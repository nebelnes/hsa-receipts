// Receipt photos and PDFs, stored in R2. The database keeps a row per file.

import { all, one, run } from './db.js';

export const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};
const BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf' };

export const KINDS = {
  receipt: 'Receipt / bill',
  eob: 'Insurance EOB',
  payment: 'Proof of payment',
  other: 'Other',
};

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 12;

function isUpload(f) {
  return f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && f.size > 0;
}

export function fileType(f) {
  let t = String(f.type || '').toLowerCase();
  if (t === 'image/jpg' || t === 'image/pjpeg') t = 'image/jpeg';
  if (TYPES[t]) return t;
  const ext = String(f.name || '').split('.').pop().toLowerCase();
  return BY_EXT[ext] || null;
}

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanName(name, ext) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[^\w .()+-]/g, '_').trim().slice(0, 100);
  return base || `receipt.${ext}`;
}

// Saves uploaded files for one receipt. Returns { saved, skipped: [reasons] }.
export async function saveFiles(env, expenseId, uploads, kind = 'receipt') {
  const files = [].concat(uploads || []).filter(isUpload);
  const skipped = [];
  let saved = 0;
  if (!KINDS[kind]) kind = 'receipt';
  for (const f of files) {
    if (saved >= MAX_FILES) {
      skipped.push(`${f.name || 'file'}: more than ${MAX_FILES} files at once`);
      continue;
    }
    const type = fileType(f);
    if (!type) {
      skipped.push(`${f.name || 'file'}: only photos (JPG, PNG, HEIC, WebP) and PDFs`);
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      skipped.push(`${f.name || 'file'}: larger than 20 MB`);
      continue;
    }
    const ext = TYPES[type];
    const name = cleanName(f.name, ext);
    const bytes = await f.arrayBuffer();
    const sha = await sha256Hex(bytes);
    // The same file twice on one receipt is never useful.
    if (await one(env, 'SELECT id FROM files WHERE expense_id = ? AND sha256 = ?', expenseId, sha)) {
      skipped.push(`${name}: already attached to this receipt`);
      continue;
    }
    const key = `receipts/${expenseId}/${crypto.randomUUID()}.${ext}`;
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
    await run(
      env,
      'INSERT INTO files (expense_id, r2_key, name, type, size, kind, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)',
      expenseId, key, name, type, f.size, kind, sha,
    );
    saved++;
  }
  return { saved, skipped, offered: files.length };
}

export function countUploads(uploads) {
  return [].concat(uploads || []).filter(isUpload).length;
}

export async function filesFor(env, expenseId) {
  return all(env, 'SELECT * FROM files WHERE expense_id = ? ORDER BY id', expenseId);
}

export async function deleteFile(env, id) {
  const f = await one(env, 'SELECT * FROM files WHERE id = ?', id);
  if (!f) return null;
  await env.FILES.delete(f.r2_key);
  await run(env, 'DELETE FROM files WHERE id = ?', id);
  return f.expense_id;
}

export async function deleteExpenseFiles(env, expenseId) {
  const rows = await filesFor(env, expenseId);
  if (rows.length) await env.FILES.delete(rows.map((r) => r.r2_key));
  await run(env, 'DELETE FROM files WHERE expense_id = ?', expenseId);
}

export async function setKind(env, id, kind) {
  if (!KINDS[kind]) return null;
  const f = await one(env, 'SELECT expense_id FROM files WHERE id = ?', id);
  if (!f) return null;
  await run(env, 'UPDATE files SET kind = ? WHERE id = ?', kind, id);
  return f.expense_id;
}

export async function serveFile(env, id, download = false) {
  const f = await one(env, 'SELECT * FROM files WHERE id = ?', id);
  if (!f) return null;
  const obj = await env.FILES.get(f.r2_key);
  if (!obj) return null;
  const type = TYPES[f.type] ? f.type : 'application/octet-stream';
  const safe = String(f.name || 'file').replace(/["\\\r\n]/g, '_');
  const headers = {
    'Content-Type': type,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${safe}"`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  // Photos open in a locked-down tab. (PDFs are left alone: browsers won't
  // show a PDF in a sandboxed tab.)
  if (type.startsWith('image/')) headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
  return new Response(obj.body, { headers });
}
