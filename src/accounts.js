// HSA accounts ("buckets"): one per spouse. Each receipt belongs to one
// account, so each of you sees what you can reimburse from your own HSA.
// Stored in settings as JSON: [{ id: '1', name, email, provider, url }].

import { getSetting, setSetting } from './db.js';
import { allowedEmails } from './auth.js';

export const MAX_ACCOUNTS = 3;

function titleFromEmail(email) {
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : '';
}

export async function getAccounts(env) {
  let saved = null;
  try {
    saved = JSON.parse((await getSetting(env, 'accounts', '')) || 'null');
  } catch {
    saved = null;
  }
  if (Array.isArray(saved) && saved.length) return saved;
  // First run: one account per allowed sign-in email.
  const emails = allowedEmails(env);
  const legacyProvider = (await getSetting(env, 'hsa_name', '')) || '';
  const legacyUrl = (await getSetting(env, 'hsa_url', '')) || '';
  const list = (emails.length ? emails : ['']).slice(0, MAX_ACCOUNTS).map((email, i) => ({
    id: String(i + 1),
    name: titleFromEmail(email) || 'My HSA',
    email,
    provider: legacyProvider,
    url: legacyUrl,
  }));
  return list;
}

export async function saveAccounts(env, accounts) {
  await setSetting(env, 'accounts', JSON.stringify(accounts));
}

// The account a new receipt goes to: the one whose email matches whoever is signed in.
export function accountForUser(accounts, user) {
  const email = String(user || '').toLowerCase();
  return (accounts.find((a) => a.email && a.email.toLowerCase() === email) || accounts[0] || { id: '1' }).id;
}

export function accountName(accounts, id) {
  const a = accounts.find((x) => x.id === String(id));
  return a ? a.name : 'Unassigned';
}

export function validAccount(accounts, id) {
  return accounts.some((a) => a.id === String(id)) ? String(id) : null;
}
