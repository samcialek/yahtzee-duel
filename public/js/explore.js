// public/js/explore.js — Strategy Explorer (SOLVER.md §5)
//
// Loads the solved value table (strategy.bin + strategy-meta.json) once, then
// answers every control change with a live query against solver/policy.js.
// The solver modules are served read-only under /solver/ (see server.js), so
// this page imports the SAME files Node uses — one source of truth.
//
// Controls → state:
//   #cat-<cat> (13 toggles)  → state.mask   (bit i per tables.js CAT_ORDER)
//   #input-up                → state.up     (clamped to states.js upListOf(mask))
//   #toggle-yz               → state.yz     (enabled only when yahtzee filled)
//   #pick-0 … #pick-4        → state.dice   (0 = blank/not rolled, else 1..6)
//   #rolls-2/1/0             → state.rolls
// Outputs: #state-ev (V of the widget), #best-line (verdict), #keeps-list
// (top 10 + keep-all + reroll-all, best in vermillion), #cats-list (pts +
// resulting EV, joker-blocked rows dimmed).

import { Policy } from '/solver/policy.js';
import { upListOf } from '/solver/states.js';
import { CAT_ORDER } from '/solver/tables.js';

const FULL_MASK = 0x1fff;
const YZ_BIT = 1 << 11;

const CAT_LABELS = {
  ones: 'Aces',
  twos: 'Twos',
  threes: 'Threes',
  fours: 'Fours',
  fives: 'Fives',
  sixes: 'Sixes',
  threeKind: 'Three of a Kind',
  fourKind: 'Four of a Kind',
  fullHouse: 'Full House',
  smallStraight: 'Small Straight',
  largeStraight: 'Large Straight',
  yahtzee: 'Yahtzee',
  chance: 'Chance',
};

const $ = (id) => document.getElementById(id);
const fmt = (v) => v.toFixed(2);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function popcount(x) {
  let c = 0;
  while (x !== 0) { x &= x - 1; c++; }
  return c;
}

/** Nearest value in an ascending list (ties resolve to the lower value). */
function nearestUp(list, want) {
  let best = list[0];
  for (const v of list) {
    if (Math.abs(v - want) < Math.abs(best - want)) best = v;
  }
  return best;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mask: 0,                 // 13-bit filled-categories mask
  up: 0,                   // upper subtotal, always reachable for mask
  yz: 0,                   // 1 ⇔ yahtzee box holds 50
  dice: [0, 0, 0, 0, 0],   // 0 = blank
  rolls: 2,                // rerolls remaining
  upNote: '',              // transient clamp message under the upper input
};

/** @type {Policy|null} */
let policy = null;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderControls() {
  for (let c = 0; c < CAT_ORDER.length; c++) {
    const btn = $('cat-' + CAT_ORDER[c]);
    const filled = ((state.mask >> c) & 1) === 1;
    btn.classList.toggle('is-filled', filled);
    btn.setAttribute('aria-pressed', String(filled));
  }

  const upInput = $('input-up');
  const noUpper = (state.mask & 63) === 0;
  upInput.disabled = noUpper;
  if (document.activeElement !== upInput) upInput.value = String(state.up);
  $('up-note').textContent = noUpper
    ? 'No upper boxes filled — subtotal is fixed at 0.'
    : state.upNote;

  const yzBtn = $('toggle-yz');
  const yzAllowed = (state.mask & YZ_BIT) !== 0;
  yzBtn.disabled = !yzAllowed;
  yzBtn.classList.toggle('is-on', state.yz === 1);
  yzBtn.setAttribute('aria-pressed', String(state.yz === 1));

  for (let i = 0; i < 5; i++) {
    $('pick-' + i).dataset.v = String(state.dice[i]);
  }

  for (const n of [0, 1, 2]) {
    $('rolls-' + n).classList.toggle('is-selected', state.rolls === n);
  }
}

