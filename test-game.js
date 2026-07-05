// test-game.js — dependency-free node smoke test for public/shared/game.js
// Run: node test-game.js

import assert from 'node:assert/strict';
import {
  ROUNDS, UPPER, LOWER, CATS, isYahtzee,
  scoreCat, potentials, makeShared, nextDice, PlayerState,
} from './public/shared/game.js';

let n = 0;
const ok = (msg) => { n++; };

// ---------------------------------------------------------------------------
// Exports & constants
// ---------------------------------------------------------------------------
assert.equal(ROUNDS, 13, 'ROUNDS is 13');
assert.deepEqual(UPPER, ['ones','twos','threes','fours','fives','sixes'], 'UPPER order');
assert.deepEqual(LOWER,
  ['threeKind','fourKind','fullHouse','smallStraight','largeStraight','yahtzee','chance'], 'LOWER order');
assert.equal(CATS.length, 13, '13 categories');
assert.equal(isYahtzee([4,4,4,4,4]), true, 'isYahtzee all same');
assert.equal(isYahtzee([4,4,4,4,5]), false, 'isYahtzee not all same');
ok();

// ---------------------------------------------------------------------------
// scoreCat — face scoring
// ---------------------------------------------------------------------------
assert.equal(scoreCat('threes', [3,3,3,1,2]), 9, 'threes = 3*3 = 9');
assert.equal(scoreCat('ones',   [1,1,4,5,6]), 2, 'ones = 2');
assert.equal(scoreCat('sixes',  [6,6,6,6,1]), 24, 'sixes = 24');
assert.equal(scoreCat('twos',   [3,3,3,1,1]), 0, 'twos absent = 0');
ok();

// three-of-a-kind & four-of-a-kind = sum of ALL dice
assert.equal(scoreCat('threeKind', [3,3,3,1,2]), 12, '3-kind = sum all = 12');
assert.equal(scoreCat('threeKind', [3,3,1,2,4]), 0,  'no 3-kind = 0');
assert.equal(scoreCat('fourKind',  [4,4,4,4,2]), 18, '4-kind = sum all = 18');
assert.equal(scoreCat('fourKind',  [4,4,4,1,2]), 0,  'no 4-kind = 0');
assert.equal(scoreCat('threeKind', [5,5,5,5,5]), 25, '3-kind also from yahtzee = 25');
ok();

// full house = 25 (exactly 3+2), yahtzee is NOT a full house textbook-wise
assert.equal(scoreCat('fullHouse', [2,2,3,3,3]), 25, 'full house = 25');
assert.equal(scoreCat('fullHouse', [2,2,3,3,4]), 0,  'not full house = 0');
assert.equal(scoreCat('fullHouse', [5,5,5,5,5]), 0,  'yahtzee is not a textbook full house');
ok();

// small straight = 30 & large straight = 40, detected even in UNSORTED dice
assert.equal(scoreCat('smallStraight', [3,1,2,4,6]), 30, 'small straight unsorted = 30');
assert.equal(scoreCat('smallStraight', [6,4,3,2,1]), 30, 'small straight (from large-ish) = 30');
assert.equal(scoreCat('smallStraight', [1,2,3,5,6]), 0,  'gap breaks small straight');
assert.equal(scoreCat('largeStraight', [5,3,1,2,4]), 40, 'large straight unsorted 1-5 = 40');
assert.equal(scoreCat('largeStraight', [2,5,4,6,3]), 40, 'large straight unsorted 2-6 = 40');
assert.equal(scoreCat('largeStraight', [1,2,3,4,4]), 0,  'not a large straight = 0');
assert.equal(scoreCat('smallStraight', [1,2,3,4,4]), 30, 'contains small straight = 30');
ok();

// yahtzee = 50, chance = sum
assert.equal(scoreCat('yahtzee', [6,6,6,6,6]), 50, 'yahtzee = 50');
assert.equal(scoreCat('yahtzee', [6,6,6,6,1]), 0,  'not yahtzee = 0');
assert.equal(scoreCat('chance',  [1,2,3,4,5]), 15, 'chance = sum = 15');
assert.equal(scoreCat('chance',  [6,6,6,6,6]), 30, 'chance = sum = 30');
ok();

