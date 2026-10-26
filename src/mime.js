// Small email (MIME) reader for receipts sent to the site's email address:
// headers, subject, plain text, and attachments (photos and PDFs).

const latin1 = new TextDecoder('latin1');

function decodeBase64(text) {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof Uint8Array.fromBase64 === 'function') {
    try {
      return Uint8Array.fromBase64(clean.replace(/=+$/, ''), { lastChunkHandling: 'loose' });
    } catch {
      /* fall through */
    }
  }
  const bin = atob(clean.length % 4 ? clean + '='.repeat(4 - (clean.length % 4)) : clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeQP(text) {
  const s = text.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

function bytesToText(bytes, charset = 'utf-8') {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^(us-ascii|ascii)$/, 'utf-8')).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// =?utf-8?B?...?= and =?utf-8?Q?...?= words in headers.
export function decodeWords(s) {
  return String(s || '')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
      const bytes = enc.toUpperCase() === 'B' ? decodeBase64(data) : decodeQP(data.replace(/_/g, ' '));
      return bytesToText(bytes, cs);
    });
}

function parseHeaders(block) {
  const headers = new Map();
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  let cur = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) {
      cur[1] += ` ${line.trim()}`;
    } else {
      const m = line.match(/^([^:\s]+):\s*(.*)$/);
      if (!m) continue;
      cur = [m[1].toLowerCase(), m[2]];
      if (!headers.has(cur[0])) headers.set(cur[0], []);
      headers.get(cur[0]).push(cur);
    }
  }
  const get = (k) => (headers.get(k) || []).map((x) => x[1]);
  return { get, first: (k) => get(k)[0] || '' };
}

function param(value, name) {
  // RFC 2231 (filename*=utf-8''...) first, then plain name="..."
  const star = new RegExp(`${name}\\*=(?:([^']*)'[^']*')?("?)([^";]+)\\2`, 'i').exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[3]);
    } catch {
      return star[3];
    }
  }
  const plain = new RegExp(`${name}=(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value);
  return plain ? decodeWords(plain[1] ?? plain[2]) : '';
}

function splitHead(text) {
  const m = /\r?\n\r?\n/.exec(text);
  return m ? [text.slice(0, m.index), text.slice(m.index + m[0].length)] : [text, ''];
}

function walk(text, out, depth = 0) {
  const [head, body] = splitHead(text);
  const h = parseHeaders(head);
  const ctype = h.first('content-type') || 'text/plain';
  const type = ctype.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const boundary = param(ctype, 'boundary');
    if (!boundary) return;
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const p of parts.slice(1)) if (p.trim()) walk(p, out, depth + 1);
    return;
  }
  if (type === 'message/rfc822' && depth < 8) {
    walk(body, out, depth + 1); // forwarded email as an attachment
    return;
  }
  const enc = (h.first('content-transfer-encoding') || '7bit').trim().toLowerCase();
  const bytes = enc === 'base64' ? decodeBase64(body) : enc === 'quoted-printable' ? decodeQP(body) : Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
  const disp = h.first('content-disposition');
  const filename = param(disp, 'filename') || param(ctype, 'name');
  const isAttachment = /^attachment/i.test(disp) || (filename && !type.startsWith('text/'));
  if (!isAttachment && type === 'text/plain') out.text.push(bytesToText(bytes, param(ctype, 'charset') || 'utf-8'));
  else if (!isAttachment && type === 'text/html') out.html.push(bytesToText(bytes, param(ctype, 'charset') || 'utf-8'));
  else out.attachments.push({ filename: filename || '', type, data: bytes, inline: /^inline/i.test(disp) || !!h.first('content-id') });
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// raw: Uint8Array of the whole email.
export function parseEmail(raw) {
  const text = latin1.decode(raw);
  const [head] = splitHead(text);
  const h = parseHeaders(head);
  const out = { text: [], html: [], attachments: [] };
  walk(text, out);
  const plain = out.text.join('\n').trim();
  return {
    headers: h,
    subject: decodeWords(h.first('subject')).trim(),
    from: (decodeWords(h.first('from')).match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0].toLowerCase(),
    text: plain || htmlToText(out.html.join('\n')),
    attachments: out.attachments,
  };
}
