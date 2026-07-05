# Optimal-Play Solver — As-Built Reference

This document describes the exact-DP Yahtzee solver as it exists in `solver/`: a fully computed,
verified value table (`strategy.bin`) plus the pure query/policy layer, CLI tools, and validation
harness built on top of it. The solver produces the **provably optimal decision in every state** of
the game implemented in this repo — which dice to keep at every reroll, which category to score — and
backs the "Perfect" AI opponent, the Strategy Explorer, and the post-game decision analysis.

The table is solved and shipped: 536,448 reachable states, `strategy.bin` is 2,145,792 bytes
(2.1 MB) of Float32 values in the `states.js` index order, and the solved expected score from the
empty card is **254.5877**. See the KEY NUMBERS section for the full result set.

Sibling docs: overall system in `ARCHITECTURE.md`; post-game analysis that consumes this policy in
`ANALYSIS.md`; project-level orientation in `HANDOFF.md` and `README.md`.

## 0. Why exact DP, not sampled RL

The game (solitaire, maximize expected final score) is a finite MDP with known transition
probabilities. Sampled RL (Q-learning/TD) would only converge toward the fixed point that
**full-width value iteration computes exactly**. The state space is small enough to enumerate, so we
solve it exactly: one retrograde sweep, no episodes, no function approximation, zero regret. This is
implemented in `solver/solve.js` and completes in about 9 seconds.

This policy is **EV-optimal**, and EV-optimality is the correct objective for all three variants of
the app. In Classic (variant 1) each player rolls their own dice. In Shared Start (variant 2) and
Linked Dice (variant 3) the shared-dice mechanic makes both players' dice processes identically
distributed, and the server enforces information-hiding so the opponent's dice are never visible.
Because you cannot observe or influence the opponent, maximizing your own expected final score is
unchanged across variants — the same table drives the Perfect AI everywhere. (A
win-probability-maximizing policy — which would deviate from EV-max when trailing or leading late in a
head-to-head — is a plausible alternative but is **not built**; see KNOWN FOLLOW-UPS in `HANDOFF.md`.)

**Validation anchor.** The published benchmark for optimal expected score under official rules
(forced-joker, +100 per extra Yahtzee only when the Yahtzee box holds 50) is **254.5896**
(Verhoeff 1999; Glenn 2006). This solver reaches **254.5877** from the empty state. The 0.0019 gap is
a property of this repo's exact rule encoding, not a bug: an independent all-layers expectimax
(`solver/verify-endgame.js`, a different algorithm) reproduced the table — including the start state —
to a maximum relative error of **5.7e-8**. `solve.js` asserts the start EV lands within ±0.02 of the
254.5896 benchmark before it will write `strategy.bin`; never widen that tolerance to force a pass —
investigate per the Pitfalls section instead.

## 1. State space

**Widget** (the state between turns): `(mask, up, yz)`

- `mask` — 13 bits, bit *i* set ⇔ `CATS[i]` is filled. The category order is fixed by
  `public/shared/game.js`: `ones=0 … sixes=5, threeKind=6, fourKind=7, fullHouse=8,
  smallStraight=9, largeStraight=10, yahtzee=11, chance=12`. `solver/tables.js` `CAT_ORDER`
  mirrors this and is pinned to `game.js` `CATS` by `test-tables.js`.
- `up` — upper-section subtotal **capped at 63** (0..63). Only subset-sum-reachable values exist per
  mask: each filled upper face *f* contributes one of `{0, f, 2f, 3f, 4f, 5f}`, and any partial sum
  ≥ 63 collapses to 63. `states.js` computes these reachable sets once per upper submask (64 of them)
  by a capped subset-sum DP and shares the frozen arrays.
- `yz` — 1 ⇔ the Yahtzee box was filled **with 50**. The `yz` dimension exists only when bit 11 is
  set; widgets with bit 11 clear have only `yz = 0`.

`V(widget)` = expected additional points from the start of a turn in this state to game end under
optimal play (upper bonus and extra-Yahtzee bonuses included as they occur). Terminal widgets
(`mask` = all 13 filled, `0x1fff`) have `V = 0`. There are **536,448** reachable widgets total
(`states.js` `count`), and `strategy.bin` holds exactly that many Float32s.

