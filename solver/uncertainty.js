// solver/uncertainty.js
// Luck vs skill per variant, by ONE calculation — the data behind the
// luck/skill split bars on the variant-selection screen
// (public/js/uncertainty-ui.js reads the public/uncertainty.json this writes).
//
//   node solver/uncertainty.js [--N 50000] [--seed 1] [--workers N]
//                              [--single] [--out <path>]
//
// METHOD — a PERFECT player (always the solver-optimal action) plays head-to-
// head against a NEAR-PERFECT player, over N simulated games per variant. The
// near-perfect player also computes the EV of every available option, but when
// two or more options sit within TIE_WINDOW_EV (4) points of the best, it picks
// uniformly at random among that near-tie set; otherwise it takes the best.
//
// If the perfect player wins 100% of those games, the variant is 100% skill:
// the rules let the better play decide every game. If it only wins 50% — no
// better than a coin flip — nothing the better play did mattered, so 0% skill.
// Between those anchors the map is linear:
//
//     skill% = 2 × (winRate − 50%),  clamped to [0, 100];  luck% = 100 − skill%
//
// winRate counts a tied final score as half a win.
//
// OPTION SET for the near-perfect player, per decision (all EVs from
// policy.evalTurn, so keep-EVs and score-now-EVs are on the same scale):
//   rollsLeft > 0 → every distinct keep sub-multiset (incl. keep-all and ∅)
//                   plus every LEGAL score-now category;
//   rollsLeft = 0 → every legal category.
//
// DICE — for each game one shared=makeShared() opening/reroll bank and two
// per-player tapes luckA/luckB=makeLuck(); nextDice applies the variant's dice
// sharing from these (mode 1 independent, 2 shares the opening, 3 shares
// opening + k-indexed rerolls). The same tapes are re-shared across the three
// variants within a game (common random numbers), and each game's RNG stream is
// derived from (seed, gameIndex) so results are independent of worker count.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker, workerData, parentPort } from 'node:worker_threads';

import { Policy, fromPlayerState } from './policy.js';
import {
  PlayerState, nextDice, makeShared, makeLuck,
} from '../public/shared/game.js';
import { holdMaskFromKeep } from '../public/js/ai-optimal.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(DIR, 'strategy.bin');
const META_PATH = path.join(DIR, 'strategy-meta.json');
const OUT_DEFAULT = path.join(DIR, '..', 'public', 'uncertainty.json');

const MODES = [1, 2, 3];
const MODE_NAME = { 1: 'Classic', 2: 'Shared Start', 3: 'Linked Dice' };
const NO_HOLD = [false, false, false, false, false];

// Per-game margin histogram (perfect − near-perfect) for the points-based match
// length below. index = margin + OFF; the window comfortably covers any single
// game's score gap (one game's score maxes out far below 2000).
const OFF = 2000;
const HLEN = 2 * OFF + 1;

// Options within this many EV points of the best are "as good as tied" for the
// near-perfect player, which then picks uniformly at random among them. Set to 4
// — a middle ground between a tight 3 (near-optimal opponent) and a loose 6
// (dramatically imperfect), so the luck/skill benchmark is meaningful but not
// exaggerated.
const TIE_WINDOW_EV = 4;

const METHOD =
  'Perfect player vs near-perfect player over N games per variant: '
  + 'skill% = 2×(perfect win rate − 50%) clamped to [0,100], luck% = 100 − skill%. '
  + 'Ties count as half a win. 100% win rate ⇒ 100% skill; coin-flip ⇒ 0% skill.';
const SKILL_MODEL =
  `near-perfect player: takes the highest-EV option unless two or more options `
  + `are within ${TIE_WINDOW_EV} EV points of the best, in which case it picks `
  + `uniformly at random among that set. Options = every keep sub-multiset plus `
  + `every legal score-now category (only legal categories at 0 rolls left).`;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — seedable so the JSON is reproducible.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mix a few 32-bit ints into one seed (order-independent enough for our use).
function deriveSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    h ^= (p >>> 0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // final avalanche
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// The two players
// ---------------------------------------------------------------------------

/**
 * One full solitaire game of PERFECT play (policy best action every decision)
 * over the given luck tape and shared bank, in variant `mode`. Final score.
 */
function playPerfect(policy, mode, luck, shared, rng) {
  const ps = new PlayerState();
  ps.luck = luck;
  while (!ps.done) {
    ps.applyRoll(nextDice(ps, NO_HOLD, mode, shared, rng).dice);   // roll #1
    for (;;) {
      const { mask, up, yz } = fromPlayerState(ps);
      const best = policy.evalTurn(mask, up, yz, ps.dice, ps.rollsLeft).best;
      if (best.type === 'score') {
        const pts = ps.scoreCategory(best.cat);
        if (pts === null) {
          throw new Error(`ILLEGAL ACTION: scoreCategory(${best.cat}) returned null`
            + ` (mode=${mode} dice=[${ps.dice}] rollsLeft=${ps.rollsLeft})`);
        }
        break;
      }
      ps.applyRoll(nextDice(ps, holdMaskFromKeep(ps.dice, best.faces), mode, shared, rng).dice);
    }
  }
  return ps.total;
}

/**
 * One full solitaire game of NEAR-PERFECT play: highest-EV option, except when
 * ≥2 options fall within TIE_WINDOW_EV of the best — then uniform random among
 * that near-tie set. Final score.
 */
function playNearPerfect(policy, mode, luck, shared, rng) {
  const ps = new PlayerState();
  ps.luck = luck;
  while (!ps.done) {
    ps.applyRoll(nextDice(ps, NO_HOLD, mode, shared, rng).dice);   // roll #1
    for (;;) {
      const { mask, up, yz } = fromPlayerState(ps);
      const { categories, keeps } = policy.evalTurn(mask, up, yz, ps.dice, ps.rollsLeft);

      // Pool every available option on the one shared EV scale.
      const pool = [];
      for (const c of categories) {
        if (c.legal) pool.push({ score: c.cat, ev: c.ev });
      }
      if (keeps) {
        for (const k of keeps) pool.push({ keep: k.faces, ev: k.ev });
      }

      let bestEv = -Infinity;
      for (const o of pool) if (o.ev > bestEv) bestEv = o.ev;
      const near = pool.filter((o) => o.ev >= bestEv - TIE_WINDOW_EV);
      // ≥2 near-ties → uniform random among them; else the sole best.
      const pick = near.length > 1 ? near[Math.floor(rng() * near.length)] : near[0];

      if (pick.score !== undefined) {
        const pts = ps.scoreCategory(pick.score);
        if (pts === null) {
          throw new Error(`ILLEGAL ACTION: scoreCategory(${pick.score}) returned null`
            + ` (mode=${mode} dice=[${ps.dice}] rollsLeft=${ps.rollsLeft})`);
        }
        break;
      }
      ps.applyRoll(nextDice(ps, holdMaskFromKeep(ps.dice, pick.keep), mode, shared, rng).dice);
    }
  }
  return ps.total;
}

// ---------------------------------------------------------------------------
// One game index × all three variants (common random dice, re-shared).
// Accumulates into acc[mi] = { win, tie, n, sum, sumSq } (margin = perf − near).
// ---------------------------------------------------------------------------

function runGame(policy, gameSeed, acc) {
  const rng = mulberry32(gameSeed);
  const shared = makeShared(rng);
  const luckA = makeLuck(rng);
  const luckB = makeLuck(rng);
  for (let mi = 0; mi < MODES.length; mi++) {
    const mode = MODES[mi];
    const sPerf = playPerfect(policy, mode, luckA, shared, rng);
    const sNear = playNearPerfect(policy, mode, luckB, shared, rng);
    const M = sPerf - sNear;
    const a = acc[mi];
    if (M > 0) a.win += 1;
    else if (M === 0) a.tie += 1;
    a.n += 1;
    a.sum += M;
    a.sumSq += M * M;
    const hi = M + OFF;
    if (hi < 0 || hi >= HLEN) throw new Error(`margin ${M} out of histogram range`);
    a.hist[hi] += 1;
  }
}

const newAcc = () => MODES.map(() => ({ win: 0, tie: 0, n: 0, sum: 0, sumSq: 0, hist: new Float64Array(HLEN) }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleVar(sum, sumSq, n) {
  if (n < 2) return 0;
  return Math.max(0, (sumSq - (sum * sum) / n) / (n - 1));
}

// Best-of-N series length for which the perfect player takes the MAJORITY of
// games — strictly more game-wins than the near-perfect player — with
// probability > 0.95. Each game is an independent +1 (perfect win, pWin) / −1
// (perfect loss, pLose) / 0 (tie, pTie) step; we track the exact distribution of
// the win-difference D by convolution and return the first N with P(D > 0) > 0.95.
//
// P(D > 0) is non-monotonic in N: at an EVEN N the match can end tied on wins
// (D = 0), which is not a majority, so P(D > 0) dips below the neighbouring odd
// lengths (a parity sawtooth — see UNCERTAINTY.md). We therefore accept only ODD
// lengths, reporting a genuine best-of-N series. This is a semantic guard, not a
// value change: the odd peaks strictly exceed both adjacent even troughs, so the
// first N to clear 0.95 is always odd regardless. Returns null if unreached.
function gamesTo95(pWin, pLose, pTie, cap = 5000) {
  let dist = new Map([[0, 1]]);
  for (let n = 1; n <= cap; n++) {
    const next = new Map();
    for (const [d, p] of dist) {
      next.set(d + 1, (next.get(d + 1) || 0) + p * pWin);
      next.set(d - 1, (next.get(d - 1) || 0) + p * pLose);
      next.set(d, (next.get(d) || 0) + p * pTie);
    }
    dist = next;
    let pPos = 0;
    for (const [d, p] of dist) if (d > 0) pPos += p;
    if (pPos > 0.95 && n % 2 === 1) return n;   // odd → a real best-of-N series
  }
  return null;
}

// Points-based match length: the fewest games N after which the perfect player
// has a higher SUMMED score than the near-perfect player with probability > 0.95
// — the smallest N with P(sum of N per-game margins > 0) >= 0.95.
//
// Unlike the win-based best-of above, summed points has NO parity sawtooth: an
// exact tie of the running point total is vanishingly rare, so P(sum > 0) climbs
// monotonically and any length — even or odd — is a fair report. Computed exactly
// by convolving the empirical integer margin histogram N times (no normal
// approximation: the margin is right-skewed, which the normal shortcut would miss
// — e.g. it clears at an even 6 for Classic and a 5 for Shared Start).
function pointsGamesTo95(hist, target = 0.95, capN = 200) {
  let lo = 0; while (lo < HLEN && hist[lo] === 0) lo++;
  let hi = HLEN - 1; while (hi >= 0 && hist[hi] === 0) hi--;
  if (hi < lo) return null;
  let total = 0; for (let i = lo; i <= hi; i++) total += hist[i];
  const pmf = new Float64Array(hi - lo + 1);
  for (let i = lo; i <= hi; i++) pmf[i - lo] = hist[i] / total;
  const base = lo - OFF;                     // margin value of pmf[0]
  const pPos = (arr, b) => { let s = 0; for (let k = 0; k < arr.length; k++) if (b + k > 0) s += arr[k]; return s; };
  let dist = pmf; let dbase = base;
  for (let N = 1; N <= capN; N++) {
    if (N > 1) {
      const out = new Float64Array(dist.length + pmf.length - 1);
      for (let i = 0; i < dist.length; i++) {
        const di = dist[i]; if (di === 0) continue;
        for (let j = 0; j < pmf.length; j++) out[i + j] += di * pmf[j];
      }
      dist = out; dbase += base;
    }
    if (pPos(dist, dbase) >= target) return N;
  }
  return null;
}
const round = (x, d) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

function loadPolicy() {
  const bin = fs.readFileSync(BIN_PATH);
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  return new Policy(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);
}

// ---------------------------------------------------------------------------
// Worker branch — run an assigned list of game seeds, post the per-mode acc.
// ---------------------------------------------------------------------------

if (!isMainThread) {
  const { gameSeeds } = workerData;
  const policy = loadPolicy();
  const acc = newAcc();
  for (const gs of gameSeeds) runGame(policy, gs, acc);
  parentPort.postMessage(acc);
}

// ---------------------------------------------------------------------------
// Main branch
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const N = args.N;
  const seed = args.seed;
  const outPath = args.out || OUT_DEFAULT;

  // Per-game seeds derived from (seed, j) — deterministic regardless of workers.
  const gameSeeds = Array.from({ length: N }, (_, j) => deriveSeed(seed, j + 1));

  const nWorkers = args.single ? 0 : Math.max(1, Math.min(args.workers, N));

  console.log(`uncertainty: perfect vs near-perfect (±${TIE_WINDOW_EV} EV tie window)`);
  console.log(`  N=${N} games × 3 variants; seed=${seed}; ${args.single ? 'single-threaded' : `${nWorkers} workers`}`);
  const t0 = Date.now();

  const total = newAcc();
  const ingest = (acc) => {
    acc.forEach((a, mi) => {
      const t = total[mi];
      t.win += a.win; t.tie += a.tie; t.n += a.n;
      t.sum += a.sum; t.sumSq += a.sumSq;
      for (let k = 0; k < HLEN; k++) t.hist[k] += a.hist[k];
    });
  };

  if (nWorkers === 0) {
    const policy = loadPolicy();
    const acc = newAcc();
    for (let j = 0; j < N; j++) {
      runGame(policy, gameSeeds[j], acc);
      if ((j + 1) % 500 === 0 || j + 1 === N) {
        process.stdout.write(`\r  games ${j + 1}/${N} (${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
      }
    }
    process.stdout.write('\n');
    ingest(acc);
  } else {
    // Round-robin split → balanced wall-time.
    const chunks = Array.from({ length: nWorkers }, () => []);
    gameSeeds.forEach((gs, i) => chunks[i % nWorkers].push(gs));
    await Promise.all(chunks.map((chunk, wi) => new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { gameSeeds: chunk } });
      w.on('message', (msg) => { ingest(msg); resolve(); });
      w.on('error', reject);
      w.on('exit', (code) => { if (code !== 0) reject(new Error(`worker ${wi} exited ${code}`)); });
    })));
  }

  const seconds = (Date.now() - t0) / 1000;

  // Assemble the JSON + table.
  const variants = MODES.map((mode, mi) => {
    const a = total[mi];
    const winRate = a.n > 0 ? (a.win + 0.5 * a.tie) / a.n : 0.5;   // ties = half a win
    const skillPct = Math.max(0, Math.min(100, 200 * (winRate - 0.5)));
    const rawVar = sampleVar(a.sum, a.sumSq, a.n);
    // Raw per-game outcome probabilities (from counts, full precision) for the
    // match-length statistic below.
    const pWin = a.n > 0 ? a.win / a.n : 0;
    const pTie = a.n > 0 ? a.tie / a.n : 0;
    const pLose = a.n > 0 ? (a.n - a.win - a.tie) / a.n : 0;
    return {
      mode,
      name: MODE_NAME[mode],
      luckPct: round(100 - skillPct, 2),
      skillPct: round(skillPct, 2),
      winPct: round(100 * winRate, 2),
      tiePct: round(100 * pTie, 2),
      meanMargin: round(a.n > 0 ? a.sum / a.n : 0, 2),
      marginStd: round(Math.sqrt(rawVar), 2),
      // Games until the perfect player is >95% likely to have the higher SUMMED
      // score (the card's headline match-length figure).
      pointsGamesTo95: pointsGamesTo95(a.hist),
      // Background: best-of-N series length for a >95% majority of game-wins
      // (win-based; odd-only parity sawtooth — see UNCERTAINTY.md).
      gamesTo95: gamesTo95(pWin, pLose, pTie),
    };
  });

  const json = {
    method: METHOD,
    skillModel: SKILL_MODEL,
    generatedBy: 'solver/uncertainty.js',
    generatedAt: new Date().toISOString(),
    seed,
    games: N,
    tieWindowEV: TIE_WINDOW_EV,
    variants,
  };

  fs.writeFileSync(outPath, JSON.stringify(json, null, 2) + '\n');

  printTable(variants, seconds);
  console.log(`\nwrote ${outPath}  (${seconds.toFixed(1)}s)`);
}

function printTable(variants, seconds) {
  console.log('\nLuck vs Skill — perfect vs near-perfect win rate  (skill% = 2×(win% − 50))\n');
  const pad = (s, n) => String(s).padStart(n);
  const padE = (s, n) => String(s).padEnd(n);
  console.log(padE('variant', 14)
    + pad('luck%', 8) + pad('skill%', 8)
    + pad('win%', 8) + pad('tie%', 7)
    + pad('meanMrg', 10) + pad('mrgStd', 9) + pad('pts N', 7) + pad('bestOf', 8));
  console.log('-'.repeat(79));
  for (const v of variants) {
    console.log(padE(v.name, 14)
      + pad(v.luckPct.toFixed(1), 8) + pad(v.skillPct.toFixed(1), 8)
      + pad(v.winPct.toFixed(1), 8) + pad(v.tiePct.toFixed(1), 7)
      + pad(v.meanMargin.toFixed(1), 10) + pad(v.marginStd.toFixed(1), 9)
      + pad(String(v.pointsGamesTo95), 7) + pad(String(v.gamesTo95), 8));
  }

  // Sanity: sharing dice cancels common luck, so the perfect player's edge
  // should decide more games 1 → 2 → 3 (within MC noise).
  const s = variants.map((v) => v.skillPct);
  const mono = s[0] <= s[1] + 0.5 && s[1] <= s[2] + 0.5;
  console.log(`\nSanity: skill%↑1→2→3: ${mono ? 'yes' : 'NO'}  [${s.map((x) => x.toFixed(1)).join(' / ')}]`);
  void seconds;
}

function parseArgs(argv) {
  const a = { N: 50000, seed: 1, workers: Math.max(1, os.cpus().length - 2), single: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = () => (argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i]);
    if (t === '--N' || t.startsWith('--N=')) a.N = Number(val());
    else if (t === '--seed' || t.startsWith('--seed=')) a.seed = Number(val());
    else if (t === '--workers' || t.startsWith('--workers=')) a.workers = Number(val());
    else if (t === '--out' || t.startsWith('--out=')) a.out = val();
    else if (t === '--single') a.single = true;
    else { console.error(`unknown flag ${t}`); process.exit(1); }
  }
  if (!Number.isInteger(a.N) || a.N < 2) { console.error('--N must be an integer ≥ 2'); process.exit(1); }
  return a;
}

if (isMainThread) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
