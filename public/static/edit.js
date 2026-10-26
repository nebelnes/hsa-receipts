// Reads the receipt on the phone and fills in empty fields for checking.
// Photos: tesseract.js (OCR). PDFs: their text layer via pdf.js, or OCR of
// page 1 when the PDF is a scan. Only the reading engine is downloaded from
// jsDelivr; the receipt never leaves the device for reading.

import { parseReceipt } from './parse.js';
import { readFileText, todayNY } from './reader.js';

const box = document.getElementById('ocr');
const btn = document.getElementById('ocr-btn');
const statusEl = document.getElementById('ocr-status');
const say = (t) => { statusEl.textContent = t; };

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
    const text = await readFileText(box.dataset.file, box.dataset.type, say);
    const today = todayNY();
    const ocrField = document.getElementById('ocr_text');
    // Text that came with the receipt (an emailed message) fills any gaps.
    const earlier = ocrField && !ocrField.dataset.read ? ocrField.value : '';
    const g = parseReceipt(text, { today });
    const e2 = earlier ? parseReceipt(earlier, { today }) : {};
    for (const k of ['date', 'provider', 'amount', 'category']) if (g[k] === null || g[k] === undefined) g[k] = e2[k] ?? null;
    if (ocrField) {
      ocrField.value = (earlier ? `${text}\n---\n${earlier}` : text).slice(0, 8000);
      ocrField.dataset.read = '1';
    }
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
