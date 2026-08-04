'use strict';

// Validation and persistence for operator-set video parameters.
//
// Two defects motivate this module, and they compound into "video settings don't
// take", which is how the operator experienced it:
//
//   1. NOTHING PERSISTED THEM. `streams/webrtc.js` held the params in a module-level
//      `let params = {...}` seeded from the config. `setParams()` mutated that object
//      and wrote mediamtx.yml, and nothing else. So every picar restart — every
//      deploy, every reboot — silently reverted the operator's tuning to the tracked
//      default. Measured: a UI change to 650 kbps at 18:30 was discarded by a restart
//      at 20:03 and replaced with the config value, with no indication anywhere.
//
//   2. NOTHING VALIDATED THEM. `setParams()` assigned whatever arrived:
//      `if (newParams.width !== undefined) params.width = newParams.width`. A string,
//      a NaN, an object — straight into the generated YAML. That is the same
//      unauthenticated surface as the `setVideoParams` RCE (see TASKS.md), and
//      persisting an unvalidated value would upgrade a transient bad frame rate into
//      a permanent unbootable stream config.
//
// Persisting makes (2) strictly more dangerous, so validation is not optional here:
// a whitelist of keys, finite integers only, clamped to ranges that cannot produce a
// broken encoder. Anything else is rejected and reported rather than coerced —
// silently accepting `fps: "fast"` as 0 is how a config error becomes a mystery.

const path = require('path');

// Bounds are deliberately generous at the top end (an operator may genuinely want
// 1080p on a good link) and conservative at the bottom, where the failure modes live:
// a 0 or negative value produces an encoder that will not start, and persisting that
// leaves a rover with no video until someone edits JSON over SSH.
const VIDEO_PARAM_SPEC = {
  width:      { min: 160, max: 1920 },
  height:     { min: 120, max: 1080 },
  fps:        { min: 1,   max: 60   },
  bitrate:    { min: 50,  max: 8000 }, // kbps
  quality:    { min: 1,   max: 100  }, // mjpeg only, harmless elsewhere
  idr_period: { min: 1,   max: 300  },
};

// Which tracked-config key each param maps to, per codec. Explicit rather than
// derived: a codec whose keys are not listed here persists NOTHING, and says so,
// instead of quietly writing keys the driver never reads.
const OVERLAY_KEYS_BY_CODEC = {
  webrtc: {
    width:      'webrtc_width',
    height:     'webrtc_height',
    fps:        'webrtc_fps',
    bitrate:    'webrtc_bitrate_kbps',
    idr_period: 'webrtc_idr_period',
  },
  h264: {
    width:   'h264_width',
    height:  'h264_height',
    fps:     'h264_framerate',
    bitrate: 'h264_bitrate_kbps',
  },
  mjpeg: {
    // mjpeg has no width/height/bitrate keys in the tracked config — only a drop
    // threshold — so there is nothing to persist. Listed explicitly so the caller
    // gets an empty mapping rather than a lookup miss it might mistake for a bug.
  },
};

// Coerce and bound one operator-supplied value. Returns null when the value cannot
// be used, so the caller can report it instead of writing a broken config.
function sanitizeOne(name, raw) {
  const spec = VIDEO_PARAM_SPEC[name];
  if (!spec) return null;
  // A numeric STRING is accepted here, unlike the param overlay, because these values
  // arrive from HTML form controls where "20" is the normal representation. What is
  // rejected is anything that is not a finite number after conversion.
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < spec.min || rounded > spec.max) return null;
  return rounded;
}

// Filter an operator request down to values that are safe to apply AND to persist.
// Reports everything dropped: a rejected setting that vanishes silently is
// indistinguishable from one that was applied, which is the exact confusion this
// whole module exists to end.
function sanitizeVideoParams(input) {
  const params = {};
  const rejected = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { params, rejected: [`request is ${Array.isArray(input) ? 'an array' : typeof input}, not an object`] };
  }
  for (const [name, raw] of Object.entries(input)) {
    if (!(name in VIDEO_PARAM_SPEC)) {
      rejected.push(`${name} is not a settable video parameter`);
      continue;
    }
    const value = sanitizeOne(name, raw);
    if (value === null) {
      const s = VIDEO_PARAM_SPEC[name];
      rejected.push(`${name}=${JSON.stringify(raw)} is not an integer in ${s.min}..${s.max}`);
      continue;
    }
    params[name] = value;
  }
  return { params, rejected };
}

// Translate sanitized params into the overlay keys for a codec.
function overlayUpdatesFor(codec, params) {
  const map = OVERLAY_KEYS_BY_CODEC[codec];
  if (!map) return { updates: {}, unsupported: true };
  const updates = {};
  for (const [name, value] of Object.entries(params)) {
    if (map[name]) updates[map[name]] = value;
  }
  return { updates, unsupported: false };
}

// Merge into an existing overlay object WITHOUT disturbing anything else in it.
// This file holds `rover_id`, which is the rover's identity — clobbering it would
// make the vehicle report as a different rover to the Fleet Manager. So this is a
// merge over a parsed copy, never a rewrite from a template.
function mergeOverlay(existing, updates) {
  const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
  return { ...base, ...updates };
}

// Persist to the untracked per-rover overlay, atomically.
//
// Atomic because a torn write to this file is worse than not writing it: it holds
// `rover_id`, and app.js parses it at startup. A truncated JSON file would leave the
// rover unable to boot its own identity — over a video setting. So write a temp file
// in the same directory and rename, which is atomic within a filesystem.
//
// Async because the caller is a Socket.IO handler on the control event loop, and
// invariant 9 forbids synchronous filesystem work there. The existing writeFileSync
// on this path is already a recorded P0; this does not add a second one.
async function persistVideoParams({
  overlayPath,
  codec,
  params,
  fs: fsdep = require('fs'),
}) {
  const { updates, unsupported } = overlayUpdatesFor(codec, params);
  if (unsupported) {
    return { persisted: false, reason: `codec '${codec}' has no persistable video keys`, updates: {} };
  }
  if (Object.keys(updates).length === 0) {
    return { persisted: false, reason: 'nothing to persist', updates: {} };
  }

  let existing = {};
  try {
    const text = await fsdep.promises.readFile(overlayPath, 'utf8');
    existing = JSON.parse(text);
  } catch (err) {
    // A missing overlay is normal on a fresh rover; a CORRUPT one is not, and
    // overwriting it would destroy rover_id. Refuse rather than guess.
    if (err.code !== 'ENOENT') {
      return { persisted: false, reason: `refusing to overwrite unreadable overlay: ${err.message}`, updates };
    }
  }
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    return { persisted: false, reason: 'existing overlay is not a JSON object; refusing to overwrite', updates };
  }

  const merged = mergeOverlay(existing, updates);
  const tmp = path.join(path.dirname(overlayPath), `.${path.basename(overlayPath)}.tmp-${process.pid}`);
  try {
    await fsdep.promises.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    await fsdep.promises.rename(tmp, overlayPath);
  } catch (err) {
    try { await fsdep.promises.unlink(tmp); } catch (_) { /* best effort */ }
    return { persisted: false, reason: `write failed: ${err.message}`, updates };
  }
  return { persisted: true, reason: null, updates };
}

module.exports = {
  VIDEO_PARAM_SPEC,
  OVERLAY_KEYS_BY_CODEC,
  sanitizeVideoParams,
  overlayUpdatesFor,
  mergeOverlay,
  persistVideoParams,
};
