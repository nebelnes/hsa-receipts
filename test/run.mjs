// End-to-end test: runs the real Worker code against a fake database,
// fake file storage and the real page scripts. Run with: npm test

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeD1, FakeR2, FakeAssets } from './fakes.mjs';
import { parseReceipt } from '../public/static/parse.js';
import { makeZip, crc32 } from '../public/static/zip.js';

const worker = (await import('../src/index.js')).default;

const ORIGIN = 'https://hsa.test';
let accessKeys = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.endsWith('/cdn-cgi/access/certs')) return new Response(JSON.stringify({ keys: accessKeys }), { headers: { 'Content-Type': 'application/json' } });
  return realFetch(input, init);
};

const env = {
  DB: new FakeD1(),
  FILES: new FakeR2(),
  ASSETS: new FakeAssets(new URL('../public/', import.meta.url)),
  DEV_NO_AUTH: '1',
  SITE_URL: ORIGIN,
};

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.stack}`);
    process.exitCode = 1;
  }
}

async function req(method, path, form, extraHeaders = {}, e = env) {
  const init = { method, headers: { Origin: ORIGIN, ...extraHeaders }, redirect: 'manual' };
  if (form instanceof FormData) init.body = form;
  else if (form) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) [].concat(v).forEach((x) => p.append(k, x));
    init.body = p;
  }
  const res = await worker.fetch(new Request(ORIGIN + path, init), e);
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, text: new TextDecoder().decode(buf), bytes: buf, headers: res.headers, location: res.headers.get('Location') || '' };
}
const msgOf = (loc) => decodeURIComponent((loc.match(/msg=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
const q = (sql, ...a) => env.DB.db.prepare(sql).all(...a);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);
const PDF = new TextEncoder().encode('%PDF-1.4\n% fake\n%%EOF');
const upload = (...files) => {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return fd;
};
const TODAY = '2026-10-26';

console.log('Receipt reading');

await step('pharmacy photo: date, provider, amount, category', async () => {
  const g = parseReceipt(await readFile(new URL('./fixtures/pharmacy.ocr.txt', import.meta.url), 'utf8'), { today: TODAY });
  assert.deepEqual(g, { date: '2026-09-14', amount: 12.5, provider: 'CVS Pharmacy', category: 'Pharmacy' });
});

await step('doctor statement: service date (not statement date) and patient responsibility', async () => {
  const g = parseReceipt(await readFile(new URL('./fixtures/pediatric.ocr.txt', import.meta.url), 'utf8'), { today: TODAY });
  assert.equal(g.date, '2026-08-27');
  assert.equal(g.amount, 35);
  assert.equal(g.provider, 'Alpharetta Pediatric Associates');
  assert.equal(g.category, 'Doctor visit');
});

await step('dental receipt: amount paid, not total charges', async () => {
  const g = parseReceipt(await readFile(new URL('./fixtures/dental.ocr.txt', import.meta.url), 'utf8'), { today: TODAY });
  assert.equal(g.date, '2026-10-06');
  assert.equal(g.amount, 37.6);
  assert.equal(g.provider, 'Smile Bright Family Dental');
  assert.equal(g.category, 'Dental');
});

await step('insurance EOB PDF text: what you owe, service date, hospital', async () => {
  const g = parseReceipt(await readFile(new URL('./fixtures/eob.pdf.txt', import.meta.url), 'utf8'), { today: TODAY });
  assert.equal(g.date, '2026-07-18');
  assert.equal(g.amount, 300);
  assert.match(g.provider || '', /Northside Hospital Forsyth$/);
  assert.equal(g.category, 'Hospital / ER');
});

await step('messy OCR: comma cents, short year, noise above the store name', async () => {
  const g = parseReceipt(await readFile(new URL('./fixtures/messy.ocr.txt', import.meta.url), 'utf8'), { today: TODAY });
  assert.equal(g.date, '2026-10-01');
  assert.equal(g.amount, 8.49);
  assert.match(g.provider, /^Kroger Pharmacy/);
  assert.equal(g.category, 'Pharmacy');
});

await step('ignores future dates, birth dates and numbers without cents', async () => {
  const g = parseReceipt('Dr. Lee MD\nDOB 04/12/1984\nNext visit 03/01/2027\nVisit 10/20/2026\nAcct 55012\nBalance due 120', { today: TODAY });
  assert.equal(g.date, '2026-10-20');
  assert.equal(g.amount, null);
  assert.equal(g.provider, 'Dr. Lee MD');
});

console.log('ZIP export');

await step('ZIP is valid and readable by standard tools', async () => {
  const zip = makeZip([
    { name: 'hsa-receipts.csv', data: new TextEncoder().encode('id,amount\n1,12.50\n') },
    { name: 'receipts/2026/2026-09-14 CVS $12.50 #1/1-scan.jpg', data: JPEG },
  ]);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const path = `${process.env.TMPDIR || '/tmp'}/hsa-test-${process.pid}.zip`;
  writeFileSync(path, zip);
  const outp = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("|".join(z.namelist()));print(z.read("hsa-receipts.csv").decode())', path]).toString();
  assert.match(outp, /hsa-receipts\.csv\|receipts\/2026\/2026-09-14 CVS \$12\.50 #1\/1-scan\.jpg/);
  assert.match(outp, /1,12\.50/);
});

console.log('Site');

await step('home page starts empty with an Add button', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Available to reimburse/);
  assert.match(r.text, /No unreimbursed receipts yet/);
  assert.match(r.text, /href="\/new"/);
  assert.match(r.headers.get('Content-Security-Policy'), /cdn\.jsdelivr\.net/);
});

await step('add page has camera, file picker and share tips', async () => {
  const r = await req('GET', '/new');
  assert.equal(r.status, 200);
  assert.match(r.text, /capture="environment"/);
  assert.match(r.text, /application\/pdf/);
  assert.match(r.text, /Add to Home screen/);
  assert.match(r.text, /\/static\/capture\.js/);
});

let firstId;
await step('uploading a photo and a PDF creates one draft receipt and opens it for reading', async () => {
  const r = await req('POST', '/new', upload(new File([JPEG], 'IMG_2041.jpg', { type: 'image/jpeg' }), new File([PDF], 'page2.pdf', { type: 'application/pdf' })));
  assert.equal(r.status, 303);
  const m = r.location.match(/^\/e\/(\d+)\/edit\?read=1$/);
  assert.ok(m, r.location);
  firstId = Number(m[1]);
  assert.equal(q('SELECT status FROM expenses WHERE id = ?', firstId)[0].status, 'draft');
  const files = q('SELECT * FROM files WHERE expense_id = ? ORDER BY id', firstId);
  assert.equal(files.length, 2);
  assert.equal(files[0].type, 'image/jpeg');
  assert.equal(files[1].type, 'application/pdf');
  assert.ok(env.FILES.objects.has(files[0].r2_key));
  const edit = await req('GET', r.location);
  assert.match(edit.text, /data-auto="1"/);
  assert.match(edit.text, new RegExp(`data-file="/files/${files[0].id}"`));
  assert.match(edit.text, /\/static\/edit\.js/);
});

await step('files are served back with safe headers; downloads work', async () => {
  const f = q('SELECT * FROM files WHERE expense_id = ? ORDER BY id', firstId);
  const img = await req('GET', `/files/${f[0].id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual([...img.bytes], [...JPEG]);
  assert.match(img.headers.get('Content-Security-Policy'), /sandbox/);
  assert.equal(img.headers.get('X-Content-Type-Options'), 'nosniff');
  const pdf = await req('GET', `/files/${f[1].id}?download=1`);
  assert.equal(pdf.headers.get('Content-Type'), 'application/pdf');
  assert.match(pdf.headers.get('Content-Disposition'), /^attachment; filename="page2\.pdf"/);
  assert.equal((await req('GET', '/files/9999')).status, 404);
});

