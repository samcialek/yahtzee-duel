# Post-Game Decision Analysis — As-Built Reference

Status: **built, wired, and tested.** This document describes the shipped post-game analysis
feature and the reasoning behind it. For the solver it queries, see SOLVER.md; for the view-model
and engine interface it hooks into, see ARCHITECTURE.md; for the project overview and run
instructions, see README.md and HANDOFF.md.

The feature is a chess-engine-style review of the **human player's own decisions**. When a game
ends, every keep/score choice you made is compared against the exact optimal policy (the solved
value table), yielding an EV loss per decision and a running cumulative tally. It works for **every**
game type — vs the Standard heuristic AI, vs the Perfect AI, and live multiplayer — because the
grading is purely client-side over your own moves. The server never grades or computes analysis; its
only involvement is handing a multiplayer player their OWN reproducible dice tape at game end (§3.5) so
the client can compute the same-luck "perfect play on your dice" closing line — the opponent's tape is
never transmitted.

The implementation lives in `public/js/analysis.js` (pure grading + rendering) with recording and
panel wiring in `public/js/app.js`. It is validated headlessly by `test-analysis.js` (10 checks)
against the real `public/strategy.bin`.

## 1. Module surface (`public/js/analysis.js`)

The module is deliberately split into a **pure half** (Node-testable, no DOM) and a **DOM half**:

| Export | Kind | Purpose |
| --- | --- | --- |
| `OPTIMAL_EPS = 0.01` | const | Float32 noise floor. A decision is optimal iff its EV loss is below this. |
| `PERFECT_EV = 254.5877` | const | Perfect-play expectation from the empty card (SOLVER.md anchor). No longer feeds the closing line — kept as the documented reference figure. |
| `recordDecision(log, view, action)` | pure | Append one decision snapshot to `log`. |
| `analyze(log, policy)` | pure | Grade every recorded decision against the optimal policy → report. No DOM. |
| `replayOptimal(context, policy)` | pure | Replay the player's OWN game (same `{shared, luck, mode}` tape) under optimal decisions → the same-luck perfect final score (integer), or `null` if the luck context/policy is missing. Powers the closing line. No DOM. |
| `renderAnalysis(report, containerEl, opts)` | DOM | Render a report into a container (`innerHTML` replaced). The only DOM-touching export. |

Keeping `recordDecision` and `analyze` free of DOM access is what lets `test-analysis.js` replay a
full scripted game in Node and grade it against `strategy.bin` with zero browser.

## 2. Decision recording (during play)

Recording happens in `app.js` at action-dispatch time, into a module-level `moveLog` array.
`recordDecision(log, view, action)` reads only `view.you` (the personalized view-model's own-player
block) and pushes a snapshot. Because both engines push the identical view-model shape, the same two
call sites cover LocalEngine (AI) and RemoteEngine (multiplayer) with no branching:

- **Reroll decisions** — `doRoll()`: when you click Roll with dice already on the table
  (`view.you.dice !== null`), the action is the kept multiset, built as
  `{ type: 'keep', faces: view.you.dice.filter((_, i) => held[i]) }`.
- **Score decisions** — `doScore(cat)`: when you click an open category, the action is
  `{ type: 'score', cat }`. Scoring while rolls remain is itself a decision, graded against the keep
  alternatives.

**A decision exists only where alternatives existed.** The forced first roll of a round (dice all
five, no choice to make) is *never* recorded: `doRoll()` guards on `view.you.dice !== null`, and
`recordDecision` itself returns early when `view.you.dice` is not an array. So the log holds only
points where `rollsLeft` is in {0, 1, 2}.

`recordDecision` also drops a **duplicate at the same `(round, rollsLeft)`**: at most one decision
can exist per point, so a repeat call — e.g. a double-click racing the next state push — is ignored
(the first action wins, matching the engine, which only honors the first action).

Each snapshot captures exactly what analysis needs, decoupled from live state:

```
{ round, rollsLeft, dice: [...5 faces],
  action: {type:'keep', faces:[...]} | {type:'score', cat},
  card: { ...you.card },              // shallow copy of your scorecard
  yzFifty: you.card.yahtzee === 50 }  // did the Yahtzee box hold 50 at decision time
```

`moveLog` is reset by `resetAnalysis()` on every new game, rematch, and leave. In `handleState`, a
transition from `phase === 'end'` back to `phase === 'play'` (a rematch on either engine) also calls
`resetAnalysis()`, so a fresh game never inherits the finished game's log or cached report.

## 3. Grading (`analyze`, pure)

