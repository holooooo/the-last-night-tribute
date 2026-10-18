import * as THREE from 'three';
import { RNG, hash2 } from '../core/rng.js';
import * as T from '../core/textures.js';
import { PixelImage } from '../core/pixel.js';
import { catenary } from '../core/kit.js';
import { LAYER } from '../render/pipeline.js';
import { makeGlass, makeHolo } from '../render/materials.js';

// Street layout constants (meters). The camera looks along -z.
export const Z_FRONT = -4.5; // shop facade plane
export const Z_CURB = 1.8; // street edge / canal wall
export const Z_QUAY = 9.0; // near quay (foreground)
export const WATER_Y = -0.16;

// Deterministic flicker curves for neon and lamps.
export function flicker(seed, kind = 'hum') {
  return (t) => {
    if (kind === 'steady') return 1;
    const hum = 0.96 + 0.04 * Math.sin(t * 50 + seed);
    if (kind === 'hum') return hum;
    const rate = kind === 'broken' ? 9 : 4;
    const slot = Math.floor(t * rate);
    const h = hash2(slot, seed | 0, 77);
    if (kind === 'broken') {
      if (h < 0.35) return 0.05 + 0.2 * hash2(slot, seed, 3);
      if (h < 0.5) return 0.6;
      return hum;
    }
    // 'flicker': rare dropouts, sometimes a quick stutter
    if (h < 0.035) return 0.08;
    if (h < 0.06) return Math.floor(t * 30) % 2 ? 0.2 : 1;
    return hum;
  };
}

