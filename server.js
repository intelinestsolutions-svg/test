/**
 * Kotamix Concrete - application server.
 * Zero external dependencies: node:http + node:sqlite.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';

import { ROOT, userForToken, destroySession, allSettings, listBranches, getBranch, branchWhere, branchCond, branchVal } from './src/db.js';
import { parseCookies, parseBody, html, json, text, redirect, setCookie } from './src/lib/http.js';
import { t } from './src/lib/html.js';

import { authRoutes } from './src/routes/auth.js';
import { branchRoutes } from './src/routes/branches.js';
import { dashboardRoutes } from './src/routes/dashboard.js';
import { orderRoutes } from './src/routes/orders.js';
import { deliveryRoutes } from './src/routes/deliveries.js';
import { scheduleRoutes } from './src/routes/schedule.js';
import { customerRoutes } from './src/routes/customers.js';
import { fleetRoutes } from './src/routes/fleet.js';
import { fuelRoutes } from './src/routes/fuel.js';
import { inventoryRoutes } from './src/routes/inventory.js';
import { mixRoutes } from './src/routes/mix.js';
import { purchasingRoutes } from './src/routes/purchasing.js';
import { staffRoutes } from './src/routes/staff.js';
import { attendanceRoutes } from './src/routes/attendance.js';
import { payrollRoutes } from './src/routes/payroll.js';
import { invoiceRoutes } from './src/routes/invoices.js';
import { paymentRoutes } from './src/routes/payments.js';
import { receivableRoutes } from './src/routes/receivables.js';
import { reportRoutes } from './src/routes/reports.js';
import { settingsRoutes } from './src/routes/settings.js';
import { printRoutes } from './src/routes/print.js';
import { portalRoutes } from './src/routes/portal.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = join(ROOT, 'public');

const routes = [
  ...authRoutes,
  ...branchRoutes,
  ...dashboardRoutes,
  ...orderRoutes,
  ...deliveryRoutes,
  ...scheduleRoutes,
  ...customerRoutes,
  ...fleetRoutes,
  ...fuelRoutes,
  ...inventoryRoutes,
  ...mixRoutes,
  ...purchasingRoutes,
  ...staffRoutes,
  ...attendanceRoutes,
  ...payrollRoutes,
  ...invoiceRoutes,
  ...paymentRoutes,
  ...receivableRoutes,
  ...reportRoutes,
  ...settingsRoutes,
  ...printRoutes,
  ...portalRoutes,
];

/* ---------------- static files ---------------- */
const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const target = normalize(join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC)) return false;
  try {
    const s = await stat(target);
    if (!s.isFile()) return false;
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': rel === '/js/app.js' || rel === '/css/app.css' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(body);
    return true;
  } catch { return false; }
}

