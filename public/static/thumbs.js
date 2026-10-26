// Shows page 1 of each PDF as a picture in its file tile (made on this
// device with pdf.js). If it can't be drawn, the 📄 icon stays.

import { PDFJS, PDFJS_WORKER } from './reader.js';

const tiles = [...document.querySelectorAll('.thumb .doc[data-pdf]')];
let lib;

async function draw(el) {
  try {
    lib ||= import(PDFJS).then((m) => {
      m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return m;
    });
    const pdfjs = await lib;
    const doc = await pdfjs.getDocument({ url: el.dataset.pdf, withCredentials: true }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(360 / base.width, 360 / base.height) * Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    canvas.setAttribute('aria-label', `Page 1 of ${doc.numPages}`);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    el.replaceChildren(canvas);
    el.title = doc.numPages > 1 ? `${doc.numPages} pages. Tap to open.` : 'Tap to open.';
  } catch (e) {
    console.warn('PDF preview failed', e);
  }
}

if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      draw(en.target);
    }
  }, { rootMargin: '200px' });
  tiles.forEach((t) => io.observe(t));
} else {
  tiles.forEach(draw);
}
