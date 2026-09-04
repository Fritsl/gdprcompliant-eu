if (localStorage.getItem('schalter')) { document.getElementById('dsgvo').hidden = true; }
document.getElementById('accept').addEventListener('click', function () { localStorage.setItem('schalter', 'accept'); document.cookie = 'schalter=accept; path=/; max-age=31536000'; document.getElementById('dsgvo').hidden = true; });
document.getElementById('settings').addEventListener('click', function () { document.getElementById('first').hidden = true; document.getElementById('second').hidden = false; });
Array.prototype.forEach.call(document.querySelectorAll('.opt'), function (b) {
  b.addEventListener('click', function () { var on = b.getAttribute('aria-checked') === 'true'; b.setAttribute('aria-checked', on ? 'false' : 'true'); b.textContent = on ? 'aus' : 'an'; });
});
document.getElementById('save').addEventListener('click', function () {
  var on = Array.prototype.filter.call(document.querySelectorAll('.opt'), function (b) { return b.getAttribute('aria-checked') === 'true'; });
  if (on.length === 0) { localStorage.setItem('schalter', 'reject'); document.cookie = 'schalter=reject; path=/; max-age=31536000'; }
  document.getElementById('dsgvo').hidden = true;
});
  
