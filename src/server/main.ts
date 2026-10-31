// HTTP + WebSocket relay. Serves the web client from dist/web and the game API under /api.
//
//   POST /api/games                 {kids, romCrc} -> {game, seats}   (one join token per player)
//   GET  /api/games/:id?token=…     game info for a seat holder (seat 1 also gets seat 2's invite)
//   GET  /api/seat?token=…          the same, from the token alone (what an invite link carries)
//   GET  /api/stats                 {playing, players}: games being played now, and players online
//   GET  /api/scores                the high-score board: [{game, kids, initials, points, won, minutes, at}]
//   GET  /api/games/:id/summary     one game on the board: its score and the milestones reached
//   POST /api/initials?token=…      {initials} for this seat's name on the board (1-3 letters)
//   WS   /api/play?token=…          join your seat: welcome (log + tick), then tick/presence messages;
//                                   send cmd, hash, and score (the milestones reached, src/score)
//
// The server never receives or stores ROM data. limits.ts keeps a public relay from being swamped.

import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { RULES } from '../story';
import { Bucket, Buckets, DEFAULT_LIMITS, type Limits, clientAddress } from './limits';
import { type ClientMessage, type CreateGameResponse, type GameInfo, type Seat, type SeatInfo, type ServerMessage, type Stats, parseCommand, parseCreate, parseHash, parseInitials, parseScore } from './protocol';
import { type Peer, Relay } from './relay';
import { Store } from './store';

const token = () => randomBytes(16).toString('base64url');
const gameId = () => randomBytes(6).toString('base64url');

interface SocketData {
  gameId: string;
  player: number;
  address: string;
  peer?: Peer;
  bucket?: Bucket;
}

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  webRoot?: string;
  /** Development only: serve this local ROM to pages on localhost that ask with ?devrom. Never set in production. */
  devRomPath?: string;
  /** Override abuse limits (tests and load tests). */
  limits?: Partial<Limits>;
}

