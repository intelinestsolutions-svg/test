import { all, get, run, setting } from '../db.js';
import { redirect, html, today, num, str, int } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  field, alert, linkBtn, submitBtn, filterBar, toolbar, submitBtn as sb,
} from '../lib/html.js';
import { customerBalance, round2 } from '../lib/biz.js';

const SABAH_AREAS = [
  'Kota Kinabalu', 'Kota Belud', 'Kota Marudu', 'Papar', 'Penampang', 'Tamparuli', 'Telipok',
  'Sandakan', 'Telupid', 'Bunut', 'Semawang',
  'Tawau', 'Lahad Datu', 'Semporna', 'Kunak',
  'Keningau', 'Tenom', 'Pensiangan', 'Kota Nabalu',
  'Miri', 'Bintulu', 'Limbang', 'Kapit', 'Song', 'Lawas',
  'Sandakan/Papar', 'Lain-lain',
];

export const customerRoutes = [
  {
    method: 'GET', path: '/customers', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const q = ctx.query;
      const where = [];
      const args = [];
      if (q.q) { where.push('(name LIKE ? OR company LIKE ? OR code LIKE ? OR phone LIKE ?)'); const s = `%${q.q}%`; args.push(s, s, s, s); }
      if (q.area) { where.push('area = ?'); args.push(q.area); }
      if (q.active !== undefined && q.active !== '') { where.push('active = ?'); args.push(int(q.active)); }
      // Pelanggan adalah KHAS CAWANGAN.
      const bc = ctx.bcond('c');
      if (bc) { where.push(bc.clause); args.push(...bc.params); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = all(`
        SELECT c.*,
          (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders_n,
          (SELECT COALESCE(SUM(o.amount),0) FROM orders o WHERE o.customer_id = c.id AND o.status NOT IN ('cancelled','draft')) AS spend,
          (SELECT COALESCE(SUM(i.amount - i.amount_paid),0) FROM invoices i WHERE i.customer_id = c.id AND i.status != 'cancelled') AS balance,
          (SELECT MAX(o.delivery_date) FROM orders o WHERE o.customer_id = c.id) AS last_order
        FROM customers c ${clause} ORDER BY c.name`, ...args);

      const body = `${filterBar(ctx, {
        action: '/customers',
        fields: [
          field({ label: T('a.search'), name: 'q', value: q.q || '', placeholder: T('a.name') }),
          field({ label: T('a.area'), name: 'area', value: q.area || '', options: [{ value: '', label: T('a.all') }, ...SABAH_AREAS.map((a) => ({ value: a, label: a }))] }),
          field({ label: T('a.status'), name: 'active', value: q.active || '', options: [{ value: '', label: T('a.all') }, { value: '1', label: T('stf.status.active') }, { value: '0', label: T('a.no') }] }),
        ].join(''),
      })}
      ${card(table([
        { key: 'code', label: T('cus.code'), cell: (r) => esc(r.code || '—') },
        { key: 'name', label: T('a.name'), cell: (r) => `<a href="/customers/${r.id}"><b>${esc(r.name)}</b></a>${r.company ? `<div class="sub tiny">${esc(r.company)}</div>` : ''}` },
        { key: 'area', label: T('a.area'), cell: (r) => esc(r.area || '—') },
        { key: 'phone', label: T('a.phone'), cell: (r) => r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '—' },
        { key: 'orders_n', label: T('cus.totalOrders'), align: 'right' },
        { key: 'spend', label: T('cus.totalSpend'), align: 'right', cell: (r) => esc(money(r.spend, lang)) },
        { key: 'balance', label: T('cus.balance'), align: 'right', cell: (r) => num(r.balance) > 0 ? `<b class="amber">${esc(money(r.balance, lang))}</b>` : '<span class="green">—</span>' },
        { key: 'last_order', label: T('ord.deliveryDate'), cell: (r) => r.last_order ? fmtDate(r.last_order, lang) : '—' },
        { key: 'active', label: T('a.status'), cell: (r) => badge(r.active ? T('stf.status.active') : T('a.no'), r.active ? 'ok' : 'neutral') },
      ], rows, { emptyMsg: T('a.noDataHint') }))}`;

      return html(ctx.res, page(ctx, {
        title: T('cus.title'),
        actions: linkBtn(T('cus.new'), '/customers/new', { ic: 'plus', variant: 'primary' }),
        body,
      }));
    },
  },
  {
    method: 'GET', path: '/customers/new', handler(ctx) {
      return html(ctx.res, page(ctx, customerForm(ctx, {
        active: 1, payment_terms_days: num(setting('default_payment_terms'), 0), credit_limit: 0,
      }, null)));
    },
  },
  {
    method: 'POST', path: '/customers/new', handler(ctx) {
      const f = cf(ctx);
      const r = run(`INSERT INTO customers (code, name, company, phone, phone2, email, area, billing_address,
                     payment_terms_days, credit_limit, note, active, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.code, f.name, f.company, f.phone, f.phone2, f.email, f.area, f.billing_address,
        f.payment_terms_days, f.credit_limit, f.note, f.active, new Date().toISOString());
      ctx.flashMsg(`${ctx.t('a.saved')}: ${f.name}`);
      return { __redirect: `/customers/${r.id}` };
    },
  },
  {
    method: 'GET', path: '/customers/:id', handler(ctx) { return html(ctx.res, customerDetail(ctx, int(ctx.params.id))); },
  },
  {
    method: 'GET', path: '/customers/:id/edit', handler(ctx) {
      const c = get('SELECT * FROM customers WHERE id = ?', int(ctx.params.id));
      if (!c) { ctx.flashMsg('404', 'err'); return { __redirect: '/customers' }; }
      return html(ctx.res, page(ctx, customerForm(ctx, c, null)));
    },
  },
  {
    method: 'POST', path: '/customers/:id/edit', handler(ctx) {
      const f = cf(ctx);
      run(`UPDATE customers SET code=?, name=?, company=?, phone=?, phone2=?, email=?, area=?, billing_address=?,
             payment_terms_days=?, credit_limit=?, note=?, active=? WHERE id=?`,
        f.code, f.name, f.company, f.phone, f.phone2, f.email, f.area, f.billing_address,
        f.payment_terms_days, f.credit_limit, f.note, f.active, int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: `/customers/${int(ctx.params.id)}` };
    },
  },
  /* ---- sites ---- */
  {
    method: 'POST', path: '/customers/:id/sites', handler(ctx) {
      run(`INSERT INTO sites (customer_id, name, address, area, access_note) VALUES (?,?,?,?,?)`,
        int(ctx.params.id), str(ctx.body.name), str(ctx.body.address), str(ctx.body.area), str(ctx.body.access_note));
      ctx.flashMsg(ctx.t('a.saved'));
      return { __redirect: `/customers/${int(ctx.params.id)}` };
    },
  },
  {
    method: 'POST', path: '/sites/:id/delete', handler(ctx) {
      const s = get('SELECT * FROM sites WHERE id = ?', int(ctx.params.id));
      if (!s) return { __redirect: '/customers' };
      run('DELETE FROM sites WHERE id = ?', s.id);
      ctx.flashMsg(ctx.t('a.deleted'));
      return { __redirect: `/customers/${s.customer_id}` };
    },
  },
  {
    method: 'GET', path: '/customers.csv', handler(ctx) {
      const rows = all(`SELECT c.code, c.name, c.company, c.phone, c.email, c.area, c.payment_terms_days, c.credit_limit,
        (SELECT COALESCE(SUM(i.amount - i.amount_paid),0) FROM invoices i WHERE i.customer_id=c.id AND i.status!='cancelled') AS balance
        FROM customers c ORDER BY c.name`);
      return html(ctx.res, `<!doctype html><meta charset="utf-8"><h1>CSV</h1><pre>${esc(JSON.stringify(rows, null, 1))}</pre>`);
    },
  },
];

/* ---------------- helpers ---------------- */
function cf(ctx) {
  const b = ctx.body;
  return {
    code: str(b.code), name: str(b.name), company: str(b.company),
    phone: str(b.phone), phone2: str(b.phone2), email: str(b.email),
    area: str(b.area), billing_address: str(b.billing_address),
    payment_terms_days: int(b.payment_terms_days, 0), credit_limit: num(b.credit_limit, 0),
    note: str(b.note), active: b.active ? 1 : 0,
  };
}

function customerForm(ctx, c, err) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const isEdit = !!c.id;
  const body = `${err ? alert('err', err) : ''}
    ${card(`<form method="post" action="${isEdit ? `/customers/${c.id}/edit` : '/customers/new'}" class="form-grid">
      ${field({ label: T('cus.code'), name: 'code', value: c.code || '' })}
      ${field({ label: T('a.name'), name: 'name', value: c.name || '', required: true })}
      ${field({ label: T('cus.company'), name: 'company', value: c.company || '' })}
      ${field({ label: T('a.area'), name: 'area', value: c.area || '', options: [{ value: '', label: '—' }, ...SABAH_AREAS.map((a) => ({ value: a, label: a }))] })}
      ${field({ label: T('a.phone'), name: 'phone', value: c.phone || '' })}
      ${field({ label: T('a.phone') + ' 2', name: 'phone2', value: c.phone2 || '' })}
      ${field({ label: T('set.email'), name: 'email', type: 'email', value: c.email || '' })}
      ${field({ label: T('cus.terms'), name: 'payment_terms_days', type: 'number', value: c.payment_terms_days, step: '1' })}
      ${field({ label: T('cus.creditLimit'), name: 'credit_limit', type: 'number', value: c.credit_limit, step: '0.01' })}
      <label class="field span-2"><span class="field-label">${T('a.address')}</span><textarea name="billing_address" rows="2">${esc(c.billing_address || '')}</textarea></label>
      <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2">${esc(c.note || '')}</textarea></label>
      <div class="form-actions span-2">
        ${submitBtn(T('a.save'), { ic: 'check' })}
        <a class="btn btn-ghost" href="${isEdit ? `/customers/${c.id}` : '/customers'}">${T('a.cancel')}</a>
        ${isEdit ? `<label class="check">${checkboxChecked(T('stf.status.active'), 'active', c.active)}</label>` : ''}
      </div>
    </form>`)}`;
  return {
    title: isEdit ? `${T('a.edit')} · ${esc(c.name)}` : T('cus.new'),
    body,
    actions: isEdit ? linkBtn(T('a.back'), `/customers/${c.id}`, { ic: 'back' }) : linkBtn(T('a.cancel'), '/customers', { ic: 'back' }),
  };
}
const checkboxChecked = (label, name, on) =>
  `<input type="checkbox" name="${name}" value="1" ${on ? 'checked' : ''}><span>${label}</span>`;

function customerDetail(ctx, id) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const c = get('SELECT * FROM customers WHERE id = ?', id);
  if (!c) { ctx.flashMsg('404', 'err'); return page(ctx, { title: '404', body: alert('err', 'Not found') }); }
  const sites = all('SELECT * FROM sites WHERE customer_id = ? ORDER BY name', id);
  const balance = customerBalance(id);
  const orders = all(`SELECT o.*, (SELECT COALESCE(SUM(t.delivered_m3),0) FROM trips t WHERE t.order_id=o.id AND t.status IN ('delivered','returned')) AS delivered,
                      (SELECT invoice_no FROM invoices i WHERE i.order_id=o.id) AS invoice_no
                      FROM orders o WHERE o.customer_id = ? ORDER BY o.delivery_date DESC LIMIT 30`, id);
  const invoices = all(`SELECT * FROM invoices WHERE customer_id = ? AND status != 'cancelled' ORDER BY issue_date DESC LIMIT 30`, id);
  const overLimit = num(c.credit_limit) > 0 && balance > num(c.credit_limit);

  const stats = `
    <div class="stat-grid">
      ${statBlock(T('cus.balance'), money(balance, lang), balance > 0 ? 'amber' : 'green')}
      ${statBlock(T('cus.creditLimit'), money(c.credit_limit, lang))}
      ${statBlock(T('cus.terms'), `${num(c.payment_terms_days)} ${T('inv2.days')}`)}
      ${statBlock(T('cus.totalOrders'), num(orders.length))}
    </div>`;

  const body = `
    ${overLimit ? alert('warn', `${T('cus.overLimit')}: ${esc(money(balance, lang))} > ${esc(money(c.credit_limit, lang))}`) : ''}
    ${card(`<div class="detail-head">
      <div><div class="detail-no">${esc(c.name)} ${c.active ? badge(T('stf.status.active'), 'ok') : badge(T('a.no'), 'neutral')}</div>
        ${c.company ? `<div class="detail-sub">${esc(c.company)}</div>` : ''}
        <div class="detail-sub">${T('a.phone')}: ${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}
          ${c.email ? ` · <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</div>
        <div class="detail-sub">${T('a.area')}: ${esc(c.area || '—')}</div>
        ${c.billing_address ? `<div class="detail-sub">${T('a.address')}: ${esc(c.billing_address)}</div>` : ''}
        ${c.note ? `<div class="detail-sub">${T('a.note')}: ${esc(c.note)}</div>` : ''}</div>
      <div class="detail-numbers">
        <div><span>${T('cus.code')}</span><b>${esc(c.code || '—')}</b></div>
        <div><span>${T('a.balance')}</span><b class="${balance > 0 ? 'amber' : 'green'}">${esc(money(balance, lang))}</b></div>
      </div>
    </div>`)}
    ${stats}
    <div class="grid-2">
      ${card(cardHead(T('cus.sites')), table([
        { key: 'name', label: T('a.name'), cell: (r) => `<b>${esc(r.name || '—')}</b>` },
        { key: 'area', label: T('a.area'), cell: (r) => esc(r.area || '—') },
        { key: 'address', label: T('a.address'), cell: (r) => `<span class="trunc">${esc(r.address || '—')}</span>` },
        { key: 'access_note', label: T('cus.accessNote'), cell: (r) => `<span class="trunc tiny muted">${esc(r.access_note || '—')}</span>` },
        { key: 'd', label: '', align: 'right', cell: (r) => `<form method="post" action="/sites/${r.id}/delete" onsubmit="return confirm('${T('a.delete')}?')"><button class="btn btn-danger-ghost sm" type="submit">${T('a.delete')}</button></form>` },
      ], sites, { emptyMsg: T('a.noData') }) + `
        <form method="post" action="/customers/${id}/sites" class="form-grid mt">
          ${field({ label: T('a.name'), name: 'name', value: '' })}
          ${field({ label: T('a.address'), name: 'address', value: '' })}
          ${field({ label: T('a.area'), name: 'area', value: c.area || '', options: [{ value: '', label: '—' }, ...SABAH_AREAS.map((a) => ({ value: a, label: a }))] })}
          ${field({ label: T('cus.accessNote'), name: 'access_note', value: '' })}
          <div class="form-actions span-2">${submitBtn(T('cus.newSite'), { ic: 'plus', variant: 'ghost' })}</div>
        </form>`)}
      ${card(cardHead(T('inv2.title')), table([
        { key: 'invoice_no', label: T('inv2.no'), cell: (r) => `<a href="/invoices/${r.id}"><b>${esc(r.invoice_no)}</b></a>` },
        { key: 'issue_date', label: T('inv2.issueDate'), cell: (r) => fmtDate(r.issue_date, lang) },
        { key: 'due_date', label: T('inv2.dueDate'), cell: (r) => fmtDate(r.due_date, lang) },
        { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => esc(money(r.amount, lang)) },
        { key: 'bal', label: T('a.balance'), align: 'right', cell: (r) => {
            const b = round2(num(r.amount) - num(r.amount_paid));
            return b > 0 ? `<b class="amber">${esc(money(b, lang))}</b>` : `<span class="green">${T('inv2.status.paid')}</span>`;
          } },
        { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'inv2.status', r.status) },
      ], invoices, { emptyMsg: T('a.noData') }) + (balance > 0
        ? `<div class="mt">${linkBtn(T('pay.payInvoice'), `/payments/new?customer_id=${id}`, { ic: 'payments', variant: 'green' })}
           ${linkBtn(T('rec.statement'), `/print/statement/${id}`, { ic: 'print' })}</div>` : ''))}
    </div>
    <div class="grid-1">${card(cardHead(T('cus.history')), table([
      { key: 'order_no', label: T('ord.no'), cell: (r) => `<a href="/orders/${r.id}"><b>${esc(r.order_no)}</b></a>` },
      { key: 'delivery_date', label: T('ord.deliveryDate'), cell: (r) => fmtDate(r.delivery_date, lang) },
      { key: 'mix_code', label: T('a.mix'), cell: (r) => badge(esc(r.mix_code || '—'), 'mix') },
      { key: 'volume_m3', label: T('a.volume'), align: 'right', cell: (r) => `${qty(r.volume_m3)} m³` },
      { key: 'delivered', label: T('dlv.deliveredQty'), align: 'right', cell: (r) => qty(r.delivered) },
      { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => esc(money(r.amount, lang)) },
      { key: 'invoice_no', label: T('inv2.title'), cell: (r) => esc(r.invoice_no || '—') },
      { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'ord.status', r.status) },
    ], orders, { emptyMsg: T('a.noData') }))}</div>`;

  return page(ctx, {
    title: c.name,
    body,
    actions: [
      linkBtn(T('ord.new') + ' →', `/orders/new?customer_id=${id}`, { ic: 'plus', variant: 'primary' }),
      linkBtn(T('a.edit'), `/customers/${id}/edit`, { ic: 'edit' }),
      linkBtn(T('a.back'), '/customers', { ic: 'back' }),
    ].join(''),
  });
}
const statBlock = (label, value, tone = '') =>
  `<div class="stat ${tone}"><div class="stat-top"><span class="stat-label">${label}</span></div><div class="stat-value">${value}</div></div>`;
