import { describe, expect, test } from 'bun:test';
import { Session } from '../src/engine/session';
import { NewLines, type SpokenLine, Voices, speakable } from '../src/web/voices';
import { haveRom, rom } from './rom-fixture';

describe.skipIf(!haveRom)('voices', () => {
  test("characters' lines are spoken once each as they appear; narration is not", () => {
    const s = new Session(rom(), { kids: ['bernard', 'michael'] }); // with the intro
    const lines = new NewLines();
    const said: string[] = [];
    for (let i = 0; i < 1500; i++) {
      s.step();
      for (const l of lines.update(s, [1])) said.push(`${l.actor}:${l.text}`);
    }
    // Dave's speech in the intro, each line once and in order; Bernard's reply; no narration.
    expect(said.slice(0, 3)).toEqual(['3:Ok! This looks like the\nold mansion.', '3:I\'m sure I saw Dr. Fred take\nSandy here.', "3:It's up to us to get her out."]);
    expect(said).toContain("5:Ok, I'm outta here!");
    expect(new Set(said).size).toBe(said.length);
    expect(said.some((l) => l.startsWith('255:'))).toBe(false);
  });

  test('NES text made speakable', () => {
    expect(speakable("If anyone wants out^")).toBe('If anyone wants out...');
    expect(speakable("BERNARD!\nDon't be a tuna head!")).toBe("BERNARD! Don't be a tuna head!");
  });

  test('a line finishes before the next; the newest waiting line wins; each character keeps one voice', () => {
    // A stand-in for the browser's speech engine.
    class Utterance {
      voice: { name: string; lang: string } | null = null;
      lang = '';
      pitch = 1;
      rate = 1;
      volume = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = Utterance;
    const voices = [
      { name: 'Daniel', lang: 'en-GB' },
      { name: 'Sandy (English (United States))', lang: 'en-US' },
      { name: 'Fred', lang: 'en-US' },
    ];
    const said: Utterance[] = [];
    let cancels = 0;
    const synth = {
      speaking: false,
      pending: false,
      getVoices: () => voices,
      speak(u: Utterance) {
        said.push(u);
        this.speaking = true;
      },
      cancel() {
        cancels++;
      },
    };
    const v = new Voices(() => false, synth as unknown as SpeechSynthesis);
    const line = (actor: number, name: string, text: string): SpokenLine => ({ actor, name, text });
    const end = () => {
      synth.speaking = false;
      said[said.length - 1].onend!();
    };
    v.hear([line(9, 'Dr Fred', 'Well, my dear.')]);
    v.hear([line(23, 'Sandy', 'You will never get away with this!')]); // waits
    v.hear([line(23, 'Sandy', 'Dave and his friends will rescue me!')]); // replaces the waiting line
    expect(said.map((u) => u.text)).toEqual(['Well, my dear.']);
    end();
    expect(said.map((u) => u.text)).toEqual(['Well, my dear.', 'Dave and his friends will rescue me!']);
    end();
    v.hear([line(23, 'Sandy', 'You and your meteor can eat slime!')]);
    expect(cancels).toBe(0);
    // Dr Fred and Sandy get the voices named after them, and Sandy keeps hers line after line.
    expect(said.map((u) => u.voice?.name)).toEqual(['Fred', 'Sandy (English (United States))', 'Sandy (English (United States))']);
    expect(said.every((u) => u.lang === u.voice?.lang)).toBe(true);
    // A lost end event doesn't stall speech forever.
    synth.speaking = false;
    v.hear([line(9, 'Dr Fred', "That's what she thinks!")]);
    expect(said[said.length - 1].text).toBe("That's what she thinks!");
  });
});
