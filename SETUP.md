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
- **HSA accounts**: one per spouse: name, the email they use, HSA provider and
  its reimbursement page. Each of you gets your own "can reimburse" total, and
  new receipts go to the account of whoever adds or emails them.
- Family members' names (patients) and the cards you pay with.

## 7. Email in (forward receipts to receipts@muravskiy.org)
Your domain → **Email** → **Email Routing** → **Routing rules** →
**Create address**:
- Custom address: `receipts`
- Action: **Send to a Worker** → `hsa-receipts` → Save

Forward bills, PDF invoices, photos or e-receipts there from your own email
(or your wife's, once it's in Settings). Each email becomes a receipt in the
sender's HSA. Emails from anyone else, or that Cloudflare can't verify, bounce
back with a short reason. Free.

## 8. Your wife's access
Add her email to the **Family** policy in Zero Trust (shared with trips) and
tell Claude, who adds it to `ALLOWED_EMAILS` in `wrangler.jsonc`.

## Costs
- Worker, database, Access (up to 50 users): free.
- R2: free up to 10 GB (may need a payment method on file to enable).
- Receipt reading runs on your phone: free. The reading engine (tesseract.js,
  pdf.js) loads from jsDelivr, a free public CDN; the receipt itself isn't sent
  anywhere for reading.
- Domain: already paid for (muravskiy.org).

## OneDrive backup (optional)

The site can copy every receipt file and the receipt list to OneDrive each
night, into its own folder (OneDrive › Apps › HSA Receipts). It needs a
Microsoft "app registration" (free), which Microsoft now only allows inside
a directory (Entra ID tenant).

1. In the Azure portal → App registrations → New registration:
   - Name: `HSA Receipts`
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: platform **Public client/native (mobile & desktop)**,
     `https://hsa.muravskiy.org/onedrive/callback`
2. Authentication → Advanced settings → **Allow public client flows: Yes** → Save.
3. API permissions → Add → Microsoft Graph → Delegated →
   `Files.ReadWrite.AppFolder` and `offline_access`.
4. Copy the **Application (client) ID** into `ONEDRIVE_CLIENT_ID` in
   `wrangler.jsonc`, push, then Settings → **Connect OneDrive**.

No client secret is used, so nothing expires. If Microsoft sign-in lapses
(password change, 90 days unused), Settings shows "Connect OneDrive" again.
