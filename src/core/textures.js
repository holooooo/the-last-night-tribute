import * as THREE from 'three';
import { PixelImage, hex, shade, mixc } from './pixel.js';
import { RNG } from './rng.js';
import { drawText, textWidth, drawPseudo } from './font.js';

// Procedural pixel-art texture library. Texel density: 16 texels per meter.
export const TPM = 16;

const DEBRIS = [0xc23b3b, 0xe0c341, 0x3fa34d, 0x2f7fc0, 0xd66f2a, 0xd9d2c0, 0x8f44a8];

export function cobble(seed = 1) {
  const rng = new RNG(seed);
  const W = 128;
  const H = 128;
  const img = new PixelImage(W, H);
  img.fill({ color: 0x101316, height: 0, rough: 0.95 });
  const palette = [0x3b4049, 0x444952, 0x4c4a4e, 0x39414b, 0x4f4740, 0x353a40, 0x474e55];
  let y = 0;
  while (y < H) {
    const rh = rng.int(5, 7);
    let x = rng.int(0, 6);
    const rowStart = x;
    while (x < W + rowStart) {
      const rw = rng.int(6, 11);
      const base = hex(rng.pick(palette));
      const k = rng.float(0.8, 1.15);
      for (let yy = 0; yy < rh - 1; yy++)
        for (let xx = 0; xx < rw - 1; xx++) {
          const corner = (xx === 0 || xx === rw - 2) && (yy === 0 || yy === rh - 2);
          if (corner) continue;
          const edge = xx === 0 || yy === 0 || xx === rw - 2 || yy === rh - 2;
          const top = yy <= 1;
          const kk = k * (top ? 1.12 : 1) * (edge ? 0.85 : 1) * rng.float(0.92, 1.08);
          img.px(x + xx, y + yy, {
            color: [base[0] * kk, base[1] * kk, base[2] * kk],
            height: edge ? 0.55 : 1,
            rough: rng.float(0.55, 0.8),
          });
        }
      x += rw;
    }
    y += rh;
  }
  img.blotches(rng, 50, { color: 0x05080a, alpha: 0.35, rMin: 2, rMax: 7 });
  img.blotches(rng, 18, { color: 0x2d3a26, alpha: 0.25, rMin: 1, rMax: 3 });
  // colourful litter specks
  for (let i = 0; i < 70; i++) {
    const c = rng.pick(DEBRIS);
    const x = rng.int(0, W);
    const yy = rng.int(0, H);
    img.px(x, yy, { color: shade(c, rng.float(0.5, 0.9)), height: 1.3, rough: 0.5 });
    if (rng.chance(0.5)) img.px(x + 1, yy, { color: shade(c, 0.6), height: 1.2 });
  }
  return img;
}

export function pavers(seed = 2, { base = 0x4a4d52, size = 16 } = {}) {
  const rng = new RNG(seed);
  const W = 64;
  const img = new PixelImage(W, W);
  img.fill({ color: 0x16191c, height: 0, rough: 0.95 });
  for (let ty = 0; ty < W; ty += size)
    for (let tx = 0; tx < W; tx += size) {
      const k = rng.float(0.82, 1.1);
      const c = shade(base, k);
      img.rect(tx, ty, size - 1, size - 1, () => ({ color: shade(c, rng.float(0.94, 1.05)), height: 1, rough: rng.float(0.6, 0.8) }));
      if (rng.chance(0.3)) {
        let cx = tx + rng.int(2, size - 3);
        let cy = ty;
        for (let i = 0; i < size; i++) {
          img.px(cx, cy, { color: 0x15181b, height: 0.3 });
          cy++;
          cx += rng.int(-1, 1);
        }
      }
    }
  img.blotches(rng, 30, { color: 0x060809, alpha: 0.3, rMin: 2, rMax: 6 });
  for (let i = 0; i < 25; i++) img.px(rng.int(0, W), rng.int(0, W), { color: shade(rng.pick(DEBRIS), 0.7), height: 1.3 });
  return img;
}

