// Minimal PDF writer: one JPEG per US Letter page, scaled to fit with a
// margin. Used by "Download as PDF" on a receipt; also tested in Node.

const enc = new TextEncoder();

// pages: [{ jpeg: Uint8Array (RGB baseline JPEG), width, height }] -> Uint8Array (.pdf)
export function makePdf(pages, { title = 'Receipt' } = {}) {
  const W = 612;
  const H = 792;
  const M = 36; // half-inch margin
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    pos += bytes.length;
  };
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    for (const part of [].concat(body)) push(part);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marks the file as binary
  const n = pages.length;
  // 1 catalog, 2 pages tree, 3 info, then per page: page, content, image
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${kids}] >>`);
  const safeTitle = String(title).replace(/[^\x20-\x7E]/g, '?').replace(/([()\\])/g, '\\$1');
  obj(3, `<< /Title (${safeTitle}) /Producer (HSA Receipts) >>`);
  pages.forEach((p, i) => {
    const pageN = 4 + i * 3;
    const scale = Math.min((W - 2 * M) / p.width, (H - 2 * M) / p.height);
    const w = +(p.width * scale).toFixed(2);
    const h = +(p.height * scale).toFixed(2);
    const x = +((W - w) / 2).toFixed(2);
    const y = +((H - h) / 2).toFixed(2);
    const content = `q ${w} 0 0 ${h} ${x} ${y} cm /Im0 Do Q`;
    obj(pageN, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${pageN + 2} 0 R >> >> /Contents ${pageN + 1} 0 R >>`);
    obj(pageN + 1, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(pageN + 2, [
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      p.jpeg,
      '\nendstream',
    ]);
  });
  const total = 4 + n * 3;
  const xref = pos;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// Reads width/height from a JPEG's SOF marker (for tests and sanity checks).
export function jpegSize(bytes) {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}
