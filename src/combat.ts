export const STAGE_WIDTH = 960;
export const STAGE_HEIGHT = 440;
export const FLOOR_Y = 350;
export const TICK_RATE = 60;
export const ROUND_SECONDS = 60;
export const MAX_HEALTH = 100;

const ROUND_TICKS = ROUND_SECONDS * TICK_RATE;
const MIN_X = 58;
const MAX_X = STAGE_WIDTH - MIN_X;
const BODY_WIDTH = 58;
const BODY_HEIGHT = 64;
const WALK_SPEED = 7.2;
const JUMP_SPEED = -15;
const GRAVITY = 0.95;
const HIT_TICKS = 14;
const BLOCK_HIT_TICKS = 10;
const BUFFER_TICKS = 9;
const LEGACY_ATTACK_TICKS = 26;
const LEGACY_ACTIVE_TICK = 17;
const attacks = {
  jab: { ticks: 17, active: 13, reach: 103, height: 58, damage: 9, push: 9 },
  cross: { ticks: 21, active: 15, reach: 115, height: 58, damage: 14, push: 26 },
  lunge: { ticks: 25, active: 17, reach: 124, height: 58, damage: 16, push: 32 },
  air: { ticks: 19, active: 15, reach: 112, height: 80, damage: 12, push: 22 },
};

export type PlayerIndex = 0 | 1;
export type AttackKind = keyof typeof attacks;

export type Input = {
  left: boolean;
  right: boolean;
  jump: boolean;
  attack: boolean;
  block: boolean;
};

export const EMPTY_INPUT: Readonly<Input> = Object.freeze({
  left: false,
  right: false,
  jump: false,
  attack: false,
  block: false,
});

type StepInput = Input & {
  jumpPressed?: boolean;
  attackPressed?: boolean;
};

export type FighterState = {
  x: number;
  y: number;
  facing: -1 | 1;
  health: number;
  attackTicks: number;
  attackKind?: AttackKind;
  hitTicks: number;
  blockHitTicks: number;
  blocking: boolean;
  grounded: boolean;
  moving: boolean;
};

export type GameState = {
  fighters: [FighterState, FighterState];
  ticksRemaining: number;
  winner: PlayerIndex | 'draw' | null;
};

function fighterAt(x: number, facing: FighterState['facing']): FighterState {
  return {
    x,
    y: FLOOR_Y,
    facing,
    health: MAX_HEALTH,
    attackTicks: 0,
    hitTicks: 0,
    blockHitTicks: 0,
    blocking: false,
    grounded: true,
    moving: false,
  };
}

function initialState(): GameState {
  return {
    fighters: [fighterAt(240, 1), fighterAt(720, -1)],
    ticksRemaining: ROUND_TICKS,
    winner: null,
  };
}

function clampX(x: number): number {
  return Math.min(MAX_X, Math.max(MIN_X, x));
}

function walkDirection(input: Input): number {
  return Number(input.right) - Number(input.left);
}

export function predictWalk(
  fighter: FighterState,
  opponent: FighterState,
  previousX: number,
  input: Input,
  ticks: number,
): number {
  const distance = Math.min(48, WALK_SPEED * ticks);
  const x = fighter.x;
  const projected = Math.max(x - 48, Math.min(x + 48, previousX + walkDirection(input) * distance));
  if (Math.abs(fighter.y - opponent.y) >= BODY_HEIGHT) return clampX(projected);
  return clampX(
    x <= opponent.x ? Math.min(projected, opponent.x - BODY_WIDTH) : Math.max(projected, opponent.x + BODY_WIDTH),
  );
}

export function attackActiveTick(fighter: FighterState): number {
  return fighter.attackKind ? attacks[fighter.attackKind].active : LEGACY_ACTIVE_TICK;
}

