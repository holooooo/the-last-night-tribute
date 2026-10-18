import * as THREE from 'three';
import { PixelImage, hex, shade } from '../core/pixel.js';
import { RNG } from '../core/rng.js';
import { NR, NRS } from '../render/lights.js';

// Sprite lighting model, injected into MeshStandardMaterial:
//  * regular PBR lighting + shadows from three (normal map = rounded volume)
//  * a rim term: every nearby light (incl. neon signs / windows that only
//    exist as fog lights) brightens the silhouette edge facing it; lights
//    behind the sprite wrap around the whole outline (backlit silhouettes)
//  * lightning: a hard directional edge light on one side of the figure
const RIM_GLSL = /* glsl */ `
uniform vec3 uRimPos[${NR}];
uniform vec4 uRimCol[${NR}];
uniform vec3 uRimSpotPos[${NRS}];
uniform vec3 uRimSpotDir[${NRS}];
uniform vec4 uRimSpotCol[${NRS}];
uniform vec2 uRimSpotCone[${NRS}];
uniform float uFlash;
uniform vec3 uFlashDir;
uniform vec3 uFlashCol;
uniform float uRimStrength;
uniform vec3 uFill;
varying vec3 vRimW;

vec3 spriteRim(vec3 Nw, vec3 P) {
  float edge = smoothstep(0.06, 0.5, 1.0 - clamp(Nw.z, 0.0, 1.0));
  if (edge <= 0.0) return vec3(0.0);
  vec2 nxy = Nw.xy / max(length(Nw.xy), 1e-4);
  vec3 rim = vec3(0.0);
  for (int i = 0; i < ${NR}; i++) {
    vec4 c = uRimCol[i];
    vec3 L = uRimPos[i] - P;
    float d2 = dot(L, L);
    if (d2 > c.w * c.w) continue;
    vec3 l = L * inversesqrt(d2);
    float w = 1.0 - d2 / (c.w * c.w);
    float att = w * w / (d2 + 0.4);
    vec2 lxy = l.xy / max(length(l.xy), 1e-4);
    float behind = clamp(-l.z, 0.0, 1.0);
    float dirm = mix(clamp(dot(nxy, lxy), 0.0, 1.0), 1.0, behind * behind);
    float side = clamp(0.35 - l.z * 0.65, 0.0, 1.0);
    rim += c.rgb * att * dirm * side;
  }
  for (int i = 0; i < ${NRS}; i++) {
    vec4 c = uRimSpotCol[i];
    vec3 L = uRimSpotPos[i] - P;
    float d2 = dot(L, L);
    if (d2 > c.w * c.w) continue;
    vec3 l = L * inversesqrt(d2);
    float cone = smoothstep(uRimSpotCone[i].x, uRimSpotCone[i].y, dot(-l, uRimSpotDir[i]));
    float w = 1.0 - d2 / (c.w * c.w);
    vec2 lxy = l.xy / max(length(l.xy), 1e-4);
    rim += c.rgb * cone * w * w / (d2 + 0.4) * clamp(dot(nxy, lxy), 0.0, 1.0) * 0.5;
  }
  vec2 fxy = normalize(uFlashDir.xy);
  float fe = pow(edge, 0.6) * clamp(dot(nxy, fxy) * 1.4 - 0.2, 0.0, 1.0);
  return rim * edge * uRimStrength + uFlashCol * uFlash * fe * 4.0;
}
`;

// Procedural pixel-art characters. A tiny 2D skeleton is posed per frame and
// rasterised limb by limb into a sprite sheet (side view, facing +x).
// The normal map comes from a blurred silhouette so the sprites read as
// rounded volumes under the dynamic street lights.

export const FW = 32; // frame size in texels (16 texels = 1 m)
export const FH = 48;
export const ANIMS = {
  walk: { start: 0, count: 8 },
  run: { start: 8, count: 8 },
  idle: { start: 16, count: 4 },
};
export const FRAME_COUNT = 20;

const SKIN = [0xe8b896, 0xc98d6a, 0x8a5a3e, 0x5e3b28, 0xf0c8a8];
const HAIR = [0x1a1412, 0x2e1e14, 0x5a3a20, 0x8a8278, 0xb04a2a, 0x101418];
const COATS = [0x2a3036, 0x3a2a24, 0x24343a, 0x4a3a2a, 0x2e2a3e, 0x5a2a2a, 0x2a3e30, 0x6a5a40];
const PANTS = [0x1c1e24, 0x2a2a30, 0x3a3428, 0x1e2630];
const SHIRTS = [0xd8d0c0, 0xb8443a, 0x3a6a8a, 0xe0b04a, 0x5a8a5a, 0xc87aa0];
const NEON = [0x5ae8ff, 0xff5ad8, 0xffd04a, 0x7aff8a, 0xff6a4a];

