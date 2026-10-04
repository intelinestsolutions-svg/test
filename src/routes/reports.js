import { all, get } from '../db.js';
import { html, num, str, int, today, addDays, monthStart, download, toCsv } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  alert, linkBtn, field, filterBar, tabs,
} from '../lib/html.js';
import { materialCostForMix, round2, mixByCode, dashboardKpis, allowanceRates } from '../lib/biz.js';

export const reportRoutes = [
  /* ============ SALES ============ */
  {
    method: 'GET', path: '/reports', role: ['admin'], handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const from = ctx.query.from || monthStart();
      const to = ctx.query.to || today();
      const r = buildReport(from, to, ctx.lang);

      const tab = ctx.query.tab || 'sales';
      const tabsHtml = tabs(ctx, [
        ['/reports?tab=sales' + qs(ctx), T('rep.salesSummary'), null],
        ['/reports?tab=profit' + qs(ctx), T('rep.profitLoss'), null],
        ['/reports?tab=stock' + qs(ctx), T('rep.stockReport'), null],
        ['/reports?tab=fleet' + qs(ctx), T('flt.title'), null],
        ['/reports?tab=people' + qs(ctx), T('stf.title'), null],
      ], `/reports?tab=${tab}${qs(ctx)}`);

      const filter = filterBar(ctx, {
        action: '/reports',
        fields: [
          field({ label: T('rep.dateRange') + ' (dari)', name: 'from', type: 'date', value: from }),
          field({ label: T('rep.dateRange') + ' (hingga)', name: 'to', type: 'date', value: to }),
          `<input type="hidden" name="tab" value="${esc(tab)}">`,
        ].join(''),
      });

      let panel = '';
      if (tab === 'sales') panel = salesPanel(ctx, r);
      else if (tab === 'profit') panel = profitPanel(ctx, r);
      else if (tab === 'stock') panel = stockPanel(ctx);
      else if (tab === 'fleet') panel = fleetPanel(ctx, r);
      else if (tab === 'people') panel = peoplePanel(ctx, r);

      return html(ctx.res, page(ctx, {
        title: T('rep.title'),
        body: `${filter}${tabsHtml}<div class="actions-row">${linkBtn(T('a.export'), `/reports/${tab}.csv?from=${from}&to=${to}`, { ic: 'download' })}</div>${panel}`,
      }));
    },
  },

  /* ============ CSV exports ============ */
  ...['sales', 'profit', 'stock', 'fleet', 'people'].map((tab) => ({
    method: 'GET', path: `/reports/${tab}.csv`, role: ['admin'],
    handler(ctx) {
      const from = ctx.query.from || monthStart();
      const to = ctx.query.to || today();
      const r = buildReport(from, to, ctx.lang);
      let rows = [];
      if (tab === 'sales') rows = r.daily.map((d) => [d.day, d.orders, d.m3, d.amount]);
      else if (tab === 'profit') rows = r.byMix.map((m) => [m.mix, m.m3, m.revenue, m.matCost, m.fuelCost, m.gross, m.marginPct]);
      else if (tab === 'fleet') rows = r.lorries.map((l) => [l.code, l.reg_no, l.capacity_m3, l.trips, l.m3, l.fuelCost, l.costPerM3]);
      else if (tab === 'people') rows = r.drivers.map((d) => [d.name, d.emp_no, d.trips, d.m3, d.km]);
      else if (tab === 'stock') rows = stockRows().map((s) => [s.sku, s.name, s.category, s.unit, s.bal, s.min_qty, s.unit_cost, s.value]);
      download(ctx.res, toCsv(rows), `${tab}-${from}-to-${to}.csv`);
    },
  })),
];