export function brick(seed = 3, { base = 0x6b3a2e, mortar = 0x2b2622, w = 8, h = 3 } = {}) {
  const rng = new RNG(seed);
  const W = 64;
  const img = new PixelImage(W, W);
  img.fill({ color: mortar, height: 0, rough: 0.95 });
  for (let row = 0; row * (h + 1) < W; row++) {
    const y = row * (h + 1);
    const off = row % 2 ? w / 2 : 0;
    for (let x = -w; x < W + w; x += w + 1) {
      const k = rng.float(0.75, 1.15);
      const c = rng.chance(0.08) ? shade(0x4a2a24, k) : shade(base, k);
      img.rect(x + off, y, w, h, (lx, ly) => ({
        color: shade(c, ly === 0 ? 1.1 : rng.float(0.92, 1.03)),
        height: 1,
        rough: 0.8,
      }));
    }
  }
  img.streaks(rng, 40, { color: 0x0b0806, alpha: 0.35, minLen: 6, maxLen: 40 });
  img.blotches(rng, 12, { color: 0x1d2a20, alpha: 0.3, rMin: 2, rMax: 5 });
  return img;
}

export function concrete(seed = 4, { base = 0x5a6066, panel = 32, stains = true } = {}) {
  const rng = new RNG(seed);
  const W = 64;
  const img = new PixelImage(W, W);
  img.fill({ color: base, height: 0.8, rough: 0.9 });
  img.noise(rng, 0.06);
  for (let y = 0; y < W; y += panel) img.rect(0, y, W, 1, { color: shade(base, 0.45), height: 0.2 });
  for (let x = 0; x < W; x += panel) img.rect(x, 0, 1, W, { color: shade(base, 0.5), height: 0.2 });
  for (let y = 4; y < W; y += panel / 2)
    for (let x = 4; x < W; x += panel / 2) img.px(x, y, { color: shade(base, 0.4), height: 0.4 });
  if (stains) {
    img.streaks(rng, 60, { color: 0x101418, alpha: 0.35, minLen: 8, maxLen: 50 });
    img.blotches(rng, 20, { color: 0x1a1f22, alpha: 0.25, rMin: 2, rMax: 8 });
  }
  return img;
}

export function tiles(seed = 5, { base = 0x5d8a86, grout = 0x2a302f, size = 4, vary = 0.12 } = {}) {
  const rng = new RNG(seed);
  const W = 64;
  const img = new PixelImage(W, W);
  img.fill({ color: grout, height: 0, rough: 0.9 });
  for (let y = 0; y < W; y += size)
    for (let x = 0; x < W; x += size) {
      if (rng.chance(0.03)) continue; // missing tile
      const c = shade(base, rng.float(1 - vary, 1 + vary));
      img.rect(x, y, size - 1, size - 1, (lx, ly) => ({
        color: lx === 0 && ly === 0 ? shade(c, 1.1) : c,
        height: 1,
        rough: 0.3,
      }));
    }
  img.streaks(rng, 45, { color: 0x0d0f0e, alpha: 0.4, minLen: 6, maxLen: 40 });
  return img;
}

export function shutter(seed = 6, { base = 0x6b7378, graffiti = true } = {}) {
  const rng = new RNG(seed);
  const W = 64;
  const H = 48;
  const img = new PixelImage(W, H);
  for (let y = 0; y < H; y++) {
    const ph = y % 3;
    img.rect(0, y, W, 1, { color: shade(base, ph === 0 ? 1.15 : ph === 1 ? 0.95 : 0.6), height: ph === 2 ? 0.3 : 1, rough: 0.55, metal: 0.4 });
  }
  img.rect(0, H - 3, W, 3, { color: shade(base, 0.45), height: 1, metal: 0.6 });
  if (graffiti) {
    const cols = [0xd04a7a, 0x3fb7c2, 0xe0b23a, 0x8bd04a, 0xffffff];
    for (let g = 0; g < 4; g++) {
      const c = rng.pick(cols);
      let x = rng.int(2, W - 10);
      let y = rng.int(4, H - 16);
      for (let s = 0; s < 18; s++) {
        img.disc(x, y, rng.float(0.8, 1.6), { color: c, alpha: 0.85 });
        x += rng.int(-1, 2);
        y += rng.int(-1, 1);
      }
    }
  }
  img.streaks(rng, 50, { color: 0x3b2414, alpha: 0.4, minLen: 4, maxLen: 30 });
  return img;
}

