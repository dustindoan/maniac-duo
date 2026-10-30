// Our additions to the original story, by rules version. A game keeps the rules it was created
// with: every client replays a game's whole command log, so a game started before an addition
// must replay (and play on) without it.
//
//   0  the original story
//   1  Dave goes on ahead and holds the dungeon's loose brick (dave.ts)

import type { Story } from '../engine/engine';
import { dave } from './dave';

/** The rules new games are created with. */
export const RULES = 1;

export function storyFor(rules: number): Story | null {
  return rules >= 1 ? dave : null;
}
