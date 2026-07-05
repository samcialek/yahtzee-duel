// public/js/engine.js
// LocalEngine — the vs-AI engine (ARCHITECTURE.md §5 & §7).
//
// It exposes the SAME game interface as RemoteEngine (net.js):
//
//     roll(holdMask)   score(cat)   holdUpdate(mask)   rematch()   destroy()
//
// and fires opts.onState(view) with a COMPLETE personalized view-model (§5) after every
// game event, so app.js is a dumb renderer that never has to know whether it is driving an
// AI game or a remote one. The view-model is built field-for-field IDENTICALLY to the way
// the server builds it for the human player, so the same render code covers both.
//
// LocalEngine owns two PlayerStates (human + AI) and a single makeShared() per game, and it
// runs the AI itself. Decisions come from this.aiBrain — the heuristic ai.js pair by
// default, or an injected opts.ai (e.g. the "Perfect" policy from ai-optimal.js):
//   - Variant 1 (Classic): strict alternation. The AI turn is a setTimeout chain
//     (~800-1100 ms between roll -> reveal holds -> reroll -> score) using aiBrain.chooseHold /
//     aiBrain.chooseCategory, pushing state at each step so the human watches it play in the
//     shared tray; then the turn is handed back. The AI's dice ARE shown (variant-1 visible turns).
//   - Variants 2/3 (Shared Start / Linked Dice): the AI plays hidden and its round TRAILS the
//     human. After the human scores round r, the AI plays its own round r — computed instantly
//     (same shared dice) via aiBrain.chooseHold / aiBrain.chooseCategory and revealed with one delayed
//     state push (~900 ms apart if catching up several rounds). When the human finishes round
//     13, the AI plays out any remainder. The AI's scorecard fills in live; its dice are NEVER
//     sent (opp.dice is null and is never computed into the view).
//
// Guard preserved from §3/§9: nextDice reads ps.round, so it is never called for a done player.

import { makeShared, makeLuck, nextDice, PlayerState } from '../shared/game.js';
import { aiChooseHold, aiChooseCategory } from './ai.js';

const noop = () => {};
const NO_HOLD = () => [false, false, false, false, false];

// Coerce whatever app.js hands us into a clean bool[5] keep-mask.
function coerceHold(mask) {
  if (!Array.isArray(mask)) return NO_HOLD();
  return [0, 1, 2, 3, 4].map((i) => !!mask[i]);
}

export class LocalEngine {
  /**
   * @param {Object}                 [opts]
   * @param {1|2|3}                  [opts.mode]    variant (defaults to 1)
   * @param {string}                 [opts.youName] the human's display name
   * @param {string}                 [opts.aiName]  the AI's display name
   * @param {(view:Object)=>void}    [opts.onState] receives the personalized view-model (§5)
   * @param {{chooseHold: (ps:Object)=>{hold:boolean[],stop:boolean},
   *          chooseCategory: (ps:Object)=>string}} [opts.ai]
   *        AI decision functions (e.g. the loaded "Perfect" policy from
   *        ai-optimal.js). Defaults to the heuristic ai.js pair. Pacing,
   *        visibility and all engine mechanics are identical either way.
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.mode = opts.mode || 1;
    this.youName = opts.youName || 'You';
    this.aiName = opts.aiName || 'Machine';
    this.onState = opts.onState || noop;
    this.aiBrain = opts.ai || { chooseHold: aiChooseHold, chooseCategory: aiChooseCategory };

    // AI games are serverless, so there is never a room code.
    this.code = null;

    // The two authoritative player states + the per-game shared randomness.
    this.human = new PlayerState();
    this.ai = new PlayerState();
    this.shared = makeShared();
    // Per-player luck tapes make each player's dice reproducible for ANY hold sequence,
    // which is what the post-game "perfect play on your dice" replay needs. nextDice reads
    // ps.luck automatically; serialize() never leaks it. (The AI's is set for symmetry.)
    this.human.luck = makeLuck();
    this.ai.luck = makeLuck();

    // View-model scaffolding.
    this.seq = 0;                       // monotonic; UI animates a roll only on a new seq
    this.starter = 'you';               // variant 1: who takes the first turn (alternates on rematch)
    this.turn = this.mode === 1 ? this.starter : null;
    this.lastRoll = null;               // { who, mask } — consumed (cleared) on each push
    this.oppHold = null;                // variant 1: the AI's live held-dice mask during its turn
    this.rematchVotes = { you: false, opp: false };

    // AI-turn bookkeeping.
    this.pendingHold = NO_HOLD();       // variant 1: the hold the AI revealed, applied on its next reroll
    this.aiStepScheduled = false;       // variants 2/3: guards the catch-up pump against double-scheduling

    // Timer/lifecycle management.
    this.timers = new Set();
    this.destroyed = false;

    // Mirror the remote engine's asynchronous first push: let the caller finish wiring before
    // the initial state arrives.
    this.schedule(() => this.start(), 0);
  }

  // -- Shared game interface (identical to RemoteEngine) ---------------------

  /**
   * Roll the dice. `holdMask` is a bool[5] of dice to KEEP. The first roll of a round ignores
   * it (nextDice re-rolls all five). Illegal calls are silently ignored (server-authoritative
   * parity).
   */
  roll(holdMask) {
    if (this.destroyed) return;
    const ps = this.human;
    if (ps.done) return;
    if (this.mode === 1 && this.turn !== 'you') return;   // not your turn (variant 1)
    if (ps.rollsLeft <= 0) return;                        // no rolls left — must score

    const hold = ps.rollsLeft === 3 ? NO_HOLD() : coerceHold(holdMask);
    const { dice, mask } = nextDice(ps, hold, this.mode, this.shared);
    ps.applyRoll(dice);
    this.lastRoll = { who: 'you', mask };
    this.pushState();
  }

