// public/js/ai-optimal.js
// "Perfect" AI (SOLVER.md §5) — exact optimal-play decisions backed by the
// precomputed value table (strategy.bin) queried through solver/policy.js.
//
// loadOptimalAI() fetches the table once and returns { chooseHold, chooseCategory }
// with EXACTLY the signatures of the heuristic public/js/ai.js
// ({hold: bool[5], stop: bool} / category string), so LocalEngine can consume
// either implementation interchangeably via opts.ai.
//
// The policy reasons over dice MULTISETS; the game holds POSITIONAL dice. The
// bridge is holdMaskFromKeep(): mark positions greedily until the kept face
// counts match the chosen keep multiset.

import { Policy, fromPlayerState } from '../../solver/policy.js';
import { CAT_ORDER } from '../../solver/tables.js';

// cat name → solver bit index (for merging Category Claim blocked sets into the mask)
const CAT_INDEX = Object.fromEntries(CAT_ORDER.map((c, i) => [c, i]));

/**
 * Positional hold mask for a keep multiset (greedy count matching).
 * @param {number[]} dice       the five rolled faces, positional order
 * @param {number[]} keepFaces  sub-multiset of `dice` to keep
 * @returns {boolean[]} hold — hold[i] === true ⇔ die i is kept
 */
export function holdMaskFromKeep(dice, keepFaces) {
  const need = [0, 0, 0, 0, 0, 0, 0];       // need[f] = copies of face f still to mark
  for (const f of keepFaces) need[f]++;
  const hold = [false, false, false, false, false];
  for (let i = 0; i < 5; i++) {
    const f = dice[i];
    if (need[f] > 0) { need[f]--; hold[i] = true; }
  }
  return hold;
}

/**
 * Fetch strategy.bin + strategy-meta.json from `baseUrl` and build the Perfect
 * AI. Throws on any fetch or table-validation failure — the CALLER decides the
 * fallback (app.js toasts and starts with the Standard heuristic instead).
 *
 * @param {string} [baseUrl]  origin prefix ('' = same origin)
 * @returns {Promise<{
 *   chooseHold: (ps: Object) => {hold: boolean[], stop: boolean},
 *   chooseCategory: (ps: Object) => string,
 *   policy: Policy,
 * }>}
 */
export async function loadOptimalAI(baseUrl = '') {
  const [binRes, metaRes] = await Promise.all([
    fetch(`${baseUrl}/strategy.bin`),
    fetch(`${baseUrl}/strategy-meta.json`),
  ]);
  if (!binRes.ok) throw new Error(`loadOptimalAI: /strategy.bin HTTP ${binRes.status}`);
  if (!metaRes.ok) throw new Error(`loadOptimalAI: /strategy-meta.json HTTP ${metaRes.status}`);
  const [buffer, meta] = await Promise.all([binRes.arrayBuffer(), metaRes.json()]);

  // Policy validates byte length against meta.widgetCount and states.js.
  const policy = new Policy(buffer, meta);

  /**
   * Widget coordinates with opponent-claimed categories (Category Claim) merged
   * into the mask as "filled" boxes. The player's own `up` sum is unchanged —
   * claimed boxes contribute nothing to it, exactly like a self-zeroed box, so
   * the state stays reachable. NOTE the policy still values the solitaire
   * continuation (it assumes it will fill every remaining box itself), so under
   * claim it is a strong heuristic rather than exactly optimal.
   */
  function coords(ps, blocked) {
    const { mask, up, yz } = fromPlayerState(ps);
    if (!blocked || blocked.size === 0) return { mask, up, yz };
    let m = mask;
    for (const cat of blocked) m |= 1 << CAT_INDEX[cat];
    return { mask: m, up, yz };
  }

  /**
   * Same contract as ai.js aiChooseHold. stop === true means "keep everything,
   * score now"; per SOLVER.md §5 that is exactly when scoring now ties or beats
   * the best keep (evalTurn's best.type === 'score', tie tolerance 1e-9 — the
   * keep-all option is valued at the score-now EV, so keep-all never wins ties).
   * @param {Object} ps PlayerState with rolled dice (rollsLeft ∈ {1,2})
   * @param {Set<string>} [blocked] opponent-claimed categories (Category Claim)
   * @returns {{hold: boolean[], stop: boolean}}
   */
  function chooseHold(ps, blocked) {
    const { mask, up, yz } = coords(ps, blocked);
    const rollsLeft = ps.rollsLeft > 2 ? 2 : ps.rollsLeft;
    if (rollsLeft <= 0) {
      return { hold: [true, true, true, true, true], stop: true };
    }
    const { best } = policy.evalTurn(mask, up, yz, ps.dice, rollsLeft);
    if (best.type === 'score') {
      return { hold: [true, true, true, true, true], stop: true };
    }
    return { hold: holdMaskFromKeep(ps.dice, best.faces), stop: false };
  }

  /**
   * Same contract as ai.js aiChooseCategory: the category to score the current
   * dice into (always legal — evalTurn's best over rollsLeft=0 is the argmax
   * over LEGAL categories, joker restrictions included).
   * @param {Object} ps PlayerState with rolled dice
   * @param {Set<string>} [blocked] opponent-claimed categories (Category Claim)
   * @returns {string}
   */
  function chooseCategory(ps, blocked) {
    const { mask, up, yz } = coords(ps, blocked);
    return policy.evalTurn(mask, up, yz, ps.dice, 0).best.cat;
  }

  return { chooseHold, chooseCategory, policy };
}
