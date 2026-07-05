// public/js/app.js
// Screen router + renderer + input wiring (ARCHITECTURE.md §5 view-model, §8 UI).
//
// This module is a DUMB renderer: it owns no game state beyond pure client-side UI
// (the held-dice mask, the last-animated seq, and the currently-shown view). Both
// engines (LocalEngine for AI, RemoteEngine for live rooms) expose the identical
// interface and push a complete personalized view-model via onState(view); render()
// is a single pure function of that view.
//
// It binds only to the stable ids documented in index.html's DOM CONTRACT.

import { potentials, CATS } from '../shared/game.js';
import { LocalEngine } from './engine.js';
import { RemoteEngine } from './net.js';
import { recordDecision, analyze, renderAnalysis, replayOptimal } from './analysis.js';
import { init as initUncertainty } from './uncertainty-ui.js';

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

// Screens + overlay + toast
const screenHome = $('screen-home');
const screenLobby = $('screen-lobby');
const screenGame = $('screen-game');
const overlayEnd = $('overlay-end');
const toastEl = $('error-toast');
const toastMsg = $('error-toast-msg');

const SCREENS = { home: screenHome, lobby: screenLobby, game: screenGame };

// Home
const oppMachine = $('opp-machine');
const oppFriend = $('opp-friend');
const aiStrength = $('ai-strength');
const aiStandard = $('ai-standard');
const aiPerfect = $('ai-perfect');
const variantGroup = $('variant-group');
const variantCards = [$('variant-1'), $('variant-2'), $('variant-3')];
const variantHostNote = $('variant-host-note');
const inputName = $('input-name');
const actionsMachine = $('actions-machine');
const actionsFriend = $('actions-friend');
const btnStart = $('btn-start');
const btnCreate = $('btn-create');
const inputCode = $('input-code');
const btnJoin = $('btn-join');

// Lobby
const lobbyCode = $('lobby-code');
const btnCancel = $('btn-cancel');

// Game — header
const variantChip = $('variant-chip');
const roundIndicator = $('round-indicator');
const btnLeave = $('btn-leave');

// Game — scorecards
const scorecardYou = $('scorecard-you');
const scorecardOpp = $('scorecard-opp');
const youName = $('you-name');
const youDot = $('you-dot');
const youProgress = $('you-progress');
const oppName = $('opp-name');
const oppDot = $('opp-dot');
const oppProgress = $('opp-progress');

// Game — center
const statusLine = $('status-line');
const diceTray = $('dice-tray');
const dieEls = [0, 1, 2, 3, 4].map((i) => $(`die-${i}`));
const diceLabel = $('dice-label');
const btnRoll = $('btn-roll');
const rollDots = [0, 1, 2].map((i) => $(`roll-dot-${i}`));
const subStatus = $('sub-status');

// End overlay
const endVerdict = $('end-verdict');
const endYouName = $('end-you-name');
const endYouTotal = $('end-you-total');
const endOppName = $('end-opp-name');
const endOppTotal = $('end-opp-total');
const btnRematch = $('btn-rematch');
const btnNewgame = $('btn-newgame');
const endRematchNote = $('end-rematch-note');
const btnAnalysis = $('btn-analysis');

// Analysis overlay
const overlayAnalysis = $('overlay-analysis');
const analysisContent = $('analysis-content');
const btnAnalysisBack = $('btn-analysis-back');

const VARIANT_NAMES = { 1: 'Classic', 2: 'Shared Start', 3: 'Linked Dice' };
const LOBBY_PLACEHOLDER = '————';

// ---------------------------------------------------------------------------
// Module state — pure client-side UI, never authoritative
// ---------------------------------------------------------------------------

let engine = null;                // the active LocalEngine | RemoteEngine
let opponentType = 'machine';     // 'machine' | 'friend'
let aiType = 'standard';          // 'standard' | 'perfect' (Machine strength)
let optimalAI = null;             // loaded Perfect AI, cached across games
let startingAI = false;           // guards Start against double-clicks mid-load
let selectedMode = 1;             // 1 | 2 | 3
let isMultiplayer = false;        // true when driven by a RemoteEngine
let held = [false, false, false, false, false]; // client-side keep mask
let lastSeq = 0;                  // last seq we animated a tumble for
let currentView = null;           // most recent view-model (for click handlers)
let currentScreen = 'home';
let toastTimer = null;

