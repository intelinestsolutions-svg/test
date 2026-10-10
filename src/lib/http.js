/**
 * Tiny HTTP helpers: request parsing, cookies, responses.
 */
import { randomBytes } from 'node:crypto';

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function parseBody(req, limitBytes = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(buf.toString('utf8') || '{}')); }
        catch { resolve({}); }
        return;
      }
      // Muat naik fail binari (contoh: restore sandaran .db). Serahkan
      // Buffer mentah supaya route boleh sahkan & simpan sendiri.
      if (ct.includes('application/octet-stream') || ct.includes('application/x-sqlite3') || ct.includes('application/vnd.sqlite3')) {
        resolve({ __raw: buf });
        return;
      }
      resolve(parseForm(buf.toString('utf8')));
    });
    req.on('error', reject);
  });
}

export function parseForm(str) {
  const out = {};
  const usp = new URLSearchParams(str);
  for (const [k, v] of usp) {
    if (k.endsWith('[]')) {
      const key = k.slice(0, -2);
      (out[key] ||= []).push(v);
    } else out[k] = v;
  }
  return out;
}

/** Convert a flat form object: numbers, trimmed strings, checkboxes -> 0/1 */
export function coerce(form, numericKeys = [], boolKeys = []) {
  const out = { ...form };
  for (const k of Object.keys(out)) if (typeof out[k] === 'string') out[k] = out[k].trim();
  for (const k of numericKeys) if (out[k] !== undefined && out[k] !== '') out[k] = num(out[k]);
  for (const k of boolKeys) out[k] = out[k] ? 1 : 0;
  return out;
}
export const num = (v, d = 0) => {
  const n = Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : d;
};
export const int = (v, d = 0) => Math.trunc(num(v, d));
export const str = (v, d = '') => (v === undefined || v === null ? d : String(v).trim());

export function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', 'HttpOnly'];
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function html(res, body, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}
export function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}
export function text(res, body, status = 200, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
export function redirect(res, url, status = 302) {
  res.writeHead(status, { Location: url });
  res.end();
}
export function download(res, body, filename, type = 'text/csv; charset=utf-8') {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end(body);
}
export const token = () => randomBytes(16).toString('hex');

/* ---------- CSV ---------- */
export function toCsv(rows, headers) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  if (headers) lines.push(headers.map((h) => esc(h.label ?? h)).join(','));
  for (const r of rows) lines.push(r.map(esc).join(','));
  return '﻿' + lines.join('\r\n');
}

/* ---------- dates ---------- */
export const today = () => new Date().toISOString().slice(0, 10);
export function nowLocal() {
  const d = new Date();
  return d.toTimeString().slice(0, 5);
}
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  const ms = new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`);
  return Math.round(ms / 86400000);
}
export const monthStart = (iso = today()) => iso.slice(0, 8) + '01';
