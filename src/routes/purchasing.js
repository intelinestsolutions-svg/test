import { all, get, run, tx, nextNo } from '../db.js';
import { redirect, html, today, num, str, int, addDays } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  field, alert, linkBtn, submitBtn, filterBar, tabs,
} from '../lib/html.js';
import { recordMovement, stockLevel, round2 } from '../lib/biz.js';

export const purchasingRoutes = [
  /* ============ suppliers ============ */
  {
    method: 'GET', path: '/suppliers', role: ['admin', 'office'], handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const rows = all(`SELECT s.*, (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id) AS po_n,
        (SELECT COALESCE(SUM(p.amount),0) FROM purchases p WHERE p.supplier_id = s.id) AS spend
        FROM suppliers s WHERE s.active = 1 ORDER BY s.name`);
      return html(ctx.res, page(ctx, {
        title: T('pur.supplier'),
        actions: linkBtn(T('pur.newSupplier'), '/suppliers/new', { ic: 'plus', variant: 'primary' }),
        body: card(table([
          { key: 'code', label: T('cus.code'), cell: (r) => esc(r.code || '—') },
          { key: 'name', label: T('a.name'), cell: (r) => `<b>${esc(r.name)}</b>` },
          { key: 'area', label: T('a.area'), cell: (r) => esc(r.area || '—') },
          { key: 'phone', label: T('a.phone'), cell: (r) => esc(r.phone || '—') },
          { key: 'po_n', label: T('pur.items'), align: 'right' },
          { key: 'spend', label: T('a.total'), align: 'right', cell: (r) => esc(money(r.spend, ctx.lang)) },
          { key: 'act', label: '', align: 'right', cell: (r) => linkBtn(T('a.edit'), `/suppliers/${r.id}/edit`, { variant: 'link', cls: 'sm' }) },
        ], rows, { emptyMsg: T('a.noDataHint') })),
      }));
    },
  },
  {
    method: 'GET', path: '/suppliers/new', role: ['admin', 'office'], handler(ctx) {
      return html(ctx.res, page(ctx, supplierForm(ctx, { active: 1 }, null)));
    },
  },
  {
    method: 'POST', path: '/suppliers/new', role: ['admin', 'office'], handler(ctx) {
      const f = sf(ctx);
      run(`INSERT INTO suppliers (code, name, phone, email, area, address, note, active) VALUES (?,?,?,?,?,?,?,?)`,
        f.code, f.name, f.phone, f.email, f.area, f.address, f.note, f.active);
      ctx.flashMsg(`${ctx.t('a.saved')}: ${f.name}`);
      return { __redirect: '/suppliers' };
    },
  },
  {
    method: 'GET', path: '/suppliers/:id/edit', role: ['admin', 'office'], handler(ctx) {
      const s = get('SELECT * FROM suppliers WHERE id = ?', int(ctx.params.id));
      if (!s) { ctx.flashMsg('404', 'err'); return { __redirect: '/suppliers' }; }
      return html(ctx.res, page(ctx, supplierForm(ctx, s, null)));
    },
  },
  {
    method: 'POST', path: '/suppliers/:id/edit', role: ['admin', 'office'], handler(ctx) {
      const f = sf(ctx);
      run(`UPDATE suppliers SET code=?, name=?, phone=?, email=?, area=?, address=?, note=?, active=? WHERE id=?`,
        f.code, f.name, f.phone, f.email, f.area, f.address, f.note, f.active, int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: '/suppliers' };
    },
  },

  /* ============ purchase orders ============ */
  {
    method: 'GET', path: '/purchasing', role: ['admin', 'office'], handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      // Pembelian tertakluk kepada cawangan.
      const pbb = ctx.bcond('p');
      const rows = all(`
        SELECT p.*, s.name AS supplier,
          (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS lines
        FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.status != 'cancelled'${pbb ? ` AND ${pbb.clause}` : ''}
        ORDER BY p.order_date DESC, p.id DESC LIMIT 100`, ...(pbb ? pbb.params : []));
      const pending = rows.filter((r) => r.status === 'ordered');
      const spend = round2(rows.filter((r) => r.status === 'received').reduce((s, r) => s + num(r.amount), 0));
      return html(ctx.res, page(ctx, {
        title: T('pur.title'),
        actions: linkBtn(T('pur.newPo'), '/purchasing/new', { ic: 'plus', variant: 'primary' }),
        body: `<div class="stat-grid">
            ${stat(T('pur.poNo'), String(rows.length))}
            ${stat(T('pur.pending'), String(pending.length), pending.length ? 'amber' : 'green')}
            ${stat(T('rep.inOut'), money(spend, lang))}
          </div>
          ${tabs(ctx, [['/purchasing', T('pur.title'), rows.length], ['/suppliers', T('pur.supplier'), null]], '/purchasing')}
          ${card(table([
            { key: 'po_no', label: T('pur.poNo'), cell: (r) => `<a href="/purchasing/${r.id}"><b>${esc(r.po_no)}</b></a>` },
            { key: 'order_date', label: T('a.date'), cell: (r) => fmtDate(r.order_date, lang) },
            { key: 'supplier', label: T('pur.supplier'), cell: (r) => esc(r.supplier) },
            { key: 'lines', label: T('pur.items'), align: 'right' },
            { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => esc(money(r.amount, lang)) },
            { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'pur.status', r.status) },
            { key: 'act', label: '', align: 'right', cell: (r) => r.status === 'ordered'
              ? `<form method="post" action="/purchasing/${r.id}/receive"><button class="btn btn-green sm" type="submit">${T('pur.receive')}</button></form>`
              : linkBtn(T('a.view'), `/purchasing/${r.id}`, { variant: 'link', cls: 'sm' }) },
          ], rows, { emptyMsg: T('a.noDataHint') }))}`,
      }));
    },
  },
  {
    method: 'GET', path: '/purchasing/new', role: ['admin', 'office'], handler(ctx) {
      return html(ctx.res, page(ctx, poForm(ctx, {
        po_no: nextNo('purchase', 'PO'), order_date: today(), delivery_date: today(), status: 'ordered',
      }, null)));
    },
  },
  {
    method: 'POST', path: '/purchasing/new', role: ['admin', 'office'], handler(ctx) {
      const suppliers = all('SELECT * FROM suppliers WHERE active = 1 ORDER BY name');
      const items = all('SELECT * FROM items WHERE active = 1 ORDER BY category, name');
      const lineIds = toArray(ctx.body.item_id);
      const qtys = toArray(ctx.body.qty);
      const costs = toArray(ctx.body.unit_cost);
      const pairs = [];
      for (let i = 0; i < lineIds.length; i++) {
        const id = int(lineIds[i]);
        if (!id || num(qtys[i]) === 0) continue;
        pairs.push({ id, qty: num(qtys[i]), cost: num(costs[i]) });
      }
      if (!pairs.length) { ctx.flashMsg(ctx.t('pur.items') + ' — 0', 'err'); return { __redirect: '/purchasing/new' }; }
      const total = round2(pairs.reduce((s, p) => s + p.qty * p.cost, 0));
      const p = tx(() => {
        const r = run(`INSERT INTO purchases (po_no, supplier_id, order_date, delivery_date, amount, status, note)
                       VALUES (?,?,?,?,?,?,?)`,
          str(ctx.body.po_no), int(ctx.body.supplier_id), str(ctx.body.order_date) || today(),
          str(ctx.body.delivery_date), total, str(ctx.body.status, 'ordered'), str(ctx.body.note));
        for (const p2 of pairs) {
          run('INSERT INTO purchase_items (purchase_id, item_id, qty, unit_cost) VALUES (?,?,?,?)', r.id, p2.id, p2.qty, p2.cost);
        }
        return r;
      });
      if (str(ctx.body.status) === 'received') receivePO(p.id, ctx.user.id, true);
      ctx.flashMsg(`${ctx.t('a.saved')}: ${str(ctx.body.po_no)}`);
      return { __redirect: `/purchasing/${p.id}` };
    },
  },
  {
    method: 'GET', path: '/purchasing/:id', role: ['admin', 'office'], handler(ctx) { return html(ctx.res, poDetail(ctx, int(ctx.params.id))); },
  },
  {
    method: 'POST', path: '/purchasing/:id/receive', role: ['admin', 'office'], handler(ctx) {
      receivePO(int(ctx.params.id), ctx.user.id, false);
      return { __redirect: `/purchasing/${int(ctx.params.id)}` };
    },
  },
  {
    method: 'POST', path: '/purchasing/:id/cancel', role: ['admin', 'office'], handler(ctx) {
      run(`UPDATE purchases SET status = 'cancelled' WHERE id = ?`, int(ctx.params.id));
      ctx.flashMsg(ctx.t('pur.status.cancelled'));
      return { __redirect: '/purchasing' };
    },
  },
];

