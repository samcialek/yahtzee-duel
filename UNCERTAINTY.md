# Luck vs Skill — the perfect-vs-near-perfect win rate

This is the as-built design of the luck/skill readout on the variant-selection screen. It
answers one question per variant: **if you play better than your opponent, how often do the
rules let that decide the game?** The estimate is a single Monte-Carlo calculation run offline
by `solver/uncertainty.js`, which writes `public/uncertainty.json`; the browser
(`public/js/uncertainty-ui.js`) reads that tiny JSON and paints a split bar under each variant
card.

## The one calculation

A **perfect player** plays head-to-head against a **near-perfect player**, N games per variant.

- **Perfect player** — the solver-optimal action (`policy.evalTurn(...).best`) at every
  decision.
- **Near-perfect player** — also computes the EV of every available option, but when **two or
  more options sit within 4 EV points of the best**, it picks **uniformly at random among that
  near-tie set**; otherwise it takes the best. (The window is 4 — a middle ground between a tight
  3, a near-optimal opponent, and a loose 6, a dramatically imperfect one.) The option set
  per decision:
  - `rollsLeft > 0`: every distinct keep sub-multiset of the current dice (incl. keep-all and
    keep-none) **plus** every legal score-now category — all on the same EV scale, so one pool;
  - `rollsLeft = 0`: every legal category.

The definition of the readout:

> If the perfect player wins **100%** of those games, the variant is **100% skill** — the rules
> let the better play decide every game. If it wins only **50%** — no better than a coin flip —
> the better play never mattered: **0% skill**. Linearly in between:

```
skill% = 2 × (winRate − 50%)   clamped to [0, 100]
luck%  = 100 − skill%
```

A tied final score counts as half a win.

## The dice (per variant)

Each game draws one shared bank `shared = makeShared()` and two per-player luck tapes
`luckA, luckB = makeLuck()`. The perfect player plays with `(shared, luckA, mode)` and the
near-perfect player with `(shared, luckB, mode)` by setting `ps.luck`; `nextDice` then applies
the variant's dice sharing automatically:

- **mode 1 — Classic:** fully independent dice.
- **mode 2 — Shared Start:** shared opening roll (`shared.first`), independent rerolls.
- **mode 3 — Linked Dice:** shared opening + k-indexed shared rerolls (`shared.rerolls`).

Sharing dice makes the two scores **positively correlated**, which cancels in the margin — the
same near-perfect skill deficit (mean margin ≈ 53 pts in every variant, with the 4-EV window) is
decided less by the dice and more by the play as the sharing deepens. That is exactly what the
readout measures.

The same tapes are re-shared across the three variants within a game (common random numbers),
and each game's RNG stream is seeded from `(seed, gameIndex)`, so the JSON is reproducible and
independent of worker count.

## Predicted behavior (the sanity checks)

1. **Mean margin ≈ constant across variants** — a single player's score distribution is
   variant-independent, so the near-perfect player's expected deficit doesn't move.
2. **Margin std shrinks 1 → 2 → 3** — shared dice cancel the common luck.
3. Therefore **win rate and skill% rise 1 → 2 → 3**. Linked Dice is the most skill-driven
   variant.

## Match length (`pointsGamesTo95`) — games to a 95% score lead

Each variant card shows the **fewest games until the perfect player is >95% likely to have the
higher SUMMED score** across those games — `P(Σ margin > 0) ≥ 0.95`, where `margin` is
perfect-minus-near-perfect points in a single game. `solver/uncertainty.js`'s `pointsGamesTo95`
builds the exact integer histogram of the per-game margin from the raw simulation, convolves it
`N` times, and returns the smallest `N` clearing 0.95.

Summed points has **no parity sawtooth**: an exact tie of the running point *total* is
vanishingly rare (unlike a tie in game-*wins*, which is common at even lengths — see below), so
`P(Σ margin > 0)` climbs essentially monotonically in `N` and any length, even or odd, is a fair
answer. The margin is also **right-skewed** (the perfect player's upside tail runs longer than its
downside), which is why the shipped points-based lengths (6 / 5 / 3) don't all match a naïve
normal approximation `z²·(σ/μ)²` (≈5.75 / 5.08 / 3.01 → would round to 6 / 6 / 4) — Shared Start
clears 95% a full game earlier than the normal shortcut predicts, because of that skew. The exact
convolution is what's shipped.

### Background: the win-based best-of-N (`gamesTo95`)

The JSON also carries a second, win-based statistic: the **best-of series length at which perfect
play takes the majority of *games* (not points) with >95% probability** — the shortest series in
which the better player reliably wins more games than they lose. Each game is an independent step
in the win-difference `D`: +1 (perfect win, `pWin`), −1 (perfect loss, `pLose`), 0 (tie, `pTie`).
`gamesTo95` convolves the exact distribution of `D` and returns the smallest **odd** length `N`
with `P(D > 0) > 0.95`.

**Why odd (a "best-of-N"):** `P(D > 0)` — strictly more wins, i.e. a majority — is a *parity
sawtooth* in `N`. At an even length the match can end **tied on wins** (`D = 0`), which isn't a
majority, so `P(D > 0)` dips below the neighbouring odd lengths. Concretely, `P(D = 0)` is ~0.3%
at odd `N` but jumps to ~8% at `N = 6` (Classic), and that draw mass is subtracted from
`P(D > 0)`. The exact one-step recurrence makes it precise:
`P(win, N+1) − P(win, N) = pWin·P(D_N = 0) − pLose·P(D_N = 1)`, which is negative across every
odd→even step. So the odd lengths are the peaks and the even lengths the troughs; the first length
to clear 0.95 is always odd. (This was verified by a four-method investigation — exact
enumeration, Monte Carlo at z > 170, rational-arithmetic convolution, and a code audit — all
confirming the sawtooth is real, not a bug.) This win-based figure is not currently shown on the
cards — the points-based one above is — but it's kept in the JSON and this doc since "best-of-N
series" is the more familiar framing and may be surfaced again later.

## Shipped numbers (from `public/uncertainty.json`, seed 1, N = 100,000 games/variant, 4-EV window)

| Variant | Win% | Luck% | Skill% | Mean margin | Margin std | Games to 95% score lead | Win-based best-of |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Classic | 79.5 | 40.9 | 59.1 | 53.3 | 77.8 | 6 | 7 |
| Shared Start | 81.2 | 37.5 | 62.5 | 52.9 | 72.5 | 5 | 7 |
| Linked Dice | 86.8 | 26.4 | 73.6 | 53.2 | 56.0 | 3 | 3 |

Mean margin is ~constant and skill% rises 1 → 2 → 3, as predicted. (The 4-EV tie window sits
between the two extremes we tried: the near-perfect player gives up ~53 pts on average — versus
~35 at a tight 3-EV window and ~82 at a loose 6-EV one — a meaningful but not exaggerated gap.)
Both match-length figures fall with skill: Linked Dice settles at 3 games either way, while the
noisier Classic and Shared Start take longer — 6 and 5 games respectively to a 95% score lead,
7 each for a 95% series win.

## Regenerate

```
node solver/uncertainty.js                     # defaults N=50000; writes public/uncertainty.json
node solver/uncertainty.js --N 100000 --seed 1 # the shipped run
node solver/uncertainty.js --single            # single-threaded (default uses worker_threads)
```

The script prints a table and the monotonicity sanity check alongside writing the JSON. The
browser readout fails soft: if the JSON is missing or malformed the bars hide themselves and
the game still starts normally.
