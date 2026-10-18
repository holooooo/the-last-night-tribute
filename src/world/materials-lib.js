import * as THREE from 'three';
import * as T from '../core/textures.js';
import { makeWet } from '../render/materials.js';

// Builds every shared material of the street once.
export function createMaterials(shared) {
  const m = {};
  const std = (img, o = {}) => T.materialFrom(img, o);

  m.cobble = makeWet(std(T.cobble(1), { name: 'cobble', normalScale: 1.2 }), shared, { wet: 1, puddle: 0.53 });
  m.pavers = makeWet(std(T.pavers(2), { name: 'pavers' }), shared, { wet: 0.85, puddle: 0.6 });
  m.water = makeWet(
    new THREE.MeshStandardMaterial({ color: 0x0a1416, roughness: 0.05, metalness: 0.0, name: 'water' }),
    shared,
    { water: true, reflStrength: 1.0 }
  );
  m.water.userData.tile = [4, 4];

  m.brick = std(T.brick(3), { name: 'brick' });
  m.brickDark = std(T.brick(31, { base: 0x4a2c27, mortar: 0x1d1a18 }), { name: 'brickDark' });
  m.concrete = std(T.concrete(4), { name: 'concrete' });
  m.concreteDark = std(T.concrete(41, { base: 0x3a4148 }), { name: 'concreteDark' });
  m.concreteWarm = std(T.concrete(42, { base: 0x6b5f55 }), { name: 'concreteWarm' });
  m.tilesTeal = std(T.tiles(5), { name: 'tilesTeal', normalScale: 0.5 });
  m.tilesCream = std(T.tiles(51, { base: 0xb7ad94, grout: 0x3a3630 }), { name: 'tilesCream', normalScale: 0.5 });
  m.tilesPink = std(T.tiles(52, { base: 0xa3647a, grout: 0x2e2228, size: 6 }), { name: 'tilesPink', normalScale: 0.5 });
  m.tilesBlue = std(T.tiles(53, { base: 0x2e5b86, grout: 0x141c26, size: 4, vary: 0.2 }), { name: 'tilesBlue', normalScale: 0.5 });
  m.shutter = std(T.shutter(6), { name: 'shutter', tile: [4, 3] });
  m.shutterRed = std(T.shutter(61, { base: 0x7a3a34 }), { name: 'shutterRed', tile: [4, 3] });
  m.corrugated = std(T.corrugated(7), { name: 'corrugated' });
  m.corrugatedRust = std(T.corrugated(71, { base: 0x6a4a36 }), { name: 'corrugatedRust' });
  m.wood = std(T.wood(8), { name: 'wood' });
  m.woodRed = std(T.wood(81, { base: 0x6e2a22 }), { name: 'woodRed' });
  m.roofGreen = std(T.roofTiles(9), { name: 'roofGreen' });
  m.roofDark = std(T.roofTiles(91, { base: 0x2f3d4a }), { name: 'roofDark' });
  m.awningBlue = std(T.awning(10), { name: 'awningBlue', alphaTest: 0.5, side: THREE.DoubleSide, tile: [2, 2] });
  m.awningRed = std(T.awning(101, { a: 0xa8332f, b: 0xe2d9c6 }), { name: 'awningRed', alphaTest: 0.5, side: THREE.DoubleSide, tile: [2, 2] });
  m.awningGreen = std(T.awning(102, { a: 0x2f7a52, b: 0xd9d8c0, stripe: 3 }), { name: 'awningGreen', alphaTest: 0.5, side: THREE.DoubleSide, tile: [2, 2] });
  m.metal = std(T.metal(11), { name: 'metal' });
  m.metalLight = std(T.metal(111, { base: 0x6a747a }), { name: 'metalLight' });
  m.grille = std(T.grille(12), { name: 'grille', alphaTest: 0.5, side: THREE.DoubleSide });
  m.ac = std(T.acUnit(13), { name: 'ac', tile: [1.5, 1] });
  m.plaster = std(T.plaster(21), { name: 'plaster' });
  m.plasterBlue = std(T.plaster(211, { base: 0x3c5566 }), { name: 'plasterBlue' });
  m.plasterRed = std(T.plaster(212, { base: 0x6e3a36 }), { name: 'plasterRed' });
  m.trim = std(T.trim(22), { name: 'trim', tile: [1, 1] });
  m.trimLight = std(T.trim(221, { base: 0x6f767a }), { name: 'trimLight', tile: [1, 1] });

  m.windows = std(T.windowAtlas(14), { name: 'windows', emissiveIntensity: 2.2 });
  m.windows.userData.cells = 8;
  m.interior = std(T.interior(18), { name: 'interior', emissiveIntensity: 2.5 });
  m.interiorWarm = std(T.interior(181, { wall: 0x5a3426, light: 0xffc98a }), { name: 'interiorWarm', emissiveIntensity: 2.5 });
  m.interiorPink = std(T.interior(182, { wall: 0x4a2440, light: 0xff9ad8 }), { name: 'interiorPink', emissiveIntensity: 2.5 });

  m.leaves = std(T.leaves(16), { name: 'leaves', alphaTest: 0.5, side: THREE.DoubleSide });
  m.leavesDark = std(T.leaves(161, { greens: [0x18341f, 0x214a26, 0x2e6430, 0x3f7a35] }), { name: 'leavesDark', alphaTest: 0.5, side: THREE.DoubleSide });
  m.vines = std(T.vines(17), { name: 'vines', alphaTest: 0.5, side: THREE.DoubleSide });

  m.taxiPaint = std(T.metal(113, { base: 0xd9a21e }), { name: 'taxiPaint' });

  m.dark = new THREE.MeshStandardMaterial({ color: 0x0c0f12, roughness: 0.8, name: 'dark' });
  m.cable = new THREE.MeshStandardMaterial({ color: 0x07090b, roughness: 0.6, name: 'cable' });
  m.pole = std(T.metal(112, { base: 0x262c31 }), { name: 'pole' });

  // pure emissive helpers (HDR colours)
  m.emissive = (color, k = 4) => {
    const c = new THREE.Color(color).multiplyScalar(k);
    return new THREE.MeshBasicMaterial({ color: c, name: 'emis', toneMapped: false });
  };
  m.emissiveTex = (img, k = 3, opts = {}) => {
    const t = img.toTextures({ name: 'sign' });
    const mat = new THREE.MeshStandardMaterial({
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.ormMap,
      emissiveMap: t.emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: k,
      roughness: 1,
      alphaTest: opts.alphaTest || 0,
      transparent: false,
      side: opts.side || THREE.FrontSide,
    });
    mat.userData.size = [img.w / T.TPM, img.h / T.TPM];
    mat.userData.baseEmissive = k;
    return mat;
  };
  return m;
}
