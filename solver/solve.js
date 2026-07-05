// solver/solve.js
// Exact retrograde value-iteration sweep for the Yahtzee solver (SOLVER.md §1–§3).
//
// Run:   node solver/solve.js            — full solve; writes solver/strategy.bin +
//                                          solver/strategy-meta.json and copies both
//                                          into public/
//        node solver/solve.js --bench    — time popcount layers 13..10, project the
//                                          full solve duration, exit without writing
//
// Node-only module, but importing it has no side effects beyond precomputing
// in-memory tables: the sweep runs only when this file is executed directly, so
// test-rules.js can import legalPts() — the EXACT legality+points code the sweep
// uses — without triggering a solve.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NUM_KEEPS, NUM_ROLLS, ROLL_OFFSET, NUM_CATS,
  childrenFlat, subsets, catScoresFlat, isYahtzeeArr, yahtzeeFace,
} from './tables.js';
import {
  count as WIDGET_COUNT, idOf, upListOf, masksByPopcountDesc,
} from './states.js';

const YZ_BIT = 1 << 11;      // yahtzee category bit in the mask
const FULL_MASK = 0x1fff;    // all 13 categories filled
const SIXTH = 1 / 6;
const TARGET_EV = 254.5896;  // Verhoeff 1999 / Glenn 2006 (SOLVER.md §0)
const EV_TOL = 0.02;

// Lower-section bits excluding yahtzee: threeKind..largeStraight, chance
const LOWER_NOY_BITS = (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 12);

// ---------------------------------------------------------------------------
// §3 legality & points — the ONE function encoding the scoring rules.
// The sweep consumes its output for every (mask, roll); test-rules.js pins it
// to game.js potentials() by exact comparison on random (mask, dice) pairs.
// ---------------------------------------------------------------------------

/**
 * Joker-aware legality and points for scoring roll `rollIdx` (0..251) against
 * `mask` (13-bit filled-categories mask). Fills ptsOut[c] for every OPEN
 * category c — both legal and joker-blocked ones, mirroring game.js
 * potentials() — and returns the 13-bit LEGALITY mask (subset of the open bits).
 *
 * @param {number} mask     13-bit filled mask (bit c set ⇔ CATS[c] filled)
 * @param {number} rollIdx  roll ordinal 0..251 (multiset index − ROLL_OFFSET)
 * @param {Int32Array|number[]} ptsOut  length ≥ 13; written for open cats only
 * @returns {number} legality bitmask
 */
export function legalPts(mask, rollIdx, ptsOut) {
  const open = (~mask) & FULL_MASK;
  const kIdx = ROLL_OFFSET + rollIdx;
  const row = rollIdx * NUM_CATS;
  if (isYahtzeeArr[kIdx] === 0 || (mask & YZ_BIT) === 0) {
    // Non-joker: every open category is legal at its raw scoreCat value.
    for (let c = 0; c < NUM_CATS; c++) {
      if ((open >> c) & 1) ptsOut[c] = catScoresFlat[row + c];
    }
    return open;
  }
  // Joker: dice are a Yahtzee and the yahtzee box is already filled (50 OR 0).
  const face = yahtzeeFace[kIdx];
  const s5 = face * 5;
  for (let c = 0; c < NUM_CATS; c++) {
    if (((open >> c) & 1) === 0) continue;
    let p;
    if (c < 6) p = (c === face - 1) ? s5 : 0;      // only the matching upper box pays
    else if (c === 8) p = 25;                       // fullHouse
    else if (c === 9) p = 30;                       // smallStraight
    else if (c === 10) p = 40;                      // largeStraight
    else p = s5;                                    // threeKind / fourKind / chance
    ptsOut[c] = p;
  }
  const upBit = 1 << (face - 1);
  if ((open & upBit) !== 0) return upBit;           // 1) forced into the matching upper box
  const lowerOpen = open & LOWER_NOY_BITS;
  if (lowerOpen !== 0) return lowerOpen;            // 2) else any open lower box, joker values
  return open;                                      // 3) else zero any remaining upper box
}

// ---------------------------------------------------------------------------
// Static precomputed tables (built once at import; nothing allocated per widget)
// ---------------------------------------------------------------------------