`analyze(log, policy)` reconstructs solver coordinates from each snapshot and grades it via
`policy.evalTurn` (SOLVER.md `solver/policy.js`). Coordinate reconstruction (`coordsOf`) mirrors the
solver's own state encoding exactly:

- **mask** — set bit `c` for every filled category, iterating `CATS` in the solver's canonical bit
  order (`ones`=bit 0 through `chance`=bit 12).
- **up** — sum of the six filled upper boxes, clamped to `min(63, up)` (the upper widget saturates
  at the 63 needed for the bonus).
- **yz** — `1` when `entry.yzFifty` (the Yahtzee box held 50 at decision time), else `0`.

For each entry it runs `policy.evalTurn(mask, up, yz, dice, rollsLeft)`, which returns
`{ categories, keeps, best }`:

- **chosenEV / yoursLabel** — for a keep action, match the entry against the `keeps` array by
  *sorted face multiset* (so holding `[3,3]` out of `[3,3,3,5,6]` grades against the `[3,3]` entry —
  not `[3]`, not `[3,3,3]`); `chosenEV` is that entry's `ev`. For a score action, find the category
  in `categories`; `chosenEV` is its `ev`, and the label carries the box's points. A kept multiset
  that is not a sub-multiset of the rolled dice, or a category not open on the recorded card, throws
  — these are logic errors, not user-facing states.
- **bestEV** — the overall best over the two option sets: the max `ev` among **legal** categories,
  unioned with the top keep (`keeps[0].ev`, since `evalTurn` returns keeps desc-sorted by ev).
  `keeps` is `null`/empty at `rollsLeft = 0`, so at the final roll only categories compete.
- **loss** — `max(0, bestEV − chosenEV)`. **A decision is optimal iff `loss < OPTIMAL_EPS`**
  (0.01) — the clamp and threshold absorb Float32 rounding in the table so a numerically-tied best
  move never reads as a mistake.
- **optimalLabel** — derived from `evalTurn`'s own `best`: `score <Category> (<pts>)` when
  `best.type === 'score'`, else a keep phrase (`reroll everything` / `stand pat` / `keep a · b · c`).

The report the UI consumes:

```
{ decisions: [{ round, rollsLeft, dice, yoursLabel, optimalLabel, loss, optimal, cumLoss }],
  totalLoss, nOptimal, nDecisions, accuracyPct, worst: decision|null, perRoundCum: [{round, cumLoss}] }
```

`cumLoss` is the running EV-lost tally shown in the ledger's rightmost column; `perRoundCum` collapses
it to one entry per round for a per-round view; `worst` is the highest-loss non-optimal decision (or
`null` if the game was flawless). `accuracyPct` is `100 · nOptimal / nDecisions` (100 on an empty log).

Because grading depends only on the recorded log and a `Policy`, the *same* `analyze` output is
produced whether the game was solitaire-vs-AI or a live room — analysis is over your moves alone.

## 3.5 Same-luck perfect replay (`replayOptimal`, pure)

The closing line answers one question: **what would a perfect player have scored on _your_ dice?** Not
the abstract 254.59 average — the exact score the optimal policy would have posted facing the very
outcomes you faced this game.

That is possible because of the **luck tape** (see below): a player's `ps.luck` makes their whole game
reproducible for *any* sequence of hold decisions. `replayOptimal(context, policy)` takes the finished
player's own `context = { shared, luck, mode }`, seeds a fresh `PlayerState` with `ps.luck = luck`, and
plays all 13 rounds driven entirely by `policy.evalTurn` — opening each round with `nextDice(ps,
NO_HOLD, mode, shared)` and, on each reroll, holding `holdMaskFromKeep(ps.dice, best.faces)` — until
`best.type === 'score'`, then scoring `best.cat`. It returns `ps.total` (an integer), or `null` if
`context`, `context.luck`, or `policy` is missing.

Because the tape fixes *every* die a reroll could draw by position, the optimal line sees the same luck
you did — even for dice it chooses to reroll that you kept, or vice versa. This is a pure function
(`PlayerState` + `nextDice` + `fromPlayerState` + a `Policy`), so `test-luck.js` exercises it headlessly.
It uses the SAME solver policy import path as `ai-optimal.js` (`../../solver/policy.js` /`fromPlayerState`)
and reuses `holdMaskFromKeep` from `ai-optimal.js`, so the replay's decisions are byte-identical to the
Perfect AI's.

### The luck tape (`ps.luck` / `makeLuck`)

