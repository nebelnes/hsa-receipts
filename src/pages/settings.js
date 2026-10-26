// Settings: family members, payment methods, HSA provider link.

import { getSetting, setSetting, one } from '../db.js';
import { esc, splitList } from '../util.js';
import { page, flashFrom } from '../views/layout.js';
import { DEFAULT_PAID_WITH } from './expenses.js';
import { authConfigured } from '../auth.js';

export async function settingsPage(env, user, url) {
  const people = splitList(await getSetting(env, 'people', '')).join(', ');
  const paidWith = splitList(await getSetting(env, 'paid_with', DEFAULT_PAID_WITH)).join(', ');
  const hsaName = (await getSetting(env, 'hsa_name', '')) || '';
  const hsaUrl = (await getSetting(env, 'hsa_url', '')) || '';
  const files = await one(env, 'SELECT COUNT(*) n, COALESCE(SUM(size), 0) s FROM files');
  const gb = files.s / 1073741824;

  const body = `<h1>Settings</h1>
    <form class="card" method="post" action="/settings">
      <label for="people">Family members</label>
      <input id="people" name="people" value="${esc(people)}" placeholder="e.g. me, my wife, our kids' names">
      <p class="hint">Separate names with commas. They appear in the Person list.</p>
      <label for="paid_with">Ways you pay</label>
      <textarea id="paid_with" name="paid_with" rows="3">${esc(paidWith)}</textarea>
      <p class="hint">Separate with commas. Anything containing "HSA" counts as paid by the HSA (nothing to reimburse).</p>
      <div class="row">
        <div><label for="hsa_name">HSA provider</label><input id="hsa_name" name="hsa_name" value="${esc(hsaName)}" placeholder="e.g. Fidelity, HealthEquity"></div>
        <div><label for="hsa_url">Reimbursement page (link)</label><input id="hsa_url" name="hsa_url" type="url" value="${esc(hsaUrl)}" placeholder="https://"></div>
      </div>
      <button type="submit">Save settings</button>
    </form>
    <div class="card small">
      <strong>Status</strong>
      <ul>
        <li>Sign-in check: ${authConfigured(env) ? '✅ on' : env.DEV_NO_AUTH === '1' ? '⚠️ off (local testing)' : '❌ not set up'}</li>
        <li>Receipt storage: ${env.FILES ? `✅ ${files.n} file${files.n === 1 ? '' : 's'}, ${(gb * 1024).toFixed(1)} MB of the free 10 GB` : '❌ storage (R2) not connected'}</li>
      </ul>
    </div>`;
  return page({ title: 'Settings', active: 'settings', user, body, flash: flashFrom(url) });
}

export async function saveSettings(env, form) {
  const url = String(form.hsa_url || '').trim();
  if (url && !/^https:\/\/[^\s"'<>]+$/i.test(url)) return { error: 'The reimbursement link should start with https://' };
  await setSetting(env, 'people', splitList(form.people).map((s) => s.slice(0, 60)).slice(0, 20).join(', '));
  await setSetting(env, 'paid_with', splitList(form.paid_with).map((s) => s.slice(0, 60)).slice(0, 30).join(', '));
  await setSetting(env, 'hsa_name', String(form.hsa_name || '').trim().slice(0, 60));
  await setSetting(env, 'hsa_url', url.slice(0, 300));
  return { ok: true };
}
