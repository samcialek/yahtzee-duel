// test-analysis.js — headless verification of public/js/analysis.js (ANALYSIS.md §4)
//
// Replays a SCRIPTED solitaire game through the REAL PlayerState + nextDice
// (public/shared/game.js), recording every decision exactly the way app.js does
// (same recordDecision call shape: keep faces = view.you.dice.filter(held);
// score = {type:'score', cat}; view.you = ps.serialize(true); the forced first
// roll of a round is never recorded). Dice are controlled by scripting the rng
// argument of nextDice — a face queue for the injected positions, a seeded LCG
// for everything else — so the whole game is deterministic and reproducible.
//
// Two deliberate blunders are injected; every other decision plays the policy's
// own best action (policy.evalTurn over the real strategy.bin):
//   A) round 1, rollsLeft 2: first roll is a MADE large straight [2,3,4,5,6]
//      … and the player rerolls everything.
//   B) round 2, rollsLeft 2: first roll is [6,6,6,6,6] with the yahtzee box
//      open … and the player scores Chance (30).
//
// Asserted (ANALYSIS.md §4):
//   * exactly the two injected blunders have loss > 0.01;
//   * each blunder's loss equals bestEV − chosenEV recomputed INDEPENDENTLY
//     via policy.evalTurn (own coordinate reconstruction, own max);
//   * every optimal decision reports loss < 0.01;
//   * cumLoss is nondecreasing and its final value equals totalLoss;
//   * accuracyPct / nOptimal / worst / perRoundCum are consistent;
//   * keep-multiset matching: holding faces [3,3] out of [3,3,3,5,6] is graded
//     against the keeps entry for exactly [3,3] — not [3] and not [3,3,3];
//   * recordDecision unit rules: forced first roll (dice === null) is never
//     logged; a duplicate (round, rollsLeft) call is dropped.
//
// Run: node test-analysis.js       (pure computation — never touches port 3000)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { recordDecision, analyze, subsetReport, OPTIMAL_EPS } from './public/js/analysis.js';
import { CATS, PlayerState, nextDice } from './public/shared/game.js';
import { Policy, fromPlayerState } from './solver/policy.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const bin = fs.readFileSync(path.join(dir, 'public', 'strategy.bin'));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'public', 'strategy-meta.json'), 'utf8'));
const policy = new Policy(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);

let passed = 0;
function ok(name) { passed++; console.log(`ok ${passed} - ${name}`); }

// ---------------------------------------------------------------------------
// Scripted randomness for nextDice: forced faces first, then a seeded LCG.
// nextDice maps rng() ∈ [0,1) → face 1 + floor(rng()*6); (f − 0.5)/6 hits
// face f exactly, with no float-rounding edge cases.
// ---------------------------------------------------------------------------

let lcgState = 0xC0FFEE >>> 0;
function lcg() {
  lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
  return lcgState / 4294967296;
}
let forcedFaces = [];              // faces consumed (in order) before the LCG kicks in
const rng = () => (forcedFaces.length ? (forcedFaces.shift() - 0.5) / 6 : lcg());

const NO_HOLD = [false, false, false, false, false];

/** Roll through the REAL nextDice + PlayerState.applyRoll (mode 1, no shared). */
function rollDice(ps, held, faces = null) {
  if (faces) forcedFaces = faces.slice();
  const { dice, mask } = nextDice(ps, held, 1, null, rng);
  assert.equal(forcedFaces.length, 0, 'scripted faces fully consumed by nextDice');
  assert.equal(mask.length, ps.rollsLeft === 3 ? 5 : held.filter((h) => !h).length);
  ps.applyRoll(dice);
}

/** Positional hold mask from a kept face multiset (same greedy as ai-optimal.js). */
function holdFromFaces(dice, faces) {
  const need = [0, 0, 0, 0, 0, 0, 0];
  for (const f of faces) need[f]++;
  return dice.map((v) => (need[v] > 0 ? (need[v]--, true) : false));
}

/** The view chunk app.js hands to recordDecision — built by the real serializer. */
const mkView = (ps) => ({ t: 'state', you: ps.serialize(true) });

