// Keypads: leaving one without entering a code (not in the original, which waits for four digits).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Driver } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { type Command, Session } from '../src/engine/session';
import { surface } from '../src/gfx/nes';
import { FRAME_H, FRAME_W, ViewRenderer } from '../src/gfx/view';
import { parseCommand } from '../src/server/protocol';
import { RULES } from '../src/story';
import { PlayerUI } from '../src/web/player-ui';
import { haveRom, rom } from './rom-fixture';

const DUNGEON = 4;
const INNER_DOOR = 163;
const OPEN = 8;
/** The lab's other keypad: a wrong code sounds the alarm, then script 62 blows up the house. */
const SELF_DESTRUCT_DOOR = 167;
const EXPLOSION = 62;
const ALARM = 33;

const route = readFileSync('test/route.txt', 'utf8').split('\n');

/** Bernard in the dungeon, padlocks off and the outer door open, in front of the inner door. */
function atInnerDoor() {
  const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true, rules: RULES }));
  runRoute(d, route.slice(0, route.findIndex((l) => l.startsWith('1 open inner door'))).join('\n'));
  expect(d.room(1)).toBe(DUNGEON);
  return d;
}

/** Open the inner door's keypad, and wait until it's on screen. */
function openKeypad(d: Driver) {
  runRoute(d, '1 open inner door');
  for (let i = 0; i < 30 && !d.e.atKeypad(1); i++) d.step();
  expect(d.e.atKeypad(1)).toBe(true);
}

/** Player 1's interface, its commands applied as they're sent, and how to tap a frame pixel. */
function ui(d: Driver) {
  const sent: Command[] = [];
  const ui = new PlayerUI(1, () => d.s, (c) => {
    sent.push(c);
    d.s.apply(c);
  });
  const look = () => (ui.view = new ViewRenderer(rom()).drawFrame(d.s, surface(FRAME_W, FRAME_H), () => '')[0]);
  const tapButton = (id: number) => {
    const v = look();
    const t = ui.options.find((o) => o.target.id === id)!.target;
    ui.click(v.scene.x + t.x - v.scrollX + 4, v.scene.y + t.y - v.scrollY + 4);
  };
  return { ui, sent, look, tapButton };
}

describe.skipIf(!haveRom)('keypads', () => {
  test('leaving the inner door keypad leaves the door shut, says nothing, and the code still works after', () => {
    const d = atInnerDoor();
    const e = d.e;
    openKeypad(d);
    const before = d.log.length;
    expect(d.s.apply({ type: 'leave', player: 1 })).toBe(true);
    d.step(30);
    expect(e.atKeypad(1)).toBe(false);
    expect([e.ctxs[1].room, e.canAct(1)]).toEqual([DUNGEON, true]);
    expect(d.log.slice(before).map((l) => l.text).join(' | ')).not.toContain('locked');
    expect(e.getState(INNER_DOOR) & OPEN).toBe(0);
    // Nothing to leave now.
    expect(d.s.apply({ type: 'leave', player: 1 })).toBe(false);

    runRoute(d, '1 open inner door\n1 dial 0000\n1 wait 40');
    expect(e.getState(INNER_DOOR) & OPEN).toBe(OPEN);
  });

  test("leaving the self-destruct door's keypad sets nothing off; a wrong code would", () => {
    const d = atInnerDoor();
    const e = d.e;
    const opened = () => {
      e.runScript(SELF_DESTRUCT_DOOR, false, false, 1);
      for (let i = 0; i < 30 && !e.atKeypad(1); i++) d.step();
      expect(e.atKeypad(1)).toBe(true);
    };
    const goesOff = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        d.step();
        if (e.isScriptRunning(EXPLOSION) || e.isSoundRunning(ALARM)) return true;
      }
      return false;
    };

    opened();
    expect(d.s.apply({ type: 'leave', player: 1 })).toBe(true);
    expect(goesOff(3500)).toBe(false);
    expect([e.ctxs[1].room, e.canAct(1)]).toEqual([DUNGEON, true]);

    // The same keypad, with a wrong code: the alarm goes off.
    opened();
    d.dial(1, [63, 64, 65, 66].map((v) => (e.vars[v] === 1 ? 2 : 1)).join(''));
    expect(goesOff(3500)).toBe(true);
  });

  test('the D-pad reaches every button, A pushes the chosen one, and the code opens the door', () => {
    const d = atInnerDoor();
    openKeypad(d);
    const { ui: p1, sent } = ui(d);
    const still = { dx: 0, dy: 0 };
    p1.tick(still);
    // 1 2 3 / 4 5 6 / 7 8 9 / * 0 #, with 1 chosen to start; the set off the right of the screen isn't offered.
    expect(p1.options.map((o) => o.target.id)).toEqual([429, 430, 431, 432, 433, 434, 435, 436, 437, 299, 300, 301]);
    expect(p1.focus?.id).toBe(429);
    expect([p1.overlayOpen, p1.status()]).toEqual([true, 'A pushes   B leaves']);
    const go = (dx: number, dy: number) => {
      p1.navigate(dx, dy);
      return p1.focus?.id;
    };
    expect([go(1, 0), go(0, 1), go(0, 1), go(0, 1), go(0, 1), go(-1, 0), go(-1, 0), go(1, 0)]).toEqual([430, 433, 436, 300, 300, 299, 299, 300]);
    // Holding the D-pad doesn't walk the kid, who isn't on this screen.
    p1.tick({ dx: 1, dy: 0 });
    expect(sent).toEqual([]);
    for (let i = 0; i < 4; i++) {
      p1.tick(still);
      p1.press('a');
      d.step(2);
      d.idle(1);
      d.step(4);
    }
    expect(sent.every((c) => c.type === 'sentence' && c.a === 300)).toBe(true);
    runRoute(d, '1 wait 40');
    expect(d.e.getState(INNER_DOOR) & OPEN).toBe(OPEN);
  });

  test('B or Skip leaves the keypad; a tap pushes a button, and between buttons does nothing', () => {
    const d = atInnerDoor();
    const { ui: p1, sent, look, tapButton } = ui(d);
    const still = { dx: 0, dy: 0 };
    for (const leave of ['b', 'skip'] as const) {
      openKeypad(d);
      p1.tick(still);
      p1.press(leave);
      expect(sent.at(-1)).toEqual({ type: 'leave', player: 1 });
      d.step(30);
      expect([d.e.atKeypad(1), d.e.ctxs[1].room, d.e.canAct(1)]).toEqual([false, DUNGEON, true]);
    }
    openKeypad(d);
    p1.tick(still);
    const before = sent.length;
    const v = look();
    p1.click(v.scene.x + 2, v.scene.y + 2);
    expect(sent.length).toBe(before);
    tapButton(433);
    expect(sent.slice(before)).toEqual([{ type: 'sentence', player: 1, verb: p1.options[0].verb, a: 433, b: 0 }]);
    expect(p1.focus?.id).toBe(433);
  });

  test("the other player's keypad is theirs to leave", () => {
    const d = atInnerDoor();
    openKeypad(d);
    expect(d.s.apply({ type: 'leave', player: 2 })).toBe(false);
    expect(d.e.atKeypad(1)).toBe(true);
  });
});

describe('the leave command', () => {
  test('the relay passes it on, as the sender', () => {
    expect(parseCommand({ type: 'leave', player: 1 }, 2)).toEqual({ type: 'leave', player: 2 });
  });
});
