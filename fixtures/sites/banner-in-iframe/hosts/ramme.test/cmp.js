window.addEventListener('message', function (e) {
  if (e.data === 'reject') { localStorage.setItem('ramme', 'reject'); document.cookie = 'ramme=reject; path=/; max-age=31536000'; document.getElementById('consent-frame').style.display = 'none'; }
  if (e.data === 'accept') { document.getElementById('consent-frame').style.display = 'none'; }
});
  
