// solver/verify-endgame.js
// INDEPENDENT endgame verification of strategy.bin (SOLVER.md §6, review phase).
//
// From-scratch recursive expectimax for widgets with popcount(mask) >= 11:
// per keep, the reroll is evaluated by DIRECT ENUMERATION of outcome multisets
// with multinomial weights — deliberately a DIFFERENT algorithm from solve.js
// (no keep-multiset lattice, no children[] fill-down, no one-die-at-a-time
// expectation, no code shared with the sweep). Allowed reuse:
//   - states.js: idOf ONLY (the strategy.bin index contract being verified)
//   - public/shared/game.js: potentials()/CATS — the app's AUTHORITATIVE rule
//     function, used directly as the legality/points oracle (solve.js instead
//     reimplements it; using the original here makes the check end-to-end).
// Everything else — multiset enumeration, probabilities, rewards/bonuses,
// upper-total reachability, the recursion itself — is implemented here.
//
// Checks:
//   ~500 sampled widgets with popcount >= 11 (incl. joker-relevant ones:
//   bit 11 set, BOTH yz values for the same (mask, up)), plus terminal
//   (popcount 13) widgets that must be exactly 0.
//   PASS iff max relative error vs strategy.bin < 1e-6 and terminals are 0.
//
// Run: node solver/verify-endgame.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { idOf } from './states.js';
import { potentials, CATS } from '../public/shared/game.js';

const FULL_MASK = 0x1fff;
const YZ_BIT = 1 << 11;
const NUM_CATS = 13;
const REL_TOL = 1e-6;

// ---------------------------------------------------------------------------
// Load the solved table
// ---------------------------------------------------------------------------

