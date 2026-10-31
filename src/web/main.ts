// Browser client: your ROM stays local; the game runs here; the server only orders commands.
import { Lockstep, stateHash } from '../engine/lockstep';
import type { Command, KidName } from '../engine/session';
import { surface, toRGBA } from '../gfx/nes';
import { FRAME_H, FRAME_W, ViewRenderer } from '../gfx/view';
import { crc32 } from '../rom/crc32';
import { type Rom, identify, loadRom, stripHeader } from '../rom/rom';
import { RULES } from '../story';
import type { CreateGameResponse, GameSummary, ScoreRow, SeatInfo, ServerMessage, Stats } from '../server/protocol';
import type { Milestone } from '../score/scorer';
import { MAX_POINTS } from '../score/table';
import { renderBoard, renderSummary } from './board';
import { TICK_HZ } from '../server/protocol';
import { AudioOut } from './audio';
import { Footfalls } from './footsteps';
import { Voices } from './voices';
import { type Button, type Pad, PlayerUI } from './player-ui';
import { forgetRom, loadStoredRom, storeRom } from './rom-store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let rom: Rom | null = null;
let romCrc = 0;

type Screen = 'home' | 'gamepage' | 'summary' | 'game';

function show(screen: Screen) {
  for (const s of ['home', 'gamepage', 'summary', 'game']) $(s).hidden = s !== screen;
  // While playing, the screen takes the whole window.
  document.body.classList.toggle('playing', screen === 'game');
}

function setMessage(id: string, text: string) {
  $(id).textContent = text;
}

// Touch screens get buttons for what the keyboard does (Items, Skip, Mute) and their own hints.
const touch = () => document.body.classList.contains('touch');
if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');
window.addEventListener('pointerdown', (ev) => ev.pointerType === 'touch' && document.body.classList.add('touch'));

// ------------------------------------------------------------------ ROM

async function acceptRom(bytes: Uint8Array): Promise<boolean> {
  if (identify(bytes) !== 'USA') {
    setMessage('rom-error', "That isn't the Maniac Mansion (USA) NES ROM this needs.");
    return false;
  }
  rom = loadRom(bytes);
  romCrc = crc32(stripHeader(bytes));
  await storeRom(stripHeader(bytes));
  return true;
}

/** Your ROM, if this browser has it (or, in development, the server's local one). */
async function loadRomQuietly(): Promise<boolean> {
  if (rom) return true;
  const stored = await loadStoredRom();
  if (stored && (await acceptRom(stored))) return true;
  if (new URLSearchParams(location.search).has('devrom')) {
    const res = await fetch('/dev/rom').catch(() => null);
    if (res?.ok && (await acceptRom(new Uint8Array(await res.arrayBuffer())))) return true;
  }
  return false;
}

/** Ask for the ROM where it's needed (the front page, or a game page), until a good one is given. */
function askForRom(where: HTMLElement, before: HTMLElement | null = null): Promise<void> {
  const box = $('rom');
  where.insertBefore(box, before);
  box.hidden = false;
  return new Promise<void>((resolve) => {
    const take = async (f: File | undefined) => {
      if (f && (await acceptRom(new Uint8Array(await f.arrayBuffer())))) {
        box.hidden = true;
        resolve();
      }
    };
    $<HTMLInputElement>('rom-file').onchange = (ev) => take((ev.target as HTMLInputElement).files?.[0]);
    const drop = $('rom-drop');
    drop.ondragover = (ev) => ev.preventDefault();
    drop.ondrop = (ev) => {
      ev.preventDefault();
      take(ev.dataTransfer?.files[0]);
    };
  });
}

// ------------------------------------------------------------------ game

interface Controls {
  /** Players driven from this device, in keyboard-scheme order. */
  local: number[];
  send: (cmd: Command) => void;
}

