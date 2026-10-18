import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { NS, NP } from '../render/pipeline.js';

const LIGHTING = /* glsl */ `
uniform vec3 uPtPos[${NP}];
uniform vec4 uPtCol[${NP}];
uniform vec3 uSpotPos[${NS}];
uniform vec3 uSpotDir[${NS}];
uniform vec3 uSpotCol[${NS}];
uniform vec4 uSpotP[${NS}];
uniform vec3 uAmb;
vec3 lightAt(vec3 p) {
  vec3 c = uAmb;
  for (int i = 0; i < ${NP}; i++) {
    vec3 d = uPtPos[i] - p;
    float r = uPtCol[i].w;
    float dd = dot(d, d);
    if (dd > r * r) continue;
    float w = 1.0 - dd / (r * r);
    c += uPtCol[i].rgb * w * w / (dd + 0.6);
  }
  for (int i = 0; i < ${NS}; i++) {
    vec3 lv = p - uSpotPos[i];
    float dl = length(lv);
    float cone = smoothstep(uSpotP[i].x, uSpotP[i].y, dot(lv / max(dl, 1e-3), uSpotDir[i]));
    float w = clamp(1.0 - pow(dl / max(uSpotP[i].z, 0.01), 4.0), 0.0, 1.0);
    c += uSpotCol[i] * cone * w * w / (dl * dl + 0.5);
  }
  return c;
}
`;

const DEPTH_TEST = /* glsl */ `
uniform sampler2D tSceneDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
float sceneDist() {
  float d = texture2D(tSceneDepth, gl_FragCoord.xy / uResolution).r;
  float z = d * 2.0 - 1.0;
  return d >= 0.999999 ? 1e5 : (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
`;

