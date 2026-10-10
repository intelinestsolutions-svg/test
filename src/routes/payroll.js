import { all, get, run, setting, setSetting } from '../db.js';
import { redirect, html, today, num, str, int } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate,
  field, alert, linkBtn, submitBtn, toolbar,
} from '../lib/html.js';
import { payrollForMonth, allowanceRates, round2 } from '../lib/biz.js';

export const payrollRoutes = [
  {
    method: 'GET', path: '/payroll', role: ['admin'], handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const month = ctx.query.month || today().slice(0, 7);
      const rows = payrollForMonth(month).filter((r) => r.staff.role === 'driver' || r.staff.role === 'mechanic' || r.staff.role === 'lab');
      const a = allowanceRates();

      const totalGross = round2(rows.reduce((s, r) => s + r.gross, 0));
      const totalTrips = rows.reduce((s, r) => s + r.trips, 0);
      const totalM3 = round2(rows.reduce((s, r) => s + r.m3, 0));

      if (ctx.query.staff_id) {
        const r = rows.find((x) => x.staff.id === int(ctx.query.staff_id)) || payrollForMonth(month).find((x) => x.staff.id === int(ctx.query.staff_id));
        if (r) return html(ctx.res, page(ctx, {
          title: `${T('pay.payslip')} · ${esc(r.staff.name)}`,
          body: `
            <div class="date-bar"><form method="get" action="/payroll">
              <input type="month" name="month" value="${esc(month)}" onchange="this.form.submit()">
              <select name="staff_id" onchange="this.form.submit()">${staffSel(ctx, r.staff.id)}</select>
            </form></div>
            ${payslip(ctx, r, month, a)}`,
          actions:
            linkBtn(T('a.print'), `/print/payslip/${r.staff.id}?month=${month}`, { ic: 'print', variant: 'primary' }) +
            linkBtn(T('a.back'), `/payroll?month=${month}`, { ic: 'back' }),
        }));
      }

      const body = `
        <div class="date-bar"><form method="get" action="/payroll">
          <input type="month" name="month" value="${esc(month)}" onchange="this.form.submit()">
          <select name="staff_id" onchange="this.form.submit()">${staffSel(ctx, 0)}</select>
          <a class="btn btn-ghost" href="/payroll">${T('a.thisMonth')}</a>
          <span class="tiny muted">${T('set.driverDaily')}: ${esc(money(a.driverDaily, lang))} · ${T('set.driverTrip')}: ${esc(money(a.driverTrip, lang))}</span>
        </form></div>
        <div class="stat-grid">
          ${stat(T('stf.title'), String(rows.length))}
          ${stat(T('pay.driverTrips'), String(totalTrips))}
          ${stat(T('a.volume'), `${qty(totalM3)} m³`)}
          ${stat(T('pay.gross'), money(totalGross, lang))}
        </div>
        ${card(table([
          { key: 'name', label: T('a.name'), cell: (r) => `<a href="/payroll?month=${month}&staff_id=${r.staff.id}"><b>${esc(r.staff.name)}</b></a><div class="sub tiny">${esc(r.staff.emp_no || '')}</div>` },
          { key: 'daysWorked', label: T('att.presentDays'), align: 'right' },
          { key: 'trips', label: T('pay.driverTrips'), align: 'right' },
          { key: 'm3', label: T('a.volume'), align: 'right', cell: (r) => `${qty(r.m3)} m³` },
          { key: 'basic', label: T('pay.basic'), align: 'right', cell: (r) => esc(money(r.basic, lang)) },
          { key: 'attAllow', label: T('pay.attendanceAllow'), align: 'right', cell: (r) => `${qty(r.daysWorked)} × ${esc(money(a.driverDaily, lang))}<div class="sub tiny">${esc(money(r.attAllow, lang))}</div>` },
          { key: 'tripAllow', label: T('pay.tripAllow'), align: 'right', cell: (r) => `${r.trips} × ${esc(money(a.driverTrip, lang))}<div class="sub tiny">${esc(money(r.tripAllow, lang))}</div>` },
          { key: 'ot', label: T('pay.ot'), align: 'right', cell: (r) => r.otHours ? `${qty(r.otHours)} jam<div class="sub tiny">${esc(money(r.otPay, lang))}</div>` : '—' },
          { key: 'gross', label: T('pay.gross'), align: 'right', cell: (r) => esc(money(r.gross, lang)) },
          { key: 'net', label: T('pay.net'), align: 'right', cell: (r) => `<b class="green">${esc(money(r.net, lang))}</b>` },
          { key: 'act', label: '', align: 'right', cell: (r) => linkBtn(T('a.print'), `/print/payslip/${r.staff.id}?month=${month}`, { ic: 'print', cls: 'sm' }) },
        ], rows, { emptyMsg: T('a.noDataHint') }))}
        <div class="actions-row">${linkBtn(T('a.export'), `/payroll/export.csv?month=${month}`, { ic: 'download' })}${linkBtn(T('set.allowance') + ' →', '/settings', { ic: 'settings' })}</div>`;

      return html(ctx.res, page(ctx, { title: T('pay.title'), body }));
    },
  },
  {
    method: 'GET', path: '/payroll/export.csv', role: ['admin'], handler(ctx) {
      const month = ctx.query.month || today().slice(0, 7);
      const rows = payrollForMonth(month);
      const header = ['Emp No', 'Name', 'Role', 'Days', 'Trips', 'm3', 'Basic', 'AttAllow', 'TripAllow', 'OT Hours', 'OT Pay',
        'SOCSO_EE', 'EIS_EE', 'EPF_EE', 'Total_Deduction', 'Gross', 'Net'];
      const lines = rows.map((r) => [r.staff.emp_no, r.staff.name, r.staff.role, r.daysWorked, r.trips, r.m3,
        r.basic, r.attAllow, r.tripAllow, r.otHours || 0, r.otPay || 0,
        r.socso_ee || 0, r.eis_ee || 0, r.epf_ee || 0, r.deduction, r.gross, r.net]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
      ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="payroll-${month}.csv"` });
      ctx.res.end('﻿' + [header.join(','), ...lines].join('\r\n'));
    },
  },
];

const stat = (label, value, tone = '') =>
  `<div class="stat ${tone}"><div class="stat-top"><span class="stat-label">${label}</span></div><div class="stat-value">${value}</div></div>`;

function payslip(ctx, r, month, a) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const s = ctx.settings;
  const socso = r.socso_ee || 0, eis = r.eis_ee || 0, epf = r.epf_ee || 0;
  return card(`
    <div class="payslip">
      <div class="ps-head">
        <div><img class="doc-logo" src="/img/kotamix-logo.png" alt="Kotamix Concrete"><b>${esc(s.company_name)}</b><div class="tiny muted">${esc(s.company_address || '')}</div></div>
        <div class="ta-right"><b>${T('doc.payslip')}</b><div class="tiny muted">${esc(month)}</div></div>
      </div>
      <table class="tbl kv">
        <tr><th>${T('a.name')}</th><td class="ta-right">${esc(r.staff.name)} (${esc(r.staff.emp_no || '')})</td></tr>
        <tr><th>${T('a.role')}</th><td class="ta-right">${esc(T('stf.role.' + r.staff.role))}</td></tr>
        <tr><th>${T('att.presentDays')}</th><td class="ta-right">${r.daysWorked} ${T('a.records')}</td></tr>
        <tr><th>${T('pay.driverTrips')}</th><td class="ta-right">${r.trips} ${T('dlv.trip').toLowerCase()}</td></tr>
        <tr><th>${T('a.volume')}</th><td class="ta-right">${qty(r.m3)} m³</td></tr>
      </table>
      <table class="tbl kv mt">
        <tr><th>${T('pay.basic')}</th><td class="ta-right">${esc(money(r.basic, lang))}</td></tr>
        <tr><th>${T('pay.attendanceAllow')} (${r.daysWorked} × ${esc(money(a.driverDaily, lang))})</th><td class="ta-right">${esc(money(r.attAllow, lang))}</td></tr>
        <tr><th>${T('pay.tripAllow')} (${r.trips} × ${esc(money(a.driverTrip, lang))})</th><td class="ta-right">${esc(money(r.tripAllow, lang))}</td></tr>
        ${r.otNormal ? `<tr><th>${T('pay.otNormal')} (${qty(r.otNormal)} jam × ${esc(money(r.otNormalRate, lang))})</th><td class="ta-right">${esc(money(round2(r.otNormal * r.otNormalRate), lang))}</td></tr>` : ''}
        ${r.otPh ? `<tr><th>${T('pay.otPh')} (${qty(r.otPh)} jam × ${esc(money(r.otPhRate, lang))})</th><td class="ta-right">${esc(money(round2(r.otPh * r.otPhRate), lang))}</td></tr>` : ''}
        <tr class="big"><th>${T('pay.gross')}</th><td class="ta-right">${esc(money(r.gross, lang))}</td></tr>
        <tr><th colspan="2" class="muted">${T('pay.statutoryDeductions')}</th></tr>
        <tr><th>${T('pay.socso')}</th><td class="ta-right">${esc(money(socso, lang))}</td></tr>
        <tr><th>${T('pay.eis')}</th><td class="ta-right">${esc(money(eis, lang))}</td></tr>
        <tr><th>${T('pay.epf')}</th><td class="ta-right">${esc(money(epf, lang))}</td></tr>
        <tr><th>${T('pay.deduction')}</th><td class="ta-right">${esc(money(r.deduction, lang))}</td></tr>
        <tr class="big"><th>${T('pay.net')}</th><td class="ta-right green">${esc(money(r.net, lang))}</td></tr>
        <tr><th colspan="2" class="muted mt">${T('pay.employerShare')}</th></tr>
        <tr><th>${T('pay.epf')}</th><td class="ta-right">${esc(money(r.epf_er || 0, lang))}</td></tr>
        <tr><th>${T('pay.socso')}</th><td class="ta-right">${esc(money(r.socso_er || 0, lang))}</td></tr>
        <tr><th>${T('pay.eis')}</th><td class="ta-right">${esc(money(r.eis_er || 0, lang))}</td></tr>
        <tr><th>${T('a.total')}</th><td class="ta-right">${esc(money(r.employerCost || 0, lang))}</td></tr>
      </table>
      <div class="ps-sign mt">
        <div>${T('a.name')}: <div class="sign-line"></div></div>
        <div>${T('a.status')}: <div class="sign-line"></div></div>
      </div>
    </div>`);
}

/* Dropdown pilih kakitangan untuk paparan payroll. Kekal nama fail logo
 * terkini; ini hanya pilihan senarai. */
function staffSel(ctx, selectedId) {
  const T = (k) => ctx.t(k);
  const staff = all(`SELECT id, name, emp_no FROM staff WHERE status != 'resigned' ORDER BY role, name`);
  return `<option value="">${esc(T('a.all'))}</option>` + staff.map((s) =>
    `<option value="${s.id}"${s.id === selectedId ? ' selected' : ''}>${esc(s.name)}${s.emp_no ? ` · ${esc(s.emp_no)}` : ''}</option>`).join('');
}
