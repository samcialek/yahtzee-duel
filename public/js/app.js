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

import { potentials, CATS, claimedCats, canRollSync } from '../shared/game.js';
import { fromPlayerState } from '../../solver/policy.js';
import { LocalEngine } from './engine.js';
import { RemoteEngine } from './net.js';
import { recordDecision, analyze, renderAnalysis, replayOptimal, subsetReport } from './analysis.js';
import { init as initUncertainty } from './uncertainty-ui.js';
import { init as initHistory, recordGame, updateGame, renderHistory } from './history.js';

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

// Screens + overlay + toast
const screenHome = $('screen-home');
const screenLobby = $('screen-lobby');
const screenGame = $('screen-game');
const screenHistory = $('screen-history');
const overlayEnd = $('overlay-end');
const toastEl = $('error-toast');
const toastMsg = $('error-toast-msg');

const SCREENS = { home: screenHome, lobby: screenLobby, game: screenGame, history: screenHistory };

// Home
const oppMachine = $('opp-machine');
const oppFriend = $('opp-friend');
const aiStrength = $('ai-strength');
const aiStandard = $('ai-standard');
const aiPerfect = $('ai-perfect');
const coachToggle = $('coach-toggle');
const coachOffBtn = $('coach-off');
const coachOnBtn = $('coach-on');
const variantCards = [$('variant-1'), $('variant-2'), $('variant-3')];
const variantHostNote = $('variant-host-note');
const gameDuel = $('game-duel');
const gameClaim = $('game-claim');
const gameCaption = $('game-caption');
const gameSelect = $('game-select');
const duelBody = $('duel-body');
const claimBody = $('claim-body');
const inputName = $('input-name');
const actionsMachine = $('actions-machine');
const actionsFriend = $('actions-friend');
const btnStart = $('btn-start');
const btnCreate = $('btn-create');
const inputCode = $('input-code');
const btnJoin = $('btn-join');
const btnHistory = $('btn-history');

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
const btnReview = $('btn-review');

// Coach panel (training games)
const coachPanel = $('coach-panel');
const btnHint = $('btn-hint');
const btnFlag = $('btn-flag');
const coachHint = $('coach-hint');

// Analysis overlay
const overlayAnalysis = $('overlay-analysis');
const analysisContent = $('analysis-content');
const btnAnalysisBack = $('btn-analysis-back');
const anTitle = $('an-title');
const anKicker = $('an-kicker');

const VARIANT_NAMES = { 1: 'Classic', 2: 'Shared Start', 3: 'Linked Dice' };
const LOBBY_PLACEHOLDER = '————';
const CAT_LABELS = {
  ones: 'Aces', twos: 'Twos', threes: 'Threes', fours: 'Fours', fives: 'Fives', sixes: 'Sixes',
  threeKind: 'Three of a Kind', fourKind: 'Four of a Kind', fullHouse: 'Full House',
  smallStraight: 'Small Straight', largeStraight: 'Large Straight', yahtzee: 'Yahtzee', chance: 'Chance',
};
// Step 02 game-fork captions (swap under the Duel / Category Claim segmented control).
const GAME_CAPTIONS = {
  duel: 'Two scorecards. Race to the higher total.',
  claim: 'One scorecard, shared. Claim each box before your opponent can.',
};
const HOST_CAPTION = 'The host picks the game — you’ll see it when the room loads.';

// ---------------------------------------------------------------------------
// Module state — pure client-side UI, never authoritative
// ---------------------------------------------------------------------------

