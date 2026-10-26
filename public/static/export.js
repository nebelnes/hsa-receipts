// Export page: builds one ZIP of every receipt file plus the list, in the browser.

import { makeZip } from './zip.js';

const btn = document.getElementById('zip');
const statusEl = document.getElementById('zip-status');
const say = (t) => { statusEl.textContent = t; };

btn?.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    say('Getting the file list…');
    const res = await fetch('/export/files.json', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`list failed (${res.status})`);
    const { csv, files } = await res.json();
    const entries = [{ name: 'hsa-receipts.csv', data: new TextEncoder().encode(csv) }];
    for (let i = 0; i < files.length; i++) {
      say(`Downloading file ${i + 1} of ${files.length}…`);
      const r = await fetch(files[i].url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`${files[i].path} failed (${r.status})`);
      entries.push({ name: `receipts/${files[i].path}`, data: new Uint8Array(await r.arrayBuffer()) });
    }
    say('Building the ZIP…');
    const blob = new Blob([makeZip(entries)], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hsa-receipts-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    say(`Done: ${files.length} file${files.length === 1 ? '' : 's'} plus the list.`);
  } catch (e) {
    say(`Export failed: ${e.message || e}`);
  } finally {
    btn.disabled = false;
  }
});
