// public/js/net.js
// RemoteEngine — the WebSocket client for live multiplayer (ARCHITECTURE.md §5 & §6).
//
// It exposes the SAME game interface as LocalEngine (engine.js):
//
//     roll(holdMask)   score(cat)   holdUpdate(mask)   rematch()   destroy()   luckContext()
//
// and fires opts.onState(view) for every incoming {t:'state'} message, so app.js is a
// dumb renderer that never has to know whether it is driving an AI game or a remote one.
//
// RemoteEngine additionally owns the create/join lobby handshake, which LocalEngine has no
// equivalent for:
//
//     create(name, mode)  → sends {t:'create', name, mode}; the room code arrives later as
//                           {t:'created', code} and is surfaced via opts.onCreated(code).
//     join(name, code)    → sends {t:'join', name, code}; the server replies with the first
//                           {t:'state', ...} once both players are present.
//
// Wire message types and field names are mirrored EXACTLY from server.js (§6) — do not rename.
//
// Connection: opens a WebSocket to the same origin that served the page (ws:// normally,
// wss:// when the page is https). Outgoing messages sent before the socket is OPEN are
// buffered and flushed on connect, so app.js can call create()/join() immediately after
// constructing the engine without racing the handshake.

const noop = () => {};

export class RemoteEngine {
  /**
   * @param {Object} [opts]
   * @param {(view:Object)=>void}   [opts.onState]   incoming {t:'state'} personalized view-model
   * @param {(code:string)=>void}   [opts.onCreated] room code from {t:'created'} (create flow)
   * @param {(msg:string)=>void}    [opts.onError]   server {t:'error', msg} (e.g. bad room code)
   * @param {()=>void}              [opts.onOppLeft] server {t:'oppLeft'} (opponent disconnected)
   * @param {()=>void}              [opts.onOpen]    socket connected (optional; lobby may show it)
   * @param {()=>void}              [opts.onClose]   socket closed unexpectedly (connection lost)
   * @param {string}                [opts.url]       override the derived ws:// URL (testing)
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.onState = opts.onState || noop;

    /** Room code, populated on {t:'created'}; also echoed inside every state view. */
    this.code = null;

    /** Variant (1|2|3): the server stamps `mode` on every state view. Null until the first. */
    this.mode = null;

    /**
     * This player's OWN reproducible-game context { shared, luck } for the post-game
     * "perfect play on your dice" replay (analysis.js). The server includes `luckContext`
     * on EVERY state — null while in play, { shared, luck } only in this player's own
     * end-of-game state (the opponent's luck is never transmitted). We mirror it verbatim
     * below, which both captures it at game end and clears it when a fresh game (e.g. after
     * a rematch) pushes its first in-play state — so a new game never reuses stale context.
     */
    this._luckContext = null;

    this._destroyed = false;
    /** Outgoing frames buffered while the socket is still CONNECTING. */
    this._queue = [];

    const url = opts.url || RemoteEngine.defaultUrl();
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this._onOpen();
    this.ws.onmessage = (ev) => this._onMessage(ev);
    this.ws.onerror = () => this._onError();
    this.ws.onclose = () => this._onClose();
  }

  /** ws:// (or wss:// under https) at the exact host/origin that served the page. */
  static defaultUrl() {
    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}`;
  }

  // -- Lobby handshake -------------------------------------------------------

  /** Create a room. Room code is delivered asynchronously via opts.onCreated. */
  create(name, mode) {
    this._send({ t: 'create', name, mode });
  }

  /** Join an existing room by 4-letter code. Server validates and replies with state/error. */
  join(name, code) {
    this._send({ t: 'join', name, code });
  }

  // -- Shared game interface (identical to LocalEngine) ----------------------

  /**
   * Roll the dice. `holdMask` is a bool[5] of dice to KEEP; the first roll of a round
   * ignores it server-side, so passing an empty/undefined mask there is fine.
   */
  roll(holdMask) {
    this._send({ t: 'roll', hold: holdMask });
  }

  /** Score the current dice into `cat`. Illegal categories are ignored server-side. */
  score(cat) {
    this._send({ t: 'score', cat });
  }

  /** Variant 1 only: relay the held-dice mask so the spectating opponent sees your keeps. */
  holdUpdate(mask) {
    this._send({ t: 'hold', mask });
  }

  /** Vote for a rematch on the end overlay. Server restarts once both players vote. */
  rematch() {
    this._send({ t: 'rematch' });
  }

  /**
   * This player's OWN reproducible-game context for the post-game "perfect play on your
   * dice" replay, or null until their end-of-game state has arrived. Shape mirrors
   * LocalEngine.luckContext(): { shared, luck, mode }. Only this player's luck is ever
   * present — the server never transmits the opponent's tape.
   */
  luckContext() {
    if (!this._luckContext) return null;
    return { shared: this._luckContext.shared, luck: this._luckContext.luck, mode: this.mode };
  }

  /** Tear down: close the socket and stop firing callbacks. */
  destroy() {
    this._destroyed = true;
    this._luckContext = null;
    this._queue = [];
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {
      // ignore — socket already closing/closed
    }
  }

  // -- Internals -------------------------------------------------------------

  _send(obj) {
    if (this._destroyed || !this.ws) return;
    const data = JSON.stringify(obj);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      // Still CONNECTING — buffer and flush on open.
      this._queue.push(data);
    }
  }

  _onOpen() {
    if (this._destroyed || !this.ws) return;
    const queued = this._queue;
    this._queue = [];
    for (const data of queued) this.ws.send(data);
    (this.opts.onOpen || noop)();
  }

  _onMessage(ev) {
    if (this._destroyed) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // malformed JSON — ignore
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'state':
        // Echo the room code so app.js can read it off the engine at any time.
        if (msg.code) this.code = msg.code;
        // Track the variant (stamped on every state) so luckContext() can report it.
        if (msg.mode) this.mode = msg.mode;
        // Mirror the server's luckContext verbatim: { shared, luck } in this player's own
        // end-of-game state, null otherwise. Storing it on every state (a) captures it at
        // game end and (b) auto-resets it to null on a fresh game's first in-play state,
        // so a new game (e.g. after a rematch) never reuses the finished game's context.
        this._luckContext = msg.luckContext || null;
        this.onState(msg);
        break;
      case 'created':
        this.code = msg.code;
        (this.opts.onCreated || noop)(msg.code);
        break;
      case 'error':
        (this.opts.onError || noop)(msg.msg);
        break;
      case 'oppLeft':
        (this.opts.onOppLeft || noop)();
        break;
      default:
        break; // unknown type — ignore
    }
  }

  _onError() {
    if (this._destroyed) return;
    // Raw socket error (e.g. server unreachable). Distinct from server {t:'error'} messages.
    (this.opts.onError || noop)('Connection error.');
  }

  _onClose() {
    if (this._destroyed) return;
    // Unexpected socket close (server gone / network dropped). oppLeft, when applicable,
    // has already fired via its own message before the server closed the socket.
    this.ws = null;
    (this.opts.onClose || noop)();
  }
}

export default RemoteEngine;
