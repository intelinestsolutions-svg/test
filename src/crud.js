/**
 * Generic CRUD engine driven by module manifests.
 *
 * Every resource in every module is served by the same code path: the manifest
 * declares the fields, this file turns them into list/read/create/update/delete
 * operations. Filtering, sorting, paging and validation are all derived from
 * the manifest, so a module never needs its own routes.
 */
import { run, get, all, logAudit } from './db.js';
import { tableName, getModule, isEnabled } from './registry.js';

const OPS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

/** Only fields declared in the manifest may be read or written. */
function fieldMap(resource) {
  return new Map(resource.fields.map((f) => [f.name, f]));
}

/** Signals "the value was unusable" as distinct from a legitimate null. */
const INVALID = Symbol('invalid');

/**
 * Converts a submitted value to the type the column expects.
 * Returns `null` for an empty optional field, `INVALID` when the value cannot
 * be used, and the converted value otherwise.
 */
function coerce(field, value) {
  if (value === undefined || value === null || value === '') {
    if (field.required) return INVALID;
    return null;
  }
  switch (field.type) {
    case 'number':
    case 'money': {
      const n = Number(value);
      return Number.isFinite(n) ? n : INVALID;
    }
    case 'relation': {
      // Stored as the target row id, so it must be a whole number.
      const n = Number(value);
      return Number.isInteger(n) && n > 0 ? n : INVALID;
    }
    case 'bool':
      return value === true || value === 'true' || value === 1 || value === '1' || value === 'on' ? 1 : 0;
    case 'date':
      // ISO calendar date only. Rejects "2026-13-45" and free text.
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim()) ? String(value).trim() : INVALID;
    case 'time':
      // 24-hour clock, optionally with seconds, as an <input type="time"> sends.
      return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(value).trim())
        ? String(value).trim() : INVALID;
    case 'datetime': {
      // A date and a time in one value: "2026-10-21T14:30" from the form, or
      // with seconds, or with a space instead of "T". Stored with a space so it
      // compares and sorts as text.
      const s = String(value).trim();
      const m = /^(\d{4}-\d{2}-\d{2})[T ](([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)$/.exec(s);
      return m ? `${m[1]} ${m[2]}` : INVALID;
    }
    default:
      return String(value);
  }
}

/**
 * Resolves a relation field to the table it points at.
 * Returns null when the target module or resource cannot be found.
 */
export function relationTarget(field) {
  const rel = field?.relation;
  if (!rel?.module || !rel?.resource) return null;
  const mod = getModule(rel.module);
  if (!mod) return null;
  const resource = mod.resources.find((r) => r.key === rel.resource);
  if (!resource) return null;
  return { mod, resource, table: tableName(rel.module, rel.resource) };
}

/** The field used to show a related record to a human. */
export function relationLabelField(target) {
  const wanted = target.relation?.label;
  if (wanted && target.resource.fields.some((f) => f.name === wanted)) return wanted;
  return target.resource.fields[0]?.name || 'id';
}

/**
 * Builds the write payload for a resource.
 * `partial` is for updates, where absent fields are left alone rather than
 * being reported as missing.
 */
function buildPayload(resource, body, { partial = false } = {}) {
  const data = {};
  const errors = [];
  for (const field of resource.fields) {
    const has = Object.prototype.hasOwnProperty.call(body || {}, field.name);
    if (!has) {
      if (!partial && field.required) errors.push(`${field.label || field.name} is required`);
      continue;
    }
    const value = coerce(field, body[field.name]);
    if (value === INVALID) {
      // Distinguish "you left this blank" from "this is not a valid value".
      const blank = body[field.name] === '' || body[field.name] === undefined || body[field.name] === null;
      errors.push(blank
        ? `${field.label || field.name} is required`
        : `${field.label || field.name} has an invalid value`);
      continue;
    }
    // A relation must point at a row that exists. Without this a deleted
    // record leaves dangling ids that render as blank with no explanation.
    if (field.type === 'relation' && value !== null) {
      const target = relationTarget(field);
      if (!target) {
        errors.push(`${field.label || field.name} is misconfigured (unknown target)`);
        continue;
      }
      const row = get(`SELECT id FROM "${target.table}" WHERE id = ?`, value);
      if (!row) {
        errors.push(`${field.label || field.name} refers to a record that does not exist`);
        continue;
      }
    }
    data[field.name] = value;
  }
  return { data, errors };
}

function resourceOf(moduleId, resourceKey) {
  const mod = getModule(moduleId);
  if (!mod) return { error: `Module "${moduleId}" not found`, status: 404 };
  if (!isEnabled(moduleId)) return { error: `Module "${moduleId}" is not installed`, status: 409 };
  const resource = mod.resources.find((r) => r.key === resourceKey);
  if (!resource) return { error: `Resource "${resourceKey}" not found`, status: 404 };
  return { mod, resource, table: tableName(moduleId, resource.key) };
}

