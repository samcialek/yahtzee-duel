# Yahtzee Duel — Engineering Handoff

Read this first. It is the orientation map for the project: what it is, how to run it, where
everything lives, how the pieces fit, how it is verified, and what is left to do. For depth on
any subsystem, follow the pointers to the three design docs
([ARCHITECTURE.md](ARCHITECTURE.md), [SOLVER.md](SOLVER.md), [ANALYSIS.md](ANALYSIS.md)) and the
player-facing [README.md](README.md).

## What this is

Yahtzee Duel is a minimalist two-player Yahtzee web app. You play against a client-side AI (a
fast Standard heuristic or a provably optimal Perfect engine) or against a friend over a
4-letter room code, live via WebSocket. Beyond Classic play it offers two twist variants that
share dice between players to trade luck for skill. It ships with an offline **solver** that
exactly solves single-card Yahtzee (all 536,448 reachable states), a **Strategy Explorer** UI on
top of the solved table, and a chess-engine-style **post-game analysis** that grades every one of
your decisions against the optimum and closes by replaying your exact game under perfect play — on
**your own dice** — to show the score an optimal player would have made on the rolls you actually
got. The variant picker also carries a **luck-vs-skill readout**: a Monte-Carlo estimate, per
variant, of how much of the head-to-head outcome is decided by the dice versus the gap in play. That same-dice replay is powered by a per-player **luck tape** (`makeLuck` / `ps.luck`) that
makes one player's whole game reproducible for any sequence of holds. The stack is deliberately tiny: Node's built-in `http` plus
`ws`, vanilla ESM in the browser, no framework and no build step.

## Status

Fully built, tested, and verified. Everything described in the design docs exists and runs; the
solver table is generated and served; all test suites pass. The three design docs
(ARCHITECTURE / SOLVER / ANALYSIS) read as as-built references of the shipped code. The dev server
runs on :3000. Not yet deployed to a public host (see **Deployment**).

## Start here (runbook)

```
cd C:/Users/samci/yahtzee
npm install          # installs the single dependency, ws
npm start            # node server.js — serves on http://localhost:3000
```

- Open the app: **http://localhost:3000**
- Open the Strategy Explorer: **http://localhost:3000/explore.html** (also linked from the home footer)
- Override the port: set `PORT` in the environment (e.g. `PORT=8080 npm start`).

Run the tests (plain `node`, no framework):

```
node test-game.js            # 21 groups — core rules & scoring
node test-game-edge.js       # 16 adversarial groups — joker/edge cases
node test-luck.js            # 4 checks — luck-tape contract + same-luck optimal replay
node test-analysis.js        # 10 checks — post-game analysis over the real strategy.bin
node solver/test-tables.js   # multiset machinery
node solver/test-states.js   # state enumeration + dense indexing
node solver/test-rules.js    # 250k random (mask,dice) pairs vs potentials()
node solver/test-policy.js   # 7 groups — Policy / evalTurn
```

Solver / analysis CLIs (all optional, all `node`):

```
node solver/solve.js                 # regenerate strategy.bin + meta, copy into public/ (~9s); --bench to benchmark
node solver/simulate.js --n 200000   # play N optimal games, report stats (default N = 10000)
node solver/verify-endgame.js        # independent expectimax cross-check of strategy.bin
node solver/analyze.js --filled ones,twos --up 7 --dice 3,3,4,5,6 --rolls 1   # query one position
node solver/uncertainty.js           # regenerate public/uncertainty.json (luck-vs-skill split); --K --J --seed
```

## File map

### App (server + browser)

