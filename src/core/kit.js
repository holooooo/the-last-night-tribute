import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Geometry kit: boxes / quads with world-scaled UVs (so every surface keeps the
// same chunky texel density) batched and merged per material.

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

// faces: px nx py ny pz nz
const FACE_DEFS = [
  { key: 'px', n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { key: 'nx', n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { key: 'py', n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { key: 'ny', n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { key: 'pz', n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { key: 'nz', n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

export function boxGeometry(w, h, d, { tile = 4, uv0 = [0, 0], faces = null, worldOffset = [0, 0, 0], uvMode = 'world' } = {}) {
  const pos = [];
  const nor = [];
  const uvs = [];
  const idx = [];
  const half = [w / 2, h / 2, d / 2];
  const tileU = Array.isArray(tile) ? tile[0] : tile;
  const tileV = Array.isArray(tile) ? tile[1] : tile;
  for (const f of FACE_DEFS) {
    if (faces && !faces.includes(f.key)) continue;
    const base = pos.length / 3;
    const n = f.n;
    // the two in-plane axes
    const ua = f.u;
    const va = f.v;
    const extU = Math.abs(ua[0]) * half[0] + Math.abs(ua[1]) * half[1] + Math.abs(ua[2]) * half[2];
    const extV = Math.abs(va[0]) * half[0] + Math.abs(va[1]) * half[1] + Math.abs(va[2]) * half[2];
    const extN = Math.abs(n[0]) * half[0] + Math.abs(n[1]) * half[1] + Math.abs(n[2]) * half[2];
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [cu, cv] of corners) {
      const x = n[0] * extN + ua[0] * extU * cu + va[0] * extV * cv;
      const y = n[1] * extN + ua[1] * extU * cu + va[1] * extV * cv;
      const z = n[2] * extN + ua[2] * extU * cu + va[2] * extV * cv;
      pos.push(x, y, z);
      nor.push(n[0], n[1], n[2]);
      let uu;
      let vv;
      if (uvMode === 'world') {
        const wx = x + worldOffset[0];
        const wy = y + worldOffset[1];
        const wz = z + worldOffset[2];
        uu = wx * ua[0] + wy * ua[1] + wz * ua[2];
        vv = wx * va[0] + wy * va[1] + wz * va[2];
      } else {
        // 'fit': 0..1 across the face
        uu = (cu * 0.5 + 0.5) * (uvMode === 'fit' ? tileU : 2 * extU);
        vv = (cv * 0.5 + 0.5) * (uvMode === 'fit' ? tileV : 2 * extV);
      }
      uvs.push(uvMode === 'fit' ? uu + uv0[0] : uu / tileU + uv0[0], uvMode === 'fit' ? vv + uv0[1] : vv / tileV + uv0[1]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

function normalizeGeometry(g) {
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(idx);
  }
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  return g;
}

export class Kit {
  constructor() {
    this.batches = new Map(); // material -> { geos: [], shadow: {cast, receive}, layer }
  }

  _batch(mat, opts = {}) {
    const key = mat;
    let b = this.batches.get(key);
    if (!b) {
      b = { geos: [], cast: opts.cast !== false, receive: opts.receive !== false, layer: opts.layer || 0 };
      this.batches.set(key, b);
    }
    return b;
  }

  add(mat, geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], cast, receive, layer } = {}) {
    const g = normalizeGeometry(geo);
    _e.set(rot[0], rot[1], rot[2]);
    _q.setFromEuler(_e);
    _m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s.set(scale[0], scale[1], scale[2]));
    g.applyMatrix4(_m);
    this._batch(mat, { cast, receive, layer }).geos.push(g);
    return g;
  }

  // Axis-aligned box given by min corner (x0,y0,z0) and size.
  // Texture tiling defaults to the material's tile size (meters).
  boxMin(mat, x0, y0, z0, w, h, d, opts = {}) {
    const tile = opts.tile || (mat.userData && mat.userData.tile) || 4;
    const cx = x0 + w / 2;
    const cy = y0 + h / 2;
    const cz = z0 + d / 2;
    const g = boxGeometry(w, h, d, {
      tile,
      faces: opts.faces,
      uv0: opts.uv0,
      uvMode: opts.uvMode,
      worldOffset: opts.rot ? [0, 0, 0] : [cx, cy, cz],
    });
    return this.add(mat, g, { pos: [cx, cy, cz], rot: opts.rot, cast: opts.cast, receive: opts.receive, layer: opts.layer });
  }

  // Centered box.
  box(mat, cx, cy, cz, w, h, d, opts = {}) {
    return this.boxMin(mat, cx - w / 2, cy - h / 2, cz - d / 2, w, h, d, opts);
  }

  // Quad facing +z (or rotated), UV 0..1 unless tile given.
  quad(mat, cx, cy, cz, w, h, opts = {}) {
    const g = new THREE.PlaneGeometry(w, h);
    if (opts.uvRect) {
      const [u0, v0, u1, v1] = opts.uvRect;
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
      }
    }
    return this.add(mat, g, { pos: [cx, cy, cz], rot: opts.rot, cast: opts.cast, receive: opts.receive, layer: opts.layer });
  }

  // Tube along a polyline (for cables, pipes).
  tube(mat, points, radius = 0.02, opts = {}) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => (p.isVector3 ? p : new THREE.Vector3(...p))));
    const g = new THREE.TubeGeometry(curve, opts.segments || Math.max(8, points.length * 6), radius, opts.radial || 4, false);
    return this.add(mat, g, { cast: opts.cast, receive: opts.receive, layer: opts.layer });
  }

  cylinder(mat, cx, cy, cz, r, h, opts = {}) {
    const g = new THREE.CylinderGeometry(opts.rTop === undefined ? r : opts.rTop, r, h, opts.radial || 8, 1, opts.open || false);
    return this.add(mat, g, { pos: [cx, cy, cz], rot: opts.rot, cast: opts.cast, receive: opts.receive, layer: opts.layer });
  }

  build(parent) {
    const meshes = [];
    for (const [mat, b] of this.batches) {
      if (!b.geos.length) continue;
      const merged = mergeGeometries(b.geos, false);
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.receive;
      mesh.layers.set(b.layer);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      meshes.push(mesh);
      for (const g of b.geos) g.dispose();
    }
    this.batches.clear();
    return meshes;
  }
}

// Catenary between two points (sagging cable).
export function catenary(a, b, sag = 0.5, n = 16) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= Math.sin(Math.PI * t) * sag;
    pts.push(p);
  }
  return pts;
}