// app.js call shapes, verbatim:
//   doRoll : recordDecision(moveLog, view, { type:'keep', faces: view.you.dice.filter((_, i) => held[i]) })
//   doScore: recordDecision(moveLog, view, { type:'score', cat })
function recordKeepLikeApp(log, view, held) {
  recordDecision(log, view, { type: 'keep', faces: view.you.dice.filter((_, i) => held[i]) });
}
function recordScoreLikeApp(log, view, cat) {
  recordDecision(log, view, { type: 'score', cat });
}

// ---------------------------------------------------------------------------
// Independent recompute of a decision's loss, straight off policy.evalTurn —
// own coordinate reconstruction (ANALYSIS.md §1 wording), own best-EV max.
// Written without reference to analysis.js internals.
// ---------------------------------------------------------------------------

function coordsIndependent(card) {
  let mask = 0, up = 0;
  CATS.forEach((cat, i) => {
    if (card[cat] !== null) { mask |= 1 << i; if (i < 6) up += card[cat]; }
  });
  return { mask, up: Math.min(63, up), yz: card.yahtzee === 50 ? 1 : 0 };
}

function independentLoss(card, dice, rollsLeft, action) {
  const { mask, up, yz } = coordsIndependent(card);
  const res = policy.evalTurn(mask, up, yz, dice, rollsLeft);
  let best = -Infinity;
  for (const c of res.categories) if (c.legal && c.ev > best) best = c.ev;
  if (res.keeps) for (const k of res.keeps) if (k.ev > best) best = k.ev;
  let chosen;
  if (action.type === 'keep') {
    const key = action.faces.slice().sort((a, b) => a - b).join(',');
    const m = res.keeps.find((k) => k.faces.join(',') === key);
    assert.ok(m, `independent: keeps entry [${key}] exists`);
    chosen = m.ev;
  } else {
    const m = res.categories.find((c) => c.cat === action.cat);
    assert.ok(m, `independent: category ${action.cat} open`);
    chosen = m.ev;
  }
  return Math.max(0, best - chosen);
}

// ---------------------------------------------------------------------------
// 1) recordDecision unit rules (forced first roll; duplicate drop)
// ---------------------------------------------------------------------------

{
  const probe = [];
  const ps0 = new PlayerState();
  // Forced first roll of a round: dice === null → MUST NOT be logged.
  recordDecision(probe, mkView(ps0), { type: 'keep', faces: [] });
  assert.equal(probe.length, 0);
  ok('forced first roll (dice === null) is not logged');

  rollDice(ps0, NO_HOLD, [1, 2, 3, 4, 5]);
  const v = mkView(ps0);
  recordKeepLikeApp(probe, v, NO_HOLD);
  assert.equal(probe.length, 1);
  // Same (round, rollsLeft) again — e.g. a double-click racing the state push.
  recordScoreLikeApp(probe, v, 'chance');
  assert.equal(probe.length, 1);
  assert.equal(probe[0].action.type, 'keep');
  ok('duplicate (round, rollsLeft) decision is dropped — first action wins');
}

// ---------------------------------------------------------------------------
// 2) The scripted game — 13 real rounds through PlayerState + nextDice.
//    Everything plays policy.evalTurn().best except the two injected blunders.
// ---------------------------------------------------------------------------

const log = [];
const ps = new PlayerState();
const blunders = [];   // { round, rollsLeft, card, dice, action } snapshots for the recompute