function keepRow(entry, rank, isBest, bestEv) {
  const row = el('div', 'exp-row' + (isBest ? ' is-best' : ''));
  row.appendChild(el('span', 'exp-rank', String(rank).padStart(2, '0')));
  const keep = el('span', 'exp-keep');
  const n = entry.faces.length;
  if (n === 0) {
    keep.appendChild(el('em', 'exp-tag', 'reroll all five'));
  } else {
    for (const f of entry.faces) keep.appendChild(el('span', 'kd', String(f)));
    keep.appendChild(el('em', 'exp-tag', n === 5 ? 'keep all' : `reroll ${5 - n}`));
  }
  row.appendChild(keep);
  row.appendChild(el('span', 'exp-delta', isBest ? '' : '−' + fmt(bestEv - entry.ev)));
  row.appendChild(el('span', 'exp-ev', fmt(entry.ev)));
  return row;
}

function renderKeeps(res) {
  const list = $('keeps-list');
  const note = $('keeps-note');
  const meta = $('keeps-meta');
  list.textContent = '';
  meta.textContent = `rolls left ${state.rolls}`;

  if (state.rolls === 0) {
    note.textContent = 'No rerolls left — choose a category below.';
    return;
  }
  const keeps = res.keeps;
  const bestEv = keeps[0].ev;
  meta.textContent = `rolls left ${state.rolls} · ${keeps.length} distinct`;
  note.textContent = 'EV of holding those dice and rerolling the rest.';

  // Top 10, then always keep-all and reroll-all (with their true ranks).
  const shown = [];
  const topN = Math.min(10, keeps.length);
  for (let i = 0; i < topN; i++) shown.push(i);
  for (let i = topN; i < keeps.length; i++) {
    const n = keeps[i].faces.length;
    if (n === 5 || n === 0) shown.push(i);
  }

  let prev = -1;
  for (const i of shown) {
    if (i > prev + 1) list.appendChild(el('div', 'exp-gap', '···'));
    list.appendChild(keepRow(keeps[i], i + 1, i === 0, bestEv));
    prev = i;
  }
}

function renderCats(res) {
  const list = $('cats-list');
  const note = $('cats-note');
  const meta = $('cats-meta');
  list.textContent = '';

  const cats = res.categories;
  const blocked = cats.filter((c) => !c.legal).length;
  meta.textContent = `${cats.length} open` + (blocked ? ` · ${blocked} joker-blocked` : '');
  note.textContent = 'EV = points scored now + value of the resulting state.';

  const bestIsScore = res.best.type === 'score';
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    const isBest = bestIsScore && c.legal && c.cat === res.best.cat;
    const row = el('div',
      'exp-row' + (c.legal ? '' : ' is-illegal') + (isBest ? ' is-best' : ''));
    if (!c.legal) row.title = 'Joker rules forbid scoring this box with these dice.';
    row.appendChild(el('span', 'exp-rank', String(i + 1).padStart(2, '0')));
    row.appendChild(el('span', 'exp-cat-name', CAT_LABELS[c.cat]));
    row.appendChild(el('span', 'exp-pts', `${c.pts} pts`));
    row.appendChild(el('span', 'exp-ev', fmt(c.ev)));
    list.appendChild(row);
  }
}

function renderBestLine(res) {
  const line = $('best-line');
  const best = res.best;
  let text;
  if (best.type === 'score') {
    text = `Score ${CAT_LABELS[best.cat]} — ${best.pts} pts · EV ${fmt(best.ev)}`;
  } else if (best.faces.length === 0) {
    text = `Reroll all five · EV ${fmt(best.ev)}`;
  } else if (best.faces.length === 5) {
    text = `Stand pat — keep all five · EV ${fmt(best.ev)}`;
  } else {
    text = `Keep ${best.faces.join(' ')} · EV ${fmt(best.ev)}`;
  }
  line.textContent = text;
  line.hidden = false;
}

function renderAnalysis() {
  const { mask, up, yz, dice, rolls } = state;
  const full = mask === FULL_MASK;

  $('state-ev').textContent = fmt(policy.stateEV(mask, up, yz));
  const open = 13 - popcount(mask);
  $('state-ev-sub').textContent = full
    ? 'All thirteen boxes are filled — game over'
    : `Expected points to come · ${open} ${open === 1 ? 'box' : 'boxes'} open`;

  const bestLine = $('best-line');
  $('keeps-list').textContent = '';
  $('cats-list').textContent = '';
  $('keeps-meta').textContent = '';
  $('cats-meta').textContent = '';

  if (full) {
    bestLine.hidden = true;
    $('keeps-note').textContent = 'Nothing left to roll for.';
    $('cats-note').textContent = 'Nothing left to score.';
    return;
  }
  if (!dice.every((v) => v >= 1)) {
    bestLine.hidden = true;
    const hint = 'Set all five dice to rank the options.';
    $('keeps-note').textContent = hint;
    $('cats-note').textContent = hint;
    $('keeps-meta').textContent = `rolls left ${rolls}`;
    return;
  }

  const res = policy.evalTurn(mask, up, yz, dice.slice(), rolls);
  renderBestLine(res);
  renderKeeps(res);
  renderCats(res);
}

