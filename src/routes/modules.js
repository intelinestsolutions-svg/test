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
import {
  listRecords, getRecord, createRecord, updateRecord, deleteRecord,
  relationOptionMap, relationOptions, relationHref, relationTarget, relationLabelField,
} from '../crud.js';
import { getModule, isEnabled, tableName } from '../registry.js';
import { get, all, run } from '../db.js';
import { syncEventToGoogle } from '../gcal.js';
import { sendGmail } from '../gmail.js';
import { can } from '../auth.js';

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

      // Resolve relation targets once per table, not once per row.
      const relOptions = relationOptionMap(resource);
      const relLabels = {};
      for (const [name, opts] of Object.entries(relOptions)) {
        relLabels[name] = new Map(opts.map((o) => [String(o.id), o.label]));
      }

      const cols = [
        { label: '#', key: 'id' },
        ...resource.fields.slice(0, 5).map((f) => ({
          label: f.label || f.name,
          key: f.name,
          render: (row) => {
            const v = row[f.name];
            if (v === null || v === undefined || v === '') return '—';
            if (f.type === 'money') return esc(Number(v).toFixed(2));
            if (f.type === 'relation') {
              const label = relLabels[f.name]?.get(String(v)) ?? `#${v}`;
              const href = relationHref(f, v);
              return href
                ? `<a href="${esc(href)}">${esc(label)}</a>`
                : esc(label);
            }
            return esc(v);
          },
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
          ${(mod.id === 'calendar' && resource.key === 'events') ? `<a class="btn ghost" href="/m/${esc(mod.id)}/${esc(resource.key)}/calendar">Calendar</a> ` : ''}<a class="btn" href="/m/${esc(mod.id)}/${esc(resource.key)}/new">New ${esc(resource.singular || resource.label)}</a>
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
      if (!can(ctx.user, mod.id, 'write')) {
        ctx.flashMsg('You do not have permission to change records in this module.', 'err');
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
            relations: relationOptionMap(resource),
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
        ctx.flashMsg(`${resource.singular || resource.label} created.`);
        if (mod.id === "calendar" && resource.key === "events") {
          try {
            const ev = getRecord(mod.id, resource.key, result.data.id);
            syncEventToGoogle(ctx.user.id, ev?.data || result.data, "upsert").then((r) => {
              if (r?.google_event_id && result.data?.id) {
                try { run("UPDATE m_calendar_events SET google_event_id = ? WHERE id = ?", r.google_event_id, result.data.id); } catch {}
              }
            }).catch(() => {});
          } catch {}
        }
    },
  },

  {
    method: 'GET',
    path: '/m/:module/:resource/calendar',
    module: true,
    moduleParam: 'module',
    handler: (ctx) => {
      if (!(ctx.params.module === 'calendar' && ctx.params.resource === 'events')) {
        return { redirect: '/m/' + esc(ctx.params.module) + '/' + esc(ctx.params.resource) };
      }
      const mod = getModule(ctx.params.module);
      const resource = mod && mod.resources ? mod.resources.find((r) => r.key === ctx.params.resource) : null;
      if (!mod || !resource) return { redirect: '/modules' };

      const now = new Date();
      const year = Number(ctx.query.year) || now.getFullYear();
      const month = Number(ctx.query.month) || (now.getMonth() + 1);
      const d = new Date(Date.UTC(year, month - 1, 1));
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const first = new Date(Date.UTC(y, m, 1));
      const last = new Date(Date.UTC(y, m + 1, 0));
      const daysInMonth = last.getUTCDate();
      const startDow = first.getUTCDay();

      const mm1 = String(m + 1).padStart(2, '0');
      const mm0 = String(m).padStart(2, '0');
      let rows = [];
      try {
        rows = all('SELECT * FROM "' + tableName(mod.id, resource.key) + '" WHERE starts_at LIKE ? OR starts_at LIKE ?', y + '-' + mm1 + '-%', y + '-' + mm0 + '-%');
      } catch (e) {
        rows = [];
      }
      const monthKey = y + '-' + mm1;
      const events = rows
        .filter((r) => String(r.starts_at || '').indexOf(monthKey) === 0)
        .sort((a, b) => String(a.starts_at || '').localeCompare(String(b.starts_at || '')));

      const eventsByDay = {};
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const day = parseInt(String(ev.starts_at).slice(8, 10), 10);
        if (!eventsByDay[day]) eventsByDay[day] = [];
        eventsByDay[day].push(ev);
      }

      const monthName = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      const prev = new Date(Date.UTC(y, m - 1, 1));
      const nxt = new Date(Date.UTC(y, m + 1, 1));

      let cells = '';
      for (let i = 0; i < startDow; i++) cells += '<td class="cal blank"></td>';
      let day = 1;
      while (day <= daysInMonth) {
        const evs = eventsByDay[day] || [];
        let evHtml = '';
        for (let j = 0; j < Math.min(3, evs.length); j++) {
          const ev = evs[j];
          const t = String(ev.starts_at || '').slice(11, 16);
          evHtml += '<a class="cal-ev" href="/m/' + esc(mod.id) + '/' + esc(resource.key) + '/' + ev.id + '">' + esc(t ? t + ' ' : '') + esc(ev.title || ('#' + ev.id)) + '</a>';
        }
        const more = evs.length > 3 ? '<div class="cal-more">+' + (evs.length - 3) + ' more</div>' : '';
        const today = (now.getUTCFullYear() === y && now.getUTCMonth() === m && now.getUTCDate() === day) ? ' today' : '';
        cells += '<td class="cal day' + today + '"><div class="cal-date">' + day + '</div>' + evHtml + more + '</td>';
        if ((startDow + day) % 7 === 0) cells += '</tr><tr>';
        day += 1;
      }

      return html(ctx.res, layout({
        title: mod.name + ' — ' + monthName,
        user: ctx.user,
        active: 'modules',
        flash: ctx.flash,
        body: pageHeader(mod.name + ': ' + monthName, '', 
          '<a class="btn ghost" href="/m/' + esc(mod.id) + '/' + esc(resource.key) + '">List</a> ' +
          '<a class="btn" href="/m/' + esc(mod.id) + '/' + esc(resource.key) + '/new">New event</a>'
        ) +
        '<div class="card cal-wrap">' +
          '<div class="cal-nav">' +
            '<a class="btn small ghost" href="/m/' + esc(mod.id) + '/' + esc(resource.key) + '/calendar?year=' + prev.getUTCFullYear() + '&month=' + (prev.getUTCMonth() + 1) + '">← Prev</a> ' +
            '<span class="cal-title">' + esc(monthName) + '</span> ' +
            '<a class="btn small ghost" href="/m/' + esc(mod.id) + '/' + esc(resource.key) + '/calendar?year=' + nxt.getUTCFullYear() + '&month=' + (nxt.getUTCMonth() + 1) + '">Next →</a>' +
          '</div>' +
          '<table class="cal"><thead><tr><th>Sun</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th></tr></thead><tbody><tr>' + cells + '</tr></tbody></table>' +
        '</div>',
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
      if (!can(ctx.user, mod.id, 'write')) {
        ctx.flashMsg('You do not have permission to change records in this module.', 'err');
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
        body: pageHeader(`Edit ${resource.singular || resource.label} #${result.data.id}`, '', (mod.id === 'calendar' && resource.key === 'events') ? `<a class="btn ghost" href="/m/${esc(mod.id)}/${esc(resource.key)}/calendar">Calendar</a> <a class="btn ghost" href="/m/${esc(mod.id)}/${esc(resource.key)}/${result.data.id}">View</a>` : `<a class="btn ghost" href="/m/${esc(mod.id)}/${esc(resource.key)}/${result.data.id}">Back</a>`) +
          form({
            action: `/m/${mod.id}/${resource.key}/${result.data.id}`,
            resource,
            values: result.data,
            relations: relationOptionMap(resource),
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
      if (mod.id === "calendar" && resource.key === "events") {
        try {
          const ev = getRecord(mod.id, resource.key, ctx.params.id);
          syncEventToGoogle(ctx.user.id, ev?.data || { id: ctx.params.id }, "upsert").catch(() => {});
        } catch {}
      }
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
      if (!can(ctx.user, mod.id, 'write')) {
        ctx.flashMsg('You do not have permission to delete records in this module.', 'err');
        return { redirect: `/m/${mod.id}/${resource.key}` };
      }
      const existing = (mod.id === 'calendar' && resource.key === 'events') ? getRecord(mod.id, resource.key, ctx.params.id)?.data : null;
      const result = deleteRecord(mod.id, resource.key, ctx.params.id, ctx.user.id);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: `/m/${mod.id}/${resource.key}` };
      }
      if (mod.id === 'calendar' && resource.key === 'events') {
        try { syncEventToGoogle(ctx.user.id, existing || { id: ctx.params.id }, 'delete').catch(() => {}); } catch {}
      }
      ctx.flashMsg(`${resource.singular || resource.label} deleted.`);
      return { redirect: `/m/${mod.id}/${resource.key}` };
    },
  },
];
