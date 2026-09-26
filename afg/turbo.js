/**
 * EVILGAME turbo / test-mode time scale.
 *
 * Enable (any one — first match wins for rate):
 *   ?turbo=1          → 200× (default rate)
 *   ?turbo=300        → 300×
 *   localStorage 'evilgame.turbo' = '1' | '200' | '300' …
 *   window.__EVILGAME_TURBO__ = true | number
 *   window.__TEST__ = true          → 200× (test harness)
 *
 * Disable: omit all of the above, or ?turbo=0 / localStorage '0' / __EVILGAME_TURBO__=0
 *
 * Re-enable later the same way — no rebuild needed; flag is resolved at page load
 * and via EvilTurbo.refresh().
 *
 * Usage in game loops: run EvilTurbo.steps(rate) fixed 1/60 updates per rAF
 * instead of one wall-clock dt (avoids physics blowing up at huge dt).
 */
(function (root) {
  'use strict';

  var DEFAULT_RATE = 200;
  var MAX_STEPS_PER_FRAME = 600;
  var STEP_DT = 1 / 60;
  var LS_KEY = 'evilgame.turbo';

  function parseRate(raw) {
    if (raw == null || raw === false || raw === '') return 0;
    if (raw === true) return DEFAULT_RATE;
    var n = Number(raw);
    if (!isFinite(n) || n <= 0) return 0;
    if (n === 1) return DEFAULT_RATE; // ?turbo=1 means "on" at default hundreds×
    return Math.min(Math.floor(n), 2000);
  }

  function fromQuery() {
    try {
      var q = new URLSearchParams((root.location && root.location.search) || '');
      if (!q.has('turbo')) return null;
      var v = q.get('turbo');
      if (v === '' || v == null) return DEFAULT_RATE;
      return parseRate(v);
    } catch (e0) {
      return null;
    }
  }

  function fromStorage() {
    try {
      if (typeof localStorage === 'undefined') return null;
      var v = localStorage.getItem(LS_KEY);
      if (v == null) return null;
      return parseRate(v);
    } catch (e1) {
      return null;
    }
  }

  function fromGlobals() {
    if (typeof root.__EVILGAME_TURBO__ !== 'undefined') {
      return parseRate(root.__EVILGAME_TURBO__);
    }
    if (root.__TEST__) return DEFAULT_RATE;
    return null;
  }

  var cached = { on: false, rate: 1, source: 'off' };

  function resolve() {
    var rate = fromQuery();
    var source = 'query';
    if (rate == null) {
      rate = fromGlobals();
      source = 'global';
    }
    if (rate == null) {
      rate = fromStorage();
      source = 'localStorage';
    }
    if (rate == null || rate <= 1) {
      cached = { on: false, rate: 1, source: 'off' };
    } else {
      cached = { on: true, rate: rate, source: source };
    }
    return cached;
  }

  function refresh() {
    return resolve();
  }

  function get() {
    return cached;
  }

  function set(rateOrBool) {
    var r = parseRate(rateOrBool);
    try {
      if (typeof localStorage !== 'undefined') {
        if (r <= 1) localStorage.removeItem(LS_KEY);
        else localStorage.setItem(LS_KEY, String(r));
      }
    } catch (e2) {}
    root.__EVILGAME_TURBO__ = r > 1 ? r : 0;
    return resolve();
  }

  /** How many fixed 1/60 steps to run this frame. */
  function stepsPerFrame(overrideRate) {
    var r = overrideRate != null ? parseRate(overrideRate) : cached.rate;
    if (!cached.on && overrideRate == null) return 1;
    if (r <= 1) return 1;
    return Math.min(r, MAX_STEPS_PER_FRAME);
  }

  function stepDt() {
    return STEP_DT;
  }

  resolve();

  var api = {
    LS_KEY: LS_KEY,
    DEFAULT_RATE: DEFAULT_RATE,
    MAX_STEPS_PER_FRAME: MAX_STEPS_PER_FRAME,
    resolve: resolve,
    refresh: refresh,
    get: get,
    set: set,
    stepsPerFrame: stepsPerFrame,
    stepDt: stepDt,
    parseRate: parseRate,
    isOn: function () { return !!cached.on; },
    rate: function () { return cached.rate; }
  };

  root.EvilTurbo = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