| Path | Purpose |
| --- | --- |
| `server.js` | Node `http` static server for `public/` plus a read-only `/solver/` route (from `SOLVER_DIR`) so the browser imports the solver's browser-safe ESM from one source of truth; `ws` multiplayer rooms; MIME map (incl. `.bin`→`application/octet-stream`, `.json`); sets `Content-Length`; path-traversal guard; builds a personalized per-player view-model; enforces information-hiding (variants 2/3 never transmit opponent dice); turn / rematch / opponent-left logic; 4-letter room codes. `PORT` env overrides 3000. |
| `public/index.html` | All screens in one document (home / lobby / game + end overlay + analysis panel). A `DOM CONTRACT` comment enumerates element ids. Scorecard rows are `.sc-row[data-cat=…]` for the 13 categories and `.sc-row[data-row=…]` for derived display rows (upper-sum, upper-bonus, yahtzee-bonus, total). Standard/Perfect machine sub-toggle. Footer links the explorer. |
| `public/style.css` | Editorial "paper & ink" aesthetic; Fraunces + IBM Plex Mono; CSS-pip dice; held dice fully inverted; vermillion accent for potentials. |
| `public/shared/game.js` | The shared rules module imported by **both** server and browser. Exports `ROUNDS`, `UPPER`, `LOWER`, `CATS`, `isYahtzee`, `scoreCat` (joker-unaware), `potentials` (joker-aware legality + points), `makeShared`/`nextDice` (zero-sync shared dice for variants 2/3), `makeLuck` (a per-player position-indexed "luck tape"; when `ps.luck` is set `nextDice` draws each player's non-shared randomness from it, making that player's whole game reproducible for ANY holds — `serialize()` never leaks it), and `class PlayerState`. `PlayerState.scoreCategory` auto-applies the +100 extra-Yahtzee bonus before writing the box. |
| `public/js/app.js` | Screen router + single pure renderer over the view-model + input wiring + post-game decision recording (`moveLog`) + analysis-panel wiring. |
| `public/js/engine.js` | `LocalEngine` (vs AI): `roll` / `score` / `holdUpdate` / `rematch` / `destroy` + `onState`; builds the **same** view-model shape as the server; accepts `opts.ai` (decision object); AI pacing per variant. |
| `public/js/net.js` | `RemoteEngine` (WebSocket client); identical interface to `LocalEngine`; drives create/join lobby. |
| `public/js/ai.js` | Standard heuristic AI (brute-force over 32 hold masks + Monte-Carlo one-step rollout). Exports `aiChooseCategory`, `aiChooseHold`. |
| `public/js/ai-optimal.js` | Perfect AI. Exports `holdMaskFromKeep(dice, keepFaces)` and `async loadOptimalAI(baseUrl='')`, which fetches `strategy.bin` + `strategy-meta.json`, builds a `Policy`, and returns `{ chooseHold, chooseCategory }` matching `ai.js`'s signatures. |
| `public/js/analysis.js` | Post-game analysis. Exports `OPTIMAL_EPS = 0.01`, `PERFECT_EV = 254.5877`, `recordDecision(log, view, action)`, `analyze(log, policy)` (pure, no DOM), `renderAnalysis(report, el, opts)` (the only DOM-touching export). |
| `public/js/uncertainty-ui.js` | Variant-picker luck-vs-skill readout. `init()` fetches `public/uncertainty.json` once (tiny — no strategy table), reveals the readout, wires the skill-spread selector (`#seg-spread`), and paints each variant card's split bar + caption. Fails soft: on any fetch/shape error the readouts hide and the game still starts. |
| `public/uncertainty.json` | Precomputed luck/skill decomposition per spread × variant, written by `solver/uncertainty.js`. Consumed only by `uncertainty-ui.js`. |
| `public/js/explore.js` + `public/explore.html` | The interactive Strategy Explorer. |
| `public/strategy.bin` + `public/strategy-meta.json` | Served copies of the solved table (generated by `solver/solve.js`). |

### Solver (offline)

