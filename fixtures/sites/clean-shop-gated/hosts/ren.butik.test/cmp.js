(function () {
  var key = 'ren-consent';
  var banner = document.getElementById('cookie-banner');
  function load() {
    var s = document.createElement('script');
    s.src = 'https://maal.tracker.test/tag.js';
    document.body.appendChild(s);
  }
  function remember(choice) {
    localStorage.setItem(key, choice);
    document.cookie = key + '=' + choice + '; path=/; max-age=31536000; secure; samesite=lax';
    banner.hidden = true;
  }
  var stored = localStorage.getItem(key);
  if (stored) {
    banner.hidden = true;
    if (stored === 'accept') load();
  }
  document.getElementById('accept').addEventListener('click', function () { remember('accept'); load(); });
  document.getElementById('reject').addEventListener('click', function () { remember('reject'); });
})();
