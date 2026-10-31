// Abuse limits for a public relay: how fast anyone may create games or send messages, how much a
// game may hold, and how big the database may grow. Normal play stays far below every one of
// them (the busiest playtest player sent 15 moves in a second and 106 in ten; the longest game
// logged 3,156), so they only ever stop scripts.

export interface Limits {
  /** Games one address may create at once, and then one more every `createEveryMs`. */
  createBurst: number;
  createEveryMs: number;
  /** Games everyone together may create in an hour. */
  createPerHour: number;
  /** No new games once the database file is this big. */
  maxDbBytes: number;
  /**
   * Games being played at once (someone connected). Joining one more is refused. On the lab box,
   * 500 simulated games (busier than real ones) kept the clock at 14.3 of its 15 ticks a second.
   */
  activeGames: number;
  /** Open connections from one address. */
  socketsPerAddress: number;
  /** Messages one connection may send at once, and then per second. Beyond that they're dropped. */
  msgBurst: number;
  msgPerSecond: number;
  /** Largest message a connection may send, in bytes. */
  maxMessage: number;
  /** Moves one game's log may hold; beyond that its moves are dropped. */
  maxLog: number;
  /** A game nobody ever joined is deleted after this long. */
  unjoinedTtlMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  createBurst: 5,
  createEveryMs: 2 * 60_000,
  createPerHour: 300,
  maxDbBytes: 4e9,
  activeGames: 500,
  socketsPerAddress: 8,
  msgBurst: 60,
  msgPerSecond: 20,
  maxMessage: 4096,
  maxLog: 60_000,
  unjoinedTtlMs: 24 * 3_600_000,
};

/** A token bucket: `burst` at once, then one more every `everyMs`. */
export class Bucket {
  private tokens: number;
  private at: number;

  constructor(
    private burst: number,
    private everyMs: number,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.at = now;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.at) / this.everyMs);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  /** Full again: nothing taken lately. */
  full(now = Date.now()) {
    return this.tokens + (now - this.at) / this.everyMs >= this.burst;
  }
}

/** One bucket per key (an address), forgetting full ones now and then. */
export class Buckets {
  private map = new Map<string, Bucket>();
  private swept = Date.now();

  constructor(
    private burst: number,
    private everyMs: number,
  ) {}

  take(key: string, now = Date.now()): boolean {
    if (now - this.swept > 10 * 60_000) {
      for (const [k, b] of this.map) if (b.full(now)) this.map.delete(k);
      this.swept = now;
    }
    let b = this.map.get(key);
    if (!b) this.map.set(key, (b = new Bucket(this.burst, this.everyMs, now)));
    return b.take(now);
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The visitor's address. Behind the box's front (Caddy, on loopback), that's the X-Forwarded-For
 * it sets: Caddy believes the switchboard's PROXY header and replaces whatever a visitor sent.
 * From anywhere else, the header could be forged, so the connection's own address counts.
 */
export function clientAddress(req: Request, peer: string | undefined): string {
  if (peer && LOOPBACK.has(peer)) {
    const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return peer ?? 'unknown';
}
