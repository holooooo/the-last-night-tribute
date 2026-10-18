import * as THREE from 'three';
import { PixelImage, hex } from '../core/pixel.js';

// High-resolution (32 texels / m) anime heroine, drawn procedurally.
// 3/4 view facing +x. Every frame is posed from a small rig, then rasterised
// with cel-shaded capsules, hand-placed facial pixels, coloured line art and
// secondary motion (long hair, skirt, jacket hem).

export const H_FW = 64;
export const H_FH = 96;
export const H_TPM = 32;
export const H_ANIMS = {
  walk: { start: 0, count: 8 },
  run: { start: 8, count: 8 },
  idle: { start: 16, count: 8 },
};
export const H_FRAMES = 24;

const C = {
  skin: [0xf7dccb, 0xe7b4a2, 0xc98c82],
  blush: 0xf2a0a6,
  hair: [0xd9d3f2, 0xa79fd6, 0x6f66a8, 0x463f78],
  hairHi: 0xffffff,
  hairTip: 0x9fe8f2,
  iris: [0x47e0e6, 0x1e8fb0, 0x123c5c],
  white: 0xf6f2f8,
  lash: 0x2a1830,
  mouth: 0xc0606e,
  jacket: [0x5d6789, 0x3e4664, 0x1c2033],
  jacketHi: 0x8792b8,
  top: [0xf0f2f6, 0xc4c8d8],
  skirt: [0x343a58, 0x23283f, 0x161a2b],
  skirtLine: 0xd04060,
  stock: [0x2a2a3a, 0x1a1a26],
  shoe: [0xf2f2f6, 0xb6b8c6],
  sole: 0x3a3c48,
  phone: [0x3a3d4c, 0x24262f],
  neon: 0x48f0ff,
  ribbon: 0xe8406a,
};

