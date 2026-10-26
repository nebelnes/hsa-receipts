// Receipts: list, add (camera / files / share from a scanner app), edit,
// mark reimbursed, export.

import { all, one, run, getSetting } from '../db.js';
import { esc, moneyExact, isDate, today, niceDate, num, list, splitList } from '../util.js';
import { page, errorPage, flashFrom } from '../views/layout.js';
import { saveFiles, filesFor, countUploads, KINDS, deleteExpenseFiles } from '../files.js';
import { getAccounts, accountForUser, accountName, validAccount } from '../accounts.js';

export const CATEGORIES = [
  'Doctor visit',
  'Dental',
  'Vision',
  'Pharmacy',
  'Lab / imaging',
  'Hospital / ER',
  'Therapy / counseling',
  'Equipment / supplies',
  'Other',
];

export const STATUS = {
  draft: { label: 'Needs details', chip: 'warn' },
  open: { label: 'Not reimbursed', chip: '' },
  reimbursed: { label: 'Reimbursed', chip: 'ok' },
  hsa_paid: { label: 'Paid with HSA card', chip: 'ok' },
};

export const DEFAULT_PAID_WITH = 'Aven, Amex Blue Cash Preferred, Chase Sapphire Preferred, Chase Freedom Unlimited, Wells Fargo Active Cash, Bank of America debit, Chase debit, HSA card, Cash or check';

