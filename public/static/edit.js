// Reads the receipt on the phone and fills in empty fields for checking.
// Photos: tesseract.js (OCR). PDFs: their text layer via pdf.js, or OCR of
// page 1 when the PDF is a scan. Only the reading engine is downloaded from
// jsDelivr; the receipt never leaves the device for reading.

import { parseReceipt } from './parse.js';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

const box = document.getElementById('ocr');
const btn = document.getElementById('ocr-btn');
const statusEl = document.getElementById('ocr-status');
const say = (t) => { statusEl.textContent = t; };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the reading engine'));
    document.head.appendChild(s);
  });
}

async function ocrImage(image) {
  say('Loading the reader (first time takes a few seconds)…');
  await loadScript(TESSERACT);
  say('Reading the receipt…');
  const worker = await window.Tesseract.createWorker('eng');
  try {
    const { data } = await worker.recognize(image);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

async function readPdf(url) {
  say('Opening the PDF…');
  const pdfjs = await import(PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjs.getDocument({ url, withCredentials: true }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
    const pg = await doc.getPage(i);
    const content = await pg.getTextContent();
    for (const item of content.items) text += item.str + (item.hasEOL ? '\n' : ' ');
    text += '\n';
  }
  if (text.replace(/\s/g, '').length > 40) return text;
  // A scanned PDF has no text: draw page 1 and read it like a photo.
  const pg = await doc.getPage(1);
  const viewport = pg.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await pg.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return ocrImage(canvas);
}

function fill(id, value) {
  const el = document.getElementById(id);
  if (!el || value === null || value === undefined || value === '') return false;
  if (String(el.value || '').trim()) return false; // never overwrite what's there
  el.value = value;
  el.classList.add('filled');
  el.addEventListener('input', () => el.classList.remove('filled'), { once: true });
  return true;
}

async function read() {
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const src = box.dataset.file;
    let text;
    if (box.dataset.type === 'application/pdf') {
      text = await readPdf(src);
    } else {
      const res = await fetch(src, { credentials: 'same-origin' });
      text = await ocrImage(await res.blob());
    }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const g = parseReceipt(text, { today });
    const ocrField = document.getElementById('ocr_text');
    if (ocrField) ocrField.value = text.slice(0, 8000);
    const got = [];
    if (fill('service_date', g.date)) got.push('date');
    if (fill('provider', g.provider)) got.push('provider');
    if (fill('amount', g.amount !== null ? g.amount.toFixed(2) : null)) got.push('amount');
    if (fill('category', g.category)) got.push('category');
    if (fill('paid_date', g.date)) got.push('paid date');
    say(got.length
      ? `Filled in ${got.join(', ')} from the receipt. Highlighted fields are guesses, so please check them.`
      : 'Couldn\'t pick out the details. Please type them in.');
  } catch (e) {
    say(`Couldn't read it automatically (${e.message || e}). Please type the details in.`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Read receipt again';
  }
}

btn.addEventListener('click', read);
if (box.dataset.auto === '1') read();
