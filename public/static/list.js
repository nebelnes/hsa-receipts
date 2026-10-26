// Receipts list: running total of ticked receipts for "mark reimbursed".

const boxes = [...document.querySelectorAll('input[name=ids]')];
const all = document.getElementById('all');
const total = document.getElementById('sel-total');
const count = document.getElementById('sel-n');
const btn = document.getElementById('bulk-btn');
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function update() {
  const on = boxes.filter((b) => b.checked);
  total.textContent = fmt.format(on.reduce((s, b) => s + Number(b.dataset.amount || 0), 0));
  count.textContent = String(on.length);
  btn.disabled = on.length === 0;
  if (all) all.checked = on.length === boxes.length && boxes.length > 0;
}

boxes.forEach((b) => b.addEventListener('change', update));
if (all) all.addEventListener('change', () => { boxes.forEach((b) => { b.checked = all.checked; }); update(); });
update();
