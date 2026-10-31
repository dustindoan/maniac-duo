# maniac-duo

Two-player NES *Maniac Mansion*. Each player controls one kid; the screen (one NES screen, shown
at 4:3) is split top and bottom, so both kids can be in different rooms of the mansion at once,
and cutscenes everyone should see fill the whole screen. Players can be on one screen or online,
and they don't have to be online at the same time: the mansion only moves while someone is
playing.

It runs the **original game scripts and graphics from your own ROM** in a small TypeScript
reimplementation of the SCUMM v1 engine, extended so several kids can be "the current kid" in
several rooms simultaneously. Puzzles, cutscenes and endings are the original ones.

**Start here: [docs/design.md](docs/design.md).**

## What it is not

- **Not a ROM source.** Bring your own *Maniac Mansion (USA)* NES dump (PRG CRC-32 `0d9f5bd1`).
  Nothing derived from it is committed, uploaded, or stored on the server; `rom/` is gitignored.
- **Not an emulator.** It does not run the NES CPU; it interprets the game's SCUMM bytecode.
- **Only USA.** Other regional ROMs have different resource tables and are rejected.

## Owns

- The engine: ROM reader, bytecode decoder, interpreter, multi-room world, NES renderer, NES sound
  driver and sound chip.
- The verb system: which verbs to offer for what you touch (`src/verbs`).
- Our additions to the story (`src/story`), in the game's own bytecode, versioned per game as
  *rules*: after the intro Dave goes on ahead and holds the dungeon's loose brick for whoever is
  caught.
- The relay server: game ids, seat tokens, the ordered command log (SQLite), and the limits that
  keep a public relay from being swamped (`src/server/limits.ts`).
- The high-score board: a points table and a scorer that runs with the game (`src/score`); the
  relay keeps each game's best score and the players' initials.
- The browser client: front page (activity, your ROM, new game, the board), each game's page,
  split or shared screen, D-pad/gamepad controls, inventory overlay.

## Calls

Nothing external. The browser talks only to the relay server it was served from.

## Exposes

HTTP and WebSocket, from `src/server/main.ts` (types in `src/server/protocol.ts`):

```
POST /api/games            {kids: [kid, kid], romCrc}   -> 201 {game, seats: [{player, kid, token}]}
                           game: {id, kids, seed, romCrc, rules, createdAt}   (rules: see src/story)
GET  /api/games/:id?token= -> {game, player, online, invite?}   (invite: seat 2's token, for seat 1)
GET  /api/seat?token=      -> the same, from the token alone
GET  /api/stats            -> {playing, players}   (games with someone connected, seats connected)
GET  /api/scores           -> the board, best first: [{game, kids, initials, points, won, minutes, at}]
GET  /api/games/:id/summary -> one game on the board: that, plus {max, reached: [{id, tick}], createdAt}
POST /api/initials?token=  {initials}   (one to three letters, for this seat's name on the board)
WS   /api/play?token=      server -> welcome {player, game, tick, log, online}
                                     tick {tick, cmds}   presence {online}
                                     hash {player, tick, hash}   (another player's world fingerprint)
                                     error {message}   (e.g. another tab took this seat)
                           client -> cmd {cmd: walk | stop | sentence | skip}
                                     hash {tick, hash}   (passed on to the other players, unread)
                                     score {reached}   (milestones this run has reached; src/score)
```

Every limit in `src/server/limits.ts` can be overridden with the `LIMITS` environment variable
(JSON, e.g. `LIMITS='{"activeGames":800}'`).

Kids are `bernard`, `michael`, `wendy`, `jeff`, `syd`, `razor`. A seat token is the whole
credential for that seat; the invite link is `/#t=<token>`.

Command-line tools (all read `rom/Maniac Mansion (USA).nes`, or `MM_ROM`):

```
bun tools/route.ts test/route.txt   # play a route file and print every step
bun tools/disasm.ts script 1 2 4    # disassemble global scripts; `room 1` for room + object scripts
bun tools/romdump.ts "" 1           # rooms, objects and their verb tables
bun tools/render.ts 1 44            # room backgrounds and a costume sheet to out/*.png
bun tools/sound.ts 55 13            # sounds and music to out/sound*.wav
bun tools/run.ts 3000               # boot headless and log rooms and messages per frame
bun tools/loadtest.ts --url http://127.0.0.1:8790 --stages 100,500,1000   # simulated games against a relay
```

