# Setting up HSA Receipts

Same steps as trips.muravskiy.org, minus the domain (you already own
muravskiy.org). About 20 minutes. Nothing secret goes into chat or this
repository.

## 1. GitHub
Create a **private, empty** repository named `hsa-receipts` and tell Claude.
Claude pushes the code into it.

## 2. Turn on R2 (receipt file storage)
Cloudflare dashboard → **R2 Object Storage** → **Get started / Enable**.
- Free up to **10 GB** of files (roughly 30,000+ receipt photos at the size
  this site saves them).
- Cloudflare may ask for a payment method to switch R2 on. You're only charged
  if you go over the free allowance.
- Then **Create bucket** → name it `hsa-receipts` → defaults → Create.

## 3. Put the site on Cloudflare
**Workers & Pages** → **Create** → **Import a repository** → choose
`hsa-receipts` → keep the defaults → **Deploy**.
The first deploy creates the database and the address `hsa.muravskiy.org`
(listed in `wrangler.jsonc`). Every change Claude saves to GitHub goes live
automatically in about a minute.

Until step 4 is done the site shows **Locked**. That's expected.

## 4. Lock it to you and your wife (Cloudflare Access)
**Zero Trust** → **Access** → **Applications** → **Add an application** →
**Self-hosted** (same team as trips):
- Application domain: `hsa.muravskiy.org`
- **Session duration: 1 month** (so sharing a scan from your phone doesn't
  land on a sign-in page)
- Policy: **Allow**, Include → **Emails** → both of your addresses
- Login method: **One-time PIN**

Then tell Claude (not secret): the application's **Audience (AUD) tag** and
your wife's email. Claude saves them in `wrangler.jsonc`.

## 5. Install it on your phone
Open **hsa.muravskiy.org** in Chrome on Android → sign in with the emailed
code → menu **⋮** → **Add to Home screen** (or **Install app**).
After that, **HSA Receipts** appears in the Share menu:
1. Google Drive → **＋** → **Scan** (auto-crops), or your phone's scanner.
2. **Share** → **HSA Receipts**. The receipt opens and the details fill in.

iPhone: Safari → Share → **Add to Home Screen**. To scan, use the Files app
(**⋯** → **Scan Documents**), save, then **Choose photos or PDFs** on the site.

## 6. Settings page
Add family members' names, your HSA provider and its reimbursement page link.

## Costs
- Worker, database, Access (up to 50 users): free.
- R2: free up to 10 GB (may need a payment method on file to enable).
- Receipt reading runs on your phone: free. The reading engine (tesseract.js,
  pdf.js) loads from jsDelivr, a free public CDN; the receipt itself isn't sent
  anywhere for reading.
- Domain: already paid for (muravskiy.org).
