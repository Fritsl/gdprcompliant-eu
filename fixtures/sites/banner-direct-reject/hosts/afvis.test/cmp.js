if (localStorage.getItem('afvis')) { document.getElementById('cookie-banner').hidden = true; }
document.getElementById('accept').addEventListener('click', function () { localStorage.setItem('afvis', 'accept'); document.cookie = 'afvis=accept; path=/; max-age=31536000'; document.getElementById('cookie-banner').hidden = true; });
document.getElementById('reject').addEventListener('click', function () { localStorage.setItem('afvis', 'reject'); document.cookie = 'afvis=reject; path=/; max-age=31536000'; document.getElementById('cookie-banner').hidden = true; });
  