export function randomLook(seed) {
  const r = new RNG(seed);
  return {
    seed,
    height: r.int(26, 30),
    build: r.float(0.85, 1.25),
    skin: r.pick(SKIN),
    hair: r.pick(HAIR),
    hairStyle: r.pick(['short', 'short', 'long', 'bun', 'bald', 'mohawk']),
    coat: r.chance(0.65) ? r.pick(COATS) : null,
    coatLong: r.chance(0.5),
    shirt: r.pick(SHIRTS),
    pants: r.pick(PANTS),
    shoes: 0x121212,
    hat: r.chance(0.18) ? r.pick(['cap', 'fedora', 'beanie']) : null,
    hood: r.chance(0.15),
    backpack: r.chance(0.2),
    bag: r.chance(0.2),
    umbrella: r.chance(0.32) ? { color: r.pick([0x1a1a20, 0x2a2a3a, 0x8a1a2a, 0x1a3a5a, 0xd8d8e0]), neon: r.chance(0.6) ? r.pick(NEON) : null } : null,
    scarf: r.chance(0.2) ? r.pick([0xb8443a, 0xe0b04a, 0x3a6a8a]) : null,
  };
}

export const PLAYER_LOOK = {
  seed: 1,
  height: 29,
  build: 1.05,
  skin: 0xe2b090,
  hair: 0x1a1210,
  hairStyle: 'short',
  coat: 0x2e3a40,
  coatLong: true,
  shirt: 0xd8d0c0,
  pants: 0x1c1e24,
  shoes: 0x0e0e0e,
  hat: null,
  hood: false,
  backpack: false,
  bag: false,
  umbrella: null,
  scarf: 0xa83a32,
};

function pose(anim, i, look) {
  const n = ANIMS[anim].count;
  const ph = (i / n) * Math.PI * 2;
  if (anim === 'idle') {
    const breathe = i === 1 || i === 2 ? 1 : 0;
    return { thighA: 0.04, thighB: -0.04, kneeA: 0.05, kneeB: 0.05, armA: 0.08, armB: -0.05, elbowA: 0.2, elbowB: 0.25, bob: 0, lean: 0, breathe, flare: 0 };
  }
  const run = anim === 'run';
  const A = run ? 0.75 : 0.42;
  const s = Math.sin(ph);
  const c = Math.cos(ph);
  return {
    thighA: A * s,
    thighB: -A * s,
    kneeA: Math.max(0, -c) * (run ? 1.3 : 0.7) + 0.08,
    kneeB: Math.max(0, c) * (run ? 1.3 : 0.7) + 0.08,
    armA: -A * 0.9 * s,
    armB: A * 0.9 * s,
    elbowA: run ? 1.3 : 0.35,
    elbowB: run ? 1.3 : 0.35,
    bob: Math.round(Math.abs(Math.cos(ph)) * (run ? 1.6 : 1)),
    lean: run ? 2 : 0,
    breathe: 0,
    flare: run ? 3 : 1.5 + Math.abs(s),
  };
}

function limb(img, x, y, angle, len, thick, b) {
  const x1 = x + Math.sin(angle) * len;
  const y1 = y + Math.cos(angle) * len;
  img.line(x, y, x1, y1, b, thick);
  return [x1, y1];
}

