// test-claim.js — pins the Category Claim contract (shared rules + LocalEngine +
// the live server rooms).
//
// Category Claim: the 13 categories are ONE shared pool — a box scored by either
// player is dead for both. It is a SIMULTANEOUS race on independent dice, run
// under the canRollSync roll barrier (neither runs more than a roll ahead), so it
// is turn-free even though it uses the mode-1 (independent) dice mechanic. When
// one box remains, SUDDEN DEATH: both players play one full turn for it at once
// and the higher score in that box claims it (tie voids). The upper bonus is a
// race: whoever pushes the COMBINED upper total to 63+ pockets the 35
// (PlayerState.claimBonus / claimMode).
//
// Assertions:
//   1) RULES      — potentials(card, dice, blocked): blocked cats never offered,
//                   count as taken for the joker branching; scoreCategory rejects
//                   blocked cats; claimedCats/openCats; claim-mode upperBonus.
//   2) BARRIER    — canRollSync truth table (rounds + rolls-taken lockstep).
//   3) ENGINE     — full LocalEngine claim games (the engine is variant-agnostic,
//                   so all 3 dice modes are exercised, fast timers): disjoint
//                   claims, 12 or 13 boxes resolved, sudden death fields, upper
//                   race awarded at most once, totals consistent.
//   4) SERVER     — a real ws game on a child-process server: a mode-2 claim
//                   request is COERCED to independent dice (mode 1), stays
//                   simultaneous (turn always null), barrier holds, sudden death
//                   resolves, game ends.
//
// Run: node test-claim.js   (spawns server.js on TEST_PORT for section 4)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import {
  PlayerState, potentials, claimedCats, openCats, canRollSync, CATS, UPPER,
} from './public/shared/game.js';
import { LocalEngine } from './public/js/engine.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function ok(name) { passed++; console.log(`ok ${passed} - ${name}`); }

// ---------------------------------------------------------------------------
// 1) RULES — blocked potentials, joker branching, claim upper bonus
// ---------------------------------------------------------------------------
{
  const ps = new PlayerState();
  const blocked = new Set(['chance', 'sixes']);
  ps.dice = [6, 6, 6, 2, 2];
  const pot = potentials(ps.card, ps.dice, blocked);
  assert.equal(pot.chance, undefined, 'blocked chance is not offered');
  assert.equal(pot.sixes, undefined, 'blocked sixes is not offered');
  assert.equal(pot.fullHouse.pts, 25, 'open cats still score normally');
  assert.equal(ps.scoreCategory('chance', blocked), null, 'scoring a blocked cat rejected');
  assert.equal(ps.scoreCategory('fullHouse', blocked), 25, 'open cat scores');
  ok('blocked cats: never offered, never scorable');
}
{
  // Joker: yahtzee box CLAIMED BY OPPONENT (own box still null) triggers joker
  // branching, forcing the matching upper box exactly as a self-filled box would.
  const ps = new PlayerState();
  ps.dice = [3, 3, 3, 3, 3];
  const pot = potentials(ps.card, ps.dice, new Set(['yahtzee']));
  assert.equal(pot.yahtzee, undefined, 'claimed yahtzee box unavailable');
  assert.equal(pot.threes.allowed, true, 'joker forces the matching upper box');
  assert.equal(pot.threes.pts, 15);
  assert.equal(pot.fullHouse.allowed, false, 'lower boxes joker-blocked while upper open');
  // …and if the matching upper box is ALSO claimed, lower boxes open at joker values.
  const pot2 = potentials(ps.card, ps.dice, new Set(['yahtzee', 'threes']));
  assert.equal(pot2.fullHouse.allowed, true);
  assert.equal(pot2.fullHouse.pts, 25);
  ok('joker branching counts opponent-claimed boxes as taken');
}
{
  const a = new PlayerState();
  a.card.ones = 3; a.card.yahtzee = 50;
  const b = new PlayerState();
  b.card.chance = 21;
  assert.deepEqual([...claimedCats(a.card)].sort(), ['ones', 'yahtzee']);
  const open = openCats(a.card, b.card);
  assert.equal(open.length, 10, '13 − 3 claimed = 10 open');
  assert.ok(!open.includes('ones') && !open.includes('yahtzee') && !open.includes('chance'));
  ok('claimedCats / openCats');
}
{
  const ps = new PlayerState();
  ps.claimMode = true;
  for (const c of UPPER) ps.card[c] = 12;                 // upperSum 72 — but claim mode
  assert.equal(ps.upperBonus, 0, 'claim mode ignores the solo ≥63 rule');
  ps.claimBonus = 35;
  assert.equal(ps.upperBonus, 35, 'claim mode pays the awarded race bonus');
  ps.claimMode = false;
  assert.equal(ps.upperBonus, 35, 'classic mode: solo ≥63 rule');
  ok('claim-mode upper bonus is the awarded race, not the solo 63');
}