// ---------------------------------------------------------------------------
// Upper bonus present at exactly 63, absent at 62
// ---------------------------------------------------------------------------
{
  const at63 = new PlayerState();
  Object.assign(at63.card, { ones:3, twos:6, threes:9, fours:12, fives:15, sixes:18 }); // = 63
  assert.equal(at63.upperSum, 63, 'upperSum exactly 63');
  assert.equal(at63.upperBonus, 35, 'bonus present at 63');

  const at62 = new PlayerState();
  Object.assign(at62.card, { ones:2, twos:6, threes:9, fours:12, fives:15, sixes:18 }); // = 62
  assert.equal(at62.upperSum, 62, 'upperSum exactly 62');
  assert.equal(at62.upperBonus, 0, 'bonus absent at 62');
  ok();
}

// ---------------------------------------------------------------------------
// Extra-Yahtzee: +100 bonus AND joker forcing across all three branches
// ---------------------------------------------------------------------------

// potentials — branch 1: matching upper box open => forced there
{
  const card = {};
  for (const c of CATS) card[c] = null;
  card.yahtzee = 50;                       // yahtzee box already holds 50
  const pot = potentials(card, [3,3,3,3,3]); // face 3, upCat = 'threes' (open)
  assert.equal(pot.threes.allowed, true,  'branch1: forced into matching upper');
  assert.equal(pot.threes.pts, 15,        'branch1: matching upper = face*5 = 15');
  assert.equal(pot.fullHouse.allowed, false, 'branch1: lower disallowed');
  assert.equal(pot.fours.allowed, false,     'branch1: other upper disallowed');
  assert.equal('yahtzee' in pot, false,      'branch1: filled yahtzee not offered');
  ok();
}

// potentials — branch 2: matching upper filled, lower open => any lower box at joker values
{
  const card = {};
  for (const c of CATS) card[c] = null;
  card.yahtzee = 50;
  card.threes = 9;                          // matching upper now FILLED
  const pot = potentials(card, [3,3,3,3,3]);
  assert.equal(pot.fullHouse.allowed, true,     'branch2: lower allowed');
  assert.equal(pot.fullHouse.pts, 25,           'branch2: full house joker = 25');
  assert.equal(pot.smallStraight.pts, 30,       'branch2: small straight joker = 30');
  assert.equal(pot.largeStraight.pts, 40,       'branch2: large straight joker = 40');
  assert.equal(pot.threeKind.pts, 15,           'branch2: 3-kind joker = sum = 15');
  assert.equal(pot.fourKind.pts, 15,            'branch2: 4-kind joker = sum = 15');
  assert.equal(pot.chance.pts, 15,              'branch2: chance joker = sum = 15');
  assert.equal(pot.fours.allowed, false,        'branch2: open upper disallowed');
  ok();
}

// potentials — branch 3: matching upper filled, all lower filled => forced to zero an upper
{
  const card = {};
  for (const c of CATS) card[c] = null;
  card.yahtzee = 50;
  card.threes = 9;                          // matching upper filled
  for (const c of ['threeKind','fourKind','fullHouse','smallStraight','largeStraight','chance'])
    card[c] = 0;                            // all lower (except yahtzee) filled
  const pot = potentials(card, [3,3,3,3,3]);
  assert.equal(pot.fours.allowed, true, 'branch3: remaining upper allowed');
  assert.equal(pot.fours.pts, 0,        'branch3: forced upper = 0');
  assert.equal(pot.fives.allowed, true, 'branch3: another remaining upper allowed');
  assert.equal(pot.fives.pts, 0,        'branch3: forced upper = 0');
  ok();
}

// scoreCategory — +100 applied BEFORE writing, and joker forcing enforced (branch 1)
{
  const ps = new PlayerState();
  ps.card.yahtzee = 50;                     // already have a yahtzee
  ps.applyRoll([3,3,3,3,3]);                // branch 1: forced to 'threes'
  assert.equal(ps.scoreCategory('fours'), null, 'branch1: illegal category rejected');
  assert.equal(ps.card.fours, null,             'branch1: rejected write did not mutate');
  const pts = ps.scoreCategory('threes');
  assert.equal(pts, 15,                'branch1: threes scored 15');
  assert.equal(ps.card.threes, 15,    'branch1: box written');
  assert.equal(ps.yahtzeeBonus, 100,  'extra-yahtzee +100 applied');
  assert.equal(ps.round, 1,           'round advanced');
  assert.equal(ps.rollsLeft, 3,       'rolls reset');
  assert.equal(ps.dice, null,         'dice cleared');
  ok();
}