function drawFrame(img, ox, anim, i, look) {
  const p = pose(anim, i, look);
  const H = look.height;
  const feetY = FH - 2;
  const legLen = Math.round(H * 0.47);
  const torsoLen = Math.round(H * 0.32);
  const cx = ox + 15;
  const hipY = feetY - legLen + p.bob * 0 - (p.bob ? 0 : 0);
  const bobY = -p.bob + 1;
  const hip = [cx, hipY + bobY];
  const sh = [cx + p.lean, hip[1] - torsoLen + p.breathe * 0];
  const w = Math.max(3, Math.round(4 * look.build));

  const body = (c, k = 1, extra = {}) => ({ color: shade(c, k), height: 1, rough: 0.85, ...extra });
  const far = 0.62;
  const pants = look.pants;
  const coat = look.coat;
  const top = coat || look.shirt;

  // umbrella shaft behind everything
  // far leg
  const thigh = Math.round(legLen * 0.5);
  const shin = legLen - thigh;
  const leg = (thighA, kneeA, k) => {
    const knee = limb(img, hip[0], hip[1], thighA, thigh, 3, body(pants, k));
    const foot = limb(img, knee[0], knee[1], thighA - kneeA, shin, 3, body(pants, k));
    img.rect(Math.round(foot[0]) - 1, Math.round(foot[1]) - 1, 4, 2, body(look.shoes, k));
  };
  const arm = (armA, elbowA, k) => {
    const upper = Math.round(H * 0.18);
    const lower = Math.round(H * 0.17);
    const el = limb(img, sh[0], sh[1] + 1, armA, upper, 3, body(top, k));
    const hand = limb(img, el[0], el[1], armA + elbowA, lower, 2, body(coat || look.shirt, k * 0.95));
    img.rect(Math.round(hand[0]) - 1, Math.round(hand[1]), 2, 2, body(look.skin, k));
    return hand;
  };

  if (look.backpack) img.rect(sh[0] - w - 3, sh[1] + 2, 4, Math.round(torsoLen * 0.7), body(0x3a3a2a, 0.9));
  arm(p.armB, p.elbowB, far);
  leg(p.thighB, p.kneeB, far);

  // torso
  for (let y = 0; y <= torsoLen; y++) {
    const t = y / torsoLen;
    const x = Math.round(sh[0] + (hip[0] - sh[0]) * t);
    const ww = w + (t > 0.7 ? 1 : 0);
    img.rect(x - ww + 1, sh[1] + y, ww * 2 - 1, 1, body(top, 1.0 - t * 0.12));
  }
  // shirt front / collar
  if (coat) img.rect(sh[0] + w - 2, sh[1] + 1, 1, Math.round(torsoLen * 0.5), body(look.shirt, 0.9));
  // coat skirt
  if (coat) {
    const skirt = look.coatLong ? Math.round(legLen * 0.62) : Math.round(legLen * 0.3);
    for (let y = 0; y < skirt; y++) {
      const t = y / skirt;
      const back = Math.round(p.flare * t);
      img.rect(hip[0] - w - back, hip[1] + y, w * 2 + back - (t > 0.5 ? 1 : 0), 1, body(coat, 0.92 - t * 0.15));
    }
    // belt
    img.rect(hip[0] - w + 1, hip[1] - 1, w * 2 - 1, 1, body(coat, 0.6));
  }
  leg(p.thighA, p.kneeA, 1.0);
  if (look.bag) img.rect(hip[0] + 2, hip[1] - 1, 3, 4, body(0x5a3a22, 1));
  const hand = arm(p.armA, p.elbowA, 1.0);

  // neck + head
  const headW = 5;
  const headH = 5;
  const hx = sh[0] - 2 + 1;
  const hy = sh[1] - headH - 1;
  img.rect(sh[0] - 1, sh[1] - 1, 2, 2, body(look.skin, 0.85));
  if (look.scarf) img.rect(sh[0] - 2, sh[1] - 1, 5, 2, body(look.scarf, 1));
  img.rect(hx - 1, hy, headW, headH, body(look.skin, 1));
  img.px(hx + headW - 1, hy + 2, body(look.skin, 1.05)); // nose
  img.px(hx + 2, hy + 2, body(0x1a1010, 1)); // eye
  // hair
  const hair = (c) => body(c, 1);
  if (look.hood) {
    img.rect(hx - 2, hy - 1, headW + 1, 3, body(coat || 0x2a2a30, 1));
    img.rect(hx - 2, hy, 3, headH + 1, body(coat || 0x2a2a30, 0.9));
  } else if (look.hairStyle === 'short') {
    img.rect(hx - 1, hy - 1, headW, 2, hair(look.hair));
    img.rect(hx - 1, hy, 2, 3, hair(look.hair));
  } else if (look.hairStyle === 'long') {
    img.rect(hx - 1, hy - 1, headW, 2, hair(look.hair));
    img.rect(hx - 2, hy, 3, headH + 4, hair(look.hair));
  } else if (look.hairStyle === 'bun') {
    img.rect(hx - 1, hy - 1, headW, 2, hair(look.hair));
    img.rect(hx - 3, hy - 1, 2, 2, hair(look.hair));
    img.rect(hx - 1, hy, 2, 2, hair(look.hair));
  } else if (look.hairStyle === 'mohawk') {
    img.rect(hx, hy - 3, 3, 3, hair(look.hair));
  }
  if (look.hat === 'cap') {
    img.rect(hx - 1, hy - 2, headW, 2, body(0x2a3a5a, 1));
    img.rect(hx + 3, hy - 1, 3, 1, body(0x2a3a5a, 0.8));
  } else if (look.hat === 'fedora') {
    img.rect(hx - 2, hy - 1, headW + 3, 1, body(0x2a2420, 1));
    img.rect(hx - 1, hy - 3, headW, 2, body(0x2a2420, 1.1));
  } else if (look.hat === 'beanie') {
    img.rect(hx - 1, hy - 2, headW, 3, body(0x8a2a2a, 1));
  }

  // umbrella held over the head
  if (look.umbrella) {
    const u = look.umbrella;
    const topY = hy - 7;
    const sway = anim === 'idle' ? 0 : Math.round(Math.sin((i / 8) * Math.PI * 2) * 0.6);
    const ux = sh[0] + 1 + sway;
    img.line(Math.round(hand[0]), Math.round(hand[1]), ux, topY, body(0x202020, 1), 1);
    for (let y = 0; y < 5; y++) {
      const half = Math.round(Math.sqrt(Math.max(0, 25 - (5 - y) * (5 - y))) * 1.9);
      img.rect(ux - half, topY + y, half * 2 + 1, 1, body(u.color, 0.85 + y * 0.04));
    }
    if (u.neon) {
      const half = 9;
      img.rect(ux - half, topY + 4, half * 2 + 1, 1, { color: u.neon, emissive: u.neon, emissiveK: 1, height: 1.2 });
      img.px(ux, topY - 1, { color: u.neon, emissive: u.neon, emissiveK: 1, height: 1.2 });
    }
  }
}

