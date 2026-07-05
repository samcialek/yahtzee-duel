# Yahtzee Duel — Architecture (as built)

A minimalist web app for two-player Yahtzee — live multiplayer via a four-letter room code, or
against a client-side machine opponent — with three variants that trade aleatory uncertainty for
skill.

Status: **as-built.** The app is fully implemented, tested, and running (`npm start` →
http://localhost:3000). This document is the architecture reference for the browser/server core:
the shared rules module, the two interchangeable engines, the personalized view-model, and the
single-document UI. Code blocks marked **CANONICAL** are the two tricky, unique mechanics —
zero-synchronization shared dice (§3) and the Yahtzee-joker `potentials()` rules (§4). They are
reproduced from the shipped `public/shared/game.js` and have been verified to match it.

Sibling docs, cross-linked throughout:

- **README.md** — how to run it.
- **HANDOFF.md** — the engineering handoff / status snapshot (deployment, follow-ups, key numbers).
- **SOLVER.md** — the retrograde solver, the solved strategy table, the Perfect (optimal-policy) AI,
  and the Strategy Explorer.
- **ANALYSIS.md** — the post-game decision-analysis ledger.

This file deliberately does **not** duplicate the solver or analysis internals; it describes the
app they plug into and points to those documents for the rest.

---

## 1. Product summary

- **Opponents**: another human (live, via a four-letter room code over WebSocket) or the **Machine**
  (runs fully client-side, no server needed). The Machine has a strength toggle:
  - **Standard** — a fast heuristic AI (`public/js/ai.js`, §7).
  - **Perfect** — the optimal EV-maximizing policy driven by the solved strategy table
    (`public/js/ai-optimal.js`; see SOLVER.md).
- **Variants** (chosen by the game creator):
  1. **Classic** — traditional Yahtzee. Alternating turns, all rolls independent, opponent's dice
     visible.
  2. **Shared Start** — both players play *simultaneously and hidden from each other*. Each round,
     both players' **first roll is identical**. Rerolls are independent. Each scores independently;
     neither sees the other's dice (scorecards are visible).
  3. **Linked Dice** — same as Shared Start, plus rerolls draw from a **shared per-round sequence**:
     if player A rerolls 3 dice and player B rerolls 2 on the same roll number of the same round,
     the first 2 reroll values are identical for both.
- **Extras built on top of the core**: a **post-game decision-analysis ledger** (every keep/score
  decision compared against the optimal one, with EV loss and a running tally — ANALYSIS.md) and a
  standalone **Strategy Explorer** at `/explore.html` (SOLVER.md). Both were added after the core
  game and reuse the same shared code.
- **UI**: slick, minimalist, editorial (§8).

## 2. Stack & key decisions

| Decision | Choice | Why |
|---|---|---|
| Server | Node.js, plain `http` static server + `ws` (the only npm dependency) | No build step, tiny footprint |
| Modules | ESM everywhere (`"type": "module"`) | One shared game-logic file imported by **both** Node server and browser |
| Frontend | Vanilla JS modules, no framework | Small app, full control over the aesthetic |
| Machine games | Run **entirely client-side** via a `LocalEngine` that mimics the server | Zero latency, works offline; the server is only needed for live multiplayer |
| State flow | Server (or `LocalEngine`) is authoritative and pushes a **complete personalized view-model** after every event; the UI is a dumb renderer of that one state shape | Eliminates delta-sync bugs; UI code is identical for machine and remote games |
| Randomness | `Math.random`, server-side for multiplayer (authoritative), client-side for machine games | No fairness requirement beyond casual play |
| Solver code sharing | The browser imports the solver's browser-safe ESM from a read-only `/solver/` server route | One source of truth; the Explorer and Perfect AI do not fork a copy (§6) |

### Folder structure (app core)

```
yahtzee/
  package.json            # type:module, dep: ws, start: node server.js
  server.js               # static file serving (public/ + read-only /solver/) + WebSocket rooms
  ARCHITECTURE.md         # this file
  HANDOFF.md  README.md   # handoff snapshot / run instructions
  SOLVER.md  ANALYSIS.md  # solver + analysis references
  public/
    index.html            # ALL screens in one document (home / lobby / game + overlays)
    style.css             # the whole aesthetic (paper & ink)
    explore.html          # the Strategy Explorer page (see SOLVER.md)
    strategy.bin          # served copy of the solved table (2,145,792 bytes; see SOLVER.md)
    strategy-meta.json    # served copy of the table's metadata
    shared/
      game.js             # scoring, joker rules, PlayerState, shared-dice RNG  ← imported by server too
    js/
      app.js              # screen router + single pure renderer + input wiring + analysis panel wiring
      engine.js           # LocalEngine (vs Machine) — same interface as net.js; accepts opts.ai
      net.js              # RemoteEngine (WebSocket client) — same interface + lobby handshake
      ai.js               # Standard heuristic AI (§7)
      ai-optimal.js       # Perfect AI: loads the strategy table, returns the same chooseHold/chooseCategory shape (SOLVER.md)
      analysis.js         # post-game decision analysis (ANALYSIS.md)
      explore.js          # Strategy Explorer logic (SOLVER.md)
  solver/                 # the offline solver + shared browser-safe policy module (SOLVER.md)
  test-game.js  test-game-edge.js  test-analysis.js   # root test suites (all pass)
```

The `solver/` tree (table generation, dense state indexing, retrograde value iteration, the pure
`Policy`, CLI tools, and cross-checks) is out of scope here — see **SOLVER.md**.

## 3. Core mechanic — shared dice with zero synchronization (CANONICAL)

The trick that makes variants 2 and 3 work without either player ever waiting for the other:
**pregenerate all shared randomness up front**, indexed by `(round, rollNumber)`. Each player
consumes it at their own pace. Two players on round 5, roll 2 get the same sequence no matter
*when* they roll.

For variant 3, a player rerolling *k* dice takes the **first k values** of that roll's shared
sequence, assigned to their rerolled dice in position order — which is exactly the requested
"lesser number of dice selected by both rolls the same" semantics, with no waiting.

```js
// public/shared/game.js — CANONICAL (verified against the shipped file)
export const ROUNDS = 13;

export function makeShared(rng = Math.random) {
  const roll5 = () => Array.from({ length: 5 }, () => 1 + Math.floor(rng() * 6));
  return {
    first:   Array.from({ length: ROUNDS }, roll5),            // variant 2 & 3: identical opening roll
    rerolls: Array.from({ length: ROUNDS }, () => [roll5(), roll5()]), // variant 3: [roll#2 seq, roll#3 seq]
  };
}

// Per-player "luck tape": a POSITION-indexed reserve of every reroll a player could draw this game.
//   opening[round]        → variant-1 opening roll (variants 2/3 use shared.first)
//   reroll[round][r][pos] → the value die-position `pos` takes on roll #(r+2), if rerolled
export function makeLuck(rng = Math.random) {
  const roll5 = () => Array.from({ length: 5 }, () => 1 + Math.floor(rng() * 6));
  return {
    opening: Array.from({ length: ROUNDS }, roll5),
    reroll:  Array.from({ length: ROUNDS }, () => [roll5(), roll5()]),
  };
}

// hold[i] === true means KEEP die i. mode: 1 | 2 | 3.
// If ps.luck is present the non-shared dice are drawn from that tape (reproducible); else from rng().
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
```

Notes:

- The server generates `shared` once per game (`makeShared()` in `handleJoin`) and keeps it secret;
  players only ever see their own resulting dice. `LocalEngine` does the same client-side (one
  `makeShared()` per game, refreshed on rematch).
- Both players always index by **their own** `round`/`rollNum`, so pacing never matters.
- In variant 2, rerolls call `rand()` fresh — only `first` is shared.
- `nextDice` reads `ps.round`, so it must never be called for a `done` player. Both engines guard
  this (see the `ps.done` / `rollsLeft` checks in `handleRoll` and `LocalEngine.roll`).
- **The luck tape extends the same idea to one player's whole game.** `makeLuck` pregenerates a
  *position-indexed* reserve of every reroll outcome a single player could draw. When a `PlayerState`
  carries `ps.luck`, `nextDice` draws that player's non-shared randomness from the tape instead of
  live `rng()` — making their entire game reproducible for **any** sequence of holds (including dice
  a perfect replay would reroll but the human kept). Variant-2/3 openings still come from
  `shared.first` and **variant-3 rerolls are still k-indexed via `shared.rerolls`**; only the
  otherwise-live rolls are served from the tape. It is statistically identical to live rolling — it
  just fixes the outcomes ahead of time. This is exactly what powers the post-game "perfect play on
  your dice" replay: the analysis panel replays your own tape under optimal decisions and reports the
  score a perfect player would have made on your rolls (see [ANALYSIS.md](ANALYSIS.md)). A tape is a
  secret like `shared`: `serialize()` never includes it, and the server transmits only a player's
  **own** tape, once, in their end-of-game state (`luckContext`) — never the opponent's.

## 4. Game rules — scoring & the Yahtzee joker (CANONICAL)

Standard 13-category card: upper (aces–sixes, +35 bonus at ≥63), lower (3-kind, 4-kind, full house
25, small straight 30, large straight 40, yahtzee 50, chance). Extra-Yahtzee rule: **+100 bonus per
additional Yahtzee if the Yahtzee box holds 50**, with forced-joker category restrictions. The joker
logic is the fiddly part and lives entirely in `potentials()`:

```js
// public/shared/game.js — CANONICAL (verified against the shipped file)
export const UPPER = ['ones','twos','threes','fours','fives','sixes'];
export const LOWER = ['threeKind','fourKind','fullHouse','smallStraight','largeStraight','yahtzee','chance'];
export const CATS  = [...UPPER, ...LOWER];
export const isYahtzee = d => d.every(v => v === d[0]);

// Returns { [openCat]: { pts, allowed } }. `allowed:false` rows render dimmed & unclickable.
export function potentials(card, dice) {
  const res = {};
  const joker = isYahtzee(dice) && card.yahtzee !== null;   // yahtzee box already filled (50 OR 0)
  if (!joker) {
    for (const cat of CATS) if (card[cat] === null)
      res[cat] = { pts: scoreCat(cat, dice), allowed: true };
    return res;
  }
  const face = dice[0], upCat = UPPER[face - 1], s = face * 5;
  const lowerOpen = LOWER.filter(c => c !== 'yahtzee' && card[c] === null);
  const jokerPts = cat =>
    UPPER.includes(cat) ? (cat === upCat ? s : 0)
    : cat === 'fullHouse' ? 25 : cat === 'smallStraight' ? 30
    : cat === 'largeStraight' ? 40 : s;                     // 3-kind / 4-kind / chance = sum
  for (const cat of CATS) {
    if (card[cat] !== null) continue;
    let allowed;
    if (card[upCat] === null)      allowed = cat === upCat;         // 1) forced into matching upper box
    else if (lowerOpen.length > 0) allowed = lowerOpen.includes(cat); // 2) else any lower box, joker values
    else                           allowed = true;                    // 3) else zero any remaining upper box
    res[cat] = { pts: jokerPts(cat), allowed };
  }
  return res;
}
```

`scoreCat(cat, dice)` (also in `game.js`) is the textbook, **joker-unaware** scorer: face counts;
straights via a longest-run check; full house = exactly (3 + 2); Yahtzee = five of a kind → 50. All
joker awareness lives in `potentials`, not here.

### PlayerState and the auto-applied +100 Yahtzee bonus

`PlayerState` (in `game.js`) holds one player's authoritative state:
`{ card: {cat: pts|null}, yahtzeeBonus, round, rollsLeft, dice|null }` with getters
`upperSum / upperBonus / total / done`, plus:

- `applyRoll(dice)` — sets `dice`, decrements `rollsLeft`.
- **`scoreCategory(cat)`** — validates `cat` against `potentials()`; if legal, **auto-applies the
  extra-Yahtzee +100 bonus** — `if (isYahtzee(this.dice) && this.card.yahtzee === 50) this.yahtzeeBonus += 100;`
  — *before* writing the box; writes the box; then resets `dice = null, rollsLeft = 3, round++`.
  Returns the points scored, or `null` if the category was illegal.
- `serialize(includeDice)` — produces the per-player chunk of the view-model (§5).

**The +100 Yahtzee bonus is not a category you click.** It is applied automatically inside
`scoreCategory` whenever you score a five-of-a-kind while the Yahtzee box already holds 50. The
"Yahtzee Bonus +100" line on the scorecard is a **derived display row**
(`.sc-row[data-row="yahtzee-bonus"]`), not a clickable category. Two separate rules are in play and
should not be conflated:

- The **joker category restrictions** trigger when the Yahtzee box is filled with **any** value
  (50 *or* 0) — that is the `card.yahtzee !== null` test in `potentials`.
- The **+100 bonus** requires the box to specifically hold **50** (a zeroed Yahtzee box earns no
  bonuses) — that is the `card.yahtzee === 50` test in `scoreCategory`.

Under standard forced-joker rules, a second Yahtzee must go in its matching upper box if that box is
open; otherwise any open lower box (at joker values); otherwise it zeroes a remaining upper box. See
ANALYSIS.md and HANDOFF.md for the confirmed behavior and an open UX-clarity follow-up.

## 5. One view-model, two engines

`LocalEngine` (`engine.js`) and `RemoteEngine` (`net.js`) expose the **identical** interface, so
`app.js` never knows which it is talking to:

```
engine.roll(holdMask)   engine.score(cat)   engine.holdUpdate(mask)   // variant-1 spectating only
engine.rematch()        engine.destroy()
callback: onState(view) — fired with a complete view after every game event
```

`RemoteEngine` additionally owns the lobby handshake that `LocalEngine` has no equivalent for —
`create(name, mode)` and `join(name, code)`, surfaced via `opts.onCreated` / `opts.onError` /
`opts.onOppLeft`. It connects to the same origin that served the page and auto-selects `wss://` on
`https://` pages (so it works through a TLS tunnel unchanged).

`LocalEngine` additionally accepts `opts.ai` — an object `{ chooseHold, chooseCategory }`. It
defaults to the heuristic pair from `ai.js`; the Home screen's **Perfect** toggle injects the loaded
optimal policy from `ai-optimal.js` instead. Pacing, visibility, and every other engine mechanic are
identical for both brains.

The personalized view-model (built per-player by the server in `stateFor`, and by `LocalEngine` in
`pushState` — **field-for-field identically**, so one render path covers both):

```js
{
  t: 'state', seq: 42,                 // seq: monotonic — the UI animates a roll only on a new seq
  phase: 'play' | 'end',
  mode: 1 | 2 | 3,
  code: 'KWPX' | null,                 // room code (multiplayer only; null for machine games)
  youName, oppName,
  turn: 'you' | 'opp' | null,          // variant 1 only; null in 2/3 (simultaneous play)
  you:  { card, yahtzeeBonus, upperSum, upperBonus, total, round, rollsLeft, dice, done },
  opp:  { ...same, dice: [...]|null }, // dice included ONLY in variant 1 (visible turns)
  oppHold: [bool×5] | null,            // variant 1: opponent's held dice, relayed live
  lastRoll: { who: 'you'|'opp', mask: [indices] } | null,   // drives the tumble animation
  rematch: { you: bool, opp: bool },   // end-screen rematch votes
  result: { you: total, opp: total } | null,
}
```

Rules embedded in the shape (all enforced by the state *producer*, never by the UI):

- In variants 2/3 the opponent's **dice are never sent** — only their scorecard and round number.
  The server enforces this in `stateFor` (`opp.ps.serialize(mode === 1)`), and `LocalEngine`
  mirrors it (`includeOppDice = this.mode === 1`). The opponent's `lastRoll` and `oppHold` are
  likewise relayed only in variant 1.
- The client computes its own `potentials(you.card, you.dice)` locally (game.js is shared), so the
  payload stays small and candidate scores render instantly on the card.
- Held-dice state is **pure client UI state**, submitted only as the `hold` mask on `roll`. Variant 1
  additionally relays it via `holdUpdate` so the spectating opponent sees the keeps.

## 6. Server (server.js)

A plain Node `http` server plus a `WebSocketServer` from `ws` attached to it (JSON messages).

**Static file serving.** Two read roots:

- `public/` — the app.
- `/solver/*` maps **read-only** onto the `solver/` directory (`SOLVER_DIR`), so the browser imports
  the solver's browser-safe ESM (`tables.js` / `states.js` / `policy.js`) from **one source of
  truth** instead of a forked copy.

Both roots share a path-traversal guard (resolve against the root, confirm the result stayed
inside), a small MIME map — including `.bin → application/octet-stream` and `.json` for the served
strategy table — and an explicit `Content-Length` header. Port is `process.env.PORT || 3000`.

**Protocol**

| Client → Server | Server → Client |
|---|---|
| `{t:'create', name, mode}` | `{t:'created', code}` |
| `{t:'join', name, code}` | `{t:'state', ...}` (to both; game starts) |
| `{t:'roll', hold}` | `{t:'state', ...}` (personalized, to both) |
| `{t:'hold', mask}` (variant 1 only) | `{t:'state', ...}` |
| `{t:'score', cat}` | `{t:'state', ...}` |
| `{t:'rematch'}` | `{t:'state', ...}` (restarts when both vote) |
| — | `{t:'error', msg}`, `{t:'oppLeft'}` |

**Room** (the in-memory record, one per code):
`{ code, mode, players: [{ ws, name, ps: PlayerState, hold }], shared, turn, starter, over, lastRoll, rematch, seq }`.
Codes are 4 chars from an ambiguity-free alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ`), stored in a `Map`.
Rooms live only in this process's memory — see the deployment note below.

**Validation on every action** (server-authoritative): the room has started (two players + shared
dice exist) and is not over, and `!ps.done`; variant 1 additionally requires `turn === playerIndex`;
`roll` requires `rollsLeft > 0` (the first roll of a round ignores the hold mask, since `nextDice`
re-rolls all five anyway); `score` requires `ps.dice !== null` and delegates legality to
`scoreCategory` (which enforces the joker restrictions and returns `null` if illegal). Illegal or
malformed actions are silently ignored.

**Turn / end / lifecycle logic**: variant 1 — scoring passes `turn` to the other player; variants
2/3 — no turn, players run free. The game is over when both players are `done`. Rematch: when both
vote, both `PlayerState`s and `shared` are freshly created, `starter` alternates (variant 1), and
`seq` keeps climbing (never reset). A disconnect deletes the room and sends the surviving player
`{t:'oppLeft'}`.

> **Deployment note.** Rooms live in an in-memory `Map`, so a live-multiplayer deployment must run
> **exactly one** always-on instance with **no** scale-to-zero / autostop — otherwise the room
> registry splits and in-flight games die. Machine games need no server at all. See HANDOFF.md for
> the current hosting plan (Tailscale Funnel for quick friend testing; Fly.io recommended for a
> permanent single-instance host).

## 7. Machine opponents

Two brains implement the same `{ chooseHold, chooseCategory }` shape and are interchangeable behind
`LocalEngine`'s `opts.ai`:

- **Standard** — the heuristic AI in `public/js/ai.js` (below).
- **Perfect** — the optimal EV-maximizing policy in `public/js/ai-optimal.js`, which fetches
  `strategy.bin` + `strategy-meta.json` and builds a `Policy`. Its internals (the solved table, the
  536,448-state index, the retrograde solve) are documented in **SOLVER.md**, not here.

### Standard AI — decision-making (CANONICAL)

Category weights encode strategy that raw points don't: upper-bonus progress, hoarding `chance`, and
how painful a zero is per category. Hold selection is brute-force over all 32 keep-masks (the
keep-all baseline plus the 31 masks with ≥1 reroll), each evaluated by a Monte-Carlo one-step
rollout — cheap (~30k scoring calls, well under 50 ms) and plays a solid game without a full EV
table.

```js
// public/js/ai.js — CANONICAL (the whole file is used verbatim)
import { CATS, UPPER, potentials } from '../shared/game.js';

const ZERO_PEN = { yahtzee:10, largeStraight:9, smallStraight:7, fullHouse:5, fourKind:4,
                   threeKind:3, sixes:3, fives:2, fours:1.5, threes:1, twos:0.5, ones:0, chance:2 };

function weighted(cat, pts) {
  let v = pts;
  const face = UPPER.indexOf(cat) + 1;
  if (face > 0 && pts >= face * 3) v += 4;        // 3+ of a face = on pace for the 63 bonus
  if (cat === 'chance') v -= 7;                    // save chance as a late dump slot
  if (pts === 0) v -= ZERO_PEN[cat] ?? 1;          // zeroing valuable boxes hurts more
  return v;
}

function bestMove(card, dice) {                    // best legal category for these dice
  const pot = potentials(card, dice);
  let cat = null, value = -1e9;
  for (const c in pot) {
    if (!pot[c].allowed) continue;
    const v = weighted(c, pot[c].pts);
    if (v > value) { value = v; cat = c; }
  }
  return { cat, value };
}

export const aiChooseCategory = ps => bestMove(ps.card, ps.dice).cat;

// Returns { hold: bool[5], stop: bool } — stop means "keep everything, score now".
export function aiChooseHold(ps, samples = 60) {
  const dice = ps.dice;
  const keepAll = bestMove(ps.card, dice).value;   // exact, no sampling needed
  let best = { hold: [true,true,true,true,true], stop: true, value: keepAll };
  for (let m = 0; m < 31; m++) {                    // 31 masks with ≥1 reroll (m=31 would be keep-all)
    const hold = [0,1,2,3,4].map(i => !!(m & (1 << i)));
    let tot = 0;
    for (let s = 0; s < samples; s++) {
      const d = dice.map((v, i) => hold[i] ? v : 1 + Math.floor(Math.random() * 6));
      tot += bestMove(ps.card, d).value;
    }
    const value = tot / samples + (ps.rollsLeft === 2 ? 2 : 0); // second reroll still in hand
    if (value > best.value) best = { hold, stop: false, value };
  }
  return best;
}
```

### Pacing (LocalEngine)

Both brains are driven by `LocalEngine`; only the decision functions differ.

- **Variant 1 (Classic)**: strict alternation. The AI turn runs as a `setTimeout` chain (800–1100 ms
  between roll → hold-reveal → reroll → score, via `delay()`) so the human watches it "think"; its
  dice, holds, and rolls render in the shared tray exactly as a remote human's would (variant-1
  visible turns).
- **Variants 2/3 (Shared Start / Linked Dice)**: the AI plays hidden and its round **trails** the
  human. After the human scores round *r*, the AI plays its own round *r* — computed synchronously
  against the same shared dice and revealed with a single delayed state push (~900 ms apart if
  catching up several rounds, via `scheduleAIStep` / `playAIRoundHidden`). When the human finishes
  round 13, the AI plays out its remainder. Its scorecard fills in live; **its dice are never sent**.
- `LocalEngine` also owns rematch (reset both states + fresh `makeShared()`) and `destroy()` (clears
  all timers). Every timer is registered so tear-down and rematch cancel cleanly.

## 8. UI & design spec

**Aesthetic**: refined editorial minimalism — Japanese-stationery paper & ink.

- Palette (CSS custom properties in `style.css`): paper `#f3efe6` (with a faint SVG-noise grain
  overlay), ink `#17150f`, muted `#8a8478`, hairline `#d8d2c2`, dice face `#fffdf7`, single accent
  vermillion `#c8451f`. Light theme only. No gradients; no shadow heavier than a whisper.