/* ---------------- helpers ---------------- */
const stat = (label, value, tone = '') =>
  `<div class="stat ${tone}"><div class="stat-top"><span class="stat-label">${label}</span></div><div class="stat-value">${value}</div></div>`;
function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
function sf(ctx) {
  const b = ctx.body;
  return {
    code: str(b.code), name: str(b.name), phone: str(b.phone), email: str(b.email),
    area: str(b.area), address: str(b.address), note: str(b.note), active: b.active ? 1 : 0,
  };
}
function receivePO(id, userId, silent) {
  const p = get('SELECT * FROM purchases WHERE id = ?', id);
  if (!p || p.status === 'received') return;
  const lines = all('SELECT * FROM purchase_items WHERE purchase_id = ?', id);
  tx(() => {
    for (const l of lines) {
      recordMovement({
        itemId: l.item_id, type: 'in', qty: num(l.qty), unitCost: num(l.unit_cost),
        refType: 'purchase', refId: id, refNo: p.po_no, userId,
      });
    }
    run(`UPDATE purchases SET status = 'received' WHERE id = ?`, id);
  });
  if (!silent) return;
}

function supplierForm(ctx, s, err) {
  const T = (k) => esc(ctx.t(k));
  const isEdit = !!s.id;
  const body = `${err ? alert('err', err) : ''}${card(`<form method="post" action="${isEdit ? `/suppliers/${s.id}/edit` : '/suppliers/new'}" class="form-grid">
      ${field({ label: T('cus.code'), name: 'code', value: s.code || '' })}
      ${field({ label: T('a.name'), name: 'name', value: s.name || '', required: true })}
      ${field({ label: T('a.phone'), name: 'phone', value: s.phone || '' })}
      ${field({ label: T('set.email'), name: 'email', type: 'email', value: s.email || '' })}
      ${field({ label: T('a.area'), name: 'area', value: s.area || '' })}
      <label class="field"><span class="field-label">${T('a.address')}</span><textarea name="address" rows="2">${esc(s.address || '')}</textarea></label>
      <label class="field"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2">${esc(s.note || '')}</textarea></label>
      <div class="form-actions span-2">${submitBtn(T('a.save'), { ic: 'check' })}<a class="btn btn-ghost" href="/suppliers">${T('a.cancel')}</a></div>
    </form>`)}`;
  return {
    title: isEdit ? `${T('a.edit')} · ${esc(s.name)}` : T('pur.newSupplier'),
    body,
    actions: linkBtn(T('a.back'), '/suppliers', { ic: 'back' }),
  };
}

