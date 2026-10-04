import { all, get } from '../db.js';
import { html, num, str, int, today, daysBetween, download, toCsv } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate, statusBadge,
  alert, linkBtn, field, filterBar, toolbar,
} from '../lib/html.js';
import { agingBuckets, customerBalance, round2 } from '../lib/biz.js';

export const receivableRoutes = [
  {
    method: 'GET', path: '/receivables', finance: true, handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const a = agingBuckets(today(), ctx.branchId);
      const buckets = [
        ['rec.current', a.totals.current, ''],
        ['rec.1to30', a.totals.d1, a.totals.d1 > 0 ? 'warn' : ''],
        ['rec.31to60', a.totals.d2, a.totals.d2 > 0 ? 'amber' : ''],
        ['rec.61to90', a.totals.d3, a.totals.d3 > 0 ? 'amber' : ''],
        ['rec.over90', a.totals.d4, a.totals.d4 > 0 ? 'red' : ''],
      ];

      const rb = ctx.bcond('i');
      const byCustomer = all(`
        SELECT c.id, c.code, c.name, c.phone, c.area,
          COALESCE(SUM(i.amount - i.amount_paid),0) AS bal,
          COUNT(*) AS inv_n,
          MIN(i.due_date) AS oldest_due
        FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.status != 'cancelled' AND (i.amount - i.amount_paid) > 0.009${rb ? ` AND ${rb.clause}` : ''}
        GROUP BY c.id ORDER BY bal DESC`, ...(rb ? rb.params : []));
      const grand = round2(byCustomer.reduce((s, r) => s + num(r.bal), 0));

      const allRows = [
        ...a.buckets.current.map((r) => ({ ...r, bucket: 'rec.current' })),
        ...a.buckets.d1.map((r) => ({ ...r, bucket: 'rec.1to30' })),
        ...a.buckets.d2.map((r) => ({ ...r, bucket: 'rec.31to60' })),
        ...a.buckets.d3.map((r) => ({ ...r, bucket: 'rec.61to90' })),
        ...a.buckets.d4.map((r) => ({ ...r, bucket: 'rec.over90' })),
      ].sort((x, y) => y.overdue - x.overdue);

      const body = `
        <div class="aging-bar">
          ${buckets.map(([k, v, tone]) => `<div class="aging-seg ${tone}" style="flex:${Math.max(0.02, num(v))}">
            <div class="as-amt">${esc(money0(v))}</div><div class="as-lbl">${esc(T(k))}</div></div>`).join('')}
        </div>
        <div class="stat-grid">
          ${stat(T('rec.totalOutstanding'), esc(money(a.grand, lang)), a.grand > 0 ? 'amber' : 'green')}
          ${stat(T('rec.current'), esc(money(a.totals.current, lang)))}
          ${stat(T('rec.1to30'), esc(money(a.totals.d1, lang)), a.totals.d1 > 0 ? 'warn' : '')}
          ${stat(T('rec.31to60'), esc(money(a.totals.d2, lang)), a.totals.d2 > 0 ? 'amber' : '')}
          ${stat(T('rec.61to90'), esc(money(a.totals.d3 + a.totals.d4, lang)), (a.totals.d3 + a.totals.d4) > 0 ? 'red' : '')}
        </div>
        <div class="grid-1">${card(
          cardHead(T('rec.byCustomer'), linkBtn(T('a.export'), '/receivables.csv', { ic: 'download' })),
          grand > 0 ? table([
            { key: 'name', label: T('a.customer'), cell: (r) => `<a href="/customers/${r.id}"><b>${esc(r.name)}</b></a>` },
            { key: 'phone', label: T('a.phone'), cell: (r) => r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '—' },
            { key: 'area', label: T('a.area'), cell: (r) => esc(r.area || '—') },
            { key: 'inv_n', label: T('inv2.title'), align: 'right' },
            { key: 'oldest_due', label: T('rec.oldest'), cell: (r) => {
                const d = daysBetween(r.oldest_due, today());
                return `${fmtDate(r.oldest_due, lang)}${d > 0 ? ` <span class="neg tiny">+${d}d</span>` : ''}`;
              } },
            { key: 'bal', label: T('a.balance'), align: 'right', cell: (r) => `<b class="amber">${esc(money(r.bal, lang))}</b>` },
            { key: 'act', label: '', align: 'right', cell: (r) => `
              ${linkBtn(T('a.print'), `/print/statement/${r.id}`, { ic: 'print', cls: 'sm', variant: 'link' })}
              ${r.phone ? linkBtn(T('rec.contactCustomer'), `https://wa.me/60${esc(String(r.phone).replace(/^0/, ''))}`, { ic: 'payments', cls: 'sm' }) : ''}
              ${linkBtn(T('pay.new'), `/payments/new?customer_id=${r.id}`, { ic: 'plus', cls: 'sm', variant: 'green' })}` },
          ], byCustomer) : `<div class="empty">${icon('check', 26)}<p>${T('rec.noOutstanding')}</p></div>`)}
        )}</div>
        <div class="grid-1">${card(cardHead(T('rec.aging')), table([
          { key: 'invoice_no', label: T('inv2.no'), cell: (r) => `<a href="/invoices/${r.id}"><b>${esc(r.invoice_no)}</b></a>` },
          { key: 'cname', label: T('a.customer'), cell: (r) => esc(r.cname) },
          { key: 'due_date', label: T('inv2.dueDate'), cell: (r) => fmtDate(r.due_date, lang) },
          { key: 'overdue', label: T('a.due'), align: 'right', cell: (r) => r.overdue > 0 ? `<b class="neg">+${r.overdue} ${T('inv2.days')}</b>` : `<span class="muted">0</span>` },
          { key: 'bucket', label: T('rec.aging'), cell: (r) => badge(esc(T(r.bucket)), r.overdue > 90 ? 'bad' : r.overdue > 0 ? 'warn' : 'ok') },
          { key: 'bal', label: T('a.balance'), align: 'right', cell: (r) => `<b>${esc(money(r.bal, lang))}</b>` },
        ], allRows, { emptyMsg: T('rec.noOutstanding') }))}</div>`;

      return html(ctx.res, page(ctx, { title: T('rec.title'), body }));
    },
  },
  {
    method: 'GET', path: '/receivables.csv', finance: true, handler(ctx) {
      const a = agingBuckets(today(), ctx.branchId);
      const rows = all(`
        SELECT c.name AS customer, c.phone, i.invoice_no, i.issue_date, i.due_date, i.amount, i.amount_paid,
               (i.amount - i.amount_paid) AS balance
        FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.status != 'cancelled' AND (i.amount - i.amount_paid) > 0.009
        ORDER BY i.due_date`);
      download(ctx.res, toCsv(rows.map((r) => Object.values(r)), Object.keys(rows[0] || { a: 1 })), `receivables-${today()}.csv`);
    },
  },
];

const stat = (label, value, tone = '') =>
  `<div class="stat ${tone}"><div class="stat-top"><span class="stat-label">${label}</span></div><div class="stat-value">${value}</div></div>`;
const money0 = (v) => 'RM ' + Number(v || 0).toLocaleString('en-MY', { maximumFractionDigits: 0 });
