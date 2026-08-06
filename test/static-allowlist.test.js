'use strict';

// What the unauthenticated control port may serve off disk.
//
// The static root defaulted to the process working directory, which systemd sets to
// /opt/picar — the whole repository. Measured against rover3 over plain unauthenticated
// HTTPS before this change:
//
//   GET /certs/ca.key          200  -----BEGIN PRIVATE KEY-----
//   GET /certs/key.pem         200  -----BEGIN PRIVATE KEY-----
//   GET /picar-cfg.local.json  200  {"rover_id": 3, ...}
//   GET /.git/config           200
//   GET /mediamtx.yml          200
//
// certs/ca.key is the CA private key README.md tells every operator device to trust, so
// that GET is a fleet-wide MITM key. Found by an adversarial review of an unrelated branch
// that happened to touch the same construction.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const { isServable } = require('../static-allowlist');

// ── The secrets, named individually so a regression says which one leaked ────

test('the TLS private keys are not servable', () => {
  for (const p of ['/certs/ca.key', '/certs/key.pem', '/certs/ca.crt', '/certs/cert.pem']) {
    assert.equal(isServable(p), false, `${p} must never be served`);
  }
});

test('the config, the overlay, the git history and the tlogs are not servable', () => {
  for (const p of ['/picar-cfg.json', '/picar-cfg.local.json', '/mediamtx.yml',
                   '/.git/config', '/.git/HEAD', '/mav.tlog', '/mav.parm',
                   '/package.json', '/CLAUDE.md', '/HANDOFF.md', '/TASKS.md']) {
    assert.equal(isServable(p), false, `${p} must not be served`);
  }
});

test('no server-side source file is servable', () => {
  // Swept from the real tree rather than listed, so a new module is covered the day it
  // lands instead of the day someone remembers to add it here.
  const root = path.join(__dirname, '..');
  const js = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
  assert.ok(js.length > 5, `expected several server modules, found ${js.length}`);
  for (const f of js) {
    if (f === 'sw.js') continue;                 // the service worker is intentionally public
    assert.equal(isServable(`/${f}`), false, `/${f} is server-side source and must not be served`);
  }
});

// ── What the browser genuinely needs ────────────────────────────────────────

test('the operator UI, the service worker and the icons ARE servable', () => {
  // A fail-closed rule that also blocks the UI is not a fix, it is an outage.
  assert.equal(isServable('/socket.html'), true);
  assert.equal(isServable('/sw.js'), true);
  assert.equal(isServable('/icons/fleet-192.png'), true);
  assert.equal(isServable('/icons/picar-icon-rover1.png'), true);
});

test('every icon actually present on disk is servable', () => {
  // Icons are named at runtime from rover_id, so the rule is a directory plus an
  // extension. This checks the real directory against it.
  const dir = path.join(__dirname, '..', 'icons');
  if (!fs.existsSync(dir)) return;
  const pngs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'));
  assert.ok(pngs.length > 0, 'expected icons on disk');
  for (const f of pngs) {
    assert.equal(isServable(`/icons/${f}`), true, `/icons/${f} is needed by the PWA`);
  }
});

// ── Traversal and encoding ─────────────────────────────────────────────────

test('traversal cannot reach a secret through an allowed prefix', () => {
  // The dangerous case: something that starts with /icons/ and then climbs out. Collapsing
  // the path BEFORE matching is what stops it.
  for (const p of ['/icons/../certs/ca.key', '/icons/../../etc/passwd',
                   '/icons/./../certs/key.pem', '/../picar-cfg.local.json',
                   '/./certs/ca.key']) {
    assert.equal(isServable(p), false, `${p} must not resolve to something servable`);
  }
});

test('percent-encoded traversal is refused', () => {
  for (const p of ['/%2e%2e/certs/ca.key', '/icons/%2e%2e/certs/ca.key',
                   '/icons%2f..%2fcerts%2fca.key', '/certs%2fca.key',
                   '/icons%2fevil.js']) {
    assert.equal(isServable(p), false, `${p} must not be served`);
  }
});

test('an encoded separator that resolves to an ALLOWED file is still allowed', () => {
  // Not a bypass, and worth pinning so nobody "hardens" it into a bug. '/%2ficons/x.png'
  // decodes to '//icons/x.png', which normalises to '/icons/x.png' — the same icon the
  // rule already permits. An earlier version of this test asserted it must be refused;
  // that expectation was wrong, and the code was right. What matters is that encoding
  // cannot reach a file OUTSIDE the allowlist, which the test above covers.
  assert.equal(isServable('/%2ficons/fleet-192.png'), true);
  assert.equal(isServable('//icons/fleet-192.png'), true);
  assert.equal(isServable('/icons//fleet-192.png'), true);
});

test('malformed encoding and NUL are refused rather than throwing', () => {
  // This runs on the request path; throwing here would be a crash, which is the other P0
  // fixed alongside this one.
  for (const p of ['/%', '/%zz', '/socket.html%00.png', '/icons/x%00.png']) {
    assert.doesNotThrow(() => isServable(p), `${p} must not throw`);
    assert.equal(isServable(p), false, `${p} must not be served`);
  }
});

test('a non-string or empty path is refused', () => {
  for (const p of [undefined, null, '', 0, {}, []]) {
    assert.equal(isServable(p), false, `${JSON.stringify(p) ?? 'undefined'} must be refused`);
  }
});

// ── The rule's edges ───────────────────────────────────────────────────────

test('the icons rule does not widen into a general file server', () => {
  assert.equal(isServable('/icons/'), false, 'the directory itself is not a file');
  assert.equal(isServable('/icons/evil.js'), false, 'only .png inside icons');
  assert.equal(isServable('/icons/evil.png.js'), false);
  assert.equal(isServable('/icons/sub/x.png'), false, 'no nesting');
  assert.equal(isServable('/iconsevil.png'), false, 'the prefix must be a directory');
});

test('matching is exact, not case-insensitive or prefix-based', () => {
  // The filesystem is case-sensitive here, so a case-insensitive rule would allow a path
  // that does not exist while implying one that does.
  assert.equal(isServable('/SOCKET.HTML'), false);
  assert.equal(isServable('/socket.htmlx'), false);
  assert.equal(isServable('/socket.html/'), false);
  assert.equal(isServable('/xsocket.html'), false);
});

test('the root path is not servable', () => {
  // node-static would look for index.html; there is none, and serving a directory index
  // off the repo root is exactly what this change prevents.
  assert.equal(isServable('/'), false);
});

// ── The consumer ───────────────────────────────────────────────────────────

test('app.js gates static requests on the allowlist', () => {
  // Source-level because app.js binds two HTTPS ports at require time. This catches the
  // realistic regression — removing the gate — which is the mutation that matters.
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(src, /if \(!isServable\(parsed\.pathname\)\)/,
    'app.js must refuse anything not on the allowlist before serving it');
  assert.match(src, /res\.writeHead\(404/,
    'and answer 404 rather than falling through');
});

test('a filename containing .. is refused even inside an allowed directory', () => {
  // The explicit '..' check is not redundant. path.posix.normalize leaves dots alone when
  // they are part of a NAME rather than a path segment, so '/icons/....png' survives
  // normalisation, matches the icons prefix, and has a .png extension — it would be
  // allowed without the check. Nothing reaches a secret either way, because the allowlist
  // is fail-closed, but the stricter behaviour is deliberate and worth pinning: a path
  // that looks like traversal has no business being served.
  assert.equal(isServable('/icons/....png'), false);
  assert.equal(isServable('/icons/..%2ffoo.png'), false);
  assert.equal(isServable('/....//certs/ca.key'), false);
});