// Post-game decision analysis (ANALYSIS.md) — the HUMAN player's move log,
// recorded at dispatch time; reset on new game / rematch / leaving.
let moveLog = [];
let analysisReport = null;        // cached analyze() result for the ended game
let analysisBusy = false;         // guards the lazy table fetch against re-clicks
let analysisGen = 0;              // bumped by resetAnalysis(); invalidates in-flight analyses

// ---------------------------------------------------------------------------
// Screen switching + toast
// ---------------------------------------------------------------------------

function showScreen(name) {
  for (const key in SCREENS) {
    SCREENS[key].classList.toggle('is-active', key === name);
  }
  currentScreen = name;
  if (name !== 'game') {
    overlayEnd.classList.remove('is-active');
    overlayAnalysis.classList.remove('is-active');
  }
}

function toast(msg) {
  toastMsg.textContent = msg || 'Something went wrong.';
  toastEl.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 3600);
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

function cleanupEngine() {
  if (engine) {
    engine.destroy();
    engine = null;
  }
}

function resetGameUI() {
  held = [false, false, false, false, false];
  lastSeq = 0;
  currentView = null;
  resetAnalysis();
}

function resetAnalysis() {
  moveLog = [];
  analysisReport = null;
  analysisGen++;   // discard any analysis still awaiting the strategy-table fetch
  overlayAnalysis.classList.remove('is-active');
}

function returnHome() {
  cleanupEngine();
  isMultiplayer = false;
  resetGameUI();
  overlayEnd.classList.remove('is-active');
  lobbyCode.textContent = LOBBY_PLACEHOLDER;
  showScreen('home');
}

function playerName() {
  return (inputName.value || '').trim() || 'You';
}

// ---------------------------------------------------------------------------
// Home wiring
// ---------------------------------------------------------------------------

function setOpponent(type) {
  opponentType = type;
  oppMachine.classList.toggle('is-selected', type === 'machine');
  oppFriend.classList.toggle('is-selected', type === 'friend');
  aiStrength.hidden = type !== 'machine';
  actionsMachine.hidden = type !== 'machine';
  actionsFriend.hidden = type !== 'friend';
  updateVariantLock();
}

function setAiType(type) {
  aiType = type;
  aiStandard.classList.toggle('is-selected', type === 'standard');
  aiPerfect.classList.toggle('is-selected', type === 'perfect');
}

function setVariant(mode) {
  if (variantGroup.classList.contains('is-locked')) return;
  selectedMode = mode;
  variantCards.forEach((card) => {
    card.classList.toggle('is-selected', Number(card.dataset.mode) === mode);
  });
}

// The variant is "set by host" only when the player is committing to JOIN an
// existing room — detected by a non-empty room-code field while Friend is chosen.
// Creating a room keeps the variant selectable.
function updateVariantLock() {
  const joining = opponentType === 'friend' && inputCode.value.trim().length > 0;
  variantGroup.classList.toggle('is-locked', joining);
  variantHostNote.hidden = !joining;
}

async function startAI() {
  if (startingAI) return;                 // Perfect table already loading — ignore re-clicks
  let ai = null;                          // null → LocalEngine's heuristic default

  if (aiType === 'perfect') {
    startingAI = true;
    const label = btnStart.textContent;
    btnStart.disabled = true;
    btnStart.classList.add('is-loading');
    btnStart.textContent = 'Loading strategy…';
    try {
      if (!optimalAI) {
        // Lazy module load: solver code + the few-MB table are only fetched
        // the first time a Perfect game starts; cached for later games.
        const mod = await import('./ai-optimal.js');
        optimalAI = await mod.loadOptimalAI('');
      }
      ai = optimalAI;
    } catch (err) {
      optimalAI = null;
      toast('Couldn’t load the perfect strategy — starting with Standard.');
    }
    btnStart.textContent = label;
    btnStart.classList.remove('is-loading');
    btnStart.disabled = false;
    startingAI = false;
  }

  cleanupEngine();
  resetGameUI();
  isMultiplayer = false;
  engine = new LocalEngine({
    mode: selectedMode,
    youName: playerName(),
    aiName: 'Machine',
    ai: ai || undefined,                  // undefined → heuristic ai.js default
    onState: handleState,
  });
  // LocalEngine pushes its opening state asynchronously; handleState switches screens.
}

