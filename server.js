// server.js — static file serving + WebSocket rooms (ARCHITECTURE.md §6)
//
// Two responsibilities:
//   1) A plain Node `http` static file server for ./public (path-traversal guarded).
//   2) A `WebSocketServer` (from `ws`) attached to it that runs authoritative Yahtzee
//      rooms and pushes a PERSONALIZED view-model (§5) to each player after every event.
//
// Information hiding is enforced HERE, not in the UI: in variants 2 & 3 the opponent's
// dice are never transmitted — only their scorecard and round number.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

import {
  PlayerState,
  makeShared,
  makeLuck,
  nextDice,
  potentials,
  isYahtzee,
  claimedCats,
  openCats,
  canRollSync,
  CATS,
} from './public/shared/game.js';

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
// Second static root (read-only): the solver's browser-safe ESM modules
// (tables.js / states.js / policy.js) are served under /solver/ so the
// explorer imports ONE source of truth instead of a forked copy.
const SOLVER_DIR = path.join(__dirname, 'solver');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
};

function serveStatic(req, res) {
  // Derive a decoded path from the request URL.
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  // Pick the static root: /solver/* maps read-only onto SOLVER_DIR, everything
  // else onto PUBLIC_DIR.
  let rootDir = PUBLIC_DIR;
  if (urlPath.startsWith('/solver/')) {
    rootDir = SOLVER_DIR;
    urlPath = urlPath.slice('/solver'.length);
  }

  // Path-traversal guard: resolve against the root and confirm we stayed inside it.
  const rel = urlPath.replace(/^[/\\]+/, '');
  const abs = path.resolve(rootDir, rel);
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// ---------------------------------------------------------------------------
// WebSocket rooms
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server });

/** code -> Room */
const rooms = new Map();
/** ws -> { room, idx } */
const conns = new WeakMap();

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // ambiguity-free, 4-char codes

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sanitizeName(n) {
  if (typeof n !== 'string') return 'Player';
  const t = n.trim().slice(0, 20);
  return t.length ? t : 'Player';
}

function normalizeHold(h) {
  const out = [false, false, false, false, false];
  if (Array.isArray(h)) for (let i = 0; i < 5; i++) out[i] = !!h[i];
  return out;
}

function emptyHold() {
  return [false, false, false, false, false];
}

/** A room has begun play once the second player has joined and shared dice exist. */
function started(room) {
  return room.players.length === 2 && room.shared !== null;
}

function bothDone(room) {
  return room.players.length === 2 && room.players.every((p) => p.ps.done);
}

// ---------------------------------------------------------------------------
// Category Claim (orthogonal to the dice variant, room.claim === true)
//
// The 13 categories are ONE shared pool: a box scored by either player is dead
// for both. Simultaneous variants (2/3) run under the canRollSync barrier so
// neither player starts a roll the other hasn't reached; Classic keeps strict
// alternation (the turn order IS the throttle). When one box remains, SUDDEN
// DEATH: both players play one full turn for it at once, lock in their dice,
// and the higher score in that box claims it (a tie voids the box). The upper
// bonus is a race too: whoever pushes the COMBINED upper total to 63+ pockets
// the 35 (PlayerState.claimBonus).
// ---------------------------------------------------------------------------

/** Blocked set for player i: every category the opponent has claimed. */
function blockedFor(room, i) {
  return claimedCats(room.players[1 - i].ps.card);
}

/** Award the 35-pt bonus to `idx` if their score just pushed the combined upper total to 63+. */
function checkUpperRace(room, idx) {
  if (room.upperAwarded) return;
  const combined = room.players[0].ps.upperSum + room.players[1].ps.upperSum;
  if (combined >= 63) {
    room.players[idx].ps.claimBonus = 35;
    room.upperAwarded = true;
  }
}

/** Enter sudden death for the single remaining category: fresh turn for both. */
function startSudden(room, cat) {
  room.sudden = { cat, locked: [null, null] };
  room.turn = null;              // Classic alternation ends; both play at once
  for (const pl of room.players) {
    pl.ps.dice = null;
    pl.ps.rollsLeft = 3;
    pl.hold = emptyHold();
  }
}

