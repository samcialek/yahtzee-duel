// public/js/analysis.js
// Post-game decision analysis (ANALYSIS.md) — chess-engine-style review of the
// human player's own decisions against the exact optimal policy.
//
// Two halves, deliberately separated:
//   * recordDecision(log, view, action) + analyze(log, policy) are PURE — no
//     DOM access — so Node can test them headlessly over the real strategy.bin.
//   * renderAnalysis(report, containerEl, opts) is the only DOM-touching export
//     (app.js calls it with the #analysis-content container).
//
// Solver coordinates are reconstructed from each entry's card SNAPSHOT at
// analysis time: mask from card null-ness in CATS bit order (ones=bit0 …
// chance=bit12, exactly the solver's CAT_ORDER), up = min(63, upper sum),
// yz = "the Yahtzee box held 50 at decision time".

import { CATS, PlayerState, nextDice } from '../shared/game.js';
import { fromPlayerState } from '../../solver/policy.js';
import { holdMaskFromKeep } from './ai-optimal.js';

/** Float32 noise floor: a decision is optimal iff its EV loss is below this. */
export const OPTIMAL_EPS = 0.01;

/** Perfect-play expectation from the empty card (SOLVER.md validation anchor). */
export const PERFECT_EV = 254.5877;

const CAT_LABELS = {
  ones: 'Aces', twos: 'Twos', threes: 'Threes', fours: 'Fours',
  fives: 'Fives', sixes: 'Sixes',
  threeKind: 'Three of a Kind', fourKind: 'Four of a Kind',
  fullHouse: 'Full House', smallStraight: 'Small Straight',
  largeStraight: 'Large Straight', yahtzee: 'Yahtzee', chance: 'Chance',
};

// ---------------------------------------------------------------------------
// §1 — Decision recording (during play)
// ---------------------------------------------------------------------------

/**
 * Append one decision snapshot to `log`. A decision exists only where
 * alternatives existed, so calls with no rolled dice (the forced first roll of
 * a round) are ignored. At most ONE decision can exist per (round, rollsLeft)
 * point, so a repeat call for the same point (e.g. a double-click racing the
 * next state push) is dropped — the engine only honors the first action.
 *
 * @param {Object[]} log   module-owned decision log (mutated)
 * @param {Object}   view  the current view-model; only view.you is read
 * @param {{type:'keep', faces:number[]} | {type:'score', cat:string}} action
 */
export function recordDecision(log, view, action) {
  if (!view || !view.you || !Array.isArray(view.you.dice)) return; // forced first roll
  const you = view.you;
  const last = log[log.length - 1];
  if (last && last.round === you.round && last.rollsLeft === you.rollsLeft) return;
  log.push({
    round: you.round,
    rollsLeft: you.rollsLeft,
    dice: you.dice.slice(),
    action: action.type === 'keep'
      ? { type: 'keep', faces: action.faces.slice() }
      : { type: 'score', cat: action.cat },
    card: { ...you.card },
    yzFifty: you.card.yahtzee === 50,
  });
}

// ---------------------------------------------------------------------------
// §2 — Analysis computation (game end)
// ---------------------------------------------------------------------------

/** Solver widget coordinates from a recorded card snapshot. */
function coordsOf(entry) {
  let mask = 0;
  let up = 0;
  for (let c = 0; c < CATS.length; c++) {
    const v = entry.card[CATS[c]];
    if (v !== null && v !== undefined) {
      mask |= 1 << c;
      if (c < 6) up += v;
    }
  }
  return { mask, up: up > 63 ? 63 : up, yz: entry.yzFifty ? 1 : 0 };
}

function keepLabel(faces) {
  if (faces.length === 0) return 'reroll everything';
  if (faces.length === 5) return 'stand pat';
  return `keep ${faces.slice().sort((a, b) => a - b).join(' · ')}`;
}

function scoreLabel(cat, pts) {
  return `score ${CAT_LABELS[cat] || cat} (${pts})`;
}

