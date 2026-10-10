import { all, get, run, hashPassword, setting, listBranches, getBranch, suggestEmpNo, branchAbbr } from '../db.js';
import { redirect, html, today, num, str, int } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate,
  field, alert, linkBtn, submitBtn, filterBar, tabs,
} from '../lib/html.js';
import { round2 } from '../lib/biz.js';

/* Peranan kakitangan. Setiap peranan ada huruf kod sendiri supaya nombor
 * pekerja dapat dibaca tanpa melihat pangkalan data (lihat suggestEmpNo).
 * 'supervisor' dan 'clerk' mesti ada di sini - tanpanya, sf() akan menukar
 * mana-mana peranan yang tidak dikenali kepada 'driver', jadi admin yang
 * memilih supervisor sebenarnya akan menubuhkan seorang pemandu. */
const ROLES = ['supervisor', 'clerk', 'dispatcher', 'driver', 'lab', 'mechanic', 'admin'];

/* Petakan peranan kakitangan kepada peranan akaun login.
 * Default ialah 'office' (pegangan cawangan, boleh urus pesanan & pembekalan).
 * Pemandu dik-special-capkan supaya lorongya sendiri sahaja; teknikal mendapat
 * 'lab' supaya boleh urus reka bentuk konkrit. Kebenan kewangan TIDAK diberi
 * di sini - admin yang memberikannya dari Tetapan -> Pengguna. */
