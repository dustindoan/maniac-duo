// Browser client: your ROM stays local; the game runs here; the server only orders commands.
import { Lockstep, stateHash } from '../engine/lockstep';
import type { Command, KidName } from '../engine/session';
import { surface, toRGBA } from '../gfx/nes';
import { HALF_H, ViewRenderer } from '../gfx/view';
import { crc32 } from '../rom/crc32';
import { type Rom, identify, loadRom, stripHeader } from '../rom/rom';
import type { CreateGameResponse, ServerMessage } from '../server/protocol';
import { TICK_HZ } from '../server/protocol';
import { type Button, type Pad, PlayerUI } from './player-ui';
import { forgetRom, loadStoredRom, storeRom } from './rom-store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GAP = 4;
const H = HALF_H * 2 + GAP;

let rom: Rom | null = null;
let romCrc = 0;

function show(screen: 'rom' | 'lobby' | 'game') {
  for (const s of ['rom', 'lobby', 'game']) $(s).hidden = s !== screen;
}

function setMessage(id: string, text: string) {
  $(id).textContent = text;
}

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

async function initRom() {
  const stored = await loadStoredRom();
  if (stored && (await acceptRom(stored))) return true;
  if (new URLSearchParams(location.search).has('devrom')) {
    const res = await fetch('/dev/rom').catch(() => null);
    if (res?.ok && (await acceptRom(new Uint8Array(await res.arrayBuffer())))) return true;
  }
  show('rom');
  return new Promise<boolean>((resolve) => {
    const take = async (f: File | undefined) => {
      if (f && (await acceptRom(new Uint8Array(await f.arrayBuffer())))) resolve(true);
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
  online = new Set<number>([1, 2]);
  /** World fingerprints every 60 ticks: two clients of one game must agree (desync check). */
  hashes = new Map<number, string>();
  private surf = surface(256, H);
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private keys = new Set<string>();

  constructor(
    public kids: KidName[],
    seed: number,
    public controls: Controls,
  ) {
    this.ls = new Lockstep(rom!, { kids, seed });
    this.renderer = new ViewRenderer(rom!);
    this.uis = [1, 2].map((p) => new PlayerUI(p, () => this.ls.session, controls.send));
    const canvas = $<HTMLCanvasElement>('screen');
    canvas.width = 256;
    canvas.height = H;
    this.ctx = canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(256, H);
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
    if (t % 60 === 0) this.hashes.set(t, stateHash(this.ls.session));
    this.controls.local.forEach((p, i) => this.uis[p - 1].tick(this.pad(i)));
  }

  private frame = () => {
    const s = this.ls.session;
    for (const p of [1, 2]) {
      const ui = this.uis[p - 1];
      const top = p === 1 ? 0 : HALF_H + GAP;
      const name = s.engine.nameOf(s.engine.egoOf(p));
      const status = this.isLocal(p) ? ui.status() : `${name}${this.online.has(p) ? '' : ' (away)'}`;
      ui.view = this.renderer.drawHalf(s, p, this.surf, top, status);
      ui.top = top;
      if (this.isLocal(p)) ui.drawOverlay(this.surf, this.renderer.font, top);
    }
    for (let i = HALF_H * 256; i < (HALF_H + GAP) * 256; i++) this.surf.px[i] = 0x2d;
    toRGBA(this.surf, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
    requestAnimationFrame(this.frame);
  };

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

  private bindInput(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (ev) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      this.keys.add(ev.code);
      if (ev.code === 'Escape') {
        this.uis[this.controls.local[0] - 1].press('skip');
        return;
      }
      this.schemes().forEach((sc, i) => {
        const ui = this.uis[this.controls.local[i] - 1];
        const is = (codes: string[]) => codes.includes(ev.code);
        let handled = true;
        if (is(sc.a)) ui.press('a');
        else if (is(sc.b)) ui.press('b');
        else if (is(sc.items)) ui.press('items');
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
    const locate = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.floor(((ev.clientX - r.left) / r.width) * 256);
      const y = Math.floor(((ev.clientY - r.top) / r.height) * H);
      const p = y < HALF_H ? 1 : y >= HALF_H + GAP ? 2 : 0;
      return { p, x, y: p === 2 ? y - HALF_H - GAP : y };
    };
    canvas.addEventListener('pointerdown', (ev) => {
      const { p, x, y } = locate(ev);
      if (p && this.isLocal(p)) this.uis[p - 1].click(x, y);
    });
    canvas.addEventListener('pointermove', (ev) => {
      const { p, x, y } = locate(ev);
      for (const ui of this.uis) if (ui.player !== p) ui.hover = '';
      if (p && this.isLocal(p)) this.uis[p - 1].move(x, y);
    });
    this.pollGamepads();
  }
}

// ------------------------------------------------------------------ modes

function startLocal(kids: KidName[]) {
  show('game');
  const queue: Command[] = [];
  const view = new GameView(kids, (Math.random() * 2 ** 31) | 1, { local: [1, 2], send: (c) => queue.push(c) });
  setMessage('game-status', 'Two players, one screen. P1: WASD, F act, G next verb, C items. P2: arrows, L act, K next verb, O items. Esc skips cutscenes.');
  let t = 0;
  setInterval(() => view.advance(++t, queue.splice(0)), 1000 / TICK_HZ);
}

function startOnline(token: string) {
  show('game');
  setMessage('game-status', 'Connecting…');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/play?token=${encodeURIComponent(token)}`);
  let view: GameView | null = null;
  let me = 0;
  let pending: { tick: number; cmds: Command[] }[] = [];
  let catchingUp = true;
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
      view = new GameView(msg.game.kids, msg.game.seed, { local: [me], send });
      view.online = new Set(msg.online);
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
          setMessage('game-status', `You are ${view!.ls.session.engine.nameOf(view!.ls.session.engine.egoOf(me))}. Arrows/WASD walk, Z/Space act, X next verb, C items, Esc skip. Gamepads work too.`);
        }
      };
      chunk();
    } else if (msg.type === 'tick' && view) {
      const cmds = msg.cmds.map(([, c]) => c);
      if (catchingUp) pending.push({ tick: msg.tick, cmds });
      else view.advance(msg.tick, cmds);
    } else if (msg.type === 'presence' && view) view.online = new Set(msg.online);
    else if (msg.type === 'error') setMessage('game-status', msg.message);
  };
  ws.onclose = () => setMessage('game-status', 'Disconnected. Reload to rejoin; the game waits for you.');
}

async function createOnline(kids: KidName[]) {
  const res = await fetch('/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kids, romCrc }) });
  if (!res.ok) {
    setMessage('lobby-error', 'Could not create a game on this server.');
    return;
  }
  const { seats } = (await res.json()) as CreateGameResponse;
  const link = (t: string) => `${location.origin}${location.pathname}#t=${t}`;
  $('invite').hidden = false;
  $<HTMLInputElement>('link-1').value = link(seats[0].token);
  $<HTMLInputElement>('link-2').value = link(seats[1].token);
  $('play-1').onclick = () => {
    location.hash = `t=${seats[0].token}`;
    startOnline(seats[0].token);
  };
}

async function main() {
  await initRom();
  const token = new URLSearchParams(location.hash.slice(1)).get('t');
  if (token) return startOnline(token);
  show('lobby');
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
  for (const id of ['copy-1', 'copy-2'])
    $(id).onclick = () => navigator.clipboard?.writeText($<HTMLInputElement>(id.replace('copy', 'link')).value);
}

main();