while (!ps.done) {
  if (ps.dice === null) {
    // Forced first roll — no decision, never recorded (app.js doRoll guard).
    const first = ps.round === 0 ? [2, 3, 4, 5, 6]      // a made large straight…
                : ps.round === 1 ? [6, 6, 6, 6, 6]      // …and a natural Yahtzee
                : null;                                  // free dice elsewhere
    rollDice(ps, NO_HOLD, first);
    continue;
  }

  const view = mkView(ps);
  const snap = { round: ps.round, rollsLeft: ps.rollsLeft, card: { ...ps.card }, dice: ps.dice.slice() };

  // -- Blunder A: round 1, rollsLeft 2 — reroll a MADE large straight ------
  if (ps.round === 0 && ps.rollsLeft === 2) {
    assert.deepEqual(ps.dice, [2, 3, 4, 5, 6]);
    recordKeepLikeApp(log, view, NO_HOLD);              // keep nothing
    blunders.push({ ...snap, action: { type: 'keep', faces: [] } });
    rollDice(ps, NO_HOLD, [2, 3, 4, 5, 6]);             // fate re-deals the straight
    continue;
  }

  // -- Blunder B: round 2, rollsLeft 2 — Chance on [6,6,6,6,6], yahtzee open
  if (ps.round === 1 && ps.rollsLeft === 2) {
    assert.deepEqual(ps.dice, [6, 6, 6, 6, 6]);
    assert.equal(ps.card.yahtzee, null, 'precondition: yahtzee box still open');
    assert.equal(ps.card.chance, null, 'precondition: chance still open');
    recordScoreLikeApp(log, view, 'chance');
    blunders.push({ ...snap, action: { type: 'score', cat: 'chance' } });
    assert.equal(ps.scoreCategory('chance'), 30);
    continue;
  }

  // -- Every other decision: the policy's own best action ------------------
  const { mask, up, yz } = fromPlayerState(ps);
  const res = policy.evalTurn(mask, up, yz, ps.dice, ps.rollsLeft);
  if (res.best.type === 'score') {
    recordScoreLikeApp(log, view, res.best.cat);
    assert.notEqual(ps.scoreCategory(res.best.cat), null, `policy pick ${res.best.cat} is legal`);
  } else {
    const held = holdFromFaces(ps.dice, res.best.faces);
    recordKeepLikeApp(log, view, held);
    rollDice(ps, held);
  }
}

assert.equal(ps.round, 13);
for (const cat of CATS) assert.notEqual(ps.card[cat], null, `${cat} filled at game end`);
assert.equal(blunders.length, 2);
assert.ok(log.length >= 13, `at least one decision per round (got ${log.length})`);
for (const e of log) {
  assert.ok(Array.isArray(e.dice) && e.dice.length === 5, 'entry has 5 rolled dice');
  assert.ok([0, 1, 2].includes(e.rollsLeft), 'no forced first roll (rollsLeft 3) recorded');
}
assert.deepEqual([...new Set(log.map((e) => e.round))], Array.from({ length: 13 }, (_, r) => r));
ok(`scripted game complete: 13 rounds, ${log.length} decisions logged, final score ${ps.total}`);

// ---------------------------------------------------------------------------
// 3) analyze() over the real strategy.bin
// ---------------------------------------------------------------------------

const report = analyze(log, policy);
assert.equal(report.nDecisions, log.length);
assert.equal(report.decisions.length, log.length);

// Exactly the two injected blunders carry loss > 0.01 …
const flagged = report.decisions.filter((d) => d.loss > OPTIMAL_EPS);
assert.equal(flagged.length, 2, `exactly 2 decisions flagged (got ${flagged.length})`);
const dA = report.decisions.find((d) => d.round === 0 && d.rollsLeft === 2);
const dB = report.decisions.find((d) => d.round === 1 && d.rollsLeft === 2);
assert.ok(flagged.includes(dA), 'blunder A (reroll made large straight) is flagged');
assert.ok(flagged.includes(dB), 'blunder B (Chance on a Yahtzee, box open) is flagged');
assert.ok(!dA.optimal && !dB.optimal);
ok(`exactly the 2 injected blunders have loss > 0.01 (A ${dA.loss.toFixed(4)}, B ${dB.loss.toFixed(4)})`);

// … and every other decision is optimal with loss < 0.01.
for (const d of report.decisions) {
  if (d === dA || d === dB) continue;
  assert.ok(d.loss < OPTIMAL_EPS, `optimal decision r${d.round + 1}/rl${d.rollsLeft} loss ${d.loss}`);
  assert.ok(d.optimal);
}
ok(`all ${report.nDecisions - 2} policy-played decisions report loss < 0.01`);

