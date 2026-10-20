/**
 * Dashboard and other top-level pages.
 */
import { html, esc } from '../lib/http.js';
import { layout, pageHeader } from '../lib/html.js';
import { registry } from '../registry.js';
import { listUsers, auditLog } from '../auth.js';
import { get } from '../db.js';
import { tableName } from '../registry.js';

export const pageRoutes = [
  {
    method: 'GET',
    path: '/',
    handler: (ctx) => ({ redirect: ctx.user ? '/dashboard' : '/login' }),
  },
  {
    method: 'GET',
    path: '/dashboard',
    handler: (ctx) => {
      const mods = registry().filter((m) => m.installed && m.enabled);

      // Count rows in each enabled resource - a quick "is there data" view.
      const cards = mods.map((m) => {
        const rows = m.resources.map((r) => {
          let count = 0;
          try {
            count = get(`SELECT COUNT(*) AS c FROM "${tableName(m.id, r.key)}"`)?.c ?? 0;
          } catch {
            count = 0;
          }
          return `<a class="tile" href="/m/${esc(m.id)}/${esc(r.key)}">
            <span class="n">${count}</span><span class="l">${esc(r.label)}</span></a>`;
        }).join('');
        return `<section class="mod">
          <h2>${esc(m.icon)} ${esc(m.name)}</h2>
          <p class="muted">${esc(m.description)}</p>
          <div class="tiles">${rows}</div>
        </section>`;
      }).join('');

      const stats = ctx.user.role === 'admin'
        ? `<div class="stats">
            <div class="stat"><span class="n">${listUsers().length}</span><span class="l">Users</span></div>
            <div class="stat"><span class="n">${mods.length}</span><span class="l">Active modules</span></div>
           </div>`
        : '';

      return html(ctx.res, layout({
        title: 'Dashboard',
        user: ctx.user,
        active: 'dashboard',
        flash: ctx.flash,
        body: `
        ${pageHeader(`Welcome, ${ctx.user.name}`)}
        ${stats}
        ${cards || '<p class="muted">No modules are installed.</p>'}`,
      }));
    },
  },
  {
    method: 'GET',
    path: '/modules',
    handler: (ctx) => {
      const rows = registry().map((m) => `
        <tr>
          <td>${esc(m.icon)} <strong>${esc(m.name)}</strong><br><span class="muted">${esc(m.description)}</span></td>
          <td>${esc(m.version || '')}</td>
          <td>${m.installed ? (m.enabled ? '<span class="pill on">enabled</span>' : '<span class="pill">disabled</span>') : '<span class="pill off">not installed</span>'}</td>
          <td>${m.resources.map((r) => `<a href="/m/${esc(m.id)}/${esc(r.key)}">${esc(r.label)}</a>`).join(' · ') || '<span class="muted">—</span>'}</td>
          <td class="right">
            ${ctx.user.role === 'admin' ? `
              ${m.installed
                ? `<form method="post" action="/admin/modules/${esc(m.id)}/toggle" class="inline">
                     <input type="hidden" name="enabled" value="${m.enabled ? '0' : '1'}">
                     <button class="btn small">${m.enabled ? 'Disable' : 'Enable'}</button>
                   </form>`
                : `<form method="post" action="/admin/modules/${esc(m.id)}/install" class="inline">
                     <button class="btn small">Install</button>
                   </form>`}
            ` : ''}
          </td>
        </tr>`).join('');

      return html(ctx.res, layout({
        title: 'Modules',
        user: ctx.user,
        active: 'modules',
        flash: ctx.flash,
        body: `
        ${pageHeader('Modules')}
        <table class="grid">
          <thead><tr><th>Module</th><th>Version</th><th>Status</th><th>Resources</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`,
      }));
    },
  },
];