**Reward on scoring category *c* with final dice *d* from `(mask, up, yz)`** (implemented identically
in `solve.js` `processMask` and `policy.js` `evalTurn`):

- `pts` per joker-aware legality (Section 3); `mask' = mask | bit(c)`.
- Upper *c*: `up' = min(63, up + pts)`; reward += 35 iff `up < 63 && up + pts >= 63` (the bonus fires
  exactly once, on the crossing).
- `yz' = yz || (c === yahtzee && pts === 50)`.
- reward += 100 iff `isYahtzee(d) && bit 11 set && yz === 1` — the extra-Yahtzee bonus, applied
  regardless of which category *c* the dice are scored into. Because it does not depend on *c*, it is
  hoisted out of the max-over-categories.
- `reward = pts + bonuses`, transition to `(mask', up', yz')`.

Masks are processed in **descending popcount** order (`states.js` `masksByPopcountDesc`, popcount 13
→ 0). Scoring always sets a new bit, so every successor of a mask lies in an earlier (higher-popcount)
group and is already solved when the mask is reached.

## 2. Turn computation — the keep-multiset lattice

Dice are exchangeable, so the solver works with **multisets**, not positional tuples. `tables.js`
enumerates all multisets of faces 1..6 of sizes 0..5: `1 + 6 + 21 + 56 + 126 + 252 = 462` keeps, at
size offsets `[0, 1, 7, 28, 84, 210]`. The 252 size-5 multisets (indices 210..461) are the possible
rolls; `ROLL_OFFSET = 210`. Enumeration is size-ascending then lexicographic within a size — this is a
**file-format contract** (it defines child/subset index relationships) and must never change.

Because expectation is linear and dice are i.i.d., "expected value after rerolling the missing dice"
is computed by adding one die at a time — no probability tables needed. For a value function `Base`
defined on the 252 rolls, the lattice fill-down `A` extends it to all 462 keeps:

```
A(k) for |k| = 5  = Base(k)                      // level-specific base on full rolls
A(k) for |k| < 5  = (1/6) · Σ_{v=1..6} A(k ∪ {v})   // one die added at a time
```

`tables.js` `childrenFlat[k*6 + (v-1)]` gives the index of `k ∪ {v}` for every keep of size < 5, so
each fill-down step is six array reads and a multiply. Children always have higher indices than their
parent, so the sweep runs from index `ROLL_OFFSET − 1` down to 0 in a single pass.

Per widget, `solve.js` computes `V` bottom-up (`policy.js` runs the same lattices per query):

1. `S(d)` for all 252 rolls *d*: `max` over LEGAL categories of `reward + V(successor)`
   (Section 1 reward, Section 3 legality).
2. `A2` lattice with `Base = S` → `Best2(d) = max over sub-multisets k ⊆ d of A2(k)`.
3. `A1` lattice with `Base = Best2` → `Best1(d) = max_{k⊆d} A1(k)`.
4. `A0` lattice with `Base = Best1` → `V(widget) = A0(∅)`.

`A2(k)` is the value of keeping multiset *k* with one reroll left; `A1(k)` the value of keeping *k*
with two rerolls left. The sub-multiset max at each `Best` level ranges over every `k ⊆ d`, which
necessarily includes `k = d` (stand pat) and `k = ∅` (reroll everything). `tables.js` `subsets[idx]`
holds the ascending list of every distinct sub-multiset index of each size-5 roll (including the roll
itself and index 0), so the `Best` max is a flat loop over precomputed indices.

`solve.js` preallocates every buffer once (two `Float64Array(462)` lattice buffers plus small
per-widget tables) and does zero allocation inside the per-widget loop; it accumulates in Float64 and
stores Float32. The whole solve is on the order of 10¹⁰ simple ops and completes in **≈9 s**; a
per-query `evalTurn` recomputes a single widget's lattices in **≈0.06 ms**.

## 3. Legality & points per (mask, dice) — equals game.js `potentials()`

The scoring rules live in **one** function, exported as `legalPts(mask, rollIdx, ptsOut)` — an exact
copy in both `solve.js` (which the sweep consumes) and `policy.js` (browser-safe, since `solve.js`
imports `node:fs` and cannot be loaded in the browser). It fills `ptsOut[c]` for every OPEN category —
both legal and joker-blocked ones, mirroring `game.js` `potentials()` display values — and returns the
13-bit legality bitmask (a subset of the open bits):

