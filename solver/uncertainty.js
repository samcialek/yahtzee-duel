// solver/uncertainty.js
// Luck (aleatory) vs skill (epistemic) decomposition of the head-to-head match
// MARGIN, per variant, by nested Monte-Carlo — the data behind the luck/skill
// split bars on the variant-selection screen (public/js/uncertainty-ui.js reads
// the public/uncertainty.json this script writes).
//
//   node solver/uncertainty.js [--K 200] [--J 150] [--seed 1] [--workers N]
//                              [--single] [--out <path>]
//
// METHOD — law of total variance on the margin M = S_A - S_B (final-score
// difference of two players; sign = winner). Conditioning on the skill pair
// Θ = (epsA, epsB):
//     Aleatory  = E_Θ[ Var_Ω(M | Θ) ]   // skills fixed, dice swing the margin → LUCK
//     Epistemic = Var_Θ[ E_Ω(M | Θ) ]   // dice averaged out, skill gap swings it → SKILL
//   and Aleatory + Epistemic = Var(M) exactly. Each is reported as an absolute
//   variance and as a % of (Aleatory+Epistemic).
//
// SKILL MODEL — an "eps-player" plays the solver-optimal move (policy.evalTurn)
// except with probability eps it instead takes a UNIFORMLY RANDOM LEGAL action:
// at a reroll decision a fair coin chooses between "score now" → a random legal
// category and "reroll" → a random keep submask of the current dice; at
// rollsLeft 0 → a random legal category. eps=0 is perfect play, eps=1 random.
//
// DICE — for each inner game one shared=makeShared() opening/reroll bank and two
// per-player tapes luckA/luckB=makeLuck(); nextDice applies the variant's dice
// sharing from these (mode 1 independent, 2 shares the opening, 3 shares opening
// + k-indexed rerolls). The shared dice make S_A,S_B positively correlated, which
// cancels in M — the aleatory reduction the variants buy.
//
// ESTIMATOR — outer loop K skill-pairs Θ_k (drawn ONCE per spread and REUSED
// across the three variants, since E_Ω[M|Θ] is variant-independent); inner loop
// J games per pair → margins M_{k,j}; μ_k = mean_j M, v_k = var_j M. Then
// Aleatory = mean_k v_k, Epistemic = var_k μ_k, and a pooled raw Var(M) over all
// K*J margins as an independent cross-check. Common random dice are reused across
// the three variants within each inner game (variance reduction: the same luck,
// re-shared, is what the aleatory drop measures).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker, workerData, parentPort } from 'node:worker_threads';

import { Policy, fromPlayerState } from './policy.js';
import {
  PlayerState, nextDice, makeShared, makeLuck, potentials, CATS,
} from '../public/shared/game.js';
import { holdMaskFromKeep } from '../public/js/ai-optimal.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(DIR, 'strategy.bin');
const META_PATH = path.join(DIR, 'strategy-meta.json');
const OUT_DEFAULT = path.join(DIR, '..', 'public', 'uncertainty.json');

const MODES = [1, 2, 3];
const MODE_NAME = { 1: 'Classic', 2: 'Shared Start', 3: 'Linked Dice' };
const NO_HOLD = [false, false, false, false, false];

const SPREADS = [
  { key: 'experts', label: 'Experts', epsRange: [0, 0.15] },
  { key: 'mixed',   label: 'Mixed',   epsRange: [0, 0.6], default: true },
  { key: 'novices', label: 'Novices', epsRange: [0.3, 0.85] },
];

const METHOD =
  'Law of total variance on the match margin M=S_A-S_B via nested Monte-Carlo: '
  + 'Aleatory=E_Θ[Var_Ω(M|Θ)] (luck), Epistemic=Var_Θ[E_Ω(M|Θ)] (skill); they sum to Var(M).';
const SKILL_MODEL =
  'eps-player: solver-optimal move w.p. 1-eps, else a uniformly random legal action '
  + '(fair coin: score-now→random legal category vs reroll→random keep submask; '
  + 'at 0 rolls left a random legal category).';

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
// eps-player game
// ---------------------------------------------------------------------------

