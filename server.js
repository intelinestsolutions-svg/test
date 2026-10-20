/**
 * SP Business Suite - application server.
 *
 * Zero external dependencies: node:http + node:sqlite + node:crypto.
 * There is no build step and nothing to `npm install`, so this runs on
 * hosting that cannot compile native modules.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';

import { ROOT, APP_BUILD, userForToken, destroySession, purgeExpiredSessions, createSession, getSetting, setSetting } from './src/db.js';
import { parseCookies, parseBody, html, json, text, redirect, setCookie, clearCookie } from './src/lib/http.js';
import { initSchema } from './src/schema.js';
import { syncRegistry, installBundledModules } from './src/registry.js';
import { can } from './src/auth.js';
import { isAdminRole } from './src/roles.js';
import { seedRoleAccessDefaults } from './src/roles.js';

import { authRoutes } from './src/routes/auth.js';
import { pageRoutes } from './src/routes/pages.js';
import { moduleRoutes } from './src/routes/modules.js';
import { adminRoutes } from './src/routes/admin.js';
import { accountAllRoutes } from './src/routes/account.js';
import { roleRoutes, setupRoutes, needsSetup } from './src/routes/roles.js';

const PORT = Number(process.env.PORT || 3000);
// Bind all interfaces: managed hosting puts a reverse proxy in front of the
// app, and a loopback-only bind is unreachable from it (visitors see 503).
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = join(ROOT, 'public');
const COOKIE = 'crm.sid';
// Secure cookies require HTTPS; enable in production.
const SECURE_COOKIE = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1';

const routes = [
  ...authRoutes,
  ...accountAllRoutes,
  ...setupRoutes,
  ...pageRoutes,
  ...moduleRoutes,
  ...adminRoutes,
  ...roleRoutes,
];

/**
 * Paths that stay reachable while an administrator is being held at the setup
 * step. Without this the redirect would loop: /setup itself, signing out, and
 * the pages needed to define user types must all remain open.
 */
function allowedBeforeSetup(pathname) {
  return pathname === '/setup'
    || pathname.startsWith('/setup/')
    || pathname.startsWith('/admin/roles')
    || pathname === '/logout'
    || pathname === '/profile'
    || pathname === '/profile/password'
    || pathname.startsWith('/img/')
    || pathname === '/app.css'
    || pathname.startsWith('/auth/google')
    || pathname.startsWith('/invite/');
}

/* ---------------- first-run ---------------- */
initSchema();
syncRegistry();
installBundledModules();
// Modules must exist before role access can be seeded from them, so this runs
// after installation rather than inside initSchema.
seedRoleAccessDefaults();
purgeExpiredSessions();

