// "Add a receipt": uploads as soon as a photo is taken or files are chosen.
// Photos are shrunk on the phone first (max 2000 px), so uploads are quick
// and storage stays small. PDFs are uploaded as they are.

const form = document.getElementById('capture');
const statusEl = document.getElementById('status');
const inputs = [...form.querySelectorAll('input[type=file]')];
const say = (t) => { statusEl.textContent = t; };

async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file; // the server takes the original
  }
}

async function upload() {
  const files = inputs.flatMap((i) => [...i.files]);
  if (!files.length) return;
  inputs.forEach((i) => { i.disabled = true; });
  say(`Preparing ${files.length} file${files.length === 1 ? '' : 's'}…`);
  const fd = new FormData();
  const acct = form.querySelector('input[name=account]:checked') || form.querySelector('input[name=account][type=hidden]');
  if (acct) fd.append('account', acct.value);
  for (const f of files) {
    const s = await shrink(f);
    fd.append('files', s, s.name);
  }
  say('Uploading…');
  try {
    const res = await fetch(form.action, { method: 'POST', body: fd, credentials: 'same-origin' });
    if (res.redirected) {
      location.href = res.url;
      return;
    }
    if (res.ok) {
      document.open();
      document.write(await res.text());
      document.close();
      return;
    }
    say(`Upload failed (${res.status}). Please try again.`);
  } catch {
    say('Upload failed. Check your connection and try again.');
  }
  inputs.forEach((i) => { i.disabled = false; i.value = ''; });
}

inputs.forEach((i) => i.addEventListener('change', upload));
form.addEventListener('submit', (e) => {
  e.preventDefault();
  upload();
});
