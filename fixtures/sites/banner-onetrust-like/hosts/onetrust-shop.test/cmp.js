document.getElementById('onetrust-reject-all-handler').addEventListener('click', function () { localStorage.setItem('OptanonConsent', 'reject'); document.cookie = 'OptanonConsent=reject; path=/; max-age=31536000'; document.getElementById('onetrust-banner-sdk').style.display = 'none'; });
document.getElementById('onetrust-accept-btn-handler').addEventListener('click', function () { localStorage.setItem('OptanonConsent', 'accept'); document.cookie = 'OptanonConsent=accept; path=/; max-age=31536000'; document.getElementById('onetrust-banner-sdk').style.display = 'none'; });
  
