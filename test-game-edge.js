// test-game-edge.js — ADVERSARIAL edge-case suite for public/shared/game.js
// Run: node test-game-edge.js
//
// Goal: try HARD to break the foundation. Covers every case the verification
// task enumerates, PLUS an independent reference implementation of the joker
// rules cross-checked against potentials() over many random card states, and a
// fuzz check on scoreCat() invariants.

import assert from 'node:assert/strict';
import {
  ROUNDS, UPPER, LOWER, CATS, isYahtzee,
  scoreCat, potentials, makeShared, nextDice, PlayerState,
} from './public/shared/game.js';

let groups = 0;
const done = () => { groups++; };
const freshCard = () => Object.fromEntries(CATS.map(c => [c, null]));

// ===========================================================================
// A) scoreCat — straights hidden in unsorted dice that also contain pairs
// ===========================================================================
{
  // the exact example from the task: small straight embedded with a pair
  assert.equal(scoreCat('smallStraight', [3,5,2,4,3]), 30, 'SS in [3,5,2,4,3] (pair of 3s) = 30');
  assert.equal(scoreCat('largeStraight', [3,5,2,4,3]), 0,  'no LS in [3,5,2,4,3]');
  // more pairs-with-straight permutations
  assert.equal(scoreCat('smallStraight', [2,2,3,4,5]), 30, 'SS 2-5 with pair of 2s');
  assert.equal(scoreCat('smallStraight', [1,1,2,3,4]), 30, 'SS 1-4 with pair of 1s');
  assert.equal(scoreCat('smallStraight', [3,4,5,6,6]), 30, 'SS 3-6 with pair of 6s');
  assert.equal(scoreCat('smallStraight', [6,4,3,3,5]), 30, 'SS 3-6 unsorted with pair');
  // gap kills the straight even though 4 distinct faces present
  assert.equal(scoreCat('smallStraight', [1,2,4,5,6]), 0, 'gap at 3 -> no SS (has 1,2 | 4,5,6)');
  assert.equal(scoreCat('smallStraight', [1,3,4,5,6]), 30, '3-6 run present -> SS');
  // large straights hidden in unsorted order
  assert.equal(scoreCat('largeStraight', [4,1,3,5,2]), 40, 'LS 1-5 unsorted');
  assert.equal(scoreCat('largeStraight', [6,4,2,3,5]), 40, 'LS 2-6 unsorted');
  assert.equal(scoreCat('largeStraight', [1,2,3,4,6]), 0,  '1,2,3,4,6 is not a LS');
  done();
}