function createRoom() {
  cleanupEngine();
  resetGameUI();
  isMultiplayer = true;
  const name = playerName();
  engine = new RemoteEngine({
    onState: handleState,
    onCreated: (code) => { lobbyCode.textContent = code; },
    onError: onNetError,
    onOppLeft: onOppLeft,
    onClose: onNetClose,
  });
  engine.create(name, selectedMode);
  lobbyCode.textContent = LOBBY_PLACEHOLDER;
  showScreen('lobby');
}

function joinRoom() {
  const code = inputCode.value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Enter the four-letter room code.');
    return;
  }
  cleanupEngine();
  resetGameUI();
  isMultiplayer = true;
  const name = playerName();
  engine = new RemoteEngine({
    onState: handleState,
    onCreated: (c) => { lobbyCode.textContent = c; },
    onError: onNetError,
    onOppLeft: onOppLeft,
    onClose: onNetClose,
  });
  engine.join(name, code);
  // The server replies with the first {t:'state'} once both players are present,
  // which flips us onto the game screen. Stay on Home until then.
}

// ---------------------------------------------------------------------------
// Remote engine event handlers
// ---------------------------------------------------------------------------

function onNetError(msg) {
  toast(msg || 'Connection error.');
  // Handshake / lobby failure (bad code, room full, unreachable) — bail home.
  if (currentScreen !== 'game') returnHome();
}

function onNetClose() {
  // Unexpected socket close while still engaged. (oppLeft handles its own case
  // first and detaches this handler via destroy(), so this won't double-fire.)
  if (currentScreen === 'game' || currentScreen === 'lobby') {
    toast('Connection lost.');
    returnHome();
  }
}

function onOppLeft() {
  toast('Your opponent left the game.');
  returnHome();
}

// ---------------------------------------------------------------------------
// State intake — reset holds on a new round, then render
// ---------------------------------------------------------------------------

function handleState(view) {
  if (!view || view.t !== 'state') return;
  const prevPhase = currentView ? currentView.phase : null;
  currentView = view;
  // Rematch restart (both engines): end → play flips mean a fresh game — clear
  // the decision log and any cached report from the finished one.
  if (prevPhase === 'end' && view.phase === 'play') {
    resetAnalysis();
  }
  // New round: a fresh state with no rolled dice for you clears the client keep mask.
  if (view.you && view.you.dice === null) {
    held = [false, false, false, false, false];
  }
  showScreen('game');
  render(view);
}

// ---------------------------------------------------------------------------
// The single pure renderer — handles EVERY view-model field (§5)
// ---------------------------------------------------------------------------

function roundLabel(p) {
  return `${Math.min(p.round + 1, 13)}/13`;
}

function render(view) {
  const mode = view.mode;
  const you = view.you;
  const opp = view.opp;
  const showOpp = mode === 1 && view.turn === 'opp'; // center tray shows opp in variant 1
  const center = showOpp ? opp : you;

  // -- Header -------------------------------------------------------------
  variantChip.textContent = VARIANT_NAMES[mode] || 'Classic';
  roundIndicator.textContent = `Round ${Math.min(you.round + 1, 13)} / 13`;

  // -- Names, active dot, per-player progress -----------------------------
  youName.textContent = view.youName;
  oppName.textContent = view.oppName;

  youDot.classList.toggle('is-active', mode === 1 && view.turn === 'you');
  oppDot.classList.toggle('is-active', mode === 1 && view.turn === 'opp');

  if (mode === 1) {
    youProgress.textContent = '';
    oppProgress.textContent = '';
  } else {
    youProgress.textContent = roundLabel(you);
    oppProgress.textContent = roundLabel(opp);
  }

  // -- Scorecards ---------------------------------------------------------
  renderScorecard(scorecardYou, you, true);
  renderScorecard(scorecardOpp, opp, false);

  // -- Dice + rolls-left + labels ----------------------------------------
  renderDice(view);

  const spent = 3 - center.rollsLeft;           // 0..3 rolls consumed this round
  rollDots.forEach((dot, i) => dot.classList.toggle('is-spent', i < spent));

  // -- Roll button: enabled only when it's your move -----------------------
  const yourTurn = mode === 1 ? view.turn === 'you' : true;
  const canRoll = view.phase === 'play' && yourTurn && !you.done && you.rollsLeft > 0;
  btnRoll.disabled = !canRoll;

  // -- Status + sub-status -----------------------------------------------
  statusLine.textContent = mainStatus(view, showOpp);
  subStatus.textContent = subStatusText(view, showOpp);

  // -- Tumble animation: only when seq advances --------------------------
  if (view.seq !== lastSeq) {
    lastSeq = view.seq;
    if (view.lastRoll && Array.isArray(view.lastRoll.mask)) {
      tumbleDice(view.lastRoll.mask);
    }
  }

  // -- End overlay --------------------------------------------------------
  if (view.phase === 'end') {
    renderEnd(view);
    // While the analysis panel is open, keep the end overlay swapped out
    // (state re-pushes, e.g. multiplayer rematch votes, land here too).
    if (!overlayAnalysis.classList.contains('is-active')) {
      overlayEnd.classList.add('is-active');
    }
  } else {
    overlayEnd.classList.remove('is-active');
    overlayAnalysis.classList.remove('is-active');
  }
}

