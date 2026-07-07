// solver/pointsrace.js  (standalone, additive — does not touch uncertainty.js/json)
//
// POINTS-based match length: the smallest number of games N after which the
// PERFECT player has a higher SUMMED score than the NEAR-PERFECT player with
// probability >= 95%  —  P( sum_{i=1..N} margin_i > 0 ) >= 0.95,
// where margin_i = perfectScore_i - nearPerfectScore_i for game i.
//
// Unlike the win-based best-of-N (which is a parity sawtooth, hence odd-only),
// summed points has no tie sawtooth: exact-score ties of the running total are
// vanishingly rare, so P(sum>0) climbs monotonically and any N (even/odd) is fair.
//
// Method: re-run the SAME simulation as uncertainty.js (identical seed + RNG
// consumption order, so margins reproduce the shipped run), but record the full
// integer histogram of per-game margins per variant, then convolve that empirical
// pmf N times EXACTLY and read off the first N clearing 0.95.
//
//   node solver/pointsrace.js [--N 100000] [--seed 1] [--single]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker, workerData, parentPort } from 'node:worker_threads';

import { Policy, fromPlayerState } from './policy.js';
import { PlayerState, nextDice, makeShared, makeLuck } from '../public/shared/game.js';
import { holdMaskFromKeep } from '../public/js/ai-optimal.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(DIR, 'strategy.bin');
const META_PATH = path.join(DIR, 'strategy-meta.json');

const MODES = [1, 2, 3];
const MODE_NAME = { 1: 'Classic', 2: 'Shared Start', 3: 'Linked Dice' };
const NO_HOLD = [false, false, false, false, false];
const TIE_WINDOW_EV = 4;

// Margin histogram range: perfect - nearperfect, each score in [0, ~375]. A
// generous symmetric window; any margin outside throws (it won't happen).
const OFF = 600;              // index = margin + OFF
const HLEN = 2 * OFF + 1;     // margins in [-600, 600]

// --- PRNG (identical to uncertainty.js) ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function deriveSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) { h ^= (p >>> 0); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// --- the two players (verbatim behaviour from uncertainty.js) ---
function playPerfect(policy, mode, luck, shared, rng) {
  const ps = new PlayerState();
  ps.luck = luck;
  while (!ps.done) {
    ps.applyRoll(nextDice(ps, NO_HOLD, mode, shared, rng).dice);
    for (;;) {
      const { mask, up, yz } = fromPlayerState(ps);
      const best = policy.evalTurn(mask, up, yz, ps.dice, ps.rollsLeft).best;
      if (best.type === 'score') { ps.scoreCategory(best.cat); break; }
      ps.applyRoll(nextDice(ps, holdMaskFromKeep(ps.dice, best.faces), mode, shared, rng).dice);
    }
  }
  return ps.total;
}
function playNearPerfect(policy, mode, luck, shared, rng) {
  const ps = new PlayerState();
  ps.luck = luck;
  while (!ps.done) {
    ps.applyRoll(nextDice(ps, NO_HOLD, mode, shared, rng).dice);
    for (;;) {
      const { mask, up, yz } = fromPlayerState(ps);
      const { categories, keeps } = policy.evalTurn(mask, up, yz, ps.dice, ps.rollsLeft);
      const pool = [];
      for (const c of categories) if (c.legal) pool.push({ score: c.cat, ev: c.ev });
      if (keeps) for (const k of keeps) pool.push({ keep: k.faces, ev: k.ev });
      let bestEv = -Infinity;
      for (const o of pool) if (o.ev > bestEv) bestEv = o.ev;
      const near = pool.filter((o) => o.ev >= bestEv - TIE_WINDOW_EV);
      const pick = near.length > 1 ? near[Math.floor(rng() * near.length)] : near[0];
      if (pick.score !== undefined) { ps.scoreCategory(pick.score); break; }
      ps.applyRoll(nextDice(ps, holdMaskFromKeep(ps.dice, pick.keep), mode, shared, rng).dice);
    }
  }
  return ps.total;
}