/* ---------------- request handler ---------------- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const cookies = parseCookies(req);

  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(req, res, pathname)) return;
    }

    // match route
    let matched = null;
    let paramNames = null;
    let matchResult = null;
    for (const r of routes) {
      if (r.method !== req.method) {
        if (!(r.method === 'GET' && req.method === 'HEAD')) continue;
      }
      const names = [];
      const pattern = r.path.replace(/:([A-Za-z_]+)/g, (_, n) => { names.push(n); return '([^/]+)'; });
      const m = pathname.match(new RegExp(`^${pattern}$`));
      if (m) { matched = r; paramNames = names; matchResult = m; break; }
    }
    if (!matched) {
      const u = userForToken(cookies.token);
      if (u) {
        return html(res, `<!doctype html><meta charset="utf-8"><title>404</title>
          <body style="font-family:system-ui;padding:3rem;text-align:center">
          <h1>404</h1><p>Halaman tidak dijumpai / Page not found</p>
          <p><a href="/dashboard">Kembali ke papan pemuka / Back to dashboard</a></p></body>`, 404);
      }
      return redirect(res, '/login');
    }

    const params = {};
    paramNames.forEach((n, i) => { params[n] = decodeURIComponent(matchResult[i + 1] ?? ''); });

    const user = userForToken(cookies.token);
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await parseBody(req) : {};

    const ctx = {
      req, res, user, params,
      url: pathname, fullUrl: req.url, query: Object.fromEntries(url.searchParams),
      cookies,
      body,
      lang: cookies.lang || (user?.lang || 'bm'),
      settings: allSettings(),
      flash: [],
    };
    ctx.t = (k) => t(ctx.lang, k);
    ctx.flashMsg = (msg, type = 'ok') => ctx.flash.push({ msg, type });
    ctx.hasRole = (...roles) => !!user && roles.includes(user.role);

    // ---- branch / cawangan -------------------------------------------
    // Setiap pengguna terikat kepada satu cawangan (users.branch_id).
    // - Admin: boleh lihat semua cawangan, dan memilih cawangan pada
    //          dashboard (?branch=ID atau ?branch=all).
    // - office / driver / staff lain: dikunci kepada cawangan sendiri.
    //          Parameter ?branch= diabaikan sepenuhnya.
    const isAdmin = !!user && user.role === 'admin';
    const requested = url.searchParams.get('branch');
    ctx.isAdmin = isAdmin;
    ctx.branches = user ? listBranches() : [];

    let branchId;
    if (!user) {
      branchId = null;
    } else if (isAdmin) {
      branchId = requested !== null ? requested : (user.branch_id ?? 'all');
    } else {
      // Kakitangan terkunci: abaikan sebarang percubaan bertukar cawangan.
      branchId = user.branch_id ?? null;
    }
    // Sahkan cawangan wujud; jika tidak, kembali kepada 'all' (admin).
    if (branchId !== 'all' && branchId !== null && branchId !== undefined && branchId !== '') {
      branchId = getBranch(Number(branchId))
        ? Number(branchId)
        : (isAdmin ? 'all' : (user?.branch_id ?? null));
    }
    ctx.branchId = branchId === 'all' ? 'all' : (branchId ? Number(branchId) : null);
    ctx.branchAll = ctx.branchId === 'all';
    /** Adakah pengguna ini boleh melihat semua cawangan (admin sahaja). */
    ctx.canSeeAllBranches = isAdmin;
    /** Cawangan rumah pengguna - digunakan semasa menyimpan rekod baru. */
    ctx.homeBranchId = user?.branch_id ?? null;
    /** Penapis SQL ikut cawangan: { sql, params }. */
    ctx.bw = (alias = '') => branchWhere(alias, ctx.branchId);
    /**
     * Klausa WHERE ikut cawangan untuk senarai yang sedang dibina.
     * Guna: const bc = ctx.bcond('o'); if (bc) { where.push(bc.clause); args.push(...bc.params); }
     */
    ctx.bcond = (alias = '') => branchCond(alias, ctx.branchId);
    /** Nilai branch_id untuk tulis ke pangkalan data. */
    ctx.bv = () => branchVal(ctx.branchId);

    // auth gate
    if (!matched.public) {
      if (!user) {
        if (pathname.startsWith('/print/')) return redirect(res, '/login');
        return redirect(res, `/login?next=${encodeURIComponent(req.url)}`);
      }
      if (matched.role && !matched.role.includes(user.role)) {
        ctx.flashMsg(t(ctx.lang, 'login.failed') + ' / Access denied', 'err');
        return redirect(res, '/dashboard');
      }
    }

    const result = await matched.handler(ctx);
    if (result === undefined) return; // handler already responded
    if (result && result.__redirect) return redirect(res, result.__redirect);
  } catch (err) {
    console.error(`\n!! ${req.method} ${pathname}\n`, err);
    if (res.headersSent) return;
    const u = userForToken(cookies.token);
    if (!u) return text(res, 'Internal error', 500);
    return html(res, `<!doctype html><meta charset="utf-8"><title>Error</title>
      <body style="font-family:system-ui;padding:3rem">
      <h1>Ralat / Error</h1><pre style="background:#f6f6f6;padding:1rem;border-radius:8px;overflow:auto">${
        String(err.stack || err.message).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))
      }</pre><p><a href="/dashboard">Kembali / Back</a></p></body>`, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Kotamix Concrete`);
  console.log(`  Running at  http://localhost:${PORT}`);
  console.log(`  Sign in     admin / admin123\n`);
});
