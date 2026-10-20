/**
 * Database layer - uses Node's built-in node:sqlite. No external packages,
 * so nothing has to be compiled on the host (this is what made the previous
 * better-sqlite3 build impossible to deploy).
 *
 * Two behaviours of node:sqlite drive the shape of this file:
 *   - binding `undefined` THROWS, so every optional value must become null
 *   - numbers bound into TEXT columns come back as "1.0", so values are
 *     coerced to the type their column expects before binding
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

export const DATA_DIR = process.env.CRM_DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'crm.db'));

// Sensible defaults; WAL keeps reads from blocking on writes.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * The running build, reported on every response as X-App-Build so a deploy
 * can prove which commit is actually answering (an old process keeps serving
 * old code until it is restarted).
 */
export const APP_BUILD = readBuild();

function readBuild() {
  try {
    const raw = readFileSync(join(ROOT, 'build.json'), 'utf8');
    return JSON.parse(raw).sha?.slice(0, 7) || 'dev';
  } catch {
    return 'dev';
  }
}

// ---------------------------------------------------------------------------
// Value coercion - see the note at the top of this file.
// ---------------------------------------------------------------------------
function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null) return null;
  return String(value);
}

/** Rewrites `?` placeholders into named ones, coercing each argument. */
function bind(args) {
  return args.map(bindable);
}

export function run(sql, ...args) {
  return db.prepare(sql).run(...bind(args));
}

export function get(sql, ...args) {
  return db.prepare(sql).get(...bind(args));
}

export function all(sql, ...args) {
  return db.prepare(sql).all(...bind(args));
}

// ---------------------------------------------------------------------------
// Passwords - scrypt from node:crypto replaces bcryptjs.
// Format keeps the algorithm and salt with the hash so it is self-describing.
// ---------------------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    // Constant-time compare - a length mismatch would make it throw.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sessions - a table instead of express-session.
// ---------------------------------------------------------------------------
export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  run(
    `INSERT INTO sessions (token, user_id, created_at, expires_at)
     VALUES (?, ?, datetime('now'), datetime('now', '+30 days'))`,
    token, userId
  );
  return token;
}

export function userForToken(token) {
  if (!token) return null;
  const row = get(
    `SELECT u.id, u.username, u.name, u.role, u.active, u.lang, u.email,
            u.must_set_password, u.setup_complete
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`,
    token
  );
  return row || null;
}

export function destroySession(token) {
  if (!token) return;
  run('DELETE FROM sessions WHERE token = ?', token);
}

export function purgeExpiredSessions() {
  run(`DELETE FROM sessions WHERE expires_at <= datetime('now')`);
}

// ---------------------------------------------------------------------------
// Settings + audit
// ---------------------------------------------------------------------------
export function allSettings() {
  const out = {};
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

export function getSetting(key, fallback = null) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : fallback;
}

export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key, String(value)
  );
}

export function logAudit(userId, action, detail) {
  run(
    'INSERT INTO audit_log (user_id, action, detail) VALUES (?, ?, ?)',
    userId ?? null, action, detail ? JSON.stringify(detail) : null
  );
}

export { createHash };
