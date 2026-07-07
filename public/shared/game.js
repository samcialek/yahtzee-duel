// public/shared/game.js
// Shared game-logic module imported by BOTH the Node server and the browser.
// Sections 3 & 4 of ARCHITECTURE.md. Blocks marked CANONICAL are copied verbatim.

// ---------------------------------------------------------------------------
// §3 — Core mechanic: shared dice with zero synchronization (CANONICAL)
// ---------------------------------------------------------------------------

// CANONICAL
export const ROUNDS = 13;

export function makeShared(rng = Math.random) {
  const roll5 = () => Array.from({ length: 5 }, () => 1 + Math.floor(rng() * 6));
  return {
    first:   Array.from({ length: ROUNDS }, roll5),            // variant 2 & 3: identical opening roll
    rerolls: Array.from({ length: ROUNDS }, () => [roll5(), roll5()]), // variant 3: [roll#2 seq, roll#3 seq]
  };
}

// Per-player "luck tape" — a POSITION-indexed reserve of every reroll outcome a player
// could possibly draw this game, generated up front. When a PlayerState carries `ps.luck`,
// nextDice draws its non-shared randomness from here instead of live rng(), which makes the
// player's whole game reproducible for ANY sequence of hold decisions — including dice a
// perfect replay would reroll but the human kept. That is exactly what the post-game
// "perfect play on your dice" replay needs (see ANALYSIS.md). Statistically identical to
// live rolling; it only fixes the outcomes ahead of time.
//   opening[round]        → variant-1 opening roll (variants 2/3 use shared.first)
//   reroll[round][r][pos] → the value die-position `pos` takes on roll #(r+2), if rerolled
//                           (variants 1 & 2; variant 3 rerolls come from shared.rerolls by k-index)
export function makeLuck(rng = Math.random) {
  const roll5 = () => Array.from({ length: 5 }, () => 1 + Math.floor(rng() * 6));
  return {
    opening: Array.from({ length: ROUNDS }, roll5),
    reroll:  Array.from({ length: ROUNDS }, () => [roll5(), roll5()]),
  };
}

// hold[i] === true means KEEP die i. mode: 1 | 2 | 3.
// If ps.luck is present the dice are drawn from that tape (reproducible); otherwise from rng().
export function nextDice(ps, hold, mode, shared, rng = Math.random) {
  const rollNum = 4 - ps.rollsLeft;            // rollsLeft 3 → this is roll #1
  const luck = ps.luck || null;
  const rand = () => 1 + Math.floor(rng() * 6);
  if (rollNum === 1) {
    const dice = mode >= 2 ? shared.first[ps.round].slice()
               : luck      ? luck.opening[ps.round].slice()
               :             Array.from({ length: 5 }, rand);
    return { dice, mask: [0, 1, 2, 3, 4] };    // mask = indices that rolled (drives animation)
  }
  const dice = ps.dice.slice();
  const pos = [];
  for (let i = 0; i < 5; i++) if (!hold[i]) pos.push(i);
  const seq = mode === 3 ? shared.rerolls[ps.round][rollNum - 2] : null;  // variant-3 k-indexed share
  const tape = luck ? luck.reroll[ps.round][rollNum - 2] : null;          // position-indexed reserve
  pos.forEach((p, k) => { dice[p] = seq ? seq[k] : tape ? tape[p] : rand(); });
  return { dice, mask: pos };
}

// ---------------------------------------------------------------------------
// §4 — Scoring & the Yahtzee joker (CANONICAL)
// ---------------------------------------------------------------------------

// CANONICAL
export const UPPER = ['ones','twos','threes','fours','fives','sixes'];
export const LOWER = ['threeKind','fourKind','fullHouse','smallStraight','largeStraight','yahtzee','chance'];
export const CATS  = [...UPPER, ...LOWER];
export const isYahtzee = d => d.every(v => v === d[0]);

// Textbook, joker-UNAWARE scoring for a single category.
// face counts; straights via longest-run check; full house = exactly (3+2).
export function scoreCat(cat, dice) {
  const counts = [0, 0, 0, 0, 0, 0, 0];        // counts[1..6]
  for (const v of dice) counts[v]++;
  const sum = dice.reduce((a, b) => a + b, 0);

  const hasRun = len => {
    let run = 0;
    for (let face = 1; face <= 6; face++) {
      if (counts[face] > 0) { run++; if (run >= len) return true; }
      else run = 0;
    }
    return false;
  };

  switch (cat) {
    case 'ones':   return counts[1] * 1;
    case 'twos':   return counts[2] * 2;
    case 'threes': return counts[3] * 3;
    case 'fours':  return counts[4] * 4;
    case 'fives':  return counts[5] * 5;
    case 'sixes':  return counts[6] * 6;
    case 'threeKind':     return counts.some(c => c >= 3) ? sum : 0;
    case 'fourKind':      return counts.some(c => c >= 4) ? sum : 0;
    case 'fullHouse':     return (counts.some(c => c === 3) && counts.some(c => c === 2)) ? 25 : 0;
    case 'smallStraight': return hasRun(4) ? 30 : 0;
    case 'largeStraight': return hasRun(5) ? 40 : 0;
    case 'yahtzee':       return counts.some(c => c === 5) ? 50 : 0;
    case 'chance':        return sum;
    default:              return 0;
  }
}

