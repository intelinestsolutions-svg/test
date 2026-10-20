/**
 * Authentication and authorisation.
 *
 * Replaces: bcryptjs (-> node:crypto scrypt) and express-session (-> the
 * sessions table in db.js).
 */
import {
  run, get, all, logAudit, verifyPassword, hashPassword,
} from './db.js';
import { randomBytes } from 'node:crypto';
import { isAdminRole, listRoles, getRole, roleName, countAdmins } from './roles.js';

export function getUser(id) {
  return get('SELECT id, username, name, role, active, lang, email, must_set_password FROM users WHERE id = ?', id);
}

/**
 * Modules a user may access. `null` means unrestricted.
 * Admins are always unrestricted; a user with no explicit grants is also
 * treated as unrestricted so a fresh install is not locked out.
 */
export function userModules(user) {
  if (!user) return [];
  if (isAdminRole(user.role)) return null;
  const grants = all('SELECT module_id FROM user_modules WHERE user_id = ?', user.id).map((r) => r.module_id);
  return grants.length ? grants : null;
}

/**
 * Whether a user may act on a module.
 *
 * Precedence: an administrator role wins outright; then a per-user grant, which
 * is the more specific instruction; then the role's own module access. Writes
 * additionally require 'full' rather than 'read'.
 */
export function can(user, moduleId, action = 'read') {
  if (!user || !user.active) return false;
  if (isAdminRole(user.role)) return true;

  const level = effectiveAccess(user, moduleId);
  if (!level) return false;
  if (action === 'read') return true;
  return level === 'full';
}

/** The access a user effectively has to one module: null, 'read' or 'full'. */
export function effectiveAccess(user, moduleId) {
  if (!user) return null;
  if (isAdminRole(user.role)) return 'full';

  // A personal grant is an explicit decision about this person.
  const grant = get('SELECT access FROM user_modules WHERE user_id = ? AND module_id = ?', user.id, moduleId);
  if (grant) {
    // Tolerate the older row shape, which only recorded membership.
    return grant.access === 'full' || grant.access === 'read' ? grant.access : 'full';
  }

  const roleLevel = get('SELECT access FROM role_modules WHERE role_key = ? AND module_id = ?', user.role, moduleId);
  if (roleLevel) return roleLevel.access;

  // Fall back to a broad default for roles that have no rows yet, so an
  // upgrade never silently locks existing users out of their modules.
  return null;
}

/** Verifies credentials. Returns the user row, or null. */
export function authenticate(username, password) {
  if (!username || !password) return null;
  const user = get('SELECT * FROM users WHERE username = ? AND active = 1', String(username).trim());
  if (!user) return null;
  return verifyPassword(password, user.password_hash) ? user : null;
}

export function changePassword(userId, currentPassword, newPassword) {
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) return { error: 'User not found', status: 404 };
  if (!verifyPassword(currentPassword || '', user.password_hash)) {
    return { error: 'Current password is incorrect', status: 400 };
  }
  if (!newPassword || String(newPassword).length < 6) {
    return { error: 'New password must be at least 6 characters', status: 400 };
  }
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), userId);
  // Changing a password invalidates existing sessions, including this one.
  run('DELETE FROM sessions WHERE user_id = ?', userId);
  logAudit(userId, 'auth.change-password', {});
  return { data: { ok: true } };
}

/**
 * Sets a password using a one-time link rather than the current password - the
 * path taken by an invited user or someone who has forgotten theirs.
 * The token is consumed by the caller before this runs.
 */
export function setPasswordWithToken(userId, newPassword) {
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) return { error: 'User not found', status: 404 };
  if (!newPassword || String(newPassword).length < 6) {
    return { error: 'Password must be at least 6 characters', status: 400 };
  }
  run(
    'UPDATE users SET password_hash = ?, must_set_password = 0 WHERE id = ?',
    hashPassword(newPassword), userId
  );
  run('DELETE FROM sessions WHERE user_id = ?', userId);
  logAudit(userId, 'auth.set-password', { via: 'token' });
  return { data: { ok: true } };
}