export function corrugated(seed = 7, { base = 0x4f5d63 } = {}) {
  const rng = new RNG(seed);
  const W = 32;
  const img = new PixelImage(W, W);
  for (let x = 0; x < W; x++) {
    const ph = x % 4;
    img.rect(x, 0, 1, W, { color: shade(base, [1.15, 1.0, 0.75, 0.6][ph]), height: [1, 0.8, 0.4, 0.2][ph], rough: 0.5, metal: 0.5 });
  }
  img.streaks(rng, 30, { color: 0x4a2a12, alpha: 0.45, minLen: 4, maxLen: 24 });
  img.noise(rng, 0.05);
  return img;
}

export function wood(seed = 8, { base = 0x5a3a26 } = {}) {
  const rng = new RNG(seed);
  const W = 32;
  const H = 64;
  const img = new PixelImage(W, H);
  for (let x = 0; x < W; x += 4) {
    const c = shade(base, rng.float(0.75, 1.15));
    img.rect(x, 0, 3, H, () => ({ color: shade(c, rng.float(0.9, 1.06)), height: 1, rough: 0.8 }));
    img.rect(x + 3, 0, 1, H, { color: shade(base, 0.3), height: 0.2 });
    for (let k = 0; k < 2; k++) {
      const y = rng.int(0, H);
      img.rect(x, y, 3, 1, { color: shade(base, 0.35), height: 0.4 });
    }
  }
  img.streaks(rng, 20, { color: 0x000000, alpha: 0.3 });
  return img;
}

export function roofTiles(seed = 9, { base = 0x3f7d5c } = {}) {
  const rng = new RNG(seed);
  const W = 32;
  const img = new PixelImage(W, W);
  img.fill({ color: shade(base, 0.35), height: 0 });
  for (let x = 0; x < W; x += 4) {
    const c = shade(base, rng.float(0.85, 1.12));
    img.rect(x, 0, 3, W, (lx, ly) => ({ color: shade(c, lx === 1 ? 1.3 : lx === 0 ? 1.0 : 0.72), height: lx === 1 ? 1 : 0.7, rough: 0.35 }));
  }
  for (let y = 0; y < W; y += 6) img.rect(0, y, W, 1, { color: shade(base, 0.45), height: 0.3 });
  img.streaks(rng, 20, { color: 0x0b1410, alpha: 0.35, minLen: 3, maxLen: 14 });
  return img;
}

export function awning(seed = 10, { a = 0x2f5fa8, b = 0xd9dde0, stripe = 4 } = {}) {
  const rng = new RNG(seed);
  const W = 32;
  const H = 32;
  const img = new PixelImage(W, H, { transparent: true });
  for (let x = 0; x < W; x++) {
    const c = Math.floor(x / stripe) % 2 ? a : b;
    for (let y = 0; y < H; y++) {
      const scallop = y >= H - 4;
      if (scallop) {
        const lx = x % (stripe * 2);
        const dy = y - (H - 4);
        if (Math.abs(lx - stripe + 0.5) > stripe - dy * 1.2) continue;
      }
      const fold = y % 8 === 0 ? 0.8 : 1;
      img.px(x, y, { color: shade(c, fold * (0.9 + 0.1 * Math.sin(x * 0.8))), height: fold < 1 ? 0.5 : 1, rough: 0.9 });
    }
  }
  img.streaks(rng, 25, { color: 0x101010, alpha: 0.25, minLen: 3, maxLen: 18 });
  return img;
}

