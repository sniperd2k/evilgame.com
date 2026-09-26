/**
 * AFG (Attic Gaming) persistence framework.
 *
 * Game code talks only to AfgStore APIs. Swap the adapter later (e.g. Slack)
 * without rewriting attic/farm gameplay.
 *
 * Adapter contract:
 *   get(key) -> string|null
 *   set(key, value:string) -> void
 *   remove(key) -> void   (optional)
 *
 * Storage key (unchanged for attic so existing players keep nick/high):
 *   evilgame.<gameId>.v1
 */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var MAX_NICK = 18;
  var MAX_SCORE = 999999;

  function clampScore(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(MAX_SCORE, Math.floor(n));
  }

  function sanitizeNick(s, fallback) {
    if (typeof s !== 'string') return fallback;
    s = s.trim().replace(/\s+/g, ' ').slice(0, MAX_NICK);
    return s || fallback;
  }

  function isoNow() {
    try {
      return new Date().toISOString();
    } catch (e1) {
      return String(Date.now());
    }
  }

  function defaultProfileFactory() {
    return {
      nick: 'PLAYER',
      highScore: 0,
      lastScore: 0,
      playCount: 0,
      lastPlayedAt: null,
      niceSeen: false
    };
  }

  /**
   * Merge + sanitize a raw stored object into a full profile.
   * Extra game-specific flags (e.g. niceSeen) are preserved.
   */
  function normalizeProfile(raw, defaults) {
    var base = defaults || defaultProfileFactory();
    var out = {
      nick: base.nick,
      highScore: 0,
      lastScore: 0,
      playCount: 0,
      lastPlayedAt: null,
      niceSeen: !!base.niceSeen
    };
    var i;
    var keys;
    if (raw && typeof raw === 'object') {
      if (typeof raw.nick === 'string') {
        out.nick = sanitizeNick(raw.nick, out.nick);
      }
      if (typeof raw.highScore === 'number') {
        out.highScore = clampScore(raw.highScore);
      }
      if (typeof raw.lastScore === 'number') {
        out.lastScore = clampScore(raw.lastScore);
      }
      if (typeof raw.playCount === 'number' && isFinite(raw.playCount) && raw.playCount > 0) {
        out.playCount = Math.min(MAX_SCORE, Math.floor(raw.playCount));
      }
      if (typeof raw.lastPlayedAt === 'string' && raw.lastPlayedAt) {
        out.lastPlayedAt = raw.lastPlayedAt;
      }
      if (raw.niceSeen) out.niceSeen = true;
      // Preserve unknown fields for future game flags.
      keys = Object.keys(raw);
      for (i = 0; i < keys.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(out, keys[i])) {
          out[keys[i]] = raw[keys[i]];
        }
      }
    } else if (typeof base.nick === 'string') {
      out.nick = sanitizeNick(base.nick, out.nick);
      out.highScore = clampScore(base.highScore);
      out.lastScore = clampScore(base.lastScore);
      out.playCount = clampScore(base.playCount);
      out.lastPlayedAt = base.lastPlayedAt || null;
      out.niceSeen = !!base.niceSeen;
    }
    return out;
  }

  function LocalStorageAdapter(storage) {
    this._s = storage;
    if (!this._s && typeof localStorage !== 'undefined') {
      this._s = localStorage;
    }
  }
  LocalStorageAdapter.prototype.get = function (key) {
    if (!this._s) return null;
    try {
      return this._s.getItem(key);
    } catch (e1) {
      return null;
    }
  };
  LocalStorageAdapter.prototype.set = function (key, value) {
    if (!this._s) return;
    try {
      this._s.setItem(key, value);
    } catch (e1) {}
  };
  LocalStorageAdapter.prototype.remove = function (key) {
    if (!this._s) return;
    try {
      this._s.removeItem(key);
    } catch (e1) {}
  };
  LocalStorageAdapter.prototype.name = 'localStorage';

  /** In-memory adapter for tests and offline stubs. */
  function MemoryAdapter(seed) {
    this._m = seed && typeof seed === 'object' ? seed : {};
  }
  MemoryAdapter.prototype.get = function (key) {
    return Object.prototype.hasOwnProperty.call(this._m, key) ? this._m[key] : null;
  };
  MemoryAdapter.prototype.set = function (key, value) {
    this._m[key] = String(value);
  };
  MemoryAdapter.prototype.remove = function (key) {
    delete this._m[key];
  };
  MemoryAdapter.prototype.name = 'memory';

  /**
   * Slack-compatible stub. Same get/set contract as LocalStorageAdapter.
   * Later: back with Slack user_id keyed server storage (or Slack datastore /
   * app home metadata). Game code never changes — only the adapter passed to
   * AfgStore.create({ adapter: new AfgStore.SlackAdapter({ ... }) }).
   *
   * opts.userId  — Slack user id when known
   * opts.fetchProfile / opts.saveProfile — optional async hooks (sync façade
   *   still uses an in-memory cache until those land)
   */
  function SlackAdapter(opts) {
    this._opts = opts || {};
    this._cache = {};
    this._userId = this._opts.userId || null;
  }
  SlackAdapter.prototype.get = function (key) {
    if (Object.prototype.hasOwnProperty.call(this._cache, key)) {
      return this._cache[key];
    }
    return null;
  };
  SlackAdapter.prototype.set = function (key, value) {
    this._cache[key] = String(value);
    // Hook point for a future Slack backend write.
    if (typeof this._opts.saveProfile === 'function') {
      try {
        this._opts.saveProfile(key, value, this._userId);
      } catch (e1) {}
    }
  };
  SlackAdapter.prototype.remove = function (key) {
    delete this._cache[key];
  };
  SlackAdapter.prototype.name = 'slack';
  SlackAdapter.prototype.setUserId = function (userId) {
    this._userId = userId || null;
  };

  function AfgStore(options) {
    options = options || {};
    this.gameId = options.gameId || 'attic';
    this.key = options.key || ('evilgame.' + this.gameId + '.v' + SCHEMA_VERSION);
    this.adapter = options.adapter || new LocalStorageAdapter();
    this._defaultFactory = typeof options.defaultProfile === 'function'
      ? options.defaultProfile
      : defaultProfileFactory;
  }

  AfgStore.prototype._readRaw = function () {
    var raw = this.adapter.get(this.key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e1) {
      return null;
    }
  };

  AfgStore.prototype._write = function (profile) {
    var payload = {
      nick: profile.nick,
      highScore: clampScore(profile.highScore),
      lastScore: clampScore(profile.lastScore),
      playCount: clampScore(profile.playCount),
      lastPlayedAt: profile.lastPlayedAt || null,
      niceSeen: !!profile.niceSeen
    };
    var keys = Object.keys(profile);
    var i;
    for (i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(payload, keys[i])) {
        payload[keys[i]] = profile[keys[i]];
      }
    }
    try {
      this.adapter.set(this.key, JSON.stringify(payload));
    } catch (e1) {}
    return payload;
  };

  AfgStore.prototype.getProfile = function () {
    var defaults = this._defaultFactory();
    return normalizeProfile(this._readRaw(), defaults);
  };

  /**
   * Merge a partial profile and persist. Returns the full saved profile.
   * Renaming never clears scores — pass { nick: 'X' } only.
   */
  AfgStore.prototype.setProfile = function (patch) {
    var cur = this.getProfile();
    var next;
    var k;
    if (!patch || typeof patch !== 'object') {
      return this._write(cur), cur;
    }
    next = normalizeProfile(cur, this._defaultFactory());
    for (k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        next[k] = patch[k];
      }
    }
    next = normalizeProfile(next, this._defaultFactory());
    this._write(next);
    return next;
  };

  AfgStore.prototype.getHighScore = function () {
    return this.getProfile().highScore;
  };

  AfgStore.prototype.setHighScore = function (score) {
    var cur = this.getProfile();
    var n = clampScore(score);
    if (n > cur.highScore) {
      cur.highScore = n;
      this._write(cur);
    }
    return cur.highScore;
  };

  /**
   * End-of-run bookkeeping: lastScore, playCount++, lastPlayedAt, high if better.
   * Returns { profile, isNewHigh }.
   */
  AfgStore.prototype.recordScore = function (score) {
    var cur = this.getProfile();
    var n = clampScore(score);
    var isNewHigh = n > cur.highScore;
    cur.lastScore = n;
    cur.playCount = clampScore(cur.playCount + 1);
    cur.lastPlayedAt = isoNow();
    if (isNewHigh) cur.highScore = n;
    this._write(cur);
    return { profile: cur, isNewHigh: isNewHigh };
  };

  AfgStore.prototype.exportSnapshot = function () {
    var profile = this.getProfile();
    return {
      schemaVersion: SCHEMA_VERSION,
      gameId: this.gameId,
      key: this.key,
      adapter: this.adapter && this.adapter.name ? this.adapter.name : 'unknown',
      profile: profile,
      exportedAt: isoNow()
    };
  };

  AfgStore.create = function (options) {
    return new AfgStore(options);
  };

  AfgStore.SCHEMA_VERSION = SCHEMA_VERSION;
  AfgStore.LocalStorageAdapter = LocalStorageAdapter;
  AfgStore.MemoryAdapter = MemoryAdapter;
  AfgStore.SlackAdapter = SlackAdapter;
  AfgStore.normalizeProfile = normalizeProfile;
  AfgStore.clampScore = clampScore;
  AfgStore.sanitizeNick = sanitizeNick;

  root.AfgStore = AfgStore;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AfgStore;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