export function buildStreet(ctx, kit, mats) {
  const { scene, lights, pipeline, shared } = ctx;
  const updaters = [];
  const lampSpots = []; // virtual street lamps (mapped onto pooled SpotLights)
  const glassMeshes = [];
  const animated = []; // { mesh, fn(t) }
  const rng = new RNG(2024);

  // ------------------------------------------------------------------ helpers
  const signMats = [];
  function sign(img, x, y, z, { k = 3, rotY = 0, light = null, kind = 'hum', seed = rng.int(0, 9999), scale = 1, layer = LAYER.WORLD, back = true } = {}) {
    const mat = mats.emissiveTex(img, k, { side: back ? THREE.DoubleSide : THREE.FrontSide });
    const [w, h] = mat.userData.size;
    const g = new THREE.PlaneGeometry(w * scale, h * scale);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    mesh.layers.set(layer);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    scene.add(mesh);
    const fl = flicker(seed, kind);
    let vl = null;
    if (light) {
      const n = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
      vl = lights.add({
        position: new THREE.Vector3(x, y, z).addScaledVector(n, light.offset === undefined ? 0.5 : light.offset),
        color: light.color,
        intensity: light.intensity || 12,
        range: light.range || 7,
        fog: light.fog === undefined ? 1 : light.fog,
        surface: light.surface !== false,
        flicker: fl,
      });
    }
    signMats.push({ mat, fl, base: k });
    return { mesh, light: vl, w: w * scale, h: h * scale };
  }

  function neonTube(points, color, k = 5, r = 0.035, light = null) {
    kit.tube(mats.emissive(color, k), points.map((p) => new THREE.Vector3(...p)), r, { cast: false, receive: false, radial: 4 });
    if (light) lights.add({ position: new THREE.Vector3(...light.pos), color, intensity: light.intensity || 8, range: light.range || 5, fog: light.fog === undefined ? 1 : light.fog });
  }

  function windowGrid(x0, x1, y0, floors, floorH, zf, { spacing = 1.9, litBias = 0.6, sills = true, inset = 0.0 } = {}) {
    const n = Math.max(1, Math.floor((x1 - x0) / spacing));
    const pad = (x1 - x0 - n * spacing) / 2;
    for (let f = 0; f < floors; f++)
      for (let i = 0; i < n; i++) {
        const x = x0 + pad + spacing * (i + 0.5);
        const y = y0 + f * floorH + floorH * 0.5;
        const lit = rng.chance(litBias);
        const cell = lit ? rng.int(0, 5) : rng.int(6, 7);
        kit.quad(mats.windows, x, y, zf + 0.012 - inset, 1, 1.5, { uvRect: [cell / 8, 0, (cell + 1) / 8, 1], cast: false });
        if (inset > 0) {
          kit.box(mats.dark, x, y, zf - inset / 2, 1.04, 1.54, inset, { faces: ['px', 'nx', 'py', 'ny'], cast: false });
        }
        if (sills) kit.box(mats.trimLight, x, y - 0.8, zf + 0.06, 1.2, 0.08, 0.14, { cast: false });
        if (lit && rng.chance(0.18)) lights.add({ position: new THREE.Vector3(x, y, zf + 0.6), color: rng.pick([0xffc27a, 0xffd59a, 0x9fd8ff]), intensity: 3, range: 4, fog: 0.8, surface: false });
      }
  }

  function acUnit(x, y, zf) {
    kit.box(mats.metalLight, x, y, zf + 0.25, 0.8, 0.52, 0.5, { faces: ['px', 'nx', 'py', 'ny'] });
    kit.box(mats.ac, x, y, zf + 0.5, 0.8, 0.52, 0.002, { faces: ['pz'], uvMode: 'fit', tile: [1, 1] });
    kit.box(mats.metal, x, y - 0.32, zf + 0.2, 0.7, 0.04, 0.4);
  }

  function pipe(x, y0, y1, z, r = 0.07) {
    kit.cylinder(mats.pole, x, (y0 + y1) / 2, z, r, y1 - y0, { radial: 6 });
  }

  function ledge(x0, x1, y, zf, d = 0.3, h = 0.25, mat = mats.trim) {
    kit.boxMin(mat, x0, y, zf, x1 - x0, h, d);
  }

  function railing(x0, x1, y, z, h = 1.0, mat = mats.pole, step = 0.25) {
    kit.boxMin(mat, x0, y + h - 0.05, z - 0.03, x1 - x0, 0.06, 0.06);
    kit.boxMin(mat, x0, y + h * 0.45, z - 0.02, x1 - x0, 0.04, 0.04);
    for (let x = x0; x <= x1 + 1e-3; x += step) kit.boxMin(mat, x - 0.02, y, z - 0.02, 0.04, h, 0.04);
  }

  function balcony(x0, x1, y, zf, d = 1.1) {
    kit.boxMin(mats.concreteDark, x0, y - 0.18, zf, x1 - x0, 0.18, d);
    railing(x0, x1, y, zf + d, 1.0);
    kit.boxMin(mats.pole, x0, y, zf, 0.04, 1.0, d);
    kit.boxMin(mats.pole, x1 - 0.04, y, zf, 0.04, 1.0, d);
    // clutter: plants and laundry
    for (let x = x0 + 0.4; x < x1 - 0.3; x += rng.float(0.6, 1.4)) {
      if (rng.chance(0.5)) {
        const s = rng.float(0.5, 0.9);
        kit.box(mats.woodRed, x, y + 0.15, zf + 0.5, 0.3, 0.3, 0.3);
        kit.quad(rng.chance(0.5) ? mats.leaves : mats.leavesDark, x, y + 0.3 + s * 0.4, zf + 0.55, s * 1.1, s, { cast: true });
      }
    }
    if (rng.chance(0.6)) {
      const a = new THREE.Vector3(x0 + 0.1, y + 1.7, zf + 0.6);
      const b = new THREE.Vector3(x1 - 0.1, y + 1.7, zf + 0.6);
      kit.tube(mats.cable, catenary(a, b, 0.15, 10), 0.01, { cast: false });
      for (let x = x0 + 0.4; x < x1 - 0.4; x += rng.float(0.35, 0.7)) {
        const c = rng.pick([0xc9c2b2, 0x7a2e2e, 0x2e4a7a, 0xd9b44a, 0x3a6a4a, 0xe0e0e0]);
        const h = rng.float(0.35, 0.8);
        kit.box(clothMat(c), x, y + 1.62 - h / 2, zf + 0.6, rng.float(0.25, 0.45), h, 0.02);
      }
    }
  }

  const clothCache = new Map();
  function clothMat(c) {
    if (!clothCache.has(c)) clothCache.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, side: THREE.DoubleSide }));
    return clothCache.get(c);
  }

  function lantern(x, y, z, color = 0xe0402a, k = 3.5, light = true) {
    const img = T.lantern(rng.int(0, 999), { color });
    const mat = mats.emissiveTex(img, k, { alphaTest: 0.5, side: THREE.DoubleSide });
    const g = new THREE.CylinderGeometry(0.22, 0.22, 0.42, 8, 1, false);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    scene.add(m);
    kit.tube(mats.cable, [new THREE.Vector3(x, y + 0.21, z), new THREE.Vector3(x, y + 0.6, z)], 0.008, { cast: false });
    const sway = rng.float(0, 6);
    animated.push({ mesh: m, fn: (t) => (m.rotation.z = Math.sin(t * 0.9 + sway) * 0.05) });
    if (light) lights.add({ position: new THREE.Vector3(x, y, z + 0.1), color, intensity: 6, range: 5, fog: 1.4 });
  }

  function stringLights(a, b, sag, n, colors, { k = 6, lightEvery = 4, intensity = 2.5 } = {}) {
    const pts = catenary(new THREE.Vector3(...a), new THREE.Vector3(...b), sag, n * 2);
    kit.tube(mats.cable, pts, 0.008, { cast: false });
    for (let i = 1; i < n; i++) {
      const p = pts[i * 2];
      const c = colors[i % colors.length];
      kit.box(mats.emissive(c, k), p.x, p.y - 0.05, p.z, 0.07, 0.09, 0.07, { cast: false });
      if (i % lightEvery === 0) lights.add({ position: p.clone().add(new THREE.Vector3(0, -0.1, 0.05)), color: c, intensity, range: 3.5, fog: 1.2, surface: i % (lightEvery * 2) === 0 });
    }
  }

  function crate(x, z, s = 0.5, y = 0) {
    const m = rng.pick([mats.wood, mats.woodRed, mats.metal]);
    kit.box(m, x, y + s / 2, z, s * rng.float(0.9, 1.3), s, s, { rot: [0, rng.float(-0.3, 0.3), 0] });
  }

  function cardboard(x, z, y = 0) {
    const w = rng.float(0.35, 0.6);
    const h = rng.float(0.25, 0.45);
    kit.box(boxMat, x, y + h / 2, z, w, h, w * 0.8, { rot: [0, rng.float(-0.6, 0.6), 0] });
  }
  const boxMat = (() => {
    const img = new PixelImage(16, 16);
    img.fill({ color: 0x8a6a44, height: 1, rough: 0.95 });
    img.rect(0, 7, 16, 2, { color: 0x6a4e30, height: 0.6 });
    img.streaks(new RNG(5), 6, { color: 0x2a1a10, alpha: 0.4 });
    img.noise(new RNG(6), 0.08);
    return T.materialFrom(img, { name: 'cardboard', tile: [1, 1] });
  })();

  function trashBag(x, z) {
    const g = new THREE.SphereGeometry(0.3, 6, 4);
    g.scale(1, 0.75, 0.9);
    kit.add(bagMat, g, { pos: [x, 0.2, z], rot: [0, rng.float(0, 3), 0] });
  }
  const bagMat = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.25, metalness: 0, flatShading: true });

  function bollard(x, z) {
    kit.cylinder(mats.pole, x, 0.45, z, 0.09, 0.9, { radial: 6 });
    kit.box(mats.emissive(0xffb45a, 2.2), x, 0.82, z + 0.05, 0.1, 0.06, 0.08, { cast: false });
  }

  // Street lamp with a pooled volumetric spot light.
  function streetLamp(x, z, { color = 0xffb066, intensity = 520, height = 5.6, reach = 1.6, angle = 0.62, side = 1 } = {}) {
    kit.box(mats.pole, x, height / 2, z, 0.14, height, 0.14);
    kit.box(mats.pole, x, 0.15, z, 0.3, 0.3, 0.3);
    kit.boxMin(mats.pole, x - 0.05, height - 0.1, z, 0.1, 0.1, reach * side);
    const hz = z + reach * side;
    kit.box(mats.pole, x, height - 0.12, hz, 0.44, 0.16, 0.6);
    kit.box(mats.emissive(color, 9), x, height - 0.22, hz, 0.36, 0.04, 0.5, { cast: false });
    const pos = new THREE.Vector3(x, height - 0.3, hz);
    lampSpots.push({ pos, target: new THREE.Vector3(x + 0.001, 0, hz + 0.3 * side), color: new THREE.Color(color), intensity, angle, penumbra: 0.6 });
    lights.add({ position: pos.clone().add(new THREE.Vector3(0, -0.15, 0)), color, intensity: 6, range: 4, fog: 1.6, surface: false });
  }

  function glassPane(x, y, z, w, h, opts = {}) {
    const mat = makeGlass(shared, opts);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(x, y, z);
    if (opts.rotY) m.rotation.y = opts.rotY;
    m.layers.set(LAYER.GLASS);
    scene.add(m);
    glassMeshes.push(m);
    // thin frame
    kit.box(mats.pole, x, y + h / 2 + 0.04, z, w + 0.1, 0.08, 0.1, { cast: false });
    kit.box(mats.pole, x, y - h / 2 - 0.04, z, w + 0.1, 0.08, 0.14, { cast: false });
    kit.box(mats.pole, x - w / 2 - 0.03, y, z, 0.06, h, 0.08, { cast: false });
    kit.box(mats.pole, x + w / 2 + 0.03, y, z, 0.06, h, 0.08, { cast: false });
    return m;
  }

  // Shop with a glass front and lit interior.
  function shopFront(x0, x1, zf, { h = 3.0, interior = mats.interior, light = 0xbfe9ff, intensity = 30, depth = 2.6, door = true, tint, frost = 0 } = {}) {
    const w = x1 - x0;
    const zb = zf - depth;
    // interior box (back wall textured, floor, ceiling, sides)
    kit.boxMin(mats.dark, x0, -0.05, zb, w, 0.05, depth, { faces: ['py'] });
    kit.boxMin(mats.concreteDark, x0, h, zb, w, 0.05, depth, { faces: ['ny'] });
    kit.box(interior, (x0 + x1) / 2, h / 2, zb + 0.01, w, h, 0.02, { faces: ['pz'], uvMode: 'fit', tile: [Math.max(1, Math.round(w / 4)), 1] });
    kit.boxMin(mats.plaster, x0, 0, zb, 0.05, h, depth, { faces: ['px'] });
    kit.boxMin(mats.plaster, x1 - 0.05, 0, zb, 0.05, h, depth, { faces: ['nx'] });
    // counter
    kit.boxMin(mats.woodRed, x0 + w * 0.15, 0, zb + depth * 0.45, w * 0.5, 1.0, 0.5);
    // ceiling light tube
    kit.box(mats.emissive(light, 6), (x0 + x1) / 2, h - 0.08, zb + depth * 0.5, w * 0.7, 0.05, 0.08, { cast: false });
    lights.add({ position: new THREE.Vector3((x0 + x1) / 2, h - 0.5, zf - 0.6), color: light, intensity, range: 9, fog: 0.9, priority: 2 });
    // glass
    const panes = Math.max(1, Math.round(w / 2.2));
    const pw = w / panes;
    for (let i = 0; i < panes; i++) {
      if (door && i === Math.floor(panes / 2)) continue;
      glassPane(x0 + pw * (i + 0.5), h * 0.48 + 0.15, zf + 0.02, pw - 0.12, h * 0.85, { tint, frost, seed: rng.float(0, 100) });
    }
    if (door) {
      const i = Math.floor(panes / 2);
      glassPane(x0 + pw * (i + 0.5), 1.15, zf + 0.02, Math.min(pw - 0.3, 1.2), 2.3, { tint, frost: 0.0, seed: rng.float(0, 100), drops: 0.5 });
    }
    kit.boxMin(mats.trim, x0, h, zf, w, 0.35, 0.12);
    return { zb };
  }

  // Building volume with an optional ground-floor opening for a shop.
  function building(mat, x0, x1, H, D, shop = null) {
    if (!shop) {
      kit.boxMin(mat, x0, 0, zf - D, x1 - x0, H, D);
      return;
    }
    const { sx0, sx1, h, depth, lowerMat, lowerH } = shop;
    const zb = zf - depth;
    kit.boxMin(mat, x0, 0, zf - D, x1 - x0, H, D - depth);
    const band = lowerMat ? Math.max(h, lowerH || h) : h;
    if (band > h) kit.boxMin(lowerMat, x0, h, zb, x1 - x0, band - h, depth);
    kit.boxMin(mat, x0, band, zb, x1 - x0, H - band, depth);
    if (sx0 > x0) kit.boxMin(lowerMat || mat, x0, 0, zb, sx0 - x0, h, depth);
    if (sx1 < x1) kit.boxMin(lowerMat || mat, sx1, 0, zb, x1 - sx1, h, depth);
  }

  // ------------------------------------------------------------------ ground
  const zBack = -40;
  kit.boxMin(mats.pavers, -90, -0.4, Z_FRONT, 180, 0.4, 1.7, { faces: ['py'], layer: LAYER.MIRROR });
  kit.boxMin(mats.cobble, -90, -0.4, Z_FRONT + 1.7, 180, 0.4, Z_CURB - Z_FRONT - 1.7, { faces: ['py'], layer: LAYER.MIRROR });
  kit.boxMin(mats.trim, -90, -0.02, Z_FRONT + 1.62, 180, 0.03, 0.12, { faces: ['py'], cast: false });
  // canal walls and water
  kit.boxMin(mats.trimLight, -90, -0.9, Z_CURB, 180, 0.95, 0.28, { faces: ['py', 'pz'] });
  kit.boxMin(mats.water, -90, -1, Z_CURB + 0.28, 180, 1 + WATER_Y, Z_QUAY - Z_CURB - 0.28, { faces: ['py'], layer: LAYER.MIRROR, cast: false, receive: true });
  kit.boxMin(mats.concreteDark, -90, -0.9, Z_QUAY - 0.25, 180, 0.95, 0.25, { faces: ['py', 'nz'] });
  kit.boxMin(mats.pavers, -90, -0.4, Z_QUAY, 180, 0.4, 8, { faces: ['py'], layer: LAYER.MIRROR });
  // deep ground for alleys / plaza
  kit.boxMin(mats.cobble, -90, -0.42, zBack, 180, 0.4, Z_FRONT - zBack, { faces: ['py'], layer: LAYER.MIRROR });

  // bollards along the curb, quay posts
  for (let x = -86; x < 86; x += 3.2) if (hash2(Math.floor(x), 1) > 0.25) bollard(x, Z_CURB - 0.25);
  for (let x = -86; x < 86; x += 7.5) {
    kit.box(mats.pole, x, 0.55, Z_QUAY + 0.25, 0.12, 1.1, 0.12);
    kit.boxMin(mats.pole, x, 1.0, Z_QUAY + 0.22, 7.5, 0.05, 0.06);
  }

  // ------------------------------------------------------------------ lots
  const zf = Z_FRONT;

  // 1) Apartment block [-66, -50]
  {
    const x0 = -66;
    const x1 = -50;
    kit.boxMin(mats.concreteDark, x0, 0, zf - 9, x1 - x0, 19, 9);
    kit.boxMin(mats.tilesCream, x0, 0, zf, x1 - x0, 3.6, 0.1, { faces: ['pz'] });
    kit.box(mats.shutter, -61, 1.45, zf + 0.12, 3.8, 2.9, 0.05, { faces: ['pz'] });
    kit.box(mats.shutterRed, -56.5, 1.45, zf + 0.12, 3.8, 2.9, 0.05, { faces: ['pz'] });
    ledge(x0, x1, 3.6, zf, 0.45, 0.3);
    windowGrid(x0 + 0.5, x1 - 0.5, 4.0, 5, 3.0, zf, { spacing: 2.2, litBias: 0.55 });
    for (let f = 0; f < 5; f++) {
      ledge(x0, x1, 3.95 + f * 3.0, zf, 0.14, 0.08, mats.trimLight);
      if (f % 2 === 0) balcony(-64.5, -60.5, 4.15 + f * 3, zf);
      acUnit(-58 + (f % 3) * 1.4, 5.3 + f * 3, zf);
    }
    pipe(-52.4, 0, 19, zf + 0.12);
    pipe(-52.0, 0, 19, zf + 0.1, 0.05);
    // vending machines
    for (let i = 0; i < 2; i++) {
      const vx = -53.4 + i * 1.05;
      kit.box(mats.metalLight, vx, 0.95, zf + 0.45, 0.95, 1.9, 0.8);
      const img = new PixelImage(16, 30, { wrap: false });
      const vr = new RNG(40 + i);
      img.fill({ color: 0xe8e8e8, emissive: i ? 0xc8f0ff : 0xffe2c4, emissiveK: 0.7 });
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++) {
          const col = vr.pick([0xe24b4b, 0x4fa3e0, 0x5ad18a, 0xf2c94c, 0xf08fd0]);
          img.rect(2 + c * 3, 3 + r * 5, 2, 4, { color: col, emissive: col, emissiveK: 0.6 });
        }
      img.rect(1, 23, 14, 5, { color: 0x222222, emissive: 0x000000 });
      sign(img, vx, 1.05, zf + 0.86, { k: 2.2, light: { color: i ? 0xbfe8ff : 0xffd9b0, intensity: 7, range: 5 }, kind: 'hum', back: false });
    }
    sign(T.glyphSign(11, 5, { color: 0xff3b5c, panel: 0x12070a, border: 0x6a1020 }), -50.6, 8.5, zf + 0.9, { k: 4, rotY: Math.PI / 2, light: { color: 0xff3b5c, intensity: 16, range: 8, offset: 0.4 }, kind: 'flicker' });
    kit.box(mats.pole, -50.6, 8.5, zf + 0.45, 0.06, 0.06, 0.9);
    trashBag(-59, zf + 0.6);
    trashBag(-58.4, zf + 0.5);
    cardboard(-57.6, zf + 0.5);
  }

  // 2) Ramen bar [-50, -38]
  {
    const x0 = -50;
    const x1 = -38;
    building(mats.woodRed, x0, x1, 8.2, 8, { sx0: x0 + 0.6, sx1: x1 - 0.6, h: 3.0, depth: 2.6 });
    kit.boxMin(mats.plasterRed, x0, 3.9, zf - 0.05, x1 - x0, 4.3, 0.06, { faces: ['pz'] });
    shopFront(x0 + 0.6, x1 - 0.6, zf, { h: 3.0, interior: mats.interiorWarm, light: 0xffb36a, intensity: 40 });
    // tiled eave roof (sloped) over the ground floor
    const roofD = 1.7;
    kit.box(mats.roofGreen, (x0 + x1) / 2, 3.65, zf + roofD / 2 - 0.1, x1 - x0 + 0.6, 0.14, roofD + 0.2, { rot: [0.32, 0, 0] });
    kit.boxMin(mats.trim, x0 - 0.3, 3.18, zf + roofD - 0.05, x1 - x0 + 0.6, 0.16, 0.12);
    for (let x = x0 + 0.2; x < x1; x += 2.3) kit.box(mats.woodRed, x, 1.6, zf + roofD - 0.2, 0.14, 3.2, 0.14);
    // sign board on the eave
    sign(T.neonSign('RAMEN', { color: 0xffb347, panel: 0x1a0d08, scale: 2, pad: 4, border: 0x7a2a10 }), -44, 4.6, zf + 0.12, { k: 4.5, light: { color: 0xffa040, intensity: 22, range: 9 }, kind: 'hum' });
    sign(T.glyphSign(21, 3, { color: 0xff6040, panel: 0x0f0806, vertical: false }), -40.2, 2.75, zf + roofD - 0.08, { k: 3.5, kind: 'hum' });
    // lanterns under the eave
    lantern(-48.2, 2.75, zf + 1.3, 0xe0402a);
    lantern(-45.6, 2.8, zf + 1.3, 0xe0402a);
    lantern(-42.5, 2.75, zf + 1.3, 0xe8a03a);
    stringLights([x0, 3.35, zf + roofD + 0.05], [x1, 3.35, zf + roofD + 0.05], 0.18, 14, [0xffc068, 0xff8048, 0x8affc8], { k: 7, lightEvery: 3 });
    // noren curtain strips over the door
    for (let i = 0; i < 5; i++) kit.box(clothMat(i % 2 ? 0x2a3a6a : 0x22305a), -44.4 + i * 0.22, 2.55, zf + 0.12, 0.2, 0.7, 0.02, { cast: false });
    // upper floor: balcony + windows
    windowGrid(x0 + 0.5, x1 - 0.5, 4.3, 1, 3.2, zf, { spacing: 2.4, litBias: 0.85 });
    balcony(x0 + 0.5, x0 + 6, 4.1, zf);
    kit.box(mats.roofDark, (x0 + x1) / 2, 8.3, zf - 3.8, x1 - x0 + 0.6, 0.25, 9, { rot: [0.0, 0, 0] });
    acUnit(-40, 7.3, zf);
    // stools outside & steam
    for (let i = 0; i < 3; i++) {
      kit.cylinder(mats.woodRed, -48.4 + i * 0.8, 0.62, zf + 0.6, 0.18, 0.08, { radial: 8 });
      kit.cylinder(mats.pole, -48.4 + i * 0.8, 0.3, zf + 0.6, 0.04, 0.6, { radial: 4 });
    }
    pipeline.addVolume(new THREE.Vector3(-39.5, 3.8, zf + 0.6), new THREE.Vector3(0.9, 2.6, 0.9), 0.55, 0.35);
    kit.box(mats.metal, -39.5, 3.2, zf + 0.3, 0.4, 0.3, 0.5);
  }

  // 3) Alley [-38, -30]
  {
    const ax0 = -38;
    const ax1 = -30;
    // side walls
    kit.boxMin(mats.brickDark, ax0 - 0.4, 0, -30, 0.4, 12, 30 + zf - 8);
    kit.boxMin(mats.plaster, ax1, 0, -30, 0.4, 14, 30 + zf - 8);
    kit.boxMin(mats.brick, ax0 - 0.4, 0, zf - 8, 0.4, 8.2, 8, { faces: ['px'] });
    kit.boxMin(mats.concrete, ax1, 0, zf - 9, 0.4, 11, 9, { faces: ['nx'] });
    // back of alley: stairs + lit door
    kit.boxMin(mats.concreteDark, ax0, 0, -32, ax1 - ax0, 16, 2);
    for (let s = 0; s < 10; s++) kit.boxMin(mats.concrete, ax0 + 0.5, 0, -24 - s * 0.32, 2.4, 0.22 * (s + 1), 0.32);
    kit.boxMin(mats.concrete, ax0 + 0.5, 0, -30, 2.4, 2.2, 3);
    kit.box(mats.emissive(0xffd29a, 3.5), -33.5, 1.1, -29.98, 1.0, 2.0, 0.02, { cast: false });
    lights.add({ position: new THREE.Vector3(-33.5, 1.4, -28.8), color: 0xffc27a, intensity: 18, range: 8, fog: 1.4 });
    // fence (grille) mid alley
    kit.box(mats.grille, -34, 1.2, -16, ax1 - ax0, 2.4, 0.02, { uvMode: 'world', tile: [1, 1] });
    for (let x = ax0; x <= ax1; x += 2) kit.box(mats.pole, x, 1.25, -16, 0.06, 2.5, 0.06);
    // clutter
    for (let i = 0; i < 6; i++) crate(rng.float(ax0 + 0.6, ax1 - 0.6), rng.float(-14, -7), rng.float(0.4, 0.7));
    kit.boxMin(mats.metal, ax1 - 2.2, 0, -12, 1.8, 1.3, 1.1);
    trashBag(ax1 - 2.6, -10.5);
    trashBag(ax1 - 1.4, -10.2);
    // cables criss-crossing the alley
    for (let i = 0; i < 7; i++) {
      const z = -6 - i * 3.2;
      const a = new THREE.Vector3(ax0, 6 + rng.float(0, 4), z + rng.float(-1, 1));
      const b = new THREE.Vector3(ax1, 6 + rng.float(0, 4), z + rng.float(-1, 1));
      kit.tube(mats.cable, catenary(a, b, rng.float(0.3, 0.9), 12), 0.018, { cast: true });
    }
    stringLights([ax0, 5.2, -9], [ax1, 5.4, -11], 0.5, 12, [0xff4a6a, 0x5ae0ff, 0xffd060], { k: 6, lightEvery: 4 });
    // windows on alley walls
    for (let f = 0; f < 3; f++)
      for (let i = 0; i < 4; i++) {
        const z = -10 - i * 4;
        if (rng.chance(0.7)) kit.quad(mats.windows, ax1 - 0.01, 3.5 + f * 3, z, 1, 1.5, { uvRect: [rng.int(0, 7) / 8, 0, (rng.int(0, 7) + 1) / 8, 1], rot: [0, -Math.PI / 2, 0] });
      }
    sign(T.neonSign('BAR', { color: 0x5affd2, panel: 0x061210, border: 0x1a6050, pad: 3, scale: 2 }), ax1 - 0.05, 4.2, -12, { k: 4, rotY: -Math.PI / 2, light: { color: 0x40ffc8, intensity: 18, range: 8 }, kind: 'broken' });
    pipeline.addVolume(new THREE.Vector3(-34, 0.8, -13), new THREE.Vector3(4, 1.4, 6), 0.25, 0.08);
  }

  // 4) UMI fish market [-30, -16]
  {
    const x0 = -30;
    const x1 = -16;
    building(mats.plasterBlue, x0, x1, 11.5, 9, { sx0: x0 + 0.8, sx1: x1 - 0.8, h: 3.0, depth: 2.6, lowerMat: mats.tilesBlue, lowerH: 3.7 });
    const { zb } = shopFront(x0 + 0.8, x1 - 0.8, zf, { h: 3.0, interior: mats.interior, light: 0x7fe8ff, intensity: 42, tint: 0xc8f4ff });
    // aquarium tanks inside (glowing cyan water + fish)
    const tankMat = mats.emissive(0x2fb8d0, 1.2);
    for (let i = 0; i < 3; i++) {
      const tx = x0 + 2.4 + i * 3.6;
      kit.box(mats.metal, tx, 0.45, zb + 0.9, 2.6, 0.9, 1.0);
      kit.box(tankMat, tx, 1.35, zb + 0.6, 2.4, 0.9, 0.02, { cast: false });
      glassPane(tx, 1.35, zb + 1.2, 2.4, 0.9, { tint: 0x9ff0ff, drops: 0, frost: 0.4, refl: 0x0a2a3a, dirt: 0.1 });
    }
    // hanging water bags (glowing)
    for (let i = 0; i < 6; i++) kit.box(mats.emissive(0xbfefff, 2.5), x0 + 6.5 + i * 0.5, 2.3, zf + 0.5, 0.18, 0.3, 0.14, { cast: false });
    // striped awning
    kit.box(mats.awningBlue, (x0 + x1) / 2, 3.45, zf + 0.9, x1 - x0 - 0.6, 0.04, 1.9, { rot: [0.38, 0, 0], uvMode: 'world', tile: [2, 2] });
    kit.boxMin(mats.pole, x0 + 0.3, 3.0, zf + 1.68, x1 - x0 - 0.6, 0.05, 0.05);
    sign(T.neonSign('UMI', { color: 0x5ee8ff, alpha: true, scale: 3, pad: 1 }), -27.2, 4.7, zf + 0.15, { k: 6, light: { color: 0x3ad8ff, intensity: 30, range: 10 }, kind: 'hum' });
    sign(T.neonSign('FISH', { color: 0xbff6ff, alpha: true, scale: 2, pad: 1 }), -22.8, 4.6, zf + 0.15, { k: 4.5, light: { color: 0x9fe8ff, intensity: 10, range: 6 }, kind: 'flicker' });
    sign(T.neonSign('06-12', { color: 0x7dff9a, panel: 0x061008, border: 0x2a6a3a }), -18.4, 2.6, zf + 0.2, { k: 3, kind: 'hum' });
    ledge(x0, x1, 3.7, zf, 0.3, 0.25);
    windowGrid(x0 + 0.5, x1 - 0.5, 4.6, 2, 3.2, zf, { spacing: 2.3, litBias: 0.65 });
    acUnit(-25, 6.0, zf);
    acUnit(-20.5, 9.1, zf);
    pipe(-16.4, 0, 11.5, zf + 0.1);
    kit.boxMin(mats.roofDark, x0 - 0.2, 11.5, zf - 9, x1 - x0 + 0.4, 0.3, 9.4);
    // crates of ice / fish on the sidewalk
    for (let i = 0; i < 4; i++) {
      kit.box(mats.metalLight, -28 + i * 0.9, 0.35, zf + 0.7, 0.8, 0.7, 0.6);
      kit.box(mats.emissive(0xdff6ff, 0.6), -28 + i * 0.9, 0.72, zf + 0.7, 0.7, 0.04, 0.5, { cast: false });
    }
    // rooftop water tank
    kit.cylinder(mats.corrugatedRust, -18.5, 13.2, zf - 4, 1.1, 3.0, { radial: 10 });
  }

  // 5) Plaza / canal view [-16, -2]
  {
    const x0 = -16;
    const x1 = -2;
    kit.boxMin(mats.concrete, x0, 0, -9.0, x1 - x0, 0.9, 0.4);
    railing(x0, x1, 0.9, -8.9, 0.9);
    // stepped terrace down to the far canal (background water)
    kit.boxMin(mats.water, -90, -1.2, -38, 180, 0.4, 28.6, { faces: ['py'], layer: LAYER.MIRROR, cast: false });
    // big tree
    const tx = -11.5;
    const tz = -6.6;
    kit.cylinder(mats.wood, tx, 2.4, tz, 0.32, 4.8, { radial: 7, rTop: 0.22 });
    kit.box(mats.wood, tx + 0.9, 4.4, tz, 1.8, 0.2, 0.2, { rot: [0, 0, 0.6] });
    kit.box(mats.wood, tx - 0.8, 4.8, tz, 1.6, 0.18, 0.18, { rot: [0, 0, -0.7] });
    for (let i = 0; i < 26; i++) {
      const a = rng.float(0, Math.PI * 2);
      const r = rng.float(0, 2.6);
      const s = rng.float(1.6, 2.8);
      kit.quad(rng.chance(0.6) ? mats.leaves : mats.leavesDark, tx + Math.cos(a) * r, 5.6 + Math.sin(a) * r * 0.55 + rng.float(-0.3, 0.6), tz + rng.float(-1.2, 1.2), s, s, { rot: [0, rng.float(-0.5, 0.5), 0] });
    }
    kit.boxMin(mats.trimLight, tx - 1.2, 0, tz - 1.2, 2.4, 0.45, 2.4);
    // bench + lamp + coffee kiosk
    kit.boxMin(mats.wood, -7.6, 0.45, -6.4, 2.2, 0.08, 0.5);
    kit.boxMin(mats.wood, -7.6, 0.5, -6.62, 2.2, 0.5, 0.06);
    kit.boxMin(mats.pole, -7.5, 0, -6.4, 0.06, 0.45, 0.5);
    kit.boxMin(mats.pole, -5.5, 0, -6.4, 0.06, 0.45, 0.5);
    // kiosk
    kit.boxMin(mats.tilesCream, -4.9, 0, -7.6, 2.6, 2.3, 2);
    kit.box(mats.roofGreen, -3.6, 2.55, -6.4, 3.2, 0.12, 2.6, { rot: [0.25, 0, 0] });
    kit.box(mats.emissive(0xffe0b0, 2.6), -3.6, 1.25, -5.59, 2.0, 0.9, 0.02, { cast: false });
    sign(T.neonSign('COFFEE', { color: 0x9dff6a, panel: 0x0a1406, border: 0x3a7a2a }), -3.6, 2.05, -5.5, { k: 3.5, light: { color: 0x9dff6a, intensity: 10, range: 6 }, kind: 'hum' });
    lights.add({ position: new THREE.Vector3(-3.6, 1.6, -5.0), color: 0xffd8a0, intensity: 10, range: 6 });
    stringLights([-14, 4.6, -6.2], [-4.6, 3.0, -6.0], 0.6, 12, [0xffd27a, 0xfff0c0], { k: 7, lightEvery: 3 });
  }

  // 6) Hotel [-2, 12]
  {
    const x0 = -2;
    const x1 = 12;
    building(mats.tilesPink, x0, x1, 15.5, 10, { sx0: x0 + 3.5, sx1: x1 - 3.5, h: 2.9, depth: 2.6, lowerMat: mats.concreteDark, lowerH: 3.4 });
    kit.boxMin(mats.concreteDark, x0, 0, zf, x1 - x0, 0.25, 0.4);
    shopFront(x0 + 3.5, x1 - 3.5, zf, { h: 2.9, interior: mats.interiorPink, light: 0xff9ad8, intensity: 34, tint: 0xffd8ef });
    // entrance canopy with neon edge
    kit.boxMin(mats.metal, x0 + 3, 3.05, zf, x1 - x0 - 6, 0.16, 2.2);
    neonTube([[x0 + 3, 3.02, zf + 2.2], [x1 - 3, 3.02, zf + 2.2]], 0xff4fd8, 6, 0.03, { pos: [5, 2.8, zf + 2.4], intensity: 14, range: 7 });
    sign(T.neonSign('HOTEL', { color: 0xff5ad8, alpha: true, scale: 2, pad: 1 }), 5, 3.65, zf + 2.0, { k: 5, kind: 'hum', light: { color: 0xff4fd0, intensity: 16, range: 8 } });
    // vertical glyph sign
    sign(T.glyphSign(61, 5, { color: 0xff6ae0, panel: 0x14061a, border: 0x6a1a5a, pad: 3 }), x1 - 1.0, 9.0, zf + 0.25, { k: 4.5, scale: 1.6, light: { color: 0xff50d8, intensity: 26, range: 10 }, kind: 'flicker' });
    windowGrid(x0 + 0.6, x1 - 2.6, 4.2, 3, 3.6, zf, { spacing: 2.2, litBias: 0.7, inset: 0.2 });
    for (let f = 0; f < 3; f++) {
      kit.boxMin(mats.concreteDark, x0, 4.0 + f * 3.6, zf, x1 - x0 - 2, 0.12, 0.6);
      neonTube([[x0 + 0.2, 4.02 + f * 3.6, zf + 0.62], [x1 - 2.2, 4.02 + f * 3.6, zf + 0.62]], f % 2 ? 0x5ae0ff : 0xff5ad8, 3, 0.02);
    }
    // potted plants
    for (const px of [x0 + 3.2, x1 - 3.2]) {
      kit.box(mats.trimLight, px, 0.35, zf + 0.6, 0.6, 0.7, 0.6);
      kit.quad(mats.leaves, px, 1.2, zf + 0.62, 1.3, 1.3);
    }
  }

  // 7) Taxi stand [12, 24]
  {
    const x0 = 12;
    const x1 = 24;
    kit.boxMin(mats.corrugated, x0, 0, zf - 8, x1 - x0, 5.2, 8);
    kit.boxMin(mats.corrugatedRust, x0, 5.2, zf - 8, 5, 3.5, 6);
    kit.box(mats.shutter, 18, 1.5, zf + 0.06, 5, 3, 0.04, { faces: ['pz'] });
    // canopy shelter on the sidewalk
    kit.boxMin(mats.metal, 13, 2.9, zf + 0.2, 9, 0.12, 2.0);
    kit.box(mats.emissive(0xe8f6ff, 5), 17.5, 2.86, zf + 1.6, 8, 0.03, 0.08, { cast: false });
    lights.add({ position: new THREE.Vector3(17.5, 2.6, zf + 1.6), color: 0xd8f0ff, intensity: 16, range: 6, fog: 1.2 });
    for (const px of [13.2, 21.8]) kit.box(mats.pole, px, 1.45, zf + 2.0, 0.08, 2.9, 0.08);
    kit.boxMin(mats.wood, 14, 0.45, zf + 0.5, 3, 0.08, 0.5);
    glassPane(17.5, 1.5, zf + 0.25, 2.2, 1.8, { drops: 1, tint: 0xe6f6ff, refl: 0x14202a });
    sign(T.neonSign('TAXI', { color: 0xffd23a, panel: 0x141004, border: 0x6a5410, pad: 2 }), 22.6, 4.2, zf + 2.0, { k: 5, rotY: 0, light: { color: 0xffc830, intensity: 18, range: 8 }, kind: 'hum' });
    kit.box(mats.pole, 22.6, 1.8, zf + 2.0, 0.1, 3.6, 0.1);
    // ticket machine
    kit.box(mats.metalLight, 20.5, 0.75, zf + 0.5, 0.6, 1.5, 0.45);
    kit.box(mats.emissive(0x6affb0, 2.5), 20.5, 1.1, zf + 0.73, 0.4, 0.3, 0.02, { cast: false });
    cardboard(15.5, zf + 0.4);
    cardboard(16.1, zf + 0.5);
  }

  // 8) Arcade [24, 38]
  {
    const x0 = 24;
    const x1 = 38;
    building(mats.brick, x0, x1, 12.5, 9, { sx0: x0 + 0.5, sx1: x1 - 0.5, h: 3.2, depth: 3 });
    kit.boxMin(mats.plasterRed, x0 + 0.5, 0, zf - 3, x1 - x0 - 1, 3.2, 0.02, { faces: ['pz'] });
    kit.boxMin(mats.dark, x0 + 0.5, -0.02, zf - 3, x1 - x0 - 1, 0.02, 3, { faces: ['py'] });
    kit.boxMin(mats.concreteDark, x0 + 0.5, 3.2, zf - 3, x1 - x0 - 1, 0.02, 3, { faces: ['ny'] });
    for (let x = x0 + 1.5; x < x1 - 1; x += 2.5) kit.box(mats.emissive(0xff7ad8, 4), x, 3.15, zf - 1.5, 1.4, 0.04, 0.08, { cast: false });
    // rows of arcade cabinets with glowing screens
    for (let i = 0; i < 9; i++) {
      const cx = x0 + 1.4 + i * 1.3;
      kit.box(mats.metal, cx, 0.9, zf - 2.2, 0.9, 1.8, 0.8);
      const c = rng.pick([0xff4a8a, 0x4ad8ff, 0x8aff5a, 0xffc84a, 0xb07aff]);
      kit.box(mats.emissive(c, 3.2), cx, 1.35, zf - 1.79, 0.6, 0.45, 0.02, { cast: false });
      if (i % 2 === 0) lights.add({ position: new THREE.Vector3(cx, 1.4, zf - 1.2), color: c, intensity: 8, range: 4.5, fog: 0.8 });
    }
    sign(T.neonSign('ARCADE', { color: 0xff4fa0, panel: 0x14060c, border: 0x7a1a4a, scale: 2, pad: 3 }), 31, 4.1, zf + 0.15, { k: 5, light: { color: 0xff3f9a, intensity: 26, range: 10 }, kind: 'flicker' });
    // marquee lights around the entrance
    for (let x = x0 + 0.6; x < x1 - 0.5; x += 0.35) kit.box(mats.emissive(0xffd090, 5), x, 3.35, zf + 0.06, 0.08, 0.08, 0.06, { cast: false });
    kit.boxMin(mats.trim, x0, 3.2, zf, x1 - x0, 0.3, 0.2);
    windowGrid(x0 + 0.5, x1 - 0.5, 4.4, 2, 3.4, zf, { spacing: 2.0, litBias: 0.5 });
    // billboard (animated hologram)
    const adImg = new PixelImage(64 * 4, 32, { wrap: false, transparent: true });
    const adR = new RNG(77);
    for (let f = 0; f < 4; f++) {
      const ox = f * 64;
      adImg.rect(ox + 1, 1, 62, 30, { color: [0x14324a, 0x3a1440, 0x14402a, 0x402a14][f] });
      const c = [0x5ae0ff, 0xff5ad8, 0x8aff6a, 0xffc04a][f];
      drawBillboard(adImg, ox, c, adR);
    }
    const adTex = adImg.toTextures({ name: 'ad' }).map;
    const ad = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), makeHolo(shared, adTex, { frames: 4, fps: 0.4, intensity: 2.6, flicker: 0.3, seed: 3 }));
    ad.position.set(31, 9.2, zf + 0.3);
    ad.layers.set(LAYER.GLOW);
    scene.add(ad);
    kit.box(mats.metal, 31, 9.2, zf + 0.15, 6.3, 3.3, 0.2);
    lights.add({ position: new THREE.Vector3(31, 9, zf + 1.5), color: 0x8ac8ff, intensity: 20, range: 9, fog: 1 });
  }

  // 9) Laundromat 24H [38, 52]
  {
    const x0 = 38;
    const x1 = 52;
    building(mats.tilesCream, x0, x1, 9.5, 9, { sx0: x0 + 0.7, sx1: x1 - 0.7, h: 3.0, depth: 2.6 });
    const { zb } = shopFront(x0 + 0.7, x1 - 0.7, zf, { h: 3.0, interior: mats.interior, light: 0xe6fff6, intensity: 36, frost: 0.15 });
    for (let i = 0; i < 6; i++) {
      const wx = x0 + 1.8 + i * 1.8;
      kit.box(mats.metalLight, wx, 0.6, zb + 0.6, 1.0, 1.2, 0.9);
      kit.cylinder(mats.emissive(0x9ae6ff, 1.2), wx, 0.65, zb + 1.06, 0.3, 0.03, { rot: [Math.PI / 2, 0, 0], radial: 10 });
    }
    sign(T.neonSign('24H', { color: 0x6aff8a, panel: 0x041008, border: 0x2a8a4a, scale: 2, pad: 2 }), 49.5, 4.3, zf + 0.15, { k: 5, light: { color: 0x5aff7a, intensity: 18, range: 8 }, kind: 'broken' });
    sign(T.neonSign('LAUNDRY', { color: 0xdffcff, alpha: true }), 43, 3.9, zf + 0.15, { k: 3.5, kind: 'hum' });
    ledge(x0, x1, 3.3, zf, 0.25, 0.2);
    windowGrid(x0 + 0.5, x1 - 0.5, 4.0, 2, 2.9, zf, { spacing: 2.0, litBias: 0.6 });
    acUnit(41, 5.4, zf);
    acUnit(46, 8.3, zf);
  }

  // 10) Old brick block with fire escape [52, 68]
  {
    const x0 = 52;
    const x1 = 68;
    kit.boxMin(mats.brickDark, x0, 0, zf - 9, x1 - x0, 21, 9);
    kit.box(mats.shutter, 56, 1.5, zf + 0.06, 4, 3, 0.04, { faces: ['pz'] });
    windowGrid(x0 + 0.5, x1 - 0.5, 3.6, 5, 3.4, zf, { spacing: 2.4, litBias: 0.4, inset: 0.15 });
    // fire escape
    for (let f = 0; f < 5; f++) {
      const y = 3.2 + f * 3.4;
      kit.boxMin(mats.grille, 58.5, y, zf, 5, 0.04, 1.2, { tile: [1, 1] });
      kit.boxMin(mats.pole, 58.5, y - 0.06, zf, 5, 0.06, 1.2, { faces: ['pz', 'ny'] });
      railing(58.5, 63.5, y, zf + 1.2, 0.9, mats.pole, 0.3);
      kit.box(mats.pole, f % 2 ? 59.8 : 62.2, y + 1.7, zf + 0.6, 3.4, 0.05, 0.6, { rot: [0, 0, f % 2 ? -0.75 : 0.75] });
    }
    sign(T.glyphSign(91, 4, { color: 0x4affb0, panel: 0x041a10, border: 0x1a5a3a }), 54, 7.2, zf + 0.15, { k: 4, light: { color: 0x3aff9a, intensity: 14, range: 7 }, kind: 'broken' });
    // ivy
    for (let i = 0; i < 8; i++) kit.quad(mats.vines, 64.5 + rng.float(-1, 3), rng.float(2, 9), zf + 0.05, 2, 4, {});
  }

  // ------------------------------------------------------------------ street furniture
  for (const [x, side] of [
    [-57, 1],
    [-41, 1],
    [-21, 1],
    [-7, 1],
    [8, 1],
    [26, 1],
    [44, 1],
    [60, 1],
  ])
    streetLamp(x, Z_FRONT + 0.4, { side });
  // foreground quay lamps (strongly blurred)
  for (const x of [-48, -14, 18, 50]) {
    kit.box(mats.pole, x, 2.4, Z_QUAY + 1.4, 0.16, 4.8, 0.16);
    kit.box(mats.emissive(0xffe2b0, 7), x, 4.85, Z_QUAY + 1.4, 0.34, 0.3, 0.34, { cast: false });
    lights.add({ position: new THREE.Vector3(x, 4.7, Z_QUAY + 1.4), color: 0xffd09a, intensity: 30, range: 9, fog: 1.2 });
  }
  // foreground plants on the quay
  for (const x of [-61, -26, 12, 41]) {
    for (let i = 0; i < 3; i++) kit.quad(mats.leavesDark, x + rng.float(-0.6, 0.6), rng.float(0.35, 0.7), Z_QUAY + 0.7 + rng.float(0, 0.4), rng.float(0.9, 1.4), rng.float(0.8, 1.1), { rot: [0, rng.float(-0.4, 0.4), 0] });
  }
  // cables spanning the street: facade -> quay poles and along the block
  for (let x = -64; x < 66; x += rng.float(7, 13)) {
    const a = new THREE.Vector3(x, rng.float(7.5, 9.5), Z_FRONT + 0.2);
    const b = new THREE.Vector3(x + rng.float(-6, 6), rng.float(6.5, 8.5), Z_QUAY + 6);
    kit.tube(mats.cable, catenary(a, b, rng.float(0.5, 1.4), 14), 0.02, { cast: true });
    const c = new THREE.Vector3(x + rng.float(8, 14), rng.float(7, 10), Z_FRONT + 0.3);
    kit.tube(mats.cable, catenary(a, c, rng.float(0.4, 1.0), 14), 0.016, { cast: true });
  }
  // litter
  for (let i = 0; i < 40; i++) {
    const x = rng.float(-64, 66);
    const z = rng.float(Z_FRONT + 0.3, Z_CURB - 0.5);
    if (rng.chance(0.5)) cardboard(x, z);
    else kit.box(mats.emissive(rng.pick([0xffffff, 0xff6a6a, 0x6affd0]), 0.0), x, 0.01, z, 0.12, 0.01, 0.08, { cast: false });
  }
  for (let i = 0; i < 10; i++) trashBag(rng.float(-64, 66), Z_FRONT + 0.4);

  // ------------------------------------------------------------------ boats on the canal
  for (const [bx, bz] of [
    [-36, 5.4],
    [22, 6.1],
  ]) {
    kit.box(mats.wood, bx, WATER_Y + 0.15, bz, 4.4, 0.4, 1.4);
    kit.box(mats.woodRed, bx, WATER_Y + 0.38, bz, 4.6, 0.08, 1.5);
    kit.box(mats.metal, bx - 0.8, WATER_Y + 0.8, bz, 1.4, 0.8, 1.0);
    lantern(bx + 1.4, WATER_Y + 1.5, bz, 0xffa040, 3.5);
    kit.box(mats.pole, bx + 1.4, WATER_Y + 1.0, bz, 0.05, 1.4, 0.05);
  }

  return { updaters, lampSpots, glassMeshes, animated, signMats };
}

function drawBillboard(img, ox, c, rng) {
  const sh = (k) => [((c >> 16) & 255) / 255 * k, ((c >> 8) & 255) / 255 * k, (c & 255) / 255 * k];
  const kind = Math.floor(rng.next() * 3);
  if (kind === 0) {
    img.disc(ox + 20, 16, 10, { color: sh(1), emissive: sh(1) });
    img.disc(ox + 20, 16, 6, { color: sh(0.3), emissive: sh(0.2) });
  } else if (kind === 1) {
    for (let i = 0; i < 6; i++) img.rect(ox + 8 + i * 8, 26 - i * 3, 5, i * 3 + 2, { color: sh(1), emissive: sh(1) });
  } else {
    img.ellipse(ox + 22, 18, 12, 8, { color: sh(0.9), emissive: sh(0.9) });
    img.rect(ox + 14, 8, 16, 3, { color: sh(1), emissive: sh(1) });
  }
  for (let r = 0; r < 3; r++) img.rect(ox + 40, 8 + r * 6, 18 - r * 4, 3, { color: [1, 1, 1], emissive: [1, 1, 1] });
}