// One game index × all three variants — identical RNG order to uncertainty.js.
// Records each per-game margin into per-mode histograms.
function runGame(policy, gameSeed, hist) {
  const rng = mulberry32(gameSeed);
  const shared = makeShared(rng);
  const luckA = makeLuck(rng);
  const luckB = makeLuck(rng);
  for (let mi = 0; mi < MODES.length; mi++) {
    const mode = MODES[mi];
    const sPerf = playPerfect(policy, mode, luckA, shared, rng);
    const sNear = playNearPerfect(policy, mode, luckB, shared, rng);
    const m = sPerf - sNear;
    const idx = m + OFF;
    if (idx < 0 || idx >= HLEN) throw new Error(`margin ${m} out of histogram range`);
    hist[mi][idx] += 1;
  }
}

const newHist = () => MODES.map(() => new Float64Array(HLEN));

function loadPolicy() {
  const bin = fs.readFileSync(BIN_PATH);
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  return new Policy(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);
}

// --- worker branch ---
if (!isMainThread) {
  const { gameSeeds } = workerData;
  const policy = loadPolicy();
  const hist = newHist();
  for (const gs of gameSeeds) runGame(policy, gs, hist);
  parentPort.postMessage(hist.map((h) => Array.from(h)));
}

// --- exact points-race from an empirical margin histogram ---
// Trim histogram to its support, normalise to a pmf, convolve N times, and
// return { N, table } for the first N with P(sum>0) >= 0.95.
function pointsRace(histArr, target = 0.95, capN = 60) {
  // find support
  let lo = 0; while (lo < HLEN && histArr[lo] === 0) lo++;
  let hi = HLEN - 1; while (hi >= 0 && histArr[hi] === 0) hi--;
  const total = histArr.reduce((s, x) => s + x, 0);
  const pmf = [];                       // pmf[k] = P(margin = (lo-OFF)+k)
  for (let i = lo; i <= hi; i++) pmf.push(histArr[i] / total);
  const base = lo - OFF;                // margin value of pmf[0]

  // distribution of the running sum, as {arr, base}
  let dist = pmf.slice();
  let dbase = base;
  const pPos = (arr, b) => {            // P(sum > 0)
    let s = 0;
    for (let k = 0; k < arr.length; k++) if (b + k > 0) s += arr[k];
    return s;
  };
  const pZero = (arr, b) => {
    const k = -b; return (k >= 0 && k < arr.length) ? arr[k] : 0;
  };
  const table = [];
  for (let N = 1; N <= capN; N++) {
    if (N > 1) {
      const out = new Float64Array(dist.length + pmf.length - 1);
      for (let i = 0; i < dist.length; i++) {
        const di = dist[i];
        if (di === 0) continue;
        for (let j = 0; j < pmf.length; j++) out[i + j] += di * pmf[j];
      }
      dist = out; dbase = dbase + base;
    }
    const p = pPos(dist, dbase);
    table.push({ N, pWin: p, pTie: pZero(dist, dbase) });
    if (p >= target) return { N, table };
  }
  return { N: null, table };
}

// win-based best-of-N (for cross-checking the shipped 7/7/3)
function winGamesTo95(pWin, pLose, pTie, cap = 5000) {
  let dist = new Map([[0, 1]]);
  for (let n = 1; n <= cap; n++) {
    const next = new Map();
    for (const [d, p] of dist) {
      next.set(d + 1, (next.get(d + 1) || 0) + p * pWin);
      next.set(d - 1, (next.get(d - 1) || 0) + p * pLose);
      next.set(d, (next.get(d) || 0) + p * pTie);
    }
    dist = next;
    let pPos = 0; for (const [d, p] of dist) if (d > 0) pPos += p;
    if (pPos > 0.95 && n % 2 === 1) return n;
  }
  return null;
}

