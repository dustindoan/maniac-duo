// HTTP + WebSocket relay. Serves the web client from dist/web and the game API under /api.
//
//   POST /api/games                 {kids, romCrc} -> {game, seats}   (one join token per player)
//   GET  /api/games/:id?token=…     game info for a seat holder
//   WS   /api/play?token=…          join your seat: welcome (log + tick), then tick/presence messages
//
// The server never receives or stores ROM data.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { type ClientMessage, type CreateGameResponse, type GameInfo, type Seat, type ServerMessage, parseCommand, parseCreate, parseHash } from './protocol';
import { type Peer, Relay } from './relay';
import { Store } from './store';

const token = () => randomBytes(16).toString('base64url');
const gameId = () => randomBytes(6).toString('base64url');

interface SocketData {
  gameId: string;
  player: number;
  peer?: Peer;
}

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  webRoot?: string;
  /** Development only: serve this local ROM to pages on localhost that ask with ?devrom. Never set in production. */
  devRomPath?: string;
}

export function createServer({ port = 8787, dbPath = 'data/games.sqlite', webRoot = 'dist/web', devRomPath }: ServerOptions = {}) {
  const store = new Store(dbPath);
  const relays = new Map<string, Relay>();
  const relayFor = (id: string) => {
    let r = relays.get(id);
    if (!r) relays.set(id, (r = new Relay(id, store, store.game(id)!.tick)));
    return r;
  };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const server = Bun.serve<SocketData, never>({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/api/games' && req.method === 'POST') {
        const body = parseCreate(await req.json().catch(() => null));
        if (!body) return json({ error: 'expected {kids: [kid, kid], romCrc}' }, 400);
        const game: GameInfo = { id: gameId(), kids: body.kids, seed: randomBytes(4).readUInt32LE() || 1, romCrc: body.romCrc, createdAt: Date.now() };
        const seats: Seat[] = body.kids.map((kid, i) => ({ player: i + 1, kid, token: token() }));
        store.createGame(game, seats);
        return json({ game, seats } satisfies CreateGameResponse, 201);
      }
      const m = url.pathname.match(/^\/api\/games\/([\w-]+)$/);
      if (m && req.method === 'GET') {
        const seat = store.seatByToken(url.searchParams.get('token') ?? '');
        if (!seat || seat.gameId !== m[1]) return json({ error: 'unknown game or token' }, 404);
        const game = store.game(m[1])!;
        return json({ game, player: seat.player, online: relays.get(m[1])?.online() ?? [] });
      }
      if (url.pathname === '/api/play') {
        const seat = store.seatByToken(url.searchParams.get('token') ?? '');
        if (!seat) return json({ error: 'unknown token' }, 401);
        if (srv.upgrade(req, { data: { gameId: seat.gameId, player: seat.player } })) return undefined;
        return json({ error: 'expected a websocket' }, 426);
      }
      if (url.pathname === '/dev/rom' && devRomPath && ['localhost', '127.0.0.1'].includes(url.hostname)) return new Response(Bun.file(devRomPath));
      return serveStatic(webRoot, url.pathname);
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        const peer: Peer = { player: ws.data.player, send: (msg: ServerMessage) => ws.send(JSON.stringify(msg)) };
        ws.data.peer = peer;
        relayFor(ws.data.gameId).join(peer);
      },
      message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
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
  createServer({ port, dbPath: process.env.DB_PATH ?? 'data/games.sqlite', devRomPath: process.env.MANIAC_DEV_ROM });
  console.log(`maniac-duo relay on http://localhost:${port}`);
}
