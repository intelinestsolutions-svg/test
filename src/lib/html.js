/**
 * HTML rendering helpers: escaping, page layout, UI components.
 */
import { translate, LANGS } from '../i18n.js';

export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    // skip & that already forms a valid entity, so esc(esc(x)) === esc(x)
    .replace(/&(?!amp;|lt;|gt;|quot;|#39;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Decode one layer of esc() output so pre-escaped titles are not escaped twice. */
export function unesc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Escape exactly once, whether the input is raw or already escaped. */
export function escOnce(v) {
  return esc(unesc(v));
}

/** Tagged template that auto-escapes interpolations. Arrays are joined raw. */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    let s;
    if (v === null || v === undefined || v === false) s = '';
    else if (Array.isArray(v)) s = v.join('');
    else if (typeof v === 'object' && v.__raw) s = String(v);
    else s = esc(v);
    out += s + strings[i + 1];
  }
  return out;
}
/**
 * A pre-escaped string. It is a String subclass rather than a bare object so
 * that interpolating raw() into a PLAIN template literal still emits the value
 * instead of "[object Object]" — the `html` tag unwraps it via __raw, while
 * String coercion keeps plain templates correct.
 */
class RawString extends String {
  get __raw() { return true; }
}

export const raw = (value) => new RawString(value == null ? '' : String(value));

export const t = (lang, key) => translate(lang, key);

