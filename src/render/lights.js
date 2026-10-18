import * as THREE from 'three';

// Virtual light pool.
//
// The street holds far more light sources than a forward renderer can afford
// per fragment. Every frame the nearest virtual lights are mapped onto a fixed
// set of physical THREE.PointLight "slots" (the shader light count never
// changes, so nothing recompiles). Fog-only lights (string lights, windows,
// distant lamps) never touch surfaces but still glow inside the volumetric fog.

export const NR = 16; // lights fed to the sprite rim-light shader
export const NRS = 4; // spot lights fed to the sprite rim-light shader

export class LightManager {
  constructor(scene, { pointSlots = 14, fogSlots = 24 } = {}) {
    this.scene = scene;
    this.virtual = [];
    this.spots = [];
    this.fogSlots = fogSlots;
    this.slots = [];
    for (let i = 0; i < pointSlots; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      scene.add(l);
      this.slots.push(l);
    }
    this.fogList = [];
    this._focus = new THREE.Vector3();
    // Shared uniforms for the sprite lighting model (see world/sprites.js).
    this.spriteUniforms = {
      uRimPos: { value: Array.from({ length: NR }, () => new THREE.Vector3()) },
      uRimCol: { value: Array.from({ length: NR }, () => new THREE.Vector4()) },
      uRimSpotPos: { value: Array.from({ length: NRS }, () => new THREE.Vector3()) },
      uRimSpotDir: { value: Array.from({ length: NRS }, () => new THREE.Vector3(0, -1, 0)) },
      uRimSpotCol: { value: Array.from({ length: NRS }, () => new THREE.Vector4()) },
      uRimSpotCone: { value: Array.from({ length: NRS }, () => new THREE.Vector2(1, 1)) },
      uFlash: { value: 0 },
      uFlashDir: { value: new THREE.Vector3(-0.8, 0.55, 0.2).normalize() },
      uFlashCol: { value: new THREE.Color(0xd8e6ff) },
      uRimStrength: { value: 2.6 },
      uFill: { value: new THREE.Color(0.1, 0.12, 0.16) },
    };
  }

  // opts: position, color, intensity (candela), range, fog (multiplier for
  // fog glow), surface (true = can light geometry), flicker (fn(t) -> k)
  add(opts) {
    const v = {
      position: opts.position.clone ? opts.position.clone() : new THREE.Vector3(...opts.position),
      color: new THREE.Color(opts.color === undefined ? 0xffffff : opts.color),
      intensity: opts.intensity === undefined ? 10 : opts.intensity,
      range: opts.range === undefined ? 10 : opts.range,
      fog: opts.fog === undefined ? 1 : opts.fog,
      surface: opts.surface !== false,
      flicker: opts.flicker || null,
      k: 1,
      enabled: true,
      priority: opts.priority || 0,
    };
    this.virtual.push(v);
    return v;
  }

  // Spot lights are real lights (shadows), registered here for the fog pass.
  addSpot(spot, { fog = 1, g = 0.35 } = {}) {
    const s = { light: spot, fog, g };
    this.spots.push(s);
    return s;
  }

  update(time, focus, camera) {
    this._focus.copy(focus);
    const f = this._focus;
    for (const v of this.virtual) v.k = v.flicker ? v.flicker(time) : 1;

    // physical surface slots: nearest to the focus point (weighted along x)
    const scoreOf = (v) => {
      const dx = v.position.x - f.x;
      const dz = (v.position.z - f.z) * 0.6;
      const dy = (v.position.y - f.y) * 0.5;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - v.range * 0.5 - v.priority;
    };
    const surf = this.virtual.filter((v) => v.surface && v.enabled && v.intensity > 0);
    surf.sort((a, b) => scoreOf(a) - scoreOf(b));
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const v = surf[i];
      if (v) {
        s.position.copy(v.position);
        s.color.copy(v.color);
        s.intensity = v.intensity * v.k;
        s.distance = v.range;
      } else {
        s.intensity = 0;
      }
    }

    // fog lights: most visible from the camera
    const fogCand = this.virtual.filter((v) => v.fog > 0 && v.enabled && v.intensity > 0);
    fogCand.sort((a, b) => scoreOf(a) - scoreOf(b));
    this.fogList = fogCand.slice(0, this.fogSlots);

    // sprite rim lights: every light counts (signs, windows, string lights...)
    const su = this.spriteUniforms;
    for (let i = 0; i < NR; i++) {
      const v = fogCand[i];
      if (!v) {
        su.uRimCol.value[i].set(0, 0, 0, 1);
        continue;
      }
      su.uRimPos.value[i].copy(v.position);
      const k = v.intensity * v.k;
      su.uRimCol.value[i].set(v.color.r * k, v.color.g * k, v.color.b * k, v.range * 1.3);
    }
    const tmp = new THREE.Vector3();
    for (let i = 0; i < NRS; i++) {
      const s = this.spots[i];
      const l = s && s.light;
      if (!l || l.intensity <= 0) {
        su.uRimSpotCol.value[i].set(0, 0, 0, 1);
        continue;
      }
      su.uRimSpotPos.value[i].copy(l.position);
      tmp.copy(l.target.position).sub(l.position).normalize();
      su.uRimSpotDir.value[i].copy(tmp);
      su.uRimSpotCol.value[i].set(l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity, l.distance || 30);
      su.uRimSpotCone.value[i].set(Math.cos(l.angle), Math.cos(l.angle * (1 - l.penumbra)));
    }
  }
}

// Tileable 3D value-gradient noise used by the volumetric fog.
export function makeNoise3D(size = 64, seed = 7) {
  const N = size;
  const data = new Uint8Array(N * N * N);
  const perm = new Uint8Array(512);
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h, x, y, z) => {
    const g = h & 15;
    const u = g < 8 ? x : y;
    const v = g < 4 ? y : g === 12 || g === 14 ? x : z;
    return ((g & 1) === 0 ? u : -u) + ((g & 2) === 0 ? v : -v);
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const noise = (x, y, z, period) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);
    const P = (a) => ((a % period) + period) % period;
    const h = (a, b, c) => perm[perm[perm[P(a)] + P(b)] + P(c)];
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(
        l(grad(h(xi, yi, zi), xf, yf, zf), grad(h(xi + 1, yi, zi), xf - 1, yf, zf), u),
        l(grad(h(xi, yi + 1, zi), xf, yf - 1, zf), grad(h(xi + 1, yi + 1, zi), xf - 1, yf - 1, zf), u),
        v
      ),
      l(
        l(grad(h(xi, yi, zi + 1), xf, yf, zf - 1), grad(h(xi + 1, yi, zi + 1), xf - 1, yf, zf - 1), u),
        l(grad(h(xi, yi + 1, zi + 1), xf, yf - 1, zf - 1), grad(h(xi + 1, yi + 1, zi + 1), xf - 1, yf - 1, zf - 1), u),
        v
      ),
      w
    );
  };
  let i = 0;
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let v = 0;
        let amp = 0.5;
        let freq = 4;
        for (let o = 0; o < 4; o++) {
          v += amp * noise((x / N) * freq, (y / N) * freq, (z / N) * freq, freq);
          amp *= 0.5;
          freq *= 2;
        }
        data[i++] = Math.max(0, Math.min(255, Math.round((v * 0.9 + 0.5) * 255)));
      }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
