// Load test for the relay: how many games can it run at once?
//
//   bun tools/loadtest.ts --url http://127.0.0.1:8790 --stages 100,200,400 --hold 20 [--pid <relay pid>]
//
// Each simulated game creates itself over the API and connects two players, who send moves a
// little faster than real players do on average (real: about 1.3 a second per game) and share a
// world fingerprint every 60 ticks, as clients do. The target must allow that many games to be
// created: start it with LIMITS='{"createBurst":100000,"createPerHour":100000,"activeGames":100000,"socketsPerAddress":100000}'.
//
// Each stage adds games up to its count, settles, then measures for --hold seconds:
//   ticks/s   per client (the relay's clock is 15 Hz; below that it's falling behind)
//   gap p99   the 99th-percentile time between ticks a client receives (66 ms when healthy)
//   move p50/p99  time from sending a move to receiving it back in a tick (up to 66 ms by design)
//   relay cpu/rss with --pid, sampled with ps (same machine only)
//   gen lag   this generator's own event-loop delay: if it's high, the numbers above are its fault

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const URL_ = arg('url', 'http://127.0.0.1:8787');
const WS_URL = URL_.replace(/^http/, 'ws');
const STAGES = arg('stages', '25,50,100').split(',').map(Number);
const HOLD = Number(arg('hold', '20')) * 1000;
const PID = arg('pid', '');
const TICK_MS = 1000 / 15;

interface Client {
  ws: WebSocket;
  player: number;
  ticks: number[];
  sent: Map<string, number>;
  latencies: number[];
  timer?: ReturnType<typeof setTimeout>;
  open: boolean;
}

const clients: Client[] = [];
let seq = 0;
let failures = 0;

async function addGame() {
  const res = await fetch(`${URL_}/api/games`, { method: 'POST', body: JSON.stringify({ kids: ['bernard', 'michael'], romCrc: 1 }) });
  if (res.status !== 201) throw new Error(`create: ${res.status} ${await res.text()}`);
  const { seats } = (await res.json()) as { seats: { player: number; token: string }[] };
  await Promise.all(seats.map((s) => connect(s.player, s.token)));
}

function connect(player: number, token: string) {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/api/play?token=${token}`);
    const c: Client = { ws, player, ticks: [], sent: new Map(), latencies: [], open: false };
    ws.onopen = () => {
      c.open = true;
      clients.push(c);
      act(c);
      resolve();
    };
    ws.onerror = () => {
      failures++;
      reject(new Error('connect failed'));
    };
    ws.onclose = () => {
      c.open = false;
      clearTimeout(c.timer);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type !== 'tick') return;
      const now = performance.now();
      c.ticks.push(now);
      if (c.ticks.length > 2000) c.ticks.splice(0, 1000);
      for (const [p, cmd] of msg.cmds as [number, { type: string; x?: number; y?: number }][]) {
        if (p !== player || cmd.type !== 'walk') continue;
        const k = `${cmd.x},${cmd.y}`;
        const t = c.sent.get(k);
        if (t !== undefined) {
          c.latencies.push(now - t);
          c.sent.delete(k);
        }
      }
      if (msg.tick % 60 === 0) ws.send(JSON.stringify({ type: 'hash', tick: msg.tick, hash: 'c0ffee' }));
    };
  });
}

/** A player: every 0.7-2 s, a walk (timed), a stop, or a sentence. */
function act(c: Client) {
  c.timer = setTimeout(
    () => {
      if (!c.open) return;
      const r = Math.random();
      if (r < 0.55) {
        const x = (seq = (seq + 1) % 60000);
        const y = Math.floor(Math.random() * 128);
        c.sent.set(`${x},${y}`, performance.now());
        c.ws.send(JSON.stringify({ type: 'cmd', cmd: { type: 'walk', x, y } }));
      } else if (r < 0.9) c.ws.send(JSON.stringify({ type: 'cmd', cmd: { type: 'stop' } }));
      else c.ws.send(JSON.stringify({ type: 'cmd', cmd: { type: 'sentence', verb: 13, a: 100 } }));
      act(c);
    },
    700 + Math.random() * 1300,
  );
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function relayUsage(): Promise<string> {
  if (!PID) return '';
  const out = await new Response(Bun.spawn(['ps', '-o', '%cpu=,rss=', '-p', PID]).stdout).text();
  const [cpu, rss] = out.trim().split(/\s+/).map(Number);
  return `  relay cpu ${cpu.toFixed(0)}% rss ${(rss / 1024).toFixed(0)} MB`;
}

async function measure(games: number) {
  for (const c of clients) {
    c.ticks = [];
    c.latencies = [];
  }
  // The generator's own event-loop lag, sampled every 100 ms.
  const lags: number[] = [];
  let expect = performance.now() + 100;
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expect));
    expect = now + 100;
  }, 100);
  const start = performance.now();
  const usage: string[] = [];
  while (performance.now() - start < HOLD) {
    await Bun.sleep(Math.min(5000, HOLD));
    usage.push(await relayUsage());
  }
  clearInterval(lagTimer);
  const secs = (performance.now() - start) / 1000;
  const live = clients.filter((c) => c.open);
  const rates = live.map((c) => c.ticks.length / secs);
  const gaps = live.flatMap((c) => c.ticks.slice(1).map((t, i) => t - c.ticks[i]));
  const lat = live.flatMap((c) => c.latencies);
  console.log(
    `games ${String(games).padStart(5)}  clients ${String(live.length).padStart(5)}  ticks/s ${pct(rates, 50).toFixed(1)} (min ${Math.min(...rates).toFixed(1)})` +
      `  gap p99 ${pct(gaps, 99).toFixed(0)} ms  move p50 ${pct(lat, 50).toFixed(0)} p99 ${pct(lat, 99).toFixed(0)} ms` +
      `${usage.at(-1) ?? ''}  gen lag p99 ${pct(lags, 99).toFixed(0)} ms  failures ${failures}`,
  );
  return { rate: pct(rates, 50), gap99: pct(gaps, 99), lat99: pct(lat, 99) };
}

console.log(`load test against ${URL_}: stages ${STAGES.join(', ')}, ${HOLD / 1000} s each (tick ${TICK_MS.toFixed(0)} ms)`);
let games = 0;
for (const target of STAGES) {
  while (games < target) {
    const batch = Math.min(20, target - games);
    const results = await Promise.allSettled(Array.from({ length: batch }, () => addGame()));
    for (const r of results) if (r.status === 'rejected') console.error((r.reason as Error).message);
    games += results.filter((r) => r.status === 'fulfilled').length;
    if (results.every((r) => r.status === 'rejected')) break;
  }
  await Bun.sleep(3000);
  const m = await measure(games);
  if (m.rate < 14 || m.lat99 > 500) {
    console.log('the relay is falling behind; stopping');
    break;
  }
}
for (const c of clients) c.ws.close();
await Bun.sleep(500);
process.exit(0);

export {};