function separateFighters(left: FighterState, right: FighterState): void {
  if (Math.abs(left.y - right.y) >= BODY_HEIGHT || right.x - left.x >= BODY_WIDTH) return;

  const center = (left.x + right.x) / 2;
  left.x = Math.min(MAX_X - BODY_WIDTH, clampX(center - BODY_WIDTH / 2));
  right.x = left.x + BODY_WIDTH;
}

type Strike = { kind: 'hit' | 'block'; damage: number; push: number };

function checkStrike(attacker: FighterState, target: FighterState): Strike | null {
  if (!attacker.attackKind) return null;
  const { active, reach, height, damage, push } = attacks[attacker.attackKind];
  if (attacker.attackTicks !== active) return null;

  const distance = (target.x - attacker.x) * attacker.facing;
  if (distance < 0 || distance > reach || Math.abs(attacker.y - target.y) >= height) {
    return null;
  }

  return { kind: target.blocking && target.facing !== attacker.facing ? 'block' : 'hit', damage, push };
}

function applyStrike(strike: Strike | null, target: FighterState, direction: FighterState['facing']): void {
  if (strike === null) return;
  if (strike.kind === 'block') {
    target.health = Math.max(0, target.health - 2);
    target.blockHitTicks = BLOCK_HIT_TICKS;
    target.x = clampX(target.x + direction * 15);
    return;
  }

  target.health = Math.max(0, target.health - strike.damage);
  target.hitTicks = HIT_TICKS;
  target.blockHitTicks = 0;
  target.attackTicks = 0;
  target.attackKind = undefined;
  target.blocking = false;
  target.moving = false;
  target.x = clampX(target.x + direction * strike.push);
}

export class Combat {
  private current = initialState();
  private verticalSpeed: [number, number] = [0, 0];
  private jumpHeld: [boolean, boolean] = [false, false];
  private attackHeld: [boolean, boolean] = [false, false];
  private jumpBuffer: [number, number] = [0, 0];
  private attackBuffer: [number, number] = [0, 0];

  get state(): GameState {
    return this.current;
  }

  reset(): void {
    this.current = initialState();
    this.verticalSpeed = [0, 0];
    this.jumpHeld = [false, false];
    this.attackHeld = [false, false];
    this.jumpBuffer = [0, 0];
    this.attackBuffer = [0, 0];
  }

  step(inputs: readonly [StepInput, StepInput]): void {
    if (this.current.winner !== null) return;

    const [first, second] = this.current.fighters;
    const firstWasOnLeft = first.x <= second.x;
    this.advanceFighter(0, inputs[0], firstWasOnLeft ? 1 : -1);
    this.advanceFighter(1, inputs[1], firstWasOnLeft ? -1 : 1);

    const [left, right] = first.x <= second.x ? [first, second] : [second, first];
    separateFighters(left, right);

    const firstStrike = checkStrike(first, second);
    const secondStrike = checkStrike(second, first);
    applyStrike(firstStrike, second, first.facing);
    applyStrike(secondStrike, first, second.facing);
    separateFighters(left, right);

    this.current.ticksRemaining -= 1;
    if (this.current.ticksRemaining === 0 || first.health === 0 || second.health === 0) {
      this.current.winner = first.health === second.health ? 'draw' : first.health > second.health ? 0 : 1;
    }
  }

