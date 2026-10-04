import { all, get, run } from '../db.js';
import { redirect, html, today, num, str, int } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, qty, fmtDate, statusBadge,
  field, alert, linkBtn, submitBtn, raw,
} from '../lib/html.js';
import { round2 } from '../lib/biz.js';

const SLOTS = [
  ['am', 'sch.slotAm'], ['pm', 'sch.slotPm'], ['night', 'sch.slotNight'],
];

export const scheduleRoutes = [
  {
    method: 'GET', path: '/schedule', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const date = ctx.query.date || today();

      const sb = ctx.bcond('t');
      const trips = all(`
        SELECT t.*, o.order_no, o.delivery_slot, o.mix_code, o.volume_m3, o.customer_id, o.site_id,
               c.name AS customer, c.code AS ccode,
               l.code AS lorry_code, st.name AS driver,
               (SELECT name FROM sites WHERE id = o.site_id) AS site_name,
               (SELECT area FROM sites WHERE id = o.site_id) AS site_area
        FROM trips t
        JOIN orders o ON o.id = t.order_id
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN lorries l ON l.id = t.lorry_id
        LEFT JOIN staff st ON st.id = t.driver_id
        WHERE o.delivery_date = ? AND t.status != 'void' AND o.status != 'cancelled'${sb ? ` AND ${sb.clause}` : ''}
        ORDER BY o.delivery_slot, c.name, t.run_no`, date, ...(sb ? sb.params : []));

      // Lori & pemandu pun tertakluk kepada cawangan yang sedang dilihat.
      const lorries = all('SELECT * FROM lorries WHERE active = 1 ORDER BY code');
      const drivers = all(`SELECT * FROM staff WHERE role='driver' AND status='active' ORDER BY name`);
      const unassigned = trips.filter((t) => !t.lorry_id);

      /* --- per-lorry columns --- */
      const fleetBoard = lorries.map((l) => {
        const mine = trips.filter((t) => t.lorry_id === l.id);
        const loaded = mine.reduce((s, t) => s + num(t.batch_m3), 0);
        const tripsUsed = new Set(mine.map((t) => t.order_id)).size;
        const cap = num(l.capacity_m3) || 1;
        const util = Math.min(100, Math.round(tripsUsed / Math.max(1, Math.ceil(tripsUsed + (mine.length - tripsUsed))) * 100));
        return `<div class="board-col">
          <div class="board-col-head ${stCls(l.status)}">
            <a href="/fleet/${l.id}"><b>${esc(l.code)}</b></a>
            <span class="tiny">${esc(l.reg_no)}</span>
            <div class="board-badges">
              ${statusBadge(ctx, 'flt.status', l.status)}
              <span class="badge neutral">${qty(cap, 1)} m³</span>
            </div>
            <div class="fuel-bar sm"><div class="fuel-fill ${num(l.fuel_litres) <= 60 ? 'low' : 'ok'}" style="width:${Math.min(100, Math.round(num(l.fuel_litres) / 300 * 100))}%"></div></div>
            <div class="tiny muted">${T('sch.loaded')}: ${qty(loaded)} m³ · ${tripsUsed} ${T('flt.trips').toLowerCase()}</div>
          </div>
          <div class="board-col-body">
            ${mine.length ? mine.map((t) => tripChip(ctx, t)).join('') : `<div class="board-empty">—</div>`}
          </div>
          <form method="post" action="/schedule/assign" class="board-assign">
            <input type="hidden" name="date" value="${esc(date)}">
            <input type="hidden" name="lorry_id" value="${l.id}">
            <select name="trip_id" onchange="this.form.submit()">
              <option value="">+ ${T('sch.unassigned')}</option>
              ${trips.filter((t) => !t.lorry_id || t.lorry_id === l.id).map((t) => `<option value="${t.id}">${esc(t.trip_no)} · ${esc(t.customer).slice(0, 22)}</option>`).join('')}
            </select>
          </form>
        </div>`;
      }).join('');

      /* --- unassigned list --- */
      const unassignedCard = card(
        cardHead(`${T('sch.unassigned')} (${unassigned.length})`),
        table([
          { key: 'trip_no', label: T('dlv.trip'), cell: (r) => `<a href="/deliveries/${r.id}"><b>${esc(r.trip_no)}</b></a>` },
          { key: 'delivery_slot', label: T('ord.slot'), cell: (r) => badge(esc(slotName(ctx, r.delivery_slot)), 'neutral') },
          { key: 'customer', label: T('a.customer'), cell: (r) => esc(r.customer) },
          { key: 'site_area', label: T('a.area'), cell: (r) => esc(r.site_area || '—') },
          { key: 'mix_code', label: T('a.mix'), cell: (r) => badge(esc(r.mix_code || '—'), 'mix') },
          { key: 'batch_m3', label: T('dlv.batch'), align: 'right', cell: (r) => `${qty(r.batch_m3)} m³` },
        ], unassigned, { emptyMsg: T('inv.ok') })
      );

      /* --- slot summary --- */
      const slotCards = SLOTS.map(([sk, label]) => {
        const inSlot = trips.filter((t) => t.delivery_slot === sk);
        const m3 = inSlot.reduce((s, t) => s + num(t.batch_m3), 0);
        return `<div class="slot-card">
          <div class="slot-head">${T(label)} <b>${qty(m3)} m³</b></div>
          <div class="slot-n">${inSlot.length} ${T('dlv.trip').toLowerCase()} · ${new Set(inSlot.map((t) => t.lorry_id)).size} ${T('a.lorry').toLowerCase()}</div>
          <div class="slot-chips">${inSlot.map((t) => `<span class="chip" title="${esc(t.customer)}">${esc(t.lorry_code || t.trip_no)}</span>`).join('') || '<span class="tiny muted">—</span>'}</div>
        </div>`;
      }).join('');

      /* --- totals --- */
      const totalM3 = round2(trips.reduce((s, t) => s + num(t.batch_m3), 0));
      const done = trips.filter((t) => ['delivered', 'returned'].includes(t.status)).length;
      const fleetCap = round2(lorries.reduce((s, l) => s + num(l.capacity_m3), 0));
      const runsMax = lorries.length ? Math.max(1, Math.ceil(totalM3 / (fleetCap / Math.max(1, lorries.length)))) : 0;

      const body = `
        <div class="date-bar">
          <form method="get" action="/schedule">
            <a class="btn btn-ghost" href="/schedule?date=${addDay(date, -1)}">‹</a>
            <input type="date" name="date" value="${esc(date)}" onchange="this.form.submit()">
            <a class="btn btn-ghost" href="/schedule?date=${addDay(date, 1)}">›</a>
            <a class="btn btn-ghost" href="/schedule">${T('a.today')}</a>
          </form>
          <div class="date-summary">
            <b>${fmtDate(date, lang)}</b> · ${trips.length} ${T('dlv.trip').toLowerCase()} · <b>${qty(totalM3)} m³</b>
            · ${done}/${trips.length} ${T('ord.status.completed').toLowerCase()}
          </div>
        </div>
        <div class="slot-grid">${slotCards}</div>
        <div class="card">
          <div class="card-head"><h2>${T('sch.board')}</h2>
            <div class="card-head-right tiny muted">${T('sch.utilisation')}: ${fleetCap ? Math.round(totalM3 / (fleetCap * Math.max(1, runsMax)) * 100) : 0}% · ${T('sch.capacity')} ${qty(fleetCap)} m³</div></div>
          ${lorries.length ? `<div class="board">${fleetBoard}</div>` : alert('warn', T('a.noData'))}
        </div>
        ${unassigned.length ? unassignedCard : ''}`;

      return html(ctx.res, page(ctx, {
        title: `${T('sch.title')} · ${fmtDate(date, lang)}`,
        actions: linkBtn(T('dlv.title'), '/deliveries?date=' + date, { ic: 'truck' }),
        body,
      }));
    },
  },
  {
    method: 'POST', path: '/schedule/assign', handler(ctx) {
      const tripId = int(ctx.body.trip_id);
      const lorryId = int(ctx.body.lorry_id);
      const driverId = int(ctx.body.driver_id);
      if (tripId) {
        run(`UPDATE trips SET lorry_id = ?, driver_id = COALESCE(?, driver_id), updated_at = ? WHERE id = ?`,
          lorryId || null, driverId || null, new Date().toISOString(), tripId);
        ctx.flashMsg(ctx.t('a.updated'));
      }
      return { __redirect: `/schedule?date=${str(ctx.body.date) || today()}` };
    },
  },
  {
    method: 'POST', path: '/schedule/assign/:tripId', handler(ctx) {
      const tripId = int(ctx.params.tripId);
      run(`UPDATE trips SET driver_id = ?, updated_at = ? WHERE id = ?`,
        int(ctx.body.driver_id) || null, new Date().toISOString(), tripId);
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: str(ctx.body.back) || '/schedule' };
    },
  },
];

function addDay(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function stCls(s) { return 'fl-' + s; }
function slotName(ctx, slot) {
  return ctx.t(slot === 'pm' ? 'sch.slotPm' : slot === 'night' ? 'sch.slotNight' : 'sch.slotAm');
}
function tripChip(ctx, t) {
  const cls = t.status === 'dispatched' ? 'chip-dispatched' : t.status === 'delivered' || t.status === 'returned' ? 'chip-done' : '';
  return `<a class="trip-chip ${cls}" href="/deliveries/${t.id}">
    <div class="tc-top"><b>${esc(t.trip_no)}</b>${statusBadge(ctx, 'trip.status', t.status)}</div>
    <div class="tc-cust trunc">${esc(t.customer)}</div>
    <div class="tc-meta">${esc(t.site_area || '')} · ${badge(esc(t.mix_code || '—'), 'mix')} · <b>${qty(t.batch_m3)} m³</b></div>
  </a>`;
}
