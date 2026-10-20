/**
 * Auth pages and endpoints: login, logout, profile.
 */
import { html, esc, redirect } from '../lib/http.js';
import { layout } from '../lib/html.js';
import { authenticate, changePassword, getUser } from '../auth.js';
import { logAudit } from '../db.js';

function loginPage({ error = '', next = '' } = {}) {
  return layout({
    title: 'Sign in',
    body: `
    <div class="auth">
      <img src="/img/logo-ink.png" alt="SP Business Suite" width="72" height="78" class="auth-logo">
      <h1>SP Business Suite</h1>
      <p class="muted">Sign in to continue</p>
      ${error ? `<div class="flash err">${esc(error)}</div>` : ''}
      <form method="post" action="/login" class="card form">
        <input type="hidden" name="next" value="${esc(next)}">
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" autocomplete="username" autofocus required>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <div class="actions"><button class="btn" type="submit">Sign in</button></div>
      </form>
    </div>`,
  });
}

export const authRoutes = [
  {
    method: 'GET',
    path: '/login',
    public: true,
    handler: (ctx) => {
      if (ctx.user) return { redirect: '/dashboard' };
      return html(ctx.res, loginPage({ next: ctx.query.next || '' }));
    },
  },
  {
    method: 'POST',
    path: '/login',
    public: true,
    handler: (ctx) => {
      const { username, password, next } = ctx.body;
      const user = authenticate(username, password);
      if (!user) {
        return html(ctx.res, loginPage({
          error: 'Invalid username or password',
          next: next || '',
        }), 401);
      }
      ctx.setSession(user.id);
      logAudit(user.id, 'auth.login', { username: user.username });
      // Only allow same-site relative redirects.
      const target = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
        ? next
        : '/dashboard';
      return { redirect: target };
    },
  },
  {
    method: 'POST',
    path: '/logout',
    handler: (ctx) => {
      if (ctx.user) logAudit(ctx.user.id, 'auth.logout', {});
      ctx.clearSession();
      return { redirect: '/login' };
    },
  },
  {
    method: 'GET',
    path: '/profile',
    handler: (ctx) => html(ctx.res, layout({
      title: 'Profile',
      user: ctx.user,
      active: 'profile',
      flash: ctx.flash,
      body: `
      <h1>Profile</h1>
      <div class="card">
        <dl class="kv">
          <dt>Username</dt><dd>${esc(ctx.user.username)}</dd>
          <dt>Name</dt><dd>${esc(ctx.user.name)}</dd>
          <dt>Role</dt><dd>${esc(ctx.user.role)}</dd>
        </dl>
      </div>
      <h2>Change password</h2>
      <form method="post" action="/profile/password" class="card form">
        <div class="field">
          <label for="currentPassword">Current password</label>
          <input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required>
        </div>
        <div class="field">
          <label for="newPassword">New password</label>
          <input id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="6" required>
        </div>
        <div class="actions"><button class="btn" type="submit">Change password</button></div>
      </form>`,
    })),
  },
  {
    method: 'POST',
    path: '/profile/password',
    handler: (ctx) => {
      const { currentPassword, newPassword } = ctx.body;
      const result = changePassword(ctx.user.id, currentPassword, newPassword);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: '/profile' };
      }
      // Changing the password clears all sessions - sign in again.
      ctx.clearSession();
      return { redirect: '/login' };
    },
  },
];