/**
 * Grade every recorded decision against the optimal policy. PURE — no DOM.
 *
 * For each entry: run policy.evalTurn(mask, up, yz, dice, rollsLeft);
 * chosenEV comes from the matching keep multiset (keep actions) or category
 * (score actions); bestEV is the overall best over keeps ∪ legal categories
 * (categories only at rollsLeft = 0); loss = max(0, bestEV − chosenEV);
 * optimal iff loss < OPTIMAL_EPS.
 *
 * @param {Object[]} log     entries from recordDecision, in play order
 * @param {import('../../solver/policy.js').Policy} policy
 * @returns {{
 *   decisions: {round:number, rollsLeft:number, dice:number[], yoursLabel:string,
 *               optimalLabel:string, loss:number, optimal:boolean, cumLoss:number}[],
 *   totalLoss:number, nOptimal:number, nDecisions:number, accuracyPct:number,
 *   worst:Object|null, perRoundCum:{round:number, cumLoss:number}[],
 * }}
 */
export function analyze(log, policy) {
  const decisions = [];
  const perRoundCum = [];
  let cumLoss = 0;
  let nOptimal = 0;
  let worst = null;

  for (const entry of log) {
    const { mask, up, yz } = coordsOf(entry);
    const res = policy.evalTurn(mask, up, yz, entry.dice, entry.rollsLeft);

    // chosen EV + label
    let chosenEV;
    let yoursLabel;
    if (entry.action.type === 'keep') {
      const key = entry.action.faces.slice().sort((a, b) => a - b).join(',');
      const match = res.keeps && res.keeps.find((k) => k.faces.join(',') === key);
      if (!match) throw new Error(`analyze: kept faces [${key}] not a sub-multiset of [${entry.dice}]`);
      chosenEV = match.ev;
      yoursLabel = keepLabel(entry.action.faces);
    } else {
      const match = res.categories.find((c) => c.cat === entry.action.cat);
      if (!match) throw new Error(`analyze: category ${entry.action.cat} is not open on the recorded card`);
      chosenEV = match.ev;
      yoursLabel = scoreLabel(entry.action.cat, match.pts);
    }

    // best EV over both option sets (keeps exist only when rollsLeft > 0)
    let bestEV = -Infinity;
    for (const c of res.categories) if (c.legal && c.ev > bestEV) bestEV = c.ev;
    if (res.keeps && res.keeps.length > 0 && res.keeps[0].ev > bestEV) bestEV = res.keeps[0].ev;

    const loss = Math.max(0, bestEV - chosenEV);
    const optimal = loss < OPTIMAL_EPS;
    if (optimal) nOptimal++;
    cumLoss += loss;

    const optimalLabel = res.best.type === 'score'
      ? scoreLabel(res.best.cat, res.best.pts)
      : keepLabel(res.best.faces);

    const decision = {
      round: entry.round,
      rollsLeft: entry.rollsLeft,
      dice: entry.dice.slice(),
      yoursLabel,
      optimalLabel,
      loss,
      optimal,
      cumLoss,
    };
    decisions.push(decision);
    if (!optimal && (worst === null || loss > worst.loss)) worst = decision;

    const lastRound = perRoundCum[perRoundCum.length - 1];
    if (lastRound && lastRound.round === entry.round) lastRound.cumLoss = cumLoss;
    else perRoundCum.push({ round: entry.round, cumLoss });
  }

  const nDecisions = decisions.length;
  return {
    decisions,
    totalLoss: cumLoss,
    nOptimal,
    nDecisions,
    accuracyPct: nDecisions > 0 ? (100 * nOptimal) / nDecisions : 100,
    worst,
    perRoundCum,
  };
}

// ---------------------------------------------------------------------------
// §2.5 — Same-luck perfect replay (game end)
// ---------------------------------------------------------------------------

const NO_HOLD = [false, false, false, false, false];

/**
 * Replay the player's own game — same (shared, luck, mode) tape — but with
 * every decision made by the optimal policy, and return the perfect final
 * score. Because ps.luck reproduces this player's exact dice for ANY hold
 * sequence, this is "what a perfect player would have scored on YOUR dice".
 *
 * @param {{shared:Object, luck:Object, mode:number}|null} context the player's
 *   own end-of-game luck context (shared board + per-player luck tape + mode)
 * @param {import('../../solver/policy.js').Policy} policy
 * @returns {number|null} the same-luck perfect score, or null if context/luck
 *   (or the policy) is missing.
 */
export function replayOptimal(context, policy) {
  if (!context || !context.luck || !policy) return null;
  const { shared, luck, mode } = context;
  const ps = new PlayerState();
  ps.luck = luck;
  while (!ps.done) {
    ps.applyRoll(nextDice(ps, NO_HOLD, mode, shared).dice);
    for (;;) {
      const { mask, up, yz } = fromPlayerState(ps);
      const res = policy.evalTurn(mask, up, yz, ps.dice, ps.rollsLeft);
      if (res.best.type === 'score') { ps.scoreCategory(res.best.cat); break; }
      ps.applyRoll(nextDice(ps, holdMaskFromKeep(ps.dice, res.best.faces), mode, shared).dice);
    }
  }
  return ps.total;
}