// ===========================================================================
// B) scoreCat — fuzz invariants over ALL 6^5 dice combos
//    (exhaustive, deterministic — no RNG luck involved)
// ===========================================================================
{
  const dice = [0,0,0,0,0];
  for (dice[0]=1; dice[0]<=6; dice[0]++)
  for (dice[1]=1; dice[1]<=6; dice[1]++)
  for (dice[2]=1; dice[2]<=6; dice[2]++)
  for (dice[3]=1; dice[3]<=6; dice[3]++)
  for (dice[4]=1; dice[4]<=6; dice[4]++) {
    const d = dice.slice();
    const sum = d.reduce((a,b)=>a+b,0);
    const counts = [0,0,0,0,0,0,0];
    for (const v of d) counts[v]++;

    const ss = scoreCat('smallStraight', d);
    const ls = scoreCat('largeStraight', d);
    const fh = scoreCat('fullHouse', d);
    const y  = scoreCat('yahtzee', d);
    const k3 = scoreCat('threeKind', d);
    const k4 = scoreCat('fourKind', d);

    assert.ok(ss === 0 || ss === 30, `SS in {0,30} for ${d}`);
    assert.ok(ls === 0 || ls === 40, `LS in {0,40} for ${d}`);
    assert.ok(fh === 0 || fh === 25, `FH in {0,25} for ${d}`);
    assert.equal(scoreCat('chance', d), sum, `chance = sum for ${d}`);

    // large straight ALWAYS implies small straight
    if (ls === 40) assert.equal(ss, 30, `LS implies SS for ${d}`);
    // yahtzee implies 3-kind and 4-kind (both = sum) and yahtzee = 50
    if (isYahtzee(d)) {
      assert.equal(y, 50, `yahtzee=50 for ${d}`);
      assert.equal(k3, sum, `3kind=sum for yahtzee ${d}`);
      assert.equal(k4, sum, `4kind=sum for yahtzee ${d}`);
      // five-of-a-kind is NEVER a textbook full house
      assert.equal(fh, 0, `five-of-a-kind is not a full house (${d})`);
    } else {
      assert.equal(y, 0, `non-yahtzee yahtzee=0 for ${d}`);
    }
    // 4-kind implies 3-kind (a group of >=4 is also >=3)
    if (k4 === sum && sum > 0) assert.equal(k3, sum, `4kind implies 3kind for ${d}`);
    // full house present but not five-of-a-kind => it's a genuine 3+2
    if (fh === 25) {
      assert.ok(counts.some(c=>c===3) && counts.some(c=>c===2), `FH is genuine 3+2 for ${d}`);
    }
    // face categories = count*face
    for (let f=1; f<=6; f++) {
      assert.equal(scoreCat(UPPER[f-1], d), counts[f]*f, `${UPPER[f-1]} = count*face for ${d}`);
    }
  }
  done();
}

// ===========================================================================
// C) FIVE-OF-A-KIND as FULL HOUSE — only reachable via the joker, never scoreCat
// ===========================================================================
{
  // scoreCat refuses it directly for every face
  for (let f=1; f<=6; f++)
    assert.equal(scoreCat('fullHouse', [f,f,f,f,f]), 0, `scoreCat FH([${f}x5]) = 0`);

  // ...but the joker path (matching upper filled, lower open) offers FH = 25
  const card = freshCard();
  card.yahtzee = 50;
  card.fives = 25;                 // matching upper (fives) FILLED -> branch 2
  const pot = potentials(card, [5,5,5,5,5]);
  assert.equal(pot.fullHouse.allowed, true, 'joker: FH allowed for five 5s');
  assert.equal(pot.fullHouse.pts, 25, 'joker: five-of-a-kind as FH = 25');
  done();
}

// ===========================================================================
// D) JOKER, matching upper FILLED, some lower boxes remain -> any open lower box
//    at joker values (FH=25, SS=30, LS=40, 3k/4k/chance = sum). Face 6 sample.
// ===========================================================================
{
  const card = freshCard();
  card.yahtzee = 50;
  card.sixes = 30;                          // matching upper filled
  // pre-fill a couple of lower boxes to prove only the OPEN ones are offered
  card.fullHouse = 25;
  card.smallStraight = 30;
  const pot = potentials(card, [6,6,6,6,6]);

  // filled boxes are NOT present in the result at all
  assert.equal('yahtzee' in pot, false, 'filled yahtzee not offered');
  assert.equal('sixes' in pot, false, 'filled matching-upper not offered');
  assert.equal('fullHouse' in pot, false, 'filled FH not offered');
  assert.equal('smallStraight' in pot, false, 'filled SS not offered');

  // remaining lower boxes allowed, at joker values (sum = 30 for face 6)
  assert.equal(pot.largeStraight.allowed, true, 'LS allowed');
  assert.equal(pot.largeStraight.pts, 40, 'LS joker = 40');
  assert.equal(pot.threeKind.allowed, true, '3k allowed');
  assert.equal(pot.threeKind.pts, 30, '3k joker = sum = 30');
  assert.equal(pot.fourKind.pts, 30, '4k joker = sum = 30');
  assert.equal(pot.chance.pts, 30, 'chance joker = sum = 30');

  // every OPEN upper box is present but DISALLOWED (can't dump into upper yet)
  for (const up of UPPER) if (card[up] === null) {
    assert.equal(pot[up].allowed, false, `open upper ${up} disallowed in branch 2`);
    assert.equal(pot[up].pts, 0, `open upper ${up} joker pts = 0`);
  }

  // scoreCategory honors it: illegal upper rejected, legal lower writes + bonus
  const ps = new PlayerState();
  Object.assign(ps.card, card);
  ps.applyRoll([6,6,6,6,6]);
  assert.equal(ps.scoreCategory('ones'), null, 'branch2: open upper rejected');
  assert.equal(ps.card.ones, null, 'branch2: rejected write did not mutate');
  const pts = ps.scoreCategory('largeStraight');
  assert.equal(pts, 40, 'branch2: LS joker scored 40');
  assert.equal(ps.yahtzeeBonus, 100, 'branch2: +100 applied (yahtzee box = 50)');
  done();
}