export async function lists(env) {
  return {
    people: splitList(await getSetting(env, 'people', '')),
    paidWith: splitList(await getSetting(env, 'paid_with', DEFAULT_PAID_WITH)),
    accounts: await getAccounts(env),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Radio buttons for choosing which HSA a receipt belongs to.
function accountPicker(accounts, current, name = 'account') {
  if (accounts.length < 2) return `<input type="hidden" name="${name}" value="${esc(accounts[0]?.id || '1')}">`;
  return `<fieldset class="acct"><legend>Whose HSA?</legend>${accounts
    .map((a) => `<label><input type="radio" name="${name}" value="${esc(a.id)}" ${a.id === String(current) ? 'checked' : ''}> ${esc(a.name)}</label>`)
    .join('')}</fieldset>`;
}

const shortDate = (s) => (isDate(s) ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}/${s.slice(2, 4)}` : '');

const chip = (status) => {
  const s = STATUS[status] || STATUS.draft;
  return `<span class="chip ${s.chip}">${esc(s.label)}</span>`;
};

const isHsaCard = (paidWith) => /\bHSA\b/i.test(String(paidWith || ''));

// ---------- List ----------

export async function listPage(env, user, url) {
  const status = ['open', 'reimbursed', 'draft', 'all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
  const yearParam = url.searchParams.get('year') || 'all';
  const year = /^\d{4}$/.test(yearParam) ? yearParam : 'all';
  const person = url.searchParams.get('person') || '';
  const { people, accounts } = await lists(env);
  const acct = validAccount(accounts, url.searchParams.get('acct')) || '';
  const multi = accounts.length > 1;

  const where = [];
  const args = [];
  if (acct) {
    where.push('account = ?');
    args.push(acct);
  }
  if (status === 'reimbursed') where.push(`status IN ('reimbursed','hsa_paid')`);
  else if (status !== 'all') {
    where.push('status = ?');
    args.push(status);
  }
  if (year !== 'all') {
    where.push(`substr(COALESCE(service_date, created_at), 1, 4) = ?`);
    args.push(year);
  }
  if (person) {
    where.push('patient = ?');
    args.push(person);
  }
  const rows = await all(
    env,
    `SELECT e.*, (SELECT COUNT(*) FROM files f WHERE f.expense_id = e.id) AS nfiles
       FROM expenses e ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(service_date, substr(created_at, 1, 10)) DESC, id DESC LIMIT 500`,
    ...args,
  );

  const thisYear = today().slice(0, 4);
  const open = await one(env, `SELECT COUNT(*) n, COALESCE(SUM(amount), 0) s FROM expenses WHERE status = 'open'`);
  const openBy = new Map((await all(env, `SELECT account, COUNT(*) n, COALESCE(SUM(amount), 0) s FROM expenses WHERE status = 'open' GROUP BY account`)).map((r) => [String(r.account), r]));
  const paidBack = await one(env, `SELECT COALESCE(SUM(reimbursed_amount), 0) s FROM expenses WHERE status = 'reimbursed' AND substr(reimbursed_date, 1, 4) = ?`, thisYear);
  const drafts = await one(env, `SELECT COUNT(*) n FROM expenses WHERE status = 'draft'`);
  const years = (await all(env, `SELECT DISTINCT substr(COALESCE(service_date, created_at), 1, 4) y FROM expenses ORDER BY y DESC`)).map((r) => r.y).filter(Boolean);
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  const filters = `<form class="card filters" method="get" action="/">
    <div><label for="f-status">Show</label><select id="f-status" name="status" onchange="this.form.submit()">
      ${opt('open', 'Not reimbursed', status)}${opt('draft', 'Needs details', status)}${opt('reimbursed', 'Reimbursed', status)}${opt('all', 'All', status)}</select></div>
    ${multi ? `<div><label for="f-acct">HSA</label><select id="f-acct" name="acct" onchange="this.form.submit()">${opt('', 'Both', acct)}${accounts.map((a) => opt(a.id, a.name, acct)).join('')}</select></div>` : ''}
    <div><label for="f-year">Year</label><select id="f-year" name="year" onchange="this.form.submit()">${opt('all', 'All years', year)}${years.map((y) => opt(y, y, year)).join('')}</select></div>
    ${people.length ? `<div><label for="f-person">Person</label><select id="f-person" name="person" onchange="this.form.submit()">${opt('', 'Everyone', person)}${people.map((p) => opt(p, p, person)).join('')}</select></div>` : ''}
    <noscript><button class="small">Filter</button></noscript>
  </form>`;

  const bulk = status === 'open' && rows.length > 0;
  const table = rows.length
    ? `<div class="card tablewrap"><table>
        <thead><tr>${bulk ? '<th><input type="checkbox" id="all" aria-label="Select all"></th>' : ''}<th>Date</th><th>Provider</th><th>${multi && !acct ? 'HSA' : 'Person'}</th><th class="hide-sm">${multi && !acct ? 'Person' : 'Category'}</th><th class="num">Amount</th>${status === 'open' ? '' : '<th>Status</th>'}<th class="hide-sm">Files</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
          ${bulk ? `<td><input type="checkbox" name="ids" value="${r.id}" form="bulk" data-amount="${Number(r.amount) || 0}" aria-label="Select"></td>` : ''}
          <td class="nowrap">${esc(shortDate(r.service_date) || '—')}</td>
          <td><a href="/e/${r.id}">${esc(r.provider || 'Untitled receipt')}</a></td>
          ${multi && !acct
            ? `<td>${esc(accountName(accounts, r.account))}</td><td class="hide-sm">${esc(r.patient || '')}</td>`
            : `<td>${esc(r.patient || '')}</td><td class="hide-sm">${esc(r.category || '')}</td>`}
          <td class="num">${moneyExact(r.amount)}</td>
          ${status === 'open' ? '' : `<td>${chip(r.status)}</td>`}
          <td class="hide-sm">${r.nfiles ? `📎 ${r.nfiles}` : '<span class="chip warn">no file</span>'}</td></tr>`,
          )
          .join('')}</tbody>
        <tfoot><tr>${bulk ? '<td></td>' : ''}<td colspan="3"><strong>${rows.length} receipt${rows.length === 1 ? '' : 's'}</strong></td><td class="hide-sm"></td><td class="num"><strong>${moneyExact(total)}</strong></td>${status === 'open' ? '' : '<td></td>'}<td class="hide-sm"></td></tr></tfoot>
      </table></div>`
    : `<div class="card"><p class="muted">${status === 'open' && year === 'all' && !person && !acct ?'No unreimbursed receipts yet. Tap <strong>Add receipt</strong> to save your first one.' : 'Nothing matches these filters.'}</p></div>`;

  const bulkForm = bulk
    ? `<form id="bulk" class="card" method="post" action="/reimburse">
        <strong>Reimbursed several at once?</strong>
        <p class="hint">Tick the receipts you were paid back for, then save.${multi && !acct ? ' Tip: pick one HSA in the filter above first, since each HSA pays back its own receipts.' : ''} Selected: <strong id="sel-total">$0.00</strong> (<span id="sel-n">0</span>)</p>
        <div class="row"><div><label for="bulk-date">Date reimbursed</label><input id="bulk-date" type="date" name="reimbursed_date" value="${today()}" required></div></div>
        <button id="bulk-btn" type="submit" disabled>Mark selected as reimbursed</button>
      </form>`
    : '';

  const perAccount = multi
    ? accounts
        .map((a) => {
          const r = openBy.get(a.id) || { n: 0, s: 0 };
          return `<a class="stat link" href="/?status=open&acct=${esc(a.id)}"><div class="k">${esc(a.name)} can reimburse</div><div class="v">${moneyExact(r.s)}</div><div class="k">${plural(r.n, 'receipt')} waiting</div></a>`;
        })
        .join('')
    : '';
  const body = `
    <div class="stats">
      ${perAccount}
      <div class="stat"><div class="k">${multi ? 'Both HSAs together' : 'Available to reimburse'}</div><div class="v">${moneyExact(open.s)}</div><div class="k">${plural(open.n, 'receipt')} waiting</div></div>
      <div class="stat"><div class="k">Reimbursed in ${thisYear}</div><div class="v">${moneyExact(paidBack.s)}</div></div>
      <div class="stat"><div class="k">Needs details</div><div class="v">${drafts.n}</div>${drafts.n ? '<div class="k"><a href="/?status=draft">Finish them</a></div>' : ''}</div>
    </div>
    <a class="btn big" href="/new">＋ Add receipt</a>
    ${drafts.n && status !== 'draft' ? `<div class="banner warn">${drafts.n} receipt${drafts.n === 1 ? ' is' : 's are'} missing the date, provider or amount. <a href="/?status=draft">Finish ${drafts.n === 1 ? 'it' : 'them'}</a>.</div>` : ''}
    ${filters}${table}${bulkForm}`;
  return page({ title: 'Receipts', active: 'list', user, body, flash: flashFrom(url), scripts: bulk ? ['/static/list.js'] : [] });
}

// ---------- Add ----------

export async function newPage(env, user, url) {
  const { accounts } = await lists(env);
  const mine = accountForUser(accounts, user);
  const inbox = String(env.RECEIPTS_EMAIL || '').trim();
  const body = `<h1>Add a receipt</h1>
    <form id="capture" class="card" method="post" action="/new" enctype="multipart/form-data">
      ${accountPicker(accounts, mine)}
      <label class="btn big" for="cam">📷 Take a photo</label>
      <input id="cam" type="file" name="files" accept="image/*" capture="environment" hidden>
      <label class="btn big ghost" for="pick">📁 Choose photos or PDFs</label>
      <input id="pick" type="file" name="files" accept="image/*,application/pdf,.pdf,.heic" multiple hidden>
      <p id="status" class="status muted" role="status"></p>
      <noscript><p class="hint">Pick a file above, then press Upload.</p><button>Upload</button></noscript>
      <p class="hint">Several pages of one bill? Choose them together and they're saved as one receipt.</p>
    </form>
    <div class="card">
      <strong>Sharper scans with auto-cropping</strong>
      <ol class="small">
        <li>On Android, open this site in Chrome → menu ⋮ → <em>Add to Home screen</em> (once).</li>
        <li>Scan the paper with Google Drive (＋ → <em>Scan</em>) or your phone's document scanner.</li>
        <li>Tap <em>Share</em> → <strong>HSA Receipts</strong>. The site opens with the scan attached and reads it for you.</li>
      </ol>
      <p class="hint">On iPhone: scan in the Files or Notes app, save it, then use <em>Choose photos or PDFs</em>.</p>
    </div>
    ${inbox ? `<div class="card">
      <strong>📧 Or email it</strong>
      <p class="small">Forward bills, PDF invoices, photos or e-receipts to <a href="mailto:${esc(inbox)}"><strong>${esc(inbox)}</strong></a> from your own email address. Each one becomes a receipt in the sender's HSA, ready for you to check.</p>
    </div>` : ''}
    <form class="card" method="post" action="/new/blank">
      ${accountPicker(accounts, mine)}
      <strong>No file?</strong> <span class="muted small">Enter the details now and attach the receipt later.</span><br>
      <button class="ghost small" type="submit">Enter details only</button>
    </form>`;
  return page({ title: 'Add a receipt', active: 'new', user, body, flash: flashFrom(url), scripts: ['/static/capture.js'] });
}

// Creates a draft receipt from uploaded files. Returns { id } or { error }.
export async function createFromUpload(env, user, uploads, { allowEmpty = false, account = null, fields = {} } = {}) {
  const n = countUploads(uploads);
  if (!n && !allowEmpty) return { error: 'Choose a photo or PDF first.' };
  const accounts = await getAccounts(env);
  const acct = validAccount(accounts, account) || accountForUser(accounts, user);
  const r = await run(
    env,
    `INSERT INTO expenses (status, created_by, account, service_date, provider, amount, category, paid_date, notes, ocr_text)
     VALUES ('draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    user || null, acct, fields.service_date || null, fields.provider || null, fields.amount ?? null,
    fields.category || null, fields.paid_date || null, fields.notes || null, fields.ocr_text || null,
  );
  const id = r.meta.last_row_id;
  if (!n) return { id, skipped: [] };
  const s = await saveFiles(env, id, uploads, 'receipt');
  if (!s.saved) {
    await run(env, 'DELETE FROM expenses WHERE id = ?', id);
    return { error: `Nothing was saved. ${s.skipped.join('; ')}` };
  }
  return { id, skipped: s.skipped };
}

// ---------- One receipt ----------

async function getExpense(env, id) {
  return one(env, 'SELECT * FROM expenses WHERE id = ?', id);
}

function fileTiles(files, { manage = false, expenseId } = {}) {
  if (!files.length) return '<p class="muted">No files yet.</p>';
  return `<div class="thumbs">${files
    .map((f) => {
      const preview = f.type.startsWith('image/') && !/hei[cf]/.test(f.type)
        ? `<a href="/files/${f.id}" target="_blank" rel="noopener"><img src="/files/${f.id}" alt="${esc(f.name)}" loading="lazy"></a>`
        : `<a class="doc" href="/files/${f.id}" target="_blank" rel="noopener">${f.type === 'application/pdf' ? '📄' : '🖼️'}</a>`;
      const kinds = Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${esc(v)}</option>`).join('');
      return `<div class="thumb">${preview}
        <div class="small"><a href="/files/${f.id}?download=1">${esc(f.name)}</a></div>
        ${manage
          ? `<form method="post" action="/files/${f.id}/kind"><select name="kind" aria-label="What is this file?" onchange="this.form.submit()">${kinds}</select><noscript><button class="small">Set</button></noscript></form>
             <form method="post" action="/files/${f.id}/delete" onsubmit="return confirm('Delete this file?')"><input type="hidden" name="expense" value="${expenseId}"><button class="small ghost">Remove file</button></form>`
          : `<span class="chip">${esc(KINDS[f.kind] || KINDS.other)}</span>`}
      </div>`;
    })
    .join('')}</div>`;
}

export async function detailPage(env, user, url, id) {
  const e = await getExpense(env, id);
  if (!e) return null;
  const files = await filesFor(env, id);
  const { accounts } = await lists(env);
  const acc = accounts.find((a) => a.id === String(e.account)) || {};
  const hsaName = acc.provider ? `${acc.name}'s HSA at ${acc.provider}` : '';
  const hsaUrl = acc.url || '';
  const kinds = new Set(files.map((f) => f.kind));
  const field = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;

  let money = '';
  if (e.status === 'open') {
    money = `<form class="card" method="post" action="/e/${id}/reimburse">
      <strong>Reimbursed from ${accounts.length > 1 ? `${esc(acc.name || 'the')}'s` : 'your'} HSA?</strong>
      ${hsaUrl ? `<p class="hint">Request it at <a href="${esc(hsaUrl)}" target="_blank" rel="noopener">${esc(hsaName || 'your HSA')}</a>, then record it here.</p>` : ''}
      <div class="row">
        <div><label for="r-date">Date reimbursed</label><input id="r-date" type="date" name="reimbursed_date" value="${today()}" required></div>
        <div><label for="r-amt">Amount</label><input id="r-amt" name="reimbursed_amount" inputmode="decimal" value="${e.amount ?? ''}" required></div>
      </div>
      <button type="submit">Mark as reimbursed</button>
    </form>`;
  } else if (e.status === 'reimbursed') {
    money = `<div class="card"><span class="chip ok">Reimbursed</span> ${moneyExact(e.reimbursed_amount)} on ${esc(niceDate(e.reimbursed_date))}
      <form class="inline" method="post" action="/e/${id}/unreimburse"><button class="small ghost">Undo</button></form></div>`;
  } else if (e.status === 'hsa_paid') {
    money = `<div class="card"><span class="chip ok">Paid with HSA card</span> Nothing to reimburse. Keep the receipt as proof the expense qualified.</div>`;
  } else {
    money = `<div class="banner warn">Add the date, provider and amount to finish this receipt. <a href="/e/${id}/edit?read=1">Fill in details</a></div>`;
  }

  const proofTip = e.category && !['Pharmacy', 'Equipment / supplies'].includes(e.category) && !kinds.has('eob') && !kinds.has('payment')
    ? '<p class="hint">Tip: for doctor and hospital bills, the IRS wants an itemized bill or insurance EOB, plus proof you paid (card receipt or statement line). Add them below and set the type.</p>'
    : '';

  const body = `<p><a href="/">← Receipts</a></p>
    <h1>${esc(e.provider || 'Untitled receipt')} ${chip(e.status)}</h1>
    ${money}
    <div class="card"><table>
      ${accounts.length > 1 ? field('HSA', esc(accountName(accounts, e.account))) : ''}
      ${field('Date of service', esc(niceDate(e.service_date) || '—'))}
      ${field('Provider', esc(e.provider || '—'))}
      ${field('Person', esc(e.patient || '—'))}
      ${field('Category', esc(e.category || '—'))}
      ${field('Amount you paid', `<strong>${moneyExact(e.amount)}</strong>`)}
      ${field('Paid on', esc(niceDate(e.paid_date) || '—'))}
      ${field('Paid with', esc(e.paid_with || '—'))}
      ${e.notes ? field('Notes', esc(e.notes).replace(/\n/g, '<br>')) : ''}
      ${field('Added', `${esc(niceDate(String(e.created_at || '').slice(0, 10)))}${e.created_by ? ` by ${esc(e.created_by)}` : ''}`)}
    </table>
    <a class="btn" href="/e/${id}/edit">Edit details</a></div>
    <h2>Files</h2>
    <div class="card">${fileTiles(files, { manage: true, expenseId: id })}${proofTip}
      <form method="post" action="/e/${id}/files" enctype="multipart/form-data">
        <label for="more">Add more files</label>
        <input id="more" type="file" name="files" accept="image/*,application/pdf,.pdf,.heic" multiple required>
        <div class="row"><div><label for="kind">This is a</label><select id="kind" name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div></div>
        <button type="submit">Upload</button>
      </form>
    </div>
    <h2>Delete</h2>
    <form class="card" method="post" action="/e/${id}/delete">
      <label class="small" style="font-weight:500"><input type="checkbox" name="confirm" value="1" required>Yes, delete this receipt and its files</label>
      <button class="danger small" type="submit">Delete receipt</button>
    </form>`;
  return page({ title: e.provider || 'Receipt', user, body, flash: flashFrom(url) });
}

export async function editPage(env, user, url, id) {
  const e = await getExpense(env, id);
  if (!e) return null;
  const files = await filesFor(env, id);
  const { people, paidWith, accounts } = await lists(env);
  const providers = (await all(env, `SELECT DISTINCT provider FROM expenses WHERE provider IS NOT NULL AND provider != '' ORDER BY provider LIMIT 200`)).map((r) => r.provider);
  const readable = files.find((f) => f.type.startsWith('image/') && !/hei[cf]/.test(f.type)) || files.find((f) => f.type === 'application/pdf');
  const auto = url.searchParams.get('read') === '1' && readable;
  const v = (k) => esc(e[k] ?? '');
  const cats = ['', ...CATEGORIES].map((c) => `<option value="${esc(c)}" ${e.category === c ? 'selected' : ''}>${esc(c || 'Choose…')}</option>`).join('');
  const dl = (idName, items) => `<datalist id="${idName}">${items.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;

  const reader = readable
    ? `<div class="card" id="ocr" data-file="/files/${readable.id}" data-type="${esc(readable.type)}" data-auto="${auto ? '1' : '0'}">
        ${readable.type === 'application/pdf' ? `<p>📄 <a href="/files/${readable.id}" target="_blank" rel="noopener">${esc(readable.name)}</a></p>` : `<a href="/files/${readable.id}" target="_blank" rel="noopener"><img src="/files/${readable.id}" alt="Receipt" style="max-width:100%;max-height:260px;border-radius:8px;display:block;margin:auto"></a>`}
        <p id="ocr-status" class="status muted" role="status">${auto ? 'Reading the receipt…' : ''}</p>
        <button type="button" id="ocr-btn" class="ghost small">${auto ? 'Reading…' : 'Read receipt and fill in'}</button>
      </div>`
    : '';

  const body = `<p><a href="/e/${id}">← Back</a></p>
    <h1>${e.status === 'draft' ? 'Receipt details' : 'Edit receipt'}</h1>
    ${reader}
    <form class="card" method="post" action="/e/${id}/edit">
      ${accountPicker(accounts, e.account || accounts[0]?.id)}
      <div class="row">
        <div><label for="service_date">Date of service</label><input id="service_date" type="date" name="service_date" value="${v('service_date')}"></div>
        <div><label for="amount">Amount you paid ($)</label><input id="amount" name="amount" inputmode="decimal" placeholder="0.00" value="${e.amount ?? ''}"></div>
      </div>
      <label for="provider">Provider or store</label>
      <input id="provider" name="provider" list="providers" autocomplete="off" value="${v('provider')}">${dl('providers', providers)}
      <div class="row">
        <div><label for="patient">Person</label><input id="patient" name="patient" list="people" autocomplete="off" value="${v('patient')}">${dl('people', people)}</div>
        <div><label for="category">Category</label><select id="category" name="category">${cats}</select></div>
      </div>
      <div class="row">
        <div><label for="paid_date">Paid on</label><input id="paid_date" type="date" name="paid_date" value="${v('paid_date')}"></div>
        <div><label for="paid_with">Paid with</label><input id="paid_with" name="paid_with" list="cards" autocomplete="off" value="${v('paid_with')}">${dl('cards', paidWith)}</div>
      </div>
      <p class="hint">Paid with the HSA card? Then there's nothing to reimburse; it's marked "Paid with HSA card".</p>
      <label for="notes">Notes</label>
      <textarea id="notes" name="notes" rows="2" placeholder="e.g. claim number, what the visit was for">${v('notes')}</textarea>
      <textarea name="ocr_text" id="ocr_text" hidden>${v('ocr_text')}</textarea>
      <button type="submit">Save</button>
    </form>
    ${files.length ? '' : `<form class="card" method="post" action="/e/${id}/files" enctype="multipart/form-data"><label for="more">Attach the receipt</label><input id="more" type="file" name="files" accept="image/*,application/pdf,.pdf,.heic" multiple required><input type="hidden" name="kind" value="receipt"><input type="hidden" name="back" value="edit"><button type="submit">Upload</button></form>`}`;
  return page({ title: 'Receipt details', active: 'new', user, body, flash: flashFrom(url), scripts: readable ? ['/static/edit.js'] : [] });
}

// Saves the form. Returns { id, status } or { error }.
export async function saveExpense(env, form, id) {
  const e = await getExpense(env, id);
  if (!e) return { error: 'Receipt not found.' };
  const d = (k) => {
    const s = String(form[k] || '').trim();
    return s ? s : null;
  };
  for (const k of ['service_date', 'paid_date']) {
    if (d(k) && !isDate(d(k))) return { error: 'Please use a valid date.' };
  }
  const amountRaw = d('amount');
  const amount = num(amountRaw);
  if (amountRaw && (amount === null || amount < 0 || amount > 1_000_000)) return { error: 'The amount should be a number like 45.10.' };
  const text = (k, max) => (d(k) ? d(k).slice(0, max) : null);
  const category = CATEGORIES.includes(d('category')) ? d('category') : null;
  const rec = {
    service_date: d('service_date'),
    provider: text('provider', 120),
    patient: text('patient', 60),
    category,
    amount,
    paid_date: d('paid_date'),
    paid_with: text('paid_with', 60),
    notes: text('notes', 2000),
    ocr_text: form.ocr_text !== undefined ? text('ocr_text', 8000) : e.ocr_text,
    account: validAccount(await getAccounts(env), form.account) || e.account,
  };

  let status = e.status;
  let reimbursedDate = e.reimbursed_date;
  let reimbursedAmount = e.reimbursed_amount;
  const complete = rec.service_date && rec.provider && rec.amount !== null && rec.amount > 0;
  if (status !== 'reimbursed') {
    if (!complete) status = 'draft';
    else if (isHsaCard(rec.paid_with)) status = 'hsa_paid';
    else status = 'open';
    if (status === 'hsa_paid') {
      reimbursedDate = rec.paid_date || rec.service_date;
      reimbursedAmount = rec.amount;
    } else {
      reimbursedDate = null;
      reimbursedAmount = null;
    }
  }
  await run(
    env,
    `UPDATE expenses SET status = ?, service_date = ?, provider = ?, patient = ?, category = ?, amount = ?, paid_date = ?,
       paid_with = ?, notes = ?, ocr_text = ?, reimbursed_date = ?, reimbursed_amount = ?, account = ?, updated_at = datetime('now') WHERE id = ?`,
    status, rec.service_date, rec.provider, rec.patient, rec.category, rec.amount, rec.paid_date,
    rec.paid_with, rec.notes, rec.ocr_text, reimbursedDate, reimbursedAmount, rec.account, id,
  );
  return { id, status, complete };
}

export async function addFiles(env, id, form) {
  const e = await getExpense(env, id);
  if (!e) return { error: 'Receipt not found.' };
  const s = await saveFiles(env, id, list(form.files), String(form.kind || 'receipt'));
  if (!s.saved) return { error: s.skipped.length ? s.skipped.join('; ') : 'Choose a file first.' };
  return { saved: s.saved, skipped: s.skipped };
}

export async function markReimbursed(env, id, form) {
  const e = await getExpense(env, id);
  if (!e) return { error: 'Receipt not found.' };
  if (e.status !== 'open') return { error: 'Only unreimbursed receipts can be marked as reimbursed.' };
  const date = String(form.reimbursed_date || '');
  const amount = num(form.reimbursed_amount);
  if (!isDate(date)) return { error: 'Please enter the date you were reimbursed.' };
  if (amount === null || amount <= 0) return { error: 'Please enter the amount reimbursed.' };
  await run(env, `UPDATE expenses SET status = 'reimbursed', reimbursed_date = ?, reimbursed_amount = ?, updated_at = datetime('now') WHERE id = ?`, date, amount, id);
  return { ok: true, partial: e.amount && amount < e.amount };
}

export async function undoReimbursed(env, id) {
  await run(env, `UPDATE expenses SET status = 'open', reimbursed_date = NULL, reimbursed_amount = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'reimbursed'`, id);
}

export async function bulkReimburse(env, form) {
  const ids = list(form.ids).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  const date = String(form.reimbursed_date || '');
  if (!ids.length) return { error: 'Tick at least one receipt.' };
  if (!isDate(date)) return { error: 'Please enter the date you were reimbursed.' };
  const marks = ids.map(() => '?').join(',');
  const rows = await all(env, `SELECT id, amount FROM expenses WHERE status = 'open' AND id IN (${marks})`, ...ids);
  if (!rows.length) return { error: 'Those receipts are already reimbursed.' };
  await env.DB.batch(rows.map((r) => env.DB.prepare(`UPDATE expenses SET status = 'reimbursed', reimbursed_date = ?, reimbursed_amount = amount, updated_at = datetime('now') WHERE id = ?`).bind(date, r.id)));
  return { count: rows.length, total: rows.reduce((s, r) => s + (Number(r.amount) || 0), 0) };
}

export async function deleteExpense(env, id, form) {
  if (form.confirm !== '1') return { error: 'Tick the box to confirm.' };
  await deleteExpenseFiles(env, id);
  await run(env, 'DELETE FROM expenses WHERE id = ?', id);
  return { ok: true };
}

// ---------- Export ----------

const CSV_COLS = ['id', 'hsa', 'status', 'service_date', 'provider', 'patient', 'category', 'amount', 'paid_date', 'paid_with', 'reimbursed_date', 'reimbursed_amount', 'notes', 'files'];

function csvCell(v, numeric) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Stop spreadsheet apps from treating text as a formula.
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function ledgerCsv(env) {
  const rows = await all(
    env,
    `SELECT e.*, (SELECT group_concat(name, ' | ') FROM files f WHERE f.expense_id = e.id) AS files
       FROM expenses e ORDER BY COALESCE(service_date, substr(created_at, 1, 10)), id`,
  );
  const accounts = await getAccounts(env);
  const head = CSV_COLS.join(',');
  const cell = (r, c) => (c === 'status' ? (STATUS[r.status] || STATUS.draft).label : c === 'hsa' ? accountName(accounts, r.account) : r[c]);
  const body = rows.map((r) => CSV_COLS.map((c) => csvCell(cell(r, c), ['id', 'amount', 'reimbursed_amount'].includes(c))).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

function safePart(s, max = 40) {
  return String(s || '').replace(/[^\w .&()+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || 'Receipt';
}

// File list for the ZIP download (built in the browser).
export async function exportManifest(env) {
  const rows = await all(
    env,
    `SELECT f.id, f.name, f.type, e.id AS eid, e.service_date, e.provider, e.amount, e.created_at, e.account
       FROM files f JOIN expenses e ON e.id = f.expense_id ORDER BY e.id, f.id`,
  );
  const accounts = await getAccounts(env);
  const seen = new Map();
  const files = rows.map((r) => {
    const date = r.service_date || String(r.created_at || '').slice(0, 10);
    const top = accounts.length > 1 ? `${safePart(`${accountName(accounts, r.account)} HSA`)}/` : '';
    const folder = `${top}${date.slice(0, 4) || 'undated'}/${date} ${safePart(r.provider)} ${r.amount !== null ? `$${Number(r.amount).toFixed(2)}` : ''} #${r.eid}`.replace(/\s+/g, ' ').trim();
    const n = (seen.get(r.eid) || 0) + 1;
    seen.set(r.eid, n);
    const ext = (String(r.name || '').match(/\.[A-Za-z0-9]{2,5}$/) || [''])[0].toLowerCase();
    return { url: `/files/${r.id}`, path: `${folder}/${n}-${safePart(String(r.name || '').replace(/\.[^.]+$/, ''), 50)}${ext}` };
  });
  return { csv: await ledgerCsv(env), files };
}

export async function exportPage(env, user, url) {
  const accounts = await getAccounts(env);
  const multi = accounts.length > 1;
  const years = await all(
    env,
    `SELECT account, substr(COALESCE(service_date, created_at), 1, 4) AS y, COUNT(*) AS n,
            COALESCE(SUM(amount), 0) AS total,
            COALESCE(SUM(CASE WHEN status = 'open' THEN amount END), 0) AS open,
            COALESCE(SUM(CASE WHEN status = 'reimbursed' THEN reimbursed_amount END), 0) AS reimbursed,
            COALESCE(SUM(CASE WHEN status = 'hsa_paid' THEN amount END), 0) AS hsa
       FROM expenses WHERE status != 'draft' GROUP BY ${multi ? 'account, ' : ''}y ORDER BY y DESC, account`,
  );
  const files = await one(env, 'SELECT COUNT(*) n, COALESCE(SUM(size), 0) s FROM files');
  const mb = (files.s / 1048576).toFixed(1);
  const body = `<h1>Export</h1>
    <div class="card tablewrap"><table>
      <thead><tr><th>Year</th>${multi ? '<th>HSA</th>' : ''}<th class="num">Receipts</th><th class="num">Total paid</th><th class="num">Not reimbursed</th><th class="num">Reimbursed</th><th class="num">HSA card</th></tr></thead>
      <tbody>${years.length ? years.map((y) => `<tr><td>${esc(y.y)}</td>${multi ? `<td>${esc(accountName(accounts, y.account))}</td>` : ''}<td class="num">${y.n}</td><td class="num">${moneyExact(y.total)}</td><td class="num">${moneyExact(y.open)}</td><td class="num">${moneyExact(y.reimbursed)}</td><td class="num">${moneyExact(y.hsa)}</td></tr>`).join('') : `<tr><td colspan="${multi ? 7 : 6}" class="muted">No finished receipts yet.</td></tr>`}</tbody>
    </table></div>
    <div class="card">
      <a class="btn" href="/export.csv">Download list (CSV)</a>
      <button type="button" id="zip" ${files.n ? '' : 'disabled'}>Download everything (ZIP)</button>
      <p id="zip-status" class="status muted" role="status"></p>
      <p class="hint">The ZIP has every receipt file in folders by ${multi ? 'HSA and ' : ''}year, plus the list. ${files.n} file${files.n === 1 ? '' : 's'}, about ${mb} MB. Save a copy once a year (Google Drive works) as a backup.</p>
    </div>
    <div class="card small">
      <strong>Keeping HSA records</strong>
      <ul>
        <li>There's no deadline to reimburse yourself, as long as the expense happened after your HSA was opened.</li>
        <li>Keep each receipt for as long as you might need to show it to the IRS: what it was, who it was for, the date, and that you paid it.</li>
        <li>Don't claim the same expense twice (for example, both as an HSA reimbursement and an itemized deduction).</li>
      </ul>
    </div>`;
  return page({ title: 'Export', active: 'export', user, body, flash: flashFrom(url), scripts: ['/static/export.js'] });
}

export function errorFor(user, title, msg) {
  return errorPage(user, title, msg);
}