// ---------------------------------------------------------------------------
// §3 — Rendering (DOM; browser only)
// ---------------------------------------------------------------------------

const fmt1 = (n) => n.toFixed(1);
const MINUS = '−';
/** ⚀..⚅ from a face 1..6 (U+2680 is face 1). */
const dieGlyph = (v) => String.fromCharCode(0x267f + v);
/** Spent-then-remaining rolls marker, mirroring the in-game dots: ○○● = 1 left. */
const rollsMarker = (r) => '○'.repeat(3 - r) + '●'.repeat(r);

/**
 * Render an analyze() report into `containerEl` (innerHTML is replaced).
 * All content is app-generated — no user-controlled strings.
 *
 * @param {ReturnType<typeof analyze>} report
 * @param {HTMLElement} containerEl
 * @param {{perfectScore?: number|null, yourScore?: number}} [opts]
 *   perfectScore = same-luck perfect score from replayOptimal (null → omit the
 *   closing line); yourScore = the human's own final score.
 */
export function renderAnalysis(report, containerEl, opts = {}) {
  if (!report || report.nDecisions === 0) {
    containerEl.innerHTML = '<p class="an-status">No decisions were recorded for this game.</p>';
    return;
  }

  const worstBit = report.worst
    ? `worst: round ${report.worst.round + 1} (${MINUS}${fmt1(report.worst.loss)})`
    : 'no mistakes';
  const summary = `${report.nOptimal} of ${report.nDecisions} decisions optimal `
    + `(${Math.round(report.accuracyPct)}%) · total EV lost ${fmt1(report.totalLoss)} · ${worstBit}`;

  let html = `<p class="an-summary">${summary}</p>`;
  html += '<div class="an-ledger">';
  html += '<div class="an-row an-row--head">'
    + '<span class="an-dice">Dice</span>'
    + '<span class="an-rolls">Rolls</span>'
    + '<span class="an-yours">You played</span>'
    + '<span class="an-best">Optimal</span>'
    + '<span class="an-delta">Δ EV</span>'
    + '<span class="an-cum">Σ lost</span>'
    + '</div>';

  let lastRound = -1;
  for (const d of report.decisions) {
    if (d.round !== lastRound) {
      lastRound = d.round;
      html += `<div class="an-round">Round ${d.round + 1}</div>`;
    }
    html += `<div class="an-row ${d.optimal ? 'is-ok' : 'is-loss'}">`
      + `<span class="an-dice">${d.dice.map(dieGlyph).join('')}</span>`
      + `<span class="an-rolls" title="${d.rollsLeft} roll${d.rollsLeft === 1 ? '' : 's'} left">${rollsMarker(d.rollsLeft)}</span>`
      + `<span class="an-yours">${d.yoursLabel}</span>`
      + `<span class="an-best">${d.optimal ? '—' : d.optimalLabel}</span>`
      + `<span class="an-delta">${d.optimal ? '✓' : MINUS + fmt1(d.loss)}</span>`
      + `<span class="an-cum">${fmt1(d.cumLoss)}</span>`
      + '</div>';
  }
  html += '</div>';

  // Closing line: the same-luck perfect score on the player's OWN dice. When the
  // luck context is unavailable (perfectScore == null) the line is omitted.
  const { perfectScore, yourScore } = opts;
  if (perfectScore != null) {
    let closing;
    if (perfectScore > yourScore) {
      const left = perfectScore - yourScore;
      closing = `Perfect play on your dice would have scored ${perfectScore} — you left `
        + `<strong style="color: var(--accent)">${left}</strong> `
        + `point${left === 1 ? '' : 's'} on the table.`;
    } else if (perfectScore === yourScore) {
      closing = `Perfect play on your dice also scored ${yourScore} — `
        + 'you matched the optimal line.';
    } else {
      const beat = yourScore - perfectScore;
      closing = `Perfect play on your dice scored ${perfectScore}; you scored ${yourScore} — `
        + `your rolls broke your way and you beat the optimal line by <strong>${beat}</strong>.`;
    }
    html += `<p class="an-closing">${closing}</p>`;
  }

  containerEl.innerHTML = html;
}
