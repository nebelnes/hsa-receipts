// Small helpers shared by every page.

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Receipt reading runs in the browser with libraries from jsDelivr
// (tesseract.js for photos, pdf.js for PDFs). The receipt itself never leaves
// the phone for reading; only the reading engine is downloaded.
const CDN = 'https://cdn.jsdelivr.net';
export const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${CDN} blob:`,
  `worker-src 'self' blob: ${CDN}`,
  `connect-src 'self' ${CDN} blob: data:`,
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': CSP,
    },
  });
}

export function redirect(location, status = 303) {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

export async function readForm(request) {
  const fd = await request.formData();
  const out = {};
  for (const [k, v] of fd.entries()) {
    const val = typeof v === 'string' ? v.trim() : v;
    if (k in out) out[k] = [].concat(out[k], val);
    else out[k] = val;
  }
  return out;
}

export function list(v) {
  return v === undefined || v === null || v === '' ? [] : [].concat(v);
}

export function moneyExact(amount) {
  if (amount === null || amount === undefined || amount === '' || Number.isNaN(Number(amount))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount));
}

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Today's date in Atlanta (so an evening entry isn't dated tomorrow).
export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

export function niceDate(s) {
  if (!isDate(s)) return s || '';
  const d = new Date(`${s}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function splitList(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s, i, a) => a.indexOf(s) === i);
}