async function main() {
  const args = { N: 100000, seed: 1, single: false, workers: Math.max(1, os.cpus().length - 2) };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--N') args.N = Number(argv[++i]);
    else if (t.startsWith('--N=')) args.N = Number(t.slice(4));
    else if (t === '--seed') args.seed = Number(argv[++i]);
    else if (t.startsWith('--seed=')) args.seed = Number(t.slice(7));
    else if (t === '--single') args.single = true;
    else if (t === '--workers') args.workers = Number(argv[++i]);
  }
  const { N, seed } = args;
  const gameSeeds = Array.from({ length: N }, (_, j) => deriveSeed(seed, j + 1));
  const nWorkers = args.single ? 0 : Math.max(1, Math.min(args.workers, N));
  console.log(`pointsrace: perfect vs near-perfect (±${TIE_WINDOW_EV} EV), N=${N} × 3 variants, seed=${seed}, ${nWorkers || 'single'} workers`);
  const t0 = Date.now();

  const hist = newHist();
  const ingest = (arr) => arr.forEach((h, mi) => { for (let k = 0; k < HLEN; k++) hist[mi][k] += h[k]; });

  if (nWorkers === 0) {
    const policy = loadPolicy();
    for (let j = 0; j < N; j++) {
      runGame(policy, gameSeeds[j], hist);
      if ((j + 1) % 1000 === 0 || j + 1 === N) process.stdout.write(`\r  games ${j + 1}/${N} (${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
    }
    process.stdout.write('\n');
  } else {
    const chunks = Array.from({ length: nWorkers }, () => []);
    gameSeeds.forEach((gs, i) => chunks[i % nWorkers].push(gs));
    await Promise.all(chunks.map((chunk) => new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { gameSeeds: chunk } });
      w.on('message', (msg) => { ingest(msg); resolve(); });
      w.on('error', reject);
      w.on('exit', (c) => { if (c !== 0) reject(new Error(`worker exited ${c}`)); });
    })));
  }
  const seconds = (Date.now() - t0) / 1000;

  console.log(`\n(${seconds.toFixed(1)}s)  seed=${seed} N=${N}\n`);
  console.log('variant        meanMrg  mrgStd  win% tie%  |  win-bestOf  points-N  |  P(sum>0) around the crossing');
  console.log('-'.repeat(104));
  const Z = 1.6448536269514722;  // one-sided 95%
  for (let mi = 0; mi < MODES.length; mi++) {
    const h = hist[mi];
    const tot = h.reduce((s, x) => s + x, 0);
    let sum = 0, sumSq = 0, win = 0, tie = 0;
    for (let i = 0; i < HLEN; i++) {
      const m = i - OFF, c = h[i];
      sum += m * c; sumSq += m * m * c;
      if (m > 0) win += c; else if (m === 0) tie += c;
    }
    const mean = sum / tot;
    const std = Math.sqrt(Math.max(0, (sumSq - sum * sum / tot) / (tot - 1)));
    const pWin = win / tot, pTie = tie / tot, pLose = 1 - pWin - pTie;
    const winBest = winGamesTo95(pWin, pLose, pTie);
    const { N: ptsN, table } = pointsRace(h);
    const normApprox = Z * Z * (std / mean) ** 2;
    // show P(sum>0) for a couple games either side of the crossing
    const ctx = table.filter((r) => Math.abs(r.N - ptsN) <= 2)
      .map((r) => `N=${r.N}:${(r.pWin * 100).toFixed(2)}%`).join('  ');
    console.log(
      `${MODE_NAME[MODES[mi]].padEnd(13)} ${mean.toFixed(1).padStart(7)} ${std.toFixed(1).padStart(7)} `
      + `${(pWin * 100).toFixed(1).padStart(5)} ${(pTie * 100).toFixed(2).padStart(5)} | `
      + `${String(winBest).padStart(9)} ${String(ptsN).padStart(9)}  | ${ctx}   (norm≈${normApprox.toFixed(2)})`);
  }
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
