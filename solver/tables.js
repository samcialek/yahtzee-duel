// solver/tables.js
// Multiset machinery for the exact Yahtzee solver (SOLVER.md §2, §4).
//
// PURE ESM module — no Node APIs, no imports. Browser-safe.
//
// Canonical enumeration (FILE FORMAT contract — never change):
//   All multisets of faces 1..6 with size 0..5, represented as non-decreasing
//   face arrays, enumerated by size ASCENDING, then LEXICOGRAPHIC within a size.
//   Index 0 is the empty multiset. Sizes contribute [1, 6, 21, 56, 126, 252]
//   multisets at offsets [0, 1, 7, 28, 84, 210] — 462 total. The 252 size-5
//   multisets (indices 210..461) are the possible rolls.
//
// Category scoring here is a deliberate, independent reimplementation of the
// raw (joker-unaware) scoreCat() from public/shared/game.js; test-tables.js
// pins it to the real game by exact comparison of all 252×13 values.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NUM_KEEPS = 462;     // all multisets, sizes 0..5
export const NUM_ROLLS = 252;     // size-5 multisets
export const ROLL_OFFSET = 210;   // first size-5 index; roll ordinal = idx - ROLL_OFFSET

// Multisets of size s over 6 faces: C(6+s-1, s)
export const SIZE_COUNTS = Object.freeze([1, 6, 21, 56, 126, 252]);
// First index of each size bucket (prefix sums of SIZE_COUNTS)
export const SIZE_OFFSETS = Object.freeze([0, 1, 7, 28, 84, 210]);

// Category order — MUST equal CATS from public/shared/game.js
// (ones=0 … sixes=5, threeKind=6, fourKind=7, fullHouse=8, smallStraight=9,
//  largeStraight=10, yahtzee=11, chance=12). Verified exactly by test-tables.js.
export const CAT_ORDER = Object.freeze([
  'ones', 'twos', 'threes', 'fours', 'fives', 'sixes',
  'threeKind', 'fourKind', 'fullHouse', 'smallStraight', 'largeStraight',
  'yahtzee', 'chance',
]);
export const NUM_CATS = 13;

// ---------------------------------------------------------------------------
// Enumeration: non-decreasing face arrays, size ascending then lexicographic
// ---------------------------------------------------------------------------

const FACES_BY_INDEX = [];             // idx -> canonical non-decreasing face array (frozen)
const INDEX_BY_KEY = new Map();        // 'f,f,...' -> idx  ('' for the empty multiset)

/** @type {Uint8Array} sizeOfArr[idx] = multiset size (0..5) */
export const sizeOfArr = new Uint8Array(NUM_KEEPS);

{
  const prefix = [];
  const emit = faces => {
    const idx = FACES_BY_INDEX.length;
    const copy = Object.freeze(faces.slice());
    FACES_BY_INDEX.push(copy);
    INDEX_BY_KEY.set(copy.join(','), idx);
    sizeOfArr[idx] = copy.length;
  };
  const gen = (remaining, minFace) => {
    if (remaining === 0) { emit(prefix); return; }
    for (let f = minFace; f <= 6; f++) {
      prefix.push(f);
      gen(remaining - 1, f);
      prefix.pop();
    }
  };
  for (let size = 0; size <= 5; size++) gen(size, 1);
  if (FACES_BY_INDEX.length !== NUM_KEEPS) {
    throw new Error(`tables.js: enumerated ${FACES_BY_INDEX.length} multisets, expected ${NUM_KEEPS}`);
  }
}

/**
 * Index of a multiset given its faces (non-decreasing array of 1..6, length 0..5).
 * Unsorted input is tolerated (a sorted copy is tried); unknown input throws.
 * @param {number[]} faces
 * @returns {number} canonical index 0..461
 */
export function indexOfMultiset(faces) {
  const idx = INDEX_BY_KEY.get(faces.join(','));
  if (idx !== undefined) return idx;
  const sorted = Array.from(faces).sort((a, b) => a - b);
  const idx2 = INDEX_BY_KEY.get(sorted.join(','));
  if (idx2 === undefined) {
    throw new Error(`indexOfMultiset: not a multiset of faces 1..6, size 0..5: [${faces}]`);
  }
  return idx2;
}

/**
 * Canonical non-decreasing face array of a multiset index. Returns a fresh
 * mutable copy; the canonical table itself is immutable.
 * @param {number} idx 0..461
 * @returns {number[]}
 */
export function facesOf(idx) {
  const faces = FACES_BY_INDEX[idx];
  if (faces === undefined) throw new Error(`facesOf: index out of range: ${idx}`);
  return faces.slice();
}

/**
 * Size (0..5) of a multiset index.
 * @param {number} idx 0..461
 * @returns {number}
 */
export function sizeOf(idx) {
  if (idx < 0 || idx >= NUM_KEEPS) throw new Error(`sizeOf: index out of range: ${idx}`);
  return sizeOfArr[idx];
}

// ---------------------------------------------------------------------------
// children[idx][face-1] = index of (multiset ∪ {face}), for sizeOf(idx) < 5
// ---------------------------------------------------------------------------

// Indices 0..209 are exactly the sizes-0..4 multisets (ROLL_OFFSET = 210).
/** @type {Int32Array} flat [ROLL_OFFSET*6]; row k, col v-1 = index of k∪{v} */
export const childrenFlat = new Int32Array(ROLL_OFFSET * 6);

