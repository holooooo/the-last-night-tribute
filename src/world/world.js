import * as THREE from 'three';
import { Kit } from '../core/kit.js';
import { createMaterials } from './materials-lib.js';
import { buildStreet } from './street.js';
import { buildCity } from './city.js';
import { buildRain } from './rain.js';
import { buildActors } from './actors.js';
import { buildVehicles, SpotPool } from './vehicles.js';

export function buildWorld(ctx) {
  const { scene, lights, pipeline, camera } = ctx;
  const mats = createMaterials(ctx.shared);

  const kit = new Kit();
  const street = buildStreet(ctx, kit, mats);
  kit.build(scene);
  const city = buildCity(ctx);
  const rain = buildRain(ctx);
  const actors = buildActors(ctx);
  const vehicles = buildVehicles(ctx, mats);

  scene.add(new THREE.HemisphereLight(0x2a4660, 0x0a0806, 0.3));
  const pool = new SpotPool(scene, lights, 4);

  // ---------------------------------------------------------------- lightning
  // A directional light whose shadow map is only rendered during a strike.
  const flashLight = new THREE.DirectionalLight(0xcfdcff, 0);
  flashLight.castShadow = true;
  flashLight.shadow.autoUpdate = false;
  flashLight.shadow.mapSize.set(2048, 2048);
  Object.assign(flashLight.shadow.camera, { left: -26, right: 26, top: 22, bottom: -8, near: 1, far: 160 });
  flashLight.shadow.camera.updateProjectionMatrix();
  flashLight.shadow.bias = -0.0008;
  flashLight.shadow.normalBias = 0.03;
  scene.add(flashLight, flashLight.target);
  const P = pipeline.params;
  const ambBase = { low: P.ambLow.clone(), high: P.ambHigh.clone(), far: P.ambFar.clone() };
  const flashCol = new THREE.Color(0.55, 0.62, 0.85);
  let strike = null;
  let nextStrike = 7;
  let strikeSeed = 1;
  function startStrike(t) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const dir = new THREE.Vector3(side * 0.85, 0.55, 0.12).normalize();
    // double / triple strobe with a long decaying tail
    const pattern = [
      [0, 0.06, 1.0],
      [0.1, 0.05, 0.45],
      [0.19, 0.5, 0.9],
    ];
    if (Math.random() < 0.4) pattern.push([0.8, 0.25, 0.5]);
    strike = { t0: t, dir, pattern };
    city.strikeBolt(camX + side * (60 + Math.random() * 120), -520 - Math.random() * 200, strikeSeed++);
    lights.spriteUniforms.uFlashDir.value.copy(dir);
    city.skyMat.uniforms.uFlashX.value = side * 0.6;
  }
  function flashValue(t) {
    if (!strike) return 0;
    const u = t - strike.t0;
    let f = 0;
    for (const [s0, d, a] of strike.pattern) {
      if (u < s0) continue;
      const k = (u - s0) / d;
      f = Math.max(f, a * (k < 1 ? 1 - k * 0.3 : Math.exp(-(k - 1) * 3.0) * 0.7));
    }
    if (u > 2.5) strike = null;
    return f;
  }

  let rainOn = true;
  let closeUp = false;
  let closeK = 0;
  let rainK = 1;
  const focus = new THREE.Vector3();
  const player = actors.player.mesh;
  let camX = player.position.x;
  const camTarget = new THREE.Vector3();

  return {
    actors,
    vehicles,
    street,
    toggleRain() {
      rainOn = !rainOn;
    },
    lightning() {
      nextStrike = -1;
    },
    toggleCloseUp() {
      closeUp = !closeUp;
    },
    teleport(x) {
      player.position.x = x;
      camX = x;
    },
    update(dt, t) {
      actors.update(dt, t);

      // cinematic follow camera: slow lead, gentle handheld drift
      const lead = actors.velocity * 0.9;
      camX += (player.position.x + lead - camX) * Math.min(1, dt * 1.6);
      const sway = Math.sin(t * 0.31) * 0.06 + Math.sin(t * 0.73) * 0.03;
      // C: blend towards a low close-up on the heroine
      closeK += ((closeUp ? 1 : 0) - closeK) * Math.min(1, dt * 1.8);
      const e = closeK * closeK * (3 - 2 * closeK);
      const px = player.position.x;
      camera.position.set(
        camX + sway + (px + 0.35 - camX) * e,
        2.3 + Math.sin(t * 0.43) * 0.03 - 1.15 * e,
        13.4 + (player.position.z + 4.6 - 13.4) * e
      );
      camTarget.set(camX + (px - camX) * e, 2.25 - 1.3 * e, -1.0 + (player.position.z + 1.5) * e);
      camera.lookAt(camTarget);
      camera.updateMatrixWorld();
      focus.set(camX, 2.0, -1.0);

      const cands = vehicles.update(dt, t, focus);
      for (const l of street.lampSpots) {
        const d = Math.abs(l.pos.x - focus.x);
        cands.push({ ...l, range: 14, fog: 1.0, g: 0.35, score: 40 - d });
      }
      pool.assign(cands);
      lights.update(t, focus, camera);

      for (const s of street.signMats) s.mat.emissiveIntensity = s.base * s.fl(t);

      // lightning
      if (t > nextStrike && rainOn) {
        startStrike(t);
        nextStrike = t + 9 + Math.random() * 16;
      } else if (nextStrike < 0) {
        startStrike(t);
        nextStrike = t + 9 + Math.random() * 16;
      }
      const f = flashValue(t);
      flashLight.intensity = f * 7;
      flashLight.position.copy(focus).addScaledVector(strike ? strike.dir : flashLight.position.clone().normalize(), 70);
      flashLight.target.position.copy(focus);
      flashLight.target.updateMatrixWorld();
      // (always render once at startup so the shadow sampler has a real texture)
      flashLight.shadow.needsUpdate = f > 0.01 || !flashLight.shadow.map;
      lights.spriteUniforms.uFlash.value = f;
      city.skyMat.uniforms.uFlash.value = f;
      city.bolt.visible = f > 0.35;
      city.boltMat.color.setRGB(0.7, 0.8, 1.0).multiplyScalar(4 + f * 40);
      const boost = (c, b, k) => c.setRGB(b.r + flashCol.r * k, b.g + flashCol.g * k, b.b + flashCol.b * k);
      boost(P.ambLow, ambBase.low, f * 0.1);
      boost(P.ambHigh, ambBase.high, f * 0.16);
      boost(P.ambFar, ambBase.far, f * 0.35);
      for (const a of street.animated) a.fn(t);

      rainK += ((rainOn ? 1 : 0) - rainK) * Math.min(1, dt * 0.8);
      ctx.shared.uRain.value = rainK;
      rain.update(camX);

      pipeline.params.focus = camera.position.distanceTo(player.position) - 0.2;
      if (this.camOverride) this.camOverride(camera);
    },
  };
}