// ===========================================================================
// E) JOKER, ALL lower boxes filled -> forced to ZERO a remaining upper box
// ===========================================================================
{
  const card = freshCard();
  card.yahtzee = 0;                          // note: zeroed yahtzee, joker STILL applies
  card.twos = 6;                             // matching upper (face 2) filled
  for (const c of ['threeKind','fourKind','fullHouse','smallStraight','largeStraight','chance'])
    card[c] = 0;                             // every lower (except yahtzee) filled
  // remaining open: ones, threes, fours, fives, sixes (all upper)
  const pot = potentials(card, [2,2,2,2,2]);

  const open = CATS.filter(c => card[c] === null);
  assert.deepEqual(open.sort(), ['fives','fours','ones','sixes','threes'].sort(), 'only uppers open');
  for (const c of open) {
    assert.equal(pot[c].allowed, true, `branch3: ${c} allowed`);
    assert.equal(pot[c].pts, 0, `branch3: ${c} forced 0 (non-matching upper)`);
  }
  // no lower box (all filled) sneaks back in
  for (const c of LOWER) assert.equal(c in pot, false, `branch3: filled lower ${c} absent`);

  // scoreCategory: filled lower rejected, matching filled upper rejected, open upper -> 0
  const ps = new PlayerState();
  Object.assign(ps.card, card);
  ps.applyRoll([2,2,2,2,2]);
  assert.equal(ps.scoreCategory('fullHouse'), null, 'branch3: filled lower rejected');
  assert.equal(ps.scoreCategory('twos'), null,      'branch3: filled matching upper rejected');
  const pts = ps.scoreCategory('sixes');
  assert.equal(pts, 0, 'branch3: forced upper zeroed');
  assert.equal(ps.card.sixes, 0, 'branch3: box written as 0');
  assert.equal(ps.yahtzeeBonus, 0, 'branch3: NO +100 because yahtzee box holds 0');
  done();
}

// ===========================================================================
// F) A YAHTZEE BOX HOLDING 0: subsequent yahtzee grants NO +100 but STILL
//    imposes joker category restrictions (branch 2 variant)
// ===========================================================================
{
  const ps = new PlayerState();
  ps.card.yahtzee = 0;                       // zeroed
  ps.card.fours = 12;                        // matching upper filled -> branch 2
  ps.applyRoll([4,4,4,4,4]);
  // restriction: cannot dump into an open upper
  assert.equal(ps.scoreCategory('ones'), null, 'zeroed-yahtzee joker still restricts to lower');
  const pts = ps.scoreCategory('smallStraight');
  assert.equal(pts, 30, 'zeroed-yahtzee joker: SS = 30');
  assert.equal(ps.yahtzeeBonus, 0, 'zeroed yahtzee: no +100 in branch 2 either');
  done();
}