class GameView {
  ls: Lockstep;
  uis: PlayerUI[];
  renderer: ViewRenderer;
  audio = new AudioOut();
  private footfalls = new Footfalls();
  private voices = new Voices(() => this.audio.muted);
  online = new Set<number>([1, 2]);
  /** World fingerprints every 60 ticks: two clients of one game must agree (desync check). */
  hashes = new Map<number, string>();
  /** Fingerprints other players reported, for ticks this client hasn't reached yet. */
  private theirs = new Map<number, string>();
  /** Called with this client's fingerprint, to share it (online games). */
  onHash: (tick: number, hash: string) => void = () => {};
  /** Called with every milestone reached so far whenever one is added (online games: the board). */
  onScore: (reached: Milestone[]) => void = () => {};
  private reported = -1;
  /** Called once if another client's world differs from this one. */
  onDesync: (tick: number) => void = () => {};
  private desynced = false;
  private surf = surface(FRAME_W, FRAME_H);
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private keys = new Set<string>();
  /** Restarts seen, to reset the interface when the game starts over. */
  private restarts = 0;

  constructor(
    public kids: KidName[],
    seed: number,
    rules: number,
    public controls: Controls,
  ) {
    this.ls = new Lockstep(rom!, { kids, seed, rules });
    this.renderer = new ViewRenderer(rom!);
    this.uis = [1, 2].map((p) => new PlayerUI(p, () => this.ls.session, controls.send));
    const canvas = $<HTMLCanvasElement>('screen');
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    this.ctx = canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(FRAME_W, FRAME_H);
    this.bindInput(canvas);
    requestAnimationFrame(this.frame);
    // Handy in the browser console: maniac.ls.session.engine, maniac.uis[0].options, ...
    (globalThis as unknown as { maniac: GameView }).maniac = this;
  }

  isLocal(p: number) {
    return this.controls.local.includes(p);
  }

  /** Advance one tick: gather pads, let local UIs emit commands, run the engine frame. */
  advance(t: number, cmds: Command[]) {
    this.ls.advance(t, cmds);
    this.reportScore();
    if (this.ls.session.restarts !== this.restarts) {
      this.restarts = this.ls.session.restarts;
      for (const ui of this.uis) ui.reset();
    }
    this.audio.play(this.ls.session.engine.sound.out);
    for (const f of this.footfalls.update(this.ls.session, this.controls.local)) this.audio.footstep(f.foot);
    this.voices.update(this.ls.session, this.controls.local);
    if (t % 60 === 0) {
      const h = stateHash(this.ls.session);
      this.hashes.set(t, h);
      this.hashes.delete(t - 600);
      this.onHash(t, h);
      if (this.theirs.has(t)) this.compare(t, this.theirs.get(t)!);
      for (const k of this.theirs.keys()) if (k < t) this.theirs.delete(k);
    }
    this.controls.local.forEach((p, i) => this.uis[p - 1].tick(this.pad(i)));
  }

  /** Report the score if it has changed (after a restart it starts again from nothing). */
  reportScore() {
    const reached = this.ls.session.scorer.reached;
    if (reached.length === this.reported) return;
    this.reported = reached.length;
    this.onScore(reached);
  }

  /** Another client's fingerprint for tick `t`. */
  theirHash(t: number, hash: string) {
    if (this.hashes.has(t)) this.compare(t, hash);
    else if (t > this.ls.tick) this.theirs.set(t, hash);
  }

  private compare(t: number, hash: string) {
    this.theirs.delete(t);
    if (hash === this.hashes.get(t) || this.desynced) return;
    this.desynced = true;
    this.onDesync(t);
  }