## Run it

```bash
bun install
```

```bash
bun run build:web
```

```bash
bun run server
```

Open http://localhost:8787, load your ROM (it stays in that browser), and either play two players
on one screen or create an online game and send the second link to your partner.

For development, `bun run dev` builds the client and serves the local ROM to pages opened as
http://localhost:8787/?devrom (localhost only), so you skip the file picker.

## Deploy it

On a box with Docker, behind a TLS front of its own (on Dustin's lab, Atoll's
boxfront serves it as `maniac.coralstack.space`):

```bash
deploy/deploy.sh <ssh host>
```

It sends the committed tree (`git archive HEAD`) plus `deploy/`, so `rom/`, `out/`
and `data/` never leave this machine, and it refuses if a ROM would be sent. On
the box the relay listens on `127.0.0.1:8787`. Games live in a Docker volume and
survive a redeploy. Each player still loads their own ROM in their own browser.

## Controls

| | Keyboard (one player) | Same screen: player 1 / player 2 | Gamepad |
|---|---|---|---|
| Walk | arrows or WASD | WASD / arrows | D-pad or stick |
| Do what's shown | Z, Space, Enter | F / L | A |
| Next suggestion | X, Shift | G / K | B |
| Items | C, Tab | C / O | Select or Y |
| Skip cutscene | Esc | Esc | Start |
| Mute | M | M | |
| Voices on/off | V | V | |

Nothing is chosen until you press B, which steps through what's nearby ("Pull door mat…"; the
ellipsis means B has more) and back to nothing. The status line under your half says what A will
do. Mouse and touch work too: click the floor to walk, click a thing for its verbs.

## Test it

```bash
bun test
```

The suite needs the ROM (tests skip without it). `test/playthrough.test.ts` is the acceptance
test: Bernard and Michael, each a separate player, beat the game by the Meteor Police ending,
following [test/route.txt](test/route.txt), with every sentence checked to be one the interface
actually offers. `test/lockstep.test.ts` replays that game from its command log and checks the
world matches at every step; `test/server.test.ts` runs two real WebSocket clients against the relay.
`test/dave.test.ts` gets Bernard caught and checks Dave holds the brick for him;
`test/score.test.ts` scores the winning route, and `test/scoreboard.test.ts` and
`test/limits.test.ts` check the board and the limits against a real relay.

The load test needs a relay started with its creation limits raised (see the top of
`tools/loadtest.ts`). Its simulated players send about twice as many moves as real ones. On the
lab box (a 2014 i7), the relay kept 15 ticks a second up to about 250 games (500 players), 14.3 at
500, and 13.3 at 1,000, with moves back within 106 ms; on an M1 Pro, 1,000 games held 15.

```bash
bunx tsc --noEmit
```

## Layout

| Path | Holds |
|---|---|
| `src/rom` | ROM identification, resource tables, room/object/script/costume parsing |
| `src/gfx` | NES tiles, object patches, costumes, the NES font, the 4:3 frame (both halves, or one shared scene) |
| `src/engine` | Bytecode and its assembler (`asm.ts`), interpreter (`vm.ts`), world and contexts (`engine.ts`), actors, walk boxes, sessions, lockstep, scripted driving |
| `src/story` | Our additions to the story, by rules version: Dave and the loose brick |
| `src/sound` | The game's sound driver (runs in the engine, decides how long sounds last) and the NES sound chip (`apu.ts`, browser only) |
| `src/verbs` | Verb affordances and D-pad focus/suggestions |
| `src/server` | Relay server, SQLite store, protocol, limits |
| `src/score` | The points table and the scorer for the high-score board |
| `src/web` | Browser client |
| `test` | Unit tests and the playthrough route |
| `tools` | CLIs above, PNG encoder, web build |

## License

GPL-3.0-or-later (see [LICENSE](LICENSE)): the engine and sound follow ScummVM's SCUMM implementation and NES player, and
resource tables come from [gmarty/scumm-nes](https://github.com/gmarty/scumm-nes) (Blue Oak 1.0.0).
*Maniac Mansion* is © Lucasfilm Games; you need your own copy.
