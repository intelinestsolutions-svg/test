import { all, get, run } from '../db.js';
import { redirect, html, today, num, str, int, addDays, download, toCsv } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  field, alert, linkBtn, submitBtn, filterBar, toolbar,
} from '../lib/html.js';
import { addFuel, removeFuelLog, round2, fuelCostForTrip } from '../lib/biz.js';

const LIMIT = 60;

export const fuelRoutes = [
  {
    method: 'GET', path: '/fuel', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const q = ctx.query;
      const offset = num(q.offset, 0);
      const where = [];
      const args = [];
      if (q.lorry) { where.push('f.lorry_id = ?'); args.push(int(q.lorry)); }
      if (q.from) { where.push('f.log_date >= ?'); args.push(q.from); }
      if (q.to) { where.push('f.log_date <= ?'); args.push(q.to); }
      const bc = ctx.bcond('f');
      if (bc) { where.push(bc.clause); args.push(...bc.params); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = all(`
        SELECT f.*, l.code AS lorry_code, l.reg_no, t.trip_no
        FROM fuel_logs f JOIN lorries l ON l.id = f.lorry_id
        LEFT JOIN trips t ON t.id = f.ref_id AND f.ref_type = 'trip'
        ${clause} ORDER BY f.log_date DESC, f.id DESC LIMIT ? OFFSET ?`, ...args, LIMIT, offset);
      const total = num(get(`SELECT COUNT(*) AS n FROM fuel_logs f ${clause}`, ...args)?.n);
      const sum = get(`SELECT COALESCE(SUM(f.litres),0) AS l, COALESCE(SUM(f.total),0) AS c, COALESCE(AVG(f.price_per_litre),0) AS p
                       FROM fuel_logs f ${clause}`, ...args);
      const lorries = all('SELECT * FROM lorries WHERE active = 1 ORDER BY code');
      const from = q.from || addDays(today(), -30);
      const to = q.to || today();
      const trips = get(`SELECT COUNT(*) AS n, COALESCE(SUM(t.delivered_m3),0) AS m3 FROM trips t
                         WHERE t.status IN ('delivered','returned') AND date(t.return_time) BETWEEN ? AND ?`, from, to);
      const costPerM3 = num(trips.m3) > 0 ? round2(num(sum.c) / num(trips.m3)) : 0;

      const stats = `<div class="stat-grid">
        ${stat(T('fue.totalLitres'), `${qty(sum.l, 0)} L`)}
        ${stat(T('fue.totalCost'), money(sum.c, lang))}
        ${stat(T('fue.avgPrice'), `${esc(money(sum.p, lang))} / L`)}
        ${stat(T('fue.costPerM3'), money(costPerM3, lang), 'amber')}
      </div>`;

      const tank = card(cardHead(T('fue.tankLevel')), lorries.length ? `<div class="tank-list">${lorries.map((l) => {
        const pct = Math.min(100, Math.round(num(l.fuel_litres) / 300 * 100));
        const lvl = pct <= 20 ? 'low' : pct <= 45 ? 'mid' : 'ok';
        return `<a class="tank-row" href="/fuel/new?lorry_id=${l.id}">
          <span class="tank-code">${esc(l.code)}</span>
          <div class="fuel-bar"><div class="fuel-fill ${lvl}" style="width:${pct}%"></div><span class="fuel-txt">${qty(l.fuel_litres, 0)} L</span></div>
        </a>`;
      }).join('')}</div>` : `<p class="muted">${T('a.noData')}</p>`);

      const body = `${stats}
        ${filterBar(ctx, {
          action: '/fuel',
          fields: [
            field({ label: T('a.lorry'), name: 'lorry', value: q.lorry || '', options: [{ value: '', label: T('a.all') }, ...lorries.map((l) => ({ value: l.id, label: l.code }))] }),
            field({ label: T('a.date') + ' (dari)', name: 'from', type: 'date', value: q.from || '' }),
            field({ label: T('a.date') + ' (hingga)', name: 'to', type: 'date', value: q.to || '' }),
          ].join(''),
        })}
        ${toolbar(T('a.showing') + ' ' + total + ' ' + T('a.records'),
          linkBtn(T('a.export'), `/fuel.csv?${new URLSearchParams(q)}`, { ic: 'download' }))}
        <div class="grid-side">${card(table([
          { key: 'log_date', label: T('a.date'), cell: (r) => fmtDate(r.log_date, lang) },
          { key: 'lorry_code', label: T('a.lorry'), cell: (r) => `<a href="/fleet/${r.lorry_id}"><b>${esc(r.lorry_code)}</b></a>` },
          { key: 'litres', label: T('fue.litres'), align: 'right', cell: (r) => `<b>${qty(r.litres, 1)}</b>` },
          { key: 'price_per_litre', label: T('fue.priceL'), align: 'right', cell: (r) => esc(money(r.price_per_litre, lang)) },
          { key: 'total', label: T('a.total'), align: 'right', cell: (r) => esc(money(r.total, lang)) },
          { key: 'odometer', label: T('fue.odo'), align: 'right', cell: (r) => qty(r.odometer, 0) },
          { key: 'trip_no', label: T('dlv.trip'), cell: (r) => r.trip_no ? `<a href="/deliveries/${r.trip_no}">${esc(r.trip_no)}</a>` : '—' },
          { key: 'receipt_no', label: T('fue.receiptNo'), cell: (r) => esc(r.receipt_no || '—') },
          { key: 'd', label: '', align: 'right', cell: (r) => `<form method="post" action="/fuel/${r.id}/delete" onsubmit="return confirm('${T('a.delete')}?')"><button class="btn btn-danger-ghost sm" type="submit">${T('a.delete')}</button></form>` },
        ], rows, { emptyMsg: T('a.noData') }))}${tank}</div>`;

      return html(ctx.res, page(ctx, {
        title: T('fue.title'),
        actions: linkBtn(T('fue.new'), '/fuel/new', { ic: 'fuel', variant: 'primary' }),
        body,
      }));
    },
  },
  {
    method: 'GET', path: '/fuel.csv', handler(ctx) {
      const rows = all(`SELECT f.log_date, l.code AS lorry, f.litres, f.price_per_litre, f.total, f.odometer, f.station, f.receipt_no, f.note
        FROM fuel_logs f JOIN lorries l ON l.id = f.lorry_id ORDER BY f.log_date DESC`);
      download(ctx.res, toCsv(rows.map((r) => Object.values(r)), Object.keys(rows[0] || { a: 1 })), `fuel-${today()}.csv`);
    },
  },
  {
    method: 'GET', path: '/fuel/new', handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const lorries = all('SELECT * FROM lorries WHERE active = 1 ORDER BY code');
      const trips = all(`SELECT t.id, t.trip_no, t.return_time, l.code AS lorry_code FROM trips t
                         LEFT JOIN lorries l ON l.id = t.lorry_id
                         WHERE t.status = 'delivered' AND t.return_time IS NULL ORDER BY t.id DESC LIMIT 25`);
      const lastPrice = num(get(`SELECT price_per_litre FROM fuel_logs ORDER BY id DESC LIMIT 1`)?.price_per_litre, 2.05);
      return html(ctx.res, page(ctx, {
        title: T('fue.new'),
        body: card(`<form method="post" action="/fuel/new" class="form-grid">
          ${field({ label: T('a.lorry'), name: 'lorry_id', value: ctx.query.lorry_id || lorries[0]?.id || '', options: lorries.map((l) => ({ value: l.id, label: `${l.code} · ${l.reg_no} (${qty(l.fuel_litres, 0)} L)` })), required: true })}
          ${field({ label: T('a.date'), name: 'log_date', type: 'date', value: today(), required: true })}
          ${field({ label: T('fue.litres'), name: 'litres', type: 'number', step: '0.1', value: '', required: true })}
          ${field({ label: T('fue.priceL'), name: 'price_per_litre', type: 'number', step: '0.001', value: lastPrice.toFixed(3), required: true })}
          ${field({ label: T('fue.odo'), name: 'odometer', type: 'number', step: '1', value: lorries[0]?.odometer ?? '' })}
          ${field({ label: T('fue.station'), name: 'station', value: '', placeholder: ctx.lang === 'bm' ? 'cth. Petronas KK' : 'e.g. Petronas KK' })}
          ${field({ label: T('fue.receiptNo'), name: 'receipt_no', value: '' })}
          ${field({ label: T('fue.refTrip'), name: 'ref_trip', value: '', options: [{ value: '', label: '—' }, ...trips.map((t) => ({ value: t.id, label: `${t.trip_no} · ${t.lorry_code || ''}` }))] })}
          <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2"></textarea></label>
          <div class="form-actions span-2">
            ${submitBtn(T('a.save'), { ic: 'check' })}
            <a class="btn btn-ghost" href="/fuel">${T('a.cancel')}</a>
          </div>
        </form>`),
        actions: linkBtn(T('a.back'), '/fuel', { ic: 'back' }),
      }));
    },
  },
  {
    method: 'POST', path: '/fuel/new', handler(ctx) {
      const lorryId = int(ctx.body.lorry_id);
      if (!lorryId) { ctx.flashMsg(ctx.t('a.lorry'), 'err'); return { __redirect: '/fuel/new' }; }
      const litres = num(ctx.body.litres);
      if (litres <= 0) { ctx.flashMsg(ctx.t('fue.litres'), 'err'); return { __redirect: '/fuel/new' }; }
      const tripRef = int(ctx.body.ref_trip);
      addFuel({
        lorryId, litres, pricePerLitre: num(ctx.body.price_per_litre),
        odometer: num(ctx.body.odometer) || null, station: str(ctx.body.station),
        receiptNo: str(ctx.body.receipt_no), refType: tripRef ? 'trip' : 'manual', refId: tripRef,
        note: str(ctx.body.note), userId: ctx.user.id, date: str(ctx.body.log_date) || today(),
      });
      if (tripRef) run(`UPDATE trips SET odometer_end = COALESCE(?, odometer_end) WHERE id = ?`, num(ctx.body.odometer) || null, tripRef);
      ctx.flashMsg(`${ctx.t('a.saved')}: ${qty(litres, 1)} L`);
      return { __redirect: '/fuel' };
    },
  },
  {
    method: 'POST', path: '/fuel/:id/delete', handler(ctx) {
      removeFuelLog(int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.deleted'));
      return { __redirect: '/fuel' };
    },
  },
];
const stat = (label, value, tone = '') =>
  `<div class="stat ${tone}"><div class="stat-top"><span class="stat-label">${label}</span></div><div class="stat-value">${value}</div></div>`;
