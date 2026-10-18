import * as THREE from 'three';
import { Pipeline } from './render/pipeline.js';
import { LightManager } from './render/lights.js';
import { buildWorld } from './world/world.js';

const ASPECT = 2.39;
const params = new URLSearchParams(location.search);
const QUALITY = { low: 0.55, med: 0.75, high: 1.0 }[params.get('q') || 'med'] || 0.75;

const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.NoToneMapping;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(29, ASPECT, 0.2, 1500);
camera.position.set(0, 1.8, 14);

const lights = new LightManager(scene, { pointSlots: 14, fogSlots: 24 });
const pipeline = new Pipeline(renderer, scene, camera, lights);
pipeline.shared.uRain = { value: 1 };

const input = { left: false, right: false, run: false };
const world = buildWorld({ scene, lights, pipeline, shared: pipeline.shared, camera, renderer, input });

function resize() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let cw = vw;
  let ch = vw / ASPECT;
  if (ch > vh) {
    ch = vh;
    cw = vh * ASPECT;
  }
  renderer.domElement.style.width = `${Math.round(cw)}px`;
  renderer.domElement.style.height = `${Math.round(ch)}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let iw = Math.min(cw * dpr, 2560) * QUALITY;
  iw = Math.max(640, Math.round(iw));
  if (params.get('w')) iw = parseInt(params.get('w'), 10);
  const ih = Math.round(iw / ASPECT);
  renderer.setSize(iw, ih, false);
  pipeline.setSize(iw, ih);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
const stats = document.getElementById('stats');
const HUD_TEXT = 'A / D  walk     SHIFT  run     C  close-up     L  lightning     R  rain     F  fog     G  depth of field     B  bloom     H  hide';
hud.textContent = HUD_TEXT;
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'a' || e.key === 'ArrowLeft') input.left = true;
  if (k === 'd' || e.key === 'ArrowRight') input.right = true;
  if (e.key === 'Shift') input.run = true;
  if (k === 'f') pipeline.params.fog = !pipeline.params.fog;
  if (k === 'g') pipeline.params.dof = !pipeline.params.dof;
  if (k === 'b') pipeline.params.bloom = pipeline.params.bloom > 0 ? 0 : 0.085;
  if (k === 'r') world.toggleRain();
  if (k === 'l') world.lightning();
  if (k === 'c') world.toggleCloseUp();
  if (k === 'h') {
    hud.style.display = hud.style.display === 'none' ? '' : 'none';
    stats.style.display = hud.style.display;
  }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'a' || e.key === 'ArrowLeft') input.left = false;
  if (k === 'd' || e.key === 'ArrowRight') input.right = false;
  if (e.key === 'Shift') input.run = false;
});
// touch / mouse: hold left or right half of the screen to walk
window.addEventListener('pointerdown', (e) => {
  if (e.clientX < window.innerWidth / 2) input.left = true;
  else input.right = true;
});
window.addEventListener('pointerup', () => {
  input.left = input.right = false;
});

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------
let last = performance.now();
let time = 0;
let fpsAcc = 0;
let fpsN = 0;
let fpsShown = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  time += dt;
  world.update(dt, time);
  pipeline.render(time);
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fpsShown = Math.round(fpsN / fpsAcc);
    fpsAcc = 0;
    fpsN = 0;
    stats.textContent = `${fpsShown} fps  ·  ${pipeline.w}×${pipeline.h}`;
  }
  requestAnimationFrame(frame);
}

document.getElementById('loading').style.opacity = 0;
setTimeout(() => document.getElementById('loading').remove(), 1300);
const title = document.getElementById('title');
setTimeout(() => (title.style.opacity = 1), 400);
setTimeout(() => (title.style.opacity = 0), 5200);
requestAnimationFrame(frame);

// Dev helper: render one frame and POST the canvas to the vite capture endpoint.
async function capture(name = 'shot', advance = 0) {
  for (let i = 0; i < advance; i++) {
    time += 1 / 60;
    world.update(1 / 60, time);
    pipeline.render(time);
  }
  world.update(0, time);
  pipeline.render(time);
  const url = renderer.domElement.toDataURL('image/png');
  await fetch(`/__capture?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
  return `${name}.png ${pipeline.w}x${pipeline.h}`;
}

window.__tln = { THREE, renderer, scene, camera, pipeline, lights, world, capture, input };
