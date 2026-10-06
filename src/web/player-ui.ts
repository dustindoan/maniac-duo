// One player's interface: D-pad walking, focus + A/B verbs, inventory overlay, item-in-hand,
// with mouse/touch as a fallback. Produces engine commands; never touches engine state.

import type { Engine } from '../engine/engine';
import type { Command, Session } from '../engine/session';
import { type HalfView, BORDER, Font, GREY, HALF_H, SCENE_H, STATUS_H, TEXT_H, WHITE, YELLOW } from '../gfx/view';
import type { Surface } from '../gfx/nes';
import { type Affordance, VERB, VERB_LABELS, affordances, pairSentence } from '../verbs/affordances';
import { type Suggestion, type Target, dpadTarget, suggestions, touchable } from '../verbs/focus';

export type Button = 'a' | 'b' | 'items' | 'skip';

export interface Pad {
  dx: number;
  dy: number;
}

interface Menu {
  obj: number;
  items: Affordance[];
  index: number;
}

const INV_ROWS = 5;

export class PlayerUI {
  /** What A would do, best first; B steps through them. */
  options: Suggestion[] = [];
  optionIndex = 0;
  inHand: { item: number; verb: number } | null = null;
  inventoryOpen = false;
  invIndex = 0;
  menu: Menu | null = null;
  hover = '';
  private lastPad: Pad = { dx: 0, dy: 0 };
  private padHeldTicks = 0;
  private lastOption = '';
  /** Where this player's half is drawn, and what was drawn there last frame (for hit testing). */
  top = 0;
  view: HalfView | null = null;

  constructor(
    public player: number,
    private session: () => Session,
    private send: (cmd: Command) => void,
  ) {}

  private get e(): Engine {
    return this.session().engine;
  }

  private kid() {
    return this.e.egoOf(this.player);
  }

  items(): number[] {
    return this.e.inventoryOf(this.kid());
  }

  /** Called once per engine tick with the current D-pad state. */
  tick(pad: Pad) {
    const e = this.e;
    if (!e.canAct(this.player)) {
      this.lastPad = { dx: 0, dy: 0 };
      return;
    }
    if (this.inventoryOpen || this.menu) {
      this.lastPad = pad;
      return;
    }
    const changed = pad.dx !== this.lastPad.dx || pad.dy !== this.lastPad.dy;
    const moving = pad.dx || pad.dy;
    this.padHeldTicks = changed ? 0 : this.padHeldTicks + 1;
    if (changed && !moving) this.send({ type: 'stop', player: this.player });
    // Diagonals aim a short distance out, so refresh them while held.
    else if (moving && (changed || (pad.dx && pad.dy && this.padHeldTicks % 6 === 0))) {
      const t = dpadTarget(e, this.player, pad.dx, pad.dy);
      if (t) this.send({ type: 'walk', player: this.player, x: t.x, y: t.y });
    }
    this.lastPad = pad;
    // Keep the chosen suggestion if it is still on offer; otherwise start from the best one.
    this.options = suggestions(e, this.player, this.inHand?.item ?? null);
    const keep = this.options.findIndex((o) => `${o.target.id}/${o.verb}` === this.lastOption);
    this.optionIndex = moving ? 0 : Math.max(0, keep);
    const cur = this.options[this.optionIndex];
    this.lastOption = cur ? `${cur.target.id}/${cur.verb}` : '';
  }

  get focus(): Target | null {
    return this.options[this.optionIndex]?.target ?? null;
  }

  press(b: Button) {
    const e = this.e;
    if (b === 'skip') {
      this.send({ type: 'skip', player: this.player });
      return;
    }
    if (!e.canAct(this.player)) return;
    if (this.menu) return this.menuPress(b);
    if (this.inventoryOpen) return this.inventoryPress(b);
    if (b === 'items') {
      this.inventoryOpen = true;
      this.invIndex = Math.min(this.invIndex, Math.max(0, this.items().length - 1));
      return;
    }
    if (b === 'b') {
      const n = this.options.length;
      if (n > 1) {
        this.optionIndex = (this.optionIndex + 1) % n;
        const cur = this.options[this.optionIndex];
        this.lastOption = `${cur.target.id}/${cur.verb}`;
      } else if (this.inHand) this.inHand = null;
      return;
    }
    // A: do the suggestion on screen.
    const o = this.options[this.optionIndex];
    if (!o) return;
    if (this.inHand) {
      const s = pairSentence(e, this.inHand.item, o.target.id);
      this.sentence(s.verb, s.a, s.b);
      this.inHand = null;
      return;
    }
    this.sentence(o.verb, o.target.id);
  }

