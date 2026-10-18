import * as THREE from 'three';
import { Kit } from '../core/kit.js';
import { Z_FRONT } from './street.js';

// Physical shadowed spot lights are a scarce resource (each one is a shadow
// render + a fog/shader slot). Candidates (lamps, headlights, searchlights)
// compete every frame; the best ones get a slot.
export class SpotPool {
  constructor(scene, lights, n, { mapSize = 1024 } = {}) {
    this.slots = [];
    for (let i = 0; i < n; i++) {
      const s = new THREE.SpotLight(0xffffff, 0, 30, 0.6, 0.5, 2);
      s.castShadow = true;
      s.shadow.mapSize.set(mapSize, mapSize);
      s.shadow.bias = -0.0004;
      s.shadow.normalBias = 0.02;
      s.shadow.camera.near = 0.3;
      scene.add(s, s.target);
      const reg = lights.addSpot(s, { fog: 1, g: 0.3 });
      this.slots.push({ light: s, reg });
    }
  }

  // candidates: { pos, target, color, intensity, angle, penumbra, range, fog, g, score }
  assign(cands) {
    cands.sort((a, b) => b.score - a.score);
    for (let i = 0; i < this.slots.length; i++) {
      const { light, reg } = this.slots[i];
      const c = cands[i];
      if (!c || c.score <= -1e8) {
        light.intensity = 0;
        light.visible = true;
        reg.fog = 0;
        continue;
      }
      light.position.copy(c.pos);
      light.target.position.copy(c.target);
      light.color.copy(c.color);
      light.intensity = c.intensity;
      light.angle = c.angle;
      light.penumbra = c.penumbra;
      light.distance = c.range || 30;
      reg.fog = c.fog === undefined ? 1 : c.fog;
      reg.g = c.g === undefined ? 0.3 : c.g;
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();
    }
  }
}

function emis(color, k) {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) });
}