// scoreCategory — branch 2: any lower box at joker value, +100 applied
{
  const ps = new PlayerState();
  ps.card.yahtzee = 50;
  ps.card.threes = 9;                       // matching upper filled -> branch 2
  ps.applyRoll([3,3,3,3,3]);
  const before = ps.yahtzeeBonus;
  const pts = ps.scoreCategory('fullHouse');
  assert.equal(pts, 25,                     'branch2: full house joker = 25');
  assert.equal(ps.card.fullHouse, 25,       'branch2: box written');
  assert.equal(ps.yahtzeeBonus, before + 100, 'branch2: +100 applied');
  ok();
}

// scoreCategory — branch 3: forced to zero a remaining upper, +100 still applied
{
  const ps = new PlayerState();
  ps.card.yahtzee = 50;
  ps.card.threes = 9;
  for (const c of ['threeKind','fourKind','fullHouse','smallStraight','largeStraight','chance'])
    ps.card[c] = 0;
  ps.applyRoll([3,3,3,3,3]);
  const pts = ps.scoreCategory('fours');
  assert.equal(pts, 0,                'branch3: forced upper zeroed');
  assert.equal(ps.card.fours, 0,      'branch3: box written as 0');
  assert.equal(ps.yahtzeeBonus, 100,  'branch3: +100 still applied (yahtzee box holds 50)');
  ok();
}

// A ZEROED yahtzee box earns NO bonus, but joker restrictions STILL apply
{
  const ps = new PlayerState();
  ps.card.yahtzee = 0;                       // zeroed yahtzee: no bonus, joker still triggers
  ps.applyRoll([3,3,3,3,3]);                 // branch 1: forced to threes
  assert.equal(ps.scoreCategory('fours'), null, 'zeroed-yahtzee joker still restricts');
  const pts = ps.scoreCategory('threes');
  assert.equal(pts, 15,              'zeroed-yahtzee joker: threes = 15');
  assert.equal(ps.yahtzeeBonus, 0,   'zeroed yahtzee earns no +100 bonus');
  ok();
}

// First yahtzee into an open yahtzee box scores 50 with NO bonus
{
  const ps = new PlayerState();
  ps.applyRoll([5,5,5,5,5]);
  const pts = ps.scoreCategory('yahtzee');
  assert.equal(pts, 50,             'first yahtzee = 50');
  assert.equal(ps.yahtzeeBonus, 0,  'first yahtzee grants no bonus');
  assert.equal(ps.card.yahtzee, 50, 'yahtzee box now holds 50');
  ok();
}

// ---------------------------------------------------------------------------
// serialize / total wiring
// ---------------------------------------------------------------------------
{
  const ps = new PlayerState();
  Object.assign(ps.card, { ones:3, twos:6, threes:9, fours:12, fives:15, sixes:18 }); // 63 -> +35
  ps.card.yahtzee = 50;
  ps.yahtzeeBonus = 100;
  // total = 63 (upper) + 35 (bonus) + 50 (yahtzee) + 100 (yahtzeeBonus) = 248
  assert.equal(ps.total, 248, 'total wiring incl. bonuses');
  const view = ps.serialize(false);
  assert.equal(view.dice, null,       'serialize(false) hides dice');
  assert.equal(view.upperBonus, 35,   'serialize carries upperBonus');
  assert.equal(view.total, 248,       'serialize carries total');
  assert.equal(view.done, false,      'not done at round 0');
  ps.dice = [1,2,3,4,5];
  assert.deepEqual(ps.serialize(true).dice, [1,2,3,4,5], 'serialize(true) reveals dice');
  ok();
}

// done getter
{
  const ps = new PlayerState();
  ps.round = ROUNDS;
  assert.equal(ps.done, true, 'done at round === ROUNDS');
  ok();
}

// ---------------------------------------------------------------------------
// makeShared / nextDice — shared opening (variant 2/3) and independence (variant 2)
// ---------------------------------------------------------------------------
{
  const shared = makeShared();
  assert.equal(shared.first.length, ROUNDS, 'shared.first has ROUNDS entries');
  assert.equal(shared.rerolls.length, ROUNDS, 'shared.rerolls has ROUNDS entries');
  assert.equal(shared.first[0].length, 5, 'shared opening roll has 5 dice');
  assert.equal(shared.rerolls[0].length, 2, 'two reroll sequences per round');

  const a = new PlayerState(), b = new PlayerState();
  const ra = nextDice(a, null, 2, shared);   // variant 2 first roll
  const rb = nextDice(b, null, 2, shared);
  assert.deepEqual(ra.dice, rb.dice, 'variant 2/3: identical opening roll');
  assert.deepEqual(ra.dice, shared.first[0], 'opening roll comes from shared.first');
  assert.deepEqual(ra.mask, [0,1,2,3,4], 'first-roll mask is all five');
  ok();
}

