/**
 * Core schema + first-run setup.
 *
 * Runs on every boot and is safe to repeat: the CREATE TABLEs are
 * IF NOT EXISTS, and the default users are only inserted when the users table
 * is empty. That is what makes a fresh deploy self-initialising - no seed step
 * is needed on the host.
 */
import { db, run, get, hashPassword, setSetting, getSetting } from './db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',   -- admin | manager | staff
  active        INTEGER NOT NULL DEFAULT 1,
  lang          TEXT NOT NULL DEFAULT 'en',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_modules (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  PRIMARY KEY (user_id, module_id)
);

CREATE TABLE IF NOT EXISTS modules (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  version      TEXT,
  installed    INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`;

/** Defaults seeded on a fresh database. These are public - change them. */
const DEFAULT_USERS = [
  { username: 'admin', password: 'admin123', name: 'System Administrator', role: 'admin' },
  { username: 'manager', password: 'manager123', name: 'Demo Manager', role: 'manager' },
  { username: 'staff', password: 'staff123', name: 'Demo Staff', role: 'staff' },
];

export function initSchema() {
  db.exec(SCHEMA);

  // First boot marks the start of the grace window.
  if (!getSetting('first_boot_at')) {
    setSetting('first_boot_at', new Date().toISOString());
  }

  const count = get('SELECT COUNT(*) AS c FROM users')?.c ?? 0;
  if (count === 0) {
    for (const u of DEFAULT_USERS) {
      run(
        'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)',
        u.username, hashPassword(u.password), u.name, u.role
      );
    }
    console.log(
      '[db] Created default users: ' +
      DEFAULT_USERS.map((u) => `${u.username}/${u.password}`).join(', ')
    );
    console.log('[db] Change these passwords after the first login.');
  }
}
