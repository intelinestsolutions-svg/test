import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run, tx, setSetting, hashPassword, verifyPassword, setting, db, DATA_DIR, listBranches, getBranch } from '../db.js';
import { redirect, html, today, num, str, int, text } from '../lib/http.js';
import {
  page, table, card, cardHead, badge, icon, esc, money, qty, fmtDate,
  field, alert, linkBtn, submitBtn, tabs, checkbox,
} from '../lib/html.js';
import { allowanceRates } from '../lib/biz.js';

const COMPANY_KEYS = ['company_name', 'company_reg_no', 'company_sst_no', 'company_phone', 'company_address', 'company_email'];
const FINANCE_KEYS = ['sst_rate', 'default_delivery_charge', 'default_payment_terms', 'base_url'];
const BANK_KEYS = ['bank_name', 'bank_account'];
const ALLOW_KEYS = ['driver_daily_allowance', 'driver_trip_allowance', 'loader_trip_allowance'];
const PREFIX_KEYS = ['invoice_prefix', 'order_prefix', 'dn_prefix', 'trip_prefix', 'payment_prefix', 'receipt_prefix'];

const TAB_KEYS = { company: COMPANY_KEYS, finance: FINANCE_KEYS, bank: BANK_KEYS, allow: ALLOW_KEYS, numbering: PREFIX_KEYS, users: null, data: null, github: null };

