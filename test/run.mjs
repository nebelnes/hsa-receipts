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
// Settings form fields for the HSA accounts: [id, name, email, provider, url]
const accountsForm = (rows) => ({
  acct_id: rows.map((r) => r[0]), acct_name: rows.map((r) => r[1]), acct_email: rows.map((r) => r[2]),
  acct_provider: rows.map((r) => r[3]), acct_url: rows.map((r) => r[4]),
});

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

console.log('PDF from photos');

await step('photos become a valid multi-page PDF that standard tools can open', async () => {
  const { makePdf, jpegSize } = await import('../public/static/pdf.js');
  const jpg = new Uint8Array(await readFile(new URL('./fixtures/small.jpg', import.meta.url)));
  const size = jpegSize(jpg);
  assert.deepEqual(size, { width: 300, height: 400 });
  const pdf = makePdf([{ jpeg: jpg, ...size }, { jpeg: jpg, ...size }], { title: '2026-09-14 CVS Pharmacy $12.50' });
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const path = `${process.env.TMPDIR || '/tmp'}/hsa-test-${process.pid}.pdf`;
  writeFileSync(path, pdf);
  const info = execFileSync('pdfinfo', [path]).toString();
  assert.match(info, /Pages:\s+2/);
  assert.match(info, /Title:\s+2026-09-14 CVS Pharmacy \$12\.50/);
  assert.match(info, /Page size:\s+612 x 792 pts \(letter\)/);
  // Render page 1 and check the photo's dark frame is really there.
  const png = execFileSync('pdftoppm', ['-r', '20', '-f', '1', '-l', '1', '-gray', '-png', path]);
  assert.ok(png.length > 100);
  const pgm = execFileSync('pdftoppm', ['-r', '20', '-f', '1', '-l', '1', '-gray', path]).toString('latin1');
  const pixels = pgm.slice(pgm.lastIndexOf('\n255\n') + 5);
  assert.ok([...pixels].some((c) => c.charCodeAt(0) < 100), 'the image shows up on the page');
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
  const fd = upload(new File([new TextEncoder().encode('%PDF-1.4\n% card statement\n%%EOF')], 'card-statement.pdf', { type: 'application/pdf' }));
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
  await req('POST', '/settings', { ...accountsForm([['1', 'Alex', 'me@x.test', 'Fidelity', 'https://www.fidelity.com']]), people: 'Alex, Max, Sam', paid_with: 'Aven, HSA card' });
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
  let r = await req('POST', '/settings', { ...accountsForm([['1', 'Alex', 'me@x.test', 'Fidelity', 'javascript:alert(1)']]), people: 'Alex', paid_with: 'Aven' });
  assert.match(msgOf(r.location), /https:\/\//);
  r = await req('POST', '/settings', { ...accountsForm([['1', 'Alex', 'not-an-email', '', '']]), people: 'Alex', paid_with: 'Aven' });
  assert.match(msgOf(r.location), /doesn't look like an email/);
  r = await req('POST', '/settings', { ...accountsForm([['1', '', '', '', '']]), people: 'Alex', paid_with: 'Aven' });
  assert.match(msgOf(r.location), /at least one HSA/);
  r = await req('POST', '/settings', { ...accountsForm([['1', 'Alex', 'me@x.test', 'Fidelity', '']]), people: 'Alex, Max, Alex', paid_with: 'Aven\nHSA card' });
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
  assert.equal(lines[0], 'id,hsa,status,service_date,provider,patient,category,amount,paid_date,paid_with,reimbursed_date,reimbursed_amount,notes,files');
  assert.match(c.text, /"'=HYPERLINK\(""x""\)"/);
  assert.match(c.text, /"line one, ""quoted"""/);
  assert.match(c.text, /,Alex,Reimbursed,2025-11-03,Northside Hospital,Alex,,300,/);
});

await step('ZIP manifest: folders by year, one entry per file', async () => {
  const r = await req('GET', '/export/files.json');
  const m = JSON.parse(r.text);
  assert.ok(m.csv.startsWith('id,hsa,status'));
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

console.log('Two HSAs');

await step('two HSA accounts: separate totals, filters, picker and export folders', async () => {
  let r = await req('POST', '/settings', {
    ...accountsForm([['1', 'Alex', 'me@x.test', 'Fidelity', 'https://www.fidelity.com'], ['2', 'Maria', 'wife@x.test', 'HealthEquity', 'https://www.healthequity.com'], ['3', '', '', '', '']]),
    people: 'Alex, Maria, Max', paid_with: 'Aven, HSA card',
  });
  assert.match(msgOf(r.location), /Settings saved/);
  // The add page offers both, with the signed-in person's own HSA picked.
  const newPage = await req('GET', '/new', null, {}, { ...env });
  assert.match(newPage.text, /Whose HSA\?/);
  assert.match(newPage.text, /value="1" checked/);
  // Upload into Maria's HSA.
  const fd = upload(new File([PDF], 'eob.pdf', { type: 'application/pdf' }));
  fd.append('account', '2');
  r = await req('POST', '/new', fd);
  const mid = Number(r.location.match(/\/e\/(\d+)\//)[1]);
  assert.equal(q('SELECT account FROM expenses WHERE id = ?', mid)[0].account, '2');
  await req('POST', `/e/${mid}/edit`, { account: '2', service_date: '2026-10-02', provider: 'Piedmont Urgent Care', amount: '75.00', patient: 'Maria' });
  // Someone else's account number is ignored; a bogus one keeps the current account.
  await req('POST', `/e/${mid}/edit`, { account: '9', service_date: '2026-10-02', provider: 'Piedmont Urgent Care', amount: '75.00', patient: 'Maria' });
  assert.equal(q('SELECT account FROM expenses WHERE id = ?', mid)[0].account, '2');
  const home = await req('GET', '/');
  const alexOpen = q(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE status='open' AND account='1'`)[0].s;
  assert.match(home.text, new RegExp(`Alex can reimburse</div><div class="v">\\$${alexOpen.toFixed(2).replace('.', '\\.')}`));
  assert.match(home.text, /Maria can reimburse<\/div><div class="v">\$75\.00/);
  assert.match(home.text, /Both HSAs together/);
  assert.match(home.text, /<th>HSA<\/th>/);
  const onlyMaria = await req('GET', '/?status=open&acct=2');
  assert.match(onlyMaria.text, /Piedmont Urgent Care/);
  assert.ok(!/Northside|Smile Bright/.test(onlyMaria.text));
  const det = await req('GET', `/e/${mid}`);
  assert.match(det.text, /Reimbursed from Maria's HSA\?/);
  assert.match(det.text, /href="https:\/\/www\.healthequity\.com"/);
  const csv = await req('GET', '/export.csv');
  assert.match(csv.text, /,Maria,Not reimbursed,2026-10-02,Piedmont Urgent Care,Maria,,75,/);
  const m = JSON.parse((await req('GET', '/export/files.json')).text);
  assert.ok(m.files.some((f) => f.path.startsWith('Maria HSA/2026/2026-10-02 Piedmont Urgent Care $75.00')), JSON.stringify(m.files.map((f) => f.path)));
  assert.ok(m.files.some((f) => f.path.startsWith('Alex HSA/')));
  const exp = await req('GET', '/export');
  assert.match(exp.text, /<td>2026<\/td><td>Maria<\/td>/);
  // An HSA that still has receipts can't be removed.
  r = await req('POST', '/settings', { ...accountsForm([['1', 'Alex', 'me@x.test', '', '']]), people: 'Alex', paid_with: 'Aven' });
  assert.match(msgOf(r.location), /Maria's HSA still has 1 receipt/);
  r = await req('POST', '/settings', { ...accountsForm([['1', 'Alex', 'me@x.test', '', ''], ['2', 'Maria', 'me@x.test', '', '']]), people: 'Alex', paid_with: 'Aven' });
  assert.match(msgOf(r.location), /different email/);
});

await step('kids as people: usual HSA per person, moving them, and a by-person report', async () => {
  const twoAccts = accountsForm([['1', 'Alex', 'me@x.test', 'Fidelity', 'https://www.fidelity.com'], ['2', 'Maria', 'wife@x.test', 'HealthEquity', 'https://www.healthequity.com']]);
  let r = await req('POST', '/settings', { ...twoAccts, people: 'Alex, Maria, Max, Sam', paid_with: 'Aven', ph_name: ['Alex', 'Maria', 'Max', 'Sam', 'Ghost'], ph_acct: ['', '', '2', '2', '1'] });
  assert.match(msgOf(r.location), /Settings saved/);
  const s = await req('GET', '/settings');
  assert.match(s.text, /Usual HSA for each person/);
  assert.match(s.text, /name="ph_name" value="Max"><\/td><td><select name="ph_acct"[^>]*><option value="">Whoever adds it<\/option><option value="1" >Alex's HSA<\/option><option value="2" selected>/);
  // The edit page knows each kid's usual HSA and loads the switcher.
  const blank = await req('POST', '/new/blank', { account: '1' });
  const kid = Number(blank.location.match(/\/e\/(\d+)\/edit/)[1]);
  const edit = await req('GET', `/e/${kid}/edit`);
  assert.match(edit.text, /data-person-hsa="\{&quot;max&quot;:&quot;2&quot;,&quot;sam&quot;:&quot;2&quot;\}"/);
  assert.match(edit.text, /\/static\/person\.js/);
  // Saved under Alex's HSA by hand, then moved to Alex for good.
  await req('POST', `/e/${kid}/edit`, { account: '2', service_date: '2026-09-30', provider: 'Pediatric Dentistry', amount: '60.00', patient: 'Sam', category: 'Dental' });
  const kid2 = Number((await req('POST', '/new/blank', { account: '1' })).location.match(/\/e\/(\d+)\/edit/)[1]);
  await req('POST', `/e/${kid2}/edit`, { account: '1', service_date: '2026-10-01', provider: 'CVS Pharmacy', amount: '9.99', patient: 'Sam' });
  const list = await req('GET', '/?status=open&person=Sam');
  assert.match(list.text, /Move Sam's receipts to another HSA\?/);
  assert.match(list.text, /Maria: 1/);
  r = await req('POST', '/move', { person: 'Sam', account: '1', default: '1' });
  assert.match(msgOf(r.location), /Moved 1 receipt for Sam to Alex's HSA/);
  assert.deepEqual(q(`SELECT DISTINCT account FROM expenses WHERE patient = 'Sam' AND status = 'open'`).map((x) => x.account), ['1']);
  const edit2 = await req('GET', `/e/${kid}/edit`);
  assert.match(edit2.text, /&quot;sam&quot;:&quot;1&quot;/);
  // A reimbursed receipt stays where it was paid.
  await req('POST', `/e/${kid2}/reimburse`, { reimbursed_date: '2026-10-20', reimbursed_amount: '9.99' });
  await req('POST', '/move', { person: 'Sam', account: '2' });
  assert.equal(q('SELECT account FROM expenses WHERE id = ?', kid2)[0].account, '1');
  assert.equal(q('SELECT account FROM expenses WHERE id = ?', kid)[0].account, '2');
  assert.match(msgOf((await req('POST', '/move', { person: '', account: '2' })).location), /Pick a person/);
  // By-person report on the Export page.
  const exp = await req('GET', '/export');
  assert.match(exp.text, /<h2>By person<\/h2>/);
  assert.match(exp.text, />Sam<\/a><\/td><td class="num">2<\/td><td class="num">\$69\.99<\/td><td class="num">\$9\.99<\/td><td class="num">\$60\.00<\/td>/);
});

console.log('Email in');

const VERIFIED = 'ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=x.test header.s=s1; dmarc=pass header.from=x.test policy.dmarc=reject; spf=pass smtp.mailfrom=wife@x.test';
function rawEmail({ from = 'wife@x.test', subject = 'Fwd: Your statement', auth = VERIFIED, parts }) {
  const b = 'BOUNDARY_abc123';
  const head = [auth, `From: Maria <${from}>`, 'To: receipts@hsa.test', `Subject: ${subject}`, 'MIME-Version: 1.0'].filter(Boolean);
  if (!parts) return `${head.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n`;
  const body = parts.map((p) => `--${b}\r\n${p}`).join('\r\n') + `\r\n--${b}--\r\n`;
  return `${head.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\nThis is a multi-part message.\r\n${body}`;
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/.{76}/g, '$&\r\n');
async function sendEmail(raw, from = 'wife@x.test', e = { ...env, ALLOWED_EMAILS: 'me@x.test, wife@x.test' }) {
  const bytes = new TextEncoder().encode(raw);
  const msg = { from, to: 'receipts@hsa.test', rawSize: bytes.length, raw: new Blob([bytes]).stream(), rejected: null, setReject(r) { this.rejected = r; } };
  const before = q('SELECT COALESCE(MAX(id),0) m FROM expenses')[0].m;
  await worker.email(msg, e);
  const created = q('SELECT * FROM expenses WHERE id > ? ORDER BY id', before);
  return { rejected: msg.rejected, created };
}

await step('emailed PDF bill lands in the sender\'s HSA with the file attached', async () => {
  const pdfBytes = new TextEncoder().encode('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  const raw = rawEmail({
    subject: '=?utf-8?Q?Fwd:_Statement_from_Piedmont_=E2=80=93_October?=',
    parts: [
      'Content-Type: multipart/alternative; boundary="ALT"\r\n\r\n--ALT\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHi, see the attached bill =E2=80=93 thanks!\r\n--ALT\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hi, see the attached bill</p>\r\n--ALT--',
      `Content-Type: application/pdf; name="Statement Oct.pdf"\r\nContent-Disposition: attachment; filename*=utf-8''Statement%20Oct%E2%80%9926.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(pdfBytes)}`,
      'Content-Type: image/png; name="logo.png"\r\nContent-Disposition: inline; filename="logo.png"\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=',
    ],
  });
  const r = await sendEmail(raw);
  assert.equal(r.rejected, null);
  assert.equal(r.created.length, 1);
  const e = r.created[0];
  assert.equal(e.account, '2');
  assert.equal(e.status, 'draft');
  assert.equal(e.created_by, 'wife@x.test');
  assert.match(e.notes, /^Emailed: Fwd: Statement from Piedmont – October$/);
  const files = q('SELECT * FROM files WHERE expense_id = ?', e.id);
  assert.equal(files.length, 1, 'the logo is skipped');
  assert.equal(files[0].type, 'application/pdf');
  assert.equal(files[0].name, 'Statement Oct’26.pdf'.replace('’', '_'));
  const stored = env.FILES.objects.get(files[0].r2_key).bytes;
  assert.deepEqual([...stored], [...pdfBytes]);
  // Opening it reads the PDF.
  const det = await req('GET', `/e/${e.id}`);
  assert.match(det.text, /\/e\/\d+\/edit\?read=1/);
  assert.match(det.text, /class="doc"[^>]*data-pdf="\/files\/\d+"/, 'PDF tile gets a page-1 preview');
  assert.match(det.text, /\/static\/thumbs\.js/);
});

await step('emailed photo and an e-receipt in the email body', async () => {
  const photo = await sendEmail(rawEmail({
    from: 'me@x.test',
    parts: [`Content-Type: image/jpeg\r\nContent-Disposition: attachment; filename="IMG_7781.JPG"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(JPEG)}`],
  }), 'me@x.test');
  assert.equal(photo.rejected, null);
  assert.equal(photo.created[0].account, '1');
  assert.equal(q('SELECT type FROM files WHERE expense_id = ?', photo.created[0].id)[0].type, 'image/jpeg');

  const html = '<html><body><h2>CVS Pharmacy</h2><table><tr><td>Fill Date</td><td>10/14/2026</td></tr><tr><td>Rx 0418823 Amoxicillin</td><td></td></tr><tr><td>Total</td><td>$12.50</td></tr></table><p>Thank you</p></body></html>';
  const ereceipt = await sendEmail(rawEmail({
    subject: 'Your CVS Pharmacy receipt',
    parts: [`Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(new TextEncoder().encode(html))}`],
  }));
  assert.equal(ereceipt.rejected, null);
  const e = ereceipt.created[0];
  assert.equal(e.account, '2');
  assert.equal(e.service_date, '2026-10-14');
  assert.equal(e.amount, 12.5);
  assert.equal(e.category, 'Pharmacy');
  assert.match(e.provider, /CVS/);
  assert.equal(e.status, 'draft', 'still waits for a check');
  assert.match(e.ocr_text, /Amoxicillin/);
});

await step('email from strangers, spoofed senders or with nothing in it is refused', async () => {
  const stranger = await sendEmail(rawEmail({ from: 'spam@evil.test', parts: [`Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="x.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PDF)}`] }), 'spam@evil.test');
  assert.match(stranger.rejected, /only accepts receipts from family/);
  assert.equal(stranger.created.length, 0);
  const spoof = await sendEmail(rawEmail({ auth: 'ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=fail; dmarc=fail header.from=x.test; spf=fail', parts: [`Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="x.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PDF)}`] }));
  assert.match(spoof.rejected, /Could not verify/);
  assert.equal(spoof.created.length, 0);
  const noAuth = await sendEmail(rawEmail({ auth: '', parts: [`Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="x.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PDF)}`] }));
  assert.match(noAuth.rejected, /Could not verify/);
  const headerMismatch = await sendEmail(rawEmail({ from: 'spam@evil.test', parts: [`Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="x.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(PDF)}`] }), 'wife@x.test');
  assert.match(headerMismatch.rejected, /only accepts receipts from family/);
  const empty = await sendEmail(rawEmail({ parts: ['Content-Type: text/plain\r\n\r\nhi'] }));
  assert.match(empty.rejected, /No receipt found/);
  const zip = await sendEmail(rawEmail({ parts: [`Content-Type: application/zip\r\nContent-Disposition: attachment; filename="a.zip"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(JPEG)}`] }));
  assert.match(zip.rejected, /No receipt found/);
});

console.log('Duplicates');

await step('duplicate rules: same file, same date+amount, similar provider nearby, different people', async () => {
  const { compare, similarProvider } = await import('../src/dups.js');
  assert.ok(similarProvider('CVS Pharmacy', 'CVS/pharmacy #X0043'));
  assert.ok(similarProvider('Stonewalk Family Dentistry', 'STONEWALK DENTAL'));
  assert.ok(!similarProvider('Stonewalk Family Dentistry', 'North American Dental Group'));
  const base = { amount: 100, service_date: '2026-09-07', provider: 'CVS Pharmacy', patient: 'Mia' };
  assert.deepEqual(compare(base, { ...base, provider: 'Walgreens' }), ['same date and amount']);
  assert.deepEqual(compare(base, { ...base, service_date: '2026-09-10', provider: 'CVS #43' }), ['same provider and amount, 3 days apart']);
  assert.deepEqual(compare(base, { ...base, service_date: '2026-10-07' }), [], 'monthly payments to the same place are fine');
  assert.deepEqual(compare(base, { ...base, amount: 100.01 }), []);
  assert.deepEqual(compare(base, { ...base, patient: 'Leo' }), [], 'two kids, same copay, same day');
  assert.deepEqual(compare(base, { ...base, patient: '' }), ['same date and amount']);
  assert.deepEqual(compare({ amount: null }, { amount: null }, { sharedFile: true }), ['same receipt file']);
});

await step('same photo uploaded twice is flagged; "Not a duplicate" clears it; deleting one clears it', async () => {
  const photo = new TextEncoder().encode('\xff\xd8 dup-test photo \xff\xd9');
  const a = Number((await req('POST', '/new', upload(new File([photo], 'a.jpg', { type: 'image/jpeg' })))).location.match(/\/e\/(\d+)\//)[1]);
  const b = Number((await req('POST', '/new', upload(new File([photo], 'b.jpg', { type: 'image/jpeg' })))).location.match(/\/e\/(\d+)\//)[1]);
  assert.match((await req('GET', `/e/${b}/edit?read=1`)).text, new RegExp(`Possible duplicate[\\s\\S]*href="/e/${a}"[\\s\\S]*same receipt file`));
  assert.match((await req('GET', `/e/${a}`)).text, new RegExp(`href="/e/${b}"`));
  const home = await req('GET', '/');
  assert.match(home.text, /look like possible duplicates/);
  const dupList = await req('GET', '/?status=dups');
  assert.match(dupList.text, new RegExp(`href="/e/${a}[/"]`));
  assert.match(dupList.text, new RegExp(`href="/e/${b}[/"]`));
  assert.match(dupList.text, /Duplicate\?/);

  const ok = await req('POST', `/e/${b}/notdup`, { other: String(a) });
  assert.match(msgOf(ok.location), /kept as separate/);
  assert.doesNotMatch((await req('GET', `/e/${b}`)).text, /Possible duplicate/);

  // A different pair: same date and amount, typed in by hand.
  const c = Number((await req('POST', '/new/blank', {})).location.match(/\/e\/(\d+)\//)[1]);
  const d = Number((await req('POST', '/new/blank', {})).location.match(/\/e\/(\d+)\//)[1]);
  for (const id of [c, d]) await req('POST', `/e/${id}/edit`, { service_date: '2026-03-03', provider: id === c ? 'Labcorp' : 'LabCorp of America', amount: '23.20' });
  await req('POST', `/e/${c}/reimburse`, { reimbursed_date: '2026-03-10', reimbursed_amount: '23.20' });
  const dv = await req('GET', `/e/${d}`);
  assert.match(dv.text, /same date and amount/);
  assert.match(dv.text, /already reimbursed, so don.t claim this again/);
  await req('POST', `/e/${d}/delete`, { confirm: '1' });
  assert.doesNotMatch((await req('GET', `/e/${c}`)).text, /Possible duplicate/);
});

await step('EOBs and statements shared by several receipts are not flagged', async () => {
  const eob = new TextEncoder().encode('%PDF-1.4\n% one EOB, two visits\n%%EOF');
  const ids = [];
  for (const amt of ['40.00', '55.00']) {
    const id = Number((await req('POST', '/new/blank', {})).location.match(/\/e\/(\d+)\//)[1]);
    await req('POST', `/e/${id}/edit`, { service_date: amt === '40.00' ? '2026-04-01' : '2026-04-15', provider: 'Piedmont', amount: amt });
    const fd = upload(new File([eob], 'eob.pdf', { type: 'application/pdf' }));
    fd.append('kind', 'eob');
    await req('POST', `/e/${id}/files`, fd);
    ids.push(id);
  }
  for (const id of ids) assert.doesNotMatch((await req('GET', `/e/${id}`)).text, /Possible duplicate/);
});

await step('the same e-receipt emailed twice is flagged', async () => {
  const html = '<p>Walgreens</p><p>Date 05/02/2026</p><p>Total $8.99</p>';
  const send = (subject) => sendEmail(rawEmail({ subject, parts: [`Content-Type: text/html; charset=utf-8\r\n\r\n${html}`] }));
  const one1 = (await send('Your Walgreens receipt')).created[0];
  const two = (await send('Fwd: Your Walgreens receipt')).created[0];
  assert.ok(one1.source_hash && one1.source_hash === two.source_hash);
  assert.match((await req('GET', `/e/${two.id}`)).text, /same emailed receipt/);
});

console.log('Filling in emailed receipts');

await step('card terminal slips: "Total Amt......70.60" with dot leaders', async () => {
  const slip = (amt) => `Stonewalk Family Dentistry\n5304 Windward Pkwy Suite 107\nAlpharetta, GA 300043828\n(770)777- 1911\nDate...........03/18/2024 8:08:24 AM\nTrans Type.....SALE\nTransaction #..28649074\nAccount........************6358\nResult.........Approved\nTotal Amt......${amt}\nI agree to pay the above total amount`;
  for (const [amt, want] of [['70.60', 70.6], ['$100.00', 100], ['934.20', 934.2], ['1,250.00', 1250]]) {
    const g = parseReceipt(slip(amt), { today: TODAY });
    assert.equal(g.amount, want, amt);
    assert.equal(g.date, '2024-03-18');
    assert.equal(g.provider, 'Stonewalk Family Dentistry');
  }
  assert.equal(parseReceipt('Version 1.2.50 Total $5.00', { today: TODAY }).amount, 5);
  const { cardSlip } = await import('../src/pages/expenses.js');
  assert.deepEqual(cardSlip(slip('70.60').replace('Result', 'Card Type......VISA\nResult')), { paid: true, card: 'Visa ending 6358' });
  assert.deepEqual(cardSlip('Account........************1002\nCard Type......Amex\nTrans Type.....SALE'), { paid: true, card: 'Amex ending 1002' });
  assert.deepEqual(cardSlip('Patient Balance Due $85.00'), { paid: false, card: null });
});

await step('payment confirmation with an attachment: details come from the email text', async () => {
  const body = 'Thank you for your payment to Labcorp.\r\nInvoice number: 87661140\r\nPayment date: 02/05/2025\r\nPayment amount: $23.20\r\n';
  const r = await sendEmail(rawEmail({
    subject: 'Fwd: Your Labcorp Payment Confirmation',
    parts: [`Content-Type: text/plain\r\n\r\n${body}`, `Content-Type: image/png\r\nContent-Disposition: attachment; filename="receipt.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(new Uint8Array(20000).fill(7))}`],
  }));
  const e = r.created[0];
  assert.equal(e.service_date, '2025-02-05');
  assert.equal(e.amount, 23.2);
  assert.equal(e.provider, 'Labcorp');
  assert.equal(e.paid_date, '2025-02-05');
  assert.equal(e.category, 'Lab / imaging');
});

await step('statement email: provider from the email, rest left for the PDF; "Read all" fills it in', async () => {
  const body = '| Your Billing Statement is Ready |\r\n| Hi Alexey, |\r\n| Your latest billing statement from Stonewalk Family Dentistry is attached to this email. |\r\n| Stonewalk Family Dentistry |\r\n| 5304 Windward Pkwy |\r\n';
  const r = await sendEmail(rawEmail({
    subject: 'Electronic Statement',
    parts: [`Content-Type: text/plain\r\n\r\n${body}`, `Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="ElectronicStatement.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(new TextEncoder().encode('%PDF-1.4\n% stonewalk\n%%EOF'))}`],
  }));
  const e = r.created[0];
  assert.equal(e.provider, 'Stonewalk Family Dentistry');
  assert.equal(e.amount, null);
  assert.equal(e.paid_date, null, 'a bill is not a payment');
  assert.equal(e.status, 'draft');

  const drafts = await req('GET', '/?status=draft');
  assert.match(drafts.text, new RegExp(`data-read="${e.id}" data-file="/files/\\d+" data-type="application/pdf"`));
  assert.match(drafts.text, /id="read-all"/);
  assert.match(drafts.text, /\/static\/read-all\.js/);

  // What the browser would send after reading the PDF.
  const pdfText = 'Stonewalk Family Dentistry\nStatement Date 10/01/2026\nPatient: Alexey\nDate of Service 09/12/2026 Periodic exam\nPatient Balance Due $85.00\n';
  const res = await req('POST', `/e/${e.id}/autofill`, { text: pdfText });
  const out = JSON.parse(res.text);
  assert.equal(out.complete, true);
  assert.deepEqual(out.filled.sort(), ['amount', 'date']);
  const after = q('SELECT * FROM expenses WHERE id = ?', e.id)[0];
  assert.equal(after.provider, 'Stonewalk Family Dentistry', 'kept');
  assert.equal(after.amount, 85);
  assert.equal(after.status, 'open');
  assert.match(after.ocr_text, /Periodic exam[\s\S]*---[\s\S]*Billing Statement/);

  // Never overwrites, and leaves finished receipts alone.
  const again = JSON.parse((await req('POST', `/e/${e.id}/autofill`, { text: 'Total $1.00' })).text);
  assert.ok(!again.filled.includes('amount'));
  assert.equal(q('SELECT amount FROM expenses WHERE id = ?', e.id)[0].amount, 85);
  assert.equal((await req('POST', '/e/999999/autofill', { text: 'x' })).status, 404);
  await req('POST', `/e/${e.id}/reimburse`, { reimbursed_date: '2026-10-20', reimbursed_amount: '85.00' });
  assert.deepEqual(JSON.parse((await req('POST', `/e/${e.id}/autofill`, { text: 'Card Type......Visa\nAccount....****1234\nApproved' })).text).filled, [], 'reimbursed ones are left alone');
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
