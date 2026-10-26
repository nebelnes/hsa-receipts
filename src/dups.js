// Duplicate check: finds receipts that look like the same expense, so the
// same bill isn't reimbursed twice. Nothing is deleted automatically; the
// site shows a warning and you decide ("Not a duplicate" or delete one).
//
// Two receipts are flagged when:
//   - they share the same receipt file (identical photo or PDF), or
//   - they came from the same emailed e-receipt, or
//   - they have the same amount and the same date of service, or
//   - they have the same amount and a similar provider, up to 7 days apart.
// EOBs and payment proofs are left out of the file check, because one EOB or
// card statement often covers several visits. Receipts for two different
// people are never flagged on amount alone.

import { all, run } from './db.js';

const STOP = new Set(['the', 'and', 'inc', 'llc', 'pllc', 'family', 'center', 'centre', 'group', 'clinic', 'medical', 'health',
  'healthcare', 'dentistry', 'dental', 'pharmacy', 'store', 'office', 'associates', 'care', 'services', 'of', 'at', 'for']);

function tokens(provider) {
  return new Set(String(provider || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)));
}

export function similarProvider(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

const cents = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100));
const dayNum = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000 : null);
const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// Reasons two receipts look alike, or [] (pure; also used by tests).
export function compare(x, y, { sharedFile = false } = {}) {
  const reasons = [];
  if (sharedFile) reasons.push('same receipt file');
  if (x.source_hash && x.source_hash === y.source_hash) reasons.push('same emailed receipt');
  const ax = cents(x.amount);
  const ay = cents(y.amount);
  const differentPeople = x.patient && y.patient && x.patient.trim().toLowerCase() !== y.patient.trim().toLowerCase();
  if (ax && ax === ay && !differentPeople) {
    const dx = dayNum(x.service_date);
    const dy = dayNum(y.service_date);
    if (dx !== null && dx === dy) reasons.push('same date and amount');
    else if (dx !== null && dy !== null && Math.abs(dx - dy) <= 7 && similarProvider(x.provider, y.provider)) {
      const n = Math.abs(dx - dy);
      reasons.push(`same provider and amount, ${n} day${n === 1 ? '' : 's'} apart`);
    }
  }
  return reasons;
}

// Map of receipt id -> [{ id, reasons }] for every receipt that has a likely twin.
export async function duplicateMap(env) {
  const rows = await all(env, `SELECT id, amount, service_date, provider, patient, source_hash FROM expenses`);
  const files = await all(env, `SELECT expense_id, sha256 FROM files WHERE sha256 IS NOT NULL AND kind = 'receipt'`);
  const ok = new Set((await all(env, `SELECT a, b FROM not_duplicates`)).map((r) => pairKey(r.a, r.b)));

  const shared = new Set();
  const bySha = new Map();
  for (const f of files) {
    const ids = bySha.get(f.sha256) || new Set();
    ids.add(f.expense_id);
    bySha.set(f.sha256, ids);
  }
  for (const ids of bySha.values()) {
    const list = [...ids];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) shared.add(pairKey(list[i], list[j]));
  }

  // Only compare receipts that could match: same amount, same email, or a shared file.
  const groups = new Map();
  const add = (k, r) => {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  };
  for (const r of rows) {
    const c = cents(r.amount);
    if (c) add(`amt:${c}`, r);
    if (r.source_hash) add(`src:${r.source_hash}`, r);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const candidates = new Set(shared);
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) candidates.add(pairKey(g[i].id, g[j].id));
  }

  const out = new Map();
  for (const k of candidates) {
    if (ok.has(k)) continue;
    const [a, b] = k.split('-').map(Number);
    const x = byId.get(a);
    const y = byId.get(b);
    if (!x || !y) continue;
    const reasons = compare(x, y, { sharedFile: shared.has(k) });
    if (!reasons.length) continue;
    if (!out.has(a)) out.set(a, []);
    if (!out.has(b)) out.set(b, []);
    out.get(a).push({ id: b, reasons });
    out.get(b).push({ id: a, reasons });
  }
  return out;
}

export async function duplicatesOf(env, id) {
  return (await duplicateMap(env)).get(Number(id)) || [];
}

export async function markNotDuplicate(env, a, b) {
  a = Number(a);
  b = Number(b);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return false;
  await run(env, `INSERT OR IGNORE INTO not_duplicates (a, b) VALUES (?, ?)`, Math.min(a, b), Math.max(a, b));
  return true;
}

export async function forgetPairs(env, id) {
  await run(env, `DELETE FROM not_duplicates WHERE a = ? OR b = ?`, id, id);
}
