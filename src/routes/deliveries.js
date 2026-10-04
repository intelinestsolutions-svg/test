import { all, get, run, tx, nextNo, setting } from '../db.js';
import { redirect, html, today, nowLocal, num, str, int, download, toCsv, addDays } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  field, alert, linkBtn, submitBtn, toolbar, filterBar, raw,
} from '../lib/html.js';
import {
  deductTripMaterials, syncLorryFromTrip, syncOrderFromTrips, round2, mixByCode,
  addFuel, recordMovement, stockQty,
} from '../lib/biz.js';

const LIMIT = 60;

export const deliveryRoutes = [
  /* ============ LIST / BOARD ============ */
  {
    method: 'GET', path: '/deliveries', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const q = ctx.query;
      const offset = num(q.offset, 0);
      const date = q.date || today();
      const where = ["t.status != 'void'"];
      const args = [];
      if (q.date) { where.push('o.delivery_date = ?'); args.push(q.date); }
      if (q.from) { where.push('o.delivery_date >= ?'); args.push(q.from); }
      if (q.to) { where.push('o.delivery_date <= ?'); args.push(q.to); }
      if (q.lorry) { where.push('t.lorry_id = ?'); args.push(int(q.lorry)); }
      if (q.driver) { where.push('t.driver_id = ?'); args.push(int(q.driver)); }
      if (q.status) { where.push('t.status = ?'); args.push(q.status); }
      if (q.q) {
        where.push('(t.trip_no LIKE ? OR t.dn_no LIKE ? OR o.order_no LIKE ? OR c.name LIKE ? OR s.name LIKE ?)');
        const s = `%${q.q}%`; args.push(s, s, s, s, s);
      }
      const bc = ctx.bcond('t');
      if (bc) { where.push(bc.clause); args.push(...bc.params); }
      const clause = 'WHERE ' + where.join(' AND ');
      const rows = all(`
        SELECT t.*, o.order_no, o.delivery_date, o.delivery_slot, o.mix_code, o.volume_m3, o.status AS order_status,
               c.name AS customer, l.code AS lorry_code, st.name AS driver,
               (SELECT name FROM sites si WHERE si.id = o.site_id) AS site_name
        FROM trips t
        JOIN orders o ON o.id = t.order_id
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN lorries l ON l.id = t.lorry_id
        LEFT JOIN staff st ON st.id = t.driver_id
        ${clause}
        ORDER BY o.delivery_date DESC, o.delivery_slot, t.run_no
        LIMIT ? OFFSET ?`, ...args, LIMIT, offset);
      const total = num(get(`
        SELECT COUNT(*) AS n FROM trips t JOIN orders o ON o.id = t.order_id
        JOIN customers c ON c.id = o.customer_id ${clause}`, ...args)?.n);

      const sum = get(`
        SELECT COALESCE(SUM(t.batch_m3),0) AS batch, COALESCE(SUM(t.delivered_m3),0) AS deliv,
               COALESCE(SUM(t.returned_m3),0) AS ret
        FROM trips t JOIN orders o ON o.id = t.order_id JOIN customers c ON c.id = o.customer_id ${clause}`, ...args);

      const lorries = all('SELECT * FROM lorries WHERE active = 1 ORDER BY code');
      const drivers = all(`SELECT * FROM staff WHERE role='driver' AND status='active' ORDER BY name`);

      const filters = filterBar(ctx, {
        action: '/deliveries',
        fields: [
          field({ label: T('a.search'), name: 'q', value: q.q || '', placeholder: 'DN / trip / pesanan' }),
          field({ label: T('a.lorry'), name: 'lorry', value: q.lorry || '', options: [{ value: '', label: T('a.all') }, ...lorries.map((l) => ({ value: l.id, label: l.code }))] }),
          field({ label: T('a.driver'), name: 'driver', value: q.driver || '', options: [{ value: '', label: T('a.all') }, ...drivers.map((d) => ({ value: d.id, label: d.name }))] }),
          field({ label: T('a.status'), name: 'status', value: q.status || '', options: [{ value: '', label: T('a.all') }, ...['planned', 'loading', 'dispatched', 'delivered', 'returned'].map((s) => ({ value: s, label: ctx.t('trip.status.' + s) }))] }),
          field({ label: T('dlv.pickDate'), name: 'date', type: 'date', value: q.date || '' }),
        ].join(''),
      });

      const cols = [
        { key: 'trip_no', label: T('dlv.dn'), cell: (r) => `<a href="/deliveries/${r.id}"><b>${esc(r.trip_no)}</b></a><div class="sub tiny">${esc(r.dn_no || '')}</div>` },
        { key: 'delivery_date', label: T('a.date'), cell: (r) => `${fmtDate(r.delivery_date, lang)}<div class="sub tiny">${esc(slotName(ctx, r.delivery_slot))}</div>` },
        { key: 'lorry_code', label: T('a.lorry'), cell: (r) => esc(r.lorry_code || '—') },
        { key: 'driver', label: T('a.driver'), cell: (r) => esc(r.driver || '—') },
        { key: 'customer', label: T('a.customer'), cell: (r) => `<div class="trunc">${esc(r.customer)}</div><div class="sub tiny trunc">${esc(r.site_name || '')}</div>` },
        { key: 'mix_code', label: T('a.mix'), cell: (r) => badge(esc(r.mix_code || '—'), 'mix') },
        { key: 'batch_m3', label: T('dlv.batch'), align: 'right', cell: (r) => qty(r.batch_m3) },
        { key: 'delivered_m3', label: T('dlv.deliveredQty'), align: 'right', cell: (r) => `<b>${qty(r.delivered_m3)}</b>${num(r.returned_m3) ? `<div class="sub tiny">−${qty(r.returned_m3)}</div>` : ''}` },
        { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'trip.status', r.status) },
        {
          key: 'act', label: '', align: 'right', cell: (r) => quickAction(ctx, r),
        },
      ];

      const body = `
        ${filters}
        ${toolbar(
          `<b>${T('a.showing')} ${total} ${T('a.records')}</b> · ${T('dlv.batch')} <b>${qty(sum.batch)} m³</b>
           · ${T('dlv.deliveredQty')} <b class="teal">${qty(sum.deliv)} m³</b>
           · ${T('dlv.returnedQty')} <b class="amber">${qty(sum.ret)} m³</b>`,
          linkBtn(T('a.export'), '/deliveries.csv?' + new URLSearchParams(q), { ic: 'download' }) +
          linkBtn(T('sch.board'), '/schedule' + (q.date ? '?date=' + q.date : ''), { ic: 'schedule' })
        )}
        ${card(table(cols, rows))}`;

      return html(ctx.res, page(ctx, {
        title: T('dlv.title'),
        actions: linkBtn(T('sch.board'), '/schedule', { ic: 'schedule' }),
        body,
      }));
    },
  },
  {
    method: 'GET', path: '/deliveries.csv', handler(ctx) {
      const rows = all(`
        SELECT t.trip_no, t.dn_no, o.order_no, o.delivery_date, c.name, s.name AS site,
               l.code AS lorry, st.name AS driver, o.mix_code, t.batch_m3, t.delivered_m3, t.returned_m3,
               t.load_time, t.depart_time, t.arrive_time, t.return_time, t.slump_measured,
               t.odo_start, t.odo_end, t.fuel_used_l, t.receiver_name, t.status
        FROM trips t JOIN orders o ON o.id = t.order_id JOIN customers c ON c.id = o.customer_id
        LEFT JOIN sites s ON s.id = o.site_id LEFT JOIN lorries l ON l.id = t.lorry_id
        LEFT JOIN staff st ON st.id = t.driver_id WHERE t.status != 'void'
        ORDER BY o.delivery_date DESC, t.run_no`);
      download(ctx.res, toCsv(rows.map((r) => Object.values(r)), Object.keys(rows[0] || { a: 1 })), `deliveries-${today()}.csv`);
    },
  },

  /* ============ TRIP DETAIL ============ */
  {
    method: 'GET', path: '/deliveries/:id', handler(ctx) {
      return html(ctx.res, tripDetail(ctx, int(ctx.params.id)));
    },
  },

  /* ============ ACTIONS ============ */
  {
    method: 'POST', path: '/trips/:id/action', handler(ctx) {
      const id = int(ctx.params.id);
      const t = get('SELECT * FROM trips WHERE id = ?', id);
      if (!t) { ctx.flashMsg('404', 'err'); return { __redirect: '/deliveries' }; }
      const action = str(ctx.body.action);
      const back = str(ctx.body.back) || `/deliveries/${id}`;
      const now = new Date().toISOString();
      const time = str(ctx.body.time) || nowLocal();

      const set = (obj) => {
        const keys = Object.keys(obj);
        run(`UPDATE trips SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`,
          ...keys.map((k) => obj[k]), now, id);
      };

      switch (action) {
        case 'load': {
          if (!['planned'].includes(t.status)) { ctx.flashMsg(ctx.t('a.no'), 'err'); break; }
          if (!t.lorry_id) { ctx.flashMsg(ctx.t('dlv.noLorry'), 'err'); break; }
          const batch = num(ctx.body.batch_m3, t.batch_m3);
          set({ status: 'loading', load_time: `${today()} ${time}:00`, batch_m3: batch });
          const res = deductTripMaterials(id, ctx.user.id);
          if (!res.ok) {
            run(`UPDATE trips SET status='planned', load_time=NULL WHERE id=?`, id);
            if (res.shortages) {
              ctx.flashMsg(`${ctx.t('ord.stockShort')}: ` + res.shortages.map((s) => `${s.name} ${qty(s.need)} ${s.unit} (${qty(s.have)})`).join(', '), 'err');
            } else ctx.flashMsg(res.msg, 'err');
            break;
          }
          syncLorryFromTrip(id);
          syncOrderFromTrips(t.order_id);
          ctx.flashMsg(ctx.t('dlv.materialsDeducted'));
          break;
        }
        case 'dispatch':
          if (!['planned', 'loading'].includes(t.status)) { ctx.flashMsg(ctx.t('a.no'), 'err'); break; }
          // a trip dispatched without an explicit load step still consumes materials
          if (t.status === 'planned') {
            set({ status: 'loading', load_time: `${today()} ${time}:00` });
            const res = deductTripMaterials(id, ctx.user.id);
            if (!res.ok) {
              run(`UPDATE trips SET status='planned', load_time=NULL WHERE id=?`, id);
              ctx.flashMsg(res.shortages
                ? `${ctx.t('ord.stockShort')}: ` + res.shortages.map((x) => `${x.name} ${qty(x.need)} ${x.unit} (${qty(x.have)})`).join(', ')
                : res.msg, 'err');
              break;
            }
          }
          set({ status: 'dispatched', depart_time: `${today()} ${time}:00`, odo_start: num(ctx.body.odo_start) || t.odo_start });
          syncLorryFromTrip(id);
          syncOrderFromTrips(t.order_id);
          ctx.flashMsg(ctx.t('trip.status.dispatched'));
          break;
        case 'arrive':
          set({ arrive_time: `${today()} ${time}:00` });
          ctx.flashMsg(ctx.t('dlv.arriveTime') + ': ' + time);
          break;
        case 'pump_start':
          set({ time_started: `${today()} ${time}:00` });
          ctx.flashMsg(ctx.t('dlv.startPump') + ': ' + time);
          break;
        case 'pump_stop':
          set({ time_finished: `${today()} ${time}:00` });
          ctx.flashMsg(ctx.t('dlv.stopPump') + ': ' + time);
          break;
        case 'deliver': {
          const delivered = num(ctx.body.delivered_m3, t.batch_m3);
          set({
            status: 'delivered',
            delivered_m3: delivered,
            slump_measured: ctx.body.slump_measured !== '' ? int(ctx.body.slump_measured) : t.slump_measured,
            receiver_name: str(ctx.body.receiver_name) || t.receiver_name,
            receiver_sign: str(ctx.body.receiver_sign) || t.receiver_sign,
            arrive_time: t.arrive_time || `${today()} ${time}:00`,
            time_finished: t.time_finished || `${today()} ${time}:00`,
            remark: str(ctx.body.remark) || t.remark,
          });
          syncOrderFromTrips(t.order_id);
          ctx.flashMsg(`${ctx.t('dlv.markDelivered')}: ${qty(delivered)} m³`);
          break;
        }
        case 'return': {
          const returned = num(ctx.body.returned_m3, 0);
          const litres = num(ctx.body.fuel_used_l, 0);
          set({
            status: 'returned',
            return_time: `${today()} ${time}:00`,
            returned_m3: returned,
            odo_end: num(ctx.body.odo_end) || t.odo_end,
            fuel_used_l: litres || t.fuel_used_l,
            remark: str(ctx.body.remark) || t.remark,
          });
          // leftover concrete is waste - note it
          if (returned > 0) {
            const o = get('SELECT * FROM orders WHERE id = ?', t.order_id);
            const mix = mixByCode(o.mix_code);
            if (mix) {
              const wasteItem = get(`SELECT * FROM items WHERE name = 'Waste Concrete'`);
              if (wasteItem) {
                recordMovement({
                  itemId: wasteItem.id, type: 'waste', qty: returned,
                  refType: 'trip', refId: id, refNo: t.trip_no, lorryId: t.lorry_id,
                  note: `${o.order_no} leftover`, userId: ctx.user.id,
                });
              }
            }
          }
          // fuel refill recorded on return trip
          if (num(ctx.body.fuel_litres) > 0) {
            addFuel({
              lorryId: t.lorry_id, litres: num(ctx.body.fuel_litres),
              pricePerLitre: num(ctx.body.fuel_price, 0), odometer: num(ctx.body.odo_end) || null,
              station: str(ctx.body.fuel_station), refType: 'trip', refId: id,
              userId: ctx.user.id, note: t.trip_no,
            });
          }
          syncLorryFromTrip(id);
          syncOrderFromTrips(t.order_id);
          ctx.flashMsg(ctx.t('dlv.markReturned'));
          break;
        }
        default:
          ctx.flashMsg('Unknown action: ' + action, 'err');
      }
      return { __redirect: back };
    },
  },

  /* ============ EDIT TRIP ============ */
  {
    method: 'POST', path: '/trips/:id/edit', handler(ctx) {
      const id = int(ctx.params.id);
      const t = get('SELECT * FROM trips WHERE id = ?', id);
      if (!t) return { __redirect: '/deliveries' };
      run(`UPDATE trips SET lorry_id=?, driver_id=?, batch_m3=?, remark=?, updated_at=? WHERE id=?`,
        int(ctx.body.lorry_id) || null, int(ctx.body.driver_id) || null, num(ctx.body.batch_m3), str(ctx.body.remark),
        new Date().toISOString(), id);
      syncOrderFromTrips(t.order_id);
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: str(ctx.body.back) || `/deliveries/${id}` };
    },
  },
];

