// A game session: boots the engine, makes the kid selection on the original selection screen,
// and applies player commands at frame boundaries. Deterministic given (seed, command log).

import type { Rom } from '../rom/rom';
import { Engine, NUM_ACTORS, V } from './engine';

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
/** CURRENT_LIGHTS bits (ScummVM's LIGHTMODE_room_lights_on and LIGHTMODE_flashlight_on). */
const LIGHTS_ON = 2;
const FLASHLIGHT_ON = 4;
/** The flashlight object. */
const FLASHLIGHT = 84;
const START_OBJECT = 403;

export type Command =
  | { type: 'walk'; player: number; x: number; y: number }
  | { type: 'stop'; player: number }
  | { type: 'sentence'; player: number; verb: number; a: number; b?: number }
  | { type: 'skip'; player: number };

/**
 * The "Meanwhile..." card before a scene everyone watches (after Day of the Tentacle): the split
 * screen fades to black, the card holds, and the scene fades in. The world waits meanwhile, so
 * nobody misses the start of the scene. Players whose kid is in the scene just see the fade; if
 * every kid is, there's no card to hold. In engine frames.
 */
export const MEANWHILE = { fade: 4, hold: 18 };

/** The card in progress: how long it holds, and which players' kids are in the scene. */
export interface Card {
  hold: number;
  present: boolean[];
}

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
  /** Frames left of the "Meanwhile..." card; the world is paused while it shows. */
  meanwhile = 0;
  card: Card = { hold: 0, present: [] };
  private wasShared = true;
  /** Sound-chip writes from the frame the scene began, played once it appears. */
  private heldSound: number[][] = [];

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
    try {
      if (this.meanwhile > 0) {
        this.meanwhile--;
        e.sound.begin();
        return;
      }
      this.drivePreGame();
      e.step();
      if (this.heldSound.length) e.sound.out.unshift(...this.heldSound.splice(0));
      // A scene everyone watches takes over the screen: hold the world for the card.
      const shared = this.ready && this.shared() !== null;
      if (shared && !this.wasShared) {
        const room = this.viewRoom(1);
        const present = e.players.map((_, i) => e.actors[e.egoOf(i + 1)].room === room);
        this.card = { hold: present.every(Boolean) ? 0 : MEANWHILE.hold, present };
        this.meanwhile = 2 * MEANWHILE.fade + this.card.hold;
        this.heldSound = e.sound.out;
        e.sound.begin();
      }
      this.wasShared = shared;
    } finally {
      this.frame++;
    }
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
    if (this.selectStage > this.selection.length && !sys.cutscene && e.players.every((_, i) => e.canAct(i + 1))) {
      this.ready = true;
      // The original starts you as Dave, with his theme playing; here the players' kids take over.
      e.playKidTheme(1);
    }
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
        // Your own cutscene first, then the one everyone is watching. During the card, skipping
        // ends the card, and the scene too if it can be skipped.
        const away = e.cutAway();
        const watched = this.shared();
        const ctx = [cmd.player, 0, away].find((c) => e.abortCutscene(c));
        const card = this.meanwhile > 0 && (ctx === undefined || ctx === watched);
        if (card) this.meanwhile = 0;
        return ctx !== undefined || card;
      }
    }
  }

  egoRoom(player: number) {
    const e = this.engine;
    return e.actors[e.egoOf(player)].room;
  }

  /** Dialogue a player sees: narration from what they're watching, plus anything said in that room. */
  dialogueFor(player: number): { actor: number; text: string; color: number }[] {
    const e = this.engine;
    const watching = this.viewCtx(player);
    const room = this.viewRoom(player);
    const out: { actor: number; text: string; color: number }[] = [];
    for (const c of e.ctxs) {
      const m = c.msg;
      if (!m.text) continue;
      if (m.room === room || (m.actor === 0xff && (c.id === 0 || c.id === watching))) out.push({ actor: m.actor, text: m.text, color: m.color });
    }
    return out;
  }

  /** The same, with each speaker's name (for logs and tests). */
  messagesFor(player: number): string[] {
    const e = this.engine;
    return this.dialogueFor(player).map((l) => (l.actor < 0x80 ? e.nameOf(l.actor) + ': ' : '') + l.text);
  }

  /**
   * The context everyone watches full-screen, or null while each player has their own view: the
   * director during the intro and world cutscenes, or a player whose cutscene cut away elsewhere.
   */
  shared(): number | null {
    const e = this.engine;
    const sys = e.ctxs[0];
    if (sys.room && (sys.cutscene || !this.ready)) return 0;
    return e.cutAway() || null;
  }

  /** The context whose room, camera and lights a player sees. */
  viewCtx(player: number): number {
    return this.shared() ?? player;
  }

  /** The room a player is looking at. */
  viewRoom(player: number) {
    return this.engine.ctxs[this.viewCtx(player)].room;
  }

  /** Centre of a player's view, in room pixels. */
  camera(player: number) {
    return this.engine.ctxs[this.viewCtx(player)].cam.cur;
  }

  lightsOn(player: number) {
    return (this.lights(player) & LIGHTS_ON) !== 0;
  }

  /**
   * Whose flashlight lights a player's dark room: the kid holding it, if it's on and they're in the
   * room this player sees (script 55 sets the lights this way). 0 when the room is lit or pitch dark.
   */
  flashlightHolder(player: number): number {
    if ((this.lights(player) & (LIGHTS_ON | FLASHLIGHT_ON)) !== FLASHLIGHT_ON) return 0;
    const e = this.engine;
    const holder = e.getOwner(FLASHLIGHT);
    return holder > 0 && holder < NUM_ACTORS && e.actors[holder].room === this.viewRoom(player) ? holder : 0;
  }

  private lights(player: number) {
    return this.engine.ctxVar(this.viewCtx(player), V.CURRENT_LIGHTS);
  }
}
