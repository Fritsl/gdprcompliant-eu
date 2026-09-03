// A "metrics" script that fingerprints the device on load: canvas, fonts and audio.
(function () {
  // Canvas: draw text nobody sees, read the pixels back.
  var canvas = document.createElement('canvas');
  canvas.width = 220;
  canvas.height = 40;
  var ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  ctx.font = '14px Arial';
  ctx.fillText('Cwm fjordbank glyphs vext quiz, 😃', 2, 15);
  var canvasHash = canvas.toDataURL();

  // Fonts: measure the same text in thirty families and compare widths.
  var families = [
    'Arial', 'Verdana', 'Helvetica', 'Tahoma', 'Trebuchet MS', 'Times New Roman', 'Georgia',
    'Garamond', 'Courier New', 'Brush Script MT', 'Impact', 'Comic Sans MS', 'Lucida Console',
    'Palatino', 'Book Antiqua', 'Century Gothic', 'Calibri', 'Cambria', 'Candara', 'Consolas',
    'Constantia', 'Corbel', 'Franklin Gothic', 'Gill Sans', 'Segoe UI', 'Optima', 'Futura',
    'Geneva', 'Monaco', 'Menlo',
  ];
  var widths = [];
  for (var i = 0; i < families.length; i += 1) {
    ctx.font = '72px "' + families[i] + '", monospace';
    widths.push(ctx.measureText('mmmmmmmmmmlli').width);
  }

  // Audio: an oscillator through a compressor into an offline context, rendered silently.
  try {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var audio = new Offline(1, 5000, 44100);
    var osc = audio.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    var comp = audio.createDynamicsCompressor();
    osc.connect(comp);
    comp.connect(audio.destination);
    osc.start(0);
    audio.startRendering().then(function (buffer) {
      var data = buffer.getChannelData(0);
      var sum = 0;
      for (var j = 4500; j < 5000; j += 1) sum += Math.abs(data[j]);
      window.__fp = { canvas: canvasHash.length, fonts: widths, audio: sum };
    });
  } catch (e) {
    window.__fp = { canvas: canvasHash.length, fonts: widths, audio: null };
  }
})();
