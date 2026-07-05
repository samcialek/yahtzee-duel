// solver/states.js
// Widget enumeration & dense indexing for the exact Yahtzee solver (SOLVER.md §1, §4).
// PURE ESM — no Node APIs; produces identical indexing in Node and the browser.
//
// Widget = (mask, up, yz):
//   mask — 13 bits, bit i set ⇔ CATS[i] is filled (order from public/shared/game.js:
//          ones=bit0 … sixes=bit5, threeKind=6, fourKind=7, fullHouse=8,
//          smallStraight=9, largeStraight=10, yahtzee=11, chance=12).
//   up   — upper-section subtotal capped at 63; only subset-sum-reachable values exist
//          per mask (each filled upper face f contributes {0, f, 2f, 3f, 4f, 5f}; any
//          raw sum >= 63 collapses into 63).
//   yz   — 1 ⇔ the Yahtzee box holds 50. The yz dimension exists only when bit 11 is
//          set; widgets with bit 11 clear have only yz = 0.
//
// Dense-id FILE FORMAT contract (index order of strategy.bin — do not change):
//   masks 0..8191 ascending; within a mask, reachable up values ascending; within a
//   (mask, up) pair, yz = 0 then yz = 1 (the yz slot exists only when bit 11 is set).

const MASK_COUNT = 8192; // 2^13
const YZ_BIT = 1 << 11;  // yahtzee category bit
const UP_MAX = 63;       // upper subtotal cap

// ---------------------------------------------------------------------------
// Reachable `up` sets per upper submask (subset-sum DP, capped at 63).
// Only the low 6 bits of a mask matter, so compute the 64 distinct sets once
// and share the (frozen) arrays across all masks with the same upper bits.
// Capping partial sums at 63 is equivalent to capping the raw total: once a
// partial sum reaches >= 63 every extension also does, and sums < 63 are
// unaffected by the cap.
// ---------------------------------------------------------------------------

const upListByUpper = new Array(64); // upper submask -> frozen ascending array of up values
for (let u6 = 0; u6 < 64; u6++) {
  let reach = new Uint8Array(UP_MAX + 1);
  reach[0] = 1;
  for (let face = 1; face <= 6; face++) {
    if (((u6 >> (face - 1)) & 1) === 0) continue;
    const next = new Uint8Array(UP_MAX + 1);
    for (let s = 0; s <= UP_MAX; s++) {
      if (reach[s] === 0) continue;
      for (let m = 0; m <= 5; m++) {
        const t = s + m * face;
        next[t > UP_MAX ? UP_MAX : t] = 1;
      }
    }
    reach = next;
  }
  const list = [];
  for (let s = 0; s <= UP_MAX; s++) if (reach[s] === 1) list.push(s);
  upListByUpper[u6] = Object.freeze(list);
}

// ---------------------------------------------------------------------------
// Dense id packing.
//   base[mask]            — first widget id of `mask` (Int32Array[8192])
//   upPos[mask*64 + up]   — position of `up` in the mask's ascending up list,
//                           or -1 when (mask, up) is unreachable (Int8Array;
//                           positions are 0..63 so Int8 suffices)
//   stride per (mask, up) — 2 when bit 11 is set (yz 0/1), else 1
//   id = base[mask] + upPos * stride + yz
// ---------------------------------------------------------------------------

const base = new Int32Array(MASK_COUNT);
const upPos = new Int8Array(MASK_COUNT * 64).fill(-1);

let nextId = 0;
for (let mask = 0; mask < MASK_COUNT; mask++) {
  base[mask] = nextId;
  const list = upListByUpper[mask & 63];
  const rowOff = mask << 6;
  for (let p = 0; p < list.length; p++) upPos[rowOff + list[p]] = p;
  nextId += list.length * ((mask & YZ_BIT) !== 0 ? 2 : 1);
}

/** Total number of reachable widgets; strategy.bin holds exactly this many Float32s. */
export const count = nextId;

function checkMask(mask) {
  if (!Number.isInteger(mask) || mask < 0 || mask >= MASK_COUNT) {
    throw new RangeError(`mask out of range [0, ${MASK_COUNT}): ${mask}`);
  }
}

/**
 * Dense widget id of (mask, up, yz), O(1).
 * Returns -1 when `up` is not reachable for `mask`.
 * Throws RangeError on out-of-range arguments or yz=1 with bit 11 clear.
 */
export function idOf(mask, up, yz) {
  checkMask(mask);
  if (!Number.isInteger(up) || up < 0 || up > UP_MAX) {
    throw new RangeError(`up out of range [0, ${UP_MAX}]: ${up}`);
  }
  if (yz !== 0 && yz !== 1) {
    throw new RangeError(`yz must be 0 or 1: ${yz}`);
  }
  const hasYz = (mask & YZ_BIT) !== 0;
  if (yz === 1 && !hasYz) {
    throw new RangeError(`yz=1 invalid for mask ${mask} (yahtzee bit 11 clear)`);
  }
  const pos = upPos[(mask << 6) | up];
  if (pos < 0) return -1;
  return hasYz ? base[mask] + pos * 2 + yz : base[mask] + pos;
}

/**
 * Ascending, frozen array of reachable up values for `mask`.
 * Shared across masks with identical upper bits — do not mutate.
 */
export function upListOf(mask) {
  checkMask(mask);
  return upListByUpper[mask & 63];
}

/** True iff the yz dimension exists for `mask` (yahtzee category filled, bit 11 set). */
export function hasYzDim(mask) {
  checkMask(mask);
  return (mask & YZ_BIT) !== 0;
}

// ---------------------------------------------------------------------------
// Solve-order iteration: all 8192 masks sorted by popcount DESCENDING (13 -> 0);
// within a popcount group, masks ascend. Scoring always sets a new bit, so every
// successor of a mask lies in an earlier group.
// ---------------------------------------------------------------------------

function popcount(x) {
  let c = 0;
  while (x !== 0) { x &= x - 1; c++; }
  return c;
}

export const masksByPopcountDesc = Object.freeze((() => {
  const groups = Array.from({ length: 14 }, () => []);
  for (let mask = 0; mask < MASK_COUNT; mask++) groups[popcount(mask)].push(mask);
  const flat = [];
  for (let p = 13; p >= 0; p--) for (const m of groups[p]) flat.push(m);
  return flat;
})());

/**
 * Invoke cb(id, up, yz) for every widget of `mask`, in dense-id order
 * (up ascending; yz 0 then 1 when the yz dimension exists). Ids of a mask are
 * contiguous starting at the mask's base.
 */
export function forEachWidgetOfMask(mask, cb) {
  checkMask(mask);
  const list = upListByUpper[mask & 63];
  let id = base[mask];
  if ((mask & YZ_BIT) !== 0) {
    for (let p = 0; p < list.length; p++) {
      const up = list[p];
      cb(id++, up, 0);
      cb(id++, up, 1);
    }
  } else {
    for (let p = 0; p < list.length; p++) {
      cb(id++, list[p], 0);
    }
  }
}