export function metal(seed = 11, { base = 0x3a4248 } = {}) {
  const rng = new RNG(seed);
  const W = 32;
  const img = new PixelImage(W, W);
  img.fill({ color: base, height: 0.8, rough: 0.5, metal: 0.6 });
  img.noise(rng, 0.07);
  img.frame(0, 0, W, W, { color: shade(base, 0.5), height: 0.3 });
  for (const [x, y] of [
    [2, 2],
    [W - 3, 2],
    [2, W - 3],
    [W - 3, W - 3],
  ])
    img.px(x, y, { color: shade(base, 1.5), height: 1.4 });
  img.streaks(rng, 18, { color: 0x3d2615, alpha: 0.4, minLen: 3, maxLen: 18 });
  return img;
}

export function grille(seed = 12, { base = 0x2a3036 } = {}) {
  const W = 16;
  const img = new PixelImage(W, W, { transparent: true });
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const on = x % 4 === 0 || y % 4 === 0;
      if (on) img.px(x, y, { color: shade(base, 1 + 0.2 * ((x + y) % 2)), height: 1, rough: 0.5, metal: 0.7 });
    }
  return img;
}

export function acUnit(seed = 13) {
  const rng = new RNG(seed);
  const W = 24;
  const H = 16;
  const img = new PixelImage(W, H);
  const body = 0x9aa2a2;
  img.fill({ color: body, height: 1, rough: 0.6 });
  img.frame(0, 0, W, H, { color: shade(body, 0.6), height: 0.6 });
  img.disc(8, 8, 6, { color: 0x2b2f31, height: 0.2 });
  for (let a = 0; a < 3; a++) {
    const ang = (a / 3) * Math.PI * 2 + 0.3;
    img.line(8, 8, 8 + Math.cos(ang) * 5, 8 + Math.sin(ang) * 5, { color: 0x5a6062, height: 0.6 });
  }
  for (let y = 3; y < H - 3; y += 2) img.rect(16, y, 6, 1, { color: shade(body, 0.55), height: 0.4 });
  img.streaks(rng, 12, { color: 0x3b2a1a, alpha: 0.5, minLen: 3, maxLen: 12 });
  return img;
}

// Window atlas: 8 variants (16x24 px each = 1m x 1.5m) in a 128x24 strip.
export function windowAtlas(seed = 14) {
  const rng = new RNG(seed);
  const CW = 16;
  const CH = 24;
  const N = 8;
  const img = new PixelImage(CW * N, CH, { wrap: false });
  const warm = [0xffc77a, 0xffb25c, 0xffd9a0, 0xff9f62];
  const cool = [0x9fd8ff, 0x7fe0d0, 0xc3b8ff];
  for (let i = 0; i < N; i++) {
    const x0 = i * CW;
    const frame = 0x2a2d31;
    img.rect(x0, 0, CW, CH, { color: frame, height: 1, rough: 0.6 });
    img.rect(x0 + 1, 1, CW - 2, CH - 3, { color: 0x0d1418, height: 0.3, rough: 0.1 });
    img.rect(x0, CH - 2, CW, 2, { color: 0x4a4e52, height: 1.2 });
    const lit = i < 6;
    if (lit) {
      const c = i < 4 ? rng.pick(warm) : rng.pick(cool);
      const kind = i % 4;
      for (let y = 1; y < CH - 2; y++)
        for (let x = 1; x < CW - 1; x++) {
          let k = 0.65 + 0.35 * (1 - y / CH);
          if (kind === 0 && y % 3 === 0) k *= 0.35; // blinds
          if (kind === 1 && (x < 4 || x > CW - 5)) k *= 0.25; // curtains
          if (kind === 2 && x > 5 && x < 10 && y > 8) k *= 0.15; // silhouette
          if (kind === 3 && y > 14) k *= 0.4; // plants
          img.px(x0 + x, y, { color: shade(c, k * 0.7), emissive: shade(c, k), height: 0.3, rough: 0.1 });
        }
      if (kind === 3)
        for (let s = 0; s < 6; s++)
          img.disc(x0 + rng.int(3, 12), rng.int(14, 20), rng.float(1, 2.2), { color: 0x1b2a14, emissive: 0x0a1206 });
    } else {
      img.rect(x0 + 1, 1, CW - 2, CH - 3, () => ({ color: shade(0x1b2730, rng.float(0.7, 1.2)), rough: 0.08 }));
      img.line(x0 + 3, 3, x0 + 8, 10, { color: 0x3a4a56 });
    }
    img.rect(x0 + CW / 2, 1, 1, CH - 3, { color: frame, emissive: 0x000000, height: 1 });
  }
  return img;
}

