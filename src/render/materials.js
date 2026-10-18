import * as THREE from 'three';

// Shared GLSL helpers for the wet-street / water / glass looks.
const WET_COMMON = /* glsl */ `
precision highp sampler3D;
uniform sampler2D tReflSharp;
uniform sampler2D tReflBlur;
uniform mat4 uReflMatrix;
uniform sampler3D tNoise3D;
uniform float uTime;
uniform float uWet;
uniform float uPuddleT;
uniform float uRain;
uniform float uIsWater;
uniform float uReflStrength;
varying vec3 vWPos;

float rh(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

// Rain ripples: expanding rings, one drop per cell, two interleaved layers.
vec2 rippleGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  for (int k = 0; k < 3; k++) {
    vec2 q = p * 2.2 + float(k) * vec2(0.37, 0.71);
    vec2 cell = floor(q);
    vec2 f = fract(q) - 0.5;
    float h = rh(cell + float(k) * 17.13);
    float ph = fract(t * (0.75 + h * 0.5) + h * 7.0);
    vec2 c = (vec2(rh(cell + 3.1), rh(cell + 7.7)) - 0.5) * 0.3;
    vec2 d = f - c;
    float r = length(d);
    float x = r - ph * 0.42;
    float env = exp(-x * x * 500.0) * (1.0 - ph) * (1.0 - ph);
    float dw = cos(x * 70.0) * env;
    g += dw * d / max(r, 1e-3) * 0.55;
  }
  return g;
}

vec2 waveGrad(vec2 p, float t) {
  float e = 0.15;
  vec3 a = vec3(p * 0.21, t * 0.035);
  float n0 = texture(tNoise3D, a).r;
  float nx = texture(tNoise3D, a + vec3(e * 0.21, 0.0, 0.0)).r;
  float nz = texture(tNoise3D, a + vec3(0.0, e * 0.21, 0.0)).r;
  vec3 b = vec3(p * 0.63 + 3.7, t * 0.06);
  float m0 = texture(tNoise3D, b).r;
  float mx = texture(tNoise3D, b + vec3(e * 0.63, 0.0, 0.0)).r;
  float mz = texture(tNoise3D, b + vec3(0.0, e * 0.63, 0.0)).r;
  return vec2(nx - n0, nz - n0) * 2.2 + vec2(mx - m0, mz - m0) * 1.1;
}
`;

// Turns any MeshStandardMaterial into a wet, reflective surface that samples
// the planar reflection (with puddles, rain ripples and roughness streaks).
export function makeWet(material, shared, opts = {}) {
  const u = {
    tReflSharp: shared.tReflSharp,
    tReflBlur: shared.tReflBlur,
    uReflMatrix: shared.uReflMatrix,
    tNoise3D: shared.tNoise3D,
    uTime: shared.uTime,
    uWet: { value: opts.wet === undefined ? 1 : opts.wet },
    uPuddleT: { value: opts.puddle === undefined ? 0.56 : opts.puddle },
    uRain: shared.uRain || { value: 1 },
    uIsWater: { value: opts.water ? 1 : 0 },
    uReflStrength: { value: opts.reflStrength === undefined ? 1 : opts.reflStrength },
  };
  material.userData.wetUniforms = u;
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WET_COMMON + '\nfloat gPuddle = 0.0;')
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        {
          vec2 pq = (floor(vWPos.xz * 16.0) + 0.5) / 16.0;
          float n = texture(tNoise3D, vec3(pq * 0.045, 0.37)).r * 0.7 + texture(tNoise3D, vec3(pq * 0.16, 0.81)).r * 0.3;
          gPuddle = uIsWater > 0.5 ? 1.0 : smoothstep(uPuddleT, uPuddleT + 0.025, n) * uWet;
          // cobble gaps hold water too
          float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          gPuddle = max(gPuddle, uIsWater > 0.5 ? 0.0 : smoothstep(0.07, 0.02, lum) * 0.6 * uWet);
          diffuseColor.rgb *= mix(1.0, 0.6, uWet);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.22, gPuddle);
        }`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.55, uWet);
        roughnessFactor = mix(roughnessFactor, 0.04, gPuddle);`
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        {
          vec2 rq = (floor(vWPos.xz * 24.0) + 0.5) / 24.0;
          vec2 g = rippleGrad(rq, uTime) * uRain;
          if (uIsWater > 0.5) g += waveGrad(vWPos.xz, uTime);
          vec3 nw = normalize(vec3(-g.x * 0.35, 1.0, -g.y * 0.35));
          vec3 nv = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
          normal = normalize(mix(normal, nv, gPuddle));
        }`
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        {
          vec4 rc = uReflMatrix * vec4(vWPos, 1.0);
          vec3 nW = inverseTransformDirection(normal, viewMatrix);
          vec2 ruv = rc.xy / rc.w + nW.xz * vec2(0.05, 0.12);
          vec3 rs = texture2D(tReflSharp, ruv).rgb;
          vec3 rb = texture2D(tReflBlur, ruv).rgb;
          vec3 refl = mix(rb, rs, gPuddle * 0.85);
          float NoV = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          float F = 0.03 + 0.97 * pow(1.0 - NoV, 5.0);
          float k = mix(uWet * 0.45, 1.0, gPuddle) * mix(0.25, 1.0, F) * uReflStrength;
          outgoingLight += refl * k;
        }
        #include <opaque_fragment>`
      );
  };
  material.customProgramCacheKey = () => 'wet' + (opts.water ? 'W' : 'G');
  return material;
}