// ---------------------------------------------------------------------------
// 2) BARRIER — canRollSync truth table
// ---------------------------------------------------------------------------
{
  const P = (round, rollsLeft) => ({ round, rollsLeft });
  // Fresh round, both untouched → both may take roll 1.
  assert.equal(canRollSync(P(0, 3), P(0, 3)), true);
  // I took roll 1, opponent hasn't → I may NOT take roll 2; they may take roll 1.
  assert.equal(canRollSync(P(0, 2), P(0, 3)), false);
  assert.equal(canRollSync(P(0, 3), P(0, 2)), true);
  // Both took roll 1 → both may take roll 2 (one roll in flight max).
  assert.equal(canRollSync(P(0, 2), P(0, 2)), true);
  // Opponent scored (next round) → I finish my round freely; they wait for me.
  assert.equal(canRollSync(P(0, 1), P(1, 3)), true);
  assert.equal(canRollSync(P(1, 3), P(0, 1)), false);
  // Sudden-death lock (rollsLeft forced to 0) frees the other player entirely.
  assert.equal(canRollSync(P(6, 2), P(6, 0)), true);
  ok('canRollSync lockstep truth table');
}

// ---------------------------------------------------------------------------
// 3) ENGINE — full LocalEngine claim games, all three variants
// ---------------------------------------------------------------------------

/** Drive one vs-AI claim game with a simple scripted human (roll once, score the
 *  first allowed open cat; in sudden death roll once and lock). Resolves with
 *  { finalView, eng } at phase 'end'. */
function playClaimGame(mode) {
  return new Promise((resolve, reject) => {
    let eng = null;
    let pending = null;      // latest view — act on THAT, never a stale one
    let scheduled = false;
    let lastSeq = 0;
    const timeout = setTimeout(() => {
      reject(new Error(`claim game (mode ${mode}) did not finish — stalled at seq ${lastSeq}`));
    }, 20000);

    const act = (view) => {
      if (view.phase === 'end') {
        clearTimeout(timeout);
        resolve({ finalView: view, eng });
        return;
      }
      const you = view.you;
      const opp = view.opp;
      if (view.turn === 'opp') return;                       // variant-1 alternation
      if (view.sudden && view.sudden.youPts !== null) return; // locked in
      if (you.dice === null) {
        // Take roll 1 when the barrier (claim 2/3 + sudden) allows it.
        const gated = view.claim;   // every Claim game is now a lockstep race
        if (!gated || canRollSync(you, opp)) eng.roll([false, false, false, false, false]);
        return;
      }
      if (view.sudden) { eng.score(view.sudden.cat); return; }
      const pot = potentials(you.card, you.dice, claimedCats(opp.card));
      const cat = CATS.find((c) => pot[c] && pot[c].allowed);
      if (cat) eng.score(cat);
    };

    eng = new LocalEngine({
      mode,
      claim: true,
      onState: (view) => {
        if (view.seq <= lastSeq) return;
        lastSeq = view.seq;
        pending = view;
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; act(pending); }, 0);
      },
    });
    eng.delay = () => 1;         // fast AI timers (Duel pacing)
    eng.claimDelay = () => 1;    // fast AI timers (Claim race pacing)
  });
}

