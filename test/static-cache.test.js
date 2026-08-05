'use strict';

// The control UI must never be served from a stale browser cache.
//
// node-static defaults to `cache: 3600`, so socket.html went out with
// `Cache-Control: max-age=3600` — an hour in which the browser will not even
// revalidate. The measured consequence was not theoretical: a client-side throttle fix
// was deployed, verified present in the file the rover serves, the operator reloaded and
// kept running the OLD page, and a round of debugging went into code the browser had
// never loaded.
//
// It is a safety issue rather than a caching nit. socket.html carries fail-safe
// behaviour: the 20 Hz input send loop, the panic key, the drivetrain interlock and the
// throttle deadzone escape. An operator can be driving a page whose fail-safe was fixed
// hours earlier.
//
// app.js binds two HTTPS ports and the MAVProxy socket at require time, so it cannot be
// required here. These tests construct node-static exactly as app.js does and assert the
// headers it produces — verified against the real app.js source so the two cannot drift.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const staticServer = require('node-static');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('app.js constructs the static server with caching disabled', () => {
  // Source-level, and deliberately so: the alternative is booting app.js, which binds
  // ports. This catches the regression that actually happened — reverting to the bare
  // `new static.Server()` default.
  const m = /new static\.Server\(([\s\S]{0,300}?)\);/.exec(appSrc);
  assert.ok(m, 'no static.Server construction found in app.js — renamed?');
  const args = m[1];
  assert.match(args, /cache:\s*false/,
    'node-static defaults to cache: 3600, which serves the control UI stale for an hour');
  assert.match(args, /'Cache-Control':\s*'no-cache'/,
    'the operator UI must be revalidated on every load');
  assert.doesNotMatch(args, /max-age/, 'no max-age on the control UI');
});

test('the constructed server emits no-cache and no max-age', () => {
  // Behavioural: build it the same way and read the headers node-static computes.
  const server = new staticServer.Server('.', {
    cache: false,
    headers: { 'Cache-Control': 'no-cache' },
  });
  const defaults = server.defaultHeaders || {};
  const keys = Object.keys(defaults).map((k) => k.toLowerCase());
  assert.ok(!keys.includes('cache-control'),
    `node-static still set a default cache-control: ${JSON.stringify(defaults)}`);
  assert.equal(server.cache, false, 'cache must be disabled, not merely shortened');

  // And the default construction — the thing we are guarding against — really does
  // produce the hour-long cache, so this test is measuring something real.
  const naive = new staticServer.Server();
  assert.equal(naive.cache, 3600);
  assert.equal(naive.defaultHeaders['cache-control'], 'max-age=3600',
    'if node-static ever changes this default, revisit the comment in app.js');
});

test('the operator-facing header is explicitly no-cache, not merely absent', () => {
  // Absent is not good enough: with no Cache-Control at all, browsers apply heuristic
  // freshness based on Last-Modified and can still reuse the page without asking.
  const server = new staticServer.Server('.', {
    cache: false,
    headers: { 'Cache-Control': 'no-cache' },
  });
  assert.equal(server.options.headers['Cache-Control'], 'no-cache');
});
