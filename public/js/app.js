/* Kotamix Concrete - tiny progressive-enhancement layer. */
(function () {
  'use strict';

  /* ---- off-canvas sidebar ---- */
  var nav = document.getElementById('sidenav');
  var scrim = document.getElementById('navScrim');
  var toggle = document.getElementById('navToggle');

  function setNav(open) {
    if (!nav) return;
    nav.classList.toggle('open', open);
    if (scrim) scrim.classList.toggle('on', open);
    document.body.style.overflow = open ? 'hidden' : '';
  }
  if (toggle) toggle.addEventListener('click', function () { setNav(!nav.classList.contains('open')); });
  if (scrim) scrim.addEventListener('click', function () { setNav(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setNav(false); });

  /* ---- auto-dismiss flash messages ---- */
  Array.prototype.forEach.call(document.querySelectorAll('.flash'), function (f) {
    setTimeout(function () {
      f.style.transition = 'opacity .4s, transform .4s';
      f.style.opacity = '0';
      f.style.transform = 'translateY(-6px)';
      setTimeout(function () { f.remove(); }, 420);
    }, 6000);
  });

  /* ---- number formatting for order totals (progressive) ---- */
  function recalcOrderTotals() {
    var form = document.getElementById('orderForm');
    if (!form) return;
    var get = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? parseFloat(el.value) || 0 : 0; };
    var vol = get('volume_m3'), price = get('unit_price'), disc = get('discount'),
      del = get('delivery_charge'), rate = get('sst_rate');
    var sub = Math.max(0, vol * price - disc + del);
    var sst = Math.round(sub * rate) / 100;
    var total = Math.round((sub + sst) * 100) / 100;
    var set = function (n, v) { var el = document.getElementById('calc-' + n); if (el) el.textContent = v.toFixed(2); };
    set('subtotal', sub);
    set('sst', sst);
    set('total', total);
  }
  var of = document.getElementById('orderForm');
  if (of) {
    ['volume_m3', 'unit_price', 'discount', 'delivery_charge', 'sst_rate'].forEach(function (n) {
      var el = of.querySelector('[name="' + n + '"]');
      if (el) el.addEventListener('input', recalcOrderTotals);
    });
    recalcOrderTotals();
  }

  /* ---- invoice select pre-fills the payment amount ---- */
  var payForm = document.getElementById('payf');
  if (payForm) {
    var invSel = payForm.querySelector('[name="invoice_id"]');
    var amt = payForm.querySelector('.js-amt');
    var data = window.__OPEN_INV__ || {};
    if (invSel && amt) {
      invSel.addEventListener('change', function () {
        var v = data[invSel.value];
        if (v !== undefined) amt.value = v;
      });
    }
  }

  /* ---- generic confirm on forms flagged data-confirm ---- */
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && f.dataset && f.dataset.confirm && !window.confirm(f.dataset.confirm)) e.preventDefault();
  }, true);

  /* ---- select-all checkbox in tables ---- */
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t.matches || !t.matches('input[data-check-all]')) return;
    var scope = t.closest('table') || document;
    scope.querySelectorAll('input[data-check-row]').forEach(function (c) { c.checked = t.checked; });
  });
})();
