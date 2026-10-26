// Pulls the date of service, provider, amount and a likely category out of
// receipt text (from on-device OCR or a PDF's text). Runs in the browser and
// in the tests. Every guess is shown to the person to check before saving.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n) => String(n).padStart(2, '0');

function validDate(y, m, d, today) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso) return null;
  const now = new Date(`${today}T00:00:00Z`);
  if (t.getTime() > now.getTime() + 2 * 86400000) return null; // no future dates
  if (now.getUTCFullYear() - y > 15) return null; // ignores birth dates and the like
  return iso;
}

function datesIn(line, today) {
  const found = [];
  let m;
  const numeric = /(?<![\d/])(\d{1,2})\s?[/.-]\s?(\d{1,2})\s?[/.-]\s?(\d{4}|\d{2})(?![\d/])/g;
  while ((m = numeric.exec(line))) {
    const d = validDate(Number(m[3]), Number(m[1]), Number(m[2]), today);
    if (d) found.push(d);
  }
  const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
  while ((m = iso.exec(line))) {
    const d = validDate(Number(m[1]), Number(m[2]), Number(m[3]), today);
    if (d) found.push(d);
  }
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;
  while ((m = named.exec(line))) {
    const d = validDate(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]), today);
    if (d) found.push(d);
  }
  const named2 = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/gi;
  while ((m = named2.exec(line))) {
    const d = validDate(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]), today);
    if (d) found.push(d);
  }
  return found;
}

// Money needs cents ("45.10", "$1,234.00") so account numbers and ZIP codes aren't mistaken for amounts.
function moneyIn(line) {
  const out = [];
  const re = /(?<![\d.,])\$?\s?(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})(?![\d])/g;
  let m;
  while ((m = re.exec(line))) {
    const v = Number(`${m[1].replace(/,/g, '')}.${m[2]}`);
    if (v > 0 && v < 100000) out.push(v);
  }
  return out;
}

const SERVICE_DATE = /date of service|service date|dates? of svc|\bdos\b|visit date|date of visit|appointment|appt|fill(?:ed)? date|date filled|treatment date/i;
const NOT_SERVICE_DATE = /birth|\bdob\b|due|statement date|print|expir|member since|payment by|pay by/i;

const OWE = /patient responsibility|your responsibility|amount you owe|you owe|patient (?:balance|portion|pays?|amount)|balance due|amount due|total due|please pay|pay this amount|new balance/i;
const PAID = /amount paid|total paid|you paid|payment received|patient payment|paid today|\bpaid\b|co-?pay|copayment/i;
const TOTAL = /grand total|\btotal\b|amount/i;
const NOT_PATIENT = /insurance|plan (?:paid|pays|discount)|adjust|discount|billed|charges|savings|you saved|deductible remaining|allowed|sub-?total|\btax\b|change due|tendered/i;

function amountFrom(lines) {
  const tiers = [OWE, PAID, TOTAL];
  for (const tier of tiers) {
    const hits = [];
    lines.forEach((line, i) => {
      if (!tier.test(line)) return;
      if (NOT_PATIENT.test(line) && !/patient|you owe|your responsibility/i.test(line)) return;
      let vals = moneyIn(line);
      if (!vals.length && lines[i + 1] !== undefined && !/[a-z]{4,}/i.test(lines[i + 1])) vals = moneyIn(lines[i + 1]);
      if (vals.length) hits.push(vals[vals.length - 1]);
    });
    if (hits.length) return tier === TOTAL ? Math.max(...hits) : hits[hits.length - 1];
  }
  const all = lines.flatMap(moneyIn);
  return all.length ? Math.max(...all) : null;
}

function dateFrom(lines, today) {
  for (let i = 0; i < lines.length; i++) {
    if (!SERVICE_DATE.test(lines[i])) continue;
    const d = datesIn(lines[i], today);
    if (d.length) return d[0];
    const next = lines[i + 1] ? datesIn(lines[i + 1], today) : [];
    if (next.length) return next[0];
  }
  for (const line of lines) {
    if (NOT_SERVICE_DATE.test(line)) continue;
    const d = datesIn(line, today);
    if (d.length) return d[0];
  }
  return null;
}

const PROVIDER_HINT = /pharmacy|clinic|medical|health|dental|dentist|hospital|pediatric|family|center|associates|\bmd\b|\bdds\b|\bod\b|optometr|vision|eye|urgent care|labcorp|quest|cvs|walgreens|kroger|walmart|publix|rite aid|orthodont|dermatolog|physical therapy|children'?s|choa|piedmont|emory|northside|wellstar|kaiser/i;
const NOT_PROVIDER = /receipt|invoice|statement|page \d|\bdate\b|patient|account|acct|phone|tel\b|fax|www\.|https?:|@|thank|guarantor|member|policy|claim|explanation of benefits|this is not a bill|summary|customer copy|^\W*$/i;

function tidyName(s) {
  let t = s.replace(/[|_~*=<>«»•]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\W\d]+|[\W]+$/g, '').trim();
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 3 && letters === letters.toUpperCase()) {
    t = t.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Md|Dds|Od|Pa|Llc|Pc|Cvs|Er|Ent|Choa)\b/g, (w) => w.toUpperCase());
  }
  return t.slice(0, 80);
}

function plausibleName(line) {
  const t = line.trim();
  if (t.length < 3 || t.length > 70) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (letters < 3 || letters / t.length < 0.55) return false;
  if (NOT_PROVIDER.test(t)) return false;
  if (/^\d/.test(t)) return false; // street address
  return true;
}

function providerFrom(lines) {
  const top = lines.slice(0, 12);
  const hinted = top.find((l) => plausibleName(l) && PROVIDER_HINT.test(l));
  if (hinted) return tidyName(hinted);
  const first = top.find(plausibleName);
  return first ? tidyName(first) : null;
}

export function guessCategory(text) {
  const t = String(text || '').toLowerCase();
  if (/pharmacy|\brx\b|prescription|refill|qty|walgreens|cvs|rite aid/.test(t)) return 'Pharmacy';
  if (/dental|dentist|\bdds\b|orthodont|hygien/.test(t)) return 'Dental';
  if (/optometr|vision|eye ?exam|optical|contact lens|eyeglass|\bod\b/.test(t)) return 'Vision';
  if (/labcorp|quest diagnostics|laborator|\blab\b|radiolog|x-ray|\bmri\b|\bct scan|ultrasound|imaging/.test(t)) return 'Lab / imaging';
  if (/emergency|hospital|\ber\b visit|inpatient|outpatient surgery/.test(t)) return 'Hospital / ER';
  if (/therap|counsel|psycholog|psychiatr|chiropract/.test(t)) return 'Therapy / counseling';
  if (/office visit|physician|pediatric|clinic|urgent care|\bmd\b|copay|consult/.test(t)) return 'Doctor visit';
  return null;
}

export function parseReceipt(text, { today } = {}) {
  const day = today || new Date().toISOString().slice(0, 10);
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return {
    date: dateFrom(lines, day),
    amount: amountFrom(lines),
    provider: providerFrom(lines),
    category: guessCategory(text),
  };
}
