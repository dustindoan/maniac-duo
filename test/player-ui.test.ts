import { describe, expect, test } from 'bun:test';
import { Driver } from '../src/engine/driver';
import { runRoute } from '../src/engine/route';
import { type Command, Session } from '../src/engine/session';
import { PlayerUI } from '../src/web/player-ui';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('player interface', () => {
  test('nothing is chosen until B steps through the suggestions, and back to nothing', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    runRoute(d, '1 go to 258'); // on the porch: door mat, front door, ...
    const sent: Command[] = [];
    const ui = new PlayerUI(1, () => d.s, (c) => sent.push(c));
    const still = { dx: 0, dy: 0 };
    ui.tick(still);
    const n = ui.options.length;
    expect(n).toBeGreaterThan(1);
    expect(ui.focus).toBeNull();
    expect(ui.status()).toBe('Bernard^');
    ui.press('a');
    expect(sent).toEqual([]); // A does nothing with nothing chosen

    ui.press('b');
    expect(ui.focus).toBe(ui.options[0].target);
    expect(ui.status()).toBe(`${ui.options[0].label}^`);
    ui.tick(still);
    expect(ui.focus).toBe(ui.options[0].target); // the choice stays while you stand still
    for (let i = 1; i < n; i++) ui.press('b');
    expect(ui.focus).toBe(ui.options[n - 1].target);
    ui.press('b');
    expect(ui.focus).toBeNull();

    ui.press('b');
    ui.press('a');
    expect(sent).toEqual([{ type: 'sentence', player: 1, verb: ui.options[0].verb, a: ui.options[0].target.id, b: 0 }]);

    // Walking clears the choice.
    ui.tick({ dx: 1, dy: 0 });
    expect(ui.focus).toBeNull();
  });

  test('with an item in hand, choosing another item in the inventory completes "Use X with Y"', () => {
    const d = new Driver(new Session(rom(), { kids: ['bernard', 'michael'], skipIntro: true }));
    runRoute(d, '1 go to 258\n1 pull door mat\n1 get key');
    const sent: Command[] = [];
    const ui = new PlayerUI(1, () => d.s, (c) => sent.push(c));
    ui.tick({ dx: 0, dy: 0 });
    const items = ui.items();
    const key = items.indexOf(55);
    const other = items.findIndex((o) => o !== 55);
    expect(key).toBeGreaterThanOrEqual(0);
    expect(other).toBeGreaterThanOrEqual(0);
    const pick = (i: number) => {
      ui.invIndex = i;
      ui.press('a');
    };
    // Items, the key, Use: the key is in hand.
    ui.press('items');
    pick(key);
    expect(ui.menu?.items[0].label).toBe('Use');
    ui.press('a');
    expect(ui.inHand).toEqual({ item: 55, verb: 11 });
    // Items again, another item: the sentence is complete.
    ui.press('items');
    expect(ui.inventoryOpen).toBe(true);
    pick(other);
    expect(sent).toEqual([{ type: 'sentence', player: 1, verb: 11, a: 55, b: items[other] }]);
    expect(ui.inHand).toBeNull();
    expect(ui.inventoryOpen).toBe(false);
    // Choosing the item you hold puts it back.
    ui.press('items');
    pick(key);
    ui.press('a');
    ui.press('items');
    pick(key);
    expect(ui.inHand).toBeNull();
    expect(sent.length).toBe(1);
  });
});
