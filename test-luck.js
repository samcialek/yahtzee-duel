// test-luck.js — pins the per-player "luck tape" contract + the same-luck perfect
// replay (public/shared/game.js makeLuck/nextDice + analysis.js replayOptimal).
//
// A player's whole game is REPRODUCIBLE for ANY hold sequence given
// (shared, ps.luck, mode): with ps.luck set, the opening roll (variant 1) and the
// rerolls (variants 1 & 2) are drawn from the tape BY DIE POSITION; variant-3
// rerolls still come from shared.rerolls BY K-INDEX. That reproducibility is what
// the post-game "perfect play on your dice" replay relies on.
//
// Assertions (dependency-free node; never touches the dev server on port 3000):
//   1) FIDELITY   — for each mode 1/2/3 and many random (shared, luck) tapes,
//                   driving a game with an arbitrary but FIXED hold sequence and
//                   then REPLAYING that same sequence over the same tape
//                   reproduces the identical dice trace and final total.
//   2) UNIFORMITY — the RAW values makeLuck lays down (opening + both reroll
//                   levels) are uniform over 1..6 within ~1% over millions of
//                   samples. (Measured on the tape itself, never on a replay
//                   trace — kept dice would bias that.)
//   3) REPLAY MEAN— replayOptimal over a few thousand random tapes (mode 1)
//                   averages within 3.0 of 254.59, and is deterministic (same
//                   tape -> same score twice).
//   4) NO-LUCK    — with ps.luck UNSET, nextDice still shares variant-3 rerolls by
//      PARITY       k-index between two players on one shared object (documented
//                   overlap intact), and the shared opening matches too.
//
// Run: node test-luck.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  makeLuck, makeShared, nextDice, PlayerState, ROUNDS, potentials, CATS,
} from './public/shared/game.js';
import { Policy, fromPlayerState } from './solver/policy.js';
import { holdMaskFromKeep } from './public/js/ai-optimal.js';

// ---------------------------------------------------------------------------
// Load the solved value table (required: ./solver/strategy.bin via node:fs).
// ---------------------------------------------------------------------------

const dir = path.dirname(fileURLToPath(import.meta.url));
const bin = fs.readFileSync(path.join(dir, 'solver', 'strategy.bin'));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'solver', 'strategy-meta.json'), 'utf8'));
const policy = new Policy(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);

let passed = 0;
function ok(name) { passed++; console.log(`ok ${passed} - ${name}`); }

// ---------------------------------------------------------------------------
// Deterministic RNG so the whole suite is reproducible (same LCG as the sibling
// tests). makeShared/makeLuck accept an rng; a seeded stream fixes the tapes.
// ---------------------------------------------------------------------------

function makeLcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const NO_HOLD = [false, false, false, false, false];

// ---------------------------------------------------------------------------
// Reference same-luck perfect replay — reconstructed faithfully from the
// analysis.js contract (PlayerState + nextDice + fromPlayerState + policy).
// ---------------------------------------------------------------------------

function replayOptimal(context) {
  if (!context || !context.luck) return null;
  const { shared, luck, mode } = context;
  const ps = new PlayerState();
  ps.luck = luck;
  while (!ps.done) {
    ps.applyRoll(nextDice(ps, NO_HOLD, mode, shared).dice);
    for (;;) {
      const { mask, up, yz } = fromPlayerState(ps);
      const res = policy.evalTurn(mask, up, yz, ps.dice, ps.rollsLeft);
      if (res.best.type === 'score') { ps.scoreCategory(res.best.cat); break; }
      ps.applyRoll(nextDice(ps, holdMaskFromKeep(ps.dice, res.best.faces), mode, shared).dice);
    }
  }
  return ps.total;
}

// ---------------------------------------------------------------------------
// An ARBITRARY but deterministic (pure-of-state) hold policy. Because it depends
// only on (round, rollsLeft, dice), the same dice always yield the same choice —
// so driving with it and then replaying the choices it made must agree.
// ---------------------------------------------------------------------------

function firstLegalCat(ps) {
  const pot = potentials(ps.card, ps.dice);
  for (const cat of CATS) if (pot[cat] && pot[cat].allowed) return cat;
  // Unreachable: potentials always leaves at least one allowed category open.
  return CATS.find((c) => ps.card[c] === null);
}