function renderAll() {
  renderControls();
  if (policy) renderAnalysis();
}

// ---------------------------------------------------------------------------
// Control events
// ---------------------------------------------------------------------------

/** Re-clamp `up` to the reachable set after any mask change. */
function reclampUp() {
  const list = upListOf(state.mask);
  if (!list.includes(state.up)) {
    const snapped = nearestUp(list, state.up);
    state.upNote = `${state.up} is not reachable with these boxes — snapped to ${snapped}.`;
    state.up = snapped;
  }
}

function bindControls() {
  for (let c = 0; c < CAT_ORDER.length; c++) {
    const bit = 1 << c;
    $('cat-' + CAT_ORDER[c]).addEventListener('click', () => {
      state.mask ^= bit;
      if ((state.mask & YZ_BIT) === 0) state.yz = 0;
      reclampUp();
      renderAll();
    });
  }

  const upInput = $('input-up');
  const commitUp = (fromChange) => {
    const raw = parseInt(upInput.value, 10);
    if (Number.isNaN(raw)) {
      if (fromChange) renderAll(); // restore the last good value
      return;
    }
    const want = Math.max(0, Math.min(63, raw));
    const list = upListOf(state.mask);
    if (list.includes(want)) {
      state.up = want;
      state.upNote = '';
      renderAll();
    } else if (fromChange) {
      const snapped = nearestUp(list, want);
      state.upNote = `${want} is not reachable with these boxes — snapped to ${snapped}.`;
      state.up = snapped;
      renderAll();
      // renderAll skips the write while the input has focus — show the snap anyway.
      upInput.value = String(snapped);
    }
  };
  upInput.addEventListener('input', () => commitUp(false));
  upInput.addEventListener('change', () => commitUp(true));

  $('toggle-yz').addEventListener('click', () => {
    if ((state.mask & YZ_BIT) === 0) return;
    state.yz = state.yz === 1 ? 0 : 1;
    renderAll();
  });

  for (let i = 0; i < 5; i++) {
    $('pick-' + i).addEventListener('click', () => {
      state.dice[i] = (state.dice[i] + 1) % 7; // 1..6 then blank
      renderAll();
    });
  }
  $('btn-clear-dice').addEventListener('click', () => {
    state.dice = [0, 0, 0, 0, 0];
    renderAll();
  });

  for (const n of [0, 1, 2]) {
    $('rolls-' + n).addEventListener('click', () => {
      state.rolls = n;
      renderAll();
    });
  }
}

// ---------------------------------------------------------------------------
// Table load
// ---------------------------------------------------------------------------

async function loadTable() {
  const [binRes, metaRes] = await Promise.all([
    fetch('strategy.bin'),
    fetch('strategy-meta.json'),
  ]);
  if (!binRes.ok) throw new Error(`strategy.bin → HTTP ${binRes.status}`);
  if (!metaRes.ok) throw new Error(`strategy-meta.json → HTTP ${metaRes.status}`);
  const [buffer, meta] = await Promise.all([binRes.arrayBuffer(), metaRes.json()]);
  return new Policy(buffer, meta);
}

async function init() {
  bindControls();
  renderControls();
  try {
    policy = await loadTable();
  } catch (err) {
    $('loading').hidden = true;
    const box = $('load-error');
    box.textContent = 'Could not load the strategy table ('
      + (err && err.message ? err.message : String(err))
      + '). Generate it with "node solver/solve.js", then reload this page.';
    box.hidden = false;
    return;
  }
  const meta = policy.meta;
  $('table-note').textContent =
    `table v${meta.version} · ${meta.widgetCount.toLocaleString('en-US')} states`
    + ` · start EV ${meta.startEV.toFixed(2)}`;
  $('loading').hidden = true;
  $('explorer-main').hidden = false;
  renderAll();
}

init();