// ---------------------------------------------------------------------------
// Variant-3 linked-reroll invariant: same round/roll, reroll k1 & k2 dice
// => first min(k1,k2) reroll VALUES match positionally (by reroll index).
// ---------------------------------------------------------------------------
{
  const shared = makeShared();
  const a = new PlayerState(), b = new PlayerState();

  // both take the (shared) opening roll of round 0
  a.applyRoll(nextDice(a, null, 3, shared).dice);   // rollsLeft 3 -> 2
  b.applyRoll(nextDice(b, null, 3, shared).dice);
  assert.equal(a.round, b.round, 'same round');
  assert.equal(a.rollsLeft, b.rollsLeft, 'same roll number');

  const holdA = [true,  true,  false, false, false]; // A rerolls positions 2,3,4  (k1 = 3)
  const holdB = [true,  true,  true,  true,  false];  // B rerolls position 4       (k2 = 1)
  const ra = nextDice(a, holdA, 3, shared);
  const rb = nextDice(b, holdB, 3, shared);

  // reroll values in reroll (position) order
  const valsA = ra.mask.map(p => ra.dice[p]);
  const valsB = rb.mask.map(p => rb.dice[p]);
  const shareN = Math.min(valsA.length, valsB.length);
  assert.equal(shareN, 1, 'min(k1,k2) = 1');
  for (let k = 0; k < shareN; k++)
    assert.equal(valsA[k], valsB[k], `linked reroll value #${k} matches positionally`);

  // and they match the shared reroll sequence (roll #2 => rerolls[round][0])
  const seq = shared.rerolls[0][0];
  for (let k = 0; k < valsA.length; k++)
    assert.equal(valsA[k], seq[k], `A reroll #${k} == shared seq[${k}]`);
  ok();

  // A larger overlap: k1 = 4, k2 = 2 -> first 2 reroll values shared
  const a2 = new PlayerState(), b2 = new PlayerState();
  a2.applyRoll(nextDice(a2, null, 3, shared).dice);
  b2.applyRoll(nextDice(b2, null, 3, shared).dice);
  const hA = [true, false, false, false, false];  // reroll 1,2,3,4  (k1 = 4)
  const hB = [true, true,  true,  false, false];   // reroll 3,4      (k2 = 2)
  const r2a = nextDice(a2, hA, 3, shared);
  const r2b = nextDice(b2, hB, 3, shared);
  const vA = r2a.mask.map(p => r2a.dice[p]);
  const vB = r2b.mask.map(p => r2b.dice[p]);
  const sN = Math.min(vA.length, vB.length);
  assert.equal(sN, 2, 'min(k1,k2) = 2');
  for (let k = 0; k < sN; k++)
    assert.equal(vA[k], vB[k], `larger overlap reroll value #${k} matches`);
  ok();
}

// ---------------------------------------------------------------------------
// Variant 2 rerolls are INDEPENDENT (not drawn from a shared sequence)
// ---------------------------------------------------------------------------
{
  // deterministic RNG to prove variant-2 rerolls call rand() fresh (mode !== 3 => seq = null)
  let i = 0;
  const seqvals = [0.10, 0.30, 0.50, 0.70, 0.90]; // -> faces 1,2,4,5,6
  const rng = () => seqvals[i++ % seqvals.length];
  const ps = new PlayerState();
  ps.dice = [6,6,6,6,6];
  ps.rollsLeft = 2;                                 // rollNum = 2 (a reroll)
  const hold = [true, true, false, false, false];   // reroll positions 2,3,4
  const r = nextDice(ps, hold, 2, makeShared(), rng);
  assert.deepEqual(r.mask, [2,3,4], 'variant2 reroll mask');
  assert.deepEqual([r.dice[0], r.dice[1]], [6,6], 'held dice unchanged');
  assert.deepEqual([r.dice[2], r.dice[3], r.dice[4]], [1,2,4], 'variant2 rerolled from rand()');
  ok();
}

console.log(`OK — all ${n} assertion groups passed.`);