- **Non-joker** (roll is not a Yahtzee, or bit 11 clear): every open category is legal at its raw
  `scoreCat` value.
- **Joker** (`isYahtzee(dice) && bit 11 set`), face *f* = `dice[0]`, `upBit` = *f*'s upper bit:
  1. `upBit` open → ONLY the matching upper box is legal, `pts = 5f`.
  2. else if any lower box excluding Yahtzee is open → exactly those are legal; pts are the joker
     values `3K/4K/chance = 5f`, `fullHouse = 25`, `smallStraight = 30`, `largeStraight = 40`.
  3. else → the remaining upper boxes are legal at 0.

This is standard **forced-joker** rules. Note the joker *restrictions* trigger on bit 11 being set with
any value (50 or a zeroed 0), but the +100 *bonus* requires `yz === 1` (box holds 50) — a zeroed
Yahtzee box restricts placement without ever paying the bonus.

**Equivalence is pinned by test, not by hope.** `solver/test-rules.js` compares `solve.js`'s
`legalPts` against `potentials(cardFromMask, dice)` from `public/shared/game.js` on **250,000** random
`(mask, dice)` pairs (`cardFromMask` maps filled→0, open→null); `test-policy.js` does the same for
`policy.js`'s copy on 20,000 pairs. Both pass, tying the solver's rules to the game's actual rules
exactly. `verify-endgame.js` goes further and uses `game.js` `potentials()` *directly* as its oracle.

## 4. Modules

All under `solver/`, pure ESM. Every module except `solve.js`, `analyze.js`, `simulate.js`, and
`verify-endgame.js` (which use `node:fs`) is browser-safe; `tables.js`, `states.js`, and `policy.js`
run identically in Node and the browser.

| Module | Role |
| --- | --- |
| `tables.js` | Multiset machinery (pure). Canonical enumeration of all 462 keeps; `children`/`childrenFlat` lattice edges; per-roll `subsets`, raw 13-category `catScores`/`catScoresFlat` (Int8), `isYahtzeeArr`, `yahtzeeFace`. Exports `indexOfMultiset`, `facesOf`, `sizeOf`, `size5Indices`, `CAT_ORDER`, size constants. |
| `states.js` | Widget enumeration & O(1) dense indexing (pure). `idOf(mask, up, yz)` via `base[mask] + upPos·stride + yz`; `count = 536448`; `upListOf`, `hasYzDim`, `masksByPopcountDesc`, `forEachWidgetOfMask`. Defines the `strategy.bin` index order (a file-format contract). |
| `solve.js` | The retrograde value-iteration sweep (Node). Exports `legalPts` (the exact legality+points the sweep uses; importing the module does not run the sweep). Writes `strategy.bin` + `strategy-meta.json` and copies both into `public/`. Flag `--bench` times popcount layers 13..10 and projects the full solve without writing. |
| `policy.js` | Pure `Policy` over an ArrayBuffer + meta, usable in Node and browser. `stateEV(mask, up, yz)`, `evalTurn(mask, up, yz, dice, rollsLeft ∈ {0,1,2})`, static/instance `fromPlayerState(ps)`. Also exports `legalPts`, `TIE_EPS = 1e-9`. |
| `analyze.js` | CLI over the table (Node). |
| `simulate.js` | Plays N full games under the policy with real random dice (Node). |
| `verify-endgame.js` | Independent expectimax cross-check of `strategy.bin` (Node). |

### `states.js` dense indexing

`idOf(mask, up, yz)` returns the dense widget id, or −1 when `up` is unreachable for `mask` (it throws
on genuinely out-of-range arguments, e.g. `yz = 1` with bit 11 clear). The id layout — masks 0..8191
ascending, reachable `up` ascending within a mask, `yz = 0` then `yz = 1` within a `(mask, up)` pair —
**is** the byte order of `strategy.bin`. `Policy`'s constructor validates that `meta.widgetCount` and
the table's float count both equal the freshly enumerated `count`, so a `strategy.bin` built against a
different `states.js` is rejected at load rather than misread.

### `policy.js` — `evalTurn`

`evalTurn(mask, up, yz, dice, rollsLeft)` returns:

- `categories` — every OPEN category, desc-sorted by `ev` (= `pts + bonuses + V(successor)`, computed
  identically for joker-blocked categories, which carry `legal: false` and the same display pts as
  `game.js` `potentials()`).