function randomLegalCat(card, dice, rng) {
  const pot = potentials(card, dice);
  const legal = [];
  for (const c of CATS) if (pot[c] && pot[c].allowed) legal.push(c);
  return legal[Math.floor(rng() * legal.length)];
}

/**
 * Play one full solitaire game with the eps skill model over the given luck tape
 * and shared dice bank, in the given variant `mode`. Returns the final score.
 */
function playEps(policy, mode, luck, shared, eps, rng) {
  const ps = new PlayerState();
  ps.luck = luck;
  while (!ps.done) {
    ps.applyRoll(nextDice(ps, NO_HOLD, mode, shared, rng).dice);   // roll #1
    for (;;) {
      const rl = ps.rollsLeft;                                     // rerolls remaining
      let scoreCat = null;
      let hold = null;
      if (rng() < eps) {
        // Uniformly random LEGAL action.
        if (rl > 0 && rng() < 0.5) {
          // reroll → random keep submask (each die held with prob 1/2)
          hold = [rng() < 0.5, rng() < 0.5, rng() < 0.5, rng() < 0.5, rng() < 0.5];
        } else {
          // score now → random legal category (also the rollsLeft==0 case)
          scoreCat = randomLegalCat(ps.card, ps.dice, rng);
        }
      } else {
        // Solver-optimal action.
        const { mask, up, yz } = fromPlayerState(ps);
        const best = policy.evalTurn(mask, up, yz, ps.dice, rl).best;
        if (best.type === 'score') scoreCat = best.cat;
        else hold = holdMaskFromKeep(ps.dice, best.faces);
      }

      if (scoreCat !== null) {
        const pts = ps.scoreCategory(scoreCat);
        if (pts === null) {
          throw new Error(`ILLEGAL ACTION: scoreCategory(${scoreCat}) returned null`
            + ` (mode=${mode} dice=[${ps.dice}] rollsLeft=${rl})`);
        }
        break;
      }
      ps.applyRoll(nextDice(ps, hold, mode, shared, rng).dice);
    }
  }
  return ps.total;
}

// ---------------------------------------------------------------------------
// One outer skill-pair × J inner games, over all three variants (common random
// dice). Returns per-mode { sum, sumSq } of the J margins.
// ---------------------------------------------------------------------------