/** Parses ?filter=field:op:value&sort=field&dir=asc&limit=n&offset=n */
function parseQuery(resource, query) {
  const fields = fieldMap(resource);
  const where = [];
  const params = [];

  const rawFilter = query.filter;
  if (rawFilter) {
    for (const term of (Array.isArray(rawFilter) ? rawFilter : [rawFilter])) {
      const [name, op = 'eq', ...rest] = String(term).split(':');
      const value = rest.join(':');
      const field = fields.get(name);
      if (!field) continue; // silently ignore unknown fields rather than error
      const sqlOp = op === 'like' ? 'LIKE' : OPS[op];
      if (!sqlOp) continue;
      if (op === 'like') {
        where.push(`"${name}" LIKE ?`);
        params.push(`%${value}%`);
      } else {
        // A filter value that will not convert is dropped rather than bound,
        // so a bad query never reaches SQLite (it would throw on a Symbol).
        const converted = coerce({ type: field.type }, value);
        if (converted === INVALID) continue;
        where.push(`"${name}" ${sqlOp} ?`);
        params.push(converted);
      }
    }
  }

  // Free-text search across text-ish fields.
  const search = query.q;
  if (search) {
    const textFields = resource.fields.filter((f) => ['text', 'textarea', 'select'].includes(f.type));
    if (textFields.length) {
      where.push(`(${textFields.map((f) => `"${f.name}" LIKE ?`).join(' OR ')})`);
      for (const _ of textFields) params.push(`%${search}%`);
    }
  }

  let sort = fields.has(query.sort) ? query.sort : 'id';
  const dir = String(query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number(query.offset) || 0, 0);

  return { where, params, sort, dir, limit, offset };
}

export function listRecords(moduleId, resourceKey, query = {}) {
  const r = resourceOf(moduleId, resourceKey);
  if (r.error) return r;
  const { table, resource } = r;
  const { where, params, sort, dir, limit, offset } = parseQuery(resource, query);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT * FROM "${table}" ${whereSql} ORDER BY "${sort}" ${dir} LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );
  const total = get(`SELECT COUNT(*) AS c FROM "${table}" ${whereSql}`, ...params)?.c ?? 0;
  return { data: rows, total, limit, offset };
}

/**
 * Every row of a related resource, as {id, label}.
 *
 * Used to fill a relation dropdown and, on read pages, to turn a stored id
 * into something a human can recognise. Loaded in one query per relation
 * rather than per row, so a 50-row list does not fire 50 queries.
 */
export function relationOptions(field) {
  const target = relationTarget(field);
  if (!target) return [];
  const labelField = relationLabelField({ relation: field.relation, resource: target.resource });
  try {
    return all(
      `SELECT id, "${labelField}" AS label FROM "${target.table}" ORDER BY "${labelField}" ASC`
    ).map((r) => ({ id: r.id, label: r.label ?? `#${r.id}` }));
  } catch {
    return [];
  }
}

/** All relation fields of a resource, as a name -> options lookup. */
export function relationOptionMap(resource) {
  const out = {};
  for (const field of resource.fields) {
    if (field.type === 'relation') out[field.name] = relationOptions(field);
  }
  return out;
}

/** The page path for a related row, so a value can be clicked through to it. */
export function relationHref(field, id) {
  const target = relationTarget(field);
  if (!target || id === null || id === undefined) return null;
  return `/m/${target.mod.id}/${target.resource.key}/${id}`;
}

export function getRecord(moduleId, resourceKey, id) {
  const r = resourceOf(moduleId, resourceKey);
  if (r.error) return r;
  const row = get(`SELECT * FROM "${r.table}" WHERE id = ?`, id);
  if (!row) return { error: 'Not found', status: 404 };
  return { data: row };
}

export function createRecord(moduleId, resourceKey, body, userId = null) {
  const r = resourceOf(moduleId, resourceKey);
  if (r.error) return r;
  const { data, errors } = buildPayload(r.resource, body);
  if (errors.length) return { error: errors.join('; '), status: 400 };
  if (!Object.keys(data).length) return { error: 'No recognised fields supplied', status: 400 };

  const cols = Object.keys(data);
  const info = run(
    `INSERT INTO "${r.table}" (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${cols.map(() => '?').join(', ')})`,
    ...cols.map((c) => data[c])
  );
  logAudit(userId, 'record.create', { module: moduleId, resource: resourceKey, id: info.lastInsertRowid });
  return { data: get(`SELECT * FROM "${r.table}" WHERE id = ?`, info.lastInsertRowid) };
}

export function updateRecord(moduleId, resourceKey, id, body, userId = null) {
  const r = resourceOf(moduleId, resourceKey);
  if (r.error) return r;
  if (!get(`SELECT id FROM "${r.table}" WHERE id = ?`, id)) {
    return { error: 'Not found', status: 404 };
  }
  const { data, errors } = buildPayload(r.resource, body, { partial: true });
  if (errors.length) return { error: errors.join('; '), status: 400 };
  if (!Object.keys(data).length) return { error: 'No recognised fields supplied', status: 400 };

  const cols = Object.keys(data);
  run(
    `UPDATE "${r.table}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')},
       updated_at = datetime('now')
     WHERE id = ?`,
    ...cols.map((c) => data[c]), id
  );
  logAudit(userId, 'record.update', { module: moduleId, resource: resourceKey, id });
  return { data: get(`SELECT * FROM "${r.table}" WHERE id = ?`, id) };
}

export function deleteRecord(moduleId, resourceKey, id, userId = null) {
  const r = resourceOf(moduleId, resourceKey);
  if (r.error) return r;
  const info = run(`DELETE FROM "${r.table}" WHERE id = ?`, id);
  if (!info.changes) return { error: 'Not found', status: 404 };
  logAudit(userId, 'record.delete', { module: moduleId, resource: resourceKey, id });
  return { data: { ok: true } };
}

export { buildPayload };
