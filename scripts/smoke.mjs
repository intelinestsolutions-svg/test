/**
 * Smoke test: log in, then walk every route (including detail pages derived
 * from seeded ids) and report any non-2xx response or logged server error.
 * Requires a running server.
 *   npm start                 # in another terminal, on the default port
 *   npm run smoke             # walks http://localhost:3000
 *   npm run smoke -- http://localhost:3111
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || `http://localhost:${process.env.PORT || 3000}`;

let cookie = '';
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    ...opts,
  });
  const setC = res.headers.getSetCookie?.() || [];
  for (const c of setC) {
    const kv = c.split(';')[0];
    if (kv.startsWith('token=') && kv.length > 6) cookie = kv;
  }
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') };
}

const results = [];
async function hit(path, { method = 'GET', body = null, expect = null } = {}) {
  const r = await req(path, { method, body });
  const ok = expect ? r.status === expect : (r.status >= 200 && r.status < 400);
  const serverErr = /Internal error|Ralat \/ Error/.test(r.text);
  results.push({ path, method, status: r.status, ok: ok && !serverErr, serverErr });
  if (!ok || serverErr) {
    const m = r.text.match(/<pre[^>]*>([\s\S]{0,600})/);
    console.log(`  ${serverErr || !ok ? 'FAIL' : '    '} ${method} ${path} -> ${r.status}` +
      (m ? `\n       ${m[1].replace(/&lt;/g, '<').replace(/&amp;/g, '&').split('\n').slice(0, 4).join('\n       ')}` : ''));
  }
  return r;
}

/* ---------- login ---------- */
const li = await req('/login', { method: 'POST', body: 'username=admin&password=admin123' });
if (li.status !== 302) { console.log('LOGIN FAILED', li.status); process.exit(1); }
console.log(`Logged in as admin. Cookie: ${cookie.slice(0, 12)}...\n`);

/* ---------- discover ids from the live database ---------- */
const { get, all } = await import(join(ROOT, 'src/db.js'));
const id = (sql, ...p) => get(sql, ...p)?.id;

/* ---------- static ---------- */
console.log('Static:');
for (const p of ['/css/app.css', '/js/app.js', '/favicon.svg']) await hit(p);

/* ---------- language toggle ---------- */
console.log('i18n:');
await hit('/lang/en');
await hit('/lang/bm');

/* ---------- main nav ---------- */
console.log('\nMain pages:');
for (const p of ['/dashboard', '/orders', '/schedule', '/deliveries', '/invoices', '/payments', '/receivables',
  '/fleet', '/fuel', '/inventory', '/mix', '/purchasing', '/suppliers', '/staff', '/attendance',
  '/payroll', '/customers', '/reports', '/settings']) await hit(p);

/* ---------- settings tabs ---------- */
console.log('\nSettings tabs:');
for (const t of ['company', 'finance', 'bank', 'allow', 'numbering', 'users', 'data']) await hit(`/settings?tab=${t}`);

/* ---------- report tabs ---------- */
console.log('\nReport tabs:');
for (const t of ['sales', 'profit', 'stock', 'fleet', 'people']) await hit(`/reports?tab=${t}`);

/* ---------- lists with filters / paging ---------- */
console.log('\nFiltered lists:');
for (const p of ['/orders?status=draft', '/orders?status=confirmed', '/deliveries?status=planned',
  '/deliveries?status=loading', '/deliveries?status=dispatched', '/invoices?unpaid=1',
  '/invoices?overdue=1', '/payments?method=cash', '/payments?method=bank', '/payments?method=online',
  '/inventory?filter=low', '/inventory?cat=material', '/inventory?cat=fuel', '/inventory?cat=part',
  '/fleet?status=available', '/staff?role=driver', '/receivables?view=aging', '/mix']) await hit(p);

/* ---------- new-record forms ---------- */
console.log('\nForms:');
for (const p of ['/orders/new', '/payments/new', '/deliveries/new', '/inventory/move', '/inventory/adjust',
  '/purchasing/new', '/suppliers/new', '/fuel/new', '/staff/new', '/mix/new', '/invoices/new',
  '/attendance']) await hit(p);

/* ---------- detail pages from real ids ---------- */
console.log('\nDetail pages:');
const oId = id('SELECT id FROM orders LIMIT 1');
const tId = id('SELECT id FROM trips LIMIT 1');
const iId = id('SELECT id FROM invoices LIMIT 1');
const pId = id('SELECT id FROM payments LIMIT 1');
const cId = id('SELECT id FROM customers LIMIT 1');
const itId = id('SELECT id FROM items LIMIT 1');
const lId = id('SELECT id FROM lorries LIMIT 1');
const sId = id('SELECT id FROM staff LIMIT 1');
const poId = id('SELECT id FROM purchases LIMIT 1');
const mId = id('SELECT id FROM mix_designs LIMIT 1');
const oId2 = get('SELECT id FROM orders WHERE status = ?', 'draft')?.id;

const paths = [
  `/orders/${oId}`, `/deliveries/${tId}`, `/invoices/${iId}`, `/payments/${pId}`,
  `/customers/${cId}`, `/inventory/${itId}`, `/fleet/${lId}`, `/staff/${sId}`, `/purchasing/${poId}`,
  `/mix/${mId}`,
  `/print/dn/${tId}`, `/print/invoice/${iId}`, `/print/receipt/${pId}`,
  `/print/statement/${cId}`, `/print/order/${oId}`, `/print/po/${poId}`,
  `/print/payslip/${sId}?month=${get("SELECT MIN(work_date) AS d FROM attendance")?.d?.slice(0, 7) || '2026-01'}`,
];
if (oId2) paths.push(`/orders/${oId2}`);
for (const p of paths) await hit(p);

/* ---------- CSV exports ---------- */
console.log('\nExports:');
for (const p of ['/orders.csv', '/payments.csv', '/inventory.csv', '/reports/sales.csv',
  '/reports/profit.csv', '/reports/stock.csv', '/reports/fleet.csv', '/reports/people.csv',
  '/receivables.csv']) await hit(p);

/* ---------- public payment link ---------- */
const pl = get(`SELECT * FROM online_payments WHERE pay_url IS NOT NULL LIMIT 1`);
console.log('\nPublic pages:');
if (pl) await hit(`/pay/${pl.ref}`);
await hit('/nonexistent-page-xyz', { expect: 404 });

/* ---------- driver role ---------- */
console.log('\nDriver role:');
cookie = '';
await req('/login', { method: 'POST', body: 'username=driver&password=driver123' });
for (const p of ['/dashboard', '/deliveries', `/deliveries/${tId}`, '/orders', '/fleet', '/settings']) await hit(p);

/* ---------- summary ---------- */
const bad = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - bad.length}/${results.length} passed ===`);
if (bad.length) {
  console.log('Failures:');
  for (const b of bad) console.log(`  ${b.method} ${b.path} -> ${b.status}${b.serverErr ? ' (server error page)' : ''}`);
  process.exit(1);
}
console.log('All green.\n');
