/**
 * HTTP helpers - no external packages.
 *
 * Express is gone, so these replace the few things we actually used it for:
 * reading cookies, reading bodies, and writing responses.
 */

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const LIMITS = new WeakMap();

/**
 * Reads and parses a request body. JSON when the client says so, otherwise
 * form-encoded (the HTML forms post this way).
 *
 * `limit` guards against a huge upload filling memory; backups are the one
 * place that legitimately needs a large limit.
 */
export function parseBody(req, limit = 3 * 1024 * 1024) {
  LIMITS.set(req, limit);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const type = String(req.headers['content-type'] || '');
      if (type.includes('application/json')) {
        try {
          return resolve(JSON.parse(raw));
        } catch {
          return resolve({});
        }
      }
      // application/x-www-form-urlencoded
      const out = {};
      for (const [k, v] of new URLSearchParams(raw)) {
        // Repeated keys become arrays so multi-select checkboxes survive.
        if (k in out) {
          out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
        } else {
          out[k] = v;
        }
      }
      resolve(out);
    });
  });
}

export function setCookie(res, name, value, { maxAge, path = '/', secure = false, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (httpOnly) parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? [...prev] : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function clearCookie(res, name, { path = '/', secure = false } = {}) {
  setCookie(res, name, '', { maxAge: 0, path, secure });
}

export function html(res, body, status = 200) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

export function json(res, data, status = 200) {
  const buf = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

export function text(res, body, status = 200) {
  const buf = Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

export function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location });
  res.end();
}

/** Escapes text for interpolation into HTML. Always use for user data. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