/** Both players locked → the higher box score claims it; a tie voids the box. */
function resolveSudden(room) {
  const [a, b] = room.sudden.locked;
  const cat = room.sudden.cat;
  if (a.pts !== b.pts) {
    const w = a.pts > b.pts ? 0 : 1;
    const ps = room.players[w].ps;
    if (room.sudden.locked[w].extraYahtzee) ps.yahtzeeBonus += 100;
    ps.card[cat] = room.sudden.locked[w].pts;
    ps.round++;
    checkUpperRace(room, w);
  }
  room.over = true;
}

// ---------------------------------------------------------------------------
// Personalized view-model (§5) — built fresh per player on every push.
// ---------------------------------------------------------------------------

function stateFor(room, i) {
  const me = room.players[i];
  const opp = room.players[1 - i];
  const mode = room.mode;
  const over = room.over;
  // Alternating, visible-dice play happens ONLY in Classic (mode 1) Duel games.
  // Category Claim is a simultaneous race even on independent dice, so it hides
  // the opponent's dice and runs turn-free like variants 2/3.
  const alternating = mode === 1 && !room.claim;

  // Own dice are always visible; opponent's dice ONLY in an alternating Classic game.
  const you = me.ps.serialize(true);
  const oppView = opp.ps.serialize(alternating);

  // Turn is personalized ('you'/'opp') only in alternating Classic; simultaneous
  // play (variants 2/3, and every Category Claim game) → null.
  const turn = alternating && room.turn !== null ? (room.turn === i ? 'you' : 'opp') : null;

  // lastRoll drives the tumble animation. Your own roll is always relayed; the
  // opponent's roll is relayed only in an alternating Classic game (else hidden).
  let lastRoll = null;
  if (room.lastRoll) {
    if (room.lastRoll.player === i) {
      lastRoll = { who: 'you', mask: room.lastRoll.mask.slice() };
    } else if (alternating) {
      lastRoll = { who: 'opp', mask: room.lastRoll.mask.slice() };
    }
  }

  // Opponent's held-dice mask is relayed only in an alternating Classic game.
  const oppHold = alternating ? opp.hold.slice() : null;

  // Category Claim: sudden-death readout. Your own locked pts are echoed back;
  // the opponent's stay a boolean until the game is over (no early reveal).
  let sudden = null;
  if (room.sudden) {
    const mine = room.sudden.locked[i];
    const theirs = room.sudden.locked[1 - i];
    sudden = {
      cat: room.sudden.cat,
      youPts: mine ? mine.pts : null,
      oppLocked: theirs !== null,
      oppPts: over && theirs ? theirs.pts : null,
    };
  }

  return {
    t: 'state',
    seq: room.seq,
    phase: over ? 'end' : 'play',
    mode,
    claim: room.claim,
    sudden,
    code: room.code,
    youName: me.name,
    oppName: opp.name,
    turn,
    you,
    opp: oppView,
    oppHold,
    lastRoll,
    rematch: { you: !!room.rematch[i], opp: !!room.rematch[1 - i] },
    result: over ? { you: me.ps.total, opp: opp.ps.total } : null,
    // At game end, hand THIS player their OWN reproducible tape so the client can
    // compute the same-luck perfect score. SECURITY: only me.ps.luck is ever sent —
    // never opp.ps.luck. room.shared is common to both players already.
    luckContext: over ? { shared: room.shared, luck: me.ps.luck } : null,
  };
}