// Distant tower facade (emissive windows grid), 64x64 per variant.
export function towerFacade(seed = 15, { lit = 0.35, base = 0x1b2128 } = {}) {
  const rng = new RNG(seed);
  const W = 64;
  const img = new PixelImage(W, W);
  img.fill({ color: base, height: 0.6, rough: 0.7 });
  const warm = [0xffc477, 0xffaf5e, 0xffe0a8];
  const cool = [0x8fd4ff, 0x9ee7e0, 0xd2b8ff];
  for (let y = 1; y < W; y += 4)
    for (let x = 1; x < W; x += 3) {
      const on = rng.chance(lit);
      const c = rng.chance(0.75) ? rng.pick(warm) : rng.pick(cool);
      img.rect(x, y, 2, 2, on ? { color: shade(c, 0.5), emissive: shade(c, rng.float(0.5, 1)), height: 0.3 } : { color: 0x0b0f13, height: 0.3, rough: 0.1 });
    }
  for (let y = 0; y < W; y += 16) img.rect(0, y, W, 1, { color: shade(base, 1.4), height: 1 });
  return img;
}

export function leaves(seed = 16, { greens = [0x24502a, 0x356b2f, 0x4d8a36, 0x6ea33f], density = 260, size = 64 } = {}) {
  const rng = new RNG(seed);
  const W = size;
  const img = new PixelImage(W, W, { transparent: true, wrap: false });
  const cx = W / 2;
  const cy = W / 2;
  for (let i = 0; i < density; i++) {
    const a = rng.float(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * W * 0.46;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.85;
    const depth = 1 - r / (W * 0.5);
    const c = greens[Math.min(greens.length - 1, Math.floor(rng.float(0, greens.length) * (0.4 + 0.6 * depth) + (y < cy ? 0.6 : 0)))];
    const lr = rng.float(1.0, 2.2);
    img.ellipse(x, y, lr * 1.4, lr, { color: shade(c, rng.float(0.85, 1.1)), height: 0.5 + depth, rough: 0.7 });
    if (rng.chance(0.5)) img.px(x - 1, y - 1, { color: shade(c, 1.3), height: 1 + depth });
  }
  return img;
}

export function vines(seed = 17, { w = 32, h = 64 } = {}) {
  const rng = new RNG(seed);
  const img = new PixelImage(w, h, { transparent: true, wrap: false });
  const greens = [0x234a26, 0x2f6a2c, 0x4b8f35, 0x77b347];
  for (let s = 0; s < 9; s++) {
    let x = rng.float(2, w - 2);
    const len = rng.int(h * 0.4, h);
    for (let y = 0; y < len; y++) {
      x += rng.float(-0.4, 0.4);
      img.px(x, y, { color: 0x1d3a1c, height: 0.5 });
      if (rng.chance(0.55)) {
        const c = rng.pick(greens);
        img.ellipse(x + rng.float(-1.5, 1.5), y, rng.float(1, 1.8), 1, { color: c, height: 1 });
      }
    }
  }
  return img;
}

export function interior(seed = 18, { wall = 0x2b4a52, light = 0xbfe9ff } = {}) {
  // shop interior back wall with shelves and products
  const rng = new RNG(seed);
  const W = 64;
  const H = 48;
  const img = new PixelImage(W, H, { wrap: false });
  img.fill({ color: wall, height: 0.5, rough: 0.8 });
  img.noise(rng, 0.05);
  const prods = [0xe24b4b, 0xf2c94c, 0x5ad18a, 0x4fa3e0, 0xf08fd0, 0xffffff, 0xff8a3d];
  for (let y = 8; y < H - 6; y += 10) {
    img.rect(2, y + 7, W - 4, 2, { color: 0x6b7378, height: 1.2 });
    for (let x = 3; x < W - 4; x += rng.int(2, 4)) {
      const ph = rng.int(3, 6);
      const c = rng.pick(prods);
      img.rect(x, y + 7 - ph, rng.int(1, 3), ph, { color: shade(c, rng.float(0.7, 1)), height: 1.4, rough: 0.4 });
    }
  }
  img.rect(0, 0, W, 3, { color: 0xffffff, emissive: light, emissiveK: 1, height: 1 });
  return img;
}

export function lantern(seed = 19, { color = 0xe0402a } = {}) {
  const W = 16;
  const H = 24;
  const img = new PixelImage(W, H, { transparent: true, wrap: false });
  img.rect(5, 0, 6, 2, { color: 0x1a1a1a, height: 1 });
  img.rect(5, H - 2, 6, 2, { color: 0x1a1a1a, height: 1 });
  img.ellipse(8, 12, 7.5, 10, { color: color, emissive: color, emissiveK: 1, height: 1 });
  for (let y = 4; y < H - 3; y += 3) img.rect(1, y, 14, 1, { color: shade(color, 0.5), emissive: shade(color, 0.35), height: 0.6 });
  img.rect(7, 2, 2, H - 4, { color: 0xffe0a0, emissive: 0xffd080 });
  return img;
}

// Neon sign: emissive letters on a dark panel with a tube border.
export function neonSign(text, { color = 0x5ef0ff, panel = 0x0b1216, border = null, pad = 3, scale = 1, w = null, h = null, alpha = false, glow = 0.18 } = {}) {
  const tw = textWidth(text) * scale;
  const W = w || tw + pad * 2;
  const H = h || 7 * scale + pad * 2;
  const img = new PixelImage(W, H, { wrap: false, transparent: alpha });
  if (!alpha) img.fill({ color: panel, height: 0.5, rough: 0.6 });
  if (border) {
    img.frame(0, 0, W, H, { color: border, emissive: border, height: 1 });
  }
  const x0 = Math.floor((W - tw) / 2);
  const y0 = Math.floor((H - 7 * scale) / 2);
  // soft halo baked into the panel (the sign's own light on its backing)
  if (!alpha && glow > 0)
    drawText(text, x0, y0, (x, y) => {
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) img.px(x + ox, y + oy, { color: mixc(panel, color, glow), alpha: 1 });
    }, { scale });
  drawText(text, x0, y0, (x, y) => img.px(x, y, { color: mixc(color, 0xffffff, 0.35), emissive: color, height: 1.2 }), { scale });
  return img;
}

