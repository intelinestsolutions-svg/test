/**
 * Printable documents: delivery note, invoice, receipt, statement, payslip,
 * order confirmation and purchase order. Each is a standalone A5/A4 sheet
 * that the browser can print straight away (Ctrl/Cmd + P).
 */
import { all, get } from '../db.js';
import { html, today, num, str, int, daysBetween, monthStart } from '../lib/http.js';
import { page, icon, esc, money, qty, fmtDate } from '../lib/html.js';
import { round2, mixByCode, payrollForMonth } from '../lib/biz.js';

/* Logo syarikat untuk kepala dokumen. Fail logo asal TIDAK diubah -
   ia cuma dipaparkan dengan saiz tetap (tinggi tetap, lebar auto) supaya
   nisbah asalnya kekal dan tidak herot semasa cetakan. */
const docLogo = (s) => `<img class="doc-logo" src="/img/kotamix-logo.png" alt="${String(s.company_name || 'Kotamix Concrete').replace(/"/g, '&quot;')}">`;

export const printRoutes = [
  /* ---------------- DELIVERY NOTE (2-up A5) ---------------- */
  {
    method: 'GET', path: '/print/dn/:id', handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const lang = ctx.lang;
      const id = int(ctx.params.id);
      const t = get(`
        SELECT t.*, o.order_no, o.delivery_date, o.delivery_slot, o.mix_code, o.volume_m3, o.po_ref,
               c.name AS customer, c.company, c.phone, c.code AS ccode, c.billing_address,
               (SELECT name FROM sites WHERE id = o.site_id) AS site_name,
               (SELECT address FROM sites WHERE id = o.site_id) AS site_address,
               (SELECT area FROM sites WHERE id = o.site_id) AS site_area,
               (SELECT access_note FROM sites WHERE id = o.site_id) AS site_access
        FROM trips t JOIN orders o ON o.id = t.order_id JOIN customers c ON c.id = o.customer_id
        WHERE t.id = ?`, id);
      if (!t) return html(ctx.res, notFound(ctx), 404);

      const s = ctx.settings;
      const lorry = t.lorry_id ? get('SELECT * FROM lorries WHERE id = ?', t.lorry_id) : null;
      const driver = t.driver_id ? get('SELECT * FROM staff WHERE id = ?', t.driver_id) : null;
      const mix = mixByCode(t.mix_code);
      const site = [t.site_name, t.site_address].filter(Boolean).join(', ');

      const sheet = (copyLabel, copyClass) => `
        <section class="sheet dn ${copyClass}">
          <div class="dn-strip"></div>
          <div class="doc-top">
            <div>${docLogo(s)}<b class="doc-co">${esc(s.company_name)}</b>
              <div class="tiny">${esc(s.company_reg_no || '')}</div>
              <div class="tiny">${esc(s.company_address || '')}</div>
              <div class="tiny">${esc(s.company_phone || '')} ${esc(s.company_email || '')}</div></div>
            <div class="ta-right">
              <div class="doc-title">${T('doc.deliveryNote')}</div>
              <div class="doc-no">${esc(t.dn_no || t.trip_no)}</div>
              <div class="tiny muted">${copyLabel}</div>
            </div>
          </div>
          <div class="doc-parties">
            <div><span class="lbl">${T('a.customer')}</span><b>${esc(t.customer)}</b>
              ${t.company ? `<div class="tiny">${esc(t.company)}</div>` : ''}
              <div class="tiny">${esc(t.billing_address || '')}</div>
              <div class="tiny">${esc(t.phone || '')}</div></div>
            <div class="ta-right">
              <div><span class="lbl">${T('doc.date')}</span> <b>${fmtDate(t.delivery_date, lang)}</b></div>
              <div><span class="lbl">${T('ord.no')}</span> ${esc(t.order_no)}${t.po_ref ? ` · PO ${esc(t.po_ref)}` : ''}</div>
              <div><span class="lbl">${T('dlv.run')}</span> ${num(t.run_no)}</div>
            </div>
          </div>
          <div class="dn-grid">
            <div><span class="lbl">${T('doc.site')}</span><b>${esc(site || '—')}</b>
              ${t.site_area ? `<div class="tiny">${esc(t.site_area)}</div>` : ''}
              ${t.site_access ? `<div class="tiny muted">${esc(t.site_access)}</div>` : ''}</div>
            <div><span class="lbl">${T('doc.mixDesign')}</span><b>${esc(t.mix_code || '—')}</b>
              ${mix?.grade_mpa ? `<div class="tiny">${qty(mix.grade_mpa, 0)} MPa · slump ${mix.slump_mm ?? '—'} mm</div>` : ''}</div>
            <div><span class="lbl">${T('a.lorry')}</span><b>${esc(lorry?.code || '—')}</b> <span class="tiny">${esc(lorry?.reg_no || '')}</span></div>
            <div><span class="lbl">${T('doc.driversName')}</span><b>${esc(driver?.name || '—')}</b>
              ${driver?.phone ? `<div class="tiny">${esc(driver.phone)}</div>` : ''}</div>
          </div>
          <table class="tbl doc-tbl">
            <thead><tr>
              <th>${T('a.description')}</th>
              <th class="ta-right">${T('a.qty')}</th>
              <th class="ta-right">${T('a.unit')}</th>
              <th class="ta-right">${T('dlv.deliveredQty')}</th>
            </tr></thead>
            <tbody>
              <tr><td>${T('doc.mixDesign')} ${esc(t.mix_code || '')}</td>
                <td class="ta-right"><b>${qty(t.batch_m3)}</b></td>
                <td class="ta-right">m³</td>
                <td class="ta-right"><span class="write-in"></span></td></tr>
              <tr class="h-sm"><td>${T('inv.issue')} / ${T('doc.remarks')}</td>
                <td class="ta-right"></td><td class="ta-right"></td>
                <td class="ta-right"></td></tr>
            </tbody>
          </table>
          <table class="dn-times">
            <tbody>
              <tr><th>${T('dlv.loadTime')}</th><td></td>
                  <th>${T('dlv.departTime')}</th><td></td></tr>
              <tr><th>${T('dlv.arriveTime')}</th><td></td>
                  <th>${T('dlv.returnTime')}</th><td></td></tr>
              <tr><th>${T('dlv.slump')}</th><td></td>
                  <th>${T('dlv.receiver')}</th><td></td></tr>
            </tbody>
          </table>
          <div class="doc-foot">
            <div class="tiny">${T('doc.thankYou')} · ${esc(s.company_name)}</div>
            <div class="ps-sign">
              <div>${T('doc.signedByCustomer')}<div class="sign-line"></div></div>
              <div>${T('doc.signedByDriver')}<div class="sign-line"></div></div>
            </div>
          </div>
        </section>`;

      const body = `<div class="print-sheets a5-2up">
          ${sheet(T('doc.original'), 'copy-original')}
          ${sheet(T('doc.driverCopy'), 'copy-driver')}
        </div>`;
      return html(ctx.res, page(ctx, {
        title: `${T('doc.deliveryNote')} ${t.dn_no || t.trip_no}`,
        body, back: `/deliveries/${id}`, cls: 'print-a5',
      }));
    },
  },

  /* ---------------- INVOICE (A4) ---------------- */
  {
    method: 'GET', path: '/print/invoice/:id', handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const lang = ctx.lang;
      const id = int(ctx.params.id);
      const s = ctx.settings;
      const inv = get(`SELECT i.*, c.name AS customer, c.code AS ccode, c.company, c.phone, c.email, c.area, c.billing_address
                       FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`, id);
      if (!inv) return html(ctx.res, notFound(ctx), 404);
      const order = inv.order_id ? get('SELECT * FROM orders WHERE id = ?', inv.order_id) : null;
      const site = order?.site_id ? get('SELECT * FROM sites WHERE id = ?', order.site_id) : null;
      const trips = order ? all(`SELECT trip_no, dn_no, batch_m3, delivered_m3 FROM trips
                                 WHERE order_id = ? AND status IN ('delivered','returned') ORDER BY run_no`, order.id) : [];
      const pays = all(`SELECT * FROM payments WHERE invoice_id = ? AND status = 'confirmed' ORDER BY paid_at`, id);
      const bal = round2(num(inv.amount) - num(inv.amount_paid));
      const terms = inv.due_date ? daysBetween(inv.issue_date, inv.due_date) : num(s.default_payment_terms, 0);
      const net = round2(num(inv.amount) - num(inv.sst_amount));

      const body = `<div class="print-sheets a4">
        <section class="sheet invoice">
          <div class="doc-top">
            <div>${docLogo(s)}<b class="doc-co">${esc(s.company_name)}</b>
              <div class="tiny">${[s.company_reg_no, s.company_sst_no].filter(Boolean).map(esc).join(' · ')}</div>
              <div class="tiny">${esc(s.company_address || '')}</div>
              <div class="tiny">${esc(s.company_phone || '')} ${esc(s.company_email || '')}</div></div>
            <div class="ta-right"><div class="doc-title">${T('doc.invoice')}</div>
              <div class="doc-no">${esc(inv.invoice_no)}</div>
              <div class="tiny muted">${T('doc.original')}</div></div>
          </div>
          <div class="doc-parties">
            <div><span class="lbl">${T('a.customer')}</span><b>${esc(inv.customer)}</b>
              ${inv.company ? `<div class="tiny">${esc(inv.company)}</div>` : ''}
              <div class="tiny">${esc(inv.billing_address || inv.area || '')}</div>
              <div class="tiny">${esc(inv.phone || '')} ${esc(inv.email || '')}</div></div>
            <div class="ta-right">
              <div><span class="lbl">${T('inv2.issueDate')}</span> ${fmtDate(inv.issue_date, lang)}</div>
              <div><span class="lbl">${T('inv2.dueDate')}</span> <b>${fmtDate(inv.due_date, lang)}</b></div>
              <div class="tiny muted">${T('inv2.termNote')} ${num(terms)} ${T('inv2.days')}</div>
            </div>
          </div>
          <table class="tbl doc-tbl">
            <thead><tr>
              <th style="width:2rem">#</th><th>${T('a.description')}</th>
              <th class="ta-right">${T('a.qty')}</th><th class="ta-right">${T('a.price')}</th>
              <th class="ta-right">${T('a.total')}</th>
            </tr></thead>
            <tbody>
              <tr>
                <td>1</td>
                <td><b>${T('a.mix')} ${esc(order?.mix_code || '')}</b> — ${T('a.volume')}
                  ${order ? `<div class="tiny muted">${T('ord.no')} ${esc(order.order_no)} · ${fmtDate(order.delivery_date, lang)}${
                    site ? ` · ${T('doc.site')}: ${esc(site.name || site.address || '')}` : ''}</div>` : ''}
                  ${inv.note ? `<div class="tiny muted">${esc(inv.note)}</div>` : ''}</td>
                <td class="ta-right">${order ? `${qty(order.volume_m3)} m³` : '1'}</td>
                <td class="ta-right">${order ? esc(money(order.unit_price, lang)) : esc(money(inv.amount, lang))}</td>
                <td class="ta-right"><b>${esc(money(order ? order.amount - order.sst_amount : net, lang))}</b></td>
              </tr>
              ${trips.map((t, i) => `<tr class="sub-row">
                <td></td><td class="tiny muted">${T('dlv.ticket')} ${esc(t.dn_no || t.trip_no)} · ${fmtDate(order.delivery_date, lang)}</td>
                <td class="ta-right tiny">${qty(t.delivered_m3)} m³</td><td></td><td></td></tr>`).join('')}
              ${num(order?.delivery_charge) ? `<tr><td>2</td><td>${T('a.delivery')}</td><td class="ta-right">1</td>
                <td class="ta-right">${esc(money(order.delivery_charge, lang))}</td>
                <td class="ta-right">${esc(money(order.delivery_charge, lang))}</td></tr>` : ''}
            </tbody>
          </table>
          <div class="doc-total">
            <div><span>${T('a.subtotal')}</span><b>${esc(money(net, lang))}</b></div>
            ${num(inv.sst_amount) ? `<div><span>${T('a.tax')} (SST)</span><b>${esc(money(inv.sst_amount, lang))}</b></div>` : ''}
            <div class="grand"><span>${T('a.total')}</span><b>${esc(money(inv.amount, lang))}</b></div>
            <div><span>${T('a.paid')}</span><b class="green">${esc(money(inv.amount_paid, lang))}</b></div>
            <div class="grand"><span>${T('a.balance')}</span><b class="${bal > 0 ? 'amber' : 'green'}">${esc(money(bal, lang))}</b></div>
          </div>
          ${pays.length ? `<table class="tbl doc-tbl mt"><thead><tr>
              <th>${T('pay.paidAt')}</th><th>${T('pay.method')}</th><th>${T('pay.refNo')}</th>
              <th class="ta-right">${T('a.amount')}</th></tr></thead>
            <tbody>${pays.map((p) => `<tr><td>${fmtDate(p.paid_at, lang)}</td>
              <td>${esc(T('pay.method.' + p.method))}${p.method_detail ? ` <span class="tiny muted">${esc(p.method_detail)}</span>` : ''}</td>
              <td class="tiny">${esc(p.ref_no || p.receipt_no || '')}</td>
              <td class="ta-right">${esc(money(p.amount, lang))}</td></tr>`).join('')}</tbody></table>` : ''}
          ${num(inv.sst_amount) ? `<p class="tiny muted">${T('inv2.sstNote')}</p>` : ''}
          <div class="doc-foot">
            <div>
              <p class="tiny">${T('a.total')}: <b>${esc(money(inv.amount, lang))}</b> — ${T('doc.thankYou')}</p>
              <p class="words tiny">${T('a.amount')}: <b>${esc(numberToWords(Math.round(num(inv.amount))))}</b> ringgit sahaja</p>
              ${s.bank_name ? `<p class="tiny"><b>${esc(s.bank_name)}</b><br>${esc(s.bank_account)}</p>` : ''}
            </div>
            <div class="ps-sign">
              <div>${T('doc.witnessedBy')}<div class="sign-line"></div></div>
              <div>${T('doc.signedByCustomer')}<div class="sign-line"></div></div>
            </div>
          </div>
        </section></div>`;

      return html(ctx.res, page(ctx, {
        title: `${T('doc.invoice')} ${inv.invoice_no}`,
        body, back: `/invoices/${id}`, cls: 'print-a4',
      }));
    },
  },

  /* ---------------- PAYMENT RECEIPT ---------------- */
  {
    method: 'GET', path: '/print/receipt/:id', handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const lang = ctx.lang;
      const id = int(ctx.params.id);
      const s = ctx.settings;
      const p = get(`SELECT p.*, c.name AS customer, c.phone, c.billing_address, i.invoice_no, u.name AS by_name
                     FROM payments p JOIN customers c ON c.id = p.customer_id
                     LEFT JOIN invoices i ON i.id = p.invoice_id
                     LEFT JOIN users u ON u.id = p.received_by WHERE p.id = ?`, id);
      if (!p) return html(ctx.res, notFound(ctx), 404);
      const inv = p.invoice_id ? get('SELECT * FROM invoices WHERE id = ?', p.invoice_id) : null;
      const bal = inv ? round2(num(inv.amount) - num(inv.amount_paid)) : 0;
      const inWords = numberToWords(Math.round(num(p.amount)));

      const body = `<div class="print-sheets a5">
        <section class="sheet receipt">
          <div class="doc-top">
            <div>${docLogo(s)}<b class="doc-co">${esc(s.company_name)}</b>
              <div class="tiny">${esc(s.company_reg_no || '')}</div>
              <div class="tiny">${esc(s.company_address || '')}</div>
              <div class="tiny">${esc(s.company_phone || '')}</div></div>
            <div class="ta-right"><div class="doc-title">${T('doc.receipt')}</div>
              <div class="doc-no">${esc(p.receipt_no || p.payment_no)}</div></div>
          </div>
          <div class="doc-parties">
            <div><span class="lbl">${T('a.customer')}</span><b>${esc(p.customer)}</b>
              <div class="tiny">${esc(p.billing_address || '')}</div>
              <div class="tiny">${esc(p.phone || '')}</div></div>
            <div class="ta-right">
              <div><span class="lbl">${T('pay.paidAt')}</span> <b>${fmtDate(p.paid_at, lang)}</b></div>
              <div><span class="lbl">${T('pay.method')}</span> <b>${esc(T('pay.method.' + p.method))}</b>
                ${p.method_detail ? ` <span class="tiny">${esc(p.method_detail)}</span>` : ''}</div>
              ${p.ref_no ? `<div class="tiny">${T('pay.refNo')}: ${esc(p.ref_no)}</div>` : ''}
              ${p.by_name ? `<div class="tiny muted">${T('pay.receivedBy')}: ${esc(p.by_name)}</div>` : ''}
            </div>
          </div>
          <table class="tbl doc-tbl"><tbody>
            ${inv ? `<tr><td>${T('inv2.title')} <b>${esc(inv.invoice_no)}</b></td>
              <td class="ta-right">${esc(money(inv.amount, lang))}</td></tr>` : ''}
            <tr class="grand-row"><td class="ta-right">${T('a.paid')}</td>
              <td class="ta-right"><b class="green">${esc(money(p.amount, lang))}</b></td></tr>
            ${inv ? `<tr><td>${T('a.balance')}</td><td class="ta-right"><b>${esc(money(bal, lang))}</b></td></tr>` : ''}
          </tbody></table>
          <div class="words tiny">${T('a.amount')}: <b>${esc(inWords)}</b> ringgit sahaja</div>
          ${p.note ? `<div class="tiny muted">${T('a.note')}: ${esc(p.note)}</div>` : ''}
          <div class="doc-foot">
            <div class="tiny">${T('a.total')}: ${esc(money(p.amount, lang))} — ${T('doc.thankYou')}</div>
            <div class="ps-sign"><div>${T('pay.receivedBy')}<div class="sign-line"></div></div></div>
          </div>
        </section></div>`;

      return html(ctx.res, page(ctx, {
        title: `${T('doc.receipt')} ${p.receipt_no || p.payment_no}`,
        body, back: `/payments/${id}`, cls: 'print-a5',
      }));
    },
  },

  /* ---------------- STATEMENT OF ACCOUNT ---------------- */
  {
    method: 'GET', path: '/print/statement/:id', handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const lang = ctx.lang;
      const id = int(ctx.params.id);
      const s = ctx.settings;
      const c = get('SELECT * FROM customers WHERE id = ?', id);
      if (!c) return html(ctx.res, notFound(ctx), 404);

      const invs = all(`SELECT * FROM invoices WHERE customer_id = ? AND status != 'cancelled'
                        ORDER BY issue_date, id`, id);
      const pays = all(`SELECT * FROM payments WHERE customer_id = ? AND status = 'confirmed'
                        ORDER BY paid_at, id`, id);
      const totalBilled = round2(invs.reduce((a, x) => a + num(x.amount), 0));
      const totalPaid = round2(pays.reduce((a, x) => a + num(x.amount), 0));
      const bal = round2(totalBilled - totalPaid);

      // Running statement rows
      const rows = [];
      let bal0 = 0;
      for (const i of invs) {
        bal0 = round2(bal0 + num(i.amount));
        rows.push({ date: i.issue_date, no: i.invoice_no, desc: T('a.invoice'), debit: round2(num(i.amount)), credit: 0, bal: bal0, due: i.due_date });
      }
      for (const p of pays) {
        bal0 = round2(bal0 - num(p.amount));
        rows.push({ date: p.paid_at, no: p.receipt_no || p.payment_no, desc: `${T('a.payment')} · ${T('pay.method.' + p.method)}`, debit: 0, credit: round2(num(p.amount)), bal: bal0, due: null });
      }
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      const body = `<div class="print-sheets a4">
        <section class="sheet statement">
          <div class="doc-top">
            <div>${docLogo(s)}<b class="doc-co">${esc(s.company_name)}</b>
              <div class="tiny">${esc(s.company_reg_no || '')}</div>
              <div class="tiny">${esc(s.company_address || '')}</div>
              <div class="tiny">${esc(s.company_phone || '')} ${esc(s.company_email || '')}</div></div>
            <div class="ta-right"><div class="doc-title">${T('doc.statement')}</div>
              <div class="tiny">${fmtDate(today(), lang)}</div></div>
          </div>
          <div class="doc-parties">
            <div><span class="lbl">${T('a.customer')}</span><b>${esc(c.name)}</b>
              ${c.company ? `<div class="tiny">${esc(c.company)}</div>` : ''}
              <div class="tiny">${esc(c.billing_address || c.area || '')}</div>
              <div class="tiny">${esc(c.phone || '')} ${esc(c.email || '')}</div></div>
            <div class="ta-right">
              <div><span class="lbl">${T('a.code')}</span> ${esc(c.code || '—')}</div>
              <div><span class="lbl">${T('inv2.termNote')}</span> ${num(c.payment_terms_days)} ${T('inv2.days')}</div>
              <div class="tiny muted">${T('inv2.termNote')}: ${fmtDate(today(), lang)}</div>
            </div>
          </div>
          <table class="tbl doc-tbl">
            <thead><tr><th>${T('doc.date')}</th><th>${T('a.reference')}</th><th>${T('a.description')}</th>
              <th class="ta-right">${T('a.debit')}</th><th class="ta-right">${T('a.credit')}</th>
              <th class="ta-right">${T('a.balance')}</th></tr></thead>
            <tbody>${rows.map((r) => `<tr>
              <td>${fmtDate(r.date, lang)}</td><td>${esc(r.no)}</td><td>${esc(r.desc)}</td>
              <td class="ta-right">${r.debit ? esc(money(r.debit, lang)) : '—'}</td>
              <td class="ta-right">${r.credit ? esc(money(r.credit, lang)) : '—'}</td>
              <td class="ta-right"><b>${esc(money(r.bal, lang))}</b></td></tr>`).join('')}</tbody>
          </table>
          <div class="doc-total">
            <div><span>${T('a.debit')} ${T('a.total')}</span><b>${esc(money(totalBilled, lang))}</b></div>
            <div><span>${T('a.credit')} ${T('a.total')}</span><b>${esc(money(totalPaid, lang))}</b></div>
            <div class="grand"><span>${T('a.balanceDue')}</span><b class="${bal > 0 ? 'amber' : 'green'}">${esc(money(bal, lang))}</b></div>
          </div>
          ${s.bank_name ? `<p class="tiny">${T('pay.bankDetails')}: <b>${esc(s.bank_name)}</b> — ${esc(s.bank_account)}</p>` : ''}
          <div class="doc-foot">
            <div class="tiny">${T('doc.thankYou')}</div>
            <div class="ps-sign"><div>${T('a.authorised')}<div class="sign-line"></div></div></div>
          </div>
        </section></div>`;

      return html(ctx.res, page(ctx, {
        title: `${T('doc.statement')} ${c.name}`,
        body, back: `/customers/${id}`, cls: 'print-a4',
      }));
    },
  },

  /* ---------------- PAYSLIP ---------------- */
  {
    method: 'GET', path: '/print/payslip/:id', handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const lang = ctx.lang;
      const s = ctx.settings;
      const month = str(ctx.query.month) || monthStart().slice(0, 7);
      const rows = payrollForMonth(month);
      const me = rows.find((r) => r.staff.id === int(ctx.params.id));
      if (!me) return html(ctx.res, notFound(ctx), 404);
      const st = me.staff;

      const body = `<div class="print-sheets a5">
        <section class="sheet payslip">
          <div class="doc-top">
            <div>${docLogo(s)}<b class="doc-co">${esc(s.company_name)}</b>
              <div class="tiny">${esc(s.company_reg_no || '')}</div>
              <div class="tiny">${esc(s.company_address || '')}</div></div>
            <div class="ta-right"><div class="doc-title">${T('doc.payslip')}</div>
              <div class="doc-no">${month}</div></div>
          </div>
          <div class="doc-parties">
            <div><span class="lbl">${T('a.name')}</span><b>${esc(st.name)}</b>
              <div class="tiny">${esc(st.emp_no || '')} · ${esc(T('stf.role.' + st.role))}</div>
              <div class="tiny">${esc(st.ic_no || '')}</div></div>
            <div class="ta-right">
              <div><span class="lbl">${T('a.period')}</span> ${month}</div>
              <div><span class="lbl">${T('att.daysWorked')}</span> ${num(me.daysWorked)}</div>
              <div><span class="lbl">${T('dlv.tripsDone')}</span> ${num(me.trips)} (${qty(me.m3)} m³)</div>
            </div>
          </div>
          <table class="tbl doc-tbl">
            <thead><tr><th>${T('a.description')}</th><th class="ta-right">${T('a.qty')}</th>
              <th class="ta-right">${T('a.rate')}</th><th class="ta-right">${T('a.amount')}</th></tr></thead>
            <tbody>
              <tr><td>${T('pay.basic')}</td><td class="ta-right">1</td>
                <td class="ta-right">${esc(money(me.basic, lang))}</td><td class="ta-right">${esc(money(me.basic, lang))}</td></tr>
              <tr><td>${T('pay.attendanceAllowance')}</td><td class="ta-right">${num(me.daysWorked)}</td>
                <td class="ta-right">${esc(money(me.attAllow / (me.daysWorked || 1), lang))}</td>
                <td class="ta-right">${esc(money(me.attAllow, lang))}</td></tr>
              <tr><td>${T('pay.tripAllowance')}</td><td class="ta-right">${num(me.trips)}</td>
                <td class="ta-right">${esc(money(me.tripAllow / (me.trips || 1), lang))}</td>
                <td class="ta-right">${esc(money(me.tripAllow, lang))}</td></tr>
              ${me.otNormal ? `<tr><td>${T('pay.otNormal')}</td><td class="ta-right">${num(me.otNormal)} jam</td>
                <td class="ta-right">${esc(money(me.otNormalRate, lang))}</td><td class="ta-right">${esc(money(round2(me.otNormal * me.otNormalRate), lang))}</td></tr>` : ''}
              ${me.otPh ? `<tr><td>${T('pay.otPh')}</td><td class="ta-right">${num(me.otPh)} jam</td>
                <td class="ta-right">${esc(money(me.otPhRate, lang))}</td><td class="ta-right">${esc(money(round2(me.otPh * me.otPhRate), lang))}</td></tr>` : ''}
              ${me.deduction ? `<tr><td>${T('pay.deduction')}</td><td class="ta-right"></td>
                <td class="ta-right"></td><td class="ta-right neg">− ${esc(money(me.deduction, lang))}</td></tr>` : ''}
              <tr><td class="muted">${T('pay.employerShare')}</td><td colspan="3" class="ta-right muted">
                ${T('pay.epf')} ${esc(money(me.epf_er || 0, lang))} · ${T('pay.socso')} ${esc(money(me.socso_er || 0, lang))} · ${T('pay.eis')} ${esc(money(me.eis_er || 0, lang))}</td></tr>
            </tbody>
          </table>
          <div class="doc-total">
            <div><span>${T('a.total')}</span><b>${esc(money(me.gross, lang))}</b></div>
            <div class="grand"><span>${T('a.net')}</span><b class="green">${esc(money(me.net, lang))}</b></div>
          </div>
          <p class="words tiny">${T('a.amount')}: <b>${esc(numberToWords(Math.round(me.net)))}</b> ringgit sahaja</p>
          <div class="doc-foot">
            <div class="tiny muted">${T('doc.printNote')}</div>
            <div class="ps-sign">
              <div>${T('a.name')}<div class="sign-line"></div></div>
              <div>${T('a.approvedBy')}<div class="sign-line"></div></div>
            </div>
          </div>
        </section></div>`;

      return html(ctx.res, page(ctx, {
        title: `${T('doc.payslip')} ${st.name} ${month}`,
        body, back: `/payroll?month=${month}`, cls: 'print-a5',
      }));
    },
  },

  /* ---------------- ORDER CONFIRMATION ---------------- */
  {
    method: 'GET', path: '/print/order/:id', handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const lang = ctx.lang;
      const id = int(ctx.params.id);
      const s = ctx.settings;
      const o = get(`SELECT o.*, c.name AS customer, c.company, c.phone, c.email, c.billing_address, c.code AS ccode, c.area
                     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, id);
      if (!o) return html(ctx.res, notFound(ctx), 404);
      const site = o.site_id ? get('SELECT * FROM sites WHERE id = ?', o.site_id) : null;
      const mix = mixByCode(o.mix_code);
      const trips = all(`SELECT t.*, l.code AS lorry_code, s.name AS driver_name
                         FROM trips t LEFT JOIN lorries l ON l.id = t.lorry_id
                         LEFT JOIN staff s ON s.id = t.driver_id
                         WHERE t.order_id = ? AND t.status != 'void' ORDER BY t.run_no`, id);

      const body = `<div class="print-sheets a4">
        <section class="sheet order">
          <div class="doc-top">
            <div>${docLogo(s)}<b class="doc-co">${esc(s.company_name)}</b>
              <div class="tiny">${esc(s.company_reg_no || '')}</div>
              <div class="tiny">${esc(s.company_address || '')}</div>
              <div class="tiny">${esc(s.company_phone || '')} ${esc(s.company_email || '')}</div></div>
            <div class="ta-right"><div class="doc-title">${T('ord.confirmTitle')}</div>
              <div class="doc-no">${esc(o.order_no)}</div></div>
          </div>
          <div class="doc-parties">
            <div><span class="lbl">${T('a.customer')}</span><b>${esc(o.customer)}</b>
              ${o.company ? `<div class="tiny">${esc(o.company)}</div>` : ''}
              <div class="tiny">${esc(o.billing_address || o.area || '')}</div>
              <div class="tiny">${esc(o.phone || '')} ${esc(o.email || '')}</div></div>
            <div class="ta-right">
              <div><span class="lbl">${T('ord.orderDate')}</span> ${fmtDate(o.order_date, lang)}</div>
              <div><span class="lbl">${T('a.deliveryDate')}</span> <b>${fmtDate(o.delivery_date, lang)}</b></div>
              ${o.po_ref ? `<div class="tiny">PO: ${esc(o.po_ref)}</div>` : ''}
              ${o.requested_by ? `<div class="tiny">${T('ord.requestedBy')}: ${esc(o.requested_by)}</div>` : ''}
            </div>
          </div>
          ${site ? `<div class="doc-ref"><span class="lbl">${T('doc.site')}</span> <b>${esc(site.name || '')}</b>
            <div class="tiny">${esc(site.address || '')}${site.area ? ' · ' + esc(site.area) : ''}</div>
            ${site.access_note ? `<div class="tiny muted">${esc(site.access_note)}</div>` : ''}</div>` : ''}
          <table class="tbl doc-tbl">
            <thead><tr><th>${T('a.description')}</th><th class="ta-right">${T('a.qty')}</th>
              <th class="ta-right">${T('a.price')}</th><th class="ta-right">${T('a.total')}</th></tr></thead>
            <tbody>
              <tr><td><b>${T('a.mix')} ${esc(o.mix_code || '')}</b>
                  ${mix ? `<div class="tiny muted">${qty(mix.grade_mpa, 0)} MPa · slump ${mix.slump_mm ?? '—'} mm · agg ${mix.max_agg_mm ?? '—'} mm</div>` : ''}</td>
                <td class="ta-right">${qty(o.volume_m3)} m³</td>
                <td class="ta-right">${esc(money(o.unit_price, lang))}</td>
                <td class="ta-right">${esc(money(o.volume_m3 * o.unit_price, lang))}</td></tr>
              ${num(o.delivery_charge) ? `<tr><td>${T('a.delivery')}</td><td class="ta-right">1</td>
                <td class="ta-right">${esc(money(o.delivery_charge, lang))}</td>
                <td class="ta-right">${esc(money(o.delivery_charge, lang))}</td></tr>` : ''}
            </tbody>
          </table>
          <div class="doc-total">
            <div><span>${T('a.subtotal')}</span><b>${esc(money(o.subtotal, lang))}</b></div>
            ${num(o.discount) ? `<div><span>${T('a.discount')}</span><b>− ${esc(money(o.discount, lang))}</b></div>` : ''}
            ${num(o.sst_rate) ? `<div><span>${T('a.tax')} ${qty(o.sst_rate)}%</span><b>${esc(money(o.amount - o.subtotal, lang))}</b></div>` : ''}
            <div class="grand"><span>${T('a.total')}</span><b>${esc(money(o.amount, lang))}</b></div>
          </div>
          ${trips.length ? `<table class="tbl doc-tbl mt">
            <thead><tr><th>${T('dlv.ticket')}</th><th>${T('a.lorry')}</th><th>${T('a.driver')}</th>
              <th class="ta-right">${T('dlv.batch')}</th><th class="ta-right">${T('dlv.deliveredQty')}</th></tr></thead>
            <tbody>${trips.map((t) => `<tr><td>${esc(t.dn_no || t.trip_no)}</td>
              <td>${esc(t.lorry_code || '')}</td><td>${esc(t.driver_name || '')}</td>
              <td class="ta-right">${qty(t.batch_m3)}</td>
              <td class="ta-right">${t.status === 'planned' || t.status === 'loading' ? '—' : qty(t.delivered_m3)}</td></tr>`).join('')}</tbody>
          </table>` : ''}
          ${o.note ? `<p class="tiny muted">${T('a.note')}: ${esc(o.note)}</p>` : ''}
          <div class="doc-foot">
            <div class="tiny">${T('ord.signatures')}</div>
            <div class="ps-sign">
              <div>${T('doc.signedByCustomer')}<div class="sign-line"></div></div>
              <div>${T('a.approvedBy')}<div class="sign-line"></div></div>
            </div>
          </div>
        </section></div>`;

      return html(ctx.res, page(ctx, {
        title: `${T('ord.confirmTitle')} ${o.order_no}`,
        body, back: `/orders/${id}`, cls: 'print-a4',
      }));
    },
  },

  /* ---------------- PURCHASE ORDER ---------------- */
  {
    method: 'GET', path: '/print/po/:id', handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const lang = ctx.lang;
      const id = int(ctx.params.id);
      const s = ctx.settings;
      const p = get(`SELECT p.*, s.name AS supplier, s.phone AS supplier_phone, s.email AS supplier_email,
                             s.address AS supplier_address, s.area AS supplier_area
                     FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`, id);
      if (!p) return html(ctx.res, notFound(ctx), 404);
      const lines = all(`SELECT pi.*, i.sku, i.name, i.unit FROM purchase_items pi
                        JOIN items i ON i.id = pi.item_id WHERE pi.purchase_id = ?`, id);

      const body = `<div class="print-sheets a4">
        <section class="sheet po">
          <div class="doc-top">
            <div>${docLogo(s)}<b class="doc-co">${esc(s.company_name)}</b>
              <div class="tiny">${esc(s.company_reg_no || '')}</div>
              <div class="tiny">${esc(s.company_address || '')}</div>
              <div class="tiny">${esc(s.company_phone || '')} ${esc(s.company_email || '')}</div></div>
            <div class="ta-right"><div class="doc-title">${T('pur.purchaseOrder')}</div>
              <div class="doc-no">${esc(p.po_no)}</div>
              <div class="tiny muted">${T('pur.status.' + p.status)}</div></div>
          </div>
          <div class="doc-parties">
            <div><span class="lbl">${T('pur.supplier')}</span><b>${esc(p.supplier)}</b>
              <div class="tiny">${esc(p.supplier_address || '')}</div>
              <div class="tiny">${esc(p.supplier_area || '')}</div>
              <div class="tiny">${esc(p.supplier_phone || '')} ${esc(p.supplier_email || '')}</div></div>
            <div class="ta-right">
              <div><span class="lbl">${T('a.date')}</span> ${fmtDate(p.order_date, lang)}</div>
              ${p.delivery_date ? `<div><span class="lbl">${T('a.deliveryDate')}</span> <b>${fmtDate(p.delivery_date, lang)}</b></div>` : ''}
            </div>
          </div>
          <table class="tbl doc-tbl">
            <thead><tr><th style="width:2rem">#</th><th>${T('inv.sku')}</th><th>${T('a.description')}</th>
              <th class="ta-right">${T('a.qty')}</th><th class="ta-right">${T('a.unit')}</th>
              <th class="ta-right">${T('a.price')}</th><th class="ta-right">${T('a.total')}</th></tr></thead>
            <tbody>${lines.map((l, i) => `<tr>
              <td>${i + 1}</td><td>${esc(l.sku || '')}</td><td><b>${esc(l.name)}</b></td>
              <td class="ta-right">${qty(l.qty)}</td><td class="ta-right">${esc(l.unit)}</td>
              <td class="ta-right">${esc(money(l.unit_cost, lang))}</td>
              <td class="ta-right">${esc(money(num(l.qty) * num(l.unit_cost), lang))}</td></tr>`).join('')}</tbody>
          </table>
          <div class="doc-total">
            <div class="grand"><span>${T('a.total')}</span><b>${esc(money(p.amount, lang))}</b></div>
          </div>
          <p class="words tiny">${T('a.amount')}: <b>${esc(numberToWords(Math.round(num(p.amount))))}</b> ringgit sahaja</p>
          ${p.note ? `<p class="tiny muted">${T('a.note')}: ${esc(p.note)}</p>` : ''}
          <div class="doc-foot">
            <div class="tiny">${T('doc.thankYou')}</div>
            <div class="ps-sign">
              <div>${T('pur.receivedBy')}<div class="sign-line"></div></div>
              <div>${T('a.approvedBy')}<div class="sign-line"></div></div>
            </div>
          </div>
        </section></div>`;

      return html(ctx.res, page(ctx, {
        title: `${T('pur.purchaseOrder')} ${p.po_no}`,
        body, back: `/purchasing/${id}`, cls: 'print-a4',
      }));
    },
  },
];

function notFound(ctx) {
  return page(ctx, {
    title: '404',
    body: `<div class="empty">${icon('box', 26)}<p>${esc(ctx.t('a.noDataHint'))}</p></div>`,
  });
}

/* ---------------- number to words (RM receipts / POs) ---------------- */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function under1000(n) {
  let out = '';
  if (n >= 100) { out += ONES[Math.floor(n / 100)] + ' Hundred'; n %= 100; if (n) out += ' '; }
  if (n >= 20) { out += TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''); }
  else if (n > 0) out += ONES[n];
  return out;
}
function numberToWords(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (n === 0) return 'Zero';
  const groups = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
  let out = '';
  for (const [base, name] of groups) {
    const q = Math.floor(n / base);
    if (q) { out += (out ? ' ' : '') + numberToWords(q) + ' ' + name; n %= base; }
  }
  if (n) out += (out ? ' ' : '') + under1000(n);
  return out;
}
