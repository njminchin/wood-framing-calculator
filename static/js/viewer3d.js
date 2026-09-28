import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { SPECIES, PINE, woodCanvas, defaultPaintingCanvas } from './textures.js';

const fmt = (v) => v.toFixed(1);

// Texture repeat sizes (mm covered by one tile of the 1024x256 wood canvas).
const GRAIN_ALONG = 400;
const GRAIN_ACROSS = 100;

/**
 * A 4-sided prism: `quad` is the outline in the XY plane, extruded from z0 to z1.
 * UVs run along `dir` so wood grain follows the length of each strip.
 * Face order: front(z1), back(z0), then the 4 sides. With `frontUV` (per-corner
 * UVs for the front) or `splitFront`, the front face uses material index 0 and
 * everything else index 1.
 */
function prismGeometry(quad, z0, z1, dir, { frontUV = null, uOffset = 0, splitFront = false } = {}) {
  const split = !!(frontUV || splitFront);
  let q = quad.map((p) => [p[0], p[1]]);
  let uvq = frontUV ? frontUV.slice() : null;
  let a2 = 0;
  for (let i = 0; i < 4; i++) a2 += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
  if (a2 < 0) { q = q.reverse(); if (uvq) uvq = uvq.reverse(); }

  const perp = [-dir[1], dir[0]];
  const along = (p) => (p[0] * dir[0] + p[1] * dir[1]) / GRAIN_ALONG + uOffset;
  const across = (p) => (p[0] * perp[0] + p[1] * perp[1]) / GRAIN_ACROSS;

  const pos = [], uv = [], groups = [];
  const pushQuad = (verts, uvs, mat) => {
    const start = pos.length / 3;
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      pos.push(...verts[idx]);
      uv.push(...uvs[idx]);
    }
    groups.push({ start, count: 6, mat });
  };

  // Front (z1) - CCW seen from +z
  pushQuad(
    q.map((p) => [p[0], p[1], z1]),
    uvq || q.map((p) => [along(p), across(p)]),
    0,
  );
  // Back (z0)
  const rq = q.slice().reverse();
  pushQuad(rq.map((p) => [p[0], p[1], z0]), rq.map((p) => [along(p), across(p)]), split ? 1 : 0);
  // Sides
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const edge = [b[0] - a[0], b[1] - a[1]];
    const el = Math.hypot(edge[0], edge[1]) || 1;
    const parallel = Math.abs((edge[0] * dir[0] + edge[1] * dir[1]) / el) > 0.7;
    const uvFor = (p, z) => (parallel ? [along(p), z / GRAIN_ACROSS] : [z / GRAIN_ALONG, across(p)]);
    pushQuad(
      [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]],
      [uvFor(a, z0), uvFor(b, z0), uvFor(b, z1), uvFor(a, z1)],
      split ? 1 : 0,
    );
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  groups.forEach((gr) => g.addGroup(gr.start, gr.count, gr.mat));
  g.computeVertexNormals();
  return g;
}

function makeLabel(text, cls = '') {
  const el = document.createElement('div');
  el.className = 'label3d ' + cls;
  el.textContent = text;
  return new CSS2DObject(el);
}