/**
 * @type {(Int32Array|null)[]} children[idx] is an Int32Array(6) view
 * (children[idx][v-1] = index of idx∪{v}) for sizeOf(idx) < 5, else null.
 */
export const children = new Array(NUM_KEEPS).fill(null);

for (let idx = 0; idx < ROLL_OFFSET; idx++) {
  const row = childrenFlat.subarray(idx * 6, idx * 6 + 6);
  const faces = FACES_BY_INDEX[idx];
  for (let v = 1; v <= 6; v++) {
    // insert v keeping the array non-decreasing
    const withV = faces.slice();
    let pos = withV.length;
    while (pos > 0 && withV[pos - 1] > v) pos--;
    withV.splice(pos, 0, v);
    row[v - 1] = INDEX_BY_KEY.get(withV.join(','));
  }
  children[idx] = row;
}

// ---------------------------------------------------------------------------
// Size-5 rolls: indices, sub-multisets, category scores, yahtzee flags
// ---------------------------------------------------------------------------

/** @type {Int32Array} the 252 size-5 multiset indices, ascending (210..461) */
export const size5Indices = new Int32Array(NUM_ROLLS);
for (let r = 0; r < NUM_ROLLS; r++) size5Indices[r] = ROLL_OFFSET + r;

/**
 * @type {(Int32Array|null)[]} subsets[idx] (size-5 idx only, else null):
 * ascending sorted indices of ALL distinct sub-multisets of the roll,
 * including the roll itself and the empty multiset (index 0).
 */
export const subsets = new Array(NUM_KEEPS).fill(null);

/**
 * @type {(Int8Array|null)[]} catScores[idx] (size-5 idx only, else null):
 * Int8Array(13) of raw joker-unaware scoreCat values in CAT_ORDER (= game.js CATS).
 */
export const catScores = new Array(NUM_KEEPS).fill(null);

/** @type {Int8Array} flat [NUM_ROLLS*13]; row (idx-ROLL_OFFSET), col = category */
export const catScoresFlat = new Int8Array(NUM_ROLLS * NUM_CATS);

/** @type {Uint8Array} isYahtzeeArr[idx] = 1 iff idx is a size-5 roll with all faces equal */
export const isYahtzeeArr = new Uint8Array(NUM_KEEPS);

/** @type {Uint8Array} yahtzeeFace[idx] = the face (1..6) if isYahtzeeArr[idx], else 0 */
export const yahtzeeFace = new Uint8Array(NUM_KEEPS);

{
  const counts = new Uint8Array(7);      // counts[1..6], reused per roll
  const subsetFaces = [];                // scratch for sub-multiset enumeration
  const subsetIdxs = [];                 // scratch list of indices

  const hasRun = len => {
    let run = 0;
    for (let face = 1; face <= 6; face++) {
      if (counts[face] > 0) { run++; if (run >= len) return true; }
      else run = 0;
    }
    return false;
  };

  for (let r = 0; r < NUM_ROLLS; r++) {
    const idx = ROLL_OFFSET + r;
    const faces = FACES_BY_INDEX[idx];

    counts.fill(0);
    let sum = 0;
    for (let i = 0; i < 5; i++) { counts[faces[i]]++; sum += faces[i]; }

    // --- raw category scores (matches game.js scoreCat exactly; test-verified)
    let has3 = false, has4 = false, has5 = false, hasEx3 = false, hasEx2 = false;
    for (let f = 1; f <= 6; f++) {
      const c = counts[f];
      if (c >= 3) has3 = true;
      if (c >= 4) has4 = true;
      if (c >= 5) has5 = true;
      if (c === 3) hasEx3 = true;
      if (c === 2) hasEx2 = true;
    }
    const row = catScoresFlat.subarray(r * NUM_CATS, (r + 1) * NUM_CATS);
    for (let f = 1; f <= 6; f++) row[f - 1] = counts[f] * f;   // ones..sixes
    row[6] = has3 ? sum : 0;                                    // threeKind
    row[7] = has4 ? sum : 0;                                    // fourKind
    row[8] = (hasEx3 && hasEx2) ? 25 : 0;                       // fullHouse (exactly 3+2)
    row[9] = hasRun(4) ? 30 : 0;                                // smallStraight
    row[10] = hasRun(5) ? 40 : 0;                               // largeStraight
    row[11] = has5 ? 50 : 0;                                    // yahtzee
    row[12] = sum;                                              // chance
    catScores[idx] = row;

    // --- yahtzee flag & face
    if (has5) { isYahtzeeArr[idx] = 1; yahtzeeFace[idx] = faces[0]; }

    // --- all distinct sub-multisets: pick 0..counts[f] of each face
    subsetIdxs.length = 0;
    const distinct = [];
    for (let f = 1; f <= 6; f++) if (counts[f] > 0) distinct.push(f);
    const pick = di => {
      if (di === distinct.length) {
        subsetIdxs.push(INDEX_BY_KEY.get(subsetFaces.join(',')));
        return;
      }
      const f = distinct[di];
      for (let take = 0; take <= counts[f]; take++) {
        for (let t = 0; t < take; t++) subsetFaces.push(f);
        pick(di + 1);
        for (let t = 0; t < take; t++) subsetFaces.pop();
      }
    };
    pick(0);
    subsetIdxs.sort((a, b) => a - b);
    subsets[idx] = Int32Array.from(subsetIdxs);
  }
}