/* ---------------- static files ---------------- */
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const target = normalize(join(PUBLIC, rel));
  // Reject anything that escapes public/ via ../ in the path.
  if (!target.startsWith(PUBLIC)) return false;
  try {
    const s = await stat(target);
    if (!s.isFile()) return false;
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': extname(target) === '.css' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- request handler ---------------- */
const server = createServer(async (req, res) => {
  // Reported before anything else so even static responses carry it - this is
  // how a deploy proves which commit is answering.
  res.setHeader('X-App-Build', APP_BUILD);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const cookies = parseCookies(req);

  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(req, res, pathname)) return;
    }

    // ---- route matching ----
    let matched = null;
    let names = null;
    let m = null;
    for (const r of routes) {
      if (!r || typeof r.method !== 'string') continue;
      if (r.method !== req.method) {
        if (!(r.method === 'GET' && req.method === 'HEAD')) continue;
      }
      const params = [];
      const pattern = r.path.replace(/:([A-Za-z_]+)/g, (_, n) => {
        params.push(n);
        return '([^/]+)';
      });
      const hit = pathname.match(new RegExp(`^${pattern}$`));
      if (hit) {
        matched = r;
        names = params;
        m = hit;
        break;
      }
    }

    const rawUser = userForToken(cookies[COOKIE]);
    // Decorate once here: whether the role may administer, and whether the
    // first-run setup is done. Route checks then read these flags instead of
    // comparing role strings, so custom user types work throughout.
    const user = rawUser ? {
      ...rawUser,
      isAdmin: isAdminRole(rawUser.role),
      setupComplete: Boolean(rawUser.setup_complete),
    } : null;

    if (!matched) {
      if (user) {
        return html(res, `<!doctype html><meta charset="utf-8"><title>404</title>
          <body style="font-family:system-ui;padding:3rem;text-align:center">
          <h1>404</h1><p>Page not found</p>
          <p><a href="/dashboard">Back to dashboard</a></p></body>`, 404);
      }
      return redirect(res, '/login');
    }

    const params = {};
    names.forEach((n, i) => {
      params[n] = decodeURIComponent(m[i + 1] ?? '');
    });

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
      ? await parseBody(req)
      : {};

    const flash = takeFlash(cookies);
    const ctx = {
      req, res, user, params, cookies,
      path: pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      flash,
      flashMsg(msg, type = 'ok') {
        flash.push({ msg, type });
      },
      setSession(userId) {
        const token = createSession(userId);
        setCookie(res, COOKIE, token, { maxAge: 30 * 24 * 3600, secure: SECURE_COOKIE });
        return token;
      },
      clearSession() {
        destroySession(cookies[COOKIE]);
        clearCookie(res, COOKIE, { secure: SECURE_COOKIE });
      },
      saveFlash() {
        if (!flash.length) return;
        setFlash(cookies[COOKIE], flash);
      },
    };

    // ---- access control ----
    if (!matched.public) {
      if (!user) {
        return redirect(res, `/login?next=${encodeURIComponent(req.url)}`);
      }

      // An administrator who has not defined their user types yet is sent to
      // the setup step first, because inviting people needs those types to
      // exist. Everything needed to complete setup stays reachable.
      if (needsSetup(user) && !allowedBeforeSetup(pathname)) {
        return redirect(res, '/setup');
      }
      // `roles: ADMIN` on a route means "any administrator type", which is why
      // this checks the flag rather than the role string.
      const roleAllowed = matched.roles && matched.roles.includes('admin')
        ? user.isAdmin
        : matched.roles?.includes(user.role);
      if (matched.roles && !roleAllowed) {
        ctx.flashMsg('You do not have access to that page.', 'err');
        ctx.saveFlash();
        return redirect(res, '/dashboard');
      }
      if (matched.module) {
        const moduleId = params[matched.moduleParam];
        if (!can(user, moduleId, req.method === 'GET' ? 'read' : 'write')) {
          ctx.flashMsg('You do not have access to that module.', 'err');
          ctx.saveFlash();
          return redirect(res, '/dashboard');
        }
      }
    }

    const result = await matched.handler(ctx);
    if (result === undefined) return; // handler already responded

    if (result && result.redirect) {
      ctx.saveFlash();
      return redirect(res, result.redirect);
    }
    if (result && result.json) return json(res, result.json, result.status || 200);
    if (result && result.error) {
      ctx.flashMsg(result.error, 'err');
      ctx.saveFlash();
      return redirect(res, result.back || '/dashboard');
    }
  } catch (err) {
    console.error(`\n!! ${req.method} ${pathname}\n`, err);
    if (res.headersSent) return;
    const u = userForToken(cookies[COOKIE]);
    if (!u) return text(res, 'Internal error', 500);
    // Never leak a stack trace to the browser; the full error stays in the log.
    return html(res, `<!doctype html><meta charset="utf-8"><title>Error</title>
      <body style="font-family:system-ui;padding:3rem">
      <h1>Error</h1><pre style="background:#f6f6f6;padding:1rem;border-radius:8px">${
        String(err.message || 'Internal error').replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))
      }</pre><p><a href="/dashboard">Back</a></p></body>`, 500);
  }
});

/* ---------------- flash helpers ---------------- */

/**
 * Flash messages ride in the settings table keyed by session token, because
 * they must survive the redirect that follows a save.
 */
function takeFlash(cookies) {
  const token = cookies[COOKIE];
  if (!token) return [];
  try {
    const raw = getSetting(`flash:${token}`);
    if (!raw) return [];
    setSetting(`flash:${token}`, '');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function setFlash(token, messages) {
  if (!token) return;
  setSetting(`flash:${token}`, JSON.stringify(messages.slice(0, 5)));
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  SP Business Suite');
  console.log(`  Build       ${APP_BUILD}`);
  console.log(`  Listening   http://${HOST}:${PORT}`);
  console.log('  First run   admin / admin123  (change this immediately)');
  console.log('');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`\n[${sig}] shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