| Path | Purpose |
| --- | --- |
| `solver/tables.js` | Multiset machinery: all 462 keep-multisets (sizes 0..5 = 1+6+21+56+126+252), children lattice, per-roll subset lists + raw category scores. Pure. |
| `solver/states.js` | Widget enumeration + O(1) dense indexing of all 536,448 reachable `(mask, up 0..63, yz)` states. Pure. Defines the `strategy.bin` index order. |
| `solver/solve.js` | Retrograde value-iteration sweep (popcount 13→0, keep-multiset lattice per widget). Exports `legalPts()` (the exact legality+points the sweep uses). Writes `strategy.bin` + `strategy-meta.json` and copies both into `public/`. Flag: `--bench`. |
| `solver/policy.js` | Pure `Policy` usable in Node **and** browser (ArrayBuffer + meta). `stateEV(mask, up, yz)`, `evalTurn(mask, up, yz, dice, rollsLeft∈{0,1,2})` → ranked categories + keeps + best; `fromPlayerState(ps)`. Also exports `legalPts`, `TIE_EPS`. |
| `solver/analyze.js` | CLI position query (see runbook). |
| `solver/simulate.js` | Plays N games (default 10000, `--n`) under the optimal policy; reports stats. |
| `solver/verify-endgame.js` | Independent expectimax (a different algorithm) cross-checking `strategy.bin`. |
| `solver/uncertainty.js` | Nested Monte-Carlo luck-vs-skill decomposition of the match margin `M = S_A − S_B` (law of total variance) for 3 skill spreads × 3 variants. Reuses the shipped mechanics + `Policy`; parallel via `worker_threads`. Writes `public/uncertainty.json` and prints a table + sanity summary. `--K --J --seed --workers --single --out`. |

### Docs

| Path | Purpose |
| --- | --- |
| `HANDOFF.md` | This file — first-read orientation. |
| `README.md` | Player-facing overview: the three variants, how to run and play. |
| `ARCHITECTURE.md` | Stack decisions, the shared game module, the view-model / two-engine design, the server, the AI, the UI spec. Sections marked CANONICAL are the verbatim shared code. |
| `SOLVER.md` | The exact solver: state space, retrograde value iteration, `strategy.bin` format, the Policy, and the key numbers. |
| `ANALYSIS.md` | The post-game decision-analysis design: recording, grading against the optimum, and the ledger UI. |
| `UNCERTAINTY.md` | The luck-vs-skill decomposition: the law-of-total-variance method, the eps-player skill model, the nested-MC estimator, the sanity checks, and the shipped numbers. |

### Tests

| Path | Proves |
| --- | --- |
| `test-game.js` | Core rules & scoring (21 groups). |
| `test-game-edge.js` | Adversarial joker / edge cases (16 groups). |
| `test-luck.js` | The `makeLuck` / `ps.luck` tape: same holds over the same tape reproduce identical dice across all 3 modes (fidelity), raw tape values are uniform, an optimal same-luck replay averages ≈ 254.6, and luckless players still match the old shared-dice path (4 checks). |
| `test-analysis.js` | `analyze()` flags injected blunders and matches independently recomputed EV loss over the real `strategy.bin` (10 checks). |
| `solver/test-tables.js` | Multiset tables & lattice. |
| `solver/test-states.js` | State enumeration + dense indexing (the `strategy.bin` order). |
| `solver/test-rules.js` | 250k random `(mask, dice)` pairs: solver legality/points vs `potentials()`. |
| `solver/test-policy.js` | `Policy` / `evalTurn` behavior incl. `stateEV(0,0,0) == meta.startEV` (7 groups). |

## How it fits together

- **One rules module, imported twice.** `public/shared/game.js` is the single source of truth for
  scoring, joker legality, and the shared-dice mechanic. Both the Node server and the browser
  import it, so the rules can never drift between them. The server's `/solver/` route exists for
  the same reason: the browser loads the solver's browser-safe ESM (`policy.js`) from the one copy
  in `solver/`, not a duplicate.
- **One view-model, two engines.** Every game — vs AI or vs a live friend — is driven by the exact
  same personalized view-model shape. `LocalEngine` (`engine.js`) builds it locally for AI games;
  `RemoteEngine` (`net.js`) receives it from the server for multiplayer. They expose an identical
  interface (`roll` / `score` / `holdUpdate` / `rematch` / `destroy` + `onState`), so `app.js`'s
  single pure renderer never knows or cares which one it is talking to.
