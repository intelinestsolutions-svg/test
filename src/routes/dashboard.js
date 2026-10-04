import { all, get } from '../db.js';
import { redirect, html, today, num } from '../lib/http.js';
import { page, statCard, table, card, cardHead, badge, icon, btn, esc, money, qty, fmtDate, statusBadge, raw, alert, linkBtn } from '../lib/html.js';
import { dashboardKpis, round2 } from '../lib/biz.js';

export const dashboardRoutes = [
  {
    method: 'GET', path: '/dashboard', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const date = ctx.query.date || today();
      const k = dashboardKpis(date);

      /* ---- stat cards ---- */
      const fleetBy = (s) => num(k.fleet.find((f) => f.status === s)?.n);
      const stats = [
        statCard({
          label: T('dash.todayOrders'), ic: 'orders',
          value: `${num(k.ordersToday.n)} <small>${T('a.records')}</small>`,
          sub: `${qty(k.ordersToday.m3)} m³ ${T('ord.volume')}`, href: `/orders?date=${date}`,
        }),
        statCard({
          label: T('dash.todayM3'), ic: 'truck', tone: 'teal',
          value: `<span>${qty(k.deliveredToday.m3)} m³</span>`,
          sub: `${num(k.deliveredToday.n)} ${T('dlv.trip').toLowerCase()}`, href: `/deliveries?date=${date}`,
        }),
        statCard({
          label: T('dash.todayRevenue'), ic: 'payments', tone: 'green',
          value: `<span>${esc(money(k.cashToday, lang))}</span>`,
          sub: `${T('pay.collect')}: ${esc(money(k.ordersToday.amt, lang))} ${T('inv2.no').toLowerCase()}`,
          href: '/payments',
        }),
        statCard({
          label: T('dash.outstanding'), ic: 'receivable', tone: k.receivables > 0 ? 'amber' : '',
          value: `<span>${esc(money(k.receivables, lang))}</span>`,
          sub: `${T('dash.overdue')}: <b>${esc(money(k.overdue, lang))}</b>`, href: '/receivables',
        }),
        statCard({
          label: T('dash.tripsToday'), ic: 'schedule', tone: 'teal',
          value: `<span>${num(k.tripsToday)}</span>`,
          sub: `${T('dash.lorriesOnRoad')}: ${fleetBy('on_delivery')}`, href: `/deliveries?date=${date}`,
        }),
        statCard({
          label: T('dash.lowStock'), ic: 'warn', tone: k.lowStock.length ? 'red' : 'green',
          value: `<span>${num(k.lowStock.length)}</span>`,
          sub: k.lowStock.length ? T('a.yes') : T('inv.ok'), href: '/inventory?filter=low',
        }),
      ].join('');

      /* ---- quick actions ---- */
      const quick = card(`
        <div class="quick-grid">
          ${linkBtn(T('dash.newOrder'), '/orders/new', { ic: 'plus', variant: 'primary' })}
          ${linkBtn(T('dlv.board'), '/schedule', { ic: 'schedule' })}
          ${linkBtn(T('dash.newCust'), '/customers/new', { ic: 'customers' })}
          ${linkBtn(T('dash.receivePayment'), '/payments/new', { ic: 'payments' })}
          ${linkBtn(T('dash.recordFuel'), '/fuel/new', { ic: 'fuel' })}
          ${linkBtn(T('dash.stockIn'), '/inventory/in', { ic: 'inventory' })}
        </div>`, 'quick-card');

      /* ---- fleet status ---- */
      const lorries = all('SELECT * FROM lorries WHERE active = 1 ORDER BY code');
      const fleetBody = lorries.length ? `<div class="fleet-grid">${lorries.map((l) => {
        const pct = Math.min(100, Math.round(num(l.fuel_litres) / 300 * 100));
        const lvl = pct <= 20 ? 'low' : pct <= 45 ? 'mid' : 'ok';
        return `<a class="fleet-card" href="/fleet/${l.id}">
          <div class="fleet-top"><b>${esc(l.code)}</b>${statusBadge(ctx, 'flt.status', l.status)}</div>
          <div class="fleet-reg">${esc(l.reg_no)} · ${qty(l.capacity_m3, 1)} m³</div>
          <div class="fuel-bar" title="${qty(l.fuel_litres, 0)} L">
            <div class="fuel-fill ${lvl}" style="width:${pct}%"></div>
            <span class="fuel-txt">${qty(l.fuel_litres, 0)} L</span>
          </div>
        </a>`;
      }).join('')}</div>` : `<p class="muted">${T('a.noData')}</p>`;
      const fleetCard = card(cardHead(`${T('flt.title')} · ${T('nav.fuel')}`, linkBtn(T('a.view'), '/fleet', { variant: 'link' })) + fleetBody);

      /* ---- low stock ---- */
      const lowRows = k.lowStock.map((i) => ({ ...i, bal: round2(i.bal) }));
      const lowTable = table([
        { key: 'name', label: T('inv.item') },
        { key: 'unit', label: T('a.unit'), width: '70px' },
        { key: 'bal', label: T('inv.stock'), align: 'right', cell: (r) => `<b>${qty(r.bal)}</b>` },
        { key: 'min_qty', label: T('inv.min'), align: 'right', cell: (r) => qty(r.min_qty) },
        {
          key: 'st', label: T('a.status'), align: 'right',
          cell: (r) => badge(r.bal <= 0 ? T('inv.outOfStock') : T('inv.low'), r.bal <= 0 ? 'bad' : 'warn'),
        },
      ], lowRows, { emptyMsg: T('inv.ok') });
      const stockCard = card(cardHead(T('dash.lowStockList'), linkBtn(T('a.view'), '/inventory?filter=low', { variant: 'link' })) + lowTable);

      /* ---- today's + tomorrow's schedule ---- */
      const schedRows = all(`
        SELECT t.*, o.order_no, o.delivery_slot, o.volume_m3, o.mix_code, o.delivery_date,
               c.name AS customer, l.code AS lorry_code, s.name AS driver,
               (SELECT name FROM sites WHERE id = o.site_id) AS site_name
        FROM trips t
        JOIN orders o ON o.id = t.order_id
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN lorries l ON l.id = t.lorry_id
        LEFT JOIN staff s ON s.id = t.driver_id
        WHERE o.delivery_date IN (?, ?) AND t.status != 'void' AND o.status != 'cancelled'
        ORDER BY o.delivery_date, o.delivery_slot, o.id, t.run_no`, date, k.tomorrow);
      const isToday = (r) => r.delivery_date === date;
      const schedToday = schedRows.filter(isToday);
      const schedTomo = schedRows.filter((r) => !isToday(r));
      const schedCols = [
        { key: 'trip_no', label: T('a.no'), cell: (r) => `<a href="/deliveries/${r.id}"><b>${esc(r.trip_no)}</b></a>` },
        { key: 'time', label: T('a.time'), width: '90px', cell: (r) => slotLabel(ctx, r.delivery_slot) },
        { key: 'lorry_code', label: T('a.lorry'), cell: (r) => esc(r.lorry_code || '—') },
        { key: 'driver', label: T('a.driver'), cell: (r) => esc(r.driver || '—') },
        { key: 'customer', label: T('a.customer'), cell: (r) => `<span class="trunc">${esc(r.customer)}</span>` },
        { key: 'site_name', label: T('doc.site'), cell: (r) => `<span class="trunc muted">${esc(r.site_name || '—')}</span>` },
        { key: 'mix_code', label: T('a.mix'), cell: (r) => badge(esc(r.mix_code || '—'), 'mix') },
        { key: 'batch_m3', label: T('dlv.batch'), align: 'right', cell: (r) => `${qty(r.batch_m3)} m³` },
        { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'trip.status', r.status) },
      ];
      const todayCard = card(
        cardHead(`${T('dash.board')} · ${fmtDate(date, lang)}`, linkBtn(T('a.view'), '/deliveries?date=' + date, { variant: 'link' })) +
        table(schedCols, schedToday, { emptyMsg: T('a.noData') })
      );
      const tomoCard = card(
        cardHead(`${T('dash.nextSchedule')} · ${fmtDate(k.tomorrow, lang)}`, linkBtn(T('sch.board'), '/schedule?date=' + k.tomorrow, { variant: 'link' })) +
        table(schedCols, schedTomo, { emptyMsg: T('a.noData') })
      );

      /* ---- mix usage 30d ---- */
      const mixRows = all(`
        SELECT o.mix_code AS mix, COUNT(DISTINCT o.id) AS orders,
               COALESCE(SUM(t.delivered_m3),0) AS m3, COALESCE(SUM(o.amount),0) AS amt
        FROM orders o LEFT JOIN trips t ON t.order_id = o.id AND t.status IN ('delivered','returned')
        WHERE o.delivery_date >= date('now','-30 day') AND o.status != 'cancelled'
        GROUP BY o.mix_code ORDER BY m3 DESC LIMIT 8`);
      const maxM3 = Math.max(1, ...mixRows.map((r) => num(r.m3)));
      const mixCard = card(cardHead(T('dash.mixUsage')) + (mixRows.length ? mixRows.map((r) => `
        <div class="bar-row">
          <span class="bar-label">${esc(r.mix || '—')}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(num(r.m3) / maxM3 * 100)}%"></div></div>
          <span class="bar-val">${qty(r.m3)} m³</span>
        </div>`).join('') : `<p class="muted">${T('a.noData')}</p>`));

      /* ---- top customers 30d ---- */
      const topRows = all(`
        SELECT c.name, c.code, COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(o.amount),0) AS amt
        FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.delivery_date >= date('now','-30 day') AND o.status NOT IN ('cancelled','draft')
        GROUP BY o.customer_id ORDER BY amt DESC LIMIT 6`);
      const topCard = card(cardHead(T('dash.topCustomers')) + table([
        { key: 'name', label: T('a.customer') },
        { key: 'orders', label: T('ord.no'), align: 'right' },
        { key: 'amt', label: T('a.amount'), align: 'right', cell: (r) => esc(money(r.amt, lang)) },
      ], topRows, { emptyMsg: T('a.noData') }));

      /* ---- recent orders ---- */
      const recent = all(`
        SELECT o.*, c.name AS customer FROM orders o JOIN customers c ON c.id = o.customer_id
        ORDER BY o.id DESC LIMIT 8`);
      const recentCard = card(cardHead(T('dash.recentOrders'), linkBtn(T('a.view'), '/orders', { variant: 'link' })) + table([
        { key: 'order_no', label: T('ord.no'), cell: (r) => `<a href="/orders/${r.id}"><b>${esc(r.order_no)}</b></a>` },
        { key: 'customer', label: T('a.customer'), cell: (r) => `<span class="trunc">${esc(r.customer)}</span>` },
        { key: 'delivery_date', label: T('ord.deliveryDate'), cell: (r) => fmtDate(r.delivery_date, lang) },
        { key: 'volume_m3', label: T('a.volume'), align: 'right', cell: (r) => `${qty(r.volume_m3)} m³` },
        { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => esc(money(r.amount, lang)) },
        { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'ord.status', r.status) },
      ], recent, { emptyMsg: T('a.noData') }));

      const body = `
        <div class="date-bar">
          <form method="get" action="/dashboard">
            <input type="date" name="date" value="${esc(date)}" onchange="this.form.submit()">
            <a class="btn btn-ghost" href="/dashboard">${T('a.today')}</a>
          </form>
        </div>
        ${k.overdue > 0 ? alert('warn', `${T('dash.overdue')}: ${esc(money(k.overdue, lang))} — <a href="/receivables">${T('rec.title')}</a>`) : ''}
        <div class="stat-grid">${stats}</div>
        <div class="grid-2">
          ${quick}
          ${mixCard}
        </div>
        <div class="grid-1">${todayCard}</div>
        <div class="grid-2">
          ${tomoCard}
          ${stockCard}
        </div>
        <div class="grid-2">
          ${fleetCard}
          ${topCard}
        </div>
        <div class="grid-1">${recentCard}</div>`;

      return html(ctx.res, page(ctx, { title: T('nav.dashboard'), body, actions: '' }));
    },
  },
];

function slotLabel(ctx, slot) {
  const key = slot === 'pm' ? 'sch.slotPm' : slot === 'night' ? 'sch.slotNight' : 'sch.slotAm';
  return esc(ctx.t(key));
}
