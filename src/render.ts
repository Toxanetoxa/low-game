import type { FighterState, GameState } from './combat';
import { attackActiveTick, FLOOR_Y, STAGE_HEIGHT, STAGE_WIDTH } from './combat';

const rust = {
  glow: '#ff6d4f',
  light: '#ffab73',
  middle: '#f4604c',
  dark: '#922e38',
  armor: '#392632',
  shadow: '#211b28',
  visor: '#fff5be',
};

const volt = {
  glow: '#63f4e4',
  light: '#a4ffed',
  middle: '#4ed2cb',
  dark: '#247c87',
  armor: '#203e50',
  shadow: '#172534',
  visor: '#d5fff3',
};

type Palette = typeof rust;
type Point = readonly [number, number];

function paint(ctx: CanvasRenderingContext2D, color: string, points: readonly Point[]): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
}

function drawCity(ctx: CanvasRenderingContext2D, near: boolean): void {
  let seed = near ? 194 : 71;
  function random(): number {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  const base = near ? 333 : 299;
  for (let x = -8; x < STAGE_WIDTH;) {
    const width = Math.round(13 + random() * (near ? 57 : 32));
    const maxHeight = near ? 122 : 116;
    const height = Math.round(30 + random() * maxHeight);
    const top = base - height;
    const tint = random();

    ctx.fillStyle = near ? (tint > 0.5 ? '#111722' : '#161c28') : tint > 0.5 ? '#26253a' : '#302838';
    ctx.fillRect(x, top, width, height);
    ctx.fillRect(x + 5, top - 6, width - 11, 6);
    if (random() > 0.72) {
      ctx.fillRect(x + Math.floor(width * 0.65), top - 21, 2, 15);
      ctx.fillStyle = near ? '#d76f63' : '#67445a';
      ctx.fillRect(x + Math.floor(width * 0.65), top - 22, 2, 2);
    }
    for (let row = top + 13; row < base - 8; row += 10) {
      for (let col = x + 6; col < x + width - 5; col += 8) {
        const light = random();
        if (light < 0.4) continue;
        ctx.fillStyle = near ? (light > 0.92 ? '#435d64' : '#242c3a') : light > 0.88 ? '#6c4f64' : '#3d3145';
        ctx.fillRect(col, row, near ? 3 : 2, light > 0.9 ? 3 : 2);
      }
    }
    x += width + Math.round(3 + random() * 10);
  }
}

function drawBackdrop(ctx: CanvasRenderingContext2D): void {
  const sky = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  sky.addColorStop(0, '#0d101d');
  sky.addColorStop(0.54, '#241c2d');
  sky.addColorStop(1, '#48313d');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

  const haze = ctx.createRadialGradient(484, 186, 40, 484, 186, 360);
  haze.addColorStop(0, '#ad51424d');
  haze.addColorStop(1, '#ad514200');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, STAGE_WIDTH, FLOOR_Y);

  const sunX = 480;
  const sunY = 179;
  const radius = 99;
  const sun = ctx.createLinearGradient(0, sunY - radius, 0, sunY + radius);
  sun.addColorStop(0, '#e58d62');
  sun.addColorStop(0.5, '#ba584e');
  sun.addColorStop(1, '#713849');
  ctx.fillStyle = sun;
  for (let y = sunY - radius; y < sunY + radius; y += 3) {
    const stripe = y > sunY - 23 && (y - sunY + 300) % 15 > 8;
    if (stripe) continue;
    const half = Math.sqrt(radius ** 2 - (y - sunY) ** 2);
    ctx.fillRect(Math.round(sunX - half), y, Math.round(2 * half), 3);
  }

  ctx.fillStyle = '#bda9b660';
  for (const [x, y] of [
    [110, 57],
    [197, 95],
    [252, 44],
    [309, 124],
    [648, 54],
    [751, 91],
    [842, 42],
    [890, 108],
  ]) {
    ctx.fillRect(x, y, 2, 2);
  }

  drawCity(ctx, false);
  drawCity(ctx, true);
  ctx.fillStyle = '#0e151f';
  ctx.fillRect(0, 322, STAGE_WIDTH, FLOOR_Y - 322);
  ctx.fillStyle = '#252b37';
  ctx.fillRect(0, 321, STAGE_WIDTH, 2);
  for (let x = 10; x < STAGE_WIDTH; x += 33) {
    ctx.fillStyle = x % 5 === 0 ? '#466668' : '#29333f';
    ctx.fillRect(x, 329, 18, 2);
  }

  const floor = ctx.createLinearGradient(0, FLOOR_Y, 0, STAGE_HEIGHT);
  floor.addColorStop(0, '#252230');
  floor.addColorStop(1, '#10151f');
  ctx.fillStyle = floor;
  ctx.fillRect(0, FLOOR_Y, STAGE_WIDTH, STAGE_HEIGHT - FLOOR_Y);
  ctx.strokeStyle = '#35404d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -980; x <= 1940; x += 95) {
    ctx.moveTo(480 + (x - 480) * 0.41, FLOOR_Y);
    ctx.lineTo(x, STAGE_HEIGHT);
  }
  for (const y of [357.5, 369.5, 388.5, 416.5, 438.5]) {
    ctx.moveTo(0, y);
    ctx.lineTo(STAGE_WIDTH, y);
  }
  ctx.stroke();

  const edge = ctx.createLinearGradient(0, 0, STAGE_WIDTH, 0);
  edge.addColorStop(0, '#413445');
  edge.addColorStop(0.24, '#c95749');
  edge.addColorStop(0.5, '#574252');
  edge.addColorStop(0.75, '#4ab2af');
  edge.addColorStop(1, '#334b56');
  ctx.fillStyle = edge;
  ctx.fillRect(0, FLOOR_Y - 2, STAGE_WIDTH, 2);
  ctx.fillStyle = '#93b9be3d';
  for (let x = 0; x < STAGE_WIDTH; x += 80) ctx.fillRect(x + 10, 429, 17, 2);

  const vignette = ctx.createRadialGradient(480, 228, 180, 480, 228, 565);
  vignette.addColorStop(0, '#080a1100');
  vignette.addColorStop(1, '#080a11a8');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

  ctx.fillStyle = '#090b1417';
  for (let y = 0; y < STAGE_HEIGHT; y += 4) ctx.fillRect(0, y, STAGE_WIDTH, 1);
}

