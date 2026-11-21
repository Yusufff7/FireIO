/* global webapis, tizen, FIREIO_CONFIG */
// Proof-of-concept: fetch one episode's streams from the configured addons,
// prefer an MKV, and play it through AVPlay — the TV's native player — to
// see whether it handles what FireIO needed a whole native remuxer for on
// Fire TV: MKV seeking, embedded audio tracks, embedded subtitles.
//
// Remote: Left/Right seek 30 s, Up/Down switch audio track, OK pause/play,
// Back exits. Everything the player reports is printed on screen.

var TITLE = { type: 'series', id: 'tt0206512:1:1', name: 'SpongeBob SquarePants S1E1' };
var SEEK_MS = 30000;

var panel = document.getElementById('panel');
var statusEl = document.getElementById('status');
var lines = [];
function log() {
  var text = Array.prototype.slice.call(arguments).join(' ');
  console.log(text);
  lines.push(text);
  if (lines.length > 32) lines.shift();
  panel.textContent = lines.join('\n');
}

function fmt(ms) {
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  // No String#padStart: this TV's browser engine (Chrome 56) predates it.
  var sec = s % 60;
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function addonBases() {
  var cfg = window.FIREIO_CONFIG || {};
  var list = cfg.useBackup ? cfg.backupStreamAddonUrls : cfg.streamAddonUrls;
  return (list || []).map(function (u) {
    return u.replace(/\/manifest\.json$/, '').replace(/\/$/, '');
  });
}

function hostOf(url) {
  var m = /^https?:\/\/([^/]+)/.exec(url);
  return m ? m[1] : '?';
}

// Same idea as the Fire TV app's resolveStream: follow the addon's redirect
// to the real file and check what its first bytes are.
async function probe(url) {
  var r = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
  var b = new Uint8Array(await r.arrayBuffer());
  var kind = b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 ? 'MKV'
    : String.fromCharCode(b[4], b[5], b[6], b[7]) === 'ftyp' ? 'MP4' : 'other';
  return { finalUrl: r.url || url, kind: kind, status: r.status };
}

async function findStream() {
  var bases = addonBases();
  if (bases.length === 0) throw new Error('No addons in config.local.js');
  var all = [];
  for (var i = 0; i < bases.length; i++) {
    try {
      var r = await fetch(bases[i] + '/stream/' + TITLE.type + '/' + TITLE.id + '.json');
      var streams = ((await r.json()).streams || []).filter(function (s) { return s.url; });
      log('addon @ ' + hostOf(bases[i]) + ': ' + streams.length + ' streams');
      all = all.concat(streams);
    } catch (e) {
      log('addon @ ' + hostOf(bases[i]) + ': failed (' + e.message + ')');
    }
  }
  var name = function (s) { return (s.behaviorHints && s.behaviorHints.filename) || (s.title || '').split('\n')[0]; };
  // English MKVs first: MKV is the case being tested, and a dubbed release
  // would muddy the audio-track check.
  var foreign = /\b(ger|german|deutsch|french|fran[cç]ais|ita|ital|spa|span|esp|lat|latino|rus|pol|tur|hindi|dual)\b/i;
  var mkvText = function (s) { return /mkv/i.test(name(s) + ' ' + (s.title || '') + ' ' + (s.name || '')); };
  var rank = function (s) { return (mkvText(s) ? 2 : 0) + (foreign.test(name(s) + ' ' + (s.title || '')) ? 0 : 1); };
  all.sort(function (a, b) { return rank(b) - rank(a); });
  for (var j = 0; j < Math.min(all.length, 8); j++) {
    try {
      var p = await probe(all[j].url);
      log('try: ' + name(all[j]).slice(0, 70) + ' -> ' + p.kind + ' (' + p.status + ')');
      if (p.kind !== 'other') return { name: name(all[j]), url: p.finalUrl, kind: p.kind };
    } catch (e) {
      log('try failed: ' + e.message);
    }
  }
  throw new Error('No playable stream found');
}

var audioTracks = [];
var audioIndex = 0;

function describeTracks() {
  var tracks = webapis.avplay.getTotalTrackInfo();
  audioTracks = [];
  for (var i = 0; i < tracks.length; i++) {
    var t = tracks[i];
    var extra = {};
    try { extra = JSON.parse(t.extra_info); } catch (e) { /* not JSON */ }
    log('track ' + t.index + ' ' + t.type + ' ' + (extra.language || '') + ' ' + (extra.fourCC || '') +
      (extra.channels ? ' ' + extra.channels + 'ch' : ''));
    if (t.type === 'AUDIO') audioTracks.push(t.index);
  }
}

function play(stream) {
  log('playing ' + stream.kind + ': ' + stream.name.slice(0, 80));
  var av = webapis.avplay;
  av.open(stream.url);
  av.setDisplayRect(0, 0, 1920, 1080);
  av.setListener({
    onbufferingstart: function () { statusEl.textContent = 'buffering'; },
    onbufferingcomplete: function () { statusEl.textContent = ''; },
    oncurrentplaytime: function (ms) { statusEl.textContent = fmt(ms) + ' / ' + fmt(av.getDuration()); },
    onstreamcompleted: function () { log('stream completed'); },
    onerror: function (e) { log('PLAYER ERROR: ' + e); },
    onevent: function (type, data) { log('event ' + type + ' ' + (data || '')); },
  });
  av.prepareAsync(function () {
    log('prepared, duration ' + fmt(av.getDuration()));
    try { describeTracks(); } catch (e) { log('tracks: ' + e.message); }
    av.play();
  }, function (e) {
    log('PREPARE FAILED: ' + e);
  });
}

function seek(deltaMs) {
  var av = webapis.avplay;
  var t0 = Date.now();
  var target = Math.max(0, av.getCurrentTime() + deltaMs);
  av.seekTo(target, function () {
    log('seek ' + (deltaMs > 0 ? '+' : '') + deltaMs / 1000 + 's -> ' + fmt(av.getCurrentTime()) +
      ' in ' + (Date.now() - t0) + 'ms');
  }, function (e) {
    log('SEEK FAILED: ' + e);
  });
}

function nextAudio(step) {
  if (audioTracks.length < 2) return log('only one audio track');
  audioIndex = (audioIndex + step + audioTracks.length) % audioTracks.length;
  try {
    webapis.avplay.setSelectTrack('AUDIO', audioTracks[audioIndex]);
    log('audio -> track ' + audioTracks[audioIndex]);
  } catch (e) {
    log('AUDIO SWITCH FAILED: ' + e.message);
  }
}

['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind'].forEach(function (k) {
  try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* not on this remote */ }
});

document.addEventListener('keydown', function (e) {
  var av = webapis.avplay;
  switch (e.keyCode) {
    case 37: case 412: seek(-SEEK_MS); break; // Left, Rewind
    case 39: case 417: seek(SEEK_MS); break; // Right, FastForward
    case 38: nextAudio(1); break; // Up
    case 40: nextAudio(-1); break; // Down
    case 13: case 10252: case 415: case 19: // OK, PlayPause, Play, Pause
      if (av.getState() === 'PLAYING') av.pause(); else av.play();
      break;
    case 10009: // Back
      try { av.stop(); av.close(); } catch (err) { /* already closed */ }
      tizen.application.getCurrentApplication().exit();
      break;
  }
});

log('FireIO Tizen test: ' + TITLE.name);
try {
  log('AVPlay ' + webapis.avplay.getVersion());
} catch (e) {
  // Informational only — never let it stop the test.
}
findStream().then(play).catch(function (e) { log('FAILED: ' + e.message); });
