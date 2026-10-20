/**
 * Module CRUD pages. One set of routes serves every module and resource:
 *
 *   GET  /m/:module                       module index
 *   GET  /m/:module/:resource             list (with ?q= search, ?sort=, ?page=)
 *   GET  /m/:module/:resource/new         create form
 *   POST /m/:module/:resource             create
 *   GET  /m/:module/:resource/:id         view
 *   GET  /m/:module/:resource/:id/edit    edit form
 *   POST /m/:module/:resource/:id         update
 *   POST /m/:module/:resource/:id/delete  delete
 */
import { html, esc } from '../lib/http.js';
import { layout, pageHeader, table, form } from '../lib/html.js';
import { getModule, isEnabled, tableName } from '../registry.js';
import { listRecords, getRecord, createRecord, updateRecord, deleteRecord } from '../crud.js';
import { get, all } from '../db.js';

const PAGE_SIZE = 25;

/** Loads a module+resource and checks the module is installed. */
function resolve(moduleId, resourceKey) {
  const mod = getModule(moduleId);
  if (!mod || !isEnabled(moduleId)) return null;
  const resource = mod.resources.find((r) => r.key === resourceKey);
  if (!resource) return null;
  return { mod, resource };
}

const guard = { module: true }; // checked against the :module param in the server
const guardParam = (params) => params.module;

function recordLink(moduleId, resource, row, fieldName) {
  const value = row[fieldName];
  const label = value === null || value === undefined || value === '' ? '—' : String(value);
  return `<a href="/m/${esc(moduleId)}/${esc(resource.key)}/${row.id}">${esc(label)}</a>`;
}

/** The first field is the natural label for a record. */
function labelField(resource) {
  return resource.fields[0]?.name || 'id';
}

