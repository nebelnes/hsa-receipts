// Receipt page: "Download as PDF" puts all of the receipt's photos into one
// PDF (a page per photo), made on your device. The photos stay as they are.

import { makePdf } from './pdf.js';

const btn = document.getElementById('pdf-btn');
const statusEl = document.getElementById('pdf-status');
const say = (t) => { if (statusEl) statusEl.textContent = t; };

async function toJpegPage(blob) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PNG transparency becomes white paper
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  const jpg = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  return { jpeg: new Uint8Array(await jpg.arrayBuffer()), width: canvas.width, height: canvas.height };
}

btn?.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    const files = JSON.parse(btn.dataset.files || '[]');
    const pages = [];
    for (let i = 0; i < files.length; i++) {
      say(`Adding photo ${i + 1} of ${files.length}…`);
      const r = await fetch(files[i], { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`photo ${i + 1} failed (${r.status})`);
      pages.push(await toJpegPage(await r.blob()));
    }
    const pdf = makePdf(pages, { title: btn.dataset.name || 'Receipt' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    a.download = `${btn.dataset.name || 'receipt'}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    say(`Saved ${a.download} (${pages.length} page${pages.length === 1 ? '' : 's'}).`);
  } catch (e) {
    say(`Couldn't make the PDF: ${e.message || e}`);
  } finally {
    btn.disabled = false;
  }
});