let engine = null;                // the active LocalEngine | RemoteEngine
let opponentType = 'machine';     // 'machine' | 'friend'
let aiType = 'standard';          // 'standard' | 'perfect' (Machine strength)
let optimalAI = null;             // loaded Perfect AI, cached across games
let startingAI = false;           // guards Start against double-clicks mid-load
let selectedMode = 1;             // 1 | 2 | 3 — the parked Duel variant (read only when game==='duel')
let selectedGame = 'duel';        // 'duel' (dice-sharing variants) | 'claim' (Category Claim)
let coachEnabled = false;         // Coach toggle (home; Machine only) — a coached Classic game
let coachGame = false;            // the CURRENT game is coached (policy loaded, hints live)
let flaggedKeys = new Set();      // decision keys ("round:rollsLeft") flagged for end review
let hintKeep = null;              // bool[5] of the coach's suggested keep for the live decision, or null
let hintCat = null;               // the coach's suggested category for the live decision, or null
let hintKey = null;               // decision key ("round:rollsLeft") the live hint belongs to
let isMultiplayer = false;        // true when driven by a RemoteEngine
let held = [false, false, false, false, false]; // client-side keep mask
let lastRollDispatch = 0;         // doRoll debounce timestamp (see ROLL_COOLDOWN_MS)
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
let optimalAILoading = null;      // in-flight loadOptimalAI promise, shared by all callers

// Game history (history.js owns storage + the screen; we only feed it records).
let historyRecorded = false;      // this game already written (end states can re-push)
let gameAiType = 'standard';      // EFFECTIVE machine strength in play (fallback-aware)

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
  lastRollDispatch = 0;
  lastSeq = 0;
  currentView = null;
  coachGame = false;      // startAI re-arms this for a coached game
  resetAnalysis();
}

function resetAnalysis() {
  moveLog = [];
  analysisReport = null;
  analysisGen++;   // discard any analysis still awaiting the strategy-table fetch
  historyRecorded = false;   // re-arm the once-per-game history record
  overlayAnalysis.classList.remove('is-active');
  // Coach review shares the moveLog + overlay; clear its per-game state too (this
  // also fires on a rematch's end→play, so a coached rematch starts fresh flags).
  flaggedKeys = new Set();
  clearHint();
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
  coachToggle.hidden = type !== 'machine';   // Coach is a Machine-only training mode
  actionsMachine.hidden = type !== 'machine';
  actionsFriend.hidden = type !== 'friend';
  updateGameLock();
}

// Coach toggle (Machine only): On → the machine's coach reviews YOUR play. It
// layers over any of the three Duel variants (mode kept as-is; gamePayload arms
// it and Start loads the strategy table the live hints need). It does not apply
// to Category Claim.
function setCoach(on) {
  coachEnabled = on;
  coachOffBtn.classList.toggle('is-selected', !on);
  coachOnBtn.classList.toggle('is-selected', on);
}

function setAiType(type) {
  aiType = type;
  aiStandard.classList.toggle('is-selected', type === 'standard');
  aiPerfect.classList.toggle('is-selected', type === 'perfect');
}

function setVariant(mode) {
  if (gameSelect.classList.contains('is-locked')) return;
  selectedMode = mode;
  variantCards.forEach((card) => {
    card.classList.toggle('is-selected', Number(card.dataset.mode) === mode);
  });
}

// The Game fork: 'duel' shows the three dice-sharing variant cards + luck/skill
// bars; 'claim' swaps them for the Category Claim rules panel. The parked variant
// (selectedMode + its highlighted card) is NOT cleared, so switching back restores
// it. Category Claim always plays on independent dice — enforced at submit
// (gamePayload), never by trusting selectedMode while game==='claim'.
function setGame(game) {
  if (gameSelect.classList.contains('is-locked')) return;
  selectedGame = game;
  gameDuel.classList.toggle('is-selected', game === 'duel');
  gameClaim.classList.toggle('is-selected', game === 'claim');
  duelBody.hidden = game !== 'duel';
  claimBody.hidden = game !== 'claim';
  gameCaption.textContent = GAME_CAPTIONS[game];
}

