// SQLite persistence for games, seats and the command log.
import { Database } from 'bun:sqlite';
import type { Command, KidName } from '../engine/session';
import type { Milestone } from '../score/scorer';
import { MAX_POINTS } from '../score/table';
import { TICK_HZ, type GameInfo, type GameSummary, type LoggedCommand, type ScoreRow, type Seat } from './protocol';

export class Store {
  db: Database;

  constructor(path = ':memory:') {
    this.db = new Database(path, { create: true });
    // WAL with synchronous = NORMAL: a commit doesn't wait for the disk (on the lab box, a flushed
    // commit took 8 ms, which held the whole relay to about 120 writes a second). A power cut can
    // lose the last moment of moves; it can't corrupt the database, and a crash loses nothing.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, kids TEXT NOT NULL, seed INTEGER NOT NULL, rom_crc INTEGER NOT NULL,
        created_at INTEGER NOT NULL, tick INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS seats (
        game_id TEXT NOT NULL, player INTEGER NOT NULL, kid TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
        PRIMARY KEY (game_id, player));
      CREATE TABLE IF NOT EXISTS commands (
        game_id TEXT NOT NULL, seq INTEGER NOT NULL, tick INTEGER NOT NULL, player INTEGER NOT NULL, cmd TEXT NOT NULL,
        PRIMARY KEY (game_id, seq));
      CREATE TABLE IF NOT EXISTS scores (
        game_id TEXT PRIMARY KEY, points INTEGER NOT NULL, reached TEXT NOT NULL, won INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS scores_points ON scores (points DESC, updated_at);
    `);
    // Games created before rules existed have the original story.
    const cols = this.db.query('PRAGMA table_info(games)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'rules')) this.db.exec('ALTER TABLE games ADD COLUMN rules INTEGER NOT NULL DEFAULT 0');
    const seatCols = this.db.query('PRAGMA table_info(seats)').all() as { name: string }[];
    if (!seatCols.some((c) => c.name === 'initials')) this.db.exec("ALTER TABLE seats ADD COLUMN initials TEXT NOT NULL DEFAULT ''");
  }

  /** Keep a game's best score: a run that scores more replaces it (a restart starts from nothing). */
  saveScore(gameId: string, points: number, reached: Milestone[], won: boolean, now = Date.now()): boolean {
    const r = this.db.query('SELECT points FROM scores WHERE game_id = ?').get(gameId) as { points: number } | null;
    if (r && r.points >= points) return false;
    this.db.query('INSERT OR REPLACE INTO scores (game_id, points, reached, won, updated_at) VALUES (?, ?, ?, ?, ?)').run(gameId, points, JSON.stringify(reached), won ? 1 : 0, now);
    return true;
  }

  setInitials(gameId: string, player: number, initials: string) {
    this.db.query('UPDATE seats SET initials = ? WHERE game_id = ? AND player = ?').run(initials, gameId, player);
  }

  private initialsOf(gameId: string): string[] {
    const rows = this.db.query('SELECT player, initials FROM seats WHERE game_id = ? ORDER BY player').all(gameId) as { initials: string }[];
    return rows.map((r) => r.initials);
  }

  private row(r: Record<string, unknown>): ScoreRow {
    return {
      game: r.id as string,
      kids: JSON.parse(r.kids as string) as KidName[],
      initials: this.initialsOf(r.id as string),
      points: r.points as number,
      won: !!r.won,
      minutes: Math.round((r.tick as number) / TICK_HZ / 60),
      at: r.updated_at as number,
    };
  }

  /** The high-score board: best first, and the earlier of two equal scores. */
  topScores(limit = 10): ScoreRow[] {
    const rows = this.db.query('SELECT g.id, g.kids, g.tick, s.points, s.won, s.updated_at FROM scores s JOIN games g ON g.id = s.game_id WHERE s.points > 0 ORDER BY s.points DESC, s.updated_at LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.row(r));
  }

  summary(gameId: string): GameSummary | null {
    const r = this.db.query('SELECT g.id, g.kids, g.tick, g.created_at, s.points, s.won, s.updated_at, s.reached FROM games g LEFT JOIN scores s ON s.game_id = g.id WHERE g.id = ?').get(gameId) as Record<string, unknown> | null;
    if (!r) return null;
    return { ...this.row({ ...r, points: r.points ?? 0, won: r.won ?? 0, updated_at: r.updated_at ?? r.created_at }), max: MAX_POINTS, reached: r.reached ? (JSON.parse(r.reached as string) as Milestone[]) : [], createdAt: r.created_at as number };
  }

  createGame(game: GameInfo, seats: Seat[]) {
    const tx = this.db.transaction(() => {
      this.db.query('INSERT INTO games (id, kids, seed, rom_crc, rules, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(game.id, JSON.stringify(game.kids), game.seed, game.romCrc, game.rules, game.createdAt);
      for (const s of seats) this.db.query('INSERT INTO seats (game_id, player, kid, token) VALUES (?, ?, ?, ?)').run(game.id, s.player, s.kid, s.token);
    });
    tx();
  }

  game(id: string): (GameInfo & { tick: number }) | null {
    const r = this.db.query('SELECT * FROM games WHERE id = ?').get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return { id: r.id as string, kids: JSON.parse(r.kids as string) as KidName[], seed: r.seed as number, romCrc: r.rom_crc as number, rules: r.rules as number, createdAt: r.created_at as number, tick: r.tick as number };
  }

  /** A seat's token, for the creator's invite link (seat 1 may always see seat 2's). */
  seatToken(gameId: string, player: number): string | null {
    const r = this.db.query('SELECT token FROM seats WHERE game_id = ? AND player = ?').get(gameId, player) as { token: string } | null;
    return r?.token ?? null;
  }

  seatByToken(token: string): (Seat & { gameId: string }) | null {
    const r = this.db.query('SELECT * FROM seats WHERE token = ?').get(token) as Record<string, unknown> | null;
    return r ? { gameId: r.game_id as string, player: r.player as number, kid: r.kid as KidName, token: r.token as string } : null;
  }

  logLength(gameId: string): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM commands WHERE game_id = ?').get(gameId) as { n: number }).n;
  }

  /** Delete games nobody ever joined (their clock never ran) that were created before `before`. */
  deleteUnjoined(before: number): number {
    const ids = (this.db.query('SELECT id FROM games WHERE tick = 0 AND created_at < ?').all(before) as { id: string }[]).map((r) => r.id);
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        this.db.query('DELETE FROM seats WHERE game_id = ?').run(id);
        this.db.query('DELETE FROM commands WHERE game_id = ?').run(id);
        this.db.query('DELETE FROM scores WHERE game_id = ?').run(id);
        this.db.query('DELETE FROM games WHERE id = ?').run(id);
      }
    });
    tx();
    return ids.length;
  }

  log(gameId: string): LoggedCommand[] {
    const rows = this.db.query('SELECT tick, player, cmd FROM commands WHERE game_id = ? ORDER BY seq').all(gameId) as { tick: number; player: number; cmd: string }[];
    return rows.map((r) => [r.tick, r.player, JSON.parse(r.cmd) as Command]);
  }

  append(gameId: string, tick: number, cmds: [number, Command][]) {
    const tx = this.db.transaction(() => {
      const row = this.db.query('SELECT COALESCE(MAX(seq), 0) AS s FROM commands WHERE game_id = ?').get(gameId) as { s: number };
      let seq = row.s;
      for (const [player, cmd] of cmds) this.db.query('INSERT INTO commands (game_id, seq, tick, player, cmd) VALUES (?, ?, ?, ?, ?)').run(gameId, ++seq, tick, player, JSON.stringify(cmd));
    });
    tx();
  }

  setTick(gameId: string, tick: number) {
    this.db.query('UPDATE games SET tick = ? WHERE id = ?').run(tick, gameId);
  }
}