  /** Inventory overlay: D-pad moves the cursor (handled in navigate), A opens the item's verbs. */
  private inventoryPress(b: Button) {
    const items = this.items();
    if (b === 'items' || b === 'b') {
      this.inventoryOpen = false;
      return;
    }
    if (b === 'a' && items[this.invIndex]) this.openMenu(items[this.invIndex]);
  }

  private menuPress(b: Button) {
    const m = this.menu!;
    if (b === 'b' || b === 'items') {
      this.menu = null;
      return;
    }
    if (b === 'a') this.choose(m.items[m.index]);
  }

  private openMenu(obj: number) {
    const items = affordances(this.e, this.player, obj);
    const inInventory = this.e.getOwner(obj) === this.kid();
    if (inInventory && !items.some((x) => x.verb === VERB.give)) items.push({ verb: VERB.give, label: VERB_LABELS[VERB.give], needsTarget: true });
    if (!items.length) return;
    this.menu = { obj, items, index: 0 };
  }

  private choose(item: Affordance | undefined) {
    const m = this.menu;
    this.menu = null;
    if (!m || !item) return;
    if (item.needsTarget) {
      this.inHand = { item: m.obj, verb: item.verb };
      this.inventoryOpen = false;
      return;
    }
    this.sentence(item.verb, m.obj);
    this.inventoryOpen = false;
  }

  /** D-pad presses while an overlay is open move its cursor. */
  navigate(dx: number, dy: number) {
    if (this.menu) {
      const n = this.menu.items.length;
      this.menu.index = (this.menu.index + dy + dx + n) % n;
    } else if (this.inventoryOpen) {
      const n = this.items().length;
      if (n) this.invIndex = Math.max(0, Math.min(n - 1, this.invIndex + dy + dx * INV_ROWS));
    }
  }

  get overlayOpen() {
    return this.inventoryOpen || !!this.menu;
  }

  private sentence(verb: number, a: number, b = 0) {
    this.send({ type: 'sentence', player: this.player, verb, a, b });
  }

  // ------------------------------------------------------------- mouse / touch

  /** Click at half-local pixel coords. */
  click(x: number, y: number) {
    const e = this.e;
    if (!e.canAct(this.player) || !this.view) return;
    if (this.menu) {
      const i = this.menuHit(x, y);
      if (i >= 0) this.choose(this.menu.items[i]);
      else this.menu = null;
      return;
    }
    if (y >= TEXT_H + SCENE_H && x >= 256 - 7 * 8) {
      this.inventoryOpen = !this.inventoryOpen;
      return;
    }
    if (this.inventoryOpen) {
      const i = this.invHit(x, y);
      if (i >= 0) {
        this.invIndex = i;
        this.openMenu(this.items()[i]);
      } else this.inventoryOpen = false;
      return;
    }
    const hit = this.hitTest(x, y);
    if (hit) {
      if (this.inHand) {
        const s = pairSentence(e, this.inHand.item, hit);
        this.sentence(s.verb, s.a, s.b);
        this.inHand = null;
        return;
      }
      const verbs = affordances(e, this.player, hit);
      if (verbs.length === 1) this.sentence(verbs[0].verb, hit);
      else if (verbs.length > 1) this.menu = { obj: hit, items: verbs, index: 0 };
      return;
    }
    if (y >= TEXT_H && y < TEXT_H + SCENE_H) {
      this.inHand = null;
      this.send({ type: 'walk', player: this.player, x: Math.max(0, x - BORDER + this.view.scrollX), y: y - TEXT_H });
    }
  }

  move(x: number, y: number) {
    const hit = this.view ? this.hitTest(x, y) : 0;
    this.hover = hit ? this.e.nameOf(hit) : '';
  }

  private hitTest(x: number, y: number): number {
    const v = this.view!;
    for (const a of v.actors.slice().reverse()) if (a.actor !== this.kid() && x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1) return a.actor;
    if (y < TEXT_H || y >= TEXT_H + SCENE_H) return 0;
    const rx = x - BORDER + v.scrollX;
    const ry = y - TEXT_H;
    for (const t of touchable(this.e, v.room)) if (rx >= t.x && rx < t.x + t.w && ry >= t.y && ry < t.y + t.h && affordances(this.e, this.player, t.id).length) return t.id;
    return 0;
  }

  // ------------------------------------------------------------- drawing

  status(): string {
    const e = this.e;
    const name = e.nameOf(this.kid());
    if (!e.canAct(this.player)) return e.ctxs[0].cutscene || e.ctxs[this.player].cutscene ? `${name} - START SKIPS` : name;
    if (this.inHand && !this.options.length) return `${VERB_LABELS[this.inHand.verb]} ${e.nameOf(this.inHand.item)}... B drops`;
    if (this.hover) return this.hover;
    const o = this.options[this.optionIndex];
    // '^' is the NES font's ellipsis: more suggestions behind B.
    if (o) return o.label + (this.options.length > 1 ? '^' : '');
    return name;
  }

