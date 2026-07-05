// solver/test-tables.js
// Exhaustive tests for solver/tables.js (SOLVER.md §4).
// Run: node solver/test-tables.js

import assert from 'node:assert/strict';
import {
  NUM_KEEPS, NUM_ROLLS, ROLL_OFFSET, SIZE_COUNTS, SIZE_OFFSETS,
  CAT_ORDER, NUM_CATS,
  indexOfMultiset, facesOf, sizeOf, sizeOfArr,
  children, childrenFlat,
  size5Indices, subsets, catScores, catScoresFlat,
  isYahtzeeArr, yahtzeeFace,
} from './tables.js';
import { scoreCat, CATS, isYahtzee } from '../public/shared/game.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

// ---------------------------------------------------------------------------
ok('constants: totals and size buckets [1,6,21,56,126,252]', () => {
  assert.equal(NUM_KEEPS, 462);
  assert.equal(NUM_ROLLS, 252);
  assert.equal(ROLL_OFFSET, 210);
  assert.deepEqual([...SIZE_COUNTS], [1, 6, 21, 56, 126, 252]);
  assert.deepEqual([...SIZE_OFFSETS], [0, 1, 7, 28, 84, 210]);
  assert.equal(SIZE_COUNTS.reduce((a, b) => a + b, 0), 462);
});

ok('enumeration: exact per-size counts, valid non-decreasing faces, all distinct', () => {
  const bySize = [0, 0, 0, 0, 0, 0];
  const seen = new Set();
  for (let idx = 0; idx < NUM_KEEPS; idx++) {
    const faces = facesOf(idx);
    assert.equal(faces.length, sizeOf(idx));
    assert.equal(sizeOf(idx), sizeOfArr[idx]);
    for (let i = 0; i < faces.length; i++) {
      assert.ok(Number.isInteger(faces[i]) && faces[i] >= 1 && faces[i] <= 6);
      if (i > 0) assert.ok(faces[i - 1] <= faces[i], `non-decreasing at idx ${idx}`);
    }
    const key = faces.join(',');
    assert.ok(!seen.has(key), `duplicate multiset at idx ${idx}: [${key}]`);
    seen.add(key);
    bySize[faces.length]++;
  }
  assert.deepEqual(bySize, [1, 6, 21, 56, 126, 252]);
});

ok('canonical order: size ascending, then lexicographic; offsets correct', () => {
  const lexLess = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  };
  for (let idx = 1; idx < NUM_KEEPS; idx++) {
    const prev = facesOf(idx - 1), cur = facesOf(idx);
    if (prev.length === cur.length) {
      assert.ok(lexLess(prev, cur), `lex order violated at idx ${idx}`);
    } else {
      assert.equal(prev.length + 1, cur.length, `size order violated at idx ${idx}`);
    }
  }
  for (let s = 0; s <= 5; s++) {
    assert.equal(sizeOf(SIZE_OFFSETS[s]), s);
    if (SIZE_OFFSETS[s] > 0) assert.equal(sizeOf(SIZE_OFFSETS[s] - 1), s - 1);
  }
  // spot-check the contract's fixed points
  assert.deepEqual(facesOf(0), []);
  assert.deepEqual(facesOf(1), [1]);
  assert.deepEqual(facesOf(6), [6]);
  assert.deepEqual(facesOf(7), [1, 1]);
  assert.deepEqual(facesOf(210), [1, 1, 1, 1, 1]);
  assert.deepEqual(facesOf(461), [6, 6, 6, 6, 6]);
});

ok('indexOfMultiset: round-trips all 462; tolerates unsorted; rejects invalid', () => {
  for (let idx = 0; idx < NUM_KEEPS; idx++) {
    assert.equal(indexOfMultiset(facesOf(idx)), idx);
  }
  assert.equal(indexOfMultiset([5, 3, 1, 4, 2]), indexOfMultiset([1, 2, 3, 4, 5]));
  assert.throws(() => indexOfMultiset([1, 2, 3, 4, 5, 6]));
  assert.throws(() => indexOfMultiset([0]));
  assert.throws(() => indexOfMultiset([7]));
});

ok('children: facesOf(children[k][v-1]) === sorted(facesOf(k) + [v]) for all sizes < 5', () => {
  let checked = 0;
  for (let idx = 0; idx < NUM_KEEPS; idx++) {
    if (sizeOf(idx) === 5) {
      assert.equal(children[idx], null);
      continue;
    }
    assert.ok(children[idx] instanceof Int32Array);
    assert.equal(children[idx].length, 6);
    for (let v = 1; v <= 6; v++) {
      const child = children[idx][v - 1];
      assert.equal(child, childrenFlat[idx * 6 + (v - 1)]);
      const expected = facesOf(idx).concat([v]).sort((a, b) => a - b);
      assert.deepEqual(facesOf(child), expected, `children[${idx}][${v - 1}]`);
      assert.equal(sizeOf(child), sizeOf(idx) + 1);
      checked++;
    }
  }
  assert.equal(checked, 210 * 6);
});

