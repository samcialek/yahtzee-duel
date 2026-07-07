// solver/policy.js
// Policy / query layer over the solved value table (SOLVER.md §4).
//
// PURE ESM — no Node APIs; works identically in Node and the browser. The
// constructor takes the raw strategy.bin bytes (ArrayBuffer or typed-array
// view) plus the parsed strategy-meta.json. Every query recomputes exactly ONE
// widget's keep lattices (§2) from V-lookups of successor widgets — there is
// no stored per-state policy, only the Float32 V table.
//
// Lattice semantics used by evalTurn (mirrors solve.js):
//   S(d)          — value of scoring now with final dice d (max over legal cats
//                   of pts + bonuses + V(successor)).
//   A2 (Base = S) — A2(k) = value of KEEPING multiset k when rollsLeft = 1.
//                   For |k| = 5, A2(d) = S(d): keeping everything = score now.
//   Best2(d)      — max over k ⊆ d of A2(k) = value of holding dice d, 1 roll left.
//   A1 (Base=Best2) — A1(k) = value of KEEPING k when rollsLeft = 2.
//                   For |k| = 5, A1(d) = Best2(d): stand pat, decide again later.

import {
  NUM_KEEPS, NUM_ROLLS, ROLL_OFFSET, NUM_CATS, CAT_ORDER,
  childrenFlat, subsets, catScoresFlat, isYahtzeeArr, yahtzeeFace,
  indexOfMultiset, facesOf,
} from './tables.js';
import { count as WIDGET_COUNT, idOf } from './states.js';

const YZ_BIT = 1 << 11;      // yahtzee category bit
const FULL_MASK = 0x1fff;    // all 13 categories filled
const SIXTH = 1 / 6;
// Lower-section bits excluding yahtzee: threeKind..largeStraight, chance
const LOWER_NOY_BITS = (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 12);

/** Tie tolerance for the score-now vs keep decision (SOLVER.md §5). */
export const TIE_EPS = 1e-9;

// ---------------------------------------------------------------------------
// §3 joker-aware legality & display points.
// Browser-safe mirror of solve.js legalPts() (solve.js imports node:fs, so it
// cannot be imported here). Pinned to game.js potentials() by test-policy.js
// exactly like test-rules.js pins the solver's copy.
// ---------------------------------------------------------------------------

/**
 * Fills ptsOut[c] for every OPEN category c — both legal and joker-blocked,
 * mirroring game.js potentials() display values — and returns the 13-bit
 * LEGALITY mask (subset of the open bits).
 * @param {number} mask     13-bit filled mask
 * @param {number} rollIdx  roll ordinal 0..251 (multiset index − ROLL_OFFSET)
 * @param {Int32Array|number[]} ptsOut length ≥ 13
 * @returns {number}
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
// PlayerState bridge (the ONLY place the solver touches game-shaped state)
// ---------------------------------------------------------------------------

/**
 * Map a PlayerState (live instance or serialized `{card, …}` chunk) to the
 * solver's widget coordinates.
 * @param {{card: Object}} ps
 * @returns {{mask: number, up: number, yz: 0|1}}
 */
