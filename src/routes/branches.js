import { all, get, run, listBranches, getBranch, setSessionBranch } from '../db.js';
import { redirect, str, int } from '../lib/http.js';
import { page, card, cardHead, table, field, submitBtn, linkBtn, badge, esc } from '../lib/html.js';

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

      return html(ctx.res, page(ctx, 'Cawangan / Branches', `
        ${cardHead('Cawangan / Branches', `/branches/new`)}
        ${unassigned.users || unassigned.orders ? `<div class="alert warn">
          Rekod belum diumpukkan: ${unassigned.users || 0} pengguna, ${unassigned.staff || 0} kakitangan,
          ${unassigned.orders || 0} pesanan. Rekod tanpa cawangan kelihatan di semua cawangan.
        </div>` : ''}
        ${card(`
          ${table(['Kod', 'Nama', 'Pengguna', 'Kakitangan', 'Pesanan', 'Stok', 'Status', ''],
            rows.map((b) => `<tr>
              <td><code>${esc(b.code)}</code></td>
              <td><b>${esc(b.name)}</b>${b.address ? `<br><small>${esc(b.address)}</small>` : ''}</td>
              <td>${b.n_users}</td>
              <td>${b.n_staff}</td>
              <td>${b.n_orders}</td>
              <td>${b.n_items}</td>
              <td>${badge(b.active ? 'active' : 'resigned', b.active ? T('a.active') : 'Off')}</td>
              <td>
                ${linkBtn(`/branches/${b.id}`, T('a.edit'))}
                <form method="post" action="/branches/${b.id}/toggle" style="display:inline">
                  ${submitBtn(b.active ? 'Lumpuhkan' : 'Aktifkan', 'ghost')}
                </form>
              </td>
            </tr>`),
            ['Kod', 'Name', 'Users', 'Staff', 'Orders', 'Stock', 'Status', ''])}
        `)}
      `));
    },
  },

  {
    method: 'GET', path: '/branches/new', role: ['admin'], handler(ctx) {
      return html(ctx.res, page(ctx, 'Cawangan Baru / New Branch', card(`
        <form method="post" action="/branches/new">
          ${field({ label: 'Kod / Code', name: 'code', placeholder: 'papar' })}
          ${field({ label: 'Nama / Name', name: 'name', placeholder: 'Papar' })}
          ${field({ label: 'Alamat / Address', name: 'address' })}
          ${field({ label: 'Telefon / Phone', name: 'phone' })}
          <div class="form-actions">
            ${submitBtn('Simpan / Save')}
            ${linkBtn('/branches', 'Batal / Cancel', 'ghost')}
          </div>
        </form>
      `)));
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
      if (!b) return html(ctx.res, page(ctx, '404', '<p>Tidak dijumpai</p>'), 404);
      return html(ctx.res, page(ctx, b.name, card(`
        <form method="post" action="/branches/${b.id}">
          ${field({ label: 'Kod / Code', name: 'code', value: b.code })}
          ${field({ label: 'Nama / Name', name: 'name', value: b.name })}
          ${field({ label: 'Alamat / Address', name: 'address', value: b.address })}
          ${field({ label: 'Telefon / Phone', name: 'phone', value: b.phone })}
          <div class="form-actions">
            ${submitBtn('Simpan / Save')}
            ${linkBtn('/branches', 'Batal / Cancel', 'ghost')}
          </div>
        </form>
      `)));
    },
  },

  {
    method: 'POST', path: '/branches/:id', role: ['admin'], handler(ctx) {
      const id = int(ctx.params.id);
      const b = getBranch(id);
      if (!b) return { __redirect: '/branches' };
      const code = str(ctx.body.code).toLowerCase().trim() || b.code;
      const clash = get('SELECT id FROM branches WHERE code = ? AND id != ?', code, id);
      if (clash) { ctx.flashMsg(`${code} sudah digunakan`, 'err'); return { __redirect: `/branches/${id}` }; }
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