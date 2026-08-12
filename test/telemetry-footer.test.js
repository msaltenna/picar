'use strict';

// What the on-target telemetry script TELLS THE OPERATOR about whether the vehicle can move.
//
// This is not a cosmetic string test. The footer this exercises used to print "rover3 has no
// flight battery connected, so no mechanical actuation is observed or implied by any check
// above" on every validation run. That claim was false, and it was ACTED ON: throttle was
// commanded -0.6 for 1.5 s and +0.6, three separate runs, each reported safe on the strength
// of it. So the text is a safety output, and the branch it takes is a decision worth pinning.
//
// It deliberately executes the REAL footer extracted from the shipped script rather than
// re-implementing its logic. CLAUDE.md names "a correct rule with an untouched consumer" as
// this repo's dominant defect shape — nine tests have been caught unable to fail, several by
// asserting a rule while the shipped call site went untested. Extracting the actual block
// means a reworded or deleted footer cannot pass this file, and asserting on the script's
// SOURCE TEXT (the vacuous shape CLAUDE.md enumerates) would not have caught that.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'on-target', 'telemetry.sh');

// Pull the footer out of the shipped script by its own markers. If someone moves or renames
// the block this extraction fails loudly rather than silently testing nothing — which is the
// failure mode that matters, so it is preferred over a tolerant regex.
function extractFooter() {
  const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n');
  const start = lines.findIndex(l => l.startsWith('# SCOPE, stated from what was measured'));
  const end   = lines.findIndex(l => l.trim() === 'exit $FAILED');
  assert.ok(start !== -1, 'footer start marker not found in telemetry.sh — did the block move?');
  assert.ok(end   !== -1, 'exit $FAILED not found in telemetry.sh');
  assert.ok(end > start,  'footer markers are out of order');
  return lines.slice(start, end).join('\n');
}

// Run the real footer with a controlled battery reading. `jget` is stubbed to return the
// current, which is all the footer asks it for; everything else comes from the script itself.
// Runs the extracted footer under the SAME shell options the real script sets, and returns both
// its output and its exit status.
//
// Three blind spots a reviewer found in the previous version of this harness, all fixed here:
//   - it omitted `set -u`, which telemetry.sh:27 DOES set (`set -uo pipefail`). So reverting a
//     `${bv:-}` guard to `$bv` passed the test while the real script aborts on an unbound
//     variable and never prints the warning at all.
//   - it pinned FAILED=0 and dropped `exit $FAILED`, so prefixing the block with `FAILED=0;`
//     — which would clear a real earlier failure and turn a failing run into a success — was
//     invisible. `failedIn` now seeds a non-zero value and the exit status is returned.
//   - its `jget` stub ignored the path it was asked for, so pointing the current lookup at
//     `remainingPct` (77) instead of `currentA` (0.42) still printed "0.42 A".
function runFooter({ bv, currentA, remainingPct = '77', failedIn = 0 }) {
  const footer = extractFooter();
  // Honour the requested path, so a mutation to the lookup changes the output.
  const stub = [
    'jget() {',
    '  case "$1" in',
    `    telemetry.battery.currentA) printf "%s" ${JSON.stringify(currentA === undefined ? 'ABSENT' : String(currentA))} ;;`,
    `    telemetry.battery.remainingPct) printf "%s" ${JSON.stringify(String(remainingPct))} ;;`,
    '    *) printf "ABSENT" ;;',
    '  esac',
    '}',
  ].join('\n');
  const preamble = [
    'set -uo pipefail',                 // exactly what telemetry.sh:27 sets
    stub,
    'S1="{}"',
    `FAILED=${failedIn}`,
    bv === undefined ? '' : `bv=${JSON.stringify(String(bv))}`,
  ].join('\n');
  // `exit $FAILED` is INCLUDED, so the footer's effect on the exit status is observable.
  const script = `${preamble}\n${footer}\nexit $FAILED\n`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
}

test('a plausible pack voltage tells the operator the wheels can turn', () => {
  const { out } = runFooter({ bv: '7.905', currentA: '0.42' });
  assert.match(out, /A PACK IS CONNECTED/,
    'a readable in-range voltage must state a pack is connected');
  assert.match(out, /ASSUME THE WHEELS CAN TURN/);
  assert.match(out, /7\.905 V/,  'it must quote the measured voltage, not a generic claim');
  assert.match(out, /0\.42 A/,   'it must quote the measured current when one is available');
  assert.doesNotMatch(out, /IMPLAUSIBLE/);
});

test('the implausible reading measured on rover3 is called out, not read as a connected pack', () => {
  // The real reading on 2026-08-11: 0.007 V while current read 0.54 A. Both cannot be true,
  // so the analog voltage sense is dead. Before this branch existed the plausible-reading
  // path would have printed "A PACK IS CONNECTED" from that nonsense number and been correct
  // only by luck — and the same code would print it for a genuinely flat pack.
  const { out } = runFooter({ bv: '0.007', currentA: '0.54' });
  assert.match(out, /IMPLAUSIBLE/, '0.007 V must be reported as implausible');
  assert.match(out, /0\.007 V/,    'it must quote the reading it is rejecting');
  assert.match(out, /Check physically/);
  assert.doesNotMatch(out, /A PACK IS CONNECTED/,
    'an implausible voltage must NOT be reported as a connected pack');
  assert.doesNotMatch(out, /ASSUME THE WHEELS CAN TURN/);
});

