// HSA Receipts: entry point. Routes every request after the sign-in check.

import { ensureSchema } from './schema.js';
import { authenticate } from './auth.js';
import { htmlResponse, redirect, readForm, esc, list } from './util.js';
import { page, errorPage, withMsg } from './views/layout.js';
import { serveFile, deleteFile, setKind } from './files.js';
import * as ex from './pages/expenses.js';
import * as settings from './pages/settings.js';
import { ICON_180, ICON_192, ICON_512 } from './icons.js';
import { receiveEmail } from './email.js';
import { markNotDuplicate } from './dups.js';

const AUTH_MESSAGES = {
  'not-configured': 'The private sign-in isn\'t set up yet, so the site is locked. Finish the Cloudflare Access step in SETUP.md.',
  'not-allowed': 'This email address isn\'t on the allowed list.',
};

const MANIFEST = {
  name: 'HSA Receipts',
  short_name: 'HSA',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#f5f4ef',
  theme_color: '#1f6f5c',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
  // Lets Android's Share menu send scans straight to the site.
  share_target: {
    action: '/share',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: {
      title: 'title',
      text: 'text',
      files: [{ name: 'files', accept: ['image/*', 'application/pdf', '.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp'] }],
    },
  },
};

function notFound(user) {
  const e = errorPage(user, 'Not found', 'That page doesn\'t exist.', 404);
  return htmlResponse(e.html, e.status);
}

