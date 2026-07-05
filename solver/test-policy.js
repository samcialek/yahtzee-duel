// solver/test-policy.js
// Tests for the policy/query layer (SOLVER.md §4). Run: node solver/test-policy.js
//
//   1. stateEV(0,0,0) === meta.startEV (to 1e-4; table stores Float32)
//   2. empty card, [1,1,1,1,1], rolls 0 → top category yahtzee, 50 pts
//   3. empty card, [1,2,3,4,5], rolls 0 → top category largeStraight, 40 pts
//   4. lattice-level consistency: keep-all EV at rollsLeft = L equals the best
//      overall EV of the SAME dice at rollsLeft = L−1 (random states)
//   5. every keeps list is exactly the sub-multisets of the dice: each entry a
//      sub-multiset, count = Π(count_f + 1), includes keep-all and ∅
//   6. policy.legalPts matches game.js potentials() on 20 000 random pairs
//   7. fromPlayerState maps card → (mask, up, yz) correctly (incl. the 63 cap)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Policy, fromPlayerState, legalPts } from './policy.js';
import { CAT_ORDER, indexOfMultiset, ROLL_OFFSET } from './tables.js';
import { upListOf } from './states.js';
import { potentials, CATS, PlayerState } from '../public/shared/game.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const bin = fs.readFileSync(path.join(dir, 'strategy.bin'));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'strategy-meta.json'), 'utf8'));
const policy = new Policy(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);

let passed = 0;
function ok(name) { passed++; console.log(`ok ${passed} - ${name}`); }

// Deterministic LCG so failures are reproducible.
let seed = 0x5eedca75 >>> 0;
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const rndInt = n => Math.floor(rnd() * n);
const rndDice = () => Array.from({ length: 5 }, () => 1 + rndInt(6));

// Random valid widget with at least one open category.
function rndState() {
  let mask;
  do { mask = rndInt(8192); } while (mask === 0x1fff);
  const upList = upListOf(mask);
  const up = upList[rndInt(upList.length)];
  const yz = (mask & (1 << 11)) !== 0 && rnd() < 0.5 ? 1 : 0;
  return { mask, up, yz };
}

// --- 1. stateEV(0,0,0) === meta.startEV ------------------------------------
{
  const ev = policy.stateEV(0, 0, 0);
  assert.ok(Math.abs(ev - meta.startEV) < 1e-4,
    `stateEV(0,0,0)=${ev} vs meta.startEV=${meta.startEV}`);
  ok(`stateEV(0,0,0) = ${ev} matches meta.startEV = ${meta.startEV} (|diff| < 1e-4)`);
}

// --- 2. empty card, [1,1,1,1,1], rolls 0 → yahtzee 50 -----------------------
{
  const res = policy.evalTurn(0, 0, 0, [1, 1, 1, 1, 1], 0);
  assert.equal(res.categories[0].cat, 'yahtzee');
  assert.equal(res.categories[0].pts, 50);
  assert.equal(res.categories[0].legal, true);
  assert.equal(res.best.type, 'score');
  assert.equal(res.best.cat, 'yahtzee');
  assert.equal(res.best.pts, 50);
  assert.equal(res.keeps, null);
  ok('empty card, [1,1,1,1,1], rolls 0 → top category yahtzee, 50 pts');
}

// --- 3. empty card, [1,2,3,4,5], rolls 0 → largeStraight 40 -----------------
{
  const res = policy.evalTurn(0, 0, 0, [1, 2, 3, 4, 5], 0);
  assert.equal(res.categories[0].cat, 'largeStraight');
  assert.equal(res.categories[0].pts, 40);
  assert.equal(res.best.type, 'score');
  assert.equal(res.best.cat, 'largeStraight');
  ok('empty card, [1,2,3,4,5], rolls 0 → top category largeStraight, 40 pts');
}

// --- 4. keep-all EV at level L = best overall EV at level L−1 ---------------
{
  const overallBest = res => {
    let m = -Infinity;
    for (const c of res.categories) if (c.legal && c.ev > m) m = c.ev;
    if (res.keeps !== null) for (const k of res.keeps) if (k.ev > m) m = k.ev;
    return m;
  };
  const findKeepAll = (res, dice) => {
    const key = dice.slice().sort((a, b) => a - b).join(',');
    return res.keeps.find(k => k.faces.join(',') === key);
  };
  for (let t = 0; t < 300; t++) {
    const { mask, up, yz } = rndState();
    const dice = rndDice();
    const r2 = policy.evalTurn(mask, up, yz, dice, 2);
    const r1 = policy.evalTurn(mask, up, yz, dice, 1);
    const r0 = policy.evalTurn(mask, up, yz, dice, 0);
    // keep-all at A1 (rolls 2) = Best2(d) = best overall option at rolls 1
    const ka2 = findKeepAll(r2, dice);
    assert.ok(Math.abs(ka2.ev - overallBest(r1)) < 1e-9,
      `A1 keep-all ${ka2.ev} != rolls-1 best ${overallBest(r1)} at mask=${mask} up=${up} yz=${yz} dice=[${dice}]`);
    // keep-all at A2 (rolls 1) = S(d) = best legal category at rolls 0
    const ka1 = findKeepAll(r1, dice);
    assert.ok(Math.abs(ka1.ev - r0.best.ev) < 1e-9,
      `A2 keep-all ${ka1.ev} != rolls-0 best ${r0.best.ev} at mask=${mask} up=${up} yz=${yz} dice=[${dice}]`);
    // best action EV is the overall max at its own level
    assert.ok(Math.abs(r2.best.ev - overallBest(r2)) < 1e-9, 'best.ev != overall max (rolls 2)');
    // desc-sortedness
    for (const res of [r2, r1]) {
      for (let i = 1; i < res.keeps.length; i++) assert.ok(res.keeps[i - 1].ev >= res.keeps[i].ev - 1e-12);
    }
    for (const res of [r2, r1, r0]) {
      for (let i = 1; i < res.categories.length; i++) assert.ok(res.categories[i - 1].ev >= res.categories[i].ev - 1e-12);
    }
  }
  ok('300 random states: keep-all EV equals the lower-level best; lists desc-sorted');
}

