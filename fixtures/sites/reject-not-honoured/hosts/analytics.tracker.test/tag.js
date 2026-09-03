// A simulated analytics tag. Sets an identifier cookie and reports a pageview the
// moment it loads. It listens to nothing.
(function () {
  if (!/(^|; )_trk=/.test(document.cookie)) {
    document.cookie = '_trk=' + Math.random().toString(36).slice(2) + '; path=/; max-age=63072000';
  }
  var img = new Image();
  img.src = 'http://analytics.tracker.test/collect?e=pageview&u=' + encodeURIComponent(location.href);
})();