export class FrameViewer {
  constructor(container) {
    this.container = container;
    this.options = { showCanvas: true, showMeasurements: true, explode: false, blackCheapTop: false };
    this.textureCache = new Map();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 50000);
    this.camera.up.set(0, 1, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;

    this.scene.add(new THREE.HemisphereLight(0xfff6ea, 0x404550, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-600, 900, 1400);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    this.key = key;
    this.scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0xdde6ff, 0.7);
    fill.position.set(900, -300, 600);
    this.scene.add(fill);
    const back = new THREE.DirectionalLight(0xffffff, 0.8);
    back.position.set(0, 300, -1500);
    this.scene.add(back);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.defaultPaintingTex = this._canvasTexture(defaultPaintingCanvas());
    this.paintingTex = this.defaultPaintingTex;
    this.materials = {
      good: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 }),
      cheap: new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }),
      cheapTop: new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }),
      paintFront: new THREE.MeshStandardMaterial({ map: this.paintingTex, roughness: 0.85 }),
      canvasEdge: new THREE.MeshStandardMaterial({ color: 0xece6d8, roughness: 0.95 }),
      line: new THREE.LineBasicMaterial({ color: 0x2f6fde }),
    };
    this.setSpecies('walnut');
    this.materials.cheap.map = this._woodTexture('pine', PINE, 3);
    this._applyCheapTop();

    this._resize = () => this.resize();
    new ResizeObserver(this._resize).observe(container);
    this.resize();

    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  _canvasTexture(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return t;
  }

  _woodTexture(key, spec, seed) {
    if (!this.textureCache.has(key)) {
      const t = this._canvasTexture(woodCanvas(spec, seed));
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      this.textureCache.set(key, t);
    }
    return this.textureCache.get(key);
  }

  setSpecies(name) {
    const spec = SPECIES[name] || SPECIES.walnut;
    this.materials.good.map = this._woodTexture(name, spec, 11);
    this.materials.good.needsUpdate = true;
  }

  /** url: image URL, or null for the built-in default painting. */
  setImage(url) {
    if (this._imageUrl === url) return;
    this._imageUrl = url;
    if (!url) {
      this.materials.paintFront.map = this.defaultPaintingTex;
      this.materials.paintFront.needsUpdate = true;
      return;
    }
    new THREE.TextureLoader().load(url, (tex) => {
      if (this._imageUrl !== url) return;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.materials.paintFront.map = tex;
      this.materials.paintFront.needsUpdate = true;
    });
  }

  setOptions(opts) {
    Object.assign(this.options, opts);
    if (this.canvasMesh) this.canvasMesh.visible = this.options.showCanvas;
    if (this.paintingLabels) this.paintingLabels.visible = this.options.showCanvas && this.options.showMeasurements;
    if (this.measure) this.measure.visible = this.options.showMeasurements;
    if ('explode' in opts) this._applyExplode();
    if ('blackCheapTop' in opts) this._applyCheapTop();
  }

  // Front face of the cheap strips (seen in the gap around the painting): bare pine or matt black paint.
  _applyCheapTop() {
    const m = this.materials.cheapTop;
    if (this.options.blackCheapTop) {
      m.map = null;
      m.color.set(0x141414);
      m.roughness = 0.9;
    } else {
      m.map = this.materials.cheap.map;
      m.color.set(0xffffff);
      m.roughness = 0.8;
    }
    m.needsUpdate = true;
  }

  _applyExplode() {
    if (!this.stripMeshes) return;
    const e = this.options.explode ? 1 : 0;
    for (const { mesh, strip, layer } of this.stripMeshes) {
      const out = layer === 'good' ? 60 : 25;
      mesh.position.set(strip.normal[0] * out * e, strip.normal[1] * out * e, layer === 'cheap' ? -40 * e : 0);
    }
    if (this.canvasMesh) this.canvasMesh.position.z = 70 * e;
  }

  _clear() {
    this.root.traverse((o) => {
      if (o.isCSS2DObject) o.element.remove();
      if (o.geometry) o.geometry.dispose();
    });
    this.root.clear();
  }

  /** Rebuild the model from a computeFrame() result. */
  update(frame) {
    const first = !this.frame;
    this.frame = frame;
    this._clear();
    if (!frame || !frame.ok) return;

    this.stripMeshes = [];
    frame.strips.forEach((strip, i) => {
      for (const layer of ['good', 'cheap']) {
        const s = strip[layer];
        const cheap = layer === 'cheap';
        const geo = prismGeometry(s.poly, s.z0, s.z1, strip.dir, { uOffset: i * 0.37 + (cheap ? 0.5 : 0), splitFront: cheap });
        const mesh = new THREE.Mesh(geo, cheap ? [this.materials.cheapTop, this.materials.cheap] : this.materials.good);
        mesh.castShadow = mesh.receiveShadow = true;
        this.root.add(mesh);
        this.stripMeshes.push({ mesh, strip, layer });
      }
    });

    // Painting
    const q = frame.quad.pts;
    const pgeo = prismGeometry(q, frame.painting.z0, frame.painting.z1, [1, 0], {
      frontUV: [[0, 0], [1, 0], [1, 1], [0, 1]], // BL, BR, TR, TL
    });
    this.canvasMesh = new THREE.Mesh(pgeo, [this.materials.paintFront, this.materials.canvasEdge]);
    this.canvasMesh.castShadow = this.canvasMesh.receiveShadow = true;
    this.canvasMesh.visible = this.options.showCanvas;
    this.root.add(this.canvasMesh);

    this._buildMeasurements(frame);
    this._applyExplode();

    // Light / shadow camera sized to the model
    const size = Math.max(frame.outerSize.top, frame.outerSize.left);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -size; sc.right = sc.top = size;
    sc.near = 10; sc.far = 6000;
    sc.updateProjectionMatrix();

    if (first) this.setView('iso');
  }

  _buildMeasurements(frame) {
    const m = new THREE.Group();
    const pts = [];
    const zTop = frame.layers.good.z1;
    const outer = frame.polys.good.outer;
    const off = 30;

    frame.strips.forEach((strip) => {
      const [i, j] = strip.corners;
      const n = strip.normal;
      const a = outer[i], b = outer[j];
      const a2 = [a[0] + n[0] * off, a[1] + n[1] * off], b2 = [b[0] + n[0] * off, b[1] + n[1] * off];
      const a3 = [a[0] + n[0] * (off + 6), a[1] + n[1] * (off + 6)], b3 = [b[0] + n[0] * (off + 6), b[1] + n[1] * (off + 6)];
      // extension lines + dimension line
      pts.push(a[0] + n[0] * 4, a[1] + n[1] * 4, zTop, a3[0], a3[1], zTop);
      pts.push(b[0] + n[0] * 4, b[1] + n[1] * 4, zTop, b3[0], b3[1], zTop);
      pts.push(a2[0], a2[1], zTop, b2[0], b2[1], zTop);
      const label = makeLabel(`${strip.name}: ${fmt(strip.good.longPoint)}`, 'dim');
      label.position.set((a2[0] + b2[0]) / 2 + n[0] * 14, (a2[1] + b2[1]) / 2 + n[1] * 14, zTop);
      m.add(label);
    });

    // Corner angles
    frame.corners.forEach((c) => {
      const p = outer[c.index];
      const q = frame.quad.pts[c.index];
      const d = [p[0] - q[0], p[1] - q[1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      const label = makeLabel(`${c.key} ${c.angle.toFixed(2)}°`, 'angle');
      label.position.set(p[0] + (d[0] / l) * 34, p[1] + (d[1] / l) * 34, zTop);
      m.add(label);
    });

    // Good wood width (depth direction) at the bottom-right corner
    const br = outer[1];
    const { z0, z1 } = frame.layers.good;
    const dx = 22;
    pts.push(br[0] + dx, br[1], z0, br[0] + dx, br[1], z1);
    pts.push(br[0] + 4, br[1], z0, br[0] + dx + 5, br[1], z0);
    pts.push(br[0] + 4, br[1], z1, br[0] + dx + 5, br[1], z1);
    const wl = makeLabel(`Good wood width ${fmt(frame.goodWidth)}`, 'dim small');
    wl.position.set(br[0] + dx + 8, br[1], (z0 + z1) / 2);
    wl.center.set(0, 0.5);
    m.add(wl);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    m.add(new THREE.LineSegments(geo, this.materials.line));
    m.visible = this.options.showMeasurements;
    this.measure = m;
    this.root.add(m);

    // Painting size labels on the canvas face
    const pl = new THREE.Group();
    const qp = frame.quad.pts, zf = frame.painting.z1 + 0.5;
    const inset = 24;
    frame.strips.forEach((strip) => {
      const [i, j] = strip.corners;
      const mid = [(qp[i][0] + qp[j][0]) / 2 - strip.normal[0] * inset, (qp[i][1] + qp[j][1]) / 2 - strip.normal[1] * inset];
      const l = makeLabel(`${strip.name[0]} ${fmt(strip.paintingLength)}`, 'paint');
      l.position.set(mid[0], mid[1], zf);
      pl.add(l);
    });
    pl.visible = this.options.showCanvas && this.options.showMeasurements;
    this.paintingLabels = pl;
    this.root.add(pl);
  }

  setView(which) {
    const f = this.frame;
    const size = f && f.ok ? Math.max(f.outerSize.top, f.outerSize.left) : 800;
    const dist = (size / 2 / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.45;
    const target = new THREE.Vector3(0, 0, f && f.ok ? f.totalDepth / 2 : 0);
    const dirs = {
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, -1),
      iso: new THREE.Vector3(-0.55, 0.35, 1).normalize(),
      corner: new THREE.Vector3(0.9, -0.55, 0.45).normalize(),
    };
    const d = dirs[which] || dirs.iso;
    const k = which === 'corner' ? 0.45 : 1;
    this.controls.target.copy(which === 'corner' && f && f.ok
      ? new THREE.Vector3(f.polys.good.outer[1][0], f.polys.good.outer[1][1], f.totalDepth / 2)
      : target);
    this.camera.position.copy(this.controls.target).addScaledVector(d, dist * k);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  snapshot() {
    return this.renderer.domElement.toDataURL('image/png');
  }
}