// ------------------------------------------------------------------ painter
class Painter {
  constructor(img, ox) {
    this.img = img;
    this.ox = ox;
  }
  px(x, y, col, { h = 1, e = null, rough = 0.85, line = false } = {}) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || x >= H_FW || y < 0 || y >= H_FH) return;
    const b = { color: col, height: h, rough };
    if (e) {
      b.emissive = e;
      b.emissiveK = 1;
    } else b.emissive = 0x000000;
    this.img.px(this.ox + x, y, b);
    this.img.lineMask[(y * this.img.w) + this.ox + x] = line ? 1 : 0;
  }
  // Tapered capsule, cel shaded against a light coming from upper-right-front.
  capsule(ax, ay, bx, by, ra, rb, pal, { line = pal[2], h = 1, lightDir = [0.6, -0.8], paint = null } = {}) {
    const minx = Math.floor(Math.min(ax, bx) - Math.max(ra, rb) - 1);
    const maxx = Math.ceil(Math.max(ax, bx) + Math.max(ra, rb) + 1);
    const miny = Math.floor(Math.min(ay, by) - Math.max(ra, rb) - 1);
    const maxy = Math.ceil(Math.max(ay, by) + Math.max(ra, rb) + 1);
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy || 1;
    for (let y = miny; y <= maxy; y++)
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let t = ((px - ax) * dx + (py - ay) * dy) / L2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + dx * t;
        const cy = ay + dy * t;
        const ox = px - cx;
        const oy = py - cy;
        const d = Math.hypot(ox, oy);
        const r = ra + (rb - ra) * t;
        if (d > r) continue;
        const k = (ox * lightDir[0] + oy * lightDir[1]) / Math.max(r, 0.5);
        let col = k > 0.25 ? pal[0] : k > -0.45 ? pal[0] : pal[1];
        if (k < -0.45) col = pal[1];
        if (k > 0.55 && pal[3] !== undefined) col = pal[3];
        const isLine = line !== null && d > r - 0.85;
        if (paint) {
          const res = paint(x, y, t, k, isLine);
          if (res === false) continue;
          if (res) {
            this.px(x, y, res.col, { h: res.h || h, e: res.e, line: res.line });
            continue;
          }
        }
        this.px(x, y, isLine ? line : col, { h: h + (1 - d / r) * 0.6, line: isLine });
      }
  }
  // Filled polygon (even-odd), with optional per-pixel shader.
  poly(pts, shader) {
    let miny = Infinity;
    let maxy = -Infinity;
    for (const p of pts) {
      miny = Math.min(miny, p[1]);
      maxy = Math.max(maxy, p[1]);
    }
    for (let y = Math.floor(miny); y <= Math.ceil(maxy); y++) {
      const yy = y + 0.5;
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if ((a[1] <= yy && b[1] > yy) || (b[1] <= yy && a[1] > yy)) xs.push(a[0] + ((yy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = Math.round(xs[i]);
        const x1 = Math.round(xs[i + 1]) - 1;
        for (let x = x0; x <= x1; x++) {
          const r = shader(x, y, x - x0, x1 - x, x0, x1);
          if (r) this.px(x, y, r.col, { h: r.h === undefined ? 1 : r.h, e: r.e, line: r.line });
        }
      }
    }
  }
}

// ------------------------------------------------------------------ rig
function rig(anim, i) {
  const n = H_ANIMS[anim].count;
  const ph = (i / n) * Math.PI * 2;
  if (anim === 'idle') {
    const b = Math.sin(ph);
    return {
      ph,
      speed: 0,
      thighF: 0.06,
      thighB: -0.08,
      kneeF: 0.06,
      kneeB: 0.1,
      armF: 0.1 + b * 0.03,
      armB: -0.12,
      elbowF: -0.35,
      elbowB: -0.25,
      bob: 0,
      breathe: b > 0.3 ? 1 : 0,
      lean: 0,
      hairSway: Math.sin(ph) * 0.8,
      hairBack: 0.5,
      skirt: Math.sin(ph) * 0.3,
      blink: i === 5,
    };
  }
  const run = anim === 'run';
  const A = run ? 0.72 : 0.36;
  const s = Math.sin(ph);
  const c = Math.cos(ph);
  return {
    ph,
    speed: run ? 1 : 0.5,
    thighF: A * s,
    thighB: -A * s,
    kneeF: Math.max(0, -c) * (run ? 1.5 : 0.75) + 0.05,
    kneeB: Math.max(0, c) * (run ? 1.5 : 0.75) + 0.05,
    armF: -A * 0.85 * s,
    armB: A * 0.85 * s,
    elbowF: run ? -1.4 : -0.3,
    elbowB: run ? -1.4 : -0.3,
    bob: run ? Math.round(Math.abs(c) * 2) : Math.round(Math.abs(c)),
    breathe: 0,
    lean: run ? 2 : 0,
    hairSway: Math.sin(ph - 1.1) * (run ? 2.2 : 1.1),
    hairBack: run ? 5 : 2.2,
    skirt: Math.sin(ph - 0.6) * (run ? 1.6 : 0.9),
    blink: false,
  };
}

// ------------------------------------------------------------------ parts
function drawBackHair(p, head, r) {
  const { hx, hy } = head;
  const top = hy - 7;
  const end = hy + 26;
  for (let y = top; y <= end; y++) {
    const t = (y - top) / (end - top);
    // the mass hugs the skull, then flows down behind the shoulders
    let xl;
    let xr;
    if (y < hy + 3) {
      const a = (y - (hy - 1.5)) / 7.2;
      const w = Math.sqrt(Math.max(0, 1 - a * a)) * 7.2;
      xl = hx - w - 0.5;
      xr = hx + w * 0.75;
    } else {
      const u = (y - (hy + 3)) / (end - hy - 3);
      const flow = -r.hairBack * u * u - r.hairSway * u * u * 1.2;
      xl = hx - 6.5 + flow - u * 1.5;
      xr = hx + 1.5 + flow - u * 2.5;
    }
    // jagged tips
    const tipZone = end - 6;
    for (let x = Math.floor(xl); x <= Math.ceil(xr); x++) {
      if (y > tipZone) {
        const strand = (x + 64) % 3;
        const cut = end - (strand === 0 ? 0 : strand === 1 ? 3 : 5);
        if (y > cut) continue;
      }
      const rel = (x - xl) / Math.max(1, xr - xl);
      let col = rel < 0.25 ? C.hair[2] : rel < 0.8 ? C.hair[1] : C.hair[2];
      if (y > end - 3) col = C.hairTip;
      const isEdge = x <= Math.floor(xl) || x >= Math.ceil(xr);
      p.px(x, y, isEdge ? C.hair[3] : col, { h: 0.9, line: isEdge });
    }
  }
}

function drawHead(p, head, r) {
  const { hx, hy } = head;
  // face (skin) — slightly egg shaped, chin towards +x
  for (let y = hy - 5; y <= hy + 5; y++)
    for (let x = hx - 5; x <= hx + 6; x++) {
      const nx = (x + 0.5 - (hx + 0.6)) / 5.2;
      const ny = (y + 0.5 - hy) / (y > hy ? 5.4 : 5.6);
      const chin = y > hy + 2 ? (x + 0.5 - (hx + 1.5)) * 0.12 : 0;
      if (nx * nx + ny * ny - chin > 1) continue;
      const shadow = nx < -0.55 || ny > 0.75;
      p.px(x, y, shadow ? C.skin[1] : C.skin[0], { h: 1.2 });
    }
  // ear
  p.px(hx - 3, hy + 1, C.skin[1]);
  p.px(hx - 3, hy + 2, C.skin[2]);

  // eyes (3/4 view: near eye larger, far eye narrower near the face edge)
  const ey = hy + 1;
  if (r.blink) {
    for (let x = hx - 1; x <= hx + 2; x++) p.px(x, ey + 1, C.lash, { line: true });
    p.px(hx + 4, ey + 1, C.lash, { line: true });
    p.px(hx + 5, ey + 1, C.lash, { line: true });
  } else {
    // near eye: 4 x 4
    const ex = hx - 1;
    for (let x = ex - 1; x <= ex + 3; x++) p.px(x, ey - 1, C.lash, { line: true });
    p.px(ex - 1, ey, C.lash, { line: true });
    p.px(ex, ey, C.white);
    p.px(ex + 1, ey, C.iris[1]);
    p.px(ex + 2, ey, C.hairHi, { e: 0x404040 });
    p.px(ex + 3, ey, C.iris[1]);
    p.px(ex, ey + 1, C.white);
    p.px(ex + 1, ey + 1, C.iris[0]);
    p.px(ex + 2, ey + 1, C.iris[2]);
    p.px(ex + 3, ey + 1, C.iris[0]);
    p.px(ex + 1, ey + 2, C.iris[0], { e: 0x0a3438 });
    p.px(ex + 2, ey + 2, C.iris[0], { e: 0x0a3438 });
    p.px(ex + 3, ey + 2, C.lash, { line: true });
    // far eye: 2 x 4
    const fx = hx + 4;
    p.px(fx, ey - 1, C.lash, { line: true });
    p.px(fx + 1, ey - 1, C.lash, { line: true });
    p.px(fx, ey, C.iris[1]);
    p.px(fx + 1, ey, C.hairHi, { e: 0x303030 });
    p.px(fx, ey + 1, C.iris[2]);
    p.px(fx + 1, ey + 1, C.iris[0]);
    p.px(fx, ey + 2, C.iris[0], { e: 0x0a3438 });
  }
  // blush, nose, mouth
  p.px(hx - 1, ey + 3, C.blush);
  p.px(hx, ey + 3, C.blush);
  p.px(hx + 6, hy + 2, C.skin[1]);
  p.px(hx + 4, hy + 4, C.mouth);

  // bangs + crown
  const crownR = 6.6;
  for (let y = hy - 8; y <= hy + 0; y++)
    for (let x = hx - 7; x <= hx + 7; x++) {
      const nx = (x + 0.5 - hx) / crownR;
      const ny = (y + 0.5 - (hy - 1.6)) / crownR;
      if (nx * nx + ny * ny > 1) continue;
      // fringe: jagged spikes over the forehead
      if (y >= hy - 3 && x >= hx - 2) {
        const spike = [0, 2, 1, 3, 0, 2, 1, 3, 0, 1][(x - hx + 2) % 10];
        if (y > hy - 3 + spike) continue;
      }
      const ring = Math.abs(ny + 0.35) < 0.09 && nx > -0.7 && nx < 0.55 && (x + y) % 5 !== 0;
      const shadow = nx < -0.45 || ny > 0.55;
      const edge = nx * nx + ny * ny > 0.82;
      let col = shadow ? C.hair[1] : C.hair[0];
      if (ring) col = C.hairHi;
      p.px(x, y, edge ? C.hair[3] : col, { h: 1.4 + (ring ? 0.2 : 0), line: edge });
    }
  // side lock falling in front of the ear, swaying
  for (let y = hy - 2; y <= hy + 10; y++) {
    const u = (y - (hy - 2)) / 12;
    const x = Math.round(hx - 4 - r.hairSway * u * 0.6 - u * 0.5);
    p.px(x, y, C.hair[2], { h: 1.3, line: true });
    p.px(x + 1, y, u > 0.85 ? C.hairTip : C.hair[0], { h: 1.4 });
    if (u < 0.6) p.px(x + 2, y, C.hair[1], { h: 1.3 });
  }
  // headphones: band over the crown, cup over the ear with an LED ring
  for (let a = 0; a < 14; a++) {
    const ang = Math.PI * (0.95 + a / 13 * 0.75);
    p.px(hx - 1 + Math.cos(ang) * 7.2, hy - 1.5 + Math.sin(ang) * 7.2, C.phone[1], { h: 1.6, line: true });
  }
  for (let y = -2; y <= 2; y++)
    for (let x = -2; x <= 1; x++) {
      const d = Math.hypot((x + 0.5) / 2.2, y / 2.6);
      if (d > 1) continue;
      const led = x === -2 && Math.abs(y) <= 1;
      p.px(hx - 4 + x, hy + 1 + y, led ? C.neon : d > 0.7 ? C.phone[1] : C.phone[0], { h: 1.8, e: led ? C.neon : null, line: d > 0.7 && !led });
    }
  // ribbon clip
  p.px(hx + 3, hy - 7, C.ribbon, { h: 1.6 });
  p.px(hx + 4, hy - 7, C.ribbon, { h: 1.6 });
  p.px(hx + 4, hy - 8, C.ribbon, { h: 1.6 });
}

function drawLeg(p, hip, thigh, knee, far, r) {
  const L1 = 12;
  const L2 = 12;
  const kx = hip[0] + Math.sin(thigh) * L1;
  const ky = hip[1] + Math.cos(thigh) * L1;
  const sh = thigh - knee;
  const fx = kx + Math.sin(sh) * L2;
  const fy = ky + Math.cos(sh) * L2;
  const dim = far ? 1 : 0;
  const stock = far ? [C.stock[1], C.stock[1], 0x0a0a10] : [C.stock[0], C.stock[1], 0x0a0a10];
  const skin = far ? [C.skin[1], C.skin[2], C.skin[2]] : [C.skin[0], C.skin[1], C.skin[2]];
  // thigh: skin above the stocking band ("zettai ryouiki"), stocking below
  p.capsule(hip[0], hip[1], kx, ky, 2.6, 2.0, skin, {
    paint: (x, y, t, k, isLine) => {
      if (t > 0.8) return { col: isLine ? stock[2] : k < -0.3 ? stock[1] : stock[0], line: isLine };
      if (t > 0.74) return { col: stock[2] };
      return null;
    },
  });
  p.capsule(kx, ky, fx, fy, 2.0, 1.4, stock);
  // sneaker pointing +x, LED sole
  const sx = Math.round(fx);
  const sy = Math.round(fy);
  const shoe = far ? [C.shoe[1], C.shoe[1]] : C.shoe;
  for (let x = -2; x <= 3; x++) p.px(sx + x, sy, x < 0 ? shoe[1] : shoe[0], { h: 1.2 });
  for (let x = -2; x <= 2; x++) p.px(sx + x, sy - 1, shoe[0], { h: 1.2 });
  for (let x = -2; x <= 4; x++) p.px(sx + x, sy + 1, C.sole, { h: 1 });
  p.px(sx + 4, sy, C.shoe[1]);
  if (!dim) for (let x = -1; x <= 3; x++) p.px(sx + x, sy + 1, C.neon, { e: C.neon, h: 1 });
  return [fx, fy];
}

function drawArm(p, sh, armA, elbowA, far) {
  const L1 = 9;
  const L2 = 8.5;
  const ex = sh[0] + Math.sin(armA) * L1;
  const ey = sh[1] + Math.cos(armA) * L1;
  const fa = armA + elbowA;
  const hx = ex + Math.sin(fa) * L2;
  const hy = ey + Math.cos(fa) * L2;
  const jac = far ? [C.jacket[1], C.jacket[2], C.jacket[2]] : [C.jacket[0], C.jacket[1], C.jacket[2], C.jacketHi];
  p.capsule(sh[0], sh[1], ex, ey, 2.7, 2.4, jac);
  p.capsule(ex, ey, hx, hy, 2.4, 2.6, jac);
  // neon cuff + hand
  const cx = ex + Math.sin(fa) * (L2 - 1);
  const cy = ey + Math.cos(fa) * (L2 - 1);
  if (!far) {
    p.px(cx - 1, cy, C.neon, { e: C.neon, h: 1.4 });
    p.px(cx + 1, cy, C.neon, { e: C.neon, h: 1.4 });
    p.px(cx, cy, C.neon, { e: C.neon, h: 1.4 });
  }
  const sk = far ? C.skin[1] : C.skin[0];
  p.px(hx, hy + 1, sk, { h: 1.2 });
  p.px(hx + 1, hy + 1, sk, { h: 1.2 });
  p.px(hx, hy + 2, C.skin[1], { h: 1.2 });
  p.px(hx + 1, hy + 2, sk, { h: 1.2 });
}

function drawTorso(p, sh, hip, r) {
  const [sx, sy] = sh;
  const [hx2, hy2] = hip;
  // inner white top (visible at the open front)
  p.poly(
    [
      [sx - 1, sy],
      [sx + 4, sy],
      [hx2 + 4, hy2 - 2],
      [hx2 - 1, hy2 - 2],
    ],
    (x, y, l, rr) => ({ col: l < 1 ? C.top[1] : C.top[0], h: 1.1 })
  );
  // ribbon tie at the collar
  p.px(sx + 3, sy + 2, C.ribbon, { h: 1.4 });
  p.px(sx + 4, sy + 3, C.ribbon, { h: 1.4 });
  p.px(sx + 3, sy + 4, C.ribbon, { h: 1.4 });
  // oversized jacket: back panel and open front edge with neon piping
  const hem = hy2 + 3;
  const flap = Math.round(r.hairBack * 0.4);
  p.poly(
    [
      [sx - 5, sy - 1],
      [sx + 1, sy - 1],
      [sx + 2, sy + 4],
      [hx2 + 2, hem],
      [hx2 - 6 - flap, hem + 1],
    ],
    (x, y, l, rr, x0, x1) => {
      const edgeR = rr < 1;
      const edgeL = l < 1;
      if (y >= hem) return { col: C.neon, e: C.neon, h: 1.2 };
      if (edgeR) return { col: C.neon, e: C.neon, h: 1.3 };
      if (edgeL) return { col: C.jacket[2], line: true };
      const fold = (x + Math.floor(y / 3)) % 7 === 0;
      return { col: fold ? C.jacket[1] : l < 3 ? C.jacket[1] : C.jacket[0], h: fold ? 0.8 : 1.1 };
    }
  );
  // collar
  for (let x = sx - 3; x <= sx + 2; x++) p.px(x, sy - 2, C.jacket[0], { h: 1.4 });
  p.px(sx + 2, sy - 2, C.neon, { e: C.neon });
  p.px(sx - 3, sy - 2, C.jacket[2], { line: true });
}

function drawSkirt(p, hip, r) {
  const [hx2, hy2] = hip;
  const top = hy2 - 2;
  const bot = hy2 + 6;
  const sway = r.skirt;
  p.poly(
    [
      [hx2 - 4, top],
      [hx2 + 4, top],
      [hx2 + 6 + sway * 0.4, bot],
      [hx2 - 7 + sway - r.hairBack * 0.35, bot + 1],
    ],
    (x, y, l, rr) => {
      if (y >= bot) return { col: C.skirtLine, h: 1 };
      if (l < 1) return { col: C.skirt[2], line: true };
      if (rr < 1) return { col: C.skirt[1], h: 1 };
      const pleat = (x - hx2 + 40 + Math.floor((y - top) * 0.25)) % 3 === 0;
      return { col: pleat ? C.skirt[1] : C.skirt[0], h: pleat ? 0.8 : 1.1 };
    }
  );
}

function drawFrame(img, ox, anim, i) {
  const p = new Painter(img, ox);
  const r = rig(anim, i);
  const feet = 92;
  const cx = 30 + r.lean;
  const hipY = feet - 25 - r.bob * 0 + (r.bob ? -1 : 0) + 1;
  const hip = [cx, hipY - r.bob];
  const sh = [cx + 1 + r.lean * 0.5, hip[1] - 13 + r.breathe * 0];
  const head = { hx: sh[0] - 0.5 + r.lean * 0.5, hy: sh[1] - 9 - r.breathe * 0.5 };

  drawBackHair(p, { hx: Math.round(head.hx), hy: Math.round(head.hy) }, r);
  drawArm(p, [sh[0] - 3, sh[1] + 1], r.armB, r.elbowB, true);
  drawLeg(p, [hip[0] - 2, hip[1]], r.thighB, r.kneeB, true, r);
  drawLeg(p, [hip[0] + 1, hip[1]], r.thighF, r.kneeF, false, r);
  drawSkirt(p, hip, r);
  drawTorso(p, sh, hip, r);
  // neck
  p.px(head.hx, sh[1] - 2, C.skin[1]);
  p.px(head.hx + 1, sh[1] - 2, C.skin[1]);
  p.px(head.hx + 1, sh[1] - 3, C.skin[0]);
  drawHead(p, { hx: Math.round(head.hx), hy: Math.round(head.hy) }, r);
  drawArm(p, [sh[0] + 1, sh[1] + 1], r.armF, r.elbowF, false);
}

// Selective outline: transparent texels next to the figure get a dark,
// colour-tinted line (classic pixel-art "sel-out").
function outline(img) {
  const { w, h } = img;
  const a = img.albedo;
  const add = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (a[i * 4 + 3] > 0.5) continue;
      let best = -1;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (Math.floor(xx / H_FW) !== Math.floor(x / H_FW)) continue;
        const j = yy * w + xx;
        if (a[j * 4 + 3] > 0.5) best = j;
      }
      if (best >= 0) add.push([i, best]);
    }
  for (const [i, j] of add) {
    a[i * 4] = a[j * 4] * 0.22 + 0.02;
    a[i * 4 + 1] = a[j * 4 + 1] * 0.2 + 0.015;
    a[i * 4 + 2] = a[j * 4 + 2] * 0.26 + 0.04;
    a[i * 4 + 3] = 1;
    img.height[i] = 0.2;
    img.rough[i] = 0.9;
  }
}