  /** Overlays for this player's half: focus brackets, inventory, verb menu. */
  drawOverlay(dst: Surface, font: Font, top: number) {
    const v = this.view;
    if (!v) return;
    const sceneTop = top + TEXT_H;
    if (this.focus && !this.overlayOpen && this.e.canAct(this.player)) {
      const f = this.focus;
      const x0 = BORDER + f.x - v.scrollX;
      const y0 = sceneTop + Math.max(0, f.y);
      const x1 = x0 + f.w - 1;
      const y1 = Math.min(sceneTop + SCENE_H - 1, sceneTop + f.y + f.h - 1);
      bracket(dst, x0, y0, x1, y1, this.inHand ? YELLOW : WHITE, BORDER, BORDER + 224, sceneTop, sceneTop + SCENE_H);
    }
    font.draw(dst, ' ITEMS ', 256 - 7 * 8, top + TEXT_H + SCENE_H, this.inventoryOpen ? WHITE : GREY);
    if (this.inventoryOpen) {
      fill(dst, BORDER, sceneTop + 8, 224, INV_ROWS * 10 + 16, 0x0f);
      const items = this.items();
      font.draw(dst, `${this.e.nameOf(this.kid())}'s things`.slice(0, 27), BORDER + 8, sceneTop + 10, YELLOW);
      if (!items.length) font.draw(dst, '(nothing)', BORDER + 8, sceneTop + 24, GREY);
      const page = Math.floor(this.invIndex / (INV_ROWS * 2));
      items.slice(page * INV_ROWS * 2, (page + 1) * INV_ROWS * 2).forEach((obj, i) => {
        const idx = page * INV_ROWS * 2 + i;
        const col = Math.floor(i / INV_ROWS);
        const row = i % INV_ROWS;
        const name = this.e.nameOf(obj).slice(0, 12);
        font.draw(dst, (idx === this.invIndex ? '-' : ' ') + name, BORDER + 4 + col * 108, sceneTop + 22 + row * 10, idx === this.invIndex ? WHITE : GREY);
      });
    }
    if (this.menu) {
      const m = this.menu;
      const w = 12 * 8;
      const h = m.items.length * 10 + 6;
      const x = BORDER + 224 - w - 8;
      const y = sceneTop + SCENE_H - h - 4;
      fill(dst, x, y, w, h, 0x0f);
      m.items.forEach((it, i) => font.draw(dst, (i === m.index ? '-' : ' ') + it.label, x + 2, y + 4 + i * 10, i === m.index ? WHITE : GREY));
    }
  }

  private menuHit(x: number, y: number): number {
    const m = this.menu!;
    const w = 12 * 8;
    const h = m.items.length * 10 + 6;
    const mx = BORDER + 224 - w - 8;
    const my = TEXT_H + SCENE_H - h - 4;
    if (x < mx || x >= mx + w || y < my || y >= my + h) return -1;
    const i = Math.floor((y - my - 3) / 10);
    return i >= 0 && i < m.items.length ? i : -1;
  }

  private invHit(x: number, y: number): number {
    const page = Math.floor(this.invIndex / (INV_ROWS * 2));
    const row = Math.floor((y - TEXT_H - 22) / 10);
    const col = x - BORDER - 4 >= 108 ? 1 : 0;
    if (row < 0 || row >= INV_ROWS || x < BORDER) return -1;
    const idx = page * INV_ROWS * 2 + col * INV_ROWS + row;
    return idx < this.items().length ? idx : -1;
  }
}

function fill(dst: Surface, x: number, y: number, w: number, h: number, c: number) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < dst.w && j < dst.h) dst.px[j * dst.w + i] = c;
}

function bracket(dst: Surface, x0: number, y0: number, x1: number, y1: number, c: number, minX: number, maxX: number, minY: number, maxY: number) {
  const L = 4;
  const set = (x: number, y: number) => {
    if (x >= minX && x < maxX && y >= minY && y < maxY) dst.px[y * dst.w + x] = c;
  };
  for (let i = 0; i < L; i++) {
    set(x0 + i, y0);
    set(x0, y0 + i);
    set(x1 - i, y0);
    set(x1, y0 + i);
    set(x0 + i, y1);
    set(x0, y1 - i);
    set(x1 - i, y1);
    set(x1, y1 - i);
  }
}

export { HALF_H, STATUS_H };
