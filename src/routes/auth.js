import { redirect, html, setCookie, str } from '../lib/http.js';
import { get, run, verifyPassword, createSession, destroySession, setSetting } from '../db.js';
import { esc, icon } from '../lib/html.js';
import { LANGS } from '../i18n.js';

function loginPage(ctx, error = '', next = '') {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${T('login.title')} · ${T('app.short')}</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/css/app.css">
</head>
<body class="login-body">
<div class="login-wrap">
  <div class="login-card">
    <div class="login-brand">
      <img class="login-logo" src="/img/kotamix-logo.png" alt="Kotamix Concrete">
      <h1>${T('app.name')}</h1>
      <p>${T('login.subtitle')}</p>
    </div>
    <div class="lang-tabs">
      ${Object.entries(LANGS).map(([k, v]) => `<a class="${k === lang ? 'on' : ''}" href="/lang/${k}?next=${encodeURIComponent(ctx.fullUrl)}">${v.name}</a>`).join('')}
    </div>
    <form method="post" action="/login" class="login-form">
      <input type="hidden" name="next" value="${esc(next)}">
      ${error ? `<div class="flash err">${icon('warn', 16)}<span>${esc(error)}</span></div>` : ''}
      <label class="field"><span class="field-label">${T('login.username')}</span>
        <input name="username" autocomplete="username" autocapitalize="off" required autofocus></label>
      <label class="field"><span class="field-label">${T('login.password')}</span>
        <input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-primary btn-block" type="submit">${T('a.login')}</button>
    </form>
    <div class="login-demo">
      <span>${lang === 'bm' ? 'Hubungi pentadbir untuk akaun.' : 'Contact the administrator for an account.'}</span>
    </div>
  </div>
  <p class="login-foot">Concrete &amp; Lorry System · Sabah, Malaysia</p>
</div>
</body>
</html>`;
}

export const authRoutes = [
  {
    method: 'GET', path: '/login', public: true,
    handler(ctx) {
      if (ctx.user) return redirect(ctx.res, '/dashboard');
      return html(ctx.res, loginPage(ctx, '', ctx.query.next || ''));
    },
  },
  {
    method: 'POST', path: '/login', public: true,
    handler(ctx) {
      const username = str(ctx.body.username).toLowerCase();
      const password = str(ctx.body.password);
      const next = str(ctx.body.next) || '/dashboard';
      const u = get('SELECT * FROM users WHERE lower(username) = ? AND active = 1', username);
      if (!u || !verifyPassword(password, u.password_hash)) {
        return html(ctx.res, loginPage(ctx, ctx.t('login.failed'), next), 401);
      }
      const uLang = get('SELECT value FROM settings WHERE key = ?', `lang_${u.id}`)?.value;
      // Kakitangan diletakkan terus dalam cawangan mereka; admin lihat semua.
      // `next` hanya dipakai jika ia laluan dalam aplikasi sahaja.
      const homeBranch = u.role === 'admin' ? null : (u.branch_id ?? null);
      const token = createSession(u.id, homeBranch);
      setCookie(ctx.res, 'token', token, { maxAge: 14 * 86400 });
      if (uLang && uLang !== 'bm') setCookie(ctx.res, 'lang', uLang, { maxAge: 365 * 86400 });
      run('UPDATE users SET last_login = ? WHERE id = ?', new Date().toISOString(), u.id);
      return redirect(ctx.res, next.startsWith('/') ? next : '/dashboard');
    },
  },
  {
    method: 'GET', path: '/logout', public: true,
    handler(ctx) {
      destroySession(ctx.cookies.token);
      setCookie(ctx.res, 'token', '', { maxAge: 0 });
      return redirect(ctx.res, '/login');
    },
  },
  {
    method: 'GET', path: '/lang/:code',
    handler(ctx) {
      const code = ctx.params.code === 'en' ? 'en' : 'bm';
      setCookie(ctx.res, 'lang', code, { maxAge: 365 * 86400 });
      if (ctx.user) setSetting(`lang_${ctx.user.id}`, code);
      // Top-bar toggle carries no ?next=, so fall back to the referring page.
      // Never redirect back to /lang/* itself (infinite loop).
      let next = ctx.query.next || '';
      if (!next.startsWith('/')) {
        const ref = ctx.req?.headers?.referer || ctx.req?.headers?.referrer || '';
        try {
          const u = new URL(ref);
          next = u.pathname + u.search;
        } catch { next = '/dashboard'; }
      }
      if (!next.startsWith('/') || next.startsWith('/lang/')) next = '/dashboard';
      return redirect(ctx.res, next);
    },
  },
];
