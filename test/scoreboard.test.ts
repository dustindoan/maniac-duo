import { afterAll, describe, expect, test } from 'bun:test';
import { createServer } from '../src/server/main';
import type { CreateGameResponse, GameSummary, ScoreRow } from '../src/server/protocol';
import { MAX_POINTS } from '../src/score/table';

const { server, relays } = createServer({ port: 0, dbPath: ':memory:', webRoot: '/nonexistent', limits: { createBurst: 100 } });
const base = `http://localhost:${server.port}`;
afterAll(() => {
  server.stop(true);
});

async function game(kids = ['bernard', 'michael']) {
  const r = (await (await fetch(`${base}/api/games`, { method: 'POST', body: JSON.stringify({ kids, romCrc: 1 }) })).json()) as CreateGameResponse;
  const ws = new WebSocket(`ws://localhost:${server.port}/api/play?token=${r.seats[0].token}`);
  await new Promise((ok) => (ws.onopen = ok));
  // Let the clock run a little, so milestones have ticks to be at.
  while ((relays.get(r.game.id)?.tick ?? 0) < 10) await Bun.sleep(20);
  const report = async (reached: { id: string; tick: number }[]) => {
    ws.send(JSON.stringify({ type: 'score', reached }));
    await Bun.sleep(80);
  };
  return { ...r, ws, report };
}

const board = async () => (await (await fetch(`${base}/api/scores`)).json()) as ScoreRow[];

describe('high-score board', () => {
  test('the server works out the points from the milestones reported, and keeps the best', async () => {
    const g = await game();
    await g.report([
      { id: 'item:55', tick: 2 },
      { id: 'door', tick: 3 },
    ]);
    let row = (await board()).find((r) => r.game === g.game.id)!;
    expect([row.points, row.won]).toEqual([125, false]);
    // After a restart the new run scores less: the board keeps the best.
    await g.report([{ id: 'item:55', tick: 9 }]);
    row = (await board()).find((r) => r.game === g.game.id)!;
    expect(row.points).toBe(125);
    await g.report([
      { id: 'item:55', tick: 2 },
      { id: 'door', tick: 3 },
      { id: 'won', tick: 9 },
    ]);
    row = (await board()).find((r) => r.game === g.game.id)!;
    expect([row.points, row.won]).toEqual([2625, true]);
    g.ws.close();
  });

  test('forged reports are ignored: unknown milestones, repeats, and ticks not reached yet', async () => {
    const g = await game();
    await g.report([{ id: 'item:46', tick: 1 }]); // a CD player: not an item
    await g.report([{ id: 'won', tick: 1 }, { id: 'won', tick: 2 }]);
    await g.report([{ id: 'won', tick: 1_000_000 }]);
    expect((await board()).some((r) => r.game === g.game.id)).toBe(false);
    g.ws.close();
  });

  test('initials name each seat on the board; a summary shows milestones but no seat links', async () => {
    const g = await game(['wendy', 'jeff']);
    await g.report([{ id: 'police', tick: 5 }]);
    const set = (token: string, initials: string) => fetch(`${base}/api/initials?token=${token}`, { method: 'POST', body: JSON.stringify({ initials }) });
    expect((await set(g.seats[0].token, 'dmd')).status).toBe(200);
    expect((await set(g.seats[1].token, 'TOOLONG')).status).toBe(400);
    expect((await set(g.seats[1].token, 'j3')).status).toBe(400);
    expect((await set('nope', 'ABC')).status).toBe(404);
    const row = (await board()).find((r) => r.game === g.game.id)!;
    expect(row.initials).toEqual(['DMD', '']);
    expect(row.kids).toEqual(['wendy', 'jeff']);

    const res = await fetch(`${base}/api/games/${g.game.id}/summary`);
    const text = await res.text();
    const s = JSON.parse(text) as GameSummary;
    expect([s.points, s.max, s.reached]).toEqual([400, MAX_POINTS, [{ id: 'police', tick: 5 }]]);
    for (const seat of g.seats) expect(text).not.toContain(seat.token);
    expect((await fetch(`${base}/api/games/nope/summary`)).status).toBe(404);
    g.ws.close();
  });

  test('the board is best first', async () => {
    const rows = await board();
    expect(rows.map((r) => r.points)).toEqual([...rows.map((r) => r.points)].sort((a, b) => b - a));
  });
});
