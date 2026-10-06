// Route files: scripted playthroughs, one step per line.
//
//   <player> <verb> <object>[ with|to|on|in <object>]   e.g. "2 give fruit drinks to Green Tentacle"
//   <player> walk <x>,<y>          walk to pixel coordinates in the player's room
//   <player> dial <digits|varN>    press keypad buttons (literal digits, or 4 vars starting at N)
//   <player> wait <frames>         let the world run
//   <player> until !<script>       run until a script has stopped
//   <player> until a<actor>[!]=<room>
//   <player> idle                  run until the player can act (skipping cutscenes)
//   <player> assert won|has <item>|script<N>|!script<N>
//
// Objects are named as the game names them, or given by number. '#' starts a comment.

import { Driver, DriverError, VERB_IDS } from './driver';

export interface RouteStep {
  line: number;
  text: string;
  player: number;
  output: string[];
}

export class RouteError extends Error {
  constructor(
    public step: { line: number; text: string },
    message: string,
  ) {
    super(`line ${step.line} "${step.text}": ${message}`);
  }
}

const VERBS = Object.keys(VERB_IDS).sort((a, b) => b.length - a.length);
const arg = (s: string) => (/^\d+$/.test(s) ? Number(s) : s);
const MAX_WAIT = 40000;

export function parseRoute(text: string): { line: number; text: string }[] {
  return text
    .split('\n')
    .map((l, i) => ({ line: i + 1, text: l.replace(/#.*/, '').trim() }))
    .filter((l) => l.text);
}

export function runStep(d: Driver, text: string): string[] {
  const [ps, ...rest] = text.split(' ');
  const p = Number(ps);
  if (!(p >= 1 && p <= d.e.players.length)) throw new DriverError(`bad player "${ps}"`);
  const words = rest.join(' ');
  const until = (cond: () => boolean) => {
    for (let n = 0; !cond(); n++) {
      if (n > MAX_WAIT) throw new DriverError('timed out waiting');
      d.step();
    }
  };
  let m: RegExpMatchArray | null;
  if ((m = words.match(/^walk (\d+),(\d+)$/))) {
    d.walk(p, Number(m[1]), Number(m[2]));
    return [];
  }
  if ((m = words.match(/^wait (\d+)$/))) {
    d.step(Number(m[1]));
    return [];
  }
  if ((m = words.match(/^until !(\d+)$/))) {
    const sc = Number(m[1]);
    until(() => !d.e.isScriptRunning(sc));
    return [];
  }
  if ((m = words.match(/^until a(\d+)(!?)=(\d+)$/))) {
    const [, act, neg, room] = m;
    until(() => (d.e.actors[Number(act)].room === Number(room)) !== !!neg);
    return [];
  }
  if (words === 'idle') {
    d.idle(p, { skip: true });
    return [];
  }
  if ((m = words.match(/^dial (var)?(\d+)$/))) return [`dialed ${d.dial(p, m[1] ? Number(m[2]) : m[2])}`];
  if ((m = words.match(/^assert (.+)$/))) {
    const what = m[1];
    let ok: boolean;
    if (what === 'won') ok = d.won;
    else if (what.startsWith('has ')) ok = d.has(p, what.slice(4));
    else if (what.startsWith('!script')) ok = !d.e.isScriptRunning(Number(what.slice(7)));
    else if (what.startsWith('script')) ok = d.e.isScriptRunning(Number(what.slice(6)));
    else throw new DriverError(`unknown assertion "${what}"`);
    if (!ok) throw new DriverError(`assertion failed: ${what}`);
    return [];
  }
  const verb = VERBS.find((v) => words.startsWith(v + ' '));
  if (!verb) throw new DriverError(`unknown step "${words}"`);
  const [a, b] = words.slice(verb.length + 1).split(/ (?:with|to|on|in) /);
  return d.do(p, verb, arg(a), b === undefined ? undefined : arg(b), { skip: true });
}

/** Run a whole route. Throws RouteError at the first failing step. */
export function runRoute(d: Driver, text: string, onStep?: (s: RouteStep) => void) {
  d.start();
  for (const step of parseRoute(text)) {
    let output: string[];
    try {
      output = runStep(d, step.text);
    } catch (err) {
      throw new RouteError(step, (err as Error).message);
    }
    onStep?.({ line: step.line, text: step.text, player: Number(step.text.split(' ')[0]), output });
  }
}
