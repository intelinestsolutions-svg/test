import { all, get, run, tx } from '../db.js';
import { redirect, html, today, num, str, int, download, toCsv } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate,
  field, alert, linkBtn, submitBtn, filterBar, toolbar, tabs,
} from '../lib/html.js';
import { stockLevel, recordMovement, round2, round3, ensureItem } from '../lib/biz.js';

const CATS = ['material', 'fuel', 'part'];
const UNITS = ['bag', 'm3', 'litre', 'pcs', 'kg', 'pail', 'tyre', 'roll'];

export const inventoryRoutes = [
  /* ============ LIST ============ */
  {
    method: 'GET', path: '/inventory', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const q = ctx.query;
      const where = ['i.active = 1'];
      const args = [];
      if (q.cat) { where.push('i.category = ?'); args.push(q.cat); }
      if (q.q) { where.push('(i.name LIKE ? OR i.sku LIKE ? OR i.location LIKE ?)'); const s = `%${q.q}%`; args.push(s, s, s); }
      if (q.filter === 'low') where.push(`(SELECT COALESCE(SUM(CASE WHEN sm.type IN ('in','adjust') THEN sm.qty ELSE -sm.qty END),0) FROM stock_movements sm WHERE sm.item_id = i.id) <= i.min_qty`);
      // Stok adalah KHAS CAWANGAN - setiap cawangan ada baki sendiri.
      const bc = ctx.bcond('i');
      if (bc) { where.push(bc.clause); args.push(...bc.params); }

      const rows = all(`
        SELECT i.*,
          (SELECT COALESCE(SUM(CASE WHEN sm.type IN ('in','adjust') THEN sm.qty ELSE -sm.qty END),0) FROM stock_movements sm WHERE sm.item_id = i.id) AS bal,
          (SELECT MAX(sm.move_date) FROM stock_movements sm WHERE sm.item_id = i.id) AS last_move
        FROM items i WHERE ${where.join(' AND ')} ORDER BY i.category, i.name`, ...args);

      const withLevel = rows.map((r) => {
        const l = stockLevel(r.id);
        const low = num(r.bal) <= num(r.min_qty);
        return { ...r, ...l, bal: round3(r.bal), value: round2(num(r.bal) * num(r.unit_cost)), low };
      });

      const totalValue = round2(withLevel.reduce((s, r) => s + r.value, 0));
      const counts = {};
      for (const c of CATS) counts[c] = withLevel.filter((r) => r.category === c).length;
      const lowCount = withLevel.filter((r) => r.low).length;

      const stats = `<div class="stat-grid">
        ${stat(T('inv.stockValue'), money(totalValue, lang))}
        ${stat(T('inv.cat.material'), String(counts.material))}
        ${stat(T('inv.cat.fuel'), String(counts.fuel))}
        ${stat(T('inv.cat.part'), String(counts.part))}
        ${stat(T('inv.low'), String(lowCount), lowCount ? 'red' : 'green')}
      </div>`;

      const body = `${stats}
        ${tabs(ctx, [
          ['/inventory', T('inv.cat.material') + ' / ' + T('inv.cat.fuel') + ' / ' + T('inv.cat.part'), withLevel.length],
          ['/inventory?cat=material', T('inv.cat.material'), counts.material],
          ['/inventory?cat=fuel', T('inv.cat.fuel'), counts.fuel],
          ['/inventory?cat=part', T('inv.cat.part'), counts.part],
          ['/inventory?filter=low', T('inv.low'), lowCount],
        ], q.filter === 'low' ? '/inventory?filter=low' : q.cat ? `/inventory?cat=${q.cat}` : '/inventory')}
        ${filterBar(ctx, {
          action: '/inventory',
          fields: [
            field({ label: T('a.search'), name: 'q', value: q.q || '' }),
            field({ label: T('inv.category'), name: 'cat', value: q.cat || '', options: [{ value: '', label: T('a.all') }, ...CATS.map((c) => ({ value: c, label: ctx.t('inv.cat.' + c) }))] }),
          ].join(''),
        })}
        ${toolbar(T('a.showing') + ' ' + withLevel.length + ' ' + T('a.records'),
          linkBtn(T('a.export'), '/inventory.csv', { ic: 'download' }) +
          linkBtn(T('inv.in'), '/inventory/in', { ic: 'plus', variant: 'green' }) +
          linkBtn(T('inv.new'), '/inventory/new', { ic: 'box', variant: 'primary' }))}
        ${card(table([
          { key: 'sku', label: T('inv.sku'), cell: (r) => `<a href="/inventory/${r.id}"><b>${esc(r.sku)}</b></a>` },
          { key: 'name', label: T('inv.item'), cell: (r) => `${esc(r.name)}${r.location ? `<div class="sub tiny">${esc(r.location)}</div>` : ''}` },
          { key: 'category', label: T('inv.category'), cell: (r) => badge(esc(ctx.t('inv.cat.' + r.category)), 'cat-' + r.category) },
          { key: 'bal', label: T('inv.stock'), align: 'right', cell: (r) => `<b class="${r.bal <= 0 ? 'neg' : r.low ? 'amber' : ''}">${qty(r.bal)}</b> <span class="tiny muted">${esc(r.unit)}</span>` },
          { key: 'min_qty', label: T('inv.min'), align: 'right', cell: (r) => qty(r.min_qty) },
          { key: 'unit_cost', label: T('inv.unitCost'), align: 'right', cell: (r) => esc(money(r.unit_cost, lang)) },
          { key: 'value', label: T('inv.stockValue'), align: 'right', cell: (r) => esc(money(r.value, lang)) },
          { key: 'st', label: T('a.status'), align: 'right', cell: (r) => r.bal <= 0 ? badge(T('inv.outOfStock'), 'bad') : r.low ? badge(T('inv.low'), 'warn') : badge(T('inv.ok'), 'ok') },
          { key: 'act', label: '', align: 'right', cell: (r) => linkBtn(T('inv.in'), `/inventory/in?item_id=${r.id}`, { variant: 'link', cls: 'sm' }) },
        ], withLevel, { emptyMsg: T('a.noDataHint') }))}`;

      return html(ctx.res, page(ctx, { title: T('inv.title'), body }));
    },
  },
  {
    method: 'GET', path: '/inventory.csv', handler(ctx) {
      const rows = all(`SELECT i.sku, i.name, i.category, i.unit,
        (SELECT COALESCE(SUM(CASE WHEN sm.type IN ('in','adjust') THEN sm.qty ELSE -sm.qty END),0) FROM stock_movements sm WHERE sm.item_id=i.id) AS balance,
        i.min_qty, i.unit_cost, i.location
        FROM items i WHERE i.active=1 ORDER BY i.category, i.name`);
      download(ctx.res, toCsv(rows.map((r) => Object.values(r)), Object.keys(rows[0] || { a: 1 })), `stock-${today()}.csv`);
    },
  },

  {
    method: 'GET', path: '/inventory/new', handler(ctx) {
      return html(ctx.res, page(ctx, itemForm(ctx, { category: 'material', unit: 'bag', active: 1, min_qty: 0, unit_cost: 0 }, null)));
    },
  },
  /* ============ ITEM DETAIL (must come after literal paths) ============ */
  {
    method: 'GET', path: '/inventory/:id', handler(ctx) { return html(ctx.res, itemDetail(ctx, int(ctx.params.id))); },
  },
  {
    method: 'POST', path: '/inventory/new', handler(ctx) {
      const f = itemF(ctx);
      const r = run(`INSERT INTO items (sku, name, category, unit, min_qty, unit_cost, location, note, active, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
        f.sku, f.name, f.category, f.unit, f.min_qty, f.unit_cost, f.location, f.note, f.active, new Date().toISOString());
      if (num(f.opening_qty) !== 0) {
        recordMovement({ itemId: r.id, type: 'adjust', qty: num(f.opening_qty), refType: 'opening', note: ctx.t('inv.opening'), userId: ctx.user.id });
      }
      ctx.flashMsg(`${ctx.t('a.saved')}: ${f.name}`);
      return { __redirect: `/inventory/${r.id}` };
    },
  },
  {
    method: 'GET', path: '/inventory/:id/edit', handler(ctx) {
      const i = get('SELECT * FROM items WHERE id = ?', int(ctx.params.id));
      if (!i) { ctx.flashMsg('404', 'err'); return { __redirect: '/inventory' }; }
      return html(ctx.res, page(ctx, itemForm(ctx, i, null)));
    },
  },
  {
    method: 'POST', path: '/inventory/:id/edit', handler(ctx) {
      const f = itemF(ctx);
      run(`UPDATE items SET sku=?, name=?, category=?, unit=?, min_qty=?, unit_cost=?, location=?, note=?, active=? WHERE id=?`,
        f.sku, f.name, f.category, f.unit, f.min_qty, f.unit_cost, f.location, f.note, f.active, int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: `/inventory/${int(ctx.params.id)}` };
    },
  },

  /* ============ STOCK IN / OUT / ADJUST ============ */
  {
    method: 'GET', path: '/inventory/:move/in', handler(ctx) { return html(ctx.res, moveForm(ctx, int(ctx.params.move), 'in')); },
  },
  {
    method: 'GET', path: '/inventory/out', handler(ctx) { return html(ctx.res, moveForm(ctx, 0, 'out')); },
  },
  {
    method: 'GET', path: '/inventory/adjust', handler(ctx) { return html(ctx.res, moveForm(ctx, 0, 'adjust')); },
  },
  {
    method: 'POST', path: '/inventory/move', handler(ctx) {
      const itemId = int(ctx.body.item_id);
      const type = ['in', 'out', 'waste', 'adjust'].includes(str(ctx.body.type)) ? str(ctx.body.type) : 'in';
      const qtyIn = num(ctx.body.qty);
      if (!itemId || qtyIn === 0) { ctx.flashMsg(ctx.t('inv.movementQty'), 'err'); return { __redirect: str(ctx.body.back) || '/inventory' }; }
      if (type !== 'adjust' && Math.sign(qtyIn) < 0) {
        ctx.flashMsg(ctx.t('a.qty') + ' < 0 → ' + type, 'err');
        return { __redirect: str(ctx.body.back) || '/inventory' };
      }
      recordMovement({
        itemId, type, qty: qtyIn, unitCost: ctx.body.unit_cost !== '' && ctx.body.unit_cost !== undefined ? num(ctx.body.unit_cost) : null,
        refType: 'manual', note: str(ctx.body.note), userId: ctx.user.id, date: str(ctx.body.move_date) || today(),
      });
      ctx.flashMsg(ctx.t('a.saved'));
      return { __redirect: str(ctx.body.back) || `/inventory/${itemId}` };
    },
  },
  {
    method: 'POST', path: '/items/:id/delete', handler(ctx) {
      const i = get('SELECT * FROM items WHERE id = ?', int(ctx.params.id));
      if (!i) return { __redirect: '/inventory' };
      run('UPDATE items SET active = 0 WHERE id = ?', i.id);
      ctx.flashMsg(ctx.t('a.deleted'));
      return { __redirect: '/inventory' };
    },
  },
];

/* ---------------- helpers ---------------- */
const stat = (label, value, tone = '') =>
  `<div class="stat ${tone}"><div class="stat-top"><span class="stat-label">${label}</span></div><div class="stat-value">${value}</div></div>`;

function itemF(ctx) {
  const b = ctx.body;
  return {
    sku: str(b.sku) || 'SKU-' + Date.now().toString(36).toUpperCase().slice(-6),
    name: str(b.name), category: CATS.includes(str(b.category)) ? str(b.category) : 'material',
    unit: str(b.unit, 'pcs'), min_qty: num(b.min_qty, 0), unit_cost: num(b.unit_cost, 0),
    location: str(b.location), note: str(b.note), active: b.active ? 1 : 0,
    opening_qty: num(b.opening_qty, 0),
  };
}

function itemForm(ctx, i, err) {
  const T = (k) => esc(ctx.t(k));
  const isEdit = !!i.id;
  const body = `${err ? alert('err', err) : ''}
    ${card(`<form method="post" action="${isEdit ? `/inventory/${i.id}/edit` : '/inventory/new'}" class="form-grid">
      ${field({ label: T('inv.sku'), name: 'sku', value: i.sku || '', hint: isEdit ? '' : T('a.optional') })}
      ${field({ label: T('inv.item'), name: 'name', value: i.name || '', required: true })}
      ${field({ label: T('inv.category'), name: 'category', value: i.category, options: CATS.map((c) => ({ value: c, label: T('inv.cat.' + c) })) })}
      ${field({ label: T('a.unit'), name: 'unit', value: i.unit, options: UNITS.map((u) => ({ value: u, label: u })) })}
      ${field({ label: T('inv.min'), name: 'min_qty', type: 'number', step: '0.01', value: i.min_qty })}
      ${field({ label: T('inv.unitCost'), name: 'unit_cost', type: 'number', step: '0.01', value: i.unit_cost })}
      ${field({ label: T('inv.location'), name: 'location', value: i.location || '' })}
      ${!isEdit ? field({ label: T('inv.opening'), name: 'opening_qty', type: 'number', step: '0.01', value: 0 }) : ''}
      <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2">${esc(i.note || '')}</textarea></label>
      <div class="form-actions span-2">
        ${submitBtn(T('a.save'), { ic: 'check' })}
        <a class="btn btn-ghost" href="${isEdit ? `/inventory/${i.id}` : '/inventory'}">${T('a.cancel')}</a>
        ${isEdit ? `<label class="check"><input type="checkbox" name="active" value="1" ${i.active ? 'checked' : ''}><span>${T('stf.status.active')}</span></label>` : ''}
      </div>
    </form>`)}`;
  return {
    title: isEdit ? `${T('a.edit')} · ${esc(i.name)}` : T('inv.new'),
    body,
    actions: isEdit ? linkBtn(T('a.back'), `/inventory/${i.id}`, { ic: 'back' }) : linkBtn(T('a.cancel'), '/inventory', { ic: 'back' }),
  };
}

function moveForm(ctx, itemId, type) {
  const T = (k) => esc(ctx.t(k));
  const items = all('SELECT * FROM items WHERE active = 1 ORDER BY category, name');
  const titleKey = type === 'in' ? 'inv.in' : type === 'out' ? 'inv.out' : 'inv.adjust';
  const bal = itemId ? stockLevel(itemId).bal : 0;
  return page(ctx, {
    title: T(titleKey),
    body: card(`
      ${itemId ? alert('ok', `${T('inv.stock')}: ${qty(bal)} ${items.find((i) => i.id === itemId)?.unit || ''}`) : ''}
      <form method="post" action="/inventory/move" class="form-grid">
        <input type="hidden" name="back" value="${itemId ? `/inventory/${itemId}` : '/inventory'}">
        ${field({ label: T('inv.item'), name: 'item_id', value: itemId || ctx.query.item_id || '', options: items.map((i) => ({ value: i.id, label: `${i.sku} · ${i.name} (${i.unit})` })), required: true })}
        ${field({ label: T('inv.movType'), name: 'type', value: type, options: ['in', 'out', 'waste', 'adjust'].map((t) => ({ value: t, label: T(t === 'in' ? 'inv.in' : t === 'out' ? 'inv.out' : t === 'waste' ? 'inv.waste' : 'inv.adjust') })) })}
        ${field({ label: T('inv.movementQty') + (type === 'adjust' ? ' (±)' : ''), name: 'qty', type: 'number', step: '0.01', value: '', required: true, hint: type === 'adjust' ? T('a.optional') : '' })}
        ${field({ label: T('a.date'), name: 'move_date', type: 'date', value: today() })}
        ${field({ label: T('inv.unitCost'), name: 'unit_cost', type: 'number', step: '0.01', value: '', hint: T('a.optional') })}
        <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2"></textarea></label>
        <div class="form-actions span-2">
          ${submitBtn(T('a.save'), { ic: 'check' })}
          <a class="btn btn-ghost" href="${itemId ? `/inventory/${itemId}` : '/inventory'}">${T('a.cancel')}</a>
        </div>
      </form>`),
    actions: linkBtn(T('a.back'), itemId ? `/inventory/${itemId}` : '/inventory', { ic: 'back' }),
  });
}

function itemDetail(ctx, id) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const i = get('SELECT * FROM items WHERE id = ?', id);
  if (!i) { ctx.flashMsg('404', 'err'); return page(ctx, { title: '404', body: alert('err', 'Not found') }); }
  const l = stockLevel(id);
  const moves = all(`
    SELECT sm.*, u.name AS by_name, l.code AS lorry_code
    FROM stock_movements sm
    LEFT JOIN users u ON u.id = sm.created_by
    LEFT JOIN lorries l ON l.id = sm.lorry_id
    WHERE sm.item_id = ? ORDER BY sm.move_date DESC, sm.id DESC LIMIT 100`, id);
  const low = num(l.bal) <= num(i.min_qty);
  const suggest = round3(Math.max(0, num(i.min_qty) * 2 - num(l.bal)));

  const body = `
    ${low ? alert('warn', `${T('inv.low')}: ${qty(l.bal)} ${esc(i.unit)} ≤ ${qty(i.min_qty)}`) : ''}
    ${card(`<div class="detail-head">
      <div><div class="detail-no">${esc(i.name)} ${badge(esc(T('inv.cat.' + i.category)), 'cat-' + i.category)}</div>
        <div class="detail-sub">${T('inv.sku')}: ${esc(i.sku)} · ${T('a.unit')}: ${esc(i.unit)}</div>
        ${i.location ? `<div class="detail-sub">${T('inv.location')}: ${esc(i.location)}</div>` : ''}
        ${i.note ? `<div class="detail-sub">${T('a.note')}: ${esc(i.note)}</div>` : ''}</div>
      <div class="detail-numbers">
        <div><span>${T('inv.stock')}</span><b class="${low ? 'amber' : ''}">${qty(l.bal)} ${esc(i.unit)}</b></div>
        <div><span>${T('inv.min')}</span><b>${qty(i.min_qty)}</b></div>
        <div><span>${T('inv.unitCost')}</span><b>${esc(money(i.unit_cost, lang))}</b></div>
        <div><span>${T('inv.stockValue')}</span><b>${esc(money(num(l.bal) * num(i.unit_cost), lang))}</b></div>
      </div>
    </div>`)}
    <div class="actions-row">
      ${linkBtn(T('inv.in'), `/inventory/${id}/in`, { ic: 'plus', variant: 'green' })}
      ${linkBtn(T('inv.out'), `/inventory/out?item_id=${id}`, { ic: 'arrowDown' })}
      ${linkBtn(T('inv.adjust'), `/inventory/adjust?item_id=${id}`, { ic: 'edit' })}
      ${linkBtn(T('a.edit'), `/inventory/${id}/edit`, { ic: 'edit' })}
      ${suggest > 0 ? linkBtn(`${T('inv.suggestPurchase')} ${qty(suggest)}`, `/inventory/${id}/in`, { ic: 'purchase' }) : ''}
    </div>
    <div class="grid-1">${card(cardHead(T('inv.movements')), table([
      { key: 'move_date', label: T('a.date'), cell: (r) => fmtDate(r.move_date, lang) },
      { key: 'type', label: T('inv.movType'), cell: (r) => badge(esc(T(r.type === 'in' ? 'inv.in' : r.type === 'out' ? 'inv.out' : r.type === 'waste' ? 'inv.waste' : 'inv.adjust')), r.type === 'in' ? 'ok' : r.type === 'waste' ? 'bad' : r.type === 'out' ? 'neutral' : 'warn') },
      { key: 'qty', label: T('inv.movementQty'), align: 'right', cell: (r) => `<b class="${r.type === 'in' ? 'green' : ''}">${r.type === 'in' ? '+' : r.type === 'adjust' ? (num(r.qty) > 0 ? '+' : '') : '−'}${qty(r.qty)}</b>` },
      { key: 'unit_cost', label: T('inv.unitCost'), align: 'right', cell: (r) => esc(money(r.unit_cost, lang)) },
      { key: 'ref_no', label: T('a.reference'), cell: (r) => esc(r.ref_no || r.ref_type || '—') },
      { key: 'lorry_code', label: T('a.lorry'), cell: (r) => esc(r.lorry_code || '—') },
      { key: 'note', label: T('a.note'), cell: (r) => `<span class="trunc">${esc(r.note || '—')}</span>` },
      { key: 'by_name', label: T('a.created'), cell: (r) => esc(r.by_name || '—') },
    ], moves, { emptyMsg: T('a.noData') }))}</div>`;

  return page(ctx, {
    title: i.name,
    body,
    actions: linkBtn(T('a.back'), '/inventory', { ic: 'back' }),
  });
}
