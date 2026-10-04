/**
 * Public customer portal (no login): landing, price list, order tracking.
 * Pages backed by the live database.
 */
import { all, get } from '../db.js';
import { html, redirect, str } from '../lib/http.js';
import { esc, money, qty, fmtDate } from '../lib/html.js';
import { translate } from '../i18n.js';

const T = (lang, k) => esc(translate(lang, k));

const ST = {
  draft: ['Draf', 'Draft'], confirmed: ['Disahkan', 'Confirmed'],
  loading: ['Dimuat', 'Loading'], dispatched: ['Dihantar', 'Dispatched'],
  delivered: ['Diterima', 'Delivered'], returned: ['Kembali', 'Returned'],
  completed: ['Siap', 'Completed'], cancelled: ['Batal', 'Cancelled'],
  planned: ['Dirancang', 'Planned'], void: ['Batal', 'Void'],
};
const st = (lang, s) => {
  const r = ST[String(s || '')];
  return r ? (lang === 'bm' ? r[0] : r[1]) : String(s || '');
};
const badgeKind = (s) => (['delivered', 'completed', 'returned'].includes(s) ? 'ok'
  : (['dispatched', 'loading', 'confirmed'].includes(s) ? 'warn' : ''));

function shell(ctx, title, body) {
  const lang = ctx.lang;
  const other = lang === 'bm' ? 'en' : 'bm';
  const back = ctx.fullUrl && ctx.fullUrl.startsWith('/') ? ctx.fullUrl : '/';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Kotamix Concrete</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/css/portal.css">
</head>
<body>
<div class="por-top">
  <a class="por-brand" href="/"><img src="/img/kotamix-logo.png" alt="Kotamix Concrete" height="30"></a>
  <a class="por-lang" href="/lang/${other}?next=${encodeURIComponent(back)}">${lang === 'bm' ? 'BM | EN' : 'EN | BM'}</a>
</div>
<main class="por-wrap">${body}</main>
<footer class="por-foot">© 2026 Kotamix Concrete · Kota Kinabalu, Sabah</footer>
</body>
</html>`;
}

function landing(ctx) {
  const lang = ctx.lang;
  const s = ctx.settings;
  const cards = [
    ['/prices', '🏗️', T(lang, 'por.customer'), T(lang, 'por.customerD')],
    ['/login', '🚚', T(lang, 'por.driver'), T(lang, 'por.driverD')],
    ['/login', '🏢', T(lang, 'por.office'), T(lang, 'por.officeD')],
  ].map(([href, emoji, h, p]) =>
    `<a class="role-card" href="${href}"><div class="emoji">${emoji}</div><h3>${h}</h3><p>${p}</p></a>`).join('');
  const body = `
    <div class="por-hero">
      <img class="por-logo-img" src="/img/kotamix-logo.png" alt="Kotamix Concrete">
      <h1>Kotamix Concrete</h1>
      <p class="tagline">${T(lang, 'por.tagline')}</p>
    </div>
    <div class="role-grid">${cards}</div>
    <div class="card"><h2>${T(lang, 'por.contact')}</h2>
      <div class="muted">${esc(s.company_phone || '')}<br>${esc(s.company_address || '')}<br>${esc(s.company_email || '')}</div>
      <div class="row-btns">
        <a class="btn btn-primary" href="/track">${T(lang, 'por.track')}</a>
        <a class="btn" href="/prices">${T(lang, 'por.prices')}</a>
        <a class="btn btn-ghost" href="/login">${T(lang, 'por.staffLogin')}</a>
      </div>
    </div>`;
  return html(ctx.res, shell(ctx, 'Kotamix Concrete', body));
}

function prices(ctx) {
  const lang = ctx.lang;
  const s = ctx.settings;
  const mixes = all(`SELECT * FROM mix_designs WHERE active = 1 ORDER BY grade_mpa, code`);
  const rows = mixes.map((m) => `<tr><td><b>${esc(m.code)}</b><br><span class="muted">${esc(m.name || '')}</span></td>
    <td>${m.grade_mpa ? `${qty(m.grade_mpa, 0)} MPa` : '—'}</td>
    <td style="text-align:right"><b>${esc(money(m.price_per_m3, lang))}</b><br><span class="muted">${T(lang, 'por.perM3')}</span></td></tr>`).join('');
  const body = `
    <div class="card"><h2>${T(lang, 'por.prices')}</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>${T(lang, 'por.mix')}</th><th>${T(lang, 'por.grade')}</th><th style="text-align:right">RM/m³</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" class="muted">—</td></tr>`}</tbody>
      </table></div>
      <p class="muted" style="margin-top:10px;font-size:12.5px">${T(lang, 'por.deliveryCharge')}: <b>${esc(money(s.default_delivery_charge, lang))}</b> · ${T(lang, 'por.sstNote')} (${esc(s.sst_rate)}%)</p>
      <div class="row-btns"><a class="btn btn-ghost" href="/">← ${T(lang, 'por.home')}</a></div>
    </div>`;
  return html(ctx.res, shell(ctx, translate(lang, 'por.prices'), body));
}

function track(ctx) {
  const lang = ctx.lang;
  const no = str(ctx.query.no).trim();
  let result = '';
  if (no) {
    const o = get(`SELECT o.*, c.name AS customer, c.company FROM orders o
                   JOIN customers c ON c.id = o.customer_id
                   WHERE lower(o.order_no) = ?`, no.toLowerCase());
    if (!o) {
      result = `<div class="alert-err">${T(lang, 'por.notFound')}</div>`;
    } else {
      const trips = all('SELECT trip_no, status, batch_m3, delivered_m3 FROM trips WHERE order_id = ? AND status != ? ORDER BY run_no', o.id, 'void');
      const done = trips.reduce((a, t) => a + Number(t.delivered_m3 || 0), 0);
      const pct = Math.min(100, Math.round(done / Math.max(o.volume_m3, 0.001) * 100));
      const tripRows = trips.map((t) => `<tr><td><b>${esc(t.trip_no)}</b></td>
        <td>${qty(t.batch_m3)} m³</td><td>${qty(t.delivered_m3)} m³</td>
        <td><span class="badge ${badgeKind(t.status)}">${esc(st(lang, t.status))}</span></td></tr>`).join('');
      result = `<div class="card"><h2>${esc(o.order_no)} <span class="badge ${badgeKind(o.status)}">${esc(st(lang, o.status))}</span></h2>
        <dl class="kv">
          <dt>${T(lang, 'por.customer')}</dt><dd>${esc(o.company || o.customer)}</dd>
          <dt>${T(lang, 'por.delivery')}</dt><dd>${esc(fmtDate(o.delivery_date, lang))} (${esc(o.delivery_slot || '')})</dd>
          <dt>${T(lang, 'por.progress')}</dt><dd>${qty(done)} / ${qty(o.volume_m3)} m³ ${T(lang, 'por.deliveredOf')}</dd>
        </dl>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Trip</th><th>Batch</th><th>${T(lang, 'por.progress')}</th><th>${T(lang, 'por.delivery')}</th></tr></thead>
          <tbody>${tripRows}</tbody>
        </table></div></div>`;
    }
  }
  const body = `
    <div class="card"><h2>${T(lang, 'por.track')}</h2>
      <p class="muted" style="margin-bottom:10px">${T(lang, 'por.trackHint')}</p>
      <form method="get" action="/track" class="inline-form">
        <input name="no" value="${esc(no)}" placeholder="SO-2026-0001" autocapitalize="off" required>
        <button class="btn btn-primary" type="submit">${T(lang, 'por.search')}</button>
      </form></div>
    ${result}
    <div class="row-btns"><a class="btn btn-ghost" href="/">← ${T(lang, 'por.home')}</a></div>`;
  return html(ctx.res, shell(ctx, translate(lang, 'por.track'), body));
}

export const portalRoutes = [
  {
    method: 'GET', path: '/', public: true,
    handler(ctx) {
      if (ctx.user) return redirect(ctx.res, '/dashboard');
      return landing(ctx);
    },
  },
  { method: 'GET', path: '/prices', public: true, handler: prices },
  { method: 'GET', path: '/track', public: true, handler: track },
];