// Returns { [openCat]: { pts, allowed } }. `allowed:false` rows render dimmed & unclickable.
// `blocked` (optional, Category Claim): a Set of categories CLAIMED BY THE OPPONENT —
// they are unavailable to this player and count as "taken" for the joker branching
// (a box closed by either player is closed for the joker rules too), but they never
// appear in the result: you cannot score into an opponent-claimed box.
export function potentials(card, dice, blocked) {
  const taken = cat => card[cat] !== null || (blocked ? blocked.has(cat) : false);
  const res = {};
  const joker = isYahtzee(dice) && taken('yahtzee');        // yahtzee box already taken (50, 0, or claimed)
  if (!joker) {
    for (const cat of CATS) if (!taken(cat))
      res[cat] = { pts: scoreCat(cat, dice), allowed: true };
    return res;
  }
  const face = dice[0], upCat = UPPER[face - 1], s = face * 5;
  const lowerOpen = LOWER.filter(c => c !== 'yahtzee' && !taken(c));
  const jokerPts = cat =>
    UPPER.includes(cat) ? (cat === upCat ? s : 0)
    : cat === 'fullHouse' ? 25 : cat === 'smallStraight' ? 30
    : cat === 'largeStraight' ? 40 : s;                     // 3-kind / 4-kind / chance = sum
  for (const cat of CATS) {
    if (taken(cat)) continue;
    let allowed;
    if (!taken(upCat))             allowed = cat === upCat;         // 1) forced into matching upper box
    else if (lowerOpen.length > 0) allowed = lowerOpen.includes(cat); // 2) else any lower box, joker values
    else                           allowed = true;                    // 3) else zero any remaining upper box
    res[cat] = { pts: jokerPts(cat), allowed };
  }
  return res;
}

// ---------------------------------------------------------------------------
// Category Claim helpers (orthogonal to the three dice variants)
// ---------------------------------------------------------------------------

// The set of categories already scored on `card` — i.e. what THIS card's owner has
// claimed. Pass the OPPONENT's card to build the `blocked` set for potentials().
export function claimedCats(card) {
  return new Set(CATS.filter(c => card[c] !== null && card[c] !== undefined));
}

// Categories still open to BOTH players — the shared pool that remains.
export function openCats(cardA, cardB) {
  return CATS.filter(c =>
    cardA[c] === null || cardA[c] === undefined
      ? (cardB[c] === null || cardB[c] === undefined)
      : false);
}

// Roll-synchronization barrier (Category Claim, simultaneous variants + sudden
// death): players start each roll together instead of running rolls ahead.
// `me`/`opp` need only { round, rollsLeft } (PlayerState or its serialized form).
//   - behind on rounds → free to catch up; ahead → wait for the opponent;
//   - same round → my next roll k is allowed once the opponent has taken ≥ k−1
//     rolls (they are at the same decision point) or has already scored/locked
//     (their rollsLeft was reset or zeroed). Max lead: one roll in flight.
export function canRollSync(me, opp) {
  if (me.round !== opp.round) return me.round < opp.round;
  return (3 - opp.rollsLeft) >= (3 - me.rollsLeft);
}

// ---------------------------------------------------------------------------
// §4 — PlayerState (describe-only in spec)
// ---------------------------------------------------------------------------

export class PlayerState {
  constructor() {
    this.card = {};
    for (const cat of CATS) this.card[cat] = null;
    this.yahtzeeBonus = 0;
    this.round = 0;
    this.rollsLeft = 3;
    this.dice = null;
    // Category Claim: the upper bonus is a shared race — the player whose score
    // pushes the COMBINED upper total to 63+ is awarded the 35 (claimBonus set by
    // the room/engine). claimMode switches the upperBonus getter to that award.
    this.claimMode = false;
    this.claimBonus = 0;
  }

  get upperSum() {
    let s = 0;
    for (const cat of UPPER) if (this.card[cat] !== null) s += this.card[cat];
    return s;
  }

  get upperBonus() {
    if (this.claimMode) return this.claimBonus;
    return this.upperSum >= 63 ? 35 : 0;
  }

  get total() {
    let lower = 0;
    for (const cat of LOWER) if (this.card[cat] !== null) lower += this.card[cat];
    return this.upperSum + this.upperBonus + lower + this.yahtzeeBonus;
  }

  get done() {
    return this.round >= ROUNDS;
  }

  // set the current dice and consume a roll
  applyRoll(dice) {
    this.dice = dice;
    this.rollsLeft--;
  }

  // Validate against potentials(); apply the extra-Yahtzee +100 bonus BEFORE writing
  // the box; write it; advance to the next round. Returns pts, or null if illegal.
  // `blocked` (Category Claim): the opponent's claimed categories — never scorable here.
  scoreCategory(cat, blocked) {
    if (this.dice === null) return null;
    const pot = potentials(this.card, this.dice, blocked);
    if (!pot[cat] || !pot[cat].allowed) return null;
    const pts = pot[cat].pts;
    if (isYahtzee(this.dice) && this.card.yahtzee === 50) this.yahtzeeBonus += 100;
    this.card[cat] = pts;
    this.dice = null;
    this.rollsLeft = 3;
    this.round++;
    return pts;
  }

  // the player chunk of the personalized view-model (§5)
  serialize(includeDice) {
    return {
      card: { ...this.card },
      yahtzeeBonus: this.yahtzeeBonus,
      upperSum: this.upperSum,
      upperBonus: this.upperBonus,
      total: this.total,
      round: this.round,
      rollsLeft: this.rollsLeft,
      dice: includeDice ? this.dice : null,
      done: this.done,
    };
  }
}
