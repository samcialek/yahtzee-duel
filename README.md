# Yahtzee Duel

A minimalist two-player Yahtzee web app. Play live against a friend over a short room
code, or against a client-side AI. Beyond Classic play, two twist variants trade luck for
skill by sharing dice between the players.

## The three variants

The game creator picks one of three variants:

1. **Classic** — traditional Yahtzee. Players take alternating turns, every roll is
   independent, and each player can see the other's dice as they play (like cardgames.io).

2. **Shared Start** — both players play at the same time, hidden from each other. Each
   round, both players get the **same opening roll**, but every reroll is independent and
   each player scores their own card. You never see your opponent's dice, only their
   scorecard. Same starting hand, different decisions — a test of who plays it better.

3. **Linked Dice** — everything in Shared Start, plus the rerolls are linked too. The
   players draw from a **shared reroll sequence** each round, so the *lesser* number of
   dice that both players choose to reroll come up identical. If you reroll 3 dice and your
   opponent rerolls 2 on the same roll, the first 2 of those rerolled dice match for both
   of you. The most tightly coupled, most skill-driven variant.

### Luck vs skill

Under each variant on the game-type picker is a **luck-vs-skill split bar**: a Monte-Carlo
estimate of how much of the head-to-head outcome that variant hands to the dice (luck) versus the
gap in play (skill). Sharing dice cancels the swings that both players ride together, so luck's
share drops and skill's share rises from Classic to Shared Start to **Linked Dice**, which is the
most skill-driven of the three. A **Players** selector (Experts / Mixed / Novices) reweights the
estimate for the skill level of the table. The numbers are precomputed offline
(`solver/uncertainty.js` → `public/uncertainty.json`); see **UNCERTAINTY.md** for the method.

## Running it

```
cd C:/Users/samci/yahtzee
npm install
npm start
```

Then open **http://localhost:3000** in your browser. (Set `PORT` in the environment to use
a different port.)

## Playing

On the home screen: pick an **opponent**, pick a **variant** (creator only), enter a
**name**, then start.

### Versus the AI (Machine)

Choose **Machine**, pick your variant, enter your name, and hit Start. The AI runs entirely
in your browser — no room, no waiting. In Classic it takes visible alternating turns you can
watch; in the other variants it plays its own hidden game alongside yours.

A **strength toggle** picks how the Machine plays: **Standard** uses a fast heuristic, while
**Perfect** plays provably optimal moves looked up from the solved strategy table (see
*The solver* below).

### Versus a Friend

- One player chooses **Friend**, picks the variant, and hits **Create a room**.
- Share the **4-letter room code** shown in the lobby with your friend.
- Your friend chooses **Friend**, enters the code, and hits **Join**. The variant is set by
  the host. The game starts as soon as they join.

## Strategy Explorer

**http://localhost:3000/explore.html** (linked from the home footer) is an interactive
front-end to the solved game: set up any scorecard, upper total, dice, and rolls left, and it
shows the optimal move and the expected value of every alternative.

## Post-game analysis

After a game ends, a decision ledger reviews your play: every roll-keep and scoring choice
you made is compared against the optimal one from the solved table, with the expected-value
loss of each mistake — so you can see exactly where the points went. The review also tells you
what a perfect player would have scored on your exact dice (same luck, optimal decisions), so you
see how many points your decisions actually cost — not a comparison to an abstract average.

## The solver

Classic single-card Yahtzee is solved exactly. `solver/solve.js` computes the optimal
expected value of all **536,448** reachable states by backward induction and writes
`strategy.bin` (2.1 MB), a table the app and tools look moves up in. The solved optimum is
**254.5877** expected points from the starting state.

- `solver/analyze.js` — query any position from the command line, e.g.
  `node solver/analyze.js --filled ones,twos --up 7 --dice 3,3,4,5,6 --rolls 1`
- `solver/simulate.js` — play out full games with the optimal policy to sanity-check the
  table empirically.
- `solver/verify-endgame.js` — independently re-derives late-game values and checks them
  against the table.

## Controls

- **Click a die** or press keys **1–5** to hold / unhold that die.
- **Space** or **R** to roll.

Held dice invert (dark face, light pips) so their state is unmistakable. You get three rolls
per turn; potential scores show in vermillion on every open row of your card while it's your
turn to score.

### Scoring note: the +100 Yahtzee bonus is automatic

The **Yahtzee Bonus +100** row on the scorecard is a display-only total — you don't click it.
Once your Yahtzee box already holds 50, every *additional* five-of-a-kind you roll adds +100 for
you automatically. Just score that roll in the highlighted box the game offers (standard forced-
joker rules: the matching upper box if it's open, otherwise an open lower box, otherwise a zero in
a remaining upper box), and the +100 is credited to the bonus row on its own.

## Tech notes

- **Node.js** with the built-in `http` module for static file serving plus **`ws`** for the
  live multiplayer WebSocket rooms. `ws` is the only dependency.
- **No build step.** The frontend is vanilla ESM JavaScript with no framework.
- A single **shared ESM game module** (`public/shared/game.js`) holds all scoring, joker
  rules, and the shared-dice logic, and is imported by *both* the Node server and the
  browser — one source of truth for the rules.
- The **AI runs client-side**. Games against the Machine need no server round-trips; the
  server is only involved when you play a live friend. Both cases feed the UI the exact same
  personalized view-model, so the renderer never knows which one it's talking to.

## Deploying

Local development is a single Node process (`npm start` on port 3000). Multiplayer rooms live in
an in-memory map, so a public deployment must run **exactly one always-on instance** with **no
scale-to-zero / auto-stop** — a second instance or a cold start would split the room registry and
drop in-flight games. See **HANDOFF.md** for the two supported paths: a Tailscale Funnel for quick
friend testing, and Fly.io for a permanent single-instance host.

## For engineers

See **HANDOFF.md** for the operational overview, and **ARCHITECTURE.md**, **SOLVER.md**,
**ANALYSIS.md**, and **UNCERTAINTY.md** for the as-built design of the app, the solver, the
post-game analysis, and the luck-vs-skill decomposition.