export function listUsers() {
  return all('SELECT id, username, name, role, active, created_at, email, must_set_password FROM users ORDER BY id');
}

/** Loose but useful validation - enough to catch typos without rejecting valid addresses. */
export function looksLikeEmail(value) {
  const s = String(value || '').trim();
  if (s.length < 3 || s.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
}

/**
 * Creates a user.
 *
 * With `invite: true` no password is set: the account gets a random unusable
 * hash and `must_set_password`, and the caller issues a one-time link so the
 * user chooses their own password. That avoids an administrator inventing and
 * communicating a shared secret.
 */
export function createUser({ username, password, name, role, email, invite = false }) {
  if (!username) return { error: 'Username is required', status: 400 };
  const cleanEmail = String(email || '').trim();
  if (cleanEmail && !looksLikeEmail(cleanEmail)) {
    return { error: 'That email address does not look valid', status: 400 };
  }
  const allowed = listRoles().map((r) => r.key);
  if (!role || !allowed.includes(role)) {
    return { error: `Choose a user type: ${allowed.join(', ')}`, status: 400 };
  }

  let hash;
  let mustSet = 0;
  if (invite) {
    // A random value nobody knows; the account cannot be signed into until the
    // one-time link is used to set a real password.
    hash = hashPassword(randomBytes(32).toString('hex'));
    mustSet = 1;
  } else {
    if (!password) return { error: 'Username and password are required', status: 400 };
    if (String(password).length < 6) {
      return { error: 'Password must be at least 6 characters', status: 400 };
    }
    hash = hashPassword(password);
  }

  try {
    const info = run(
      'INSERT INTO users (username, password_hash, name, role, email, must_set_password) VALUES (?, ?, ?, ?, ?, ?)',
      String(username).trim(), hash, name || username, role, cleanEmail || null, mustSet
    );
    return { data: getUser(info.lastInsertRowid) };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return { error: 'Username already exists', status: 409 };
    throw err;
  }
}

export function updateUser(id, { name, role, active }) {
  const user = getUser(id);
  if (!user) return { error: 'User not found', status: 404 };
  const allowed = listRoles().map((r) => r.key);
  if (role !== undefined && !allowed.includes(role)) {
    return { error: `Choose a user type: ${allowed.join(', ')}`, status: 400 };
  }
  // Moving an administrator out of an administrator type must not remove the
  // last one, or the installation can no longer be managed.
  if (role !== undefined && role !== user.role && isAdminRole(user.role) && !isAdminRole(role)) {
    if (countAdmins() <= 1) {
      return { error: 'This is the only remaining administrator. Give someone else that type first.', status: 400 };
    }
  }
  run(
    `UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active)
     WHERE id = ?`,
    name ?? null, role ?? null, active === undefined ? null : (active ? 1 : 0), id
  );
  if (active === false || active === 0 || active === '0') {
    run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  return { data: getUser(id) };
}

/**
 * Resets a user's password. Admin action.
 * Sessions are cleared so the old password cannot keep a session alive.
 */
export function adminResetPassword(id, newPassword) {
  if (!newPassword || String(newPassword).length < 6) {
    return { error: 'Password must be at least 6 characters', status: 400 };
  }
  if (!getUser(id)) return { error: 'User not found', status: 404 };
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), id);
  run('DELETE FROM sessions WHERE user_id = ?', id);
  return { data: { ok: true } };
}

export function deleteUser(id, actorId) {
  if (Number(id) === Number(actorId)) return { error: 'You cannot delete your own account', status: 400 };
  const user = getUser(id);
  if (!user) return { error: 'User not found', status: 404 };
  // Never leave the system without an admin.
  if (isAdminRole(user.role)) {
    if (countAdmins() <= 1) {
      return { error: 'This is the only remaining administrator, so it cannot be deleted.', status: 400 };
    }
  }
  run('DELETE FROM users WHERE id = ?', id);
  return { data: { ok: true } };
}

export function auditLog(limit = 200) {
  return all(
    `SELECT a.*, u.username FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC LIMIT ?`,
    limit
  );
}
