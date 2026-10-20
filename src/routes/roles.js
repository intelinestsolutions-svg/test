/**
 * User types: the administrator's own list of roles, and what each may do.
 *
 * This is the first thing an administrator is asked to do, because everything
 * else - who can be invited, and into what - depends on it. The setup step is
 * deliberately skippable, since the default types are usable as they are.
 */
import { html, esc } from '../lib/http.js';
import { layout, pageHeader } from '../lib/html.js';
import { registry } from '../registry.js';
import { logAudit, run } from '../db.js';
import {
  listRoles, getRole, createRole, updateRole, deleteRole, roleModuleAccess,
  slugifyRole, countAdmins,
} from '../roles.js';

/** Renders the module access grid for a role. */
function accessGrid(roleKey, current) {
  const mods = registry();
  if (!mods.length) return '<p class="muted">No modules are installed yet.</p>';
  return `<table class="grid access">
    <thead><tr><th>Module</th><th>No access</th><th>Read only</th><th>Full access</th></tr></thead>
    <tbody>
    ${mods.map((m) => `
      <tr>
        <td><strong>${esc(m.icon)} ${esc(m.name)}</strong></td>
        ${['', 'read', 'full'].map((level) => `<td class="c">
          <input type="radio" name="access_${esc(m.id)}" value="${level}"
                 ${(current[m.id] || '') === level ? 'checked' : ''}>
        </td>`).join('')}
      </tr>`).join('')}
    </tbody>
  </table>`;
}

/** Reads the access radios out of a submitted form. */
function accessFromBody(body, prefix = 'access_') {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (!key.startsWith(prefix)) continue;
    const moduleId = key.slice(prefix.length);
    if (value === 'read' || value === 'full') out[moduleId] = value;
  }
  return out;
}

export const roleRoutes = [
  {
    method: 'GET',
    path: '/admin/roles',
    roles: ['admin'],
    handler: (ctx) => {
      return { redirect: '/admin/users#roles' };
      const roles = listRoles();
      const rows = roles.map((r) => `
        <tr>
          <td>${esc(r.name)}<br><span class="muted small">${esc(r.key)}</span></td>
          <td>${esc(r.description || '')}</td>
          <td>${r.is_admin ? '<span class="pill on">administrator</span>' : '<span class="muted">—</span>'}</td>
          <td>${r.user_count}</td>
          <td class="right">
            <a class="btn small ghost" href="/admin/roles/${esc(r.key)}">Edit</a>
            ${r.is_admin ? '' : `
            <form method="post" action="/admin/roles/${esc(r.key)}/delete" class="inline"
                  onsubmit="return confirm('Delete this user type?')">
              <button class="btn small danger">Delete</button>
            </form>`}
          </td>
        </tr>`).join('');

      return html(ctx.res, layout({
        title: 'User types',
        user: ctx.user,
        active: 'roles',
        flash: ctx.flash,
        body: `
        ${pageHeader('User types', `${roles.length} defined`)}
        <p class="muted">A user type decides whether someone can administer the suite,
        and what they can do in each module. Individual users can be given extra access.</p>
        <table class="grid">
          <thead><tr><th>Type</th><th>Description</th><th>Administers</th><th>Users</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>

        <h2>Add a user type</h2>
        <form method="post" action="/admin/roles" class="card form">
          <div class="field"><label for="name">Name</label>
            <input id="name" name="name" required placeholder="e.g. Technician, Accountant"
                   autocomplete="off"></div>
          <div class="field"><label for="description">Description</label>
            <input id="description" name="description" autocomplete="off"
                   placeholder="What this type is for"></div>
          <div class="field">
            <label class="radio"><input type="checkbox" name="is_admin" value="1">
              This type can administer the suite (manage users, types and audit)</label>
          </div>
          <h3>Module access</h3>
          ${accessGrid('new', {})}
          <div class="actions"><button class="btn" type="submit">Create user type</button></div>
        </form>`,
      }));
    },
  },

  {
    method: 'POST',
    path: '/admin/roles',
    roles: ['admin'],
    handler: (ctx) => {
      const result = createRole({
        name: ctx.body.name,
        description: ctx.body.description,
        is_admin: ctx.body.is_admin === '1',
        access: accessFromBody(ctx.body),
        actorId: ctx.user.id,
      });
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: '/admin/roles' };
      }
      ctx.flashMsg(`User type “${result.data.name}” created.`);
      return { redirect: '/admin/roles' };
    },
  },

  {
    method: 'GET',
    path: '/admin/roles/:key',
    roles: ['admin'],
    handler: (ctx) => {
      const role = getRole(ctx.params.key);
      if (!role) {
        ctx.flashMsg('That user type no longer exists.', 'err');
        return { redirect: '/admin/roles' };
      }
      const current = roleModuleAccess(role.key);
      const admins = countAdmins();
      const lastAdmin = role.is_admin && admins <= 1;

      return html(ctx.res, layout({
        title: role.name,
        user: ctx.user,
        active: 'roles',
        flash: ctx.flash,
        body: `
        ${pageHeader(role.name, `${role.user_count} user${role.user_count === 1 ? '' : 's'}`, `
          <a class="btn ghost" href="/admin/roles">Back</a>`)}
        ${lastAdmin ? `<div class="notice">This is the only administrator type, so it
          cannot lose that setting. Give another type administrator access first if you
          want to change it.</div>` : ''}
        <form method="post" action="/admin/roles/${esc(role.key)}" class="card form">
          <div class="field"><label for="name">Name</label>
            <input id="name" name="name" value="${esc(role.name)}" required></div>
          <div class="field"><label for="description">Description</label>
            <input id="description" name="description" value="${esc(role.description || '')}"></div>
          <div class="field">
            <label class="radio"><input type="checkbox" name="is_admin" value="1"
              ${role.is_admin ? 'checked' : ''} ${lastAdmin ? 'disabled' : ''}>
              This type can administer the suite</label>
            ${lastAdmin ? '<input type="hidden" name="is_admin" value="1">' : ''}
          </div>
          <h3>Module access</h3>
          ${accessGrid(role.key, current)}
          <div class="actions"><button class="btn" type="submit">Save changes</button></div>
        </form>`,
      }));
    },
  },

  {
    method: 'POST',
    path: '/admin/roles/:key',
    roles: ['admin'],
    handler: (ctx) => {
      // A disabled checkbox is absent from the body, and the last administrator
      // sends a hidden field instead; treat a missing flag as "not an admin"
      // only when the role is allowed to change.
      const role = getRole(ctx.params.key);
      if (!role) {
        ctx.flashMsg('That user type no longer exists.', 'err');
        return { redirect: '/admin/roles' };
      }
      const wantsAdmin = ctx.body.is_admin === '1';
      const result = updateRole(role.key, {
        name: ctx.body.name,
        description: ctx.body.description,
        is_admin: wantsAdmin,
        access: accessFromBody(ctx.body),
        actorId: ctx.user.id,
      });
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: `/admin/roles/${encodeURIComponent(role.key)}` };
      }
      ctx.flashMsg('User type saved.');
      return { redirect: '/admin/roles' };
    },
  },

  {
    method: 'POST',
    path: '/admin/roles/:key/delete',
    roles: ['admin'],
    handler: (ctx) => {
      const result = deleteRole(ctx.params.key, ctx.user.id);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
      } else {
        ctx.flashMsg('User type deleted.');
      }
      return { redirect: '/admin/roles' };
    },
  },
];

