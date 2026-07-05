// solver/simulate.js
// Monte-Carlo validation of the optimal policy (SOLVER.md §4): plays N full
// games (default 10 000, --n N) with REAL Math.random dice through the actual
// game rules (PlayerState / nextDice / scoreCategory from public/shared/game.js),
// taking every decision from policy.evalTurn.
//
//   node solver/simulate.js [--n 10000]
//
// Reports mean / stddev / min / max, P(score ≥ 300), yahtzee rate, extra-yahtzee
// bonus count, upper-bonus rate. Hard assertions:
//   - |mean − 254.59| < 2.0  (σ ≈ 59.6 → 3σ of the mean ≈ 1.8 at N = 10k)
//   - no illegal action is ever chosen: scoreCategory() returning null → throw
//   - the game's awarded pts must equal the policy's predicted pts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Policy, fromPlayerState } from './policy.js';
import { PlayerState, nextDice, ROUNDS } from '../public/shared/game.js';

const TARGET_MEAN = 254.59;
const MEAN_TOL = 2.0;

// ---------------------------------------------------------------------------
// Args & setup
// ---------------------------------------------------------------------------

let nGames = 10000;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--n' || argv[i].startsWith('--n=')) {
      const v = argv[i].startsWith('--n=') ? argv[i].slice(4) : argv[++i];
      nGames = Number(v);
      if (!Number.isInteger(nGames) || nGames < 1) {
        console.error(`error: --n must be a positive integer, got ${v}`);
        process.exit(1);
      }
    } else {
      console.error(`error: unknown flag ${argv[i]} (usage: node solver/simulate.js [--n N])`);
      process.exit(1);
    }
  }
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const bin = fs.readFileSync(path.join(dir, 'strategy.bin'));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'strategy-meta.json'), 'utf8'));
const policy = new Policy(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);

// Multiset keep → positional hold mask (greedy face-count matching, §5).
function holdFromKeep(dice, keepFaces) {
  const need = [0, 0, 0, 0, 0, 0, 0];
  for (const f of keepFaces) need[f]++;
  const hold = [false, false, false, false, false];
  for (let i = 0; i < 5; i++) {
    if (need[dice[i]] > 0) { hold[i] = true; need[dice[i]]--; }
  }
  return hold;
}

// ---------------------------------------------------------------------------
// Play one game with real Math.random dice, decisions from evalTurn
// ---------------------------------------------------------------------------

const NO_HOLD = [false, false, false, false, false];

function playGame() {
  const ps = new PlayerState();
  while (!ps.done) {
    // Roll #1 (mode 1 = classic independent random dice; shared unused).
    ps.applyRoll(nextDice(ps, NO_HOLD, 1, null).dice);
    for (;;) {
      const { mask, up, yz } = fromPlayerState(ps);
      const res = policy.evalTurn(mask, up, yz, ps.dice, ps.rollsLeft);
      if (res.best.type === 'score') {
        const pts = ps.scoreCategory(res.best.cat);
        if (pts === null) {
          throw new Error(`ILLEGAL ACTION: scoreCategory(${res.best.cat}) returned null`
            + ` at mask=${mask} up=${up} yz=${yz} dice=[${ps.dice}] rollsLeft=${ps.rollsLeft}`);
        }
        if (pts !== res.best.pts) {
          throw new Error(`PTS MISMATCH: game awarded ${pts}, policy predicted ${res.best.pts}`
            + ` for ${res.best.cat} at mask=${mask} up=${up} yz=${yz} dice=[${ps.dice}]`);
        }
        break;
      }
      const hold = holdFromKeep(ps.dice, res.best.faces);
      ps.applyRoll(nextDice(ps, hold, 1, null).dice);
    }
  }
  if (ps.round !== ROUNDS) throw new Error(`game ended after ${ps.round} rounds`);
  return ps;
}

// ---------------------------------------------------------------------------
// Run & tally
// ---------------------------------------------------------------------------

console.log(`simulating ${nGames} games under the optimal policy (real Math.random dice)…`);
const t0 = Date.now();

let sum = 0, sumSq = 0, min = Infinity, max = -Infinity;
let ge300 = 0, yahtzee50 = 0, extraYahtzees = 0, upperBonus = 0;

for (let g = 1; g <= nGames; g++) {
  const ps = playGame();
  const total = ps.total;
  sum += total;
  sumSq += total * total;
  if (total < min) min = total;
  if (total > max) max = total;
  if (total >= 300) ge300++;
  if (ps.card.yahtzee === 50) yahtzee50++;
  extraYahtzees += ps.yahtzeeBonus / 100;
  if (ps.upperSum >= 63) upperBonus++;

  if (g % 1000 === 0 || g === nGames) {
    const el = (Date.now() - t0) / 1000;
    console.log(`  ${String(g).padStart(7)}/${nGames}  running mean ${(sum / g).toFixed(2)}  (${el.toFixed(1)}s)`);
  }
}

const mean = sum / nGames;
const variance = nGames > 1 ? (sumSq - nGames * mean * mean) / (nGames - 1) : 0;
const stddev = Math.sqrt(Math.max(0, variance));
const seconds = (Date.now() - t0) / 1000;

console.log('\nResults');
console.log(`  games            : ${nGames}  (${seconds.toFixed(1)}s, ${(seconds * 1000 / nGames).toFixed(2)} ms/game)`);
console.log(`  mean             : ${mean.toFixed(3)}   (optimal EV ${meta.startEV.toFixed(4)})`);
console.log(`  stddev           : ${stddev.toFixed(3)}`);
console.log(`  min / max        : ${min} / ${max}`);
console.log(`  P(score >= 300)  : ${(ge300 / nGames).toFixed(4)}  (${ge300})`);
console.log(`  yahtzee rate     : ${(yahtzee50 / nGames).toFixed(4)}  (games with yahtzee box = 50)`);
console.log(`  extra yahtzees   : ${extraYahtzees} bonuses (+100), ${(extraYahtzees / nGames).toFixed(4)} per game`);
console.log(`  upper-bonus rate : ${(upperBonus / nGames).toFixed(4)}  (games with upper >= 63)`);

if (!(Math.abs(mean - TARGET_MEAN) < MEAN_TOL)) {
  console.error(`\nFAIL: |mean ${mean.toFixed(3)} - ${TARGET_MEAN}| >= ${MEAN_TOL}`);
  process.exit(1);
}
console.log(`\nok - |mean - ${TARGET_MEAN}| = ${Math.abs(mean - TARGET_MEAN).toFixed(3)} < ${MEAN_TOL};`
  + ' no illegal action was ever chosen');
