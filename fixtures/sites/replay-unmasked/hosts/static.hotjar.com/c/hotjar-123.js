// A simulated session replay tag: the globals a real one leaves on the page, and a
// recording beacon to its own host. It records nothing here.
(function () {
  window._hjSettings = { hjid: 123, hjsv: 6 };
  window.hj =
    window.hj ||
    function () {
      (window.hj.q = window.hj.q || []).push(arguments);
    };
  var img = new Image();
  img.src = 'https://static.hotjar.com/api/v2/sites/123/record?u=' + encodeURIComponent(location.href);
})();