await step('page scripts are served after sign-in', async () => {
  const r = await req('GET', '/static/parse.js');
  assert.equal(r.status, 200);
  assert.match(r.text, /export function parseReceipt/);
  assert.match(r.headers.get('Content-Type'), /javascript/);
});

await step('saving details finishes the receipt; missing details keep it as a draft', async () => {
  let r = await req('POST', `/e/${firstId}/edit`, { service_date: '2026-09-14', provider: 'CVS Pharmacy', amount: '', patient: 'Sam' });
  assert.match(msgOf(r.location), /Add the date, provider and amount/);
  assert.equal(q('SELECT status FROM expenses WHERE id = ?', firstId)[0].status, 'draft');
  r = await req('POST', `/e/${firstId}/edit`, { service_date: '2026-09-14', provider: 'CVS Pharmacy', amount: '$12.50', patient: 'Sam', category: 'Pharmacy', paid_date: '2026-09-14', paid_with: 'Aven', notes: 'Amoxicillin', ocr_text: 'CVS PHARMACY ...' });
  assert.equal(r.location, `/e/${firstId}?msg=Saved.&kind=ok`);
  const e = q('SELECT * FROM expenses WHERE id = ?', firstId)[0];
  assert.equal(e.status, 'open');
  assert.equal(e.amount, 12.5);
  assert.equal(e.ocr_text, 'CVS PHARMACY ...');
  const d = await req('GET', `/e/${firstId}`);
  assert.match(d.text, /Not reimbursed/);
  assert.match(d.text, /\$12\.50/);
  assert.match(d.text, /Mark as reimbursed/);
});