- **Solver → table → three consumers.** `solve.js` runs the retrograde sweep over the state space
  enumerated by `states.js` (using the multiset tables from `tables.js`) and writes `strategy.bin`
  (a flat Float32 array in `states.js` index order) plus `strategy-meta.json`. `policy.js` reads
  that table and answers optimal-move queries. Three features consume it: the **Perfect AI**
  (`ai-optimal.js`), the **Strategy Explorer** (`explore.js`), and **post-game analysis**
  (`analysis.js`) — all through the same `Policy`.
- **The luck tape → "perfect play on your dice".** `makeShared` fixes the *shared* randomness up
  front; `makeLuck` extends the same idea to a *single player*, pre-generating a position-indexed
  reserve of every reroll they could draw. With `ps.luck` set, `nextDice` reproduces that player's
  exact dice for **any** hold sequence — even dice a perfect replay would have rerolled but the
  human kept. The analysis panel uses this: `analysis.js` `replayOptimal({shared, luck, mode}, policy)`
  replays your game with optimal decisions over your own tape, and the closing line reports the score
  a perfect player would have made on your rolls. Each engine hands the client only its **own**
  context via `luckContext()` — `LocalEngine` returns it directly (`{shared, luck: human.luck, mode}`);
  multiplayer sends it once in that player's own end-of-game state payload (`luckContext` field in
  `stateFor`), and **the opponent's luck tape is never transmitted**.

## Testing & verification

All suites pass. Beyond the unit tests above, the solver output is cross-checked and simulated:

- **Independent cross-check.** `solver/verify-endgame.js` re-derives state values with a completely
  different algorithm (all-layers expectimax) and compares against `strategy.bin` to a tolerance of
  1e-6. The observed agreement across sampled states — including the start state — was to max
  relative error ≈ 5.7e-8, i.e. the table is correct, not merely self-consistent.
- **Empirical simulation.** `solver/simulate.js` plays full games with real `Math.random` dice,
  taking every decision from `evalTurn`. A 200,000-game run reported mean **254.574** (σ ≈ 59.9),
  P(score ≥ 300) = 0.143, Yahtzee rate 0.336, upper-bonus rate 0.681 — consistent with the solved
  start EV.

Key numbers (use these exact figures):

| Quantity | Value |
| --- | --- |
| Reachable states | 536,448 |
| `strategy.bin` size | 2,145,792 bytes (2.1 MB), Float32 in `states.js` index order |
| Solved start EV | **254.5877** (`meta.startEV` = 254.58772873449504) |
| Published optimal-solitaire benchmark | 254.5896 — the 0.0019 gap is a property of this rule encoding, not an error |
| Independent expectimax agreement | max relative error ≈ 5.7e-8 |
| 200k-game simulated mean | 254.574 (σ ≈ 59.9), P(≥300) = 0.143, Yahtzee 0.336, upper-bonus 0.681 |
| Solve time | ≈ 9s (9.2s observed) |
| `evalTurn` latency | ≈ 0.06 ms |

The 0.0019 benchmark gap deserves a note: it is intrinsic to how this codebase encodes the rules,
and the independent expectimax reproduces the same value, so it is expected — not a bug to chase.

## Deployment

Currently local only: `npm start` on :3000 (running in this environment). Nothing is deployed to a
public host and no cloud config is committed yet.

**The one hard constraint:** multiplayer rooms live in an in-memory `Map` in the server process.
Any deployment must run **exactly one** always-on instance with **no scale-to-zero / autostop**.
A second instance would split the room registry; an autostop would kill in-flight games. This rules
out multi-instance and idle-to-zero setups for live play.