function drawFighter(ctx: CanvasRenderingContext2D, fighter: FighterState, palette: Palette, time: number): void {
  const outline = '#0a0e18';
  const height = FLOOR_Y - fighter.y;
  const shadowSize = Math.max(0.42, 1 - height / 150);

  ctx.save();
  ctx.translate(Math.round(fighter.x), FLOOR_Y + 3);
  ctx.scale(shadowSize, 1);
  ctx.fillStyle = '#090c17c7';
  ctx.beginPath();
  ctx.ellipse(0, 0, 45, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `${palette.glow}30`;
  ctx.fillRect(-26, 0, 52, 2);
  ctx.restore();

  ctx.save();
  ctx.translate(Math.round(fighter.x), Math.round(fighter.y));
  ctx.scale(3.8 * fighter.facing, 3.8);

  const stride = fighter.moving && fighter.grounded ? Math.round(Math.sin(time / 53) * 3) : 0;
  const breath = fighter.grounded && Math.sin(time / 310) > 0.25 ? 1 : 0;
  const attackFrame = fighter.attackTicks - attackActiveTick(fighter);
  const punching = Math.abs(attackFrame) <= 3;
  const hurt = fighter.hitTicks > 0;
  const bodyLight = hurt && Math.floor(fighter.hitTicks / 2) % 2 === 0 ? '#ffdfd8' : palette.light;

  ctx.save();
  ctx.translate(-stride, fighter.grounded ? 0 : -2);
  paint(ctx, outline, [
    [-10, -15],
    [-2, -15],
    [1, -9],
    [-4, -2],
    [-2, -1],
    [-2, 1],
    [-13, 1],
    [-13, -4],
    [-9, -9],
  ]);
  paint(ctx, palette.shadow, [
    [-9, -13],
    [-3, -13],
    [-2, -9],
    [-7, -3],
    [-4, -2],
    [-4, 0],
    [-12, 0],
    [-12, -3],
    [-8, -9],
  ]);
  paint(ctx, palette.dark, [
    [-9, -11],
    [-5, -12],
    [-5, -9],
    [-9, -5],
    [-11, -5],
    [-11, -7],
  ]);
  ctx.restore();

  ctx.save();
  ctx.translate(stride, fighter.grounded ? 0 : -3);
  paint(ctx, outline, [
    [0, -15],
    [7, -15],
    [11, -8],
    [10, -4],
    [14, -3],
    [14, 1],
    [4, 1],
    [3, -2],
    [5, -8],
    [0, -9],
  ]);
  paint(ctx, palette.armor, [
    [0, -14],
    [6, -14],
    [9, -8],
    [8, -4],
    [12, -2],
    [12, 0],
    [5, 0],
    [4, -2],
    [6, -8],
    [1, -10],
  ]);
  paint(ctx, palette.dark, [
    [2, -12],
    [6, -12],
    [8, -8],
    [7, -6],
    [5, -6],
    [6, -8],
    [4, -9],
    [2, -9],
  ]);
  paint(ctx, palette.middle, [
    [6, -4],
    [8, -4],
    [12, -2],
    [12, -1],
    [6, -1],
  ]);
  ctx.restore();

  ctx.translate(hurt ? -2 : 0, breath);
  paint(ctx, outline, [
    [-11, -28],
    [1, -30],
    [8, -26],
    [9, -20],
    [6, -13],
    [-5, -12],
    [-12, -15],
    [-13, -24],
  ]);
  paint(ctx, palette.shadow, [
    [-10, -27],
    [1, -29],
    [6, -25],
    [7, -20],
    [5, -14],
    [-5, -13],
    [-10, -15],
    [-11, -23],
  ]);
  paint(ctx, palette.armor, [
    [-9, -25],
    [0, -27],
    [6, -24],
    [6, -20],
    [2, -16],
    [-6, -16],
    [-9, -20],
  ]);
  paint(ctx, palette.middle, [
    [-8, -25],
    [-5, -27],
    [1, -27],
    [5, -24],
    [4, -22],
    [-1, -22],
    [-4, -20],
    [-8, -21],
  ]);
  paint(ctx, palette.dark, [
    [-8, -22],
    [-4, -21],
    [-5, -18],
    [-7, -18],
    [-9, -20],
  ]);
  ctx.fillStyle = bodyLight;
  ctx.fillRect(-5, -26, 6, 1);
  ctx.fillStyle = palette.visor;
  ctx.fillRect(-1, -22, 4, 1);
  ctx.fillStyle = palette.middle;
  ctx.fillRect(-6, -15, 10, 1);

  paint(ctx, outline, [
    [-5, -34],
    [0, -36],
    [7, -36],
    [10, -32],
    [10, -27],
    [7, -24],
    [0, -24],
    [-5, -27],
  ]);
  paint(ctx, palette.dark, [
    [-4, -33],
    [0, -35],
    [6, -35],
    [9, -32],
    [9, -27],
    [6, -25],
    [0, -25],
    [-4, -27],
  ]);
  paint(ctx, palette.middle, [
    [-3, -33],
    [1, -35],
    [6, -35],
    [9, -32],
    [9, -30],
    [0, -30],
    [-3, -28],
  ]);
  paint(ctx, bodyLight, [
    [0, -34],
    [6, -34],
    [8, -32],
    [4, -32],
    [3, -33],
    [0, -33],
  ]);
  ctx.fillStyle = palette.shadow;
  ctx.fillRect(1, -30, 8, 3);
  ctx.fillStyle = palette.visor;
  ctx.fillRect(3, -29, 6, 1);
  ctx.fillStyle = palette.middle;
  ctx.fillRect(4, -26, 3, 1);

  if (punching) {
    paint(ctx, outline, [
      [-9, -25],
      [0, -27],
      [8, -25],
      [12, -26],
      [19, -26],
      [23, -24],
      [23, -19],
      [20, -17],
      [12, -18],
      [7, -20],
      [0, -20],
      [-5, -18],
      [-10, -20],
    ]);
    paint(ctx, palette.armor, [
      [-9, -24],
      [0, -26],
      [8, -24],
      [13, -25],
      [19, -25],
      [22, -23],
      [22, -20],
      [19, -18],
      [13, -19],
      [7, -21],
      [0, -21],
      [-5, -19],
      [-9, -20],
    ]);
    paint(ctx, palette.middle, [
      [-8, -23],
      [-5, -25],
      [-1, -25],
      [3, -23],
      [0, -21],
      [-5, -20],
      [-8, -21],
    ]);
    paint(ctx, palette.middle, [
      [14, -24],
      [19, -25],
      [22, -23],
      [22, -20],
      [20, -19],
      [15, -20],
      [13, -22],
    ]);
    ctx.fillStyle = bodyLight;
    ctx.fillRect(16, -24, 4, 1);
    ctx.fillRect(23, -27, 7, 1);
    ctx.fillRect(25, -18, 4, 1);
    if (fighter.attackKind !== 'jab' && fighter.attackKind && Math.abs(attackFrame) <= 2) {
      ctx.fillStyle = fighter.attackKind === 'cross' ? '#ffe9a4' : palette.light;
      const trail = fighter.attackKind === 'lunge' ? 12 : 7;
      const y = fighter.attackKind === 'air' ? -16 : -22;
      ctx.fillRect(25, y, trail, 1);
      ctx.fillRect(29, y - 3, trail - 3, 1);
      ctx.fillRect(26, y + 4, trail - 4, 1);
    }
  } else {
    const guard = fighter.blocking ? -6 : 0;
    paint(ctx, outline, [
      [-10, -25],
      [-3, -26],
      [0, -22],
      [4, -21],
      [8, -23 + guard],
      [13, -22 + guard],
      [15, -18 + guard],
      [12, -14 + guard],
      [7, -14 + guard],
      [4, -15],
      [-4, -15],
      [-9, -18],
    ]);
    paint(ctx, palette.armor, [
      [-9, -24],
      [-3, -25],
      [-1, -22],
      [4, -20],
      [8, -22 + guard],
      [12, -21 + guard],
      [14, -18 + guard],
      [11, -15 + guard],
      [7, -15 + guard],
      [4, -16],
      [-4, -16],
      [-8, -19],
    ]);
    paint(ctx, palette.middle, [
      [-9, -23],
      [-7, -25],
      [-3, -25],
      [-1, -22],
      [-4, -19],
      [-8, -20],
    ]);
    paint(ctx, palette.middle, [
      [7, -20 + guard],
      [9, -22 + guard],
      [12, -21 + guard],
      [14, -18 + guard],
      [11, -16 + guard],
      [8, -16 + guard],
      [6, -18 + guard],
    ]);
    ctx.fillStyle = bodyLight;
    ctx.fillRect(-7, -24, 4, 1);
    ctx.fillRect(9, -21 + guard, 3, 1);
  }

  if (fighter.blockHitTicks > 0 || hurt) {
    const impact = fighter.blockHitTicks > 0 ? palette.light : '#fff2b5';
    ctx.fillStyle = impact;
    ctx.fillRect(12, -24, 5, 1);
    ctx.fillRect(15, -27, 1, 6);
    ctx.fillRect(18, -28, 3, 1);
    ctx.fillRect(20, -21, 2, 1);
    ctx.fillRect(13, -30, 1, 2);
  }
  ctx.restore();
}

export class ArenaRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly background: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = STAGE_WIDTH;
    canvas.height = STAGE_HEIGHT;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Браузер не поддерживает Canvas 2D.');
    this.ctx = ctx;

    this.background = document.createElement('canvas');
    this.background.width = STAGE_WIDTH;
    this.background.height = STAGE_HEIGHT;
    const backgroundCtx = this.background.getContext('2d');
    if (!backgroundCtx) throw new Error('Браузер не поддерживает Canvas 2D.');
    drawBackdrop(backgroundCtx);
  }

  draw(state: GameState, time: number): void {
    this.ctx.drawImage(this.background, 0, 0);
    drawFighter(this.ctx, state.fighters[0], rust, time);
    drawFighter(this.ctx, state.fighters[1], volt, time + 190);
  }
}