// ===========================================================================
// G) JOKER only fires on an ACTUAL yahtzee — a filled yahtzee box does NOT
//    restrict a non-yahtzee roll.
// ===========================================================================
{
  const card = freshCard();
  card.yahtzee = 50;
  const pot = potentials(card, [3,3,3,3,2]);  // four-of-a-kind, NOT a yahtzee
  // all open categories allowed, scored at textbook values (no joker forcing)
  for (const c of CATS) if (card[c] === null) {
    assert.equal(pot[c].allowed, true, `no joker: ${c} allowed for non-yahtzee`);
  }
  assert.equal(pot.fours.allowed, true, 'no joker: open upper freely allowed');
  assert.equal(pot.fullHouse.pts, 0, 'no joker: FH textbook 0 for 4-of-a-kind');
  assert.equal(pot.threeKind.pts, 14, 'no joker: 3k = sum = 14');
  assert.equal(pot.chance.pts, 14, 'no joker: chance = 14');
  done();
}

// ===========================================================================
// H) FIRST yahtzee is NOT a joker: player may score it anywhere (e.g. chance),
//    leaving the yahtzee box open, and earns no bonus.
// ===========================================================================
{
  const ps = new PlayerState();
  ps.applyRoll([5,5,5,5,5]);
  const pot = potentials(ps.card, ps.dice);
  assert.equal(pot.yahtzee.allowed, true, 'first yahtzee: yahtzee box offered');
  assert.equal(pot.yahtzee.pts, 50, 'first yahtzee: 50 available');
  assert.equal(pot.chance.allowed, true, 'first yahtzee: may take chance instead');
  const pts = ps.scoreCategory('chance');
  assert.equal(pts, 25, 'scored first yahtzee into chance = 25');
  assert.equal(ps.card.yahtzee, null, 'yahtzee box still OPEN');
  assert.equal(ps.yahtzeeBonus, 0, 'no bonus (no prior yahtzee)');
  done();
}

// ===========================================================================
// I) INDEPENDENT REFERENCE for the joker rules, cross-checked against
//    potentials() over MANY random filled-box configurations & faces.
// ===========================================================================
{
  const refJokerPts = (cat, upCat, s) => {
    if (UPPER.includes(cat)) return cat === upCat ? s : 0;
    if (cat === 'fullHouse') return 25;
    if (cat === 'smallStraight') return 30;
    if (cat === 'largeStraight') return 40;
    return s; // threeKind / fourKind / chance
  };
  const refAllowedSet = (card, upCat) => {
    const open = CATS.filter(c => card[c] === null);
    if (card[upCat] === null) return new Set([upCat]);
    const lowerOpen = LOWER.filter(c => c !== 'yahtzee' && card[c] === null);
    if (lowerOpen.length > 0) return new Set(lowerOpen);
    return new Set(open); // remaining opens are all uppers -> zero any
  };

  let checks = 0;
  for (let trial = 0; trial < 20000; trial++) {
    const face = 1 + Math.floor(Math.random() * 6);
    const upCat = UPPER[face - 1];
    const s = face * 5;
    const card = freshCard();
    card.yahtzee = Math.random() < 0.5 ? 50 : 0;   // filled (joker active)
    // randomly fill a subset of the OTHER categories
    for (const c of CATS) {
      if (c === 'yahtzee') continue;
      if (Math.random() < 0.5) card[c] = 0;         // value irrelevant to allow-logic
    }
    const dice = [face, face, face, face, face];
    const pot = potentials(card, dice);
    const allowedSet = refAllowedSet(card, upCat);

    // keys of pot must be EXACTLY the open categories
    const openSet = new Set(CATS.filter(c => card[c] === null));
    for (const k of Object.keys(pot)) assert.ok(openSet.has(k), `pot has only open cats (${k})`);
    for (const c of openSet) assert.ok(c in pot, `pot offers every open cat (${c})`);

    for (const c of Object.keys(pot)) {
      const expAllowed = allowedSet.has(c);
      assert.equal(pot[c].allowed, expAllowed,
        `joker allow mismatch: face=${face} cat=${c} card=${JSON.stringify(card)}`);
      assert.equal(pot[c].pts, refJokerPts(c, upCat, s),
        `joker pts mismatch: face=${face} cat=${c}`);
    }
    checks++;
  }
  assert.ok(checks === 20000, 'ran all joker cross-check trials');
  done();
}