// The Game fork is "set by host" only when JOINING a room (Friend + a typed
// code): it dims and collapses the bodies. The Coach does NOT override the fork —
// it layers onto whichever Duel variant you pick.
function updateGameLock() {
  const joining = opponentType === 'friend' && inputCode.value.trim().length > 0;
  gameSelect.classList.toggle('is-locked', joining);
  variantHostNote.hidden = !joining;
  if (joining) {
    duelBody.hidden = true;
    claimBody.hidden = true;
    gameCaption.textContent = HOST_CAPTION;
  } else {
    setGame(selectedGame);   // lock class already cleared above, so this proceeds
  }
}

// The submit payload. Category Claim forces mode 1 (never trusting a stale
// selectedMode). The Coach is a Machine-only training layer over ANY of the three
// DUEL variants — it keeps the chosen variant (mode = selectedMode) and does not
// apply to Category Claim (the solitaire-optimal solver can't grade a shared card).
function gamePayload() {
  const claim = selectedGame === 'claim';
  const coach = opponentType === 'machine' && coachEnabled && !claim;
  return { mode: claim ? 1 : selectedMode, claim, coach };
}

// The one lazy-load path for the optimal policy (solver module + the few-MB
// strategy table): Perfect games, the coach, post-game analysis, and history
// recording all funnel through here, sharing a single in-flight fetch. Throws
// on failure (each caller handles its own fallback); safe to retry later.
async function ensureOptimalAI() {
  if (optimalAI) return optimalAI;
  if (!optimalAILoading) {
    optimalAILoading = import('./ai-optimal.js')
      .then((mod) => mod.loadOptimalAI(''))
      .then((loaded) => { optimalAI = loaded; return loaded; })
      .finally(() => { optimalAILoading = null; });
  }
  return optimalAILoading;
}

