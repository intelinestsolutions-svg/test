import { all, get, run, nextNo, setting } from '../db.js';
import { redirect, html, today, num, str, int, addDays, daysBetween, download, toCsv } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  field, alert, linkBtn, submitBtn, filterBar, toolbar,
} from '../lib/html.js';
import { recalcInvoice, ensureInvoiceForOrder, round2, agingBuckets } from '../lib/biz.js';

const LIMIT = 50;

export const invoiceRoutes = [
  {
    method: 'GET', path: '/invoices', finance: true, handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const q = ctx.query;
      const offset = num(q.offset, 0);
      const where = [];
      const args = [];
      if (q.status) { where.push('i.status = ?'); args.push(q.status); }
      if (q.customer) { where.push('i.customer_id = ?'); args.push(int(q.customer)); }
      if (q.q) { where.push('(i.invoice_no LIKE ? OR c.name LIKE ? OR i.note LIKE ?)'); const s = `%${q.q}%`; args.push(s, s, s); }
      if (q.unpaid) where.push(`(i.amount - i.amount_paid) > 0.009 AND i.status != 'cancelled'`);
      if (q.overdue) { where.push(`(i.amount - i.amount_paid) > 0.009 AND i.due_date < ? AND i.status != 'cancelled'`); args.push(today()); }
      const ib = ctx.bcond('i');
      if (ib) { where.push(ib.clause); args.push(...ib.params); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = all(`
        SELECT i.*, c.name AS customer, c.code AS ccode, c.phone,
          (i.amount - i.amount_paid) AS balance,
          CAST(julianday(?) - julianday(i.due_date) AS INTEGER) AS overdue
        FROM invoices i JOIN customers c ON c.id = i.customer_id ${clause}
        ORDER BY i.issue_date DESC, i.id DESC LIMIT ? OFFSET ?`, today(), ...args, LIMIT, offset);
      const total = num(get(`SELECT COUNT(*) AS n FROM invoices i JOIN customers c ON c.id = i.customer_id ${clause}`, ...args)?.n);
      const sum = get(`SELECT COALESCE(SUM(i.amount),0) AS amt, COALESCE(SUM(i.amount_paid),0) AS paid,
                       COALESCE(SUM(i.amount - i.amount_paid),0) AS bal
                       FROM invoices i JOIN customers c ON c.id = i.customer_id ${clause}`, ...args);
      const customers = all('SELECT id, name FROM customers WHERE active = 1 ORDER BY name');

      const body = `${filterBar(ctx, {
        action: '/invoices',
        fields: [
          field({ label: T('a.search'), name: 'q', value: q.q || '', placeholder: 'INV-2026-0001' }),
          field({ label: T('a.customer'), name: 'customer', value: q.customer || '', options: [{ value: '', label: T('a.all') }, ...customers.map((c) => ({ value: c.id, label: c.name }))] }),
          field({ label: T('a.status'), name: 'status', value: q.status || '', options: [{ value: '', label: T('a.all') }, ...['unpaid', 'partial', 'paid', 'cancelled'].map((s) => ({ value: s, label: ctx.t('inv2.status.' + s) }))] }),
        ].join(''),
      })}
      <div class="quick-filters">
        <a class="btn ${!q.unpaid && !q.overdue ? 'btn-primary' : 'btn-ghost'}" href="/invoices">${T('a.all')}</a>
        <a class="btn ${q.unpaid ? 'btn-primary' : 'btn-ghost'}" href="/invoices?unpaid=1">${T('a.balance')}</a>
        <a class="btn ${q.overdue ? 'btn-primary' : 'btn-ghost'}" href="/invoices?overdue=1">${T('dash.overdue')}</a>
      </div>
      ${toolbar(`<b>${T('a.showing')} ${total}</b> · ${T('a.amount')} <b>${esc(money(sum.amt, lang))}</b> · ${T('a.paid')} <b class="green">${esc(money(sum.paid, lang))}</b> · ${T('a.balance')} <b class="amber">${esc(money(sum.bal, lang))}</b>`,
        linkBtn(T('a.export'), '/invoices.csv', { ic: 'download' }))}
      ${card(table([
        { key: 'invoice_no', label: T('inv2.no'), cell: (r) => `<a href="/invoices/${r.id}"><b>${esc(r.invoice_no)}</b></a>` },
        { key: 'customer', label: T('a.customer'), cell: (r) => `<div class="trunc">${esc(r.customer)}</div>` },
        { key: 'issue_date', label: T('inv2.issueDate'), cell: (r) => fmtDate(r.issue_date, lang) },
        { key: 'due_date', label: T('inv2.dueDate'), cell: (r) => `${fmtDate(r.due_date, lang)}${num(r.overdue) > 0 ? `<div class="sub tiny neg">+${r.overdue}d</div>` : ''}` },
        { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => esc(money(r.amount, lang)) },
        { key: 'amount_paid', label: T('a.paid'), align: 'right', cell: (r) => `<span class="green">${esc(money(r.amount_paid, lang))}</span>` },
        { key: 'balance', label: T('a.balance'), align: 'right', cell: (r) => num(r.balance) > 0 ? `<b class="amber">${esc(money(r.balance, lang))}</b>` : `<span class="muted">0.00</span>` },
        { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'inv2.status', r.status) },
        { key: 'act', label: '', align: 'right', cell: (r) => num(r.balance) > 0
          ? linkBtn(T('pay.payInvoice'), `/payments/new?invoice_id=${r.id}`, { variant: 'green', cls: 'sm' })
          : linkBtn(T('a.print'), `/print/invoice/${r.id}`, { ic: 'print', cls: 'sm', variant: 'link' }) },
      ], rows, { emptyMsg: T('a.noDataHint') }))}`;

      return html(ctx.res, page(ctx, {
        title: T('inv2.title'),
        actions: linkBtn(T('inv2.new'), '/invoices/new', { ic: 'plus', variant: 'primary' }),
        body,
      }));
    },
  },
  {
    method: 'GET', path: '/invoices.csv', finance: true, handler(ctx) {
      const rows = all(`SELECT i.invoice_no, c.name AS customer, i.issue_date, i.due_date, i.amount, i.amount_paid,
                       (i.amount - i.amount_paid) AS balance, i.status FROM invoices i
                       JOIN customers c ON c.id = i.customer_id ORDER BY i.issue_date DESC`);
      download(ctx.res, toCsv(rows.map((r) => Object.values(r)), Object.keys(rows[0] || { a: 1 })), `invoices-${today()}.csv`);
    },
  },
  {
    method: 'GET', path: '/invoices/new', finance: true, handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const customers = all('SELECT * FROM customers WHERE active = 1 ORDER BY name');
      const uninvoiced = get(`SELECT o.id, o.order_no, o.amount, o.delivery_date, c.name AS customer
                              FROM orders o JOIN customers c ON c.id = o.customer_id
                              WHERE o.status NOT IN ('draft','cancelled') AND o.amount > 0
                                AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id)
                              ORDER BY o.delivery_date DESC LIMIT 100`);
      return html(ctx.res, page(ctx, {
        title: T('inv2.new'),
        body: card(`<form method="post" action="/invoices/new" class="form-grid">
          ${field({ label: T('inv2.fromOrder'), name: 'order_id', value: ctx.query.order_id || '', options: [{ value: '', label: '—' }, ...all(`SELECT o.id, o.order_no, c.name AS customer, o.amount FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.amount>0 AND o.status NOT IN ('draft','cancelled') ORDER BY o.delivery_date DESC LIMIT 100`).map((o) => ({ value: o.id, label: `${o.order_no} · ${o.customer} · ${qty(o.amount)}` }))] })}
          ${field({ label: T('a.customer'), name: 'customer_id', value: customers[0]?.id || '', options: customers.map((c) => ({ value: c.id, label: c.name })) })}
          ${field({ label: T('a.amount'), name: 'amount', type: 'number', step: '0.01', value: '', required: true })}
          ${field({ label: T('inv2.issueDate'), name: 'issue_date', type: 'date', value: today(), required: true })}
          ${field({ label: T('inv2.dueDate'), name: 'due_date', type: 'date', value: addDays(today(), 30) })}
          <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2"></textarea></label>
          <div class="form-actions span-2">${submitBtn(T('a.save'), { ic: 'check' })}<a class="btn btn-ghost" href="/invoices">${T('a.cancel')}</a></div>
        </form>`),
        actions: linkBtn(T('a.back'), '/invoices', { ic: 'back' }),
      }));
    },
  },
  {
    method: 'POST', path: '/invoices/new', finance: true, handler(ctx) {
      let amount = num(ctx.body.amount);
      let customerId = int(ctx.body.customer_id);
      let issueDate = str(ctx.body.issue_date) || today();
      let dueDate = str(ctx.body.due_date) || addDays(issueDate, 30);
      const orderId = int(ctx.body.order_id) || null;
      if (orderId) {
        const o = get('SELECT * FROM orders WHERE id = ?', orderId);
        if (o) {
          amount = num(o.amount); customerId = o.customer_id;
          issueDate = today(); dueDate = addDays(o.delivery_date, num(get('SELECT payment_terms_days FROM customers WHERE id = ?', o.customer_id)?.payment_terms_days, 0));
          ensureInvoiceForOrder(orderId);
          ctx.flashMsg(ctx.t('a.saved'));
          return { __redirect: `/invoices/${get('SELECT id FROM invoices WHERE order_id = ?', orderId)?.id}` };
        }
      }
      if (amount <= 0) { ctx.flashMsg(ctx.t('a.amount'), 'err'); return { __redirect: '/invoices/new' }; }
      const r = run(`INSERT INTO invoices (invoice_no, order_id, customer_id, issue_date, due_date, amount, sst_amount, amount_paid, status, note, branch_id)
                     VALUES (?,?,?,?,?,?,?,0,'unpaid',?,?)`,
        nextNo('invoice', setting('invoice_prefix', 'INV')), null, customerId, issueDate, dueDate, amount, 0, str(ctx.body.note), ctx.bv());
      ctx.flashMsg(ctx.t('a.saved'));
      return { __redirect: `/invoices/${r.id}` };
    },
  },
  {
    method: 'GET', path: '/invoices/:id', finance: true, handler(ctx) { return html(ctx.res, invoiceDetail(ctx, int(ctx.params.id))); },
  },
  {
    method: 'POST', path: '/invoices/:id/edit', finance: true, handler(ctx) {
      const id = int(ctx.params.id);
      run(`UPDATE invoices SET customer_id=?, issue_date=?, due_date=?, amount=?, note=? WHERE id=?`,
        int(ctx.body.customer_id), str(ctx.body.issue_date), str(ctx.body.due_date), num(ctx.body.amount), str(ctx.body.note), id);
      recalcInvoice(id);
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: `/invoices/${id}` };
    },
  },
  {
    method: 'POST', path: '/invoices/:id/cancel', finance: true, handler(ctx) {
      const id = int(ctx.params.id);
      const inv = get('SELECT * FROM invoices WHERE id = ?', id);
      if (num(inv?.amount_paid) > 0) { ctx.flashMsg(ctx.t('a.no'), 'err'); return { __redirect: `/invoices/${id}` }; }
      run(`UPDATE invoices SET status = 'cancelled' WHERE id = ?`, id);
      ctx.flashMsg(ctx.t('inv2.status.cancelled'));
      return { __redirect: '/invoices' };
    },
  },
  /* ---- payment link (online) ---- */
  {
    method: 'POST', path: '/invoices/:id/link', finance: true, handler(ctx) {
      const id = int(ctx.params.id);
      const inv = get('SELECT * FROM invoices WHERE id = ?', id);
      if (!inv) return { __redirect: '/invoices' };
      const bal = round2(num(inv.amount) - num(inv.amount_paid));
      const base = ctx.settings.base_url.replace(/\/$/, '');
      const ref = `PL-${inv.invoice_no}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const payUrl = `${base}/pay/${ref}`;
      run(`INSERT INTO online_payments (invoice_id, customer_id, provider, ref, amount, pay_url, status, created_at, branch_id)
           VALUES (?,?,?,?,?,?, 'pending', ?, ?)`, inv.id, inv.customer_id, 'paylink', ref, bal, payUrl, new Date().toISOString(), inv.branch_id ?? ctx.bv());
      ctx.flashMsg(`${ctx.t('pay.payLink')}: ${payUrl}`);
      return { __redirect: `/invoices/${id}` };
    },
  },
];

/* ---------------- detail ---------------- */
function invoiceDetail(ctx, id) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const s = ctx.settings;
  const inv = get(`SELECT i.*, c.name AS customer, c.code AS ccode, c.company, c.phone, c.email, c.area, c.billing_address
                   FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`, id);
  if (!inv) { ctx.flashMsg('404', 'err'); return page(ctx, { title: '404', body: alert('err', 'Not found') }); }
  const order = inv.order_id ? get('SELECT * FROM orders WHERE id = ?', inv.order_id) : null;
  const site = order?.site_id ? get('SELECT * FROM sites WHERE id = ?', order.site_id) : null;
  const pays = all('SELECT p.*, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id = p.received_by WHERE p.invoice_id = ? ORDER BY p.paid_at DESC, p.id DESC', id);
  const links = all(`SELECT * FROM online_payments WHERE invoice_id = ? ORDER BY id DESC LIMIT 10`, id);
  const bal = round2(num(inv.amount) - num(inv.amount_paid));
  const overdue = num(inv.due_date) ? daysBetween(inv.due_date, today()) : 0;

  const terms = num(inv.due_date) ? daysBetween(inv.issue_date, inv.due_date) : 30;

  const docCard = card(`
    <div class="doc">
      <div class="doc-top">
        <div><b class="doc-co">${esc(s.company_name)}</b>
          <div class="tiny muted">${esc(s.company_reg_no || '')}</div>
          <div class="tiny muted">${esc(s.company_address || '')}</div>
          <div class="tiny muted">${esc(s.company_phone || '')} ${esc(s.company_email || '')}</div></div>
        <div class="ta-right"><div class="doc-title">${T('doc.invoice')}</div>
          <div class="doc-no">${esc(inv.invoice_no)}</div></div>
      </div>
      <div class="doc-parties">
        <div><span class="lbl">${T('a.customer')}</span><b>${esc(inv.customer)}</b>${inv.company ? `<div class="tiny">${esc(inv.company)}</div>` : ''}
          <div class="tiny muted">${esc(inv.billing_address || inv.area || '')}</div>
          <div class="tiny muted">${esc(inv.phone || '')}</div></div>
        <div class="ta-right">
          <div><span class="lbl">${T('inv2.issueDate')}</span> ${fmtDate(inv.issue_date, lang)}</div>
          <div><span class="lbl">${T('inv2.dueDate')}</span> ${fmtDate(inv.due_date, lang)}${overdue > 0 && bal > 0 ? ` <span class="neg">(+${overdue}d)</span>` : ''}</div>
          <div class="tiny muted">${T('inv2.termNote')} ${terms} ${T('inv2.days')}</div>
        </div>
      </div>
      ${order ? `<div class="doc-ref tiny muted">${T('ord.no')}: <a href="/orders/${order.id}">${esc(order.order_no)}</a> ·
        ${T('a.date')} ${fmtDate(order.delivery_date, lang)} · ${T('a.mix')} ${esc(order.mix_code || '')} · ${T('a.volume')} ${qty(order.volume_m3)} m³
        ${site ? ` · ${T('doc.site')}: ${esc(site.name || site.address || '')}` : ''}</div>` : ''}
      <table class="tbl doc-tbl">
        <thead><tr><th>${T('a.description')}</th><th class="ta-right">${T('a.qty')}</th><th class="ta-right">${T('a.price')}</th><th class="ta-right">${T('a.total')}</th></tr></thead>
        <tbody><tr>
          <td>${order ? `${T('a.mix')} ${esc(order.mix_code || '')} — ${T('a.volume')}` : T('a.note')}${inv.note ? `<div class="tiny muted">${esc(inv.note)}</div>` : ''}</td>
          <td class="ta-right">${order ? `${qty(order.volume_m3)} m³` : '1'}</td>
          <td class="ta-right">${order ? esc(money(order.unit_price, lang)) : esc(money(inv.amount, lang))}</td>
          <td class="ta-right"><b>${esc(money(inv.amount, lang))}</b></td>
        </tr></tbody>
      </table>
      <div class="doc-total">
        <div><span>${T('a.subtotal')}</span><b>${esc(money(num(inv.amount) - num(inv.sst_amount), lang))}</b></div>
        ${num(inv.sst_amount) ? `<div><span>${T('a.tax')}</span><b>${esc(money(inv.sst_amount, lang))}</b></div>` : ''}
        <div class="grand"><span>${T('a.total')}</span><b>${esc(money(inv.amount, lang))}</b></div>
        <div><span>${T('a.paid')}</span><b class="green">${esc(money(inv.amount_paid, lang))}</b></div>
        <div class="grand"><span>${T('a.balance')}</span><b class="${bal > 0 ? 'amber' : 'green'}">${esc(money(bal, lang))}</b></div>
      </div>
      ${num(inv.sst_amount) ? `<div class="tiny muted">${T('inv2.sstNote')}</div>` : ''}
      <div class="doc-foot">
        <div class="tiny">${T('a.total')}: ${esc(money(bal, lang))} ${T('doc.thankYou')}</div>
        ${s.bank_name ? `<div class="tiny"><b>${esc(s.bank_name)}</b> · ${esc(s.bank_account)}</div>` : ''}
        <div class="ps-sign">
          <div>${T('a.name')}: <div class="sign-line"></div></div>
        </div>
      </div>
    </div>`);

  const payCard = card(cardHead(T('a.paid')), table([
    { key: 'payment_no', label: T('pay.no'), cell: (r) => `<a href="/payments/${r.id}"><b>${esc(r.payment_no)}</b></a>` },
    { key: 'paid_at', label: T('pay.paidAt'), cell: (r) => fmtDate(r.paid_at, lang) },
    { key: 'method', label: T('pay.method'), cell: (r) => badge(esc(T('pay.method.' + r.method)), 'm-' + r.method) },
    { key: 'ref_no', label: T('pay.refNo'), cell: (r) => esc(r.ref_no || '—') },
    { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => `<b>${esc(money(r.amount, lang))}</b>` },
    { key: 'by_name', label: T('pay.receivedBy'), cell: (r) => esc(r.by_name || '—') },
    { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'pay.status', r.status) },
  ], pays, { emptyMsg: T('a.noData') }));

  const linkCard = card(cardHead(T('pay.payLink')), `
    ${links.length ? table([
      { key: 'ref', label: T('a.reference'), cell: (r) => `<span class="tiny">${esc(r.ref)}</span>` },
      { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => esc(money(r.amount, lang)) },
      { key: 'pay_url', label: T('a.no'), cell: (r) => `<a href="${esc(r.pay_url)}" target="_blank" class="tiny">${esc(r.pay_url)}</a>` },
      { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'pay.status', r.status === 'paid' ? 'confirmed' : 'pending') },
      { key: 'act', label: '', align: 'right', cell: (r) => `<button class="btn btn-link sm" type="button" onclick="navigator.clipboard.writeText('${esc(r.pay_url)}');this.textContent='${T('a.copied')}'">${T('a.copy')}</button>` },
    ], links) : `<p class="muted">${T('a.noData')}</p>`}
    ${bal > 0 ? `<div class="mt"><form method="post" action="/invoices/${id}/link"><button class="btn btn-primary" type="submit">${icon('copy', 15)}<span>${T('pay.payLink')}</span></button></form>
      <p class="tiny muted mt">${T('pay.gatewaySetup')}</p></div>` : ''}`);

  const body = `
    <div class="actions-row">
      ${bal > 0 ? linkBtn(T('pay.payInvoice'), `/payments/new?invoice_id=${id}`, { ic: 'payments', variant: 'green' }) : ''}
      ${linkBtn(T('a.print'), `/print/invoice/${id}`, { ic: 'print', variant: 'primary' })}
      ${num(inv.amount_paid) <= 0 && inv.status !== 'cancelled' ? `<form method="post" action="/invoices/${id}/cancel" onsubmit="return confirm('${T('a.confirm')}?')"><button class="btn btn-danger-ghost" type="submit">${T('a.delete')}</button></form>` : ''}
      ${linkBtn(T('a.back'), '/invoices', { ic: 'back' })}
    </div>
    ${overdue > 0 && bal > 0 ? alert('warn', `${T('dash.overdue')}: ${overdue} ${T('inv2.days')} — ${esc(money(bal, lang))}`) : ''}
    <div class="grid-doc">${docCard}<div class="stack">${payCard}${linkCard}</div></div>`;

  return page(ctx, {
    title: inv.invoice_no,
    body,
    actions: linkBtn(T('a.back'), '/invoices', { ic: 'back' }),
  });
}