  private frame = () => {
    const views = this.renderer.drawFrame(this.ls.session, this.surf, (p) => this.statusOf(p), this.controls.local);
    for (const ui of this.uis) {
      ui.view = views[ui.player - 1];
      if (this.isLocal(ui.player)) ui.drawOverlay(this.surf, this.renderer.font);
    }
    toRGBA(this.surf, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
    requestAnimationFrame(this.frame);
  };

  /** A local player's status line says what A does; a remote one's just who they are. */
  private statusOf(p: number) {
    if (this.isLocal(p)) return this.uis[p - 1].status();
    const e = this.ls.session.engine;
    return `${e.nameOf(e.egoOf(p))}${this.online.has(p) ? '' : ' (away)'}`;
  }

  // ---------------------------------------------------------------- input

  private schemes = () =>
    this.controls.local.length === 1
      ? [{ up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], a: ['KeyZ', 'Space', 'Enter', 'KeyF'], b: ['KeyX', 'ShiftLeft', 'ShiftRight', 'KeyG'], items: ['KeyC', 'Tab'] }]
      : [
          { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], a: ['KeyF'], b: ['KeyG'], items: ['KeyC'] },
          { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], a: ['KeyL'], b: ['KeyK'], items: ['KeyO'] },
        ];

  private pad(i: number): Pad {
    const sc = this.schemes()[i];
    const held = (codes: string[]) => codes.some((c) => this.keys.has(c));
    let dx = (held(sc.right) ? 1 : 0) - (held(sc.left) ? 1 : 0);
    let dy = (held(sc.down) ? 1 : 0) - (held(sc.up) ? 1 : 0);
    const gp = navigator.getGamepads?.()[i];
    if (gp) {
      const b = (n: number) => !!gp.buttons[n]?.pressed;
      dx ||= (b(15) ? 1 : 0) - (b(14) ? 1 : 0) || (Math.abs(gp.axes[0] ?? 0) > 0.5 ? Math.sign(gp.axes[0]) : 0);
      dy ||= (b(13) ? 1 : 0) - (b(12) ? 1 : 0) || (Math.abs(gp.axes[1] ?? 0) > 0.5 ? Math.sign(gp.axes[1]) : 0);
    }
    return { dx, dy };
  }

  private gpPrev: boolean[][] = [];

  private pollGamepads() {
    const pads = navigator.getGamepads?.() ?? [];
    this.controls.local.forEach((p, i) => {
      const gp = pads[i];
      if (!gp) return;
      const prev = this.gpPrev[i] ?? [];
      const edge = (n: number) => !!gp.buttons[n]?.pressed && !prev[n];
      if (gp.buttons.some((_, n) => edge(n))) this.audio.unlock();
      const ui = this.uis[p - 1];
      if (edge(0)) ui.press('a');
      if (edge(1)) ui.press('b');
      if (edge(8) || edge(3)) ui.press('items');
      if (edge(9)) ui.press('skip');
      if (ui.overlayOpen) {
        if (edge(12)) ui.navigate(0, -1);
        if (edge(13)) ui.navigate(0, 1);
        if (edge(14)) ui.navigate(-1, 0);
        if (edge(15)) ui.navigate(1, 0);
      }
      this.gpPrev[i] = gp.buttons.map((b) => b.pressed);
    });
    requestAnimationFrame(() => this.pollGamepads());
  }

  /** Who Esc skips for: a local player whose own cutscene is running, else the first one (shared scenes). */
  private skipper(): number {
    const e = this.ls.session.engine;
    return this.controls.local.find((p) => e.ctxs[p].cutscene) ?? this.controls.local[0];
  }

  private toggleMute() {
    this.audio.toggleMute();
    if (this.audio.muted) this.voices.silence();
    $('touch-sound').textContent = this.audio.muted ? 'Unmute' : 'Mute';
  }

  private bindInput(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (ev) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      this.keys.add(ev.code);
      this.audio.unlock();
      if (ev.code === 'KeyM') {
        if (!ev.repeat) this.toggleMute();
        return;
      }
      if (ev.code === 'KeyV') {
        if (!ev.repeat) this.voices.toggle();
        return;
      }
      if (ev.code === 'Escape') {
        if (!ev.repeat) this.uis[this.skipper() - 1].press('skip');
        return;
      }
      this.schemes().forEach((sc, i) => {
        const ui = this.uis[this.controls.local[i] - 1];
        const is = (codes: string[]) => codes.includes(ev.code);
        // A held key repeats: let that scroll an overlay, but not act or toggle Items again.
        const press = (b: Button) => ev.repeat || ui.press(b);
        let handled = true;
        if (is(sc.a)) press('a');
        else if (is(sc.b)) press('b');
        else if (is(sc.items)) press('items');
        else if (ui.overlayOpen && is(sc.up)) ui.navigate(0, -1);
        else if (ui.overlayOpen && is(sc.down)) ui.navigate(0, 1);
        else if (ui.overlayOpen && is(sc.left)) ui.navigate(-1, 0);
        else if (ui.overlayOpen && is(sc.right)) ui.navigate(1, 0);
        else handled = [sc.up, sc.down, sc.left, sc.right].some(is);
        if (handled) ev.preventDefault();
      });
    });
    window.addEventListener('keyup', (ev) => this.keys.delete(ev.code));
    window.addEventListener('blur', () => this.keys.clear());
    // Pointer position in frame pixels, and whose half it's over (nobody's while a scene is shared).
    const locate = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.floor(((ev.clientX - r.left) / r.width) * FRAME_W);
      const y = Math.floor(((ev.clientY - r.top) / r.height) * FRAME_H);
      const ui = this.uis.find(({ view: v }) => v && !v.shared && y >= v.area.y && y < v.area.y + v.area.h);
      return { p: ui?.player ?? 0, x, y };
    };
    // The touch buttons act for whoever touched the screen last (on one screen, either player).
    let last = this.controls.local[0];
    canvas.addEventListener('pointerdown', (ev) => {
      this.audio.unlock();
      const { p, x, y } = locate(ev);
      if (p && this.isLocal(p)) {
        last = p;
        this.uis[p - 1].click(x, y);
      }
    });
    // iPhones only let sound start when a touch ends.
    canvas.addEventListener('pointerup', () => this.audio.unlock());
    const button = (id: string, act: () => void) =>
      ($(id).onclick = () => {
        this.audio.unlock();
        act();
      });
    button('touch-items', () => this.uis[last - 1].press('items'));
    button('touch-skip', () => this.uis[this.skipper() - 1].press('skip'));
    button('touch-sound', () => this.toggleMute());
    $('touch-sound').textContent = this.audio.muted ? 'Unmute' : 'Mute';
    canvas.addEventListener('pointermove', (ev) => {
      const { p, x, y } = locate(ev);
      for (const ui of this.uis) if (ui.player !== p) ui.hover = '';
      if (p && this.isLocal(p)) this.uis[p - 1].move(x, y);
    });
    this.pollGamepads();
  }
}