await step('bad input is rejected with a clear message', async () => {
  let r = await req('POST', `/e/${firstId}/edit`, { service_date: '2026-13-01', provider: 'X', amount: '5' });
  assert.match(msgOf(r.location), /valid date/);
  r = await req('POST', `/e/${firstId}/edit`, { service_date: '2026-09-14', provider: 'X', amount: 'twelve' });
  assert.match(msgOf(r.location), /number like/);
  assert.equal(q('SELECT provider FROM expenses WHERE id = ?', firstId)[0].provider, 'CVS Pharmacy');
});

await step('paid with the HSA card: nothing to reimburse', async () => {
  const r = await req('POST', '/new/blank', {});
  const id = Number(r.location.match(/\/e\/(\d+)\/edit/)[1]);
  const s = await req('POST', `/e/${id}/edit`, { service_date: '2026-10-06', provider: 'Smile Bright Family Dental', amount: '37.60', paid_with: 'HSA card', category: 'Dental' });
  assert.match(msgOf(s.location), /paid with the HSA card/);
  const e = q('SELECT * FROM expenses WHERE id = ?', id)[0];
  assert.equal(e.status, 'hsa_paid');
  assert.equal(e.reimbursed_amount, 37.6);
  assert.equal(e.reimbursed_date, '2026-10-06');
  // Switching to a regular card makes it reimbursable again.
  await req('POST', `/e/${id}/edit`, { service_date: '2026-10-06', provider: 'Smile Bright Family Dental', amount: '37.60', paid_with: 'Amex Blue Cash Preferred', category: 'Dental' });
  const e2 = q('SELECT * FROM expenses WHERE id = ?', id)[0];
  assert.equal(e2.status, 'open');
  assert.equal(e2.reimbursed_amount, null);
});

