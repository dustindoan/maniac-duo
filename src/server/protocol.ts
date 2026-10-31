// Wire protocol between the relay server and browsers. The server never sees the ROM: it orders
// commands into ticks, and every client runs the same deterministic engine over that log.

import type { Command } from '../engine/session';
import type { Milestone } from '../score/scorer';
import { pointsOf } from '../score/table';
import type { KidName } from '../engine/session';

/** Engine frames per second; one server tick advances every client's engine by one frame. */
export const TICK_HZ = 15;

export interface GameInfo {
  id: string;
  kids: KidName[];
  seed: number;
  /** CRC-32 of the PRG data, so both players run the same ROM. */
  romCrc: number;
  /** Our additions to the story this game has (src/story); games keep the rules they began with. */
  rules: number;
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
  /** Another player's world fingerprint at a tick; yours should match (desync check). */
  | { type: 'hash'; player: number; tick: number; hash: string }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'cmd'; cmd: Command }
  | { type: 'hash'; tick: number; hash: string }
  /** Every milestone this run of the game has reached (src/score), sent when one is added. */
  | { type: 'score'; reached: Milestone[] }
  | { type: 'ping' };

export interface CreateGameRequest {
  kids: KidName[];
  romCrc: number;
}

/** A seat holder's view of their game. Seat 1, who created it, can always get seat 2's invite. */
export interface SeatInfo {
  game: GameInfo;
  player: number;
  online: number[];
  invite?: string;
}

/** A line on the high-score board. */
export interface ScoreRow {
  game: string;
  kids: KidName[];
  /** Each seat's initials, '' until they've entered some. */
  initials: string[];
  points: number;
  won: boolean;
  /** Minutes the game has been played. */
  minutes: number;
  /** When the score was last raised. */
  at: number;
}

/** What anyone may see of a game on the board: no seat links, no moves. */
export interface GameSummary extends ScoreRow {
  max: number;
  reached: Milestone[];
  createdAt: number;
}

/** How busy the server is, for the lobby. */
export interface Stats {
  /** Games with someone connected. */
  playing: number;
  /** Seats connected, across those games. */
  players: number;
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

/** Validate a client's world fingerprint; the server passes it on without interpreting it. */
export function parseHash(raw: unknown): { tick: number; hash: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.tick !== 'number' || !Number.isInteger(r.tick) || r.tick < 0) return null;
  if (typeof r.hash !== 'string' || !/^[0-9a-f]{1,16}$/.test(r.hash)) return null;
  return { tick: r.tick, hash: r.hash };
}

/** Check a browser's score report against the points table; the points are worked out here. */
export function parseScore(raw: unknown): { reached: Milestone[]; points: number; won: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const list = (raw as Record<string, unknown>).reached;
  if (!Array.isArray(list) || list.length > 200) return null;
  const reached: Milestone[] = [];
  const ids = new Set<string>();
  let points = 0;
  for (const m of list) {
    if (!m || typeof m !== 'object') return null;
    const { id, tick } = m as Record<string, unknown>;
    if (typeof id !== 'string' || typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0 || ids.has(id)) return null;
    const p = pointsOf(id);
    if (p === null) return null;
    ids.add(id);
    points += p;
    reached.push({ id, tick });
  }
  return { reached, points, won: ids.has('won') };
}

/** Initials for the board: one to three letters. */
export function parseInitials(raw: unknown): string | null {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).initials : null;
  if (typeof v !== 'string') return null;
  const up = v.trim().toUpperCase();
  return /^[A-Z]{1,3}$/.test(up) ? up : null;
}