// ---------------------------------------------------------------------------
// Rain-streaked refractive glass. Samples the opaque scene copy so whatever is
// behind (shop interiors, fish tanks) is refracted through running droplets.
// ---------------------------------------------------------------------------
export function makeGlass(shared, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tOpaque: shared.tOpaque,
      uResolution: shared.uResolution,
      uTime: shared.uTime,
      uRain: shared.uRain || { value: 1 },
      uTint: { value: new THREE.Color(opts.tint === undefined ? 0xd8eef0 : opts.tint) },
      uRefl: { value: new THREE.Color(opts.refl === undefined ? 0x1a2a3a : opts.refl) },
      uDirt: { value: opts.dirt === undefined ? 0.25 : opts.dirt },
      uDrops: { value: opts.drops === undefined ? 1 : opts.drops },
      uFrost: { value: opts.frost === undefined ? 0.0 : opts.frost },
      uSeed: { value: opts.seed || 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      varying vec3 vN;
      varying vec3 vView;
      varying vec2 vUv;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vView = cameraPosition - wp.xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tOpaque;
      uniform vec2 uResolution;
      uniform float uTime;
      uniform float uRain;
      uniform vec3 uTint;
      uniform vec3 uRefl;
      uniform float uDirt;
      uniform float uDrops;
      uniform float uFrost;
      uniform float uSeed;
      varying vec3 vWPos;
      varying vec3 vN;
      varying vec3 vView;
      varying vec2 vUv;

      float h1(float n) { return fract(sin(n * 91.345 + uSeed) * 47453.5453); }
      float h2(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1)) + uSeed) * 45758.5453); }

      // returns xy: surface slope, z: wet coverage
      vec3 staticDrops(vec2 p, float scale) {
        vec2 q = p * scale;
        vec2 id = floor(q);
        vec2 f = fract(q) - 0.5;
        float h = h2(id);
        vec2 c = (vec2(h2(id + 1.7), h2(id + 9.1)) - 0.5) * 0.55;
        float r = mix(0.12, 0.34, h * h);
        vec2 d = f - c;
        float m = 1.0 - dot(d, d) / (r * r);
        if (m <= 0.0 || h < 0.35) return vec3(0.0);
        return vec3(d / r * 0.9, smoothstep(0.0, 0.25, m));
      }

      vec3 runningDrops(vec2 p, float t) {
        float colW = 0.11;
        float col = floor(p.x / colW);
        float hx = h1(col);
        float speed = 0.25 + hx * 0.6;
        float x = (fract(p.x / colW) - 0.5) * colW;
        float cx = (h1(col + 3.3) - 0.5) * colW * 0.4 + sin(p.y * 6.0 + hx * 30.0) * 0.006;
        // stop-and-go slide
        float tt = t * speed + hx * 10.0;
        float y = 2.4 - fract(tt * 0.18) * 3.6 - 0.25 * sin(tt * 2.1) * 0.15;
        vec2 d = vec2((x - cx) / 0.022, (p.y - y) / 0.03);
        float m = 1.0 - dot(d, d);
        vec3 res = vec3(0.0);
        if (m > 0.0) res = vec3(d * 0.8, smoothstep(0.0, 0.3, m));
        // wet trail behind the drop with a few beads
        float above = p.y - y;
        if (above > 0.0 && above < 1.2) {
          float tw = 1.0 - smoothstep(0.004, 0.009, abs(x - cx));
          float bead = step(0.82, fract(above * 9.0 + hx * 4.0)) * (1.0 - above / 1.2);
          res.z = max(res.z, tw * (0.25 + bead * 0.6));
          res.xy += vec2(sign(x - cx) * tw * bead * 0.6, 0.0);
        }
        return res;
      }

      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(vView);
        // glass plane coordinates in world meters, pixel-quantised
        vec3 up = vec3(0.0, 1.0, 0.0);
        vec3 tang = normalize(cross(up, N));
        vec2 gp = vec2(dot(vWPos, tang), vWPos.y);
        gp = (floor(gp * 48.0) + 0.5) / 48.0;
        vec3 d = vec3(0.0);
        if (uDrops > 0.0) {
          vec3 s1 = staticDrops(gp, 9.0);
          vec3 s2 = staticDrops(gp + 3.1, 17.0) * 0.7;
          vec3 r1 = runningDrops(gp, uTime) * uRain;
          d.xy = s1.xy * s1.z + s2.xy * s2.z + r1.xy * r1.z;
          d.z = max(max(s1.z, s2.z), r1.z);
          d *= uDrops;
        }
        vec2 suv = gl_FragCoord.xy / uResolution;
        vec2 off = d.xy * 0.018 + N.xz * 0.0;
        vec3 refr = vec3(0.0);
        float blur = mix(uFrost, 0.0, d.z);
        for (int i = 0; i < 5; i++) {
          float a = float(i) * 2.39996;
          vec2 o = vec2(cos(a), sin(a)) * blur * float(i) * 0.0025;
          refr += texture2D(tOpaque, suv + off + o).rgb;
        }
        refr /= 5.0;
        refr *= uTint;
        float NoV = clamp(abs(dot(N, V)), 0.0, 1.0);
        float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
        float grad = clamp(vWPos.y * 0.15, 0.0, 1.0);
        vec3 refl = uRefl * (0.6 + grad);
        float dirt = uDirt * (0.5 + 0.5 * sin(gp.x * 3.1 + sin(gp.y * 2.3)));
        vec3 col = mix(refr, refl, clamp(F + dirt * 0.15, 0.0, 1.0));
        // droplets catch a sliver of light
        col += uRefl * d.z * 0.35 + refr * d.z * 0.25;
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
  });
}