export function createServer({ port = 8787, dbPath = 'data/games.sqlite', webRoot = 'dist/web', devRomPath, limits: overrides }: ServerOptions = {}) {
  const limits: Limits = { ...DEFAULT_LIMITS, ...overrides };
  const store = new Store(dbPath);
  const relays = new Map<string, Relay>();
  const relayFor = (id: string) => {
    let r = relays.get(id);
    if (!r) relays.set(id, (r = new Relay(id, store, store.game(id)!.tick, limits.maxLog)));
    return r;
  };
  const creates = new Buckets(limits.createBurst, limits.createEveryMs);
  const allCreates = new Bucket(limits.createPerHour, 3_600_000 / limits.createPerHour);
  const sockets = new Map<string, number>();
  const playing = () => [...relays.values()].filter((r) => r.peers.size > 0);
  const dbBytes = () => [dbPath, `${dbPath}-wal`].reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0);

  // Games nobody ever joined: once at start, then hourly.
  const sweep = () => store.deleteUnjoined(Date.now() - limits.unjoinedTtlMs);
  sweep();
  setInterval(sweep, 3_600_000).unref();

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const server = Bun.serve<SocketData, never>({
    port,
    maxRequestBodySize: 64 * 1024,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const address = clientAddress(req, srv.requestIP(req)?.address);
      if (url.pathname === '/api/games' && req.method === 'POST') {
        const body = parseCreate(await req.json().catch(() => null));
        if (!body) return json({ error: 'expected {kids: [kid, kid], romCrc}' }, 400);
        if (!creates.take(address)) return json({ error: "You've created a lot of games just now. Try again in a few minutes." }, 429);
        if (dbPath !== ':memory:' && dbBytes() > limits.maxDbBytes) return json({ error: 'This server is full. Try again later.' }, 503);
        if (!allCreates.take()) return json({ error: 'Lots of games are being created right now. Try again in a few minutes.' }, 503);
        const game: GameInfo = { id: gameId(), kids: body.kids, seed: randomBytes(4).readUInt32LE() || 1, romCrc: body.romCrc, rules: RULES, createdAt: Date.now() };
        const seats: Seat[] = body.kids.map((kid, i) => ({ player: i + 1, kid, token: token() }));
        store.createGame(game, seats);
        return json({ game, seats } satisfies CreateGameResponse, 201);
      }
      const m = url.pathname.match(/^\/api\/games\/([\w-]+)$/);
      if ((m || url.pathname === '/api/seat') && req.method === 'GET') {
        const seat = store.seatByToken(url.searchParams.get('token') ?? '');
        if (!seat || (m && seat.gameId !== m[1])) return json({ error: 'unknown game or token' }, 404);
        const game = store.game(seat.gameId)!;
        const invite = seat.player === 1 ? store.seatToken(seat.gameId, 2) : null;
        return json({ game, player: seat.player, online: relays.get(seat.gameId)?.online() ?? [], ...(invite && { invite }) } satisfies SeatInfo);
      }
      if (url.pathname === '/api/scores' && req.method === 'GET') return json(store.topScores(10));
      const sm = url.pathname.match(/^\/api\/games\/([\w-]+)\/summary$/);
      if (sm && req.method === 'GET') {
        const summary = store.summary(sm[1]);
        return summary ? json(summary) : json({ error: 'unknown game' }, 404);
      }
      if (url.pathname === '/api/initials' && req.method === 'POST') {
        const seat = store.seatByToken(url.searchParams.get('token') ?? '');
        if (!seat) return json({ error: 'unknown token' }, 404);
        const initials = parseInitials(await req.json().catch(() => null));
        if (!initials) return json({ error: 'one to three letters' }, 400);
        store.setInitials(seat.gameId, seat.player, initials);
        return json({ initials });
      }
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        const now = playing();
        return json({ playing: now.length, players: now.reduce((n, r) => n + r.online().length, 0) } satisfies Stats);
      }
      if (url.pathname === '/api/play') {
        const seat = store.seatByToken(url.searchParams.get('token') ?? '');
        if (!seat) return json({ error: 'unknown token' }, 401);
        if ((sockets.get(address) ?? 0) >= limits.socketsPerAddress) return json({ error: 'too many connections' }, 429);
        if (!relays.get(seat.gameId)?.peers.size && playing().length >= limits.activeGames) return json({ error: 'busy' }, 503);
        if (srv.upgrade(req, { data: { gameId: seat.gameId, player: seat.player, address } })) return undefined;
        return json({ error: 'expected a websocket' }, 426);
      }
      if (url.pathname === '/dev/rom' && devRomPath && ['localhost', '127.0.0.1'].includes(url.hostname)) return new Response(Bun.file(devRomPath));
      return serveStatic(webRoot, url.pathname);
    },
    websocket: {
      maxPayloadLength: limits.maxMessage,
      open(ws: ServerWebSocket<SocketData>) {
        sockets.set(ws.data.address, (sockets.get(ws.data.address) ?? 0) + 1);
        ws.data.bucket = new Bucket(limits.msgBurst, 1000 / limits.msgPerSecond);
        const peer: Peer = {
          player: ws.data.player,
          send: (msg: ServerMessage) => ws.send(JSON.stringify(msg)),
          close: (reason) => {
            ws.send(JSON.stringify({ type: 'error', message: reason } satisfies ServerMessage));
            ws.close(4000, 'replaced');
          },
        };
        ws.data.peer = peer;
        relayFor(ws.data.gameId).join(peer);
      },
      message(ws, raw) {
        if (!ws.data.bucket?.take()) return;
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg?.type === 'score') {
          // The browser runs the game, so it reports the score; the table decides what it's worth.
          // A milestone from a tick the clock hasn't reached yet is a forgery.
          const s = parseScore(msg);
          const relay = relays.get(ws.data.gameId);
          if (s && relay && s.reached.every((m) => m.tick <= relay.tick)) store.saveScore(ws.data.gameId, s.points, s.reached, s.won);
          return;
        }
        if (msg?.type === 'hash') {
          const h = parseHash(msg);
          if (h) relays.get(ws.data.gameId)?.shareHash(ws.data.player, h.tick, h.hash);
          return;
        }
        if (msg?.type !== 'cmd') return;
        const cmd = parseCommand(msg.cmd, ws.data.player);
        if (cmd) relayFor(ws.data.gameId).submit(ws.data.player, cmd);
      },
      close(ws) {
        const n = (sockets.get(ws.data.address) ?? 1) - 1;
        if (n > 0) sockets.set(ws.data.address, n);
        else sockets.delete(ws.data.address);
        const r = relays.get(ws.data.gameId);
        if (!r || !ws.data.peer) return;
        r.leave(ws.data.peer);
        // Nobody left: the clock has stopped and the tick is stored; the next join loads it again.
        if (r.peers.size === 0) relays.delete(ws.data.gameId);
      },
    },
  });
  return { server, store, relays };
}

async function serveStatic(root: string, path: string): Promise<Response> {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, rel);
  if (!existsSync(file) || !rel.includes('.')) file = join(root, 'index.html');
  if (!existsSync(file)) return new Response('Build the client first: bun run build:web', { status: 404 });
  return new Response(Bun.file(file));
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const { mkdirSync } = await import('node:fs');
  mkdirSync('data', { recursive: true });
  // LIMITS: JSON overriding limits.ts, e.g. '{"activeGames": 500}' (load tests raise the creation limits).
  const limits = process.env.LIMITS ? (JSON.parse(process.env.LIMITS) as Partial<Limits>) : undefined;
  createServer({ port, dbPath: process.env.DB_PATH ?? 'data/games.sqlite', devRomPath: process.env.MANIAC_DEV_ROM, limits });
  console.log(`maniac-duo relay on http://localhost:${port}`);
}