export function makeSheet(look) {
  const img = new PixelImage(FW * FRAME_COUNT, FH, { wrap: false, transparent: true });
  for (const [anim, { start, count }] of Object.entries(ANIMS)) for (let i = 0; i < count; i++) drawFrame(img, (start + i) * FW, anim, i, look);
  // height from silhouette -> rounded normals
  for (let k = 0; k < img.w * img.h; k++) img.height[k] = img.albedo[k * 4 + 3] > 0.5 ? 1 : 0;
  img.blurHeight(1, 2);
  // gentle top-down baked shading for readability
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const k = y * img.w + x;
      if (img.albedo[k * 4 + 3] < 0.5) continue;
      const t = 1.06 - ((y % FH) / FH) * 0.18;
      img.albedo[k * 4] *= t;
      img.albedo[k * 4 + 1] *= t;
      img.albedo[k * 4 + 2] *= t;
    }
  const tex = img.toTextures({ name: 'sprite', normalStrength: 1.6 });
  for (const t of [tex.map, tex.normalMap, tex.ormMap, tex.emissiveMap]) {
    if (!t) continue;
    t.minFilter = THREE.NearestMipmapLinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  }
  return tex;
}

// A sprite actor: textured quad (2m x 3m) anchored at the feet.
export class SpriteActor {
  constructor(sheet, { emissiveK = 3, lighting = null } = {}) {
    const meta = sheet.meta || { fw: FW, fh: FH, frames: FRAME_COUNT, anims: ANIMS, tpm: 16, footPad: 2 };
    this.meta = meta;
    const clone = (t) => {
      if (!t) return null;
      const c = t.clone();
      c.repeat.set(1 / meta.frames, 1);
      c.needsUpdate = true;
      return c;
    };
    this.maps = [clone(sheet.map), clone(sheet.normalMap), clone(sheet.ormMap), clone(sheet.emissiveMap)].filter(Boolean);
    const mat = new THREE.MeshStandardMaterial({
      map: this.maps[0],
      normalMap: this.maps[1],
      roughnessMap: this.maps[2],
      roughness: 1,
      metalness: 0,
      alphaTest: 0.5,
      side: THREE.FrontSide,
    });
    if (sheet.emissiveMap) {
      mat.emissiveMap = this.maps[3];
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = emissiveK;
    }
    mat.normalScale.set(1.4, 1.4);
    if (lighting) {
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, lighting);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vRimW;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRimW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\n' + RIM_GLSL)
          .replace(
            '#include <opaque_fragment>',
            `{
              vec3 Nw = inverseTransformDirection(normal, viewMatrix);
              vec3 r = spriteRim(Nw, vRimW);
              outgoingLight += r * (diffuseColor.rgb * 1.3 + 0.3);
              outgoingLight += diffuseColor.rgb * uFill * (0.65 + 0.35 * Nw.y);
            }
            #include <opaque_fragment>`
          );
      };
      mat.customProgramCacheKey = () => 'spriteRim';
    }
    const g = new THREE.PlaneGeometry(meta.fw / meta.tpm, meta.fh / meta.tpm);
    g.translate(0, meta.fh / meta.tpm / 2 - meta.footPad / meta.tpm, 0);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ map: this.maps[0], alphaTest: 0.5 });
    this.frame = 0;
    this.facing = 1;
    this.anim = 'idle';
    this.t = 0;
  }

  setFrame(f) {
    this.frame = f;
    const o = f / this.meta.frames;
    for (const m of this.maps) m.offset.set(o, 0);
  }

  setFacing(dir) {
    if (dir === 0 || dir === this.facing) return;
    this.facing = dir;
    this.mesh.scale.x = dir;
  }

  // advance animation: rate in frames per second
  animate(anim, dt, rate) {
    if (anim !== this.anim) {
      this.anim = anim;
      this.t = 0;
    }
    this.t += dt * rate;
    const a = this.meta.anims[anim];
    this.setFrame(a.start + (Math.floor(this.t) % a.count));
  }
}