// Flattened sub-multiset lists: subFlat[subOff[r] .. subOff[r+1]-1] are the
// distinct sub-multiset indices of roll r (includes the roll itself = stand
// pat, and index 0 = reroll everything).
const subOff = new Int32Array(NUM_ROLLS + 1);
{
  let n = 0;
  for (let r = 0; r < NUM_ROLLS; r++) { subOff[r] = n; n += subsets[ROLL_OFFSET + r].length; }
  subOff[NUM_ROLLS] = n;
}
const subFlat = new Int32Array(subOff[NUM_ROLLS]);
for (let r = 0; r < NUM_ROLLS; r++) subFlat.set(subsets[ROLL_OFFSET + r], subOff[r]);

// Per-roll yahtzee flag (roll ordinal indexed).
const yFlagRoll = new Uint8Array(NUM_ROLLS);
for (let r = 0; r < NUM_ROLLS; r++) yFlagRoll[r] = isYahtzeeArr[ROLL_OFFSET + r];

// Upper-category pts → dice count (pts = cnt * face, exact): ptsToCnt[c*51 + pts].
const ptsToCnt = new Int8Array(6 * 51);
for (let c = 0; c < 6; c++) {
  for (let cnt = 0; cnt <= 5; cnt++) ptsToCnt[c * 51 + cnt * (c + 1)] = cnt;
}

