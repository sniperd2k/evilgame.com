/**
 * EVILGAME event-driven audio manager.
 *
 * Decouples SFX from the game loop:
 *   - Games fire cues: audio.fire('meow') / audio.fire('salad') / audio.play(url, vol, opts)
 *   - Manager owns pooling, mic priority, unlock, and turbo mute/skip
 *   - Game-time tick(dt) advances mic TTL so turbo sim can race ahead without softlock;
 *     HTMLAudio still plays at wall-clock (or is muted/skipped under turbo)
 *
 * Does not POST / log — leave attic/farm free to add play_log hooks beside fire() calls.
 *
 * Usage:
 *   var audio = EvilAudio.create({
 *     urls: ['sfx/meow1.wav', ...],
 *     priorityTtl: 5,
 *     turboPriorityTtl: 2.5,
 *     turboSkipCrowRefresh: true  // farm: skip priority re-fire while mic locked
 *   });
 *   audio.register('meow', { pick: ['sfx/meow1.wav',...], vol: 0.9, overlap: true });
 *   audio.register('crow', { url: 'sfx/cockadoodle.wav', priority: true, turboSkipIfBusy: true });
 *   // in game loop: audio.fire('meow');  audio.tick(dt);
 */
(function (root) {
  'use strict';

  function nowMs() {
    try {
      if (typeof performance !== 'undefined' && performance.now) return performance.now();
    } catch (e0) {}
    return Date.now();
  }

  function turboOn() {
    try {
      return !!(root.EvilTurbo && typeof EvilTurbo.isOn === 'function' && EvilTurbo.isOn());
    } catch (e1) {
      return false;
    }
  }

  function create(opts) {
    opts = opts || {};
    var urls = (opts.urls || []).slice();
    var priorityTtl = opts.priorityTtl != null ? Number(opts.priorityTtl) : 6.0;
    var turboPriorityTtl = opts.turboPriorityTtl != null ? Number(opts.turboPriorityTtl) : 2.8;
    var name = opts.name || 'sfx';

    var audioCtx = null;
    var audioUnlocked = false;
    var sfxEls = {};
    var currentSfx = null;
    var voicePriority = false;
    var voicePriorityLeft = 0;
    var lastSfx = { url: null, priority: false, at: 0 };
    var cues = Object.create(null);
    var listeners = Object.create(null);
    var eventLog = []; // recent fires (debug / tests); capped
    var EVENT_LOG_MAX = 32;

    function ensureAudio() {
      try {
        var AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return null;
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === 'suspended') {
          try { audioCtx.resume(); } catch (e1) {}
        }
        return audioCtx;
      } catch (err) {
        return null;
      }
    }

    function hasHtmlAudio() {
      return typeof root.Audio === 'function' || typeof Audio === 'function';
    }

    function makeAudio() {
      if (typeof root.Audio === 'function') return new root.Audio();
      if (typeof Audio === 'function') return new Audio();
      return null;
    }

    function getSfxEl(url) {
      if (!sfxEls[url]) {
        var a = makeAudio();
        if (!a) {
          // Node / headless unit tests — stub element; schedulePlay still records lastSfx.
          sfxEls[url] = {
            preload: 'auto', src: url, muted: false, volume: 1, paused: true, currentTime: 0,
            play: function () { return Promise.resolve(); },
            pause: function () {},
            load: function () {},
            cloneNode: function () { return getSfxEl(url); },
            setAttribute: function () {},
            onended: null
          };
          return sfxEls[url];
        }
        a.preload = 'auto';
        a.src = url;
        try { a.setAttribute('playsinline', ''); a.playsInline = true; } catch (e1) {}
        try { a.load(); } catch (e2) {}
        sfxEls[url] = a;
      }
      return sfxEls[url];
    }

    function preload(list) {
      var arr = list || urls;
      var i;
      for (i = 0; i < arr.length; i++) {
        if (arr[i]) getSfxEl(arr[i]);
      }
    }

    function unlock() {
      var ctx = ensureAudio();
      if (ctx) {
        try {
          var o = ctx.createOscillator();
          var g = ctx.createGain();
          g.gain.value = 0.0001;
          o.connect(g);
          g.connect(ctx.destination);
          o.start(0);
          o.stop(ctx.currentTime + 0.04);
        } catch (e1) {}
        try { ctx.resume(); } catch (e2) {}
      }
      var i, a, p;
      var list = urls.length ? urls : Object.keys(sfxEls);
      for (i = 0; i < list.length; i++) {
        a = getSfxEl(list[i]);
        try {
          a.muted = true;
          a.volume = 0;
          p = a.play();
          if (p && typeof p.then === 'function') {
            p.then(function (el) {
              return function () {
                try { el.pause(); el.currentTime = 0; } catch (e3) {}
                el.muted = false;
                el.volume = 1;
              };
            }(a)).catch(function (el) {
              return function () { el.muted = false; el.volume = 1; };
            }(a));
          } else {
            try { a.pause(); a.currentTime = 0; } catch (e4) {}
            a.muted = false;
            a.volume = 1;
          }
        } catch (e5) {
          a.muted = false;
          a.volume = 1;
        }
      }
      audioUnlocked = true;
    }

    function stopCurrent() {
      if (!currentSfx) return;
      try { currentSfx.pause(); } catch (e1) {}
      try { currentSfx.currentTime = 0; } catch (e2) {}
      currentSfx = null;
    }

    function clearPriority() {
      voicePriority = false;
      voicePriorityLeft = 0;
    }

    /** Advance game-time mic lock (call from sim update, not wall clock). */
    function tick(dt) {
      if (!voicePriority) return;
      if (voicePriorityLeft > 0) {
        voicePriorityLeft -= dt || 0;
        if (voicePriorityLeft <= 0) clearPriority();
      }
    }

    function emitLocal(type, detail) {
      var arr = listeners[type];
      if (!arr || !arr.length) return;
      var i, copy = arr.slice();
      for (i = 0; i < copy.length; i++) {
        try { copy[i](detail); } catch (eL) {}
      }
    }

    function on(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
      return function off() {
        var arr = listeners[type];
        if (!arr) return;
        var i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    }

    function pushLog(entry) {
      eventLog.push(entry);
      if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
    }

    /**
     * Core scheduler: apply mic rules + turbo mute/skip, then play.
     * Returns { played, skipped, reason } for tests.
     */
    function schedulePlay(url, vol, playOpts) {
      playOpts = playOpts || {};
      var priority = !!playOpts.priority;
      var overlap = !!playOpts.overlap;
      var result = { played: false, skipped: false, reason: null, url: url, priority: priority };

      if (!url) {
        result.skipped = true;
        result.reason = 'no-url';
        return result;
      }

      try {
        if (!audioUnlocked) unlock();

        // Mic policy: lesser SFX ignored while priority owns the mic.
        if (voicePriority && !priority) {
          result.skipped = true;
          result.reason = 'mic-blocked';
          emitLocal('skip', result);
          return result;
        }

        // Farm turbo: crow spam must not refresh TTL / Audio indefinitely.
        if (priority && playOpts.turboSkipIfBusy && turboOn() && voicePriority) {
          result.skipped = true;
          result.reason = 'turbo-busy';
          emitLocal('skip', result);
          return result;
        }

        lastSfx.url = url;
        lastSfx.priority = priority;
        lastSfx.at = nowMs();

        if (priority || !overlap) stopCurrent();

        try { if (root.speechSynthesis) root.speechSynthesis.cancel(); } catch (e0) {}

        if (priority) {
          var ttl = turboOn() ? turboPriorityTtl : priorityTtl;
          if (turboOn() && playOpts.turboHoldTtl) {
            // Under turbo, do not refresh an active lock (crow) — only arm if idle.
            if (!voicePriority || voicePriorityLeft <= 0) voicePriorityLeft = ttl;
          } else {
            voicePriorityLeft = ttl;
          }
          voicePriority = true;
        } else if (!overlap) {
          // Attic: non-priority clears any leftover priority flag when it actually plays.
          // (Only reached when mic was free.)
          voicePriority = false;
          voicePriorityLeft = 0;
        }

        var a = getSfxEl(url);
        var isTurbo = turboOn();

        // Overlap clones (meows) — skip under turbo to avoid Audio storms.
        if (overlap && !isTurbo && !a.paused && a.currentTime > 0) {
          try {
            var clone = a.cloneNode();
            clone.volume = vol == null ? 0.85 : vol;
            clone.play().catch(function () {});
            result.played = true;
            result.reason = 'overlap-clone';
            emitLocal('play', result);
            return result;
          } catch (eClone) {}
        }

        // Turbo: mute non-priority (logic races; audio optional / silent).
        var mute = isTurbo && !priority;
        a.muted = !!mute;
        a.volume = mute ? 0 : (vol == null ? 1 : vol);
        try { a.currentTime = 0; } catch (e1) {}
        a.onended = function () {
          if (currentSfx === a) currentSfx = null;
          if (priority) clearPriority();
          emitLocal('ended', { url: url, priority: priority });
        };
        if (!overlap) currentSfx = a;
        var p = a.play();
        if (p && typeof p.catch === 'function') {
          p.catch(function () {
            if (currentSfx === a) currentSfx = null;
            if (priority) clearPriority();
          });
        }
        result.played = true;
        result.reason = mute ? 'muted-turbo' : 'play';
        emitLocal('play', result);
        return result;
      } catch (err) {
        if (priority) clearPriority();
        result.skipped = true;
        result.reason = 'error';
        return result;
      }
    }

    /** Direct play (same contract as legacy playHtmlSfx). */
    function play(url, vol, playOpts) {
      return schedulePlay(url, vol, playOpts || {});
    }

    /**
     * Register a named cue. Spec:
     *   { url, vol, priority, overlap, turboSkipIfBusy, turboHoldTtl, pick: [urls] }
     *   or a function (api) => schedule result / void
     */
    function register(cueName, spec) {
      cues[cueName] = spec;
      if (spec && spec.url && urls.indexOf(spec.url) < 0) urls.push(spec.url);
      if (spec && spec.pick) {
        var i;
        for (i = 0; i < spec.pick.length; i++) {
          if (spec.pick[i] && urls.indexOf(spec.pick[i]) < 0) urls.push(spec.pick[i]);
        }
      }
      return api;
    }

    /** Fire a named cue or raw event. Game loop should call this — not touch Audio. */
    function fire(cueName, extra) {
      extra = extra || {};
      var entry = { cue: cueName, at: nowMs(), name: name };
      pushLog(entry);
      emitLocal('fire', entry);

      var spec = cues[cueName];
      if (typeof spec === 'function') {
        var out = spec(api, extra);
        entry.result = out;
        return out;
      }
      if (!spec) {
        // Allow fire('custom', { url, vol, priority, overlap })
        if (extra.url) {
          entry.result = schedulePlay(extra.url, extra.vol, extra);
          return entry.result;
        }
        entry.result = { played: false, skipped: true, reason: 'unknown-cue' };
        emitLocal('skip', entry.result);
        return entry.result;
      }

      var url = spec.url;
      if (spec.pick && spec.pick.length) {
        url = spec.pick[Math.floor(Math.random() * spec.pick.length)];
      }
      if (extra.url) url = extra.url;

      var playOpts = {
        priority: !!(extra.priority != null ? extra.priority : spec.priority),
        overlap: !!(extra.overlap != null ? extra.overlap : spec.overlap),
        turboSkipIfBusy: !!(extra.turboSkipIfBusy != null ? extra.turboSkipIfBusy : spec.turboSkipIfBusy),
        turboHoldTtl: !!(extra.turboHoldTtl != null ? extra.turboHoldTtl : spec.turboHoldTtl)
      };
      var vol = extra.vol != null ? extra.vol : spec.vol;
      entry.result = schedulePlay(url, vol, playOpts);
      return entry.result;
    }

    /**
     * Play a URL until ended (or fallback ms), then callback.
     * Used by index reset gay SFX — wall-clock, not game-time.
     */
    function playUntilEnd(url, onEnded, fallbackMs) {
      var done = false;
      var timer = null;
      function finish() {
        if (done) return;
        done = true;
        if (timer != null) {
          try { clearTimeout(timer); } catch (eC) {}
          timer = null;
        }
        if (typeof onEnded === 'function') onEnded();
      }
      function armFallback(ms) {
        if (done) return;
        if (timer != null) {
          try { clearTimeout(timer); } catch (eC2) {}
        }
        timer = setTimeout(finish, ms);
      }
      try {
        if (!audioUnlocked) unlock();
        var a = new Audio(url);
        a.preload = 'auto';
        a.addEventListener('ended', finish);
        a.addEventListener('error', function () { armFallback(400); });
        a.addEventListener('loadedmetadata', function () {
          var d = a.duration;
          var ms = (isFinite(d) && d > 0) ? Math.ceil(d * 1000) + 250 : (fallbackMs || 1200);
          armFallback(ms);
        });
        lastSfx.url = url;
        lastSfx.priority = true;
        lastSfx.at = nowMs();
        var p = a.play();
        if (p && typeof p.catch === 'function') {
          p.catch(function () { armFallback(400); });
        }
        armFallback(fallbackMs || 2000);
        emitLocal('play', { url: url, priority: true, reason: 'until-end' });
      } catch (e0) {
        armFallback(400);
      }
    }

    /**
     * Procedural boom (Duke/Doom-ish) via Web Audio oscillators.
     * Optional shared AudioContext via opts.ctx or ensureAudio().
     */
    function playBoom(boomOpts) {
      boomOpts = boomOpts || {};
      try {
        var ac = boomOpts.ctx || ensureAudio();
        if (!ac) return { played: false, skipped: true, reason: 'no-ctx' };
        if (ac.state === 'suspended') {
          try { ac.resume(); } catch (eR) {}
        }
        var t0 = ac.currentTime;
        function boomTone(freq, start, dur, type, vol) {
          var o = ac.createOscillator();
          var g = ac.createGain();
          o.type = type || 'square';
          o.frequency.setValueAtTime(freq, t0 + start);
          o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.2), t0 + start + dur);
          g.gain.setValueAtTime(vol || 0.08, t0 + start);
          g.gain.exponentialRampToValueAtTime(0.001, t0 + start + dur);
          o.connect(g);
          g.connect(ac.destination);
          o.start(t0 + start);
          o.stop(t0 + start + dur + 0.02);
        }
        boomTone(120, 0, 0.35, 'sawtooth', 0.1);
        boomTone(55, 0.02, 0.45, 'square', 0.08);
        boomTone(400, 0, 0.12, 'square', 0.05);
        lastSfx.url = boomOpts.label || 'boom';
        lastSfx.priority = true;
        lastSfx.at = nowMs();
        emitLocal('play', { url: lastSfx.url, priority: true, reason: 'boom' });
        return { played: true, skipped: false, reason: 'boom' };
      } catch (eB) {
        return { played: false, skipped: true, reason: 'error' };
      }
    }

    function addUrls(list) {
      var i;
      for (i = 0; i < list.length; i++) {
        if (list[i] && urls.indexOf(list[i]) < 0) urls.push(list[i]);
      }
    }

    var api = {
      name: name,
      create: create,
      register: register,
      fire: fire,
      play: play,
      playUntilEnd: playUntilEnd,
      playBoom: playBoom,
      tick: tick,
      unlock: unlock,
      preload: preload,
      addUrls: addUrls,
      clearPriority: clearPriority,
      stopCurrent: stopCurrent,
      on: on,
      ensureAudio: ensureAudio,
      getSfxEl: getSfxEl,
      getLastSfx: function () {
        return { url: lastSfx.url, priority: lastSfx.priority, at: lastSfx.at };
      },
      hasVoicePriority: function () { return !!voicePriority; },
      getVoicePriorityLeft: function () { return voicePriorityLeft; },
      isUnlocked: function () { return !!audioUnlocked; },
      getEventLog: function () { return eventLog.slice(); },
      // Compatibility aliases used by existing game hooks
      unlockAudio: function () { unlock(); },
      tickVoicePriority: tick,
      clearVoicePriority: clearPriority,
      playHtmlSfx: play
    };

    if (urls.length) preload(urls);
    return api;
  }

  var api = {
    create: create,
    turboOn: turboOn
  };

  root.EvilAudio = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