function poForm(ctx, p, err) {
  const T = (k) => esc(ctx.t(k));
  const suppliers = all('SELECT * FROM suppliers WHERE active = 1 ORDER BY name');
  const items = all('SELECT * FROM items WHERE active = 1 ORDER BY category, name');
  const rows = [0, 1, 2, 3].map(() => `<tr>
      <td><select name="item_id[]">${items.map((i) => `<option value="${i.id}">${esc(i.sku)} · ${esc(i.name)} (${esc(i.unit)})</option>`).join('')}</select></td>
      <td class="ta-right"><input type="number" step="0.01" name="qty[]" class="line-qty" placeholder="0"></td>
      <td class="ta-right"><input type="number" step="0.01" name="unit_cost[]" class="line-cost" placeholder="0.00"></td>
      <td class="ta-right line-total">0.00</td>
    </tr>`).join('');
  const body = `${err ? alert('err', err) : ''}${card(`<form method="post" action="/purchasing/new" class="form-grid" id="pof">
      ${field({ label: T('pur.poNo'), name: 'po_no', value: p.po_no, required: true })}
      ${field({ label: T('pur.supplier'), name: 'supplier_id', value: suppliers[0]?.id || '', options: suppliers.map((s) => ({ value: s.id, label: s.name })), required: true })}
      ${field({ label: T('a.date'), name: 'order_date', type: 'date', value: p.order_date })}
      ${field({ label: T('a.date') + ' ' + T('a.detail'), name: 'delivery_date', type: 'date', value: p.delivery_date })}
      ${field({ label: T('a.status'), name: 'status', value: p.status, options: [{ value: 'ordered', label: T('pur.status.ordered') }, { value: 'received', label: T('pur.status.received') }] })}
      <div class="span-2">
        <table class="tbl" id="poLines">
          <thead><tr><th>${T('inv.item')}</th><th class="ta-right">${T('a.qty')}</th><th class="ta-right">${T('inv.unitCost')}</th><th class="ta-right">${T('a.total')}</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><th colspan="3" class="ta-right">${T('a.total')}</th><th class="ta-right" id="poTotal">0.00</th></tr></tfoot>
        </table>
        <button class="btn btn-ghost sm mt" type="button" onclick="addLine()">${T('pur.addLine')}</button>
      </div>
      <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2"></textarea></label>
      <div class="form-actions span-2">${submitBtn(T('a.save'), { ic: 'check' })}<a class="btn btn-ghost" href="/purchasing">${T('a.cancel')}</a></div>
    </form>`)}`;
  return {
    title: T('pur.newPo'),
    body,
    actions: linkBtn(T('a.back'), '/purchasing', { ic: 'back' }),
    script: `
      function addLine() {
        const tb = document.querySelector('#poLines tbody');
        const r = tb.lastElementChild.cloneNode(true);
        r.querySelectorAll('input').forEach((i) => { i.value = ''; });
        tb.appendChild(r); calc();
      }
      function calc() {
        let t = 0;
        document.querySelectorAll('#poLines tbody tr').forEach((tr) => {
          const q = parseFloat(tr.querySelector('.line-qty').value) || 0;
          const c = parseFloat(tr.querySelector('.line-cost').value) || 0;
          const v = q * c; t += v;
          tr.querySelector('.line-total').textContent = v.toFixed(2);
        });
        document.getElementById('poTotal').textContent = t.toFixed(2);
      }
      document.querySelector('#pof').addEventListener('input', calc);
      document.querySelectorAll('.line-qty,.line-cost').forEach((i) => i.addEventListener('input', calc));
    `,
  };
}

