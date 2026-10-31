// The on-screen gamepad for touch screens: a see-through D-pad, A and B over the game. It drives one
// player as the keyboard does: the D-pad is held like the arrow keys, A and B are pressed like Z and X.

import type { Button, Pad } from './player-ui';

/** How far from the D-pad's centre a thumb must be to count, as a share of its half-width. */
const DEAD_ZONE = 0.25;
/** Like a held key, a direction held in a menu repeats after a pause. */
const REPEAT_AFTER_MS = 400;
const REPEAT_EVERY_MS = 150;

export interface TouchPadHandlers {
  /** A or B was pressed. */
  press(b: Button): void;
  /** The D-pad was pushed, or is held, in a direction: for moving through a menu. */
  step(dx: number, dy: number): void;
}

export class TouchPad {
  /** The D-pad as it's held now. */
  pad: Pad = { dx: 0, dy: 0 };
  private repeat: ReturnType<typeof setTimeout> | undefined;
  private arms: Record<string, Element | null>;

  constructor(
    dpad: HTMLElement,
    buttons: Record<'a' | 'b', HTMLElement>,
    private on: TouchPadHandlers,
  ) {
    this.arms = Object.fromEntries(['up', 'down', 'left', 'right'].map((d) => [d, dpad.querySelector(`[data-d=${d}]`)]));
    const aim = (ev: PointerEvent) => {
      const r = dpad.getBoundingClientRect();
      this.hold(direction(((ev.clientX - r.left) / r.width) * 2 - 1, ((ev.clientY - r.top) / r.height) * 2 - 1));
    };
    dpad.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      dpad.setPointerCapture(ev.pointerId);
      aim(ev);
    });
    dpad.addEventListener('pointermove', (ev) => dpad.hasPointerCapture(ev.pointerId) && aim(ev));
    for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) dpad.addEventListener(end, () => this.hold({ dx: 0, dy: 0 }));
    for (const b of ['a', 'b'] as const) {
      const el = buttons[b];
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        el.classList.add('on');
        on.press(b);
      });
      for (const end of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(end, () => el.classList.remove('on'));
    }
  }

  private hold(p: Pad) {
    if (p.dx === this.pad.dx && p.dy === this.pad.dy) return;
    this.pad = p;
    clearTimeout(this.repeat);
    clearInterval(this.repeat);
    this.arms.up?.classList.toggle('on', p.dy < 0);
    this.arms.down?.classList.toggle('on', p.dy > 0);
    this.arms.left?.classList.toggle('on', p.dx < 0);
    this.arms.right?.classList.toggle('on', p.dx > 0);
    if (!p.dx && !p.dy) return;
    // Menus move along one axis at a time: a diagonal counts as up or down.
    const step = () => (p.dy ? this.on.step(0, p.dy) : this.on.step(p.dx, 0));
    step();
    this.repeat = setTimeout(() => (this.repeat = setInterval(step, REPEAT_EVERY_MS)), REPEAT_AFTER_MS);
  }
}

/** The direction at (x, y), each from -1 to 1 across the D-pad: eight ways, a 45° slice each. */
export function direction(x: number, y: number): Pad {
  if (Math.hypot(x, y) < DEAD_ZONE) return { dx: 0, dy: 0 };
  const a = Math.round(Math.atan2(y, x) / (Math.PI / 4)) * (Math.PI / 4);
  return { dx: Math.round(Math.cos(a)), dy: Math.round(Math.sin(a)) };
}
