import { esc } from '../util.js';

const CSS = `
:root{--bg:#f5f4ef;--card:#fff;--ink:#1d2430;--muted:#5f6b7a;--line:#e3ded3;--accent:#1f6f5c;--accent-ink:#fff;--ok:#1d7a46;--warn:#9a5b00;--warnbg:#fff4df;--bad:#a12a2a;--badbg:#fdecec;--okbg:#e7f5ec;--chip:#eef2f0}
@media (prefers-color-scheme:dark){:root{--bg:#13181a;--card:#1b2225;--ink:#e6e9ee;--muted:#9aa5b3;--line:#2c3638;--accent:#6cc7ad;--accent-ink:#0c1a16;--ok:#5fd08f;--warn:#f2b45a;--warnbg:#2c2414;--bad:#ff8a8a;--badbg:#2e1818;--okbg:#14281c;--chip:#252f31}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
header{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.bar{max-width:980px;margin:0 auto;padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;text-decoration:none;color:var(--ink);margin-right:auto}
nav a{text-decoration:none;color:var(--muted);font-weight:500;padding:4px 2px}
nav a.on{color:var(--ink);border-bottom:2px solid var(--accent)}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:.4rem 0 1rem}
h2{font-size:1.15rem;margin:1.6rem 0 .6rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 12px}
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.stat .v{font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums}
.stat .k{color:var(--muted);font-size:.85rem}
.muted{color:var(--muted)}.small{font-size:.875rem}
.banner{border-radius:10px;padding:10px 14px;margin:0 0 12px;border:1px solid var(--line)}
.banner.warn{background:var(--warnbg);color:var(--warn)}.banner.bad{background:var(--badbg);color:var(--bad)}.banner.ok{background:var(--okbg);color:var(--ok)}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 10px;font-size:.8rem;margin:0 4px 4px 0;white-space:nowrap}
.chip.ok{background:var(--okbg);color:var(--ok)}.chip.warn{background:var(--warnbg);color:var(--warn)}.chip.bad{background:var(--badbg);color:var(--bad)}
.btn,button{display:inline-block;font:inherit;font-weight:600;border-radius:9px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);padding:8px 14px;text-decoration:none;cursor:pointer;margin:2px 4px 2px 0}
.btn.ghost,button.ghost{background:transparent;color:var(--accent)}
.btn.danger,button.danger{background:var(--bad);border-color:var(--bad);color:#fff}
.btn.small,button.small{padding:4px 10px;font-size:.875rem}
.btn.big{display:block;text-align:center;padding:16px;font-size:1.1rem;margin:8px 0}
button:disabled{opacity:.5;cursor:default}
form.inline{display:inline}
label{display:block;font-weight:600;font-size:.9rem;margin:10px 0 4px}
input,select,textarea{font:inherit;width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
input[type=checkbox]{width:auto;margin-right:6px}
input.filled,select.filled{border-color:var(--warn);background:var(--warnbg)}
.row{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.03em}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tablewrap{overflow-x:auto}
.nowrap{white-space:nowrap}
.hint{font-size:.85rem;color:var(--muted);margin:4px 0 0}
.thumbs{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.thumb{border:1px solid var(--line);border-radius:10px;padding:6px;background:var(--bg)}
.thumb img{width:100%;height:180px;object-fit:contain;display:block;border-radius:6px;background:#fff}
.thumb .doc{height:180px;display:flex;align-items:center;justify-content:center;font-size:2.5rem}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:end}
.filters label{margin:0 0 2px}.filters>div{min-width:120px;flex:1}
.status{font-size:.9rem;margin:6px 0}
@media (max-width:640px){nav{width:100%;overflow-x:auto;white-space:nowrap}nav a{margin-right:10px}main{padding:12px}.hide-sm{display:none}}
footer{max-width:980px;margin:24px auto;padding:0 16px;color:var(--muted);font-size:.8rem}
`;

export function page({ title, active = '', user, body, flash, scripts = [] }) {
  const nav = [
    ['/', 'Receipts', 'list'],
    ['/new', 'Add', 'new'],
    ['/export', 'Export', 'export'],
    ['/settings', 'Settings', 'settings'],
  ]
    .map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`)
    .join('');
  const js = scripts.map((s) => `<script type="module" src="${esc(s)}"></script>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" href="/icon-192.png">
<meta name="theme-color" content="#1f6f5c">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="HSA">
<title>${esc(title)} · HSA Receipts</title>
<style>${CSS}</style>${js}</head><body>
<header><div class="bar"><a class="brand" href="/">🧾 HSA Receipts</a><nav>${nav}</nav></div></header>
<main>${flash ? `<div class="banner ${esc(flash.kind || 'ok')}">${esc(flash.text)}</div>` : ''}${body}</main>
<footer>${user ? `Signed in as ${esc(user)}` : ''}</footer>
</body></html>`;
}

export function errorPage(user, title, message, status = 400) {
  return {
    status,
    html: page({
      title,
      user,
      body: `<h1>${esc(title)}</h1><div class="card"><p>${esc(message)}</p><p><a href="/">Back to receipts</a></p></div>`,
    }),
  };
}

// Reads ?msg=...&kind=... set after a redirect.
export function flashFrom(url) {
  const text = url.searchParams.get('msg');
  if (!text) return null;
  const kind = url.searchParams.get('kind');
  return { text: text.slice(0, 300), kind: ['ok', 'warn', 'bad'].includes(kind) ? kind : 'ok' };
}

export function withMsg(path, text, kind = 'ok') {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}msg=${encodeURIComponent(text)}&kind=${kind}`;
}