export function fromPlayerState(ps) {
  const card = ps.card;
  let mask = 0;
  let upSum = 0;
  for (let c = 0; c < NUM_CATS; c++) {
    const v = card[CAT_ORDER[c]];
    if (v !== null && v !== undefined) {
      mask |= 1 << c;
      if (c < 6) upSum += v;
    }
  }
  return { mask, up: upSum > 63 ? 63 : upSum, yz: card.yahtzee === 50 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export class Policy {
  /**
   * @param {ArrayBuffer|ArrayBufferView} buffer  raw strategy.bin contents
   * @param {{version:number, widgetCount:number, startEV:number, byteLength:number}} meta
   */
  constructor(buffer, meta) {
    if (!meta || typeof meta !== 'object') {
      throw new TypeError('Policy: parsed strategy-meta.json object required');
    }
    let f32;
    if (buffer instanceof ArrayBuffer) {
      f32 = new Float32Array(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
      if (buffer.byteLength % 4 !== 0) {
        throw new RangeError(`Policy: byteLength ${buffer.byteLength} not a multiple of 4`);
      }
      f32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    } else {
      throw new TypeError('Policy: buffer must be an ArrayBuffer or typed-array view');
    }
    if (meta.widgetCount !== WIDGET_COUNT) {
      throw new Error(`Policy: meta.widgetCount ${meta.widgetCount} !== enumerated ${WIDGET_COUNT}`
        + ' — strategy.bin does not match this build of states.js');
    }
    if (f32.length !== WIDGET_COUNT) {
      throw new Error(`Policy: table holds ${f32.length} floats, expected ${WIDGET_COUNT}`);
    }

    /** @type {Float32Array} V in widget-id order (states.js dense ids) */
    this.V = f32;
    this.meta = meta;

    // Preallocated per-query scratch (queries are synchronous; not re-entrant).
    this._latA = new Float64Array(NUM_KEEPS);           // A2 (and Best2 base)
    this._latB = new Float64Array(NUM_KEEPS);           // A1
    this._upVal = new Float64Array(36);                 // [upperCat*6 + count]
    this._lowVal = new Float64Array(NUM_CATS);          // [lowerCat] → V(successor)
    this._pts = new Int32Array(NUM_CATS);
    this._movesCat = new Uint8Array(NUM_ROLLS * NUM_CATS);
    this._movesPts = new Uint8Array(NUM_ROLLS * NUM_CATS);
    this._movesOff = new Int32Array(NUM_ROLLS + 1);
    this._movesMask = -1;                               // mask the moves table is built for
  }

  /** @see fromPlayerState */
  static fromPlayerState(ps) { return fromPlayerState(ps); }

  /**
   * V(mask, up, yz): expected additional points from the start of a turn under
   * optimal play. Throws on out-of-range arguments or an unreachable `up`.
   * @returns {number}
   */
  stateEV(mask, up, yz) {
    const id = idOf(mask, up, yz); // validates mask/up/yz ranges
    if (id < 0) {
      throw new RangeError(`stateEV: up=${up} is not reachable for mask=${mask}`);
    }
    return this.V[id];
  }

  /**
   * Full decision analysis for one in-turn state.
   *
   * @param {number} mask 13-bit filled-categories mask (not all 13 filled)
   * @param {number} up   upper subtotal 0..63 (must be reachable for mask)
   * @param {0|1} yz      1 ⇔ yahtzee box holds 50
   * @param {number[]} dice five faces 1..6, any order
   * @param {0|1|2} rollsLeft rerolls remaining
   * @param {boolean} [withTurn=false] also compute best.turnEv — the expected
   *   points scored in THIS turn under optimal play (evaluates the immediate
   *   scoring reward, dropping the +V(successor) future term, under the same
   *   optimal decisions). Off by default so the AI/simulation hot path is
   *   unaffected; the coach passes true to show a per-turn figure.
   * @returns {{
   *   categories: {cat: string, pts: number, ev: number, legal: boolean}[],
   *   keeps: {faces: number[], ev: number}[] | null,
   *   best: {type:'score', cat: string, pts: number, ev: number, turnEv?: number}
   *       | {type:'keep', faces: number[], ev: number, turnEv?: number},
   * }}
   * categories: every OPEN category, desc-sorted by ev (ev = pts + bonuses +
   *   V(successor), computed identically for joker-blocked cats, which carry
   *   legal:false and the same display pts as game.js potentials()).
   * keeps: every distinct sub-multiset of `dice` (incl. keep-all and ∅),
   *   desc-sorted by ev, at lattice level A1 (rollsLeft=2) or A2 (rollsLeft=1);
   *   null when rollsLeft=0.
   * best: 'score' when rollsLeft=0 or scoring now ties/beats every keep
   *   (scoreNowEV ≥ bestKeepEV − TIE_EPS), else the argmax keep.
   */
  evalTurn(mask, up, yz, dice, rollsLeft, withTurn = false) {
    if (rollsLeft !== 0 && rollsLeft !== 1 && rollsLeft !== 2) {
      throw new RangeError(`evalTurn: rollsLeft must be 0, 1 or 2: ${rollsLeft}`);
    }
    if (!Array.isArray(dice) || dice.length !== 5) {
      throw new RangeError(`evalTurn: dice must be an array of 5 faces: [${dice}]`);
    }
    if (mask === FULL_MASK) {
      throw new RangeError('evalTurn: all 13 categories are filled — nothing to decide');
    }
    if (idOf(mask, up, yz) < 0) {
      throw new RangeError(`evalTurn: up=${up} is not reachable for mask=${mask}`);
    }
    const kIdx = indexOfMultiset(dice);   // throws on non-faces
    const rollIdx = kIdx - ROLL_OFFSET;

    const V = this.V;
    const hasYz = (mask & YZ_BIT) !== 0;

    // ---- per-widget successor values (§1 reward), identical to solve.js ----
    const upVal = this._upVal;
    const lowVal = this._lowVal;
    // Parallel immediate-reward table for the upper cats (this turn's points only:
    // the score plus the upper-bonus crossing), built only when turn EV is wanted.
    const upImm = withTurn ? new Float64Array(36) : null;
    for (let c = 0; c < 6; c++) {
      if ((mask >> c) & 1) continue;
      const f = c + 1;
      const m2 = mask | (1 << c);
      for (let cnt = 0; cnt <= 5; cnt++) {
        const pts = cnt * f;
        const raw = up + pts;
        const bonus = (up < 63 && raw >= 63) ? 35 : 0;   // fires exactly on the crossing
        const up2 = raw > 63 ? 63 : raw;
        upVal[c * 6 + cnt] = pts + bonus + V[idOf(m2, up2, yz)];
        if (withTurn) upImm[c * 6 + cnt] = pts + bonus;
      }
    }
    for (let c = 6; c < NUM_CATS; c++) {
      if (c === 11 || ((mask >> c) & 1)) continue;
      lowVal[c] = V[idOf(mask | (1 << c), up, yz)];
    }
    let y50 = 0, y0 = 0;
    if (!hasYz) {
      const m2 = mask | YZ_BIT;
      y0 = V[idOf(m2, up, 0)];            // zeroed box: bit 11 set, yz stays 0
      y50 = 50 + V[idOf(m2, up, 1)];
    }
    // Extra-Yahtzee +100: iff the roll is a Yahtzee, bit 11 set, and yz === 1;
    // fires regardless of which category is scored.
    const bonusAdd = (hasYz && yz === 1) ? 100 : 0;

    // Score-now value of category c at pts (pts = cnt·face for upper cats).
    const rollIsYahtzee = isYahtzeeArr[kIdx] !== 0;
    const catEV = (c, pts) => {
      let v;
      if (c < 6) v = upVal[c * 6 + pts / (c + 1)];
      else if (c === 11) v = pts === 50 ? y50 : y0;
      else v = pts + lowVal[c];
      return rollIsYahtzee ? v + bonusAdd : v;
    };
    // This-turn reward of scoring c at pts (immediate part of catEV, no future V):
    // upper cats via upImm (score + bonus crossing); yahtzee box & lower = pts;
    // the extra-Yahtzee +100 rides along whenever the roll is a Yahtzee.
    const catImm = (c, pts) => {
      const v = c < 6 ? upImm[c * 6 + pts / (c + 1)] : pts;
      return rollIsYahtzee ? v + bonusAdd : v;
    };

    // ---- keeps (must run BEFORE the categories block: both use this._pts) ----
    let keeps = null;
    let bestKeepEv = -Infinity;
    let levelImm = null;      // immediate-reward lattice aligned with `level`, when withTurn
    if (rollsLeft > 0) {
      this._buildMoves(mask);
      const latA = this._latA;
      const movesOff = this._movesOff, movesCat = this._movesCat, movesPts = this._movesPts;
      // Immediate-reward twin lattice, propagated under the SAME argmax as the
      // full-EV lattice — so it reports this turn's points along the optimal line.
      const immA = withTurn ? new Float64Array(NUM_KEEPS) : null;

      // S(d) for all 252 rolls
      for (let r = 0; r < NUM_ROLLS; r++) {
        let s = -Infinity, sImm = 0;
        const e = movesOff[r + 1];
        for (let j = movesOff[r]; j < e; j++) {
          const c = movesCat[j];
          const pts = movesPts[j];
          let v;
          if (c < 6) v = upVal[c * 6 + pts / (c + 1)];
          else if (c === 11) v = pts === 50 ? y50 : y0;
          else v = pts + lowVal[c];
          if (v > s) { s = v; if (withTurn) sImm = c < 6 ? upImm[c * 6 + pts / (c + 1)] : pts; }
        }
        if (bonusAdd !== 0 && isYahtzeeArr[ROLL_OFFSET + r] !== 0) { s += bonusAdd; sImm += bonusAdd; }
        latA[ROLL_OFFSET + r] = s;
        if (withTurn) immA[ROLL_OFFSET + r] = sImm;
      }
      // A2: expected S after filling the keep one die at a time
      for (let k = ROLL_OFFSET - 1; k >= 0; k--) {
        const o = k * 6;
        latA[k] = (latA[childrenFlat[o]] + latA[childrenFlat[o + 1]] + latA[childrenFlat[o + 2]]
                 + latA[childrenFlat[o + 3]] + latA[childrenFlat[o + 4]] + latA[childrenFlat[o + 5]]) * SIXTH;
        if (withTurn) immA[k] = (immA[childrenFlat[o]] + immA[childrenFlat[o + 1]] + immA[childrenFlat[o + 2]]
                 + immA[childrenFlat[o + 3]] + immA[childrenFlat[o + 4]] + immA[childrenFlat[o + 5]]) * SIXTH;
      }
      let level = latA;                        // rollsLeft === 1 → keeps valued at A2
      levelImm = immA;
      if (rollsLeft === 2) {
        const latB = this._latB;
        const immB = withTurn ? new Float64Array(NUM_KEEPS) : null;
        // Best2(d) = max over k ⊆ d of A2(k); its imm rides the same argmax.
        for (let r = 0; r < NUM_ROLLS; r++) {
          const subs = subsets[ROLL_OFFSET + r];
          let m = -Infinity, mImm = 0;
          for (let j = 0; j < subs.length; j++) {
            const v = latA[subs[j]];
            if (v > m) { m = v; if (withTurn) mImm = immA[subs[j]]; }
          }
          latB[ROLL_OFFSET + r] = m;
          if (withTurn) immB[ROLL_OFFSET + r] = mImm;
        }
        // A1: expected Best2
        for (let k = ROLL_OFFSET - 1; k >= 0; k--) {
          const o = k * 6;
          latB[k] = (latB[childrenFlat[o]] + latB[childrenFlat[o + 1]] + latB[childrenFlat[o + 2]]
                   + latB[childrenFlat[o + 3]] + latB[childrenFlat[o + 4]] + latB[childrenFlat[o + 5]]) * SIXTH;
          if (withTurn) immB[k] = (immB[childrenFlat[o]] + immB[childrenFlat[o + 1]] + immB[childrenFlat[o + 2]]
                   + immB[childrenFlat[o + 3]] + immB[childrenFlat[o + 4]] + immB[childrenFlat[o + 5]]) * SIXTH;
        }
        level = latB;                          // rollsLeft === 2 → keeps valued at A1
        levelImm = immB;
      }

      const subs = subsets[kIdx];
      keeps = new Array(subs.length);
      for (let j = 0; j < subs.length; j++) {
        const ev = level[subs[j]];
        const kp = { faces: facesOf(subs[j]), ev };
        if (withTurn) kp.si = subs[j];         // keep-index into levelImm for turnEv
        keeps[j] = kp;
        if (ev > bestKeepEv) bestKeepEv = ev;
      }
      // Desc by ev; stable sort keeps the canonical (size asc, lexicographic)
      // enumeration order among ties → deterministic output.
      keeps.sort((a, b) => b.ev - a.ev);
    }

    // ---- categories for the current roll ----
    const legal = legalPts(mask, rollIdx, this._pts);
    const open = (~mask) & FULL_MASK;
    const categories = [];
    for (let c = 0; c < NUM_CATS; c++) {
      if (((open >> c) & 1) === 0) continue;
      const pts = this._pts[c];
      const cObj = {
        cat: CAT_ORDER[c],
        pts,
        ev: catEV(c, pts),
        legal: ((legal >> c) & 1) !== 0,
      };
      if (withTurn) cObj.ci = c;               // numeric index for catImm(bestCat)
      categories.push(cObj);
    }
    // Desc by ev; on ties legal before blocked, then CATS order (stable sort).
    categories.sort((a, b) => (b.ev - a.ev) || ((b.legal ? 1 : 0) - (a.legal ? 1 : 0)));

    // Best legal category = first legal entry (max ev among legal moves).
    let bestCat = null;
    for (let i = 0; i < categories.length; i++) {
      if (categories[i].legal) { bestCat = categories[i]; break; }
    }
    // legalPts always returns a non-empty subset of open bits, so bestCat exists.

    // ---- best action (§5 tie rule: prefer scoring when it ties the best keep) ----
    let best;
    if (rollsLeft === 0 || bestCat.ev >= bestKeepEv - TIE_EPS) {
      best = { type: 'score', cat: bestCat.cat, pts: bestCat.pts, ev: bestCat.ev };
      // Scoring now is deterministic — this turn's value is exactly its immediate reward.
      if (withTurn) best.turnEv = catImm(bestCat.ci, bestCat.pts);
    } else {
      const bk = keeps[0];
      best = { type: 'keep', faces: bk.faces.slice(), ev: bk.ev };
      // Expected points this turn if we hold bk and continue optimally.
      if (withTurn) best.turnEv = levelImm[bk.si];
    }

    return { categories, keeps, best };
  }

  /**
   * Per-mask legal-move table for the S(d) sweep (legality + pts depend only
   * on the mask, never on up/yz). Cached: consecutive queries on the same mask
   * (the common case within a turn) skip the rebuild.
   */
  _buildMoves(mask) {
    if (this._movesMask === mask) return;
    const movesOff = this._movesOff, movesCat = this._movesCat, movesPts = this._movesPts;
    const pts = this._pts;
    let n = 0;
    for (let r = 0; r < NUM_ROLLS; r++) {
      movesOff[r] = n;
      const legal = legalPts(mask, r, pts);
      for (let c = 0; c < NUM_CATS; c++) {
        if ((legal >> c) & 1) { movesCat[n] = c; movesPts[n] = pts[c]; n++; }
      }
    }
    movesOff[NUM_ROLLS] = n;
    this._movesMask = mask;
  }
}
