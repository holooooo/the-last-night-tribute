// GLSL for the full-screen passes of the cinematic pipeline.
// All shaders are ShaderMaterial (WebGL2 / GLSL ES 3.0 under the hood).

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const COMMON = /* glsl */ `
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
float linearizeDepth(float d, float n, float f) {
  // perspective depth buffer value -> positive view distance along -z
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - z * (f - n));
}
vec3 luma3(vec3 c) { return vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

export const COPY_FRAG = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }
`;

// Half-resolution linear depth (nearest of the 2x2 footprint).
export const DEPTH_DOWN_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tDepth;
uniform vec2 uSrcTexel;
uniform float uNear, uFar;
varying vec2 vUv;
void main() {
  vec2 o = uSrcTexel * 0.5;
  float d0 = texture2D(tDepth, vUv + vec2(-o.x, -o.y)).r;
  float d1 = texture2D(tDepth, vUv + vec2( o.x, -o.y)).r;
  float d2 = texture2D(tDepth, vUv + vec2(-o.x,  o.y)).r;
  float d3 = texture2D(tDepth, vUv + vec2( o.x,  o.y)).r;
  float d = min(min(d0, d1), min(d2, d3));
  float lin = d >= 0.999999 ? 1.0e4 : linearizeDepth(d, uNear, uFar);
  gl_FragColor = vec4(lin, 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Volumetric fog. Ray-marched single scattering with:
//  * exponential height fog with animated 3D noise (wind)
//  * shadowed spot lights (shadow maps re-used from the surface lighting)
//  * analytic in-scattering integral for point lights (no marching needed)
//  * local density volumes (steam vents, smoke)
// ---------------------------------------------------------------------------
export function fogFrag(NS, NP, NV, STEPS) {
  const spotSamplers = Array.from({ length: NS }, (_, i) => `uniform sampler2DShadow tSpotShadow${i};`).join('\n');
  const spotBlocks = Array.from(
    { length: NS },
    (_, i) => /* glsl */ `
    {
      vec3 lv = p - uSpotPos[${i}];
      float dl = length(lv);
      vec3 l = lv / max(dl, 1e-4);
      float cone = smoothstep(uSpotP[${i}].x, uSpotP[${i}].y, dot(l, uSpotDir[${i}]));
      if (cone > 0.0 && dl < uSpotP[${i}].z) {
        float att = 1.0 / max(dl * dl, 0.25);
        float w = clamp(1.0 - pow(dl / uSpotP[${i}].z, 4.0), 0.0, 1.0);
        att *= w * w;
        float sh = 1.0;
        if (uSpotShadowOn[${i}] > 0.5) {
          vec4 sc = uSpotMat[${i}] * vec4(p, 1.0);
          sc.xyz /= sc.w;
          if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0)
            sh = texture(tSpotShadow${i}, vec3(sc.xy, sc.z - 0.0008));
        }
        inS += uSpotCol[${i}] * (cone * att * sh * hg(dot(l, -rd), uSpotP[${i}].w));
      }
    }`
  ).join('\n');

  return /* glsl */ `
${COMMON}
#define NS ${NS}
#define NP ${NP}
#define NV ${NV}
#define STEPS ${STEPS}
precision highp sampler3D;
uniform sampler2D tDepth;          // half-res linear depth
uniform sampler3D tNoise;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec4 uFogA;   // density, height falloff, base height, noise amount
uniform vec4 uFogB;   // noise scale, max march distance, extinction scale, point-light scale
uniform vec4 uFogC;   // spot scale, ground-layer density, ground-layer height, sky density
uniform vec3 uWind;
uniform vec3 uAmbLow;
uniform vec3 uAmbHigh;
uniform vec3 uAmbFar;

uniform vec3 uSpotPos[NS];
uniform vec3 uSpotDir[NS];
uniform vec3 uSpotCol[NS];
uniform vec4 uSpotP[NS];      // cosOuter, cosInner, range, anisotropy g
uniform mat4 uSpotMat[NS];
uniform float uSpotShadowOn[NS];
${spotSamplers}

uniform vec3 uPtPos[NP];
uniform vec4 uPtCol[NP];      // rgb * intensity, w = range

uniform vec4 uVolPos[NV];     // center, density
uniform vec4 uVolRad[NV];     // radii, rise speed

varying vec2 vUv;

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

float noiseAt(vec3 p) {
  vec3 q = p * uFogB.x;
  float n1 = texture(tNoise, q + uWind * uTime).r;
  float n2 = texture(tNoise, q * 2.63 + vec3(0.31, 0.17, 0.77) - uWind * (uTime * 1.7)).r;
  return n1 * 0.68 + n2 * 0.32;
}

float densityAt(vec3 p) {
  float h = max(p.y - uFogA.z, 0.0);
  float d = uFogA.x * (exp(-h * uFogA.y) + uFogC.w);
  // thick wet layer hugging the ground
  d += uFogC.y * exp(-max(p.y, 0.0) / uFogC.z);
  float n = noiseAt(p);
  d *= max(mix(1.0, n * 2.1 - 0.15, uFogA.w), 0.0);
  for (int i = 0; i < NV; i++) {
    if (uVolPos[i].w <= 0.0) continue;
    vec3 q = (p - uVolPos[i].xyz) / uVolRad[i].xyz;
    float f = clamp(1.0 - dot(q, q), 0.0, 1.0);
    if (f <= 0.0) continue;
    float vn = texture(tNoise, p * 0.45 - vec3(0.0, uTime * uVolRad[i].w, 0.0)).r;
    d += uVolPos[i].w * f * f * smoothstep(0.25, 0.75, vn);
  }
  return d;
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vr = v.xyz / v.w;
  vr /= -vr.z;
  vec3 wp = (uViewInv * vec4(vr * min(depth, 2000.0), 1.0)).xyz;
  vec3 rd = normalize(wp - uCamPos);
  float dist = length(wp - uCamPos);
  bool sky = depth > 5000.0;
  float tMax = min(dist, uFogB.y);

  float jitter = ign(gl_FragCoord.xy);
  vec3 L = vec3(0.0);
  float T = 1.0;
  float ext = uFogB.z;
  float tPrev = 0.0;
  for (int i = 0; i < STEPS; i++) {
    float a = (float(i) + jitter) / float(STEPS);
    float t = tMax * a * a;
    float dt = t - tPrev;
    tPrev = t;
    vec3 p = uCamPos + rd * t;
    float dens = densityAt(p);
    if (dens <= 1e-5) continue;
    vec3 inS = mix(uAmbLow, uAmbHigh, clamp(p.y / 40.0, 0.0, 1.0));
    inS = mix(inS, uAmbFar, clamp(t / 160.0, 0.0, 1.0));
    vec3 spot = vec3(0.0);
    {
      vec3 inS0 = inS;
      inS = vec3(0.0);
${spotBlocks}
      spot = inS * uFogC.x;
      inS = inS0;
    }
    inS += spot;
    float sig = dens * ext;
    float Ts = exp(-sig * dt);
    L += T * inS * (1.0 - Ts) / ext;
    T *= Ts;
  }
  // haze beyond the march range (distant skyline)
  if (dist > tMax) {
    vec3 pf = uCamPos + rd * tMax;
    float dFar = uFogA.x * (exp(-max(pf.y - uFogA.z, 0.0) * uFogA.y * 0.6) + uFogC.w) * 0.8;
    float Tf = exp(-dFar * ext * (min(dist, 1200.0) - tMax));
    L += T * uAmbFar * (1.0 - Tf) / ext;
    T *= Tf;
  }

  // Analytic point-light in-scattering: integral of 1/(h^2 + (t - tc)^2) along the ray.
  float tEnd = min(dist, 400.0);
  for (int i = 0; i < NP; i++) {
    vec4 c = uPtCol[i];
    if (c.r + c.g + c.b <= 0.0) continue;
    vec3 toL = uPtPos[i] - uCamPos;
    float tc = dot(toL, rd);
    float h = max(length(toL - rd * tc), 0.12);
    if (h > c.w) continue;
    float I = (atan((tEnd - tc) / h) - atan(-tc / h)) / h;
    float w = clamp(1.0 - pow(h / c.w, 4.0), 0.0, 1.0);
    float tcc = clamp(tc, 0.0, tEnd);
    vec3 pc = uCamPos + rd * tcc;
    float dc = densityAt(pc);
    float Tc = exp(-dc * ext * tcc);
    L += c.rgb * (I * w * w * dc * Tc * uFogB.w * 0.0796);
  }

  gl_FragColor = vec4(L, T);
}
`;
}

// Depth-aware separable blur at fog resolution.
export const BILATERAL_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  float dc = texture2D(tDepth, vUv).r;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int k = -4; k <= 4; k++) {
    vec2 uv = vUv + uDir * float(k);
    float d = texture2D(tDepth, uv).r;
    float g = exp(-float(k * k) / 8.0);
    float w = g * exp(-abs(d - dc) / (0.06 * min(dc, 400.0) + 0.05));
    acc += texture2D(tSrc, uv) * w;
    wsum += w;
  }
  gl_FragColor = acc / max(wsum, 1e-4);
}
`;

// Scene * transmittance + in-scatter, with joint-bilateral upsampling.
export const FOG_COMPOSITE_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tScene;
uniform sampler2D tDepth;      // full-res depth buffer
uniform sampler2D tFog;        // low-res fog
uniform sampler2D tFogDepth;   // low-res linear depth
uniform vec2 uFogRes;
uniform float uNear, uFar;
uniform float uFogOn;
varying vec2 vUv;
void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  if (uFogOn < 0.5) { gl_FragColor = vec4(col, 1.0); return; }
  float d = texture2D(tDepth, vUv).r;
  float lin = d >= 0.999999 ? 1.0e4 : linearizeDepth(d, uNear, uFar);
  vec2 p = vUv * uFogRes - 0.5;
  vec2 f = fract(p);
  vec2 base = (floor(p) + 0.5) / uFogRes;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j <= 1; j++)
    for (int i = 0; i <= 1; i++) {
      vec2 uv = base + vec2(float(i), float(j)) / uFogRes;
      float ld = texture2D(tFogDepth, uv).r;
      float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
      float w = bw * exp(-abs(ld - lin) / (0.04 * min(lin, 400.0) + 0.03)) + 1e-5;
      acc += texture2D(tFog, uv) * w;
      wsum += w;
    }
  vec4 fog = acc / wsum;
  gl_FragColor = vec4(col * fog.a + fog.rgb, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Depth of field (scatter-as-gather, after Dennis Gustafsson's single pass bokeh)
// ---------------------------------------------------------------------------
export const DOF_COC = /* glsl */ `
uniform float uFocus;
uniform float uFocusRange;
uniform float uNearK;
uniform float uFarK;
uniform float uMaxCoc;
float cocFromDepth(float lin) {
  // signed: negative = foreground
  float s;
  if (lin < uFocus) s = -max((uFocus - uFocusRange) / max(lin, 0.05) - 1.0, 0.0) * uNearK;
  else s = max(1.0 - (uFocus + uFocusRange) / lin, 0.0) * uFarK;
  return clamp(s, -1.0, 1.0) * uMaxCoc;
}
`;

export const DOF_PRE_FRAG = /* glsl */ `
${COMMON}
${DOF_COC}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform float uNear, uFar;
uniform vec2 uSrcTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  vec2 o = uSrcTexel * 0.5;
  float d0 = texture2D(tDepth, vUv + vec2(-o.x, -o.y)).r;
  float d1 = texture2D(tDepth, vUv + vec2( o.x, -o.y)).r;
  float d2 = texture2D(tDepth, vUv + vec2(-o.x,  o.y)).r;
  float d3 = texture2D(tDepth, vUv + vec2( o.x,  o.y)).r;
  float d = min(min(d0, d1), min(d2, d3));
  float lin = d >= 0.999999 ? 1.0e4 : linearizeDepth(d, uNear, uFar);
  // limit the energy of tiny over-bright texels so bokeh discs don't sparkle
  c = c / (1.0 + max(luma(c) - 24.0, 0.0) * 0.04);
  gl_FragColor = vec4(c, cocFromDepth(lin));
}
`;

export const DOF_GATHER_FRAG = /* glsl */ `
uniform sampler2D tPre;
uniform vec2 uTexel;
uniform float uMaxCoc;
uniform float uRadScale;
varying vec2 vUv;
void main() {
  vec4 center = texture2D(tPre, vUv);
  float centerSize = abs(center.a);
  vec3 color = center.rgb;
  float tot = 1.0;
  float fg = 0.0;
  float radius = uRadScale;
  float ang = 0.0;
  for (int i = 0; i < 400; i++) {
    if (radius >= uMaxCoc) break;
    vec2 tc = vUv + vec2(cos(ang), sin(ang)) * uTexel * radius;
    vec4 s = texture2D(tPre, tc);
    float sampleSize = abs(s.a);
    if (s.a > center.a) sampleSize = clamp(sampleSize, 0.0, centerSize * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, sampleSize);
    color += mix(color / tot, s.rgb, m);
    if (s.a < center.a - 1.0) fg += m;
    tot += 1.0;
    ang += 2.39996323;
    radius += uRadScale / radius;
  }
  color /= tot;
  float a = max(smoothstep(0.6, 2.0, centerSize), clamp(fg / tot * 2.2, 0.0, 1.0));
  gl_FragColor = vec4(color, a);
}
`;

export const DOF_COMPOSITE_FRAG = /* glsl */ `
${COMMON}
${DOF_COC}
uniform sampler2D tColor;
uniform sampler2D tBlur;
uniform sampler2D tDepth;
uniform float uNear, uFar;
uniform float uDofOn;
varying vec2 vUv;
void main() {
  vec3 sharp = texture2D(tColor, vUv).rgb;
  if (uDofOn < 0.5) { gl_FragColor = vec4(sharp, 1.0); return; }
  vec4 blur = texture2D(tBlur, vUv);
  float d = texture2D(tDepth, vUv).r;
  float lin = d >= 0.999999 ? 1.0e4 : linearizeDepth(d, uNear, uFar);
  float coc = abs(cocFromDepth(lin));
  float a = max(smoothstep(0.6, 2.0, coc), blur.a);
  gl_FragColor = vec4(mix(sharp, blur.rgb, a), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Bloom: physically-based style mip chain (13 tap down / 3x3 tent up)
// ---------------------------------------------------------------------------
export const BLOOM_DOWN_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uKaris;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
vec3 karis(vec3 c) { return c / (1.0 + luma(c)); }
void main() {
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 res;
  if (uKaris > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = 1.0 / (1.0 + luma(g0)), w1 = 1.0 / (1.0 + luma(g1)), w2 = 1.0 / (1.0 + luma(g2));
    float w3 = 1.0 / (1.0 + luma(g3)), w4 = 1.0 / (1.0 + luma(g4));
    res = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) /
          (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
  } else {
    res = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(max(res, 0.0), 1.0);
}
`;

export const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 r = uTexel * uRadius;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += (texture2D(tSrc, vUv + vec2(-r.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(r.x, 0.0)).rgb +
        texture2D(tSrc, vUv + vec2(0.0, -r.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, r.y)).rgb) * 2.0;
  c += texture2D(tSrc, vUv + vec2(-r.x, -r.y)).rgb + texture2D(tSrc, vUv + vec2(r.x, -r.y)).rgb +
       texture2D(tSrc, vUv + vec2(-r.x, r.y)).rgb + texture2D(tSrc, vUv + vec2(r.x, r.y)).rgb;
  gl_FragColor = vec4(c / 16.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Final: chromatic aberration, bloom mix, filmic tone curve, grading, grain.
// ---------------------------------------------------------------------------
export const FINAL_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloom;
uniform float uCA;
uniform float uGrain;
uniform float uVignette;
uniform float uTime;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uSaturation;
uniform float uContrast;
uniform float uDebug;
varying vec2 vUv;

vec3 aces(vec3 x) {
  // Stephen Hill's ACES fit (RRT + ODT)
  const mat3 ACESIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 ACESOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = ACESIn * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(ACESOut * (a / b), 0.0, 1.0);
}

vec3 sampleHdr(vec2 uv) {
  return texture2D(tColor, uv).rgb + texture2D(tBloom, uv).rgb * uBloom;
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 dir = vUv - 0.5;
  float r2 = dot(dir, dir);
  vec2 ca = dir * r2 * uCA;
  vec3 col;
  col.r = sampleHdr(vUv - ca).r;
  col.g = sampleHdr(vUv).g;
  col.b = sampleHdr(vUv + ca).b;
  if (uDebug > 0.5) { gl_FragColor = vec4(toSRGB(clamp(col, 0.0, 1.0)), 1.0); return; }

  col *= uExposure;
  col = aces(col);
  // grading in display-ish space
  col = pow(col, vec3(1.0 / 1.0));
  vec3 l = luma3(col);
  col = mix(l, col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5;
  col = col * uGain + uLift * (1.0 - col);
  col = clamp(col, 0.0, 1.0);

  float vig = smoothstep(0.85, 0.2, length(dir * vec2(1.25, 1.0)));
  col *= mix(1.0 - uVignette, 1.0, vig);

  vec3 outc = toSRGB(col);
  float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0, vec2(12.9898, 78.233))) * 43758.5453);
  float n2 = fract(sin(dot(gl_FragCoord.xy * 1.37 + fract(uTime * 3.11) * 71.0, vec2(39.346, 11.135))) * 24634.6345);
  float g = (n + n2 - 1.0);
  outc += g * uGrain * (0.35 + 0.65 * (1.0 - luma(outc)));
  gl_FragColor = vec4(outc, 1.0);
}
`;
