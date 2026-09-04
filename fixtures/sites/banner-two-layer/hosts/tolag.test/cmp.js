document.getElementById('ok').addEventListener('click', function () { localStorage.setItem('tolag', 'accept'); document.cookie = 'tolag=accept; path=/; max-age=31536000'; document.getElementById('cmp').hidden = true; });
document.getElementById('settings').addEventListener('click', function () { document.getElementById('layer1').hidden = true; document.getElementById('layer2').hidden = false; });
document.getElementById('save').addEventListener('click', function () {
  var on = ['stat', 'mkt', 'pref'].filter(function (id) { return document.getElementById(id).checked; });
  if (on.length === 0) { localStorage.setItem('tolag', 'reject'); document.cookie = 'tolag=reject; path=/; max-age=31536000'; }
  document.getElementById('cmp').hidden = true;
});
  
