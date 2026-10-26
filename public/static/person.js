// Edit page: choosing a person switches "Whose HSA?" to that person's default
// HSA (set in Settings). You can still pick the other one by hand.

const form = document.querySelector('form[data-person-hsa]');
if (form) {
  let map = {};
  try {
    map = JSON.parse(form.dataset.personHsa || '{}');
  } catch {
    map = {};
  }
  const patient = form.querySelector('#patient');
  const radios = [...form.querySelectorAll('input[type=radio][name=account]')];
  const note = form.querySelector('#acct-note');
  const apply = () => {
    const key = String(patient.value || '').trim().toLowerCase();
    const id = map[key];
    if (!id) return;
    const r = radios.find((x) => x.value === String(id));
    if (r && !r.checked) {
      r.checked = true;
      if (note) note.textContent = `Switched to ${r.parentElement.textContent.trim()}'s HSA, the usual one for ${patient.value.trim()}.`;
    }
  };
  if (patient && radios.length) {
    patient.addEventListener('change', apply);
    patient.addEventListener('blur', apply);
  }
}
