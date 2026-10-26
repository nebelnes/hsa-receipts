// "Read all" on the Needs-details list: reads each receipt's PDF or photo on
// this device, one at a time, and lets the site fill in the empty fields.

import { readFileText } from './reader.js';

const btn = document.getElementById('read-all');
const statusEl = document.getElementById('read-all-status');
const say = (t) => { statusEl.textContent = t; };

btn?.addEventListener('click', async () => {
  const rows = [...document.querySelectorAll('tr[data-read]')];
  btn.disabled = true;
  let complete = 0;
  let partly = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = `${i + 1} of ${rows.length}`;
    say(`Reading ${label}…`);
    try {
      const text = await readFileText(row.dataset.file, row.dataset.type, (t) => say(`${label}: ${t}`));
      const body = new URLSearchParams({ text: text.slice(0, 8000) });
      const res = await fetch(`/e/${row.dataset.read}/autofill`, { method: 'POST', body, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      const r = await res.json();
      if (r.complete) complete++;
      else if (r.filled.length) partly++;
      row.style.opacity = '0.5';
    } catch (e) {
      failed++;
      console.error(e);
    }
  }
  const left = rows.length - complete;
  const msg = `Read ${rows.length}: ${complete} filled in${left ? `, ${left} still need${left === 1 ? 's' : ''} details` : ''}${failed ? ` (${failed} couldn't be read)` : ''}. Please check the amounts.`;
  location.href = `/?status=all&msg=${encodeURIComponent(msg)}&kind=${left ? 'warn' : 'ok'}`;
});