  private advanceFighter(index: PlayerIndex, input: StepInput, direction: FighterState['facing']): void {
    const fighter = this.current.fighters[index];
    const jumpPressed = input.jumpPressed ?? (input.jump && !this.jumpHeld[index]);
    const attackPressed = input.attackPressed ?? (input.attack && !this.attackHeld[index]);
    this.jumpHeld[index] = input.jump;
    this.attackHeld[index] = input.attack;
    this.jumpBuffer[index] = jumpPressed ? BUFFER_TICKS : Math.max(0, this.jumpBuffer[index] - 1);
    this.attackBuffer[index] = attackPressed ? BUFFER_TICKS : Math.max(0, this.attackBuffer[index] - 1);
    fighter.attackTicks = Math.max(0, fighter.attackTicks - 1);
    fighter.hitTicks = Math.max(0, fighter.hitTicks - 1);
    fighter.blockHitTicks = Math.max(0, fighter.blockHitTicks - 1);

    const canChain =
      fighter.attackKind === 'jab' && fighter.attackTicks > 0 && fighter.attackTicks <= 8 && fighter.grounded;
    if (fighter.attackTicks === 0) fighter.attackKind = undefined;
    const canAct = fighter.attackTicks === 0 && fighter.hitTicks === 0;
    if (canAct) fighter.facing = direction;
    fighter.blocking = canAct && input.block && fighter.grounded;
    fighter.moving = false;

    if (canAct && !fighter.blocking && this.jumpBuffer[index] && fighter.grounded) {
      this.jumpBuffer[index] = 0;
      this.verticalSpeed[index] = JUMP_SPEED;
      fighter.grounded = false;
    }

    const walk = walkDirection(input);
    if (!fighter.blocking && this.attackBuffer[index] && (canAct || canChain)) {
      let kind: AttackKind = 'jab';
      if (canChain) kind = 'cross';
      else if (!fighter.grounded) kind = 'air';
      else if (walk === direction) kind = 'lunge';
      fighter.attackKind = kind;
      fighter.attackTicks = attacks[kind].ticks;
      this.attackBuffer[index] = 0;
    }

    let speed = 0;
    if (fighter.attackKind === 'lunge' && fighter.attackTicks >= attacks.lunge.active) speed = fighter.facing * 7;
    else if (fighter.hitTicks === 0 && !fighter.blocking && (fighter.attackTicks === 0 || !fighter.grounded)) {
      speed = walk * WALK_SPEED;
    }
    const nextX = clampX(fighter.x + speed);
    fighter.moving = nextX !== fighter.x;
    fighter.x = nextX;

    if (fighter.grounded) return;
    fighter.y = Math.min(FLOOR_Y, fighter.y + this.verticalSpeed[index]);
    this.verticalSpeed[index] += GRAVITY;
    fighter.grounded = fighter.y === FLOOR_Y;
    if (fighter.grounded) this.verticalSpeed[index] = 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && value >= min && value <= max;
}

export function isInput(value: unknown): value is Input {
  return (
    isRecord(value) &&
    typeof value.left === 'boolean' &&
    typeof value.right === 'boolean' &&
    typeof value.jump === 'boolean' &&
    typeof value.attack === 'boolean' &&
    typeof value.block === 'boolean'
  );
}

function isFighterState(value: unknown): value is FighterState {
  return (
    isRecord(value) &&
    isNumberInRange(value.x, MIN_X, MAX_X) &&
    isNumberInRange(value.y, 0, FLOOR_Y) &&
    (value.facing === -1 || value.facing === 1) &&
    isNumberInRange(value.health, 0, MAX_HEALTH) &&
    isNumberInRange(value.attackTicks, 0, LEGACY_ATTACK_TICKS) &&
    (value.attackKind === undefined ||
      (typeof value.attackKind === 'string' && Object.hasOwn(attacks, value.attackKind))) &&
    isNumberInRange(value.hitTicks, 0, HIT_TICKS) &&
    isNumberInRange(value.blockHitTicks, 0, BLOCK_HIT_TICKS) &&
    typeof value.blocking === 'boolean' &&
    typeof value.grounded === 'boolean' &&
    typeof value.moving === 'boolean'
  );
}

export function isGameState(value: unknown): value is GameState {
  return (
    isRecord(value) &&
    Array.isArray(value.fighters) &&
    value.fighters.length === 2 &&
    isFighterState(value.fighters[0]) &&
    isFighterState(value.fighters[1]) &&
    isNumberInRange(value.ticksRemaining, 0, ROUND_TICKS) &&
    Number.isInteger(value.ticksRemaining) &&
    (value.winner === null || value.winner === 'draw' || value.winner === 0 || value.winner === 1)
  );
}
