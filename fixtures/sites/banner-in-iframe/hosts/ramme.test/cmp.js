if (localStorage.getItem('ramme')) { document.getElementById('consent-frame').style.display = 'none'; }
window.addEventListener('message', function (e) {
  if (e.data === 'reject') { localStorage.setItem('ramme', 'reject'); document.cookie = 'ramme=reject; path=/; max-age=31536000'; document.getElementById('consent-frame').style.display = 'none'; }
  if (e.data === 'accept') { localStorage.setItem('ramme', 'accept'); document.cookie = 'ramme=accept; path=/; max-age=31536000'; document.getElementById('consent-frame').style.display = 'none'; }
});
  