// --- 5. keeps lists are exactly the sub-multisets of the dice ---------------
{
  for (let t = 0; t < 200; t++) {
    const { mask, up, yz } = rndState();
    const dice = rndDice();
    const rolls = 1 + rndInt(2); // 1 or 2
    const res = policy.evalTurn(mask, up, yz, dice, rolls);
    const diceCounts = [0, 0, 0, 0, 0, 0, 0];
    for (const f of dice) diceCounts[f]++;
    let expected = 1;
    for (let f = 1; f <= 6; f++) expected *= diceCounts[f] + 1;
    assert.equal(res.keeps.length, expected, `keeps count for dice=[${dice}]`);
    const seen = new Set();
    let hasAll = false, hasEmpty = false;
    for (const k of res.keeps) {
      const kc = [0, 0, 0, 0, 0, 0, 0];
      for (const f of k.faces) {
        assert.ok(Number.isInteger(f) && f >= 1 && f <= 6, `bad face ${f}`);
        kc[f]++;
      }
      for (let f = 1; f <= 6; f++) {
        assert.ok(kc[f] <= diceCounts[f],
          `keep [${k.faces}] is NOT a sub-multiset of dice [${dice}]`);
      }
      const key = k.faces.join(',');
      assert.ok(!seen.has(key), `duplicate keep [${k.faces}]`);
      seen.add(key);
      if (k.faces.length === 5) hasAll = true;
      if (k.faces.length === 0) hasEmpty = true;
    }
    assert.ok(hasAll && hasEmpty, 'keeps must include keep-all and reroll-all');
  }
  ok('200 random queries: keeps = exactly the distinct sub-multisets (incl. keep-all, ∅)');
}

// --- 6. policy.legalPts matches game.js potentials() ------------------------
{
  const N = 20000;
  const ptsBuf = new Int32Array(13);
  for (let i = 0; i < N; i++) {
    const mask = rndInt(8192);
    let dice;
    if (rnd() < 0.25) { const f = 1 + rndInt(6); dice = [f, f, f, f, f]; }
    else dice = rndDice();
    const card = {};
    for (let c = 0; c < 13; c++) {
      card[CATS[c]] = ((mask >> c) & 1) === 0 ? null : (c === 11 && rnd() < 0.5 ? 50 : 0);
    }
    const legal = legalPts(mask, indexOfMultiset(dice) - ROLL_OFFSET, ptsBuf);
    const pot = potentials(card, dice);
    for (let c = 0; c < 13; c++) {
      const cat = CATS[c];
      const isOpen = ((mask >> c) & 1) === 0;
      assert.equal(Object.prototype.hasOwnProperty.call(pot, cat), isOpen);
      if (isOpen) {
        assert.equal(((legal >> c) & 1) === 1, pot[cat].allowed,
          `legality mismatch ${cat} mask=${mask} dice=[${dice}]`);
        assert.equal(ptsBuf[c], pot[cat].pts,
          `pts mismatch ${cat} mask=${mask} dice=[${dice}]`);
      } else {
        assert.equal((legal >> c) & 1, 0);
      }
    }
  }
  ok(`policy legalPts matches game.js potentials() on ${N} random (mask, dice) pairs`);
}

// --- 7. fromPlayerState -----------------------------------------------------
{
  const ps = new PlayerState();
  assert.deepEqual(fromPlayerState(ps), { mask: 0, up: 0, yz: 0 });

  ps.card.ones = 3;            // bit 0
  ps.card.fives = 15;          // bit 4
  ps.card.fullHouse = 25;      // bit 8
  ps.card.yahtzee = 0;         // bit 11, zeroed box → yz 0
  assert.deepEqual(fromPlayerState(ps),
    { mask: (1 << 0) | (1 << 4) | (1 << 8) | (1 << 11), up: 18, yz: 0 });

  ps.card.yahtzee = 50;        // box holds 50 → yz 1
  assert.deepEqual(fromPlayerState(ps),
    { mask: (1 << 0) | (1 << 4) | (1 << 8) | (1 << 11), up: 18, yz: 1 });

  // upper cap at 63
  const ps2 = new PlayerState();
  for (let c = 0; c < 6; c++) ps2.card[CAT_ORDER[c]] = (c + 1) * 4; // sum = 84
  assert.deepEqual(fromPlayerState(ps2), { mask: 63, up: 63, yz: 0 });

  // serialized (plain-object) form works too
  assert.deepEqual(fromPlayerState(ps.serialize(false)),
    { mask: (1 << 0) | (1 << 4) | (1 << 8) | (1 << 11), up: 18, yz: 1 });

  ok('fromPlayerState: mask bits, upper sum (capped at 63), yz from yahtzee===50');
}

console.log(`\nall ${passed} test groups passed`);
