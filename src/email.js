// Email in: bills, PDFs, photos and e-receipts forwarded to the site's
// address (e.g. receipts@muravskiy.org) become receipts in the sender's HSA.
// Only emails from the family's own addresses are accepted, and only when
// Cloudflare confirmed the sender is real (SPF, DKIM or DMARC passed).

import { ensureSchema } from './schema.js';
import { parseEmail } from './mime.js';
import { allowedEmails } from './auth.js';
import { getAccounts } from './accounts.js';
import { createFromUpload } from './pages/expenses.js';
import { fileType, sha256Hex } from './files.js';
import { parseReceipt } from '../public/static/parse.js';
import { today } from './util.js';

const MAX_RAW = 25 * 1024 * 1024;

export function senderVerified(headers) {
  const results = [...headers.get('arc-authentication-results'), ...headers.get('authentication-results')]
    .filter((h) => /mx\.cloudflare\.net/i.test(h));
  return results.some((h) => /\b(dmarc|dkim|spf)=pass\b/i.test(h));
}

// Returns { id } when saved, or { reject: 'reason' }.
export async function receiveEmail(message, env) {
  await ensureSchema(env.DB);
  if (message.rawSize > MAX_RAW) return { reject: 'Too large. Please send receipts under 25 MB.' };
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const mail = parseEmail(raw);

  const accounts = await getAccounts(env);
  const known = new Set([...allowedEmails(env), ...accounts.map((a) => String(a.email || '').toLowerCase()).filter(Boolean)]);
  const sender = String(message.from || '').toLowerCase();
  if (!known.has(sender) || (mail.from && !known.has(mail.from))) return { reject: 'This address only accepts receipts from family members.' };
  if (!senderVerified(mail.headers)) return { reject: 'Could not verify the sender. Please send from your own email account.' };

  // Photos and PDFs; tiny inline images are usually logos and signatures.
  const files = mail.attachments
    .filter((a) => a.data.length > 0)
    .map((a) => ({ ...a, type: fileType({ type: a.type, name: a.filename }) }))
    .filter((a) => a.type && !(a.inline && a.type.startsWith('image/') && a.data.length < 15_000))
    .slice(0, 12)
    .map((a, i) => new File([a.data], a.filename || `email-${i + 1}.${a.type === 'application/pdf' ? 'pdf' : 'jpg'}`, { type: a.type }));

  const body = mail.text.slice(0, 8000);
  if (!files.length && body.replace(/\s/g, '').length < 20) return { reject: 'No receipt found. Attach a PDF or photo, or forward the e-receipt.' };

  // An e-receipt in the email body can be read right away; attachments are read when opened.
  const guess = files.length ? { category: null } : parseReceipt(`${mail.subject}\n${body}`, { today: today() });
  const fields = {
    service_date: files.length ? null : guess.date,
    provider: files.length ? null : guess.provider,
    amount: files.length ? null : guess.amount,
    category: files.length ? null : guess.category,
    paid_date: files.length ? null : guess.date,
    notes: `Emailed: ${mail.subject || '(no subject)'}`.slice(0, 300),
    ocr_text: body || null,
    // Fingerprint of an e-receipt in the body, to spot the same email sent twice.
    source_hash: files.length ? null : await sha256Hex(`${mail.subject}\n${body}`.toLowerCase().replace(/^(fwd?|re):\s*/gm, '').replace(/^>+/gm, '').replace(/\s+/g, ' ').trim()),
  };
  const r = await createFromUpload(env, sender, files, { allowEmpty: true, fields });
  if (r.error) return { reject: r.error };
  return { id: r.id, files: files.length };
}
