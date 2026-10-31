import { afterAll, describe, expect, test } from 'bun:test';
import { Bucket, clientAddress } from '../src/server/limits';
import { createServer } from '../src/server/main';
import type { CreateGameResponse, ServerMessage, Stats } from '../src/server/protocol';
import { Store } from '../src/server/store';

const limits = { createBurst: 3, msgBurst: 10, msgPerSecond: 1, maxLog: 25, activeGames: 2, maxMessage: 1024 };
const { server, store } = createServer({ port: 0, dbPath: ':memory:', webRoot: '/nonexistent', limits });
const base = `http://localhost:${server.port}`;
afterAll(() => {
  server.stop(true);
});

const create = (kids = ['bernard', 'michael']) => fetch(`${base}/api/games`, { method: 'POST', body: JSON.stringify({ kids, romCrc: 1 }) });
const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await Bun.sleep(10);
  }
};

function connect(token: string) {
  const ws = new WebSocket(`ws://localhost:${server.port}/api/play?token=${token}`);
  const msgs: ServerMessage[] = [];
  let closed = false;
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  ws.onclose = () => (closed = true);
  const opened = new Promise<boolean>((r) => {
    ws.onopen = () => r(true);
    ws.onerror = () => r(false);
  });
  return { ws, msgs, opened, isClosed: () => closed };
}

describe('limits', () => {
  test('a bucket gives a burst, then refills at its rate', () => {
    const b = new Bucket(2, 1000, 0);
    expect([b.take(0), b.take(0), b.take(0)]).toEqual([true, true, false]);
    expect(b.take(999)).toBe(false);
    expect(b.take(1000)).toBe(true);
  });

  test("only the box's own front may say who the visitor is", () => {
    const req = new Request('http://x/', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    expect(clientAddress(req, '127.0.0.1')).toBe('203.0.113.9');
    expect(clientAddress(req, '198.51.100.4')).toBe('198.51.100.4');
    expect(clientAddress(new Request('http://x/'), '127.0.0.1')).toBe('127.0.0.1');
  });

  // The games below come out of this address's three creations; keep the order.
  let seats: CreateGameResponse['seats'] = [];

  test('seat 1 can always get the invite for seat 2; seat 2 gets none', async () => {
    const r = (await (await create()).json()) as CreateGameResponse;
    seats = r.seats;
    const one = await (await fetch(`${base}/api/games/${r.game.id}?token=${seats[0].token}`)).json();
    const two = await (await fetch(`${base}/api/games/${r.game.id}?token=${seats[1].token}`)).json();
    expect(one.invite).toBe(seats[1].token);
    expect(two.invite).toBeUndefined();
    const byToken = await (await fetch(`${base}/api/seat?token=${seats[1].token}`)).json();
    expect([byToken.game.id, byToken.player]).toEqual([r.game.id, 2]);
    expect((await fetch(`${base}/api/seat?token=nope`)).status).toBe(404);
  });

  test('a seat has one connection: a new one takes over', async () => {
    const a = connect(seats[0].token);
    expect(await a.opened).toBe(true);
    const b = connect(seats[0].token);
    expect(await b.opened).toBe(true);
    await until(a.isClosed);
    expect(a.msgs.some((m) => m.type === 'error' && m.message.includes('opened somewhere else'))).toBe(true);
    expect(b.isClosed()).toBe(false);
    b.ws.close();
  });

  test('messages beyond the rate are dropped', async () => {
    const r = (await (await create()).json()) as CreateGameResponse;
    const p = connect(r.seats[0].token);
    await p.opened;
    for (let i = 0; i < 40; i++) p.ws.send(JSON.stringify({ type: 'cmd', cmd: { type: 'stop' } }));
    await Bun.sleep(300);
    expect(store.logLength(r.game.id)).toBe(10);
    p.ws.close();
  });

  test("a game's log stops at its cap", async () => {
    const other = createServer({ port: 0, dbPath: ':memory:', webRoot: '/nonexistent', limits: { msgBurst: 100, maxLog: 25 } });
    try {
      const res = await fetch(`http://localhost:${other.server.port}/api/games`, { method: 'POST', body: JSON.stringify({ kids: ['wendy', 'jeff'], romCrc: 1 }) });
      const r = (await res.json()) as CreateGameResponse;
      const ws = new WebSocket(`ws://localhost:${other.server.port}/api/play?token=${r.seats[0].token}`);
      await new Promise((ok) => (ws.onopen = ok));
      for (let i = 0; i < 40; i++) ws.send(JSON.stringify({ type: 'cmd', cmd: { type: 'stop' } }));
      await Bun.sleep(300);
      expect(other.store.logLength(r.game.id)).toBe(25);
      ws.close();
    } finally {
      other.server.stop(true);
    }
  });

  test('an oversized message ends the connection', async () => {
    const p = connect(seats[1].token);
    await p.opened;
    p.ws.send(JSON.stringify({ type: 'cmd', cmd: { type: 'stop' }, pad: 'x'.repeat(2000) }));
    await until(p.isClosed);
  });

  test('an address may create only so many games at once', async () => {
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(429);
  });

  test('beyond the number of games being played at once, a new one has to wait', async () => {
    const one = connect(seats[0].token);
    const fresh = store.db.query("SELECT token FROM seats WHERE player = 1 AND game_id NOT IN (SELECT game_id FROM seats WHERE token = ?) ORDER BY rowid LIMIT 2").all(seats[0].token) as { token: string }[];
    const two = connect(fresh[0].token);
    expect(await one.opened).toBe(true);
    expect(await two.opened).toBe(true);
    await Bun.sleep(100);
    const stats = (await (await fetch(`${base}/api/stats`)).json()) as Stats;
    expect(stats).toEqual({ playing: 2, players: 2 });
    const three = connect(fresh[1].token);
    expect(await three.opened).toBe(false);
    // A seat of a game already being played still gets in.
    const partner = connect(seats[1].token);
    expect(await partner.opened).toBe(true);
    for (const c of [one, two, partner]) c.ws.close();
  });

  test('games nobody joined are deleted after a while; played ones stay', () => {
    const s = new Store(':memory:');
    const game = (id: string, createdAt: number) => ({ id, kids: ['bernard', 'michael'] as ['bernard', 'michael'], seed: 1, romCrc: 1, rules: 1, createdAt });
    s.createGame(game('old', 0), [{ player: 1, kid: 'bernard', token: 'a' }]);
    s.createGame(game('played', 0), [{ player: 1, kid: 'bernard', token: 'b' }]);
    s.createGame(game('new', Date.now()), [{ player: 1, kid: 'bernard', token: 'c' }]);
    s.setTick('played', 40);
    expect(s.deleteUnjoined(Date.now() - 1000)).toBe(1);
    expect(s.game('old')).toBeNull();
    expect(s.seatByToken('a')).toBeNull();
    expect(s.game('played')).not.toBeNull();
    expect(s.game('new')).not.toBeNull();
  });
});
