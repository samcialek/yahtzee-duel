// public/js/history.js
// Persistent game history — localStorage only, no accounts, no server.
//
// Owns the '#screen-history' screen and the store under localStorage key
// 'yz.history.v1' ({ v: 1, games: [oldest → newest] }, capped at 500). app.js
// records a row synchronously the moment a game ends (recordGame), then patches
// in the analysis fields (perfect-play score on the same dice, EV loss,
// accuracy) once the strategy table has produced them (updateGame) — so a row
// survives even if that fetch never lands. Everything here fails soft: storage
// being unavailable, full, or corrupt must never throw into the game.
//
// Unlike the analysis ledger (app-generated content), the opponent name is
// user-typed — rows are built with createElement/textContent, never innerHTML.
//
// Binds only to the stable ids in index.html's DOM CONTRACT:
//   #history-stats #history-table #history-empty
//   #btn-history-back #btn-history-export #btn-history-clear

const $ = (id) => document.getElementById(id);

const KEY = 'yz.history.v1';
const MAX_GAMES = 500;      // oldest dropped beyond this
const TRIM_GAMES = 100;     // quota-exceeded fallback: keep the most recent 100

// Mirrors VARIANT_NAMES in app.js (kept local so this module stays standalone).
const VARIANT_NAMES = { 1: 'Classic', 2: 'Shared Start', 3: 'Linked Dice' };

let onBack = null;
let toast = null;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// Wire the History screen's buttons. Callbacks come from app.js (screen routing
// and the shared toast) so this module never reaches into game state.
export function init(opts) {
  onBack = opts && typeof opts.onBack === 'function' ? opts.onBack : null;
  toast = opts && typeof opts.toast === 'function' ? opts.toast : null;
  const back = $('btn-history-back');
  const exp = $('btn-history-export');
  const clear = $('btn-history-clear');
  if (back) back.addEventListener('click', () => { if (onBack) onBack(); });
  if (exp) exp.addEventListener('click', exportCSV);
  if (clear) clear.addEventListener('click', clearHistory);
}

// Persist one finished game. Assigns an id, caps the store, saves. Returns the
// id so the caller can patch analysis fields in later — or null if the record
// couldn't be saved (storage unavailable/full), in which case skip the patch.
export function recordGame(rec) {
  const store = load();
  const id = makeId();
  store.games.push({ ...rec, id });
  if (store.games.length > MAX_GAMES) {
    store.games.splice(0, store.games.length - MAX_GAMES);
  }
  return save(store) ? id : null;
}

// Merge late-arriving fields (the async analysis patch) into a stored record.
// No-op if the record has been cleared or aged out in the meantime.
export function updateGame(id, patch) {
  const store = load();
  const rec = store.games.find((g) => g && g.id === id);
  if (!rec) return;
  Object.assign(rec, patch);
  save(store);
}

// Paint the aggregate strip + the per-game ledger (newest first).
export function renderHistory() {
  const statsEl = $('history-stats');
  const tableEl = $('history-table');
  const emptyEl = $('history-empty');
  if (!statsEl || !tableEl) return;

  const games = load().games.filter((g) => g && typeof g === 'object');
  const has = games.length > 0;
  if (emptyEl) emptyEl.hidden = has;
  statsEl.hidden = !has;
  tableEl.hidden = !has;
  statsEl.textContent = '';
  tableEl.textContent = '';
  if (!has) return;

  renderStats(statsEl, games);
  renderTable(tableEl, games);
}

// ---------------------------------------------------------------------------
// Storage — every access wrapped; corrupt or missing data reads as empty
// ---------------------------------------------------------------------------

function load() {
  try {
    const store = JSON.parse(localStorage.getItem(KEY));
    if (store && store.v === 1 && Array.isArray(store.games)) return store;
  } catch (_err) { /* corrupt / unavailable — superseded on next save */ }
  return { v: 1, games: [] };
}

function save(store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
    return true;
  } catch (_err) {
    // Quota — keep only the most recent games and retry once.
    try {
      store.games.splice(0, Math.max(0, store.games.length - TRIM_GAMES));
      localStorage.setItem(KEY, JSON.stringify(store));
      return true;
    } catch (_err2) {
      return false;      // private mode / storage off — give up silently
    }
  }
}

function makeId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().slice(0, 8);
    }
  } catch (_err) { /* fall through */ }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function outcomeOf(rec) {
  if (rec.yourScore > rec.oppScore) return 'win';
  if (rec.yourScore < rec.oppScore) return 'loss';
  return 'tie';
}