/* ---------------- data builder ---------------- */
function buildReport(from, to, lang) {
  const orders = all(`
    SELECT o.*, c.name AS customer, c.area,
           (SELECT name FROM sites WHERE id = o.site_id) AS site_name
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.delivery_date BETWEEN ? AND ? AND o.status NOT IN ('cancelled','draft')`, from, to);

  const delivered = all(`
    SELECT t.*, o.mix_code, o.customer_id, o.order_no, t.lorry_id, t.driver_id
    FROM trips t JOIN orders o ON o.id = t.order_id
    WHERE t.status IN ('delivered','returned') AND o.delivery_date BETWEEN ? AND ?`, from, to);

  const daily = {};
  for (const o of orders) {
    const d = (daily[o.delivery_date] ||= { day: o.delivery_date, orders: 0, m3: 0, amount: 0 });
    d.orders++; d.m3 += num(o.volume_m3); d.amount += num(o.amount);
  }

  /* revenue/mix grouping based on delivered m3 */
  const byMixMap = {};
  for (const o of orders) {
    const m = byMixMap[o.mix_code] ||= { mix: o.mix_code, m3: 0, revenue: 0, matCost: 0, fuelCost: 0, orders: 0 };
    m.orders++;
    m.revenue += num(o.amount);
    m.m3 += num(o.volume_m3);
    const mix = mixByCode(o.mix_code);
    if (mix) m.matCost += materialCostForMix(mix, num(o.volume_m3)).total;
  }
  const fuelByLorry = all(`SELECT lorry_id, COALESCE(SUM(total),0) AS cost FROM fuel_logs
                           WHERE log_date BETWEEN ? AND ? GROUP BY lorry_id`, from, to);
  for (const t of delivered) {
    const m = byMixMap[t.mix_code];
    if (!m) continue;
    const share = num(o_share(t, orders));
    const lf = fuelByLorry.find((f) => f.lorry_id === t.lorry_id);
    if (lf) m.fuelCost += num(lf.cost) * share;
  }
  const byMix = Object.values(byMixMap).map((m) => {
    const gross = round2(m.revenue - m.matCost - m.fuelCost);
    return { ...m, m3: round2(m.m3), revenue: round2(m.revenue), matCost: round2(m.matCost), fuelCost: round2(m.fuelCost), gross, marginPct: m.revenue > 0 ? Math.round(gross / m.revenue * 100) : 0 };
  }).sort((a, b) => b.revenue - a.revenue);

  const byAreaMap = {};
  for (const o of orders) {
    const a = (byAreaMap[o.area || '—'] ||= { area: o.area || '—', m3: 0, amount: 0, orders: 0 });
    a.orders++; a.m3 += num(o.volume_m3); a.amount += num(o.amount);
  }
  const byArea = Object.values(byAreaMap).map((a) => ({ ...a, m3: round2(a.m3), amount: round2(a.amount) })).sort((x, y) => y.amount - x.amount);

  const byCustMap = {};
  for (const o of orders) {
    const c = (byCustMap[o.customer] ||= { customer: o.customer, m3: 0, amount: 0, orders: 0 });
    c.orders++; c.m3 += num(o.volume_m3); c.amount += num(o.amount);
  }
  const byCustomer = Object.values(byCustMap).map((c) => ({ ...c, m3: round2(c.m3), amount: round2(c.amount) })).sort((x, y) => y.amount - x.amount);

  /* lorries */
  const lorries = all('SELECT * FROM lorries WHERE active = 1 ORDER BY code').map((l) => {
    const mine = delivered.filter((t) => t.lorry_id === l.id);
    const m3 = round2(mine.reduce((s, t) => s + num(t.delivered_m3), 0));
    const km = round2(mine.reduce((s, t) => s + Math.max(0, num(t.odo_end) - num(t.odo_start)), 0));
    const fuel = fuelByLorry.find((f) => f.lorry_id === l.id);
    const fuelCost = round2(num(fuel?.cost));
    return { ...l, trips: mine.length, m3, km, fuelCost, costPerM3: m3 > 0 ? round2(fuelCost / m3) : 0, lPer100: km > 0 ? round2(num(fuel?.litres || 0) / km * 100) : 0 };
  });

  /* drivers */
  const drivers = all(`SELECT s.* FROM staff s WHERE s.role = 'driver' AND s.status != 'resigned' ORDER BY s.name`).map((s) => {
    const mine = delivered.filter((t) => t.driver_id === s.id);
    return {
      ...s,
      trips: mine.length,
      m3: round2(mine.reduce((x, t) => x + num(t.delivered_m3), 0)),
      km: round2(mine.reduce((x, t) => x + Math.max(0, num(t.odo_end) - num(t.odo_start)), 0)),
      waste: round2(mine.reduce((x, t) => x + num(t.returned_m3), 0)),
    };
  }).sort((a, b) => b.m3 - a.m3);

  const totalM3 = round2(orders.reduce((s, o) => s + num(o.volume_m3), 0));
  const totalRevenue = round2(orders.reduce((s, o) => s + num(o.amount), 0));
  const totalDelivered = round2(delivered.reduce((s, t) => s + num(t.delivered_m3), 0));
  const totalMat = round2(byMix.reduce((s, m) => s + m.matCost, 0));
  const totalFuel = round2(fuelByLorry.reduce((s, f) => s + num(f.cost), 0));
  const cashIn = get(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='confirmed' AND paid_at BETWEEN ? AND ?`, from, to);
  const stockValue = round2(stockRows().reduce((s, r) => s + r.value, 0));

  return {
    from, to, orders, delivered, byMix, byArea, byCustomer, lorries, drivers,
    daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, m3: round2(d.m3), amount: round2(d.amount) })),
    totals: {
      orders: orders.length, m3: totalM3, delivered: totalDelivered, revenue: totalRevenue,
      matCost: totalMat, fuelCost: totalFuel,
      gross: round2(totalRevenue - totalMat - totalFuel),
      marginPct: totalRevenue > 0 ? Math.round((totalRevenue - totalMat - totalFuel) / totalRevenue * 100) : 0,
      cashIn: round2(cashIn.s), stockValue,
    },
  };
}
function o_share(t, orders) {
  const o = orders.find((x) => x.id === t.order_id);
  if (!o || num(o.volume_m3) === 0) return 0;
  return num(t.batch_m3) / num(o.volume_m3);
}
function stockRows() {
  return all(`
    SELECT i.*, (SELECT COALESCE(SUM(CASE WHEN sm.type IN ('in','adjust') THEN sm.qty ELSE -sm.qty END),0) FROM stock_movements sm WHERE sm.item_id = i.id) AS bal
    FROM items i WHERE i.active = 1 ORDER BY i.category, i.name`)
    .map((r) => ({ ...r, bal: round2(num(r.bal)), value: round2(num(r.bal) * num(r.unit_cost)), low: num(r.bal) <= num(r.min_qty) }));
}
function qs(ctx) {
  const p = new URLSearchParams();
  if (ctx.query.from) p.set('from', ctx.query.from);
  if (ctx.query.to) p.set('to', ctx.query.to);
  const s = p.toString();
  return s ? '&' + s : '';
}

/* ---------------- panels ---------------- */
const stat = (label, value, sub = '', tone = '') =>
  `<div class="stat ${tone}"><div class="stat-top"><span class="stat-label">${label}</span></div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;

function salesPanel(ctx, r) {
  const T = (k) => esc(ctx.t(k));
  const { lang } = ctx;
  const max = Math.max(1, ...r.daily.map((d) => num(d.amount)));
  return `
    <div class="stat-grid">
      ${stat(T('rep.revenue'), esc(money(r.totals.revenue, lang)), `${r.totals.orders} ${T('ord.no').toLowerCase()}`)}
      ${stat(T('a.volume'), `${qty(r.totals.m3)} m³`, `${qty(r.totals.delivered)} ${T('dlv.deliveredQty').toLowerCase()}`, 'teal')}
      ${stat(T('pay.collect'), esc(money(r.totals.cashIn, lang)), T('rep.inOut'), 'green')}
      ${stat(T('rep.stockValueReport'), esc(money(r.totals.stockValue, lang)))}
    </div>
    ${card(cardHead(T('rep.dailySales')), r.daily.length ? `<div class="chart">
      ${r.daily.map((d) => `<div class="chart-col" title="${fmtDate(d.day, lang)}: ${esc(money(d.amount, lang))}">
        <div class="chart-bar" style="height:${Math.max(2, Math.round(num(d.amount) / max * 100))}%"></div>
        <div class="chart-lbl tiny">${d.day.slice(8)}</div></div>`).join('')}
    </div>` : `<p class="muted">${T('a.noData')}</p>`)}
    <div class="grid-2">
      ${card(cardHead(T('rep.byMix')), table([
        { key: 'mix', label: T('a.mix'), cell: (x) => badge(esc(x.mix || '—'), 'mix') },
        { key: 'orders', label: T('ord.no'), align: 'right' },
        { key: 'm3', label: T('a.volume'), align: 'right', cell: (x) => `${qty(x.m3)} m³` },
        { key: 'amount', label: T('rep.revenue'), align: 'right', cell: (x) => esc(money(x.amount, lang)) },
      ], r.byMix, { emptyMsg: T('a.noData') }))}
      ${card(cardHead(T('rep.byArea')), table([
        { key: 'area', label: T('a.area') },
        { key: 'orders', label: T('ord.no'), align: 'right' },
        { key: 'm3', label: T('a.volume'), align: 'right', cell: (x) => `${qty(x.m3)} m³` },
        { key: 'amount', label: T('rep.revenue'), align: 'right', cell: (x) => esc(money(x.amount, lang)) },
      ], r.byArea, { emptyMsg: T('a.noData') }))}
    </div>
    <div class="grid-1">${card(cardHead(T('dash.topCustomers')), table([
      { key: 'customer', label: T('a.customer') },
      { key: 'orders', label: T('ord.no'), align: 'right' },
      { key: 'm3', label: T('a.volume'), align: 'right', cell: (x) => `${qty(x.m3)} m³` },
      { key: 'amount', label: T('rep.revenue'), align: 'right', cell: (x) => esc(money(x.amount, lang)) },
    ], r.byCustomer, { emptyMsg: T('a.noData') }))}</div>`;
}

function profitPanel(ctx, r) {
  const T = (k) => esc(ctx.t(k));
  const { lang } = ctx;
  const t = r.totals;
  return `
    <div class="stat-grid">
      ${stat(T('rep.revenue'), esc(money(t.revenue, lang)))}
      ${stat(T('rep.materialCost'), esc(money(t.matCost, lang)), t.revenue > 0 ? `${Math.round(t.matCost / t.revenue * 100)}%` : '', 'amber')}
      ${stat(T('rep.fuelCost'), esc(money(t.fuelCost, lang)), t.revenue > 0 ? `${Math.round(t.fuelCost / t.revenue * 100)}%` : '', 'amber')}
      ${stat(T('rep.grossProfit'), esc(money(t.gross, lang)), `${t.marginPct}% ${T('rep.margin').toLowerCase()}`, t.gross >= 0 ? 'green' : 'red')}
    </div>
    ${card(cardHead(T('rep.byMix')), table([
      { key: 'mix', label: T('a.mix'), cell: (x) => badge(esc(x.mix || '—'), 'mix') },
      { key: 'm3', label: T('a.volume'), align: 'right', cell: (x) => `${qty(x.m3)} m³` },
      { key: 'revenue', label: T('rep.revenue'), align: 'right', cell: (x) => esc(money(x.revenue, lang)) },
      { key: 'matCost', label: T('rep.materialCost'), align: 'right', cell: (x) => esc(money(x.matCost, lang)) },
      { key: 'fuelCost', label: T('rep.fuelCost'), align: 'right', cell: (x) => esc(money(x.fuelCost, lang)) },
      { key: 'gross', label: T('rep.grossProfit'), align: 'right', cell: (x) => `<b class="${x.gross >= 0 ? 'green' : 'neg'}">${esc(money(x.gross, lang))}</b>` },
      { key: 'marginPct', label: T('rep.margin'), align: 'right', cell: (x) => `<span class="${x.marginPct < 10 ? 'neg' : x.marginPct < 20 ? 'amber' : 'green'}">${x.marginPct}%</span>` },
    ], r.byMix, { emptyMsg: T('a.noData') }))}
    ${card(cardHead(T('rep.cashflow')), `
      <table class="tbl kv">
        <tr><th>${T('rep.inOut')} · ${T('pay.title')}</th><td class="ta-right green">+ ${esc(money(t.cashIn, lang))}</td></tr>
        <tr><th>${T('rep.fuelCost')}</th><td class="ta-right">− ${esc(money(t.fuelCost, lang))}</td></tr>
        <tr><th>${T('rep.materialCost')}</th><td class="ta-right">− ${esc(money(t.matCost, lang))}</td></tr>
        <tr class="big"><th>${T('rep.grossProfit')}</th><td class="ta-right ${t.gross >= 0 ? 'green' : 'neg'}">${esc(money(t.gross, lang))}</td></tr>
      </table>
      <p class="tiny muted">${T('rep.materialCost')} ${T('a.optional')}: ${T('inv.title')} → ${T('inv.new')}</p>`)}`;
}

function stockPanel(ctx) {
  const T = (k) => esc(ctx.t(k));
  const { lang } = ctx;
  const rows = stockRows();
  const total = round2(rows.reduce((s, r) => s + r.value, 0));
  const low = rows.filter((r) => r.low);
  const byCat = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + r.value;
  return `
    <div class="stat-grid">
      ${stat(T('rep.stockValueReport'), esc(money(total, lang)))}
      ${stat(T('inv.cat.material'), esc(money(byCat.material || 0, lang)))}
      ${stat(T('inv.cat.fuel'), esc(money(byCat.fuel || 0, lang)))}
      ${stat(T('inv.cat.part'), esc(money(byCat.part || 0, lang)))}
    </div>
    ${low.length ? alert('warn', `${T('inv.low')}: ${low.map((i) => `${esc(i.name)} (${qty(i.bal)})`).join(', ')}`) : ''}
    ${card(cardHead(T('rep.stockReport')), table([
      { key: 'sku', label: T('inv.sku') },
      { key: 'name', label: T('inv.item'), cell: (r) => `<a href="/inventory/${r.id}"><b>${esc(r.name)}</b></a>` },
      { key: 'category', label: T('inv.category'), cell: (r) => badge(esc(T('inv.cat.' + r.category)), 'cat-' + r.category) },
      { key: 'bal', label: T('inv.stock'), align: 'right', cell: (r) => `<b class="${r.low ? 'amber' : ''}">${qty(r.bal)}</b> ${esc(r.unit)}` },
      { key: 'min_qty', label: T('inv.min'), align: 'right', cell: (r) => qty(r.min_qty) },
      { key: 'unit_cost', label: T('inv.unitCost'), align: 'right', cell: (r) => esc(money(r.unit_cost, lang)) },
      { key: 'value', label: T('inv.stockValue'), align: 'right', cell: (r) => esc(money(r.value, lang)) },
    ], rows, { emptyMsg: T('a.noData') }))}`;
}

function fleetPanel(ctx, r) {
  const T = (k) => esc(ctx.t(k));
  const { lang } = ctx;
  return `
    <div class="stat-grid">
      ${stat(T('flt.title'), String(r.lorries.length))}
      ${stat(T('a.volume'), `${qty(r.totals.delivered)} m³`, '', 'teal')}
      ${stat(T('rep.fuelCost'), esc(money(r.totals.fuelCost, lang)))}
      ${stat(T('flt.costPerM3'), esc(money(r.totals.delivered > 0 ? r.totals.fuelCost / r.totals.delivered : 0, lang)), T('rep.fuelCost'), 'amber')}
    </div>
    ${card(cardHead(T('rep.lorryPerformance')), table([
      { key: 'code', label: T('flt.code'), cell: (x) => `<a href="/fleet/${x.id}"><b>${esc(x.code)}</b></a>` },
      { key: 'reg_no', label: T('flt.regNo') },
      { key: 'trips', label: T('rep.tripsCount'), align: 'right' },
      { key: 'm3', label: T('a.volume'), align: 'right', cell: (x) => `<b>${qty(x.m3)} m³</b>` },
      { key: 'km', label: T('rep.kmTravelled'), align: 'right', cell: (x) => qty(x.km, 0) },
      { key: 'lPer100', label: T('fue.consumption'), align: 'right', cell: (x) => x.lPer100 ? `${qty(x.lPer100, 1)} L` : '—' },
      { key: 'fuelCost', label: T('rep.fuelCost'), align: 'right', cell: (x) => esc(money(x.fuelCost, lang)) },
      { key: 'costPerM3', label: T('flt.costPerM3'), align: 'right', cell: (x) => esc(money(x.costPerM3, lang)) },
      { key: 'avg', label: T('rep.avgM3PerTrip'), align: 'right', cell: (x) => x.trips ? qty(x.m3 / x.trips) : '—' },
    ], r.lorries, { emptyMsg: T('a.noData') }))}`;
}

function peoplePanel(ctx, r) {
  const T = (k) => esc(ctx.t(k));
  const { lang } = ctx;
  const a = allowanceRates();
  return `
    <div class="stat-grid">
      ${stat(T('stf.role.driver'), String(r.drivers.length))}
      ${stat(T('rep.tripsCount'), String(r.drivers.reduce((s, d) => s + d.trips, 0)))}
      ${stat(T('a.volume'), `${qty(r.drivers.reduce((s, d) => s + d.m3, 0))} m³`, '', 'teal')}
      ${stat(T('inv.waste'), `${qty(r.drivers.reduce((s, d) => s + d.waste, 0))} m³`, T('dlv.returnedQty'), 'amber')}
    </div>
    ${card(cardHead(T('rep.driverPerformance')), table([
      { key: 'name', label: T('a.name'), cell: (x) => `<a href="/staff/${x.id}"><b>${esc(x.name)}</b></a>` },
      { key: 'emp_no', label: T('stf.empNo'), cell: (x) => esc(x.emp_no || '—') },
      { key: 'licence_class', label: T('stf.licenceClass'), cell: (x) => esc(x.licence_class || '—') },
      { key: 'trips', label: T('rep.tripsCount'), align: 'right' },
      { key: 'm3', label: T('a.volume'), align: 'right', cell: (x) => `<b>${qty(x.m3)} m³</b>` },
      { key: 'avg', label: T('rep.avgM3PerTrip'), align: 'right', cell: (x) => x.trips ? qty(x.m3 / x.trips) : '—' },
      { key: 'km', label: T('rep.kmTravelled'), align: 'right', cell: (x) => qty(x.km, 0) },
      { key: 'waste', label: T('inv.waste'), align: 'right', cell: (x) => x.waste ? `<span class="amber">${qty(x.waste)} m³</span>` : '0' },
      { key: 'allow', label: T('pay.tripAllow'), align: 'right', cell: (x) => esc(money(x.trips * a.driverTrip, lang)) },
    ], r.drivers, { emptyMsg: T('a.noData') }))}`;
}
