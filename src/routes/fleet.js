import { all, get, run, setting } from '../db.js';
import { redirect, html, today, num, str, int, addDays, download, toCsv } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  field, alert, linkBtn, submitBtn, filterBar, toolbar,
} from '../lib/html.js';
import { round2 } from '../lib/biz.js';

export const fleetRoutes = [
  {
    method: 'GET', path: '/fleet', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      // Lori adalah KHAS CAWANGAN.
      const lb = ctx.bcond('l');
      // Pemandu hanya melihat lori yang dipandangnya (diketahui melalui trip).
      const drv = ctx.myLorryCond('l');
      const rows = all(`
        SELECT l.*,
          (SELECT COUNT(*) FROM trips t WHERE t.lorry_id = l.id AND t.status != 'void') AS trips_n,
          (SELECT COALESCE(SUM(t.delivered_m3),0) FROM trips t WHERE t.lorry_id = l.id AND t.status IN ('delivered','returned')) AS m3,
          (SELECT COALESCE(SUM(f.total),0) FROM fuel_logs f WHERE f.lorry_id = l.id) AS fuel_cost,
          (SELECT COALESCE(SUM(f.litres),0) FROM fuel_logs f WHERE f.lorry_id = l.id) AS fuel_l,
          (SELECT s.name FROM trips t JOIN staff s ON s.id = t.driver_id
            WHERE t.lorry_id = l.id AND t.status = 'dispatched' LIMIT 1) AS current_driver
        FROM lorries l WHERE l.active = 1${lb ? ` AND ${lb.clause}` : ''}${drv ? ` AND ${drv.clause}` : ''} ORDER BY l.code`,
      ...(lb ? lb.params : []), ...(drv ? drv.params : []));

      const totalCap = round2(rows.reduce((s, l) => s + num(l.capacity_m3), 0));
      const stats = `<div class="stat-grid">
        ${stat(T('sch.capacity'), `${qty(totalCap)} m³`)}
        ${stat(T('dash.lorriesAvail'), `${rows.filter((r) => r.status === 'available').length} / ${rows.length}`)}
        ${stat(T('dash.lorriesOnRoad'), String(rows.filter((r) => r.status === 'on_delivery').length), 'teal')}
        ${stat(T('dash.inMaintenance'), String(rows.filter((r) => r.status === 'maintenance').length), 'amber')}
      </div>`;

      const body = `${stats}${card(table([
        { key: 'code', label: T('flt.code'), cell: (r) => `<a href="/fleet/${r.id}"><b>${esc(r.code)}</b></a>` },
        { key: 'reg_no', label: T('flt.regNo'), cell: (r) => esc(r.reg_no) },
        { key: 'capacity_m3', label: T('flt.capacity'), align: 'right', cell: (r) => `${qty(r.capacity_m3, 1)} m³` },
        { key: 'odometer', label: T('flt.odo'), align: 'right', cell: (r) => qty(r.odometer, 0) },
        { key: 'fuel_litres', label: T('nav.fuel'), align: 'right', cell: (r) => fuelCell(r) },
        { key: 'trips_n', label: T('flt.trips'), align: 'right' },
        { key: 'm3', label: T('flt.m3Done'), align: 'right', cell: (r) => `${qty(r.m3)} m³` },
        { key: 'fuel_cost', label: T('fue.totalCost'), align: 'right', cell: (r) => esc(money(r.fuel_cost, lang)) },
        { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'flt.status', r.status) },
        { key: 'next_service_date', label: T('flt.nextServiceDate'), cell: (r) => serviceCell(ctx, r) },
      ], rows, { emptyMsg: T('a.noDataHint') }))}`;

      return html(ctx.res, page(ctx, {
        title: T('flt.title'),
        actions: linkBtn(T('flt.new'), '/fleet/new', { ic: 'plus', variant: 'primary' }),
        body,
      }));
    },
  },
  {
    method: 'GET', path: '/fleet/new', handler(ctx) {
      return html(ctx.res, page(ctx, lorryForm(ctx, { active: 1, capacity_m3: 8, status: 'available' }, null)));
    },
  },
  {
    method: 'POST', path: '/fleet/new', handler(ctx) {
      const f = lf(ctx);
      const r = run(`INSERT INTO lorries (code, reg_no, make, model, year, capacity_m3, odometer, status,
                     next_service_km, next_service_date, note, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.code, f.reg_no, f.make, f.model, f.year, f.capacity_m3, f.odometer, f.status,
        f.next_service_km, f.next_service_date, f.note, f.active);
      const nextCode = get(`SELECT code FROM lorries WHERE id = (SELECT MAX(id) FROM lorries)`);
      run('UPDATE settings SET value = ? WHERE key = ?', String(num(setting('lorries_count')) + 1), 'lorries_count');
      ctx.flashMsg(`${ctx.t('a.saved')}: ${f.code}`);
      return { __redirect: `/fleet/${r.id}` };
    },
  },
  {
    method: 'GET', path: '/fleet/:id', handler(ctx) { return html(ctx.res, lorryDetail(ctx, int(ctx.params.id))); },
  },
  {
    method: 'GET', path: '/fleet/:id/edit', handler(ctx) {
      const l = get('SELECT * FROM lorries WHERE id = ?', int(ctx.params.id));
      if (!l) { ctx.flashMsg('404', 'err'); return { __redirect: '/fleet' }; }
      return html(ctx.res, page(ctx, lorryForm(ctx, l, null)));
    },
  },
  {
    method: 'POST', path: '/fleet/:id/edit', handler(ctx) {
      const f = lf(ctx);
      run(`UPDATE lorries SET code=?, reg_no=?, make=?, model=?, year=?, capacity_m3=?, odometer=?, status=?,
             next_service_km=?, next_service_date=?, note=?, active=? WHERE id=?`,
        f.code, f.reg_no, f.make, f.model, f.year, f.capacity_m3, f.odometer, f.status,
        f.next_service_km, f.next_service_date, f.note, f.active, int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: `/fleet/${int(ctx.params.id)}` };
    },
  },
  {
    method: 'POST', path: '/fleet/:id/status', handler(ctx) {
      run('UPDATE lorries SET status = ? WHERE id = ?', str(ctx.body.status, 'available'), int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: `/fleet/${int(ctx.params.id)}` };
    },
  },
];

/* ---------------- helpers ---------------- */
const stat = (label, value, tone = '') =>
  `<div class="stat ${tone}"><div class="stat-top"><span class="stat-label">${label}</span></div><div class="stat-value">${value}</div></div>`;

function fuelCell(r) {
  const pct = Math.min(100, Math.round(num(r.fuel_litres) / 300 * 100));
  const lvl = pct <= 20 ? 'low' : pct <= 45 ? 'mid' : 'ok';
  return `<div class="fuel-bar sm" title="${qty(r.fuel_litres, 0)} L">
    <div class="fuel-fill ${lvl}" style="width:${pct}%"></div>
    <span class="fuel-txt">${qty(r.fuel_litres, 0)} L</span></div>`;
}
function serviceCell(ctx, r) {
  if (!r.next_service_date && !r.next_service_km) return '<span class="muted">—</span>';
  const dueDate = r.next_service_date && r.next_service_date <= addDays(today(), 14);
  const dueKm = r.next_service_km && num(r.odometer) >= num(r.next_service_km) - 500;
  return `<div class="${dueDate || dueKm ? 'neg' : ''}">${r.next_service_date ? fmtDate(r.next_service_date, ctx.lang) : ''}
    ${r.next_service_km ? `<div class="sub tiny">${qty(r.odometer, 0)} / ${qty(r.next_service_km, 0)} km</div>` : ''}
    ${(dueDate || dueKm) ? badge(ctx.t('flt.serviceDue'), 'bad') : ''}</div>`;
}
function lf(ctx) {
  const b = ctx.body;
  return {
    code: str(b.code), reg_no: str(b.reg_no), make: str(b.make), model: str(b.model),
    year: int(b.year) || null, capacity_m3: num(b.capacity_m3, 8), odometer: num(b.odometer, 0),
    status: ['available', 'loading', 'on_delivery', 'maintenance', 'off'].includes(str(b.status)) ? str(b.status) : 'available',
    next_service_km: num(b.next_service_km) || null,
    next_service_date: str(b.next_service_date) || null,
    note: str(b.note), active: b.active ? 1 : 0,
  };
}
function lorryForm(ctx, l, err) {
  const T = (k) => esc(ctx.t(k));
  const isEdit = !!l.id;
  const body = `${err ? alert('err', err) : ''}
    ${card(`<form method="post" action="${isEdit ? `/fleet/${l.id}/edit` : '/fleet/new'}" class="form-grid">
      ${field({ label: T('flt.code'), name: 'code', value: l.code || '', required: true, placeholder: 'L01' })}
      ${field({ label: T('flt.regNo'), name: 'reg_no', value: l.reg_no || '', required: true, placeholder: 'WA1234T' })}
      ${field({ label: T('flt.make'), name: 'make', value: l.make || '' })}
      ${field({ label: T('flt.model'), name: 'model', value: l.model || '' })}
      ${field({ label: T('flt.year'), name: 'year', type: 'number', value: l.year || '', step: '1' })}
      ${field({ label: T('flt.capacity'), name: 'capacity_m3', type: 'number', value: l.capacity_m3, step: '0.1', required: true })}
      ${field({ label: T('flt.odo'), name: 'odometer', type: 'number', value: l.odometer, step: '1' })}
      ${field({ label: T('a.status'), name: 'status', value: l.status, options: ['available', 'loading', 'on_delivery', 'maintenance', 'off'].map((s) => ({ value: s, label: ctx.t('flt.status.' + s) })) })}
      ${field({ label: T('flt.nextServiceKm'), name: 'next_service_km', type: 'number', value: l.next_service_km || '', step: '1' })}
      ${field({ label: T('flt.nextServiceDate'), name: 'next_service_date', type: 'date', value: l.next_service_date || '' })}
      <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2">${esc(l.note || '')}</textarea></label>
      <div class="form-actions span-2">
        ${submitBtn(T('a.save'), { ic: 'check' })}
        <a class="btn btn-ghost" href="${isEdit ? `/fleet/${l.id}` : '/fleet'}">${T('a.cancel')}</a>
        ${isEdit ? `<label class="check"><input type="checkbox" name="active" value="1" ${l.active ? 'checked' : ''}><span>${T('stf.status.active')}</span></label>` : ''}
      </div>
    </form>`)}`;
  return {
    title: isEdit ? `${T('a.edit')} · ${esc(l.code)}` : T('flt.new'),
    body,
    actions: isEdit ? linkBtn(T('a.back'), `/fleet/${l.id}`, { ic: 'back' }) : linkBtn(T('a.cancel'), '/fleet', { ic: 'back' }),
  };
}

function lorryDetail(ctx, id) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const l = get('SELECT * FROM lorries WHERE id = ?', id);
  if (!l) { ctx.flashMsg('404', 'err'); return page(ctx, { title: '404', body: alert('err', 'Not found') }); }
  const trips = all(`
    SELECT t.*, o.order_no, o.delivery_date, c.name AS customer, s.name AS driver
    FROM trips t JOIN orders o ON o.id = t.order_id JOIN customers c ON c.id = o.customer_id
    LEFT JOIN staff s ON s.id = t.driver_id
    WHERE t.lorry_id = ? AND t.status != 'void' ORDER BY o.delivery_date DESC, t.run_no LIMIT 50`, id);
  const fuels = all('SELECT * FROM fuel_logs WHERE lorry_id = ? ORDER BY log_date DESC, id DESC LIMIT 30', id);
  const totals = get(`SELECT COUNT(*) AS trips, COALESCE(SUM(delivered_m3),0) AS m3 FROM trips
                      WHERE lorry_id = ? AND status IN ('delivered','returned')`, id);
  const fuelTot = get(`SELECT COALESCE(SUM(litres),0) AS l, COALESCE(SUM(total),0) AS c FROM fuel_logs WHERE lorry_id = ?`, id);
  const costPerM3 = num(totals.m3) > 0 ? round2(num(fuelTot.c) / num(totals.m3)) : 0;
  const lPer100 = num(l.odometer) > 0 ? round2(num(fuelTot.l) / num(l.odometer) * 100) : 0;

  const body = `
    ${card(`<div class="detail-head">
      <div><div class="detail-no">${esc(l.code)} ${statusBadge(ctx, 'flt.status', l.status)}</div>
        <div class="detail-sub">${esc(l.reg_no)} ${l.make ? `· ${esc(l.make)} ${esc(l.model || '')}` : ''} ${l.year ? `· ${l.year}` : ''}</div>
        <div class="detail-sub">${T('flt.capacity')}: <b>${qty(l.capacity_m3, 1)} m³</b> · ${T('flt.odo')}: <b>${qty(l.odometer, 0)} km</b></div>
        ${l.note ? `<div class="detail-sub">${T('a.note')}: ${esc(l.note)}</div>` : ''}</div>
      <div class="detail-numbers">
        <div><span>${T('fue.tankLevel')}</span><b>${qty(l.fuel_litres, 0)} L</b></div>
        <div><span>${T('flt.trips')}</span><b>${num(totals.trips)}</b></div>
        <div><span>${T('flt.m3Done')}</span><b>${qty(totals.m3)} m³</b></div>
        <div><span>${T('flt.costPerM3')}</span><b>${esc(money(costPerM3, lang))}</b></div>
        <div><span>${T('fue.consumption')}</span><b>${qty(lPer100, 1)} L</b></div>
      </div>
    </div>`)}
    <div class="grid-1">${card(cardHead(T('a.status')), `
      <form method="post" action="/fleet/${id}/status" class="form-inline-row">
        ${['available', 'loading', 'on_delivery', 'maintenance', 'off'].map((s) =>
          `<button class="btn ${l.status === s ? 'btn-primary' : 'btn-ghost'}" name="status" value="${s}" type="submit">${T('flt.status.' + s)}</button>`).join('')}
      </form>`)}</div>
    <div class="grid-2">
      ${card(cardHead(T('flt.trips')), table([
        { key: 'trip_no', label: T('dlv.trip'), cell: (r) => `<a href="/deliveries/${r.id}"><b>${esc(r.trip_no)}</b></a>` },
        { key: 'delivery_date', label: T('a.date'), cell: (r) => fmtDate(r.delivery_date, lang) },
        { key: 'driver', label: T('a.driver'), cell: (r) => esc(r.driver || '—') },
        { key: 'customer', label: T('a.customer'), cell: (r) => `<span class="trunc">${esc(r.customer)}</span>` },
        { key: 'delivered_m3', label: T('dlv.deliveredQty'), align: 'right', cell: (r) => qty(r.delivered_m3) },
        { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'trip.status', r.status) },
      ], trips, { emptyMsg: T('a.noData') }))}
      ${card(cardHead(T('nav.fuel')), table([
        { key: 'log_date', label: T('a.date'), cell: (r) => fmtDate(r.log_date, lang) },
        { key: 'litres', label: T('fue.litres'), align: 'right', cell: (r) => qty(r.litres, 1) },
        { key: 'price_per_litre', label: T('fue.priceL'), align: 'right', cell: (r) => esc(money(r.price_per_litre, lang)) },
        { key: 'total', label: T('a.total'), align: 'right', cell: (r) => esc(money(r.total, lang)) },
        { key: 'odometer', label: T('fue.odo'), align: 'right', cell: (r) => qty(r.odometer, 0) },
        { key: 'station', label: T('fue.station'), cell: (r) => `<span class="trunc">${esc(r.station || '—')}</span>` },
      ], fuels, { emptyMsg: T('a.noData') }) + `<div class="mt">${linkBtn(T('fue.new'), `/fuel/new?lorry_id=${id}`, { ic: 'fuel' })}</div>`)}
    </div>`;

  return page(ctx, {
    title: `${l.code} · ${l.reg_no}`,
    body,
    actions: [linkBtn(T('a.edit'), `/fleet/${id}/edit`, { ic: 'edit' }), linkBtn(T('a.back'), '/fleet', { ic: 'back' })].join(''),
  });
}