// Dense-id packing mirrors, derived from the states.js public API so the hot
// loops use pure integer arithmetic instead of function calls:
//   id = baseId[mask] + upPosArr[(mask<<6)|up] * strideArr[mask] + yz
const baseId = new Int32Array(8192);
const upPosArr = new Int8Array(8192 * 64).fill(-1);
const strideArr = new Uint8Array(8192);
for (let mask = 0; mask < 8192; mask++) {
  const list = upListOf(mask);
  baseId[mask] = idOf(mask, list[0], 0);
  const off = mask << 6;
  for (let p = 0; p < list.length; p++) upPosArr[off + list[p]] = p;
  strideArr[mask] = (mask & YZ_BIT) !== 0 ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Preallocated solve buffers (SOLVER.md §2 performance notes)
// ---------------------------------------------------------------------------

const V = new Float64Array(WIDGET_COUNT);          // accumulate in float64
const latA = new Float64Array(NUM_KEEPS);          // lattice buffer (A2 / A0)
const latB = new Float64Array(NUM_KEEPS);          // lattice buffer (A1)
const upVal = new Float64Array(36);                // [upperCat*6 + count] → pts+bonus+V(succ)
const lowVal = new Float64Array(13);               // [lowerCat] → V(succ); pts added per roll
const movesCat = new Uint8Array(NUM_ROLLS * NUM_CATS); // per-mask legal (cat, pts) pairs,
const movesPts = new Uint8Array(NUM_ROLLS * NUM_CATS); //   flattened across the 252 rolls
const movesOff = new Int32Array(NUM_ROLLS + 1);
const ptsScratch = new Int32Array(NUM_CATS);

// Build the per-mask legal-move table (legality+pts depend only on the mask,
// never on up/yz, so this is shared by every widget of the mask).
function buildMoves(mask) {
  let n = 0;
  for (let r = 0; r < NUM_ROLLS; r++) {
    movesOff[r] = n;
    const legal = legalPts(mask, r, ptsScratch);
    for (let c = 0; c < NUM_CATS; c++) {
      if ((legal >> c) & 1) { movesCat[n] = c; movesPts[n] = ptsScratch[c]; n++; }
    }
  }
  movesOff[NUM_ROLLS] = n;
}

// ---------------------------------------------------------------------------
// Per-mask widget sweep: S over 252 rolls → A2 → Best2 → A1 → Best1 → A0.
// Returns the number of widgets processed.
// ---------------------------------------------------------------------------

function processMask(mask) {
  buildMoves(mask);
  const upList = upListOf(mask);
  const hasYz = (mask & YZ_BIT) !== 0;
  const yzMax = hasYz ? 1 : 0;
  let id = baseId[mask];

  for (let pi = 0; pi < upList.length; pi++) {
    const up = upList[pi];
    for (let yz = 0; yz <= yzMax; yz++, id++) {

      // ---- per-widget successor values (SOLVER.md §1 reward) ----
      // Upper categories: upVal[c*6+cnt] = pts + 35·(bonus crossing) + V(mask|bit, up', yz)
      for (let c = 0; c < 6; c++) {
        if ((mask >> c) & 1) continue;
        const f = c + 1;
        const m2 = mask | (1 << c);
        const b2 = baseId[m2], st2 = strideArr[m2], row2 = m2 << 6;
        for (let cnt = 0; cnt <= 5; cnt++) {
          const pts = cnt * f;
          const raw = up + pts;
          const bonus = (up < 63 && raw >= 63) ? 35 : 0;   // fires exactly on the crossing
          const up2 = raw > 63 ? 63 : raw;
          upVal[c * 6 + cnt] = pts + bonus + V[b2 + upPosArr[row2 + up2] * st2 + yz];
        }
      }
      // Lower categories except yahtzee: successor keeps (up, yz); pts added per roll.
      for (let c = 6; c < 13; c++) {
        if (c === 11 || ((mask >> c) & 1)) continue;
        const m2 = mask | (1 << c);
        lowVal[c] = V[baseId[m2] + upPosArr[(m2 << 6) + up] * strideArr[m2] + yz];
      }
      // Yahtzee category (only open when bit 11 clear, hence current yz = 0):
      //   scored with 50 → yz' = 1;   scored with 0 → yz' = 0.
      let y50 = 0, y0 = 0;
      if (!hasYz) {
        const m2 = mask | YZ_BIT;
        const b = baseId[m2] + upPosArr[(m2 << 6) + up] * 2;
        y0 = V[b];
        y50 = 50 + V[b + 1];
      }
      // Extra-Yahtzee +100: iff the roll is a Yahtzee, bit 11 set, and yz === 1;
      // applies regardless of which category is scored → hoisted out of the max.
      const bonusAdd = (hasYz && yz === 1) ? 100 : 0;

      // ---- S(d) for all 252 rolls: max over legal cats of reward + V(successor) ----
      for (let r = 0; r < NUM_ROLLS; r++) {
        let s = -Infinity;
        const e = movesOff[r + 1];
        for (let j = movesOff[r]; j < e; j++) {
          const c = movesCat[j];
          const pts = movesPts[j];
          let v;
          if (c < 6) v = upVal[c * 6 + ptsToCnt[c * 51 + pts]];
          else if (c === 11) v = pts === 50 ? y50 : y0;
          else v = pts + lowVal[c];
          if (v > s) s = v;
        }
        if (bonusAdd !== 0 && yFlagRoll[r] !== 0) s += bonusAdd;
        latA[ROLL_OFFSET + r] = s;
      }

      // ---- A2: lattice fill-down with Base = S (children have higher indices) ----
      for (let k = ROLL_OFFSET - 1; k >= 0; k--) {
        const o = k * 6;
        latA[k] = (latA[childrenFlat[o]] + latA[childrenFlat[o + 1]] + latA[childrenFlat[o + 2]]
                 + latA[childrenFlat[o + 3]] + latA[childrenFlat[o + 4]] + latA[childrenFlat[o + 5]]) * SIXTH;
      }
      // ---- Best2(d) = max over sub-multisets k ⊆ d of A2(k) (incl. k=d, k=∅) ----
      for (let r = 0; r < NUM_ROLLS; r++) {
        let m = -Infinity;
        const e = subOff[r + 1];
        for (let j = subOff[r]; j < e; j++) { const v = latA[subFlat[j]]; if (v > m) m = v; }
        latB[ROLL_OFFSET + r] = m;
      }
      // ---- A1: lattice with Base = Best2 ----
      for (let k = ROLL_OFFSET - 1; k >= 0; k--) {
        const o = k * 6;
        latB[k] = (latB[childrenFlat[o]] + latB[childrenFlat[o + 1]] + latB[childrenFlat[o + 2]]
                 + latB[childrenFlat[o + 3]] + latB[childrenFlat[o + 4]] + latB[childrenFlat[o + 5]]) * SIXTH;
      }
      // ---- Best1(d) = max over k ⊆ d of A1(k) ----
      for (let r = 0; r < NUM_ROLLS; r++) {
        let m = -Infinity;
        const e = subOff[r + 1];
        for (let j = subOff[r]; j < e; j++) { const v = latB[subFlat[j]]; if (v > m) m = v; }
        latA[ROLL_OFFSET + r] = m;
      }
      // ---- A0: lattice with Base = Best1; V(widget) = A0(∅) ----
      for (let k = ROLL_OFFSET - 1; k >= 0; k--) {
        const o = k * 6;
        latA[k] = (latA[childrenFlat[o]] + latA[childrenFlat[o + 1]] + latA[childrenFlat[o + 2]]
                 + latA[childrenFlat[o + 3]] + latA[childrenFlat[o + 4]] + latA[childrenFlat[o + 5]]) * SIXTH;
      }
      V[id] = latA[0];
    }
  }
  return upList.length * (yzMax + 1);
}

// ---------------------------------------------------------------------------
// Sweep driver: masks in popcount-DESCENDING order (all successors solved first)
// ---------------------------------------------------------------------------

function popcount(x) {
  let c = 0;
  while (x !== 0) { x &= x - 1; c++; }
  return c;
}

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '?';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function runSweep({ benchMinPop = -1 } = {}) {
  const t0 = Date.now();
  const total = WIDGET_COUNT;
  const order = masksByPopcountDesc;
  let done = 0;
  let nextLog = 0.05;
  for (let i = 0; i < order.length; i++) {
    const mask = order[i];
    if (benchMinPop >= 0 && popcount(mask) < benchMinPop) break;
    if (mask === FULL_MASK) {
      // Terminal widgets: V = 0 (Float64Array is zero-initialized).
      done += upListOf(mask).length * 2;
      continue;
    }
    done += processMask(mask);
    if (benchMinPop < 0 && done / total >= nextLog) {
      const elapsed = (Date.now() - t0) / 1000;
      const frac = done / total;
      const eta = elapsed * (1 - frac) / frac;
      console.log(`  ${(frac * 100).toFixed(1).padStart(5)}%  ${done}/${total} widgets  elapsed ${fmtTime(elapsed)}  ETA ${fmtTime(eta)}`);
      while (done / total >= nextLog) nextLog += 0.05;
    }
  }
  return { done, seconds: (Date.now() - t0) / 1000 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const bench = process.argv.includes('--bench');
  console.log(`widget count: ${WIDGET_COUNT}`);

  if (bench) {
    const { done, seconds } = runSweep({ benchMinPop: 10 });
    const nsPerWidget = (seconds * 1e9) / done;
    const projectedMin = (nsPerWidget * WIDGET_COUNT) / 1e9 / 60;
    console.log(`bench: ${done} widgets (popcount 13..10) in ${seconds.toFixed(2)}s`
      + `  →  ${(nsPerWidget / 1000).toFixed(1)} µs/widget`
      + `  →  projected full solve ≈ ${projectedMin.toFixed(1)} min`);
    return;
  }

  console.log('solving (popcount 13 → 0)…');
  const { seconds } = runSweep();
  const startEV = V[idOf(0, 0, 0)];
  console.log(`solve complete in ${fmtTime(seconds)} (${seconds.toFixed(1)}s)`);
  console.log(`startEV = ${startEV.toFixed(6)}  (target ${TARGET_EV} ± ${EV_TOL})`);
  if (!(Math.abs(startEV - TARGET_EV) < EV_TOL)) {
    console.error(`FATAL: startEV ${startEV} outside ${TARGET_EV} ± ${EV_TOL} — NOT writing strategy.bin.`
      + ' Investigate per SOLVER.md §8.');
    process.exit(1);
  }

  // Store Float32 (values < 1600 → rel. eps ~1e-7 is plenty).
  const f32 = new Float32Array(WIDGET_COUNT);
  for (let i = 0; i < WIDGET_COUNT; i++) f32[i] = V[i];

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const binPath = path.join(dir, 'strategy.bin');
  const metaPath = path.join(dir, 'strategy-meta.json');
  fs.writeFileSync(binPath, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
  const meta = {
    version: 1,
    widgetCount: WIDGET_COUNT,
    startEV,
    byteLength: f32.byteLength,
    generatedWith: 'node solver/solve.js',
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

  const pub = path.resolve(dir, '..', 'public');
  fs.copyFileSync(binPath, path.join(pub, 'strategy.bin'));
  fs.copyFileSync(metaPath, path.join(pub, 'strategy-meta.json'));

  console.log(`wrote ${binPath} (${f32.byteLength} bytes) + ${metaPath}`);
  console.log(`copied both into ${pub}${path.sep}`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const arg = path.resolve(process.argv[1]);
  return self === arg || self.toLowerCase() === arg.toLowerCase();
})();
if (isMain) main();