// Blunder losses equal bestEV − chosenEV recomputed independently via evalTurn.
const [sA, sB] = blunders;
const expA = independentLoss(sA.card, sA.dice, sA.rollsLeft, sA.action);
const expB = independentLoss(sB.card, sB.dice, sB.rollsLeft, sB.action);
assert.ok(expA > OPTIMAL_EPS && expB > OPTIMAL_EPS, 'independent recompute also flags both');
assert.ok(Math.abs(dA.loss - expA) < 1e-9, `lossA ${dA.loss} == independent ${expA}`);
assert.ok(Math.abs(dB.loss - expB) < 1e-9, `lossB ${dB.loss} == independent ${expB}`);
ok('both blunder losses equal bestEV − chosenEV recomputed independently via evalTurn');

// cumLoss nondecreasing; final value equals totalLoss; equals the loss sum.
let prev = 0;
for (const d of report.decisions) {
  assert.ok(d.cumLoss >= prev - 1e-12, 'cumLoss nondecreasing');
  prev = d.cumLoss;
}
assert.ok(Math.abs(report.decisions[report.nDecisions - 1].cumLoss - report.totalLoss) < 1e-9);
const lossSum = report.decisions.reduce((a, d) => a + d.loss, 0);
assert.ok(Math.abs(report.totalLoss - lossSum) < 1e-9);
ok(`cumLoss nondecreasing, final cumLoss == totalLoss == Σloss (${report.totalLoss.toFixed(4)})`);

// Summary consistency: nOptimal / accuracyPct / worst / perRoundCum.
assert.equal(report.nOptimal, report.nDecisions - 2);
assert.ok(Math.abs(report.accuracyPct - (100 * report.nOptimal) / report.nDecisions) < 1e-9);
const maxLoss = Math.max(...report.decisions.map((d) => d.loss));
assert.equal(report.worst, dA.loss >= dB.loss ? dA : dB, 'worst is the larger-loss blunder');
assert.ok(Math.abs(report.worst.loss - maxLoss) < 1e-12);
assert.deepEqual(report.perRoundCum.map((r) => r.round), Array.from({ length: 13 }, (_, r) => r));
let prevRound = 0;
for (const r of report.perRoundCum) {
  assert.ok(r.cumLoss >= prevRound - 1e-12, 'perRoundCum nondecreasing');
  prevRound = r.cumLoss;
}
assert.ok(Math.abs(report.perRoundCum[12].cumLoss - report.totalLoss) < 1e-9);
ok(`summary consistent: ${report.nOptimal}/${report.nDecisions} optimal `
  + `(${report.accuracyPct.toFixed(1)}%), worst round ${report.worst.round + 1} `
  + `(−${report.worst.loss.toFixed(2)}), perRoundCum ends at totalLoss`);

// Labels carry the documented shapes on the injected pair.
assert.equal(dA.yoursLabel, 'reroll everything');
assert.equal(dB.yoursLabel, 'score Chance (30)');
assert.equal(dB.optimalLabel, 'score Yahtzee (50)');
assert.ok(/^(keep \d|stand pat|reroll everything|score )/.test(dA.optimalLabel), dA.optimalLabel);
ok(`labels: "${dA.yoursLabel}" vs "${dA.optimalLabel}"; "${dB.yoursLabel}" vs "${dB.optimalLabel}"`);

// ---------------------------------------------------------------------------
// 4) Keep-multiset matching: held faces [3,3] must be graded against the
//    keeps entry for exactly [3,3] — not [3], not [3,3,3]. Played through the
//    real PlayerState so the log entry is one a real game could produce.
// ---------------------------------------------------------------------------