function renderScorecard(root, p, isYou) {
  const card = p.card;
  // Potentials (candidate scores + joker legality) only make sense for your own
  // rolled dice; the opponent's card renders filled boxes only.
  const pots = isYou && p.dice ? potentials(card, p.dice) : null;

  for (const cat of CATS) {
    const row = root.querySelector(`.sc-row[data-cat="${cat}"]`);
    if (!row) continue;
    const valEl = row.querySelector('.sc-value');
    row.classList.remove('sc-row--open', 'sc-row--disallowed', 'sc-row--filled');

    const filled = card[cat];
    if (filled !== null && filled !== undefined) {
      valEl.textContent = String(filled);
      row.classList.add('sc-row--filled');
    } else if (pots && pots[cat]) {
      valEl.textContent = String(pots[cat].pts);
      row.classList.add(pots[cat].allowed ? 'sc-row--open' : 'sc-row--disallowed');
    } else {
      valEl.textContent = '';
    }
  }

  setDerived(root, 'upper-sum', p.upperSum);
  setDerived(root, 'upper-bonus', p.upperBonus);
  setDerived(root, 'yahtzee-bonus', p.yahtzeeBonus);
  setDerived(root, 'total', p.total);
}

function setDerived(root, key, value) {
  const el = root.querySelector(`.sc-row[data-row="${key}"] .sc-value`);
  if (el) el.textContent = String(value);
}

function renderDice(view) {
  const showOpp = view.mode === 1 && view.turn === 'opp';
  const center = showOpp ? view.opp : view.you;
  const dice = center ? center.dice : null;
  const holdMask = showOpp ? view.oppHold : held;

  for (let i = 0; i < 5; i++) {
    const el = dieEls[i];
    const v = dice && dice[i] != null ? dice[i] : 0;
    el.dataset.v = String(v);
    const empty = v === 0;
    el.classList.toggle('is-empty', empty);
    el.classList.toggle('held', !empty && !!(holdMask && holdMask[i]));
  }

  if (view.mode === 1) {
    diceLabel.hidden = false;
    diceLabel.textContent = showOpp ? `${view.oppName}'s dice` : 'Your dice';
  } else {
    diceLabel.hidden = true;
    diceLabel.textContent = '';
  }
}

function tumbleDice(mask) {
  mask.forEach((idx, k) => {
    const el = dieEls[idx];
    if (!el) return;
    el.classList.remove('tumbling');
    el.style.animationDelay = '';
    // Force reflow so re-adding the class restarts the keyframes cleanly.
    void el.offsetWidth;
    el.style.animationDelay = `${k * 55}ms`;
    el.classList.add('tumbling');
    // Fallback: prefers-reduced-motion disables the animation, so animationend
    // never fires — clear the transient class after a beat regardless.
    setTimeout(() => {
      el.classList.remove('tumbling');
      el.style.animationDelay = '';
    }, 700 + k * 55);
  });
}

function mainStatus(view, showOpp) {
  if (view.phase === 'end') return 'Game over.';
  if (showOpp) {
    return isMultiplayer ? `${view.oppName}'s turn.` : `${view.oppName} is thinking…`;
  }
  const you = view.you;
  if (you.done) return "You're done — waiting for your opponent.";
  if (you.rollsLeft === 3) return view.mode === 1 ? 'Your turn — roll.' : 'Roll to begin the round.';
  if (you.rollsLeft === 0) return 'Choose a category.';
  return 'Hold, reroll — or score.';
}

