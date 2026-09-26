/**
 * AFG soft password-gate client helpers.
 * Server (check_afg.py) is the source of truth — never embed the password here.
 */
(function (root) {
  'use strict';

  var CGI = 'check_afg.py';
  var COOKIE_NAME = 'afg_unlock';

  function normalizePassword(raw) {
    if (raw == null) return '';
    return String(raw).replace(/^\s+|\s+$/g, '').toLowerCase();
  }

  function getCookie(name) {
    name = name || COOKIE_NAME;
    try {
      var parts = (document.cookie || '').split(';');
      var i, p, eq, k, v;
      for (i = 0; i < parts.length; i++) {
        p = parts[i].replace(/^\s+/, '');
        eq = p.indexOf('=');
        if (eq < 0) continue;
        k = p.slice(0, eq);
        v = p.slice(eq + 1);
        if (k === name) return decodeURIComponent(v);
      }
    } catch (e1) {}
    return null;
  }

  function fetchJson(url, opts) {
    opts = opts || {};
    return fetch(url, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    }).then(function (r) {
      return r.json().then(function (j) {
        return { status: r.status, body: j };
      }).catch(function () {
        return { status: r.status, body: { ok: false, error: 'bad json' } };
      });
    });
  }

  function checkUnlocked() {
    return fetchJson(CGI).then(function (res) {
      return !!(res.body && res.body.unlocked);
    }).catch(function () {
      return false;
    });
  }

  function submitPassword(password) {
    return fetchJson(CGI, {
      method: 'POST',
      body: { password: password }
    }).then(function (res) {
      return {
        ok: !!(res.body && res.body.ok && res.body.unlocked),
        status: res.status,
        error: (res.body && res.body.error) || null
      };
    });
  }

  /**
   * Build a mobile-friendly gate overlay. Caller appends to document.
   * opts: { title, onSuccess(href), targetHref, raspberryUrl, successUrl }
   */
  function createOverlay(opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'afg-gate';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', opts.title || 'AFG password');
    el.innerHTML =
      '<div class="afg-gate-card">' +
        '<div class="afg-gate-title">' + (opts.title || 'AFG LOCK') + '</div>' +
        '<div class="afg-gate-sub">PASSWORD REQUIRED</div>' +
        '<form class="afg-gate-form" action="#" method="post">' +
          '<label class="afg-gate-label" for="afgGatePw">Enter password</label>' +
          '<input id="afgGatePw" class="afg-gate-input" type="password" ' +
            'name="password" autocomplete="off" autocorrect="off" ' +
            'autocapitalize="off" spellcheck="false" inputmode="text" ' +
            'enterkeyhint="go" autofocus maxlength="64" />' +
          '<button type="submit" class="afg-gate-go">GO</button>' +
        '</form>' +
        '<div class="afg-gate-msg" aria-live="polite"></div>' +
        '<button type="button" class="afg-gate-cancel">BACK</button>' +
      '</div>';

    var input = el.querySelector('#afgGatePw');
    var msg = el.querySelector('.afg-gate-msg');
    var form = el.querySelector('.afg-gate-form');
    var cancel = el.querySelector('.afg-gate-cancel');
    var busy = false;

    function play(url) {
      if (!url) return;
      try {
        var a = new Audio(url);
        a.play().catch(function () {});
      } catch (e1) {}
    }

    function setMsg(t) {
      msg.textContent = t || '';
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy) return;
      busy = true;
      setMsg('…');
      submitPassword(input.value).then(function (res) {
        busy = false;
        if (res.ok) {
          setMsg('UNLOCKED');
          play(opts.successUrl || 'sfx/stab_painting.wav');
          // Server play log (best-effort; never blocks unlock UX).
          try {
            if (root.AfgPlayLog && typeof root.AfgPlayLog.log === 'function') {
              var logUser = '';
              if (opts.playLogUser) logUser = String(opts.playLogUser);
              if (!logUser) {
                try {
                  var rawProf = localStorage.getItem('evilgame.attic.v1') ||
                    localStorage.getItem('evilgame.farm.v1');
                  if (rawProf) {
                    var po = JSON.parse(rawProf);
                    if (po && po.nick) logUser = String(po.nick);
                  }
                } catch (eNick) {}
              }
              root.AfgPlayLog.log({
                action: 'visit',
                user: logUser || 'afg'
              });
            }
          } catch (eLog) {}
          var href = opts.targetHref || 'attic.html';
          setTimeout(function () {
            if (typeof opts.onSuccess === 'function') opts.onSuccess(href);
            else window.location.href = href;
          }, 900);
        } else {
          setMsg('WRONG');
          play(opts.raspberryUrl || 'sfx/raspberry.wav');
          input.value = '';
          input.focus();
        }
      }).catch(function () {
        busy = false;
        setMsg('ERROR');
        play(opts.raspberryUrl || 'sfx/raspberry.wav');
      });
    });

    cancel.addEventListener('click', function () {
      if (typeof opts.onCancel === 'function') opts.onCancel();
      else el.remove();
    });

    // Focus after paint so mobile keyboards pop reliably.
    setTimeout(function () {
      try { input.focus(); input.click(); } catch (e1) {}
    }, 50);

    return el;
  }


  /**
   * Expire the AFG unlock cookie client-side (cookie is not HttpOnly).
   * Returns the assignment string (useful for tests).
   */
  function clearUnlockCookie() {
    var expire = COOKIE_NAME + '=; Path=/; Max-Age=0; SameSite=Lax';
    try {
      if (typeof document !== 'undefined') {
        document.cookie = expire;
        // Some browsers keep legacy host-only cookies; clear those too.
        document.cookie = COOKIE_NAME + '=; Max-Age=0; SameSite=Lax';
      }
    } catch (e1) {}
    return expire;
  }

  /**
   * Wipe AFG unlock + all evilgame.* local/session storage (profiles, highs, etc.).
   */
  function wipeUserData() {
    clearUnlockCookie();
    function wipeStore(store) {
      if (!store) return;
      var keys = [];
      var i, k;
      try {
        for (i = 0; i < store.length; i++) {
          k = store.key(i);
          if (k && k.indexOf('evilgame.') === 0) keys.push(k);
        }
        for (i = 0; i < keys.length; i++) store.removeItem(keys[i]);
      } catch (e2) {}
    }
    try { wipeStore(typeof localStorage !== 'undefined' ? localStorage : null); } catch (e3) {}
    try { wipeStore(typeof sessionStorage !== 'undefined' ? sessionStorage : null); } catch (e4) {}
    // Known keys even if prefix scan missed them
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('evilgame.attic.v1');
        localStorage.removeItem('evilgame.farm.v1');
      }
    } catch (e5) {}
  }

  var Gate = {
    CGI: CGI,
    COOKIE_NAME: COOKIE_NAME,
    normalizePassword: normalizePassword,
    getCookie: getCookie,
    clearUnlockCookie: clearUnlockCookie,
    wipeUserData: wipeUserData,
    checkUnlocked: checkUnlocked,
    submitPassword: submitPassword,
    createOverlay: createOverlay
  };

  root.AfgGate = Gate;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Gate;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