- Type: **Fraunces** (display — masthead, statuses, end screen) + **IBM Plex Mono** (labels,
  scorecard numbers, buttons; uppercase, letterspaced). Loaded from Google Fonts.
- Motion: a staggered reveal on the home screen; dice-tumble keyframes (~450 ms, per-die delay)
  triggered by `lastRoll.mask` on a new `seq`; potential scores fade in on the card. Everything else
  is instant.

**Screens** — all in one `index.html`, toggled by `app.js` via the `.is-active` class on `.screen`
elements. The document opens with a **DOM CONTRACT** comment that enumerates every stable id
`app.js` binds to; that comment is the authoritative element inventory. `app.js` is a **single pure
renderer** over the view-model: it updates values in place and never replaces scorecard innerHTML.

1. **Home** (`#screen-home`) — Fraunces masthead; three numbered steps: `01 — Opponent`
   (Machine / Friend segmented toggle), with a **Machine strength sub-toggle** (`#ai-strength`:
   Standard / Perfect) shown only for Machine; `02 — Variant` (three option cards, locked with a
   "Set by host" note when joining a friend's room); `03 — Name`. Then Start (Machine) or
   Create-room / Join-with-code (Friend). Choosing **Perfect** puts `#btn-start` into a loading state
   while the strategy table is fetched. A footer colophon links the **Strategy Explorer**
   (`explore.html`).
2. **Lobby** (`#screen-lobby`) — the giant room code, "share this code", an animated waiting
   ellipsis, and Cancel.
3. **Game** (`#screen-game`) — header (wordmark · variant chip · `Round n / 13` · Leave). A
   three-column layout: your scorecard | center | opponent scorecard (columns stack under ~900 px).
   Center column: a Fraunces status line, the five dice (click to hold), a Roll pill with three
   rolls-left dots, and a mono sub-status.
4. **End overlay** (`#overlay-end`) — a Fraunces verdict ("You win." / "You lose." / "Dead heat."),
   both totals, and **Rematch** (with a waiting state in multiplayer), **Analysis**, and **New game**.
5. **Analysis overlay** (`#overlay-analysis`) — swapped in over the end card by the Analysis button;
   `analysis.js` fills `#analysis-content`. It lazy-loads the strategy table on first open. See
   **ANALYSIS.md**.

**Dice**: white rounded squares, 1 px hairline, ink pips (a CSS 3×3 grid of `<i>` elements
positioned by `[data-v]` rules). **Held = full inversion** (ink face, paper pips) plus a small lift
— unmistakable at a glance. Pre-roll dice: dashed outline, no pips (`data-v="0"` / `.is-empty`). Each
die element (`#die-0 … #die-4`) is animated only when its index is in `lastRoll.mask` on a new `seq`.

**Scorecard**: hairline-ruled rows. Each category is a `.sc-row[data-cat="<cat>"]` (13 of them,
`<cat> ∈ ones…sixes, threeKind, fourKind, fullHouse, smallStraight, largeStraight, yahtzee, chance`);
derived display rows are `.sc-row[data-row="upper-sum" | "upper-bonus" | "yahtzee-bonus" | "total"]`.
`app.js` sets `.sc-value` text and toggles row modifiers: `.sc-row--open` (scorable → potential score
in vermillion), `.sc-row--disallowed` (joker-forbidden → dimmed, unclickable), `.sc-row--filled`
(scored → ink). Clicks are bound to open rows by their `data-cat`; the **Yahtzee Bonus +100** row
is a derived `data-row`, not a category, and is therefore never clickable (§4). Variants 2/3 show
each player's own `Round n / 13` progress under their name; the active player (variant 1) gets an
accent dot.

**Input niceties**: keys 1–5 toggle holds, Space/R rolls; the room-code input auto-uppercases;
errors surface as a small toast (`#error-toast`), never an `alert`.

## 9. How it was built — order, and invariants to preserve

The core game was built shared-code-first; the solver, Perfect AI, Strategy Explorer, and post-game
analysis were layered on afterward and reuse that same shared code.

1. `public/shared/game.js` — constants, `scoreCat`, `potentials` (§4), `PlayerState`, `makeShared`/
   `nextDice` (§3). **Everything depends on this; it was built and unit-tested first.**
2. `server.js` (§6), and `public/js/engine.js` + `ai.js` (§7) — independent of one another once (1)
   existed. `public/js/net.js` is a thin client alongside them.
3. `public/index.html` + `js/app.js` + `style.css` (the §5 shape rendered under the §8 spec).
4. **Later additions**, each in its own doc: the offline solver and the solved `strategy.bin`
   (SOLVER.md); the **Perfect** AI (`ai-optimal.js`) wired in via `LocalEngine`'s `opts.ai`; the
   **Strategy Explorer** (`explore.html` / `explore.js`, SOLVER.md); and the **post-game analysis**
   ledger (`analysis.js`, ANALYSIS.md). The server grew its read-only `/solver/` route so the
   browser and the solver share one copy of the browser-safe modules.
5. Verification: root suites `test-game.js`, `test-game-edge.js`, `test-analysis.js`, plus the
   solver's own suites — all passing (see HANDOFF.md / SOLVER.md for the full list and key numbers).

**Invariants worth guarding (hard-won; easy to lose in a refactor):**

- `nextDice` reads `ps.round` — never call it for a `done` player. Both engines guard with
  `ps.done` / `rollsLeft` checks before rolling.
- The Yahtzee bonus checks `card.yahtzee === 50` (a zeroed Yahtzee box earns no bonus) and is applied
  **before** the scored box is written — see `PlayerState.scoreCategory` (§4).
- The joker *category restrictions* trigger when the Yahtzee box holds **any** value (50 or 0) via
  `card.yahtzee !== null`; the +100 bonus is a **separate** rule keyed on `=== 50`. Do not merge them.
- Reset the client-side held mask whenever a state arrives with `you.dice === null` (new round).
- Animate the dice only when `seq` advances, and only the indices in `lastRoll.mask`, or re-renders
  will re-tumble settled dice.
- Information hiding for variants 2/3 (opponent dice, `lastRoll`, `oppHold`) is the **producer's**
  responsibility — the server's `stateFor` and `LocalEngine.pushState`. The UI must never be trusted
  to hide what the payload contains.
