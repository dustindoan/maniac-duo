// Per-game lockstep clock. Ticks advance only while at least one player is connected, so the
// world waits for you when nobody is playing. Commands are stamped into the next tick in arrival order.

import type { Command } from '../engine/session';
import type { Store } from './store';
import { type ServerMessage, TICK_HZ } from './protocol';

export interface Peer {
  player: number;
  send(msg: ServerMessage): void;
}

export class Relay {
  peers = new Set<Peer>();
  tick: number;
  private pending: [number, Command][] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private persistEvery = TICK_HZ * 5;

  constructor(
    public gameId: string,
    private store: Store,
    startTick: number,
    private tickMs = 1000 / TICK_HZ,
  ) {
    this.tick = startTick;
  }

  online(): number[] {
    return [...new Set([...this.peers].map((p) => p.player))].sort();
  }

  join(peer: Peer) {
    this.peers.add(peer);
    const game = this.store.game(this.gameId)!;
    peer.send({ type: 'welcome', player: peer.player, game: { id: game.id, kids: game.kids, seed: game.seed, romCrc: game.romCrc, createdAt: game.createdAt }, tick: this.tick, log: this.store.log(this.gameId), online: this.online() });
    this.broadcast({ type: 'presence', online: this.online() });
    if (!this.timer) this.timer = setInterval(() => this.advance(), this.tickMs);
  }

  leave(peer: Peer) {
    this.peers.delete(peer);
    this.broadcast({ type: 'presence', online: this.online() });
    if (this.peers.size === 0) this.stop();
  }

  submit(player: number, cmd: Command) {
    this.pending.push([player, cmd]);
  }

  /** One tick: commands stamped now apply before the engine's next frame on every client. */
  advance() {
    this.tick++;
    const cmds = this.pending;
    this.pending = [];
    if (cmds.length) this.store.append(this.gameId, this.tick, cmds);
    if (cmds.length || this.tick % this.persistEvery === 0) this.store.setTick(this.gameId, this.tick);
    this.broadcast({ type: 'tick', tick: this.tick, cmds });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store.setTick(this.gameId, this.tick);
  }

  private broadcast(msg: ServerMessage) {
    for (const p of this.peers) p.send(msg);
  }
}
