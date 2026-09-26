/**
 * Attic edge-bounce + salad-zoom shrink helpers (pure, testable).
 * Normal play: edge touch → inward bounce/wobble + −1 score (clamp ≥ 0).
 * Salad closing: edge touch → center snap + shrink, no point loss.
 */
(function (root) {
  'use strict';

  var EDGE_PAD = 1.5;
  var NORMAL_BOUNCE_PX = 28;
  var SALAD_SHRINK_FACTOR = 0.72;
  var SALAD_SIZE_FLOOR = 0.35;
  var WOBBLE_SEC = 0.42;
  var EDGE_GRACE_SEC = 0.35;
  var SALAD_SHOUT_URL = 'sfx/dont-like-salad.wav';

  function playBounds(scene, saladClosing, saladInset, playerR, W, H) {
    playerR = playerR || 14;
    W = W || 640;
    H = H || 480;
    if (scene === 'belch') {
      var rim = (saladInset == null ? 34 : saladInset) + 4;
      if (saladClosing) {
        return {
          minX: playerR,
          maxX: W - playerR,
          minY: playerR,
          maxY: H - playerR,
          rim: rim
        };
      }
      return {
        minX: rim + playerR,
        maxX: W - rim - playerR,
        minY: rim + playerR,
        maxY: H - rim - playerR,
        rim: rim
      };
    }
    return {
      minX: playerR + 8,
      maxX: W - playerR - 8,
      minY: playerR + 28,
      maxY: H - playerR - 8,
      rim: 0
    };
  }

  function atPlayBounds(player, bounds, pad) {
    pad = pad == null ? EDGE_PAD : pad;
    if (!player || !bounds) return false;
    if (bounds.maxX < bounds.minX + 4 || bounds.maxY < bounds.minY + 4) return true;
    return (
      player.x <= bounds.minX + pad ||
      player.x >= bounds.maxX - pad ||
      player.y <= bounds.minY + pad ||
      player.y >= bounds.maxY - pad
    );
  }

  /** Salad rim counts as an edge during the zoom/crush phase. */
  function atSaladRim(player, saladInset, playerR, W, H, pad) {
    pad = pad == null ? EDGE_PAD : pad;
    var rim = (saladInset == null ? 34 : saladInset) + 4;
    playerR = playerR || 14;
    W = W || 640;
    H = H || 480;
    var left = rim + playerR;
    var right = W - rim - playerR;
    var top = rim + playerR;
    var bot = H - rim - playerR;
    if (left >= right - 2 || top >= bot - 2) return true;
    return (
      player.x <= left + pad ||
      player.x >= right - pad ||
      player.y <= top + pad ||
      player.y >= bot - pad
    );
  }

  function isEdgeContact(input) {
    var scene = input.scene || 'attic';
    var saladClosing = !!input.saladClosing;
    var pr = input.playerR == null ? 14 : input.playerR;
    var bounds = playBounds(scene, saladClosing, input.saladInset, pr, input.W, input.H);
    if (atPlayBounds(input.player, bounds)) return true;
    if (scene === 'belch' && saladClosing) {
      return atSaladRim(input.player, input.saladInset, pr, input.W, input.H);
    }
    return false;
  }

  /**
   * One edge-touch resolution.
   * @param {object} input
   * @returns {{ score, size, player, bounceT, bounced, lostPoint, shrunk, message, recenterDrag }}
   */
  function applyEdgeTouch(input) {
    var score = Math.max(0, Math.floor(Number(input.score) || 0));
    var size = input.size == null ? 1 : Number(input.size);
    if (!(size > 0)) size = 1;
    var saladClosing = !!input.saladClosing;
    var W = input.W || 640;
    var H = input.H || 480;
    var player = {
      x: input.player && input.player.x != null ? Number(input.player.x) : W / 2,
      y: input.player && input.player.y != null ? Number(input.player.y) : H / 2
    };
    var out = {
      score: score,
      size: size,
      player: player,
      bounceT: WOBBLE_SEC,
      bounced: true,
      lostPoint: false,
      shrunk: false,
      message: null,
      recenterDrag: true
    };

    if (saladClosing) {
      player.x = W / 2;
      player.y = H / 2;
      var next = Math.max(SALAD_SIZE_FLOOR, size * SALAD_SHRINK_FACTOR);
      out.shrunk = next < size - 0.0001;
      out.size = next;
      out.message = 'SALAD SQUISH!';
      return out;
    }

    var b = input.bounds || playBounds(input.scene || 'attic', false, input.saladInset, input.playerR, W, H);
    var bump = NORMAL_BOUNCE_PX;
    var pad = EDGE_PAD;
    if (player.x <= b.minX + pad) player.x = Math.min(b.maxX, b.minX + bump);
    else if (player.x >= b.maxX - pad) player.x = Math.max(b.minX, b.maxX - bump);
    if (player.y <= b.minY + pad) player.y = Math.min(b.maxY, b.minY + bump);
    else if (player.y >= b.maxY - pad) player.y = Math.max(b.minY, b.maxY - bump);

    if (score > 0) {
      score -= 1;
      out.lostPoint = true;
    }
    out.score = Math.max(0, score);
    out.message = 'BONK — EDGE (−1)';
    return out;
  }

  /** Salad shout must cut Belchertown / lesser SFX (priority mic). */
  function saladShoutSfxOpts() {
    return { priority: true };
  }

  function saladShoutUrl() {
    return SALAD_SHOUT_URL;
  }

  /**
   * Contract when the last Belchertown snack is eaten:
   * start salad closing + emit the shout once (skip the normal slurp).
   */
  function onLastBelchItemEaten(prev) {
    prev = prev || {};
    var already = !!prev.saladShouted;
    return {
      saladClosing: true,
      saladCloseT: 0,
      saladShouted: true,
      shouldPlaySaladShout: !already,
      skipSlurp: true,
      shoutUrl: SALAD_SHOUT_URL,
      shoutOpts: { priority: true }
    };
  }

  /**
   * Lesser SFX are blocked while voicePriority is set (unless incoming is priority).
   * Used to document/fix the mic policy salad relies on.
   */
  function sfxAllowed(voicePriority, incomingPriority) {
    if (voicePriority && !incomingPriority) return false;
    return true;
  }

  var Api = {
    EDGE_PAD: EDGE_PAD,
    NORMAL_BOUNCE_PX: NORMAL_BOUNCE_PX,
    SALAD_SHRINK_FACTOR: SALAD_SHRINK_FACTOR,
    SALAD_SIZE_FLOOR: SALAD_SIZE_FLOOR,
    WOBBLE_SEC: WOBBLE_SEC,
    EDGE_GRACE_SEC: EDGE_GRACE_SEC,
    playBounds: playBounds,
    atPlayBounds: atPlayBounds,
    atSaladRim: atSaladRim,
    isEdgeContact: isEdgeContact,
    applyEdgeTouch: applyEdgeTouch,
    saladShoutSfxOpts: saladShoutSfxOpts,
    saladShoutUrl: saladShoutUrl,
    onLastBelchItemEaten: onLastBelchItemEaten,
    sfxAllowed: sfxAllowed
  };

  root.AtticEdge = Api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
