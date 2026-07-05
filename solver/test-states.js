// solver/test-states.js
// Tests for solver/states.js — widget enumeration & dense indexing (SOLVER.md §1, §4).
// Run: node solver/test-states.js

import assert from 'node:assert/strict';
import {
  count,
  idOf,
  upListOf,
  hasYzDim,
  masksByPopcountDesc,
  forEachWidgetOfMask,
} from './states.js';

const MASK_COUNT = 8192;
const YZ_BIT = 1 << 11;

function popcount(x) {
  let c = 0;
  while (x !== 0) { x &= x - 1; c++; }
  return c;
}

// Deterministic RNG for reproducible random-widget sampling.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

// ---------------------------------------------------------------------------
// masksByPopcountDesc: all 8192 masks exactly once, popcount 13 -> 0,
// ascending within each popcount group.
// ---------------------------------------------------------------------------
{
  ok(masksByPopcountDesc.length === MASK_COUNT, 'masksByPopcountDesc covers 8192 masks');
  const seenMask = new Uint8Array(MASK_COUNT);
  let prevPop = 14;
  let prevMask = -1;
  for (const mask of masksByPopcountDesc) {
    assert.ok(Number.isInteger(mask) && mask >= 0 && mask < MASK_COUNT, `mask in range: ${mask}`);
    assert.equal(seenMask[mask], 0, `mask listed once: ${mask}`);
    seenMask[mask] = 1;
    const p = popcount(mask);
    assert.ok(p <= prevPop, `popcount non-increasing at mask ${mask}`);
    if (p === prevPop) {
      assert.ok(mask > prevMask, `masks ascend within popcount group at ${mask}`);
    }
    prevPop = p;
    prevMask = mask;
  }
  ok(seenMask.every((v) => v === 1), 'every mask appears in masksByPopcountDesc');
  ok(masksByPopcountDesc[0] === MASK_COUNT - 1, 'first mask is the full mask (popcount 13)');
  ok(masksByPopcountDesc[MASK_COUNT - 1] === 0, 'last mask is the empty mask (popcount 0)');
}

// ---------------------------------------------------------------------------
// Bijection: cover every widget via masksByPopcountDesc + forEachWidgetOfMask,
// mark a Uint8Array, assert all 1s and total === count. Also record a decode
// table (id -> mask/up/yz) for the successor-closure test, and cross-check
// idOf against the enumerated ids.
// ---------------------------------------------------------------------------
const maskOfId = new Int16Array(count);
const upOfId = new Int8Array(count);
const yzOfId = new Int8Array(count);
{
  const seen = new Uint8Array(count);
  let total = 0;
  for (const mask of masksByPopcountDesc) {
    const list = upListOf(mask);
    let k = 0; // position within this mask's widgets, checks enumeration order
    let prevUp = -1;
    forEachWidgetOfMask(mask, (id, up, yz) => {
      assert.ok(Number.isInteger(id) && id >= 0 && id < count, `id in [0, count): ${id}`);
      assert.equal(seen[id], 0, `id emitted once: ${id}`);
      seen[id] = 1;
      total++;
      assert.equal(idOf(mask, up, yz), id, `idOf matches enumeration for (${mask},${up},${yz})`);
      // Enumeration order: up ascending, yz 0 then 1 (yz slot only when bit 11 set).
      if (hasYzDim(mask)) {
        assert.equal(up, list[k >> 1], 'up order (yz masks)');
        assert.equal(yz, k & 1, 'yz alternates 0,1');
      } else {
        assert.equal(up, list[k], 'up order (non-yz masks)');
        assert.equal(yz, 0, 'yz always 0 when bit 11 clear');
      }
      assert.ok(up > prevUp || (hasYzDim(mask) && up === prevUp && yz === 1), 'up non-decreasing');
      prevUp = up;
      maskOfId[id] = mask;
      upOfId[id] = up;
      yzOfId[id] = yz;
      k++;
    });
    assert.equal(k, list.length * (hasYzDim(mask) ? 2 : 1), `widget count of mask ${mask}`);
  }
  ok(total === count, `enumeration total (${total}) === count (${count})`);
  ok(seen.every((v) => v === 1), 'idOf is a bijection onto [0, count): every id covered');
}

// ---------------------------------------------------------------------------
// Up-list content checks.
// ---------------------------------------------------------------------------
{
  assert.deepEqual([...upListOf(0)], [0], 'mask 0 has only up=0');
  ok(true, 'mask 0 up list');
  assert.deepEqual([...upListOf(1)], [0, 1, 2, 3, 4, 5], '{ones} up list');
  ok(true, '{ones} up list');
  assert.deepEqual([...upListOf(1 << 5)], [0, 6, 12, 18, 24, 30], '{sixes} up list');
  ok(true, '{sixes} up list');
  const full = upListOf(63); // full upper mask
  ok(full[full.length - 1] === 63, 'full upper mask reaches 63');
  assert.deepEqual([...full], Array.from({ length: 64 }, (_, i) => i),
    'full upper mask reaches every up 0..63');
  ok(true, 'full upper mask up list complete');
  // Lower bits do not affect the up list.
  assert.deepEqual([...upListOf((1 << 5) | YZ_BIT | (1 << 12))], [0, 6, 12, 18, 24, 30],
    'lower bits do not change reachable ups');
  ok(true, 'up list ignores lower bits');
  // idOf(0,0,0) is the very first widget.
  ok(idOf(0, 0, 0) === 0, 'widget (0,0,0) has id 0');
}

