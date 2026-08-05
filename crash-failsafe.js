'use strict';

// Make an unexpected crash put the vehicle in a safe state before the process dies.
//
// THE HOLE THIS CLOSES. `app.js` registered only `process.on('SIGINT')`, so a fail-safe
// stop ran on a deliberate shutdown and on nothing else. Any uncaught exception took the
// process down with the channel buffer holding whatever throttle was last commanded, and
// **no neutral RC_CHANNELS_OVERRIDE packet and no DISARM ever reached the link.**
// Invariant 6 names "process shutdown" as one of the paths that must put neutral on the
// wire before the disarm; only the polite half of it was covered.
//
// It was reachable by one unauthenticated HTTP request. `node-static`'s `finish()` calls
// `res.writeHead()` again after a 206 has already streamed, so
// `curl -H 'Range: bytes=0-99' https://rover:8443/socket.html` throws
// ERR_HTTP_HEADERS_SENT out of the request handler. Reproduced locally against the same
// node-static the rovers run. `picar.service` is `Restart=always`, so repeating the
// request held picar in a crash-restart loop — each cycle leaving the last throttle in
// the buffer and the vehicle armed, on a rover with a flight battery installed and a
// flight controller that ignores DISARM.
//
// Everything here is injected rather than reached for, so the handler can be invoked by a
// test. The previous version of this reasoning lived in a comment; comments do not run.

// Deliberately small: this runs while the process is already failing, so it must not
// depend on anything that could itself be broken.
function installCrashFailSafe({
  proc = process,
  failSafeStop,
  stopStream = () => {},
  log = console.error,
  exit,
  flushMs = 120,
  setTimeoutFn = setTimeout,
} = {}) {
  if (typeof failSafeStop !== 'function') {
    throw new TypeError('installCrashFailSafe requires failSafeStop');
  }
  const doExit = exit || ((code) => proc.exit(code));
  let handling = false;

  function onFatal(kind, err) {
    // Re-entrancy guard. If the fail-safe itself throws, the handler would be re-entered
    // and we would recurse instead of dying — leaving the vehicle armed with throttle
    // applied, which is the exact outcome this exists to prevent.
    if (handling) {
      try { log(`picar: fatal during fatal handling (${kind}), exiting immediately`); } catch (_) {}
      return doExit(1);
    }
    handling = true;

    try {
      log(`picar: FATAL ${kind} — stopping the vehicle before exit:`,
          (err && err.stack) || err);
    } catch (_) { /* logging must never prevent the stop */ }

    // The stop comes first and is wrapped, because a failure to log or to stop the video
    // stream must not prevent neutral reaching the wire.
    try {
      failSafeStop(`fatal ${kind}`);
    } catch (stopErr) {
      try { log('picar: failSafeStop threw during fatal handling:', stopErr); } catch (_) {}
    }
    try { stopStream(); } catch (_) { /* best effort */ }

    // Exit non-zero so systemd treats it as a failure. The delay lets the neutral and
    // DISARM packets flush to the socket, matching the SIGINT path's reasoning — the
    // driver writes them synchronously, but the kernel still needs the tick.
    const t = setTimeoutFn(() => doExit(1), flushMs);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  proc.on('uncaughtException', (err) => onFatal('uncaughtException', err));
  // An unhandled rejection is fatal by default in Node 15+, and it reaches the same
  // place: the process ends without a fail-safe unless it is handled here too.
  proc.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason));

  return { onFatal };
}

// Strip `Range` before handing a request to node-static.
//
// This is the prevention half. The containment half above means a crash is survivable;
// this means this particular crash does not happen. Nothing picar serves on the control
// port needs byte ranges — it is one HTML page, a service worker, a manifest and some
// PNG icons — and node-static's 206 path is what double-writes the header.
//
// Returns whether a range was removed, so the caller can log it: an unexplained request
// pattern on the control port is worth seeing.
function stripRangeHeader(req) {
  if (!req || !req.headers) return false;
  let removed = false;
  for (const name of ['range', 'if-range']) {
    if (req.headers[name] !== undefined) {
      delete req.headers[name];
      removed = true;
    }
  }
  return removed;
}

// The static-serve wrapper, extracted so the Range strip has a TESTED consumer.
// Mutating app.js to skip the strip survived the whole suite while this logic was inline —
// the rule was tested and its only caller was not, which is the defect shape CLAUDE.md
// names as this repo's dominant one and which has now recurred on four branches.
function serveStatic(file, req, res, { log = console.error, describe } = {}) {
  if (stripRangeHeader(req)) {
    const what = describe ? describe(req) : (req.url || '');
    try {
      log(`picar: stripped a Range header from ${req.method} ${what} ` +
          '(node-static 206 path crashes the process)');
    } catch (_) { /* logging must never break the response */ }
  }
  return file.serve(req, res);
}

module.exports = { installCrashFailSafe, stripRangeHeader, serveStatic };