export function glyphSign(seed, count, { color = 0xff4a5a, panel = 0x14090b, vertical = true, border = null, pad = 2 } = {}) {
  const cell = 9;
  const W = vertical ? 7 + pad * 2 : count * cell - 2 + pad * 2;
  const H = vertical ? count * cell - 2 + pad * 2 : 7 + pad * 2;
  const img = new PixelImage(W, H, { wrap: false });
  img.fill({ color: panel, height: 0.5, rough: 0.6 });
  if (border) img.frame(0, 0, W, H, { color: border, emissive: border, height: 1 });
  for (let i = 0; i < count; i++) {
    const x = vertical ? pad : pad + i * cell;
    const y = vertical ? pad + i * cell : pad;
    drawPseudo(seed * 31 + i, x, y, (px, py) => img.px(px, py, { color: mixc(color, 0xffffff, 0.3), emissive: color, height: 1.2 }));
  }
  return img;
}

export function poster(seed = 20) {
  const rng = new RNG(seed);
  const W = 16;
  const H = 24;
  const img = new PixelImage(W, H, { wrap: false });
  const bgs = [0xd9c9a3, 0xc94848, 0x2e6c8a, 0xe6d14a, 0x1c1c1c, 0xe07a9a];
  const bg = rng.pick(bgs);
  img.fill({ color: bg, height: 0.6, rough: 0.9 });
  const fg = rng.pick([0x111111, 0xffffff, 0xd03030, 0x30a0d0]);
  img.rect(2, 2, W - 4, 10, { color: shade(fg, 0.9) });
  img.disc(8, 7, 3, { color: rng.pick(bgs) });
  for (let i = 0; i < 2; i++) drawPseudo(seed * 3 + i, 1 + i * 7, 14, (x, y) => img.px(x, y, { color: fg }), 1);
  img.streaks(rng, 6, { color: 0x000000, alpha: 0.3, minLen: 3, maxLen: 12 });
  return img;
}