function assertClaimInvariants(finalView, eng, label) {
  assert.equal(finalView.phase, 'end', `${label}: game ended`);
  assert.equal(finalView.claim, true, `${label}: claim stamped on the view`);

  const humanClaims = claimedCats(eng.human.card);
  const aiClaims = claimedCats(eng.ai.card);
  for (const c of humanClaims) {
    assert.ok(!aiClaims.has(c), `${label}: box ${c} claimed by exactly one player`);
  }
  const resolved = humanClaims.size + aiClaims.size;
  assert.ok(resolved === 13 || resolved === 12,
    `${label}: 13 boxes resolved (or 12 on a sudden-death tie), got ${resolved}`);
  assert.ok(eng.sudden !== null, `${label}: sudden death was reached`);
  assert.ok(finalView.sudden.oppPts !== null || finalView.sudden.oppLocked,
    `${label}: sudden outcome revealed at end`);

  // Upper race: 35 awarded to at most one player, and exactly one iff combined ≥63.
  const combined = eng.human.upperSum + eng.ai.upperSum;
  const awards = (eng.human.claimBonus === 35 ? 1 : 0) + (eng.ai.claimBonus === 35 ? 1 : 0);
  assert.ok(awards <= 1, `${label}: upper bonus awarded at most once`);
  assert.equal(awards === 1, combined >= 63,
    `${label}: bonus iff combined upper (${combined}) crossed 63`);

  // Serialized totals include the claim bonus and match the result payload.
  assert.equal(finalView.result.you, eng.human.total, `${label}: your total consistent`);
  assert.equal(finalView.result.opp, eng.ai.total, `${label}: AI total consistent`);
}

for (const mode of [1, 2, 3]) {
  const { finalView, eng } = await playClaimGame(mode);
  assertClaimInvariants(finalView, eng, `mode ${mode}`);
  eng.destroy();
  ok(`LocalEngine claim game, variant ${mode} (claims disjoint, sudden death, upper race)`);
}

// Rematch resets claim state and plays clean again.
{
  const { eng } = await playClaimGame(2);
  const done = new Promise((resolve, reject) => {
    let lastSeq = 0;
    let pending = null;
    let scheduled = false;
    const timeout = setTimeout(() => reject(new Error('rematch game stalled')), 20000);
    const act = (view) => {
      if (view.phase === 'end') { clearTimeout(timeout); resolve(view); return; }
      const you = view.you;
      if (view.sudden && view.sudden.youPts !== null) return;
      if (you.dice === null) {
        const gated = view.claim;   // every Claim game is now a lockstep race
        if (!gated || canRollSync(you, view.opp)) eng.roll([false, false, false, false, false]);
        return;
      }
      if (view.sudden) { eng.score(view.sudden.cat); return; }
      const pot = potentials(you.card, you.dice, claimedCats(view.opp.card));
      const cat = CATS.find((c) => pot[c] && pot[c].allowed);
      if (cat) eng.score(cat);
    };
    eng.onState = (view) => {
      if (view.seq <= lastSeq) return;
      lastSeq = view.seq;
      pending = view;
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; act(pending); }, 0);
    };
    eng.rematch();
  });
  const view2 = await done;
  assertClaimInvariants(view2, eng, 'rematch');
  eng.destroy();
  ok('rematch resets sudden/upper-race state and completes');
}

// The two AI pumps must use INDEPENDENT double-scheduling guards. If they shared
// one flag, a human who opens sudden death while a claim-pump timer is still in
// flight would leave the AI unscheduled (pumpSuddenAI would bail on the shared
// flag) until the human acted again — the AI frozen at the decisive box.
{
  const eng = new LocalEngine({ mode: 1, claim: true, onState: () => {} });
  eng.clearTimers();                          // cancel the queued opening start()
  // Simulate: a claim-pump timer is in flight, and the human just triggered sudden death.
  eng.aiClaimScheduled = true;
  eng.human.round = 6; eng.human.rollsLeft = 3; eng.human.dice = null;
  eng.ai.round = 6; eng.ai.rollsLeft = 3; eng.ai.dice = null;
  eng.sudden = { cat: 'chance', locked: { you: null, opp: null } };
  eng.pumpSuddenAI();
  assert.equal(eng.aiSuddenScheduled, true,
    'sudden pump arms despite an in-flight claim-pump timer (independent guards)');
  eng.destroy();
  ok('sudden-death AI pump is not blocked by a pending claim-pump timer');
}

// ---------------------------------------------------------------------------
// 4) SERVER — real ws room; a mode-2 claim request is coerced to independent dice
// ---------------------------------------------------------------------------

const TEST_PORT = 3131;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf) => {
      if (String(buf).includes('listening')) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('exit', (code) => reject(new Error(`test server exited early (${code})`)));
    setTimeout(() => reject(new Error('test server did not start')), 5000);
  });
}

/** A scripted claim client mirroring app.js's real roll-gating: respect
 *  variant-1 alternation (turn) and the claim roll-sync barrier only where it
 *  applies (mode>=2 or sudden death). Resolves with its final view at 'end'. */