function subStatusText(view, showOpp) {
  if (view.phase === 'end' || showOpp) return '';
  const you = view.you;
  if (you.done) return '';
  if (view.mode >= 2 && you.rollsLeft === 3) return 'Shared opening';
  if (view.mode === 3 && you.rollsLeft > 0 && you.rollsLeft < 3) return 'Linked reroll';
  return '';
}

function renderEnd(view) {
  const result = view.result || { you: view.you.total, opp: view.opp.total };
  let verdict;
  if (result.you > result.opp) verdict = 'You win.';
  else if (result.you < result.opp) verdict = 'You lose.';
  else verdict = 'Dead heat.';
  endVerdict.textContent = verdict;

  endYouName.textContent = view.youName;
  endOppName.textContent = view.oppName;
  endYouTotal.textContent = String(result.you);
  endOppTotal.textContent = String(result.opp);

  // Multiplayer rematch: after you vote and the opponent hasn't, show the waiting
  // note and lock the button until the server restarts (both votes) or you leave.
  const waiting = isMultiplayer && view.rematch && view.rematch.you && !view.rematch.opp;
  endRematchNote.hidden = !waiting;
  btnRematch.disabled = !!waiting;
}

// ---------------------------------------------------------------------------
// Game input — dice holds, roll, score
// ---------------------------------------------------------------------------

function canControl(view) {
  if (!view || view.phase !== 'play') return false;
  if (view.mode === 1 && view.turn !== 'you') return false; // opp's turn in variant 1
  if (view.you.done) return false;
  return true;
}

function toggleHold(i) {
  const view = currentView;
  if (!canControl(view)) return;
  if (view.you.dice === null) return;   // nothing rolled yet
  if (view.you.rollsLeft <= 0) return;  // no reroll left — holds are moot
  held[i] = !held[i];
  renderDice(view);                     // instant local feedback, no state push
  // Variant 1 relays keeps so the spectating opponent sees them live.
  if (view.mode === 1 && engine) engine.holdUpdate(held.slice());
}

function doRoll() {
  const view = currentView;
  if (!canControl(view)) return;
  if (view.you.rollsLeft <= 0) return;
  // Record the reroll decision (the kept multiset) — but NOT the forced first
  // roll of a round, where dice === null and no alternative existed.
  if (view.you.dice !== null) {
    recordDecision(moveLog, view, {
      type: 'keep',
      faces: view.you.dice.filter((_, i) => held[i]),
    });
  }
  if (engine) engine.roll(held.slice());
}

function doScore(cat) {
  const view = currentView;
  if (!canControl(view)) return;
  if (view.you.dice === null) return;
  recordDecision(moveLog, view, { type: 'score', cat });
  if (engine) engine.score(cat);
}

// ---------------------------------------------------------------------------
// Post-game analysis panel (ANALYSIS.md §3) — overlay-swap from the end card
// ---------------------------------------------------------------------------

function analysisStatus(msg) {
  analysisContent.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'an-status';
  p.textContent = msg;
  analysisContent.appendChild(p);
}

function analysisRenderOpts() {
  const view = currentView;
  const yourScore = view
    ? (view.result ? view.result.you : view.you.total)
    : null;
  // Closing line = the SAME-LUCK perfect score on the player's own dice. Both
  // engines expose luckContext() ({ shared, luck, mode }); the replay reproduces
  // the human's exact dice under optimal decisions. Null (→ line omitted) until
  // the strategy table is loaded and the finished game's luck context is present.
  let perfectScore = null;
  if (optimalAI && engine && typeof engine.luckContext === 'function') {
    try {
      perfectScore = replayOptimal(engine.luckContext(), optimalAI.policy);
    } catch {
      perfectScore = null;
    }
  }
  return { perfectScore, yourScore };
}

