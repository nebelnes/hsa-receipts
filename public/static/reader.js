// Gets the text out of a receipt file on this device: PDFs through their
// text layer (pdf.js), photos and scanned PDFs through OCR (tesseract.js).
// Only the reading engines are downloaded from jsDelivr; the receipt itself
// never leaves the device for reading.

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
export const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
export const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

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

async function ocrImage(image, say) {
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

async function readPdf(url, say) {
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
  return ocrImage(canvas, say);
}

export async function readFileText(url, type, say = () => {}) {
  if (type === 'application/pdf') return readPdf(url, say);
  const res = await fetch(url, { credentials: 'same-origin' });
  return ocrImage(await res.blob(), say);
}

export const todayNY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