function out(result, user) {
  if (!result) return notFound(user);
  if (typeof result === 'string') return htmlResponse(result);
  if (result.redirect) return redirect(result.redirect);
  if (result.html) return htmlResponse(result.html, result.status || 200);
  return notFound(user);
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  if (path === '/manifest.webmanifest') {
    return new Response(JSON.stringify(MANIFEST), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'max-age=86400' } });
  }
  const icons = { '/icon-192.png': ICON_192, '/icon-512.png': ICON_512, '/apple-touch-icon.png': ICON_180 };
  if (icons[path]) {
    const bin = Uint8Array.from(atob(icons[path]), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800' } });
  }
  if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });

  const auth = await authenticate(request, env);
  if (auth.error) {
    return htmlResponse(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Locked</title>
       <body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px"><h1>🔒 Locked</h1>
       <p>${esc(AUTH_MESSAGES[auth.error] || 'Please sign in through hsa.muravskiy.org.')}</p></body>`,
      403,
    );
  }
  const user = auth.email;

  // Page scripts, served only after sign-in.
  if (path.startsWith('/static/') && (method === 'GET' || method === 'HEAD')) {
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('Cache-Control', 'private, max-age=300');
    h.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers: h });
  }

  // Every change is a POST from one of our own pages. The one exception is
  // Android's Share menu, which posts to /share without a web origin.
  if (method === 'POST') {
    const origin = request.headers.get('Origin');
    const site = request.headers.get('Sec-Fetch-Site');
    const shareOk = path === '/share' && (!origin || origin === 'null') && (!site || site === 'none' || site === 'same-origin');
    const sameOk = (!origin || origin === url.origin) && (!site || ['same-origin', 'none'].includes(site));
    if (!shareOk && !sameOk) return new Response('Cross-site request blocked', { status: 403 });
  } else if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  await ensureSchema(env.DB);
  const m = (re) => path.match(re);
  let p;

  if (path === '/' && method === 'GET') return out(await ex.listPage(env, user, url), user);

  // ----- Adding receipts -----
  if (path === '/new' || path === '/share') {
    if (method === 'GET') return path === '/share' ? redirect('/new') : out(await ex.newPage(env, user, url), user);
    const form = await readForm(request);
    const r = await ex.createFromUpload(env, user, list(form.files), { account: form.account });
    if (r.error) return redirect(withMsg('/new', r.error, 'bad'));
    const note = r.skipped.length ? `Some files were skipped: ${r.skipped.join('; ')}` : '';
    return redirect(note ? withMsg(`/e/${r.id}/edit?read=1`, note, 'warn') : `/e/${r.id}/edit?read=1`);
  }
  if (path === '/new/blank' && method === 'POST') {
    const form = await readForm(request);
    const r = await ex.createFromUpload(env, user, [], { allowEmpty: true, account: form.account });
    return redirect(`/e/${r.id}/edit`);
  }

  // ----- One receipt -----
  if ((p = m(/^\/e\/(\d+)$/)) && method === 'GET') return out(await ex.detailPage(env, user, url, Number(p[1])), user);
  if ((p = m(/^\/e\/(\d+)\/edit$/))) {
    const id = Number(p[1]);
    if (method === 'GET') return out(await ex.editPage(env, user, url, id), user);
    const r = await ex.saveExpense(env, await readForm(request), id);
    if (r.error) return redirect(withMsg(`/e/${id}/edit`, r.error, 'bad'));
    if (!r.complete) return redirect(withMsg(`/e/${id}`, 'Saved. Add the date, provider and amount to finish it.', 'warn'));
    return redirect(withMsg(`/e/${id}`, r.status === 'hsa_paid' ? 'Saved as paid with the HSA card.' : 'Saved.'));
  }
  if ((p = m(/^\/e\/(\d+)\/files$/)) && method === 'POST') {
    const id = Number(p[1]);
    const form = await readForm(request);
    const r = await ex.addFiles(env, id, form);
    const back = form.back === 'edit' ? `/e/${id}/edit?read=1` : `/e/${id}`;
    if (r.error) return redirect(withMsg(form.back === 'edit' ? `/e/${id}/edit` : back, r.error, 'bad'));
    return redirect(withMsg(back, `Added ${r.saved} file${r.saved === 1 ? '' : 's'}.${r.skipped.length ? ` Skipped: ${r.skipped.join('; ')}` : ''}`, r.skipped.length ? 'warn' : 'ok'));
  }
  if ((p = m(/^\/e\/(\d+)\/reimburse$/)) && method === 'POST') {
    const id = Number(p[1]);
    const r = await ex.markReimbursed(env, id, await readForm(request));
    return redirect(withMsg(`/e/${id}`, r.error || (r.partial ? 'Marked as reimbursed (less than the amount paid).' : 'Marked as reimbursed.'), r.error ? 'bad' : 'ok'));
  }
  if ((p = m(/^\/e\/(\d+)\/unreimburse$/)) && method === 'POST') {
    const id = Number(p[1]);
    await ex.undoReimbursed(env, id);
    return redirect(withMsg(`/e/${id}`, 'Back to not reimbursed.'));
  }
  if ((p = m(/^\/e\/(\d+)\/delete$/)) && method === 'POST') {
    const id = Number(p[1]);
    const r = await ex.deleteExpense(env, id, await readForm(request));
    return redirect(r.error ? withMsg(`/e/${id}`, r.error, 'bad') : withMsg('/', 'Receipt deleted.'));
  }
  if ((p = m(/^\/e\/(\d+)\/notdup$/)) && method === 'POST') {
    const id = Number(p[1]);
    const form = await readForm(request);
    await markNotDuplicate(env, id, form.other);
    return redirect(withMsg(`/e/${id}`, 'Got it, those two are kept as separate receipts.'));
  }
  if (path === '/move' && method === 'POST') {
    const r = await ex.movePerson(env, await readForm(request));
    if (r.error) return redirect(withMsg('/', r.error, 'bad'));
    return redirect(withMsg(`/?status=open&person=${encodeURIComponent(r.person)}`, `Moved ${r.moved} receipt${r.moved === 1 ? '' : 's'} for ${r.person} to ${r.to}'s HSA.`));
  }
  if (path === '/reimburse' && method === 'POST') {
    const r = await ex.bulkReimburse(env, await readForm(request));
    if (r.error) return redirect(withMsg('/', r.error, 'bad'));
    return redirect(withMsg('/', `Marked ${r.count} receipt${r.count === 1 ? '' : 's'} as reimbursed (${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(r.total)}).`));
  }

  // ----- Files -----
  if ((p = m(/^\/files\/(\d+)$/)) && method === 'GET') {
    const res = await serveFile(env, Number(p[1]), url.searchParams.get('download') === '1');
    return res || notFound(user);
  }
  if ((p = m(/^\/files\/(\d+)\/delete$/)) && method === 'POST') {
    const eid = await deleteFile(env, Number(p[1]));
    return redirect(eid ? withMsg(`/e/${eid}`, 'File removed.') : '/');
  }
  if ((p = m(/^\/files\/(\d+)\/kind$/)) && method === 'POST') {
    const form = await readForm(request);
    const eid = await setKind(env, Number(p[1]), String(form.kind || ''));
    return redirect(eid ? `/e/${eid}` : '/');
  }

  // ----- Export, settings -----
  if (path === '/export' && method === 'GET') return out(await ex.exportPage(env, user, url), user);
  if (path === '/export.csv' && method === 'GET') {
    const day = new Date().toISOString().slice(0, 10);
    return new Response(await ex.ledgerCsv(env), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="hsa-receipts-${day}.csv"`, 'Cache-Control': 'no-store' },
    });
  }
  if (path === '/export/files.json' && method === 'GET') {
    return new Response(JSON.stringify(await ex.exportManifest(env)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  if (path === '/settings') {
    if (method === 'GET') return out(await settings.settingsPage(env, user, url), user);
    const r = await settings.saveSettings(env, await readForm(request));
    return redirect(r.error ? withMsg('/settings', r.error, 'bad') : withMsg('/settings', 'Settings saved.'));
  }

  return notFound(user);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      console.error(e);
      return htmlResponse(
        page({ title: 'Error', body: `<h1>Something went wrong</h1><div class="card"><p>${esc(e.message)}</p><p><a href="/">Back to receipts</a></p></div>` }),
        500,
      );
    }
  },

  // Cloudflare Email Routing hands emails sent to the receipts address here.
  async email(message, env) {
    try {
      const r = await receiveEmail(message, env);
      if (r.reject) {
        console.log('email rejected', JSON.stringify({ from: message.from, reason: r.reject }));
        message.setReject(r.reject);
      } else {
        console.log('email saved', JSON.stringify({ from: message.from, id: r.id, files: r.files }));
      }
    } catch (e) {
      console.error('email failed', e);
      message.setReject('Sorry, the receipt could not be saved. Please upload it on the site.');
    }
  },
};
