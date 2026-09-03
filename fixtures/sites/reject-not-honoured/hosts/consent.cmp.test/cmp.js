// A simulated consent platform. It shows the banner, records the choice, and hides the
// banner again. It does exactly what it says. What it does not do is gate anything: the
// site's tags never ask it, which is the finding.
(function () {
  var KEY = 'cmp-choice';
  function show() {
    var el = document.getElementById('cmp');
    if (!el) return;
    if (localStorage.getItem(KEY)) return;
    el.hidden = false;
    document.getElementById('cmp-accept').addEventListener('click', function () {
      localStorage.setItem(KEY, 'accept');
      document.cookie = 'cmp_consent=accept; path=/; max-age=31536000';
      el.hidden = true;
      window.dispatchEvent(new CustomEvent('CookieConsentDecision', { detail: { categories: ['statistics', 'marketing'] } }));
    });
    document.getElementById('cmp-reject').addEventListener('click', function () {
      localStorage.setItem(KEY, 'reject');
      document.cookie = 'cmp_consent=reject; path=/; max-age=31536000';
      el.hidden = true;
      window.dispatchEvent(new CustomEvent('CookieConsentDecision', { detail: { categories: [] } }));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
