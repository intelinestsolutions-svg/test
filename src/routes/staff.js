import { all, get, run, hashPassword, setting, listBranches, getBranch } from '../db.js';
import { redirect, html, today, num, str, int } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate,
  field, alert, linkBtn, submitBtn, filterBar, tabs,
} from '../lib/html.js';
import { round2 } from '../lib/biz.js';

const ROLES = ['driver', 'dispatcher', 'lab', 'mechanic', 'admin'];

export const staffRoutes = [
  {
    method: 'GET', path: '/staff', handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const q = ctx.query;
      const where = [];
      const args = [];
      if (q.q) { where.push('(s.name LIKE ? OR s.emp_no LIKE ? OR s.licence_class LIKE ?)'); const s = `%${q.q}%`; args.push(s, s, s); }
      if (q.role) { where.push('s.role = ?'); args.push(q.role); }
      if (q.status) { where.push('s.status = ?'); args.push(q.status); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = all(`
        SELECT s.*, u.id AS user_id, u.username, u.active AS user_active,
          (SELECT COUNT(*) FROM trips t WHERE t.driver_id = s.id AND t.status IN ('delivered','returned')) AS trips_n,
          (SELECT COALESCE(SUM(t.delivered_m3),0) FROM trips t WHERE t.driver_id = s.id AND t.status IN ('delivered','returned')) AS m3
        FROM staff s LEFT JOIN users u ON u.staff_id = s.id ${clause}
        ORDER BY s.role, s.name`, ...args);

      const soon = addDaysLocal(today(), 60);
      const expiring = rows.filter((r) => r.licence_expiry && r.licence_expiry <= soon);
      const body = `
        ${expiring.length ? alert('warn', `${T('stf.licenceExpiringSoon')}: ` + expiring.map((r) => `${esc(r.name)} (${fmtDate(r.licence_expiry, lang)})`).join(', ')) : ''}
        ${filterBar(ctx, {
          action: '/staff',
          fields: [
            field({ label: T('a.search'), name: 'q', value: q.q || '' }),
            field({ label: T('a.role'), name: 'role', value: q.role || '', options: [{ value: '', label: T('a.all') }, ...ROLES.map((r) => ({ value: r, label: T('stf.role.' + r) }))] }),
            field({ label: T('a.status'), name: 'status', value: q.status || '', options: [{ value: '', label: T('a.all') }, { value: 'active', label: T('stf.status.active') }, { value: 'leave', label: T('stf.status.leave') }, { value: 'resigned', label: T('stf.status.resigned') }] }),
          ].join(''),
        })}
        ${card(table([
          { key: 'emp_no', label: T('stf.empNo'), cell: (r) => esc(r.emp_no || '—') },
          { key: 'name', label: T('a.name'), cell: (r) => `<a href="/staff/${r.id}"><b>${esc(r.name)}</b></a>` },
          { key: 'role', label: T('a.role'), cell: (r) => badge(esc(T('stf.role.' + r.role)), 'role-' + r.role) },
          { key: 'phone', label: T('a.phone'), cell: (r) => r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '—' },
          { key: 'licence', label: T('stf.licence'), cell: (r) => licenceCell(ctx, r) },
          { key: 'salary', label: T('stf.salary'), align: 'right', cell: (r) => esc(money(r.salary, lang)) },
          { key: 'trips_n', label: T('flt.trips'), align: 'right' },
          { key: 'm3', label: T('flt.m3Done'), align: 'right', cell: (r) => `${qty(r.m3)} m³` },
          { key: 'login', label: T('set.users'), cell: (r) => r.user_id
            ? badge(esc(r.username), 'ok')
            : `<span class="muted tiny">${T('stf.noLogin')}</span>` },
          { key: 'status', label: T('a.status'), cell: (r) => badge(esc(T('stf.status.' + r.status)), r.status === 'active' ? 'ok' : r.status === 'leave' ? 'warn' : 'neutral') },
          { key: 'act', label: '', align: 'right', cell: (r) => linkBtn(T('a.edit'), `/staff/${r.id}/edit`, { variant: 'link', cls: 'sm' }) },
        ], rows, { emptyMsg: T('a.noDataHint') }))}`;

      return html(ctx.res, page(ctx, {
        title: T('stf.title'),
        actions: linkBtn(T('stf.new'), '/staff/new', { ic: 'plus', variant: 'primary' }),
        body,
      }));
    },
  },
  {
    method: 'GET', path: '/staff/new', handler(ctx) {
      return html(ctx.res, page(ctx, staffForm(ctx, { role: 'driver', status: 'active', salary: 0 }, null)));
    },
  },
  {
    method: 'POST', path: '/staff/new', handler(ctx) {
      const f = sf(ctx);
      // Cawangan wajib - tanpa ia, kakitangan tidak boleh dikenal pasti.
      if (!f.branch_id) {
        ctx.flashMsg(ctx.t('set.branchRequired'), 'err');
        return { __redirect: '/staff/new' };
      }
      const r = run(`INSERT INTO staff (emp_no, name, role, phone, ic_no, licence_class, licence_expiry, address, salary, join_date, status, note, branch_id, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.emp_no, f.name, f.role, f.phone, f.ic_no, f.licence_class, f.licence_expiry, f.address,
        f.salary, f.join_date, f.status, f.note, f.branch_id, new Date().toISOString());
      // optional login account
      if (str(ctx.body.username)) {
        run(`INSERT INTO users (username, password_hash, name, role, staff_id, branch_id, active, created_at) VALUES (?,?,?,?,?,?,1,?)`,
          str(ctx.body.username).toLowerCase(), hashPassword(str(ctx.body.password) || str(ctx.body.username)),
          f.name, f.role === 'admin' ? 'admin' : f.role === 'driver' ? 'driver' : 'office',
          r.id, f.branch_id, new Date().toISOString());
      }
      ctx.flashMsg(`${ctx.t('a.saved')}: ${f.name}`);
      return { __redirect: `/staff/${r.id}` };
    },
  },
  {
    method: 'GET', path: '/staff/:id', handler(ctx) { return html(ctx.res, staffDetail(ctx, int(ctx.params.id))); },
  },
  {
    method: 'GET', path: '/staff/:id/edit', handler(ctx) {
      const s = get('SELECT * FROM staff WHERE id = ?', int(ctx.params.id));
      if (!s) { ctx.flashMsg('404', 'err'); return { __redirect: '/staff' }; }
      return html(ctx.res, page(ctx, staffForm(ctx, s, null)));
    },
  },
  {
    method: 'POST', path: '/staff/:id/edit', handler(ctx) {
      const f = sf(ctx);
      run(`UPDATE staff SET emp_no=?, name=?, role=?, phone=?, ic_no=?, licence_class=?, licence_expiry=?,
             address=?, salary=?, join_date=?, status=?, note=?, branch_id=? WHERE id=?`,
        f.emp_no, f.name, f.role, f.phone, f.ic_no, f.licence_class, f.licence_expiry, f.address,
        f.salary, f.join_date, f.status, f.note, f.branch_id, int(ctx.params.id));
      // Kakitangan login mewarisi cawangan yang sama.
      run('UPDATE users SET name = ?, branch_id = ? WHERE staff_id = ?', f.name, f.branch_id, int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: `/staff/${int(ctx.params.id)}` };
    },
  },
  /* ---- login accounts ---- */
  {
    method: 'POST', path: '/staff/:id/login', handler(ctx) {
      const sid = int(ctx.params.id);
      const s = get('SELECT * FROM staff WHERE id = ?', sid);
      if (!s) return { __redirect: '/staff' };
      const username = str(ctx.body.username).toLowerCase();
      const password = str(ctx.body.password) || username;
      // Akaun login mewarisi cawangan kakitangan.
      const bid = s.branch_id || null;
      const exist = get('SELECT id FROM users WHERE staff_id = ?', sid);
      if (exist) {
        run('UPDATE users SET username = ?, password_hash = ?, branch_id = ?, active = 1 WHERE id = ?',
          username, hashPassword(password), bid, exist.id);
      } else {
        run(`INSERT INTO users (username, password_hash, name, role, staff_id, branch_id, active, created_at) VALUES (?,?,?,?,?,?,1,?)`,
          username, hashPassword(password), s.name, s.role === 'admin' ? 'admin' : s.role === 'driver' ? 'driver' : 'office',
          sid, bid, new Date().toISOString());
      }
      ctx.flashMsg(`${ctx.t('a.saved')}: ${username}`);
      return { __redirect: `/staff/${sid}` };
    },
  },
  {
    method: 'POST', path: '/staff/:id/login/delete', handler(ctx) {
      run('DELETE FROM users WHERE staff_id = ?', int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.deleted'));
      return { __redirect: `/staff/${int(ctx.params.id)}` };
    },
  },
];

function addDaysLocal(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function licenceCell(ctx, r) {
  if (!r.licence_class) return '<span class="muted">—</span>';
  const exp = r.licence_expiry;
  const expired = exp && exp < today();
  const soon = exp && !expired && exp <= addDaysLocal(today(), 60);
  return `<b>${esc(r.licence_class)}</b>${exp ? `<div class="sub tiny ${expired ? 'neg' : soon ? 'amber' : ''}">${fmtDate(exp, ctx.lang)}</div>` : ''}
    ${expired ? badge(ctx.t('stf.licenceExpired'), 'bad') : soon ? badge(ctx.t('stf.licenceExpiringSoon'), 'warn') : ''}`;
}
function sf(ctx) {
  const b = ctx.body;
  return {
    emp_no: str(b.emp_no), name: str(b.name),
    role: ROLES.includes(str(b.role)) ? str(b.role) : 'driver',
    phone: str(b.phone), ic_no: str(b.ic_no),
    licence_class: str(b.licence_class), licence_expiry: str(b.licence_expiry) || null,
    address: str(b.address), salary: num(b.salary, 0),
    join_date: str(b.join_date) || null,
    status: ['active', 'leave', 'resigned'].includes(str(b.status)) ? str(b.status) : 'active',
    note: str(b.note),
    // Cawangan wajib; default kepada cawangan admin yang sedang pilih.
    branch_id: getBranch(int(b.branch_id) || ctx.bv())?.id ?? null,
  };
}
function staffForm(ctx, s, err) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const isEdit = !!s.id;
  // Cawangan - wajib, supaya setiap kakitangan boleh dikenal pasti.
  const bl = listBranches({ activeOnly: !isEdit });
  const branchField = bl.length
    ? field({
      label: 'Cawangan / Branch', name: 'branch_id', required: true,
      value: s.branch_id || ctx.branchId === 'all' ? (s.branch_id || ctx.homeBranchId || '') : (s.branch_id || ctx.branchId || ''),
      options: bl.map((b) => ({ value: b.id, label: b.name })),
      hint: 'Kakitangan hanya nampak data cawangan ini',
    })
    : `<div class="alert warn span-2">Belum ada cawangan. <a href="/branches/new">Tambah cawangan</a> dahulu.</div>`;
  const body = `${err ? alert('err', err) : ''}${card(`<form method="post" action="${isEdit ? `/staff/${s.id}/edit` : '/staff/new'}" class="form-grid">
      ${field({ label: T('stf.empNo'), name: 'emp_no', value: s.emp_no || '' })}
      ${field({ label: T('a.name'), name: 'name', value: s.name || '', required: true })}
      ${branchField}
      ${field({ label: T('a.role'), name: 'role', value: s.role, options: ROLES.map((r) => ({ value: r, label: T('stf.role.' + r) })) })}
      ${field({ label: T('a.phone'), name: 'phone', value: s.phone || '' })}
      ${field({ label: T('stf.icNo'), name: 'ic_no', value: s.ic_no || '' })}
      ${field({ label: T('stf.licenceClass'), name: 'licence_class', value: s.licence_class || '', placeholder: 'D / DA / G1 / G1A' })}
      ${field({ label: T('stf.licenceExpiry'), name: 'licence_expiry', type: 'date', value: s.licence_expiry || '' })}
      ${field({ label: T('stf.salary'), name: 'salary', type: 'number', step: '0.01', value: s.salary })}
      ${field({ label: T('stf.joinDate'), name: 'join_date', type: 'date', value: s.join_date || '' })}
      ${field({ label: T('a.status'), name: 'status', value: s.status, options: ['active', 'leave', 'resigned'].map((r) => ({ value: r, label: T('stf.status.' + r) })) })}
      <label class="field span-2"><span class="field-label">${T('a.address')}</span><textarea name="address" rows="2">${esc(s.address || '')}</textarea></label>
      <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2">${esc(s.note || '')}</textarea></label>
      ${!isEdit ? `<div class="span-2 form-divider"><b>${T('stf.createLogin')} ${T('a.optional')}</b></div>
        ${field({ label: T('stf.username'), name: 'username', value: '', hint: T('a.optional') })}
        ${field({ label: T('login.password'), name: 'password', value: '', hint: T('a.optional') })}` : ''}
      <div class="form-actions span-2">${submitBtn(T('a.save'), { ic: 'check' })}<a class="btn btn-ghost" href="${isEdit ? `/staff/${s.id}` : '/staff'}">${T('a.cancel')}</a></div>
    </form>`)}`;
  return {
    title: isEdit ? `${T('a.edit')} · ${esc(s.name)}` : T('stf.new'),
    body,
    actions: isEdit ? linkBtn(T('a.back'), `/staff/${s.id}`, { ic: 'back' }) : linkBtn(T('a.cancel'), '/staff', { ic: 'back' }),
  };
}

function staffDetail(ctx, id) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const s = get(`SELECT s.*, u.id AS user_id, u.username FROM staff s LEFT JOIN users u ON u.staff_id = s.id WHERE s.id = ?`, id);
  if (!s) { ctx.flashMsg('404', 'err'); return page(ctx, { title: '404', body: alert('err', 'Not found') }); }
  const trips = all(`SELECT t.*, o.order_no, o.delivery_date, c.name AS customer FROM trips t
                     JOIN orders o ON o.id = t.order_id JOIN customers c ON c.id = o.customer_id
                     WHERE t.driver_id = ? AND t.status != 'void' ORDER BY o.delivery_date DESC LIMIT 40`, id);
  const month = ctx.query.month || today().slice(0, 7);
  const att = all(`SELECT * FROM attendance WHERE staff_id = ? AND work_date LIKE ? ORDER BY work_date DESC`, id, month + '%');
  const tot = get(`SELECT COUNT(*) AS n, COALESCE(SUM(t.delivered_m3),0) AS m3 FROM trips t
                   WHERE t.driver_id = ? AND t.status IN ('delivered','returned')`, id);
  const present = att.filter((a) => ['present', 'late'].includes(a.status)).length;

  const body = `
    ${card(`<div class="detail-head">
      <div><div class="detail-no">${esc(s.name)} ${badge(esc(T('stf.role.' + s.role)), 'role-' + s.role)}</div>
        <div class="detail-sub">${T('stf.empNo')}: ${esc(s.emp_no || '—')}${s.join_date ? ` · ${T('stf.joinDate')}: ${fmtDate(s.join_date, lang)}` : ''}</div>
        <div class="detail-sub">${T('a.phone')}: ${s.phone ? `<a href="tel:${esc(s.phone)}">${esc(s.phone)}</a>` : '—'}</div>
        ${s.licence_class ? `<div class="detail-sub">${T('stf.licence')}: <b>${esc(s.licence_class)}</b>${s.licence_expiry ? ` (${fmtDate(s.licence_expiry, lang)})` : ''}</div>` : ''}
        ${s.address ? `<div class="detail-sub">${T('a.address')}: ${esc(s.address)}</div>` : ''}</div>
      <div class="detail-numbers">
        <div><span>${T('flt.trips')}</span><b>${num(tot.n)}</b></div>
        <div><span>${T('flt.m3Done')}</span><b>${qty(tot.m3)} m³</b></div>
        <div><span>${T('stf.salary')}</span><b>${esc(money(s.salary, lang))}</b></div>
        <div><span>${T('att.presentDays')} (${esc(month)})</span><b>${present}/${att.length}</b></div>
      </div>
    </div>`)}
    <div class="actions-row">
      ${linkBtn(T('a.edit'), `/staff/${id}/edit`, { ic: 'edit' })}
      ${linkBtn(T('pay.payslip') + ' →', `/payroll?staff_id=${id}&month=${month}`, { ic: 'payroll' })}
    </div>
    <div class="grid-2">
      ${card(cardHead(T('set.users')), s.user_id ? `
        <p>${T('stf.username')}: <b>${esc(s.username)}</b></p>
        <form method="post" action="/staff/${id}/login/delete" onsubmit="return confirm('${T('a.delete')}?')">
          <button class="btn btn-danger-ghost sm" type="submit">${T('stf.deleteLogin')}</button></form>`
        : `<form method="post" action="/staff/${id}/login" class="form-grid">
            ${field({ label: T('stf.username'), name: 'username', value: '', required: true })}
            ${field({ label: T('login.password'), name: 'password', value: '', hint: T('a.optional') })}
            <div class="form-actions span-2">${submitBtn(T('a.save'), { ic: 'check' })}</div>
          </form>`)}
      ${card(cardHead(`${T('att.title')} · ${esc(month)}`), table([
        { key: 'work_date', label: T('a.date'), cell: (r) => fmtDate(r.work_date, lang) },
        { key: 'in_time', label: T('att.in'), cell: (r) => esc(r.in_time || '—') },
        { key: 'out_time', label: T('att.out'), cell: (r) => esc(r.out_time || '—') },
        { key: 'status', label: T('a.status'), cell: (r) => badge(esc(T('att.status.' + r.status)), r.status === 'present' ? 'ok' : r.status === 'leave' ? 'warn' : r.status === 'absent' ? 'bad' : 'neutral') },
      ], att, { emptyMsg: T('a.noData') }) + `<div class="mt">${linkBtn(T('att.title'), `/attendance?month=${month}`, { ic: 'attendance' })}</div>`)}
    </div>
    <div class="grid-1">${card(cardHead(T('flt.trips')), table([
      { key: 'trip_no', label: T('dlv.trip'), cell: (r) => `<a href="/deliveries/${r.id}"><b>${esc(r.trip_no)}</b></a>` },
      { key: 'delivery_date', label: T('a.date'), cell: (r) => fmtDate(r.delivery_date, lang) },
      { key: 'customer', label: T('a.customer'), cell: (r) => `<span class="trunc">${esc(r.customer)}</span>` },
      { key: 'delivered_m3', label: T('dlv.deliveredQty'), align: 'right', cell: (r) => qty(r.delivered_m3) },
      { key: 'status', label: T('a.status'), cell: (r) => `<span class="tiny">${esc(ctx.t('trip.status.' + r.status))}</span>` },
    ], trips, { emptyMsg: T('a.noData') }))}</div>`;

  return page(ctx, {
    title: s.name,
    body,
    actions: linkBtn(T('a.back'), '/staff', { ic: 'back' }),
  });
}