// ===========================================================================
// J) UPPER BONUS boundary: 63 -> 35, 62 -> 0, 64 -> 35, 0 -> 0
// ===========================================================================
{
  const mk = (assign) => { const p = new PlayerState(); Object.assign(p.card, assign); return p; };
  assert.equal(mk({ ones:3, twos:6, threes:9, fours:12, fives:15, sixes:18 }).upperBonus, 35, '63 -> 35');
  assert.equal(mk({ ones:2, twos:6, threes:9, fours:12, fives:15, sixes:18 }).upperBonus, 0,  '62 -> 0');
  assert.equal(mk({ ones:4, twos:6, threes:9, fours:12, fives:15, sixes:18 }).upperBonus, 35, '64 -> 35');
  assert.equal(mk({ ones:0, twos:0, threes:0, fours:0, fives:0, sixes:0 }).upperBonus, 0, '0 -> 0');
  // exactly 63 with a different composition
  assert.equal(mk({ ones:5, twos:10, threes:15, fours:0, fives:15, sixes:18 }).upperSum, 63, 'alt 63 sum');
  assert.equal(mk({ ones:5, twos:10, threes:15, fours:0, fives:15, sixes:18 }).upperBonus, 35, 'alt 63 -> 35');
  done();
}

// ===========================================================================
// K) TOTAL composition = upperSum + upperBonus + lower + yahtzeeBonus
//    (verified against a hand-summed full card AND via serialize()).
// ===========================================================================
{
  const ps = new PlayerState();
  // upper = 3+6+9+8+15+18 = 59 (< 63 -> NO bonus), lower box values below
  Object.assign(ps.card, {
    ones:3, twos:6, threes:9, fours:8, fives:15, sixes:18,           // upper 59
    threeKind:20, fourKind:24, fullHouse:25, smallStraight:30,
    largeStraight:40, yahtzee:50, chance:17,                          // lower 206
  });
  ps.yahtzeeBonus = 200;                                              // two extra yahtzees
  const upperSum = 59, upperBonus = 0, lower = 206, yBonus = 200;
  assert.equal(ps.upperSum, upperSum, 'upperSum = 59');
  assert.equal(ps.upperBonus, upperBonus, 'no bonus at 59');
  assert.equal(ps.total, upperSum + upperBonus + lower + yBonus, 'total = 465 composition');
  assert.equal(ps.total, 465, 'total literal = 465');
  const v = ps.serialize(false);
  assert.equal(v.total, 465, 'serialize carries composed total');
  assert.equal(v.upperSum, 59, 'serialize upperSum');
  assert.equal(v.yahtzeeBonus, 200, 'serialize yahtzeeBonus');

  // second card: cross the 63 threshold so the +35 enters the composition
  const p2 = new PlayerState();
  Object.assign(p2.card, {
    ones:3, twos:6, threes:9, fours:12, fives:15, sixes:18,          // upper 63 -> +35
    threeKind:0, fourKind:0, fullHouse:0, smallStraight:0,
    largeStraight:0, yahtzee:0, chance:0,                             // lower 0
  });
  assert.equal(p2.total, 63 + 35 + 0 + 0, 'total includes the 63-bonus = 98');
  done();
}

// ===========================================================================
// L) OPENING roll is identical in variant 2 AND variant 3, and comes from
//    shared.first[round]; and is unaffected by mode-1 (independent).
// ===========================================================================
{
  const shared = makeShared();
  const p = new PlayerState();      // round 0
  const r2 = nextDice(p, null, 2, shared);
  const r3 = nextDice(p, null, 3, shared);
  assert.deepEqual(r2.dice, r3.dice, 'variant 2 & 3 share the SAME opening roll');
  assert.deepEqual(r2.dice, shared.first[0], 'opening roll = shared.first[round]');
  assert.deepEqual(r2.mask, [0,1,2,3,4], 'opening mask all five');

  // at a later round the opening still tracks shared.first[round]
  const p5 = new PlayerState(); p5.round = 5;
  assert.deepEqual(nextDice(p5, null, 2, shared).dice, shared.first[5], 'round-5 opening from shared');
  assert.deepEqual(nextDice(p5, null, 3, shared).dice, shared.first[5], 'round-5 v3 opening from shared');
  done();
}

