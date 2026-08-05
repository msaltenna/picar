'use strict';

// What the unauthenticated control port is allowed to serve off disk.
//
// THE DEFECT. node-static's root defaulted to the process working directory, which
// systemd sets to /opt/picar — the whole repository. Measured against rover3 over plain
// unauthenticated HTTPS:
//
//   GET /certs/ca.key          200  -----BEGIN PRIVATE KEY-----
//   GET /certs/key.pem         200  -----BEGIN PRIVATE KEY-----
//   GET /picar-cfg.local.json  200  {"rover_id": 3, ...}
//   GET /.git/config           200
//   GET /mediamtx.yml          200
//
// `certs/ca.key` is the CA private key that README.md tells every operator device to
// trust. Anyone who can reach the port can mint a certificate the whole fleet accepts —
// a fleet-wide MITM from a single GET, no authentication, no arming, no lease. The
// untracked overlay that invariant 8 exists to protect is readable too, along with the
// git history and the generated MediaMTX config.
//
// AN ALLOWLIST, NOT A DENYLIST. A denylist has to anticipate every secret anyone ever
// adds to the repo, and it silently stops covering new ones. This enumerates the four
// things the browser actually fetches and refuses everything else, so a file added
// tomorrow is not served by default. Fail-closed: an entry that cannot be classified is
// denied.

const path = require('path');

// Exactly what socket.html and the PWA install request. /manifest.json and
// /socket.io/socket.io.js are handled before this by app.js and socket.io respectively
// and never reach the static server.
const ALLOWED_FILES = new Set(['/socket.html', '/sw.js']);

// Icons are per-rover and named at runtime from rover_id, so they cannot be enumerated —
// a directory plus a strict extension is the tightest rule available.
const ALLOWED_DIRS = [{ prefix: '/icons/', extensions: new Set(['.png']) }];

// Decode once and reject anything that decoding turns into a traversal or a NUL. node-static
// has its own traversal check, but this runs first and must not depend on it: the point of a
// fail-closed allowlist is that it holds even if the thing behind it changes.
function normalise(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return null;                       // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  // Collapse any traversal BEFORE matching, so /icons/../certs/ca.key cannot pass by
  // looking like it starts with /icons/.
  const resolved = path.posix.normalize(decoded);
  if (!resolved.startsWith('/')) return null;
  if (resolved.includes('..')) return null;
  return resolved;
}

// Whether the static server may serve this request path.
function isServable(pathname) {
  const p = normalise(pathname);
  if (p === null) return false;
  if (ALLOWED_FILES.has(p)) return true;
  for (const { prefix, extensions } of ALLOWED_DIRS) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    // No nesting: /icons/a/b.png is not an icon, and allowing subdirectories widens the
    // rule for no benefit.
    if (rest.length === 0 || rest.includes('/')) return false;
    if (!extensions.has(path.posix.extname(rest).toLowerCase())) return false;
    return true;
  }
  return false;
}

module.exports = { isServable, ALLOWED_FILES, ALLOWED_DIRS };
