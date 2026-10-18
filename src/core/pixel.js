import * as THREE from 'three';

// A tiny multi-channel "pixel painter". Every procedural texture in the scene is
// painted with these primitives into parallel channels (albedo / height /
// emissive / roughness / metalness) and then converted into nearest-filtered
// GPU textures. Height is turned into a per-texel normal map so the chunky
// pixel art reacts to the dynamic 3D lights like in The Last Night.

export function hex(c) {
  if (Array.isArray(c)) return c;
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

export function shade(c, k) {
  const a = hex(c);
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function mixc(a, b, t) {
  a = hex(a);
  b = hex(b);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export class PixelImage {
  constructor(w, h, { wrap = true, transparent = false } = {}) {
    this.w = w;
    this.h = h;
    this.wrap = wrap;
    this.albedo = new Float32Array(w * h * 4);
    if (!transparent) for (let i = 0; i < w * h; i++) this.albedo[i * 4 + 3] = 1;
    this.height = new Float32Array(w * h);
    this.emissive = new Float32Array(w * h * 3);
    this.rough = new Float32Array(w * h).fill(0.85);
    this.metal = new Float32Array(w * h);
    this.hasEmissive = false;
  }

  index(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (this.wrap) {
      x = ((x % this.w) + this.w) % this.w;
      y = ((y % this.h) + this.h) % this.h;
    } else if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  apply(i, b) {
    if (i < 0) return;
    if (b.color !== undefined) {
      const c = hex(b.color);
      const a = b.alpha === undefined ? 1 : b.alpha;
      const o = i * 4;
      if (b.blend === 'mul') {
        this.albedo[o] *= 1 - a + a * c[0];
        this.albedo[o + 1] *= 1 - a + a * c[1];
        this.albedo[o + 2] *= 1 - a + a * c[2];
      } else {
        this.albedo[o] += (c[0] - this.albedo[o]) * a;
        this.albedo[o + 1] += (c[1] - this.albedo[o + 1]) * a;
        this.albedo[o + 2] += (c[2] - this.albedo[o + 2]) * a;
        if (b.opaque !== false) this.albedo[o + 3] = Math.max(this.albedo[o + 3], b.coverage === undefined ? 1 : b.coverage);
      }
    }
    if (b.erase) this.albedo[i * 4 + 3] = 0;
    if (b.height !== undefined) this.height[i] = b.height;
    if (b.dh !== undefined) this.height[i] += b.dh;
    if (b.emissive !== undefined) {
      const e = hex(b.emissive);
      const k = b.emissiveK === undefined ? 1 : b.emissiveK;
      this.emissive[i * 3] = e[0] * k;
      this.emissive[i * 3 + 1] = e[1] * k;
      this.emissive[i * 3 + 2] = e[2] * k;
      this.hasEmissive = true;
    }
    if (b.rough !== undefined) this.rough[i] = b.rough;
    if (b.metal !== undefined) this.metal[i] = b.metal;
  }

  px(x, y, b) {
    this.apply(this.index(x, y), b);
  }

  fill(b) {
    for (let i = 0; i < this.w * this.h; i++) this.apply(i, b);
  }

  rect(x, y, w, h, b) {
    for (let yy = Math.floor(y); yy < Math.floor(y) + h; yy++)
      for (let xx = Math.floor(x); xx < Math.floor(x) + w; xx++) {
        if (typeof b === 'function') {
          const r = b(xx - x, yy - y, xx, yy);
          if (r) this.px(xx, yy, r);
        } else this.px(xx, yy, b);
      }
  }

  // Rectangle outline.
  frame(x, y, w, h, b) {
    this.rect(x, y, w, 1, b);
    this.rect(x, y + h - 1, w, 1, b);
    this.rect(x, y, 1, h, b);
    this.rect(x + w - 1, y, 1, h, b);
  }

  line(x0, y0, x1, y1, b, thick = 1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const n = Math.max(Math.abs(dx), Math.abs(dy), 1);
    const r = (thick - 1) / 2;
    for (let s = 0; s <= n; s++) {
      const x = x0 + (dx * s) / n;
      const y = y0 + (dy * s) / n;
      if (thick <= 1) this.px(Math.round(x), Math.round(y), b);
      else this.disc(x, y, r + 0.5, b);
    }
  }

  disc(cx, cy, r, b) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) this.px(x, y, b);
      }
  }

  ellipse(cx, cy, rx, ry, b) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.px(x, y, b);
      }
  }

  // Per-texel brightness jitter: gives the hand-placed "dithered" feel.
  noise(rng, amount = 0.08, mask = null) {
    for (let i = 0; i < this.w * this.h; i++) {
      if (mask && !mask(i % this.w, Math.floor(i / this.w))) continue;
      const k = 1 + (rng.next() * 2 - 1) * amount;
      this.albedo[i * 4] *= k;
      this.albedo[i * 4 + 1] *= k;
      this.albedo[i * 4 + 2] *= k;
    }
  }

  // Vertical dirt / rain streaks that run down from ledges.
  streaks(rng, count, { color = 0x000000, alpha = 0.25, minLen = 4, maxLen = 30, y0 = 0 } = {}) {
    for (let s = 0; s < count; s++) {
      const x = rng.int(0, this.w - 1);
      const len = rng.int(minLen, maxLen);
      const start = y0 + rng.int(0, Math.max(0, this.h - len));
      for (let y = 0; y < len; y++) {
        const a = alpha * (1 - y / len);
        this.px(x, start + y, { color, alpha: a, opaque: false });
        if (rng.chance(0.3)) this.px(x + 1, start + y, { color, alpha: a * 0.5, opaque: false });
      }
    }
  }

  blotches(rng, count, { color = 0x000000, alpha = 0.2, rMin = 1, rMax = 4, rough } = {}) {
    for (let s = 0; s < count; s++) {
      const cx = rng.float(0, this.w);
      const cy = rng.float(0, this.h);
      const r = rng.float(rMin, rMax);
      this.disc(cx, cy, r, { color, alpha: alpha * rng.float(0.5, 1), opaque: false, rough });
    }
  }

  get(x, y) {
    const i = this.index(x, y);
    if (i < 0) return null;
    return {
      r: this.albedo[i * 4],
      g: this.albedo[i * 4 + 1],
      b: this.albedo[i * 4 + 2],
      a: this.albedo[i * 4 + 3],
      h: this.height[i],
    };
  }

  heightAt(x, y) {
    const i = this.index(x, y);
    return i < 0 ? 0 : this.height[i];
  }

  // Blur the height channel (used by sprites to get rounded volumes).
  blurHeight(radius = 1, passes = 1) {
    const w = this.w;
    const h = this.h;
    for (let p = 0; p < passes; p++) {
      const src = this.height.slice();
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0;
          let n = 0;
          for (let oy = -radius; oy <= radius; oy++)
            for (let ox = -radius; ox <= radius; ox++) {
              const i = this.index(x + ox, y + oy);
              if (i < 0) continue;
              s += src[i];
              n++;
            }
          this.height[y * w + x] = s / n;
        }
    }
  }

  toTextures({ normalStrength = 2.0, emissive = this.hasEmissive, name = 'tex' } = {}) {
    const { w, h } = this;
    const N = w * h;
    const albedo = new Uint8Array(N * 4);
    const normal = new Uint8Array(N * 4);
    const orm = new Uint8Array(N * 4);
    const emis = emissive ? new Uint8Array(N * 4) : null;
    const to8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let y = 0; y < h; y++) {
      const ty = h - 1 - y; // DataTexture rows start at v = 0 (bottom)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = (ty * w + x) * 4;
        albedo[o] = to8(this.albedo[i * 4]);
        albedo[o + 1] = to8(this.albedo[i * 4 + 1]);
        albedo[o + 2] = to8(this.albedo[i * 4 + 2]);
        albedo[o + 3] = to8(this.albedo[i * 4 + 3]);
        const hl = this.heightAt(x - 1, y);
        const hr = this.heightAt(x + 1, y);
        const hu = this.heightAt(x, y - 1);
        const hd = this.heightAt(x, y + 1);
        let nx = -(hr - hl) * normalStrength;
        let ny = -(hu - hd) * normalStrength;
        let nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        normal[o] = to8(nx * 0.5 + 0.5);
        normal[o + 1] = to8(ny * 0.5 + 0.5);
        normal[o + 2] = to8(nz * 0.5 + 0.5);
        normal[o + 3] = 255;
        orm[o] = 255;
        orm[o + 1] = to8(this.rough[i]);
        orm[o + 2] = to8(this.metal[i]);
        orm[o + 3] = 255;
        if (emis) {
          emis[o] = to8(this.emissive[i * 3]);
          emis[o + 1] = to8(this.emissive[i * 3 + 1]);
          emis[o + 2] = to8(this.emissive[i * 3 + 2]);
          emis[o + 3] = 255;
        }
      }
    }
    const mk = (data, srgb, label) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.name = `${name}.${label}`;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.wrapS = t.wrapT = this.wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 8;
      t.needsUpdate = true;
      return t;
    };
    return {
      map: mk(albedo, true, 'albedo'),
      normalMap: mk(normal, false, 'normal'),
      ormMap: mk(orm, false, 'orm'),
      emissiveMap: emis ? mk(emis, true, 'emissive') : null,
      width: w,
      height: h,
    };
  }
}
