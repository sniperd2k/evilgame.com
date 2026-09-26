/**
 * AFG play-log client — fire-and-forget POST to play_log.py.
 * Normalized actions: visit / session_start / session_end / score.
 * Never throws into game loops; treats all server strings as untrusted.
 * Leave detection: pagehide / visibilitychange / beforeunload (keepalive beacon).
 */
(function (root) {
  'use strict';

  var CGI = 'play_log.py';
  var ALLOWED = {
    visit: 1,
    session_start: 1,
    session_end: 1,
    score: 1
  };
  var ALLOWED_REASONS = {
    pagehide: 1,
    hidden: 1,
    beforeunload: 1,
    unbind: 1,
    reset_wipe: 1,
    leave: 1
  };

  /** Active session from bindSession (for score posts + wipe). */
  var _active = {
    gameSessionId: null,
    visitId: null,
    user: '',
    game: ''
  };

  function sanitizeUser(raw) {
    if (raw == null) return '';
    var s = String(raw).replace(/^\s+|\s+$/g, '');
    if (!s || s.length > 64) return '';
    if (!/^[\w .@+\-]+$/.test(s)) return '';
    return s;
  }

  function sanitizeGame(raw) {
    if (raw == null || raw === '') return '';
    var s = String(raw).replace(/^\s+|\s+$/g, '').toLowerCase();
    if (!s || s.length > 64) return '';
    if (!/^[\w.\-]+$/.test(s)) return '';
    return s;
  }

  function sanitizeAction(raw) {
    var s = String(raw || '').toLowerCase();
    return ALLOWED[s] ? s : '';
  }

  function sanitizeScore(raw) {
    if (raw == null || raw === '') return undefined;
    var n = Number(raw);
    if (!isFinite(n)) return null;
    n = Math.floor(n);
    if (n < 0 || n > 999999) return null;
    return n;
  }

  function sanitizeId(raw) {
    if (raw == null || raw === '') return null;
    var n = Number(raw);
    if (!isFinite(n) || n < 1) return null;
    return Math.floor(n);
  }

  function sanitizeReason(raw) {
    var s = String(raw || 'leave').toLowerCase().slice(0, 32);
    return ALLOWED_REASONS[s] ? s : '';
  }

  function post(body) {
    if (typeof fetch !== 'function') {
      return Promise.resolve({ ok: false, error: 'no fetch' });
    }
    return fetch(CGI, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      keepalive: true
    }).then(function (r) {
      return r.json().then(function (j) {
        var out = {
          ok: !!(r.ok && j && j.ok),
          status: r.status,
          error: (j && typeof j.error === 'string') ? j.error : null
        };
        if (j) {
          if (j.visit_id != null) out.visit_id = j.visit_id;
          if (j.game_session_id != null) out.game_session_id = j.game_session_id;
          if (j.score_id != null) out.score_id = j.score_id;
          if (j.user_id != null) out.user_id = j.user_id;
          if (j.updated != null) out.updated = j.updated;
        }
        return out;
      }).catch(function () {
        return { ok: false, status: r.status, error: 'bad json' };
      });
    }).catch(function () {
      return { ok: false, error: 'network' };
    });
  }

  /**
   * POST one action. Returns a Promise that always resolves
   * to { ok: boolean, ... } (never rejects).
   *
   * Preferred: { action: 'visit'|'session_start'|'session_end'|'score', ... }
   * Legacy aliases: event/type login→visit, session_start, session_end, score.
   */
  function log(opts) {
    opts = opts || {};
    var rawAction = opts.action || opts.event || opts.event_type || opts.type;
    // Map legacy login / game_played onto normalized actions.
    var legacy = String(rawAction || '').toLowerCase();
    if (legacy === 'login') rawAction = 'visit';
    if (legacy === 'game_played') rawAction = 'score';
    var action = sanitizeAction(rawAction);
    var user = sanitizeUser(opts.user || opts.user_id || opts.nick || opts.login);
    var game = sanitizeGame(opts.game || opts.game_name);
    if (!action) {
      return Promise.resolve({ ok: false, error: 'bad action' });
    }

    if (action === 'visit') {
      if (!user) return Promise.resolve({ ok: false, error: 'bad args' });
      return post({ action: 'visit', user: user }).then(function (r) {
        if (r.ok && r.visit_id != null) _active.visitId = r.visit_id;
        if (r.ok) _active.user = user;
        return r;
      });
    }

    if (action === 'session_start') {
      if (!user || !game) {
        return Promise.resolve({ ok: false, error: !user ? 'bad args' : 'need game' });
      }
      var startBody = { action: 'session_start', user: user, game: game };
      var vid = sanitizeId(opts.visit_id != null ? opts.visit_id : _active.visitId);
      if (vid != null) startBody.visit_id = vid;
      return post(startBody).then(function (r) {
        if (r.ok && r.game_session_id != null) {
          _active.gameSessionId = r.game_session_id;
          _active.user = user;
          _active.game = game;
        }
        return r;
      });
    }

    if (action === 'session_end') {
      var sid = sanitizeId(
        opts.game_session_id != null ? opts.game_session_id : _active.gameSessionId
      );
      if (sid == null) return Promise.resolve({ ok: false, error: 'need session' });
      var reason = sanitizeReason(opts.end_reason || opts.reason || 'leave');
      if (!reason) return Promise.resolve({ ok: false, error: 'bad reason' });
      var endBody = {
        action: 'session_end',
        game_session_id: sid,
        end_reason: reason
      };
      var endUser = user || _active.user;
      if (endUser) endBody.user = endUser;
      return post(endBody).then(function (r) {
        if (r.ok && _active.gameSessionId === sid) {
          _active.gameSessionId = null;
        }
        return r;
      });
    }

    if (action === 'score') {
      if (!user) return Promise.resolve({ ok: false, error: 'bad args' });
      if (!game) return Promise.resolve({ ok: false, error: 'need game' });
      var score = sanitizeScore(opts.score != null ? opts.score : opts.score_value);
      if (score === null || score === undefined) {
        return Promise.resolve({ ok: false, error: 'bad score' });
      }
      var scoreSid = sanitizeId(
        opts.game_session_id != null ? opts.game_session_id : _active.gameSessionId
      );
      if (scoreSid == null) return Promise.resolve({ ok: false, error: 'need session' });
      return post({
        action: 'score',
        user: user,
        game: game,
        score: score,
        game_session_id: scoreSid
      });
    }

    return Promise.resolve({ ok: false, error: 'bad action' });
  }

  function visit(opts) {
    opts = opts || {};
    opts.action = 'visit';
    return log(opts);
  }

  function startSession(opts) {
    opts = opts || {};
    opts.action = 'session_start';
    return log(opts);
  }

  function endSession(opts) {
    opts = opts || {};
    opts.action = 'session_end';
    return log(opts);
  }

  function score(opts) {
    opts = opts || {};
    opts.action = 'score';
    return log(opts);
  }

  function getActiveSession() {
    return {
      gameSessionId: _active.gameSessionId,
      visitId: _active.visitId,
      user: _active.user,
      game: _active.game
    };
  }

  /**
   * Page arrival: visit (upsert user) + session_start.
   * Leave: session_end on pagehide / visibility hidden / beforeunload.
   * opts: { user, game, getUser?, visitFirst? }
   */
  function bindSession(opts) {
    opts = opts || {};
    var game = sanitizeGame(opts.game);
    if (!game) return function () {};
    var ended = false;
    var started = false;

    function userNow() {
      if (typeof opts.getUser === 'function') {
        try { return sanitizeUser(opts.getUser()); } catch (e1) { return ''; }
      }
      return sanitizeUser(opts.user);
    }

    function start() {
      if (started) return;
      var u = userNow();
      if (!u) return;
      started = true;
      var doStart = function (visitId) {
        var payload = { action: 'session_start', user: u, game: game };
        if (visitId != null) payload.visit_id = visitId;
        return log(payload);
      };
      if (opts.visitFirst === false) {
        doStart(_active.visitId);
        return;
      }
      log({ action: 'visit', user: u }).then(function (vr) {
        doStart(vr && vr.visit_id != null ? vr.visit_id : _active.visitId);
      });
    }

    function end(reason) {
      if (ended) return;
      ended = true;
      var sid = _active.gameSessionId;
      var u = userNow() || _active.user;
      if (sid == null) return;
      log({
        action: 'session_end',
        user: u,
        game_session_id: sid,
        end_reason: reason || 'leave'
      });
    }

    // Defer start slightly so profile/nick may be ready after game init.
    try {
      if (typeof setTimeout === 'function') {
        setTimeout(start, 0);
      } else {
        start();
      }
    } catch (eStart) {
      start();
    }

    function onHide() {
      try {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          end('hidden');
        }
      } catch (e3) {}
    }
    function onPageHide() { end('pagehide'); }
    function onBeforeUnload() { end('beforeunload'); }
    try {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onHide);
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('beforeunload', onBeforeUnload);
      }
    } catch (e4) {}

    return function unbind() {
      try {
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onHide);
        }
        if (typeof window !== 'undefined') {
          window.removeEventListener('pagehide', onPageHide);
          window.removeEventListener('beforeunload', onBeforeUnload);
        }
      } catch (e5) {}
      end('unbind');
    };
  }

  var Api = {
    CGI: CGI,
    ALLOWED_ACTIONS: Object.keys(ALLOWED),
    sanitizeUser: sanitizeUser,
    sanitizeGame: sanitizeGame,
    sanitizeAction: sanitizeAction,
    sanitizeScore: sanitizeScore,
    sanitizeReason: sanitizeReason,
    log: log,
    visit: visit,
    startSession: startSession,
    endSession: endSession,
    score: score,
    bindSession: bindSession,
    getActiveSession: getActiveSession
  };

  root.AfgPlayLog = Api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