- **Quick friend testing (Tailscale Funnel).** `tailscale funnel --bg 3000` exposes the dev server
  at a public HTTPS URL (`<your-machine>.<your-tailnet>.ts.net`). The WebSocket client already
  auto-selects `wss://` on HTTPS pages, so it works through the funnel unchanged. **Status:
  pending** — Funnel is not yet enabled on the tailnet; it needs a one-click "Enable Funnel"
  approval in the Tailscale admin console.
- **Recommended permanent host: Fly.io.** A single shared-cpu 256MB machine with an ~8-line
  Dockerfile + `fly.toml` and no autostop satisfies the single-instance constraint. Render's free
  tier idles after 15 minutes with a slow cold start, which is poor for live sockets. No Fly config
  is committed yet.

## Gotchas / behaviors

- **The +100 Yahtzee Bonus is automatic and not a clickable category.** This has been mistaken for a
  bug before — it is correct. `PlayerState.scoreCategory` adds +100 automatically when you score a
  5-of-a-kind while the Yahtzee box already holds 50, *before* writing the box. The
  "Yahtzee Bonus +100" scorecard row is a **derived display row** (`data-row="yahtzee-bonus"`), not
  a category you click. The bonus requires the *first* Yahtzee to have been scored in the Yahtzee
  box (making it 50). The app uses standard **forced-joker** rules for a second Yahtzee: it must go
  in its matching upper box if that box is open; otherwise any open lower box (at joker values);
  otherwise it zeroes a remaining upper box. Verified correct in `game.js`. (Open UX idea, not yet
  done: style the bonus row as visibly non-interactive with a "Yahtzee! +100 — score it in a
  highlighted box" hint, and optionally a free-joker toggle.)
- **Variants 2/3 hide opponent dice.** The server builds a per-player view-model and never transmits
  the opponent's dice in Shared Start or Linked Dice — the renderer only ever sees what a player is
  allowed to see. Do not "fix" the client by trying to read opponent dice; they are not sent.
- **A player's luck tape is private.** The post-game "perfect play on your dice" replay needs the
  player's own `ps.luck`, but a tape reveals every reroll outcome a player could draw — so it is a
  secret, like `shared`. `serialize()` deliberately omits it, and the server only ever puts
  `me.ps.luck` (never `opp.ps.luck`) into a player's own end-of-game `luckContext`. Do not add luck
  to `serialize()` or send it mid-game; both would leak it to the opponent.
- **A decision exists only where alternatives existed.** Analysis recording ignores the forced first
  roll of a round (roll all 5). Only rerolls (`rollsLeft ∈ {1,2}` with a held mask) and scoring
  choices are graded. At most one decision per `(round, rollsLeft)` — a repeat call (e.g. a
  double-click racing the next state push) is dropped.
- **Regenerating the table.** `solver/solve.js` writes `strategy.bin` + meta into `solver/` **and**
  copies both into `public/`. If you change the state ordering in `states.js`, you must re-run the
  solver so the served copy and `policy.js`'s indexing stay in sync.

## Known follow-ups / next steps

- [ ] Enable and run the **Tailscale Funnel** (needs the one-click admin-console approval).
- [ ] Add **Fly.io deploy config** (Dockerfile + `fly.toml`, single machine, no autostop).
- [ ] **Yahtzee-bonus UX clarity pass** — make the derived bonus row clearly non-interactive; add a
      "score it in a highlighted box" hint; optional free-joker toggle.
- [ ] Fix two low-priority **analysis edge cases**: a double-click roll race on the remote path, and
      a duplicate `strategy.bin` fetch edge.
- [ ] Add a **win-probability-maximizing policy** as an alternative to the current EV-maximizing one.

---

For deeper reading: [ARCHITECTURE.md](ARCHITECTURE.md) (app internals & design rationale),
[SOLVER.md](SOLVER.md) (the exact solver & table format), [ANALYSIS.md](ANALYSIS.md) (decision
grading), [UNCERTAINTY.md](UNCERTAINTY.md) (the luck-vs-skill decomposition), and
[README.md](README.md) (how to play).
