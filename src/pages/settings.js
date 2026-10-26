// Settings: HSA accounts (one per spouse), family members, payment methods.

import { getSetting, setSetting, one } from '../db.js';
import { esc, splitList } from '../util.js';
import { page, flashFrom } from '../views/layout.js';
import { DEFAULT_PAID_WITH } from './expenses.js';
import { authConfigured, allowedEmails } from '../auth.js';
import { getAccounts, saveAccounts, MAX_ACCOUNTS } from '../accounts.js';

export async function settingsPage(env, user, url) {
  const people = splitList(await getSetting(env, 'people', '')).join(', ');
  const paidWith = splitList(await getSetting(env, 'paid_with', DEFAULT_PAID_WITH)).join(', ');
  const accounts = await getAccounts(env);
  const files = await one(env, 'SELECT COUNT(*) n, COALESCE(SUM(size), 0) s FROM files');
  const mb = files.s / 1048576;
  const allowed = allowedEmails(env);
  const inbox = String(env.RECEIPTS_EMAIL || '').trim();

  const slots = Array.from({ length: MAX_ACCOUNTS }, (_, i) => accounts[i] || { id: String(i + 1), name: '', email: '', provider: '', url: '' });
  const rows = slots
    .map((a, i) => `<div class="card" style="background:var(--bg)">
      <strong>HSA ${i + 1}</strong>${i === 0 ? '' : ' <span class="muted small">(leave the name empty if you don\'t need it)</span>'}
      <input type="hidden" name="acct_id" value="${esc(a.id)}">
      <div class="row">
        <div><label for="an${i}">Whose HSA</label><input id="an${i}" name="acct_name" value="${esc(a.name)}" placeholder="${i === 0 ? 'e.g. Alexey' : i === 1 ? 'e.g. your wife\'s name' : ''}"></div>
        <div><label for="ae${i}">Their email</label><input id="ae${i}" name="acct_email" type="email" value="${esc(a.email)}" placeholder="the email they sign in and forward from"></div>
      </div>
      <div class="row">
        <div><label for="ap${i}">HSA provider</label><input id="ap${i}" name="acct_provider" value="${esc(a.provider)}" placeholder="e.g. Fidelity, HealthEquity"></div>
        <div><label for="au${i}">Reimbursement page (link)</label><input id="au${i}" name="acct_url" type="url" value="${esc(a.url)}" placeholder="https://"></div>
      </div>
    </div>`)
    .join('');

  const body = `<h1>Settings</h1>
    <form class="card" method="post" action="/settings">
      <h2 style="margin-top:0">HSA accounts</h2>
      <p class="hint">Each of you gets your own total. New receipts go to the account whose email matches whoever adds or emails them.</p>
      ${rows}
      <label for="people">Family members (patients)</label>
      <input id="people" name="people" value="${esc(people)}" placeholder="e.g. me, my wife, our kids' names">
      <p class="hint">Separate names with commas. They appear in the Person list.</p>
      <label for="paid_with">Ways you pay</label>
      <textarea id="paid_with" name="paid_with" rows="3">${esc(paidWith)}</textarea>
      <p class="hint">Separate with commas. Anything containing "HSA" counts as paid by the HSA (nothing to reimburse).</p>
      <button type="submit">Save settings</button>
    </form>
    <div class="card small">
      <strong>Status</strong>
      <ul>
        <li>Sign-in check: ${authConfigured(env) ? `✅ on (${esc(allowed.join(', '))})` : env.DEV_NO_AUTH === '1' ? '⚠️ off (local testing)' : '❌ not set up'}</li>
        <li>Receipt storage: ${env.FILES ? `✅ ${files.n} file${files.n === 1 ? '' : 's'}, ${mb.toFixed(1)} MB of the free 10 GB` : '❌ storage (R2) not connected'}</li>
        <li>Email in: ${inbox ? `✅ forward to <strong>${esc(inbox)}</strong>` : 'not set up'}</li>
      </ul>
    </div>`;
  return page({ title: 'Settings', active: 'settings', user, body, flash: flashFrom(url) });
}

const arr = (v) => (v === undefined ? [] : [].concat(v));

export async function saveSettings(env, form) {
  const ids = arr(form.acct_id);
  const names = arr(form.acct_name);
  const emails = arr(form.acct_email);
  const providers = arr(form.acct_provider);
  const urls = arr(form.acct_url);
  const accounts = [];
  for (let i = 0; i < Math.min(ids.length, MAX_ACCOUNTS); i++) {
    const name = String(names[i] || '').trim().slice(0, 40);
    if (!name) continue;
    const email = String(emails[i] || '').trim().toLowerCase().slice(0, 120);
    const url = String(urls[i] || '').trim().slice(0, 300);
    if (email && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) return { error: `"${email}" doesn't look like an email address.` };
    if (url && !/^https:\/\/[^\s"'<>]+$/i.test(url)) return { error: 'Reimbursement links should start with https://' };
    accounts.push({ id: String(ids[i]).replace(/\D/g, '') || String(i + 1), name, email, provider: String(providers[i] || '').trim().slice(0, 60), url });
  }
  if (!accounts.length) return { error: 'Give at least one HSA a name.' };
  for (const old of await getAccounts(env)) {
    if (accounts.some((a) => a.id === old.id)) continue;
    const used = await one(env, 'SELECT COUNT(*) n FROM expenses WHERE account = ?', old.id);
    if (used.n) return { error: `${old.name}'s HSA still has ${used.n} receipt${used.n === 1 ? '' : 's'}. Move them to another HSA before removing it.` };
  }
  if (new Set(accounts.map((a) => a.email).filter(Boolean)).size !== accounts.filter((a) => a.email).length) return { error: 'Each HSA needs a different email.' };
  await saveAccounts(env, accounts);
  await setSetting(env, 'people', splitList(form.people).map((s) => s.slice(0, 60)).slice(0, 20).join(', '));
  await setSetting(env, 'paid_with', splitList(form.paid_with).map((s) => s.slice(0, 60)).slice(0, 30).join(', '));
  return { ok: true };
}
