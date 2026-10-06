// Wire protocol between the relay server and browsers. The server never sees the ROM: it orders
// commands into ticks, and every client runs the same deterministic engine over that log.

import type { Command } from '../engine/session';
import type { KidName } from '../engine/session';

/** Engine frames per second; one server tick advances every client's engine by one frame. */
export const TICK_HZ = 15;

export interface GameInfo {
  id: string;
  kids: KidName[];
  seed: number;
  /** CRC-32 of the PRG data, so both players run the same ROM. */
  romCrc: number;
  createdAt: number;
}

export interface Seat {
  player: number;
  kid: KidName;
  token: string;
}

/** A command as stored and broadcast: the tick it applies at, and who sent it. */
export type LoggedCommand = [tick: number, player: number, cmd: Command];

export type ServerMessage =
  | { type: 'welcome'; player: number; game: GameInfo; tick: number; log: LoggedCommand[]; online: number[] }
  | { type: 'tick'; tick: number; cmds: [player: number, cmd: Command][] }
  | { type: 'presence'; online: number[] }
  | { type: 'error'; message: string };

export type ClientMessage = { type: 'cmd'; cmd: Command } | { type: 'ping' };

export interface CreateGameRequest {
  kids: KidName[];
  romCrc: number;
}

export interface CreateGameResponse {
  game: GameInfo;
  seats: Seat[];
}

const KID_NAMES = new Set(['syd', 'razor', 'michael', 'bernard', 'wendy', 'jeff']);

/** Validate the shape of a client command (semantics are the engine's job, identically on every client). */
export function parseCommand(raw: unknown, player: number): Command | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 0x10000;
  switch (c.type) {
    case 'walk':
      return int(c.x) && int(c.y) ? { type: 'walk', player, x: c.x as number, y: c.y as number } : null;
    case 'sentence':
      return int(c.verb) && int(c.a) && (c.b === undefined || int(c.b)) ? { type: 'sentence', player, verb: c.verb as number, a: c.a as number, b: (c.b as number) ?? 0 } : null;
    case 'stop':
      return { type: 'stop', player };
    case 'skip':
      return { type: 'skip', player };
  }
  return null;
}

export function parseCreate(raw: unknown): CreateGameRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.kids) || r.kids.length !== 2 || !r.kids.every((k) => typeof k === 'string' && KID_NAMES.has(k))) return null;
  if (r.kids[0] === r.kids[1]) return null;
  if (typeof r.romCrc !== 'number') return null;
  return { kids: r.kids as KidName[], romCrc: r.romCrc };
}
