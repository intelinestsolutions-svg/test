import { all, get, run, tx, nextNo, setting } from '../db.js';
import { redirect, html, today, num, str, int, addDays, download, toCsv } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  field, alert, linkBtn, submitBtn, toolbar, filterBar, raw, pager,
} from '../lib/html.js';
import { calcOrder, suggestTrips, orderProgress, ensureInvoiceForOrder, activeMixes, round2, mixByCode } from '../lib/biz.js';

const LIMIT = 50;

export const orderRoutes = [
  /* ============ LIST ============ */
  {
    method: 'GET', path: '/orders', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const q = ctx.query;
      const offset = num(q.offset, 0);
      const where = [];
      const args = [];
      if (q.date) { where.push('o.delivery_date = ?'); args.push(q.date); }
      if (q.from) { where.push('o.delivery_date >= ?'); args.push(q.from); }
      if (q.to) { where.push('o.delivery_date <= ?'); args.push(q.to); }
      if (q.customer) { where.push('o.customer_id = ?'); args.push(int(q.customer)); }
      if (q.status) { where.push('o.status = ?'); args.push(q.status); }
      if (q.mix) { where.push('o.mix_code = ?'); args.push(q.mix); }
      if (q.q) {
        where.push('(o.order_no LIKE ? OR c.name LIKE ? OR o.po_ref LIKE ? OR o.mix_code LIKE ?)');
        const s = `%${q.q}%`; args.push(s, s, s, s);
      }
      // Penapis cawangan - kakitangan hanya nampak pesanan cawangan sendiri.
      const bc = ctx.bcond('o');
      if (bc) { where.push(bc.clause); args.push(...bc.params); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = all(`
        SELECT o.*, c.name AS customer, c.code AS ccode, s.name AS site_name, s.area,
               (SELECT COUNT(*) FROM trips t WHERE t.order_id = o.id AND t.status != 'void') AS trips_total,
               (SELECT COUNT(*) FROM trips t WHERE t.order_id = o.id AND t.status IN ('delivered','returned')) AS trips_done,
               (SELECT COALESCE(SUM(t.delivered_m3),0) FROM trips t WHERE t.order_id = o.id AND t.status IN ('delivered','returned')) AS delivered_m3,
               (SELECT invoice_no FROM invoices i WHERE i.order_id = o.id) AS invoice_no,
               (SELECT i.status FROM invoices i WHERE i.order_id = o.id) AS inv_status
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN sites s ON s.id = o.site_id
        ${clause}
        ORDER BY o.delivery_date DESC, o.id DESC
        LIMIT ? OFFSET ?`, ...args, LIMIT, offset);
      const total = num(get(`SELECT COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id ${clause}`, ...args)?.n);

      const sum = get(`
        SELECT COALESCE(SUM(o.amount),0) AS amt, COALESCE(SUM(o.volume_m3),0) AS m3
        FROM orders o JOIN customers c ON c.id = o.customer_id ${clause}`, ...args);

      const customers = all('SELECT id, name FROM customers WHERE active = 1 ORDER BY name');
      const mixList = activeMixes();

      const filters = filterBar(ctx, {
        action: '/orders',
        fields: [
          field({ label: T('a.search'), name: 'q', value: q.q || '', placeholder: `${rows[0]?.order_no || 'no. pesanan'} / PO / nama` }),
          field({ label: T('a.customer'), name: 'customer', value: q.customer || '', options: [{ value: '', label: T('a.all') }, ...customers.map((c) => ({ value: c.id, label: c.name }))] }),
          field({ label: T('a.mix'), name: 'mix', value: q.mix || '', options: [{ value: '', label: T('a.all') }, ...mixList.map((m) => ({ value: m.code, label: m.code }))] }),
          field({ label: T('a.status'), name: 'status', value: q.status || '', options: [{ value: '', label: T('a.all') }, ...['draft', 'confirmed', 'loading', 'dispatched', 'delivered', 'completed', 'cancelled'].map((s) => ({ value: s, label: ctx.t('ord.status.' + s) }))] }),
          field({ label: T('ord.deliveryDate'), name: 'from', type: 'date', value: q.from || '' }),
          field({ label: T('rep.dateRange'), name: 'to', type: 'date', value: q.to || '' }),
        ].join(''),
      });

      const cols = [
        { key: 'order_no', label: T('ord.no'), cell: (r) => `<a href="/orders/${r.id}"><b>${esc(r.order_no)}</b></a>${r.po_ref ? `<div class="sub tiny">PO: ${esc(r.po_ref)}</div>` : ''}` },
        { key: 'customer', label: T('a.customer'), cell: (r) => `<div class="trunc">${esc(r.customer)}</div><div class="sub tiny">${esc(r.area || r.site_name || '')}</div>` },
        { key: 'delivery_date', label: T('ord.deliveryDate'), cell: (r) => `${fmtDate(r.delivery_date, lang)}<div class="sub tiny">${esc(slotName(ctx, r.delivery_slot))}</div>` },
        { key: 'mix_code', label: T('a.mix'), cell: (r) => badge(esc(r.mix_code || '—'), 'mix') },
        { key: 'volume_m3', label: T('a.volume'), align: 'right', cell: (r) => `<b>${qty(r.volume_m3)} m³</b>` },
        { key: 'prog', label: T('ord.deliveredM3'), align: 'right', cell: (r) => {
            const pct = r.volume_m3 > 0 ? Math.min(100, Math.round(num(r.delivered_m3) / num(r.volume_m3) * 100)) : 0;
            return `<div class="mini-prog"><div class="mini-track"><div class="mini-fill" style="width:${pct}%"></div></div>
              <span class="tiny">${qty(r.delivered_m3)}/${qty(r.volume_m3)} · ${r.trips_done}/${r.trips_total} ${esc(ctx.t('dlv.trip').toLowerCase())}</span></div>`;
          } },
        { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => esc(money(r.amount, lang)) },
        { key: 'inv_status', label: T('inv2.title'), cell: (r) => r.invoice_no
            ? `<a href="/invoices/${get('SELECT id FROM invoices WHERE order_id = ?', r.id)?.id || ''}">${esc(r.invoice_no)}</a><div>${statusBadge(ctx, 'inv2.status', r.inv_status)}</div>`
            : `<span class="muted tiny">—</span>` },
        { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'ord.status', r.status) },
      ];

      const body = `
        ${filters}
        ${toolbar(
          `<b>${T('a.showing')} ${total} ${T('a.records')}</b> · ${qty(sum.m3)} m³ · <b>${esc(money(sum.amt, lang))}</b>`,
          linkBtn(T('a.export'), `/orders.csv?${new URLSearchParams(q)}`, { ic: 'download' })
        )}
        ${card(table(cols, rows))}
        ${pager(ctx, { total, limit: LIMIT, offset, baseUrl: '/orders', extra: qs(q, ['offset']) })}`;

      return html(ctx.res, page(ctx, {
        title: T('ord.title'),
        actions: linkBtn(T('ord.new'), '/orders/new', { ic: 'plus', variant: 'primary' }),
        body,
      }));
    },
  },

  /* ============ CSV ============ */
  {
    method: 'GET', path: '/orders.csv', handler(ctx) {
      const rows = all(`
        SELECT o.order_no, o.order_date, o.delivery_date, c.name, s.name AS site, o.po_ref,
               o.mix_code, o.volume_m3, o.unit_price, o.discount, o.delivery_charge, o.sst_rate,
               o.subtotal, o.amount, o.status
        FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN sites s ON s.id = o.site_id
        ORDER BY o.delivery_date DESC`);
      const csv = toCsv(rows.map((r) => [r.order_no, r.order_date, r.delivery_date, r.name, r.site, r.po_ref, r.mix_code, r.volume_m3, r.unit_price, r.discount, r.delivery_charge, r.sst_rate, r.subtotal, r.amount, r.status]),
        ['Order No', 'Order Date', 'Delivery Date', 'Customer', 'Site', 'PO Ref', 'Mix', 'Volume m3', 'Unit Price', 'Discount', 'Delivery Charge', 'SST %', 'Subtotal', 'Amount', 'Status']);
      download(ctx.res, csv, `orders-${today()}.csv`);
    },
  },

  /* ============ NEW ============ */
  {
    method: 'GET', path: '/orders/new', handler(ctx) {
      const v = orderForm(ctx, {
        order_no: nextNo('order', setting('order_prefix', 'SO')),
        order_date: today(),
        delivery_date: ctx.query.date || today(),
        delivery_slot: 'am',
        sst_rate: num(setting('sst_rate'), 0),
        delivery_charge: num(setting('default_delivery_charge'), 0),
        unit_price: 0, discount: 0, volume_m3: 0, status: 'draft',
      }, null);
      return html(ctx.res, page(ctx, v));
    },
  },
  {
    method: 'POST', path: '/orders/new', handler(ctx) {
      const f = formData(ctx);
      const mix = mixByCode(f.mix_code);
      const t = calcOrder(f);
      const r = run(`
        INSERT INTO orders (order_no, customer_id, site_id, order_date, delivery_date, delivery_slot, mix_code,
          volume_m3, unit_price, discount, delivery_charge, sst_rate, subtotal, amount, status, po_ref,
          requested_by, note, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.order_no, f.customer_id, f.site_id, f.order_date, f.delivery_date, f.delivery_slot, f.mix_code,
        t.volume_m3, t.unit_price, t.discount, t.delivery_charge, t.sst_rate, t.subtotal, t.amount,
        f.status, f.po_ref, f.requested_by, f.note, ctx.user.id, new Date().toISOString(), new Date().toISOString());
      const id = r.id;
      if (f.status !== 'draft') ensureInvoiceForOrder(id);
      ctx.flashMsg(`${ctx.t('a.saved')}: ${f.order_no}`);
      return { __redirect: `/orders/${id}` };
    },
  },

  /* ============ EDIT ============ */
  {
    method: 'GET', path: '/orders/:id', handler(ctx) {
      return html(ctx.res, orderDetail(ctx, int(ctx.params.id)));
    },
  },
  {
    method: 'GET', path: '/orders/:id/edit', handler(ctx) {
      const o = get('SELECT * FROM orders WHERE id = ?', int(ctx.params.id));
      if (!o) return notFound(ctx);
      return html(ctx.res, page(ctx, orderForm(ctx, o, null)));
    },
  },  {
    method: 'POST', path: '/orders/:id/edit', handler(ctx) {
      const id = int(ctx.params.id);
      const f = formData(ctx);
      const t = calcOrder(f);
      run(`UPDATE orders SET customer_id=?, site_id=?, order_date=?, delivery_date=?, delivery_slot=?, mix_code=?,
             volume_m3=?, unit_price=?, discount=?, delivery_charge=?, sst_rate=?, subtotal=?, amount=?,
             po_ref=?, requested_by=?, note=?, updated_at=? WHERE id=?`,
        f.customer_id, f.site_id, f.order_date, f.delivery_date, f.delivery_slot, f.mix_code,
        t.volume_m3, t.unit_price, t.discount, t.delivery_charge, t.sst_rate, t.subtotal, t.amount,
        f.po_ref, f.requested_by, f.note, new Date().toISOString(), id);
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: `/orders/${id}` };
    },
  },

  /* ============ STATUS ACTIONS ============ */
  {
    method: 'POST', path: '/orders/:id/status', handler(ctx) {
      const id = int(ctx.params.id);
      const status = str(ctx.body.status);
      const o = get('SELECT * FROM orders WHERE id = ?', id);
      if (!o) return notFound(ctx);
      if (status === 'cancelled') {
        run(`UPDATE orders SET status='cancelled', cancel_reason=?, updated_at=? WHERE id=?`,
          str(ctx.body.reason), new Date().toISOString(), id);
        const inv = get('SELECT * FROM invoices WHERE order_id = ?', id);
        if (inv && num(inv.amount_paid) <= 0) run(`UPDATE invoices SET status='cancelled' WHERE id=?`, inv.id);
        ctx.flashMsg(`${o.order_no}: ${ctx.t('ord.status.cancelled')}`);
      } else {
        run(`UPDATE orders SET status=?, updated_at=? WHERE id=?`, status, new Date().toISOString(), id);
        if (['confirmed', 'delivered', 'completed'].includes(status)) ensureInvoiceForOrder(id);
        ctx.flashMsg(`${o.order_no}: ${ctx.t('ord.status.' + status)}`);
      }
      return { __redirect: ctx.body.back || `/orders/${id}` };
    },
  },

  /* ============ TRIP PLANNING ============ */
  {
    method: 'GET', path: '/orders/:id/trips', handler(ctx) {
      const id = int(ctx.params.id);
      const o = get('SELECT * FROM orders WHERE id = ?', id);
      if (!o) return notFound(ctx);
      const lorries = all('SELECT * FROM lorries WHERE active = 1 ORDER BY code');
      const drivers = all(`SELECT * FROM staff WHERE role = 'driver' AND status = 'active' ORDER BY name`);
      const existing = all(`SELECT run_no, lorry_id, driver_id, batch_m3 FROM trips
                            WHERE order_id = ? AND status != 'void' ORDER BY run_no`, id);
      const prog = orderProgress(id);
      const suggested = suggestTrips(o.volume_m3, existing.map((e) => e.lorry_id));

      const T = (k) => esc(ctx.t(k));
      const body = `
        ${card(cardHead(T('ord.scheduleTrips')), `
          <p class="muted">${T('a.volume')}: <b>${qty(o.volume_m3)} m³</b> · ${T('ord.tripsPlanned')}: <b>${prog.tripsTotal}</b>
             · ${T('ord.remaining')}: <b>${qty(prog.remaining)} m³</b></p>
          <p class="muted tiny">${T('ord.tripCountHint')}: ≈ <b>${suggested}</b> ${T('dlv.trip').toLowerCase()}
             (${T('a.lorry')} ${qty(Math.max(1, suggested - existing.length))} ${T('ord.remaining') ? '' : ''}× ${qty(lorries[0]?.capacity_m3 || 8, 1)} m³)</p>`)}
        ${card(`
          <form method="post" action="/orders/${id}/trips" class="form-grid">
            <input type="hidden" name="back" value="/orders/${id}">
            ${field({ label: T('ord.tripCount'), name: 'trip_count', type: 'number', value: Math.max(1, suggested - existing.length), step: '1', required: true })}
            ${field({ label: T('dlv.batch') + ' (m³)', name: 'batch_m3', type: 'number', step: '0.01', value: round2(prog.remaining / Math.max(1, suggested - existing.length)), required: true })}
            ${field({ label: T('a.lorry'), name: 'lorry_id', value: lorries[0]?.id || '', options: lorries.map((l) => ({ value: l.id, label: `${l.code} · ${l.reg_no} · ${qty(l.capacity_m3, 1)} m³` })) })}
            ${field({ label: T('a.driver'), name: 'driver_id', value: drivers[0]?.id || '', options: [{ value: '', label: '—' }, ...drivers.map((d) => ({ value: d.id, label: `${d.name} (${d.emp_no || ''})` }))] })}
            <div class="form-actions">${submitBtn(T('a.add'), { ic: 'plus' })}</div>
          </form>`)}
        ${card(cardHead(T('ord.scheduleTrips')), table([
          { key: 'run_no', label: T('dlv.run') },
          { key: 'lorry', label: T('a.lorry'), cell: (r) => esc(r.lorry) },
          { key: 'driver', label: T('a.driver'), cell: (r) => esc(r.driver) },
          { key: 'batch_m3', label: T('dlv.batch'), align: 'right', cell: (r) => `${qty(r.batch_m3)} m³` },
          { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'trip.status', r.status) },
        ], existing.map((e) => ({ ...e, lorry: lorries.find((l) => l.id === e.lorry_id)?.code || '—', driver: drivers.find((d) => d.id === e.driver_id)?.name || '—' })), { emptyMsg: T('a.noData') }))}`;

      return html(ctx.res, page(ctx, {
        title: `${T('ord.scheduleTrips')} · ${o.order_no}`,
        body,
        actions: linkBtn(T('a.back'), `/orders/${id}`, { ic: 'back' }),
      }));
    },
  },
  {
    method: 'POST', path: '/orders/:id/trips', handler(ctx) {
      const id = int(ctx.params.id);
      const o = get('SELECT * FROM orders WHERE id = ?', id);
      if (!o) return notFound(ctx);
      const count = Math.max(1, int(ctx.body.trip_count, 1));
      const batch = num(ctx.body.batch_m3);
      const lorryId = int(ctx.body.lorry_id) || null;
      const driverId = int(ctx.body.driver_id) || null;
      const last = num(get(`SELECT COALESCE(MAX(run_no),0) AS n FROM trips WHERE order_id = ?`, id)?.n);
      const dnPrefix = setting('dn_prefix', 'DN');
      const tripPrefix = setting('trip_prefix', 'TRP');
      let created = 0;
      tx(() => {
        for (let i = 1; i <= count; i++) {
          const runNo = last + i;
          const tripNo = nextNo('trip', tripPrefix);
          run(`INSERT INTO trips (trip_no, dn_no, order_id, lorry_id, driver_id, run_no, batch_m3, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?, 'planned', ?, ?)`,
            tripNo, `${dnPrefix}-${tripNo.split('-').slice(1).join('-')}`, id, lorryId, driverId, runNo, batch,
            new Date().toISOString(), new Date().toISOString());
          created++;
        }
      });
      ctx.flashMsg(`${created} ${ctx.t('dlv.trip')} ${ctx.t('a.add').toLowerCase()}`);
      return { __redirect: ctx.body.back || `/orders/${id}` };
    },
  },
  {
    method: 'POST', path: '/trips/:id/delete', handler(ctx) {
      const t = get('SELECT * FROM trips WHERE id = ?', int(ctx.params.id));
      if (!t) return notFound(ctx);
      if (['dispatched', 'delivered', 'returned'].includes(t.status)) {
        ctx.flashMsg(ctx.t('a.no') + ': ' + ctx.t('dlv.ticket'), 'err');
        return { __redirect: ctx.body.back || '/deliveries' };
      }
      run(`UPDATE trips SET status='void' WHERE id = ?`, t.id);
      ctx.flashMsg(`${t.trip_no}: ${ctx.t('a.deleted')}`);
      return { __redirect: ctx.body.back || `/orders/${t.order_id}` };
    },
  },
];

/* ---------------- helpers ---------------- */
function qs(obj, drop = []) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (!drop.includes(k) && v) p.set(k, v);
  const s = p.toString();
  return s ? '&' + s : '';
}
function slotName(ctx, slot) {
  return ctx.t(slot === 'pm' ? 'sch.slotPm' : slot === 'night' ? 'sch.slotNight' : 'sch.slotAm');
}
function notFound(ctx) {
  ctx.flashMsg('404: ' + ctx.t('a.noData'), 'err');
  return { __redirect: '/orders' };
}
function formData(ctx) {
  const b = ctx.body;
  return {
    order_no: str(b.order_no),
    customer_id: int(b.customer_id),
    site_id: int(b.site_id) || null,
    order_date: str(b.order_date) || today(),
    delivery_date: str(b.delivery_date) || today(),
    delivery_slot: str(b.delivery_slot, 'am'),
    mix_code: str(b.mix_code),
    volume_m3: num(b.volume_m3),
    unit_price: num(b.unit_price),
    discount: num(b.discount),
    delivery_charge: num(b.delivery_charge),
    sst_rate: num(b.sst_rate, 0),
    po_ref: str(b.po_ref),
    requested_by: str(b.requested_by),
    note: str(b.note),
    status: ['draft', 'confirmed'].includes(str(b.status)) ? str(b.status) : 'draft',
  };
}

/* ---------------- order form ---------------- */
function orderForm(ctx, o, err) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const customers = all('SELECT * FROM customers WHERE active = 1 ORDER BY name');
  const sites = all('SELECT * FROM sites ORDER BY name');
  const mixList = activeMixes();
  const isEdit = !!o.id;
  const siteOpts = [{ value: '', label: '—' }, ...sites.map((s) => ({ value: s.id, label: `${s.name || s.address} (${s.area || ''})` }))];

  const body = `
    ${err ? alert('err', err) : ''}
    ${card(`
      <form method="post" action="${isEdit ? `/orders/${o.id}/edit` : '/orders/new'}" class="form-grid" id="of">
        ${field({ label: T('ord.no'), name: 'order_no', value: o.order_no, required: true })}
        ${field({ label: T('a.customer'), name: 'customer_id', value: o.customer_id, required: true, options: customers.map((c) => ({ value: c.id, label: `${c.name}${c.company ? ' · ' + c.company : ''}` })) })}
        ${field({ label: T('ord.date'), name: 'order_date', type: 'date', value: o.order_date, required: true })}
        ${field({ label: T('ord.deliveryDate'), name: 'delivery_date', type: 'date', value: o.delivery_date, required: true })}
        ${field({ label: T('ord.slot'), name: 'delivery_slot', value: o.delivery_slot, options: [
          { value: 'am', label: T('sch.slotAm') }, { value: 'pm', label: T('sch.slotPm') }, { value: 'night', label: T('sch.slotNight') },
        ] })}
        ${field({ label: T('doc.site'), name: 'site_id', value: o.site_id || '', options: siteOpts })}
        ${field({ label: T('a.mix'), name: 'mix_code', value: o.mix_code, required: true, options: mixList.map((m) => ({ value: m.code, label: `${m.code} — ${esc(money(m.price_per_m3, lang))}/m³` })) })}
        ${field({ label: T('ord.volume'), name: 'volume_m3', type: 'number', value: o.volume_m3, step: '0.01', required: true, cls: 'js-vol' })}
        ${field({ label: T('a.price') + ' (RM)', name: 'unit_price', type: 'number', value: o.unit_price, step: '0.01', cls: 'js-price' })}
        ${field({ label: T('a.discount') + ' (RM)', name: 'discount', type: 'number', value: o.discount, step: '0.01' })}
        ${field({ label: T('set.defaultDelivery'), name: 'delivery_charge', type: 'number', value: o.delivery_charge, step: '0.01' })}
        ${field({ label: T('a.tax') + ' (%)', name: 'sst_rate', type: 'number', value: o.sst_rate, step: '0.01' })}
        ${field({ label: T('ord.poRef'), name: 'po_ref', value: o.po_ref })}
        ${field({ label: T('ord.requestedBy'), name: 'requested_by', value: o.requested_by })}
        <label class="field span-2"><span class="field-label">${T('a.note')}</span>
          <textarea name="note" rows="2">${esc(o.note || '')}</textarea></label>
        <div class="form-actions span-2">
          ${submitBtn(T('a.save'), { ic: 'check' })}
          <a class="btn btn-ghost" href="${isEdit ? `/orders/${o.id}` : '/orders'}">${T('a.cancel')}</a>
        </div>
      </form>`)}
    ${card(cardHead(T('ord.summary')), `
      <table class="tbl kv">
        <tr><th>${T('a.subtotal')}</th><td class="ta-right" id="of-sub">${esc(money(num(o.volume_m3) * num(o.unit_price) - num(o.discount) + num(o.delivery_charge), ctx.lang))}</td></tr>
        <tr><th>${T('a.tax')}</th><td class="ta-right" id="of-sst">${esc(money(num(o.subtotal) * num(o.sst_rate) / 100, ctx.lang))}</td></tr>
        <tr class="big"><th>${T('a.total')}</th><td class="ta-right" id="of-total">${esc(money(o.amount, ctx.lang))}</td></tr>
        <tr><th>${T('ord.tripCount')}</th><td class="ta-right" id="of-trips">—</td></tr>
      </table>`)}
    ${card(cardHead(T('ord.materials')), `<div id="of-mat" class="muted">—</div>`)}`;

  const mixData = JSON.stringify(mixList.map((m) => ({
    code: m.code, price: num(m.price_per_m3),
    bom: { cement: num(m.cement_bags), sand: num(m.sand_m3), agg: num(m.agg_m3), admix: num(m.admix_l) },
  })));
  const tripCap = num(get(`SELECT MIN(capacity_m3) AS c FROM lorries WHERE active = 1`)?.c, 8);

  const script = `
  const MIX = ${mixData};
  const CAP = ${tripCap};
  const T = ${JSON.stringify({
    bag: ctx.t('a.bag'), m3: 'm³', litre: ctx.t('a.litre'),
    trips: ctx.t('ord.tripCount'), mat: ctx.t('ord.materials'),
  })};
  const f = document.getElementById('of');
  const g = (n) => f.elements[n];
  function calc() {
    const v = parseFloat(g('volume_m3').value) || 0;
    const p = parseFloat(g('unit_price').value) || 0;
    const d = parseFloat(g('discount').value) || 0;
    const dc = parseFloat(g('delivery_charge').value) || 0;
    const sr = parseFloat(g('sst_rate').value) || 0;
    const sub = Math.max(0, v * p - d + dc);
    const sst = sub * sr / 100;
    const fmt = (n) => 'RM ' + n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('of-sub').textContent = fmt(sub);
    document.getElementById('of-sst').textContent = fmt(sst);
    document.getElementById('of-total').textContent = fmt(sub + sst);
    document.getElementById('of-trips').textContent = (CAP > 0 ? Math.max(1, Math.ceil(v / CAP)) : 0) + ' ' + (T.trips || '');
    const mix = MIX.find((m) => m.code === g('mix_code').value);
    if (!mix) { document.getElementById('of-mat').textContent = '—'; return; }
    if (!g('unit_price').dataset.touched) g('unit_price').value = mix.price.toFixed(2);
    const rows = [];
    if (mix.bom.cement) rows.push([T.bag, (mix.bom.cement * v).toFixed(2)]);
    if (mix.bom.sand) rows.push(['Pasir m³', (mix.bom.sand * v).toFixed(2)]);
    if (mix.bom.agg) rows.push(['Agregat m³', (mix.bom.agg * v).toFixed(2)]);
    if (mix.bom.admix) rows.push([T.litre, (mix.bom.admix * v).toFixed(2)]);
    document.getElementById('of-mat').innerHTML = rows.length
      ? '<table class="tbl kv"><tbody>' + rows.map((r) => '<tr><th>' + r[0] + '</th><td class="ta-right">' + r[1] + '</td></tr>').join('') + '</tbody></table>'
      : '—';
  }
  g('mix_code').addEventListener('change', () => { g('unit_price').dataset.touched = ''; calc(); });
  g('unit_price').addEventListener('input', () => { g('unit_price').dataset.touched = '1'; calc(); });
  f.addEventListener('input', calc);
  calc();`;

  return {
    title: isEdit ? `${ctx.t('a.edit')} · ${o.order_no}` : T('ord.new'),
    body,
    actions: isEdit ? linkBtn(T('a.back'), `/orders/${o.id}`, { ic: 'back' }) : linkBtn(T('a.cancel'), '/orders', { ic: 'back' }),
    script,
  };
}

/* ---------------- order detail ---------------- */
function orderDetail(ctx, id) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const o = get(`SELECT o.*, c.name AS customer, c.company, c.phone, c.code AS ccode,
                         (SELECT name FROM sites WHERE id = o.site_id) AS site_name,
                         (SELECT address FROM sites WHERE id = o.site_id) AS site_address,
                         (SELECT area FROM sites WHERE id = o.site_id) AS site_area
                  FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, id);
  if (!o) return notFound(ctx);
  const prog = orderProgress(id);
  const mix = mixByCode(o.mix_code);
  const trips = all(`
    SELECT t.*, l.code AS lorry_code, l.reg_no, s.name AS driver, s.phone AS driver_phone
    FROM trips t LEFT JOIN lorries l ON l.id = t.lorry_id LEFT JOIN staff s ON s.id = t.driver_id
    WHERE t.order_id = ? AND t.status != 'void' ORDER BY t.run_no`, id);
  const inv = get('SELECT * FROM invoices WHERE order_id = ?', id);
  const pays = inv ? all(`SELECT * FROM payments WHERE invoice_id = ? ORDER BY id DESC`, inv.id) : [];
  const bal = inv ? round2(num(inv.amount) - num(inv.amount_paid)) : round2(num(o.amount));

  const canEdit = ['draft', 'confirmed'].includes(o.status);
  const canSchedule = !['cancelled', 'completed'].includes(o.status);

  const actions = [
    o.status === 'draft' ? linkBtn(T('a.confirm'), `/orders/${id}?confirm=1`, { ic: 'check', variant: 'primary' }) : '',
    canEdit ? linkBtn(T('a.edit'), `/orders/${id}/edit`, { ic: 'edit' }) : '',
    canSchedule ? linkBtn(T('ord.scheduleTrips'), `/orders/${id}/trips`, { ic: 'schedule', variant: 'primary' }) : '',
    o.status === 'delivered' && !inv ? linkBtn(T('inv2.new'), `/invoices/new?order_id=${id}`, { ic: 'invoice' }) : '',
    inv ? linkBtn(T('inv2.no'), `/invoices/${inv.id}`, { ic: 'invoice' }) : '',
    bal > 0 ? linkBtn(T('pay.payInvoice'), `/payments/new?invoice_id=${inv?.id || ''}&order_id=${id}`, { ic: 'payments', variant: 'green' }) : '',
    linkBtn(T('a.print'), `/print/order/${id}`, { ic: 'print' }),
    o.status !== 'cancelled' ? `<form method="post" action="/orders/${id}/status" class="inline-form" onsubmit="return confirm('${T('a.confirm')}?')">
        <input type="hidden" name="status" value="cancelled"><input type="hidden" name="back" value="/orders/${id}">
        <button class="btn btn-danger-ghost" type="submit">${icon('x', 15)}<span>${T('ord.void')}</span></button></form>` : '',
  ].filter(Boolean).join('');

  // confirm on GET then redirect back
  if (ctx.query.confirm && o.status === 'draft') {
    run(`UPDATE orders SET status='confirmed', updated_at=? WHERE id=?`, new Date().toISOString(), id);
    ensureInvoiceForOrder(id);
    ctx.flashMsg(`${o.order_no}: ${T('ord.status.confirmed')}`);
    return { __redirect: `/orders/${id}` };
  }

  const head = card(`
    <div class="detail-head">
      <div>
        <div class="detail-no">${esc(o.order_no)} ${statusBadge(ctx, 'ord.status', o.status)}</div>
        <div class="detail-sub">${T('a.customer')}: <a href="/customers/${o.customer_id}"><b>${esc(o.customer)}</b></a>
          ${o.company ? ` · ${esc(o.company)}` : ''}</div>
        <div class="detail-sub">${T('ord.deliveryDate')}: <b>${fmtDate(o.delivery_date, lang)}</b> · ${esc(slotName(ctx, o.delivery_slot))}
          ${o.po_ref ? ` · PO: ${esc(o.po_ref)}` : ''}</div>
        ${o.site_name || o.site_address ? `<div class="detail-sub">${T('doc.site')}: ${esc(o.site_name || '')} ${esc(o.site_address || '')} ${o.site_area ? `(${esc(o.site_area)})` : ''}</div>` : ''}
        ${o.note ? `<div class="detail-sub">${T('a.note')}: ${esc(o.note)}</div>` : ''}
      </div>
      <div class="detail-numbers">
        <div><span>${T('a.volume')}</span><b>${qty(o.volume_m3)} m³</b></div>
        <div><span>${T('ord.deliveredM3')}</span><b class="teal">${qty(prog.delivered)} m³</b></div>
        <div><span>${T('a.total')}</span><b>${esc(money(o.amount, lang))}</b></div>
        ${inv ? `<div><span>${T('a.balance')}</span><b class="${bal > 0 ? 'amber' : 'green'}">${esc(money(bal, lang))}</b></div>` : ''}
      </div>
    </div>`);

  const mixCard = mix ? card(cardHead(T('doc.mixDesign')), `
    <table class="tbl kv">
      <tr><th>${T('a.mix')}</th><td class="ta-right"><b>${esc(mix.code)}</b> ${esc(mix.name || '')}</td></tr>
      ${mix.grade_mpa ? `<tr><th>${T('mix.grade')}</th><td class="ta-right">${qty(mix.grade_mpa, 0)} MPa</td></tr>` : ''}
      ${mix.slump_mm ? `<tr><th>${T('mix.slump')}</th><td class="ta-right">${mix.slump_mm} mm</td></tr>` : ''}
      <tr><th>${T('a.price')}</th><td class="ta-right">${esc(money(mix.price_per_m3, lang))} / m³</td></tr>
      <tr><th>${T('inv2.termNote')}</th><td class="ta-right">${qty(mix.min_charge_m3)} m³</td></tr>
    </table>`) : '';

  const amountsCard = card(cardHead(T('a.total')), `
    <table class="tbl kv">
      <tr><th>${qty(o.volume_m3)} m³ × ${esc(money(o.unit_price, lang))}</th><td class="ta-right">${esc(money(num(o.volume_m3) * num(o.unit_price), lang))}</td></tr>
      ${num(o.discount) ? `<tr><th>${T('a.discount')}</th><td class="ta-right neg">− ${esc(money(o.discount, lang))}</td></tr>` : ''}
      ${num(o.delivery_charge) ? `<tr><th>${T('set.defaultDelivery')}</th><td class="ta-right">${esc(money(o.delivery_charge, lang))}</td></tr>` : ''}
      <tr><th>${T('a.subtotal')}</th><td class="ta-right">${esc(money(o.subtotal, lang))}</td></tr>
      ${num(o.sst_rate) ? `<tr><th>${T('a.tax')} ${qty(o.sst_rate)}%</th><td class="ta-right">${esc(money(num(o.amount) - num(o.subtotal), lang))}</td></tr>` : ''}
      <tr class="big"><th>${T('a.total')}</th><td class="ta-right">${esc(money(o.amount, lang))}</td></tr>
    </table>`);

  const tripsCard = card(
    cardHead(`${T('ord.scheduleTrips')} (${prog.tripsDone}/${prog.tripsTotal})`,
      canSchedule ? linkBtn(T('a.add'), `/orders/${id}/trips`, { ic: 'plus', variant: 'link' }) : ''),
    table([
      { key: 'trip_no', label: T('dlv.trip'), cell: (r) => `<a href="/deliveries/${r.id}"><b>${esc(r.trip_no)}</b></a><div class="sub tiny">${esc(r.dn_no || '')}</div>` },
      { key: 'lorry_code', label: T('a.lorry'), cell: (r) => esc(r.lorry_code || '—') },
      { key: 'driver', label: T('a.driver'), cell: (r) => `<a href="tel:${esc(r.driver_phone || '')}">${esc(r.driver || '—')}</a>` },
      { key: 'batch_m3', label: T('dlv.batch'), align: 'right', cell: (r) => `${qty(r.batch_m3)} m³` },
      { key: 'delivered_m3', label: T('dlv.deliveredQty'), align: 'right', cell: (r) => `<b>${qty(r.delivered_m3)}</b>` },
      { key: 'returned_m3', label: T('dlv.returnedQty'), align: 'right', cell: (r) => qty(r.returned_m3) },
      { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'trip.status', r.status) },
      {
        key: 'act', label: T('a.actions'), align: 'right', cell: (r) => `
          ${linkBtn(T('dlv.ticket'), `/print/dn/${r.id}`, { ic: 'print', variant: 'link', cls: 'sm' })}
          ${['planned', 'loading'].includes(r.status) ? `<form method="post" action="/trips/${r.id}/delete" class="inline-form" onsubmit="return confirm('${T('a.delete')}?')">
            <input type="hidden" name="back" value="/orders/${id}">
            <button class="btn btn-danger-ghost sm" type="submit">${T('a.delete')}</button></form>` : ''}`,
      },
    ], trips, { emptyMsg: T('a.noData') })
  );

  const payCard = inv ? card(
    cardHead(`${T('inv2.title')} · ${esc(inv.invoice_no)}`, linkBtn(T('a.view'), `/invoices/${inv.id}`, { variant: 'link' })),
    `<table class="tbl kv">
      <tr><th>${T('a.total')}</th><td class="ta-right">${esc(money(inv.amount, lang))}</td></tr>
      <tr><th>${T('a.paid')}</th><td class="ta-right green">${esc(money(inv.amount_paid, lang))}</td></tr>
      <tr class="big"><th>${T('a.balance')}</th><td class="ta-right ${bal > 0 ? 'amber' : 'green'}">${esc(money(bal, lang))}</td></tr>
    </table>
    ${pays.length ? table([
      { key: 'payment_no', label: T('pay.no') },
      { key: 'paid_at', label: T('pay.paidAt'), cell: (r) => fmtDate(r.paid_at, lang) },
      { key: 'method', label: T('pay.method'), cell: (r) => badge(esc(ctx.t('pay.method.' + r.method)), 'm-' + r.method) },
      { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => esc(money(r.amount, lang)) },
    ], pays) : ''}`
  ) : '';

  const body = `<div class="actions-row">${actions}</div>
    ${o.status === 'cancelled' ? alert('warn', `${T('ord.status.cancelled')}: ${esc(o.cancel_reason || '')}`) : ''}
    ${head}
    <div class="grid-3">
      ${amountsCard}
      ${mixCard}
      ${payCard || (o.status === 'draft' ? card(cardHead(T('inv2.title')), `<p class="muted">${T('ord.confirmFirst')}</p>`) : '')}
    </div>
    <div class="grid-1">${tripsCard}</div>`;

  return page(ctx, { title: o.order_no, body, actions: linkBtn(T('a.back'), '/orders', { ic: 'back' }) });
}
