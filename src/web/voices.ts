// Voices: characters' lines read aloud by the browser's speech synthesis, as they appear in the
// rooms this screen shows. Only lines a character says (the ones with mouth animation), not
// narration. Presentation only: it reads the world and never changes it.

import type { Session } from '../engine/session';

/** A line someone says. */
export interface SpokenLine {
  actor: number;
  name: string;
  text: string;
}

/** Characters' lines that have just appeared on screen. */
export class NewLines {
  private shown = new Set<string>();

  update(s: Session, viewers: number[]): SpokenLine[] {
    const now = new Map<string, SpokenLine>();
    for (const p of viewers) for (const l of s.dialogueFor(p)) if (l.actor < 0x80) now.set(`${l.actor}:${l.text}`, { actor: l.actor, name: s.engine.nameOf(l.actor), text: l.text });
    const fresh = [...now].filter(([k]) => !this.shown.has(k)).map(([, l]) => l);
    this.shown = new Set(now.keys());
    return fresh;
  }
}

/** What a line sounds like read aloud: NES line breaks and the '^' ellipsis glyph made speakable. */
export function speakable(text: string): string {
  return text.replace(/\^/g, '...').replace(/\s+/g, ' ').trim();
}

interface Profile {
  female?: boolean;
  pitch: number;
  rate?: number;
}

/** How each character sounds (actor numbers from the game); anyone else gets the default. */
const PROFILES: Record<number, Profile> = {
  1: { pitch: 1.05 }, // Syd
  2: { female: true, pitch: 1.2 }, // Razor
  3: { pitch: 1 }, // Dave
  4: { pitch: 0.95 }, // Michael
  5: { pitch: 1.25 }, // Bernard
  6: { female: true, pitch: 1.3 }, // Wendy
  7: { pitch: 1 }, // Jeff
  9: { pitch: 0.8, rate: 0.95 }, // Dr Fred
  10: { female: true, pitch: 1.05 }, // Nurse Edna
  11: { pitch: 0.9 }, // Weird Ed
  12: { pitch: 0.5, rate: 0.85 }, // Dead Cousin Ted
  13: { pitch: 0.6, rate: 0.9 }, // Purple Tentacle
  14: { pitch: 0.7, rate: 0.9 }, // Green Tentacle
  19: { pitch: 0.4, rate: 0.85 }, // Plant
  23: { female: true, pitch: 1.35 }, // Sandy
};
/** Natural speed. */
const RATE = 1;
const FEMALE = /female|samantha|victoria|karen|moira|tessa|fiona|zira|susan|serena|allison|ava|kate|kathy|ellen|flo|shelley|grandma|sandy|google us english/i;
const MALE = /\bmale|alex|daniel|fred|tom|aaron|arthur|oliver|rishi|david|mark|george|eddy|reed|rocko|grandpa|ralph|junior/i;
/** macOS's novelty voices (singing, bells, robots): fun, but not for the cast. */
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox/i;
const VOICES_KEY = 'maniac-duo.voices';

/**
 * Speaks characters' lines, one at a time. A line is let finish, but speech is never more than one
 * line behind the text: a line still waiting its turn when another arrives is dropped.
 */
export class Voices {
  enabled = true;
  private lines = new NewLines();
  private synth = globalThis.speechSynthesis as SpeechSynthesis | undefined;

  constructor(private muted: () => boolean) {
    try {
      this.enabled = localStorage.getItem(VOICES_KEY) !== '0';
    } catch {}
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.silence();
    try {
      localStorage.setItem(VOICES_KEY, this.enabled ? '1' : '0');
    } catch {}
  }

  silence() {
    this.synth?.cancel();
  }

  /** Call once per engine tick: says whatever characters have just started saying. */
  update(s: Session, viewers: number[]) {
    const fresh = this.lines.update(s, viewers);
    if (!fresh.length || !this.synth || !this.enabled || this.muted()) return;
    if (this.synth.pending) this.synth.cancel();
    this.say(fresh[fresh.length - 1]);
  }

  private say(l: SpokenLine) {
    const u = new SpeechSynthesisUtterance(speakable(l.text));
    const p = PROFILES[l.actor] ?? { pitch: 1 };
    u.voice = this.voiceFor(l, p);
    u.pitch = p.pitch;
    u.rate = RATE * (p.rate ?? 1);
    u.volume = 1;
    this.synth!.speak(u);
  }

  /**
   * An English voice: one named like the character if there is one (Dr Fred, Sandy), else one of
   * the right kind, a different one per character where there are several.
   */
  private voiceFor(l: SpokenLine, p: Profile): SpeechSynthesisVoice | null {
    const english = this.synth!.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en') && !NOVELTY.test(v.name));
    const own = l.name.split(' ').pop()!.toLowerCase();
    const named = english.find((v) => v.name.toLowerCase().split(' ')[0] === own);
    if (named) return named;
    const kind = english.filter((v) => (p.female ? FEMALE : MALE).test(v.name));
    const pool = kind.length ? kind : english;
    return pool.length ? pool[l.actor % pool.length] : null;
  }
}