export const moduleRoutes = [
  {
    method: 'GET',
    path: '/m/:module',
    module: true,
    moduleParam: 'module',
    handler: (ctx) => {
      const mod = getModule(ctx.params.module);
      if (!mod || !isEnabled(mod.id)) {
        ctx.flashMsg('That module is not available.', 'err');
        return { redirect: '/modules' };
      }
      const tiles = mod.resources.map((r) => {
        let count = 0;
        try {
          count = get(`SELECT COUNT(*) AS c FROM "${tableName(mod.id, r.key)}"`)?.c ?? 0;
        } catch { count = 0; }
        return `<a class="tile" href="/m/${esc(mod.id)}/${esc(r.key)}">
          <span class="n">${count}</span><span class="l">${esc(r.label)}</span></a>`;
      }).join('');

      return html(ctx.res, layout({
        title: mod.name,
        user: ctx.user,
        active: 'modules',
        flash: ctx.flash,
        body: `${pageHeader(`${mod.icon} ${mod.name}`, mod.description)}
               <div class="tiles">${tiles}</div>`,
      }));
    },
  },

  {
    method: 'GET',
    path: '/m/:module/:resource',
    module: true,
    moduleParam: 'module',
    handler: (ctx) => {
      const { mod, resource } = resolve(ctx.params.module, ctx.params.resource) || {};
      if (!mod) return { redirect: '/modules' };

      const page = Math.max(Number(ctx.query.page) || 1, 1);
      const result = listRecords(mod.id, resource.key, {
        q: ctx.query.q,
        sort: ctx.query.sort,
        dir: ctx.query.dir || 'desc',
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });

      const cols = [
        { label: '#', key: 'id' },
        ...resource.fields.slice(0, 5).map((f) => ({
          label: f.label || f.name,
          key: f.name,
          render: (row) => (f.type === 'money'
            ? esc(row[f.name] === null || row[f.name] === undefined ? '—' : Number(row[f.name]).toFixed(2))
            : esc(row[f.name] ?? '—')),
        })),
        {
          label: '',
          render: (row) => `<a href="/m/${esc(mod.id)}/${esc(resource.key)}/${row.id}/edit">Edit</a>`,
        },
      ];

      const total = result.total ?? 0;
      const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
      const pager = pages > 1
        ? `<div class="pager">
             ${page > 1 ? `<a class="btn small ghost" href="?page=${page - 1}${ctx.query.q ? `&q=${encodeURIComponent(ctx.query.q)}` : ''}">Previous</a>` : ''}
             <span class="muted">Page ${page} of ${pages} · ${total} records</span>
             ${page < pages ? `<a class="btn small ghost" href="?page=${page + 1}${ctx.query.q ? `&q=${encodeURIComponent(ctx.query.q)}` : ''}">Next</a>` : ''}
           </div>`
        : `<p class="muted">${total} record${total === 1 ? '' : 's'}</p>`;

      return html(ctx.res, layout({
        title: resource.label,
        user: ctx.user,
        active: 'modules',
        flash: ctx.flash,
        body: `
        ${pageHeader(resource.label, `${mod.name}${ctx.query.q ? ` · search “${ctx.query.q}”` : ''}`, `
          <a class="btn ghost" href="/m/${esc(mod.id)}">Back</a>
          <a class="btn" href="/m/${esc(mod.id)}/${esc(resource.key)}/new">New ${esc(resource.singular || resource.label)}</a>
        `)}
        <form method="get" class="searchbar">
          <input name="q" value="${esc(ctx.query.q || '')}" placeholder="Search ${esc(resource.label.toLowerCase())}">
          <button class="btn ghost">Search</button>
        </form>
        ${table({ columns: cols, rows: result.data || [], empty: `No ${String(resource.label).toLowerCase()} yet.` })}
        ${pager}`,
      }));
    },
  },

  {
    method: 'GET',
    path: '/m/:module/:resource/new',
    module: true,
    moduleParam: 'module',
    handler: (ctx) => {
      const { mod, resource } = resolve(ctx.params.module, ctx.params.resource) || {};
      if (!mod) return { redirect: '/modules' };
      if (!['admin', 'manager'].includes(ctx.user.role)) {
        ctx.flashMsg('Your role is read-only.', 'err');
        return { redirect: `/m/${mod.id}/${resource.key}` };
      }
      return html(ctx.res, layout({
        title: `New ${resource.singular || resource.label}`,
        user: ctx.user,
        active: 'modules',
        flash: ctx.flash,
        body: pageHeader(`New ${resource.singular || resource.label}`) +
          form({
            action: `/m/${mod.id}/${resource.key}`,
            resource,
            cancel: `/m/${mod.id}/${resource.key}`,
          }),
      }));
    },
  },

  {
    method: 'POST',
    path: '/m/:module/:resource',
    module: true,
    moduleParam: 'module',
    handler: (ctx) => {
      const { mod, resource } = resolve(ctx.params.module, ctx.params.resource) || {};
      if (!mod) return { redirect: '/modules' };
      const result = createRecord(mod.id, resource.key, ctx.body, ctx.user.id);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: `/m/${mod.id}/${resource.key}/new` };
      }
      ctx.flashMsg(`${resource.singular || resource.label} created.`);
      return { redirect: `/m/${mod.id}/${resource.key}/${result.data.id}` };
    },
  },

  {
    method: 'GET',
    path: '/m/:module/:resource/:id',
    module: true,
    moduleParam: 'module',
    handler: (ctx) => {
      const { mod, resource } = resolve(ctx.params.module, ctx.params.resource) || {};
      if (!mod) return { redirect: '/modules' };
      const result = getRecord(mod.id, resource.key, ctx.params.id);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: `/m/${mod.id}/${resource.key}` };
      }
      const row = result.data;
      const rows = resource.fields.map((f) => {
        const v = row[f.name];
        const shown = f.type === 'money' && v !== null && v !== undefined
          ? Number(v).toFixed(2)
          : (v === null || v === undefined || v === '' ? '—' : v);
        return `<dt>${esc(f.label || f.name)}</dt><dd>${esc(shown)}</dd>`;
      }).join('');

      return html(ctx.res, layout({
        title: `${resource.singular || resource.label} #${row.id}`,
        user: ctx.user,
        active: 'modules',
        flash: ctx.flash,
        body: `
        ${pageHeader(`${resource.singular || resource.label} #${row.id}`, '', `
          <a class="btn ghost" href="/m/${esc(mod.id)}/${esc(resource.key)}">Back</a>
          ${['admin', 'manager'].includes(ctx.user.role)
            ? `<a class="btn" href="/m/${esc(mod.id)}/${esc(resource.key)}/${row.id}/edit">Edit</a>` : ''}
        `)}
        <div class="card"><dl class="kv">${rows}</dl></div>
        <p class="muted small">Created ${esc(row.created_at || '')} · Updated ${esc(row.updated_at || '')}</p>`,
      }));
    },
  },

  {
    method: 'GET',
    path: '/m/:module/:resource/:id/edit',
    module: true,
    moduleParam: 'module',
    handler: (ctx) => {
      const { mod, resource } = resolve(ctx.params.module, ctx.params.resource) || {};
      if (!mod) return { redirect: '/modules' };
      if (!['admin', 'manager'].includes(ctx.user.role)) {
        ctx.flashMsg('Your role is read-only.', 'err');
        return { redirect: `/m/${mod.id}/${resource.key}` };
      }
      const result = getRecord(mod.id, resource.key, ctx.params.id);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: `/m/${mod.id}/${resource.key}` };
      }
      return html(ctx.res, layout({
        title: `Edit ${resource.singular || resource.label}`,
        user: ctx.user,
        active: 'modules',
        flash: ctx.flash,
        body: pageHeader(`Edit ${resource.singular || resource.label} #${result.data.id}`) +
          form({
            action: `/m/${mod.id}/${resource.key}/${result.data.id}`,
            resource,
            values: result.data,
            submit: 'Save changes',
            cancel: `/m/${mod.id}/${resource.key}/${result.data.id}`,
          }) +
          `<form method="post" action="/m/${esc(mod.id)}/${esc(resource.key)}/${result.data.id}/delete"
                  onsubmit="return confirm('Delete this record? This cannot be undone.')" class="card danger">
             <button class="btn danger">Delete ${esc(resource.singular || resource.label)}</button>
           </form>`,
      }));
    },
  },

  {
    method: 'POST',
    path: '/m/:module/:resource/:id',
    module: true,
    moduleParam: 'module',
    handler: (ctx) => {
      const { mod, resource } = resolve(ctx.params.module, ctx.params.resource) || {};
      if (!mod) return { redirect: '/modules' };
      const result = updateRecord(mod.id, resource.key, ctx.params.id, ctx.body, ctx.user.id);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: `/m/${mod.id}/${resource.key}/${ctx.params.id}/edit` };
      }
      ctx.flashMsg('Changes saved.');
      return { redirect: `/m/${mod.id}/${resource.key}/${ctx.params.id}` };
    },
  },

  {
    method: 'POST',
    path: '/m/:module/:resource/:id/delete',
    module: true,
    moduleParam: 'module',
    handler: (ctx) => {
      const { mod, resource } = resolve(ctx.params.module, ctx.params.resource) || {};
      if (!mod) return { redirect: '/modules' };
      if (ctx.user.role !== 'admin' && ctx.user.role !== 'manager') {
        ctx.flashMsg('Only admins and managers can delete records.', 'err');
        return { redirect: `/m/${mod.id}/${resource.key}` };
      }
      const result = deleteRecord(mod.id, resource.key, ctx.params.id, ctx.user.id);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: `/m/${mod.id}/${resource.key}` };
      }
      ctx.flashMsg(`${resource.singular || resource.label} deleted.`);
      return { redirect: `/m/${mod.id}/${resource.key}` };
    },
  },
];