function runClient(ws, name) {
  return new Promise((resolve, reject) => {
    let lastSeq = 0;
    const timeout = setTimeout(() => reject(new Error(`${name} stalled at seq ${lastSeq}`)), 20000);
    const send = (obj) => ws.send(JSON.stringify(obj));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'error') { clearTimeout(timeout); reject(new Error(`${name}: ${msg.msg}`)); return; }
      if (msg.t !== 'state') return;
      // Category Claim must be simultaneous throughout — turn is always null.
      if (msg.claim && msg.turn !== null) {
        clearTimeout(timeout); reject(new Error(`${name}: claim game reported turn=${msg.turn} (not simultaneous)`)); return;
      }
      if (msg.seq <= lastSeq) return;
      lastSeq = msg.seq;
      if (msg.phase === 'end') { clearTimeout(timeout); resolve(msg); return; }
      const you = msg.you;
      const opp = msg.opp;
      if (msg.mode === 1 && !msg.claim && msg.turn === 'opp') return;  // not my alternating turn
      if (msg.sudden && msg.sudden.youPts !== null) return;    // locked in
      if (you.dice === null) {
        const gated = msg.claim;   // every Claim game is now a lockstep race
        if (!gated || canRollSync(you, opp)) send({ t: 'roll', hold: [] });
        return;
      }
      if (msg.sudden) { send({ t: 'score', cat: msg.sudden.cat }); return; }
      const pot = potentials(you.card, you.dice, claimedCats(opp.card));
      const cat = CATS.find((c) => pot[c] && pot[c].allowed);
      if (cat) send({ t: 'score', cat });
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

{
  const child = await startServer();
  try {
    const wsA = new WebSocket(`ws://localhost:${TEST_PORT}`);
    const wsB = new WebSocket(`ws://localhost:${TEST_PORT}`);
    const doneA = runClient(wsA, 'A');
    const doneB = runClient(wsB, 'B');

    const code = await new Promise((resolve, reject) => {
      wsA.on('open', () => wsA.send(JSON.stringify({ t: 'create', name: 'A', mode: 2, claim: true })));
      wsA.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.t === 'created') resolve(msg.code);
      });
      setTimeout(() => reject(new Error('no room code')), 5000);
    });
    await new Promise((resolve) => {
      if (wsB.readyState === WebSocket.OPEN) resolve();
      else wsB.on('open', resolve);
    });
    wsB.send(JSON.stringify({ t: 'join', name: 'B', code }));

    const [endA, endB] = await Promise.all([doneA, doneB]);
    assert.equal(endA.claim, true, 'server: claim echoed in the view');
    // Defensive coercion: a claim room requested with mode 2 is forced to
    // independent dice (mode 1) — Category Claim never runs on shared/linked dice.
    assert.equal(endA.mode, 1, 'server: claim room coerced to independent dice (mode 1)');
    assert.equal(endA.phase, 'end');
    // Disjoint claims across the two personalized views.
    const aClaims = claimedCats(endA.you.card);
    const bClaims = claimedCats(endA.opp.card);
    for (const c of aClaims) assert.ok(!bClaims.has(c), `server: ${c} claimed once`);
    const resolved = aClaims.size + bClaims.size;
    assert.ok(resolved === 13 || resolved === 12, `server: 13 (or tie 12) resolved, got ${resolved}`);
    assert.ok(endA.sudden && endA.sudden.cat, 'server: sudden death happened');
    assert.equal(endA.result.you, endB.result.opp, 'server: mirrored totals agree');
    assert.equal(endA.result.opp, endB.result.you, 'server: mirrored totals agree (reverse)');
    // Upper race consistency from the serialized bonuses.
    const awards = (endA.you.upperBonus === 35 ? 1 : 0) + (endA.opp.upperBonus === 35 ? 1 : 0);
    const combined = endA.you.upperSum + endA.opp.upperSum;
    assert.ok(awards <= 1, 'server: bonus at most once');
    assert.equal(awards === 1, combined >= 63, 'server: bonus iff combined ≥ 63');
    wsA.close();
    wsB.close();
    ok('server room: claim end-to-end (mode-2 request coerced to mode 1, simultaneous race, sudden death, upper race)');
  } finally {
    child.kill();
  }
}

console.log(`\nall ${passed} claim checks passed`);