/** Bump the monotonic seq once per event and push a personalized state to both players. */
function push(room) {
  room.seq++;
  for (let i = 0; i < room.players.length; i++) {
    send(room.players[i].ws, stateFor(room, i));
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function handleCreate(ws, msg) {
  if (conns.has(ws)) return; // already in a room
  const claim = !!msg.claim;
  // Category Claim is a separate game that plays ONLY on independent dice (the
  // Classic model). Force mode 1 for any claim room regardless of the requested
  // mode, so a stale/hostile client can never open the illegal claim + shared/
  // linked combination. Duel rooms honor the requested variant.
  const mode = claim ? 1 : (msg.mode === 2 || msg.mode === 3 ? msg.mode : 1);
  const code = makeCode();
  const room = {
    code,
    mode,
    claim,                     // Category Claim — a separate game, independent dice only (mode 1)
    players: [{ ws, name: sanitizeName(msg.name), ps: new PlayerState(), hold: emptyHold() }],
    shared: null,
    turn: 0,
    starter: 0,
    over: false,
    lastRoll: null,
    rematch: [false, false],
    seq: 0,
    sudden: null,              // { cat, locked: [ {pts, extraYahtzee} | null, … ] } during sudden death
    upperAwarded: false,       // combined-upper 63 race decided
  };
  // Give this player their own reproducible "luck tape"; their dice flow through
  // ps.luck via nextDice. Never transmitted except in that player's own end payload.
  room.players[0].ps.luck = makeLuck();
  room.players[0].ps.claimMode = room.claim;
  rooms.set(code, room);
  conns.set(ws, { room, idx: 0 });
  send(ws, { t: 'created', code });
}

function handleJoin(ws, msg) {
  if (conns.has(ws)) return; // already in a room
  const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
  const room = rooms.get(code);
  if (!room) {
    send(ws, { t: 'error', msg: 'Room not found.' });
    return;
  }
  if (room.players.length >= 2) {
    send(ws, { t: 'error', msg: 'Room is full.' });
    return;
  }

  room.players.push({ ws, name: sanitizeName(msg.name), ps: new PlayerState(), hold: emptyHold() });
  // Joiner gets their own luck tape too (see handleCreate).
  room.players[1].ps.luck = makeLuck();
  room.players[1].ps.claimMode = room.claim;
  conns.set(ws, { room, idx: 1 });

  // Game starts: one authoritative shared-dice table, kept secret on the server.
  room.shared = makeShared();
  // Claim races are simultaneous (turn-free); only a Classic Duel alternates.
  room.turn = room.claim ? null : room.starter;
  room.over = false;
  room.lastRoll = null;
  push(room);
}

function handleRoll(ws, msg) {
  const c = conns.get(ws);
  if (!c) return;
  const { room, idx } = c;
  if (!started(room) || room.over) return;
  const p = room.players[idx];
  if (p.ps.done) return;
  // Alternating-turn gate applies only to a Classic Duel game (mode 1, no claim).
  if (room.mode === 1 && !room.claim && room.turn !== null && room.turn !== idx) return;
  if (p.ps.rollsLeft <= 0) return;
  if (room.sudden && room.sudden.locked[idx]) return;  // locked in — no more rolls
  // Category Claim is a simultaneous race in lockstep: you start a roll only when
  // your opponent has reached it (canRollSync), so neither runs rolls ahead —
  // but whoever *decides* faster still claims a contested box first.
  if (room.claim && !canRollSync(p.ps, room.players[1 - idx].ps)) return;

  // The FIRST roll of a round ignores the hold mask (nextDice re-rolls all 5 anyway).
  const firstRoll = p.ps.rollsLeft === 3;
  const hold = firstRoll ? emptyHold() : normalizeHold(msg.hold);

  const { dice, mask } = nextDice(p.ps, hold, room.mode, room.shared);
  p.ps.applyRoll(dice);
  p.hold = hold.slice(); // reflect kept dice for the variant-1 oppHold relay
  room.lastRoll = { player: idx, mask };
  push(room);
}

function handleHold(ws, msg) {
  const c = conns.get(ws);
  if (!c) return;
  const { room, idx } = c;
  // Relayed holds exist only for the alternating, visible-dice Classic Duel game.
  // Category Claim hides dice (simultaneous race), so it never relays holds.
  if (room.mode !== 1 || room.claim || !started(room) || room.over) return;
  const p = room.players[idx];
  if (p.ps.done) return;
  if (room.turn !== idx) return;

  p.hold = normalizeHold(msg.mask);
  room.lastRoll = null; // a hold update must not re-trigger the tumble animation
  push(room);
}

function handleScore(ws, msg) {
  const c = conns.get(ws);
  if (!c) return;
  const { room, idx } = c;
  if (!started(room) || room.over) return;
  const p = room.players[idx];
  if (p.ps.done) return;
  if (room.mode === 1 && !room.claim && room.turn !== null && room.turn !== idx) return;
  if (p.ps.dice === null) return;

  const cat = msg.cat;
  if (typeof cat !== 'string' || !CATS.includes(cat)) return;

  // Sudden death: "scoring" the contested box locks your dice in — the box is
  // resolved (higher pts wins it) once both players have locked.
  if (room.sudden) {
    if (cat !== room.sudden.cat) return;
    if (room.sudden.locked[idx]) return;
    const pot = potentials(p.ps.card, p.ps.dice, blockedFor(room, idx));
    if (!pot[cat]) return;
    room.sudden.locked[idx] = {
      pts: pot[cat].pts,
      // Extra-Yahtzee +100 rides on the WINNING score only (applied at resolve).
      extraYahtzee: isYahtzee(p.ps.dice) && p.ps.card.yahtzee === 50,
    };
    p.ps.rollsLeft = 0;                 // frees the opponent's barrier; no more rolls
    p.hold = emptyHold();
    room.lastRoll = null;
    if (room.sudden.locked[0] && room.sudden.locked[1]) resolveSudden(room);
    push(room);
    return;
  }

  // scoreCategory enforces legality (incl. joker restrictions) and returns null if
  // illegal. Under Category Claim the opponent's claimed boxes are blocked too —
  // a race to the same box is decided by whichever score reaches the server first.
  const blocked = room.claim ? blockedFor(room, idx) : undefined;
  const pts = p.ps.scoreCategory(cat, blocked);
  if (pts === null) return;

  p.hold = emptyHold();
  room.lastRoll = null;

  if (room.claim) {
    // Category Claim is simultaneous — scoring never passes a turn; each player
    // just advances their own round (kept in step by the roll barrier).
    checkUpperRace(room, idx);
    const open = openCats(room.players[0].ps.card, room.players[1].ps.card);
    if (open.length === 1) {
      startSudden(room, open[0]);       // the last box is contested head-to-head
    }
  } else if (bothDone(room)) {
    room.over = true;
  } else if (room.mode === 1) {
    // Variant 1: scoring passes the turn to the other player.
    room.turn = 1 - room.turn;
  }
  push(room);
}

function handleRematch(ws) {
  const c = conns.get(ws);
  if (!c) return;
  const { room, idx } = c;
  // Rematch is voted on the end overlay — only meaningful once the game is over.
  if (!started(room) || !room.over) return;

  room.rematch[idx] = true;
  if (room.rematch[0] && room.rematch[1]) {
    for (const pl of room.players) {
      pl.ps = new PlayerState();
      pl.ps.luck = makeLuck(); // fresh tape per game (fresh room.shared below)
      pl.ps.claimMode = room.claim;
      pl.hold = emptyHold();
    }
    room.shared = makeShared();
    room.over = false;
    room.lastRoll = null;
    room.rematch = [false, false];
    room.sudden = null;
    room.upperAwarded = false;
    // starter alternates in a Classic Duel; seq keeps climbing (never reset).
    room.starter = room.mode === 1 && !room.claim ? 1 - room.starter : room.starter;
    room.turn = room.claim ? null : room.starter;
  }
  push(room);
}

function handleClose(ws) {
  const c = conns.get(ws);
  if (!c) return;
  const { room } = c;
  rooms.delete(room.code);
  for (const pl of room.players) {
    if (pl.ws !== ws) send(pl.ws, { t: 'oppLeft' });
    conns.delete(pl.ws);
  }
}

// ---------------------------------------------------------------------------
// Connection wiring
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // malformed JSON — silently ignore
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'create':
        handleCreate(ws, msg);
        break;
      case 'join':
        handleJoin(ws, msg);
        break;
      case 'roll':
        handleRoll(ws, msg);
        break;
      case 'hold':
        handleHold(ws, msg);
        break;
      case 'score':
        handleScore(ws, msg);
        break;
      case 'rematch':
        handleRematch(ws);
        break;
      default:
        break; // unknown message type — silently ignore
    }
  });

  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {}); // swallow socket errors; 'close' handles cleanup
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Yahtzee Duel server listening on http://localhost:${PORT}`);
});
