import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { PixelImage } from '../core/pixel.js';
import { drawText, drawPseudo } from '../core/font.js';
import { LAYER } from '../render/pipeline.js';
import { makeHolo } from '../render/materials.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Procedural tower material: windows computed from world position, with
// derivative-based filtering so distant facades melt into a soft average
// instead of shimmering.
function towerMaterial(shared) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uBase: { value: new THREE.Color(0x0e1419) },
      uGlow: { value: new THREE.Color(0x2a2430) },
    },
  ]);
  uniforms.uTime = shared.uTime;
  return new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      varying vec3 vWPos;
      varying vec3 vN;
      varying float vSeed;
      varying vec3 vSize;
      void main() {
        mat4 im = instanceMatrix;
        vec4 wp = modelMatrix * im * vec4(position, 1.0);
        vWPos = wp.xyz;
        vN = normalize(mat3(modelMatrix * im) * normal);
        vSize = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
        vSeed = fract(sin(dot(im[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform vec3 uBase;
      uniform vec3 uGlow;
      varying vec3 vWPos;
      varying vec3 vN;
      varying float vSeed;
      varying vec3 vSize;
      float h21(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
      void main() {
        vec3 n = normalize(vN);
        vec2 c = abs(n.z) > 0.5 ? vec2(vWPos.x, vWPos.y) : vec2(vWPos.z, vWPos.y);
        bool roof = n.y > 0.5;
        float floorH = 3.2 + floor(vSeed * 3.0) * 0.4;
        float cellW = 1.6 + floor(fract(vSeed * 7.0) * 3.0) * 0.6;
        vec2 g = c / vec2(cellW, floorH);
        vec2 id = floor(g);
        vec2 f = fract(g);
        float lit = fract(vSeed * 13.7) * 0.4 + 0.12;
        float r = h21(id + vSeed * 91.0);
        float rowOff = step(0.82, h21(vec2(id.y, vSeed * 17.0)));
        float colOn = step(0.15, h21(vec2(id.x * 1.7, vSeed * 3.0)));
        float on = step(r, lit) * (1.0 - rowOff) * colOn;
        // occasional TV-flicker
        on *= 1.0 - 0.6 * step(0.985, h21(id + floor(uTime * 2.0)));
        vec3 warm = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.82, 0.55), h21(id + 3.1));
        vec3 cool = mix(vec3(0.45, 0.75, 1.0), vec3(0.6, 1.0, 0.9), h21(id + 7.7));
        vec3 wc = h21(id + 5.3) < 0.72 ? warm : cool;
        float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.22, f.y) * step(f.y, 0.78);
        vec3 winCol = mix(vec3(0.015, 0.02, 0.03), wc * (1.6 + 1.6 * h21(id + 1.3)), on);
        // filtering: blend to the cell average when cells get tiny on screen
        vec2 fw = fwidth(g);
        float aa = smoothstep(0.25, 0.6, max(fw.x, fw.y));
        vec3 avg = mix(vec3(0.015), wc * 2.4, lit * 0.36) * 0.6 + uBase * 0.4;
        vec3 facade = mix(uBase, winCol, win);
        facade = mix(facade, avg, aa);
        // city glow on the lower floors, dark crown
        float hgt = clamp(vWPos.y / 160.0, 0.0, 1.0);
        facade += uGlow * (1.0 - hgt) * 0.25;
        if (roof) facade = uBase * 0.6;
        // edge highlight (pixel trim) on vertical corners
        gl_FragColor = vec4(facade, 1.0);
        #include <fog_fragment>
      }`,
  });
}

function blinkMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime },
    vertexShader: /* glsl */ `
      varying float vSeed;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vSeed = fract(sin(dot(instanceMatrix[3].xyz, vec3(1.7, 9.2, 3.3))) * 4375.5);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying float vSeed;
      void main() {
        float b = step(0.6, fract(uTime * 0.5 + vSeed));
        gl_FragColor = vec4(vec3(1.0, 0.12, 0.08) * (0.3 + 14.0 * b), 1.0);
      }`,
  });
}

// Flying traffic: instanced quads that loop along x in lanes.
function trafficMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec4 aLane;   // x0, speed, length, colorSel
      varying vec3 vCol;
      varying vec2 vUv;
      void main() {
        vec3 base = instanceMatrix[3].xyz;
        float range = 900.0;
        float x = mod(aLane.x + aLane.y * uTime, range) - range * 0.5;
        float dir = sign(aLane.y);
        vec3 p = vec3(x, base.y + sin(uTime * 0.3 + aLane.x) * 0.6, base.z);
        // camera facing quad, stretched along travel direction
        vec3 right = vec3(1.0, 0.0, 0.0);
        vec3 up = vec3(0.0, 1.0, 0.0);
        float len = aLane.z;
        vec3 wp = p + right * position.x * len + up * position.y * 0.5;
        vUv = uv;
        vCol = aLane.w > 0.5 ? vec3(1.0, 0.85, 0.65) * 9.0 : vec3(1.0, 0.15, 0.1) * 7.0;
        if (dir < 0.0 && aLane.w > 0.5) vCol = vec3(1.0, 0.15, 0.1) * 7.0;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying vec2 vUv;
      void main() {
        float d = abs(vUv.y - 0.5) * 2.0;
        float a = (1.0 - d) * smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
        gl_FragColor = vec4(vCol * a, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

function makeAdTexture(seed, kind) {
  const rng = new RNG(seed);
  const W = 64;
  const H = 96;
  const img = new PixelImage(W * 2, H, { wrap: false, transparent: true });
  for (let f = 0; f < 2; f++) {
    const ox = f * W;
    if (kind === 'koi') {
      const c = [1.0, 0.45, 0.25];
      for (let i = 0; i < 40; i++) {
        const t = i / 40;
        const x = ox + 32 + Math.sin(t * 6 + f * 0.6) * 14;
        const y = 12 + t * 70;
        img.disc(x, y, 7 * (1 - t) + 2, { color: c, emissive: c });
      }
      img.disc(ox + 32 + Math.sin(f * 0.6) * 14, 12, 3, { color: [1, 1, 1], emissive: [1, 1, 1] });
    } else if (kind === 'face') {
      const c = [0.45, 0.85, 1.0];
      img.ellipse(ox + 32, 44, 20, 28, { color: c, emissive: c });
      img.ellipse(ox + 32, 44, 17, 25, { color: [0.05, 0.15, 0.25], emissive: [0.05, 0.15, 0.25] });
      img.rect(ox + 22, 38, 7, 3, { color: c, emissive: c });
      img.rect(ox + 35, 38, 7, f ? 1 : 3, { color: c, emissive: c });
      img.rect(ox + 27, 58, 10, 2, { color: c, emissive: c });
      for (let y = 0; y < H; y += 3) img.rect(ox, y, W, 1, { color: [0, 0, 0], erase: false, alpha: 0.4 });
    } else {
      const c = rng.pick([
        [1.0, 0.35, 0.8],
        [0.5, 1.0, 0.6],
        [1.0, 0.8, 0.3],
      ]);
      for (let i = 0; i < 6; i++) drawPseudo(seed * 10 + i, ox + 18, 6 + i * 14, (x, y) => img.rect(x, y, 2, 2, { color: c, emissive: c }), 1);
      img.frame(ox + 10, 2, 44, H - 4, { color: c, emissive: c });
      if (f) img.rect(ox + 12, 4, 40, H - 8, { color: c, emissive: c, alpha: 0.15 });
    }
  }
  const t = img.toTextures({ name: 'ad' }).map;
  return t;
}

export function buildCity(ctx) {
  const { scene, shared, lights } = ctx;
  const rng = new RNG(4242);
  const group = new THREE.Group();
  scene.add(group);

  // --------------------------------------------------------------- towers
  const boxes = [];
  const place = (x, z, w, d, h) => boxes.push({ x, z, w, d, h });
  // mid ring just behind the street (seen through gaps and above roofs)
  for (let x = -110; x < 110; x += rng.float(9, 16)) place(x, rng.float(-34, -22), rng.float(8, 14), rng.float(8, 12), rng.float(20, 42));
  // far rings
  for (let x = -260; x < 260; x += rng.float(12, 24)) place(x, rng.float(-80, -50), rng.float(12, 22), rng.float(12, 22), rng.float(35, 95));
  for (let x = -420; x < 420; x += rng.float(18, 34)) place(x, rng.float(-170, -110), rng.float(16, 30), rng.float(16, 30), rng.float(60, 170));
  for (let x = -700; x < 700; x += rng.float(30, 60)) place(x, rng.float(-320, -230), rng.float(25, 45), rng.float(25, 45), rng.float(90, 260));
  // mega structures
  place(-140, -420, 70, 60, 480);
  place(180, -520, 90, 70, 560);
  place(20, -650, 60, 60, 420);

  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const towers = new THREE.InstancedMesh(geo, towerMaterial(shared), boxes.length);
  const m4 = new THREE.Matrix4();
  boxes.forEach((b, i) => {
    m4.makeScale(b.w, b.h, b.d);
    m4.setPosition(b.x, -2, b.z);
    towers.setMatrixAt(i, m4);
  });
  towers.frustumCulled = false;
  group.add(towers);

  // setback crowns / antennas
  const crowns = [];
  boxes.forEach((b) => {
    if (b.h > 50 && rng.chance(0.6)) {
      const s = rng.float(0.45, 0.75);
      crowns.push({ x: b.x, z: b.z, w: b.w * s, d: b.d * s, y: b.h - 2, h: rng.float(6, 20) });
    }
  });
  const crownMesh = new THREE.InstancedMesh(geo, towers.material, crowns.length);
  crowns.forEach((c, i) => {
    m4.makeScale(c.w, c.h, c.d);
    m4.setPosition(c.x, c.y, c.z);
    crownMesh.setMatrixAt(i, m4);
  });
  crownMesh.frustumCulled = false;
  group.add(crownMesh);

  // aviation blink lights
  const blinkGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  const blinkers = boxes.filter((b) => b.h > 40);
  const blink = new THREE.InstancedMesh(blinkGeo, blinkMaterial(shared), blinkers.length);
  blinkers.forEach((b, i) => {
    const s = b.z < -200 ? 3 : 1.4;
    m4.makeScale(s, s, s);
    m4.setPosition(b.x + b.w * 0.4, b.h + 1, b.z + b.d * 0.5);
    blink.setMatrixAt(i, m4);
  });
  blink.frustumCulled = false;
  group.add(blink);

  // vertical light strips on the megastructures
  for (const [x, z, h, c] of [
    [-140, -389, 470, 0x5ae0ff],
    [180, -484, 550, 0xff5ad8],
    [20, -619, 410, 0xffc04a],
  ]) {
    for (let i = -2; i <= 2; i++) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(1.6, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(2.2) }));
      strip.position.set(x + i * 11, h / 2, z);
      group.add(strip);
    }
  }

  // --------------------------------------------------------------- holograms
  const ads = [
    { kind: 'koi', x: -6, y: 32, z: -48.9, w: 12, h: 18 },
    { kind: 'face', x: 66, y: 58, z: -100, w: 24, h: 36 },
    { kind: 'glyph', x: -48, y: 40, z: -70, w: 10, h: 15 },
    { kind: 'glyph', x: 34, y: 26, z: -22.5, w: 6, h: 9 },
    { kind: 'face', x: -120, y: 90, z: -150, w: 30, h: 45 },
  ];
  ads.forEach((a, i) => {
    const tex = makeAdTexture(100 + i, a.kind);
    const mat = makeHolo(shared, tex, { frames: 2, fps: 0.7, intensity: 3.2, flicker: 0.25, seed: i * 1.7 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(a.w, a.h), mat);
    m.position.set(a.x, a.y, a.z);
    m.layers.set(LAYER.GLOW);
    group.add(m);
    const col = a.kind === 'koi' ? 0xff7a40 : a.kind === 'face' ? 0x6ad8ff : 0xff6ad0;
    lights.add({ position: new THREE.Vector3(a.x, a.y, a.z + 4), color: col, intensity: a.w * 18, range: a.w * 3, fog: 1.6, surface: false });
  });

  // --------------------------------------------------------------- traffic
  const lanes = [];
  for (let i = 0; i < 160; i++) {
    const z = rng.pick([-40, -65, -90, -130, -180, -240]) + rng.float(-6, 6);
    const y = rng.float(28, 120) * (z < -150 ? 1.3 : 1);
    const speed = rng.float(14, 38) * rng.sign();
    lanes.push({ x0: rng.float(0, 900), y, z, speed, len: rng.float(1.5, 3.2), col: rng.chance(0.5) ? 1 : 0 });
  }
  const tg = new THREE.PlaneGeometry(1, 1);
  tg.translate(0, 0, 0);
  const trafficGeo = new THREE.InstancedBufferGeometry().copy(tg);
  trafficGeo.instanceCount = lanes.length;
  const aLane = new Float32Array(lanes.length * 4);
  lanes.forEach((l, i) => aLane.set([l.x0, l.speed, l.len, l.col], i * 4));
  trafficGeo.setAttribute('aLane', new THREE.InstancedBufferAttribute(aLane, 4));
  const traffic = new THREE.InstancedMesh(trafficGeo, trafficMaterial(shared), lanes.length);
  lanes.forEach((l, i) => {
    m4.makeTranslation(0, l.y, l.z);
    traffic.setMatrixAt(i, m4);
  });
  traffic.frustumCulled = false;
  traffic.layers.set(LAYER.GLOW);
  group.add(traffic);

  // --------------------------------------------------------------- mountains + sky
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uFlash: { value: 0 }, uFlashX: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = normalize(wp.xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFlash;
      uniform float uFlashX;
      varying vec3 vDir;
      float h(vec2 p){ return fract(sin(dot(p, vec2(41.1, 289.7))) * 43758.5453); }
      float n2(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main() {
        float y = vDir.y;
        vec3 top = vec3(0.008, 0.014, 0.03);
        vec3 mid = vec3(0.03, 0.05, 0.085);
        vec3 hor = vec3(0.16, 0.10, 0.12);
        vec3 c = mix(hor, mid, smoothstep(-0.02, 0.18, y));
        c = mix(c, top, smoothstep(0.18, 0.6, y));
        // slow clouds lit from below by the city
        vec2 p = vDir.xz / max(y + 0.15, 0.05) * 1.4 + vec2(uTime * 0.004, 0.0);
        float cl = n2(p) * 0.6 + n2(p * 2.3) * 0.3 + n2(p * 5.1) * 0.1;
        c += vec3(0.11, 0.07, 0.08) * smoothstep(0.45, 0.85, cl) * smoothstep(0.5, 0.05, y);
        // lightning lights the cloud deck from inside
        float side = exp(-abs(vDir.x - uFlashX) * 2.5);
        c += vec3(0.55, 0.62, 0.9) * uFlash * (0.25 + cl * 1.6) * (0.35 + side) * smoothstep(-0.05, 0.25, y);
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1300, 32, 16), skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.onBeforeRender = (r, s, cam) => sky.position.copy(cam.position);
  group.add(sky);

  // distant mountain silhouettes
  const mshape = [];
  const mr = new RNG(9);
  let mx = -1200;
  const mpts = [new THREE.Vector2(-1200, -10)];
  while (mx < 1200) {
    mx += mr.float(40, 120);
    mpts.push(new THREE.Vector2(mx, mr.float(60, 210)));
  }
  mpts.push(new THREE.Vector2(1200, -10));
  const ms = new THREE.Shape(mpts);
  const mountain = new THREE.Mesh(new THREE.ShapeGeometry(ms), new THREE.MeshBasicMaterial({ color: 0x0a0e14 }));
  mountain.position.set(0, -5, -1000);
  group.add(mountain);
  mshape.push(mountain);

  // lightning bolt (geometry rebuilt per strike)
  const boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 0.8, 1.0) });
  const bolt = new THREE.Mesh(new THREE.BufferGeometry(), boltMat);
  bolt.visible = false;
  bolt.frustumCulled = false;
  group.add(bolt);
  function strikeBolt(x, z, seed) {
    const r = new RNG(seed);
    const pts = [];
    let p = new THREE.Vector3(x, 420, z);
    pts.push(p.clone());
    while (p.y > 40) {
      p = p.clone().add(new THREE.Vector3(r.float(-28, 28), -r.float(18, 40), 0));
      pts.push(p);
    }
    const geos = [];
    const seg = (a, b, w) => {
      const d = b.clone().sub(a);
      const g = new THREE.BoxGeometry(w, d.length(), w);
      g.translate(0, d.length() / 2, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      g.applyQuaternion(q);
      g.translate(a.x, a.y, a.z);
      geos.push(g);
    };
    for (let i = 0; i < pts.length - 1; i++) {
      seg(pts[i], pts[i + 1], 2.6);
      if (r.chance(0.35)) {
        let b = pts[i].clone();
        for (let k = 0; k < 3; k++) {
          const nb = b.clone().add(new THREE.Vector3(r.float(-30, 30), -r.float(15, 30), 0));
          seg(b, nb, 1.2);
          b = nb;
        }
      }
    }
    bolt.geometry.dispose();
    bolt.geometry = mergeGeometries(geos);
  }

  return { group, towers, skyMat, bolt, boltMat, strikeBolt };
}
