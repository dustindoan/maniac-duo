// A game session: boots the engine, makes the kid selection on the original selection screen,
// and applies player commands at frame boundaries. Deterministic given (seed, command log).

import type { Rom } from '../rom/rom';
import { Engine, V } from './engine';

/** Kid actor numbers and their selection-screen objects (room 45). */
export const KIDS = {
  syd: { actor: 1, select: 260 },
  razor: { actor: 2, select: 261 },
  michael: { actor: 4, select: 262 },
  bernard: { actor: 5, select: 263 },
  wendy: { actor: 6, select: 264 },
  jeff: { actor: 7, select: 265 },
} as const;
export type KidName = keyof typeof KIDS;

const SELECT_ROOM = 45;
const START_OBJECT = 403;

export type Command =
  | { type: 'walk'; player: number; x: number; y: number }
  | { type: 'stop'; player: number }
  | { type: 'sentence'; player: number; verb: number; a: number; b?: number }
  | { type: 'skip'; player: number };

export interface SessionOptions {
  kids: KidName[];
  seed?: number;
  /** Skip the title sequence and intro cutscenes (useful for tests). */
  skipIntro?: boolean;
}

export class Session {
  engine: Engine;
  private selection: number[];
  private selectStage = 0;
  private selectWait = 0;
  ready = false;
  /** Frames stepped so far; tick N applies its commands before frame N runs. */
  frame = 0;
  /** Every command applied, stamped with the tick it applied at (for lockstep logs). */
  recorded: [tick: number, cmd: Command][] = [];

  constructor(
    rom: Rom,
    public opts: SessionOptions,
  ) {
    this.engine = new Engine(
      rom,
      opts.kids.map((k) => ({ kid: KIDS[k].actor })),
      opts.seed ?? 1,
    );
    this.selection = opts.kids.map((k) => KIDS[k].select);
    this.engine.boot();
  }

  /** Advance one engine frame. */
  step() {
    const e = this.engine;
    this.drivePreGame();
    e.step();
    this.frame++;
  }

  private drivePreGame() {
    if (this.ready) return;
    const e = this.engine;
    const sys = e.ctxs[0];
    if (this.opts.skipIntro && sys.cutscene) e.abortCutscene(0);
    if (sys.room === SELECT_ROOM && this.selectStage <= this.selection.length) {
      if (this.selectWait > 0) {
        this.selectWait--;
        return;
      }
      // Each selection object runs script 114, which plays a sound before registering the pick.
      if (e.isScriptRunning(114)) return;
      const obj = this.selectStage < this.selection.length ? this.selection[this.selectStage] : START_OBJECT;
      e.execSentence(0, 13, obj);
      this.selectStage++;
      this.selectWait = 2;
      return;
    }
    if (this.selectStage > this.selection.length && !sys.cutscene && e.players.every((_, i) => e.canAct(i + 1))) this.ready = true;
  }

  apply(cmd: Command): boolean {
    const e = this.engine;
    this.recorded.push([this.frame + 1, cmd]);
    switch (cmd.type) {
      case 'walk':
        return e.walk(cmd.player, cmd.x, cmd.y);
      case 'stop':
        return e.stopWalk(cmd.player);
      case 'sentence':
        return e.sentence(cmd.player, cmd.verb, cmd.a, cmd.b ?? 0);
      case 'skip': {
        const own = e.abortCutscene(cmd.player);
        return own || e.abortCutscene(0);
      }
    }
  }

  egoRoom(player: number) {
    const e = this.engine;
    return e.actors[e.egoOf(player)].room;
  }

  /** Text currently shown to a player (their own messages plus anything said in their room). */
  messagesFor(player: number): string[] {
    const e = this.engine;
    const room = this.viewRoom(player);
    const out: string[] = [];
    for (const c of e.ctxs) {
      const m = c.msg;
      if (!m.text) continue;
      if (m.room === room || (m.actor === 0xff && (c.id === 0 || c.id === player))) out.push((m.actor < 0x80 ? e.nameOf(m.actor) + ': ' : '') + m.text);
    }
    return out;
  }

  /** The room a player is looking at (the director's room during a broadcast cutscene). */
  viewRoom(player: number) {
    const e = this.engine;
    const sys = e.ctxs[0];
    if (sys.room && (sys.cutscene || !this.ready)) return sys.room;
    return e.ctxs[player].room;
  }

  lightsOn(player: number) {
    const e = this.engine;
    const sys = e.ctxs[0];
    const id = sys.room && (sys.cutscene || !this.ready) ? 0 : player;
    return (e.ctxVar(id, V.CURRENT_LIGHTS) & 2) !== 0;
  }
}
