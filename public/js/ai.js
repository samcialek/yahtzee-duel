// public/js/ai.js
// §7 of ARCHITECTURE.md — client-side AI decision-making.
// The whole file is the CANONICAL block, used verbatim.

import { CATS, UPPER, potentials, scoreCat } from '../shared/game.js';

const ZERO_PEN = { yahtzee:10, largeStraight:9, smallStraight:7, fullHouse:5, fourKind:4,
                   threeKind:3, sixes:3, fives:2, fours:1.5, threes:1, twos:0.5, ones:0, chance:2 };

function weighted(cat, pts) {
  let v = pts;
  const face = UPPER.indexOf(cat) + 1;
  if (face > 0 && pts >= face * 3) v += 4;        // 3+ of a face = on pace for the 63 bonus
  if (cat === 'chance') v -= 7;                   // save chance as a late dump slot
  if (pts === 0) v -= ZERO_PEN[cat] ?? 1;         // zeroing valuable boxes hurts more
  return v;
}

function bestMove(card, dice, blocked) {          // best legal category for these dice
  const pot = potentials(card, dice, blocked);    // blocked: opp-claimed cats (Category Claim)
  let cat = null, value = -1e9;
  for (const c in pot) {
    if (!pot[c].allowed) continue;
    const v = weighted(c, pot[c].pts);
    if (v > value) { value = v; cat = c; }
  }
  return { cat, value };
}

export const aiChooseCategory = (ps, blocked) => bestMove(ps.card, ps.dice, blocked).cat;

// Returns { hold: bool[5], stop: bool } — stop means "keep everything, score now".
export function aiChooseHold(ps, blocked, samples = 60) {
  const dice = ps.dice;
  const keepAll = bestMove(ps.card, dice, blocked).value;  // exact, no sampling needed
  let best = { hold: [true,true,true,true,true], stop: true, value: keepAll };
  for (let m = 0; m < 31; m++) {                  // 31 masks with ≥1 reroll (m=31 would be keep-all)
    const hold = [0,1,2,3,4].map(i => !!(m & (1 << i)));
    let tot = 0;
    for (let s = 0; s < samples; s++) {
      const d = dice.map((v, i) => hold[i] ? v : 1 + Math.floor(Math.random() * 6));
      tot += bestMove(ps.card, d, blocked).value;
    }
    const value = tot / samples + (ps.rollsLeft === 2 ? 2 : 0); // second reroll still in hand
    if (value > best.value) best = { hold, stop: false, value };
  }
  return best;
}

// Sudden death (Category Claim): maximize ONE fixed category — brute-force the 32
// hold masks by sampled mean of scoreCat(cat), same machinery as aiChooseHold.
// Returns { hold: bool[5], stop: bool }.
export function aiSuddenHold(ps, cat, samples = 80) {
  const dice = ps.dice;
  let best = { hold: [true,true,true,true,true], stop: true, value: scoreCat(cat, dice) };
  for (let m = 0; m < 31; m++) {
    const hold = [0,1,2,3,4].map(i => !!(m & (1 << i)));
    let tot = 0;
    for (let s = 0; s < samples; s++) {
      const d = dice.map((v, i) => hold[i] ? v : 1 + Math.floor(Math.random() * 6));
      tot += scoreCat(cat, d);
    }
    const value = tot / samples;
    if (value > best.value) best = { hold, stop: false, value };
  }
  return best;
}