- `keeps` — every distinct sub-multiset of `dice` (including keep-all and ∅), each `{faces, ev}`,
  desc-sorted by `ev`, valued at lattice level `A1` when `rollsLeft = 2` or `A2` when `rollsLeft = 1`;
  `null` when `rollsLeft = 0`. The sort is stable, so ties keep the canonical enumeration order and
  output is deterministic.
- `best` — `{type: 'score', cat, pts, ev}` when `rollsLeft = 0` or scoring now ties/beats every keep
  (`bestCat.ev >= bestKeepEv − TIE_EPS`), else `{type: 'keep', faces, ev}`. The tie rule prefers
  scoring; because the keep-all option is itself valued at the score-now EV, keep-all never wins a tie.

`fromPlayerState(ps)` maps a live or serialized `PlayerState` to `{mask, up, yz}`: `up = min(63,
upperSum)`, `yz = card.yahtzee === 50 ? 1 : 0`. This is the only place the solver touches game-shaped
state; the sweep itself is pure `(mask, up, yz)` arithmetic and never references `PlayerState` or
`nextDice`.

### `analyze.js` — CLI

```
node solver/analyze.js                                            # empty-card state EV
node solver/analyze.js --filled ones,fullHouse --up 3
node solver/analyze.js --filled yahtzee --yz --up 12 --dice 6,6,6,6,6 --rolls 1
node solver/analyze.js --dice 1,2,3,4,6 --rolls 2
```

Flags: `--filled a,b,c` (comma-separated category names, default none), `--up N` (0..63, must be
reachable), `--yz` (bare or `0/1`; requires `yahtzee` in `--filled`), `--dice a,b,c,d,e` (omit for
state EV only), `--rolls 0|1|2` (default 2, only meaningful with `--dice`). It loads `strategy.bin` +
meta, builds the state, and prints the state EV; with dice it prints ranked keeps (top 10 plus
keep-all and reroll-all always shown, best marked) and ranked categories (joker-blocked ones dimmed),
then the single best action.

### `simulate.js` — Monte-Carlo validation

`node solver/simulate.js [--n N]` (default `--n 10000`) plays N full games with real `Math.random`
dice through the actual `public/shared/game.js` rules (`PlayerState` / `nextDice` / `scoreCategory`),
taking every decision from `policy.evalTurn`. It reports mean/σ/min/max, `P(score ≥ 300)`, Yahtzee
rate, extra-Yahtzee bonus count, and upper-bonus rate, and hard-asserts `|mean − 254.59| < 2.0` (σ ≈ 60
→ 3σ of the mean ≈ 1.8 at N = 10k), that `scoreCategory` never returns null (no illegal action is ever
chosen), and that the game's awarded pts equal the policy's predicted pts on every scoring move. The
200,000-game figures in KEY NUMBERS come from a larger run of this same tool.

## 5. App integration — one table, three consumers

`strategy.bin` and `strategy-meta.json` are produced by `solve.js` and copied into `public/`; the
server (`server.js`) serves `.bin` as `application/octet-stream` and `.json` as `application/json`
with a `Content-Length`. Everything downstream goes through `policy.js` — there is no second copy of
the DP anywhere.

- **Perfect AI** — `public/js/ai-optimal.js`. `loadOptimalAI(baseUrl = '')` fetches `/strategy.bin` +
  `/strategy-meta.json`, builds a `Policy`, and returns `{chooseHold(ps), chooseCategory(ps), policy}`
  with EXACTLY the signatures of the heuristic `public/js/ai.js` (`{hold: bool[5], stop: bool}` /
  category string), so `LocalEngine` consumes either interchangeably via `opts.ai`. The policy reasons
  over multisets; the game holds positional dice, so `holdMaskFromKeep(dice, keepFaces)` (also
  exported) greedily marks positions until the kept face counts match the chosen keep. `stop === true`
  ⇔ `evalTurn`'s `best.type === 'score'`. On any fetch/validation failure `loadOptimalAI` throws and
  the caller (app) falls back to the Standard heuristic. The home screen exposes a Standard/Perfect
  sub-toggle; Perfect preloads the table before the game starts.
