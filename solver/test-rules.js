// solver/test-rules.js
// Rule-consistency test (SOLVER.md §3): the solver's in-loop legality+points
// logic — legalPts() exported by solve.js, the EXACT code the sweep consumes —
// must EXACTLY match potentials(cardFromMask, dice) from public/shared/game.js
// for 250 000 random (mask, dice) pairs. Run: node solver/test-rules.js
//
// Importing solve.js does NOT run the sweep (main is guarded on direct execution).

import assert from 'node:assert/strict';
import { legalPts } from './solve.js';
import { indexOfMultiset, ROLL_OFFSET } from './tables.js';
import { potentials, CATS, isYahtzee } from '../public/shared/game.js';

const N = 250000;
const YZ_BIT = 1 << 11;

// Deterministic LCG so failures are reproducible.
let seed = 0x2c3dda21 >>> 0;
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const rndInt = n => Math.floor(rnd() * n);

const ptsBuf = new Int32Array(13);
let jokerCase1 = 0, jokerCase2 = 0, jokerCase3 = 0, nonJoker = 0, yahtzeeRolls = 0;

for (let i = 0; i < N; i++) {
  const mask = rndInt(8192);

  // ~25% forced Yahtzee rolls so all three joker branches get heavy coverage.
  let dice;
  if (rnd() < 0.25) {
    const f = 1 + rndInt(6);
    dice = [f, f, f, f, f];
  } else {
    dice = [1 + rndInt(6), 1 + rndInt(6), 1 + rndInt(6), 1 + rndInt(6), 1 + rndInt(6)];
  }

  // cardFromMask: filled → 0 (or 50 for a filled yahtzee box half the time —
  // potentials() only null-checks it, so the value must not matter), open → null.
  const card = {};
  for (let c = 0; c < 13; c++) {
    card[CATS[c]] = ((mask >> c) & 1) === 0 ? null
      : (c === 11 && rnd() < 0.5 ? 50 : 0);
  }

  const rollIdx = indexOfMultiset(dice) - ROLL_OFFSET;
  const legal = legalPts(mask, rollIdx, ptsBuf);
  const pot = potentials(card, dice);

  const ctx = () => `i=${i} mask=${mask.toString(2).padStart(13, '0')} dice=[${dice}]`;

  for (let c = 0; c < 13; c++) {
    const cat = CATS[c];
    const isOpen = ((mask >> c) & 1) === 0;
    const inPot = Object.prototype.hasOwnProperty.call(pot, cat);
    assert.equal(inPot, isOpen, `openness mismatch for ${cat}: ${ctx()}`);
    if (isOpen) {
      assert.equal(((legal >> c) & 1) === 1, pot[cat].allowed,
        `legality mismatch for ${cat}: ${ctx()}`);
      assert.equal(ptsBuf[c], pot[cat].pts,
        `pts mismatch for ${cat}: solver=${ptsBuf[c]} game=${pot[cat].pts} ${ctx()}`);
    } else {
      assert.equal((legal >> c) & 1, 0, `closed cat ${cat} marked legal: ${ctx()}`);
    }
  }

  // Coverage bookkeeping.
  if (isYahtzee(dice)) yahtzeeRolls++;
  if (isYahtzee(dice) && (mask & YZ_BIT) !== 0) {
    const upBit = 1 << (dice[0] - 1);
    const open = (~mask) & 0x1fff;
    const LOWER_NOY = (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 12);
    if (open & upBit) jokerCase1++;
    else if (open & LOWER_NOY) jokerCase2++;
    else jokerCase3++;
  } else {
    nonJoker++;
  }
}

assert.ok(jokerCase1 > 1000 && jokerCase2 > 1000 && jokerCase3 > 100,
  `insufficient joker coverage: ${jokerCase1}/${jokerCase2}/${jokerCase3}`);

console.log(`ok - ${N} random (mask, dice) pairs: legalPts() EXACTLY matches potentials()`);
console.log(`     coverage: non-joker=${nonJoker}, joker case1(forced upper)=${jokerCase1},`
  + ` case2(lower)=${jokerCase2}, case3(zero upper)=${jokerCase3}, yahtzee rolls=${yahtzeeRolls}`);
