/**
 * Unit tests for afg/play_log.js sanitizers + normalized action posts.
 * Run: node tests/play-log-client.test.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AfgPlayLog = require(path.join(__dirname, '..', 'afg', 'play_log.js'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(AfgPlayLog.CGI === 'play_log.py', 'cgi');
assert(AfgPlayLog.sanitizeUser('SoggyGoblin42') === 'SoggyGoblin42', 'user');
assert(AfgPlayLog.sanitizeUser("x'; DROP--") === '', 'user reject');
assert(AfgPlayLog.sanitizeUser('a'.repeat(65)) === '', 'user len');
assert(AfgPlayLog.sanitizeGame('Attic') === 'attic', 'game');
assert(AfgPlayLog.sanitizeGame('bad!') === '', 'game bad');
assert(AfgPlayLog.sanitizeAction('VISIT') === 'visit', 'action');
assert(AfgPlayLog.sanitizeAction('login') === '', 'login not action');
assert(AfgPlayLog.sanitizeAction('nope') === '', 'action bad');
assert(AfgPlayLog.sanitizeScore(12) === 12, 'score');
assert(AfgPlayLog.sanitizeScore(-1) === null, 'score neg');
assert(AfgPlayLog.sanitizeScore(undefined) === undefined, 'score omit');
assert(AfgPlayLog.sanitizeReason('pagehide') === 'pagehide', 'reason');
assert(AfgPlayLog.sanitizeReason('DROP') === '', 'reason bad');

const calls = [];
globalThis.fetch = function (url, opts) {
  calls.push({ url, opts });
  const body = JSON.parse(opts.body);
  let j = { ok: true };
  if (body.action === 'visit') j = { ok: true, visit_id: 7, user_id: body.user };
  else if (body.action === 'session_start') j = { ok: true, game_session_id: 3 };
  else if (body.action === 'score') j = { ok: true, score_id: 9 };
  else if (body.action === 'session_end') j = { ok: true, updated: true, game_session_id: body.game_session_id };
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(j); }
  });
};

calls.length = 0;
const vr = await AfgPlayLog.visit({ user: 'Nick1' });
assert(vr.ok === true && vr.visit_id === 7, 'visit ok');
assert(calls.length === 1, 'one fetch visit');
assert(calls[0].opts.method === 'POST', 'method');
assert(calls[0].opts.keepalive === true, 'keepalive');
assert(calls[0].opts.headers['Content-Type'] === 'application/json', 'ctype');
const vbody = JSON.parse(calls[0].opts.body);
assert(vbody.action === 'visit' && vbody.user === 'Nick1', 'visit body');
assert(vbody.ip_address == null, 'no client ip');

calls.length = 0;
const sr = await AfgPlayLog.startSession({ user: 'Nick1', game: 'attic', visit_id: 7 });
assert(sr.ok && sr.game_session_id === 3, 'session start');
const sbody = JSON.parse(calls[0].opts.body);
assert(sbody.action === 'session_start' && sbody.visit_id === 7, 'session body');

calls.length = 0;
const scr = await AfgPlayLog.score({ user: 'Nick1', game: 'attic', score: 42 });
assert(scr.ok && scr.score_id === 9, 'score uses active session');
const scbody = JSON.parse(calls[0].opts.body);
assert(scbody.game_session_id === 3 && scbody.score === 42, 'score body');

calls.length = 0;
const er = await AfgPlayLog.endSession({ end_reason: 'pagehide' });
assert(er.ok === true, 'end session');
const ebody = JSON.parse(calls[0].opts.body);
assert(ebody.action === 'session_end' && ebody.end_reason === 'pagehide', 'end body');
assert(ebody.game_session_id === 3, 'end sid');

// Legacy login maps to visit
calls.length = 0;
const lr = await AfgPlayLog.log({ event: 'login', user: 'Nick2' });
assert(lr.ok === true, 'legacy login→visit');
assert(JSON.parse(calls[0].opts.body).action === 'visit', 'mapped visit');

const bad = await AfgPlayLog.score({ user: 'Nick1', game: 'attic', score: 1, game_session_id: null });
// After endSession, active sid cleared — need session unless passed
const need = await AfgPlayLog.log({ action: 'score', user: 'Nick1', game: 'attic', score: 1 });
assert(need.ok === false && need.error === 'need session', 'need session');

const inj = await AfgPlayLog.visit({ user: "admin'--" });
assert(inj.ok === false, 'reject inj user');

const noGame = await AfgPlayLog.startSession({ user: 'Nick1' });
assert(noGame.ok === false && noGame.error === 'need game', 'need game');

console.log('play-log-client: ok');
