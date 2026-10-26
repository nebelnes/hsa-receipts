# HSA Receipts

A private website (hsa.muravskiy.org) for keeping the family's medical receipts
so they can be reimbursed from the HSA later, even years later.

- **Add receipts fast**: take a photo, choose photos/PDFs, or scan with Google
  Drive or the phone's document scanner (auto-cropping) and **Share → HSA Receipts**.
  Photos are shrunk on the phone before upload.
- **Email it in**: forward bills, PDF invoices, photos or e-receipts to
  receipts@muravskiy.org from your own address; each becomes a receipt in the
  sender's HSA (Cloudflare Email Routing → this Worker; sender checked).
- **Two HSAs**: one account per spouse, each with its own "can reimburse"
  total, filter, provider link and export folder.
- **Reads the receipt for you**: date of service, provider, amount you paid and
  category are filled in from the photo (on-device OCR) or the PDF's text. Filled
  fields are highlighted so you can check them before saving.
- **Ledger**: "Available to reimburse" total, filters by status, year and person,
  and "mark several as reimbursed" when you withdraw from the HSA in one go.
  Paid with the HSA card → marked as such (nothing to reimburse).
- **Proof**: attach the itemized bill, insurance EOB and proof of payment to one
  receipt and label each file.
- **Duplicate check**: flags receipts that look like the same expense (same
  file, same emailed receipt, same date and amount, or same provider and amount
  within a week) so nothing is reimbursed twice. "Not a duplicate" dismisses it.
- **Export**: CSV list, and one ZIP of every file in folders by year.
- **Private**: Cloudflare Access (one-time email codes) in front, and the code
  checks the sign-in token again on every request, files included.

Set-up steps: see [SETUP.md](SETUP.md).

## How it's built
- Cloudflare Worker (`src/index.js`), plain JavaScript, no frameworks; same
  structure as trip-manager.
- Email in: `src/email.js` (checks the sender) and `src/mime.js` (reads the email).
- D1 database for the list (`src/schema.js`, tables created automatically),
  R2 for the photos and PDFs (`src/files.js`).
- Browser scripts in `public/static/` (served only after sign-in): upload and
  shrink (`capture.js`), receipt reading (`edit.js` + `parse.js`, using
  tesseract.js and pdf.js from jsDelivr), ZIP export (`zip.js`, `export.js`).

## Tests
`npm test` runs the whole site against a fake database and fake file storage:
receipt reading on sample OCR text, upload limits, editing, HSA-card receipts,
reimbursing (single and several), file labels, CSV and ZIP export, the Android
share target, cross-site protection, and the sign-in check.
