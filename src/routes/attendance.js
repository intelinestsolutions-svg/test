import { all, get, run, tx } from '../db.js';
import { redirect, html, today, num, str, int } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, qty, fmtDate,
  field, alert, linkBtn, submitBtn, toolbar,
} from '../lib/html.js';
import { round2 } from '../lib/biz.js';

const STATUSES = ['present', 'late', 'absent', 'leave', 'rest'];

export const attendanceRoutes = [
  {
    method: 'GET', path: '/attendance', role: ['admin'], handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const date = ctx.query.date || today();
      const month = date.slice(0, 7);

      const staff = all(`SELECT * FROM staff WHERE status != 'resigned' ORDER BY role, name`);
      const att = all('SELECT * FROM attendance WHERE work_date = ?', date);
      const byId = Object.fromEntries(att.map((a) => [a.staff_id, a]));
      const dow = new Date(`${date}T00:00:00`).getDay();

      const rows = staff.map((s) => ({ ...s, a: byId[s.id] || null }));

      const mRows = all(`SELECT s.id, s.name, s.role, s.emp_no,
          SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN a.status='leave' THEN 1 ELSE 0 END) AS leave_d,
          SUM(CASE WHEN a.status='absent' THEN 1 ELSE 0 END) AS absent
        FROM staff s LEFT JOIN attendance a ON a.staff_id = s.id AND a.work_date LIKE ?
        WHERE s.status != 'resigned' GROUP BY s.id ORDER BY s.role, s.name`, month + '%');

      const dayCard = card(
        cardHead(`${T('att.title')} · ${fmtDate(date, lang)}`, `<form method="post" action="/attendance/markall" class="inline-form">
            <input type="hidden" name="date" value="${esc(date)}">
            <button class="btn btn-link" type="submit">${esc(T('att.markAll'))}</button></form>`),
        table([
          { key: 'emp_no', label: T('stf.empNo'), cell: (r) => esc(r.emp_no || '—') },
          { key: 'name', label: T('a.name'), cell: (r) => `<a href="/staff/${r.id}"><b>${esc(r.name)}</b></a>` },
          { key: 'role', label: T('a.role'), cell: (r) => `<span class="tiny">${esc(T('stf.role.' + r.role))}</span>` },
          { key: 'st', label: T('a.status'), cell: (r) => {
              const s = r.a?.status || '';
              return s ? badge(esc(T('att.status.' + s)), s === 'present' ? 'ok' : s === 'late' ? 'warn' : s === 'absent' ? 'bad' : 'neutral')
                       : '<span class="muted">—</span>';
            } },
          { key: 'in', label: T('att.in'), cell: (r) => esc(r.a?.in_time || '—') },
          { key: 'out', label: T('att.out'), cell: (r) => esc(r.a?.out_time || '—') },
          {
            key: 'act', label: '', align: 'right', cell: (r) => STATUSES.map((s) => `
              <form method="post" action="/attendance" class="inline-form">
                <input type="hidden" name="staff_id" value="${r.id}">
                <input type="hidden" name="work_date" value="${esc(date)}">
                <input type="hidden" name="status" value="${s}">
                <button class="btn ${r.a?.status === s ? 'btn-primary' : 'btn-ghost'} xs" type="submit">${esc(T('att.status.' + s).slice(0, 3))}</button>
              </form>`).join(''),
          },
        ], rows, { emptyMsg: T('a.noDataHint') })
      );

      const monthCard = card(cardHead(`${T('a.summary')} · ${esc(month)}`), table([
        { key: 'name', label: T('a.name') },
        { key: 'present', label: T('att.presentDays'), align: 'right', cell: (r) => `<b class="green">${num(r.present)}</b>` },
        { key: 'leave_d', label: T('att.leaveDays'), align: 'right', cell: (r) => num(r.leave_d) },
        { key: 'absent', label: T('att.status.absent'), align: 'right', cell: (r) => num(r.absent) ? `<b class="neg">${num(r.absent)}</b>` : '0' },
      ], mRows, { emptyMsg: T('a.noData') }));

      return html(ctx.res, page(ctx, {
        title: T('att.title'),
        body: `
          <div class="date-bar"><form method="get" action="/attendance">
            <a class="btn btn-ghost" href="/attendance?date=${shift(date, -1)}">‹</a>
            <input type="date" name="date" value="${esc(date)}" onchange="this.form.submit()">
            <a class="btn btn-ghost" href="/attendance?date=${shift(date, 1)}">›</a>
            <a class="btn btn-ghost" href="/attendance">${T('a.today')}</a>
            <span class="tiny muted">${['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'][dow] || ''}</span>
          </form></div>
          ${dayCard}
          <div class="grid-1">${monthCard}</div>
          ${linkBtn(T('pay.title'), `/payroll?month=${month}`, { ic: 'payroll' })}`,
      }));
    },
  },
  {
    method: 'POST', path: '/attendance', handler(ctx) {
      const staffId = int(ctx.body.staff_id);
      const date = str(ctx.body.work_date) || today();
      const status = STATUSES.includes(str(ctx.body.status)) ? str(ctx.body.status) : 'present';
      run(`INSERT INTO attendance (staff_id, work_date, in_time, out_time, status, note)
           VALUES (?,?,?,?,?,'')
           ON CONFLICT(staff_id, work_date) DO UPDATE SET status = excluded.status,
             in_time = COALESCE(NULLIF(excluded.in_time,''), attendance.in_time),
             out_time = COALESCE(NULLIF(excluded.out_time,''), attendance.out_time)`,
        staffId, date, str(ctx.body.in_time), str(ctx.body.out_time), status);
      return { __redirect: str(ctx.body.back) || `/attendance?date=${date}` };
    },
  },
  {
    method: 'POST', path: '/attendance/markall', handler(ctx) {
      const date = str(ctx.body.date) || today();
      const staff = all(`SELECT id FROM staff WHERE status = 'active'`);
      const t = new Date().toTimeString().slice(0, 5);
      tx(() => {
        for (const s of staff) {
          run(`INSERT INTO attendance (staff_id, work_date, in_time, status, note) VALUES (?,?,?,'present','')
               ON CONFLICT(staff_id, work_date) DO UPDATE SET in_time = excluded.in_time`, s.id, date, t);
        }
      });
      return { __redirect: `/attendance?date=${date}` };
    },
  },
];

function shift(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