function poDetail(ctx, id) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const p = get('SELECT p.*, s.name AS supplier, s.phone AS supplier_phone FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?', id);
  if (!p) { ctx.flashMsg('404', 'err'); return page(ctx, { title: '404', body: alert('err', 'Not found') }); }
  const lines = all(`SELECT pi.*, i.sku, i.name, i.unit FROM purchase_items pi JOIN items i ON i.id = pi.item_id WHERE pi.purchase_id = ?`, id);
  const body = `
    <div class="actions-row">
      ${p.status === 'ordered' ? `<form method="post" action="/purchasing/${id}/receive"><button class="btn btn-green" type="submit">${icon('check', 15)}<span>${T('pur.receive')}</span></button></form>` : ''}
      ${linkBtn(T('a.print'), `/print/po/${id}`, { ic: 'print' })}
      ${linkBtn(T('a.back'), '/purchasing', { ic: 'back' })}
    </div>
    ${card(`<div class="detail-head">
      <div><div class="detail-no">${esc(p.po_no)} ${statusBadge(ctx, 'pur.status', p.status)}</div>
        <div class="detail-sub">${T('pur.supplier')}: <b>${esc(p.supplier)}</b>${p.supplier_phone ? ` · ${esc(p.supplier_phone)}` : ''}</div>
        <div class="detail-sub">${T('a.date')}: ${fmtDate(p.order_date, lang)}${p.delivery_date ? ` · ${T('a.detail')}: ${fmtDate(p.delivery_date, lang)}` : ''}</div>
        ${p.note ? `<div class="detail-sub">${T('a.note')}: ${esc(p.note)}</div>` : ''}</div>
      <div class="detail-numbers"><div><span>${T('a.total')}</span><b>${esc(money(p.amount, lang))}</b></div></div>
    </div>`)}
    <div class="grid-1">${card(cardHead(T('pur.items')), table([
      { key: 'sku', label: T('inv.sku') },
      { key: 'name', label: T('inv.item'), cell: (r) => `<b>${esc(r.name)}</b>` },
      { key: 'qty', label: T('a.qty'), align: 'right', cell: (r) => `${qty(r.qty)} ${esc(r.unit)}` },
      { key: 'unit_cost', label: T('inv.unitCost'), align: 'right', cell: (r) => esc(money(r.unit_cost, lang)) },
      { key: 'tot', label: T('a.total'), align: 'right', cell: (r) => esc(money(num(r.qty) * num(r.unit_cost), lang)) },
    ], lines, { emptyMsg: T('a.noData') }))}</div>`;
  return page(ctx, { title: p.po_no, body, actions: linkBtn(T('a.back'), '/purchasing', { ic: 'back' }) });
}
