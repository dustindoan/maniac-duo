import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server/main';
import type { CreateGameResponse, ServerMessage } from '../src/server/protocol';
import { Store } from '../src/server/store';
import { RULES } from '../src/story';

const { server, relays } = createServer({ port: 0, dbPath: ':memory:', webRoot: '/nonexistent' });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

function connect(token: string) {
  const ws = new WebSocket(`ws://localhost:${server.port}/api/play?token=${token}`);
  const msgs: ServerMessage[] = [];
  ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
  const opened = new Promise((r) => (ws.onopen = r));
  const until = async (pred: (m: ServerMessage[]) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred(msgs)) {
      if (Date.now() > end) throw new Error('timeout');
      await Bun.sleep(10);
    }
  };
  return { ws, msgs, opened, until };
}

describe('relay server', () => {
  test('rejects bad games and unknown tokens', async () => {
    expect((await fetch(`${base}/api/games`, { method: 'POST', body: JSON.stringify({ kids: ['bernard', 'bernard'], romCrc: 1 }) })).status).toBe(400);
    expect((await fetch(`${base}/api/play?token=nope`)).status).toBe(401);
  });

  test('two players share one ordered command stream; a late joiner gets the log', async () => {
    const res = await fetch(`${base}/api/games`, { method: 'POST', body: JSON.stringify({ kids: ['bernard', 'michael'], romCrc: 0xd9f5bd1 }) });
    expect(res.status).toBe(201);
    const { game, seats } = (await res.json()) as CreateGameResponse;
    expect(seats.map((s) => s.kid)).toEqual(['bernard', 'michael']);

    const p1 = connect(seats[0].token);
    await p1.opened;
    await p1.until((m) => m.some((x) => x.type === 'welcome'));
    const welcome = p1.msgs.find((x) => x.type === 'welcome')!;
    expect(welcome.type === 'welcome' && welcome.player).toBe(1);
    expect(game.rules).toBe(RULES);
    expect(welcome.type === 'welcome' && welcome.game.rules).toBe(RULES);

    p1.ws.send(JSON.stringify({ type: 'cmd', cmd: { type: 'walk', x: 40, y: 100 } }));
    p1.ws.send(JSON.stringify({ type: 'cmd', cmd: { type: 'sentence', verb: 14, a: 55, player: 2 } })); // player is forced to the seat's
    await p1.until((m) => m.some((x) => x.type === 'tick' && x.cmds.length === 2));
    const tick = p1.msgs.find((x) => x.type === 'tick' && x.cmds.length === 2)!;
    if (tick.type !== 'tick') throw new Error();
    expect(tick.cmds.map(([p, c]) => [p, c.type, c.player])).toEqual([[1, 'walk', 1], [1, 'sentence', 1]]);

    const p2 = connect(seats[1].token);
    await p2.opened;
    await p2.until((m) => m.some((x) => x.type === 'welcome'));
    const w2 = p2.msgs.find((x) => x.type === 'welcome')!;
    if (w2.type !== 'welcome') throw new Error();
    expect(w2.game.id).toBe(game.id);
    expect(w2.log.map(([t]) => t)).toEqual([tick.tick, tick.tick]);
    expect(w2.online).toEqual([1, 2]);

    // Ticks keep flowing to both, identically.
    const before = w2.tick;
    await p2.until((m) => m.filter((x) => x.type === 'tick').length >= 3);
    const t2 = p2.msgs.filter((x) => x.type === 'tick').map((x) => (x as { tick: number }).tick);
    expect(t2[0]).toBe(before + 1);
    p1.ws.close();
    p2.ws.close();
  });

  test('the clock stops when nobody is connected', async () => {
    const { seats } = (await (await fetch(`${base}/api/games`, { method: 'POST', body: JSON.stringify({ kids: ['wendy', 'jeff'], romCrc: 1 }) })).json()) as CreateGameResponse;
    const p = connect(seats[0].token);
    await p.opened;
    await p.until((m) => m.filter((x) => x.type === 'tick').length >= 2);
    p.ws.close();
    await Bun.sleep(150);
    const again = connect(seats[0].token);
    await again.until((m) => m.some((x) => x.type === 'welcome'));
    const w = again.msgs.find((x) => x.type === 'welcome')!;
    const lastSeen = Math.max(...p.msgs.filter((x) => x.type === 'tick').map((x) => (x as { tick: number }).tick));
    expect(w.type === 'welcome' && w.tick - lastSeen).toBeLessThanOrEqual(1);
    again.ws.close();
  });

  test("a player's world fingerprint goes to the others, not back to them", async () => {
    const { seats } = (await (await fetch(`${base}/api/games`, { method: 'POST', body: JSON.stringify({ kids: ['syd', 'razor'], romCrc: 1 }) })).json()) as CreateGameResponse;
    const [p1, p2] = seats.map((s) => connect(s.token));
    await Promise.all([p1.opened, p2.opened]);
    await p1.until((m) => m.some((x) => x.type === 'presence' && x.online.length === 2));
    p1.ws.send(JSON.stringify({ type: 'hash', tick: 60, hash: 'BAD!' }));
    p1.ws.send(JSON.stringify({ type: 'hash', tick: 60, hash: 'c0ffee' }));
    await p2.until((m) => m.some((x) => x.type === 'hash'));
    expect(p2.msgs.filter((x) => x.type === 'hash')).toEqual([{ type: 'hash', player: 1, tick: 60, hash: 'c0ffee' }]);
    await Bun.sleep(50);
    expect(p1.msgs.some((x) => x.type === 'hash')).toBe(false);
    p1.ws.close();
    p2.ws.close();
  });

  test('a game nobody is playing is dropped from memory and picks up where it was', async () => {
    const { game, seats } = (await (await fetch(`${base}/api/games`, { method: 'POST', body: JSON.stringify({ kids: ['wendy', 'syd'], romCrc: 1 }) })).json()) as CreateGameResponse;
    const p = connect(seats[0].token);
    await p.until((m) => m.filter((x) => x.type === 'tick').length >= 3);
    expect(relays.has(game.id)).toBe(true);
    p.ws.close();
    const end = Date.now() + 2000;
    while (relays.has(game.id) && Date.now() < end) await Bun.sleep(10);
    expect(relays.has(game.id)).toBe(false);
    const again = connect(seats[0].token);
    await again.until((m) => m.some((x) => x.type === 'welcome'));
    const w = again.msgs.find((x) => x.type === 'welcome')!;
    expect(w.type === 'welcome' && w.tick).toBeGreaterThanOrEqual(3);
    again.ws.close();
  });

  test('games from before rules existed keep the original story', () => {
    const path = `${tmpdir()}/maniac-rules-${process.pid}.sqlite`;
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, kids TEXT NOT NULL, seed INTEGER NOT NULL, rom_crc INTEGER NOT NULL,
      created_at INTEGER NOT NULL, tick INTEGER NOT NULL DEFAULT 0)`);
    old.query('INSERT INTO games (id, kids, seed, rom_crc, created_at) VALUES (?, ?, ?, ?, ?)').run('old', '["bernard","michael"]', 7, 1, 0);
    old.close();
    try {
      const store = new Store(path);
      expect(store.game('old')!.rules).toBe(0);
      store.createGame({ id: 'new', kids: ['wendy', 'jeff'], seed: 8, romCrc: 1, rules: RULES, createdAt: 0 }, []);
      expect(store.game('new')!.rules).toBe(RULES);
      store.db.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    }
  });
});
