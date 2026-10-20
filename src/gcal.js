/**
 * Google Calendar API helper (node built-ins only).
 * Uses the access/refresh tokens stored per connected Google account.
 * When saving appointments in the app, we mirror them to the user's
 * connected Google Calendar automatically.
 */

import { get, run } from './db.js';
import { googleConfigured } from './google.js';

const CALENDAR_API = process.env.GOOGLE_CALENDAR_API || 'https://www.googleapis.com/calendar/v3';
const TOKEN_ENDPOINT = process.env.GOOGLE_TOKEN_ENDPOINT || 'https://oauth2.googleapis.com/token';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

function getAccount(userId) {
  if (!userId) return null;
  return get(
    'SELECT * FROM google_accounts WHERE user_id = ? ORDER BY connected_at DESC LIMIT 1',
    userId
  );
}

async function refreshIfNeeded(account) {
  if (!account) return null;
  // If token doesn't look expired, try it first; Google will tell us if not
  // But we have expires_at; be defensive
  if (account.expires_at && account.expires_at > Math.floor(Date.now() / 1000) - 60) {
    return account.access_token;
  }
  if (!account.refresh_token || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return account.access_token;
  }
  try {
    const body = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: account.refresh_token,
      grant_type: 'refresh_token',
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) return account.access_token;
    const expiresAt = Math.floor(Date.now() / 1000) + Number(json.expires_in || 3600);
    run(
      `UPDATE google_accounts SET access_token = ?, expires_at = COALESCE(?, expires_at), updated_at = datetime('now')
       WHERE id = ?`,
      json.access_token,
      json.expires_in ? expiresAt : null,
      account.id
    );
    return json.access_token;
  } catch {
    return account.access_token;
  }
}

function toRfc3339(s) {
  if (!s) return null;
  // We store "YYYY-MM-DD HH:MM(:SS)" from the app; convert to RFC3339
  const t = String(s).trim().replace(' ', 'T');
  // If no timezone, assume UTC-ish or just attach Z? Better to send as local-ish without TZ
  // but Google accepts dateTime; if it's missing offset, add Z as a safe default for this app's use
  if (/[Zz]$/.test(t) || /[+-]\d{2}:?\d{2}$/.test(t)) return t;
  // Try to treat as UTC for simplicity if time present
  if (t.includes('T')) return t + 'Z';
  return t;
}

function buildEventBody(event) {
  const title = event.title || 'Appointment';
  const body = {
    summary: title,
    description: event.notes || undefined,
    location: event.location || undefined,
  };
  if (event.all_day) {
    // For all-day, use date (YYYY-MM-DD)
    const startDate = String(event.starts_at || '').slice(0, 10);
    const endDate = event.ends_at ? String(event.ends_at).slice(0, 10) : startDate;
    // Google all-day events are exclusive of end date; bump if same day? Keep simple
    body.start = { date: startDate };
    body.end = { date: endDate };
  } else {
    const start = toRfc3339(event.starts_at);
    let end = toRfc3339(event.ends_at);
    if (start && !end) {
      // Default 1 hour if missing
      try {
        const d = new Date(start.replace('Z', ''));
        d.setHours(d.getHours() + 1);
        end = d.toISOString();
      } catch {
        end = start;
      }
    }
    if (start) body.start = { dateTime: start, timeZone: process.env.GOOGLE_CALENDAR_TZ || 'UTC' };
    if (end) body.end = { dateTime: end, timeZone: process.env.GOOGLE_CALENDAR_TZ || 'UTC' };
  }
  return body;
}

export async function syncEventToGoogle(userId, event, action = 'upsert') {
  if (!googleConfigured()) return { ok: false, reason: 'not_configured' };
  const account = getAccount(userId);
  if (!account) return { ok: false, reason: 'not_connected' };
  const token = await refreshIfNeeded(account);
  if (!token) return { ok: false, reason: 'no_token' };

  try {
    if (action === 'delete') {
      const gId = event.google_event_id;
      if (!gId) return { ok: true, skipped: true };
      const res = await fetch(`${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(gId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      // 204 or 410 means gone
      return { ok: res.ok || res.status === 404 || res.status === 410 };
    }

    const body = buildEventBody(event);
    if (event.google_event_id) {
      const res = await fetch(
        `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(event.google_event_id)}`,
        {
          method: 'PATCH',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true };
    } else {
      const res = await fetch(`${CALENDAR_API}/calendars/primary/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, google_event_id: json.id || null };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
