import { all, get, run, tx } from '../db.js';
import { redirect, html, today, num, str, int, download, toCsv } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty,
  field, alert, linkBtn, submitBtn,
} from '../lib/html.js';
import { materialCostForMix, round2, ensureItem, stockQty } from '../lib/biz.js';

export const mixRoutes = [
  {
    method: 'GET', path: '/mix', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const rows = all(`
        SELECT m.*,
          (SELECT COUNT(*) FROM orders o WHERE o.mix_code = m.code AND o.status NOT IN ('cancelled','draft')) AS orders_n,
          (SELECT COALESCE(SUM(o.amount),0) FROM orders o WHERE o.mix_code = m.code AND o.status NOT IN ('cancelled','draft')) AS revenue,
          (SELECT COALESCE(SUM(t.delivered_m3),0) FROM trips t JOIN orders o2 ON o2.id = t.order_id
            WHERE o2.mix_code = m.code AND t.status IN ('delivered','returned')) AS m3
        FROM mix_designs m WHERE m.active = 1 ORDER BY m.code`);
      const withCost = rows.map((m) => {
        const cost = materialCostForMix(m, 1).total;
        return { ...m, cost, margin: round2(num(m.price_per_m3) - cost), marginPct: num(m.price_per_m3) > 0 ? Math.round((num(m.price_per_m3) - cost) / num(m.price_per_m3) * 100) : 0 };
      });
      const body = card(table([
        { key: 'code', label: T('mix.code'), cell: (r) => `<a href="/mix/${r.id}"><b>${esc(r.code)}</b></a>` },
        { key: 'name', label: T('a.name'), cell: (r) => esc(r.name || '—') },
        { key: 'grade_mpa', label: T('mix.grade'), align: 'right', cell: (r) => r.grade_mpa ? `${qty(r.grade_mpa, 0)} MPa` : '—' },
        { key: 'slump_mm', label: T('mix.slump'), align: 'right', cell: (r) => r.slump_mm ? `${r.slump_mm} mm` : '—' },
        { key: 'cement_bags', label: T('mix.cementBags'), align: 'right', cell: (r) => qty(r.cement_bags, 2) },
        { key: 'sand_m3', label: T('mix.sand'), align: 'right', cell: (r) => qty(r.sand_m3, 2) },
        { key: 'agg_m3', label: T('mix.agg'), align: 'right', cell: (r) => qty(r.agg_m3, 2) },
        { key: 'admix_l', label: T('mix.admix'), align: 'right', cell: (r) => qty(r.admix_l, 2) },
        { key: 'cost', label: T('mix.costPerM3'), align: 'right', cell: (r) => esc(money(r.cost, lang)) },
        { key: 'price_per_m3', label: T('mix.price'), align: 'right', cell: (r) => `<b>${esc(money(r.price_per_m3, lang))}</b>` },
        { key: 'margin', label: T('mix.margin'), align: 'right', cell: (r) => `<b class="${r.margin < 0 ? 'neg' : r.marginPct < 15 ? 'amber' : 'green'}">${esc(money(r.margin, lang))}</b><div class="sub tiny">${r.marginPct}%</div>` },
        { key: 'm3', label: T('a.volume'), align: 'right', cell: (r) => `${qty(r.m3)} m³` },
        { key: 'act', label: '', align: 'right', cell: (r) => linkBtn(T('a.edit'), `/mix/${r.id}/edit`, { variant: 'link', cls: 'sm' }) },
      ], withCost, { emptyMsg: T('a.noDataHint') }));
      return html(ctx.res, page(ctx, {
        title: T('mix.title'),
        actions: linkBtn(T('mix.new'), '/mix/new', { ic: 'plus', variant: 'primary' }),
        body,
      }));
    },
  },
  {
    method: 'GET', path: '/mix/new', handler(ctx) {
      return html(ctx.res, page(ctx, mixForm(ctx, {
        active: 1, slump_mm: 125, max_agg_mm: 20, min_charge_m3: 1,
        cement_bags: 6, sand_m3: 0.4, agg_m3: 0.8, admix_l: 3,
      }, null)));
    },
  },
  {
    method: 'POST', path: '/mix/new', handler(ctx) {
      const f = mf(ctx);
      const r = run(`INSERT INTO mix_designs (code, name, grade_mpa, slump_mm, max_agg_mm, cement_bags, sand_m3, agg_m3, admix_l, price_per_m3, min_charge_m3, active)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.code, f.name, f.grade_mpa, f.slump_mm, f.max_agg_mm, f.cement_bags, f.sand_m3, f.agg_m3, f.admix_l, f.price_per_m3, f.min_charge_m3, f.active);
      // make sure the four material items exist so stock can be tracked
      for (const [n, u] of [['Cement', 'bag'], ['Sand', 'm3'], ['Aggregate', 'm3'], ['Admixture', 'litre']]) ensureItem(n, u, 'material');
      ctx.flashMsg(`${ctx.t('a.saved')}: ${f.code}`);
      return { __redirect: `/mix/${r.id}` };
    },
  },
  {
    method: 'GET', path: '/mix/:id', handler(ctx) {
      const id = int(ctx.params.id);
      const m = get('SELECT * FROM mix_designs WHERE id = ?', id);
      if (!m) { ctx.flashMsg('404', 'err'); return { __redirect: '/mix' }; }
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const cost = materialCostForMix(m, 1);
      const margin = round2(num(m.price_per_m3) - cost.total);
      const usage = get(`SELECT COUNT(*) AS n, COALESCE(SUM(volume_m3),0) AS m3, COALESCE(SUM(amount),0) AS amt
                         FROM orders WHERE mix_code = ? AND status NOT IN ('cancelled','draft')`, m.code);
      const stock = cost.detail.map((d) => {
        const item = get(`SELECT * FROM items WHERE name = ? AND category='material'`, d.name);
        return { ...d, have: item ? stockQty(item.id) : 0, itemId: item?.id };
      });
      const body = `
        <div class="actions-row">
          ${linkBtn(T('mix.use'), `/orders/new?mix=${esc(m.code)}`, { ic: 'plus', variant: 'primary' })}
          ${linkBtn(T('a.edit'), `/mix/${id}/edit`, { ic: 'edit' })}
        </div>
        ${card(`<div class="detail-head">
          <div><div class="detail-no">${esc(m.code)} ${badge(m.active ? T('stf.status.active') : T('a.no'), m.active ? 'ok' : 'neutral')}</div>
            <div class="detail-sub">${esc(m.name || '')}</div>
            <div class="detail-sub">${m.grade_mpa ? `${T('mix.grade')}: <b>${qty(m.grade_mpa, 0)} MPa</b> · ` : ''}${m.slump_mm ? `${T('mix.slump')}: ${m.slump_mm} mm · ` : ''}${m.max_agg_mm ? `${T('mix.maxAgg')}: ${m.max_agg_mm} mm` : ''}</div></div>
          <div class="detail-numbers">
            <div><span>${T('mix.price')}</span><b>${esc(money(m.price_per_m3, lang))}</b></div>
            <div><span>${T('mix.costPerM3')}</span><b>${esc(money(cost.total, lang))}</b></div>
            <div><span>${T('mix.margin')}</span><b class="${margin < 0 ? 'neg' : 'green'}">${esc(money(margin, lang))}</b></div>
          </div>
        </div>`)}
        <div class="grid-2">
          ${card(cardHead(`${T('mix.bom')} · 1 m³`), table([
            { key: 'name', label: T('inv.item') },
            { key: 'qty', label: T('a.qty'), align: 'right', cell: (r) => `<b>${qty(r.qty, 2)}</b> ${esc(T('a.' + (r.name === 'Cement' ? 'bag' : r.name === 'Admixture' ? 'litre' : 'm3')))}` },
            { key: 'unitCost', label: T('inv.unitCost'), align: 'right', cell: (r) => esc(money(r.unitCost, lang)) },
            { key: 'have', label: T('inv.stock'), align: 'right', cell: (r) => `<span class="${r.have <= 0 ? 'neg' : ''}">${qty(r.have)}</span>` },
            { key: 'cost', label: T('a.cost'), align: 'right', cell: (r) => esc(money(r.cost, lang)) },
          ], stock))}
          ${card(cardHead(T('mix.profit')), `
            <table class="tbl kv">
              ${stock.map((r) => `<tr><th>${esc(r.name)}</th><td class="ta-right">${esc(money(r.cost, lang))}</td></tr>`).join('')}
              <tr><th><b>${T('mix.costPerM3')}</b></th><td class="ta-right"><b>${esc(money(cost.total, lang))}</b></td></tr>
              <tr><th>${T('mix.price')}</th><td class="ta-right">${esc(money(m.price_per_m3, lang))}</td></tr>
              <tr class="big"><th>${T('mix.margin')}</th><td class="ta-right ${margin < 0 ? 'neg' : 'green'}">${esc(money(margin, lang))}</td></tr>
            </table>
            <h3 class="mini-head" style="margin-top:1rem">${T('mix.use')} 10 m³ ${T('a.volume')}</h3>
            <table class="tbl kv">
              <tr><th>${T('rep.revenue')}</th><td class="ta-right">${esc(money(num(m.price_per_m3) * 10, lang))}</td></tr>
              <tr><th>${T('rep.materialCost')}</th><td class="ta-right">${esc(money(cost.total * 10, lang))}</td></tr>
              <tr class="big"><th>${T('rep.grossProfit')}</th><td class="ta-right green">${esc(money(margin * 10, lang))}</td></tr>
            </table>`)}
        </div>
        <div class="grid-1">${card(cardHead(T('a.summary')), table([
          { key: 'n', label: T('cus.totalOrders'), align: 'right' },
          { key: 'm3', label: T('a.volume'), align: 'right', cell: (r) => `${qty(r.m3)} m³` },
          { key: 'amt', label: T('rep.revenue'), align: 'right', cell: (r) => esc(money(r.amt, lang)) },
        ], [usage]))}</div>`;
      return html(ctx.res, page(ctx, {
        title: `${m.code} · ${m.name || ''}`,
        body,
        actions: linkBtn(T('a.back'), '/mix', { ic: 'back' }),
      }));
    },
  },
  {
    method: 'GET', path: '/mix/:id/edit', handler(ctx) {
      const m = get('SELECT * FROM mix_designs WHERE id = ?', int(ctx.params.id));
      if (!m) { ctx.flashMsg('404', 'err'); return { __redirect: '/mix' }; }
      return html(ctx.res, page(ctx, mixForm(ctx, m, null)));
    },
  },
  {
    method: 'POST', path: '/mix/:id/edit', handler(ctx) {
      const f = mf(ctx);
      run(`UPDATE mix_designs SET code=?, name=?, grade_mpa=?, slump_mm=?, max_agg_mm=?, cement_bags=?, sand_m3=?,
             agg_m3=?, admix_l=?, price_per_m3=?, min_charge_m3=?, active=? WHERE id=?`,
        f.code, f.name, f.grade_mpa, f.slump_mm, f.max_agg_mm, f.cement_bags, f.sand_m3, f.agg_m3, f.admix_l,
        f.price_per_m3, f.min_charge_m3, f.active, int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: `/mix/${int(ctx.params.id)}` };
    },
  },
  {
    method: 'POST', path: '/mix/:id/delete', handler(ctx) {
      run('UPDATE mix_designs SET active = 0 WHERE id = ?', int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.deleted'));
      return { __redirect: '/mix' };
    },
  },
];

function mf(ctx) {
  const b = ctx.body;
  return {
    code: str(b.code), name: str(b.name), grade_mpa: num(b.grade_mpa) || null,
    slump_mm: int(b.slump_mm) || null, max_agg_mm: int(b.max_agg_mm) || null,
    cement_bags: num(b.cement_bags), sand_m3: num(b.sand_m3), agg_m3: num(b.agg_m3), admix_l: num(b.admix_l),
    price_per_m3: num(b.price_per_m3), min_charge_m3: num(b.min_charge_m3, 1), active: b.active ? 1 : 0,
  };
}

function mixForm(ctx, m, err) {
  const T = (k) => esc(ctx.t(k));
  const isEdit = !!m.id;
  const body = `${err ? alert('err', err) : ''}
    ${card(`<form method="post" action="${isEdit ? `/mix/${m.id}/edit` : '/mix/new'}" class="form-grid">
      ${field({ label: T('mix.code'), name: 'code', value: m.code || '', required: true, placeholder: 'K1 / C25' })}
      ${field({ label: T('a.name'), name: 'name', value: m.name || '' })}
      ${field({ label: T('mix.grade'), name: 'grade_mpa', type: 'number', step: '1', value: m.grade_mpa ?? '' })}
      ${field({ label: T('mix.slump'), name: 'slump_mm', type: 'number', step: '1', value: m.slump_mm ?? '' })}
      ${field({ label: T('mix.maxAgg'), name: 'max_agg_mm', type: 'number', step: '1', value: m.max_agg_mm ?? '' })}
      <div class="span-2 form-divider"><b>${T('mix.bom')}</b></div>
      ${field({ label: T('mix.cementBags'), name: 'cement_bags', type: 'number', step: '0.01', value: m.cement_bags })}
      ${field({ label: T('mix.sand'), name: 'sand_m3', type: 'number', step: '0.01', value: m.sand_m3 })}
      ${field({ label: T('mix.agg'), name: 'agg_m3', type: 'number', step: '0.01', value: m.agg_m3 })}
      ${field({ label: T('mix.admix'), name: 'admix_l', type: 'number', step: '0.01', value: m.admix_l })}
      <div class="span-2 form-divider"></div>
      ${field({ label: T('mix.price'), name: 'price_per_m3', type: 'number', step: '0.01', value: m.price_per_m3, required: true })}
      ${field({ label: T('mix.minCharge'), name: 'min_charge_m3', type: 'number', step: '0.01', value: m.min_charge_m3 })}
      <div class="form-actions span-2">
        ${submitBtn(T('a.save'), { ic: 'check' })}
        <a class="btn btn-ghost" href="${isEdit ? `/mix/${m.id}` : '/mix'}">${T('a.cancel')}</a>
        ${isEdit ? `<label class="check"><input type="checkbox" name="active" value="1" ${m.active ? 'checked' : ''}><span>${T('stf.status.active')}</span></label>` : ''}
      </div>
    </form>`)}`;
  return {
    title: isEdit ? `${T('a.edit')} · ${esc(m.code)}` : T('mix.new'),
    body,
    actions: isEdit ? linkBtn(T('a.back'), `/mix/${m.id}`, { ic: 'back' }) : linkBtn(T('a.cancel'), '/mix', { ic: 'back' }),
  };
}