  /** Score the current human dice into `cat`. Illegal categories are ignored (delegated to
   *  PlayerState.scoreCategory, which enforces the joker restrictions). */
  score(cat) {
    if (this.destroyed) return;
    const ps = this.human;
    if (ps.done) return;
    if (this.mode === 1 && this.turn !== 'you') return;   // not your turn (variant 1)
    if (ps.dice === null) return;                         // nothing rolled yet

    const pts = ps.scoreCategory(cat);
    if (pts === null) return;                             // illegal category — ignore
    this.lastRoll = null;

    if (this.mode === 1) {
      // Strict alternation: hand the turn to the AI (unless the game is already over — which
      // can happen when the AI was the starter and thus finishes each round first).
      if (this.human.done && this.ai.done) {
        this.pushState();                                 // phase: 'end'
        return;
      }
      this.turn = 'opp';
      this.oppHold = null;
      this.pushState();
      this.aiTurnStart();
    } else {
      // Variants 2/3: the human plays free; the AI's round trails and catches up on a timer.
      this.pushState();
      this.scheduleAIStep();
    }
  }

  /**
   * Variant-1 spectating relay only. In a live game this forwards the human's held-dice mask
   * to the opponent. In a local AI game the AI never observes the human's holds (they are pure
   * client UI state, submitted only as the `hold` mask on roll), so this is a no-op.
   */
  holdUpdate(_mask) {
    // intentionally empty
  }

  /** Rematch: reset both PlayerStates + fresh makeShared() and push a fresh state. Variant 1
   *  alternates the starter. The AI always accepts, so this restarts immediately. */
  rematch() {
    if (this.destroyed) return;
    this.clearTimers();

    this.human = new PlayerState();
    this.ai = new PlayerState();
    this.shared = makeShared();
    // Per-player luck tapes make each player's dice reproducible for ANY hold sequence,
    // which is what the post-game "perfect play on your dice" replay needs. nextDice reads
    // ps.luck automatically; serialize() never leaks it. (The AI's is set for symmetry.)
    this.human.luck = makeLuck();
    this.ai.luck = makeLuck();

    this.lastRoll = null;
    this.oppHold = null;
    this.pendingHold = NO_HOLD();
    this.aiStepScheduled = false;
    this.rematchVotes = { you: false, opp: false };
    if (this.mode === 1) this.starter = this.starter === 'you' ? 'opp' : 'you';

    // seq stays monotonic across rematches so the UI always sees it advance.
    this.start();
  }

  /** Tear down: stop all pending timers and stop firing callbacks. */
  destroy() {
    this.destroyed = true;
    this.clearTimers();
  }

  /**
   * The HUMAN player's own reproducible-game context, for the post-game "perfect play on your
   * dice" replay (see analysis.js replayOptimal). Returns { shared, luck, mode } where `luck`
   * is the human's tape — never the AI's. `luck` is null only if a game hasn't started.
   */
  luckContext() {
    return { shared: this.shared, luck: this.human.luck, mode: this.mode };
  }

  // -- Game lifecycle --------------------------------------------------------

  /** Push the opening state and, in variant 1, kick off the AI if it is the starter. */
  start() {
    if (this.destroyed) return;
    this.turn = this.mode === 1 ? this.starter : null;
    this.oppHold = null;
    this.lastRoll = null;
    this.pushState();
    if (this.mode === 1 && this.starter === 'opp') this.aiTurnStart();
  }

  // -- Variant 1: the AI turn as a paced setTimeout chain --------------------

  aiTurnStart() {
    if (this.destroyed) return;
    if (this.ai.done) { this.endAITurn(); return; }       // nothing to play — hand back / end
    this.pendingHold = NO_HOLD();
    this.schedule(() => this.aiDoRoll(), this.delay());
  }

  /** Perform one AI roll (first roll or reroll, decided by rollsLeft), then schedule the
   *  hold/score decision. */
  aiDoRoll() {
    if (this.destroyed) return;
    if (this.ai.done) { this.endAITurn(); return; }

    const rollNum = 4 - this.ai.rollsLeft;                // 1 = opening roll, 2/3 = reroll
    const hold = rollNum === 1 ? NO_HOLD() : this.pendingHold;
    const { dice, mask } = nextDice(this.ai, hold, this.mode, this.shared);
    this.ai.applyRoll(dice);

    this.lastRoll = { who: 'opp', mask };
    this.oppHold = rollNum === 1 ? NO_HOLD() : hold.slice();
    this.pushState();

    this.schedule(() => this.aiDecide(), this.delay());
  }