{
  const log2 = [];
  const ps2 = new PlayerState();
  rollDice(ps2, NO_HOLD, [3, 3, 3, 5, 6]);            // forced first roll — not a decision
  const view2 = mkView(ps2);
  const held2 = [true, true, false, false, false];    // hold exactly two of the three 3s
  recordKeepLikeApp(log2, view2, held2);
  assert.deepEqual(log2[0].action.faces, [3, 3]);
  rollDice(ps2, held2);                               // the reroll actually happens

  const res2 = policy.evalTurn(0, 0, 0, [3, 3, 3, 5, 6], 2);
  const evOf = (key) => {
    const k = res2.keeps.find((e) => e.faces.join(',') === key);
    assert.ok(k, `keeps entry [${key}] exists`);
    return k.ev;
  };
  const ev3 = evOf('3'), ev33 = evOf('3,3'), ev333 = evOf('3,3,3');
  // The three candidate matches are meaningfully distinct in this state.
  assert.ok(Math.abs(ev3 - ev33) > 1e-6 && Math.abs(ev333 - ev33) > 1e-6 && Math.abs(ev3 - ev333) > 1e-6);
  let best2 = -Infinity;
  for (const c of res2.categories) if (c.legal && c.ev > best2) best2 = c.ev;
  for (const k of res2.keeps) if (k.ev > best2) best2 = k.ev;

  const rep2 = analyze(log2, policy);
  assert.equal(rep2.nDecisions, 1);
  const d = rep2.decisions[0];
  assert.ok(Math.abs(d.loss - Math.max(0, best2 - ev33)) < 1e-12, 'graded against the [3,3] entry');
  assert.ok(Math.abs(d.loss - Math.max(0, best2 - ev3)) > 1e-6, 'NOT graded against [3]');
  assert.ok(Math.abs(d.loss - Math.max(0, best2 - ev333)) > 1e-6, 'NOT graded against [3,3,3]');
  ok(`keep-multiset matching: [3,3] → ev ${ev33.toFixed(4)} (loss ${d.loss.toFixed(4)}), `
    + `distinct from [3] ev ${ev3.toFixed(4)} and [3,3,3] ev ${ev333.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// 5) subsetReport (the Coach's flagged-decisions review): a subset of graded
//    decisions gets its running Σ and summary recomputed over just that subset.
// ---------------------------------------------------------------------------

{
  // Flag one blunder (dA) and one optimal decision — the shape a training player
  // produces by tapping "Flag for review" on two turns.
  const optimalPick = report.decisions.find((d) => d.optimal && d.round !== dA.round);
  const subset = report.decisions.filter((d) => d === dA || d === optimalPick);
  const sub = subsetReport(subset);

  assert.equal(sub.nDecisions, 2, 'subset keeps exactly the flagged decisions');
  assert.equal(sub.nOptimal, 1, 'one of the two flagged was optimal');
  assert.ok(Math.abs(sub.accuracyPct - 50) < 1e-9, 'accuracy over the subset is 50%');
  assert.ok(Math.abs(sub.totalLoss - dA.loss) < 1e-12, 'subset totalLoss = the one blunder’s loss');
  assert.equal(sub.worst, sub.decisions.find((d) => !d.optimal), 'worst is the flagged blunder');
  // Running Σ is recomputed over the subset (not carried from the full game).
  let run = 0;
  for (const d of sub.decisions) { run += d.loss; assert.ok(Math.abs(d.cumLoss - run) < 1e-12, 'subset cumLoss'); }
  // subsetReport returns fresh entries — the source decisions are not mutated.
  assert.ok(sub.decisions.every((d, i) => d !== subset[i]), 'subsetReport copies entries (no aliasing)');
  ok(`subsetReport: 2 flagged → ${sub.nOptimal}/${sub.nDecisions} optimal, `
    + `Σ ${sub.totalLoss.toFixed(2)}, worst −${sub.worst.loss.toFixed(2)}`);

  // Empty subset (nothing flagged) is well-formed and renders as "no decisions".
  const empty = subsetReport([]);
  assert.equal(empty.nDecisions, 0);
  assert.equal(empty.accuracyPct, 100);
  assert.equal(empty.worst, null);
  ok('subsetReport([]) is a well-formed empty report');
}

console.log(`\n# test-analysis: all ${passed} checks passed`);
console.log(`# game: ${report.nDecisions} decisions, ${report.nOptimal} optimal, `
  + `totalLoss ${report.totalLoss.toFixed(4)}, final score ${ps.total}`);
console.log(`# ledger: ${report.decisions.map((d) =>
  `[r${d.round + 1}·${d.rollsLeft} ${d.yoursLabel}${d.optimal ? '' : ` −${d.loss.toFixed(2)}`}]`).join(' ')}`);