export function plaster(seed = 21, { base = 0x7a6a58 } = {}) {
  const rng = new RNG(seed);
  const W = 64;
  const img = new PixelImage(W, W);
  img.fill({ color: base, height: 0.7, rough: 0.9 });
  img.noise(rng, 0.08);
  img.blotches(rng, 30, { color: shade(base, 0.6), alpha: 0.35, rMin: 2, rMax: 8 });
  // chipped plaster revealing brick
  for (let i = 0; i < 5; i++) {
    const cx = rng.int(0, W);
    const cy = rng.int(0, W);
    const r = rng.int(3, 7);
    img.ellipse(cx, cy, r, r * 0.7, (() => ({ color: 0x5a3328, height: 0.3 }))());
    for (let y = cy - r; y < cy + r; y += 3) img.rect(cx - r, y, r * 2, 1, { color: 0x2a1c18, height: 0.1, alpha: 0.6 });
  }
  img.streaks(rng, 70, { color: 0x15110d, alpha: 0.35, minLen: 6, maxLen: 50 });
  return img;
}

export function trim(seed = 22, { base = 0x30363c } = {}) {
  const rng = new RNG(seed);
  const W = 16;
  const img = new PixelImage(W, W);
  img.fill({ color: base, height: 1, rough: 0.6 });
  img.rect(0, 0, W, 1, { color: shade(base, 1.6), height: 1.3 });
  img.rect(0, W - 1, W, 1, { color: shade(base, 0.4), height: 0.4 });
  img.noise(rng, 0.06);
  return img;
}

// Seamless dark cloud/sky gradient for the backdrop (not pixel textured).
export function skyTexture() {
  const W = 512;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#05080f');
  grd.addColorStop(0.45, '#0d1726');
  grd.addColorStop(0.75, '#2a2433');
  grd.addColorStop(1.0, '#4a3036');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  const rng = new RNG(99);
  for (let i = 0; i < 260; i++) {
    const x = rng.float(0, W);
    const y = rng.float(H * 0.2, H * 0.9);
    const r = rng.float(20, 80);
    const a = rng.float(0.02, 0.06);
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(120,100,120,${a})`);
    rg.addColorStop(1, 'rgba(120,100,120,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------------------
// Material factory
// ---------------------------------------------------------------------------
export function materialFrom(img, { tile = null, emissiveIntensity = 1, color = 0xffffff, normalScale = 1, alphaTest = 0, side = THREE.FrontSide, name = 'mat', roughness = 1, metalness = 1, transparent = false } = {}) {
  const t = img.toTextures({ name });
  const m = new THREE.MeshStandardMaterial({
    map: t.map,
    normalMap: t.normalMap,
    roughnessMap: t.ormMap,
    metalnessMap: t.ormMap,
    roughness,
    metalness,
    color,
    side,
    alphaTest,
    transparent,
  });
  m.normalScale.set(normalScale, normalScale);
  if (t.emissiveMap) {
    m.emissiveMap = t.emissiveMap;
    m.emissive = new THREE.Color(0xffffff);
    m.emissiveIntensity = emissiveIntensity;
  }
  m.name = name;
  m.userData.tile = tile || [img.w / TPM, img.h / TPM];
  m.userData.textures = t;
  return m;
}
