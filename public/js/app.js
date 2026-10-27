// Small progressive enhancements. No inline scripts (CSP: script-src 'self').
document.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add-row]');
  if (add) {
    const tpl = document.getElementById(add.dataset.addRow);
    const target = document.getElementById(add.dataset.target);
    target.insertAdjacentHTML('beforeend', tpl.innerHTML);
    e.preventDefault();
  }
  const rm = e.target.closest('[data-remove-row]');
  if (rm) { rm.closest('tr').remove(); e.preventDefault(); recalc(); }
});

// Require confirmation for destructive actions.
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

// Navigate on select change (e.g. picking a client on the new invoice page).
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-nav]')) {
    const url = new URL(window.location.href);
    url.searchParams.set(e.target.name, e.target.value);
    window.location.href = url.toString();
  }
  recalc();
});
document.addEventListener('input', recalc);

function parse(v) { const n = Number(String(v || '').replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; }
function fmt(c) { return (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function recalc() {
  const out = document.querySelector('[data-total]');
  if (out) {
    let sum = 0;
    document.querySelectorAll('[data-inst-amount]').forEach((cb) => { if (cb.checked) sum += Number(cb.dataset.instAmount); });
    document.querySelectorAll('input[name="item_amount"]').forEach((i) => { sum += parse(i.value); });
    out.textContent = fmt(sum);
  }
  const instOut = document.querySelector('[data-inst-total]');
  if (instOut) {
    let sum = 0;
    document.querySelectorAll('input[name="inst_amount"]').forEach((i) => { sum += parse(i.value); });
    instOut.textContent = fmt(sum);
    const total = parse(document.querySelector('input[name="total_amount"]')?.value);
    const warn = document.querySelector('[data-inst-warn]');
    if (warn) warn.hidden = sum === 0 || sum === total;
  }
}
recalc();
