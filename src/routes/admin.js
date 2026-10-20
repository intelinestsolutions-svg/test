/**
 * Admin pages: user management, audit log, module installation.
 *
 * Every route here is restricted to the admin role, so role checks are not
 * repeated in each handler.
 */
import { html, esc } from '../lib/http.js';
import { layout, pageHeader } from '../lib/html.js';
import {
  listUsers, createUser, updateUser, deleteUser, adminResetPassword, auditLog, getUser,
} from '../auth.js';
import { registry, installModule, setModuleEnabled, uninstallModule, getModule } from '../registry.js';
import { logAudit } from '../db.js';
import { listRoles, getRole, createRole, updateRole, deleteRole, roleModuleAccess } from '../roles.js';
import { issueToken, peekToken, consumeToken, pruneTokens } from '../tokens.js';
import { sendMail, emailLayout, mailConfigured, mailStatus, baseUrl } from '../mailer.js';

const ADMIN = ['admin'];

export const adminRoutes = [
  {
    method: 'GET',
    path: '/admin/users',
    roles: ADMIN,
    handler: (ctx) => {
      const rows = listUsers().map((u) => `
        <tr>
          <td>${u.id}</td>
          <td><strong>${esc(u.username)}</strong></td>
          <td>${esc(u.name)}</td>
          <td>${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td>
          <td>${esc(u.role)}</td>
          <td>${u.active ? '<span class="pill on">active</span>' : '<span class="pill off">disabled</span>'}${
            u.must_set_password ? ' <span class="pill">invited</span>' : ''}</td>
          <td class="right">
            <form method="post" action="/admin/users/${u.id}/toggle" class="inline">
              <input type="hidden" name="active" value="${u.active ? '0' : '1'}">
              <button class="btn small ghost">${u.active ? 'Disable' : 'Enable'}</button>
            </form>
            <form method="post" action="/admin/users/${u.id}/reset" class="inline"
                  onsubmit="return confirm('Reset this user\\'s password?')">
              <input type="hidden" name="password" value="changeme123">
              <button class="btn small ghost">Reset password</button>
            </form>
            <form method="post" action="/admin/users/${u.id}/delete" class="inline"
                  onsubmit="return confirm('Delete this user? This cannot be undone.')">
              <button class="btn small danger">Delete</button>
            </form>
          </td>
        </tr>`).join('');

      // A freshly issued invitation link, shown once so the admin can pass it on
      // if the email is delayed or filtered.
      const inviteToken = ctx.query.invite;
      const invitePanel = inviteToken && peekToken(inviteToken, 'invite')
        ? `<div class="card invite-link">
             <strong>Invitation link</strong>
             <p class="muted">Sent by email as well. This link works once and is not shown again.</p>
             <input readonly value="${esc(baseUrl() + '/invite/' + inviteToken)}" onclick="this.select()">
           </div>`
        : '';

      return html(ctx.res, layout({
        title: 'Users',
        user: ctx.user,
        active: 'users',
        flash: ctx.flash,
        body: `
        ${pageHeader('Users', `${listUsers().length} accounts`)}
        ${mailConfigured() ? '' : `<div class="notice">${esc(mailStatus())}</div>`}
        ${invitePanel}
        <table class="grid">
          <thead><tr><th>#</th><th>Username</th><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>

        <h2>Add a user</h2>
        <form method="post" action="/admin/users" class="card form" id="adduser">
          <div class="field"><label for="username">Username</label>
            <input id="username" name="username" required autocomplete="off"></div>
          <div class="field"><label for="name">Full name</label>
            <input id="name" name="name" autocomplete="off"></div>
          <div class="field"><label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="off">
            <p class="hint">The invitation is sent here. It also matches a Google account.</p></div>
          <div class="field"><label for="role">Role</label>
            <select id="role" name="role">
              <option value="staff">staff</option>
              <option value="manager">manager</option>
              <option value="admin">admin</option>
            </select></div>
          <div class="field">
            <label>How should they get their password?</label>
            <label class="radio"><input type="radio" name="mode" value="invite" checked>
              Email an invitation — they choose their own password</label>
            <label class="radio"><input type="radio" name="mode" value="password">
              Set a password now</label>
          </div>
          <div class="field" id="pwfield" hidden><label for="password">Password</label>
            <input id="password" name="password" type="password" minlength="6" autocomplete="new-password"></div>
          <div class="actions"><button class="btn" type="submit">Create user</button></div>
        </form>
        <script>
          (function () {
            var form = document.getElementById('adduser');
            var pw = document.getElementById('pwfield');
            var input = document.getElementById('password');
            function sync() {
              var needs = form.querySelector('input[name=mode]:checked').value === 'password';
              pw.hidden = !needs;
              input.required = needs;
              if (!needs) input.value = '';
            }
            form.addEventListener('change', sync);
            sync();
          })();
        </script>`,
      }));
    },
  },

  {
    method: 'POST',
    path: '/admin/users',
    roles: ADMIN,
    handler: async (ctx) => {
      const invite = ctx.body.mode !== 'password';
      const result = createUser({
        username: ctx.body.username,
        password: ctx.body.password,
        name: ctx.body.name,
        email: ctx.body.email,
        role: ctx.body.role,
        invite,
      });
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: '/admin/users' };
      }

      const user = result.data;
      logAudit(ctx.user.id, 'user.create', {
        username: user.username, email: user.email || null, invited: invite,
      });

      if (!invite) {
        ctx.flashMsg(`User “${user.username}” created.`);
        return { redirect: '/admin/users' };
      }

      // Invitation: mint a one-time link and try to email it. The link is the
      // credential, so a send failure must not lose it.
      const { token, expiresAt } = issueToken(user.id, 'invite');
      const link = `${baseUrl()}/invite/${token}`;

      if (!user.email) {
        ctx.flashMsg(`“${user.username}” has no email address, so no invitation was sent.`, 'err');
        return { redirect: `/admin/users?invite=${encodeURIComponent(token)}` };
      }

      const message = emailLayout({
        heading: 'You have been invited to SP Business Suite',
        lines: [
          `${ctx.user.name} has created an account for you.`,
          'Choose a password to finish setting up your account.',
        ],
        button: { label: 'Set your password', href: link },
        footnote: `This link can only be used once and expires on ${expiresAt.slice(0, 10)}.`,
      });

      const sent = await sendMail({
        to: user.email,
        subject: 'Your invitation to SP Business Suite',
        ...message,
      });

      if (sent.error) {
        logAudit(ctx.user.id, 'user.invite-failed', { username: user.username, reason: sent.error });
        ctx.flashMsg(`Invitation created but not emailed: ${sent.error}`, 'err');
        return { redirect: `/admin/users?invite=${encodeURIComponent(token)}` };
      }

      logAudit(ctx.user.id, 'user.invite-sent', { username: user.username, email: user.email });
      ctx.flashMsg(`Invitation emailed to ${user.email}.`);
      // The link is still offered once, in case the mail is filtered.
      return { redirect: `/admin/users?invite=${encodeURIComponent(token)}` };
    },
  },

  {
    method: 'POST',
    path: '/admin/users/:id',
    roles: ADMIN,
    handler: (ctx) => {
      const result = updateUser(ctx.params.id, ctx.body);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
      } else {
        logAudit(ctx.user.id, 'user.update', { id: ctx.params.id });
        ctx.flashMsg('User updated.');
      }
      return { redirect: '/admin/users' };
    },
  },

  {
    method: 'POST',
    path: '/admin/users/:id/toggle',
    roles: ADMIN,
    handler: (ctx) => {
      // Guard against disabling the last way in.
      const target = getUser(ctx.params.id);
      if (!target) {
        ctx.flashMsg('User not found.', 'err');
        return { redirect: '/admin/users' };
      }
      if (Number(target.id) === Number(ctx.user.id)) {
        ctx.flashMsg('You cannot disable your own account.', 'err');
        return { redirect: '/admin/users' };
      }
      const active = ctx.body.active === '1';
      const result = updateUser(ctx.params.id, { active });
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
      } else {
        logAudit(ctx.user.id, active ? 'user.enable' : 'user.disable', { id: ctx.params.id });
        ctx.flashMsg(active ? 'User enabled.' : 'User disabled and signed out.');
      }
      return { redirect: '/admin/users' };
    },
  },

  {
    method: 'POST',
    path: '/admin/users/:id/reset',
    roles: ADMIN,
    handler: (ctx) => {
      const result = adminResetPassword(ctx.params.id, ctx.body.password);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
      } else {
        logAudit(ctx.user.id, 'user.reset-password', { id: ctx.params.id });
        ctx.flashMsg('Password reset — tell the user to change it after signing in.', 'warn');
      }
      return { redirect: '/admin/users' };
    },
  },

  {
    method: 'POST',
    path: '/admin/users/:id/delete',
    roles: ADMIN,
    handler: (ctx) => {
      const result = deleteUser(ctx.params.id, ctx.user.id);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
      } else {
        logAudit(ctx.user.id, 'user.delete', { id: ctx.params.id });
        ctx.flashMsg('User deleted.');
      }
      return { redirect: '/admin/users' };
    },
  },

  {
    method: 'GET',
    path: '/admin/audit',
    roles: ADMIN,
    handler: (ctx) => {
      const limit = Math.min(Math.max(Number(ctx.query.limit) || 200, 1), 1000);
      const rows = auditLog(limit).map((a) => `
        <tr>
          <td>${a.id}</td>
          <td class="nowrap">${esc(a.created_at)}</td>
          <td>${esc(a.username || '—')}</td>
          <td><code>${esc(a.action)}</code></td>
          <td class="detail">${esc(a.detail || '')}</td>
        </tr>`).join('');

      return html(ctx.res, layout({
        title: 'Audit log',
        user: ctx.user,
        active: 'audit',
        flash: ctx.flash,
        body: `
        ${pageHeader('Audit log', `Most recent ${limit} entries`)}
        ${rows
          ? `<table class="grid">
               <thead><tr><th>#</th><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
               <tbody>${rows}</tbody>
             </table>`
          : '<p class="muted">No activity recorded yet.</p>'}`,
      }));
    },
  },

  {
    method: 'POST',
    path: '/admin/modules/:id/install',
    roles: ADMIN,
    handler: (ctx) => {
      try {
        installModule(ctx.params.id, ctx.user.id);
        ctx.flashMsg(`Module “${ctx.params.id}” installed.`);
      } catch (err) {
        ctx.flashMsg(err.message, 'err');
      }
      return { redirect: '/modules' };
    },
  },

  {
    method: 'POST',
    path: '/admin/modules/:id/toggle',
    roles: ADMIN,
    handler: (ctx) => {
      const enabled = ctx.body.enabled === '1';
      try {
        setModuleEnabled(ctx.params.id, enabled, ctx.user.id);
        ctx.flashMsg(enabled ? 'Module enabled.' : 'Module disabled.');
      } catch (err) {
        ctx.flashMsg(err.message, 'err');
      }
      return { redirect: '/modules' };
    },
  },

  {
    method: 'POST',
    path: '/admin/modules/:id/uninstall',
    roles: ADMIN,
    handler: (ctx) => {
      const mod = getModule(ctx.params.id);
      if (!mod) {
        ctx.flashMsg('Module not found.', 'err');
        return { redirect: '/modules' };
      }
      try {
        uninstallModule(ctx.params.id, ctx.user.id);
        // Re-register so the module still appears as available to reinstall.
        registry();
        ctx.flashMsg(`Module “${mod.name}” uninstalled and its data dropped.`, 'warn');
      } catch (err) {
        ctx.flashMsg(err.message, 'err');
      }
      return { redirect: '/modules' };
    },
  },
];