function fixedDecide(ps) {
  if (ps.rollsLeft === 0) return { score: true, cat: firstLegalCat(ps) };
  const sum = ps.dice.reduce((a, b) => a + b, 0);
  // Stop early on the last reroll sometimes, so games mix 1-, 2- and 3-roll rounds.
  if (ps.rollsLeft === 1 && sum % 3 === 0) return { score: true, cat: firstLegalCat(ps) };
  // Otherwise keep a dice-derived, position-varying subset and reroll the rest.
  const hold = ps.dice.map((v, i) => (((v + i + ps.round) & 1) === 0));
  return { hold };
}

// Drive a full game with fixedDecide, recording the dice trace AND the exact
// script (opening / reroll-with-hold / score-cat) it produced.
function driveGame(shared, luck, mode) {
  const ps = new PlayerState();
  ps.luck = luck;
  const trace = [];
  const script = [];
  while (!ps.done) {
    ps.applyRoll(nextDice(ps, NO_HOLD, mode, shared).dice);
    trace.push(ps.dice.slice());
    script.push({ kind: 'open' });
    for (;;) {
      const d = fixedDecide(ps);
      if (d.score) { script.push({ kind: 'score', cat: d.cat }); ps.scoreCategory(d.cat); break; }
      ps.applyRoll(nextDice(ps, d.hold, mode, shared).dice);
      trace.push(ps.dice.slice());
      script.push({ kind: 'reroll', hold: d.hold.slice() });
    }
  }
  return { total: ps.total, trace, script };
}

// Replay a recorded script (the SAME hold sequence) over the same tape.
function replayScript(shared, luck, mode, script) {
  const ps = new PlayerState();
  ps.luck = luck;
  const trace = [];
  for (const step of script) {
    if (step.kind === 'open') {
      ps.applyRoll(nextDice(ps, NO_HOLD, mode, shared).dice);
      trace.push(ps.dice.slice());
    } else if (step.kind === 'reroll') {
      ps.applyRoll(nextDice(ps, step.hold, mode, shared).dice);
      trace.push(ps.dice.slice());
    } else {
      ps.scoreCategory(step.cat);
    }
  }
  return { total: ps.total, trace };
}

// ===========================================================================
// 1) FIDELITY — fixed hold sequence reproduces the dice trace + total per mode.
// ===========================================================================

{
  const rng = makeLcg(0x5EED1);
  const TAPES_PER_MODE = 150;
  let checked = 0;
  let sawMultiRoll = false;
  for (const mode of [1, 2, 3]) {
    for (let t = 0; t < TAPES_PER_MODE; t++) {
      const shared = makeShared(rng);
      const luck = makeLuck(rng);
      const driven = driveGame(shared, luck, mode);
      const replayed = replayScript(shared, luck, mode, driven.script);

      assert.equal(driven.trace.length, replayed.trace.length,
        `mode ${mode}: trace length must match`);
      for (let i = 0; i < driven.trace.length; i++) {
        assert.deepEqual(replayed.trace[i], driven.trace[i],
          `mode ${mode} tape ${t}: dice at trace step ${i} must reproduce`);
      }
      assert.equal(replayed.total, driven.total,
        `mode ${mode} tape ${t}: final total must reproduce`);
      // Sanity: a completed game covers all 13 rounds.
      const openings = driven.script.filter((s) => s.kind === 'open').length;
      assert.equal(openings, ROUNDS, `mode ${mode}: a game plays exactly ${ROUNDS} rounds`);
      if (driven.trace.length > ROUNDS) sawMultiRoll = true;
      checked++;
    }
  }
  assert.ok(sawMultiRoll, 'fixed policy actually rerolls (trace longer than 13 openings)');
  ok(`FIDELITY — ${checked} games across modes 1/2/3 replay to identical dice + total`);
}

// ===========================================================================
// 2) UNIFORMITY — raw makeLuck values are uniform over 1..6 within ~1%.
// Measured on the tape itself (opening + reroll level 0 + reroll level 1),
// NOT on any replay trace (kept dice would bias the distribution).
// ===========================================================================

{
  const TAPES = 20000;                 // 20000 * (65 + 65 + 65) = ~3.9M raw samples
  const counts = new Float64Array(7);  // counts[1..6]
  let total = 0;
  const tally = (arr) => { for (const v of arr) { counts[v]++; total++; } };
  for (let t = 0; t < TAPES; t++) {
    const luck = makeLuck();            // real default path (Math.random)
    for (let r = 0; r < ROUNDS; r++) {
      tally(luck.opening[r]);
      tally(luck.reroll[r][0]);
      tally(luck.reroll[r][1]);
    }
  }
  const expected = total / 6;
  let maxRel = 0;
  for (let f = 1; f <= 6; f++) {
    const rel = Math.abs(counts[f] - expected) / expected;
    if (rel > maxRel) maxRel = rel;
  }
  assert.ok(total >= 3_000_000, `sampled a few million raw values (got ${total})`);
  assert.ok(maxRel < 0.01,
    `each face within 1% of uniform (max relative deviation ${(maxRel * 100).toFixed(3)}%)`);
  ok(`UNIFORMITY — ${(total / 1e6).toFixed(2)}M raw tape values uniform over 1..6 `
    + `(max dev ${(maxRel * 100).toFixed(3)}%)`);
}

