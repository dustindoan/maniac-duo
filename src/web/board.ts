// The high-score board, after the Meteor Mess arcade machine's (room 39 of the game). With your
// ROM loaded it's drawn from the ROM itself: the machine's title, its panel stretched to ten rows,
// and the game's font. Without one, a look-alike in plain HTML. Each line opens that game's page.

import { type Surface, compose, drawBackground, surface, toRGBA } from '../gfx/nes';
import { Font, WHITE } from '../gfx/view';
import type { Rom } from '../rom/rom';
import type { GameSummary, ScoreRow } from '../server/protocol';
import { BEATS, type Beat, MAX_POINTS } from '../score/table';

const ROOM = 39;
/** Room 39's panel: its top border starts at row 16, rows 24-79 hold the title, row 76 is clean panel. */
const TOP = 16;
const TITLE_END = 80;
const CLEAN = 76;
const BORDER_ROWS = 7;
/** The panel spans x 16-207: the machine's screen. */
const LEFT = 16;
const WIDTH = 192;
const ROWS = 10;
const ROW_H = 12;

/**
 * The line for one game: both players' initials, '!' if they won, and the score in four digits as
 * the machine shows it. (The NES font has letters, digits and a little punctuation: no '+' or '*'.)
 */
function line(r: ScoreRow): string {
  const who = r.initials.map((i) => (i || '---').padEnd(3)).join(' ');
  return `${who}${r.won ? '!' : ' '}  ${String(Math.min(r.points, 9999)).padStart(4, '0')}`;
}

/** The board as a picture from the ROM: the machine's title, then a row per game. */
export function drawBoard(rom: Rom, rows: ScoreRow[]): Surface {
  const room = rom.rooms[ROOM]!;
  const bg = drawBackground(rom, room, compose(room, []), true).surface;
  const body = ROWS * ROW_H + 8;
  const out = surface(WIDTH, TITLE_END - TOP + body + BORDER_ROWS);
  const copy = (sy: number, dy: number) => out.px.set(bg.px.subarray(sy * bg.w + LEFT, sy * bg.w + LEFT + WIDTH), dy * WIDTH);
  for (let y = TOP; y < TITLE_END; y++) copy(y, y - TOP);
  for (let y = 0; y < body; y++) copy(CLEAN, TITLE_END - TOP + y);
  // Close the panel with its top border, upside down.
  for (let i = 0; i < BORDER_ROWS; i++) copy(TOP + i, out.h - 1 - i);
  const font = new Font(rom);
  const lines = rows.length ? rows.slice(0, ROWS).map(line) : ['NO SCORES YET'];
  lines.forEach((text, i) => font.draw(out, text, (WIDTH - text.length * 8) >> 1, TITLE_END - TOP + 6 + i * ROW_H, WHITE));
  return out;
}

/** Put the board in `el`: from the ROM if there is one, else as HTML. */
export function renderBoard(el: HTMLElement, rows: ScoreRow[], rom: Rom | null) {
  el.replaceChildren();
  const list = document.createElement('ol');
  list.className = 'mm-rows';
  for (const r of rows.slice(0, ROWS)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#g=${r.game}`;
    a.title = `${r.kids.map(cap).join(' and ')}, ${r.minutes} min${r.won ? ', won' : ''}`;
    a.textContent = line(r);
    li.append(a);
    list.append(li);
  }
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = 'No scores yet';
    list.append(li);
  }
  if (!rom) {
    el.className = 'mm';
    const title = document.createElement('h2');
    title.textContent = 'Meteor Mess';
    const sub = document.createElement('p');
    sub.textContent = 'High score';
    el.append(title, sub, list);
    return;
  }
  el.className = 'mm-rom';
  const pic = drawBoard(rom, rows);
  const canvas = document.createElement('canvas');
  canvas.width = pic.w;
  canvas.height = pic.h;
  canvas.setAttribute('aria-hidden', 'true');
  const img = canvas.getContext('2d')!.createImageData(pic.w, pic.h);
  toRGBA(pic, img.data);
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  canvas.onclick = (ev) => {
    const r = canvas.getBoundingClientRect();
    const y = ((ev.clientY - r.top) / r.height) * pic.h - (TITLE_END - TOP + 4);
    const row = rows[Math.floor(y / ROW_H)];
    if (y >= 0 && row) location.hash = `g=${row.game}`;
  };
  // The same lines as links, for keyboards and screen readers.
  list.classList.add('visually-hidden');
  el.append(canvas, list);
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const clock = (tick: number) => {
  const s = Math.floor(tick / 15);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** An item's name, from your ROM (the server never has it). */
function itemName(rom: Rom | null, obj: number): string {
  for (const room of rom?.rooms ?? []) for (const o of room?.objects ?? []) if (o.id === obj) return `the ${String.fromCharCode(...o.name).replace(/@/g, '').trim()}`;
  return 'an item';
}

/** One game's page on the board: who, how far, and when each milestone came. */
export function renderSummary(el: HTMLElement, s: GameSummary, rom: Rom | null) {
  el.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = `${s.kids.map(cap).join(' and ')}: ${s.points} of ${MAX_POINTS}`;
  const who = document.createElement('p');
  who.className = 'lede';
  const names = s.initials.map((i, n) => `${i || '---'} played ${cap(s.kids[n])}`).join(', ');
  who.textContent = `${names}. ${s.minutes} minutes of play, started ${new Date(s.createdAt).toLocaleDateString()}.${s.won ? ' They won.' : ''}`;
  const list = document.createElement('ol');
  list.className = 'timeline';
  for (const m of s.reached) {
    const li = document.createElement('li');
    const item = m.id.match(/^item:(\d+)$/);
    const what = item ? `Found ${itemName(rom, Number(item[1]))}` : (BEATS[m.id as Beat]?.label ?? m.id);
    li.textContent = `${clock(m.tick)}  ${what}`;
    list.append(li);
  }
  const back = document.createElement('p');
  back.innerHTML = '<a href="#">Back to the board</a>';
  el.append(h, who, list, back);
  if (!rom) {
    const note = document.createElement('p');
    note.className = 'lede';
    note.textContent = 'Load your ROM on the front page to see which items they found.';
    el.append(note);
  }
}
