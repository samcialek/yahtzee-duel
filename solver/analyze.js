// solver/analyze.js
// CLI analyzer over the solved table (SOLVER.md §4). Examples:
//
//   node solver/analyze.js                                    # empty-card state EV
//   node solver/analyze.js --filled ones,fullHouse --up 3
//   node solver/analyze.js --filled yahtzee --yz --up 12 --dice 6,6,6,6,6 --rolls 1
//   node solver/analyze.js --dice 1,2,3,4,6 --rolls 2
//
// Flags:
//   --filled a,b,c   comma-separated category names already filled (default none)
//   --up N           upper-section subtotal 0..63 (default 0; must be reachable)
//   --yz             yahtzee box holds 50 (requires yahtzee in --filled)
//   --dice a,b,c,d,e current dice; omit for state EV only
//   --rolls N        rerolls remaining 0|1|2 (default 2; only with --dice)
//
// Prints: state EV; with dice: ranked keeps (top 10, plus keep-all and
// reroll-all always shown) and ranked categories (joker-blocked dimmed).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Policy } from './policy.js';
import { CAT_ORDER } from './tables.js';
import { upListOf } from './states.js';

const YZ_BIT = 1 << 11;

// ---------------------------------------------------------------------------
// Argument parsing (--flag value | --flag=value | bare boolean --yz)
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(`error: ${msg}`);
  console.error('usage: node solver/analyze.js [--filled cats] [--up N] [--yz]'
    + ' [--dice a,b,c,d,e] [--rolls 0|1|2]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { filled: [], up: 0, yz: 0, dice: null, rolls: 2, rollsGiven: false };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    let val = null;
    const eq = arg.indexOf('=');
    if (eq !== -1) { val = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const takeVal = () => {
      if (val !== null) return val;
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--filled': {
        const names = takeVal().split(',').map(s => s.trim()).filter(s => s.length > 0);
        for (const name of names) {
          if (!CAT_ORDER.includes(name)) {
            fail(`unknown category "${name}" (valid: ${CAT_ORDER.join(', ')})`);
          }
        }
        args.filled = names;
        break;
      }
      case '--up': {
        const n = Number(takeVal());
        if (!Number.isInteger(n) || n < 0 || n > 63) fail(`--up must be an integer 0..63`);
        args.up = n;
        break;
      }
      case '--yz': {
        if (val !== null) {
          if (val !== '0' && val !== '1') fail(`--yz takes no value, or 0/1`);
          args.yz = Number(val);
        } else if (i + 1 < argv.length && (argv[i + 1] === '0' || argv[i + 1] === '1')) {
          args.yz = Number(argv[++i]);
        } else {
          args.yz = 1;
        }
        break;
      }
      case '--dice': {
        const faces = takeVal().split(',').map(s => Number(s.trim()));
        if (faces.length !== 5 || faces.some(f => !Number.isInteger(f) || f < 1 || f > 6)) {
          fail(`--dice must be 5 comma-separated faces 1..6`);
        }
        args.dice = faces;
        break;
      }
      case '--rolls': {
        const n = Number(takeVal());
        if (n !== 0 && n !== 1 && n !== 2) fail(`--rolls must be 0, 1 or 2`);
        args.rolls = n;
        args.rollsGiven = true;
        break;
      }
      default:
        fail(`unknown flag: ${arg}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Load table, build state, query
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

const dir = path.dirname(fileURLToPath(import.meta.url));
const bin = fs.readFileSync(path.join(dir, 'strategy.bin'));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'strategy-meta.json'), 'utf8'));
const policy = new Policy(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);

let mask = 0;
for (const name of args.filled) mask |= 1 << CAT_ORDER.indexOf(name);
if (args.yz === 1 && (mask & YZ_BIT) === 0) {
  fail('--yz requires yahtzee to be in --filled (the box must be filled to hold 50)');
}
if (mask === 0x1fff) fail('all 13 categories filled — the game is over, EV of the rest is 0');

const upList = upListOf(mask);
if (!upList.includes(args.up)) {
  fail(`--up ${args.up} is not reachable for filled=[${args.filled.join(',') || 'none'}]`
    + ` (reachable: ${upList.join(', ')})`);
}

const fmt = x => x.toFixed(4);
const facesStr = faces => faces.length === 0 ? '(none)' : `[${faces.join(',')}]`;

const stateEV = policy.stateEV(mask, args.up, args.yz);
console.log('State');
console.log(`  filled : ${args.filled.length > 0 ? args.filled.join(', ') : '(none — empty card)'}`);
console.log(`  open   : ${CAT_ORDER.filter((_, c) => ((mask >> c) & 1) === 0).join(', ')}`);
console.log(`  upper  : ${args.up} / 63    yahtzee-box-holds-50: ${args.yz === 1 ? 'yes' : 'no'}`);
console.log(`  state EV (before rolling): ${fmt(stateEV)}`);

if (args.dice === null) {
  if (args.rollsGiven) console.log('\n(--rolls ignored: no --dice given)');
  process.exit(0);
}

const res = policy.evalTurn(mask, args.up, args.yz, args.dice, args.rolls);
console.log(`\nDice ${facesStr(args.dice)}   rolls left: ${args.rolls}`);

if (res.keeps !== null) {
  const nDice = args.dice.length;
  const rows = [];
  for (let i = 0; i < res.keeps.length; i++) {
    const k = res.keeps[i];
    const isAll = k.faces.length === nDice;
    const isNone = k.faces.length === 0;
    if (i < 10 || isAll || isNone) {
      let note = '';
      if (isAll) note = '  (keep all — stand pat)';
      else if (isNone) note = '  (reroll all)';
      rows.push({ rank: i + 1, k, note });
    }
  }
  console.log(`\nKeeps (${res.keeps.length} distinct sub-multisets, best first; showing top 10 + keep-all + reroll-all):`);
  let lastRank = 0;
  for (const { rank, k, note } of rows) {
    if (rank > lastRank + 1) console.log('        ...');
    lastRank = rank;
    const star = rank === 1 ? '*' : ' ';
    console.log(` ${star}${String(rank).padStart(3)}. keep ${facesStr(k.faces).padEnd(13)} EV ${fmt(k.ev)}${note}`);
  }
}

console.log('\nCategories (score now; best first):');
res.categories.forEach((c, i) => {
  const star = res.best.type === 'score' && c.cat === res.best.cat && c.legal ? '*' : ' ';
  const tag = c.legal ? '' : '   [joker-blocked]';
  console.log(` ${star}${String(i + 1).padStart(3)}. ${c.cat.padEnd(14)} pts ${String(c.pts).padStart(3)}   EV ${fmt(c.ev)}${tag}`);
});

if (res.best.type === 'score') {
  console.log(`\nBest action: SCORE ${res.best.cat} for ${res.best.pts} pts  →  EV ${fmt(res.best.ev)}`);
} else {
  console.log(`\nBest action: KEEP ${facesStr(res.best.faces)} and reroll ${5 - res.best.faces.length}  →  EV ${fmt(res.best.ev)}`);
}
