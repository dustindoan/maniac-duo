# Design

## The idea

NES *Maniac Mansion* shows one room on top and the verbs and inventory below. Here the bottom
half is the second player's room instead. Each half is the original 224-pixel NES room view
between black borders, so scenes render exactly as before; two of them stack into roughly one
NES screen. Each player controls exactly one kid. Dave is still in the game, but nobody controls
him: he stays where the intro leaves him.

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
  src/gfx  draw each player's half
        |
  src/web  canvas, controls, inventory overlay
```

The server never runs the game. Each browser runs the same deterministic engine over the same
command log, so the server only has to order commands. A player who joins later (or reloads)
replays the log to catch up. `test/lockstep.test.ts` checks the replay reproduces the world exactly.

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
- **Cutscenes**: a player's own cutscene freezes that player and moves only their camera. A world
  cutscene freezes everyone; if it moves the camera, both players watch it. Afterwards, players
  whose kid it moved (for example, captured into the dungeon) follow their kid.
- **Distances between different rooms are infinite.** With several rooms live, "nearest kid" must
  never find someone in another room.

The rest follows ScummVM: walk boxes and the box matrix, actor walking in 8x2-pixel steps, costume
animation, object state bits, inventory, messages and talk timing.

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
   Go to at all.
4. **An item meets a person: Give. An item meets a thing: Use.** The original scripts work out
   the rest.

Typically one to three verbs remain. Targets are never highlighted while you hold an item, so the
filtering doesn't give puzzles away.

## Controls

Direct control (`src/verbs/focus.ts`, `src/web/player-ui.ts`):

- **D-pad walks your kid.** Holding a direction walks toward that edge along the walk boxes, and
  releasing stops. This needed one new command, `stop`.
- **Suggestions**: nearby things you can act on (nearest first, favouring the way you face, with
  pickups first) take turns offering their verbs. The status line shows the current one, and the
  thing is outlined.
- **A** does what the status line says. **B** shows the next suggestion; with an item in hand,
  B drops it.
- **Items** opens the overlay over your half. Choosing Use or Give puts the item in hand, and the
  suggestions become "Use key with front door" for nearby things.
- Mouse and touch: click the floor to walk, click a thing for its verbs.

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

- **Sound and music** are timed but not played. NES APU playback would be its own piece.
- **Flashlight** darkness and some lighting details are approximate: dark rooms use the dark
  palette, with no flashlight circle.
- **Message display** uses NES text timing; text is shown per room, not in the original
  per-actor colours.
- **Who does what in a world cutscene** is decided by the context rules above. They hold for the
  route here, but untested parts of the game (the other kids' endings, the plant, the Edsel) may
  surface script assumptions about a single ego; the fix would be a new entry in `WORLD_SCRIPTS`
  or `PLAYER_SCOPED`.
- **Only the USA ROM** is supported.
- **Seat tokens are bearer credentials.** That's fine for a private game between friends; there
  are no accounts.

## Sources

- ScummVM, `engines/scumm` (GPL-3.0+): interpreter, actors, boxes, NES graphics, costumes.
- gmarty/scumm-nes (Blue Oak 1.0.0): NES resource tables and parsers.
- segrax/Maniac.Mansion.Disassembly and pditincho/mm-explained: script and engine commentary.
- thonky.com walkthroughs, for the skeleton of the route; the details came from the scripts.