// ===========================================================================
// 3) REPLAY MEAN — replayOptimal over a few thousand mode-1 tapes averages
// within 3.0 of 254.59, and is deterministic (same tape -> same score twice).
// ===========================================================================

{
  const rng = makeLcg(0xA11CE);
  const N = 4000;
  let sum = 0;
  let firstScore = null;
  let firstContext = null;
  for (let i = 0; i < N; i++) {
    const shared = makeShared(rng);
    const luck = makeLuck(rng);
    const context = { shared, luck, mode: 1 };
    const score = replayOptimal(context);
    assert.ok(Number.isInteger(score) && score >= 0, `replay score is a non-negative integer (${score})`);
    if (i === 0) { firstScore = score; firstContext = context; }
    sum += score;
  }
  const mean = sum / N;
  assert.ok(Math.abs(mean - 254.5877) < 3.0,
    `mode-1 replay mean ${mean.toFixed(3)} within 3.0 of 254.59 (n=${N})`);

  // Determinism: the very same tape replays to the very same score.
  const again = replayOptimal(firstContext);
  assert.equal(again, firstScore, 'same tape -> same replay score twice (deterministic)');
  // And a null / luckless context yields null (the app's "no closing line" path).
  assert.equal(replayOptimal(null), null, 'null context -> null');
  assert.equal(replayOptimal({ shared: makeShared(rng), mode: 1 }), null, 'missing luck -> null');

  ok(`REPLAY MEAN — mean ${mean.toFixed(3)} over ${N} mode-1 tapes (within 3.0 of 254.59); deterministic`);
}

// ===========================================================================
// 4) NO-LUCK PARITY — with ps.luck UNSET, two players on one shared object still
// share variant-3 rerolls by K-INDEX, and the shared opening matches.
// ===========================================================================

{
  const shared = makeShared(makeLcg(0xB0B));
  const round = 0;

  // Two luckless players (ps.luck never assigned).
  const a = new PlayerState();
  const b = new PlayerState();
  assert.equal(a.luck, undefined, 'player A carries no luck tape');
  assert.equal(b.luck, undefined, 'player B carries no luck tape');

  // Opening (mode 3 -> shared.first): identical for both, equal to the shared board.
  const aOpen = nextDice(a, NO_HOLD, 3, shared);
  const bOpen = nextDice(b, NO_HOLD, 3, shared);
  a.applyRoll(aOpen.dice);
  b.applyRoll(bOpen.dice);
  assert.deepEqual(aOpen.dice, shared.first[round], 'mode-3 opening = shared.first');
  assert.deepEqual(bOpen.dice, aOpen.dice, 'both players see the identical shared opening');

  // Reroll #2 (rollNum 2 -> shared.rerolls[round][0]) shared BY K-INDEX:
  const seq = shared.rerolls[round][0];

  //  (a) rerolling ALL five -> full overlap, dice === seq in order.
  const aAll = nextDice(a, NO_HOLD, 3, shared);
  assert.deepEqual(aAll.dice, seq.slice(), 'reroll-all draws the whole k-indexed seq in order');

  //  (b) a partial reroll draws seq[k] for the k-th rerolled POSITION (k-index,
  //      not die position): hold dice 0 and 2, reroll positions 1,3,4.
  const hold = [true, false, true, false, false];
  const bPart = nextDice(b, hold, 3, shared);
  const freePositions = [1, 3, 4];
  freePositions.forEach((p, k) => {
    assert.equal(bPart.dice[p], seq[k],
      `partial reroll: free position ${p} takes seq[${k}]=${seq[k]} (k-index sharing)`);
  });
  // Held positions keep their opening faces.
  assert.equal(bPart.dice[0], bOpen.dice[0], 'held die 0 keeps its face');
  assert.equal(bPart.dice[2], bOpen.dice[2], 'held die 2 keeps its face');

  ok('NO-LUCK PARITY — luckless players share the mode-3 opening and rerolls by k-index');
}

console.log(`\nPASS test-luck.js — ${passed}/${passed} assertions green (luck-tape contract + same-luck replay)`);
