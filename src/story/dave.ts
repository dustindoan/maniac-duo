// Dave, whom nobody plays here, goes on ahead and ends up in the dungeon, where he holds the loose
// brick so a captured kid can get out. In the original, the brick opens the cell door for three
// seconds and the door won't let whoever pushed it out (script 137, door 159), so escaping always
// cost a second kid, who stayed behind. With two players, that meant one of them pushing a brick
// until someone found the old rusty key.
//
// Written in the game's own bytecode (src/engine/asm.ts), so the VM gives these scripts the same
// cutscenes, skipping, talking and walking as the original ones.

import { Asm } from '../engine/asm';
import type { Story } from '../engine/engine';

const DAVE = 3;
const DUNGEON = 4;
/** The loose brick, the cell door, and the same door seen from the basement. */
const BRICK = 453;
const CELL_DOOR = 159;
const BASEMENT_DOOR = 155;
const PUSH = 9;
/** Var[214]: who is pushing the brick. The cell door won't let them out. */
const PUSHER = 214;
/** The two chosen kids (script 114). */
const KID1 = 48;
const KID2 = 49;
/** Original scripts: 137 holds the door open for three seconds; 56 shuts it. */
const BRICK_TIMER = 137;
const SHUT_DOOR = 56;
const DOOR_OPENS = 8;
/** animateActor directions: face the room, or the wall. */
const FACE_ROOM = 250;
const FACE_WALL = 251;
/** Where Dave waits in the dungeon, and where a kid or Dave stands to push the brick. */
const DAVE_SPOT = [40, 60] as const;
const BRICK_SPOT = [27, 56] as const;
const ASIDE = [31, 58] as const;

/** Var[240]: a kid has asked Dave to hold the brick (the first time is a short scene). */
const ASKED = 240;
const TIMER = 241;
const RESULT = 1;
const EGO = { v: 0 };

export const LEAVE = 200;
export const PUSH_BRICK = 201;
export const HOLD_BRICK = 202;

/**
 * After the intro's "Ok, let's go rescue Sandy!", Dave walks off toward the house while the
 * players already have control, and is next seen in the dungeon. If nobody watches the yard, he
 * doesn't walk (no actor does), so he only waits so long.
 */
const leave = new Asm()
  .op('walkActorTo', DAVE, 1, 60)
  .op('move', TIMER, 150)
  .label('walking')
  .op('breakHere')
  .op('decrement', TIMER)
  .op('equalZero', TIMER, 'time left') // -> unless out of time
  .op('jumpRelative', 'gone')
  .label('time left')
  .op('getActorMoving', RESULT, DAVE)
  .op('notEqualZero', RESULT, 'gone') // -> once he stops
  .op('jumpRelative', 'walking')
  .label('gone')
  .op('putActorInRoom', DAVE, DUNGEON)
  .op('putActor', DAVE, ...DAVE_SPOT)
  .op('animateActor', DAVE, FACE_ROOM)
  .op('stopObjectCode');

/**
 * "Push loose brick", in the pushing kid's context. With Dave in the dungeon, the door opens and
 * Dave is the one holding it, so the kid can leave; the first time, the kid asks him in a short
 * scene. Without him, the brick works as it always did.
 */
const pushBrick = new Asm()
  .op('getActorRoom', RESULT, DAVE)
  .op('isEqual', RESULT, DUNGEON, 'alone') // -> unless Dave is here
  .op('ifStateIntrinsicOn', CELL_DOOR, 'open') // -> if the door is already open
  .op('startSound', DOOR_OPENS)
  .op('setStateIntrinsicOn', CELL_DOOR)
  .op('setStateIntrinsicOn', BASEMENT_DOOR)
  .label('open')
  .op('move', PUSHER, DAVE)
  .op('notEqualZero', ASKED, 'ask') // -> the first time
  .op('startScript', HOLD_BRICK)
  .op('stopObjectCode')
  .label('ask')
  .op('move', ASKED, 1)
  .op('cutscene')
  .op('beginOverride')
  .op('jumpRelative', 'skipped')
  .op('printEgo', 'Dave! Can you hold this\x01brick in for me?')
  .op('waitForMessage')
  .op('print', DAVE, 'Sure. Go find Sandy!')
  .op('walkActorTo', DAVE, ...BRICK_SPOT)
  .op('walkActorTo', EGO, ...ASIDE)
  .op('waitForMessage')
  .op('waitForActor', DAVE)
  .label('skipped')
  .op('putActor', DAVE, ...BRICK_SPOT)
  .op('animateActor', DAVE, FACE_WALL)
  .op('endCutscene')
  .op('startScript', HOLD_BRICK)
  .op('stopObjectCode')
  .label('alone')
  .op('move', PUSHER, EGO)
  .op('startScript', BRICK_TIMER)
  .op('stopObjectCode');

/**
 * Dave walks to the brick and holds it while either kid is still in the dungeon, or until
 * someone goes through (the door shuts behind them), then walks back to his spot. Actors only
 * walk in rooms someone is watching, so with no kid left to see him, he's simply back.
 */
const holdBrick = new Asm()
  .op('walkActorTo', DAVE, ...BRICK_SPOT)
  .label('walking')
  .op('breakHere')
  .op('ifStateIntrinsicOff', CELL_DOOR, 'back') // -> once the door has shut
  .op('getActorMoving', RESULT, DAVE)
  .op('notEqualZero', RESULT, 'there') // -> once he's there
  .op('jumpRelative', 'walking')
  .label('there')
  .op('animateActor', DAVE, FACE_WALL)
  .label('holding')
  .op('breakHere')
  .op('ifStateIntrinsicOff', CELL_DOOR, 'back')
  .op('getActorRoom', RESULT, { v: KID1 })
  .op('isNotEqual', RESULT, DUNGEON, 'holding') // -> while that kid is still here
  .op('getActorRoom', RESULT, { v: KID2 })
  .op('isNotEqual', RESULT, DUNGEON, 'holding')
  .op('startScript', SHUT_DOOR)
  .label('back')
  .op('walkActorTo', DAVE, ...DAVE_SPOT)
  .label('returning')
  .op('getActorRoom', RESULT, { v: KID1 })
  .op('isNotEqual', RESULT, DUNGEON, 'watched') // -> while someone is here to see him
  .op('getActorRoom', RESULT, { v: KID2 })
  .op('isNotEqual', RESULT, DUNGEON, 'watched')
  .op('putActor', DAVE, ...DAVE_SPOT)
  .op('jumpRelative', 'home')
  .label('watched')
  .op('getActorMoving', RESULT, DAVE)
  .op('notEqualZero', RESULT, 'home') // -> once he's back
  .op('breakHere')
  .op('jumpRelative', 'returning')
  .label('home')
  .op('animateActor', DAVE, FACE_ROOM)
  .op('stopObjectCode');

export const dave: Story = {
  scripts: new Map([
    [LEAVE, leave.bytes()],
    [PUSH_BRICK, pushBrick.bytes()],
    [HOLD_BRICK, holdBrick.bytes()],
  ]),
  start: LEAVE,
  verbs: new Map([[BRICK, new Map([[PUSH, PUSH_BRICK]])]]),
  world: new Set([LEAVE, HOLD_BRICK]),
  perPlayer: new Set([PUSH_BRICK]),
};
