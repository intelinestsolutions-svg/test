/**
 * Core schema + first-run setup.
 *
 * Runs on every boot and is safe to repeat: the CREATE TABLEs are
 * IF NOT EXISTS, and the default users are only inserted when the users table
 * is empty. That is what makes a fresh deploy self-initialising - no seed step
 * is needed on the host.
 */
import { db, run, get, hashPassword, setSetting, getSetting } from './db.js';
import { initRoles } from './roles.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',   -- admin | manager | staff
  active        INTEGER NOT NULL DEFAULT 1,
  lang          TEXT NOT NULL DEFAULT 'en',
  email         TEXT,
  must_set_password      INTEGER NOT NULL DEFAULT 0,
  google_prompt_dismissed INTEGER NOT NULL DEFAULT 0,
  setup_complete         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_modules (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  access    TEXT NOT NULL DEFAULT 'full',   -- read | full
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

-- A Google account linked to a local user, used to prove identity only
-- (openid/email/profile). Tokens are stored so the connection can be listed and
-- revoked; the refresh token is the sensitive one and is only ever kept so the
-- user can disconnect cleanly.
CREATE TABLE IF NOT EXISTS google_accounts (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_sub      TEXT NOT NULL,          -- Google's stable subject id
  email           TEXT NOT NULL,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  name            TEXT,
  picture         TEXT,
  access_token    TEXT,
  refresh_token   TEXT,
  expires_at      TEXT,
  scopes          TEXT,
  connected_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_google_sub ON google_accounts(google_sub);

-- Failed one-time codes and outstanding invites. A row is consumed by the
-- action it was issued for, so a leaked link cannot be replayed.
CREATE TABLE IF NOT EXISTS one_time_tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL,               -- invite | reset | google_link
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ott_user ON one_time_tokens(user_id, purpose);

-- User types are data, so a business can define the ones it actually uses.
-- The builtin flag marks the roles a fresh install ships with; only is_admin
-- matters for permissions, and the last administrator role is protected in code.
CREATE TABLE IF NOT EXISTS roles (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  rank        INTEGER NOT NULL DEFAULT 100,
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Module access per role. Absent row means no access; 'read' allows viewing,
-- 'full' allows writing. A per-user grant in user_modules overrides this.
CREATE TABLE IF NOT EXISTS role_modules (
  role_key  TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  access    TEXT NOT NULL DEFAULT 'read',   -- read | full
  PRIMARY KEY (role_key, module_id)
);
`;

/** Defaults seeded on a fresh database. These are public - change them. */
const DEFAULT_USERS = [
  { username: 'admin', password: 'admin123', name: 'System Administrator', role: 'admin' },
  { username: 'manager', password: 'manager123', name: 'Demo Manager', role: 'manager' },
  { username: 'staff', password: 'staff123', name: 'Demo Staff', role: 'staff' },
];

/** Adds a column only when it is missing, so boot stays repeatable. */
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN ${definition}`);
  console.log(`[db] Added ${table}.${column}`);
  return true;
}

/**
 * Schema changes for databases created by an earlier build. Every step is
 * idempotent: the live site keeps its data across deploys, so boot must be able
 * to run against a database that is already partly up to date.
 */
function migrate() {
  // Accounts created before email addresses existed have none; the column is
  // nullable so those rows stay valid.
  addColumnIfMissing('users', 'email', 'email TEXT');
  addColumnIfMissing('users', 'must_set_password', 'must_set_password INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'google_prompt_dismissed', 'google_prompt_dismissed INTEGER NOT NULL DEFAULT 0');
  // Set once the administrator has defined their user types.
  addColumnIfMissing('users', 'setup_complete', 'setup_complete INTEGER NOT NULL DEFAULT 0');
  // Personal module grants gained a level, so a per-user grant can be read-only
  // as well as full. Existing rows predate this and mean "full".
  addColumnIfMissing('user_modules', 'access', "access TEXT NOT NULL DEFAULT 'full'");
  // Track which Google Calendar event corresponds to an appointment in this app.
  try {
    if (!db.prepare("SELECT name FROM pragma_table_info('m_calendar_events') WHERE name='google_event_id'").get()) {
      // Table might not exist yet on a fresh install; migration adds to live tables.
    }
  } catch {}
  // Easier: just try adding; if the table doesn't exist, the schema DDL will
  // handle fresh installs.
  try { db.exec("ALTER TABLE m_calendar_events ADD COLUMN google_event_id TEXT"); } catch {}
}

export function initSchema() {
  db.exec(SCHEMA);
  migrate();
  initRoles();

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