const dir = path.dirname(fileURLToPath(import.meta.url));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'strategy-meta.json'), 'utf8'));
const rawBin = fs.readFileSync(path.join(dir, 'strategy.bin'));
if (rawBin.byteLength !== meta.byteLength) {
  console.error(`FAIL: strategy.bin is ${rawBin.byteLength} bytes, meta says ${meta.byteLength}`);
  process.exit(1);
}
const V32 = new Float32Array(rawBin.buffer.slice(rawBin.byteOffset, rawBin.byteOffset + rawBin.byteLength));
if (V32.length !== meta.widgetCount) {
  console.error(`FAIL: table holds ${V32.length} floats, meta.widgetCount = ${meta.widgetCount}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Independent multiset machinery (no tables.js)
// ---------------------------------------------------------------------------

const FACT = [1, 1, 2, 6, 24, 120];

/** All non-decreasing tuples of faces 1..6 with the given length. */
function enumSorted(size) {
  const out = [];
  const cur = [];
  (function go(minFace) {
    if (cur.length === size) { out.push(cur.slice()); return; }
    for (let f = minFace; f <= 6; f++) { cur.push(f); go(f); cur.pop(); }
  })(1);
  return out;
}

/** Number of ordered arrangements of a face multiset: n! / prod(count_f!). */
function permsOf(faces) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const f of faces) counts[f]++;
  let denom = 1;
  for (let f = 1; f <= 6; f++) denom *= FACT[counts[f]];
  return FACT[faces.length] / denom;
}

const rolls = enumSorted(5);
const NUM_ROLLS = rolls.length;
if (NUM_ROLLS !== 252) { console.error(`FAIL: enumerated ${NUM_ROLLS} rolls, expected 252`); process.exit(1); }
const rollIdxByKey = new Map(rolls.map((r, i) => [r.join(','), i]));

const rollProb = new Float64Array(NUM_ROLLS);
{
  let s = 0;
  for (let r = 0; r < NUM_ROLLS; r++) { rollProb[r] = permsOf(rolls[r]) / 7776; s += rollProb[r]; }
  if (Math.abs(s - 1) > 1e-12) { console.error(`FAIL: roll probabilities sum to ${s}`); process.exit(1); }
}

const rollIsYah = new Uint8Array(NUM_ROLLS);
for (let r = 0; r < NUM_ROLLS; r++) rollIsYah[r] = rolls[r][0] === rolls[r][4] ? 1 : 0;

// All 462 keep multisets (sizes 0..5) with their reroll-outcome distribution:
// keeping k means rerolling 5-|k| dice; outcomes are enumerated as multisets
// with weight (#ordered sequences) / 6^(5-|k|), merged back into a full roll.
const keepFaces = [];
for (let s = 0; s <= 5; s++) keepFaces.push(...enumSorted(s));
const NUM_KEEPS = keepFaces.length;
if (NUM_KEEPS !== 462) { console.error(`FAIL: enumerated ${NUM_KEEPS} keeps, expected 462`); process.exit(1); }
const keepIdxByKey = new Map(keepFaces.map((k, i) => [k.join(','), i]));

const keepOutRoll = new Array(NUM_KEEPS); // Int32Array of merged roll indices
const keepOutProb = new Array(NUM_KEEPS); // Float64Array of outcome probabilities
for (let k = 0; k < NUM_KEEPS; k++) {
  const kept = keepFaces[k];
  const m = 5 - kept.length;
  const outcomes = enumSorted(m);
  const idxs = new Int32Array(outcomes.length);
  const probs = new Float64Array(outcomes.length);
  const denom = Math.pow(6, m);
  let s = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const merged = kept.concat(outcomes[i]).sort((a, b) => a - b);
    idxs[i] = rollIdxByKey.get(merged.join(','));
    probs[i] = permsOf(outcomes[i]) / denom;
    s += probs[i];
  }
  if (Math.abs(s - 1) > 1e-12) { console.error(`FAIL: keep [${kept}] outcome probs sum to ${s}`); process.exit(1); }
  keepOutRoll[k] = idxs;
  keepOutProb[k] = probs;
}

// Distinct sub-multiset keeps of each roll via the 32 position subsets,
// deduplicated — necessarily includes keep-all (stand pat) and ∅ (reroll all).
const keepsOfRoll = new Array(NUM_ROLLS);
for (let r = 0; r < NUM_ROLLS; r++) {
  const faces = rolls[r];
  const seen = new Set();
  const list = [];
  for (let bits = 0; bits < 32; bits++) {
    const kept = [];
    for (let i = 0; i < 5; i++) if ((bits >> i) & 1) kept.push(faces[i]);
    const key = kept.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(keepIdxByKey.get(key));
  }
  keepsOfRoll[r] = Int32Array.from(list);
}

// ---------------------------------------------------------------------------
// Legality & points oracle: game.js potentials() per (mask, roll), cached per
// mask (legality and pts never depend on up/yz; potentials only null-checks
// the yahtzee box, so filled → 0 is a faithful cardFromMask).
// ---------------------------------------------------------------------------

const movesCache = new Map();
function movesFor(mask) {
  let mv = movesCache.get(mask);
  if (mv) return mv;
  const card = {};
  for (let c = 0; c < NUM_CATS; c++) card[CATS[c]] = ((mask >> c) & 1) ? 0 : null;
  const cats = [];
  const pts = [];
  const off = new Int32Array(NUM_ROLLS + 1);
  let n = 0;
  for (let r = 0; r < NUM_ROLLS; r++) {
    off[r] = n;
    const pot = potentials(card, rolls[r]);
    for (let c = 0; c < NUM_CATS; c++) {
      const e = pot[CATS[c]];
      if (e && e.allowed) { cats.push(c); pts.push(e.pts); n++; }
    }
    if (n === off[r]) { console.error(`FAIL: no legal move for mask=${mask} roll=[${rolls[r]}]`); process.exit(1); }
  }
  off[NUM_ROLLS] = n;
  mv = { cats: Uint8Array.from(cats), pts: Uint8Array.from(pts), off };
  movesCache.set(mask, mv);
  return mv;
}

// ---------------------------------------------------------------------------
// Recursive expectimax
//   widgetValue(w) = Σ_d P(d) · best2(d)
//   best2(d) = max( over keeps k ⊆ d : Σ_o P(o) · best1(k∪o) )   [k=d → best1(d)]
//   best1(d) = max( over keeps k ⊆ d : Σ_o P(o) · S(k∪o) )       [k=d → S(d)]
//   S(d)     = max over LEGAL cats of pts + 35·(upper-bonus crossing)
//              + 100·(extra-Yahtzee: roll is Yahtzee ∧ bit11 set ∧ yz=1)
//              + widgetValue(successor)
// Rewards/transitions mirror game.js PlayerState.scoreCategory semantics.
// ---------------------------------------------------------------------------

const memo = new Float64Array(V32.length).fill(NaN);
let turnsComputed = 0;

function bestAfterReroll(base) {
  const out = new Float64Array(NUM_ROLLS);
  for (let r = 0; r < NUM_ROLLS; r++) {
    const ks = keepsOfRoll[r];
    let best = -Infinity;
    for (let t = 0; t < ks.length; t++) {
      const k = ks[t];
      const idxs = keepOutRoll[k];
      const probs = keepOutProb[k];
      let e = 0;
      for (let i = 0; i < idxs.length; i++) e += probs[i] * base[idxs[i]];
      if (e > best) best = e;
    }
    out[r] = best;
  }
  return out;
}

function widgetValue(mask, up, yz) {
  if (mask === FULL_MASK) return 0;
  const id = idOf(mask, up, yz);
  if (id < 0) throw new Error(`states.js disagrees on reachability: mask=${mask} up=${up} yz=${yz}`);
  const hit = memo[id];
  if (!Number.isNaN(hit)) return hit;

  const mv = movesFor(mask);
  const sNow = new Float64Array(NUM_ROLLS);
  for (let r = 0; r < NUM_ROLLS; r++) {
    const b100 = (rollIsYah[r] === 1 && (mask & YZ_BIT) !== 0 && yz === 1) ? 100 : 0;
    let best = -Infinity;
    const end = mv.off[r + 1];
    for (let j = mv.off[r]; j < end; j++) {
      const c = mv.cats[j];
      const p = mv.pts[j];
      const m2 = mask | (1 << c);
      let up2 = up;
      let yz2 = yz;
      let reward = p + b100;
      if (c < 6) {
        const raw = up + p;
        if (up < 63 && raw >= 63) reward += 35;   // upper bonus on the crossing
        up2 = raw > 63 ? 63 : raw;
      } else if (c === 11 && p === 50) {
        yz2 = 1;                                  // Yahtzee box filled with 50
      }
      const v = reward + widgetValue(m2, up2, yz2);
      if (v > best) best = v;
    }
    sNow[r] = best;
  }
  const b1 = bestAfterReroll(sNow);
  const b2 = bestAfterReroll(b1);
  let v = 0;
  for (let r = 0; r < NUM_ROLLS; r++) v += rollProb[r] * b2[r];
  memo[id] = v;
  turnsComputed++;
  return v;
}

// ---------------------------------------------------------------------------
// Sampling: ~500 widgets with popcount >= 11
// ---------------------------------------------------------------------------

function popcount(x) { let c = 0; while (x !== 0) { x &= x - 1; c++; } return c; }

/** Independent reachable upper totals: raw subset sums, capped at 63 at the end. */
function reachableUps(mask) {
  let sums = new Set([0]);
  for (let f = 1; f <= 6; f++) {
    if (((mask >> (f - 1)) & 1) === 0) continue;
    const next = new Set();
    for (const s of sums) for (let m = 0; m <= 5; m++) next.add(s + m * f);
    sums = next;
  }
  const capped = new Set();
  for (const s of sums) capped.add(s > 63 ? 63 : s);
  return Array.from(capped).sort((a, b) => a - b);
}

// Deterministic LCG for reproducible sampling. Default seed is fixed;
// `node solver/verify-endgame.js --seed <uint32>` draws a different sample.
let seed = 0x7ec1a5e5 >>> 0;
{
  const i = process.argv.indexOf('--seed');
  if (i !== -1 && process.argv[i + 1] !== undefined) {
    const s = Number(process.argv[i + 1]) >>> 0;
    if (!Number.isFinite(Number(process.argv[i + 1]))) {
      console.error(`FAIL: bad --seed ${process.argv[i + 1]}`);
      process.exit(1);
    }
    seed = s;
    console.log(`using sampling seed ${s}`);
  }
}
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const rndInt = n => Math.floor(rnd() * n);

const pool11 = [];        // popcount 11 widgets
const pool12 = [];        // popcount 12 widgets
const jokerPairs11 = [];  // popcount 11, bit 11 set: [mask, up] (both yz values exist)
for (let mask = 0; mask < 8192; mask++) {
  const pc = popcount(mask);
  if (pc !== 11 && pc !== 12) continue;
  const pool = pc === 11 ? pool11 : pool12;
  const ups = reachableUps(mask);
  for (const up of ups) {
    pool.push([mask, up, 0]);
    if ((mask & YZ_BIT) !== 0) {
      pool.push([mask, up, 1]);
      if (pc === 11) jokerPairs11.push([mask, up]);
    }
  }
}

const samples = [];
const chosen = new Set();
function addSample(mask, up, yz) {
  const id = idOf(mask, up, yz);
  if (id < 0) throw new Error(`sample not indexable: mask=${mask} up=${up} yz=${yz}`);
  if (chosen.has(id)) return false;
  chosen.add(id);
  samples.push([mask, up, yz]);
  return true;
}

// 1) 25 forced joker PAIRS (same mask & up, yz=0 AND yz=1) → 50 widgets.
{
  let pairs = 0;
  while (pairs < 25 && jokerPairs11.length > 0) {
    const [mask, up] = jokerPairs11[rndInt(jokerPairs11.length)];
    const added0 = addSample(mask, up, 0);
    const added1 = addSample(mask, up, 1);
    if (added0 || added1) pairs++;
  }
}
// 2) random popcount-11 widgets up to 390 total samples
while (samples.length < 390) {
  const [mask, up, yz] = pool11[rndInt(pool11.length)];
  addSample(mask, up, yz);
}
// 3) random popcount-12 widgets up to 500 total samples
while (samples.length < 500) {
  const [mask, up, yz] = pool12[rndInt(pool12.length)];
  addSample(mask, up, yz);
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

console.log(`verify-endgame: ${samples.length} sampled widgets (popcount 11/12), `
  + `${jokerPairs11.length} joker pairs available in population`);
const t0 = Date.now();

let maxRel = 0;
let worst = null;
let jokerYz1 = 0;
let jokerBit11 = 0;
for (let i = 0; i < samples.length; i++) {
  const [mask, up, yz] = samples[i];
  const vRec = widgetValue(mask, up, yz);
  const vBin = V32[idOf(mask, up, yz)];
  const rel = Math.abs(vBin - vRec) / Math.max(Math.abs(vRec), 1e-9);
  if (rel > maxRel) { maxRel = rel; worst = { mask, up, yz, vRec, vBin }; }
  if ((mask & YZ_BIT) !== 0) { jokerBit11++; if (yz === 1) jokerYz1++; }
  if ((i + 1) % 100 === 0) {
    console.log(`  ${i + 1}/${samples.length} compared  (max rel err so far ${maxRel.toExponential(3)}, `
      + `${turnsComputed} widget-turns solved, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

// Terminal widgets (popcount 13): V must be exactly 0.
let terminalsChecked = 0;
let terminalBad = 0;
for (const up of reachableUps(FULL_MASK)) {
  for (const yz of [0, 1]) {
    if (rnd() < 0.15) {
      const v = V32[idOf(FULL_MASK, up, yz)];
      terminalsChecked++;
      if (v !== 0) { terminalBad++; console.error(`  terminal V != 0: up=${up} yz=${yz} v=${v}`); }
    }
  }
}

const elapsed = (Date.now() - t0) / 1000;
console.log(`\ncompared ${samples.length} widgets in ${elapsed.toFixed(1)}s `
  + `(${turnsComputed} distinct widget-turns solved recursively, ${movesCache.size} mask rule-tables)`);
console.log(`coverage: bit11-set samples = ${jokerBit11}, of which yz=1 = ${jokerYz1}`);
console.log(`terminal (popcount 13) widgets checked = ${terminalsChecked}, nonzero = ${terminalBad}`);
console.log(`max relative error vs strategy.bin = ${maxRel.toExponential(6)}  (tolerance ${REL_TOL})`);
if (worst) {
  console.log(`worst: mask=${worst.mask.toString(2).padStart(13, '0')} up=${worst.up} yz=${worst.yz}  `
    + `brute=${worst.vRec.toFixed(9)}  table=${worst.vBin.toFixed(9)}`);
}

if (maxRel < REL_TOL && terminalBad === 0) {
  console.log(`\nok - independent endgame expectimax matches strategy.bin (max rel err < ${REL_TOL})`);
  process.exit(0);
} else {
  console.error('\nFAIL - strategy.bin disagrees with the independent expectimax');
  process.exit(1);
}
