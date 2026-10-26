// OneDrive backup: copies every receipt file and the receipt list (CSV) into
// the site's own folder in OneDrive ("Apps/HSA Receipts"). The site can only
// see that one folder, not the rest of the OneDrive.
//
// Runs every night on its own (Cloudflare cron, free) and from the
// "Back up now" button in Settings. Each file is copied once; the list is
// replaced each run. Files deleted on the site stay in the backup.
//
// Sign-in is Microsoft's standard "authorization code + PKCE" flow for a
// public app, so there is no client secret to store or renew. The refresh
// token Microsoft hands back is kept in the database.

import { all, getSetting, setSetting, run } from './db.js';
import { getAccounts, accountName } from './accounts.js';
import { ledgerCsv } from './pages/expenses.js';

const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'Files.ReadWrite.AppFolder offline_access';
// Free Workers allow 50 outside requests per run: 1 sign-in + 1 list + files.
export const PER_RUN = 40;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const configured = (env) => /^[0-9a-f-]{36}$/i.test(String(env.ONEDRIVE_CLIENT_ID || ''));
const redirectUri = (env) => `${String(env.SITE_URL || '').replace(/\/$/, '')}/onedrive/callback`;

export async function getStatus(env) {
  try {
    return JSON.parse((await getSetting(env, 'onedrive_status', '')) || '{}') || {};
  } catch {
    return {};
  }
}
async function setStatus(env, patch) {
  await setSetting(env, 'onedrive_status', JSON.stringify({ ...(await getStatus(env)), ...patch }));
}
export async function isConnected(env) {
  return !!(await getSetting(env, 'onedrive_refresh', ''));
}

// Step 1: send the person to Microsoft to approve access.
export async function connectUrl(env) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  await setSetting(env, 'onedrive_pending', JSON.stringify({ state, verifier, at: Date.now() }));
  const q = new URLSearchParams({
    client_id: env.ONEDRIVE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(env),
    response_mode: 'query',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTH}/authorize?${q}`;
}

async function tokenRequest(env, params) {
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.ONEDRIVE_CLIENT_ID, scope: SCOPE, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(data.error_description ? String(data.error_description).split('\r\n')[0] : `Microsoft sign-in failed (${res.status})`);
    err.code = data.error || 'token_error';
    throw err;
  }
  if (data.refresh_token) await setSetting(env, 'onedrive_refresh', data.refresh_token);
  return data.access_token;
}

// Step 2: Microsoft sends the person back here with a one-time code.
export async function finishConnect(env, url) {
  if (url.searchParams.get('error')) return { error: url.searchParams.get('error_description') || 'Access was not approved.' };
  let pending = {};
  try {
    pending = JSON.parse((await getSetting(env, 'onedrive_pending', '')) || '{}');
  } catch {}
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!pending.state || state !== pending.state || Date.now() - pending.at > 15 * 60 * 1000 || !code) {
    return { error: 'That sign-in link expired. Please press "Connect OneDrive" again.' };
  }
  await setSetting(env, 'onedrive_pending', '');
  try {
    const token = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(env), code_verifier: pending.verifier });
    // Creates (or finds) the app's own folder and tells us which account it is.
    const res = await fetch(`${GRAPH}/me/drive/special/approot`, { headers: { Authorization: `Bearer ${token}` } });
    const root = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(root.error?.message || `OneDrive answered ${res.status}`);
    const who = root.createdBy?.user?.displayName || root.parentReference?.driveId || '';
    await setStatus(env, { connectedAt: new Date().toISOString(), account: who, folder: root.webUrl || '', lastError: '' });
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

export async function disconnect(env) {
  await setSetting(env, 'onedrive_refresh', '');
  await setStatus(env, { connectedAt: '', lastError: '' });
}

function part(s, max = 40) {
  return String(s || '').replace(/[^\w .&()+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || 'Receipt';
}

// Same folder layout as the ZIP download: "<Name> HSA/<year>/<date provider $amount #id>/<file>".
export function backupPath(row, accounts) {
  const date = row.service_date || String(row.created_at || '').slice(0, 10);
  const top = accounts.length > 1 ? `${part(`${accountName(accounts, row.account)} HSA`)}/` : '';
  const folder = `${top}${date.slice(0, 4) || 'undated'}/${date} ${part(row.provider)} ${row.amount !== null && row.amount !== undefined ? `$${Number(row.amount).toFixed(2)}` : ''} #${row.eid}`.replace(/\s+/g, ' ').trim();
  const ext = (String(row.name || '').match(/\.[A-Za-z0-9]{2,5}$/) || [''])[0].toLowerCase();
  return `${folder}/${row.id}-${part(String(row.name || '').replace(/\.[^.]+$/, ''), 50)}${ext}`;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function put(token, path, body, type) {
  const res = await fetch(`${GRAPH}/me/drive/special/approot:/${encodePath(path)}:/content?@microsoft.graph.conflictBehavior=replace`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type || 'application/octet-stream' },
    body,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message || `OneDrive upload failed (${res.status})`);
  }
}

// Copies files not backed up yet (up to PER_RUN) and the receipt list.
export async function runBackup(env, { max = PER_RUN } = {}) {
  if (!configured(env)) return { error: 'OneDrive backup is not set up yet.' };
  const refresh = await getSetting(env, 'onedrive_refresh', '');
  if (!refresh) return { error: 'OneDrive is not connected.' };
  let token;
  try {
    token = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refresh });
  } catch (e) {
    const msg = e.code === 'invalid_grant' ? 'Microsoft sign-in expired. Press "Connect OneDrive" to reconnect.' : e.message;
    if (e.code === 'invalid_grant') await setSetting(env, 'onedrive_refresh', '');
    await setStatus(env, { lastRun: new Date().toISOString(), lastError: msg });
    return { error: msg };
  }

  const accounts = await getAccounts(env);
  const rows = await all(
    env,
    `SELECT f.id, f.name, f.type, f.r2_key, e.id AS eid, e.service_date, e.provider, e.amount, e.created_at, e.account
       FROM files f JOIN expenses e ON e.id = f.expense_id
      WHERE f.backup_at IS NULL ORDER BY f.id LIMIT ?`,
    max,
  );
  let copied = 0;
  let error = '';
  for (const r of rows) {
    try {
      const obj = await env.FILES.get(r.r2_key);
      if (!obj) continue;
      const path = backupPath(r, accounts);
      await put(token, path, await obj.arrayBuffer(), r.type);
      await run(env, `UPDATE files SET backup_path = ?, backup_at = datetime('now') WHERE id = ?`, path, r.id);
      copied++;
    } catch (e) {
      error = e.message;
      break;
    }
  }
  if (!error) {
    try {
      await put(token, 'receipts.csv', await ledgerCsv(env), 'text/csv');
    } catch (e) {
      error = e.message;
    }
  }
  const left = (await all(env, `SELECT COUNT(*) n FROM files WHERE backup_at IS NULL`))[0].n;
  const total = (await all(env, `SELECT COUNT(*) n FROM files`))[0].n;
  await setStatus(env, { lastRun: new Date().toISOString(), lastCopied: copied, waiting: left, total, lastError: error, ...(error ? {} : { lastOk: new Date().toISOString() }) });
  return { copied, left, error };
}

// Nightly run (up to PER_RUN files a night; "Back up now" does more at once).
export async function scheduledBackup(env) {
  if (!configured(env) || !(await isConnected(env))) return null;
  return runBackup(env);
}
