/**
 * "Sign in with Google" / account linking, identity scope only.
 *
 * Deliberately limited to proving who someone is and reading their verified
 * email address and basic profile. It does not read mail or calendars, which
 * would drag the app into Google's "restricted scope" review.
 *
 * Implemented against node: built-ins only - the OAuth authorisation-code flow
 * is a few HTTP calls plus a signature check, none of which needs a library.
 *
 * Credentials come from the environment, never the database and never the
 * repository. When they are absent the feature reports itself as unavailable
 * and every entry point fails closed, so an unconfigured deploy is safe.
 */
import { createHash, randomBytes } from 'node:crypto';
import { run, get, all, logAudit } from './db.js';

// Overridable so the flow can be exercised against a stub during testing.
// Production always uses the real Google endpoints.
const AUTH_ENDPOINT = process.env.GOOGLE_AUTH_ENDPOINT || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = process.env.GOOGLE_TOKEN_ENDPOINT || 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = process.env.GOOGLE_USERINFO_ENDPOINT || 'https://openidconnect.googleapis.com/v1/userinfo';

// Identity + Calendar events so the connected user's Google account
// receives appointments saved in this app automatically.
const SCOPE = 'openid email profile https://www.googleapis.com/auth/calendar.events';

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// Must match the value registered in the Google Cloud console exactly.
export const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || 'https://test.prostudio.my/auth/google/callback';

/** True when the deploy has been given usable credentials. */
export function googleConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

/**
 * Why the feature is unavailable, for display. Returns null when it is usable.
 */
export function googleStatus() {
  if (googleConfigured()) return null;
  return 'Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID and '
    + 'GOOGLE_CLIENT_SECRET in the host environment, then restart.';
}

/* ------------------------------------------------------------------ *
 * State - a short-lived, single-use value that ties a callback back to
 * the browser that started it. Stored as a setting row so it survives
 * a restart and needs no extra table.
 * ------------------------------------------------------------------ */

const STATE_TTL_MS = 10 * 60 * 1000;

export function createState(intent) {
  const token = randomBytes(24).toString('base64url');
  const value = JSON.stringify({
    intent,                       // 'login' | 'link'
    at: Date.now(),
    token,
  });
  // Keep it under a key that is obviously temporary.
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    `google_state:${token}`, value
  );
  return token;
}

export function consumeState(token) {
  if (!token) return null;
  const key = `google_state:${token}`;
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return null;
  run('DELETE FROM settings WHERE key = ?', key);
  let parsed;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (!parsed || parsed.token !== token) return null;
  if (Date.now() - Number(parsed.at || 0) > STATE_TTL_MS) return null;
  return parsed;
}

/** Removes state rows that were never completed. */
export function pruneStates() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const row of all("SELECT key, value FROM settings WHERE key LIKE 'google_state:%'")) {
    try {
      const at = JSON.parse(row.value)?.at ?? 0;
      if (at < cutoff) run('DELETE FROM settings WHERE key = ?', row.key);
    } catch {
      run('DELETE FROM settings WHERE key = ?', row.key);
    }
  }
}

/* ------------------------------------------------------------------ *
 * OAuth steps
 * ------------------------------------------------------------------ */

export function authorizeUrl(state, { prompt = 'select_account' } = {}) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    state,
    prompt,
    access_type: 'online',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Exchanges the one-time code for tokens. Returns {error} on failure. */
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.access_token) {
      const detail = json?.error_description || json?.error || `HTTP ${res.status}`;
      return { error: `Google rejected the sign-in: ${detail}` };
    }
    return { data: json };
  } catch (err) {
    return { error: `Could not reach Google: ${err.message}` };
  }
}

/** Reads the signed-in user's basic profile. */
export async function fetchProfile(accessToken) {
  try {
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.sub) {
      return { error: `Google would not return a profile (HTTP ${res.status})` };
    }
    if (!json.email) return { error: 'That Google account did not share an email address.' };
    return { data: json };
  } catch (err) {
    return { error: `Could not reach Google: ${err.message}` };
  }
}

/* ------------------------------------------------------------------ *
 * Stored links
 * ------------------------------------------------------------------ */

export function getLink(userId) {
  return get('SELECT * FROM google_accounts WHERE user_id = ?', userId) || null;
}

export function findBySub(sub) {
  return get('SELECT * FROM google_accounts WHERE google_sub = ?', sub) || null;
}

export function findByEmail(email) {
  if (!email) return null;
  return get('SELECT * FROM google_accounts WHERE lower(email) = lower(?)', email) || null;
}

/**
 * Connects a Google identity to a local user. Replaces any previous link, so
 * reconnecting after a revoked token just works.
 */
export function linkAccount(userId, profile, tokens = {}) {
  const existing = findBySub(profile.sub);
  if (existing && existing.user_id !== userId) {
    return {
      error: `That Google account is already connected to "${existing.email}". `
        + 'Disconnect it there first.',
    };
  }
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
    : null;

  run(
    `INSERT INTO google_accounts
       (user_id, google_sub, email, email_verified, name, picture, access_token, refresh_token, expires_at, scopes, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       google_sub = excluded.google_sub,
       email = excluded.email,
       email_verified = excluded.email_verified,
       name = excluded.name,
       picture = excluded.picture,
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, google_accounts.refresh_token),
       expires_at = excluded.expires_at,
       scopes = excluded.scopes,
       connected_at = excluded.connected_at`,
    userId,
    String(profile.sub),
    String(profile.email),
    profile.email_verified ? 1 : 0,
    profile.name || null,
    profile.picture || null,
    tokens.access_token || null,
    tokens.refresh_token || null,
    expiresAt,
    tokens.scope || SCOPE
  );
  return { data: getLink(userId) };
}

export function unlinkAccount(userId) {
  const link = getLink(userId);
  if (!link) return { error: 'No Google account is connected.' };
  run('DELETE FROM google_accounts WHERE user_id = ?', userId);
  // Google tokens are not refreshable without the client secret and are
  // dropped with the row; nothing else needs revoking here.
  return { data: link };
}

export function markLogin(userId) {
  run("UPDATE google_accounts SET last_login_at = datetime('now') WHERE user_id = ?", userId);
}

export { logAudit };

/** A stable, non-reversible reference for logs - never the raw Google id. */
export function subFingerprint(sub) {
  return createHash('sha256').update(String(sub)).digest('hex').slice(0, 12);
}