/* ---------- formatting ---------- */
export function money(v, lang = 'en') {
  const n = Number(v || 0);
  return (lang === 'bm' ? 'RM ' : 'RM ') + n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function money0(v) {
  return 'RM ' + Number(v || 0).toLocaleString('en-MY', { maximumFractionDigits: 0 });
}
export function qty(v, dp = 2) {
  return Number(v || 0).toLocaleString('en-MY', { maximumFractionDigits: dp });
}
export function fmtDate(iso, lang = 'en') {
  if (!iso) return '-';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const day = String(d.getDate()).padStart(2, '0');
  const mon = String(d.getMonth() + 1).padStart(2, '0');
  const yr = d.getFullYear();
  if (lang === 'bm') return `${day}-${mon}-${yr}`;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${names[d.getMonth()]} ${yr}`;
}

/* ---------- icons (inline svg, stroke style) ---------- */
const ICONS = {
  dashboard: '<path d="M3 3h7v7H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 14h7v7H3z"/>',
  orders: '<path d="M9 2h6a2 2 0 0 1 2 2h2a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2a2 2 0 0 1 2-2z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  deliveries: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  schedule: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
  invoice: '<path d="M6 2h9l4 4v16H6z"/><path d="M9 11h7M9 15h7M9 19h4"/>',
  payments: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  receivable: '<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  customers: '<circle cx="9" cy="8" r="3.5"/><path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/><path d="M17 8h5M19.5 5.5v5"/>',
  fleet: '<path d="M3 6h12v10H3zM15 9h4l2 3v4h-6z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16"/><path d="M3 21h11M6 9h6M6 13h6"/><path d="M15 8h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
  inventory: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v10"/>',
  mix: '<path d="M4 4h16v6a8 8 0 0 1-8 8 8 8 0 0 1-8-8z"/><path d="M8 8h8"/>',
  purchase: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 11a4 4 0 0 1-8 0"/>',
  staff: '<circle cx="12" cy="7" r="3.5"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  attendance: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 14l3 3 5-5"/>',
  payroll: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.5 2.5 1.5-1 1.5-2.5 1.5-2.5.5-2.5 1.5 1 1.5 2.5 1.5 2.5-.5 2.5-1.5"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11.5 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4z"/>',
  print: '<path d="M6 9V3h12v6M6 18H4v-6h16v6h-2"/><path d="M6 14h12v7H6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17.5v.5"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  truck: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v10"/>',
};
export function icon(name, size = 18) {
  const body = ICONS[name] || ICONS.box;
  return raw(`<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`);
}

/* ---------- layout ---------- */
const NAV = [
  { group: 'nav.group.ops', items: [
    ['/dashboard', 'dashboard', 'nav.dashboard'],
    ['/orders', 'orders', 'nav.orders'],
    ['/schedule', 'schedule', 'nav.schedule'],
    ['/deliveries', 'deliveries', 'nav.deliveries'],
  ] },
  { group: 'nav.group.finance', items: [
    ['/invoices', 'invoice', 'nav.invoices'],
    ['/payments', 'payments', 'nav.payments'],
    ['/receivables', 'receivable', 'nav.receivables'],
  ] },
  { group: 'nav.group.assets', items: [
    ['/fleet', 'fleet', 'nav.fleet'],
    ['/fuel', 'fuel', 'nav.fuel'],
    ['/inventory', 'inventory', 'nav.inventory'],
    ['/mix', 'mix', 'nav.mix'],
    ['/purchasing', 'purchase', 'nav.purchase'],
  ] },
  { group: 'nav.group.people', items: [
    ['/staff', 'staff', 'nav.staff'],
    ['/attendance', 'attendance', 'nav.attendance'],
    ['/payroll', 'payroll', 'nav.payroll'],
    ['/customers', 'customers', 'nav.customers'],
  ] },
  { group: 'nav.group.system', items: [
    ['/reports', 'reports', 'nav.reports'],
    ['/settings', 'settings', 'nav.settings'],
  ] },
];

function navHtml(ctx) {
  const { lang, url, user } = ctx;
  return NAV.map((g) => `
    <div class="nav-group">
      <div class="nav-group-title">${t(lang, g.group)}</div>
      ${g.items.map(([href, ic, key]) => {
        const active = url === href || (href !== '/dashboard' && url.startsWith(href + '/')) || (href === '/dashboard' && url === '/');
        // ---- siapa boleh nampak halaman mana ------------------------------
        // KHAS ADMIN: payroll, attendance, laporan.
        const adminOnly = ['/payroll', '/attendance', '/reports'];
        if (adminOnly.includes(href) && user.role !== 'admin') return '';

        // KEWANGAN: perlu kebenaran khas daripada admin; peranan 'office'
        // sahaja tidak mencukupi. Pemandu tidak pernah.
        const financePages = ['/invoices', '/payments', '/receivables'];
        if (financePages.includes(href) && !ctx.canFinance) return '';

        // PEKERJAAN: site & setting - admin sahaja.
        const officeOnly = ['/settings'];
        if (officeOnly.includes(href) && user.role !== 'admin') return '';

        // BEKALAN: pembelian & pembekal - pejabat + admin sahaja.
        // Pemandu boleh LIHAT diesel, fuel dan simpanan inventori, tetapi
        // tidak boleh membuat pesanan pembelian.
        const supplyPages = ['/purchasing', '/suppliers'];
        if (supplyPages.includes(href) && !['admin', 'office'].includes(user.role)) return '';

        // REKA BENTUK KONKRIT: teknikal/jurutera + admin sahaja.
        if (href === '/mix' && !['admin', 'lab'].includes(user.role)) return '';
        return `<a class="nav-item ${active ? 'on' : ''}" href="${href}">${icon(ic)}<span>${t(lang, key)}</span></a>`;
      }).join('')}
    </div>`).join('')
    + (user.role === 'admin' ? `
    <div class="nav-group">
      <div class="nav-group-title">Cawangan</div>
      <a class="nav-item ${url === '/branches' ? 'on' : ''}" href="/branches">${icon('settings')}<span>Cawangan</span></a>
    </div>` : '');
}

const TITLES = {
  '/dashboard': 'nav.dashboard', '/orders': 'nav.orders', '/schedule': 'nav.schedule',
  '/deliveries': 'nav.deliveries', '/invoices': 'nav.invoices', '/payments': 'nav.payments',
  '/receivables': 'nav.receivables', '/customers': 'nav.customers', '/fleet': 'nav.fleet',
  '/fuel': 'nav.fuel', '/inventory': 'nav.inventory', '/mix': 'nav.mix',
  '/purchasing': 'nav.purchase', '/staff': 'nav.staff', '/attendance': 'nav.attendance',
  '/payroll': 'nav.payroll', '/reports': 'nav.reports', '/settings': 'nav.settings',
};

/**
 * Pemilih cawangan - KHAS ADMIN sahaja.
 * Kakitangan terkunci kepada cawangan mereka sendiri, jadi mereka tidak
 * melihat pemilih ini langsung (ctx.canSeeAllBranches hanya true untuk admin).
 */
function branchSwitcher(ctx) {
  const list = ctx.branches || [];
  if (!list.length) return '';
  if (!ctx.canSeeAllBranches) return '';
  const cur = ctx.branchId === 'all' ? 'all' : (ctx.branchId ?? '');
  const opts = [`<option value="all"${cur === 'all' ? ' selected' : ''}>Semua Cawangan / All</option>`]
    .concat(list.map((b) => `<option value="${b.id}"${String(b.id) === String(cur) ? ' selected' : ''}>${esc(b.name)}</option>`))
    .join('');
  return `<form method="post" action="/branch/switch" class="branch-switch">
    <input type="hidden" name="next" value="${esc(ctx.fullUrl || '/dashboard')}">
    <select name="branch_id" onchange="this.form.submit()" aria-label="Cawangan">${opts}</select>
  </form>`;
}

export function layout(ctx, opts) {
  const { lang, url, user, flash, settings } = ctx;
  const title = opts.title || 'app.name';
  const T = (k) => esc(t(lang, k));
  const fullBleed = opts.fullBleed;

  const flashHtml = (flash || []).map((f) => {
    const type = f.type || 'ok';
    const ic = type === 'err' ? 'warn' : 'check';
    return `<div class="flash ${type}">${icon(ic, 16)}<span>${esc(f.msg)}</span><a class="flash-x" href="javascript:void(0)" onclick="this.parentElement.remove()">${icon('x', 14)}</a></div>`;
  }).join('');

  if (opts.bare) {
    // Standalone document view: no sidebar, no top bar - just the sheet.
    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title ? escOnce(opts.title) + ' · ' : ''}${T('app.short')}</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/css/app.css">
</head>
<body class="print-mode bare ${opts.cls || ''}">
${opts.toolbar === false ? '' : `<div class="print-bar no-print">
  <a class="btn btn-ghost" href="${opts.back || '/dashboard'}">${icon('back', 15)}<span>${T('a.back')}</span></a>
  <span class="print-hint">${T('doc.printNote')}</span>
  <button class="btn btn-primary" type="button" onclick="window.print()">${icon('print', 15)}<span>${T('a.print')}</span></button>
</div>`}
${opts.body}
<script src="/js/app.js"></script>
</body>
</html>`;
  }

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${opts.title ? escOnce(opts.title) + ' · ' : ''}${T('app.short')}</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/css/app.css">
</head>
<body class="${opts.print ? 'print-mode' : ''}">
<header class="topbar">
  <button class="icon-btn only-mobile" id="navToggle" aria-label="Menu">${icon('menu', 22)}</button>
  <a class="brand" href="/dashboard">
    <img class="brand-logo" src="/img/kotamix-logo.png" alt="Kotamix">
    <span class="brand-text">${T('app.name')}</span>
  </a>
  <div class="topbar-right">
    ${branchSwitcher(ctx)}
    <a class="lang-switch" href="/lang/${lang === 'bm' ? 'en' : 'bm'}" title="Tukar bahasa / Switch language">
      ${LANGS[lang].name === 'BM' ? 'BM | EN' : 'EN | BM'}
    </a>
    <span class="user-chip" title="${esc(user.name)}">
      <span class="avatar">${esc((user.name || '?').trim().charAt(0).toUpperCase())}</span>
      <span class="user-name">${esc(user.name)}</span>
      <span class="user-role">${T('set.role.' + user.role)}</span>
    </span>
    <a class="icon-btn" href="/logout" title="${T('a.logout')}">${icon('logout', 18)}</a>
  </div>
</header>
<div class="shell">
  <nav class="sidenav" id="sidenav">${navHtml(ctx)}</nav>
  <div class="sidenav-scrim" id="navScrim"></div>
  <main class="main ${fullBleed ? 'bleed' : ''}">
    ${flashHtml ? `<div class="flash-wrap">${flashHtml}</div>` : ''}
    ${opts.hideTitle ? '' : `<div class="page-head">
      <div><h1>${escOnce(opts.title || t(lang, 'app.name'))}</h1>
      ${opts.subtitle ? `<p class="sub">${esc(opts.subtitle)}</p>` : ''}</div>
      <div class="page-actions">${opts.actions || ''}</div>
    </div>`}
    ${opts.body}
  </main>
</div>
<script src="/js/app.js"></script>
${opts.script ? `<script>${opts.script}</script>` : ''}
</body>
</html>`;
}

/* ---------- components ---------- */
export function page(ctx, opts) { return layout(ctx, opts); }

export function card(inner, cls = '') {
  return raw(`<div class="card ${cls}">${inner}</div>`);
}
export function cardHead(title, right = '', lang = 'en') {
  return raw(`<div class="card-head"><h2>${esc(title)}</h2>${right ? `<div class="card-head-right">${right}</div>` : ''}</div>`);
}
export function btn(label, href, { ic = '', variant = '', cls = '', attrs = '' } = {}) {
  const v = variant ? `btn-${variant}` : '';
  return raw(`<a class="btn ${v} ${cls}" href="${href}" ${attrs}>${ic ? icon(ic, 15) : ''}<span>${esc(label)}</span></a>`);
}
export function submitBtn(label, { ic = '', variant = 'primary', cls = '', attrs = '' } = {}) {
  return raw(`<button class="btn btn-${variant} ${cls}" type="submit" ${attrs}>${ic ? icon(ic, 15) : ''}<span>${esc(label)}</span></button>`);
}
export function linkBtn(label, href, { ic = '', variant = 'ghost', cls = '', attrs = '' } = {}) {
  return raw(`<a class="btn btn-${variant} ${cls}" href="${href}" ${attrs}>${ic ? icon(ic, 15) : ''}<span>${esc(label)}</span></a>`);
}

/** Generic table. cols: [{key,label,align,width,cls,cell(row)}] */
export function table(cols, rows, { empty = true, emptyMsg = '', cls = '' } = {}) {
  if (!rows.length) {
    return empty ? raw(`<div class="empty">${icon('box', 26)}<p>${esc(emptyMsg || 'No records')}</p></div>`) : raw('');
  }
  const head = cols.map((c) => `<th class="${c.align ? 'ta-' + c.align : ''} ${c.cls || ''}" ${c.width ? `style="width:${c.width}"` : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map((r, i) => `<tr class="${r.__cls || ''}">${cols.map((c) => {
    const v = c.cell ? c.cell(r, i) : esc(r[c.key] ?? '');
    return `<td class="${c.align ? 'ta-' + c.align : ''} ${c.cls || ''}">${v}</td>`;
  }).join('')}</tr>`).join('');
  return raw(`<div class="table-wrap"><table class="tbl ${cls}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
}

export function badge(text, kind = '') {
  return raw(`<span class="badge ${kind}">${esc(text)}</span>`);
}
export function statusBadge(ctx, prefix, status) {
  const lang = ctx.lang;
  const label = t(lang, `${prefix}.${status}`);
  return badge(label || status, `st-${status}`);
}
export function statCard({ label, value, sub = '', tone = '', href = '', ic = '' }) {
  const inner = `<div class="stat ${tone}">
      <div class="stat-top"><span class="stat-label">${esc(label)}</span>${ic ? `<span class="stat-ic">${icon(ic, 17)}</span>` : ''}</div>
      <div class="stat-value">${value}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`;
  return href ? raw(`<a class="stat-link" href="${href}">${inner}</a>`) : raw(inner);
}
export function field({ label, name, type = 'text', value = '', required = false, hint = '', attrs = '', options = null, placeholder = '', step = '', cls = '' }) {
  let input;
  const v = value === null || value === undefined ? '' : value;
  if (options) {
    input = `<select name="${name}" ${attrs} class="${cls}">${options.map((o) => {
      const val = o.value ?? o; const lab = o.label ?? o; const sel = String(val) === String(v) ? ' selected' : '';
      return `<option value="${esc(val)}"${sel}>${esc(lab)}</option>`;
    }).join('')}</select>`;
  } else if (type === 'textarea') {
    input = `<textarea name="${name}" rows="3" ${attrs} class="${cls}" placeholder="${esc(placeholder)}">${esc(v)}</textarea>`;
  } else {
    input = `<input type="${type}" name="${name}" value="${esc(v)}" ${step ? `step="${step}"` : ''} ${attrs} class="${cls}" placeholder="${esc(placeholder)}"${required ? ' required' : ''}>`;
  }
  return `<label class="field ${cls}"><span class="field-label">${esc(label)}${required ? ' <i>*</i>' : ''}</span>${input}${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}</label>`;
}
export function checkbox({ label, name, checked = false, value = '1' }) {
  return `<label class="check"><input type="checkbox" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}><span>${esc(label)}</span></label>`;
}
export function hidden(name, value) {
  return `<input type="hidden" name="${name}" value="${esc(value ?? '')}">`;
}
export function alert(kind, text) {
  return raw(`<div class="alert ${kind}">${icon(kind === 'warn' ? 'warn' : 'check', 16)}<span>${esc(text)}</span></div>`);
}
export function tabs(ctx, items, current) {
  const l = (x) => esc(x);
  return raw(`<div class="tabs">${items.map(([href, label, n]) => `<a class="tab ${href === current ? 'on' : ''}" href="${href}">${l(label)}${n !== undefined ? `<b>${n}</b>` : ''}</a>`).join('')}</div>`);
}
export function filterBar(ctx, { action, fields = '' }) {
  return raw(`<form class="filters" method="get" action="${action}">
    <div class="filters-fields">${fields}</div>
    <div class="filters-btns">
      <button class="btn btn-primary" type="submit">${icon('search', 15)}<span>${t(ctx.lang, 'a.filter')}</span></button>
      <a class="btn btn-ghost" href="${action}">${t(ctx.lang, 'a.reset')}</a>
    </div>
  </form>`);
}
export function selectField({ name, label, options, value = '', onchange = '', cls = '' }) {
  return field({ label, name, value, options, cls, attrs: onchange ? `onchange="${onchange}"` : '' });
}
export function toolbar(text = '', buttons = '') {
  return raw(`<div class="toolbar">${text ? `<div class="toolbar-text">${text}</div>` : ''}<div class="toolbar-btns">${buttons}</div></div>`);
}
export function pager(ctx, { total, limit, offset, baseUrl, extra = '' }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return raw(`<div class="pager"><span>${t(ctx.lang, 'a.showing')} ${total} ${t(ctx.lang, 'a.records')}</span></div>`);
  const mk = (p) => `${baseUrl}?limit=${limit}&offset=${(p - 1) * limit}${extra}`;
  let out = `<span class="pager-info">${t(ctx.lang, 'a.showing')} ${offset + 1}–${Math.min(offset + limit, total)} daripada ${total}</span>`;
  out += `<div class="pager-links">`;
  if (page > 1) out += `<a class="pager-b" href="${mk(page - 1)}">‹</a>`;
  const range = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) range.push(p);
  if (range[0] > 1) out += `<a class="pager-b" href="${mk(1)}">1</a>`;
  if (range[0] > 2) out += `<span class="pager-gap">…</span>`;
  for (const p of range) out += `<a class="pager-b ${p === page ? 'on' : ''}" href="${mk(p)}">${p}</a>`;
  if (range[range.length - 1] < pages - 1) out += `<span class="pager-gap">…</span>`;
  if (range[range.length - 1] < pages) out += `<a class="pager-b" href="${mk(pages)}">${pages}</a>`;
  if (page < pages) out += `<a class="pager-b" href="${mk(page + 1)}">›</a>`;
  out += `</div>`;
  return raw(`<div class="pager">${out}</div>`);
}