`makeShared()` fixes the dice a game *shares* between players (variant-2/3 openings, variant-3 rerolls
by k-index). `makeLuck()` fixes the rest of a *single* player's randomness up front: `opening[round]`
(the variant-1 opening) and `reroll[round][r][pos]` (the value each die **position** takes on reroll
`r`, variants 1 & 2). When a `PlayerState` carries `ps.luck`, `nextDice` draws from the tape instead of
live `rng()` — statistically identical, just pre-committed — which is what makes the game reproducible
for any holds. `serialize()` never includes `luck`, so it cannot leak through the normal view-model.

The finished player's own `{ shared, luck, mode }` reaches the client two ways, one per engine:

- **LocalEngine (vs AI)** — exposes it directly: `luckContext()` returns
  `{ shared: this.shared, luck: this.human.luck, mode: this.mode }` — the **human's** tape, never the
  AI's (the AI carries its own tape only for symmetry). `null` luck only before a game starts.
- **Multiplayer** — the **server** hands each player THEIR OWN tape once, in that player's own
  end-of-game state payload: `stateFor` sets `luckContext: over ? { shared: room.shared, luck: me.ps.luck } : null`.
  **Only `me.ps.luck` is ever sent — never the opponent's** (the opponent's dice/luck stay on the server,
  preserving variant-2/3 information hiding). `RemoteEngine` mirrors `msg.luckContext` verbatim onto
  `this._luckContext` on every state, so it is captured at game end and auto-cleared to `null` when a
  rematch's first in-play state arrives; its `luckContext()` returns `{ shared, luck, mode: this.mode }`
  to match `LocalEngine`'s shape. Both engines therefore present one identical method to `app.js`.

## 4. Rendering (`renderAnalysis`, DOM)

`renderAnalysis(report, containerEl, opts)` replaces `containerEl.innerHTML`. All strings are
app-generated (dice faces, labels, numbers) — no user-controlled text is interpolated. It renders:

- **Summary line** (`.an-summary`) — `N of M decisions optimal (X%) · total EV lost Y.Y · worst:
  round R (−Z.Z)`.
- **Ledger** (`.an-ledger`) — a header row plus one `.an-row` per decision, grouped under
  `.an-round` headings. Each row shows the dice as Unicode die glyphs, a rolls-left marker
  (three pips, filled ones = rolls remaining, mirroring the in-game dots), *You played*, *Optimal*,
  the EV delta (a vermillion negative number on a mistake, a quiet check when optimal), and the
  running total lost. Optimal rows carry class `is-ok`; mistakes carry `is-loss` and the ink.
- **Closing line** (`.an-closing`) — the **same-luck perfect score on the player's OWN dice**
  (`replayOptimal`, §3.5): *Perfect play on your dice would have scored P — you left L points on the
  table* when `P > yourScore`; *…also scored S — you matched the optimal line* on a tie; and *…scored P;
  you scored S — your rolls broke your way and you beat the optimal line by B* when the human beat it
  (dice a perfect line would have rerolled but the human kept can, occasionally, out-score the optimal
  line on that same tape). When the luck context is unavailable (`perfectScore == null`) the closing
  line is **omitted entirely** — no fallback sentence.
- **Empty state** — a single `.an-status` line when `nDecisions === 0`.

`opts` is `{ perfectScore, yourScore }`. `app.js` (`analysisRenderOpts`) supplies `yourScore` from the
view-model (`view.result.you`, or `view.you.total`) and computes `perfectScore` by calling
`replayOptimal(engine.luckContext(), optimalAI.policy)` — but only once the strategy table is loaded
(`optimalAI`) and the engine exposes `luckContext()`; any throw, or a missing/null luck context, leaves
`perfectScore = null` and the line is dropped. `finalScore`/`perfectEV` and the old ±254.59 line are
gone; `PERFECT_EV`/`meta.startEV` no longer participate in rendering.

## 5. Reaching the panel (`app.js` wiring)

The panel is an overlay that swaps with the end-of-game overlay (DOM CONTRACT in `index.html`):

- **`#overlay-end`** gains an **Analysis** button (`#btn-analysis`, alongside Rematch / New game).
- **`#overlay-analysis`** holds `#analysis-content` (which `renderAnalysis` fills, and which also
  shows the loading / failure `.an-status` line) and a Back button (`#btn-analysis-back`).

`openAnalysis()` hides `#overlay-end`, shows `#overlay-analysis`, and:

