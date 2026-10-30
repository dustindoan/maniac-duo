// SQLite persistence for games, seats and the command log.
import { Database } from 'bun:sqlite';
import type { Command, KidName } from '../engine/session';
import type { GameInfo, LoggedCommand, Seat } from './protocol';

export class Store {
  db: Database;

  constructor(path = ':memory:') {
    this.db = new Database(path, { create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, kids TEXT NOT NULL, seed INTEGER NOT NULL, rom_crc INTEGER NOT NULL,
        created_at INTEGER NOT NULL, tick INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS seats (
        game_id TEXT NOT NULL, player INTEGER NOT NULL, kid TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
        PRIMARY KEY (game_id, player));
      CREATE TABLE IF NOT EXISTS commands (
        game_id TEXT NOT NULL, seq INTEGER NOT NULL, tick INTEGER NOT NULL, player INTEGER NOT NULL, cmd TEXT NOT NULL,
        PRIMARY KEY (game_id, seq));
    `);
    // Games created before rules existed have the original story.
    const cols = this.db.query('PRAGMA table_info(games)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'rules')) this.db.exec('ALTER TABLE games ADD COLUMN rules INTEGER NOT NULL DEFAULT 0');
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

  seatByToken(token: string): (Seat & { gameId: string }) | null {
    const r = this.db.query('SELECT * FROM seats WHERE token = ?').get(token) as Record<string, unknown> | null;
    return r ? { gameId: r.game_id as string, player: r.player as number, kid: r.kid as KidName, token: r.token as string } : null;
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