export function buildRain(ctx, { count = 6500, splashCount = 1400 } = {}) {
  const { pipeline, shared } = ctx;
  const fogU = pipeline.mFog.uniforms;
  const rng = new RNG(31);

  const common = {
    uTime: shared.uTime,
    uRain: shared.uRain,
    tSceneDepth: shared.tSceneDepth,
    uResolution: shared.uResolution,
    uNear: shared.uNear,
    uFar: shared.uFar,
    uPtPos: fogU.uPtPos,
    uPtCol: fogU.uPtCol,
    uSpotPos: fogU.uSpotPos,
    uSpotDir: fogU.uSpotDir,
    uSpotCol: fogU.uSpotCol,
    uSpotP: fogU.uSpotP,
    uAmb: { value: new THREE.Vector3(0.03, 0.045, 0.06) },
    uWind: { value: new THREE.Vector3(-1.2, 0, 0.3) },
  };

  // ---------------------------------------------------------------- streaks
  // Drops live in a world-anchored periodic volume: the box only decides which
  // period is shown, so drops never travel with the camera.
  function streakLayer(n, boxMin, boxSize, gain, widthK) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.uv = base.attributes.uv;
  const seeds = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) seeds.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = n;
  const uniforms = {
    ...common,
    uBoxMin: { value: boxMin },
    uBoxSize: { value: boxSize },
    uGain: { value: gain },
    uWidthK: { value: widthK },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uRain;
      uniform vec3 uBoxMin;
      uniform vec3 uBoxSize;
      uniform vec3 uWind;
      uniform float uWidthK;
      varying vec2 vUv;
      varying vec3 vWPos;
      varying float vFade;
      void main() {
        float speed = 9.0 + aSeed.w * 4.0;
        vec3 vel = vec3(uWind.x, -speed, uWind.z);
        vec3 p0 = aSeed.xyz * uBoxSize;
        vec3 p = uBoxMin + mod(p0 + vel * uTime - uBoxMin, uBoxSize);
        vec3 dir = normalize(vel);
        vec3 toCam = normalize(cameraPosition - p);
        vec3 side = normalize(cross(dir, toCam));
        float len = speed * 0.028;
        float dist = length(cameraPosition - p);
        float width = (0.006 + dist * 0.0006) * uWidthK;
        vec3 wp = p + dir * (position.y * len) + side * (position.x * width);
        vUv = uv;
        vWPos = wp;
        vFade = step(aSeed.w * 0.999, uRain) * smoothstep(0.0, 0.6, p.y) * smoothstep(uBoxMin.y + uBoxSize.y, uBoxMin.y + uBoxSize.y - 2.0, p.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${LIGHTING}
      ${DEPTH_TEST}
      uniform float uGain;
      varying vec2 vUv;
      varying vec3 vWPos;
      varying float vFade;
      void main() {
        if (vFade <= 0.0) discard;
        float myDist = length(vWPos - cameraPosition);
        if (myDist > sceneDist() * 1.02) discard;
        float a = (1.0 - abs(vUv.x - 0.5) * 2.0) * smoothstep(0.0, 0.5, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
        vec3 L = lightAt(vWPos);
        gl_FragColor = vec4(L * a * vFade * uGain, 1.0);
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const streaks = new THREE.Mesh(geo, mat);
  streaks.frustumCulled = false;
  pipeline.postScene.add(streaks);
  return uniforms;
  }
  const near = streakLayer(count, new THREE.Vector3(-16, -0.5, -8), new THREE.Vector3(32, 14, 16.5), 0.3, 1.0);
  const far = streakLayer(5000, new THREE.Vector3(-36, -0.5, -42), new THREE.Vector3(72, 30, 34), 0.32, 1.2);

  // ---------------------------------------------------------------- splashes
  const sgeo = new THREE.InstancedBufferGeometry();
  const sbase = new THREE.PlaneGeometry(1, 1);
  sgeo.index = sbase.index;
  sgeo.attributes.position = sbase.attributes.position;
  sgeo.attributes.uv = sbase.attributes.uv;
  const sseeds = new Float32Array(splashCount * 4);
  for (let i = 0; i < splashCount; i++) sseeds.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
  sgeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sseeds, 4));
  sgeo.instanceCount = splashCount;
  const smat = new THREE.ShaderMaterial({
    uniforms: { ...common, uBoxMin: near.uBoxMin, uBoxSize: near.uBoxSize, uCurbZ: { value: 1.8 }, uWaterY: { value: -0.16 } },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uRain;
      uniform vec3 uBoxMin;
      uniform vec3 uBoxSize;
      uniform float uCurbZ;
      uniform float uWaterY;
      varying vec2 vUv;
      varying vec3 vWPos;
      varying float vPh;
      void main() {
        float period = 0.45 + aSeed.w * 0.5;
        float tt = uTime / period + aSeed.z * 10.0;
        float cyc = floor(tt);
        vPh = fract(tt);
        // re-randomise position each cycle
        vec2 r = fract(sin(vec2(cyc * 12.989 + aSeed.x * 78.2, cyc * 39.34 + aSeed.y * 11.13)) * 43758.5453);
        vec3 p = vec3(uBoxMin.x + mod(r.x * uBoxSize.x - uBoxMin.x, uBoxSize.x), 0.0, -6.0 + r.y * 15.0);
        p.y = p.z > uCurbZ ? uWaterY + 0.01 : 0.01;
        vec3 toCam = normalize(cameraPosition - p);
        vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        float s = 0.05 + vPh * 0.12;
        vec3 wp = p + side * position.x * s * 2.0 + vec3(0.0, (position.y + 0.5) * s, 0.0);
        vUv = uv;
        vWPos = wp;
        vPh = uRain > aSeed.w ? vPh : 2.0;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${LIGHTING}
      ${DEPTH_TEST}
      varying vec2 vUv;
      varying vec3 vWPos;
      varying float vPh;
      void main() {
        if (vPh > 1.0) discard;
        float myDist = length(vWPos - cameraPosition);
        if (myDist > sceneDist() * 1.03) discard;
        // pixel crown: two droplets flying outward
        vec2 q = floor(vUv * 8.0) / 8.0 + 1.0 / 16.0;
        float spread = vPh * 0.38;
        float y = 0.15 + sin(vPh * 3.14159) * 0.55;
        float d1 = length(q - vec2(0.5 - spread, y));
        float d2 = length(q - vec2(0.5 + spread, y));
        float base = smoothstep(0.25, 0.0, abs(q.y - 0.06)) * smoothstep(0.5, 0.1, abs(q.x - 0.5)) * (1.0 - vPh);
        float a = max(max(step(d1, 0.09), step(d2, 0.09)) * (1.0 - vPh), base * 0.7);
        vec3 L = lightAt(vWPos + vec3(0.0, 0.1, 0.0));
        gl_FragColor = vec4(L * a * 0.45, 1.0);
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const splashes = new THREE.Mesh(sgeo, smat);
  splashes.frustumCulled = false;
  pipeline.postScene.add(splashes);

  return {
    update(camX) {
      near.uBoxMin.value.x = camX - 16;
      far.uBoxMin.value.x = camX - 36;
    },
    splashes,
  };
}