  /** Decide whether to reroll (reveal the new holds and roll again) or stop and score. */
  aiDecide() {
    if (this.destroyed) return;
    if (this.ai.done) { this.endAITurn(); return; }

    if (this.ai.rollsLeft === 0) {                        // out of rolls — must score
      this.schedule(() => this.aiScore(), this.delay());
      return;
    }
    const choice = this.aiBrain.chooseHold(this.ai);
    if (choice.stop) {                                    // keep everything, score now
      this.schedule(() => this.aiScore(), this.delay());
      return;
    }
    // Reveal the chosen holds to the watching human, then reroll after a beat.
    this.pendingHold = choice.hold;
    this.oppHold = choice.hold.slice();
    this.lastRoll = null;
    this.pushState();
    this.schedule(() => this.aiDoRoll(), this.delay());
  }

  /** Choose and write the AI's category, then hand the turn back (or end the game). */
  aiScore() {
    if (this.destroyed) return;
    if (this.ai.done) { this.endAITurn(); return; }
    const cat = this.aiBrain.chooseCategory(this.ai);
    this.ai.scoreCategory(cat);
    this.endAITurn();
  }

  endAITurn() {
    if (this.destroyed) return;
    this.oppHold = null;
    this.lastRoll = null;
    if (this.human.done && this.ai.done) {
      this.pushState();                                   // phase: 'end'
      return;
    }
    this.turn = 'you';
    this.pushState();
  }

  // -- Variants 2/3: the hidden AI catch-up pump -----------------------------

  /** Schedule the AI to advance one round toward the human, ~900 ms later. Re-arms itself
   *  until the AI has caught up (ai.round === human.round) or is done. Guarded so overlapping
   *  human scores never double-schedule. */
  scheduleAIStep() {
    if (this.destroyed) return;
    if (this.aiStepScheduled) return;
    if (this.ai.done || this.ai.round >= this.human.round) return;   // already caught up
    this.aiStepScheduled = true;
    this.schedule(() => {
      this.aiStepScheduled = false;
      this.playAIRoundHidden();
      this.scheduleAIStep();                              // keep catching up if still behind
    }, 900);
  }

  /** Play one full hidden AI round (round = ai.round) synchronously against the shared dice,
   *  then reveal it with a single state push. The AI's dice are never sent. */
  playAIRoundHidden() {
    if (this.destroyed) return;
    if (this.ai.done) return;
    if (this.ai.round >= this.human.round) return;        // never get ahead of the human

    // Opening roll (mode 2/3 -> shared.first[round]); guard: ai is not done here.
    const first = nextDice(this.ai, NO_HOLD(), this.mode, this.shared);
    this.ai.applyRoll(first.dice);

    // Rerolls: brute-force hold selection until the AI decides to stop or runs out of rolls.
    while (this.ai.rollsLeft > 0) {
      const choice = this.aiBrain.chooseHold(this.ai);
      if (choice.stop) break;
      const nr = nextDice(this.ai, choice.hold, this.mode, this.shared);
      this.ai.applyRoll(nr.dice);
    }

    // Score the round.
    const cat = this.aiBrain.chooseCategory(this.ai);
    this.ai.scoreCategory(cat);

    // Reveal: only the scorecard/round advance; dice stay hidden, so no tumble for the opp.
    this.lastRoll = null;
    this.pushState();
  }

  // -- View-model + timers ---------------------------------------------------

  /** Build and emit the personalized view-model (§5), field-for-field as the server does for
   *  the human. `lastRoll` is consume-once: it is captured into the view then cleared, so a
   *  subsequent non-roll push never re-triggers the tumble animation. */
  pushState() {
    if (this.destroyed) return;
    this.seq++;
    const bothDone = this.human.done && this.ai.done;
    const includeOppDice = this.mode === 1;               // opp dice visible ONLY in variant 1
    const view = {
      t: 'state',
      seq: this.seq,
      phase: bothDone ? 'end' : 'play',
      mode: this.mode,
      code: this.code,                                    // null for AI games
      youName: this.youName,
      oppName: this.aiName,
      turn: this.mode === 1 ? this.turn : null,           // null in variants 2/3 (simultaneous)
      you: this.human.serialize(true),
      opp: this.ai.serialize(includeOppDice),
      oppHold: this.mode === 1 && this.oppHold ? this.oppHold.slice() : null,
      lastRoll: this.lastRoll,
      rematch: { you: this.rematchVotes.you, opp: this.rematchVotes.opp },
      result: bothDone ? { you: this.human.total, opp: this.ai.total } : null,
    };
    this.lastRoll = null;                                 // consume-once
    this.onState(view);
  }

  /** Random inter-step pacing for the visible variant-1 AI turn: 800-1100 ms. */
  delay() {
    return 800 + Math.floor(Math.random() * 301);
  }

  /** Register a timer so destroy()/rematch() can cancel it; auto-drops itself on fire and
   *  bails if the engine was torn down in the meantime. */
  schedule(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (this.destroyed) return;
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.aiStepScheduled = false;
  }
}

export default LocalEngine;
