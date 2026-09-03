// A simulated analytics tag, arriving late. Sets an identifier and reports a pageview.
(function () {
  document.cookie = '_lz=' + Math.random().toString(36).slice(2) + '; path=/; max-age=63072000; SameSite=Lax';
  var img = new Image();
  img.src = 'http://lazy.tracker.test/collect?e=pageview';
})();
