import { afterAll, describe, expect, test } from 'bun:test';
import { createServer } from '../src/server/main';
import type { CreateGameResponse, ServerMessage } from '../src/server/protocol';

const { server } = createServer({ port: 0, dbPath: ':memory:', webRoot: '/nonexistent' });
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
});
