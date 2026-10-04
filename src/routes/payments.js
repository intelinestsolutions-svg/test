import { all, get, run, tx, nextNo, setting } from '../db.js';
import { redirect, html, today, num, str, int, addDays, daysBetween, download, toCsv } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  field, alert, linkBtn, submitBtn, filterBar, toolbar,
} from '../lib/html.js';
import { recalcInvoice, customerBalance, round2, ensureInvoiceForOrder } from '../lib/biz.js';

const METHODS = ['cash', 'bank', 'online'];
const LIMIT = 60;

export const paymentRoutes = [
  /* ============ LIST ============ */
  {
    method: 'GET', path: '/payments', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const q = ctx.query;
      const offset = num(q.offset, 0);
      const where = [];
      const args = [];
      if (q.method) { where.push('p.method = ?'); args.push(q.method); }
      if (q.customer) { where.push('p.customer_id = ?'); args.push(int(q.customer)); }
      if (q.from) { where.push('p.paid_at >= ?'); args.push(q.from); }
      if (q.to) { where.push('p.paid_at <= ?'); args.push(q.to); }
      if (q.q) { where.push('(p.payment_no LIKE ? OR p.ref_no LIKE ? OR c.name LIKE ?)'); const s = `%${q.q}%`; args.push(s, s, s); }
      if (q.status) { where.push('p.status = ?'); args.push(q.status); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = all(`
        SELECT p.*, c.name AS customer, c.code AS ccode, i.invoice_no, u.name AS by_name
        FROM payments p JOIN customers c ON c.id = p.customer_id
        LEFT JOIN invoices i ON i.id = p.invoice_id
        LEFT JOIN users u ON u.id = p.received_by
        ${clause} ORDER BY p.paid_at DESC, p.id DESC LIMIT ? OFFSET ?`, ...args, LIMIT, offset);
      const total = num(get(`SELECT COUNT(*) AS n FROM payments p JOIN customers c ON c.id = p.customer_id ${clause}`, ...args)?.n);
      const sum = get(`SELECT COALESCE(SUM(CASE WHEN p.status='confirmed' THEN p.amount ELSE 0 END),0) AS amt
                       FROM payments p JOIN customers c ON c.id = p.customer_id ${clause}`, ...args);
      const byMethod = all(`SELECT p.method, COALESCE(SUM(p.amount),0) AS amt, COUNT(*) AS n
                            FROM payments p JOIN customers c ON c.id = p.customer_id
                            ${clause ? clause + ' AND' : 'WHERE'} p.status='confirmed' GROUP BY p.method`, ...args);
      const customers = all('SELECT id, name FROM customers WHERE active = 1 ORDER BY name');

      const body = `${filterBar(ctx, {
        action: '/payments',
        fields: [
          field({ label: T('a.search'), name: 'q', value: q.q || '' }),
          field({ label: T('a.customer'), name: 'customer', value: q.customer || '', options: [{ value: '', label: T('a.all') }, ...customers.map((c) => ({ value: c.id, label: c.name }))] }),
          field({ label: T('pay.method'), name: 'method', value: q.method || '', options: [{ value: '', label: T('a.all') }, ...METHODS.map((m) => ({ value: m, label: T('pay.method.' + m) }))] }),
          field({ label: T('a.date') + ' (dari)', name: 'from', type: 'date', value: q.from || '' }),
          field({ label: T('a.date') + ' (hingga)', name: 'to', type: 'date', value: q.to || '' }),
        ].join(''),
      })}
      ${toolbar(`<b>${T('a.showing')} ${total}</b> · ${T('a.total')} <b class="green">${esc(money(sum.amt, lang))}</b>`,
        linkBtn(T('a.export'), '/payments.csv?' + new URLSearchParams(q), { ic: 'download' }) +
        linkBtn(T('pay.new'), '/payments/new', { ic: 'plus', variant: 'primary' }))}
      ${byMethod.length ? card(cardHead(T('pay.byMethod')), `<div class="method-grid">${byMethod.map((m) => `
        <div class="method-card m-${esc(m.method)}">
          <div class="mc-label">${esc(T('pay.method.' + m.method))}</div>
          <div class="mc-amt">${esc(money(m.amt, lang))}</div>
          <div class="mc-n">${num(m.n)} ${T('a.records')}</div>
        </div>`).join('')}</div>`) : ''}
      ${card(table([
        { key: 'payment_no', label: T('pay.no'), cell: (r) => `<a href="/payments/${r.id}"><b>${esc(r.payment_no)}</b></a>` },
        { key: 'paid_at', label: T('pay.paidAt'), cell: (r) => fmtDate(r.paid_at, lang) },
        { key: 'customer', label: T('a.customer'), cell: (r) => `<a href="/customers/${r.customer_id}"><span class="trunc">${esc(r.customer)}</span></a>` },
        { key: 'invoice_no', label: T('inv2.title'), cell: (r) => r.invoice_id ? `<a href="/invoices/${r.invoice_id}">${esc(r.invoice_no)}</a>` : '—' },
        { key: 'method', label: T('pay.method'), cell: (r) => badge(esc(T('pay.method.' + r.method)), 'm-' + r.method) + (r.method_detail ? `<div class="sub tiny">${esc(r.method_detail)}</div>` : '') },
        { key: 'ref_no', label: T('pay.refNo'), cell: (r) => esc(r.ref_no || '—') },
        { key: 'amount', label: T('a.amount'), align: 'right', cell: (r) => `<b>${esc(money(r.amount, lang))}</b>` },
        { key: 'by_name', label: T('pay.receivedBy'), cell: (r) => esc(r.by_name || '—') },
        { key: 'status', label: T('a.status'), cell: (r) => statusBadge(ctx, 'pay.status', r.status) },
      ], rows, { emptyMsg: T('a.noDataHint') }))}`;

      return html(ctx.res, page(ctx, { title: T('pay.title'), body }));
    },
  },
  {
    method: 'GET', path: '/payments.csv', handler(ctx) {
      const rows = all(`SELECT p.payment_no, p.paid_at, c.name AS customer, i.invoice_no, p.method, p.method_detail,
                       p.ref_no, p.amount, p.note, p.status FROM payments p JOIN customers c ON c.id = p.customer_id
                       LEFT JOIN invoices i ON i.id = p.invoice_id ORDER BY p.paid_at DESC`);
      download(ctx.res, toCsv(rows.map((r) => Object.values(r)), Object.keys(rows[0] || { a: 1 })), `payments-${today()}.csv`);
    },
  },

  /* ============ NEW PAYMENT ============ */
  {
    method: 'GET', path: '/payments/new', handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const lang = ctx.lang;
      const invId = int(ctx.query.invoice_id);
      const custId = int(ctx.query.customer_id) || num(get('SELECT customer_id FROM invoices WHERE id = ?', invId)?.customer_id);
      const inv = invId ? get('SELECT * FROM invoices WHERE id = ?', invId) : null;
      const customers = all('SELECT * FROM customers WHERE active = 1 ORDER BY name');
      const openInvoices = all(`SELECT i.*, c.name AS customer,
            (i.amount - i.amount_paid) AS bal FROM invoices i JOIN customers c ON c.id = i.customer_id
          WHERE i.status != 'cancelled' AND (i.amount - i.amount_paid) > 0.009
          ${custId ? 'AND i.customer_id = ?' : ''} ORDER BY i.due_date`, ...(custId ? [custId] : []));
      const due = inv ? round2(num(inv.amount) - num(inv.amount_paid)) : 0;
      const s = ctx.settings;
      const last = get(`SELECT price_per_litre FROM fuel_logs ORDER BY id DESC LIMIT 1`);

      return html(ctx.res, page(ctx, {
        title: T('pay.new'),
        body: `${s.bank_name ? card(cardHead(T('pay.bankDetails')), `
          <table class="tbl kv"><tr><th>${T('set.bankName')}</th><td class="ta-right"><b>${esc(s.bank_name)}</b></td></tr>
          <tr><th>${T('set.bankAccount')}</th><td class="ta-right"><b>${esc(s.bank_account)}</b>
            <button class="btn btn-link xs" type="button" onclick="navigator.clipboard.writeText('${esc(s.bank_account)}')">${T('a.copy')}</button></td></tr></table>`) : ''}
        ${card(`<form method="post" action="/payments/new" class="form-grid" id="payf">
          ${field({ label: T('a.customer'), name: 'customer_id', value: custId || customers[0]?.id || '', options: customers.map((c) => ({ value: c.id, label: c.name })), required: true, attrs: 'onchange="this.form.submit()"' })}
          ${field({ label: T('inv2.title'), name: 'invoice_id', value: invId || '', options: [{ value: '', label: '— ' + T('a.optional') + ' —' }, ...openInvoices.map((i) => ({ value: i.id, label: `${i.invoice_no} · ${i.customer} · ${T('a.balance')} ${qty(i.bal)}` }))] })}
          ${field({ label: T('a.amount'), name: 'amount', type: 'number', step: '0.01', value: due || '', required: true, cls: 'js-amt' })}
          ${field({ label: T('pay.method'), name: 'method', value: 'cash', options: METHODS.map((m) => ({ value: m, label: T('pay.method.' + m) })), required: true })}
          ${field({ label: T('a.date'), name: 'paid_at', type: 'date', value: today(), required: true })}
          ${field({ label: T('pay.methodDetail'), name: 'method_detail', value: '', placeholder: 'DuitNow / Maybank / Touch n Go' })}
          ${field({ label: T('pay.refNo'), name: 'ref_no', value: '' })}
          <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2"></textarea></label>
          <div class="form-actions span-2">
            ${submitBtn(T('a.save'), { ic: 'check' })}
            <a class="btn btn-ghost" href="/payments">${T('a.cancel')}</a>
          </div>
        </form>`)}
        ${inv ? card(cardHead(T('inv2.title')), `<table class="tbl kv">
            <tr><th>${T('inv2.no')}</th><td class="ta-right"><a href="/invoices/${inv.id}">${esc(inv.invoice_no)}</a></td></tr>
            <tr><th>${T('a.total')}</th><td class="ta-right">${esc(money(inv.amount, lang))}</td></tr>
            <tr><th>${T('a.paid')}</th><td class="ta-right green">${esc(money(inv.amount_paid, lang))}</td></tr>
            <tr class="big"><th>${T('a.balance')}</th><td class="ta-right amber">${esc(money(due, lang))}</td></tr>
          </table>`) : ''}`,
        actions: linkBtn(T('a.back'), '/payments', { ic: 'back' }),
      }));
    },
  },
  {
    method: 'POST', path: '/payments/new', handler(ctx) {
      const customerId = int(ctx.body.customer_id);
      const invoiceId = int(ctx.body.invoice_id) || null;
      const method = METHODS.includes(str(ctx.body.method)) ? str(ctx.body.method) : 'cash';
      let amount = num(ctx.body.amount);
      if (amount <= 0) { ctx.flashMsg(ctx.t('pay.amountRequired'), 'err'); return { __redirect: '/payments/new' }; }
      if (invoiceId) {
        const inv = get('SELECT * FROM invoices WHERE id = ?', invoiceId);
        if (inv && inv.customer_id !== customerId) {
          ctx.flashMsg(T('a.customer'), 'err');
          return { __redirect: '/payments/new' };
        }
      }
      const p = tx(() => {
        const r = run(`INSERT INTO payments (payment_no, receipt_no, customer_id, invoice_id, amount, method,
                         method_detail, ref_no, paid_at, received_by, status, note)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          nextNo('payment', setting('payment_prefix', 'PAY')),
          nextNo('receipt', setting('receipt_prefix', 'RC')),
          customerId, invoiceId, amount, method, str(ctx.body.method_detail), str(ctx.body.ref_no),
          str(ctx.body.paid_at) || today(), ctx.user.id, 'confirmed', str(ctx.body.note));
        if (invoiceId) recalcInvoice(invoiceId);
        return r;
      });
      ctx.flashMsg(`${ctx.t('a.saved')}: ${money(amount, ctx.lang)}`);
      return { __redirect: str(ctx.body.back) || `/payments/${p.id}` };
    },
  },
  {
    method: 'GET', path: '/payments/:id', handler(ctx) { return html(ctx.res, paymentDetail(ctx, int(ctx.params.id))); },
  },
  {
    method: 'POST', path: '/payments/:id/void', handler(ctx) {
      const id = int(ctx.params.id);
      const p = get('SELECT * FROM payments WHERE id = ?', id);
      if (!p) return { __redirect: '/payments' };
      tx(() => {
        run(`UPDATE payments SET status = 'void' WHERE id = ?`, id);
        if (p.invoice_id) recalcInvoice(p.invoice_id);
      });
      ctx.flashMsg(ctx.t('pay.status.void'));
      return { __redirect: `/payments/${id}` };
    },
  },

  /* ============ PUBLIC PAYMENT LINK (customer facing) ============ */
  {
    method: 'GET', path: '/pay/:ref', public: true, handler(ctx) {
      const link = get(`SELECT * FROM online_payments WHERE ref = ?`, ctx.params.ref);
      if (!link) {
        return html(ctx.res, publicPage(ctx, ctx.t('a.notFound')), 404);
      }
      const inv = get(`SELECT i.*, c.name AS customer, c.phone, c.company FROM invoices i
                       JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`, link.invoice_id);
      const s = ctx.settings;
      const base = s.base_url.replace(/\/$/, '');
      return html(ctx.res, `<!doctype html><html lang="${ctx.lang}"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${esc(ctx.t('pay.payLink'))} · ${esc(s.company_name)}</title>
        <link rel="stylesheet" href="/css/app.css"></head>
        <body class="pay-body"><div class="pay-wrap">
          <div class="pay-card">
            <div class="pay-head"><b>${esc(s.company_name)}</b><div class="tiny muted">${esc(s.company_address || '')}</div></div>
            <h1>${esc(ctx.t('pay.payLink'))}</h1>
            <div class="pay-amt">${esc(money(link.amount, ctx.lang))}</div>
            <table class="tbl kv">
              <tr><th>${esc(ctx.t('inv2.no'))}</th><td class="ta-right">${esc(inv?.invoice_no || '—')}</td></tr>
              <tr><th>${esc(ctx.t('a.customer'))}</th><td class="ta-right">${esc(inv?.customer || '—')}</td></tr>
              <tr><th>${esc(ctx.t('a.balance'))}</th><td class="ta-right"><b>${esc(money(round2(num(inv?.amount) - num(inv?.amount_paid)), ctx.lang))}</b></td></tr>
            </table>
            ${s.bank_name ? `<div class="pay-bank">
              <div class="lbl">${esc(ctx.t('pay.bankDetails'))}</div>
              <div class="bank-line"><b>${esc(s.bank_name)}</b></div>
              <div class="bank-acct">${esc(s.bank_account)}</div>
              <button class="btn btn-ghost btn-block" type="button" onclick="navigator.clipboard.writeText('${esc(s.bank_account)}')">${esc(ctx.t('a.copy'))}</button>
            </div>` : ''}
            <form method="post" action="/pay/${esc(link.ref)}" class="pay-form">
              <label class="field"><span class="field-label">${esc(ctx.t('a.name'))}</span><input name="payer" required></label>
              <label class="field"><span class="field-label">${esc(ctx.t('pay.refNo'))}</span><input name="ref_no"></label>
              <button class="btn btn-primary btn-block" type="submit">${esc(ctx.t('pay.markPaid'))}</button>
              <p class="tiny muted">${esc(ctx.t('pay.autoMatched'))}</p>
            </form>
            <p class="tiny muted">${esc(ctx.t('pay.sentTo'))}: ${esc(inv?.phone || '')}</p>
          </div>
        </div></body></html>`);
    },
  },
  {
    method: 'POST', path: '/pay/:ref', public: true, handler(ctx) {
      const link = get(`SELECT * FROM online_payments WHERE ref = ?`, ctx.params.ref);
      if (!link) return redirect(ctx.res, '/');
      const inv = get('SELECT * FROM invoices WHERE id = ?', link.invoice_id);
      if (link.status === 'paid') {
        return html(ctx.res, publicPage(ctx, `${ctx.t('inv2.status.paid')} — ${money(inv?.amount, ctx.lang)}`, true));
      }
      tx(() => {
        run(`UPDATE online_payments SET status = 'paid', paid_at = ? WHERE id = ?`, new Date().toISOString(), link.id);
        run(`INSERT INTO payments (payment_no, receipt_no, customer_id, invoice_id, amount, method, method_detail, ref_no, paid_at, received_by, status, note)
             VALUES (?,?,?,?,?,'online',?,?,?,1,'confirmed',?)`,
          nextNo('payment', setting('payment_prefix', 'PAY')), nextNo('receipt', setting('receipt_prefix', 'RC')),
          link.customer_id, link.invoice_id, link.amount, ctx.t('pay.method.online'), str(ctx.body.ref_no), today(), ctx.t('pay.payLink'));
        recalcInvoice(link.invoice_id);
      });
      return html(ctx.res, publicPage(ctx, `${ctx.t('inv2.status.paid')} — ${money(link.amount, ctx.lang)}`, true));
    },
  },
];

function publicPage(ctx, msg, ok = false) {
  const s = ctx.settings;
  return `<!doctype html><html lang="${ctx.lang}"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(s.company_name)}</title><link rel="stylesheet" href="/css/app.css"></head>
    <body class="pay-body"><div class="pay-wrap"><div class="pay-card center">
      <div class="pay-big">${ok ? '✓' : '✕'}</div>
      <h1>${esc(msg)}</h1>
      <p class="muted">${esc(s.company_name)}${s.company_phone ? ' · ' + esc(s.company_phone) : ''}</p>
    </div></div></body></html>`;
}

function paymentDetail(ctx, id) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const s = ctx.settings;
  const p = get(`SELECT p.*, c.name AS customer, c.phone, c.billing_address, i.invoice_no, u.name AS by_name
                 FROM payments p JOIN customers c ON c.id = p.customer_id
                 LEFT JOIN invoices i ON i.id = p.invoice_id
                 LEFT JOIN users u ON u.id = p.received_by WHERE p.id = ?`, id);
  if (!p) { ctx.flashMsg('404', 'err'); return page(ctx, { title: '404', body: alert('err', 'Not found') }); }
  const inv = p.invoice_id ? get('SELECT * FROM invoices WHERE id = ?', p.invoice_id) : null;
  const bal = inv ? round2(num(inv.amount) - num(inv.amount_paid)) : 0;

  const docCard = card(`
    <div class="doc">
      <div class="doc-top">
        <div><b class="doc-co">${esc(s.company_name)}</b>
          <div class="tiny muted">${esc(s.company_reg_no || '')}</div>
          <div class="tiny muted">${esc(s.company_address || '')}</div>
          <div class="tiny muted">${esc(s.company_phone || '')}</div></div>
        <div class="ta-right"><div class="doc-title">${T('doc.receipt')}</div><div class="doc-no">${esc(p.receipt_no || p.payment_no)}</div></div>
      </div>
      <div class="doc-parties">
        <div><span class="lbl">${T('a.customer')}</span><b>${esc(p.customer)}</b>
          <div class="tiny muted">${esc(p.billing_address || '')}</div>
          <div class="tiny muted">${esc(p.phone || '')}</div></div>
        <div class="ta-right">
          <div><span class="lbl">${T('pay.paidAt')}</span> ${fmtDate(p.paid_at, lang)}</div>
          <div><span class="lbl">${T('pay.method')}</span> ${esc(T('pay.method.' + p.method))}</div>
          ${p.ref_no ? `<div><span class="lbl">${T('pay.refNo')}</span> ${esc(p.ref_no)}</div>` : ''}
        </div>
      </div>
      <table class="tbl doc-tbl"><tbody>
        ${inv ? `<tr><td>${T('inv2.title')} ${esc(inv.invoice_no)}</td><td class="ta-right">${esc(money(inv.amount, lang))}</td></tr>` : ''}
        <tr><td class="ta-right">${T('a.paid')}</td><td class="ta-right"><b class="green">${esc(money(p.amount, lang))}</b></td></tr>
        ${inv ? `<tr><td>${T('a.balance')}</td><td class="ta-right">${esc(money(bal, lang))}</td></tr>` : ''}
      </tbody></table>
      ${p.note ? `<div class="tiny muted">${T('a.note')}: ${esc(p.note)}</div>` : ''}
      <div class="doc-foot"><p class="tiny">${T('a.total')}: ${esc(money(p.amount, lang))} — ${T('doc.thankYou')}</p>
        <div class="ps-sign"><div>${T('a.name')}: <div class="sign-line"></div></div></div></div>
    </div>`);

  const body = `<div class="actions-row">
      ${linkBtn(T('a.print'), `/print/receipt/${id}`, { ic: 'print', variant: 'primary' })}
      ${p.status === 'confirmed' ? `<form method="post" action="/payments/${id}/void" onsubmit="return confirm('${T('a.confirm')}?')"><button class="btn btn-danger-ghost" type="submit">${T('a.delete')}</button></form>` : ''}
      ${linkBtn(T('a.back'), '/payments', { ic: 'back' })}
    </div>
    ${p.status !== 'confirmed' ? alert('warn', T('pay.status.' + p.status)) : ''}
    <div class="grid-doc">${docCard}</div>`;

  return page(ctx, {
    title: p.payment_no,
    body,
    actions: linkBtn(T('a.back'), '/payments', { ic: 'back' }),
  });
}
