/**
 * One-time links for invites and password resets.
 *
 * A new user cannot be emailed without a mail provider, so instead the admin is
 * shown a single-use link to pass on however they like. The same mechanism
 * covers resets. Tokens are stored hashed, expire, and are consumed on use, so
 * a link that leaks cannot be replayed and a stolen database does not yield
 * working links.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { run, get, all } from './db.js';

const TTL = {
  invite: 7 * 24 * 60 * 60 * 1000,   // a week to accept an invitation
  reset: 60 * 60 * 1000,             // an hour to set a new password
  google_link: 15 * 60 * 1000,       // a quarter hour to finish linking
};

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues a token and returns the raw value. Only the hash is stored, so this is
 * the one and only time the link can be produced.
 */
export function issueToken(userId, purpose) {
  if (!TTL[purpose]) throw new Error(`Unknown token purpose: ${purpose}`);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL[purpose]).toISOString();
  // Supersede any earlier unused token of the same kind for this user.
  run('DELETE FROM one_time_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL', userId, purpose);
  run(
    'INSERT INTO one_time_tokens (token, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)',
    hashToken(token), userId, purpose, expiresAt
  );
  return { token, expiresAt };
}

/**
 * Validates and consumes a token. Returns the user id, or an error string.
 * Consumption is a conditional update, so two simultaneous uses cannot both win.
 */
export function consumeToken(token, purpose) {
  if (!token) return { error: 'That link is not valid.' };
  const row = get('SELECT * FROM one_time_tokens WHERE token = ?', hashToken(token));
  if (!row) return { error: 'That link is not valid.' };
  if (row.purpose !== purpose) return { error: 'That link is not valid.' };
  if (row.used_at) return { error: 'That link has already been used.' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { error: 'That link has expired. Ask an administrator for a new one.' };
  }
  const claimed = run(
    'UPDATE one_time_tokens SET used_at = datetime(\'now\') WHERE token = ? AND used_at IS NULL',
    row.token
  );
  if (!claimed.changes) return { error: 'That link has already been used.' };
  return { userId: row.user_id };
}

/** Looks up a token without consuming it, for rendering "set your password". */
export function peekToken(token, purpose) {
  if (!token) return null;
  const row = get('SELECT * FROM one_time_tokens WHERE token = ?', hashToken(token));
  if (!row || row.purpose !== purpose || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export function revokeTokens(userId, purpose) {
  run('DELETE FROM one_time_tokens WHERE user_id = ? AND purpose = ?', userId, purpose);
}

/** Housekeeping so the table does not grow without bound. */
export function pruneTokens() {
  run("DELETE FROM one_time_tokens WHERE expires_at < datetime('now') OR used_at IS NOT NULL");
}

export function countOutstanding(userId, purpose) {
  return all(
    'SELECT 1 FROM one_time_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL',
    userId, purpose
  ).length;
}

export { timingSafeEqual };