/* ------------------------------------------------------------------ *
 * First-run setup
 * ------------------------------------------------------------------ */

/**
 * Shown once to the first administrator. Defining user types first means the
 * invite screen can offer real choices rather than three invented defaults.
 */
export const setupRoutes = [
  {
    method: 'GET',
    path: '/setup',
    handler: (ctx) => {
      if (!ctx.user.isAdmin) return { redirect: '/dashboard' };
      const roles = listRoles();
      return html(ctx.res, layout({
        title: 'Set up user types',
        user: ctx.user,
        flash: ctx.flash,
        body: `
        ${pageHeader('Set up your user types', 'Step 1 of 1')}
        <p>Define the kinds of user your business has. You can invite people into
        these once you are done.</p>
        <div class="card">
          <table class="grid">
            <thead><tr><th>Type</th><th>Description</th><th>Administers</th></tr></thead>
            <tbody>
              ${roles.map((r) => `<tr>
                <td><strong>${esc(r.name)}</strong></td>
                <td>${esc(r.description || '')}</td>
                <td>${r.is_admin ? '<span class="pill on">yes</span>' : '<span class="muted">—</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p class="muted">Add, rename or remove types before continuing.</p>
        <div class="actions">
          <a class="btn ghost" href="/admin/roles">Edit user types</a>
          <form method="post" action="/setup/complete" class="inline">
            <button class="btn">These look right — continue</button>
          </form>
        </div>`,
      }));
    },
  },
  {
    method: 'POST',
    path: '/setup/complete',
    handler: (ctx) => {
      if (!ctx.user.isAdmin) return { redirect: '/dashboard' };
      run('UPDATE users SET setup_complete = 1 WHERE id = ?', ctx.user.id);
      logAudit(ctx.user.id, 'setup.complete', { roles: listRoles().length });
      ctx.flashMsg('User types are set. Invite your first user whenever you are ready.');
      return { redirect: '/admin/users' };
    },
  },
];

/** True when this administrator still has to run the setup step. */
export function needsSetup(user) {
  return Boolean(user && user.isAdmin && !user.setupComplete);
}
