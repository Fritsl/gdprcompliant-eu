document.getElementById('accept').addEventListener('click', function () { parent.postMessage('accept', '*'); });
document.getElementById('reject').addEventListener('click', function () { parent.postMessage('reject', '*'); });
  
