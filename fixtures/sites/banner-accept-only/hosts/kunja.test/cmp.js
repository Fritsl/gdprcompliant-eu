if (localStorage.getItem('kunja')) { document.getElementById('notice').hidden = true; }
document.getElementById('ok').addEventListener('click', function () { localStorage.setItem('kunja', 'accept'); document.cookie = 'kunja=accept; path=/; max-age=31536000'; document.getElementById('notice').hidden = true; });
  
