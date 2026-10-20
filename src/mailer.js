/**
 * Outbound email, via a transactional provider.
 *
 * Sending mail needs a transport, and the suite deliberately has no mail server
 * of its own. Instead this speaks to a provider over its HTTP API, configured
 * entirely by environment variables. Two reasons for that choice:
 *
 *   - no dependency to install, which is what lets the app run on hosting that
 *     cannot run npm;
 *   - no SMTP credentials or mail server to look after.
 *
 * When no provider is configured the feature reports itself as unavailable and
 * callers fall back to showing the one-time link, so invitations still work.
 *
 * Nothing here is provider-specific beyond the small request shape each API
 * expects, all of which are documented and stable.
 */
import { getSetting } from './db.js';

const PROVIDER = (process.env.MAIL_PROVIDER || '').toLowerCase();
const API_KEY = process.env.MAIL_API_KEY || '';
const FROM = process.env.MAIL_FROM || '';
const REPLY_TO = process.env.MAIL_REPLY_TO || '';
// Resend accepts a custom endpoint; Postmark and others have fixed hosts.
const ENDPOINT = process.env.MAIL_ENDPOINT || '';

export function mailConfigured() {
  return Boolean(PROVIDER && API_KEY && FROM);
}

export function mailStatus() {
  if (mailConfigured()) return null;
  return 'Email is not configured on this server, so invitations cannot be sent. '
    + 'Set MAIL_PROVIDER, MAIL_API_KEY and MAIL_FROM in the host environment. '
    + 'Until then, share the invitation link shown after creating a user.';
}

/** The public origin, used to build absolute links in emails. */
export function baseUrl() {
  return (getSetting('public_base_url')
    || process.env.PUBLIC_BASE_URL
    || 'https://test.prostudio.my').replace(/\/+$/, '');
}

function fromHeader() {
  // Accept either a bare address or "Name <address>".
  if (FROM.includes('<')) return FROM;
  return `SP Business Suite <${FROM}>`;
}

/**
 * Builds the provider request. Each service differs only in header names and
 * the sender/target field names, so the mapping lives in one place.
 */
function buildRequest({ to, subject, text, html }) {
  const common = { to, subject, text, html };

  switch (PROVIDER) {
    case 'resend':
      return {
        url: ENDPOINT || 'https://api.resend.com/emails',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: {
          from: fromHeader(),
          to: [to],
          subject,
          text,
          html,
          ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
        },
      };
    case 'postmark':
      return {
        url: ENDPOINT || 'https://api.postmarkapp.com/email',
        headers: {
          'X-Postmark-Server-Token': API_KEY,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: {
          From: fromHeader(),
          To: to,
          Subject: subject,
          TextBody: text,
          HtmlBody: html,
          MessageStream: process.env.MAIL_STREAM || 'outbound',
          ...(REPLY_TO ? { ReplyTo: REPLY_TO } : {}),
        },
      };
    case 'sendgrid':
      return {
        url: ENDPOINT || 'https://api.sendgrid.com/v3/mail/send',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: {
          personalizations: [{ to: [{ email: to }] }],
          from: REPLY_TO
            ? { email: FROM.replace(/.*<|>.*/g, '').trim() || FROM, name: 'SP Business Suite' }
            : { email: FROM.replace(/.*<|>.*/g, '').trim() || FROM, name: 'SP Business Suite' },
          subject,
          content: [
            { type: 'text/plain', value: text },
            { type: 'text/html', value: html },
          ],
          ...(REPLY_TO ? { reply_to: { email: REPLY_TO } } : {}),
        },
      };
    case 'mailgun':
      return {
        url: ENDPOINT || `https://api.mailgun.net/v3/${process.env.MAIL_DOMAIN}/messages`,
        headers: {
          authorization: `Basic ${Buffer.from(`api:${API_KEY}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        // Mailgun wants form encoding rather than JSON.
        form: {
          from: fromHeader(),
          to,
          subject,
          text,
          html,
          ...(REPLY_TO ? { 'h:Reply-To': REPLY_TO } : {}),
        },
      };
    default:
      return null;
  }
}

/**
 * Sends one message. Never throws - a failed invitation must not lose the token
 * or the created user, so the caller gets {error} and shows the link instead.
 */
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) return { error: mailStatus() };
  if (!to) return { error: 'That user has no email address, so nothing could be sent.' };

  const req = buildRequest({ to, subject, text, html });
  if (!req) return { error: `Unknown MAIL_PROVIDER "${PROVIDER}".` };

  const init = { method: 'POST', headers: req.headers };
  if (req.form) init.body = new URLSearchParams(req.form);
  else init.body = JSON.stringify(req.body);

  try {
    const res = await fetch(req.url, init);
    // Read the body for the reason; some providers only explain failures here.
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = raw.slice(0, 300);
      try {
        const j = JSON.parse(raw);
        detail = j.message || j.error || j.Message || detail;
      } catch { /* plain-text body */ }
      return { error: `The mail provider refused the message (HTTP ${res.status}): ${detail}` };
    }
    return { data: { ok: true, status: res.status } };
  } catch (err) {
    return { error: `Could not reach the mail provider: ${err.message}` };
  }
}

/** Wraps a line of body text in the suite's minimal email styling. */
export function emailLayout({ heading, lines, button, footnote }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
  const text = [
    heading,
    '',
    ...lines,
    '',
    button ? `${button.label}: ${button.href}` : '',
    '',
    footnote || '',
  ].filter((l) => l !== '').join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2024">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
    <h1 style="margin:0 0 16px;font-size:20px">${esc(heading)}</h1>
    ${lines.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${esc(l)}</p>`).join('')}
    ${button ? `<p style="margin:24px 0">
      <a href="${esc(button.href)}" style="background:#1c2024;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">${esc(button.label)}</a>
    </p>
    <p style="margin:0;color:#6b7280;font-size:13px">If the button does not work, paste this into your browser:<br>${esc(button.href)}</p>` : ''}
    ${footnote ? `<p style="margin:24px 0 0;color:#6b7280;font-size:13px">${esc(footnote)}</p>` : ''}
  </div>
</body></html>`;

  return { text, html };
}

export { PROVIDER };