function userRoleFor(staffRole) {
  if (staffRole === 'driver') return 'driver';
  if (staffRole === 'lab') return 'lab';
  if (staffRole === 'admin') return 'admin';
  return 'office';
}

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
          { key: 'act', label: '', align: 'right', cell: (r) =>
            linkBtn(T('a.edit'), `/staff/${r.id}/edit`, { variant: 'link', cls: 'sm' }) +
            (ctx.user.role === 'admin' && r.id !== ctx.user.staff_id
              ? `<form method="post" action="/staff/${r.id}/delete" class="inline-form" onsubmit="return confirm('${T('stf.deleteConfirm')}')">
                  <button class="btn btn-danger-ghost sm" type="submit">${T('a.delete')}</button></form>`
              : '') },
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
      // Nombor pekerja mesti unik. emp_no mempunyai kekangan UNIQUE,
      // jadi tanpa semakan ini INSERT yang berulang akan melontar
      // UNIQUE constraint dan admin nampak ralat pelayan 500, bukan
      // sebab yang boleh dibetulkan.
      if (f.emp_no) {
        const clash = get('SELECT id, name FROM staff WHERE lower(emp_no) = ?', f.emp_no.toLowerCase());
        if (clash) {
          ctx.flashMsg(ctx.t('stf.empNoTaken').replace('%s', f.emp_no).replace('%n', clash.name), 'err');
          return { __redirect: '/staff/new' };
        }
      }
      if (str(ctx.body.username)) {
        const uClash = get('SELECT id FROM users WHERE lower(username) = ?', str(ctx.body.username).toLowerCase());
        if (uClash) {
          ctx.flashMsg(ctx.t('stf.usernameTaken').replace('%s', str(ctx.body.username)), 'err');
          return { __redirect: '/staff/new' };
        }
      }
      const r = run(`INSERT INTO staff (emp_no, name, role, phone, ic_no, licence_class, licence_expiry, address, salary, annual_leave, join_date, status, note, branch_id, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.emp_no, f.name, f.role, f.phone, f.ic_no, f.licence_class, f.licence_expiry, f.address,
        f.salary, f.annual_leave, f.join_date, f.status, f.note, f.branch_id, new Date().toISOString());
      upsertOtRates(r.id, f);
      // Username lalai kepada nombor pekerja supaya kakitangan
      // login dengan kod yang tercetak pada slip gaji. Kebenan kewangan TIDAK
      // diberi di sini - admin yang memberikannya dari Tetapan -> Pengguna.
      if (str(ctx.body.username)) {
        run(`INSERT INTO users (username, password_hash, name, role, staff_id, branch_id, can_finance, active, created_at)
             VALUES (?,?,?,?,?,?,0,1,?)`,
          str(ctx.body.username).toLowerCase(), hashPassword(str(ctx.body.password) || str(ctx.body.username)),
          f.name, userRoleFor(f.role), r.id, f.branch_id, new Date().toISOString());
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
      // Kadar lembur disimpan dalam jadual berasingan - gabungkan untuk borang.
      const otr = get('SELECT * FROM staff_ot_rates WHERE staff_id = ?', int(ctx.params.id));
      if (otr) Object.assign(s, { ot_normal: otr.normal_rate, ot_rest: otr.rest_rate, ot_ph: otr.ph_rate });
      return html(ctx.res, page(ctx, staffForm(ctx, s, null)));
    },
  },
  {
    method: 'POST', path: '/staff/:id/edit', handler(ctx) {
      const f = sf(ctx);
      run(`UPDATE staff SET emp_no=?, name=?, role=?, phone=?, ic_no=?, licence_class=?, licence_expiry=?,
             address=?, salary=?, annual_leave=?, join_date=?, status=?, note=?, branch_id=? WHERE id=?`,
        f.emp_no, f.name, f.role, f.phone, f.ic_no, f.licence_class, f.licence_expiry, f.address,
        f.salary, f.annual_leave, f.join_date, f.status, f.note, f.branch_id, int(ctx.params.id));
      upsertOtRates(int(ctx.params.id), f);
      // Sinkronkan status login: staf yang 'leave' atau 'resigned' tidak boleh log masuk.
      const userActive = f.status === 'active' ? 1 : 0;
      run('UPDATE users SET name = ?, branch_id = ?, active = ? WHERE staff_id = ?',
        f.name, f.branch_id, userActive, int(ctx.params.id));
      ctx.flashMsg(ctx.t('a.updated'));
      return { __redirect: `/staff/${int(ctx.params.id)}` };
    },
  },
  {
    method: 'POST', path: '/staff/:id/delete', role: ['admin'], handler(ctx) {
      const id = int(ctx.params.id);
      const s = get('SELECT * FROM staff WHERE id = ?', id);
      if (!s) return { __redirect: '/staff' };
      const refs = get(`SELECT
          (SELECT COUNT(*) FROM users WHERE staff_id = ?) AS u,
          (SELECT COUNT(*) FROM attendance WHERE staff_id = ?) AS a,
          (SELECT COUNT(*) FROM trips WHERE driver_id = ?) AS t`, id, id, id);
      if (!num(refs.u) && !num(refs.a) && !num(refs.t)) {
        // Tiada rekod berkaitan - padam terus.
        run('DELETE FROM staff_ot_rates WHERE staff_id = ?', id);
        run('DELETE FROM staff WHERE id = ?', id);
        ctx.flashMsg(`${ctx.t('stf.deleted')}: ${s.name}`);
      } else {
        // Ada sejarah (kehadiran/perjalanan/login) - tanda resigned sahaja
        // supaya rekod lama tidak putus rujukan.
        run(`UPDATE staff SET status = 'resigned' WHERE id = ?`, id);
        run('UPDATE users SET active = 0 WHERE staff_id = ?', id);
        ctx.flashMsg(`${ctx.t('stf.softDeleted')}: ${s.name}`);
      }
      return { __redirect: '/staff' };
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
    annual_leave: num(b.annual_leave, 0),
    ot_normal: num(b.ot_normal, 0), ot_rest: num(b.ot_rest, 0), ot_ph: num(b.ot_ph, 0),
    join_date: str(b.join_date) || null,
    status: ['active', 'leave', 'resigned'].includes(str(b.status)) ? str(b.status) : 'active',
    note: str(b.note),
    // Cawangan wajib; default kepada cawangan admin yang sedang pilih.
    branch_id: getBranch(int(b.branch_id) || ctx.bv())?.id ?? null,
  };
}
/* Simpan kadar lembur staff (staff_ot_rates). Kadar 0 = auto daripada gaji
 * dalam pengiraan payroll. */
function upsertOtRates(staffId, f) {
  run(`INSERT INTO staff_ot_rates (staff_id, normal_rate, rest_rate, ph_rate, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(staff_id) DO UPDATE SET normal_rate=excluded.normal_rate,
         rest_rate=excluded.rest_rate, ph_rate=excluded.ph_rate, updated_at=excluded.updated_at`,
    staffId, f.ot_normal, f.ot_rest, f.ot_ph, new Date().toISOString());
}
function staffForm(ctx, s, err) {
  const { lang } = ctx;
  const T = (k) => esc(ctx.t(k));
  const isEdit = !!s.id;
  // Cawangan - wajib, supaya setiap kakitangan boleh dikenal pasti.
  const bl = listBranches({ activeOnly: !isEdit });
  // Untuk staff baru, cawangan yang sedang dipilih dijadikan titik mula
  // supaya nombor pekerja yang dicadangkan sudah betul sejak mula.
  // Admin yang sedang melihat SEMUA cawangan perlu diberi satu cawangan
  // sebenar - kalau tidak, pelayar akan pilih yang pertama dalam senarai
  // tetapi nombor pekerja akan dipaparkan sebagai HQ, jadi kedua-duanya
  // tidak sepadan.
  const prefillBranch = isEdit
    ? (s.branch_id || '')
    : (s.branch_id || (ctx.branchId === 'all' ? ctx.homeBranchId : ctx.branchId) || bl[0]?.id || '');
  const branchField = bl.length
    ? field({
      label: 'Cawangan / Branch', name: 'branch_id', required: true,
      value: prefillBranch,
      options: bl.map((b) => ({ value: b.id, label: `${b.name} (${branchAbbr(b)})` })),
      hint: 'Kakitangan hanya nampak data cawangan ini',
    })
    : `<div class="alert warn span-2">Belum ada cawangan. <a href="/branches/new">Tambah cawangan</a> dahulu.</div>`;
  /* Nombor pekerja dicadangkan daripada cawangan + peranan (3-PPR01, 6-PUT01)
   * supaya admin tidak perlu menaip atau kena kod yang sama dua kali.
   * Staff sedia ada kekal dengan kod dia; hanya dipaparkan jika kosong. */
  const empNoValue = s.emp_no || (!isEdit ? suggestEmpNo(s.role, prefillBranch || null) : '');
  const body = `${err ? alert('err', err) : ''}${card(`<form method="post" action="${isEdit ? `/staff/${s.id}/edit` : '/staff/new'}" class="form-grid">
      ${field({
    label: T('stf.empNo'), name: 'emp_no', value: empNoValue, attrs: 'data-empno',
    hint: isEdit ? 'Kod cawangan + peranan, contoh 3-PPR01'
      : 'Dijana daripada cawangan & peranan. Kakitangan login dengan kod ini.',
  })}
      ${field({ label: T('a.name'), name: 'name', value: s.name || '', required: true })}
      ${branchField}
      ${field({ label: T('a.role'), name: 'role', value: s.role, options: ROLES.map((r) => ({ value: r, label: T('stf.role.' + r) })) })}
      ${field({ label: T('a.phone'), name: 'phone', value: s.phone || '' })}
      ${field({ label: T('stf.icNo'), name: 'ic_no', value: s.ic_no || '' })}
      ${field({ label: T('stf.licenceClass'), name: 'licence_class', value: s.licence_class || '', placeholder: 'D / DA / G1 / G1A' })}
      ${field({ label: T('stf.licenceExpiry'), name: 'licence_expiry', type: 'date', value: s.licence_expiry || '' })}
      ${field({ label: T('stf.salary'), name: 'salary', type: 'number', step: '0.01', value: s.salary })}
      ${field({ label: T('stf.annualLeave'), name: 'annual_leave', type: 'number', step: '1', value: s.annual_leave || '' })}
      <div class="span-2 form-divider"><b>${T('stf.otRates')}</b></div>
      ${field({ label: T('stf.otNormal'), name: 'ot_normal', type: 'number', step: '0.01', value: s.ot_normal || '', hint: T('stf.otHint') })}
      ${field({ label: T('stf.otPh'), name: 'ot_ph', type: 'number', step: '0.01', value: s.ot_ph || '' })}
      ${field({ label: T('stf.joinDate'), name: 'join_date', type: 'date', value: s.join_date || '' })}
      ${field({ label: T('a.status'), name: 'status', value: s.status, options: ['active', 'leave', 'resigned'].map((r) => ({ value: r, label: T('stf.status.' + r) })) })}
      <label class="field span-2"><span class="field-label">${T('a.address')}</span><textarea name="address" rows="2">${esc(s.address || '')}</textarea></label>
      <label class="field span-2"><span class="field-label">${T('a.note')}</span><textarea name="note" rows="2">${esc(s.note || '')}</textarea></label>
      ${!isEdit ? `<div class="span-2 form-divider"><b>${T('stf.createLogin')} ${T('a.optional')}</b></div>
        ${field({ label: T('stf.username'), name: 'username', value: empNoValue ? empNoValue.toLowerCase() : '', hint: 'Nombor pekerja - kakitangan login dengan kod ini' })}
        ${field({ label: T('login.password'), name: 'password', value: '', hint: 'Kosongkan untuk guna username sebagai kata laluan' })}` : ''}
      <div class="form-actions span-2">${submitBtn(T('a.save'), { ic: 'check' })}<a class="btn btn-ghost" href="${isEdit ? `/staff/${s.id}` : '/staff'}">${T('a.cancel')}</a></div>
    </form>`)}`;
  /* Skrip kecil: bila admin tukar cawangan atau peranan, nombor pekerja
   * dan username login ikut dikemas kini supaya kod tidak lagi tepat dengan
   * cawangan yang dipilih. */
  const script = isEdit ? '' : `(() => {
  const emp = document.querySelector('[name=emp_no]');
  const user = document.querySelector('[name=username]');
  const br = document.querySelector('[name=branch_id]');
  const role = document.querySelector('[name=role]');
  const next = new Map(${JSON.stringify(empNoPlan(bl))});
  const sync = () => {
    const want = next.get(br.value + '/' + role.value);
    if (want && emp && emp.dataset.touched !== '1') emp.value = want;
    if (want && user && !user.value) user.value = want.toLowerCase();
  };
  emp?.addEventListener('input', () => { emp.dataset.touched = '1'; });
  br?.addEventListener('change', () => { emp && (emp.dataset.touched = '0'); sync(); });
  role?.addEventListener('change', sync);
})();`;
  return {
    title: isEdit ? `${T('a.edit')} · ${esc(s.name)}` : T('stf.new'),
    body, script,
    actions: isEdit ? linkBtn(T('a.back'), `/staff/${s.id}`, { ic: 'back' }) : linkBtn(T('a.cancel'), '/staff', { ic: 'back' }),
  };
}

/* Pelan nombor pekerja untuk setiap pasangan cawangan + peranan, supaya
 * skrip boleh mengemas kini nombor tanpa panggil server. Kunci ialah
 * "<branch_id>/<role>", nilai ialah nombor pekerja berikutnya. */
function empNoPlan(branches) {
  const plan = {};
  for (const b of branches) for (const r of ROLES) plan[`${b.id}/${r}`] = suggestEmpNo(r, b.id);
  return plan;
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
  // Kadar lembur & baki cuti tahunan (cuti diambil dikira dari attendance tahun ini).
  const otr = get('SELECT * FROM staff_ot_rates WHERE staff_id = ?', id);
  const leaveUsed = num(get(`SELECT COUNT(*) AS n FROM attendance WHERE staff_id = ? AND status = 'leave' AND work_date LIKE ?`,
    id, today().slice(0, 4) + '%')?.n);
  const leaveEnt = num(s.annual_leave);

  const body = `
    ${card(`<div class="detail-head">
      <div><div class="detail-no">${esc(s.name)} ${badge(esc(T('stf.role.' + s.role)), 'role-' + s.role)}</div>
        <div class="detail-sub">${T('stf.empNo')}: ${esc(s.emp_no || '—')}${s.join_date ? ` · ${T('stf.joinDate')}: ${fmtDate(s.join_date, lang)}` : ''}</div>
        <div class="detail-sub">${T('a.phone')}: ${s.phone ? `<a href="tel:${esc(s.phone)}">${esc(s.phone)}</a>` : '—'}</div>
        ${s.licence_class ? `<div class="detail-sub">${T('stf.licence')}: <b>${esc(s.licence_class)}</b>${s.licence_expiry ? ` (${fmtDate(s.licence_expiry, lang)})` : ''}</div>` : ''}
        ${otr ? `<div class="detail-sub">${T('stf.otRates')}: <b class="green">B ${esc(money(otr.normal_rate || 'auto', lang))}</b> · P ${esc(money(otr.ph_rate || 'auto', lang))}/jam</div>` : ''}
        ${leaveEnt > 0 ? `<div class="detail-sub">${T('stf.annualLeave')}: <b>${num(leaveEnt)}</b> hari · ${T('stf.leaveUsed')}: ${leaveUsed} · ${T('stf.leaveBal')}: <b>${Math.max(0, leaveEnt - leaveUsed)}</b></div>` : ''}
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
      ${ctx.user.role === 'admin' && s.user_id !== ctx.user.id
        ? `<form method="post" action="/staff/${id}/delete" class="inline-form" onsubmit="return confirm('${T('stf.deleteConfirm')}')">
            <button class="btn btn-danger-ghost sm" type="submit">${T('a.delete')}</button></form>`
        : ''}
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
