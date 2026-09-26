/**
 * Integration: CGI check_afg.py against a temp App_Data password.
 * Exercises wrong/right password, cookie unlock, GET verify.
 * Run: node tests/afg-gate-integration.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CGI = path.join(ROOT, 'check_afg.py');
const SECRET = 'IntegrationSlurWord';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function runCgi({ method, body, cookie, cwd }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      REQUEST_METHOD: method,
      CONTENT_LENGTH: body ? String(Buffer.byteLength(body)) : '0',
      HTTP_COOKIE: cookie || ''
    };
    // Do not inject ROOT on PYTHONPATH — CGI must resolve afg_gate + App_Data
    // relative to the staged site (mirrors IIS layout).
    delete env.PYTHONPATH;
    delete env.AFG_PASSWORD;
    const script = path.join(cwd || ROOT, 'check_afg.py');
    const child = spawn('python3', [script], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { err = Buffer.concat([err, d]); });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, out: out.toString('utf8'), err: err.toString('utf8') });
    });
    if (body) child.stdin.write(body);
    child.stdin.end();
  });
}

function parseCgi(out) {
  const split = out.split(/\r?\n\r?\n/);
  const header = split[0] || '';
  const body = split.slice(1).join('\n\n');
  const statusM = header.match(/Status:\s*(\d+)/i);
  const setCookie = (header.match(/Set-Cookie:\s*([^\r\n]+)/i) || [])[1] || null;
  let json = null;
  try { json = JSON.parse(body || '{}'); } catch (e) { json = { _raw: body }; }
  return {
    status: statusM ? Number(statusM[1]) : 0,
    setCookie,
    json,
    header
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afg-gate-'));
  // Mirror IIS layout: site root has check_afg.py + App_Data/afg_password.txt
  // We run CGI with cwd=ROOT but password file must be found relative to script dir.
  // So write into ROOT/App_Data temporarily OR copy scripts — use env AFG_PASSWORD
  // for isolation so we never touch real App_Data secrets in tests.
  const prev = process.env.AFG_PASSWORD;
  process.env.AFG_PASSWORD = SECRET;

  // Also stage a file-based secret under tmp and run with a copied layout:
  const site = path.join(tmp, 'site');
  fs.mkdirSync(path.join(site, 'App_Data'), { recursive: true });
  fs.copyFileSync(CGI, path.join(site, 'check_afg.py'));
  fs.copyFileSync(path.join(ROOT, 'afg_gate.py'), path.join(site, 'afg_gate.py'));
  fs.writeFileSync(path.join(site, 'App_Data', 'afg_password.txt'), SECRET + '\n', 'utf8');
  delete process.env.AFG_PASSWORD; // prefer file

  // Wrong password
  let res = parseCgi((await runCgi({
    method: 'POST',
    body: JSON.stringify({ password: 'nope' }),
    cwd: site
  })).out);
  assert(res.status === 401, 'wrong -> 401, got ' + res.status);
  assert(res.json && res.json.unlocked === false, 'wrong unlocked false');
  assert(!res.setCookie, 'no cookie on fail');

  // Right password (case + whitespace)
  res = parseCgi((await runCgi({
    method: 'POST',
    body: JSON.stringify({ password: '  integrationslurword  ' }),
    cwd: site
  })).out);
  assert(res.status === 200, 'right -> 200, got ' + res.status + ' ' + JSON.stringify(res.json));
  assert(res.json && res.json.ok && res.json.unlocked, 'right unlocked');
  assert(res.setCookie && res.setCookie.includes('afg_unlock='), 'set-cookie');
  const cookieVal = res.setCookie.split(';')[0]; // afg_unlock=...

  // GET verify with cookie
  res = parseCgi((await runCgi({
    method: 'GET',
    cookie: cookieVal,
    cwd: site
  })).out);
  assert(res.status === 200 && res.json.unlocked === true, 'verify unlocked');

  // GET without cookie
  res = parseCgi((await runCgi({ method: 'GET', cwd: site })).out);
  assert(res.status === 200 && res.json.unlocked === false, 'verify locked');

  // Missing config
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(path.join(empty, 'App_Data'), { recursive: true });
  fs.copyFileSync(CGI, path.join(empty, 'check_afg.py'));
  fs.copyFileSync(path.join(ROOT, 'afg_gate.py'), path.join(empty, 'afg_gate.py'));
  res = parseCgi((await runCgi({
    method: 'POST',
    body: JSON.stringify({ password: 'x' }),
    cwd: empty
  })).out);
  assert(res.status === 503, 'unconfigured -> 503');

  if (prev === undefined) delete process.env.AFG_PASSWORD;
  else process.env.AFG_PASSWORD = prev;

  console.log('afg-gate-integration: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
