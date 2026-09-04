if (localStorage.getItem('uc_settings')) { document.getElementById('usercentrics-root').style.display = 'none'; }
var root = document.getElementById('usercentrics-root').attachShadow({ mode: 'open' });
root.innerHTML = '<div id="uc-banner" style="position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:2px solid #333;padding:1rem;z-index:1000" role="dialog">' +
  '<p>Wir verwenden Cookies und ähnliche Technologien.</p>' +
  '<button data-testid="uc-accept-all-button" type="button">Alle akzeptieren</button>' +
  '<button data-testid="uc-more-button" type="button">Einstellungen</button>' +
  '<button data-testid="uc-deny-all-button" type="button">Ablehnen</button></div>';
root.querySelector('[data-testid="uc-deny-all-button"]').addEventListener('click', function () { localStorage.setItem('uc_settings', 'reject'); document.cookie = 'uc_settings=reject; path=/; max-age=31536000'; document.getElementById('usercentrics-root').style.display = 'none'; });
root.querySelector('[data-testid="uc-accept-all-button"]').addEventListener('click', function () { localStorage.setItem('uc_settings', 'accept'); document.cookie = 'uc_settings=accept; path=/; max-age=31536000'; document.getElementById('usercentrics-root').style.display = 'none'; });
  