await step('file type and size limits', async () => {
  const r = await req('POST', '/new', upload(new File([new TextEncoder().encode('hello')], 'notes.txt', { type: 'text/plain' })));
  assert.match(msgOf(r.location), /only photos .* and PDFs/);
  const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'huge.jpg', { type: 'image/jpeg' });
  const r2 = await req('POST', '/new', upload(big, new File([JPEG], 'ok.jpg', { type: 'image/jpeg' })));
  assert.match(r2.location, /\/edit\?read=1&msg=Some%20files%20were%20skipped/);
  const r3 = await req('POST', '/new', new FormData());
  assert.match(msgOf(r3.location), /Choose a photo or PDF/);
  // Extension is enough when the phone sends no type (common for HEIC).
  const r4 = await req('POST', '/new', upload(new File([JPEG], 'IMG_1.HEIC', { type: '' })));
  const id = Number(r4.location.match(/\/e\/(\d+)\//)[1]);
  assert.equal(q('SELECT type FROM files WHERE expense_id = ?', id)[0].type, 'image/heic');
});

await step('adding files later, labeling them, removing one', async () => {
  const fd = upload(new File([PDF], 'card-statement.pdf', { type: 'application/pdf' }));
  fd.append('kind', 'payment');
  const r = await req('POST', `/e/${firstId}/files`, fd);
  assert.match(msgOf(r.location), /Added 1 file/);
  const files = q('SELECT * FROM files WHERE expense_id = ? ORDER BY id', firstId);
  assert.equal(files.length, 3);
  assert.equal(files[2].kind, 'payment');
  await req('POST', `/files/${files[1].id}/kind`, { kind: 'eob' });
  assert.equal(q('SELECT kind FROM files WHERE id = ?', files[1].id)[0].kind, 'eob');
  await req('POST', `/files/${files[1].id}/kind`, { kind: 'bogus' });
  assert.equal(q('SELECT kind FROM files WHERE id = ?', files[1].id)[0].kind, 'eob');
  const del = await req('POST', `/files/${files[1].id}/delete`, {});
  assert.equal(del.location, `/e/${firstId}?msg=File%20removed.&kind=ok`);
  assert.ok(!env.FILES.objects.has(files[1].r2_key));
  const d = await req('GET', `/e/${firstId}`);
  assert.match(d.text, /Proof of payment/);
});

await step('mark reimbursed, undo, and validation', async () => {
  let r = await req('POST', `/e/${firstId}/reimburse`, { reimbursed_date: '', reimbursed_amount: '12.50' });
  assert.match(msgOf(r.location), /date you were reimbursed/);
  r = await req('POST', `/e/${firstId}/reimburse`, { reimbursed_date: '2026-10-20', reimbursed_amount: '12.50' });
  assert.match(msgOf(r.location), /Marked as reimbursed/);
  let e = q('SELECT * FROM expenses WHERE id = ?', firstId)[0];
  assert.equal(e.status, 'reimbursed');
  assert.equal(e.reimbursed_date, '2026-10-20');
  r = await req('POST', `/e/${firstId}/reimburse`, { reimbursed_date: '2026-10-21', reimbursed_amount: '12.50' });
  assert.match(msgOf(r.location), /Only unreimbursed/);
  // Editing a reimbursed receipt keeps it reimbursed.
  await req('POST', `/e/${firstId}/edit`, { service_date: '2026-09-14', provider: 'CVS Pharmacy #4821', amount: '12.50', paid_with: 'Aven' });
  e = q('SELECT * FROM expenses WHERE id = ?', firstId)[0];
  assert.equal(e.status, 'reimbursed');
  assert.equal(e.provider, 'CVS Pharmacy #4821');
  await req('POST', `/e/${firstId}/unreimburse`, {});
  e = q('SELECT * FROM expenses WHERE id = ?', firstId)[0];
  assert.equal(e.status, 'open');
  assert.equal(e.reimbursed_amount, null);
});

await step('list: totals, filters and marking several reimbursed at once', async () => {
  const ids = [];
  for (const [date, prov, amt, who] of [['2025-11-03', 'Northside Hospital', '300.00', 'Alex'], ['2026-08-27', 'Alpharetta Pediatric Associates', '35.00', 'Max']]) {
    const r = await req('POST', '/new', upload(new File([JPEG], 'scan.jpg', { type: 'image/jpeg' })));
    const id = Number(r.location.match(/\/e\/(\d+)\//)[1]);
    await req('POST', `/e/${id}/edit`, { service_date: date, provider: prov, amount: amt, patient: who, paid_with: 'Aven' });
    ids.push(id);
  }
  await req('POST', '/settings', { people: 'Alex, Max, Sam', paid_with: 'Aven, HSA card', hsa_name: 'Fidelity', hsa_url: 'https://www.fidelity.com' });
  let home = await req('GET', '/');
  const open = q(`SELECT SUM(amount) s FROM expenses WHERE status = 'open'`)[0].s;
  assert.equal(open, 12.5 + 37.6 + 300 + 35);
  assert.match(home.text, /\$385\.10/);
  assert.match(home.text, /Needs details/);
  assert.match(home.text, /name="ids" value="\d+"/);
  assert.match(home.text, /\/static\/list\.js/);
  const y2025 = await req('GET', '/?status=open&year=2025');
  assert.match(y2025.text, /Northside Hospital/);
  assert.ok(!/CVS Pharmacy/.test(y2025.text));
  const max = await req('GET', '/?status=open&person=Max');
  assert.match(max.text, /Alpharetta Pediatric/);
  assert.ok(!/Northside/.test(max.text));
  const r = await req('POST', '/reimburse', { ids: [String(ids[0]), String(ids[1])], reimbursed_date: '2026-10-25' });
  assert.match(msgOf(r.location), /Marked 2 receipts as reimbursed \(\$335\.00\)/);
  const again = await req('POST', '/reimburse', { ids: [String(ids[0])], reimbursed_date: '2026-10-25' });
  assert.match(msgOf(again.location), /already reimbursed/);
  home = await req('GET', '/');
  assert.match(home.text, /\$50\.10/);
  const det = await req('GET', `/e/${firstId}`);
  assert.match(det.text, /href="https:\/\/www\.fidelity\.com"/);
});

await step('drafts are listed so nothing gets lost', async () => {
  const r = await req('GET', '/?status=draft');
  assert.match(r.text, /Untitled receipt/);
  assert.match(r.text, /Needs details/);
});

await step('settings validate the link and keep lists tidy', async () => {
  let r = await req('POST', '/settings', { people: 'Alex, Max, Alex', paid_with: 'Aven', hsa_url: 'javascript:alert(1)' });
  assert.match(msgOf(r.location), /https:\/\//);
  r = await req('POST', '/settings', { people: 'Alex, Max, Alex', paid_with: 'Aven\nHSA card', hsa_name: 'Fidelity', hsa_url: '' });
  assert.match(msgOf(r.location), /Settings saved/);
  const s = await req('GET', '/settings');
  assert.match(s.text, /value="Alex, Max"/);
  assert.match(s.text, /Aven, HSA card/);
  assert.match(s.text, /Receipt storage: ✅/);
});

await step('CSV export: all receipts, formula-safe', async () => {
  const r = await req('POST', '/new/blank', {});
  const id = Number(r.location.match(/\/e\/(\d+)\/edit/)[1]);
  await req('POST', `/e/${id}/edit`, { service_date: '2026-10-01', provider: '=HYPERLINK("x")', amount: '10.00', notes: 'line one, "quoted"' });
  const c = await req('GET', '/export.csv');
  assert.equal(c.status, 200);
  assert.match(c.headers.get('Content-Disposition'), /attachment; filename="hsa-receipts-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = c.text.trim().split('\r\n');
  assert.equal(lines[0], 'id,status,service_date,provider,patient,category,amount,paid_date,paid_with,reimbursed_date,reimbursed_amount,notes,files');
  assert.match(c.text, /"'=HYPERLINK\(""x""\)"/);
  assert.match(c.text, /"line one, ""quoted"""/);
  assert.match(c.text, /Reimbursed,2025-11-03,Northside Hospital,Alex,,300,/);
});

await step('ZIP manifest: folders by year, one entry per file', async () => {
  const r = await req('GET', '/export/files.json');
  const m = JSON.parse(r.text);
  assert.ok(m.csv.startsWith('id,status'));
  const n = q('SELECT COUNT(*) n FROM files')[0].n;
  assert.equal(m.files.length, n);
  assert.ok(m.files.some((f) => /^2026\/2026-09-14 CVS Pharmacy 4821 \$12\.50 #\d+\/1-IMG_2041\.jpg$/.test(f.path)), JSON.stringify(m.files.slice(0, 3)));
  assert.ok(m.files.some((f) => f.path.startsWith('2025/2025-11-03 Northside Hospital $300.00')));
  assert.equal(new Set(m.files.map((f) => f.path)).size, m.files.length);
  const page = await req('GET', '/export');
  assert.match(page.text, /Download everything \(ZIP\)/);
  assert.match(page.text, /<td>2025<\/td><td class="num">1<\/td>/);
});

await step('deleting a receipt removes its files from storage', async () => {
  const keys = q('SELECT r2_key FROM files WHERE expense_id = ?', firstId).map((r) => r.r2_key);
  assert.ok(keys.length);
  let r = await req('POST', `/e/${firstId}/delete`, {});
  assert.match(msgOf(r.location), /Tick the box/);
  r = await req('POST', `/e/${firstId}/delete`, { confirm: '1' });
  assert.match(msgOf(r.location), /Receipt deleted/);
  assert.equal(q('SELECT COUNT(*) n FROM expenses WHERE id = ?', firstId)[0].n, 0);
  for (const k of keys) assert.ok(!env.FILES.objects.has(k));
  assert.equal((await req('GET', `/e/${firstId}`)).status, 404);
});

await step('escaping: names with HTML are shown as text', async () => {
  const r = await req('POST', '/new/blank', {});
  const id = Number(r.location.match(/\/e\/(\d+)\/edit/)[1]);
  await req('POST', `/e/${id}/edit`, { service_date: '2026-10-01', provider: '<script>alert(1)</script>', amount: '1.00' });
  const d = await req('GET', `/e/${id}`);
  assert.ok(!d.text.includes('<script>alert(1)</script>'));
  assert.match(d.text, /&lt;script&gt;/);
});

await step('Android share menu can post scans; other sites cannot', async () => {
  const share = await req('POST', '/share', upload(new File([JPEG], 'Scan 2026-10-26.jpg', { type: 'image/jpeg' })), { Origin: 'null', 'Sec-Fetch-Site': 'none' });
  assert.equal(share.status, 303);
  assert.match(share.location, /^\/e\/\d+\/edit\?read=1$/);
  const noOrigin = new Request(`${ORIGIN}/share`, { method: 'POST', body: upload(new File([JPEG], 's.jpg', { type: 'image/jpeg' })), redirect: 'manual' });
  assert.equal((await worker.fetch(noOrigin, env)).status, 303);
  const evil = await req('POST', '/share', upload(new File([JPEG], 'x.jpg', { type: 'image/jpeg' })), { Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(evil.status, 403);
  const evilNull = await req('POST', '/share', upload(new File([JPEG], 'x.jpg', { type: 'image/jpeg' })), { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(evilNull.status, 403);
  const evilDelete = await req('POST', '/reimburse', { ids: ['1'], reimbursed_date: '2026-10-01' }, { Origin: 'https://evil.test' });
  assert.equal(evilDelete.status, 403);
  const nullElsewhere = await req('POST', '/settings', { people: 'x' }, { Origin: 'null' });
  assert.equal(nullElsewhere.status, 403);
  assert.equal((await req('GET', '/share')).location, '/new');
});

await step('home-screen manifest offers the share target', async () => {
  const r = await req('GET', '/manifest.webmanifest');
  const m = JSON.parse(r.text);
  assert.equal(m.share_target.action, '/share');
  assert.equal(m.share_target.enctype, 'multipart/form-data');
  assert.equal(m.share_target.params.files[0].name, 'files');
  const icon = await req('GET', '/icon-512.png');
  assert.deepEqual([...icon.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

await step('Cloudflare Access sign-in is enforced, including for files and scripts', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
  accessKeys = [jwk];
  const aenv = { ...env, DEV_NO_AUTH: undefined, ACCESS_TEAM_DOMAIN: 'ourteam.cloudflareaccess.com', ACCESS_AUD: 'aud123', ALLOWED_EMAILS: 'me@x.test, wife@x.test' };
  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  async function token(payload, key = kp.privateKey) {
    const h = b64u({ alg: 'RS256', kid: 'k1' });
    const p = b64u(payload);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
  }
  const good = { aud: ['aud123'], email: 'Wife@x.test', exp: Math.floor(Date.now() / 1000) + 600, iss: 'https://ourteam.cloudflareaccess.com' };
  const fileId = q('SELECT id FROM files LIMIT 1')[0].id;
  for (const path of ['/', `/files/${fileId}`, '/static/parse.js', '/export.csv', '/export/files.json']) {
    assert.equal((await req('GET', path, null, {}, aenv)).status, 403, `no token: ${path}`);
  }
  assert.equal((await req('GET', '/', null, { 'Cf-Access-Jwt-Assertion': await token(good) }, aenv)).status, 200, 'valid token');
  assert.equal((await req('GET', `/files/${fileId}`, null, { 'Cf-Access-Jwt-Assertion': await token(good) }, aenv)).status, 200, 'valid token, file');
  assert.equal((await req('GET', '/', null, { 'Cf-Access-Jwt-Assertion': await token({ ...good, email: 'stranger@x.test' }) }, aenv)).status, 403, 'wrong email');
  assert.equal((await req('GET', '/', null, { 'Cf-Access-Jwt-Assertion': await token({ ...good, aud: ['other'] }) }, aenv)).status, 403, 'wrong audience');
  assert.equal((await req('GET', '/', null, { 'Cf-Access-Jwt-Assertion': await token({ ...good, exp: 1 }) }, aenv)).status, 403, 'expired');
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
  assert.equal((await req('GET', '/', null, { 'Cf-Access-Jwt-Assertion': await token(good, other.privateKey) }, aenv)).status, 403, 'forged signature');
  const lr = await req('GET', '/', null, {}, { ...env, DEV_NO_AUTH: undefined });
  assert.equal(lr.status, 403);
  assert.match(lr.text, /set up yet/);
  // The manifest and icons stay reachable so the phone can install the app.
  assert.equal((await req('GET', '/manifest.webmanifest', null, {}, aenv)).status, 200);
});

// Optional: save rendered pages for a visual check (SNAPSHOT_DIR=/some/dir npm test).
if (process.env.SNAPSHOT_DIR) {
  const fs = await import('node:fs');
  const save = (name, html) => fs.writeFileSync(`${process.env.SNAPSHOT_DIR}/${name}.html`, html);
  save('home', (await req('GET', '/')).text);
  save('new', (await req('GET', '/new')).text);
  save('export', (await req('GET', '/export')).text);
  save('settings', (await req('GET', '/settings')).text);
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