function runPair(policy, epsA, epsB, J, seed) {
  const rng = mulberry32(seed);
  const acc = MODES.map(() => ({ sum: 0, sumSq: 0 }));
  for (let j = 0; j < J; j++) {
    // One shared bank + two per-player tapes, reused (re-shared) across variants.
    const shared = makeShared(rng);
    const luckA = makeLuck(rng);
    const luckB = makeLuck(rng);
    for (let mi = 0; mi < MODES.length; mi++) {
      const mode = MODES[mi];
      const sA = playEps(policy, mode, luckA, shared, epsA, rng);
      const sB = playEps(policy, mode, luckB, shared, epsB, rng);
      const M = sA - sB;
      acc[mi].sum += M;
      acc[mi].sumSq += M * M;
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function sampleVar(sum, sumSq, n) {
  if (n < 2) return 0;
  return Math.max(0, (sumSq - (sum * sum) / n) / (n - 1));
}
function sampleVarArr(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  let s = 0;
  for (const x of xs) s += x;
  const m = s / n;
  let q = 0;
  for (const x of xs) q += (x - m) * (x - m);
  return q / (n - 1);
}
function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : 0;
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
// Worker branch — process an assigned list of pairs, post per-pair per-mode acc.
// ---------------------------------------------------------------------------

if (!isMainThread) {
  const { pairs, J } = workerData;
  const policy = loadPolicy();
  const out = [];
  for (const p of pairs) {
    const acc = runPair(policy, p.epsA, p.epsB, J, p.seed);
    out.push({ spreadIdx: p.spreadIdx, k: p.k, acc });
  }
  parentPort.postMessage(out);
}

// ---------------------------------------------------------------------------
// Main branch
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const K = args.K;
  const J = args.J;
  const seed = args.seed;
  const outPath = args.out || OUT_DEFAULT;

  // Build the full job list. Skill pairs are drawn ONCE per spread from a
  // per-spread deterministic stream and REUSED across the three variants.
  const pairs = [];
  SPREADS.forEach((sp, spreadIdx) => {
    const [lo, hi] = sp.epsRange;
    const skillRng = mulberry32(deriveSeed(seed, spreadIdx, 999));
    for (let k = 0; k < K; k++) {
      const epsA = lo + skillRng() * (hi - lo);
      const epsB = lo + skillRng() * (hi - lo);
      pairs.push({ spreadIdx, k, epsA, epsB, seed: deriveSeed(seed, spreadIdx, k + 1) });
    }
  });

  const nWorkers = args.single ? 0
    : Math.max(1, Math.min(args.workers, pairs.length));

  console.log(`uncertainty: K=${K} skill-pairs × J=${J} games × 3 variants × ${SPREADS.length} spreads`);
  console.log(`  margins per cell = ${K * J}; total games = ${K * J * 3 * SPREADS.length * 2}`);
  console.log(`  seed=${seed}; ${args.single ? 'single-threaded' : `${nWorkers} workers`}`);
  const t0 = Date.now();

  // results[spreadIdx][mode] collects μ_k, v_k and pooled sums.
  const results = SPREADS.map(() => {
    const byMode = {};
    for (const m of MODES) byMode[m] = { mus: [], vs: [], poolSum: 0, poolSumSq: 0, poolN: 0 };
    return byMode;
  });

  const ingest = (pairResults) => {
    for (const r of pairResults) {
      const byMode = results[r.spreadIdx];
      r.acc.forEach((a, mi) => {
        const mode = MODES[mi];
        const cell = byMode[mode];
        cell.mus.push(a.sum / J);
        cell.vs.push(sampleVar(a.sum, a.sumSq, J));
        cell.poolSum += a.sum;
        cell.poolSumSq += a.sumSq;
        cell.poolN += J;
      });
    }
  };

  if (nWorkers === 0) {
    const policy = loadPolicy();
    let done = 0;
    for (const p of pairs) {
      ingest([{ spreadIdx: p.spreadIdx, k: p.k, acc: runPair(policy, p.epsA, p.epsB, J, p.seed) }]);
      if (++done % 25 === 0 || done === pairs.length) {
        process.stdout.write(`\r  pairs ${done}/${pairs.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
      }
    }
    process.stdout.write('\n');
  } else {
    // Round-robin split so each worker gets a mix of cheap (novice) and dear
    // (expert) pairs → balanced wall-time.
    const chunks = Array.from({ length: nWorkers }, () => []);
    pairs.forEach((p, i) => chunks[i % nWorkers].push(p));
    await Promise.all(chunks.map((chunk, wi) => new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { pairs: chunk, J } });
      w.on('message', (msg) => { ingest(msg); resolve(); });
      w.on('error', reject);
      w.on('exit', (code) => { if (code !== 0) reject(new Error(`worker ${wi} exited ${code}`)); });
    })));
  }

  const seconds = (Date.now() - t0) / 1000;

  // Assemble the JSON + table.
  const spreadsOut = SPREADS.map((sp, spreadIdx) => {
    const byMode = results[spreadIdx];
    const variants = MODES.map((mode) => {
      const cell = byMode[mode];
      const aleatoryVar = mean(cell.vs);          // E_Θ[Var_Ω(M|Θ)]
      const epistemicVar = sampleVarArr(cell.mus); // Var_Θ[E_Ω(M|Θ)]
      const rawVar = sampleVar(cell.poolSum, cell.poolSumSq, cell.poolN);
      const denom = aleatoryVar + epistemicVar;
      const aleatoryPct = denom > 0 ? (100 * aleatoryVar) / denom : 0;
      const epistemicPct = denom > 0 ? (100 * epistemicVar) / denom : 0;
      return {
        mode,
        name: MODE_NAME[mode],
        aleatoryPct: round(aleatoryPct, 2),
        epistemicPct: round(epistemicPct, 2),
        aleatoryVar: round(aleatoryVar, 1),
        epistemicVar: round(epistemicVar, 1),
        marginStd: round(Math.sqrt(Math.max(0, rawVar)), 2),
        rawVar: round(rawVar, 1),
      };
    });
    const out = { key: sp.key, label: sp.label, epsRange: sp.epsRange };
    if (sp.default) out.default = true;
    out.variants = variants;
    return out;
  });

  const json = {
    method: METHOD,
    skillModel: SKILL_MODEL,
    generatedBy: 'solver/uncertainty.js',
    generatedAt: new Date().toISOString(),
    seed,
    samples: { outerSkillPairs: K, innerGamesPerPair: J, marginsPerCell: K * J },
    spreads: spreadsOut,
  };

  fs.writeFileSync(outPath, JSON.stringify(json, null, 2) + '\n');

  printTable(spreadsOut, seconds);
  console.log(`\nwrote ${outPath}  (${seconds.toFixed(1)}s)`);
}

function printTable(spreadsOut, seconds) {
  console.log('\nLuck vs Skill decomposition of the match margin  (Var(M) = Aleatory + Epistemic)\n');
  const pad = (s, n) => String(s).padStart(n);
  const padE = (s, n) => String(s).padEnd(n);
  console.log(padE('spread', 9) + padE('variant', 14)
    + pad('luck%', 8) + pad('skill%', 8)
    + pad('aleatVar', 11) + pad('epistVar', 11)
    + pad('rawVar', 10) + pad('|raw-Σ|', 9) + pad('mrgStd', 8));
  console.log('-'.repeat(86));
  for (const sp of spreadsOut) {
    for (const v of sp.variants) {
      const sigma = v.aleatoryVar + v.epistemicVar;
      const diff = Math.abs(v.rawVar - sigma);
      console.log(padE(sp.key, 9) + padE(v.name, 14)
        + pad(v.aleatoryPct.toFixed(1), 8) + pad(v.epistemicPct.toFixed(1), 8)
        + pad(v.aleatoryVar.toFixed(0), 11) + pad(v.epistemicVar.toFixed(0), 11)
        + pad(v.rawVar.toFixed(0), 10) + pad(diff.toFixed(0), 9)
        + pad(v.marginStd.toFixed(1), 8));
    }
    console.log('');
  }

  // Sanity summary.
  console.log('Sanity checks:');
  for (const sp of spreadsOut) {
    const epi = sp.variants.map((v) => v.epistemicVar);
    const ale = sp.variants.map((v) => v.aleatoryVar);
    const epiPct = sp.variants.map((v) => v.epistemicPct);
    const epiSpread = (Math.max(...epi) - Math.min(...epi)) / (mean(epi) || 1) * 100;
    // Trends judged within MC tolerance: aleatory ~1% relative, epistemic% 0.3pp
    // (the experts v1/v2 skill gap is tiny, so its epistemic% is noise-limited).
    const aleMono = ale[0] >= ale[1] * 0.99 && ale[1] >= ale[2] * 0.99;
    const epiPctMono = epiPct[0] <= epiPct[1] + 0.3 && epiPct[1] <= epiPct[2] + 0.3;
    console.log(`  ${padE(sp.key, 9)} epistemicVar≈const (spread ${epiSpread.toFixed(0)}%)`
      + `  aleatory↓1→2→3: ${aleMono ? 'yes' : 'NO'}`
      + `  epistemic%↑1→2→3: ${epiPctMono ? 'yes' : 'NO'}`
      + `  [ale ${ale.map((x) => x.toFixed(0)).join('/')}]`);
  }
  void seconds;
}

function parseArgs(argv) {
  const a = { K: 200, J: 150, seed: 1, workers: Math.max(1, os.cpus().length - 2), single: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = () => (argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i]);
    if (t === '--K' || t.startsWith('--K=')) a.K = Number(val());
    else if (t === '--J' || t.startsWith('--J=')) a.J = Number(val());
    else if (t === '--seed' || t.startsWith('--seed=')) a.seed = Number(val());
    else if (t === '--workers' || t.startsWith('--workers=')) a.workers = Number(val());
    else if (t === '--out' || t.startsWith('--out=')) a.out = val();
    else if (t === '--single') a.single = true;
    else { console.error(`unknown flag ${t}`); process.exit(1); }
  }
  if (!Number.isInteger(a.K) || a.K < 2) { console.error('--K must be an integer ≥ 2'); process.exit(1); }
  if (!Number.isInteger(a.J) || a.J < 2) { console.error('--J must be an integer ≥ 2'); process.exit(1); }
  return a;
}

if (isMainThread) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
