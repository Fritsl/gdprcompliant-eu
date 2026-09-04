(function () {
  var img = new Image();
  img.src = 'https://sporing.tracker.test/collect?e=pageview&u=' + encodeURIComponent(location.href);
})();
