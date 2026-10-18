import * as THREE from 'three';
import * as S from './shaders.js';
import { makeNoise3D } from './lights.js';

export const NS = 4; // shadowed volumetric spot lights
export const NP = 24; // analytic fog point lights
export const NV = 4; // local fog density volumes

export const LAYER = {
  WORLD: 0, // opaque world, also rendered into reflections
  MIRROR: 1, // wet ground / water: receive the planar reflection, not rendered into it
  GLASS: 2, // refractive transparent surfaces (sample the opaque buffer)
  GLOW: 3, // additive / transparent emissive things (holograms), also reflected
};

class FSQuad {
  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.mesh.frustumCulled = false;
  }
  render(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.camera);
  }
}

function pass(frag, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: S.FS_VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

function rt(w, h, opts = {}) {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    ...opts,
  });
  t.texture.generateMipmaps = false;
  return t;
}

export class Pipeline {
  constructor(renderer, scene, camera, lights) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.lights = lights;
    this.quad = new FSQuad();
    this.postScene = new THREE.Scene(); // rain etc., drawn after the fog composite
    this.params = {
      fog: true,
      dof: true,
      bloom: 0.085,
      exposure: 1.0,
      focus: 14,
      focusRange: 1.2,
      nearK: 1.0,
      farK: 0.32,
      maxCoc: 20,
      ca: 0.012,
      grain: 0.045,
      vignette: 0.42,
      saturation: 1.08,
      contrast: 1.04,
      lift: new THREE.Color(0.012, 0.024, 0.04),
      gain: new THREE.Color(1.02, 0.99, 0.95),
      reflectionFog: 0.018,
      reflectionFogColor: new THREE.Color(0x0b1a22),
      fogDensity: 0.022,
      fogFalloff: 0.085,
      fogBase: 0.0,
      fogNoise: 0.75,
      fogNoiseScale: 0.035,
      fogMaxDist: 120,
      fogExtinction: 1.0,
      fogPointScale: 1.0,
      fogSpotScale: 1.0,
      groundFog: 0.03,
      groundFogHeight: 1.2,
      skyFog: 0.06,
      wind: new THREE.Vector3(0.012, 0.002, 0.004),
      ambLow: new THREE.Color(0.05, 0.11, 0.15),
      ambHigh: new THREE.Color(0.06, 0.08, 0.14),
      ambFar: new THREE.Color(0.11, 0.12, 0.16),
      debug: 0,
    };

    this.reflPlaneY = -0.04;
    this.reflCam = new THREE.PerspectiveCamera();
    this.reflCam.layers.set(LAYER.WORLD);
    this.reflCam.layers.enable(LAYER.GLOW);
    this.reflMatrix = new THREE.Matrix4();
    this.noise3D = makeNoise3D(64, 11);

    // Uniforms shared (by reference) with world materials.
    this.shared = {
      tReflSharp: { value: null },
      tReflBlur: { value: null },
      uReflMatrix: { value: this.reflMatrix },
      tOpaque: { value: null },
      tSceneDepth: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uNear: { value: camera.near },
      uFar: { value: camera.far },
      tNoise3D: { value: this.noise3D },
    };

    this.scene.fog = new THREE.FogExp2(this.params.reflectionFogColor, 0);

