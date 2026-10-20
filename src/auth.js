/**
 * Authentication and authorisation.
 *
 * Replaces: bcryptjs (-> node:crypto scrypt) and express-session (-> the
 * sessions table in db.js).
 */
import {
  run, get, all, logAudit, verifyPassword, hashPassword,
} from './db.js';

export function getUser(id) {
  return get('SELECT id, username, name, role, active, lang FROM users WHERE id = ?', id);
}

/**
 * Modules a user may access. `null` means unrestricted.
 * Admins are always unrestricted; a user with no explicit grants is also
 * treated as unrestricted so a fresh install is not locked out.
 */
export function userModules(user) {
  if (!user) return [];
  if (user.role === 'admin') return null;
  const grants = all('SELECT module_id FROM user_modules WHERE user_id = ?', user.id).map((r) => r.module_id);
  return grants.length ? grants : null;
}

export function can(user, moduleId, action = 'read') {
  if (!user || !user.active) return false;
  if (user.role === 'admin') return true;
  const mods = userModules(user);
  if (mods && !mods.includes(moduleId)) return false;
  if (action === 'read') return true;
  return user.role === 'manager'; // staff are read-only
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

export function listUsers() {
  return all('SELECT id, username, name, role, active, created_at FROM users ORDER BY id');
}

export function createUser({ username, password, name, role }) {
  if (!username || !password) return { error: 'Username and password are required', status: 400 };
  if (String(password).length < 6) return { error: 'Password must be at least 6 characters', status: 400 };
  const allowed = ['admin', 'manager', 'staff'];
  if (!allowed.includes(role)) return { error: `Role must be one of: ${allowed.join(', ')}`, status: 400 };
  try {
    const info = run(
      'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)',
      String(username).trim(), hashPassword(password), name || username, role
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
  const allowed = ['admin', 'manager', 'staff'];
  if (role !== undefined && !allowed.includes(role)) {
    return { error: `Role must be one of: ${allowed.join(', ')}`, status: 400 };
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
  if (user.role === 'admin') {
    const admins = get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1")?.c ?? 0;
    if (admins <= 1) return { error: 'Cannot delete the last admin', status: 400 };
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
