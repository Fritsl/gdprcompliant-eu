// A banner that closes on either answer and stores nothing, so it asks again on every
// page. The refusal is clicked, never registered: the finding is CNS-04.
document.getElementById('accept').addEventListener('click', function () {
  document.getElementById('cookie-banner').hidden = true;
});
document.getElementById('reject').addEventListener('click', function () {
  document.getElementById('cookie-banner').hidden = true;
});
