/**
 * Module registry - discovers modules from src/modules/<id>/manifest.json and
 * builds the table for each declared resource.
 *
 * Modules are pure data: a manifest lists resources and their fields, and the
 * generic CRUD engine serves them. Adding a module means adding a folder.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, run, get, all, logAudit } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MODULES_DIR = process.env.CRM_MODULES_DIR || join(__dirname, 'modules');

export function discoverModules() {
  if (!existsSync(MODULES_DIR)) return [];
  return readdirSync(MODULES_DIR)
    .filter((entry) => existsSync(join(MODULES_DIR, entry, 'manifest.json')))
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(MODULES_DIR, entry, 'manifest.json'), 'utf8')
      );
      return { ...manifest, id: manifest.id || entry };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getModule(id) {
  return discoverModules().find((m) => m.id === id) || null;
}

/** SQLite table for one resource. Prefixed so it can never collide. */
export function tableName(moduleId, resourceKey) {
  const clean = (s) => String(s).replace(/[^a-z0-9_]/gi, '_');
  return `m_${clean(moduleId)}_${clean(resourceKey)}`;
}

const SQL_TYPES = {
  text: 'TEXT', textarea: 'TEXT', select: 'TEXT', date: 'TEXT',
  // A calendar needs a time of day, not just a date. Both are stored as text
  // in ISO form, which sorts correctly and needs no conversion to display.
  datetime: 'TEXT', time: 'TEXT', email: 'TEXT', url: 'TEXT',
  number: 'REAL', money: 'REAL', bool: 'INTEGER',
  // A relation stores the target row's id. The column has to be INTEGER for
  // that to mean anything, so it is never inferred from the value.
  relation: 'INTEGER',
};

export function columnDDL(field) {
  const type = SQL_TYPES[field.type] || 'TEXT';
  let ddl = `"${field.name}" ${type}`;
  if (field.required) ddl += ' NOT NULL';
  if (field.unique) ddl += ' UNIQUE';
  if (field.default !== undefined) ddl += ` DEFAULT ${JSON.stringify(field.default)}`;
  return ddl;
}

function createResourceTable(moduleId, resource) {
  const table = tableName(moduleId, resource.key);
  const cols = resource.fields.map(columnDDL).join(', ');
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ${cols},
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export function syncRegistry() {
  for (const m of discoverModules()) {
    run(
      `INSERT INTO modules (id, name, installed, enabled, version)
       VALUES (?, ?, 0, 0, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version`,
      m.id, m.name, m.version || '1.0.0'
    );
  }
}

export function registry() {
  syncRegistry();
  const discovered = new Map(discoverModules().map((m) => [m.id, m]));
  return all('SELECT * FROM modules').map((row) => {
    const mod = discovered.get(row.id);
    return {
      ...row,
      available: Boolean(mod),
      description: mod?.description || '',
      icon: mod?.icon || '📦',
      resources: mod ? mod.resources.map((r) => ({ key: r.key, label: r.label })) : [],
    };
  });
}

export function installModule(id, userId = null) {
  const mod = getModule(id);
  if (!mod) throw new Error(`Module "${id}" not found`);
  for (const resource of mod.resources) createResourceTable(id, resource);
  run(
    `INSERT INTO modules (id, name, installed, enabled, version, installed_at)
     VALUES (?, ?, 1, 1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET installed = 1, enabled = 1`,
    id, mod.name, mod.version || '1.0.0'
  );
  logAudit(userId, 'module.install', { id });
  return mod;
}

export function setModuleEnabled(id, enabled, userId = null) {
  const res = run('UPDATE modules SET enabled = ? WHERE id = ? AND installed = 1', enabled ? 1 : 0, id);
  if (!res.changes) throw new Error(`Module "${id}" is not installed`);
  logAudit(userId, enabled ? 'module.enable' : 'module.disable', { id });
}

export function uninstallModule(id, userId = null) {
  const mod = getModule(id);
  if (mod) for (const r of mod.resources) db.exec(`DROP TABLE IF EXISTS "${tableName(id, r.key)}"`);
  run('DELETE FROM modules WHERE id = ?', id);
  run('DELETE FROM user_modules WHERE module_id = ?', id);
  logAudit(userId, 'module.uninstall', { id });
}

export function isEnabled(moduleId) {
  const row = get('SELECT installed, enabled FROM modules WHERE id = ?', moduleId);
  return Boolean(row && row.installed && row.enabled);
}

/** Installs every bundled module - run on first boot. */
export function installBundledModules() {
  for (const mod of discoverModules()) installModule(mod.id, null);
}