test('an unreadable voltage is never reported as proof the vehicle cannot move', () => {
  for (const bv of [undefined, 'ABSENT', 'null']) {
    const { out } = runFooter({ bv });
    assert.match(out, /NOT evidence the vehicle cannot move/,
      `bv=${bv} must refuse to conclude the vehicle is safe`);
    assert.match(out, /Check physically/);
    assert.doesNotMatch(out, /A PACK IS CONNECTED/);
  }
});

test('no branch of the footer can print the false premise that was acted on', () => {
  // The negative control, and the reason this file exists. Every reachable branch is checked,
  // because the defect was not that the claim was wrong in one case — it was printed
  // unconditionally.
  const forbidden = [
    /has no flight battery/i,
    /cannot actuate/i,
    /cannot physically actuate/i,
    /no mechanical actuation is (observed|implied)/i,
  ];
  const cases = [
    { bv: '7.905', currentA: '0.42' },
    { bv: '0.007', currentA: '0.54' },
    { bv: '25.0',  currentA: undefined },
    { bv: 'ABSENT' },
    { bv: 'null' },
    { bv: undefined },
  ];
  for (const c of cases) {
    const { out } = runFooter(c);
    for (const pat of forbidden) {
      assert.doesNotMatch(out, pat,
        `footer printed a forbidden actuation premise for bv=${c.bv}: ${JSON.stringify(out)}`);
    }
  }
});

test('the footer never claims motion was commanded, because it commands none', () => {
  const { out } = runFooter({ bv: '7.905', currentA: '0.42' });
  assert.match(out, /commands no motion/,
    'the scope line must say the script commands no motion');
});

test('BOTH plausibility bounds are exercised, not just the lower one', () => {
  // A red team found the upper bound untested: every case used bv <= 25.0, so deleting
  // `v < 30.0` from telemetry.sh survived the whole file. A mis-scaled 40 V reading would then
  // print "A PACK IS CONNECTED" instead of being called implausible. Safe-direction, but it
  // degrades the one diagnostic this footer exists to give.
  const high = runFooter({ bv: '40.0', currentA: '0.42' });
  assert.match(high.out, /IMPLAUSIBLE/, '40 V must be flagged implausible');
  assert.doesNotMatch(high.out, /A PACK IS CONNECTED/);
  const low = runFooter({ bv: '2.9', currentA: '0.1' });
  assert.match(low.out, /IMPLAUSIBLE/, '2.9 V is below the 3.0 bound');
  // ...and just inside both bounds is plausible, so the bounds are not merely "always reject".
  for (const v of ['3.1', '29.9']) {
    const ok = runFooter({ bv: v, currentA: '0.42' });
    assert.match(ok.out, /A PACK IS CONNECTED/, `${v} V is inside the window and must pass`);
  }
});

test('the footer PRESERVES an earlier failure instead of clearing it', () => {
  // A reviewer's mutation: prefix the block with `FAILED=0;`. The printed text is identical, so
  // the previous harness — which pinned FAILED=0 and dropped `exit $FAILED` — could not see it.
  // rover3 currently FAILS the plausibility check at telemetry.sh:132, so clearing FAILED here
  // would turn a genuinely failing validation run into a successful one.
  const r = runFooter({ bv: '0.007', currentA: '0.54', failedIn: 1 });
  assert.equal(r.code, 1, 'the footer must not reset a failure that happened before it');
  const ok = runFooter({ bv: '7.905', currentA: '0.42', failedIn: 0 });
  assert.equal(ok.code, 0, 'and it must not invent a failure either');
});

test('the footer reads the CURRENT, not some other telemetry field', () => {
  // The old stub answered every jget path with the same value, so repointing the lookup at
  // remainingPct still printed "0.42 A". Distinct values make the mutation visible: a rover at
  // 77% would print "77 A", which is nonsense a reader would act on.
  const { out } = runFooter({ bv: '7.905', currentA: '0.42', remainingPct: '77' });
  assert.match(out, /0\.42 A/, 'it must report the measured current');
  assert.doesNotMatch(out, /77 A/, 'it must not report the percentage as an amperage');
});

test('the footer survives set -u, which the real script enables', () => {
  // telemetry.sh:27 is `set -uo pipefail`. An earlier revision of this file asserted the script
  // had no `set -u` — from grepping its first twelve lines — and concluded the `${bv:-}` guards
  // were decorative. They are load-bearing: without them an unset bv aborts the shell before
  // the warning prints, so the operator sees NOTHING rather than "check physically".
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /^set -uo pipefail$/m,
    'telemetry.sh must keep set -u, or the guards this test relies on stop mattering');
  const r = runFooter({ bv: undefined });          // bv never assigned at all
  assert.equal(r.code, 0, `an unset bv must not abort the shell: ${r.out}`);
  assert.match(r.out, /NOT evidence the vehicle cannot move/);
});

test('the false premise cannot be reintroduced ANYWHERE in the script, not just in the footer', () => {
  // The extraction starts at the marker, so a printf placed BEFORE it is invisible to every test
  // above — which makes "no reachable branch can print the premise" false as previously written.
  // This is a source-text assertion, and CLAUDE.md is right that those are weak: it catches a
  // reintroduction of these exact phrasings and would not catch a reworded one. It is a
  // supplementary guard on a specific known regression, not a proof.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const live = src.split('\n')
    .filter((l) => !l.trim().startsWith('#'))     // comments may quote the old wording
    .join('\n');
  for (const pat of [/has no flight battery/i, /cannot actuate/i,
                     /cannot physically actuate/i, /no mechanical actuation is (observed|implied)/i]) {
    assert.doesNotMatch(live, pat,
      `a non-comment line in telemetry.sh asserts the withdrawn actuation premise (${pat})`);
  }
});