- **Strategy Explorer** — `public/explore.html` + `public/js/explore.js`. The interactive front end
  over `Policy`: set filled categories, upper total, the Yahtzee-holds-50 flag, five dice, and
  rolls-left, and see the state EV plus ranked keeps and category choices. Linked from the home footer.
- **Post-game analysis** — `public/js/analysis.js` (see `ANALYSIS.md`) uses the same `Policy` to score
  each recorded decision against the optimal one and tally cumulative EV loss. `PERFECT_EV = 254.5877`
  there is this solver's start EV.

## 6. Independent verification

- **`verify-endgame.js`** — a from-scratch recursive expectimax for widgets with popcount ≥ 11. It
  evaluates each reroll by DIRECT ENUMERATION of outcome multisets with multinomial weights — no
  keep-multiset lattice, no `children` fill-down, no code shared with the sweep. Its only reuse is
  `states.js` `idOf` (the index contract under test) and `game.js` `potentials()`/`CATS` as the
  legality oracle (making the check end-to-end against the app's authoritative rules). It samples
  ~500 widgets (including forced-joker pairs — same `(mask, up)` with both `yz` values — and terminal
  popcount-13 widgets that must be exactly 0) and PASSES iff the max relative error vs `strategy.bin`
  is < 1e-6 and terminals are 0. Measured max relative error: **5.7e-8**.
- **Rule consistency** — `test-rules.js` (250k pairs) and `test-policy.js` (7 groups) pin `legalPts`
  to `game.js` `potentials()`.
- **Table & state structure** — `test-tables.js` (exhaustive over all 462 keeps / 252 rolls,
  including all 252×13 raw scores vs `game.js` `scoreCat`) and `test-states.js` (indexing, popcount
  order, reachability). All solver tests pass, alongside the app-level suites listed in `HANDOFF.md`.

## KEY NUMBERS

| Quantity | Value |
| --- | --- |
| Reachable widgets (`states.js` count / `meta.widgetCount`) | 536,448 |
| `strategy.bin` size | 2,145,792 bytes (Float32, `states.js` index order) |
| Keeps / rolls | 462 / 252 (`ROLL_OFFSET` 210) |
| Solved start EV (empty card) | 254.5877 (`meta.startEV` = 254.58772873449504) |
| Published benchmark (Verhoeff/Glenn) | 254.5896 (gap 0.0019, a rule-encoding property) |
| Independent expectimax max relative error | 5.7e-8 |
| Solve time (`solve.js`) | ≈9 s |
| `evalTurn` latency | ≈0.06 ms |
| 200k-game simulation, mean | 254.574 |
| 200k-game simulation, σ | ≈59.9 |
| P(score ≥ 300) | 0.143 |
| Yahtzee rate (box = 50) | 0.336 |
| Upper-bonus rate (upper ≥ 63) | 0.681 |

The simulation mean (254.574) sits just under the solved EV (254.5877) as expected for a finite
sample with σ ≈ 60.

## Pitfalls (each has burned someone before)

- The upper bonus fires on the **crossing** (`up < 63 && up + pts >= 63`), exactly once, inside the
  reward — not whenever `up === 63`.
- +100 requires `yz === 1` (box holds 50). A zeroed Yahtzee box triggers joker RESTRICTIONS (bit 11
  set) but never the bonus. Joker restriction trigger = bit 11 set at any value; bonus trigger =
  bit 11 set AND `yz === 1`.
- Scoring the yahtzee category with a non-Yahtzee (0 pts) sets bit 11 with `yz = 0`; scoring a genuine
  Yahtzee there (50 pts) sets `yz = 1`.
- The sub-multiset max at each `Best` level must include stand-pat (`k = d`) and reroll-all (`k = ∅`).
- Solve order is popcount DESCENDING; `V` for popcount *p+1* must be fully written before any
  *p*-mask is processed. `up`/`yz` order within a mask is irrelevant (successors always flip a bit).
- Float32 storage is fine (values < 1600, rel. eps ~1e-7), but ACCUMULATE in Float64.
- The solver is pure `(mask, up, yz)` math; only `policy.js` `fromPlayerState` bridges to
  `PlayerState`. Do not reach for `nextDice`/`PlayerState` inside the sweep.
- On Windows, write the binary via `Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)`, never as
  a string. The dev server on port 3000 may be running — tests must use a different port and must not
  kill it.