export function makeHeroineImage() {
  const img = new PixelImage(H_FW * H_FRAMES, H_FH, { wrap: false, transparent: true });
  img.lineMask = new Uint8Array(img.w * img.h);
  for (const [anim, { start, count }] of Object.entries(H_ANIMS)) for (let i = 0; i < count; i++) drawFrame(img, (start + i) * H_FW, anim, i);
  outline(img);
  // rounded-volume heights: silhouette distance blended with painted relief
  const base = new Float32Array(img.w * img.h);
  for (let k = 0; k < base.length; k++) base[k] = img.albedo[k * 4 + 3] > 0.5 ? 1 : 0;
  const painted = img.height.slice();
  img.height.set(base);
  img.blurHeight(1, 3);
  for (let k = 0; k < base.length; k++) img.height[k] = img.height[k] * 1.0 + (base[k] ? (painted[k] - 1) * 0.35 : 0);
  return img;
}

export function makeHeroineSheet() {
  const img = makeHeroineImage();
  const tex = img.toTextures({ name: 'heroine', normalStrength: 1.4 });
  for (const t of [tex.map, tex.normalMap, tex.ormMap, tex.emissiveMap]) {
    if (!t) continue;
    t.minFilter = THREE.NearestMipmapLinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  }
  tex.meta = { fw: H_FW, fh: H_FH, frames: H_FRAMES, anims: H_ANIMS, tpm: H_TPM, footPad: 2 };
  return { tex, img };
}
