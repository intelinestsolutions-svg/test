/**
 * User types (roles) and what they may do.
 *
 * Roles are data, not constants: an administrator defines the types their
 * business actually uses. Two properties matter for safety:
 *
 *   - every role records whether it may administer (`is_admin`), which is what
 *     gates the Users/Audit/Roles pages;
 *   - the administrator role cannot be deleted or demoted while it is the last
 *     one, so an installation can never lock itself out.
 *
 * Module access lives in role_modules: a role either has unrestricted access to
 * a module (`full`), read-only access (`read`), or none. Personal grants in
 * user_modules still override this per person.
 */
import { run, get, all, logAudit } from './db.js';

/** The role every fresh install starts with. `admin` may never be removed. */
export const BUILTIN_ADMIN = 'admin';

const DEFAULT_ROLES = [
  { key: 'admin', name: 'Administrator', description: 'Full access to everything, including users and settings.', is_admin: 1, rank: 10 },
  { key: 'manager', name: 'Manager', description: 'Runs day-to-day operations. Can approve and edit across modules.', is_admin: 0, rank: 20 },
  { key: 'staff', name: 'Staff', description: 'Day-to-day data entry.', is_admin: 0, rank: 30 },
];

/** Turns a display name into a stable key. */
export function slugifyRole(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export function initRoles() {
  if ((get('SELECT COUNT(*) AS c FROM roles')?.c ?? 0) === 0) {
    for (const r of DEFAULT_ROLES) {
      run(
        'INSERT INTO roles (key, name, description, is_admin, rank, builtin) VALUES (?, ?, ?, ?, ?, 1)',
        r.key, r.name, r.description, r.is_admin, r.rank
      );
    }
  }
  // A role table with no administrator is unusable; repair rather than fail.
  if ((get('SELECT COUNT(*) AS c FROM roles WHERE is_admin = 1')?.c ?? 0) === 0) {
    const first = get('SELECT key FROM roles ORDER BY rank LIMIT 1');
    if (first) {
      run('UPDATE roles SET is_admin = 1 WHERE key = ?', first.key);
      console.log(`[db] No administrator role existed; promoted "${first.key}".`);
    }
  }
}

/**
 * Gives the built-in roles sensible access to every installed module.
 *
 * Runs after modules are installed, and only fills gaps: a module the
 * administrator has already decided about is never overwritten, which matters
 * because a module can be installed later and should not silently grant access
 * that was deliberately withheld elsewhere.
 */
export function seedRoleAccessDefaults() {
  const defaults = { [BUILTIN_ADMIN]: 'full', manager: 'full', staff: 'read' };
  let added = 0;
  for (const mod of all('SELECT id FROM modules')) {
    for (const [roleKey, access] of Object.entries(defaults)) {
      if (!getRole(roleKey)) continue;
      const existing = get('SELECT 1 AS x FROM role_modules WHERE role_key = ? AND module_id = ?', roleKey, mod.id);
      if (existing) continue;
      run('INSERT INTO role_modules (role_key, module_id, access) VALUES (?, ?, ?)', roleKey, mod.id, access);
      added += 1;
    }
  }
  if (added) console.log(`[db] Granted default module access (${added} role/module pairs).`);
  return added;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function listRoles() {
  return all(`SELECT r.*,
                (SELECT COUNT(*) FROM users u WHERE u.role = r.key) AS user_count
              FROM roles r ORDER BY r.rank, r.name`);
}

export function getRole(key) {
  return get('SELECT * FROM roles WHERE key = ?', key) || null;
}

export function roleName(key) {
  return getRole(key)?.name || key;
}

export function isAdminRole(key) {
  return Boolean(getRole(key)?.is_admin);
}

/** Module access granted to a role: { moduleId: 'full' | 'read' }. */
export function roleModuleAccess(roleKey) {
  const out = {};
  for (const r of all('SELECT module_id, access FROM role_modules WHERE role_key = ?', roleKey)) {
    out[r.module_id] = r.access;
  }
  return out;
}

export function countAdmins() {
  return get("SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.key = u.role WHERE r.is_admin = 1 AND u.active = 1")?.c ?? 0;
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export function createRole({ name, description, is_admin = 0, access = {}, actorId = null }) {
  const key = slugifyRole(name);
  if (!key) return { error: 'Give the user type a name.', status: 400 };
  if (getRole(key)) return { error: `A user type called “${name}” already exists.`, status: 409 };

  const rank = (get('SELECT MAX(rank) AS m FROM roles')?.m ?? 0) + 10;
  run(
    'INSERT INTO roles (key, name, description, is_admin, rank, builtin) VALUES (?, ?, ?, ?, ?, 0)',
    key, String(name).trim(), String(description || '').trim(), is_admin ? 1 : 0, rank
  );
  setRoleAccess(key, access);
  if (actorId) logAudit(actorId, 'role.create', { key, name, is_admin: is_admin ? 1 : 0 });
  return { data: getRole(key) };
}

export function updateRole(key, { name, description, is_admin, access, actorId = null }) {
  const role = getRole(key);
  if (!role) return { error: 'That user type no longer exists.', status: 404 };

  // Guard the last administrator: demoting it would leave nobody able to
  // manage users, and no way to recover through the interface.
  if (role.is_admin && !is_admin) {
    if (countAdmins() <= 1 && (get('SELECT COUNT(*) AS c FROM roles WHERE is_admin = 1')?.c ?? 0) <= 1) {
      return { error: 'This is the only administrator type, so it cannot lose that setting.', status: 400 };
    }
  }

  run(
    'UPDATE roles SET name = ?, description = ?, is_admin = ? WHERE key = ?',
    String(name || role.name).trim(),
    String(description ?? role.description ?? '').trim(),
    is_admin ? 1 : 0,
    key
  );
  if (access) setRoleAccess(key, access);
  if (actorId) logAudit(actorId, 'role.update', { key, is_admin: is_admin ? 1 : 0 });
  return { data: getRole(key) };
}

export function setRoleAccess(roleKey, access) {
  run('DELETE FROM role_modules WHERE role_key = ?', roleKey);
  for (const [moduleId, level] of Object.entries(access || {})) {
    if (!['full', 'read'].includes(level)) continue;
    run('INSERT INTO role_modules (role_key, module_id, access) VALUES (?, ?, ?)',
      roleKey, moduleId, level);
  }
}

export function deleteRole(key, actorId = null) {
  const role = getRole(key);
  if (!role) return { error: 'That user type no longer exists.', status: 404 };
  if (role.is_admin) {
    return { error: 'An administrator type cannot be deleted.', status: 400 };
  }
  const inUse = get('SELECT COUNT(*) AS c FROM users WHERE role = ?', key)?.c ?? 0;
  if (inUse) {
    return { error: `${inUse} user${inUse === 1 ? '' : 's'} still use this type. Move them first.`, status: 400 };
  }
  run('DELETE FROM role_modules WHERE role_key = ?', key);
  run('DELETE FROM roles WHERE key = ?', key);
  if (actorId) logAudit(actorId, 'role.delete', { key });
  return { data: { ok: true } };
}

/**
 * Whether a user may administer. Reads the role table rather than comparing to
 * the string 'admin', so renaming or replacing the administrator type works.
 */
export function userIsAdmin(user) {
  if (!user) return false;
  return isAdminRole(user.role);
}