async function startAI() {
  if (startingAI) return;                 // Perfect table already loading — ignore re-clicks
  const { mode, claim, coach } = gamePayload();
  let ai = null;                          // null → LocalEngine's heuristic default

  // The strategy table is needed by a Perfect opponent AND by the coach's live
  // hints — load it once (cached) if either is in play.
  const needPolicy = aiType === 'perfect' || coach;
  if (needPolicy) {
    startingAI = true;
    const label = btnStart.textContent;
    btnStart.disabled = true;
    btnStart.classList.add('is-loading');
    btnStart.textContent = 'Loading strategy…';
    try {
      await ensureOptimalAI();
      if (aiType === 'perfect') ai = optimalAI;
    } catch (err) {
      optimalAI = null;
      toast(coach
        ? 'Couldn’t load the coach — starting a plain Classic game.'
        : 'Couldn’t load the perfect strategy — starting with Standard.');
    }
    btnStart.textContent = label;
    btnStart.classList.remove('is-loading');
    btnStart.disabled = false;
    startingAI = false;
  }

  cleanupEngine();
  resetGameUI();
  isMultiplayer = false;
  // Effective strength actually in play — the catch above may have downgraded a
  // Perfect pick to Standard; the history record must say what really ran.
  gameAiType = ai ? 'perfect' : 'standard';
  // Coached only if requested AND the policy actually loaded; otherwise a plain
  // Classic game (the coach panel stays hidden).
  coachGame = coach && !!optimalAI;
  engine = new LocalEngine({
    mode,
    claim,
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
  const { mode, claim } = gamePayload();
  engine.create(name, mode, claim);
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
  // A game just finished — persist it to the local history exactly once (end
  // states re-push while multiplayer rematch votes come in; the flag absorbs them).
  if (view.phase === 'end' && !historyRecorded) {
    historyRecorded = true;     // set synchronously, before recordGameEnd's async work
    recordGameEnd(view);
  }
  showScreen('game');
  render(view);
}

// ---------------------------------------------------------------------------
// Game history intake — one record per finished game (history.js stores it)
// ---------------------------------------------------------------------------

// Save the score row IMMEDIATELY (it must survive a closed tab or a failed
// table fetch), then patch in the analysis fields — perfect-play score on the
// player's own dice, EV loss, accuracy — once the strategy table delivers.
function recordGameEnd(view) {
  const result = view.result || { you: view.you.total, opp: view.opp.total };
  const id = recordGame({
    date: new Date().toISOString(),
    mode: view.mode,
    claim: !!view.claim,
    opp: isMultiplayer ? 'friend' : 'machine',
    ai: isMultiplayer ? null : gameAiType,
    coach: coachGame,
    oppName: view.oppName,
    yourScore: result.you,
    oppScore: result.opp,
    perfectScore: null, evLoss: null, accuracyPct: null, nDecisions: null, nOptimal: null,
  });
  // Category Claim has no decision log (and no meaningful optimal replay).
  if (!id || view.claim || moveLog.length === 0) return;
  // Snapshot NOW — a rematch clears moveLog and returning home destroys the
  // engine (dropping its luck context) before the async work below finishes.
  const log = moveLog.slice();
  const luckCtx = engine && typeof engine.luckContext === 'function' ? engine.luckContext() : null;
  const gen = analysisGen;
  (async () => {
    try {
      await ensureOptimalAI();
      const report = analyze(log, optimalAI.policy);
      let perfect = null;
      try { perfect = replayOptimal(luckCtx, optimalAI.policy); } catch { perfect = null; }
      updateGame(id, {
        perfectScore: perfect,
        evLoss: report.totalLoss,
        accuracyPct: report.accuracyPct,
        nDecisions: report.nDecisions,
        nOptimal: report.nOptimal,
      });
      // Share with openAnalysis(): the Analysis button then renders instantly.
      if (gen === analysisGen && !analysisReport) analysisReport = report;
    } catch {
      // Offline / fetch failed — the score row is already saved; the analysis
      // columns simply stay em-dashed for this game.
    }
  })();
}

// ---------------------------------------------------------------------------
// The single pure renderer — handles EVERY view-model field (§5)
// ---------------------------------------------------------------------------

function roundLabel(p, claim) {
  return claim ? `${Math.min(p.round + 1, 6)}/6` : `${Math.min(p.round + 1, 13)}/13`;
}

function render(view) {
  const mode = view.mode;
  const you = view.you;
  const opp = view.opp;
  // Alternating, visible-dice play happens ONLY in a Classic Duel. Category Claim
  // is a simultaneous race even on independent dice (mode 1) → turn-free, hidden.
  const alternating = mode === 1 && !view.claim;
  const showOpp = alternating && view.turn === 'opp'; // center tray shows opp only then
  const center = showOpp ? opp : you;

  // -- Coach: drop a stale hint when the decision point changed (new roll /
  //    round) BEFORE the scorecard/dice render, so the highlights stay in sync.
  const decisionKeyNow = Array.isArray(you.dice) ? decisionKey(you) : null;
  if (hintKey && hintKey !== decisionKeyNow) clearHint();

  // -- Header -------------------------------------------------------------
  // Category Claim is its own game; Duel shows the variant (+ a Coach tag when training).
  variantChip.textContent = view.claim
    ? 'Category Claim'
    : (VARIANT_NAMES[mode] || 'Classic') + (coachGame ? ' · Coach' : '');
  roundIndicator.textContent = view.claim
    ? (view.sudden ? 'Sudden death' : `Round ${Math.min(you.round + 1, 6)} / 6`)
    : `Round ${Math.min(you.round + 1, 13)} / 13`;

  // -- Names, active dot, per-player progress -----------------------------
  youName.textContent = view.youName;
  oppName.textContent = view.oppName;

  youDot.classList.toggle('is-active', alternating && view.turn === 'you');
  oppDot.classList.toggle('is-active', alternating && view.turn === 'opp');

  if (alternating) {
    youProgress.textContent = '';
    oppProgress.textContent = '';
  } else {
    // Simultaneous play (variants 2/3 and every Claim race): show both clocks.
    youProgress.textContent = roundLabel(you, view.claim);
    oppProgress.textContent = roundLabel(opp, view.claim);
  }

  // -- Scorecards ---------------------------------------------------------
  renderScorecard(scorecardYou, you, opp, true, view);
  renderScorecard(scorecardOpp, opp, you, false, view);

  // -- Dice + rolls-left + labels ----------------------------------------
  renderDice(view);

  const spent = 3 - center.rollsLeft;           // 0..3 rolls consumed this round
  rollDots.forEach((dot, i) => dot.classList.toggle('is-spent', i < spent));

  // -- Roll button: enabled only when it's your move -----------------------
  // turn === null means simultaneous play (variants 2/3, and sudden death in
  // every variant); Category Claim adds the roll-sync barrier + sudden locks.
  const yourTurn = view.turn ? view.turn === 'you' : true;
  const youLocked = !!(view.sudden && view.sudden.youPts !== null);
  let canRoll = view.phase === 'play' && yourTurn && !you.done && you.rollsLeft > 0 && !youLocked;
  // Category Claim is a lockstep race: you may roll only once your opponent has
  // reached the same roll (barrier applies to every Claim game + sudden death).
  if (canRoll && view.claim) {
    canRoll = canRollSync(you, opp);
  }
  btnRoll.disabled = !canRoll;

  // -- Coach panel (training games): shown while YOU have a live decision -----
  const coachActive = coachGame && view.phase === 'play' && canControl(view)
    && Array.isArray(you.dice);
  coachPanel.hidden = !coachActive;
  if (coachActive) {
    const flagged = flaggedKeys.has(decisionKeyNow);
    btnFlag.classList.toggle('is-flagged', flagged);
    btnFlag.textContent = flagged ? 'Flagged ✓' : 'Flag for review';
  }

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

function renderScorecard(root, p, other, isYou, view) {
  const card = p.card;
  const claim = !!(view && view.claim);
  const suddenCat = view && view.sudden ? view.sudden.cat : null;
  // Category Claim: a box scored by the OTHER player is dead on this card too.
  const blocked = claim ? claimedCats(other.card) : null;
  const youLocked = isYou && view && view.sudden && view.sudden.youPts !== null;
  // Potentials (candidate scores + joker legality) only make sense for your own
  // rolled dice; the opponent's card renders filled boxes only. A sudden-death
  // lock freezes your card — no more candidates to offer.
  const pots = isYou && p.dice && !youLocked ? potentials(card, p.dice, blocked || undefined) : null;

  for (const cat of CATS) {
    const row = root.querySelector(`.sc-row[data-cat="${cat}"]`);
    if (!row) continue;
    const valEl = row.querySelector('.sc-value');
    row.classList.remove('sc-row--open', 'sc-row--disallowed', 'sc-row--filled',
      'sc-row--claimed', 'sc-row--sudden', 'sc-row--hint');
    if (suddenCat === cat) row.classList.add('sc-row--sudden');
    // Coach: mark the optimal category on your own card while a score-hint is shown.
    if (isYou && coachGame && hintCat === cat) row.classList.add('sc-row--hint');

    const filled = card[cat];
    if (filled !== null && filled !== undefined) {
      valEl.textContent = String(filled);
      row.classList.add('sc-row--filled');
    } else if (blocked && blocked.has(cat)) {
      valEl.textContent = '✕';
      row.classList.add('sc-row--claimed');
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
  // Opponent dice show only in an alternating Classic Duel; a Claim race is hidden.
  const alternating = view.mode === 1 && !view.claim;
  const showOpp = alternating && view.turn === 'opp';
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
    // Coach: ring the optimal keep-dice on your own tray while a hint is shown.
    el.classList.toggle('die--hint', coachGame && !showOpp && !empty && !!(hintKeep && hintKeep[i]));
  }

  if (alternating) {
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
  // Sudden death: one box left, both play a turn for it at once.
  if (view.sudden) {
    const label = CAT_LABELS[view.sudden.cat] || view.sudden.cat;
    if (view.sudden.youPts !== null) {
      return `Locked in ${view.sudden.youPts} for ${label} — waiting for ${view.oppName}.`;
    }
    return `Sudden death — ${label} decides it.`;
  }
  if (you.done) return "You're done — waiting for your opponent.";
  // Category Claim race barrier: you can't reroll until the opponent catches up —
  // but if you've already rolled you can still snipe a box now (that's the race).
  if (view.claim && you.rollsLeft > 0 && !canRollSync(view.you, view.opp)) {
    return you.dice
      ? `Reroll locked — claim a box now, or wait for ${view.oppName}.`
      : `Waiting for ${view.oppName}…`;
  }
  const alternating = view.mode === 1 && !view.claim;
  if (you.rollsLeft === 3) return alternating ? 'Your turn — roll.' : 'Roll to begin the round.';
  if (you.rollsLeft === 0) return 'Choose a category.';
  if (view.claim) return 'Hold, reroll — or claim a box.';
  return 'Hold, reroll — or score.';
}

function subStatusText(view, showOpp) {
  if (view.phase === 'end' || showOpp) return '';
  const you = view.you;
  if (view.sudden) {
    if (view.sudden.youPts !== null) return view.sudden.oppLocked ? '' : 'Opponent still rolling';
    return view.sudden.oppLocked ? 'Opponent has locked in' : 'Higher score takes the box';
  }
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

  // Post-game analysis replays YOUR dice against solitaire perfect play — the
  // premise breaks under Category Claim (the opponent constrains your card).
  btnAnalysis.hidden = !!view.claim;
  // The flagged-decisions review is offered only for a coached game where you
  // actually flagged something.
  btnReview.hidden = !(coachGame && flaggedKeys.size > 0);
}

// ---------------------------------------------------------------------------
// Game input — dice holds, roll, score
// ---------------------------------------------------------------------------

function canControl(view) {
  if (!view || view.phase !== 'play') return false;
  // turn === 'opp' → Classic Duel alternation, not your move. turn === null means
  // simultaneous play (variants 2/3, every Claim race, sudden death) — your board.
  if (view.mode === 1 && !view.claim && view.turn === 'opp') return false;
  if (view.you.done) return false;
  if (view.sudden && view.sudden.youPts !== null) return false; // locked in
  return true;
}

function toggleHold(i) {
  const view = currentView;
  if (!canControl(view)) return;
  if (view.you.dice === null) return;   // nothing rolled yet
  if (view.you.rollsLeft <= 0) return;  // no reroll left — holds are moot
  held[i] = !held[i];
  renderDice(view);                     // instant local feedback, no state push
  // Only an alternating Classic Duel relays keeps to the spectating opponent; a
  // Claim race hides dice, so holds stay local.
  if (view.mode === 1 && !view.claim && engine) engine.holdUpdate(held.slice());
}

// A second roll dispatched while the previous one's dice are still tumbling
// cannot be intentional — the player hasn't even seen the result yet. Accidental
// re-fires (mouse double-click, key auto-repeat, Enter activation on the focused
// Roll button) would otherwise silently consume a roll: harmless-looking, but if
// it lands at the start of a round the extra roll carries the fresh all-false
// keep mask and rerolls all five dice — including any the player then "held"
// between the two in-flight multiplayer pushes.
const ROLL_COOLDOWN_MS = 400;

function doRoll() {
  const view = currentView;
  if (!canControl(view)) return;
  if (view.you.rollsLeft <= 0) return;
  const now = Date.now();
  if (now - lastRollDispatch < ROLL_COOLDOWN_MS) return;
  lastRollDispatch = now;
  // Record the reroll decision (the kept multiset) — but NOT the forced first
  // roll of a round, where dice === null and no alternative existed. Claim games
  // aren't analyzable (the solitaire replay premise breaks), so skip the log.
  if (view.you.dice !== null && !view.claim) {
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
  if (!view.claim) recordDecision(moveLog, view, { type: 'score', cat });
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
  anKicker.textContent = 'Post-game';       // reset (the flagged-review reuse retitles it)
  anTitle.textContent = 'Decision analysis';

  if (analysisReport) {
    renderAnalysis(analysisReport, analysisContent, analysisRenderOpts());
    return;
  }
  if (analysisBusy) return;
  analysisBusy = true;
  const gen = analysisGen;   // if a rematch resets the log mid-fetch, gen goes stale
  analysisStatus('Consulting the strategy table…');
  try {
    // Same lazy path as a Perfect game: module + few-MB table fetched once,
    // then shared — a Perfect AI started later reuses this instance too.
    await ensureOptimalAI();
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
// Coach (training games) — live optimal-move hints + flag-for-review
// ---------------------------------------------------------------------------

const decisionKey = (you) => `${you.round}:${you.rollsLeft}`;

function keepLabel(faces) {
  if (faces.length === 0) return 'reroll everything';
  if (faces.length === 5) return 'keep all — score now';
  return `keep ${faces.slice().sort((a, b) => a - b).join(' · ')}`;
}

// Positional keep-mask for a kept multiset (greedy count match) — the coach's
// suggested keep, glowed on the tray. Mirrors ai-optimal.js holdMaskFromKeep.
function keepMaskFromFaces(dice, faces) {
  const need = [0, 0, 0, 0, 0, 0, 0];
  for (const f of faces) need[f]++;
  const mask = [false, false, false, false, false];
  for (let i = 0; i < 5; i++) {
    const f = dice[i];
    if (need[f] > 0) { need[f]--; mask[i] = true; }
  }
  return mask;
}

function clearHint() {
  hintKeep = null;
  hintCat = null;
  hintKey = null;
  if (coachHint) coachHint.textContent = '';
}

// Reveal the optimal move for the current dice: name it, print its EV, and glow
// the keep-dice (reroll) or the recommended category row (score now).
function showHint() {
  const view = currentView;
  if (!coachGame || !optimalAI || !canControl(view)) return;
  const you = view.you;
  if (!Array.isArray(you.dice)) return;
  let best;
  try {
    const { mask, up, yz } = fromPlayerState(you);
    // withTurn=true → best.turnEv = expected points scored THIS turn under optimal
    // play (not the whole-game EV), which is the figure the coach shows.
    best = optimalAI.policy.evalTurn(mask, up, yz, you.dice, you.rollsLeft, true).best;
  } catch {
    coachHint.textContent = 'The coach is unavailable for this position.';
    return;
  }
  hintKey = decisionKey(you);
  const turnEv = best.turnEv != null ? best.turnEv : best.ev;
  const evTag = `<span class="ev">≈ ${turnEv.toFixed(1)} pts this turn</span>`;
  if (best.type === 'keep') {
    hintKeep = keepMaskFromFaces(you.dice, best.faces);
    hintCat = null;
    coachHint.innerHTML = `Optimal: <strong>${keepLabel(best.faces)}</strong> ${evTag}`;
  } else {
    hintKeep = null;
    hintCat = best.cat;
    coachHint.innerHTML = `Optimal: <strong>score ${CAT_LABELS[best.cat] || best.cat} = ${best.pts}</strong> ${evTag}`;
  }
  render(view);   // reapply the die / row highlights (pure fn of currentView + hint state)
}

// Flag (or unflag) the current decision to review at game end.
function toggleFlag() {
  const view = currentView;
  if (!coachGame || !canControl(view) || !Array.isArray(view.you.dice)) return;
  const key = decisionKey(view.you);
  if (flaggedKeys.has(key)) flaggedKeys.delete(key);
  else flaggedKeys.add(key);
  render(view);   // refresh the flag button's state
}

// Open the flagged-decisions review — reuses the analysis overlay + ledger,
// filtered to the decisions you flagged. The policy is already loaded (a coached
// game required it), and moveLog is recorded (a coached game is a Classic Duel).
function openReview() {
  if (!currentView || currentView.phase !== 'end' || !optimalAI) return;
  overlayEnd.classList.remove('is-active');
  overlayAnalysis.classList.add('is-active');
  anKicker.textContent = 'Coach';
  anTitle.textContent = 'Decisions you flagged';
  try {
    const full = analyze(moveLog, optimalAI.policy);
    const flagged = full.decisions.filter((d) => flaggedKeys.has(`${d.round}:${d.rollsLeft}`));
    if (flagged.length === 0) {
      analysisStatus('No decisions were flagged.');
      return;
    }
    renderAnalysis(subsetReport(flagged), analysisContent, {});
  } catch {
    analysisStatus('The review couldn’t be prepared.');
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

// Home — Coach on/off (Machine training mode)
coachOffBtn.addEventListener('click', () => setCoach(false));
coachOnBtn.addEventListener('click', () => setCoach(true));

// Home — variant cards
variantCards.forEach((card) => {
  card.addEventListener('click', () => setVariant(Number(card.dataset.mode)));
});

// Home — Game fork (Duel ↔ Category Claim)
gameDuel.addEventListener('click', () => setGame('duel'));
gameClaim.addEventListener('click', () => setGame('claim'));

// Home — room-code input: auto-uppercase, strip non-letters, refresh lock state
inputCode.addEventListener('input', () => {
  const cleaned = inputCode.value.toUpperCase().replace(/[^A-Z]/g, '');
  if (inputCode.value !== cleaned) inputCode.value = cleaned;
  updateGameLock();
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

// Home — game history (render fresh from storage on every open)
btnHistory.addEventListener('click', () => { renderHistory(); showScreen('history'); });

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
btnReview.addEventListener('click', openReview);
btnAnalysis.addEventListener('click', openAnalysis);

// Analysis overlay
btnAnalysisBack.addEventListener('click', closeAnalysis);

// Coach panel (training games)
btnHint.addEventListener('click', showHint);
btnFlag.addEventListener('click', toggleFlag);

// Keyboard: 1-5 toggle holds, Space or R rolls; in a coached game H = best move,
// F = flag (only while playing the board).
document.addEventListener('keydown', (e) => {
  if (currentScreen !== 'game') return;
  // OS key auto-repeat must not act: a held Space/R would fire extra rolls (each
  // one consuming a REAL roll — the engine is synchronous), and a held 1-5 would
  // rapidly toggle a hold on/off, sometimes landing silently un-held.
  if (e.repeat) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key >= '1' && e.key <= '5') {
    e.preventDefault();
    toggleHold(Number(e.key) - 1);
  } else if (e.key === ' ' || e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    doRoll();
  } else if (coachGame && (e.key === 'h' || e.key === 'H')) {
    e.preventDefault();
    showHint();
  } else if (coachGame && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    toggleFlag();
  }
});

// ---------------------------------------------------------------------------
// Initial state — Home is active in the markup; sync our defaults to it.
// ---------------------------------------------------------------------------

setOpponent('machine');
setAiType('standard');
setVariant(1);
setGame('duel');
setCoach(false);
lobbyCode.textContent = LOBBY_PLACEHOLDER;

// Luck-vs-skill readout on the Variant step — fetches the tiny precomputed
// uncertainty.json (NOT the 2MB strategy table) and paints the split bars.
// Fire-and-forget: it fails soft and never blocks game start.
initUncertainty();

// Game history screen — storage + rendering live in history.js; it gets the
// screen router and the shared toast, never any game state.
initHistory({ onBack: () => showScreen('home'), toast });
