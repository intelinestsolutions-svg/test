/**
 * Gmail API helper (node built-ins only).
 * Each user connects their own Google account; tokens are stored per user.
 */

import { get, run } from './db.js';
import { googleConfigured } from './google.js';

const GMAIL_API = process.env.GOOGLE_GMAIL_API || 'https://gmail.googleapis.com/gmail/v1';
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

function encodeMime({ to, subject, text, cc }) {
  const headers = [];
  if (to) headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (subject) headers.push(`Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset=UTF-8');
  headers.push('Content-Transfer-Encoding: base64');
  const body = Buffer.from(text || '').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

export async function sendGmail(userId, { to, subject, text, cc }) {
  if (!googleConfigured()) return { ok: false, reason: 'not_configured' };
  const account = getAccount(userId);
  if (!account) return { ok: false, reason: 'not_connected' };
  const token = await refreshIfNeeded(account);
  if (!token) return { ok: false, reason: 'no_token' };
  try {
    const raw = encodeMime({ to, subject, text, cc });
    const res = await fetch(`${GMAIL_API}/users/me/messages/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: json.error?.message };
    return { ok: true, id: json.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