async function openAnalysis() {
  if (!currentView || currentView.phase !== 'end') return;
  overlayEnd.classList.remove('is-active');
  overlayAnalysis.classList.add('is-active');

  if (analysisReport) {
    renderAnalysis(analysisReport, analysisContent, analysisRenderOpts());
    return;
  }
  if (analysisBusy) return;
  analysisBusy = true;
  const gen = analysisGen;   // if a rematch resets the log mid-fetch, gen goes stale
  analysisStatus('Consulting the strategy table…');
  try {
    if (!optimalAI) {
      // Same lazy path as a Perfect game: module + few-MB table fetched once,
      // then shared — a Perfect AI started later reuses this instance too.
      const mod = await import('./ai-optimal.js');
      optimalAI = await mod.loadOptimalAI('');
    }
    // A new game started while the table was loading: this run belongs to the
    // finished game, whose log is gone — don't analyze/cache the new game's log.
    if (gen !== analysisGen) return;
    analysisReport = analyze(moveLog, optimalAI.policy);
    renderAnalysis(analysisReport, analysisContent, analysisRenderOpts());
  } catch (err) {
    if (gen === analysisGen) {
      analysisStatus('The analysis couldn’t be prepared — check your connection and try again.');
    }
  } finally {
    analysisBusy = false;
  }
}

function closeAnalysis() {
  overlayAnalysis.classList.remove('is-active');
  if (currentView && currentView.phase === 'end') {
    overlayEnd.classList.add('is-active');
  }
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

// Home — opponent toggle
oppMachine.addEventListener('click', () => setOpponent('machine'));
oppFriend.addEventListener('click', () => setOpponent('friend'));

// Home — Machine strength sub-toggle
aiStandard.addEventListener('click', () => setAiType('standard'));
aiPerfect.addEventListener('click', () => setAiType('perfect'));

// Home — variant cards
variantCards.forEach((card) => {
  card.addEventListener('click', () => setVariant(Number(card.dataset.mode)));
});

// Home — room-code input: auto-uppercase, strip non-letters, refresh lock state
inputCode.addEventListener('input', () => {
  const cleaned = inputCode.value.toUpperCase().replace(/[^A-Z]/g, '');
  if (inputCode.value !== cleaned) inputCode.value = cleaned;
  updateVariantLock();
});
inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); joinRoom(); }
});
inputName.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (opponentType === 'machine') startAI();
  else createRoom();
});

// Home — actions
btnStart.addEventListener('click', startAI);
btnCreate.addEventListener('click', createRoom);
btnJoin.addEventListener('click', joinRoom);

// Lobby
btnCancel.addEventListener('click', returnHome);

// Game — leave
btnLeave.addEventListener('click', returnHome);

// Game — roll
btnRoll.addEventListener('click', doRoll);

// Game — dice holds (delegated over the tray)
diceTray.addEventListener('click', (e) => {
  const die = e.target.closest('.die');
  if (!die) return;
  const idx = dieEls.indexOf(die);
  if (idx >= 0) toggleHold(idx);
});

// Game — score by clicking an open row on YOUR scorecard
scorecardYou.addEventListener('click', (e) => {
  const row = e.target.closest('.sc-row[data-cat]');
  if (!row || !row.classList.contains('sc-row--open')) return;
  doScore(row.dataset.cat);
});

// Game — dice tumble cleanup on animation end
dieEls.forEach((el) => {
  el.addEventListener('animationend', () => {
    el.classList.remove('tumbling');
    el.style.animationDelay = '';
  });
});

// End overlay
btnRematch.addEventListener('click', () => { if (engine) engine.rematch(); });
btnNewgame.addEventListener('click', returnHome);
btnAnalysis.addEventListener('click', openAnalysis);

// Analysis overlay
btnAnalysisBack.addEventListener('click', closeAnalysis);

// Keyboard: 1-5 toggle holds, Space or R rolls (only while playing the board)
document.addEventListener('keydown', (e) => {
  if (currentScreen !== 'game') return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key >= '1' && e.key <= '5') {
    e.preventDefault();
    toggleHold(Number(e.key) - 1);
  } else if (e.key === ' ' || e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    doRoll();
  }
});

// ---------------------------------------------------------------------------
// Initial state — Home is active in the markup; sync our defaults to it.
// ---------------------------------------------------------------------------

setOpponent('machine');
setAiType('standard');
setVariant(1);
lobbyCode.textContent = LOBBY_PLACEHOLDER;

// Luck-vs-skill readout on the Variant step — fetches the tiny precomputed
// uncertainty.json (NOT the 2MB strategy table) and paints the split bars.
// Fire-and-forget: it fails soft and never blocks game start.
initUncertainty();