export function buildVehicles(ctx, mats) {
  const { scene, lights } = ctx;

  // ---------------------------------------------------------------- drone
  const drone = new THREE.Group();
  {
    const k = new Kit();
    k.box(mats.metal, 0, 0, 0, 0.7, 0.22, 0.5);
    k.box(mats.pole, 0, -0.16, 0, 0.3, 0.12, 0.3);
    for (const [x, z] of [
      [-0.55, -0.4],
      [0.55, -0.4],
      [-0.55, 0.4],
      [0.55, 0.4],
    ]) {
      k.box(mats.pole, x * 0.6, 0.05, z * 0.6, 0.5, 0.05, 0.06, { rot: [0, Math.atan2(z, x), 0] });
      k.cylinder(mats.dark, x, 0.1, z, 0.22, 0.02, { radial: 10 });
    }
    k.build(drone);
    const red = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), emis(0xff2020, 12));
    red.position.set(-0.36, 0.0, 0.26);
    const green = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), emis(0x20ff60, 12));
    green.position.set(0.36, 0.0, 0.26);
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.18), emis(0xdff0ff, 30));
    lens.position.set(0, -0.23, 0);
    drone.add(red, green, lens);
    drone.userData = { red, green };
    scene.add(drone);
  }
  const droneLight = lights.add({ position: new THREE.Vector3(), color: 0xdff0ff, intensity: 10, range: 3, fog: 2, surface: false });

  // ---------------------------------------------------------------- taxi
  const taxi = new THREE.Group();
  const taxiLights = [];
  {
    const k = new Kit();
    const yellow = mats.taxiPaint;
    // voxel-ish hover cab, nose pointing -x
    k.box(yellow, 0, 0.45, 0, 4.2, 0.5, 1.8);
    k.box(yellow, 0.2, 0.85, 0, 3.4, 0.35, 1.7);
    k.box(yellow, 0.4, 1.25, 0, 2.2, 0.45, 1.6);
    k.box(yellow, -1.95, 0.55, 0, 0.4, 0.4, 1.6);
    k.box(yellow, 2.0, 0.65, 0, 0.5, 0.5, 1.7);
    k.box(mats.dark, 0, 0.12, 0, 3.6, 0.2, 1.4);
    // thrusters
    for (const x of [-1.3, 1.3]) for (const z of [-0.75, 0.75]) k.cylinder(mats.pole, x, 0.1, z, 0.28, 0.25, { radial: 8 });
    k.build(taxi);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.34, 1.62), new THREE.MeshStandardMaterial({ color: 0x0a1218, roughness: 0.1, metalness: 0.5, emissive: new THREE.Color(0x3a2a1a), emissiveIntensity: 0.6 }));
    glass.position.set(0.35, 1.25, 0);
    taxi.add(glass);
    // roof sign
    const roof = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.3), emis(0xffb030, 6));
    roof.position.set(0.4, 1.58, 0);
    taxi.add(roof);
    // headlights + tail lights + thruster glow
    for (const z of [-0.55, 0.55]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.34), emis(0xfff2d8, 40));
      h.position.set(-2.16, 0.6, z);
      taxi.add(h);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.4), emis(0xff2a1a, 12));
      tl.position.set(2.26, 0.75, z);
      taxi.add(tl);
    }
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.06), emis(0xffa020, 8));
      s.position.set(-1.6 + i * 0.12, 0.98, 0.86);
      taxi.add(s);
    }
    const under = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.03, 1.2), emis(0xff8a30, 2.5));
    under.position.set(0, 0.0, 0);
    taxi.add(under);
    taxi.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    scene.add(taxi);
    taxiLights.push(lights.add({ position: new THREE.Vector3(), color: 0xff3a20, intensity: 8, range: 4, fog: 1.4 }));
    taxiLights.push(lights.add({ position: new THREE.Vector3(), color: 0xff9a40, intensity: 16, range: 5, fog: 1.0 }));
  }

  // Taxi flight path (seconds): enter right high -> descend -> hover at stand -> leave left
  const CYCLE = 46;
  const P_IN = new THREE.Vector3(95, 22, -1.5);
  const P_STAND = new THREE.Vector3(19, 1.3, -0.9);
  const P_OUT = new THREE.Vector3(-95, 18, 0.5);
  const ease = (t) => t * t * (3 - 2 * t);
  function taxiState(t) {
    const c = t % CYCLE;
    const pos = new THREE.Vector3();
    let pitch = 0;
    if (c < 14) {
      const u = ease(c / 14);
      pos.lerpVectors(P_IN, P_STAND, u);
      pos.y = P_STAND.y + (P_IN.y - P_STAND.y) * Math.pow(1 - u, 1.6);
      pitch = -0.12 * (1 - u);
    } else if (c < 26) {
      pos.copy(P_STAND);
      pitch = 0.02 * Math.sin(c * 1.3);
    } else {
      const u = Math.min(1, (c - 26) / 16);
      const e = u * u;
      pos.lerpVectors(P_STAND, P_OUT, e);
      pos.y = P_STAND.y + (P_OUT.y - P_STAND.y) * Math.pow(u, 0.7);
      pitch = 0.1 * Math.sin(u * Math.PI);
    }
    pos.y += Math.sin(t * 1.7) * 0.06;
    return { pos, pitch };
  }

  const tmp = new THREE.Vector3();
  return {
    drone,
    taxi,
    update(dt, t, focus) {
      // drone: hover + sweep in the alley
      const dx = -34 + Math.sin(t * 0.21) * 2.2;
      const dz = -12 + Math.sin(t * 0.13) * 4;
      drone.position.set(dx, 9.2 + Math.sin(t * 0.9) * 0.15, dz);
      drone.rotation.y = Math.sin(t * 0.17) * 0.4;
      drone.rotation.z = Math.sin(t * 0.7) * 0.04;
      const blink = Math.floor(t * 1.5) % 2;
      drone.userData.red.visible = blink === 0;
      drone.userData.green.visible = blink === 1;
      droneLight.position.copy(drone.position).add(tmp.set(0, -0.3, 0));
      const sweep = new THREE.Vector3(-34 + Math.sin(t * 0.37) * 3.2, 0, -10 + Math.sin(t * 0.29 + 1) * 6 + 2);

      // taxi
      const s = taxiState(t);
      taxi.position.copy(s.pos);
      taxi.rotation.z = s.pitch;
      const hover = (t % CYCLE) >= 14 && (t % CYCLE) < 26;
      taxiLights[0].position.copy(s.pos).add(tmp.set(2.3, 0.75, 0));
      taxiLights[1].position.copy(s.pos).add(tmp.set(0, -0.2, 0));

      const cands = [];
      cands.push({
        pos: drone.position.clone().add(tmp.set(0, -0.3, 0)),
        target: sweep,
        color: new THREE.Color(0xcfe6ff),
        intensity: 9000,
        angle: 0.2,
        penumbra: 0.45,
        range: 45,
        fog: 0.55,
        g: 0.55,
        score: 100 - Math.abs(drone.position.x - focus.x) * 0.5,
      });
      const fwd = new THREE.Vector3(-Math.cos(s.pitch), -Math.sin(s.pitch) - 0.12, 0).normalize();
      for (const z of [-0.55, 0.55]) {
        const hp = s.pos.clone().add(new THREE.Vector3(-2.2, 0.6, z));
        cands.push({
          pos: hp,
          target: hp.clone().addScaledVector(fwd, 10),
          color: new THREE.Color(0xffe6c0),
          intensity: hover ? 1400 : 2200,
          angle: 0.24,
          penumbra: 0.5,
          range: 40,
          fog: 0.45,
          g: 0.6,
          score: Math.abs(s.pos.x - focus.x) < 34 ? 60 : -1e9,
        });
      }
      return cands;
    },
  };
}