    // A real (uploaded) comparison depth texture for unused shadow slots.
    const dummyDepth = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    dummyDepth.compareFunction = THREE.LessEqualCompare;
    dummyDepth.minFilter = dummyDepth.magFilter = THREE.LinearFilter;
    this.dummyShadowRT = new THREE.WebGLRenderTarget(1, 1, { depthTexture: dummyDepth, depthBuffer: true });
    renderer.setRenderTarget(this.dummyShadowRT);
    renderer.clear();
    renderer.setRenderTarget(null);
    this.dummyShadow = dummyDepth;
    this._buildMaterials();
    this.setSize(1280, 536);
  }

  _buildMaterials() {
    const P = this.params;
    this.mCopy = pass(S.COPY_FRAG, { tSrc: { value: null } });
    this.mDepthDown = pass(S.DEPTH_DOWN_FRAG, {
      tDepth: { value: null },
      uSrcTexel: { value: new THREE.Vector2() },
      uNear: this.shared.uNear,
      uFar: this.shared.uFar,
    });

    const spotUniforms = {};
    for (let i = 0; i < NS; i++) spotUniforms[`tSpotShadow${i}`] = { value: this.dummyShadow };
    this.mFog = pass(S.fogFrag(NS, NP, NV, 40), {
      tDepth: { value: null },
      tNoise: { value: this.noise3D },
      uProjInv: { value: new THREE.Matrix4() },
      uViewInv: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uTime: this.shared.uTime,
      uFogA: { value: new THREE.Vector4() },
      uFogB: { value: new THREE.Vector4() },
      uFogC: { value: new THREE.Vector4() },
      uWind: { value: P.wind },
      uAmbLow: { value: P.ambLow },
      uAmbHigh: { value: P.ambHigh },
      uAmbFar: { value: P.ambFar },
      uSpotPos: { value: Array.from({ length: NS }, () => new THREE.Vector3()) },
      uSpotDir: { value: Array.from({ length: NS }, () => new THREE.Vector3(0, -1, 0)) },
      uSpotCol: { value: Array.from({ length: NS }, () => new THREE.Vector3()) },
      uSpotP: { value: Array.from({ length: NS }, () => new THREE.Vector4(1, 1, 1, 0)) },
      uSpotMat: { value: Array.from({ length: NS }, () => new THREE.Matrix4()) },
      uSpotShadowOn: { value: new Array(NS).fill(0) },
      uPtPos: { value: Array.from({ length: NP }, () => new THREE.Vector3()) },
      uPtCol: { value: Array.from({ length: NP }, () => new THREE.Vector4()) },
      uVolPos: { value: Array.from({ length: NV }, () => new THREE.Vector4()) },
      uVolRad: { value: Array.from({ length: NV }, () => new THREE.Vector4(1, 1, 1, 0)) },
      ...spotUniforms,
    });
    this.volumes = []; // {center: Vector3, radius: Vector3, density, rise}

    this.mBilateral = pass(S.BILATERAL_FRAG, {
      tSrc: { value: null },
      tDepth: { value: null },
      uDir: { value: new THREE.Vector2() },
    });
    this.mFogComposite = pass(S.FOG_COMPOSITE_FRAG, {
      tScene: { value: null },
      tDepth: { value: null },
      tFog: { value: null },
      tFogDepth: { value: null },
      uFogRes: { value: new THREE.Vector2() },
      uNear: this.shared.uNear,
      uFar: this.shared.uFar,
      uFogOn: { value: 1 },
    });

    const coc = {
      uFocus: { value: P.focus },
      uFocusRange: { value: P.focusRange },
      uNearK: { value: P.nearK },
      uFarK: { value: P.farK },
      uMaxCoc: { value: P.maxCoc },
    };
    this.cocUniforms = coc;
    this.mDofPre = pass(S.DOF_PRE_FRAG, {
      ...coc,
      tColor: { value: null },
      tDepth: { value: null },
      uNear: this.shared.uNear,
      uFar: this.shared.uFar,
      uSrcTexel: { value: new THREE.Vector2() },
    });
    this.mDofGather = pass(S.DOF_GATHER_FRAG, {
      tPre: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uMaxCoc: coc.uMaxCoc,
      uRadScale: { value: 0.9 },
    });
    this.mDofComposite = pass(S.DOF_COMPOSITE_FRAG, {
      ...coc,
      tColor: { value: null },
      tBlur: { value: null },
      tDepth: { value: null },
      uNear: this.shared.uNear,
      uFar: this.shared.uFar,
      uDofOn: { value: 1 },
    });

    this.mBloomDown = pass(S.BLOOM_DOWN_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uKaris: { value: 0 },
    });
    this.mBloomUp = pass(S.BLOOM_UP_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1 },
    });
    this.mBloomUp.blending = THREE.CustomBlending;
    this.mBloomUp.blendEquation = THREE.AddEquation;
    this.mBloomUp.blendSrc = THREE.OneFactor;
    this.mBloomUp.blendDst = THREE.OneFactor;
    this.mBloomUp.transparent = true;

    this.mFinal = pass(S.FINAL_FRAG, {
      tColor: { value: null },
      tBloom: { value: null },
      uExposure: { value: P.exposure },
      uBloom: { value: P.bloom },
      uCA: { value: P.ca },
      uGrain: { value: P.grain },
      uVignette: { value: P.vignette },
      uTime: this.shared.uTime,
      uLift: { value: P.lift },
      uGain: { value: P.gain },
      uSaturation: { value: P.saturation },
      uContrast: { value: P.contrast },
      uDebug: { value: 0 },
    });
  }

  setSize(w, h) {
    w = Math.max(64, Math.floor(w / 2) * 2);
    h = Math.max(64, Math.floor(h / 2) * 2);
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    const dispose = (t) => t && t.dispose();
    [
      this.mainRT,
      this.opaqueRT,
      this.reflRT,
      this.reflBlurA,
      this.reflBlurB,
      this.depthHalfRT,
      this.fogRT,
      this.fogTmpRT,
      this.hdrRT,
      this.dofPreRT,
      this.dofBlurRT,
      this.postRT,
      ...(this.bloomMips || []),
    ].forEach(dispose);

    const hw = w >> 1;
    const hh = h >> 1;
    this.mainRT = rt(w, h, {
      samples: 4,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType),
    });
    this.opaqueRT = rt(w, h);
    this.reflRT = rt(hw, hh, { depthBuffer: true, samples: 2 });
    this.reflBlurA = rt(hw >> 1, hh >> 1);
    this.reflBlurB = rt(hw >> 1, hh >> 1);
    this.depthHalfRT = rt(hw, hh, { format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.fogRT = rt(hw, hh);
    this.fogTmpRT = rt(hw, hh);
    this.hdrRT = rt(w, h);
    this.dofPreRT = rt(hw, hh);
    this.dofBlurRT = rt(hw, hh);
    this.postRT = rt(w, h);
    this.bloomMips = [];
    let bw = hw;
    let bh = hh;
    for (let i = 0; i < 6; i++) {
      this.bloomMips.push(rt(Math.max(bw, 2), Math.max(bh, 2)));
      bw >>= 1;
      bh >>= 1;
    }

    this.shared.tReflSharp.value = this.reflRT.texture;
    this.shared.tReflBlur.value = this.reflBlurB.texture;
    this.shared.tOpaque.value = this.opaqueRT.texture;
    this.shared.tSceneDepth.value = this.mainRT.depthTexture;
    this.shared.uResolution.value.set(w, h);
  }

  addVolume(center, radius, density, rise = 0.15) {
    const v = { center, radius, density, rise };
    this.volumes.push(v);
    return v;
  }

  _updateReflection() {
    const cam = this.camera;
    const n = new THREE.Vector3(0, 1, 0);
    const planePoint = new THREE.Vector3(0, this.reflPlaneY, 0);
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const rot = new THREE.Matrix4().extractRotation(cam.matrixWorld);
    const view = planePoint.clone().sub(camPos).reflect(n).negate().add(planePoint);
    const lookAt = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
    const target = planePoint.clone().sub(lookAt).reflect(n).negate().add(planePoint);
    const rc = this.reflCam;
    rc.position.copy(view);
    rc.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
    rc.lookAt(target);
    rc.near = cam.near;
    rc.far = cam.far;
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(cam.projectionMatrix);

    this.reflMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.reflMatrix.multiply(rc.projectionMatrix);
    this.reflMatrix.multiply(rc.matrixWorldInverse);

    // oblique near plane clipping (Lengyel)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, planePoint);
    plane.applyMatrix4(rc.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = rc.projectionMatrix;
    const q = new THREE.Vector4(
      (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0],
      (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5],
      -1.0,
      (1.0 + pm.elements[10]) / pm.elements[14]
    );
    clip.multiplyScalar(2.0 / clip.dot(q));
    pm.elements[2] = clip.x;
    pm.elements[6] = clip.y;
    pm.elements[10] = clip.z + 1.0;
    pm.elements[14] = clip.w;
    rc.projectionMatrixInverse.copy(pm).invert();
  }

  _updateFogUniforms() {
    const P = this.params;
    const u = this.mFog.uniforms;
    const cam = this.camera;
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uViewInv.value.copy(cam.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    u.uFogA.value.set(P.fogDensity, P.fogFalloff, P.fogBase, P.fogNoise);
    u.uFogB.value.set(P.fogNoiseScale, P.fogMaxDist, P.fogExtinction, P.fogPointScale);
    u.uFogC.value.set(P.fogSpotScale, P.groundFog, P.groundFogHeight, P.skyFog);

    const spots = this.lights.spots;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < NS; i++) {
      const s = spots[i];
      const l = s && s.light;
      if (!l || !l.visible || l.intensity <= 0 || s.fog <= 0) {
        u.uSpotCol.value[i].set(0, 0, 0);
        u.uSpotP.value[i].set(1, 1, 0.001, 0);
        u.uSpotShadowOn.value[i] = 0;
        u[`tSpotShadow${i}`].value = this.dummyShadow;
        continue;
      }
      l.updateMatrixWorld();
      l.target.updateMatrixWorld();
      const pos = u.uSpotPos.value[i].setFromMatrixPosition(l.matrixWorld);
      tmp.setFromMatrixPosition(l.target.matrixWorld);
      u.uSpotDir.value[i].copy(tmp).sub(pos).normalize();
      const k = l.intensity * s.fog;
      u.uSpotCol.value[i].set(l.color.r * k, l.color.g * k, l.color.b * k);
      u.uSpotP.value[i].set(Math.cos(l.angle), Math.cos(l.angle * (1 - l.penumbra)), l.distance || 60, s.g);
      const hasShadow = l.castShadow && l.shadow.map && l.shadow.map.depthTexture;
      u.uSpotShadowOn.value[i] = hasShadow ? 1 : 0;
      if (hasShadow) {
        u.uSpotMat.value[i].copy(l.shadow.matrix);
        u[`tSpotShadow${i}`].value = l.shadow.map.depthTexture;
      } else {
        u[`tSpotShadow${i}`].value = this.dummyShadow;
      }
    }

    const fl = this.lights.fogList;
    for (let i = 0; i < NP; i++) {
      const v = fl[i];
      if (!v) {
        u.uPtCol.value[i].set(0, 0, 0, 1);
        continue;
      }
      u.uPtPos.value[i].copy(v.position);
      const k = v.intensity * v.k * v.fog;
      u.uPtCol.value[i].set(v.color.r * k, v.color.g * k, v.color.b * k, v.range * 1.5);
    }

    for (let i = 0; i < NV; i++) {
      const v = this.volumes[i];
      if (!v || v.density <= 0) {
        u.uVolPos.value[i].set(0, 0, 0, 0);
        continue;
      }
      u.uVolPos.value[i].set(v.center.x, v.center.y, v.center.z, v.density);
      u.uVolRad.value[i].set(v.radius.x, v.radius.y, v.radius.z, v.rise);
    }
  }

  render(time) {
    const r = this.renderer;
    const P = this.params;
    const cam = this.camera;
    const scene = this.scene;
    this.shared.uTime.value = time;
    this.shared.uNear.value = cam.near;
    this.shared.uFar.value = cam.far;
    cam.updateMatrixWorld();
    r.autoClear = false;
    r.setClearColor(0x000000, 1);

    // 1) planar reflection (also triggers the shadow maps for this frame)
    this._updateReflection();
    scene.fog.density = P.reflectionFog;
    scene.fog.color.copy(P.reflectionFogColor);
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.reflRT);
    r.clear();
    r.render(scene, this.reflCam);
    scene.fog.density = 0;

    // anisotropic (vertically stretched) blur for wet-street streaks
    const bw = this.reflBlurA.width;
    const bh = this.reflBlurA.height;
    this.mBilateralNoDepth ||= pass(
      /* glsl */ `
      uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
      void main(){ vec4 a=vec4(0.); float ws=0.;
        for(int k=-6;k<=6;k++){ float w=exp(-float(k*k)/18.); a+=texture2D(tSrc,vUv+uDir*float(k))*w; ws+=w; }
        gl_FragColor=a/ws; }`,
      { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }
    );
    const mb = this.mBilateralNoDepth;
    mb.uniforms.tSrc.value = this.reflRT.texture;
    mb.uniforms.uDir.value.set(1.2 / bw, 0);
    this.quad.render(r, mb, this.reflBlurA);
    mb.uniforms.tSrc.value = this.reflBlurA.texture;
    mb.uniforms.uDir.value.set(0, 3.2 / bh);
    this.quad.render(r, mb, this.reflBlurB);

    // 2) main opaque pass
    cam.layers.set(LAYER.WORLD);
    cam.layers.enable(LAYER.MIRROR);
    r.setRenderTarget(this.mainRT);
    r.clear();
    r.render(scene, cam);

    // 3) copy for refraction, then glass + glow layers
    this.mCopy.uniforms.tSrc.value = this.mainRT.texture;
    this.quad.render(r, this.mCopy, this.opaqueRT);
    cam.layers.set(LAYER.GLASS);
    cam.layers.enable(LAYER.GLOW);
    r.setRenderTarget(this.mainRT);
    r.render(scene, cam);
    cam.layers.enableAll();

    // 4) volumetric fog at half resolution
    const hw = this.depthHalfRT.width;
    const hh = this.depthHalfRT.height;
    this.mDepthDown.uniforms.tDepth.value = this.mainRT.depthTexture;
    this.mDepthDown.uniforms.uSrcTexel.value.set(1 / this.w, 1 / this.h);
    this.quad.render(r, this.mDepthDown, this.depthHalfRT);

    if (P.fog) {
      this._updateFogUniforms();
      this.mFog.uniforms.tDepth.value = this.depthHalfRT.texture;
      this.quad.render(r, this.mFog, this.fogRT);
      const mbl = this.mBilateral;
      mbl.uniforms.tDepth.value = this.depthHalfRT.texture;
      mbl.uniforms.tSrc.value = this.fogRT.texture;
      mbl.uniforms.uDir.value.set(1 / hw, 0);
      this.quad.render(r, mbl, this.fogTmpRT);
      mbl.uniforms.tSrc.value = this.fogTmpRT.texture;
      mbl.uniforms.uDir.value.set(0, 1 / hh);
      this.quad.render(r, mbl, this.fogRT);
    }

    const fc = this.mFogComposite.uniforms;
    fc.tScene.value = this.mainRT.texture;
    fc.tDepth.value = this.mainRT.depthTexture;
    fc.tFog.value = this.fogRT.texture;
    fc.tFogDepth.value = this.depthHalfRT.texture;
    fc.uFogRes.value.set(hw, hh);
    fc.uFogOn.value = P.fog ? 1 : 0;
    this.quad.render(r, this.mFogComposite, this.hdrRT);

    // 6) depth of field
    const cu = this.cocUniforms;
    cu.uFocus.value = P.focus;
    cu.uFocusRange.value = P.focusRange;
    cu.uNearK.value = P.nearK;
    cu.uFarK.value = P.farK;
    cu.uMaxCoc.value = P.maxCoc;
    let postSrc = this.hdrRT;
    if (P.dof) {
      const pre = this.mDofPre.uniforms;
      pre.tColor.value = this.hdrRT.texture;
      pre.tDepth.value = this.mainRT.depthTexture;
      pre.uSrcTexel.value.set(1 / this.w, 1 / this.h);
      this.quad.render(r, this.mDofPre, this.dofPreRT);
      const g = this.mDofGather.uniforms;
      g.tPre.value = this.dofPreRT.texture;
      g.uTexel.value.set(1 / hw, 1 / hh);
      this.quad.render(r, this.mDofGather, this.dofBlurRT);
      const c = this.mDofComposite.uniforms;
      c.tColor.value = this.hdrRT.texture;
      c.tBlur.value = this.dofBlurRT.texture;
      c.tDepth.value = this.mainRT.depthTexture;
      c.uDofOn.value = 1;
      this.quad.render(r, this.mDofComposite, this.postRT);
      postSrc = this.postRT;
    }

    // rain & particles after DOF: they carry their own depth (manual test
    // against the scene depth), so they must not inherit the background's blur
    r.setRenderTarget(postSrc);
    r.render(this.postScene, cam);

    // 7) bloom
    const mips = this.bloomMips;
    let src = postSrc;
    for (let i = 0; i < mips.length; i++) {
      const d = this.mBloomDown.uniforms;
      d.tSrc.value = src.texture;
      d.uTexel.value.set(1 / src.width, 1 / src.height);
      d.uKaris.value = i === 0 ? 1 : 0;
      this.quad.render(r, this.mBloomDown, mips[i]);
      src = mips[i];
    }
    for (let i = mips.length - 1; i > 0; i--) {
      const u = this.mBloomUp.uniforms;
      u.tSrc.value = mips[i].texture;
      u.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      u.uRadius.value = 1.0;
      this.quad.render(r, this.mBloomUp, mips[i - 1]);
    }

    // 8) final grade to screen
    const f = this.mFinal.uniforms;
    f.tColor.value = postSrc.texture;
    f.tBloom.value = mips[0].texture;
    f.uExposure.value = P.exposure;
    f.uBloom.value = P.bloom;
    f.uCA.value = P.ca;
    f.uGrain.value = P.grain;
    f.uVignette.value = P.vignette;
    f.uSaturation.value = P.saturation;
    f.uContrast.value = P.contrast;
    f.uDebug.value = P.debug;
    if (P.debugTex) {
      const t = { refl: this.reflRT, reflBlur: this.reflBlurB, fog: this.fogRT, opaque: this.opaqueRT, main: this.mainRT, dof: this.dofBlurRT }[P.debugTex];
      this.mCopy.uniforms.tSrc.value = t.texture;
      this.quad.render(r, this.mCopy, null);
      return;
    }
    this.quad.render(r, this.mFinal, null);
  }
}