ok('size5Indices: exactly the 252 indices 210..461, all of size 5', () => {
  assert.equal(size5Indices.length, 252);
  for (let r = 0; r < 252; r++) {
    assert.equal(size5Indices[r], ROLL_OFFSET + r);
    assert.equal(sizeOf(size5Indices[r]), 5);
  }
});

ok('subsets: [1,2,3,4,5] has exactly 32 entries; [6,6,6,6,6] exactly 6', () => {
  assert.equal(subsets[indexOfMultiset([1, 2, 3, 4, 5])].length, 32);
  assert.equal(subsets[indexOfMultiset([6, 6, 6, 6, 6])].length, 6);
});

ok('subsets: every roll — sorted, distinct, complete, includes self and empty', () => {
  for (let idx = 0; idx < ROLL_OFFSET; idx++) assert.equal(subsets[idx], null);
  for (const idx of size5Indices) {
    const subs = subsets[idx];
    assert.ok(subs instanceof Int32Array);
    // roll counts
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const f of facesOf(idx)) counts[f]++;
    // expected count = product of (count_f + 1)
    let expectedN = 1;
    for (let f = 1; f <= 6; f++) expectedN *= counts[f] + 1;
    assert.equal(subs.length, expectedN, `subset count for idx ${idx}`);
    // strictly ascending (=> distinct), includes 0 (empty) and itself
    assert.equal(subs[0], 0);
    assert.equal(subs[subs.length - 1], idx);
    for (let i = 1; i < subs.length; i++) {
      assert.ok(subs[i - 1] < subs[i], `subsets not strictly ascending at idx ${idx}`);
    }
    // every entry is a genuine sub-multiset
    for (const s of subs) {
      const sc = [0, 0, 0, 0, 0, 0, 0];
      for (const f of facesOf(s)) sc[f]++;
      for (let f = 1; f <= 6; f++) {
        assert.ok(sc[f] <= counts[f], `idx ${s} not a sub-multiset of ${idx}`);
      }
    }
  }
});

ok('CAT_ORDER matches game.js CATS exactly', () => {
  assert.equal(NUM_CATS, 13);
  assert.deepEqual([...CAT_ORDER], [...CATS]);
});

ok('CRITICAL: catScores match real game.js scoreCat for ALL 252 x 13 values', () => {
  let compared = 0;
  for (let idx = 0; idx < ROLL_OFFSET; idx++) assert.equal(catScores[idx], null);
  for (const idx of size5Indices) {
    const faces = facesOf(idx);
    const row = catScores[idx];
    assert.ok(row instanceof Int8Array);
    assert.equal(row.length, 13);
    const r = idx - ROLL_OFFSET;
    for (let c = 0; c < 13; c++) {
      const expected = scoreCat(CATS[c], faces);
      assert.equal(row[c], expected,
        `catScores mismatch: roll [${faces}] cat ${CATS[c]}: got ${row[c]}, game.js says ${expected}`);
      assert.equal(catScoresFlat[r * 13 + c], expected);
      compared++;
    }
  }
  assert.equal(compared, 252 * 13);
  console.log(`  # compared ${compared} (252x13) score values against game.js scoreCat — all exact`);
});

ok('isYahtzeeArr / yahtzeeFace match game.js isYahtzee for all rolls', () => {
  let yCount = 0;
  for (let idx = 0; idx < ROLL_OFFSET; idx++) {
    assert.equal(isYahtzeeArr[idx], 0);
    assert.equal(yahtzeeFace[idx], 0);
  }
  for (const idx of size5Indices) {
    const faces = facesOf(idx);
    const expected = isYahtzee(faces) ? 1 : 0;
    assert.equal(isYahtzeeArr[idx], expected, `isYahtzeeArr mismatch at [${faces}]`);
    assert.equal(yahtzeeFace[idx], expected ? faces[0] : 0, `yahtzeeFace mismatch at [${faces}]`);
    if (expected) {
      yCount++;
      assert.equal(catScores[idx][11], 50);
    }
  }
  assert.equal(yCount, 6);
});

ok('facesOf returns a defensive copy (mutating it does not corrupt the tables)', () => {
  const idx = indexOfMultiset([2, 2, 4]);
  const f = facesOf(idx);
  f[0] = 6;
  assert.deepEqual(facesOf(idx), [2, 2, 4]);
  assert.equal(indexOfMultiset([2, 2, 4]), idx);
});

console.log(`\nall ${passed} test groups passed`);
