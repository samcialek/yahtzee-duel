# Luck vs Skill — the uncertainty decomposition

This is the as-built design of the luck/skill readout on the variant-selection screen. It
answers one question per variant: **of the things that decide who wins, how much is the dice
(luck) and how much is the gap in play (skill)?** The estimate is a nested Monte-Carlo run
offline by `solver/uncertainty.js`, which writes `public/uncertainty.json`; the browser
(`public/js/uncertainty-ui.js`) reads that tiny JSON and paints a split bar under each variant
card.

## What is decomposed

The object of study is the **match margin**

```
M = S_A − S_B          (final-score difference of the two players; sign(M) = winner)
```

We split the variance of `M` by the **law of total variance**, conditioning on the skill pair
`Θ = (epsA, epsB)`:

```
Aleatory  = E_Θ[ Var_Ω(M | Θ) ]    // skills fixed, dice swing the margin   → LUCK
Epistemic = Var_Θ[ E_Ω(M | Θ) ]    // dice averaged out, skill gap swings it → SKILL

Aleatory + Epistemic = Var(M)      (exactly)
```

Each term is reported as an absolute variance and as a percentage of `Var(M)`. The two
percentages sum to ~100 per variant — that identity is the headline sanity check.

## The skill model (the eps-player)

A player's skill is a single knob `eps ∈ [0, 1]`. An **eps-player** plays the solver-optimal
move (`policy.evalTurn`) except with probability `eps`, when it instead takes a **uniformly
random legal action**:

- at a **reroll** decision (`rollsLeft ∈ {1,2}`): a fair coin picks between *score now* → a
  uniformly random legal category, and *reroll* → a random keep submask of the current dice
  (each die held with probability 1/2);
- at **`rollsLeft = 0`**: a uniformly random legal category.

`eps = 0` is perfect play; `eps = 1` is fully random legal play. Each player's `eps` is drawn
independently, once per outer skill-pair, from the active spread's distribution.

### Skill spreads

| Key | Label | `eps` distribution |
| --- | --- | --- |
| `experts` | Experts | `U(0, 0.15)` |
| `mixed` | Mixed (default) | `U(0, 0.6)` |
| `novices` | Novices | `U(0.3, 0.85)` |

## The dice (per variant)

Each inner game draws one shared bank `shared = makeShared()` and two per-player luck tapes
`luckA, luckB = makeLuck()`. Player A plays with `(shared, luckA, mode)` and B with
`(shared, luckB, mode)` by setting `ps.luck`; `nextDice` then applies the variant's dice
sharing automatically:

- **mode 1 — Classic:** fully independent dice.
- **mode 2 — Shared Start:** shared opening roll (`shared.first`), independent rerolls.
- **mode 3 — Linked Dice:** shared opening + k-indexed shared rerolls (`shared.rerolls`).

Sharing dice makes `S_A` and `S_B` **positively correlated**, and that correlation cancels in
`M = S_A − S_B`. That cancellation is precisely the aleatory (luck) reduction the variants buy.

## The estimator (nested MC)

- **Outer loop:** `K` skill-pairs `Θ_k`. Pairs are drawn once per spread and **reused across
  the three variants**, because `E_Ω[M | Θ]` does not depend on the variant.
- **Inner loop:** `J` games per pair → margins `M_{k,j}`; `μ_k = mean_j M`, `v_k = var_j M`.
  Common random dice (the same `shared`/`luckA`/`luckB`, re-shared) are reused across the three
  variants within each inner game for variance reduction.
- **Combine:** `Aleatory = mean_k v_k`, `Epistemic = var_k μ_k`. A pooled raw `Var(M)` over all
  `K·J` margins is computed independently as a cross-check (must ≈ Aleatory + Epistemic).

The shipped `public/uncertainty.json` was generated with `K = 320`, `J = 200`
(64,000 margins per cell), `seed = 1`.

## Predicted behavior (the sanity checks)

1. **`Aleatory% + Epistemic% ≈ 100`** per variant (law of total variance), and
   `|rawVar − (Aleatory + Epistemic)|` is small.
2. **Epistemic absolute variance is ~constant across the three variants within a spread** — a
   single player's score distribution is variant-independent, so `E_Ω[M | Θ]` (hence its
   variance over `Θ`) does not depend on the variant.
3. **Aleatory decreases 1 → 2 → 3**, so the skill share **`Epistemic%` increases 1 → 2 → 3**.
   Linked Dice is the most skill-driven variant.

## Shipped numbers (from `public/uncertainty.json`, seed 1, K=320 J=200)

Aleatory / Epistemic as % of `Var(M)`:

| Spread | Classic | Shared Start | Linked Dice |
| --- | --- | --- | --- |
| Experts | 89.0 / 11.0 | 88.5 / 11.6 | 78.5 / 21.5 |
| Mixed | 48.2 / 51.8 | 47.1 / 52.9 | 41.2 / 58.8 |
| Novices | 62.7 / 37.3 | 62.7 / 37.3 | 61.8 / 38.2 |

Epistemic absolute variance is near-constant per spread (Experts ≈ 820/806/804; Mixed ≈
4885/4816/4926; Novices ≈ 1447/1405/1410), and the skill share rises 1 → 2 → 3 in every spread,
as predicted.

## Regenerate

```
node solver/uncertainty.js                 # defaults K=200 J=150; writes public/uncertainty.json
node solver/uncertainty.js --K 320 --J 200 --seed 1   # the shipped run
node solver/uncertainty.js --single        # single-threaded (default uses worker_threads)
```

The script prints a table and per-spread sanity summary alongside writing the JSON. The browser
readout fails soft: if the JSON is missing or malformed the bars hide themselves and the game
still starts normally.