export const settingsRoutes = [
  {
    method: 'GET', path: '/settings', role: ['admin'], handler(ctx) {
      const { lang } = ctx;
      const T = (k) => esc(ctx.t(k));
      const tab = TAB_KEYS[ctx.query.tab] !== undefined ? ctx.query.tab : 'company';
      const s = ctx.settings;
      const a = allowanceRates();

      const tabsHtml = tabs(ctx, [
        ['/settings?tab=company', T('set.company'), null],
        ['/settings?tab=finance', T('set.finance'), null],
        ['/settings?tab=bank', T('set.bank'), null],
        ['/settings?tab=allow', T('set.allowance'), null],
        ['/settings?tab=numbering', T('set.numbering'), null],
        ['/settings?tab=users', T('set.users'), num(get('SELECT COUNT(*) AS n FROM users WHERE active=1')?.n)],
        ['/settings?tab=data', T('set.data'), null],
        ['/settings?tab=github', T('set.github'), null],
      ], `/settings?tab=${tab}`);

      let panel = '';
      if (tab === 'company') {
        panel = card(cardHead(T('set.company')), form(ctx, 'company', COMPANY_KEYS, [
          f(T('set.companyName'), 'company_name', s.company_name, { required: true }),
          f(T('set.regNo'), 'company_reg_no', s.company_reg_no),
          f(T('set.sstNo'), 'company_sst_no', s.company_sst_no),
          f(T('set.phone'), 'company_phone', s.company_phone),
          f(T('set.address'), 'company_address', s.company_address, { textarea: true }),
          f(T('set.email'), 'company_email', s.company_email, { type: 'email' }),
        ]));
      } else if (tab === 'finance') {
        panel = card(cardHead(T('set.finance')), form(ctx, 'finance', FINANCE_KEYS, [
          f(T('set.sstRate'), 'sst_rate', s.sst_rate, { type: 'number', step: '0.01' }),
          f(T('set.defaultDelivery'), 'default_delivery_charge', s.default_delivery_charge, { type: 'number', step: '0.01' }),
          f(T('set.defaultTerms'), 'default_payment_terms', s.default_payment_terms, { type: 'number', step: '1' }),
          f(T('set.baseUrl'), 'base_url', s.base_url, { hint: T('set.baseUrlHint') }),
        ]));
      } else if (tab === 'bank') {
        panel = card(cardHead(T('set.bank')), form(ctx, 'bank', BANK_KEYS, [
          f(T('set.bankName'), 'bank_name', s.bank_name),
          f(T('set.bankAccount'), 'bank_account', s.bank_account),
        ]) + `<p class="tiny muted mt">${T('pay.gatewaySetup')}</p>`);
      } else if (tab === 'allow') {
        panel = card(cardHead(T('set.allowance')), form(ctx, 'allow', ALLOW_KEYS, [
          f(T('set.driverDaily'), 'driver_daily_allowance', a.driverDaily, { type: 'number', step: '0.01' }),
          f(T('set.driverTrip'), 'driver_trip_allowance', a.driverTrip, { type: 'number', step: '0.01' }),
          f(T('set.loaderTrip'), 'loader_trip_allowance', a.loaderTrip, { type: 'number', step: '0.01' }),
        ]) + `<p class="tiny muted mt">${T('pay.title')} → <a href="/payroll">/payroll</a></p>`);
      } else if (tab === 'numbering') {
        panel = card(cardHead(T('set.numbering')), form(ctx, 'numbering', PREFIX_KEYS, [
          f(T('ord.no'), 'order_prefix', s.order_prefix),
          f(T('dlv.dn'), 'dn_prefix', s.dn_prefix),
          f(T('inv2.no'), 'invoice_prefix', s.invoice_prefix),
          f(T('pay.no'), 'payment_prefix', s.payment_prefix),
          f(T('pay.receiptNo'), 'receipt_prefix', s.receipt_prefix),
          f(T('dlv.trip'), 'trip_prefix', s.trip_prefix),
        ]) + `<p class="tiny muted mt">${T('doc.printNote')}</p>`);
      } else if (tab === 'users') {
        const users = all(`SELECT u.*, s.emp_no, st.name AS staff_name, b.name AS branch_name
          FROM users u
          LEFT JOIN staff s ON s.id = u.staff_id
          LEFT JOIN staff st ON st.id = s.id
          LEFT JOIN branches b ON b.id = u.branch_id
          ORDER BY u.role, u.name`);
        panel = card(cardHead(T('set.users')), table([
          { key: 'username', label: T('stf.username'), cell: (r) => `<b>${esc(r.username)}</b>` },
          { key: 'name', label: T('a.name') },
          { key: 'role', label: T('a.role'), cell: (r) => badge(esc(T('set.role.' + r.role)), 'role-' + r.role) },
          { key: 'staff_name', label: T('stf.title'), cell: (r) => esc(r.staff_name || '—') },
          { key: 'branch_name', label: 'Cawangan', cell: (r) => r.branch_name
            ? badge(esc(r.branch_name), 'ok')
            : (r.role === 'admin' ? badge('Semua', 'role-admin') : badge('—', 'neutral')) },
          { key: 'created_at', label: T('a.created'), cell: (r) => fmtDate(r.created_at, lang) },
          { key: 'last_login', label: T('a.time'), cell: (r) => r.last_login ? fmtDate(r.last_login, lang) : '—' },
          { key: 'active', label: T('a.status'), cell: (r) => badge(r.active ? T('stf.status.active') : T('a.no'), r.active ? 'ok' : 'neutral') },
        ], users) + `
        <div class="grid-2 mt">
          <div class="card">${cardHead(T('set.newUser'))}<form method="post" action="/settings/users" class="form-grid">
            ${field({ label: T('stf.username'), name: 'username', value: '', required: true })}
            ${field({ label: T('login.password'), name: 'password', value: '', required: true })}
            ${field({ label: T('a.name'), name: 'name', value: '', required: true })}
            ${field({ label: T('a.role'), name: 'role', value: 'office', options: ['admin', 'office', 'driver'].map((r) => ({ value: r, label: T('set.role.' + r) })) })}
            ${field({
    label: 'Cawangan / Branch', name: 'branch_id', value: ctx.branchId === 'all' ? '' : (ctx.branchId || ''),
    options: [{ value: '', label: 'Semua Cawangan (admin sahaja)' }, ...listBranches().map((b) => ({ value: b.id, label: b.name }))],
    hint: 'Pengguna biasa hanya boleh nampak data cawangan ini',
  })}
            <div class="form-actions span-2">${submitBtn(T('a.add'), { ic: 'plus' })}</div>
          </form></div>
          <div class="card">${cardHead(T('login.changePw'))}<form method="post" action="/settings/password" class="form-grid">
            ${field({ label: T('stf.username'), name: 'username', value: '' })}
            ${field({ label: T('login.newPw'), name: 'password', value: '', required: true })}
            <div class="form-actions span-2">${submitBtn(T('login.changePw'), { ic: 'check' })}</div>
          </form></div>
        </div>`);
      } else if (tab === 'data') {
        const counts = {
          orders: num(get('SELECT COUNT(*) AS n FROM orders')?.n),
          trips: num(get('SELECT COUNT(*) AS n FROM trips')?.n),
          invoices: num(get('SELECT COUNT(*) AS n FROM invoices')?.n),
          payments: num(get('SELECT COUNT(*) AS n FROM payments')?.n),
          customers: num(get('SELECT COUNT(*) AS n FROM customers')?.n),
          items: num(get('SELECT COUNT(*) AS n FROM items')?.n),
          staff: num(get('SELECT COUNT(*) AS n FROM staff')?.n),
        };
        panel = card(cardHead(T('set.data')), `
          <p class="muted">${T('set.backupHint')}</p>
          <p class="tiny">${Object.entries(counts).map(([k, v]) => `${k}: <b>${v}</b>`).join(' · ')}</p>
          <div class="actions-row mt">
            ${linkBtn(T('set.downloadBackup'), '/settings/backup.db', { ic: 'download', variant: 'primary' })}
          </div>
          <div class="danger-zone mt">
            <h3>${T('set.dangerZone')}</h3>
            <p class="tiny">${T('set.resetWarn')}</p>
            <form method="post" action="/settings/reset" onsubmit="return confirm('${T('a.confirm')}?')">
              <input type="hidden" name="confirm" value="RESET">
              <button class="btn btn-danger" type="submit">${T('set.resetDemo')}</button></form>
          </div>`);
      } else if (tab === 'github') {
        panel = card(cardHead(T('set.github')), `
          <p class="tiny">${T('set.ghPrivateWarn')}</p>
          <form method="post" action="/settings/github-save" class="form-grid">
            ${f(T('set.ghRepo'), 'github_repo', s.github_repo || '', { placeholder: 'owner/kotamix-backups', required: true })}
            ${f(T('set.ghBranch'), 'github_branch', s.github_branch || 'main')}
            ${f(T('set.ghToken'), 'github_token', s.github_token || '', { type: 'password', hint: T('set.ghTokenHint') })}
            <div class="form-actions span-2">${submitBtn(T('a.save'), { ic: 'check' })}</div>
          </form>
          <form method="post" action="/settings/github-push" onsubmit="return confirm('${T('a.confirm')}?')">
            <button class="btn btn-primary" type="submit">${T('set.ghPush')}</button></form>`);
      }

      return html(ctx.res, page(ctx, { title: T('set.title'), body: tabsHtml + panel }));
    },
  },
  {
    method: 'POST', path: '/settings/users', role: ['admin'], handler(ctx) {
      const username = str(ctx.body.username).toLowerCase();
      if (!username || !str(ctx.body.password)) { ctx.flashMsg(ctx.t('a.required'), 'err'); return { __redirect: '/settings?tab=users' }; }
      if (get('SELECT id FROM users WHERE lower(username) = ?', username)) {
        ctx.flashMsg(username, 'err'); return { __redirect: '/settings?tab=users' };
      }
      const role = ['admin', 'office', 'driver'].includes(str(ctx.body.role)) ? str(ctx.body.role) : 'office';
      // Admin tidak terikat kepada satu cawangan; pengguna lain mesti ada cawangan.
      const bid = getBranch(int(ctx.body.branch_id) || ctx.bv())?.id ?? null;
      if (role !== 'admin' && !bid) {
        ctx.flashMsg('Cawangan wajib untuk office/driver / Branch required', 'err');
        return { __redirect: '/settings?tab=users' };
      }
      run(`INSERT INTO users (username, password_hash, name, role, branch_id, active, created_at) VALUES (?,?,?,?,?,1,?)`,
        username, hashPassword(str(ctx.body.password)), str(ctx.body.name), role, bid, new Date().toISOString());
      ctx.flashMsg(`${ctx.t('a.saved')}: ${username}`);
      return { __redirect: '/settings?tab=users' };
    },
  },
  {
    method: 'POST', path: '/settings/password', handler(ctx) {
      const u = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
      if (!verifyPassword(str(ctx.body.old_password), u.password_hash)) { ctx.flashMsg(ctx.t('login.failed'), 'err'); return { __redirect: '/settings?tab=users' }; }
      run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(str(ctx.body.password)), u.id);
      ctx.flashMsg(ctx.t('a.saved'));
      return { __redirect: '/settings?tab=users' };
    },
  },
  {
    method: 'GET', path: '/settings/backup.db', role: ['admin'], handler(ctx) {
      // Fold the WAL into the main file first so the copy is complete.
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
      const bytes = readFileSync(join(DATA_DIR, 'clsbiz.db'));
      ctx.res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes.length,
        'Content-Disposition': `attachment; filename="concrete-sabah-backup-${today()}.db"`,
      });
      ctx.res.end(bytes);
    },
  },
  {
    method: 'POST', path: '/settings/github-save', role: ['admin'], handler(ctx) {
      for (const k of ['github_repo', 'github_branch', 'github_token']) {
        setSetting(k, str(ctx.body[k]).trim());
      }
      if (!setting('github_branch')) setSetting('github_branch', 'main');
      ctx.flashMsg(ctx.t('a.saved'));
      return { __redirect: '/settings?tab=github' };
    },
  },
  {
    method: 'POST', path: '/settings/github-push', role: ['admin'], handler(ctx) {
      const repo = (setting('github_repo') || '').trim();
      const branch = (setting('github_branch') || 'main').trim() || 'main';
      const token = (setting('github_token') || '').trim();
      if (!repo.includes('/') || !token) {
        ctx.flashMsg(ctx.t('set.ghMissing'), 'err');
        return { __redirect: '/settings?tab=github' };
      }
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
      const bytes = readFileSync(join(DATA_DIR, 'clsbiz.db'));
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 12);
      const path = `backups/clsbiz-${stamp}.db`;
      return fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'kotamix-concrete',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `kotamix backup ${stamp}`,
          content: bytes.toString('base64'),
          branch,
        }),
      }).then(async (r) => {
        if (r.status === 201 || r.status === 200) {
          setSetting('github_last', new Date().toISOString());
          ctx.flashMsg(`${ctx.t('a.saved')}: ${path}`);
        } else {
          const j = await r.json().catch(() => ({}));
          ctx.flashMsg(`GitHub ${r.status}: ${j.message || 'error'}`, 'err');
        }
        return { __redirect: '/settings?tab=github' };
      }).catch((e) => {
        ctx.flashMsg(`GitHub: ${e.message}`, 'err');
        return { __redirect: '/settings?tab=github' };
      });
    },
  },
  {
    method: 'POST', path: '/settings/reset', role: ['admin'], handler(ctx) {
      if (str(ctx.body.confirm) !== 'RESET') {
        ctx.flashMsg(ctx.t('set.resetWarn'), 'err');
        return { __redirect: '/settings?tab=data' };
      }
      // Wipe transactional data only; keep users, settings and the catalogue.
      const wipe = [
        'stock_movements', 'fuel_logs', 'payments', 'online_payments', 'invoices',
        'trips', 'orders', 'purchase_items', 'purchases', 'attendance',
      ];
      tx(() => {
        for (const t of wipe) run(`DELETE FROM ${t}`);
        run('DELETE FROM counters');
        run('DELETE FROM sites');
        run('DELETE FROM customers');
        run('DELETE FROM stock_movements');
        run(`UPDATE lorries SET status = 'available', fuel_litres = 0`);
      });
      ctx.flashMsg(ctx.t('set.resetDone'));
      return { __redirect: '/settings?tab=data' };
    },
  },
  {
    // Generic tab saver — must stay LAST: /settings/:tab would shadow the
    // specific POST routes above (users, password, github-*, reset).
    method: 'POST', path: '/settings/:tab', role: ['admin'], handler(ctx) {
      const tab = ctx.params.tab;
      const keys = TAB_KEYS[tab];
      if (!keys) return { __redirect: '/settings' };
      for (const k of keys) setSetting(k, str(ctx.body[k]));
      ctx.flashMsg(ctx.t('a.saved'));
      return { __redirect: `/settings?tab=${tab}` };
    },
  },
];

function f(label, key, value, opts = {}) {
  return field({ label, name: key, value: value ?? '', ...opts });
}
function form(ctx, tab, keys, fieldsHtml) {
  return `<form method="post" action="/settings/${tab}" class="form-grid">
    ${fieldsHtml}
    <div class="form-actions span-2">${submitBtn(ctx.t('a.save'), { ic: 'check' })}</div>
  </form>`;
}
