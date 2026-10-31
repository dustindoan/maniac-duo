# Design

## The idea

NES *Maniac Mansion* shows one room on top and the verbs and inventory below. Here the picture is
still one NES screen (256x240, shown at 4:3), but its bottom half is the second player's room.
Each half is the original 224-pixel room view between black borders, showing 118 of the room's
128 rows: it follows the kid's feet, so what's left out is almost always ceiling or sky. The
dialogue and status lines are drawn over the scene. When everyone has to watch the same thing (the
intro, a world cutscene, or a player's cutscene that cuts away to another room), the split goes
away and that scene fills the screen in the original arrangement: dialogue, then the whole room,
with nothing below it. Each player controls exactly one kid. Dave is still in the game, but
nobody controls him: after the intro he goes on ahead, and waits in the dungeon to hold the loose
brick for whoever gets caught (see [Our additions to the story](#our-additions-to-the-story)).

Everything the game does comes from the ROM: rooms, objects, costumes, the font, and every script.
The engine is a TypeScript reimplementation of the SCUMM v1 interpreter (as used by the NES game),
following ScummVM's implementation, and extended in one important way: several players can be
"the current kid" in several rooms at the same time.

## Data flow

```
your ROM (browser, IndexedDB)            relay server (no ROM)
        |                                  |  game id, seat tokens
  src/rom  parse resources                 |  15 Hz tick clock (only while someone is online)
        |                                  |  ordered command log (SQLite)
  src/engine  Session <-- commands per tick -+
        |   deterministic: (seed, log) => world
  src/gfx  draw each player's half, or the scene everyone watches
        |
  src/web  canvas, controls, inventory overlay
```

The server never runs the game. Each browser runs the same deterministic engine over the same
command log, so the server only has to order commands. A player who joins later (or reloads)
replays the log to catch up. `test/lockstep.test.ts` checks the replay reproduces the world exactly.
When the game restarts ("Press 'B' button play again" after a game over), the session builds a
new game at that tick, with the same kids and a seed derived from the first, so every client
starts over together. Every 60 ticks each client shares a fingerprint of its world through the server, and says so if
its partner's differs. If the engine ever throws on a command or a frame, every client throws at
the same point, so play carries on (`Lockstep.errors`) instead of leaving a log nobody can load.

## Several kids at once: contexts

The original engine has one current room, one camera, one `VAR_EGO`, one sentence queue and one
message line. Here each of those belongs to a **context**:

- **Player contexts** (one per player): that player's kid, room, camera, sentence queue, message,
  cursor state and cutscene state.
- **The system context**: boot, timers and NPCs. During a world cutscene it is the *director*,
  whose camera both players watch.

Every script slot records its context. When a slot runs, its context's variables are swapped in
(`CTX_VARS` in `src/engine/engine.ts`: ego, room, camera, sentence and click variables, message
state, lights), so the unmodified scripts see "their" kid and room. Scripts inherit the context of
whatever started them, with these rules:

- **Sentence, input and per-room scripts** (2, 3, 4, 5, 7) exist once per player.
- **NPC behaviour and world timers** (Edna 36-40, Fred and Purple Tentacle 47-48, Ed 87-98, the
  doorbell 12, package delivery 111, Meteor Police 136, Edna's kitchen timer 152) always run in
  the system context, whoever started them. In the system context, the ego and room variables
  alternate between the players frame by frame, so "is a kid in my room?" checks treat both kids
  fairly. Without this, Edna would only ever hunt the player who first set her off.
- **A room is loaded while anyone (either player or the director) is in it.** Actors walk and
  animate in every loaded room. Entry scripts run for each player who enters; exit scripts run
  when the last viewer leaves.
- **Cutscenes**: a player's own cutscene freezes that player and plays in their half. If it cuts
  away to a room their kid isn't in (Dr. Fred and Sandy in the lab, the Meteor Police on the
  radio), it is a story scene: it fills the screen and the other players wait (`Engine.cutAway`).
  A world cutscene freezes everyone; if it moves the camera, it fills the screen too. Anyone can
  skip what everyone is watching. Players whose kid was moved to another room by someone else's
  script (for example, captured into the dungeon) follow their kid once the cutscene is over.
- **"Meanwhile..."**: when a scene takes over the screen, the world pauses for a moment: the
  split screen fades to black, and the scene fades in (`Session.meanwhile`). Players whose kid
  isn't in the scene see "Meanwhile..." on black in between, after Day of the Tentacle; a player
  whose kid is in it (just caught, say) sees only the fade, and if every kid is, there's no card
  to hold. Skipping during the card ends it.
- **Freezes**: a player's freeze (their cutscene, a keypad) also holds the world's scripts, as in
  the original. While a world cutscene runs, a player's freeze of world scripts waits for it to
  end (`Slot.held`): the player can't act meanwhile, so nothing would ever release it.
- **Distances between different rooms are infinite.** With several rooms live, "nearest kid" must
  never find someone in another room.

The rest follows ScummVM: walk boxes and the box matrix, actor walking in 8x2-pixel steps, costume
animation, object state bits, inventory, messages and talk timing.

## Our additions to the story

With two kids instead of three, some of the original's puzzles assume a kid to spare. Where that
makes co-op worse, we add to the story rather than change the original scripts. The additions are
scripts in the game's own bytecode (`src/story`), written with a small assembler that is the
decoder in reverse (`src/engine/asm.ts`), so they get cutscenes, skipping, dialogue, voices and
walking from the same VM as everything else, and `tools/disasm.ts` can print them. The engine
takes them as a `Story`: extra global scripts (numbered from 200, above the ROM's), a script to
start when the players take over from the intro, object verbs that run an added script instead of
the object's own, and which added scripts are NPC behaviour (system context) or exist per player.
Their state lives in variables 240 and up, which the ROM never uses.

Additions are versioned as **rules**, stored with each game (`src/story/index.ts`). Every client
replays a game's whole command log, so a game keeps the rules it began with: one started before an
addition replays, and plays on, without it.

**Rules 1: Dave and the loose brick.** In the original, pushing the dungeon's loose brick opens the
cell door for three seconds (script 137), and the door won't let whoever pushed it out: it shuts
instead (door 159 checks Var[214]). So escaping always cost a second kid, who stayed behind, until
someone found the old rusty key. With two players, one of them was left pushing a brick.

- After the intro's last line, "Ok, let's go rescue Sandy!", Dave walks off toward the house while
  the players already have control, and is next seen in the dungeon, standing out of the way of
  the cell (the original even keeps a cell spot for him: script 146).
- The first time a kid pushes the brick, the door opens and that kid asks Dave to hold it, in a
  short scene in their half: "Dave! Can you hold this brick in for me?" "Sure. Go find Sandy!"
  Dave takes over the brick. Skipping the scene leaves him holding it all the same.
- After that, pushing the brick opens the door at once, and Dave comes over without a word; the
  kid doesn't have to wait for him.
- Dave holds the door while either kid is still in the dungeon, or until someone goes through (the
  door shuts behind them, as in the original); then he goes back to his spot.
- If Dave isn't in the dungeon, the brick works exactly as the original.

## Running it in public

The relay is cheap: a game costs a 15 Hz timer while someone is connected and a few hundred
bytes per minute of moves (a 41-minute playtest logged 3,156 moves, about 120 KB). What a public
relay has to stop is scripts, so `src/server/limits.ts` caps how fast an address may create games
(5, then one every two minutes) and how many everyone may create in an hour, how many games are
played at once (500: on the lab box the clock held 14.3 of its 15 ticks a second there, under
twice the moves real players send), connections per address, and
each connection's message rate and size (well above the busiest playtest: 15 moves in a second).
A game's log stops at 60,000 moves, there are no new games past 4 GB of database, and games
nobody ever joined are deleted after a day. One connection holds a seat: a new tab takes over.
The database doesn't wait for the disk on each commit (WAL with `synchronous = NORMAL`): on the
lab box a flushed commit took 8 ms, which held the whole relay to about 120 writes a second and
fell behind at 100 games. A power cut can lose the last moment of moves; a crash loses nothing.
Visitors' addresses come from the box's front (Caddy believes the switchboard's PROXY header and
sets X-Forwarded-For), and only from loopback.

There are no accounts: a seat link is the credential, and needing the ROM already keeps out
anyone who isn't playing.

## The high-score board

After the Meteor Mess arcade machine in the game room (room 39, which a quarter in the machine
shows for five seconds). Points (`src/score/table.ts`) come from items (each object a player's
kid first holds: 25) and story beats (the front door, getting out of the dungeon, calling the
Meteor Police, Purple Tentacle giving in, a record or book deal, freeing Dr. Fred), 5,975 in all.
The scorer runs in each browser beside the engine, from the world's state alone, so every client
of a game agrees; a restart starts a new run.

The server has no ROM, so it can't score a game itself: browsers report the milestones reached,
and the relay works out the points from the table, refusing unknown or repeated milestones and
ticks its clock hasn't reached. A forged score is still possible, but a game is entirely
determined by its seed and its log, which the relay keeps, so any score can be checked by
replaying it (not built yet). The table holds only numbers and our own words: an item's name on a
game's page comes from the viewer's ROM.

With your ROM loaded, the board is drawn from it: the machine's title from room 39, its panel
stretched to ten rows, and the game's font. Without one it's an HTML look-alike.

## Sound

`src/sound/driver.ts` is the game's own sound driver (ported from ScummVM's NES player). It runs
inside the engine, 60 times a second (`delta` steps per engine frame), because scripts wait for
sounds to finish: how long a sound runs comes from its data, deterministically, on every client.
Its output is a list of sound-chip register writes per engine frame. The browser feeds those to
`src/sound/apu.ts`, an NES sound chip (two square waves, a triangle, noise), and queues the
samples a little ahead of the speakers (`src/web/audio.ts`), nudging playback speed by at most 2%
so uneven ticks neither stutter nor lag. Nothing the chip does feeds back into the game. The
noise channel, which most sound effects use, is mixed at its NES level relative to the squares
(ScummVM's simplified chip has it at half that).

Footsteps are ours, not the original's: a soft NES-noise scuff each time a walking actor's foot
lands (twice per walk cycle), for the rooms on your screen (`src/web/footsteps.ts`). They play
in the browser beside the chip, not through the game's driver, whose effects would mute the
music, and nothing in the game depends on them.

Voices are ours too: characters' lines (anything a character says, the lines with mouth
animation, never narration) are read aloud by the browser's speech synthesis as they appear on
your screen (`src/web/voices.ts`). Each character gets an English system voice of the right
kind and a pitch of their own (a voice named like them if there is one). A line is let finish;
a line still waiting its turn when another appears is dropped, so speech is never more than a
line behind the text. The waiting line is kept by us rather than queued in the browser, because
Chrome can lose a chosen voice after `speechSynthesis.cancel()`. V toggles voices; M silences them with everything else.

There is one driver, as there was one chip: both players hear every sound and the music, whichever
room it comes from, and a sound effect mutes the music while it plays, as in the original.

Two NES-specific findings worth knowing:

- NES MM shows 28 tiles of room, not 32. Scripts depend on this: the title sequence pans the
  camera until it reaches column 45, which a 32-tile view can't reach.
- An object's "on" state draws an image patch over the room. For things you can pick up, the
  patch shows the empty spot, which is how picking up the key makes it vanish.

## The verb system

Each object in the ROM has a verb table: the verbs its script handles. NES MM has eleven verbs,
and only two of them take a second object (Use X with Y, Give X to Y). From that
(`src/verbs/affordances.ts`):

1. **Offer only verbs the object's script handles.** Everything else would get "That doesn't
   seem to work."
2. **Verbs that run the very same script are the same action**, so show it once, under its
   plainest name (Pull beats Get; Get and Read have extra rules in the sentence script).
3. **Toggles show the half that applies.** A closed door offers Open, an open door offers Go to
   and Close, a flat door mat offers Pull, a pulled one offers Push. A closed door doesn't offer
   Go to at all. Turn on and Turn off are both always offered: most switchable things keep
   whether they're on somewhere other than their own state (a lamp darkens the room, the
   flashlight sets a variable), so their state can't tell which half applies.
4. **An item meets a person: Give. An item meets a thing: Use.** The original scripts work out
   the rest. Dave is never offered as someone to give things to: nobody plays him, so anything he
   was given would be lost.

Typically one to three verbs remain. Targets are never highlighted while you hold an item, so the
filtering doesn't give puzzles away.

## Controls

Direct control (`src/verbs/focus.ts`, `src/web/player-ui.ts`):

- **D-pad walks your kid.** Holding a direction walks toward that edge along the walk boxes, and
  releasing stops. This needed one new command, `stop`.
- **Suggestions**: nearby things you can act on (nearest first, favouring the way you face, with
  pickups first), each with its verbs. Nothing is chosen at first: **B** steps through them, all
  of one thing's verbs before the next thing's, and back to nothing. The status line shows the chosen one, and the thing is
  outlined; walking clears the choice.
- **A** does what the status line says (nothing, if nothing is chosen). With an item in hand,
  the suggestions are the things to use it with; B drops the item only when there's nothing
  nearby to use it with (the status line then says "B drops").
- **Items** opens the overlay over your half. Choosing Use or Give puts the item in hand, and the
  suggestions become "Use key with front door" for nearby things. Opening Items again and
  choosing another item completes "Use batteries with flashlight"; choosing the one in hand puts
  it back.
- Mouse and touch: click the floor to walk, click a thing for its verbs.
- **Go to a person** walks your kid up beside them. The game's scripts do nothing with that
  sentence, so the engine handles it (`Engine.sentence`).

Suggestions are computed on each client from shared state; only the resulting sentence goes on the
wire, so they can't desynchronise anything.

`test/playthrough.test.ts` checks that every sentence of the winning route is one this interface
offers at that moment.

## The playthrough

`test/route.txt` beats the game with Bernard (player 1) and Michael (player 2), using the original
scripts, by the Meteor Police ending:

- **Front door**: Bernard finds the key under the mat. Michael holds the gargoyle while Bernard
  slips into the basement for the silver key; the door stays open only while the puller stands
  still.
- **Kitchen**: Bernard takes the radio tube from the living room, waits out Edna's five-minute
  kitchen watch, and unlocks the pool door.
- **Pool**: Michael feeds the Green Tentacle (wax fruit, then fruit drinks), gets strong on the
  Hunk-O-Matic, and opens the rusted grating. He drains the pool while Bernard fetches the glowing
  key, then refills it before the reactor melts down.
- **Ed's room**: Michael rings the doorbell to draw Weird Ed downstairs, and Bernard takes the
  hamster and card key.
- **Radio**: Bernard fixes the ham radio and calls the Meteor Police; the number is the one on the
  wanted poster, randomised at boot.
- **Dungeon**: Bernard lets Edna catch him, unlocks both padlocks with the glowing key, and opens
  the inner door with code 0000.
- **Ending**: the police arrive and take the meteor. Bernard shows Purple Tentacle the dropped
  badge, uses the card key, and switches off the machine: "Congratulations! You won the game!"

The headless run takes about 16,000 frames (roughly 18 minutes of game time) and about 0.1 s to
simulate.

## Not done yet, and known differences

- **Flashlight**: as on the NES, a dark room is black except for people, and the flashlight
  shows a 48x32 beam of the dimmed room. The original centres the beam on the cursor; with no
  cursor here, it centres on whoever holds the flashlight, at chest height.
- **Message display** uses NES text timing, and is shown per room. As on the NES, no names:
  each speaker's text is yellow or white, switching whenever someone else speaks (narration is
  yellow). The switch is kept per room, since one conversation can run in two contexts.
- **Who does what in a world cutscene** is decided by the context rules above. They hold for the
  route here, but untested parts of the game (the other kids' endings, the plant, the Edsel) may
  surface script assumptions about a single ego; the fix would be a new entry in `WORLD_SCRIPTS`
  or `PLAYER_SCOPED`.
- **Only the USA ROM** is supported.
- **Not built yet:** replays and watching games live (both would replay a game's log in a viewer's
  browser), and checking scores by replay.
- **Seat tokens are bearer credentials.** That's fine for a private game between friends; there
  are no accounts.

## Sources

- ScummVM, `engines/scumm` (GPL-3.0+): interpreter, actors, boxes, NES graphics, costumes, and
  the NES sound driver and APU (`players/player_nes.cpp`).
- gmarty/scumm-nes (Blue Oak 1.0.0): NES resource tables and parsers.
- segrax/Maniac.Mansion.Disassembly and pditincho/mm-explained: script and engine commentary.
- thonky.com walkthroughs, for the skeleton of the route; the details came from the scripts.