// ------------------------------------------------------------------ modes

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const seatLink = (token: string) => `${location.origin}${location.pathname}${location.search}#t=${token}`;
const copyButton = (button: string, input: string) => ($(button).onclick = () => navigator.clipboard?.writeText($<HTMLInputElement>(input).value));

function startLocal(kids: KidName[]) {
  show('game');
  $('back').onclick = () => confirm("Leave this game? A game on one screen isn't saved.") && location.reload();
  const queue: Command[] = [];
  const view = new GameView(kids, (Math.random() * 2 ** 31) | 1, RULES, { local: [1, 2], send: (c) => queue.push(c) });
  setMessage(
    'game-status',
    touch()
      ? 'Two players, one screen: each taps in their own half.'
      : 'Two players, one screen. P1: WASD, F act, G next verb, C items. P2: arrows, L act, K next verb, O items. Esc skips cutscenes, M mutes, V voices.',
  );
  // Keep to the real clock: timers fire late or early, and sound should neither lag nor stutter.
  const start = performance.now();
  let t = 0;
  setInterval(() => {
    const due = Math.floor(((performance.now() - start) * TICK_HZ) / 1000);
    while (t < due) view.advance(++t, queue.splice(0));
  }, 1000 / TICK_HZ / 2);
}

function startOnline(token: string) {
  show('game');
  $('back').onclick = () => (location.hash = `t=${token}`);
  setMessage('game-status', 'Connecting…');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/play?token=${encodeURIComponent(token)}`);
  let view: GameView | null = null;
  let me = 0;
  let pending: { tick: number; cmds: Command[] }[] = [];
  let catchingUp = true;
  let replaced = false;
  const send = (cmd: Command) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'cmd', cmd }));

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as ServerMessage;
    if (msg.type === 'welcome') {
      if (msg.game.romCrc !== romCrc) {
        setMessage('game-status', 'This game was created with a different ROM version.');
        ws.close();
        return;
      }
      me = msg.player;
      view = new GameView(msg.game.kids, msg.game.seed, msg.game.rules, { local: [me], send });
      view.online = new Set(msg.online);
      view.onHash = (tick, hash) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'hash', tick, hash }));
      view.onDesync = (tick) => {
        console.error(`desync: worlds differ at tick ${tick}`);
        setMessage('game-status', 'Your game is out of step with your partner\'s. Reload to catch up again.');
      };
      const log = msg.log.map(([t, , c]) => [t, c] as [number, Command]);
      const target = msg.tick;
      setMessage('game-status', `Catching up on ${target} ticks…`);
      // Replay the shared history in slices so the page stays responsive.
      const chunk = () => {
        const to = Math.min(target, view!.ls.tick + 3000);
        view!.ls.replay(log, to);
        if (to < target) setTimeout(chunk, 0);
        else {
          catchingUp = false;
          for (const p of pending) if (p.tick > view!.ls.tick) view!.advance(p.tick, p.cmds);
          pending = [];
          // Scores go to the board only once caught up, so a replay doesn't report every step again.
          view!.onScore = (reached) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'score', reached }));
          view!.reportScore();
          const you = `You are ${view!.ls.session.engine.nameOf(view!.ls.session.engine.egoOf(me))}.`;
          setMessage(
            'game-status',
            touch()
              ? `${you} Tap to walk; tap people and things to use them.`
              : `${you} Arrows/WASD walk, Z/Space act, X next verb, C items, Esc skip, M mute, V voices. Gamepads work too.`,
          );
        }
      };
      chunk();
    } else if (msg.type === 'tick' && view) {
      const cmds = msg.cmds.map(([, c]) => c);
      if (catchingUp) pending.push({ tick: msg.tick, cmds });
      else view.advance(msg.tick, cmds);
    } else if (msg.type === 'presence' && view) view.online = new Set(msg.online);
    else if (msg.type === 'hash' && view) view.theirHash(msg.tick, msg.hash);
    else if (msg.type === 'error') {
      replaced = true;
      setMessage('game-status', msg.message);
    }
  };
  ws.onclose = (ev) => {
    if (replaced) return;
    if (!view && ev.code !== 1000) setMessage('game-status', 'The server is busy or this link has expired. Try again in a few minutes.');
    else setMessage('game-status', 'Disconnected. Reload to rejoin; the game waits for you.');
  };
}

async function createOnline(kids: KidName[]) {
  const res = await fetch('/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kids, romCrc }) });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    setMessage('lobby-error', res.status === 400 || !err?.error ? 'Could not create a game on this server.' : err.error);
    return;
  }
  const { seats } = (await res.json()) as CreateGameResponse;
  // Your game's page: both links, and Play.
  location.hash = `t=${seats[0].token}`;
}

/** The front page: what's going on, your ROM, a new game, and the high-score board. */
async function home() {
  show('home');
  const activity = async () => {
    const s = (await (await fetch('/api/stats')).json().catch(() => null)) as Stats | null;
    if (!s) return;
    const games = s.playing === 1 ? '1 game' : `${s.playing} games`;
    const players = s.players === 1 ? '1 player' : `${s.players} players`;
    setMessage('activity', `Right now: ${games} being played, ${players} online.`);
  };
  const board = async () => {
    const rows = (await (await fetch('/api/scores')).json().catch(() => [])) as ScoreRow[];
    renderBoard($('board'), rows, rom);
  };
  activity();
  setInterval(activity, 30_000);
  const have = await loadRomQuietly();
  board();
  if (!have) {
    await askForRom($('home'), $('lobby'));
    board();
  }
  $('lobby').hidden = false;
  $('forget-rom').hidden = false;
  const kids = () => [$<HTMLSelectElement>('kid-1').value, $<HTMLSelectElement>('kid-2').value] as KidName[];
  const valid = () => {
    const [a, b] = kids();
    setMessage('lobby-error', a === b ? 'Pick two different kids.' : '');
    return a !== b;
  };
  $('play-local').onclick = () => valid() && startLocal(kids());
  $('create-online').onclick = () => valid() && createOnline(kids());
  $('forget-rom').onclick = async () => {
    await forgetRom();
    location.reload();
  };
}

/** A game's own page: who's in it, both links for its creator, initials, the score, and Play. */
async function gamePage(token: string) {
  show('gamepage');
  const res = await fetch(`/api/seat?token=${encodeURIComponent(token)}`).catch(() => null);
  if (!res?.ok) {
    setMessage('gp-error', "This link isn't a seat in any game on this server.");
    $('gp-play').hidden = true;
    return;
  }
  const info = (await res.json()) as SeatInfo;
  const [k1, k2] = info.game.kids.map(cap);
  const other = 3 - info.player;
  $('gp-title').textContent = `${k1} and ${k2}`;
  setMessage('gp-who', `You play ${cap(info.game.kids[info.player - 1])}. ${cap(info.game.kids[other - 1])} is ${info.online.includes(other) ? 'playing now' : 'away'}.`);
  $<HTMLInputElement>('gp-link').value = seatLink(token);
  copyButton('gp-copy-link', 'gp-link');
  if (info.invite) {
    $('gp-invite-row').hidden = false;
    $<HTMLInputElement>('gp-invite').value = seatLink(info.invite);
    copyButton('gp-copy-invite', 'gp-invite');
    // Phones can hand the invite straight to Messages and the like.
    if (navigator.share) {
      $('gp-share-invite').hidden = false;
      $('gp-share-invite').onclick = () => navigator.share({ title: 'Maniac Duo', text: `Play Maniac Mansion with me, as ${cap(info.game.kids[other - 1])}:`, url: seatLink(info.invite!) }).catch(() => {});
    }
  }
  const summary = (await (await fetch(`/api/games/${info.game.id}/summary`)).json().catch(() => null)) as GameSummary | null;
  if (summary) {
    $<HTMLInputElement>('gp-initials').value = summary.initials[info.player - 1] ?? '';
    $('gp-score').innerHTML = '';
    $('gp-score').append(`Score so far: ${summary.points} of ${MAX_POINTS}. `);
    const a = document.createElement('a');
    a.href = `#g=${info.game.id}`;
    a.textContent = 'See it on the board';
    if (summary.points > 0) $('gp-score').append(a);
  }
  $('gp-save-initials').onclick = async () => {
    const r = await fetch(`/api/initials?token=${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ initials: $<HTMLInputElement>('gp-initials').value }) });
    const body = (await r.json().catch(() => null)) as { initials?: string } | null;
    if (r.ok && body?.initials) $<HTMLInputElement>('gp-initials').value = body.initials;
    setMessage('gp-initials-msg', r.ok ? 'Saved.' : 'One to three letters.');
  };
  $('gp-play').onclick = async () => {
    if (!(await loadRomQuietly())) await askForRom($('gp-rom'));
    location.hash = `t=${token}&play`;
  };
}

/** One game on the board. */
async function summaryPage(id: string) {
  show('summary');
  const res = await fetch(`/api/games/${encodeURIComponent(id)}/summary`).catch(() => null);
  if (!res?.ok) {
    $('summary').textContent = 'No such game on this server.';
    return;
  }
  await loadRomQuietly();
  renderSummary($('summary'), (await res.json()) as GameSummary, rom);
}

async function main() {
  // Each view has its own address; moving between them loads the page afresh.
  window.addEventListener('hashchange', () => location.reload());
  const h = new URLSearchParams(location.hash.slice(1));
  const token = h.get('t');
  const game = h.get('g');
  if (token && h.has('play')) {
    if (await loadRomQuietly()) return startOnline(token);
    location.hash = `t=${token}`;
    return;
  }
  if (token) return gamePage(token);
  if (game) return summaryPage(game);
  return home();
}

main();