/* ---------------- helpers ---------------- */
function slotName(ctx, slot) {
  return ctx.t(slot === 'pm' ? 'sch.slotPm' : slot === 'night' ? 'sch.slotNight' : 'sch.slotAm');
}
function quickAction(ctx, r) {
  const T = (k) => esc(ctx.t(k));
  const go = (action, label, ic, variant = 'primary') => `
    <form method="post" action="/trips/${r.id}/action" class="inline-form">
      <input type="hidden" name="action" value="${action}">
      <button class="btn btn-${variant} sm" type="submit">${ic ? icon(ic, 14) : ''}<span>${label}</span></button>
    </form>`;
  switch (r.status) {
    case 'planned': return go('load', T('dlv.markLoading'), 'box');
    case 'loading': return go('dispatch', T('dlv.markDispatched'), 'truck', 'teal');
    case 'dispatched': return go('deliver', T('dlv.markDelivered'), 'check', 'green');
    case 'delivered': return go('return', T('dlv.markReturned'), 'back');
    default: return `<a class="btn btn-ghost sm" href="/deliveries/${r.id}">${T('a.view')}</a>`;
  }
}

function tripDetail(ctx, id) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const t = get(`
    SELECT t.*, o.order_no, o.delivery_date, o.delivery_slot, o.mix_code, o.volume_m3, o.status AS order_status,
           o.customer_id, o.site_id,
           c.name AS customer, c.phone AS customer_phone, c.code AS ccode,
           (SELECT name FROM sites WHERE id = o.site_id) AS site_name,
           (SELECT address FROM sites WHERE id = o.site_id) AS site_address,
           (SELECT area FROM sites WHERE id = o.site_id) AS site_area,
           (SELECT access_note FROM sites WHERE id = o.site_id) AS site_access
    FROM trips t JOIN orders o ON o.id = t.order_id JOIN customers c ON c.id = o.customer_id
    WHERE t.id = ?`, id);
  if (!t) return page(ctx, { title: '404', body: alert('err', 'Trip not found'), actions: linkBtn(T('a.back'), '/deliveries', { ic: 'back' }) });

  const lorry = t.lorry_id ? get('SELECT * FROM lorries WHERE id = ?', t.lorry_id) : null;
  const driver = t.driver_id ? get('SELECT * FROM staff WHERE id = ?', t.driver_id) : null;
  const mix = mixByCode(t.mix_code);
  const lorries = all('SELECT * FROM lorries WHERE active = 1 ORDER BY code');
  const drivers = all(`SELECT * FROM staff WHERE role='driver' AND status='active' ORDER BY name`);
  const s = t.status;
  const stockWarn = [];

  const steps = [
    ['planned', T('ord.scheduleTrips')],
    ['loading', T('dlv.loadTime')],
    ['dispatched', T('dlv.departTime')],
    ['delivered', T('dlv.markDelivered')],
    ['returned', T('dlv.markReturned')],
  ];
  const order = ['planned', 'loading', 'dispatched', 'delivered', 'returned'];
  const curIdx = order.indexOf(s);
  const stepper = `<div class="stepper">${steps.map(([k, label], i) => `
    <div class="step ${i <= curIdx ? 'done' : ''} ${i === curIdx ? 'now' : ''}">
      <span class="step-dot">${i < curIdx ? '✓' : i + 1}</span><span class="step-lbl">${label}</span>
    </div>`).join('')}</div>`;

  /* --- action forms --- */
  let actionCard = '';
  if (s === 'planned') {
    const cements = ['Cement', 'Sand', 'Aggregate', 'Admixture'].map((n) => {
      const item = get(`SELECT * FROM items WHERE name = ? AND category='material'`, n);
      if (!item) return '';
      const need = n === 'Cement' ? num(mix?.cement_bags) * num(t.batch_m3)
        : n === 'Sand' ? num(mix?.sand_m3) * num(t.batch_m3)
        : n === 'Aggregate' ? num(mix?.agg_m3) * num(t.batch_m3)
        : num(mix?.admix_l) * num(t.batch_m3);
      const have = stockQty(item.id);
      const short = have < need;
      if (short) stockWarn.push(`${n}: ${qty(need)} ${item.unit} (${qty(have)})`);
      return `<tr><th>${esc(n)}</th><td class="ta-right">${qty(need)} ${esc(item.unit)}</td>
        <td class="ta-right ${short ? 'neg' : 'green'}">${qty(have)}</td></tr>`;
    }).join('');
    actionCard = card(cardHead(T('dlv.markLoading')), `
      ${stockWarn.length ? alert('warn', `${T('ord.stockShort')}: ${stockWarn.join(' · ')}`) : ''}
      <table class="tbl kv"><thead><tr><th>${T('inv.movType')}</th><th class="ta-right">${T('a.qty')}</th><th class="ta-right">${T('inv.stock')}</th></tr></thead><tbody>${cements}</tbody></table>
      <form method="post" action="/trips/${id}/action" class="form-grid">
        <input type="hidden" name="action" value="load"><input type="hidden" name="back" value="/deliveries/${id}">
        ${field({ label: T('dlv.batch') + ' (m³)', name: 'batch_m3', type: 'number', step: '0.01', value: t.batch_m3, required: true })}
        ${field({ label: T('dlv.loadTime'), name: 'time', type: 'time', value: nowLocal(), required: true })}
        <div class="form-actions">${submitBtn(T('dlv.markLoading'), { ic: 'box' })}</div>
      </form>`);
  } else if (s === 'loading') {
    actionCard = card(cardHead(T('dlv.markDispatched')), `
      <form method="post" action="/trips/${id}/action" class="form-grid">
        <input type="hidden" name="action" value="dispatch"><input type="hidden" name="back" value="/deliveries/${id}">
        ${field({ label: T('dlv.departTime'), name: 'time', type: 'time', value: nowLocal(), required: true })}
        ${field({ label: T('dlv.odo') + ' (mula)', name: 'odo_start', type: 'number', step: '1', value: lorry?.odometer ?? '' })}
        <div class="form-actions">${submitBtn(T('dlv.markDispatched'), { ic: 'truck' })}</div>
      </form>`);
  } else if (s === 'dispatched') {
    actionCard = card(cardHead(T('dlv.markDelivered')), `
      <form method="post" action="/trips/${id}/action" class="form-grid">
        <input type="hidden" name="action" value="deliver"><input type="hidden" name="back" value="/deliveries/${id}">
        ${field({ label: T('dlv.arriveTime'), name: 'time', type: 'time', value: nowLocal(), required: true })}
        ${field({ label: T('dlv.deliveredQty'), name: 'delivered_m3', type: 'number', step: '0.01', value: t.batch_m3, required: true })}
        ${field({ label: T('dlv.slump') + ' (mm)', name: 'slump_measured', type: 'number', step: '1', value: mix?.slump_mm ?? '' })}
        ${field({ label: T('dlv.receiver'), name: 'receiver_name', value: '' })}
        ${field({ label: T('doc.signedByCustomer'), name: 'receiver_sign', value: '', hint: T('a.optional') })}
        <label class="field span-2"><span class="field-label">${T('a.remark')}</span><textarea name="remark" rows="2"></textarea></label>
        <div class="form-actions">
          ${submitBtn(T('a.save') + ' · ' + T('dlv.arriveTime'), { ic: 'clock', variant: 'ghost', attrs: 'formnovalidate' })}
          ${submitBtn(T('dlv.markDelivered'), { ic: 'check' })}
        </div>
      </form>`);
  } else if (s === 'delivered') {
    const leftover = round2(Math.max(0, num(t.batch_m3) - num(t.delivered_m3)));
    actionCard = card(cardHead(T('dlv.markReturned')), `
      <form method="post" action="/trips/${id}/action" class="form-grid">
        <input type="hidden" name="action" value="return"><input type="hidden" name="back" value="/deliveries/${id}">
        ${field({ label: T('dlv.returnTime'), name: 'time', type: 'time', value: nowLocal(), required: true })}
        ${field({ label: T('dlv.returnedQty'), name: 'returned_m3', type: 'number', step: '0.01', value: leftover, hint: leftover > 0 ? T('inv.waste') : '' })}
        ${field({ label: T('dlv.odo') + ' (tamat)', name: 'odo_end', type: 'number', step: '1', value: lorry?.odometer ?? '' })}
        ${field({ label: T('fue.litres') + ' ' + T('dlv.fuelUsed'), name: 'fuel_used_l', type: 'number', step: '0.1', value: '' })}
        ${field({ label: T('fue.litres') + ' (isi)', name: 'fuel_litres', type: 'number', step: '0.1', value: '', hint: T('inv.issue') })}
        ${field({ label: T('fue.priceL'), name: 'fuel_price', type: 'number', step: '0.001', value: num(ctx.query.diesel_price, 2.05) })}
        ${field({ label: T('fue.station'), name: 'fuel_station', value: '' })}
        <div class="form-actions">${submitBtn(T('dlv.markReturned'), { ic: 'back' })}</div>
      </form>`);
  } else {
    actionCard = card(cardHead(T('a.detail')), `<p class="muted">${T('trip.status.returned')} · ${fmtDate((t.return_time || '').slice(0, 10), lang)} ${esc((t.return_time || '').slice(11, 16))}</p>`);
  }

  /* --- info cards --- */
  const infoCard = card(cardHead(T('a.detail')), `
    <table class="tbl kv">
      <tr><th>${T('ord.no')}</th><td class="ta-right"><a href="/orders/${t.order_id}">${esc(t.order_no)}</a></td></tr>
      <tr><th>${T('a.customer')}</th><td class="ta-right"><a href="/customers/${t.customer_id}">${esc(t.customer)}</a></td></tr>
      ${t.customer_phone ? `<tr><th>${T('a.phone')}</th><td class="ta-right"><a href="tel:${esc(t.customer_phone)}">${esc(t.customer_phone)}</a></td></tr>` : ''}
      <tr><th>${T('doc.site')}</th><td class="ta-right">${esc(t.site_name || '—')}<div class="sub tiny">${esc(t.site_area || '')}</div></td></tr>
      ${t.site_access ? `<tr><th>${T('cus.accessNote')}</th><td class="ta-right">${esc(t.site_access)}</td></tr>` : ''}
      <tr><th>${T('a.mix')}</th><td class="ta-right">${badge(esc(t.mix_code || '—'), 'mix')} ${mix?.grade_mpa ? `${qty(mix.grade_mpa, 0)} MPa` : ''}</td></tr>
      <tr><th>${T('a.lorry')}</th><td class="ta-right">${esc(lorry?.code || '—')} ${esc(lorry?.reg_no || '')}</td></tr>
      <tr><th>${T('a.driver')}</th><td class="ta-right">${esc(driver?.name || '—')}</td></tr>
    </table>`);

  const timeCard = card(cardHead(T('a.time')), `
    <table class="tbl kv">
      <tr><th>${T('dlv.loadTime')}</th><td class="ta-right">${esc(hm(t.load_time))}</td></tr>
      <tr><th>${T('dlv.departTime')}</th><td class="ta-right">${esc(hm(t.depart_time))}</td></tr>
      <tr><th>${T('dlv.arriveTime')}</th><td class="ta-right">${esc(hm(t.arrive_time))}</td></tr>
      <tr><th>${T('dlv.siteTimeStart')}</th><td class="ta-right">${esc(hm(t.time_started))}</td></tr>
      <tr><th>${T('dlv.siteTimeEnd')}</th><td class="ta-right">${esc(hm(t.time_finished))}</td></tr>
      <tr><th>${T('dlv.returnTime')}</th><td class="ta-right">${esc(hm(t.return_time))}</td></tr>
      <tr><th>${T('dlv.slump')}</th><td class="ta-right">${t.slump_measured ?? '—'} / ${mix?.slump_mm ?? '—'} mm</td></tr>
      <tr><th>${T('dlv.receiver')}</th><td class="ta-right">${esc(t.receiver_name || '—')}</td></tr>
      <tr><th>${T('dlv.odo')}</th><td class="ta-right">${t.odo_start ?? '—'} → ${t.odo_end ?? '—'} km</td></tr>
      <tr><th>${T('dlv.fuelUsed')}</th><td class="ta-right">${qty(t.fuel_used_l, 1)} L</td></tr>
    </table>`);

  const assignCard = card(cardHead(T('a.edit')), `
    <form method="post" action="/trips/${id}/edit" class="form-grid">
      <input type="hidden" name="back" value="/deliveries/${id}">
      ${field({ label: T('a.lorry'), name: 'lorry_id', value: t.lorry_id || '', options: [{ value: '', label: '—' }, ...lorries.map((l) => ({ value: l.id, label: `${l.code} · ${l.reg_no}` }))] })}
      ${field({ label: T('a.driver'), name: 'driver_id', value: t.driver_id || '', options: [{ value: '', label: '—' }, ...drivers.map((d) => ({ value: d.id, label: d.name }))] })}
      ${field({ label: T('dlv.batch'), name: 'batch_m3', type: 'number', step: '0.01', value: t.batch_m3 })}
      <label class="field span-2"><span class="field-label">${T('a.remark')}</span><textarea name="remark" rows="2">${esc(t.remark || '')}</textarea></label>
      <div class="form-actions">${submitBtn(T('a.save'), { ic: 'check' })}</div>
    </form>`);

  const actions = [
    linkBtn(T('dlv.ticket'), `/print/dn/${id}`, { ic: 'print', variant: 'primary' }),
    ['planned', 'loading'].includes(s) ? `<form method="post" action="/trips/${id}/delete" class="inline-form" onsubmit="return confirm('${T('a.delete')}?')">
      <input type="hidden" name="back" value="/deliveries/${id}">
      <button class="btn btn-danger-ghost" type="submit">${T('a.delete')}</button></form>` : '',
  ].filter(Boolean).join('');

  const body = `<div class="actions-row">${actions}</div>
    <div class="trip-head card">
      <div><div class="detail-no">${esc(t.trip_no)} ${statusBadge(ctx, 'trip.status', s)}</div>
        <div class="detail-sub">${T('dlv.run')} ${num(t.run_no)} · ${esc(t.dn_no || '')}</div>
        <div class="detail-sub">${T('a.date')}: <b>${fmtDate(t.delivery_date, lang)}</b> · ${esc(slotName(ctx, t.delivery_slot))}</div></div>
      <div class="detail-numbers">
        <div><span>${T('dlv.batch')}</span><b>${qty(t.batch_m3)} m³</b></div>
        <div><span>${T('dlv.deliveredQty')}</span><b class="teal">${qty(t.delivered_m3)} m³</b></div>
        <div><span>${T('dlv.returnedQty')}</span><b class="amber">${qty(t.returned_m3)} m³</b></div>
      </div>
    </div>
    ${stepper}
    <div class="grid-2">
      ${actionCard}
      <div class="stack">${infoCard}${timeCard}</div>
    </div>
    <div class="grid-2">${assignCard}
      ${card(cardHead(T('a.note')), `<p>${esc(t.remark || '—')}</p>`)}</div>`;

  return page(ctx, { title: t.trip_no, body, actions: linkBtn(T('a.back'), '/deliveries', { ic: 'back' }) });
}
const hm = (v) => (v ? `${String(v).slice(0, 10)} ${String(v).slice(11, 16)}` : '—');
