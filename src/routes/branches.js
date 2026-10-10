import { all, get, run, getBranch, setSessionBranch } from '../db.js';
import { html, str, int } from '../lib/http.js';
import { page, card, table, field, submitBtn, linkBtn, badge, alert, esc } from '../lib/html.js';

/**
 * Cawangan / Branch management.
 * KESELURUHAN laluan di sini adalah KHAS ADMIN. Kakitangan terkunci
 * kepada cawangan sendiri dan tidak boleh bertukar.
 */
export const branchRoutes = [
  {
    method: 'POST', path: '/branch/switch', role: ['admin'], handler(ctx) {
      const raw = str(ctx.body.branch_id);
      const want = raw === 'all' ? 'all' : int(raw);
      if (want !== 'all' && want && !getBranch(want)) {
        ctx.flashMsg(ctx.t('a.required'), 'err');
        return { __redirect: ctx.fullUrl.replace(/\?.*$/, '') || '/dashboard' };
      }
      setSessionBranch(ctx.cookies.token, want === 'all' ? null : want);
      const back = ctx.query.next || '/dashboard';
      return { __redirect: back.startsWith('/') ? back : '/dashboard' };
    },
  },

  {
    method: 'GET', path: '/branches', role: ['admin'], handler(ctx) {
      const T = (k) => esc(ctx.t(k));
      const rows = all(`SELECT b.*,
            (SELECT COUNT(*) FROM users   u WHERE u.branch_id = b.id) AS n_users,
            (SELECT COUNT(*) FROM staff   s WHERE s.branch_id = b.id) AS n_staff,
            (SELECT COUNT(*) FROM orders  o WHERE o.branch_id = b.id) AS n_orders,
            (SELECT COUNT(*) FROM items   i WHERE i.branch_id = b.id) AS n_items
          FROM branches b ORDER BY b.name`);
      const unassigned = get(`SELECT
            (SELECT COUNT(*) FROM users  WHERE branch_id IS NULL) AS users,
            (SELECT COUNT(*) FROM staff  WHERE branch_id IS NULL) AS staff,
            (SELECT COUNT(*) FROM orders WHERE branch_id IS NULL) AS orders`) || {};

      // Rekod tanpa cawangan kelihatan di semua cawangan - amaran admin supaya
      // data tidak tersilap kepunyaan.
      const warn = (unassigned.users || unassigned.orders)
        ? alert('warn', `Rekod belum diumpukkan: ${unassigned.users || 0} pengguna, `
          + `${unassigned.staff || 0} kakitangan, ${unassigned.orders || 0} pesanan. `
          + 'Rekod tanpa cawangan kelihatan di semua cawangan.')
        : '';

      const cols = [
        { label: 'Kod', cell: (b) => `<code>${esc(b.code)}</code>` },
        {
          label: 'Nama',
          cell: (b) => `<b>${esc(b.name)}</b>`
            + (b.address ? `<br><small>${esc(b.address)}</small>` : ''),
        },
        { label: 'Pengguna', align: 'right', cell: (b) => b.n_users },
        { label: 'Kakitangan', align: 'right', cell: (b) => b.n_staff },
        { label: 'Pesanan', align: 'right', cell: (b) => b.n_orders },
        { label: 'Stok', align: 'right', cell: (b) => b.n_items },
        {
          label: 'Status',
          cell: (b) => badge(b.active ? 'Aktif' : 'Off', b.active ? 'st-active' : 'st-off'),
        },
        {
          label: '',
          align: 'right',
          cell: (b) => `${linkBtn(T('a.edit'), `/branches/${b.id}`)}
            <form method="post" action="/branches/${b.id}/toggle" style="display:inline">
              ${submitBtn(b.active ? 'Lumpuhkan' : 'Aktifkan', { variant: 'ghost' })}
            </form>`,
        },
      ];

      return html(ctx.res, page(ctx, {
        title: 'Cawangan / Branches',
        actions: linkBtn('Cawangan Baru', '/branches/new', { ic: 'plus', variant: 'primary' }),
        body: `${warn}${card(table(cols, rows, { emptyMsg: 'Tiada cawangan / No branches' }))}`,
      }));
    },
  },

  {
    method: 'GET', path: '/branches/new', role: ['admin'], handler(ctx) {
      return html(ctx.res, page(ctx, {
        title: 'Cawangan Baru / New Branch',
        body: card(`
          <form method="post" action="/branches/new">
            ${field({ label: 'Kod / Code', name: 'code', placeholder: 'papar', required: true })}
            ${field({ label: 'Nama / Name', name: 'name', placeholder: 'Papar', required: true })}
            ${field({ label: 'Alamat / Address', name: 'address' })}
            ${field({ label: 'Telefon / Phone', name: 'phone' })}
            <div class="form-actions">
              ${submitBtn('Simpan / Save')}
              ${linkBtn('Batal / Cancel', '/branches', { variant: 'ghost' })}
            </div>
          </form>
        `),
      }));
    },
  },

  {
    method: 'POST', path: '/branches/new', role: ['admin'], handler(ctx) {
      const code = str(ctx.body.code).toLowerCase().trim();
      const name = str(ctx.body.name).trim();
      if (!code || !name) {
        ctx.flashMsg(ctx.t('a.required'), 'err');
        return { __redirect: '/branches/new' };
      }
      if (get('SELECT id FROM branches WHERE code = ?', code)) {
        ctx.flashMsg(`${code} sudah wujud / already exists`, 'err');
        return { __redirect: '/branches/new' };
      }
      run(`INSERT INTO branches (code, name, address, phone, active, created_at) VALUES (?,?,?,?,1,?)`,
        code, name, str(ctx.body.address), str(ctx.body.phone), new Date().toISOString());
      ctx.flashMsg(`${ctx.t('a.saved')}: ${name}`);
      return { __redirect: '/branches' };
    },
  },

  {
    method: 'GET', path: '/branches/:id', role: ['admin'], handler(ctx) {
      const b = getBranch(int(ctx.params.id));
      if (!b) {
        return html(ctx.res, page(ctx, {
          title: '404', body: alert('err', 'Tidak dijumpai / Not found'),
        }), 404);
      }
      return html(ctx.res, page(ctx, {
        title: b.name,
        body: card(`
          <form method="post" action="/branches/${b.id}">
            ${field({ label: 'Kod / Code', name: 'code', value: b.code })}
            ${field({ label: 'Nama / Name', name: 'name', value: b.name })}
            ${field({ label: 'Alamat / Address', name: 'address', value: b.address })}
            ${field({ label: 'Telefon / Phone', name: 'phone', value: b.phone })}
            <div class="form-actions">
              ${submitBtn('Simpan / Save')}
              ${linkBtn('Batal / Cancel', '/branches', { variant: 'ghost' })}
            </div>
          </form>
        `),
      }));
    },
  },

  {
    method: 'POST', path: '/branches/:id', role: ['admin'], handler(ctx) {
      const id = int(ctx.params.id);
      const b = getBranch(id);
      if (!b) return { __redirect: '/branches' };
      const code = str(ctx.body.code).toLowerCase().trim() || b.code;
      const clash = get('SELECT id FROM branches WHERE code = ? AND id != ?', code, id);
      if (clash) {
        ctx.flashMsg(`${code} sudah digunakan / already in use`, 'err');
        return { __redirect: `/branches/${id}` };
      }
      run('UPDATE branches SET code = ?, name = ?, address = ?, phone = ? WHERE id = ?',
        code, str(ctx.body.name), str(ctx.body.address), str(ctx.body.phone), id);
      ctx.flashMsg(ctx.t('a.saved'));
      return { __redirect: '/branches' };
    },
  },

  {
    method: 'POST', path: '/branches/:id/toggle', role: ['admin'], handler(ctx) {
      const id = int(ctx.params.id);
      const b = getBranch(id);
      if (b) run('UPDATE branches SET active = ? WHERE id = ?', b.active ? 0 : 1, id);
      return { __redirect: '/branches' };
    },
  },
];