// ---------------------------------------------------------------------------
// Unreachable (mask, up) pairs return -1; invalid arguments throw.
// ---------------------------------------------------------------------------
{
  ok(idOf(0, 5, 0) === -1, 'mask 0, up 5 unreachable -> -1');
  ok(idOf(0, 63, 0) === -1, 'mask 0, up 63 unreachable -> -1');
  ok(idOf(1 << 5, 1, 0) === -1, '{sixes}, up 1 unreachable -> -1');
  ok(idOf(1, 6, 0) === -1, '{ones}, up 6 unreachable -> -1');
  ok(idOf((1 << 5) | YZ_BIT, 7, 1) === -1, '{sixes,yahtzee}, up 7 unreachable -> -1 (yz=1)');

  assert.throws(() => idOf(0, 0, 1), RangeError, 'yz=1 rejected when bit 11 clear');
  ok(true, 'yz=1 rejected when bit 11 clear (mask 0)');
  assert.throws(() => idOf(1 << 12, 0, 1), RangeError, 'yz=1 rejected: chance filled, bit 11 clear');
  ok(true, 'yz=1 rejected when bit 11 clear (mask 4096)');
  assert.throws(() => idOf(-1, 0, 0), RangeError, 'negative mask throws');
  assert.throws(() => idOf(MASK_COUNT, 0, 0), RangeError, 'mask 8192 throws');
  assert.throws(() => idOf(0, 64, 0), RangeError, 'up 64 throws');
  assert.throws(() => idOf(0, -1, 0), RangeError, 'up -1 throws');
  assert.throws(() => idOf(0, 0, 2), RangeError, 'yz 2 throws');
  assert.throws(() => idOf(0.5, 0, 0), RangeError, 'non-integer mask throws');
  ok(true, 'argument validation throws');

  // yz dimension present and adjacent when bit 11 set.
  ok(hasYzDim(YZ_BIT) === true, 'hasYzDim(bit11) === true');
  ok(hasYzDim(0) === false, 'hasYzDim(0) === false');
  ok(hasYzDim(MASK_COUNT - 1) === true, 'hasYzDim(full mask) === true');
  ok(idOf(YZ_BIT, 0, 1) === idOf(YZ_BIT, 0, 0) + 1, 'yz=1 slot directly follows yz=0');
}

// ---------------------------------------------------------------------------
// Successor closure (SOLVER.md §1 reward/transition rules): for 500 random
// widgets and each open category c:
//   mask' = mask | bit(c)
//   upper c (0..5, face f=c+1): pts ∈ {0, f, 2f, 3f, 4f, 5f} -> up' = min(63, up+pts)
//   yahtzee c (11):             up' = up, yz' = yz || (pts === 50) — check pts 0 and 50
//   other lower c:              up' = up, yz' = yz
// Every successor widget id must be valid (>= 0).
// ---------------------------------------------------------------------------
{
  const rng = mulberry32(0x5EED5);
  const N = 500;
  let checks = 0;
  for (let n = 0; n < N; n++) {
    const id = Math.floor(rng() * count);
    const mask = maskOfId[id];
    const up = upOfId[id];
    const yz = yzOfId[id];
    for (let c = 0; c < 13; c++) {
      if ((mask >> c) & 1) continue; // filled
      const mask2 = mask | (1 << c);
      if (c <= 5) {
        const f = c + 1;
        for (let m = 0; m <= 5; m++) {
          const up2 = Math.min(63, up + m * f);
          const sid = idOf(mask2, up2, yz);
          assert.ok(sid >= 0,
            `upper successor invalid: (${mask},${up},${yz}) cat ${c} pts ${m * f}`);
          checks++;
        }
      } else if (c === 11) {
        // yahtzee open => bit 11 clear => yz === 0 here.
        for (const pts of [0, 50]) {
          const yz2 = yz === 1 || pts === 50 ? 1 : 0;
          const sid = idOf(mask2, up, yz2);
          assert.ok(sid >= 0,
            `yahtzee successor invalid: (${mask},${up},${yz}) pts ${pts}`);
          checks++;
        }
      } else {
        const sid = idOf(mask2, up, yz);
        assert.ok(sid >= 0,
          `lower successor invalid: (${mask},${up},${yz}) cat ${c}`);
        checks++;
      }
    }
  }
  ok(checks > 0, `successor closure: ${checks} transitions from ${N} random widgets all valid`);
}

console.log(`states.js: all assertion groups passed (${passed} checks logged)`);
console.log(`Total widget count: ${count}`);
