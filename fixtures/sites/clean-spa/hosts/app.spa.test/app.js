(function () {
  var key = 'spa-consent';
  var views = {
    '': '<h2>Planlæg din uge</h2><p>Et lille værktøj til at holde styr på ugens opgaver. Alt gemmes i din browser.</p>',
    'om': '<h2>Om</h2><p>Lavet af to udviklere i Aarhus. Skriv til hej@app.spa.test.</p>',
    'privatliv': '<h2>Privatlivspolitik</h2>' +
      '<p>Planlægger ApS er dataansvarlig for de personoplysninger, vi behandler om dig. Vi behandler kun det, du selv skriver ind, og det bliver i din browser, medmindre du siger ja til statistik.</p>' +
      '<p>Siger du ja, sender vi sidevisninger til vores statistikleverandør i EU under en databehandleraftale. Vi videregiver ikke oplysninger til andre, medmindre loven kræver det.</p>' +
      '<p>Du har ret til indsigt, berigtigelse, sletning og dataportabilitet, og du kan til enhver tid gøre indsigelse eller trække dit samtykke tilbage. Skriv til privatliv@app.spa.test.</p>' +
      '<p>Du kan klage til Datatilsynet, Carl Jacobsens Vej 35, 2500 Valby.</p>'
  };
  function render() {
    var route = location.hash.replace(/^#\/?/, '');
    document.getElementById('app').innerHTML = views[route] || views[''];
  }
  function load() {
    var s = document.createElement('script');
    s.src = 'https://spor.tracker.test/tag.js';
    document.body.appendChild(s);
  }
  function banner() {
    var stored = localStorage.getItem(key);
    if (stored) { if (stored === 'accept') load(); return; }
    var el = document.createElement('div');
    el.id = 'cookie-banner';
    el.className = 'overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cookies');
    el.innerHTML = '<p>Må vi bruge statistik-cookies?</p><button id="accept" type="button">Accepter alle</button><button id="reject" type="button">Afvis alle</button>';
    document.body.appendChild(el);
    document.getElementById('accept').addEventListener('click', function () { localStorage.setItem(key, 'accept'); el.hidden = true; load(); });
    document.getElementById('reject').addEventListener('click', function () { localStorage.setItem(key, 'reject'); el.hidden = true; });
  }
  window.addEventListener('hashchange', render);
  render();
  banner();
})();