// Scanline hologram / screen material (additive, flickering).
export function makeHolo(shared, map, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      uTime: shared.uTime,
      uColor: { value: new THREE.Color(opts.color === undefined ? 0xffffff : opts.color) },
      uIntensity: { value: opts.intensity === undefined ? 3 : opts.intensity },
      uFlicker: { value: opts.flicker === undefined ? 0.15 : opts.flicker },
      uScan: { value: opts.scan === undefined ? 1 : opts.scan },
      uSeed: { value: opts.seed || 0 },
      uFrames: { value: opts.frames || 1 },
      uFps: { value: opts.fps || 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWPos;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float uTime, uIntensity, uFlicker, uScan, uSeed, uFrames, uFps;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying vec3 vWPos;
      float hh(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        vec2 uv = vUv;
        float frame = uFps > 0.0 ? floor(mod(uTime * uFps + uSeed * 7.0, uFrames)) : 0.0;
        float glitch = step(0.985, hh(floor(uTime * 12.0) + uSeed));
        uv.x += glitch * (hh(floor(vWPos.y * 20.0) + uTime) - 0.5) * 0.06;
        uv.x = (uv.x + frame) / uFrames;
        vec4 t = texture2D(map, uv);
        float scan = mix(1.0, 0.55 + 0.45 * step(0.5, fract(vWPos.y * 18.0 - uTime * 0.6)), uScan);
        float fl = 1.0 - uFlicker * step(0.92, hh(floor(uTime * 24.0) + uSeed * 3.1));
        vec3 c = t.rgb * uColor * uIntensity * scan * fl;
        gl_FragColor = vec4(c * t.a, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}
