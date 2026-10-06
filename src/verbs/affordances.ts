// The verb system: instead of picking from every verb, offer only what the game's own scripts
// handle for the thing you touched.
//
// Every object in the ROM carries a verb table -- the verbs its script responds to. NES Maniac
// Mansion exposes eleven verbs, and only two of them take a second object (Use X with Y, Give X
// to Y). So:
//   * tapping something lists just the verbs its script handles (usually 1-3), ordered by state;
//   * dragging an inventory item onto a person means Give, onto anything else means Use;
//   * "What is" is replaced by showing names on hover.
// Targets are never highlighted during a drag, so the verb lists don't spoil puzzles.

import { type Engine, NUM_ACTORS, OWNER_ROOM } from '../engine/engine';

export const VERB = {
  open: 1,
  close: 2,
  give: 3,
  turnOn: 4,
  turnOff: 5,
  push: 9,
  pull: 10,
  use: 11,
  read: 12,
  goTo: 13,
  get: 14,
} as const;

export const VERB_LABELS: Record<number, string> = {
  1: 'Open',
  2: 'Close',
  3: 'Give',
  4: 'Turn on',
  5: 'Turn off',
  9: 'Push',
  10: 'Pull',
  11: 'Use',
  12: 'Read',
  13: 'Go to',
  14: 'Get',
};

/** Verbs the NES interface offers (New Kid is gone: each player has one kid). */
const NES_VERBS = new Set(Object.keys(VERB_LABELS).map(Number));
const DEFAULT_ENTRY = 0xff;

export interface Affordance {
  verb: number;
  label: string;
  /** Second object needed (Use with / Give to). */
  needsTarget?: boolean;
}

/** The object's own verb table entries (verb ids), as the ROM stores them. */
export function handledVerbs(e: Engine, obj: number): number[] {
  const def = e.objIndex.get(obj)?.def;
  return def ? def.verbs.map(([v]) => v) : [];
}

/** Verbs to offer when a player taps an object in the room or in their inventory. */
export function affordances(e: Engine, player: number, obj: number): Affordance[] {
  if (obj < NUM_ACTORS) {
    // People: you can give them things (by dragging) or walk up to them.
    return [{ verb: VERB.goTo, label: 'Go to' }];
  }
  const handled = handledVerbs(e, obj);
  const state = e.getState(obj);
  const inInventory = e.getOwner(obj) === e.egoOf(player);
  const on = (state & 8) !== 0;
  let verbs = handled.filter((v) => NES_VERBS.has(v));
  if (verbs.length === 0 && handled.includes(DEFAULT_ENTRY)) {
    // A catch-all handler: the object reacts to anything, so offer the plainest verbs.
    verbs = [VERB.use, VERB.pull];
  }
  if (inInventory) verbs = verbs.filter((v) => v !== VERB.get && v !== VERB.goTo);
  else if (e.getOwner(obj) === OWNER_ROOM && state & 2) verbs = verbs.filter((v) => v !== VERB.get);

  // Pairs that toggle with the object's state: offer the one that makes sense now, and drop any
  // other verb that runs the same script as the one hidden.
  const handlerOf = (v: number) => e.objIndex.get(obj)?.def.verbs.find(([x]) => x === v)?.[1] ?? -v;
  const hide = new Set<number>();
  const both = (a: number, b: number) => verbs.includes(a) && verbs.includes(b);
  const toggle = (offVerb: number, onVerb: number) => {
    if (!both(offVerb, onVerb)) return;
    const hidden = on ? offVerb : onVerb;
    const shown = on ? onVerb : offVerb;
    hide.add(hidden);
    // Its twins go too, unless the shown verb is one of them (one script toggling both ways).
    if (handlerOf(hidden) !== handlerOf(shown)) for (const v of verbs) if (handlerOf(v) === handlerOf(hidden)) hide.add(v);
  };
  toggle(VERB.open, VERB.close);
  toggle(VERB.turnOn, VERB.turnOff);
  // Push/Pull with separate scripts usually move something one way and back (door mat, panels).
  if (handlerOf(VERB.push) !== handlerOf(VERB.pull)) toggle(VERB.pull, VERB.push);
  // Doors and the like: going through something closed does nothing, so open it first.
  if (handled.includes(VERB.open) && !on) hide.add(VERB.goTo);
  verbs = verbs.filter((v) => !hide.has(v));

  const rank = (v: number) => {
    if (v === VERB.goTo) return on || !handled.includes(VERB.open) ? 0 : 5;
    if (v === VERB.open || v === VERB.turnOn || v === VERB.get) return 1;
    if (v === VERB.use || v === VERB.give) return 3;
    return 2;
  };
  verbs = [...new Set(verbs)].sort((a, b) => rank(a) - rank(b) || a - b);
  // Verbs that run the very same script are the same action: offer it once, under its plainest
  // name (Get, Read and Give have extra rules in the sentence script, so they yield to the others).
  const def = e.objIndex.get(obj)?.def;
  if (def) {
    const plain = [VERB.open, VERB.close, VERB.turnOn, VERB.turnOff, VERB.push, VERB.pull, VERB.use, VERB.goTo, VERB.read, VERB.get, VERB.give] as number[];
    const offset = (v: number) => def.verbs.find(([x]) => x === v)?.[1] ?? -v;
    verbs = verbs.filter((v) => !verbs.some((w) => w !== v && offset(w) === offset(v) && plain.indexOf(w) < plain.indexOf(v)));
  }
  return verbs.map((v) => ({ verb: v, label: VERB_LABELS[v], needsTarget: inInventory && (v === VERB.use || v === VERB.give) }));
}

/** The sentence a drag of `item` onto `target` means. */
export function pairSentence(e: Engine, item: number, target: number): { verb: number; a: number; b: number } {
  if (target < NUM_ACTORS) return { verb: VERB.give, a: item, b: target };
  return { verb: VERB.use, a: item, b: target };
}

/** Human-readable sentence, e.g. "Use radio tube with tube socket". */
export function describe(e: Engine, verb: number, a: number, b = 0): string {
  const prep = verb === VERB.give ? 'to' : 'with';
  return `${VERB_LABELS[verb] ?? '?'} ${e.nameOf(a)}${b ? ` ${prep} ${e.nameOf(b)}` : ''}`;
}