// ===========================================================================
// M) VARIANT 2 rerolls INDEPENDENT vs VARIANT 3 rerolls OVERLAP on min(k1,k2).
//    Built with a deterministic shared (all shared dice = 1) so we can prove
//    variant 2 IGNORES shared while variant 3 CONSUMES it regardless of rng.
// ===========================================================================
{
  const sharedOnes = makeShared(() => 0.0);         // every shared die = 1
  // sanity: shared reroll seq is all 1s
  assert.deepEqual(sharedOnes.rerolls[0][0], [1,1,1,1,1], 'shared reroll seq is all 1s');

  const rngSix = () => 0.99;                          // -> face 6
  const rngTwo = () => 0.25;                          // -> 1+floor(1.5) = 2

  // --- VARIANT 3: rng is IGNORED, values come from shared, overlap on min(k1,k2)
  {
    const a = new PlayerState(); a.dice = [4,4,4,4,4]; a.rollsLeft = 2; a.round = 0;
    const b = new PlayerState(); b.dice = [4,4,4,4,4]; b.rollsLeft = 2; b.round = 0;
    const holdA = [true,true,false,false,false];      // A rerolls 3 (pos 2,3,4)  k1=3
    const holdB = [true,true,true,true,false];        // B rerolls 1 (pos 4)       k2=1
    const ra = nextDice(a, holdA, 3, sharedOnes, rngSix);
    const rb = nextDice(b, holdB, 3, sharedOnes, rngTwo);
    const vA = ra.mask.map(p => ra.dice[p]);
    const vB = rb.mask.map(p => rb.dice[p]);
    assert.deepEqual(vA, [1,1,1], 'v3: A rerolls come from shared (all 1), rng ignored');
    assert.deepEqual(vB, [1],     'v3: B rerolls come from shared (all 1), rng ignored');
    const overlap = Math.min(vA.length, vB.length);
    assert.equal(overlap, 1, 'v3 overlap = min(k1,k2) = 1');
    for (let k = 0; k < overlap; k++) assert.equal(vA[k], vB[k], `v3 leading reroll #${k} matches`);
  }

  // larger overlap k1=4, k2=2 -> first 2 reroll values shared
  {
    const a = new PlayerState(); a.dice = [4,4,4,4,4]; a.rollsLeft = 2; a.round = 0;
    const b = new PlayerState(); b.dice = [4,4,4,4,4]; b.rollsLeft = 2; b.round = 0;
    const ra = nextDice(a, [true,false,false,false,false], 3, sharedOnes, rngSix);  // k1=4
    const rb = nextDice(b, [true,true,true,false,false],   3, sharedOnes, rngTwo);  // k2=2
    const vA = ra.mask.map(p => ra.dice[p]);
    const vB = rb.mask.map(p => rb.dice[p]);
    assert.equal(Math.min(vA.length, vB.length), 2, 'v3 overlap = 2');
    for (let k = 0; k < 2; k++) assert.equal(vA[k], vB[k], `v3 larger-overlap reroll #${k} matches`);
  }

  // --- VARIANT 2: rng is USED, shared is IGNORED -> two players independent
  {
    const a = new PlayerState(); a.dice = [4,4,4,4,4]; a.rollsLeft = 2; a.round = 0;
    const b = new PlayerState(); b.dice = [4,4,4,4,4]; b.rollsLeft = 2; b.round = 0;
    const hold = [true,true,false,false,false];       // both reroll pos 2,3,4
    const ra = nextDice(a, hold, 2, sharedOnes, rngSix);
    const rb = nextDice(b, hold, 2, sharedOnes, rngTwo);
    const vA = ra.mask.map(p => ra.dice[p]);
    const vB = rb.mask.map(p => rb.dice[p]);
    assert.deepEqual(vA, [6,6,6], 'v2: A rerolls from its OWN rng (6), not shared');
    assert.deepEqual(vB, [2,2,2], 'v2: B rerolls from its OWN rng (2), not shared');
    assert.notDeepEqual(vA, vB, 'v2: the two players are INDEPENDENT');
    // and neither took the shared value (1) -> variant 2 does not consume shared.rerolls
    assert.notDeepEqual(vA, [1,1,1], 'v2: A did not read shared.rerolls');
    assert.deepEqual([ra.dice[0], ra.dice[1]], [4,4], 'v2: held dice preserved');
  }
  done();
}