function gameLabel(rec) {
  const base = rec.claim ? 'Category Claim' : (VARIANT_NAMES[rec.mode] || 'Duel');
  return rec.coach ? `${base} · Coach` : base;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stat(num, cap) {
  const box = el('div', 'hi-stat');
  box.append(el('span', 'hi-num', num), el('span', 'hi-cap', cap));
  return box;
}

function renderStats(container, games) {
  const n = games.length;
  const wins = games.filter((g) => outcomeOf(g) === 'win').length;
  const losses = games.filter((g) => outcomeOf(g) === 'loss').length;
  const ties = n - wins - losses;

  const gaps = games
    .filter((g) => Number.isFinite(g.perfectScore))
    .map((g) => g.perfectScore - g.yourScore);
  const losses95 = games.filter((g) => Number.isFinite(g.evLoss)).map((g) => g.evLoss);

  container.append(
    stat(String(n), n === 1 ? 'game' : 'games'),
    stat(`${Math.round((100 * wins) / n)}%`, `wins · ${wins}–${losses}–${ties}`),
    stat(mean(games.map((g) => g.yourScore)).toFixed(1), 'avg score'),
    stat(gaps.length ? mean(gaps).toFixed(1) : '—', 'avg gap to perfect'),
    stat(losses95.length ? mean(losses95).toFixed(1) : '—', 'avg ev lost / game'),
  );
}

const COLUMNS = ['Date', 'Game', 'Opponent', 'You', 'Them', 'Perfect', 'Gap', 'Acc.'];

function renderTable(container, games) {
  const head = el('div', 'hi-row hi-row--head');
  const cellCls = ['hi-date', 'hi-game', 'hi-oppn', 'hi-you', 'hi-them', 'hi-perfect', 'hi-gap', 'hi-acc'];
  COLUMNS.forEach((label, i) => head.append(el('span', cellCls[i], label)));
  container.append(head);

  for (let i = games.length - 1; i >= 0; i--) {   // newest first
    const g = games[i];
    const outcome = outcomeOf(g);
    const row = el('div', 'hi-row');

    const date = el('span', 'hi-date', fmtDate(g.date));
    const full = new Date(g.date);
    if (!isNaN(full)) date.title = full.toLocaleString();

    const you = el('span', `hi-you${outcome === 'win' ? ' is-win' : ''}`, String(g.yourScore));
    const them = el('span', `hi-them${outcome === 'loss' ? ' is-win' : ''}`, String(g.oppScore));

    const hasPerfect = Number.isFinite(g.perfectScore);
    const perfect = el('span', `hi-perfect${hasPerfect ? '' : ' is-null'}`,
      hasPerfect ? String(g.perfectScore) : '—');
    const gapVal = hasPerfect ? g.perfectScore - g.yourScore : null;
    const gap = el('span',
      `hi-gap${gapVal === null ? ' is-null' : (gapVal > 0 ? ' is-pos' : '')}`,
      gapVal === null ? '—' : (gapVal > 0 ? `−${gapVal}` : String(-gapVal || 0)));
    const hasAcc = Number.isFinite(g.accuracyPct);
    const acc = el('span', `hi-acc${hasAcc ? '' : ' is-null'}`,
      hasAcc ? `${Math.round(g.accuracyPct)}%` : '—');

    row.append(
      date,
      el('span', 'hi-game', gameLabel(g)),
      el('span', 'hi-oppn', String(g.oppName || (g.opp === 'friend' ? 'Friend' : 'Machine'))),
      you, them, perfect, gap, acc,
    );
    container.append(row);
  }
}

// ---------------------------------------------------------------------------
// Export + clear
// ---------------------------------------------------------------------------

// One CSV field. Numbers pass through untouched; strings get RFC-4180 quoting
// plus a leading apostrophe when they could read as a spreadsheet formula
// (the opponent name is the only user-controlled column).
function csvField(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+@-]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCSV() {
  const games = load().games;
  if (!games.length) {
    if (toast) toast('No games to export yet.');
    return;
  }
  const header = ['date', 'game', 'opponent', 'opponent_type', 'ai', 'coach',
    'your_score', 'opp_score', 'result', 'perfect_score', 'gap', 'ev_loss',
    'accuracy_pct', 'decisions', 'optimal_decisions'];
  const lines = [header.join(',')];
  for (const g of games) {
    const hasPerfect = Number.isFinite(g.perfectScore);
    lines.push([
      g.date, gameLabel(g), g.oppName, g.opp, g.ai, g.coach ? 'true' : 'false',
      g.yourScore, g.oppScore, outcomeOf(g),
      hasPerfect ? g.perfectScore : null,
      hasPerfect ? g.perfectScore - g.yourScore : null,
      Number.isFinite(g.evLoss) ? g.evLoss : null,
      Number.isFinite(g.accuracyPct) ? Math.round(g.accuracyPct * 10) / 10 : null,
      Number.isFinite(g.nDecisions) ? g.nDecisions : null,
      Number.isFinite(g.nOptimal) ? g.nOptimal : null,
    ].map(csvField).join(','));
  }
  const csv = lines.join('\r\n') + '\r\n';

  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `yahtzee-history-${stamp}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  if (toast) toast('History exported.');
}

function clearHistory() {
  if (!window.confirm('Clear all game history? This can’t be undone.')) return;
  try { localStorage.removeItem(KEY); } catch (_err) { /* nothing to lose */ }
  renderHistory();
  if (toast) toast('History cleared.');
}
