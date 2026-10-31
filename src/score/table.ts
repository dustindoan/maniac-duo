// The points table for the high-score board. Shared by the browser (which scores the game as it
// runs) and the relay (which checks what browsers report). It holds only numbers and our own
// words: item names come from each player's ROM, so nothing from the game is stored server-side.

/**
 * Things a kid can get: objects whose "Get" picks them up, plus those another script hands over
 * (the CD players the intro gives out don't count). Each scores the first time a player's kid
 * holds it.
 */
export const ITEMS = [
  30, 31, 32, 33, 34, 45, 55, 56, 57, 58, 60, 73, 76, 80, 83, 84, 86, 87, 90, 91, 92, 93, 94, 96, 97, 104, 107, 123, 128, 129, 130, 132,
  133, 141, 142, 152, 153, 158, 165, 167, 178, 188, 189, 192, 198, 199, 200, 210, 211, 212, 214, 215, 216, 221, 222, 242, 243, 244, 245,
  246, 247,
];
export const ITEM_POINTS = 25;

/** Story beats, in the order a game usually reaches them. */
export const BEATS = {
  door: { points: 100, label: 'Opened the front door' },
  dungeon: { points: 250, label: 'Got out of the dungeon' },
  police: { points: 400, label: 'Called the Meteor Police' },
  tentacle: { points: 400, label: 'Won over Purple Tentacle' },
  deal: { points: 800, label: 'Landed a record or book deal' },
  won: { points: 2500, label: 'Freed Dr. Fred' },
} as const;
export type Beat = keyof typeof BEATS;

/** The most the table gives. Some paths can't be combined, so few games come close. */
export const MAX_POINTS = ITEMS.length * ITEM_POINTS + Object.values(BEATS).reduce((n, b) => n + b.points, 0);

/** A milestone id: a beat's name, or "item:<object>". */
export function pointsOf(id: string): number | null {
  if (id in BEATS) return BEATS[id as Beat].points;
  const m = id.match(/^item:(\d+)$/);
  return m && ITEMS.includes(Number(m[1])) ? ITEM_POINTS : null;
}