// ===========================================================================
// N) VARIANT 3 reroll INDEXING: roll #2 draws rerolls[round][0],
//    roll #3 draws rerolls[round][1] (adversarial index check across a round).
// ===========================================================================
{
  const shared = makeShared();
  const p = new PlayerState();                        // round 0
  p.applyRoll(nextDice(p, null, 3, shared).dice);     // roll #1 (opening), rollsLeft 3->2

  // roll #2: reroll positions 2,3,4 -> must equal shared.rerolls[0][0][0..2]
  const seq2 = shared.rerolls[0][0];
  const r2 = nextDice(p, [true,true,false,false,false], 3, shared);
  assert.deepEqual(r2.mask, [2,3,4], 'roll#2 mask');
  assert.deepEqual([r2.dice[2], r2.dice[3], r2.dice[4]], [seq2[0], seq2[1], seq2[2]], 'roll#2 uses rerolls[r][0]');
  p.applyRoll(r2.dice);                                // rollsLeft 2 -> 1

  // roll #3: reroll positions 3,4 -> must equal shared.rerolls[0][1][0..1]
  const seq3 = shared.rerolls[0][1];
  const r3 = nextDice(p, [true,true,true,false,false], 3, shared);
  assert.deepEqual(r3.mask, [3,4], 'roll#3 mask');
  assert.deepEqual([r3.dice[3], r3.dice[4]], [seq3[0], seq3[1]], 'roll#3 uses rerolls[r][1]');
  done();
}

// ===========================================================================
// O) nextDice never MUTATES the caller's ps.dice; held dice always preserved.
// ===========================================================================
{
  const shared = makeShared();
  const ps = new PlayerState();
  ps.dice = [1,2,3,4,5];
  ps.rollsLeft = 2;
  ps.round = 0;
  const before = ps.dice.slice();
  const r = nextDice(ps, [true,false,true,false,true], 2, shared);
  assert.deepEqual(ps.dice, before, 'nextDice did not mutate ps.dice');
  assert.equal(r.dice[0], 1, 'held pos 0 preserved');
  assert.equal(r.dice[2], 3, 'held pos 2 preserved');
  assert.equal(r.dice[4], 5, 'held pos 4 preserved');
  assert.deepEqual(r.mask, [1,3], 'mask = rerolled positions');
  done();
}

// ===========================================================================
// P) scoreCategory legality guards: null dice, already-filled box, and that
//    a returned 0 is distinguishable from an illegal null.
// ===========================================================================
{
  const ps = new PlayerState();
  assert.equal(ps.scoreCategory('chance'), null, 'no dice -> null');
  ps.applyRoll([1,1,1,2,3]);
  assert.equal(ps.scoreCategory('sixes'), 0, 'legal zero returns 0 (not null)');
  assert.equal(ps.card.sixes, 0, 'zero written');
  // now sixes is filled; scoring it again is illegal
  ps.applyRoll([6,6,6,6,1]);
  assert.equal(ps.scoreCategory('sixes'), null, 'already-filled box -> null');
  assert.equal(ps.round, 1, 'round only advanced once (the legal score)');
  done();
}

console.log(`OK — all ${groups} adversarial edge-case groups passed.`);