1. If a report is already cached (`analysisReport`), re-renders it immediately.
2. Otherwise it lazy-loads the strategy table. The Policy is **shared with the Perfect AI**: if a
   Perfect game was already started, `optimalAI` is populated and reused; if not, `openAnalysis`
   runs the same lazy path — `import('./ai-optimal.js')` then `loadOptimalAI('')` — which fetches
   `strategy.bin` (2.1 MB) + `strategy-meta.json` once and caches the instance for later. A Perfect
   game started afterward reuses this same instance. It shows a "Consulting the strategy table" status
   while loading, then runs `analyze(moveLog, optimalAI.policy)`, caches the report, and renders.

`closeAnalysis()` (Back) hides the analysis overlay and, if still at game end, restores the end
overlay. While the analysis overlay is open, `render()` deliberately keeps the end overlay swapped
out even as fresh states arrive (e.g. multiplayer rematch-vote pushes), so the panel is not yanked
away mid-read.

### Concurrency guards

- **`analysisBusy`** — a boolean that ignores repeat Analysis clicks while the table is fetching.
- **`analysisGen`** — a generation counter bumped by `resetAnalysis()`. `openAnalysis` snapshots
  `gen = analysisGen` before the `await`; if a rematch or new game resets the log mid-fetch, the
  counter advances and the stale run **bails without analyzing or caching** the vanished log (and
  suppresses its error status). This is the verified guard against a rematch-racing-the-table-fetch.
- **Fetch failure** → a graceful `.an-status` message in the panel ("The analysis couldn't be
  prepared — check your connection and try again."), never an alert, and only if the run is still
  current.

## 6. Verification (`test-analysis.js`, 10 checks)

`test-analysis.js` replays a **scripted** 13-round solitaire game through the real `PlayerState` +
`nextDice` (`public/shared/game.js`), recording every decision with the exact call shapes `app.js`
uses, then grading with `analyze` over the real `public/strategy.bin`. Dice are made deterministic by
scripting `nextDice`'s rng (a forced-face queue, then a seeded LCG). Two deliberate blunders are
injected; every other decision plays the policy's own `best`:

- **A** — round 1, `rollsLeft 2`: reroll a *made* large straight `[2,3,4,5,6]`.
- **B** — round 2, `rollsLeft 2`: score Chance (30) on a natural Yahtzee `[6,6,6,6,6]` with the
  Yahtzee box open.

The suite asserts (10 `ok` checks): the forced first roll is never logged and a duplicate
`(round, rollsLeft)` call is dropped; the scripted game completes with a decision per round; exactly
the two injected blunders carry `loss > 0.01`; every policy-played decision reports `loss < 0.01`;
each blunder's loss equals `bestEV − chosenEV` recomputed *independently* via `evalTurn`; `cumLoss` is
nondecreasing and its final value equals `totalLoss` equals the loss sum; `nOptimal` / `accuracyPct` /
`worst` / `perRoundCum` are mutually consistent; the documented label shapes appear (`reroll
everything`, `score Chance (30)` vs `score Yahtzee (50)`); and keep-multiset matching grades held
faces `[3,3]` against the `[3,3]` entry — distinct from `[3]` and `[3,3,3]`. Run: `node test-analysis.js`
(pure computation — never touches port 3000).

The luck-tape mechanism the closing line rests on has its own suite, **`test-luck.js`** (4 checks, run
`node test-luck.js`): **FIDELITY** — across all three modes, driving a game with a fixed hold sequence
then replaying that sequence over the same `(shared, luck)` tape reproduces the identical dice trace and
final total; **UNIFORMITY** — the raw values `makeLuck` lays down are uniform over 1..6 within ~1% over
a few million samples; **REPLAY MEAN** — `replayOptimal` over thousands of random mode-1 tapes averages
within 3.0 of 254.59 and is deterministic (same tape → same score), with `null`/luckless contexts
returning `null`; **NO-LUCK PARITY** — with `ps.luck` unset the old `rng`/shared-dice behavior is intact.

## 7. Open follow-ups (low priority)

Two known edge cases remain, both minor and non-blocking:

- **Remote double-click roll race** — on the RemoteEngine path a very fast double Roll click can, in
  principle, race the state push. `recordDecision`'s duplicate-`(round, rollsLeft)` drop and the
  server's first-action-wins rule cover the recorded log; the residual case is cosmetic.
- **Duplicate `strategy.bin` fetch edge** — a narrow interleaving where the Perfect AI and the
  analysis panel could each initiate the table fetch before either populates `optimalAI`. The result
  is at worst one redundant download; correctness is unaffected because both resolve to an equivalent
  Policy.

Neither changes analysis output; both are cleanup items, not bugs affecting grading.
