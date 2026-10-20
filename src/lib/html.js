/**
 * HTML rendering - replaces the Next.js frontend.
 *
 * Pages are rendered on the server and sent as complete documents, so there is
 * no build step and no client framework to bundle.
 */
import { esc } from './http.js';

export function layout({ title, user, body, flash = [], active = '' }) {
  const nav = user
    ? `
    <nav class="nav">
      <a href="/dashboard" class="${active === 'dashboard' ? 'on' : ''}">Dashboard</a>
      <a href="/modules" class="${active === 'modules' ? 'on' : ''}">Modules</a>
      ${user.role === 'admin' ? `<a href="/admin/users" class="${active === 'users' ? 'on' : ''}">Users</a>` : ''}
      ${user.role === 'admin' ? `<a href="/admin/audit" class="${active === 'audit' ? 'on' : ''}">Audit</a>` : ''}
      <span class="spacer"></span>
      <span class="who">${esc(user.name)} <span class="role">${esc(user.role)}</span></span>
      <a href="/profile" class="${active === 'profile' ? 'on' : ''}">Profile</a>
      <form method="post" action="/logout" class="inline"><button class="link">Sign out</button></form>
    </nav>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Studio Pro CRM</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
${nav}
<main class="wrap">
  ${flash.length ? flash.map((f) => `<div class="flash ${esc(f.type || 'ok')}">${esc(f.msg)}</div>`).join('') : ''}
  ${body}
</main>
</body>
</html>`;
}

export function table({ columns, rows, empty = 'Nothing here yet.' }) {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<table class="grid">
  <thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
  <tbody>
  ${rows.map((row) => `<tr>${columns.map((c) => `<td>${c.render ? c.render(row) : esc(row[c.key] ?? '')}</td>`).join('')}</tr>`).join('')}
  </tbody>
</table>`;
}

/** Renders a form from a resource manifest. */
export function form({ action, resource, values = {}, submit = 'Save', cancel = null }) {
  const fields = resource.fields.map((f) => {
    const v = values[f.name];
    const val = v === null || v === undefined ? '' : String(v);
    const label = `<label for="f_${esc(f.name)}">${esc(f.label || f.name)}${f.required ? ' <span class="req">*</span>' : ''}</label>`;

    if (f.type === 'textarea') {
      return `<div class="field">${label}<textarea id="f_${esc(f.name)}" name="${esc(f.name)}" rows="3">${esc(val)}</textarea></div>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || [])
        .map((o) => `<option value="${esc(o)}"${val === o ? ' selected' : ''}>${esc(o)}</option>`)
        .join('');
      const blank = f.required ? '' : `<option value=""${val === '' ? ' selected' : ''}></option>`;
      return `<div class="field">${label}<select id="f_${esc(f.name)}" name="${esc(f.name)}">${blank}${opts}</select></div>`;
    }
    const type = f.type === 'money' || f.type === 'number' ? 'number'
      : f.type === 'date' ? 'date'
      : 'text';
    const step = f.type === 'money' ? ' step="0.01"' : '';
    return `<div class="field">${label}<input id="f_${esc(f.name)}" type="${type}"${step} name="${esc(f.name)}" value="${esc(val)}"></div>`;
  }).join('\n');

  return `<form method="post" action="${esc(action)}" class="card form">
  ${fields}
  <div class="actions">
    <button type="submit" class="btn">${esc(submit)}</button>
    ${cancel ? `<a class="btn ghost" href="${esc(cancel)}">Cancel</a>` : ''}
  </div>
</form>`;
}

export function pageHeader(title, subtitle = '', actions = '') {
  return `<header class="page">
    <div><h1>${esc(title)}</h1>${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ''}</div>
    <div class="page-actions">${actions}</div>
  </header>`;
}
