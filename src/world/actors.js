import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { makeSheet, randomLook, SpriteActor } from './sprites.js';
import { makeHeroineSheet } from './heroine.js';
import { Z_FRONT, Z_QUAY } from './street.js';

export const X_MIN = -68;
export const X_MAX = 70;

export function buildActors(ctx) {
  const { scene, input } = ctx;
  const rng = new RNG(808);

  // ---------------------------------------------------------------- player
  const lighting = ctx.lights.spriteUniforms;
  const player = new SpriteActor(makeHeroineSheet().tex, { lighting, emissiveK: 3.5 });
  player.mesh.position.set(-4, 0, 0.55);
  scene.add(player.mesh);
  const pstate = { vx: 0 };

  // ---------------------------------------------------------------- crowd
  const sheets = [];
  for (let i = 0; i < 14; i++) sheets.push(makeSheet(randomLook(1000 + i * 17)));
  const npcs = [];
  const lanes = [
    { z: Z_FRONT + 0.9, n: 6 },
    { z: Z_FRONT + 1.6, n: 5 },
    { z: -1.6, n: 4 },
    { z: 1.25, n: 3 },
    { z: Z_QUAY + 0.9, n: 4, fg: true },
  ];
  let si = 0;
  for (const lane of lanes)
    for (let i = 0; i < lane.n; i++) {
      const a = new SpriteActor(sheets[si++ % sheets.length], { emissiveK: 4, lighting });
      const dir = rng.sign();
      const npc = {
        a,
        x: rng.float(X_MIN, X_MAX),
        z: lane.z + rng.float(-0.25, 0.25),
        dir,
        speed: rng.float(0.9, 1.5),
        idle: !lane.fg && rng.chance(0.18),
        pause: 0,
      };
      a.mesh.position.set(npc.x, 0, npc.z);
      a.setFacing(dir);
      scene.add(a.mesh);
      npcs.push(npc);
    }
  // a few people loitering at fixed spots
  for (const [x, z, f] of [
    [-46.8, Z_FRONT + 0.7, 1],
    [-44.3, Z_FRONT + 1.0, -1],
    [17.2, Z_FRONT + 0.9, -1],
    [19.0, Z_FRONT + 1.1, 1],
    [30.5, Z_FRONT + 0.9, 1],
    [-24.5, Z_FRONT + 1.0, -1],
    [5.6, Z_FRONT + 1.2, 1],
  ]) {
    const a = new SpriteActor(sheets[si++ % sheets.length], { emissiveK: 4, lighting });
    a.mesh.position.set(x, 0, z);
    a.setFacing(f);
    scene.add(a.mesh);
    npcs.push({ a, x, z, dir: f, speed: 0, idle: true, fixed: true, pause: 0 });
  }

  return {
    player,
    npcs,
    update(dt, t) {
      // player
      const target = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const maxV = input.run ? 3.9 : 1.45;
      const acc = 7;
      pstate.vx += (target * maxV - pstate.vx) * Math.min(1, dt * acc);
      if (Math.abs(pstate.vx) < 0.02 && target === 0) pstate.vx = 0;
      const p = player.mesh.position;
      p.x = Math.max(X_MIN, Math.min(X_MAX, p.x + pstate.vx * dt));
      if (target !== 0) player.setFacing(target);
      const sp = Math.abs(pstate.vx);
      if (sp > 2.4) player.animate('run', dt, (8 * sp) / 2.7);
      else if (sp > 0.15) player.animate('walk', dt, (8 * sp) / 1.45);
      else player.animate('idle', dt, 2.2);

      // crowd
      for (const n of npcs) {
        if (n.idle) {
          n.a.animate('idle', dt, 1.6 + (n.z % 1) * 0.5);
          if (!n.fixed) {
            n.pause -= dt;
            if (n.pause <= 0 && rng.chance(dt * 0.1)) n.idle = false;
          }
          continue;
        }
        n.x += n.dir * n.speed * dt;
        if (n.x > X_MAX + 6) n.x = X_MIN - 6;
        if (n.x < X_MIN - 6) n.x = X_MAX + 6;
        n.a.mesh.position.x = n.x;
        n.a.animate('walk', dt, (8 * n.speed) / 1.45);
        if (!n.fixed && rng.chance(dt * 0.015)) {
          n.idle = true;
          n.pause = rng.float(3, 9);
        }
      }
    },
    get velocity() {
      return pstate.vx;
    },
  };
}
