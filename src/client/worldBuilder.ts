import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CIPHER_SYMBOLS,
  computeIrrigationGauges,
  DOOR_KEY_REQUIREMENTS,
  ITEMS,
  SOLUTIONS,
  WORLD_CLUES,
} from '../shared/puzzles.js';
import type { BoxCollider } from '../shared/worldLayout.js';
import type {
  CardinalDir,
  CipherSymbol,
  CoopPing,
  DoorId,
  HarpColor,
  ItemId,
  PlayerInfo,
  WorldPuzzleStates,
  WorldState,
} from '../shared/types.js';
import { FLOOR_PLATES, OBSERVATORY_DECK, SKYLIFT_RAMP } from '../shared/worldLayout.js';
import {
  getTextures,
  HARP_HEX,
  makeGaugeTexture,
  makeNameTexture,
  makeNumberRing,
  makePlaqueTexture,
  makeSymbolTexture,
  UV_FRAME_SIZES,
} from './textures.js';

// ============================================================
// Public contract
// ============================================================
export interface InteractableObject {
  id: string;
  mesh: THREE.Object3D;
  label: string;
  actionType: 'modal' | 'clue' | 'door' | 'pickup' | 'direct';
  modalId?: string;
  clueId?: string;
  doorId?: DoorId;
  itemId?: ItemId;
  maxDistance?: number;
  // Optional dynamic label getter based on state
  getLabel?: (state: WorldState) => string | null; // null = currently not interactable
}

export interface BuiltWorld {
  scene: THREE.Scene;
  interactables: InteractableObject[];
  uvFrames: {
    index: number;
    mesh: THREE.Mesh;
    uvMat: THREE.MeshStandardMaterial;
    normalMat: THREE.MeshStandardMaterial;
    worldPos: THREE.Vector3;
  }[];
  updateFromState: (state: WorldState, myPlayerId: string, dt: number, elapsed: number) => void;
  setLocalUvLight: (camera: THREE.Camera, enabled: boolean) => void;
}

// ============================================================
// Small math helpers
// ============================================================
const TAU = Math.PI * 2;

function damp(cur: number, target: number, lambda: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

function dampAngle(cur: number, target: number, lambda: number, dt: number): number {
  let d = (target - cur) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return cur + d * (1 - Math.exp(-lambda * dt));
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Excludes an object from every raycast (glass, sprites, particles, beams...). */
function noRay<T extends THREE.Object3D>(o: T): T {
  o.raycast = () => {};
  return o;
}

// ============================================================
// Geometry kit: primitives that end up merged per material
// ============================================================
type Sink = (geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4) => void;

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

function normalizeGeo(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  }
  return g;
}

function scaleUv(geo: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

class Kit {
  constructor(
    private sink: Sink,
    private base: THREE.Matrix4 = new THREE.Matrix4(),
  ) {}

  at(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0): Kit {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
      new THREE.Vector3(1, 1, 1),
    );
    return new Kit(this.sink, this.base.clone().multiply(m));
  }

  put(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    sx = 1,
    sy = sx,
    sz = sx,
  ): void {
    const m = new THREE.Matrix4().compose(
      _v.set(x, y, z),
      _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')),
      _s.set(sx, sy, sz),
    );
    this.sink(geo, mat, this.base.clone().multiply(m));
  }

  /** Box whose `y` is its BOTTOM face; UVs are in metres. */
  box(mat: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): void {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.getAttribute('uv');
    const dims: [number, number][] = [
      [d, h],
      [d, h],
      [w, d],
      [w, d],
      [w, h],
      [w, h],
    ];
    for (let f = 0; f < 6; f++) {
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
      }
    }
    this.put(g, mat, x, y + h / 2, z, rx, ry, rz);
  }

  /** Vertical cylinder whose `y` is its BOTTOM. */
  cyl(mat: THREE.Material, rt: number, rb: number, h: number, x = 0, y = 0, z = 0, seg = 18, open = false): void {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
    scaleUv(g, TAU * Math.max(rt, rb), h);
    this.put(g, mat, x, y + h / 2, z);
  }

  /** Cylinder between two arbitrary points. */
  rod(mat: THREE.Material, r: number, a: [number, number, number], b: [number, number, number], seg = 8): void {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    scaleUv(g, TAU * r, len);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      vb.clone().sub(va).normalize(),
    );
    const m = new THREE.Matrix4().compose(va.add(vb).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    this.sink(g, mat, this.base.clone().multiply(m));
  }

  sph(mat: THREE.Material, r: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, seg = 16): void {
    this.put(new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.65))), mat, x, y, z, 0, 0, 0, sx, sy, sz);
  }

  ico(mat: THREE.Material, r: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, detail = 1): void {
    this.put(new THREE.IcosahedronGeometry(r, detail), mat, x, y, z, 0, x + z, 0, sx, sy, sz);
  }

  cone(mat: THREE.Material, r: number, h: number, x = 0, y = 0, z = 0, seg = 14, rx = 0, ry = 0, rz = 0): void {
    this.put(new THREE.ConeGeometry(r, h, seg), mat, x, y + h / 2, z, rx, ry, rz);
  }

  torus(mat: THREE.Material, r: number, tube: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, seg = 36, arc = TAU): void {
    this.put(new THREE.TorusGeometry(r, tube, 10, seg, arc), mat, x, y, z, rx, ry, rz);
  }

  /** Plane facing +Z with 0..1 UVs (painted textures). */
  panel(mat: THREE.Material, w: number, h: number, x = 0, y = 0, z = 0, ry = 0, rx = 0): void {
    this.put(new THREE.PlaneGeometry(w, h), mat, x, y, z, rx, ry);
  }

  /** Flat disc facing up with 0..1 UVs; canvas-top points to -Z (north). */
  disc(mat: THREE.Material, r: number, x = 0, y = 0, z = 0, seg = 40): void {
    this.put(new THREE.CircleGeometry(r, seg), mat, x, y, z, -Math.PI / 2);
  }

  /** Horizontal floor rectangle (UVs in metres, world aligned). */
  floor(mat: THREE.Material, x0: number, x1: number, z0: number, z1: number, y: number, up = true): void {
    const g = new THREE.BufferGeometry();
    const p = up
      ? [x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z1, x1, y, z0, x0, y, z0]
      : [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
    const uv: number[] = [];
    for (let i = 0; i < 6; i++) uv.push(p[i * 3], -p[i * 3 + 2]);
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    this.put(g, mat);
  }

  /** Arbitrary planar quad (a,b,c,d counter-clockwise), UVs in metres. */
  quad(mat: THREE.Material, a: number[], b: number[], c: number[], d: number[]): void {
    const va = new THREE.Vector3(...(a as [number, number, number]));
    const vb = new THREE.Vector3(...(b as [number, number, number]));
    const vd = new THREE.Vector3(...(d as [number, number, number]));
    const u = vb.clone().sub(va);
    const v = vd.clone().sub(va);
    const un = u.clone().normalize();
    const nn = u.clone().cross(v).normalize();
    const vn = nn.clone().cross(un);
    const uvOf = (p: number[]): [number, number] => {
      const q = new THREE.Vector3(...(p as [number, number, number])).sub(va);
      return [q.dot(un), q.dot(vn)];
    };
    const g = new THREE.BufferGeometry();
    const tri = [a, b, c, a, c, d];
    g.setAttribute('position', new THREE.Float32BufferAttribute(tri.flat(), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(tri.flatMap(uvOf), 2));
    g.computeVertexNormals();
    this.put(g, mat);
  }
}

function buildMerged(entries: Map<THREE.Material, THREE.BufferGeometry[]>): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const [mat, geos] of entries) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    const transparent = mat.transparent;
    mesh.castShadow = !transparent && !mat.userData.noCast;
    mesh.receiveShadow = !mat.userData.noReceive;
    if (mat.userData.noRay) noRay(mesh);
    out.push(mesh);
  }
  return out;
}

class Batcher {
  private zones = new Map<string, Map<THREE.Material, THREE.BufferGeometry[]>>();

  kit(zone: string): Kit {
    let entries = this.zones.get(zone);
    if (!entries) {
      entries = new Map();
      this.zones.set(zone, entries);
    }
    return new Kit(collect(entries));
  }

  flush(scene: THREE.Scene): void {
    for (const [zone, entries] of this.zones) {
      for (const mesh of buildMerged(entries)) {
        mesh.name = `static_${zone}`;
        mesh.matrixAutoUpdate = false;
        scene.add(mesh);
      }
    }
    this.zones.clear();
  }
}

function collect(entries: Map<THREE.Material, THREE.BufferGeometry[]>): Sink {
  return (geo, mat, m) => {
    const g = normalizeGeo(geo).clone();
    g.applyMatrix4(m);
    const list = entries.get(mat);
    if (list) list.push(g);
    else entries.set(mat, [g]);
  };
}

/** Dynamic group: geometry is merged per material inside the returned group. */
function group(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  ry: number,
  build?: (k: Kit) => void,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.order = 'YXZ';
  g.rotation.y = ry;
  if (build) {
    const entries = new Map<THREE.Material, THREE.BufferGeometry[]>();
    build(new Kit(collect(entries)));
    for (const mesh of buildMerged(entries)) g.add(mesh);
  }
  parent.add(g);
  return g;
}

// ============================================================
// Reusable shapes
// ============================================================
function gearGeo(teeth: number, r: number, thick: number, hole = 0.22, spokes = 5): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  const w = Math.PI / teeth;
  const depth = Math.min(r * 0.16, (TAU * r) / teeth / 2.2);
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * TAU;
    for (const [da, rr] of [
      [-w * 0.95, r - depth],
      [-w * 0.45, r],
      [w * 0.45, r],
      [w * 0.95, r - depth],
    ]) {
      const px = Math.cos(a + da) * rr;
      const py = Math.sin(a + da) * rr;
      if (i === 0 && da < -w * 0.9) sh.moveTo(px, py);
      else sh.lineTo(px, py);
    }
  }
  sh.closePath();
  const hub = new THREE.Path();
  hub.absarc(0, 0, r * hole * 0.5, 0, TAU, true);
  sh.holes.push(hub);
  if (spokes > 0) {
    for (let i = 0; i < spokes; i++) {
      const a0 = (i / spokes) * TAU + 0.16;
      const a1 = ((i + 1) / spokes) * TAU - 0.16;
      const h = new THREE.Path();
      h.absarc(0, 0, r * 0.66, a0, a1, false);
      h.absarc(0, 0, r * 0.32, a1, a0, true);
      h.closePath();
      sh.holes.push(h);
    }
  }
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: thick,
    bevelEnabled: true,
    bevelThickness: thick * 0.12,
    bevelSize: Math.min(0.012, r * 0.02),
    bevelSegments: 1,
    curveSegments: 8,
  });
  g.translate(0, 0, -thick / 2);
  return g;
}

function starShape(points: number, rOut: number, rIn: number): THREE.Shape {
  const sh = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * TAU + Math.PI / 2;
    const r = i % 2 ? rIn : rOut;
    if (i === 0) sh.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else sh.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  sh.closePath();
  return sh;
}

/** Arching fern: a rosette of curved, tapering fronds. */
function fernGeo(fronds: number, len: number, seed: number, width = 0.13, droop = 1): THREE.BufferGeometry {
  const r = makeRng(seed);
  const pos: number[] = [];
  const uv: number[] = [];
  const SEG = 6;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * TAU + r() * 0.5;
    const l = len * (0.7 + r() * 0.5);
    const up = 0.75 + r() * 0.5;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const pts: [number, number, number, number][] = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const out = l * t * (0.55 + 0.35 * t);
      const y = l * (up * t - droop * 0.82 * t * t);
      const w = l * width * Math.sin(Math.PI * (0.12 + t * 0.86));
      pts.push([out, y, w, t]);
    }
    for (let i = 0; i < SEG; i++) {
      const [o0, y0, w0, t0] = pts[i];
      const [o1, y1, w1, t1] = pts[i + 1];
      const l0 = [ca * o0 - sa * w0, y0, sa * o0 + ca * w0];
      const r0 = [ca * o0 + sa * w0, y0, sa * o0 - ca * w0];
      const l1 = [ca * o1 - sa * w1, y1, sa * o1 + ca * w1];
      const r1 = [ca * o1 + sa * w1, y1, sa * o1 - ca * w1];
      pos.push(...l0, ...r0, ...r1, ...l0, ...r1, ...l1);
      uv.push(0, t0, 1, t0, 1, t1, 0, t0, 1, t1, 0, t1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Ivy / vine patch made of small leaf diamonds on a vertical surface facing +Z. */
function ivyGeo(w: number, h: number, count: number, seed: number): THREE.BufferGeometry {
  const r = makeRng(seed);
  const pos: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = (r() - 0.5) * w;
    const reach = h * (0.45 + 0.55 * Math.abs(Math.sin(x * 2.3 + seed)));
    const y = -r() * reach;
    const s = 0.06 + r() * 0.09;
    const a = r() * TAU;
    const z = 0.02 + r() * 0.1;
    const tip = (r() - 0.3) * 0.1;
    const pt = (px: number, py: number, pz: number): number[] => [
      x + Math.cos(a) * px - Math.sin(a) * py,
      y + Math.sin(a) * px + Math.cos(a) * py,
      z + pz,
    ];
    const p0 = pt(0, -s, 0);
    const p1 = pt(s * 0.7, 0, 0.03);
    const p2 = pt(0, s * 1.2, tip);
    const p3 = pt(-s * 0.7, 0, 0.03);
    pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function cypressGeo(h: number, r: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const rr = r * Math.sin(Math.PI * Math.pow(t, 0.62)) * (1 + 0.1 * Math.sin(t * 34)) + (i === N ? 0 : 0.02);
    pts.push(new THREE.Vector2(Math.max(0.005, rr), t * h));
  }
  const g = new THREE.LatheGeometry(pts, 14);
  scaleUv(g, TAU * r, h);
  return g;
}

function lathe(profile: [number, number][], seg = 40): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    profile.map(([x, y]) => new THREE.Vector2(x, y)),
    seg,
  );
}

// ============================================================
// Materials
// ============================================================
type StdOpts = THREE.MeshStandardMaterialParameters;

function makeMaterials() {
  const T = getTextures();
  const uTime = { value: 0 };
  // envMapIntensity only affects an explicitly assigned envMap (scene.environment has its own scale)
  const std = (o: StdOpts): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ roughness: 0.8, ...(o.envMapIntensity !== undefined ? { envMap: T.env } : {}), ...o });
  const sway = (o: StdOpts, amt: number): THREE.MeshStandardMaterial => {
    const m = std({ side: THREE.DoubleSide, ...o });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float swayAmt = ${amt.toFixed(3)} * smoothstep(0.1, 1.6, position.y);
           transformed.x += sin(uTime * 1.5 + position.x * 1.7 + position.z * 2.1) * swayAmt;
           transformed.z += cos(uTime * 1.2 + position.x * 2.3 + position.z * 1.4) * swayAmt * 0.8;`,
        );
    };
    m.customProgramCacheKey = () => `sway${amt}`;
    return m;
  };
  const glass = std({
    color: 0xdff5ee,
    transparent: true,
    opacity: 0.12,
    roughness: 0.04,
    metalness: 0.1,
    envMapIntensity: 2.2,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  glass.userData.noRay = true;
  const glow = (color: number, intensity = 1.6): THREE.MeshStandardMaterial => {
    // dark diffuse keeps the hue saturated under ACES + sunlight
    const m = std({ color: new THREE.Color(color).multiplyScalar(0.35), emissive: color, emissiveIntensity: intensity, roughness: 0.45 });
    m.userData.noCast = true;
    return m;
  };
  const glassIron = std({
    map: T.glassIron,
    transparent: true,
    roughness: 0.08,
    metalness: 0.15,
    envMapIntensity: 1.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  glassIron.userData.noRay = true;
  const tiles = new THREE.MeshStandardMaterial({ map: T.roof, roughness: 0.6, metalness: 0.15 });

  return {
    T,
    uTime,
    std,
    glow,
    parquet: std({ map: T.parquet, roughness: 0.46, envMapIntensity: 0.4 }),
    deckWood: std({ map: T.parquet, color: 0xe8c9a0, roughness: 0.5 }),
    flag: std({ map: T.flagstone, bumpMap: T.flagstoneBump, bumpScale: 2.2, roughness: 0.85 }),
    workFloor: std({ map: T.flagstone, color: 0xd9b394, bumpMap: T.flagstoneBump, bumpScale: 1.6, roughness: 0.6 }),
    consFloor: std({ map: T.flagstone, color: 0xd8ecd4, bumpMap: T.flagstoneBump, bumpScale: 1.6, roughness: 0.55 }),
    grass: std({ map: T.grass, roughness: 0.95 }),
    damask: std({ map: T.damask, roughness: 0.72 }),
    damaskMint: std({ map: T.damask, color: 0xcfe8cf, roughness: 0.72 }),
    damaskRose: std({ map: T.damask, color: 0xf2c9b4, roughness: 0.72 }),
    brick: std({ map: T.brick, bumpMap: T.brickBump, bumpScale: 2, roughness: 0.85 }),
    ashlar: std({ map: T.ashlar, roughness: 0.86 }),
    trimStone: std({ color: 0xf3e6c6, roughness: 0.75 }),
    plaster: std({ map: T.plaster, roughness: 0.9, emissive: 0x6b5a3c, emissiveIntensity: 0.18 }),
    walnut: std({ map: T.walnut, roughness: 0.5, envMapIntensity: 0.45 }),
    walnutRed: std({ map: T.walnut, color: 0xffc29a, roughness: 0.5, envMapIntensity: 0.45 }),
    brass: std({ map: T.brass, metalness: 0.85, roughness: 0.27, envMapIntensity: 1.35 }),
    brassDark: std({ color: 0xb98d4c, metalness: 0.8, roughness: 0.38, envMapIntensity: 1.1 }),
    copper: std({ color: 0xcb7c50, metalness: 0.88, roughness: 0.32, envMapIntensity: 1.4 }),
    silver: std({ color: 0xe6ebf2, metalness: 0.92, roughness: 0.22, envMapIntensity: 1.6 }),
    iron: std({ color: 0x3d5a4e, metalness: 0.55, roughness: 0.48 }),
    darkIron: std({ color: 0x43403f, metalness: 0.7, roughness: 0.5 }),
    verdigris: std({ color: 0x5fa392, metalness: 0.45, roughness: 0.5 }),
    marble: std({ map: T.marble, roughness: 0.28, envMapIntensity: 0.9 }),
    roof: tiles,
    hedge: std({ map: T.hedge, roughness: 0.95 }),
    cypress: std({ map: T.hedge, color: 0x9fc48f, roughness: 0.95 }),
    leaf: sway({ color: 0x5fae48, roughness: 0.7 }, 0.05),
    leafDark: sway({ color: 0x2f7a3c, roughness: 0.75 }, 0.04),
    leafLime: sway({ color: 0x9ccb4d, roughness: 0.7 }, 0.06),
    petalPink: sway({ color: 0xf28fb1, roughness: 0.7, emissive: 0x7a2a45, emissiveIntensity: 0.25 }, 0.04),
    petalGold: sway({ color: 0xffc53f, roughness: 0.7, emissive: 0x7a5010, emissiveIntensity: 0.3 }, 0.04),
    petalWhite: sway({ color: 0xfff3e0, roughness: 0.7, emissive: 0x6b5a40, emissiveIntensity: 0.25 }, 0.04),
    petalViolet: sway({ color: 0xb286e8, roughness: 0.7, emissive: 0x44207a, emissiveIntensity: 0.35 }, 0.04),
    orchid: sway({ color: 0xffa7ee, roughness: 0.5, emissive: 0xff5fd8, emissiveIntensity: 0.9 }, 0.04),
    orchidCyan: sway({ color: 0xa8fff0, roughness: 0.5, emissive: 0x3fe8d0, emissiveIntensity: 0.9 }, 0.04),
    bark: std({ color: 0x7a5636, roughness: 0.95 }),
    soil: std({ color: 0x553a24, roughness: 1 }),
    terracotta: std({ color: 0xcf7a4c, roughness: 0.82 }),
    velvetRed: std({ color: 0x9c3535, roughness: 0.95 }),
    velvetTeal: std({ color: 0x246a68, roughness: 0.95 }),
    cream: std({ color: 0xf7ead0, roughness: 0.8 }),
    paper: std({ color: 0xf8ecd0, roughness: 0.9 }),
    ebony: std({ color: 0x2b1d16, roughness: 0.4 }),
    books: std({ map: T.books, roughness: 0.75 }),
    rug: new THREE.MeshStandardMaterial({ map: T.rug, roughness: 0.98, transparent: true, depthWrite: false }),
    rosette: new THREE.MeshStandardMaterial({ map: T.rosette, roughness: 0.75, transparent: true, depthWrite: false }),
    glass,
    glassIron,
    lampGlow: glow(0xffd08a, 2.2),
    ember: glow(0xff7a2a, 2.6),
    soot: std({ color: 0x33241c, roughness: 1 }),
    starDome: std({
      map: T.starDome,
      emissiveMap: T.starDome,
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      roughness: 0.7,
      side: THREE.BackSide,
    }),
    copperRoof: std({ color: 0x4f9aa8, metalness: 0.5, roughness: 0.42 }),
    solar: std({ color: 0x24458c, metalness: 0.4, roughness: 0.18, envMapIntensity: 1.8 }),
  };
}

type Mats = ReturnType<typeof makeMaterials>;

/** Painted/readable surface material: lit, but with enough self-glow to stay legible in shade. */
function paintedMat(tex: THREE.Texture, glow = 0.32): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: 0xffffff,
    emissiveIntensity: glow,
    roughness: 0.85,
  });
}

// ============================================================
// Item meshes (pickups, pedestal cores and partner's hand)
// ============================================================
const CORE_COLORS: Record<'sun' | 'gear' | 'star' | 'wind', number> = {
  sun: 0xffb02e,
  gear: 0xff7d3a,
  star: 0x3f7bff,
  wind: 0x2fe0c8,
};

const ITEM_GLOW: Record<ItemId, number> = {
  key_study: 0xffd27a,
  key_conservatory: 0x6affa8,
  key_skylift: 0xffd27a,
  tool_uv_lamp: 0xb07bff,
  tool_prism: 0xcff4ff,
  item_gear_18t: 0xffc46a,
  core_sun: CORE_COLORS.sun,
  core_gear: CORE_COLORS.gear,
  core_star: CORE_COLORS.star,
  core_wind: CORE_COLORS.wind,
};

function makeItemMesh(M: Mats, id: ItemId): THREE.Group {
  const holder = new THREE.Group();
  switch (id) {
    case 'key_study':
    case 'key_conservatory':
    case 'key_skylift': {
      const accent =
        id === 'key_conservatory' ? M.glow(0x39e07f, 0.9) : id === 'key_skylift' ? M.copper : M.brass;
      group(holder, 0, 0, 0, 0, (k) => {
        k.torus(M.brass, 0.1, 0.026, 0, 0.17, 0);
        k.torus(accent, 0.052, 0.02, 0, 0.17, 0);
        if (id === 'key_skylift') k.put(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 6), M.copper, 0, 0.17, 0, Math.PI / 2);
        k.cyl(M.brass, 0.024, 0.024, 0.34, 0, -0.25, 0, 10);
        k.torus(M.brass, 0.036, 0.012, 0, 0.03, 0, Math.PI / 2);
        k.box(M.brass, 0.11, 0.035, 0.03, 0.06, -0.24, 0);
        k.box(M.brass, 0.08, 0.035, 0.03, 0.045, -0.17, 0);
      });
      break;
    }
    case 'tool_uv_lamp':
      group(holder, 0, 0, 0, 0, (k) => {
        const uv = M.glow(0x9d5cff, 2.6);
        k.cyl(M.brass, 0.1, 0.13, 0.05, 0, -0.2, 0);
        k.cyl(uv, 0.07, 0.07, 0.22, 0, -0.15, 0);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU;
          k.cyl(M.brass, 0.012, 0.012, 0.24, Math.cos(a) * 0.1, -0.16, Math.sin(a) * 0.1, 6);
        }
        k.cone(M.brass, 0.14, 0.12, 0, 0.07, 0);
        k.torus(M.brass, 0.07, 0.012, 0, 0.24, 0);
      });
      break;
    case 'tool_prism':
      group(holder, 0, 0, 0, 0, (k) => {
        const crystal = new THREE.MeshStandardMaterial({
          color: 0xe9fbff,
          emissive: 0x9fdcff,
          emissiveIntensity: 0.5,
          roughness: 0.03,
          metalness: 0.2,
          envMapIntensity: 3,
          transparent: true,
          opacity: 0.85,
        });
        k.put(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 3), crystal);
        k.torus(M.brass, 0.2, 0.016);
        k.torus(M.brass, 0.2, 0.016, 0, 0, 0, 0, Math.PI / 2);
        k.cyl(M.brass, 0.02, 0.02, 0.08, 0, -0.28, 0, 8);
      });
      break;
    case 'item_gear_18t':
      group(holder, 0, 0, 0, 0, (k) => k.put(gearGeo(18, 0.22, 0.07), M.brass));
      break;
    default: {
      const kind = id.slice(5) as keyof typeof CORE_COLORS;
      const mat = M.glow(CORE_COLORS[kind], 1.5);
      group(holder, 0, 0, 0, 0, (k) => {
        if (kind === 'sun') {
          k.put(new THREE.IcosahedronGeometry(0.15, 1), mat);
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * TAU;
            k.put(new THREE.ConeGeometry(0.03, 0.11, 5), M.brass, Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0, 0, 0, a - Math.PI / 2);
          }
        } else if (kind === 'gear') {
          k.put(new THREE.DodecahedronGeometry(0.12), mat);
          k.put(gearGeo(12, 0.24, 0.06, 0.6, 0), M.copper);
        } else if (kind === 'star') {
          const g = new THREE.ExtrudeGeometry(starShape(5, 0.22, 0.095), {
            depth: 0.07,
            bevelEnabled: true,
            bevelSize: 0.02,
            bevelThickness: 0.04,
            bevelSegments: 1,
          });
          g.translate(0, 0, -0.035);
          k.put(g, mat);
          k.torus(M.silver, 0.27, 0.014);
        } else {
          k.put(new THREE.TorusKnotGeometry(0.12, 0.04, 64, 8, 2, 3), mat);
          k.torus(M.silver, 0.24, 0.013, 0, 0, 0, Math.PI / 2);
        }
      });
      if (kind !== 'star') {
        group(holder, 0, 0, 0, 0, (k) => k.torus(M.brass, 0.27, 0.012, 0, 0, 0, 0.9, 0.5));
      }
      break;
    }
  }
  return holder;
}

function glowSprite(M: Mats, color: number, size: number, opacity = 0.7): THREE.Sprite {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: M.T.glow,
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  s.scale.set(size, size, 1);
  return noRay(s);
}

// ============================================================
// Build context
// ============================================================
interface Frame {
  state: WorldState;
  p: WorldPuzzleStates;
  myId: string;
  dt: number;
  t: number;
}

interface LightAnchor {
  pos: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  distance: number;
  flicker: number;
  gain: number; // live multiplier driven by state
}

type RegOpts = Omit<InteractableObject, 'mesh'> & { enabled?: (s: WorldState) => boolean };

interface Ctx {
  scene: THREE.Scene;
  M: Mats;
  B: Batcher;
  interactables: InteractableObject[];
  updaters: ((f: Frame) => void)[];
  ambient: ((t: number, dt: number, camera: THREE.Camera) => void)[];
  anchors: LightAnchor[];
  uvFrames: BuiltWorld['uvFrames'];
  uv: { camera: THREE.Camera | null; enabled: boolean };
  reg: (o: RegOpts, x: number, y: number, z: number, w: number, h: number, d: number, ry?: number) => THREE.Mesh;
  light: (x: number, y: number, z: number, color: number, intensity: number, distance: number, flicker?: number) => LightAnchor;
}

const PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false });

function setProxyActive(mesh: THREE.Object3D, on: boolean): void {
  if (mesh.visible === on) return;
  mesh.visible = on;
  mesh.layers.set(on ? 0 : 31); // raycaster ignores layer 31
}

function solvedTag(s: WorldState, id: keyof WorldState['solvedPuzzles'], label: string): string {
  return s.solvedPuzzles[id] ? `${label} (solved)` : label;
}

function clueLabel(id: string): string {
  return `Read: ${WORLD_CLUES[id]?.title ?? 'Plaque'}`;
}

// ------------------------------------------------------------
// Walls
// ------------------------------------------------------------
interface Opening {
  a: number;
  b: number;
  y0: number;
  y1: number;
  win?: boolean;
}

interface WallSpec {
  axis: 'x' | 'z'; // direction the wall runs along
  at: number;
  from: number;
  to: number;
  h: number;
  half?: number;
  neg: THREE.Material; // face looking toward -normal (-Z for axis x, -X for axis z)
  pos: THREE.Material;
  core?: THREE.Material;
  openings?: Opening[];
  coping?: THREE.Material;
}

function emitWallPiece(k: Kit, w: WallSpec, a: number, b: number, y0: number, y1: number): void {
  const t = w.half ?? 0.35;
  const core = w.core ?? w.pos;
  const lo = w.at - t;
  const hi = w.at + t;
  if (w.axis === 'x') {
    k.quad(w.neg, [b, y0, lo], [a, y0, lo], [a, y1, lo], [b, y1, lo]);
    k.quad(w.pos, [a, y0, hi], [b, y0, hi], [b, y1, hi], [a, y1, hi]);
    k.quad(core, [a, y0, lo], [a, y0, hi], [a, y1, hi], [a, y1, lo]);
    k.quad(core, [b, y0, hi], [b, y0, lo], [b, y1, lo], [b, y1, hi]);
    k.quad(core, [a, y1, hi], [b, y1, hi], [b, y1, lo], [a, y1, lo]);
    k.quad(core, [a, y0, lo], [b, y0, lo], [b, y0, hi], [a, y0, hi]);
  } else {
    k.quad(w.neg, [lo, y0, a], [lo, y0, b], [lo, y1, b], [lo, y1, a]);
    k.quad(w.pos, [hi, y0, b], [hi, y0, a], [hi, y1, a], [hi, y1, b]);
    k.quad(core, [hi, y0, a], [lo, y0, a], [lo, y1, a], [hi, y1, a]);
    k.quad(core, [lo, y0, b], [hi, y0, b], [hi, y1, b], [lo, y1, b]);
    k.quad(core, [lo, y1, b], [hi, y1, b], [hi, y1, a], [lo, y1, a]);
    k.quad(core, [lo, y0, a], [hi, y0, a], [hi, y0, b], [lo, y0, b]);
  }
}

function wall(c: Ctx, k: Kit, w: WallSpec): void {
  const ops = w.openings ?? [];
  const cuts = [w.from, w.to, ...ops.flatMap((o) => [o.a, o.b])].sort((p, q) => p - q);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < 1e-4) continue;
    const mid = (a + b) / 2;
    const here = ops.filter((o) => mid > o.a && mid < o.b).sort((p, q) => p.y0 - q.y0);
    let y = 0;
    for (const o of here) {
      if (o.y0 > y) emitWallPiece(k, w, a, b, y, o.y0);
      y = o.y1;
    }
    if (y < w.h) emitWallPiece(k, w, a, b, y, w.h);
  }
  const t = w.half ?? 0.35;
  if (w.coping) {
    const len = w.to - w.from;
    const mid = (w.from + w.to) / 2;
    if (w.axis === 'x') k.box(w.coping, len + 0.16, 0.16, t * 2 + 0.16, mid, w.h, w.at);
    else k.box(w.coping, t * 2 + 0.16, 0.16, len + 0.16, w.at, w.h, mid);
  }
  for (const o of ops) if (o.win) windowUnit(c, k, w, o);
}

function windowUnit(c: Ctx, k: Kit, w: WallSpec, o: Opening): void {
  const { M } = c;
  const wd = o.b - o.a;
  const ht = o.y1 - o.y0;
  const mid = (o.a + o.b) / 2;
  const f = w.axis === 'x' ? k.at(mid, o.y0, w.at, 0) : k.at(w.at, o.y0, mid, Math.PI / 2);
  f.panel(M.glass, wd, ht, 0, ht / 2, 0);
  f.box(M.cream, 0.09, ht, 0.16, -wd / 2 + 0.045, 0, 0);
  f.box(M.cream, 0.09, ht, 0.16, wd / 2 - 0.045, 0, 0);
  f.box(M.cream, wd, 0.09, 0.16, 0, ht - 0.09, 0);
  f.box(M.cream, wd + 0.2, 0.08, 0.86, 0, -0.06, 0);
  const n = Math.max(1, Math.round(wd / 0.7));
  for (let i = 1; i < n; i++) f.box(M.brassDark, 0.035, ht, 0.05, -wd / 2 + (wd * i) / n, 0, 0);
  f.box(M.brassDark, wd, 0.035, 0.05, 0, ht * 0.66, 0);
  // stained fan-light accents in the top band
  const colors = [M.petalGold, M.petalPink, M.orchidCyan];
  for (let i = 0; i < n; i++) {
    f.put(new THREE.CircleGeometry(Math.min(wd / n, ht * 0.3) * 0.26, 18), colors[i % 3], -wd / 2 + (wd * (i + 0.5)) / n, ht * 0.83, 0.01);
  }
}

/** Interior wainscot, chair rail, baseboard & crown along a wall face. */
function trim(
  c: Ctx,
  k: Kit,
  axis: 'x' | 'z',
  face: number,
  dir: 1 | -1,
  from: number,
  to: number,
  gaps: [number, number][],
  ceil: number,
  wood: THREE.Material = c.M.walnut,
): void {
  const { M } = c;
  const put = (mat: THREE.Material, a: number, b: number, y: number, h: number, d: number): void => {
    const mid = (a + b) / 2;
    const off = face + dir * (d / 2);
    if (axis === 'x') k.box(mat, b - a, h, d, mid, y, off);
    else k.box(mat, d, h, b - a, off, y, mid);
  };
  put(M.cream, from, to, ceil - 0.2, 0.2, 0.12);
  put(M.brass, from, to, ceil - 0.25, 0.035, 0.1);
  const edges = [from, ...gaps.flat(), to];
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const a = edges[i];
    const b = edges[i + 1];
    if (b - a < 0.05) continue;
    put(wood, a, b, 0, 1.0, 0.035);
    put(wood, a, b, 0, 0.18, 0.06);
    put(wood, a, b, 0.98, 0.08, 0.075);
    const n = Math.max(1, Math.round((b - a) / 0.95));
    const step = (b - a) / n;
    for (let j = 0; j < n; j++) put(wood, a + j * step + 0.12, a + (j + 1) * step - 0.12, 0.3, 0.56, 0.055);
  }
}

function hipRoof(k: Kit, mat: THREE.Material, under: THREE.Material, x0: number, x1: number, z0: number, z1: number, y: number, h: number): void {
  const w = x1 - x0;
  const d = z1 - z0;
  const inset = Math.min(w, d) / 2;
  const a = [x0, y, z1];
  const b = [x1, y, z1];
  const cc = [x1, y, z0];
  const dd = [x0, y, z0];
  if (w >= d) {
    const r0 = [x0 + inset, y + h, (z0 + z1) / 2];
    const r1 = [x1 - inset, y + h, (z0 + z1) / 2];
    k.quad(mat, a, b, r1, r0);
    k.quad(mat, cc, dd, r0, r1);
    k.quad(mat, b, cc, r1, r1);
    k.quad(mat, dd, a, r0, r0);
  } else {
    const r0 = [(x0 + x1) / 2, y + h, z0 + inset];
    const r1 = [(x0 + x1) / 2, y + h, z1 - inset];
    k.quad(mat, b, cc, r0, r1);
    k.quad(mat, dd, a, r1, r0);
    k.quad(mat, a, b, r1, r1);
    k.quad(mat, cc, dd, r0, r0);
  }
  k.floor(under, x0, x1, z0, z1, y - 0.02, false);
  k.box(under, w + 0.1, 0.16, d + 0.1, (x0 + x1) / 2, y - 0.16, (z0 + z1) / 2);
}

function plaque(c: Ctx, k: Kit, tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ry: number, rx = 0, frame: THREE.Material = c.M.brass, glow = 0.3): void {
  const f = k.at(x, y, z, ry, rx);
  f.box(frame, w + 0.12, h + 0.12, 0.06, 0, -h / 2 - 0.06, 0);
  f.panel(paintedMat(tex, glow), w, h, 0, 0, 0.034);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) f.sph(c.M.brass, 0.028, (sx * (w + 0.06)) / 2, (sy * (h + 0.06)) / 2, 0.035, 1, 1, 1, 8);
  }
}

function pottedPlant(c: Ctx, k: Kit, x: number, z: number, s: number, seed: number, y = 0): void {
  const { M } = c;
  k.put(
    lathe([
      [0.02, 0],
      [0.2, 0],
      [0.22, 0.05],
      [0.29, 0.4],
      [0.33, 0.42],
      [0.33, 0.48],
      [0.27, 0.48],
      [0.25, 0.42],
      [0.01, 0.42],
    ], 18),
    M.terracotta,
    x,
    y,
    z,
    0,
    0,
    0,
    s,
  );
  k.put(fernGeo(16, 0.95, seed), M.leaf, x, y + 0.4 * s, z, 0, seed, 0, s);
  k.put(fernGeo(10, 0.6, seed + 5, 0.17, 0.6), M.leafLime, x, y + 0.42 * s, z, 0, seed * 2, 0, s);
}

function flowerClump(c: Ctx, k: Kit, x: number, y: number, z: number, n: number, spread: number, seed: number, mats?: THREE.Material[]): void {
  const { M } = c;
  const r = makeRng(seed);
  const pal = mats ?? [M.petalPink, M.petalGold, M.petalWhite, M.petalViolet];
  for (let i = 0; i < n; i++) {
    const px = x + (r() - 0.5) * spread;
    const pz = z + (r() - 0.5) * spread;
    const py = y + 0.12 + r() * 0.22;
    const s = 0.05 + r() * 0.05;
    k.put(new THREE.IcosahedronGeometry(s, 0), pal[Math.floor(r() * pal.length)], px, py, pz, r(), r(), 0, 1, 0.65, 1);
    k.put(new THREE.ConeGeometry(0.07, 0.24, 4), M.leafDark, px, py - 0.13, pz);
  }
  k.put(fernGeo(7, 0.4, seed + 9, 0.14), M.leaf, x, y, z);
}

function lampPost(c: Ctx, k: Kit, x: number, z: number, y = 0): void {
  const { M } = c;
  k.cyl(M.iron, 0.16, 0.22, 0.2, x, y, z, 10);
  k.cyl(M.iron, 0.05, 0.08, 2.4, x, y + 0.2, z, 10);
  k.torus(M.brass, 0.085, 0.025, x, y + 1.1, z, Math.PI / 2);
  k.cyl(M.brass, 0.17, 0.1, 0.08, x, y + 2.58, z, 6);
  k.cyl(M.lampGlow, 0.13, 0.1, 0.3, x, y + 2.66, z, 6);
  k.cone(M.iron, 0.24, 0.2, x, y + 2.96, z, 6);
  k.sph(M.brass, 0.045, x, y + 3.19, z, 1, 1, 1, 8);
}

function pedestal(c: Ctx, k: Kit, x: number, z: number, h: number, y = 0, r = 0.28): void {
  k.put(
    lathe([
      [0.01, 0],
      [r * 1.25, 0],
      [r * 1.25, 0.08],
      [r * 0.95, 0.15],
      [r * 0.72, 0.28],
      [r * 0.66, h - 0.24],
      [r * 0.95, h - 0.12],
      [r * 1.15, h - 0.08],
      [r * 1.15, h],
      [0.01, h],
    ], 24),
    c.M.marble,
    x,
    y,
    z,
  );
  k.torus(c.M.brass, r * 1.16, 0.02, x, y + h - 0.04, z, Math.PI / 2);
}

/** A two-state lever. Returns the pivot group. */
function leverUnit(c: Ctx, x: number, y: number, z: number, ry: number, zone: string, floorPost: boolean, lampCol: number) {
  const { M } = c;
  const k = c.B.kit(zone).at(x, y, z, ry);
  if (floorPost) {
    k.box(M.darkIron, 0.5, 0.12, 0.5, 0, -y, 0);
    k.box(M.brassDark, 0.26, y, 0.22, 0, -y + 0.1, -0.02);
  }
  k.box(M.walnut, 0.5, 0.72, 0.08, 0, -0.36, 0);
  k.box(M.brass, 0.4, 0.6, 0.05, 0, -0.3, 0.045);
  k.box(M.ebony, 0.07, 0.46, 0.02, 0, -0.23, 0.072);
  k.torus(M.brass, 0.14, 0.02, 0, 0.45, 0.02);
  const lamp = M.glow(lampCol, 0.15);
  const root = group(c.scene, x, y, z, ry);
  group(root, 0, 0.45, 0.04, 0, (g) => g.sph(lamp, 0.11, 0, 0, 0));
  const arm = group(root, 0, 0, 0.06, 0, (g) => {
    g.rod(M.brass, 0.025, [0, 0, 0], [0, 0, 0.42], 10);
    g.sph(M.velvetRed, 0.065, 0, 0, 0.45);
    g.torus(M.brass, 0.05, 0.012, 0, 0, 0.39);
  });
  arm.rotation.x = -0.75;
  return { arm, lamp };
}

function oracleBooth(c: Ctx, zone: string, x: number, z: number, ry: number, id: string): void {
  const { M } = c;
  const k = c.B.kit(zone).at(x, 0, z, ry);
  k.box(M.walnutRed, 1.3, 0.9, 0.9);
  k.box(M.brass, 1.36, 0.06, 0.96, 0, 0.9, 0);
  k.box(M.brass, 1.36, 0.08, 0.96, 0, 0, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) k.cyl(M.brass, 0.045, 0.045, 1.25, sx * 0.6, 0.96, sz * 0.4, 10);
  }
  k.box(M.velvetRed, 1.14, 1.2, 0.04, 0, 0.98, -0.4);
  for (let i = 0; i < 8; i++) k.cyl(M.velvetRed, 0.07, 0.08, 1.2, -0.53 + i * 0.152, 0.98, -0.36, 8);
  k.box(M.walnutRed, 1.36, 0.14, 0.96, 0, 2.2, 0);
  k.panel(paintedMat(M.T.oracleSign, 0.75), 1.24, 0.31, 0, 2.5, 0.42, 0, -0.08);
  k.box(M.brass, 1.32, 0.38, 0.04, 0, 2.31, 0.38);
  k.put(new THREE.SphereGeometry(0.62, 18, 10, 0, TAU, 0, Math.PI / 2), M.walnutRed, 0, 2.34, -0.1, 0, 0, 0, 1, 0.6, 0.7);
  k.sph(M.brass, 0.09, 0, 2.78, -0.1);
  k.panel(M.glass, 1.16, 1.2, 0, 1.58, 0.43);
  // coin slot & brass sunburst front
  k.put(new THREE.ExtrudeGeometry(starShape(12, 0.28, 0.17), { depth: 0.03, bevelEnabled: false }), M.brass, 0, 0.48, 0.45);
  k.sph(M.lampGlow, 0.1, 0, 0.48, 0.48);
  // automaton
  k.put(
    lathe([
      [0.01, 0],
      [0.34, 0],
      [0.26, 0.34],
      [0.15, 0.42],
      [0.01, 0.42],
    ], 18),
    M.velvetTeal,
    0,
    0.96,
    -0.1,
  );
  k.torus(M.brass, 0.17, 0.03, 0, 1.37, -0.1, Math.PI / 2);
  const root = group(c.scene, x, 0, z, ry);
  const head = group(root, 0, 1.56, -0.1, 0, (g) => {
    g.sph(M.cream, 0.15, 0, 0, 0, 1, 1.12, 1);
    g.sph(M.brass, 0.16, 0, 0.06, -0.015, 1.02, 0.8, 1.02);
    g.torus(M.brass, 0.05, 0.014, -0.06, 0.01, 0.13);
    g.torus(M.brass, 0.05, 0.014, 0.06, 0.01, 0.13);
    g.cone(M.velvetRed, 0.11, 0.26, 0, 0.14, 0);
    g.sph(M.brass, 0.035, 0, 0.41, 0, 1, 1, 1, 8);
  });
  const eyes = M.glow(0x7affff, 1.8);
  group(head, 0, 0.01, 0.135, 0, (g) => {
    g.sph(eyes, 0.034, -0.06, 0, 0, 1, 1, 0.5, 10);
    g.sph(eyes, 0.034, 0.06, 0, 0, 1, 1, 0.5, 10);
  });
  const orbMat = M.glow(0xb06bff, 1.8);
  const orb = group(root, 0, 1.14, 0.2, 0, (g) => {
    g.sph(orbMat, 0.14);
  });
  orb.add(glowSprite(M, 0xb487ff, 0.9, 0.55));
  group(root, 0, 0.97, 0.2, 0, (g) => g.torus(M.brass, 0.12, 0.03, 0, 0.02, 0, Math.PI / 2));
  const hands = [-1, 1].map((s) => group(root, s * 0.28, 1.2, 0.02, 0, (g) => {
    g.rod(M.brass, 0.03, [0, 0.08, -0.1], [-s * 0.1, -0.06, 0.18], 8);
    g.sph(M.cream, 0.05, -s * 0.1, -0.06, 0.2, 1, 0.7, 1.2, 10);
  }));
  c.ambient.push((t) => {
    head.rotation.y = Math.sin(t * 0.7) * 0.45;
    head.rotation.x = Math.sin(t * 1.1) * 0.08;
    orbMat.emissiveIntensity = 1.5 + Math.sin(t * 2.2) * 0.6;
    hands.forEach((h, i) => (h.position.y = 1.2 + Math.sin(t * 1.6 + i * 2) * 0.04));
  });
  c.reg(
    {
      id,
      label: 'Consult the Clockwork Oracle',
      actionType: 'direct',
      maxDistance: 3.8,
      getLabel: (s) =>
        s.hintCooldownEndsAt > Date.now() ? 'Clockwork Oracle (recharging)' : 'Consult the Clockwork Oracle for a hint',
    },
    x,
    1.35,
    z,
    1.45,
    2.7,
    1.1,
    ry,
  );
}

function floorPlate(c: Ctx, id: string, color: number, active: (f: Frame) => boolean, idle = 0.35): void {
  const { M } = c;
  const p = FLOOR_PLATES[id];
  const mat = M.glow(color, idle);
  const rim = group(c.scene, p.x, p.y, p.z, 0, (k) => {
    k.cyl(M.brassDark, p.radius, p.radius + 0.06, 0.05, 0, 0, 0, 48);
    k.torus(M.brass, p.radius - 0.02, 0.035, 0, 0.05, 0, Math.PI / 2, 0, 0, 56);
  });
  rim.name = id;
  const top = group(c.scene, p.x, p.y + 0.055, p.z, 0, (k) => {
    k.cyl(mat, p.radius * 0.8, p.radius * 0.82, 0.035, 0, 0, 0, 40);
    k.put(new THREE.ExtrudeGeometry(starShape(8, p.radius * 0.55, p.radius * 0.28), { depth: 0.02, bevelEnabled: false }), M.brass, 0, 0.03, 0, -Math.PI / 2);
    k.sph(mat, p.radius * 0.16, 0, 0.04, 0, 1, 0.35, 1);
  });
  const halo = glowSprite(M, color, p.radius * 3.2, 0.07);
  halo.position.set(p.x, p.y + 0.35, p.z);
  c.scene.add(halo);
  let v = 0;
  c.updaters.push((f) => {
    const on = active(f);
    v = damp(v, on ? 1 : 0, 8, f.dt);
    top.position.y = p.y + 0.055 - v * 0.035;
    mat.emissiveIntensity = idle + Math.sin(f.t * 2 + p.x) * 0.08 + v * 0.95;
    (halo.material as THREE.SpriteMaterial).opacity = 0.07 + v * 0.26;
  });
}

// ============================================================
// SKY, TERRAIN, ATMOSPHERE
// ============================================================
const SUN_DIR = new THREE.Vector3(-30, 40, 27).normalize();

function buildSky(c: Ctx): void {
  const { scene, M } = c;
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      uSun: { value: SUN_DIR },
      uZenith: { value: new THREE.Color(0x3f93d6) },
      uMid: { value: new THREE.Color(0x9fd0ea) },
      uHorizon: { value: new THREE.Color(0xffd3a0) },
      uGround: { value: new THREE.Color(0xe9c48f) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
        gl_Position = p.xyww;
        gl_Position.z *= 0.99999;
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uSun, uZenith, uMid, uHorizon, uGround;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.28, h));
        col = mix(col, uZenith, smoothstep(0.2, 0.85, h));
        col = mix(col, uGround, smoothstep(0.0, -0.2, h));
        float s = max(dot(d, normalize(uSun)), 0.0);
        col += vec3(1.0, 0.62, 0.28) * pow(s, 5.0) * 0.26;
        col += vec3(1.0, 0.8, 0.5) * pow(s, 40.0) * 0.5;
        col += vec3(1.0, 0.95, 0.8) * smoothstep(0.9985, 0.9993, s) * 2.0;
        float cirrus = sin(d.x * 9.0 + d.z * 4.0 + sin(d.z * 14.0)) * sin(d.z * 6.0 - d.x * 3.0);
        col += vec3(1.0, 0.86, 0.7) * smoothstep(0.35, 1.0, cirrus) * 0.1 * smoothstep(0.05, 0.3, h);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = noRay(new THREE.Mesh(new THREE.SphereGeometry(100, 40, 24), skyMat));
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  let last = 0;
  // Ambient motion runs from the render itself so it also plays behind the lobby.
  sky.onBeforeRender = (_r, _sc, camera) => {
    const t = performance.now() / 1000;
    const dt = last ? Math.min(0.1, t - last) : 0.016;
    last = t;
    M.uTime.value = t;
    for (const fn of c.ambient) fn(t, dt, camera);
  };
  scene.add(sky);

  scene.fog = new THREE.FogExp2(0xf4d9b4, 0.0056);
  scene.background = new THREE.Color(0xf4d9b4);
  scene.environment = M.T.env;
  scene.environmentIntensity = 0.5;

  const sun = new THREE.DirectionalLight(0xffd196, 3.5);
  const target = new THREE.Vector3(0, 0, -6);
  sun.position.copy(target).addScaledVector(SUN_DIR, 70);
  sun.target.position.copy(target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const cam = sun.shadow.camera;
  cam.left = -36;
  cam.right = 36;
  cam.top = 34;
  cam.bottom = -34;
  cam.near = 10;
  cam.far = 130;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 3;
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  scene.add(sun, sun.target);
  let frame = 0;
  c.ambient.push(() => {
    if (frame++ % 2 === 0) sun.shadow.needsUpdate = true;
  });

  scene.add(new THREE.HemisphereLight(0xd6e4ff, 0xe0b378, 0.95));

  // Drifting cloud clusters
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffe9dc, emissiveIntensity: 0.42, fog: false });
  cloudMat.userData.noCast = true;
  cloudMat.userData.noReceive = true;
  cloudMat.userData.noRay = true;
  const r = makeRng(5);
  for (let ringI = 0; ringI < 2; ringI++) {
    const ring = group(scene, 0, 0, -6, 0, (k) => {
      const n = ringI ? 9 : 12;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + r() * 0.4;
        const rad = ringI ? 96 + r() * 26 : 138 + r() * 24;
        const y = ringI ? 48 + r() * 18 : 34 + r() * 26;
        const cl = k.at(Math.cos(a) * rad, y, Math.sin(a) * rad, -a + Math.PI / 2);
        const puffs = 7 + Math.floor(r() * 6);
        const s = 2.8 + r() * 2.6;
        for (let j = 0; j < puffs; j++) {
          const px = (j - puffs / 2) * s * 0.75 + r() * s * 0.4;
          const env = 1 - Math.abs((j - puffs / 2) / (puffs / 2)) * 0.55;
          const g = new THREE.IcosahedronGeometry(s * env * (0.75 + r() * 0.5), 3);
          cl.put(g, cloudMat, px, r() * s * 0.5 * env, (r() - 0.5) * s * 1.2, 0, r(), 0, 1, 0.68, 0.9);
        }
        for (let j = 0; j < 3; j++) {
          cl.put(new THREE.IcosahedronGeometry(s * 0.75, 3), cloudMat, (r() - 0.5) * puffs * s * 0.4, -s * 0.15, (r() - 0.5) * s, 0, 0, 0, 1.5, 0.42, 1);
        }
      }
    });
    c.ambient.push((t) => (ring.rotation.y = t * (ringI ? 0.0045 : 0.0025)));
  }

  // Vance's skyship, adrift in the distance
  const ship = group(scene, -44, 34, -86, 0.9, (k) => {
    const hull = M.std({ color: 0xf0e0bd, roughness: 0.7, emissive: 0x7a5a2a, emissiveIntensity: 0.15 });
    k.sph(hull, 5, 0, 5, 0, 2.3, 1, 1, 28);
    for (const px of [-8, -4, 0, 4, 8]) {
      const rr = 5 * Math.sqrt(1 - (px / 11.5) ** 2);
      k.torus(M.copper, rr + 0.05, 0.12, px, 5, 0, 0, Math.PI / 2, 0, 40);
    }
    k.box(M.walnutRed, 8, 1.4, 2.2, 0, -2.2, 0);
    k.box(M.brass, 8.4, 0.2, 2.6, 0, -0.8, 0);
    for (const px of [-3.4, -1.1, 1.1, 3.4]) {
      k.rod(M.brassDark, 0.06, [px, -0.8, 1], [px * 1.2, 1.2, 1.8]);
      k.rod(M.brassDark, 0.06, [px, -0.8, -1], [px * 1.2, 1.2, -1.8]);
    }
    k.box(M.velvetTeal, 2.4, 4.6, 0.16, -11.2, 3.2, 0, 0, 0, 0.1);
    k.box(M.velvetTeal, 2.4, 0.16, 4.8, -11.2, 5, 0);
  });
  const prop = group(ship, -4.6, -1.5, 0, 0, (k) => {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      k.rod(M.brass, 0.14, [0, 0, 0], [0, Math.cos(a) * 1.6, Math.sin(a) * 1.6]);
    }
  });
  c.ambient.push((t) => {
    ship.position.y = 34 + Math.sin(t * 0.25) * 1.4;
    ship.position.x = -44 + Math.sin(t * 0.04) * 10;
    ship.rotation.z = Math.sin(t * 0.21) * 0.03;
    prop.rotation.x = t * 5;
  });

  buildTerrain(c);
  buildMotes(c);
}

function terrainHeight(x: number, z: number): number {
  const dx = x / 1.02;
  const dz = z + 6;
  const d = Math.hypot(dx, dz);
  const drop = smooth(36, 74, d) * -8;
  const roll =
    Math.sin(x * 0.052 + 1.3) * Math.cos(z * 0.045) * 4.6 + Math.sin(x * 0.021 + z * 0.03) * 6 + Math.sin(z * 0.09 + x * 0.02) * 1.6;
  const rise = Math.max(0, d - 82) * 0.17;
  return -0.1 + drop + smooth(52, 100, d) * (roll + rise);
}

function buildTerrain(c: Ctx): void {
  const { scene, M } = c;
  const R = [0, 34, 38, 42, 47, 53, 60, 68, 77, 87, 98, 110, 123, 137, 152, 168, 185];
  const SEG = 84;
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const c1 = new THREE.Color(0x86b356);
  const c2 = new THREE.Color(0xb9c468);
  const c3 = new THREE.Color(0x5e9a55);
  const tmp = new THREE.Color();
  for (const rad of R) {
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * TAU;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad - 6;
      const y = terrainHeight(x, z);
      pos.push(x, y, z);
      uv.push(x, z);
      const n = Math.sin(x * 0.11) * Math.sin(z * 0.13 + 2) * 0.5 + 0.5;
      tmp.copy(c1).lerp(n > 0.5 ? c2 : c3, Math.abs(n - 0.5) * 1.5);
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let i = 0; i + 1 < R.length; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * (SEG + 1) + j;
      const b = a + SEG + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const land = new THREE.Mesh(
    g,
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
  land.receiveShadow = true;
  scene.add(land);

  // Distant orchard trees
  const r = makeRng(77);
  const trunk = new THREE.CylinderGeometry(0.18, 0.28, 1.6, 5);
  trunk.translate(0, 0.8, 0);
  const crown = new THREE.IcosahedronGeometry(1.5, 1);
  crown.scale(1, 1.15, 1);
  crown.translate(0, 2.7, 0);
  const poplar = cypressGeo(5.4, 0.85);
  const N = 190;
  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number): THREE.InstancedMesh => {
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.frustumCulled = false;
    scene.add(noRay(im));
    return im;
  };
  const crownMat = new THREE.MeshLambertMaterial({ color: 0x74ab4c });
  const iTrunk = mk(trunk, new THREE.MeshLambertMaterial({ color: 0x7a5636 }), N);
  const iCrown = mk(crown, crownMat, N);
  const iPop = mk(poplar, new THREE.MeshLambertMaterial({ color: 0x47803f }), 90);
  const m = new THREE.Matrix4();
  const tint = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const a = r() * TAU;
    const d = 44 + Math.pow(r(), 0.8) * 105;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d - 6;
    const s = 1 + r() * 1.3;
    m.compose(_v.set(x, terrainHeight(x, z) - 0.2, z), _q.setFromEuler(_e.set(0, r() * 6, 0)), _s.set(s, s * (0.85 + r() * 0.4), s));
    iTrunk.setMatrixAt(i, m);
    iCrown.setMatrixAt(i, m);
    iCrown.setColorAt(i, tint.setHSL(0.17 + r() * 0.16, 0.5, 0.5 + r() * 0.2));
  }
  for (let i = 0; i < 90; i++) {
    const a = r() * TAU;
    const d = 40 + r() * 90;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d - 6;
    const s = 0.8 + r() * 1.1;
    m.compose(_v.set(x, terrainHeight(x, z) - 0.2, z), _q.identity(), _s.set(s, s, s));
    iPop.setMatrixAt(i, m);
  }

  // Solarpunk wind turbines on the far ridges
  for (const [x, z, s, ph] of [
    [78, -78, 1.2, 0],
    [98, -50, 1, 2],
    [-96, 44, 1.1, 1],
    [-84, -96, 1.25, 3],
    [30, 108, 1, 4],
  ] as const) {
    const y = terrainHeight(x, z);
    const yaw = Math.atan2(-x, -z);
    group(scene, x, y, z, yaw, (k) => {
      k.put(new THREE.CylinderGeometry(0.28, 0.6, 18, 10), M.cream, 0, 9 * s, 0, 0, 0, 0, s);
      k.sph(M.copper, 0.8 * s, 0, 18 * s, 0);
    });
    const rot = group(scene, x, y + 18 * s, z, yaw);
    const blades = group(rot, 0, 0, 0.8 * s, 0, (k) => {
      for (let i = 0; i < 3; i++) {
        const f = k.at(0, 0, 0, 0, 0, (i / 3) * TAU);
        f.put(new THREE.ConeGeometry(0.55 * s, 8 * s, 4), M.cream, 0, 4.2 * s, 0, 0, 0, 0, 1, 1, 0.25);
      }
      k.sph(M.brass, 0.6 * s);
    });
    c.ambient.push((t) => (blades.rotation.z = t * 0.5 + ph));
  }

  // Meadow apron just outside the walls so it reads as real grass up close
  const k = c.B.kit('apron');
  k.floor(M.grass, -34, 34, 18.2, 26, -0.04);
  k.floor(M.grass, -34, 34, -38, -28, -0.04);
  k.floor(M.grass, -36, -26, -38, 26, -0.045);
  k.floor(M.grass, 26, 36, -38, 26, -0.045);
  k.floor(M.grass, -26, -12, -28, -14, -0.04);
  k.floor(M.grass, 12, 26, -28, -14, -0.04);
  k.floor(M.grass, -26, -12, 2, 18, -0.04);
  k.floor(M.grass, 12, 26, 2, 18, -0.04);
}

function buildMotes(c: Ctx): void {
  const { scene, M } = c;
  const N = 520;
  const r = makeRng(99);
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = -27 + r() * 54;
    pos[i * 3 + 1] = 0.2 + r() * 5;
    pos[i * 3 + 2] = -32 + r() * 51;
    seed[i * 2] = r() * 100;
    seed[i * 2 + 1] = r();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: M.uTime, uMap: { value: M.T.mote } },
    vertexShader: `
      attribute vec2 aSeed; uniform float uTime; varying float vA; varying float vK;
      void main() {
        vec3 p = position;
        float t = uTime * 0.25 + aSeed.x;
        p.x += sin(t * 1.3) * 1.1 + sin(t * 0.37) * 0.8;
        p.y += sin(t * 0.9 + aSeed.x) * 0.5;
        p.z += cos(t * 1.1) * 1.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vK = aSeed.y;
        vA = (0.45 + 0.55 * sin(uTime * (0.8 + aSeed.y * 2.0) + aSeed.x * 3.0)) * smoothstep(0.4, 1.6, -mv.z) * (1.0 - smoothstep(16.0, 30.0, -mv.z));
        gl_PointSize = (22.0 + aSeed.y * 34.0) / max(0.6, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap; varying float vA; varying float vK;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a;
        vec3 col = mix(vec3(1.0, 0.78, 0.32), vec3(0.95, 1.0, 0.55), step(0.8, vK));
        gl_FragColor = vec4(col, a * max(vA, 0.0) * 0.75);
        #include <colorspace_fragment>
      }`,
  });
  const pts = noRay(new THREE.Points(g, mat));
  pts.frustumCulled = false;
  scene.add(pts);
}

function waterMat(c: Ctx, deep: number, shallow: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uTime: c.M.uTime, uDeep: { value: new THREE.Color(deep) }, uShal: { value: new THREE.Color(shallow) } },
    vertexShader: `
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uDeep, uShal; varying vec3 vW;
      void main() {
        vec2 p = vW.xz * 2.4;
        float w1 = sin(p.x * 1.7 + uTime * 1.3 + sin(p.y * 1.4 + uTime));
        float w2 = sin(p.y * 2.1 - uTime * 1.1 + sin(p.x * 1.9 - uTime * 0.7));
        float caustic = pow(1.0 - abs(w1 * 0.5 + w2 * 0.5), 5.0);
        vec3 v = normalize(cameraPosition - vW);
        float fres = pow(1.0 - max(v.y, 0.0), 3.0);
        vec3 col = mix(uDeep, uShal, 0.35 + 0.3 * w1 * w2);
        col += vec3(1.0, 0.95, 0.8) * caustic * 0.4;
        col = mix(col, vec3(0.85, 0.93, 0.95), fres * 0.55);
        float glint = smoothstep(0.93, 1.0, sin(p.x * 5.0 + uTime * 2.0) * sin(p.y * 6.0 - uTime * 2.6));
        col += vec3(1.0, 0.9, 0.65) * glint * 0.7;
        gl_FragColor = vec4(col, 0.84);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ============================================================
// SHARED SHELL: walls, floors, ceilings & roofs of the south wing
// ============================================================
const CEIL = 4.5;

function buildSouthWing(c: Ctx): void {
  const { B, M } = c;
  const k = B.kit('southwing');
  const f = B.kit('foyer');
  const t = B.kit('tea');
  const s = B.kit('study');
  const stone = M.ashlar;
  const H = 4.8;

  // --- Z=18 south walls ---
  const winF: Opening[] = [
    { a: -5.1, b: -2.7, y0: 1.15, y1: 3.75, win: true },
    { a: 2.7, b: 5.1, y0: 1.15, y1: 3.75, win: true },
  ];
  wall(c, f, { axis: 'x', at: 18, from: -8.3, to: 8.3, h: H, neg: M.damask, pos: stone, core: M.cream, openings: winF });
  const winT: Opening[] = [{ a: 14.2, b: 18.2, y0: 1.15, y1: 3.75, win: true }];
  wall(c, t, { axis: 'x', at: 18, from: 8.3, to: 20.3, h: H, neg: M.damaskMint, pos: stone, core: M.cream, openings: winT });
  wall(c, s, { axis: 'x', at: 18, from: -20.3, to: -8.3, h: H, neg: M.damaskRose, pos: stone, core: M.cream });
  // --- Foyer north ---
  wall(c, f, { axis: 'x', at: 6, from: -8.3, to: -2, h: H, neg: stone, pos: M.damask, core: M.cream });
  wall(c, f, { axis: 'x', at: 6, from: 2, to: 8.3, h: H, neg: stone, pos: M.damask, core: M.cream });
  emitWallPiece(f, { axis: 'x', at: 6, from: 0, to: 0, h: 0, neg: stone, pos: M.damask, core: M.cream }, -2, 2, 4.0, H);
  // --- X=-8 (Study | Foyer) ---
  wall(c, f, { axis: 'z', at: -8, from: 5, to: 5.65, h: H, neg: stone, pos: stone });
  wall(c, f, {
    axis: 'z',
    at: -8,
    from: 5.65,
    to: 18.3,
    h: H,
    neg: M.damaskRose,
    pos: M.damask,
    core: M.walnut,
    openings: [{ a: 10.5, b: 13.5, y0: 0, y1: 3.6 }],
  });
  // --- X=8 (Foyer | Tea) ---
  wall(c, f, { axis: 'z', at: 8, from: 5, to: 5.65, h: H, neg: stone, pos: stone });
  wall(c, f, {
    axis: 'z',
    at: 8,
    from: 5.65,
    to: 18.3,
    h: H,
    neg: M.damask,
    pos: M.damaskMint,
    core: M.walnut,
    openings: [
      { a: 7.2, b: 9.8, y0: 0, y1: 3.6 },
      { a: 13.5, b: 16.2, y0: 0, y1: 3.4 },
    ],
  });
  // --- Tea parlor shell ---
  wall(c, t, { axis: 'x', at: 5, from: 8, to: 20.3, h: H, neg: stone, pos: M.damaskMint, core: stone });
  wall(c, t, {
    axis: 'z',
    at: 20,
    from: 5,
    to: 18.3,
    h: H,
    neg: M.damaskMint,
    pos: stone,
    core: M.cream,
    openings: [
      { a: 6.6, b: 9.6, y0: 1.15, y1: 3.75, win: true },
      { a: 12.4, b: 13.6, y0: 1.5, y1: 3.4, win: true },
    ],
  });
  // --- Study shell ---
  wall(c, s, { axis: 'x', at: 5, from: -20.3, to: -8, h: H, neg: stone, pos: M.damaskRose, core: stone });
  wall(c, s, {
    axis: 'z',
    at: -20,
    from: 5,
    to: 18.3,
    h: H,
    neg: stone,
    pos: M.damaskRose,
    core: M.cream,
    openings: [{ a: 9.8, b: 12.2, y0: 1.15, y1: 3.75, win: true }],
  });
  // --- Courtyard south connectors (visible inside the wings too) ---
  wall(c, k, { axis: 'x', at: 6, from: -12.3, to: -8.3, h: H - 0.01, neg: stone, pos: M.damaskRose });
  wall(c, k, { axis: 'x', at: 6, from: 8.3, to: 12.3, h: H - 0.01, neg: stone, pos: M.damaskMint });

  // --- Floors & ceilings ---
  f.floor(M.parquet, -8, 8, 6, 18, 0);
  t.floor(M.parquet, 8, 20, 5, 18, 0);
  s.floor(M.parquet, -20, -8, 5, 18, 0);
  const ceiling = (kk: Kit, x0: number, x1: number, z0: number, z1: number): void => {
    kk.box(M.plaster, x1 - x0, 0.28, z1 - z0, (x0 + x1) / 2, CEIL, (z0 + z1) / 2);
    const n = Math.round((x1 - x0) / 2.6);
    for (let i = 1; i < n; i++) kk.box(M.walnut, 0.2, 0.2, z1 - z0, x0 + ((x1 - x0) * i) / n, CEIL - 0.2, (z0 + z1) / 2);
    const nz = Math.round((z1 - z0) / 3);
    for (let i = 1; i < nz; i++) kk.box(M.walnut, x1 - x0, 0.16, 0.2, (x0 + x1) / 2, CEIL - 0.16, z0 + ((z1 - z0) * i) / nz);
  };
  ceiling(f, -8, 8, 6, 18);
  ceiling(t, 8, 20, 5, 18);
  ceiling(s, -20, -8, 5, 18);

  // --- Roofs (seen from courtyard and sky-deck) ---
  hipRoof(k, M.roof, M.trimStone, -8.1, 8.1, 5.3, 18.7, 4.84, 3.3);
  hipRoof(k, M.roof, M.trimStone, -20.7, -8.1, 4.3, 18.7, 4.84, 2.5);
  hipRoof(k, M.roof, M.trimStone, 8.1, 20.7, 4.3, 18.7, 4.84, 2.5);
  for (const x of [-14.4, 14.4]) {
    for (let i = 0; i < 3; i++) k.box(M.solar, 1.5, 0.05, 1.5, x - 1.9 + i * 1.9, 5.92, 6.55, 0, 0.385);
  }
  // Foyer lantern cupola + sun finial + chimney
  k.cyl(M.trimStone, 1.15, 1.25, 1.2, 0, 7.2, 12, 8);
  k.cyl(M.glassIron, 0.95, 0.95, 1.1, 0, 8.4, 12, 8, true);
  k.cyl(M.lampGlow, 0.3, 0.3, 0.8, 0, 8.5, 12, 12);
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) / 8) * TAU;
    k.cyl(M.cream, 0.07, 0.07, 1.1, Math.cos(a) * 0.98, 8.4, 12 + Math.sin(a) * 0.98, 8);
  }
  k.put(new THREE.SphereGeometry(1.2, 20, 10, 0, TAU, 0, Math.PI / 2), M.copperRoof, 0, 9.5, 12);
  k.cyl(M.brass, 0.04, 0.06, 0.9, 0, 10.6, 12, 8);
  k.put(new THREE.ExtrudeGeometry(starShape(12, 0.5, 0.3), { depth: 0.06, bevelEnabled: false }), M.brass, 0, 11.7, 11.97);
  k.box(M.brick, 1.3, 3.4, 0.9, 0, 5.3, 16.9);
  k.box(M.trimStone, 1.5, 0.2, 1.1, 0, 8.7, 16.9);

  // Coping / cornice along the courtyard facade
  k.box(M.trimStone, 16.8, 0.22, 0.2, 0, 4.4, 5.56);
  for (const sgn of [-1, 1]) {
    k.box(M.trimStone, 4.2, 0.22, 0.2, sgn * 10.2, 4.4, 5.56);
    // Pilasters framing the great door
    k.box(M.trimStone, 0.5, 4.4, 0.16, sgn * 2.45, 0, 5.57);
    k.box(M.trimStone, 0.64, 0.3, 0.26, sgn * 2.45, 0, 5.55);
    k.box(M.trimStone, 0.64, 0.26, 0.26, sgn * 2.45, 4.0, 5.55);
  }
  k.put(new THREE.ExtrudeGeometry(starShape(16, 0.5, 0.36), { depth: 0.08, bevelEnabled: false }), M.brass, 0, 4.42, 5.36);
}

function doorTrim(k: Kit, M: Mats, w: number, h: number): void {
  // local +Z faces the viewer, opening centred on x=0
  k.box(M.walnutRed, 0.22, h, 0.1, -w / 2 - 0.11, 0, 0.05);
  k.box(M.walnutRed, 0.22, h, 0.1, w / 2 + 0.11, 0, 0.05);
  k.box(M.walnutRed, w + 0.6, 0.26, 0.13, 0, h, 0.06);
  k.box(M.brass, w + 0.66, 0.05, 0.16, 0, h + 0.26, 0.07);
}

// ============================================================
// GRAND FOYER
// ============================================================
function buildFoyer(c: Ctx): void {
  const { B, M, scene } = c;
  const k = B.kit('foyer');

  trim(c, k, 'x', 6.35, 1, -7.65, 7.65, [[-2.25, 2.25]], CEIL);
  trim(c, k, 'x', 17.65, -1, -7.65, 7.65, [[-1.5, 1.5]], CEIL);
  trim(c, k, 'z', -7.65, 1, 6.35, 17.65, [[10.25, 13.75]], CEIL);
  trim(c, k, 'z', 7.65, -1, 6.35, 17.65, [[6.95, 10.05], [13.25, 16.45]], CEIL);
  doorTrim(k.at(0, 0, 6.36, 0), M, 4, 4.0);
  doorTrim(k.at(-7.64, 0, 12, Math.PI / 2), M, 3, 3.6);
  doorTrim(k.at(7.64, 0, 8.5, -Math.PI / 2), M, 2.6, 3.6);
  doorTrim(k.at(7.64, 0, 14.85, -Math.PI / 2), M, 2.7, 3.4);

  // Sun rug
  k.disc(M.rug, 3.1, 0, 0.012, 12.2, 64);

  // Chandelier: brass armillary sun
  const chand = group(scene, 0, 3.45, 12.2, 0, (g) => {
    g.cyl(M.brass, 0.03, 0.03, 1.0, 0, 0, 0, 8);
    g.sph(M.lampGlow, 0.2, 0, -0.05, 0);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      const x = Math.cos(a) * 0.95;
      const z = Math.sin(a) * 0.95;
      g.rod(M.brass, 0.018, [0, 0.1, 0], [x, -0.1, z]);
      g.cyl(M.brass, 0.07, 0.04, 0.05, x, -0.12, z, 10);
      g.cyl(M.lampGlow, 0.035, 0.045, 0.16, x, -0.07, z, 8);
    }
    g.torus(M.brass, 0.95, 0.028, 0, -0.12, 0, Math.PI / 2);
  });
  const ringA = group(chand, 0, -0.05, 0, 0, (g) => g.torus(M.brass, 0.42, 0.018));
  const ringB = group(chand, 0, -0.05, 0, 0, (g) => g.torus(M.copper, 0.52, 0.016));
  c.ambient.push((t) => {
    ringA.rotation.set(t * 0.4, t * 0.3, 0);
    ringB.rotation.set(0.6, -t * 0.35, t * 0.2);
  });
  c.light(0, 3.1, 12.2, 0xffd9a0, 26, 15);

  // --- Fireplace (south wall) ---
  const fp = k.at(0, 0, 17.65, Math.PI);
  fp.box(M.brick, 0.75, 1.7, 0.5, -1.1, 0, 0.25);
  fp.box(M.brick, 0.75, 1.7, 0.5, 1.1, 0, 0.25);
  fp.box(M.soot, 1.5, 1.7, 0.06, 0, 0, 0.03);
  fp.box(M.brick, 2.95, 0.4, 0.5, 0, 1.5, 0.25);
  fp.box(M.marble, 3.3, 0.14, 0.72, 0, 1.9, 0.33);
  for (const sx of [-1, 1]) {
    fp.put(lathe([[0.01, 0], [0.16, 0], [0.16, 0.1], [0.1, 0.16], [0.11, 1.5], [0.16, 1.62], [0.16, 1.72], [0.01, 1.72]], 18), M.marble, sx * 1.12, 0.14, 0.56);
    fp.box(M.marble, 0.42, 0.14, 0.42, sx * 1.12, 0, 0.56);
  }
  fp.box(M.trimStone, 3.3, 0.06, 1.0, 0, 0, 0.75);
  fp.box(M.brick, 2.0, 2.4, 0.3, 0, 2.04, 0.15);
  for (let i = 0; i < 4; i++) fp.rod(M.bark, 0.07, [-0.45, 0.16 + (i % 2) * 0.1, 0.15 + i * 0.07], [0.45, 0.2 + ((i + 1) % 2) * 0.12, 0.2 + i * 0.05]);
  fp.box(M.ember, 0.9, 0.08, 0.34, 0, 0.06, 0.26);
  fp.box(M.darkIron, 1.1, 0.05, 0.06, 0, 0.35, 0.5);
  // Mantel: portrait sun mirror, candles, small clock
  fp.put(new THREE.CircleGeometry(0.62, 40), M.silver, 0, 3.05, 0.31);
  fp.torus(M.brass, 0.66, 0.06, 0, 3.05, 0.31);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    fp.put(new THREE.ConeGeometry(0.06, 0.3, 4), M.brass, Math.cos(a) * 0.86, 3.05 + Math.sin(a) * 0.86, 0.31, 0, 0, a - Math.PI / 2);
  }
  for (const x of [-1.2, -0.95, 0.95, 1.2]) {
    fp.cyl(M.brass, 0.05, 0.07, 0.1, x, 2.04, 0.4, 10);
    fp.cyl(M.cream, 0.03, 0.03, 0.22, x, 2.14, 0.4, 8);
    fp.sph(M.lampGlow, 0.025, x, 2.4, 0.4, 1, 1.8, 1, 8);
  }
  // Flames
  const flameMat = new THREE.SpriteMaterial({ map: M.T.glow, color: 0xff8a2e, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const flames: THREE.Sprite[] = [];
  for (let i = 0; i < 9; i++) {
    const fl = noRay(new THREE.Sprite(flameMat));
    fl.position.set(-0.4 + i * 0.1, 0.4, 17.35);
    scene.add(fl);
    flames.push(fl);
  }
  c.ambient.push((t) => {
    flames.forEach((fl, i) => {
      const b = 0.5 + 0.5 * Math.sin(t * (6 + i) + i * 2.1) * Math.sin(t * 3.7 + i);
      fl.scale.set(0.34 + b * 0.12, 0.6 + b * 0.5, 1);
      fl.position.y = 0.38 + b * 0.18;
    });
    M.ember.emissiveIntensity = 2.4 + Math.sin(t * 9) * 0.35 + Math.sin(t * 5.3) * 0.3;
  });
  c.light(0, 0.9, 16.7, 0xff8c3c, 16, 9, 0.4);

  // Armchairs facing the hearth
  for (const [x, ry] of [[-2.7, Math.PI - 0.9], [2.7, Math.PI + 0.9]] as const) armchair(k.at(x, 0, 16.6, ry), M, M.velvetTeal);
  // Tucked-away commemorative brass plaque on the side of the Foyer fireplace
  plaque(
    c,
    k,
    makePlaqueTexture('SMALL BRASS PLAQUE', 'Gavin is the best\nand is my favorite\ncoworker.', { style: 'brass', w: 512, h: 320 }),
    0.42,
    0.26,
    -1.66,
    1.12,
    17.25,
    -Math.PI / 2,
    0,
    M.brass,
    0.35,
  );
  c.reg(
    {
      id: 'easter_egg_gavin',
      label: 'Read Small Brass Plaque',
      actionType: 'modal',
      modalId: 'easter_egg_gavin',
      maxDistance: 3.2,
    },
    -1.7,
    1.12,
    17.25,
    0.22,
    0.45,
    0.55,
  );
  pottedPlant(c, k, -7.1, 14.5, 1, 3);
  pottedPlant(c, k, 7.1, 11.7, 1.05, 4);
  pottedPlant(c, k, 7.1, 17.1, 1.1, 8);
  pottedPlant(c, k, -7.1, 6.9, 1, 12);
  for (const [x, z, ry] of [[-2.9, 6.36, 0], [2.9, 6.36, 0], [-7.64, 9.7, Math.PI / 2], [-7.64, 14.3, Math.PI / 2], [7.64, 12.9, -Math.PI / 2], [7.64, 10.4, -Math.PI / 2]] as const) sconce(k.at(x, 2.5, z, ry), M);

  // Estate map plaque (east wall)
  plaque(c, k, M.T.blueprint, 1.7, 1.7, 7.6, 2.0, 11.65, -Math.PI / 2, 0, M.walnutRed, 0.4);

  // --- Grandfather clock (north wall, left of the doors) ---
  const gx = -3.75;
  const gz = 6.72;
  const gk = k.at(gx, 0, gz, 0);
  gk.box(M.walnutRed, 1.05, 0.5, 0.6);
  gk.box(M.walnutRed, 0.14, 1.25, 0.5, -0.36, 0.5, 0);
  gk.box(M.walnutRed, 0.14, 1.25, 0.5, 0.36, 0.5, 0);
  gk.box(M.ebony, 0.6, 1.25, 0.05, 0, 0.5, -0.2);
  gk.box(M.walnutRed, 1.15, 1.05, 0.6, 0, 1.75, 0);
  gk.box(M.brass, 1.2, 0.06, 0.64, 0, 1.73, 0);
  gk.put(new THREE.CylinderGeometry(0.6, 0.6, 0.62, 30, 1, false, 0, Math.PI), M.walnutRed, 0, 2.78, 0, 0, -Math.PI / 2, Math.PI / 2);
  gk.torus(M.brass, 0.6, 0.035, 0, 2.78, 0.3, 0, 0, 0, 30, Math.PI);
  gk.sph(M.brass, 0.09, 0, 3.46, 0);
  gk.torus(M.brass, 0.46, 0.045, 0, 2.3, 0.31);
  gk.panel(M.glass, 0.6, 1.25, 0, 1.12, 0.2);
  const face = group(scene, gx, 2.3, gz + 0.31, 0, (g) => g.put(new THREE.CircleGeometry(0.45, 48), paintedMat(M.T.clockFace, 0.35)));
  const hourHand = group(face, 0, 0, 0.025, 0, (g) => {
    g.box(M.ebony, 0.045, 0.24, 0.012, 0, -0.04, 0);
    g.cone(M.ebony, 0.05, 0.09, 0, 0.18, 0, 4);
  });
  const minHand = group(face, 0, 0, 0.04, 0, (g) => {
    g.box(M.ebony, 0.028, 0.38, 0.012, 0, -0.05, 0);
    g.sph(M.brass, 0.035, 0, 0, 0.01, 1, 1, 1, 10);
  });
  const pend = group(scene, gx, 1.72, gz, 0, (g) => {
    g.cyl(M.brass, 0.012, 0.012, 0.85, 0, -0.85, 0, 8);
    g.put(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 30), M.brass, 0, -0.9, 0, Math.PI / 2);
    g.put(new THREE.ExtrudeGeometry(starShape(10, 0.11, 0.07), { depth: 0.02, bevelEnabled: false }), M.copper, 0, -0.9, 0.02);
  });
  const clockHalo = glowSprite(M, 0xffc766, 2.2, 0);
  clockHalo.position.set(gx, 2.3, gz + 0.5);
  scene.add(clockHalo);
  c.ambient.push((t) => (pend.rotation.z = Math.sin(t * 2.6) * 0.16));
  c.updaters.push((f) => {
    const d = f.p.clockDigits;
    const hh = d[0] * 10 + d[1];
    const mm = d[2] * 10 + d[3];
    hourHand.rotation.z = dampAngle(hourHand.rotation.z, -(((hh % 12) + (mm % 60) / 60) / 12) * TAU, 4, f.dt);
    minHand.rotation.z = dampAngle(minHand.rotation.z, -((mm % 60) / 60) * TAU, 4, f.dt);
    (clockHalo.material as THREE.SpriteMaterial).opacity = f.state.solvedPuzzles.p1_foyer_clock ? 0.3 + Math.sin(f.t * 2) * 0.06 : 0;
  });
  c.reg(
    {
      id: 'p1_foyer_clock',
      label: 'Set the Grandfather Clock',
      actionType: 'modal',
      modalId: 'p1_foyer_clock',
      getLabel: (s) => solvedTag(s, 'p1_foyer_clock', 'Set the Grandfather Clock'),
    },
    gx,
    1.75,
    gz,
    1.25,
    3.5,
    0.8,
  );

  // --- Welcome lectern ---
  lectern(c, k, 3.5, 8.5, 0.0, makePlaqueTexture(WORLD_CLUES.clue_welcome_ledger.title, WORLD_CLUES.clue_welcome_ledger.body, { w: 900, h: 720 }), 'clue_welcome_ledger');

  // --- Twin entry levers ---
  const left = leverUnit(c, -5.5, 1.35, 6.4, 0, 'foyer', false, 0xffb84a);
  const right = leverUnit(c, 5.5, 1.35, 6.4, 0, 'foyer', false, 0xffb84a);
  c.updaters.push((f) => {
    const powered = f.state.solvedPuzzles.p1_foyer_clock;
    const done = f.state.solvedPuzzles.p1_twin_levers;
    const now = Date.now();
    for (const [unit, at] of [
      [left, f.p.foyerLeverLeftAt],
      [right, f.p.foyerLeverRightAt],
    ] as const) {
      const down = done || (at > 0 && now - at < 2500 && now - at > -4000);
      unit.arm.rotation.x = damp(unit.arm.rotation.x, down ? 0.75 : -0.75, 10, f.dt);
      unit.lamp.emissiveIntensity = done ? 2.2 : powered ? 1.2 + Math.sin(f.t * 5) * 0.7 : 0.12;
    }
  });
  for (const [id, x, side] of [
    ['lever_foyer_left', -5.5, 'Left'],
    ['lever_foyer_right', 5.5, 'Right'],
  ] as const) {
    c.reg(
      {
        id,
        label: `Pull the ${side} Entry Lever`,
        actionType: 'direct',
        maxDistance: 3.2,
        getLabel: (s) =>
          s.solvedPuzzles.p1_twin_levers
            ? null
            : s.solvedPuzzles.p1_foyer_clock
              ? `Pull the ${side} Entry Lever (together with your partner!)`
              : `${side} Entry Lever (no power yet)`,
      },
      x,
      1.4,
      6.6,
      0.9,
      1.4,
      0.8,
    );
  }

  // --- Brass floor plate for the Tea Booth grille ---
  floorPlate(c, 'foyer_booth_plate', 0xffc24a, (f) => f.p.foyerPlatePressedBy.length > 0, 0.4);

  oracleBooth(c, 'foyer', -6.5, 16.5, Math.PI * 0.75, 'open_oracle');
  pedestal(c, k, -5.9, 9.2, 1.0);
}

function armchair(k: Kit, M: Mats, cloth: THREE.Material): void {
  k.box(cloth, 0.8, 0.22, 0.75, 0, 0.28, 0);
  k.box(cloth, 0.84, 0.85, 0.18, 0, 0.35, -0.36, 0, -0.14);
  k.box(cloth, 0.16, 0.36, 0.72, -0.42, 0.34, 0);
  k.box(cloth, 0.16, 0.36, 0.72, 0.42, 0.34, 0);
  for (const sx of [-1, 1]) {
    k.put(new THREE.CylinderGeometry(0.09, 0.09, 0.72, 12), cloth, sx * 0.42, 0.7, 0, Math.PI / 2);
    for (const sz of [-1, 1]) k.cyl(M.walnut, 0.04, 0.03, 0.28, sx * 0.36, 0, sz * 0.3, 8);
  }
  k.box(M.velvetRed, 0.4, 0.34, 0.1, 0.06, 0.5, -0.2, 0.3, -0.25);
}

function sconce(k: Kit, M: Mats): void {
  k.box(M.brass, 0.14, 0.34, 0.03, 0, -0.17, 0.015);
  k.rod(M.brass, 0.014, [0, -0.05, 0.02], [0, 0, 0.16]);
  k.cyl(M.brass, 0.06, 0.03, 0.04, 0, 0, 0.17, 10);
  k.cyl(M.lampGlow, 0.065, 0.045, 0.16, 0, 0.04, 0.17, 10);
}

function lectern(c: Ctx, k: Kit, x: number, z: number, ry: number, tex: THREE.Texture, clueId: string, y = 0): void {
  const { M } = c;
  const l = k.at(x, y, z, ry);
  l.put(lathe([[0.01, 0], [0.34, 0], [0.34, 0.06], [0.14, 0.14], [0.08, 0.3], [0.08, 0.85], [0.16, 0.98], [0.01, 0.98]], 20), M.walnutRed);
  l.torus(M.brass, 0.1, 0.02, 0, 0.5, 0, Math.PI / 2);
  const top = l.at(0, 1.1, 0.02, 0, 0.62 - Math.PI / 2);
  top.box(M.walnutRed, 0.98, 0.8, 0.06, 0, -0.4, -0.03);
  top.box(M.brass, 1.0, 0.04, 0.12, 0, -0.42, 0.02);
  top.panel(paintedMat(tex, 0.3), 0.88, 0.7, 0, 0.02, 0.012);
  c.reg({ id: clueId, label: clueLabel(clueId), actionType: 'clue', clueId, maxDistance: 3.4 }, x, y + 0.85, z, 1.1, 1.5, 1.0, ry);
}

// ============================================================
// TEA PARLOR
// ============================================================
function buildTea(c: Ctx): void {
  const { B, M, scene } = c;
  const k = B.kit('tea');
  const wood = M.walnut;

  // South booth trim
  trim(c, k, 'x', 17.65, -1, 8.35, 19.65, [], CEIL, wood);
  trim(c, k, 'z', 8.35, 1, 11.2, 17.65, [[13.25, 16.45]], CEIL, wood);
  trim(c, k, 'z', 19.65, -1, 11.2, 17.65, [], CEIL, wood);
  // North booth trim
  trim(c, k, 'z', 8.35, 1, 6.35, 10.8, [[6.95, 10.05]], CEIL, wood);
  trim(c, k, 'x', 6.35, 1, 8.35, 12.3, [], CEIL, wood);
  trim(c, k, 'x', 5.35, 1, 12.35, 19.65, [], CEIL, wood);
  trim(c, k, 'z', 12.35, 1, 5.35, 6.35, [], CEIL, wood);
  trim(c, k, 'z', 19.65, -1, 5.35, 10.8, [], CEIL, wood);
  // East end of the courtyard wall stub that projects into the booth
  emitWallPiece(k, { axis: 'z', at: 12, from: 0, to: 0, h: 0, neg: M.damaskMint, pos: M.damaskMint }, 5.35, 6.3, 0, CEIL);
  doorTrim(k.at(8.36, 0, 8.5, Math.PI / 2), M, 2.6, 3.6);
  doorTrim(k.at(8.36, 0, 14.85, Math.PI / 2), M, 2.7, 3.4);

  // --- Crystal partition at Z=11 (West half X:8.4..13.5 is clear viewing glass; East half X:13.5..19.65 is a solid walnut gallery wall) ---
  const gk = k;
  gk.panel(M.glass, 5.2, 3.9, 10.95, 2.45, 11);
  gk.box(M.walnutRed, 5.2, 0.45, 0.4, 10.95, 0, 11);
  gk.box(M.brass, 5.2, 0.06, 0.42, 10.95, 0.45, 11);
  gk.box(M.brass, 11.3, 0.12, 0.22, 14, 4.38, 11);
  gk.box(M.brass, 5.2, 0.05, 0.07, 10.95, 3.4, 11);
  for (let i = 0; i <= 4; i++) gk.box(M.brass, 0.07, 3.95, 0.12, 8.4 + (i * 5.1) / 4, 0.5, 11);
  for (let i = 0; i < 4; i++) {
    const cx = 8.4 + ((i + 0.5) * 5.1) / 4;
    gk.torus(M.brass, 0.34, 0.018, cx, 3.88, 11);
    gk.put(new THREE.CircleGeometry(0.15, 20), i % 2 ? M.petalGold : M.orchidCyan, cx, 3.88, 11.01);
    gk.put(new THREE.CircleGeometry(0.15, 20), i % 2 ? M.petalGold : M.orchidCyan, cx, 3.88, 10.99, 0, Math.PI);
  }
  // Solid walnut-and-brass gallery wall on the East half (X: 13.5..19.7, Z: 10.75..11.25)
  // Completely opaque from the South Booth; the Botanical Grid Mural faces NORTH into the North Booth!
  gk.box(M.walnutRed, 6.2, 4.45, 0.46, 16.6, 0, 11);
  gk.box(M.brass, 6.24, 0.07, 0.5, 16.6, 0.95, 11);
  gk.box(M.brass, 6.24, 0.07, 0.5, 16.6, 4.38, 11);
  // Decorative solid brass diamond trim on the South-facing back of the gallery wall
  for (const dx of [14.8, 16.6, 18.4]) {
    gk.torus(M.brass, 0.36, 0.022, dx, 2.55, 11.25);
  }
  // Speaking tube
  for (const s of [-1, 1]) {
    const f = gk.at(9.1, 1.5, 11, s > 0 ? 0 : Math.PI);
    f.put(new THREE.CylinderGeometry(0.2, 0.06, 0.26, 24, 1, true), M.brass, 0, 0, 0.22, Math.PI / 2);
    f.torus(M.brass, 0.2, 0.02, 0, 0, 0.35);
    f.put(new THREE.CylinderGeometry(0.08, 0.08, 0.2, 18), M.copper, 0, 0, 0.06, Math.PI / 2);
  }
  // Low decorative planter under the clear glass window (leaves clear partner sightline above waist!)
  gk.box(M.walnutRed, 4.2, 0.42, 0.32, 11.1, 0, 10.6);
  gk.box(M.soil, 4.1, 0.04, 0.26, 11.1, 0.41, 10.6);
  const r = makeRng(21);
  for (let i = 0; i < 10; i++) {
    const x = 9.3 + i * 0.4;
    gk.put(fernGeo(11, 0.42 + r() * 0.14, 60 + i, 0.14, 0.4), [M.leaf, M.leafDark, M.leafLime][i % 3], x, 0.42, 10.6, 0, r() * 6, 0, 0.45, 0.65, 0.3);
  }

  // --- North booth mural (mounted on the NORTH-facing side of the solid gallery wall at Z=10.74!) ---
  // 100% physically invisible from the South Booth; fully readable from inside the North Booth!
  plaque(c, k, M.T.mural, 5.1, 3.2, 16.55, 2.35, 10.74, Math.PI, 0, M.walnutRed, 0.42);
  c.reg({ id: 'clue_tea_north_mural', label: 'Study the Botanical Grid Mural', actionType: 'clue', clueId: 'clue_tea_north_mural', maxDistance: 4.6 }, 16.55, 2.15, 10.6, 5.3, 3.5, 0.35);
  k.box(M.walnutRed, 2.2, 0.1, 0.5, 10.4, 0.42, 6.75);
  k.box(M.velvetRed, 2.1, 0.1, 0.46, 10.4, 0.5, 6.75);
  for (const x of [9.5, 11.3]) k.box(M.walnutRed, 0.1, 0.42, 0.45, x, 0, 6.75);
  pottedPlant(c, k, 19.1, 6, 1.1, 33);
  pottedPlant(c, k, 12.85, 5.8, 0.95, 34);
  for (const [x, z, ry] of [[12.95, 5.4, 0], [19.1, 5.4, 0], [8.36, 12.2, Math.PI / 2], [19.64, 17.1, -Math.PI / 2]] as const) sconce(k.at(x, 2.6, z, ry), M);
  c.light(15.5, 3.4, 8, 0xffe2b0, 18, 11);
  c.light(14, 3.3, 14.6, 0xffd9a0, 22, 13);

  // Ceiling teapot lamps
  for (const [x, z] of [[14, 14.6], [15.5, 8]] as const) {
    k.cyl(M.brass, 0.02, 0.02, 0.9, x, 3.6, z, 6);
    k.put(new THREE.SphereGeometry(0.42, 24, 12, 0, TAU, 0, Math.PI / 2), M.copper, x, 3.3, z, 0, 0, 0, 1, 0.8, 1);
    k.sph(M.lampGlow, 0.18, x, 3.28, z);
  }
  k.disc(M.rug, 2.0, 14.2, 0.013, 14.8, 48);

  // --- 4-dial Cipher Console ---
  const cx = 11.4;
  const ck = k.at(cx, 0, 11.7, 0);
  ck.box(M.walnutRed, 2.2, 0.85, 0.6);
  ck.box(M.brass, 2.26, 0.05, 0.66, 0, 0.85, 0);
  const deck = ck.at(0, 1.12, 0.06, 0, -0.6);
  deck.box(M.walnut, 2.14, 0.62, 0.1, 0, -0.31, -0.05);
  // Offset cleanly behind walnut back face (no coplanar Z-fighting!)
  deck.box(M.brass, 2.18, 0.66, 0.03, 0, -0.33, -0.118);
  const symTex: Partial<Record<CipherSymbol, THREE.Texture>> = {};
  for (const s of CIPHER_SYMBOLS) symTex[s.id] = makeSymbolTexture(s.id);
  const cons = group(scene, cx, 1.12, 11.76, 0);
  cons.rotation.x = -0.6;
  const dialMats: THREE.MeshStandardMaterial[] = [];
  const dialGroups: THREE.Group[] = [];
  for (let i = 0; i < 4; i++) {
    const mat = paintedMat(symTex.sun as THREE.Texture, 0.4);
    dialMats.push(mat);
    const x = -0.78 + i * 0.52;
    dialGroups.push(
      group(cons, x, 0.02, 0.02, 0, (g) => {
        g.put(new THREE.CircleGeometry(0.19, 36), mat, 0, 0, 0.02);
        g.torus(M.brass, 0.21, 0.03, 0, 0, 0.01);
      }),
    );
    deck.put(gearGeo(16, 0.25, 0.03, 0.2, 0), M.brassDark, x, 0.02, 0.01);
  }
  const lastDial: (CipherSymbol | null)[] = [null, null, null, null];
  c.updaters.push((f) => {
    f.p.teaCipherDials.forEach((s, i) => {
      if (lastDial[i] !== s) {
        lastDial[i] = s;
        const tex = symTex[s] ?? null;
        dialMats[i].map = tex;
        dialMats[i].emissiveMap = tex;
        dialGroups[i].rotation.z = -0.9;
      }
      dialGroups[i].rotation.z = damp(dialGroups[i].rotation.z, 0, 7, f.dt);
      dialMats[i].emissiveIntensity = f.state.solvedPuzzles.p2_tea_cipher ? 0.85 : 0.4;
    });
  });
  c.reg(
    { id: 'p2_tea_cipher', label: 'Use the 4-Dial Cipher Console', actionType: 'modal', modalId: 'p2_tea_cipher', getLabel: (s) => solvedTag(s, 'p2_tea_cipher', 'Use the 4-Dial Cipher Console') },
    cx,
    0.85,
    11.75,
    2.3,
    1.4,
    0.8,
  );

  // --- Apothecary balance table (east wall) ---
  const bk = k.at(19.15, 0, 14.9, -Math.PI / 2);
  bk.box(M.walnutRed, 2.6, 0.08, 0.9, 0, 0.84, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bk.cyl(M.walnutRed, 0.05, 0.04, 0.84, sx * 1.15, 0, sz * 0.36, 10);
  bk.box(M.walnutRed, 2.5, 0.16, 0.8, 0, 0.68, 0);
  bk.cyl(M.brass, 0.22, 0.26, 0.06, -0.3, 0.92, -0.05, 24);
  bk.cyl(M.brass, 0.03, 0.04, 0.62, -0.3, 0.96, -0.05, 12);
  bk.sph(M.brass, 0.06, -0.3, 1.6, -0.05);
  const bal = group(scene, 19.15, 0, 14.9, -Math.PI / 2);
  const beam = group(bal, -0.3, 1.55, -0.05, 0, (g) => {
    g.box(M.brass, 1.16, 0.035, 0.05, 0, -0.017, 0);
    g.sph(M.brass, 0.04, -0.56, 0, 0);
    g.sph(M.brass, 0.04, 0.56, 0, 0);
  });
  const pans = [-1, 1].map((s) =>
    group(bal, -0.3 + s * 0.56, 1.5, -0.05, 0, (g) => {
      for (let j = 0; j < 3; j++) {
        const a = (j / 3) * TAU;
        g.rod(M.brass, 0.006, [0, 0, 0], [Math.cos(a) * 0.18, -0.36, Math.sin(a) * 0.18], 5);
      }
      g.put(lathe([[0.01, -0.42], [0.1, -0.41], [0.2, -0.36], [0.21, -0.35]], 24), M.brass);
    }),
  );
  const canColors = [0xffb030, 0x46b878, 0xf06a8a, 0x9fe6c8];
  const cans = canColors.map((col, i) => {
    const x = 0.5 + (i % 4) * 0.2;
    bk.cyl(M.brass, 0.085, 0.085, 0.05, x, 0.92, 0.18, 18);
    return group(bal, x, 0.97, 0.18, 0, (g) => {
      g.cyl(M.glow(col, 0.35), 0.075, 0.075, 0.3, 0, 0, 0, 18);
    });
  });
  bk.cyl(M.cream, 0.1, 0.06, 0.1, -1.05, 0.92, 0.2, 16);
  bk.put(lathe([[0.01, 0], [0.1, 0], [0.16, 0.08], [0.15, 0.18], [0.06, 0.24], [0.01, 0.25]], 20), M.copper, -1.0, 0.92, -0.14);
  c.updaters.push((f) => {
    const w = f.p.teaWeights;
    const done = f.state.solvedPuzzles.p3_tea_balance;
    const total = w.amber + w.jade + w.rose + w.mint;
    const tilt = done ? 0 : Math.max(-0.2, Math.min(0.2, (total - 33) * 0.02)) + Math.sin(f.t * 1.3) * 0.02;
    beam.rotation.z = damp(beam.rotation.z, tilt, 3, f.dt);
    pans.forEach((p, i) => (p.position.y = 1.5 + Math.sin(beam.rotation.z) * (i ? 0.56 : -0.56)));
    [w.amber, w.jade, w.rose, w.mint].forEach((v, i) => (cans[i].scale.y = damp(cans[i].scale.y, 0.25 + v * 0.09, 6, f.dt)));
  });
  c.reg(
    { id: 'p3_tea_balance', label: 'Use the Apothecary Tea Scale', actionType: 'modal', modalId: 'p3_tea_balance', getLabel: (s) => solvedTag(s, 'p3_tea_balance', 'Use the Apothecary Tea Scale') },
    19.15,
    0.95,
    14.9,
    2.6,
    1.6,
    0.95,
    -Math.PI / 2,
  );
  plaque(c, k, makePlaqueTexture(WORLD_CLUES.clue_tea_balance_plaque.title, WORLD_CLUES.clue_tea_balance_plaque.body, { style: 'brass', w: 800, h: 560 }), 1.3, 0.9, 19.58, 2.3, 14.9, -Math.PI / 2);
  c.reg({ id: 'clue_tea_balance_plaque', label: clueLabel('clue_tea_balance_plaque'), actionType: 'clue', clueId: 'clue_tea_balance_plaque', maxDistance: 4 }, 19.5, 2.3, 14.9, 1.5, 1.1, 0.25, -Math.PI / 2);
  // Secret drawer with the Sun medallion
  const drawer = group(bal, -0.85, 0.7, 0.3, 0, (g) => {
    g.box(M.walnut, 0.5, 0.12, 0.4, 0, 0, 0);
    g.box(M.velvetRed, 0.44, 0.01, 0.34, 0, 0.115, 0);
    g.sph(M.brass, 0.03, 0, 0.06, 0.21);
    g.put(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 24), M.brass, 0, 0.135, 0);
    g.put(new THREE.ExtrudeGeometry(starShape(12, 0.09, 0.055), { depth: 0.012, bevelEnabled: false }), M.glow(0xffb02e, 0.8), 0, 0.146, 0, -Math.PI / 2);
  });
  c.updaters.push((f) => (drawer.position.z = damp(drawer.position.z, f.state.solvedPuzzles.p3_tea_balance ? 0.62 : 0.2, 4, f.dt)));
  c.reg(
    {
      id: 'clue_core_sun_cardinal',
      label: clueLabel('clue_core_sun_cardinal'),
      actionType: 'clue',
      clueId: 'clue_core_sun_cardinal',
      enabled: (s) => s.solvedPuzzles.p3_tea_balance,
    },
    18.5,
    0.85,
    14.05,
    0.6,
    0.4,
    0.6,
  );

  // --- Supply cabinet (south wall) ---
  const sk = k.at(11.6, 0, 17.35, Math.PI);
  sk.box(M.walnutRed, 2.2, 1.0, 0.56);
  sk.box(M.marble, 2.3, 0.06, 0.64, 0, 1.0, 0.02);
  for (const x of [-0.55, 0.55]) {
    sk.box(M.walnut, 0.9, 0.7, 0.04, x, 0.15, 0.28);
    sk.sph(M.brass, 0.03, x * 0.3, 0.5, 0.32);
  }
  sk.box(M.walnutRed, 2.2, 0.06, 0.34, 0, 2.0, -0.1);
  sk.box(M.walnutRed, 2.2, 0.06, 0.34, 0, 2.5, -0.1);
  sk.box(M.walnutRed, 0.06, 1.6, 0.34, -1.1, 1.06, -0.1);
  sk.box(M.walnutRed, 0.06, 1.6, 0.34, 1.1, 1.06, -0.1);
  const tins = [M.petalGold, M.copper, M.velvetTeal, M.petalPink, M.brass, M.verdigris];
  for (let i = 0; i < 9; i++) {
    sk.cyl(tins[i % 6], 0.085, 0.085, 0.22, -0.92 + i * 0.23, 2.06, -0.1, 14);
    sk.cyl(M.brass, 0.09, 0.09, 0.03, -0.92 + i * 0.23, 2.28, -0.1, 14);
  }
  sk.cyl(M.velvetTeal, 0.2, 0.22, 0.04, 0, 1.06, 0.06, 24);
  // Corner café table
  const tk = k.at(9.5, 0, 17.0, 0);
  tk.cyl(M.marble, 0.5, 0.5, 0.05, 0, 0.74, 0, 30);
  tk.cyl(M.iron, 0.04, 0.05, 0.74, 0, 0, 0, 10);
  tk.cyl(M.iron, 0.28, 0.32, 0.04, 0, 0, 0, 20);
  tk.put(lathe([[0.01, 0], [0.12, 0], [0.18, 0.1], [0.16, 0.2], [0.06, 0.26], [0.01, 0.27]], 20), M.cream, 0, 0.79, 0);
  for (const [x, z] of [[0.28, 0.1], [-0.26, 0.16]] as const) tk.cyl(M.cream, 0.07, 0.045, 0.07, x, 0.79, z, 14);
}

// ============================================================
// ALCHEMIST'S STUDY
// ============================================================
function buildStudy(c: Ctx): void {
  const { B, M, scene } = c;
  const k = B.kit('study');
  trim(c, k, 'x', 17.65, -1, -19.65, -8.35, [], CEIL, M.walnutRed);
  trim(c, k, 'z', -19.65, 1, 5.35, 17.65, [], CEIL, M.walnutRed);
  trim(c, k, 'z', -8.35, -1, 6.35, 17.65, [[10.25, 13.75]], CEIL, M.walnutRed);
  trim(c, k, 'x', 5.35, 1, -19.65, -12.35, [], CEIL, M.walnutRed);
  trim(c, k, 'x', 6.35, 1, -12.35, -8.35, [], CEIL, M.walnutRed);
  trim(c, k, 'z', -12.35, -1, 5.35, 6.35, [], CEIL, M.walnutRed);
  emitWallPiece(k, { axis: 'z', at: -12, from: 0, to: 0, h: 0, neg: M.damaskRose, pos: M.damaskRose }, 5.35, 6.3, 0, CEIL);
  k.disc(M.rug, 2.6, -14, 0.012, 11.8, 56);

  // Bookshelves along the north wall
  for (let i = 0; i < 3; i++) {
    const x = -18.4 + i * 2.35;
    const b = k.at(x, 0, 5.56, 0);
    b.box(M.walnutRed, 2.25, 3.6, 0.06, 0, 0, -0.16);
    b.box(M.walnutRed, 0.1, 3.6, 0.4, -1.1, 0, 0);
    b.box(M.walnutRed, 0.1, 3.6, 0.4, 1.1, 0, 0);
    for (let s = 0; s < 4; s++) b.box(M.walnutRed, 2.2, 0.06, 0.4, 0, 0.1 + s * 1.15, 0);
    b.box(M.walnutRed, 2.4, 0.16, 0.48, 0, 3.6, 0);
    b.box(M.brass, 2.4, 0.03, 0.5, 0, 3.58, 0);
    for (let s = 0; s < 3; s++) b.panel(M.books, 2.1, 1.02, 0, 0.7 + s * 1.15, 0.12);
  }
  // Rolling ladder
  for (const x of [-15.4, -14.95]) k.rod(M.brass, 0.025, [x, 0.02, 6.6], [x, 3.4, 5.85]);
  for (let i = 0; i < 8; i++) {
    const t = (i + 1) / 9;
    k.rod(M.walnut, 0.02, [-15.4, 3.4 * t, 6.6 - 0.75 * t], [-14.95, 3.4 * t, 6.6 - 0.75 * t]);
  }

  // Desk + organ rules
  const dk = k.at(-10.3, 0, 7.0, 0);
  dk.box(M.walnutRed, 2.4, 0.08, 1.0, 0, 0.8, 0);
  dk.box(M.walnutRed, 0.6, 0.8, 0.9, -0.85, 0, 0);
  dk.box(M.walnutRed, 0.6, 0.8, 0.9, 0.85, 0, 0);
  dk.box(M.velvetTeal, 1.6, 0.012, 0.75, 0, 0.88, 0.05);
  for (const y of [0.12, 0.45]) for (const x of [-0.85, 0.85]) {
    dk.box(M.walnut, 0.5, 0.26, 0.03, x, y, 0.46);
    dk.sph(M.brass, 0.025, x, y + 0.13, 0.49);
  }
  dk.cyl(M.brass, 0.1, 0.12, 0.03, -0.9, 0.88, -0.2, 18);
  dk.cyl(M.brass, 0.018, 0.018, 0.34, -0.9, 0.9, -0.2, 8);
  dk.put(new THREE.CylinderGeometry(0.1, 0.2, 0.16, 18, 1, true), M.lampGlow, -0.9, 1.28, -0.2);
  const note = dk.at(0.15, 0.91, 0.1, 0, -Math.PI / 2 + 0.28);
  note.box(M.walnut, 0.86, 0.66, 0.03, 0, -0.33, -0.02);
  note.panel(paintedMat(makePlaqueTexture(WORLD_CLUES.clue_organ_rules.title, WORLD_CLUES.clue_organ_rules.body, { w: 820, h: 620 })), 0.8, 0.6, 0, 0, 0.01);
  for (let i = 0; i < 3; i++) dk.box([M.velvetRed, M.velvetTeal, M.copper][i], 0.36, 0.06, 0.26, 0.85, 0.88 + i * 0.06, -0.2, i * 0.3);
  c.reg({ id: 'clue_organ_rules', label: clueLabel('clue_organ_rules'), actionType: 'clue', clueId: 'clue_organ_rules', maxDistance: 3.4 }, -10.2, 1.0, 7.1, 1.6, 0.5, 1.0);
  c.light(-11.2, 1.9, 8.2, 0xffc98a, 9, 7);
  // Alchemy glassware on shelf
  k.box(M.walnutRed, 2.2, 0.06, 0.32, -10.3, 1.9, 6.54);
  [0xff8ab0, 0x7fe0ff, 0xb9ff7a, 0xffd25a, 0xc79bff].forEach((col, i) => {
    const g = M.glow(col, 0.7);
    const x = -11.1 + i * 0.4;
    k.sph(g, 0.1, x, 2.06, 6.54, 1, 1, 1, 14);
    k.cyl(M.glass, 0.035, 0.05, 0.16, x, 2.12, 6.54, 10);
    k.cyl(M.bark, 0.035, 0.03, 0.05, x, 2.26, 6.54, 8);
  });

  // Globe & reading chair
  armchair(k.at(-18.7, 0, 11.3, Math.PI / 2 + 0.25), M, M.velvetRed);
  k.cyl(M.walnutRed, 0.22, 0.3, 0.1, -18.6, 0, 16.6, 18);
  k.cyl(M.walnutRed, 0.05, 0.05, 0.6, -18.6, 0.1, 16.6, 10);
  const globe = group(scene, -18.6, 1.05, 16.6, 0, (g) => {
    g.sph(M.std({ color: 0x3f8f9a, roughness: 0.4 }), 0.36, 0, 0, 0, 1, 1, 1, 28);
    for (let i = 0; i < 8; i++) g.ico(M.petalGold, 0.1 + (i % 3) * 0.04, Math.cos(i * 2.1) * 0.3, Math.sin(i * 1.7) * 0.22, Math.sin(i * 2.1) * 0.3, 1, 0.6, 1, 1);
  });
  globe.rotation.z = 0.4;
  k.torus(M.brass, 0.42, 0.02, -18.6, 1.05, 16.6, 0, 0, 0.4);
  c.ambient.push((t) => (globe.rotation.y = t * 0.12));

  // Chandelier of glass orbs
  k.cyl(M.brass, 0.02, 0.02, 0.8, -14, 3.7, 11.8, 6);
  k.torus(M.brass, 0.7, 0.025, -14, 3.6, 11.8, Math.PI / 2);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU;
    k.sph(M.lampGlow, 0.1, -14 + Math.cos(a) * 0.7, 3.48, 11.8 + Math.sin(a) * 0.7, 1, 1, 1, 12);
  }
  c.light(-14, 3.2, 11.8, 0xffd2a0, 24, 13);

  // --- UV canvases (tiny -> large) ---
  const frames: [number, number, number, number][] = [
    [-8.41, 1.75, 16.2, -Math.PI / 2],
    [-10.4, 1.95, 17.58, Math.PI],
    [-17.4, 2.0, 17.58, Math.PI],
    [-19.58, 2.15, 14.4, Math.PI / 2],
  ];
  frames.forEach(([x, y, z, ry], i) => {
    const { w, h } = UV_FRAME_SIZES[i];
    const fk = k.at(x, y, z, ry);
    const t = 0.07 + i * 0.018;
    for (const s of [-1, 1]) {
      fk.box(M.brass, t, h + t * 2, 0.07, s * (w / 2 + t / 2), -h / 2 - t, 0);
      fk.box(M.brass, w, t, 0.07, 0, s > 0 ? h / 2 : -h / 2 - t, 0);
      fk.box(M.walnutRed, t * 0.5, h + t * 3, 0.05, s * (w / 2 + t * 1.2), -h / 2 - t * 1.5, 0);
    }
    const normalMat = paintedMat(M.T.uvBlank[i], 0.28);
    const uvMat = new THREE.MeshStandardMaterial({
      map: M.T.uvGlow[i],
      emissiveMap: M.T.uvGlow[i],
      emissive: 0xffffff,
      emissiveIntensity: 1.25,
      roughness: 0.8,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), normalMat);
    mesh.position.set(x, y, z).add(_v.set(Math.sin(ry) * 0.02, 0, Math.cos(ry) * 0.02));
    mesh.rotation.y = ry;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const halo = glowSprite(M, 0x8f6bff, Math.max(w, h) * 2, 0);
    halo.position.copy(mesh.position).add(_v.set(Math.sin(ry) * 0.12, 0, Math.cos(ry) * 0.12));
    scene.add(halo);
    const worldPos = mesh.position.clone();
    c.uvFrames.push({ index: i, mesh, uvMat, normalMat, worldPos });
    const dir = new THREE.Vector3();
    const to = new THREE.Vector3();
    const litBy = (pos: THREE.Vector3, d: THREE.Vector3): boolean => {
      to.copy(worldPos).sub(pos);
      const dist = to.length();
      return dist <= 7 && d.dot(to.normalize()) > 0.72;
    };
    let hv = 0;
    c.updaters.push((f) => {
      const revealed = f.p.uvRevealedFrames.includes(i);
      let lit = false;
      if (c.uv.enabled && c.uv.camera) {
        c.uv.camera.getWorldDirection(dir);
        lit = litBy(c.uv.camera.getWorldPosition(new THREE.Vector3()), dir);
      }
      mesh.material = revealed || lit ? uvMat : normalMat;
      uvMat.emissiveIntensity = lit ? 1.6 + Math.sin(f.t * 6) * 0.12 : 1.05 + Math.sin(f.t * 1.7 + i) * 0.12;
      hv = damp(hv, revealed || lit ? 0.22 : 0, 5, f.dt);
      (halo.material as THREE.SpriteMaterial).opacity = hv;
    });
    c.reg(
      {
        id: `clue_uv_frame_${i}`,
        label: clueLabel(`clue_uv_frame_${i}`),
        actionType: 'clue',
        clueId: `clue_uv_frame_${i}`,
        maxDistance: 5,
        getLabel: (s) => (s.puzzles.uvRevealedFrames.includes(i) ? clueLabel(`clue_uv_frame_${i}`) : null),
      },
      x,
      y,
      z,
      w + 0.2,
      h + 0.2,
      0.2,
      ry,
    );
  });

  // --- Wall safe (west wall) ---
  const sx = -19.6;
  const sz = 7.6;
  const sk = k.at(sx, 1.45, sz, Math.PI / 2);
  sk.box(M.darkIron, 0.08, 1.0, 0.36, -0.5, -0.5, 0.18);
  sk.box(M.darkIron, 0.08, 1.0, 0.36, 0.5, -0.5, 0.18);
  sk.box(M.darkIron, 1.08, 0.08, 0.36, 0, 0.46, 0.18);
  sk.box(M.darkIron, 1.08, 0.08, 0.36, 0, -0.54, 0.18);
  sk.box(M.velvetRed, 1.0, 1.0, 0.04, 0, -0.5, 0.02);
  sk.box(M.brass, 1.2, 0.05, 0.05, 0, 0.53, 0.35);
  sk.box(M.brass, 1.2, 0.05, 0.05, 0, -0.58, 0.35);
  sk.box(M.walnutRed, 1.5, 0.82, 0.5, 0, -1.45, 0.25);
  const door = group(scene, sx + 0.38, 1.45, sz + 0.46, Math.PI / 2, (g) => {
    // hinge at local x=0, door spans +x
    g.box(M.iron, 0.92, 0.92, 0.09, 0.46, -0.46, 0);
    g.box(M.brass, 0.8, 0.8, 0.02, 0.46, -0.4, 0.05);
    g.box(M.iron, 0.7, 0.7, 0.03, 0.46, -0.35, 0.055);
    for (let i = 0; i < 4; i++) {
      g.put(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 20), M.brass, 0.2 + i * 0.175, 0.18, 0.09, Math.PI / 2);
    }
  });
  const wheel = group(door, 0.46, -0.1, 0.1, 0, (g) => {
    g.torus(M.brass, 0.16, 0.022);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      g.rod(M.brass, 0.014, [0, 0, 0], [Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0]);
    }
    g.sph(M.brass, 0.05);
  });
  const safeGlow = M.glow(0xffd27a, 0);
  group(scene, sx + 0.07, 1.45, sz, Math.PI / 2, (g) => g.box(safeGlow, 0.9, 0.05, 0.02, 0, 0.36, 0));
  c.updaters.push((f) => {
    const open = f.state.solvedPuzzles.p4_uv_safe;
    door.rotation.y = damp(door.rotation.y, Math.PI / 2 - (open ? 1.95 : 0), 3, f.dt);
    wheel.rotation.z = damp(wheel.rotation.z, f.p.studySafeDigits.reduce((a, d) => a + d, 0) * 0.35, 5, f.dt);
    safeGlow.emissiveIntensity = damp(safeGlow.emissiveIntensity, open ? 1.8 : 0, 3, f.dt);
  });
  c.reg(
    {
      id: 'p4_uv_safe',
      label: 'Open the Wall Safe',
      actionType: 'modal',
      modalId: 'p4_uv_safe',
      getLabel: (s) =>
        s.solvedPuzzles.p4_uv_safe &&
        !(s.collectedWorldItems.includes('key_conservatory') && s.collectedWorldItems.includes('tool_prism'))
          ? null
          : solvedTag(s, 'p4_uv_safe', 'Enter the Wall Safe code'),
    },
    sx + 0.25,
    1.45,
    sz,
    1.1,
    1.1,
    0.5,
    Math.PI / 2,
  );
  plaque(c, k, makePlaqueTexture(WORLD_CLUES.clue_uv_frames_note.title, WORLD_CLUES.clue_uv_frames_note.body, { style: 'brass', w: 900, h: 480 }), 1.25, 0.66, -19.57, 2.62, sz, Math.PI / 2);
  c.reg({ id: 'clue_uv_frames_note', label: clueLabel('clue_uv_frames_note'), actionType: 'clue', clueId: 'clue_uv_frames_note', maxDistance: 4 }, -19.5, 2.62, sz, 1.4, 0.8, 0.3, Math.PI / 2);

  // --- Harmonic Pipe Organ (south wall) ---
  const ok = k.at(-14, 0, 17.2, Math.PI);
  ok.box(M.walnutRed, 3.4, 0.95, 0.8, 0, 0, 0.0);
  ok.box(M.walnutRed, 3.4, 1.0, 0.4, 0, 0.95, -0.2);
  ok.box(M.walnut, 3.5, 0.1, 0.9, 0, 0.92, 0.05);
  ok.box(M.walnut, 3.5, 0.1, 0.55, 0, 1.92, -0.18);
  ok.box(M.walnutRed, 0.35, 3.6, 0.5, -1.75, 0, -0.18);
  ok.box(M.walnutRed, 0.35, 3.6, 0.5, 1.75, 0, -0.18);
  for (const x of [-1.75, 1.75]) ok.sph(M.brass, 0.16, x, 3.75, -0.18);
  ok.box(M.cream, 2.2, 0.05, 0.28, 0, 1.0, 0.38);
  for (let i = 0; i < 28; i++) if (i % 7 !== 2 && i % 7 !== 6) ok.box(M.ebony, 0.035, 0.035, 0.16, -1.05 + i * 0.078, 1.05, 0.33);
  ok.put(new THREE.ExtrudeGeometry(starShape(14, 0.28, 0.2), { depth: 0.03, bevelEnabled: false }), M.brass, 0, 1.45, 0.02);
  ok.box(M.walnut, 1.1, 0.08, 0.4, 0, 0.5, 1.0);
  for (const x of [-0.45, 0.45]) ok.box(M.walnut, 0.08, 0.5, 0.36, x, 0, 1.0);
  for (let i = 0; i < 6; i++) ok.cyl(M.copper, 0.06, 0.06, 1.5 + (i % 3) * 0.25, -1.45 + i * 0.58, 2.0, -0.34, 12);
  const org = group(scene, -14, 2.0, 17.3, Math.PI);
  const pipes = [0, 1, 2, 3, 4].map((i) => {
    // local +x is the player's left-to-right when facing south is mirrored, so slot 0 sits at the viewer's left
    const x = -1.16 + i * 0.58;
    const body = group(org, x, 0, 0.05, 0, (g) => {
      g.cyl(M.brass, 0.17, 0.17, 1, 0, 0, 0, 24);
    });
    const cap = group(org, x, 0, 0.05, 0, (g) => {
      g.torus(M.brass, 0.17, 0.03, 0, 0, 0, Math.PI / 2);
      g.cyl(M.ebony, 0.14, 0.14, 0.02, 0, -0.01, 0, 20);
    });
    group(org, x, 0.24, 0.215, 0, (g) => {
      g.box(M.ebony, 0.16, 0.07, 0.03, 0, 0, 0);
      g.cone(M.brass, 0.1, 0.16, 0, -0.2, 0, 3);
    });
    const light = M.glow(0x8fe0ff, 0.1);
    group(org, x, -0.45, 0.25, 0, (g) => g.sph(light, 0.05));
    return { body, cap, light, h: 0.5 };
  });
  c.updaters.push((f) => {
    pipes.forEach((p, i) => {
      p.h = damp(p.h, 0.4 + f.p.organPipes[i] * 0.38, 5, f.dt);
      p.body.scale.y = p.h;
      p.cap.position.y = p.h;
      p.light.emissiveIntensity = f.state.solvedPuzzles.p5_pipe_organ ? 1.2 + Math.sin(f.t * 3 + i) * 0.6 : 0.15;
    });
  });
  c.reg(
    { id: 'p5_pipe_organ', label: 'Play the Harmonic Pipe Organ', actionType: 'modal', modalId: 'p5_pipe_organ', getLabel: (s) => solvedTag(s, 'p5_pipe_organ', 'Arrange the Harmonic Pipe Organ') },
    -14,
    1.9,
    17.3,
    3.2,
    3.8,
    0.6,
  );
  const gp = k.at(-11.75, 0, 17.4, Math.PI);
  gp.box(M.walnut, 0.5, 0.9, 0.3);
  const compartment = group(scene, -11.75, 1.15, 17.45, Math.PI, (g) => {
    g.box(M.brass, 0.56, 0.4, 0.05, 0, -0.2, 0);
    g.put(gearGeo(14, 0.14, 0.03), M.glow(0xff8a4a, 0.5), 0, 0, 0.05);
  });
  c.updaters.push((f) => (compartment.visible = f.state.solvedPuzzles.p5_pipe_organ));
  c.reg({ id: 'clue_core_gear_cardinal', label: clueLabel('clue_core_gear_cardinal'), actionType: 'clue', clueId: 'clue_core_gear_cardinal', enabled: (s) => s.solvedPuzzles.p5_pipe_organ }, -11.75, 1.15, 17.4, 0.7, 0.55, 0.35);
  pottedPlant(c, k, -9.0, 17.1, 0.9, 41);
  pottedPlant(c, k, -19.1, 6.1, 0.9, 42);
}

// ============================================================
// SUNLIT FOUNTAIN COURTYARD
// ============================================================
function buildCourtyard(c: Ctx): void {
  const { B, M, scene } = c;
  const k = B.kit('courtyard');
  k.floor(M.flag, -12, 12, -14, 6, 0);

  // Perimeter walls
  const cw = B.kit('cons');
  const ce = B.kit('workshop');
  for (const [kk, x] of [[cw, -12], [ce, 12]] as const) {
    const east = x > 0;
    const inner = east ? M.brick : M.ashlar;
    wall(c, kk, {
      axis: 'z',
      at: x,
      from: -14.3,
      to: 2.35,
      h: 5,
      neg: east ? M.ashlar : inner,
      pos: east ? inner : M.ashlar,
      core: M.trimStone,
      openings: [{ a: -7.5, b: -4.5, y0: 0, y1: 3.8 }],
    });
    wall(c, kk, { axis: 'z', at: x, from: 2.35, to: 5.35, h: 5, neg: M.ashlar, pos: M.ashlar });
  }
  for (const sgn of [-1, 1]) {
    const face = sgn * 11.62;
    k.box(M.trimStone, 0.26, 0.2, 20.2, sgn * 11.68, 4.8, -4.2);
    // Door surrounds
    const d = k.at(face, 0, -6, sgn > 0 ? -Math.PI / 2 : Math.PI / 2);
    for (const s of [-1, 1]) {
      d.box(M.trimStone, 0.45, 4.1, 0.24, s * 1.75, 0, 0.08);
      d.box(M.trimStone, 0.6, 0.35, 0.34, s * 1.75, 0, 0.1);
      d.box(M.trimStone, 0.58, 0.28, 0.32, s * 1.75, 3.9, 0.1);
    }
    d.box(M.trimStone, 4.4, 0.36, 0.3, 0, 4.15, 0.08);
    d.torus(sgn > 0 ? M.copper : M.verdigris, 0.34, 0.06, 0, 4.72, 0.1);
    if (sgn > 0) d.put(gearGeo(12, 0.3, 0.08), M.brass, 0, 4.72, 0.1);
    else d.put(fernGeo(9, 0.34, 4, 0.2, 0.5), M.leafLime, 0, 4.6, 0.16);
    // Ivy drapes, hedges & flowers
    for (const [z, w, n] of [[1.4, 5.2, 260], [-10.6, 4.4, 220]] as const) {
      if (sgn > 0 && z < 0) continue;
      const iv = k.at(face - sgn * 0.02, 4.9, z, sgn > 0 ? -Math.PI / 2 : Math.PI / 2);
      iv.put(ivyGeo(w, 3.4, n, z + 7 + sgn), M.leafDark);
      iv.put(ivyGeo(w, 2.8, n, z + 17 + sgn), M.leaf);
      iv.put(ivyGeo(w, 2.4, 60, z + 27 + sgn), M.petalPink);
    }
  }
  for (const sgn of [-1, 1]) {
    const iv = k.at(sgn * 6.6, 4.75, 5.6, Math.PI);
    iv.put(ivyGeo(4.6, 2.6, 200, 60 + sgn), M.leaf);
    iv.put(ivyGeo(4.6, 2.2, 160, 70 + sgn), M.leafDark);
    iv.put(ivyGeo(4.6, 2.0, 70, 80 + sgn), M.petalGold);
  }

  const hedge = (x: number, z: number, w: number, d: number, h = 0.85): void => {
    k.box(M.hedge, w, h, d, x, 0, z);
    k.box(M.trimStone, w + 0.16, 0.14, d + 0.16, x, 0, z);
    const n = Math.round(Math.max(w, d) / 0.55);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n - 0.5;
      k.ico(M.hedge, 0.34, x + (w > d ? t * w : 0), h - 0.06, z + (w > d ? 0 : t * d), 1, 0.5, 1, 2);
    }
    for (let i = 0; i < n; i += 2) {
      const t = (i + 0.5) / n - 0.5;
      flowerClump(c, k, x + (w > d ? t * w : 0), h - 0.04, z + (w > d ? 0 : t * d), 5, 0.5, Math.round(x * 13 + z * 7 + i));
    }
  };
  hedge(-11.15, 1.4, 0.8, 5.2);
  hedge(-11.15, -10.6, 0.8, 4.2);
  hedge(11.15, 0.2, 0.8, 4.6);
  hedge(-6.6, 5.15, 4.8, 0.7);
  hedge(6.6, 5.15, 4.8, 0.7);
  hedge(-7.6, -13.3, 4.0, 0.7);

  // Cypress in planters
  const tree = (x: number, z: number, h: number): void => {
    k.cyl(M.trimStone, 0.62, 0.52, 0.55, x, 0, z, 8);
    k.torus(M.brass, 0.58, 0.035, x, 0.46, z, Math.PI / 2, 0, 0, 24);
    k.cyl(M.soil, 0.54, 0.54, 0.02, x, 0.54, z, 16);
    k.cyl(M.bark, 0.1, 0.13, 0.6, x, 0.5, z, 8);
    k.put(cypressGeo(h, 0.62), M.cypress, x, 0.8, z);
    flowerClump(c, k, x, 0.52, z, 10, 0.8, Math.round(x * 5 + z));
  };
  tree(-10.6, -2.4, 4.6);
  tree(-10.6, -12.2, 4.9);
  tree(10.6, -2.9, 4.6);
  tree(-10.5, 4.6, 4.4);
  tree(4.4, 4.9, 3.6);
  tree(-4.4, 4.9, 3.6);
  tree(7.4, -12.7, 4.2);

  // Arcing flower beds around the fountain + lamp posts + benches
  for (let q = 0; q < 4; q++) {
    const a0 = q * (Math.PI / 2) + Math.PI / 4;
    for (let i = -2; i <= 2; i++) {
      const a = a0 + i * 0.13;
      const x = Math.cos(a) * 3.9;
      const z = -4 + Math.sin(a) * 3.9;
      k.box(M.trimStone, 0.56, 0.26, 0.62, x, 0, z, -a);
      k.box(M.soil, 0.46, 0.04, 0.52, x, 0.24, z, -a);
      flowerClump(c, k, x, 0.28, z, 8, 0.45, q * 10 + i + 50);
    }
  }
  for (const [x, z] of [[-8.6, -2.6], [8.6, -2.6], [-3.1, -11.2], [8.0, 4.2], [-8.2, 4.1]] as const) lampPost(c, k, x, z);
  for (const [x, z, ry] of [[-9.6, 0.6, Math.PI / 2], [9.7, -1.0, -Math.PI / 2]] as const) {
    const b = k.at(x, 0, z, ry);
    for (let i = 0; i < 4; i++) b.box(M.walnutRed, 1.7, 0.04, 0.1, 0, 0.45, -0.18 + i * 0.12);
    for (let i = 0; i < 3; i++) b.box(M.walnutRed, 1.7, 0.09, 0.03, 0, 0.58 + i * 0.14, -0.26);
    for (const s of [-1, 1]) {
      b.box(M.iron, 0.06, 0.45, 0.45, s * 0.75, 0, 0);
      b.box(M.iron, 0.06, 0.6, 0.05, s * 0.75, 0.4, -0.27);
      b.torus(M.brass, 0.1, 0.02, s * 0.75, 0.6, 0.12, 0, Math.PI / 2);
    }
  }

  buildFountain(c, k);

  // --- Equinox Sundial ---
  const sx = -6.2;
  const sz = -9.4;
  k.cyl(M.trimStone, 1.25, 1.35, 0.14, sx, 0, sz, 8);
  k.cyl(M.trimStone, 0.95, 1.05, 0.14, sx, 0.14, sz, 8);
  pedestal(c, k, sx, sz, 0.92, 0.2, 0.44);
  k.cyl(M.brassDark, 0.86, 0.8, 0.07, sx, 1.1, sz, 48);
  const ringsDef = [
    { r: 0.84, label: 'DAY', face: '#d9b469' },
    { r: 0.6, label: 'AZIMUTH', face: '#f0dca4' },
    { r: 0.37, label: 'HOUR', face: '#fbf0cf' },
  ];
  const dials = ringsDef.map((d, i) => {
    const g = group(scene, sx, 1.175 + i * 0.03, sz, 0, (g2) => {
      g2.disc(paintedMat(makeNumberRing(12, d.label, d.face, '#47290f'), 0.25), d.r, 0, 0.012, 0, 56);
      g2.cyl(M.brass, d.r + 0.015, d.r + 0.015, 0.02, 0, -0.01, 0, 56, true);
    });
    return g;
  });
  k.put(new THREE.ConeGeometry(0.16, 0.7, 3), M.brass, sx, 1.6, sz, 0.45, 0, 0, 0.35, 1, 1);
  k.cone(M.velvetRed, 0.06, 0.16, sx, 1.24, sz - 0.94, 4, -Math.PI / 2);
  const sunHalo = glowSprite(M, 0xffce66, 2.6, 0);
  sunHalo.position.set(sx, 1.5, sz);
  scene.add(sunHalo);
  c.updaters.push((f) => {
    const s = f.p.sundial;
    [s.day, s.azimuth, s.hour].forEach((v, i) => (dials[i].rotation.y = dampAngle(dials[i].rotation.y, ((v - 1) / 12) * TAU, 4, f.dt)));
    (sunHalo.material as THREE.SpriteMaterial).opacity = damp((sunHalo.material as THREE.SpriteMaterial).opacity, f.state.solvedPuzzles.p6_sundial ? 0.4 : 0, 2, f.dt);
  });
  c.reg({ id: 'p6_sundial', label: 'Turn the Equinox Sundial', actionType: 'modal', modalId: 'p6_sundial', getLabel: (s) => solvedTag(s, 'p6_sundial', 'Turn the Equinox Sundial') }, sx, 1.1, sz, 1.9, 1.6, 1.9);
  // Stone tablet
  const tb = k.at(-3.9, 0, -9.9, 0.35);
  tb.box(M.trimStone, 1.5, 0.24, 0.6);
  tb.box(M.ashlar, 1.3, 1.35, 0.22, 0, 0.2, 0);
  plaque(c, tb, makePlaqueTexture(WORLD_CLUES.clue_sundial_tablet.title, WORLD_CLUES.clue_sundial_tablet.body, { style: 'stone', w: 820, h: 720 }), 1.06, 0.94, 0, 1.0, 0.13, 0, 0, M.trimStone);
  c.reg({ id: 'clue_sundial_tablet', label: clueLabel('clue_sundial_tablet'), actionType: 'clue', clueId: 'clue_sundial_tablet' }, -3.9, 0.95, -9.9, 1.4, 1.5, 0.45, 0.35);

  oracleBooth(c, 'courtyard', 10.2, 3.9, -Math.PI * 0.75, 'open_oracle_courtyard');
  floorPlate(c, 'courtyard_sun_pad', 0xffa928, (f) => f.p.mirror2ClutchHeldBy.length > 0, 0.45);

  // Solar Relay Notice
  const nt = k.at(2.5, 0, -12.3, 0);
  for (const s of [-1, 1]) nt.cyl(M.brass, 0.04, 0.05, 1.2, s * 0.55, 0, -0.04, 10);
  plaque(c, nt, makePlaqueTexture(WORLD_CLUES.clue_mirror_plaque.title, WORLD_CLUES.clue_mirror_plaque.body, { style: 'brass', w: 900, h: 700 }), 1.2, 0.93, 0, 1.4, 0.03, 0, -0.2);
  c.reg({ id: 'clue_mirror_plaque', label: clueLabel('clue_mirror_plaque'), actionType: 'clue', clueId: 'clue_mirror_plaque' }, 2.5, 1.35, -12.3, 1.4, 1.2, 0.5);

  buildLightRelay(c, k);
}

function buildFountain(c: Ctx, k: Kit): void {
  const { M, scene } = c;
  const z = -4;
  k.disc(M.rosette, 3.4, 0, 0.012, z, 64);
  k.put(
    lathe([[1.98, 0], [2.3, 0], [2.3, 0.1], [2.18, 0.16], [2.16, 0.52], [2.3, 0.58], [2.3, 0.7], [1.98, 0.7], [1.94, 0.6], [1.94, 0.1]], 56),
    M.marble,
    0,
    0,
    z,
  );
  k.torus(M.brass, 2.24, 0.035, 0, 0.64, z, Math.PI / 2, 0, 0, 64);
  k.put(
    lathe([[0.01, 0], [0.62, 0], [0.5, 0.25], [0.3, 0.45], [0.24, 0.9], [0.3, 1.12], [0.62, 1.22], [1.02, 1.36], [1.16, 1.5], [1.18, 1.56], [1.08, 1.56], [0.9, 1.44], [0.3, 1.36], [0.2, 1.4], [0.15, 1.6], [0.13, 2.05], [0.2, 2.18], [0.42, 2.26], [0.58, 2.38], [0.6, 2.44], [0.53, 2.44], [0.4, 2.36], [0.1, 2.32], [0.08, 2.6], [0.01, 2.6]], 48),
    M.marble,
    0,
    0,
    z,
  );
  k.torus(M.brass, 1.17, 0.03, 0, 1.55, z, Math.PI / 2, 0, 0, 48);
  k.torus(M.brass, 0.59, 0.025, 0, 2.43, z, Math.PI / 2, 0, 0, 40);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    k.cone(M.brass, 0.07, 0.2, Math.cos(a) * 2.06, 0.68, z + Math.sin(a) * 2.06, 8);
    k.sph(M.brass, 0.06, Math.cos(a) * 1.17, 1.5, z + Math.sin(a) * 1.17, 1, 1, 1, 8);
  }
  k.sph(M.brass, 0.13, 0, 2.66, z);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    k.put(new THREE.ConeGeometry(0.035, 0.16, 5), M.brass, Math.cos(a) * 0.2, 2.66 + Math.sin(a) * 0.2, z, 0, 0, a - Math.PI / 2);
  }
  const water = waterMat(c, 0x2b93a8, 0x7fdccf);
  for (const [r, y] of [[1.96, 0.5], [1.02, 1.5], [0.5, 2.4]] as const) {
    const w = new THREE.Mesh(new THREE.CircleGeometry(r, 48), water);
    w.rotation.x = -Math.PI / 2;
    w.position.set(0, y, z);
    scene.add(noRay(w));
  }

  // Ballistic droplets
  const N = 1500;
  const r = makeRng(17);
  const pos = new Float32Array(N * 3);
  const a0 = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const kind = i < 260 ? 0 : i < 560 ? 1 : i < 1050 ? 2 : 3;
    let ang = r() * TAU;
    if (kind === 1) ang = (Math.floor(r() * 10) / 10) * TAU + (r() - 0.5) * 0.16;
    if (kind === 2) ang = (Math.floor(r() * 16) / 16) * TAU + (r() - 0.5) * 0.12;
    if (kind === 3) ang = (Math.floor(r() * 8) / 8) * TAU + (r() - 0.5) * 0.025;
    a0.set([ang, r(), kind, r()], i * 4);
    pos.set([0, 1.5, z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aS', new THREE.BufferAttribute(a0, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: M.uTime, uMap: { value: M.T.mote } },
    vertexShader: `
      attribute vec4 aS; uniform float uTime; varying float vA;
      void main() {
        float kind = aS.z; float rnd = aS.w;
        vec2 dir = vec2(cos(aS.x), sin(aS.x));
        float life = kind < 0.5 ? 0.85 : (kind < 1.5 ? 0.46 : (kind < 2.5 ? 0.52 : 0.95));
        float t = fract(uTime / life * 0.62 + aS.y) * life;
        vec3 p; float r0, y0, vr, vy, yMin;
        if (kind < 0.5) { r0 = 0.02; y0 = 2.75; vr = 0.15 + rnd * 0.32; vy = 2.5 + rnd * 0.9; yMin = 2.4; }
        else if (kind < 1.5) { r0 = 0.6; y0 = 2.42; vr = 0.5 + rnd * 0.22; vy = 0.25; yMin = 1.5; }
        else if (kind < 2.5) { r0 = 1.16; y0 = 1.54; vr = 0.6 + rnd * 0.26; vy = 0.25; yMin = 0.5; }
        else { r0 = 2.05; y0 = 0.86; vr = -0.92 - rnd * 0.05; vy = 4.35 + rnd * 0.1; yMin = 0.5; }
        float rad = r0 + vr * t;
        float y = y0 + vy * t - 4.6 * t * t;
        p = vec3(dir.x * rad, max(y, yMin), -4.0 + dir.y * rad);
        vA = (1.0 - smoothstep(0.85, 1.0, t / life)) * step(yMin, y + 0.02);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (26.0 + rnd * 26.0) / max(0.5, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap; varying float vA;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a;
        gl_FragColor = vec4(vec3(0.93, 0.98, 1.0) + vec3(0.1, 0.05, -0.05), a * vA * 0.8);
        #include <colorspace_fragment>
      }`,
  });
  const pts = noRay(new THREE.Points(g, mat));
  pts.frustumCulled = false;
  scene.add(pts);
}

// ------------------------------------------------------------
// Solar relay: emitter -> M1 -> M2 -> M3 -> conservatory receptor
// ------------------------------------------------------------
const EMITTER = new THREE.Vector3(0, 1.5, -12.8);
const MIRRORS = [new THREE.Vector3(6, 1.5, -9), new THREE.Vector3(5.5, 1.5, 1.5), new THREE.Vector3(-6.5, 1.5, 1.5)];
const RECEPTOR = new THREE.Vector3(-11.8, 2.2, -6);

function buildLightRelay(c: Ctx, k: Kit): void {
  const { M, scene } = c;
  // Emitter: brass heliostat on a marble plinth
  k.cyl(M.trimStone, 0.48, 0.56, 0.16, EMITTER.x, 0, EMITTER.z, 8);
  pedestal(c, k, EMITTER.x, EMITTER.z, 0.95, 0.14, 0.26);
  const toM1 = MIRRORS[0].clone().sub(EMITTER).normalize();
  const emYaw = Math.atan2(toM1.x, toM1.z);
  const em = k.at(EMITTER.x, EMITTER.y, EMITTER.z, emYaw);
  em.torus(M.brass, 0.34, 0.04, 0, 0, 0);
  em.torus(M.brass, 0.3, 0.03, 0, 0, 0.18);
  em.put(new THREE.CylinderGeometry(0.2, 0.3, 0.5, 24, 1, true), M.brassDark, 0, 0, -0.1, Math.PI / 2);
  em.rod(M.brass, 0.03, [-0.36, -0.42, 0], [-0.36, 0.1, 0]);
  em.rod(M.brass, 0.03, [0.36, -0.42, 0], [0.36, 0.1, 0]);
  // collecting dish pointed at the sun
  const up = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), SUN_DIR);
  const eul = new THREE.Euler().setFromQuaternion(up, 'YXZ');
  const dish = k.at(EMITTER.x, EMITTER.y + 0.75, EMITTER.z, eul.y, eul.x, eul.z);
  dish.put(lathe([[0.02, -0.14], [0.25, -0.1], [0.5, 0.06], [0.53, 0.08], [0.5, 0.1], [0.25, -0.05], [0.02, -0.1]], 36), M.brass);
  k.cyl(M.brass, 0.035, 0.05, 0.5, EMITTER.x, EMITTER.y + 0.2, EMITTER.z, 10);
  const prism = group(scene, EMITTER.x, EMITTER.y, EMITTER.z, emYaw);
  const prismMesh = makeItemMesh(M, 'tool_prism');
  prism.add(prismMesh);
  const prismGlow = glowSprite(M, 0xffd27a, 2.2, 0.8);
  prism.add(prismGlow);
  c.reg(
    {
      id: 'insert_prism',
      label: 'Place the Brass Prism',
      actionType: 'direct',
      maxDistance: 3.4,
      getLabel: (s) =>
        s.puzzles.prismInserted
          ? null
          : s.inventory.includes('tool_prism')
            ? 'Place the Pocket Brass Prism in the Sun-Emitter'
            : 'Sun-Emitter: its prism socket is empty',
    },
    EMITTER.x,
    1.35,
    EMITTER.z,
    1.0,
    2.2,
    1.0,
  );

  // Mirrors
  const outs = [
    MIRRORS[1].clone().sub(MIRRORS[0]).normalize(),
    MIRRORS[2].clone().sub(MIRRORS[1]).normalize(),
    RECEPTOR.clone().sub(MIRRORS[2]).normalize(),
  ];
  const ins = [toM1, outs[0], outs[1]];
  const normals = outs.map((o, i) => o.clone().sub(ins[i]).normalize());
  const baseYaw = normals.map((n) => Math.atan2(n.x, n.z));
  const pitch = normals.map((n) => -Math.asin(n.y));
  const yawFor = (i: number, step: number): number => baseYaw[i] + (step - SOLUTIONS.p7_mirrors[i]) * (Math.PI / 4);
  const heads = MIRRORS.map((m, i) => {
    k.cyl(M.trimStone, 0.52, 0.6, 0.14, m.x, 0, m.z, 8);
    k.cyl(M.brassDark, 0.3, 0.42, 0.12, m.x, 0.14, m.z, 24);
    k.cyl(M.brass, 0.055, 0.09, 0.62, m.x, 0.26, m.z, 14);
    k.torus(M.brass, 0.3, 0.02, m.x, 0.3, m.z, Math.PI / 2);
    for (let s = 0; s < 8; s++) {
      const a = (s / 8) * TAU;
      k.box(M.ebony, 0.03, 0.02, 0.1, m.x + Math.sin(a) * 0.46, 0.14, m.z + Math.cos(a) * 0.46, a);
    }
    const head = group(scene, m.x, m.y, m.z, yawFor(i, 0));
    group(head, 0, 0, 0, 0, (g) => {
      // yoke
      g.torus(M.brass, 0.56, 0.035, 0, 0, 0, 0, 0, Math.PI, 30, Math.PI);
      g.cyl(M.brass, 0.05, 0.05, 0.12, 0, -0.66, 0, 12);
      g.box(M.velvetRed, 0.05, 0.04, 0.2, 0, -0.64, 0.12);
      g.sph(M.brass, 0.05, -0.56, 0, 0, 1, 1, 1, 10);
      g.sph(M.brass, 0.05, 0.56, 0, 0, 1, 1, 1, 10);
    });
    const face = group(head, 0, 0, 0, 0, (g) => {
      const mirrorMat = M.std({ color: 0xfdf6e4, metalness: 1, roughness: 0.05, envMapIntensity: 2.4 });
      g.put(new THREE.CylinderGeometry(0.47, 0.47, 0.03, 40), mirrorMat, 0, 0, -0.005, Math.PI / 2);
      g.put(new THREE.CylinderGeometry(0.48, 0.44, 0.06, 40), M.brassDark, 0, 0, -0.045, Math.PI / 2);
      g.torus(M.brass, 0.48, 0.04, 0, 0, 0, 0, 0, 0, 44);
      for (let s = 0; s < 8; s++) {
        const a = (s / 8) * TAU;
        g.put(new THREE.ConeGeometry(0.05, 0.14, 5), M.brass, Math.cos(a) * 0.56, Math.sin(a) * 0.56, 0, 0, 0, a - Math.PI / 2);
      }
    });
    face.rotation.x = pitch[i];
    c.reg(
      {
        id: `rotate_mirror_${i}`,
        label: `Rotate Mirror ${i + 1}`,
        actionType: 'direct',
        maxDistance: 3.2,
        getLabel: (s) => {
          if (s.solvedPuzzles.p7_light_relay) return null;
          const n = `Rotate Mirror ${i + 1} (notch ${s.puzzles.mirrorAngles[i]})`;
          if (i === 1 && !s.puzzles.mirror2Latched && s.puzzles.mirror2ClutchHeldBy.length === 0)
            return 'Mirror 2 (spring clutch slips: hold the Sun-Pad)';
          return n;
        },
      },
      m.x,
      1.15,
      m.z,
      1.2,
      2.2,
      1.2,
    );
    return { head, yaw: yawFor(i, 0) };
  });
  const clutch = M.glow(0xffa928, 0.2);
  group(scene, MIRRORS[1].x, 0.36, MIRRORS[1].z, 0, (g) => g.torus(clutch, 0.4, 0.03, 0, 0, 0, Math.PI / 2));
  // Inlaid brass conduit linking Sun-Pad and Mirror 2
  k.box(M.brass, 1.9, 0.012, 0.07, 4.35, 0.004, 1.65, 0.13);

  // Receptor: faceted crystal hung from a brass arm over the conservatory door
  k.rod(M.brass, 0.045, [-11.62, 3.95, -6], [-11.1, 3.95, -6]);
  k.rod(M.brass, 0.03, [-11.1, 3.95, -6], [-11.6, 3.0, -6]);
  k.rod(M.brass, 0.018, [-11.6, 3.0, -6], [-11.8, 2.5, -6]);
  const recMat = new THREE.MeshStandardMaterial({ color: 0xd9f4ff, emissive: 0xffc04a, emissiveIntensity: 0.1, roughness: 0.05, metalness: 0.2, envMapIntensity: 2.5, transparent: true, opacity: 0.9 });
  const rec = group(scene, RECEPTOR.x, RECEPTOR.y, RECEPTOR.z, 0, (g) => {
    g.put(new THREE.OctahedronGeometry(0.24), recMat);
    g.torus(M.brass, 0.27, 0.02, 0, 0, 0, 0, Math.PI / 2);
  });
  const recGlow = glowSprite(M, 0xffc860, 2.6, 0);
  rec.add(recGlow);
  // Conservatory continuation beam: receptor -> lotus
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffe49a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
  const haloMat = new THREE.MeshBasicMaterial({ color: 0xff9f1e, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
  const unit = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
  unit.rotateX(Math.PI / 2);
  unit.translate(0, 0, 0.5);
  const beams = Array.from({ length: 6 }, () => {
    const g = new THREE.Group();
    const core = noRay(new THREE.Mesh(unit, coreMat));
    core.scale.set(0.016, 0.016, 1);
    const halo = noRay(new THREE.Mesh(unit, haloMat));
    halo.scale.set(0.06, 0.06, 1);
    g.add(core, halo);
    g.visible = false;
    scene.add(g);
    const spark = glowSprite(M, 0xffd778, 1.2, 0.85);
    spark.visible = false;
    scene.add(spark);
    return { g, spark };
  });
  const setBeam = (i: number, a: THREE.Vector3, b: THREE.Vector3): void => {
    const bm = beams[i];
    bm.g.visible = true;
    bm.g.position.copy(a);
    bm.g.lookAt(b);
    bm.g.scale.set(1, 1, a.distanceTo(b));
    bm.spark.visible = true;
    bm.spark.position.copy(b);
  };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const d = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const clip = (from: THREE.Vector3, dir: THREE.Vector3): number => {
    let best = 40;
    const planes: [number, number, number][] = [
      [dir.x, from.x, -11.65],
      [dir.x, from.x, 11.65],
      [dir.z, from.z, -13.7],
      [dir.z, from.z, 5.65],
      [dir.y, from.y, 0.02],
    ];
    for (const [dv, fv, lim] of planes) {
      if (Math.abs(dv) < 1e-5) continue;
      const s = (lim - fv) / dv;
      if (s > 0.05 && s < best) best = s;
    }
    // Fountain column
    const fx = from.x;
    const fz = from.z + 4;
    const A = dir.x * dir.x + dir.z * dir.z;
    const Bq = 2 * (fx * dir.x + fz * dir.z);
    const C = fx * fx + fz * fz - 1.2 * 1.2;
    const disc = Bq * Bq - 4 * A * C;
    if (disc > 0) {
      const s = (-Bq - Math.sqrt(disc)) / (2 * A);
      if (s > 0.05 && s < best) best = s;
    }
    return best;
  };

  c.updaters.push((f) => {
    const solved = f.state.solvedPuzzles.p7_light_relay;
    heads.forEach((h, i) => {
      h.yaw = dampAngle(h.yaw, yawFor(i, solved ? SOLUTIONS.p7_mirrors[i] : f.p.mirrorAngles[i]), 6, f.dt);
      h.head.rotation.y = h.yaw;
    });
    const held = f.p.mirror2ClutchHeldBy.length > 0 || f.p.mirror2Latched;
    clutch.emissiveIntensity = held ? 2 : 0.2;
    prismMesh.visible = f.p.prismInserted;
    prismGlow.visible = f.p.prismInserted;
    prismMesh.rotation.z = f.t * 0.6;
    for (const bm of beams) {
      bm.g.visible = false;
      bm.spark.visible = false;
    }
    const pulse = 0.85 + Math.sin(f.t * 5) * 0.12;
    haloMat.opacity = 0.26 * pulse;
    let hit = false;
    if (f.p.prismInserted || solved) {
      // incoming sun shaft
      setBeam(5, tmp.copy(EMITTER).addScaledVector(SUN_DIR, 26), EMITTER);
      a.copy(EMITTER);
      d.copy(toM1);
      let seg = 0;
      for (let i = 0; i <= 3; i++) {
        const tgt = i < 3 ? MIRRORS[i] : RECEPTOR;
        tmp.copy(tgt).sub(a);
        const along = tmp.dot(d);
        const off = Math.sqrt(Math.max(0, tmp.lengthSq() - along * along));
        if (along > 0 && off < 0.42) {
          b.copy(a).addScaledVector(d, along);
          setBeam(seg++, a, b);
          if (i === 3) {
            hit = true;
            break;
          }
          n.set(Math.sin(heads[i].yaw) * Math.cos(pitch[i]), -Math.sin(pitch[i]), Math.cos(heads[i].yaw) * Math.cos(pitch[i]));
          const dn = d.dot(n);
          if (dn > -0.08) break; // strikes the back or rim of the mirror
          d.addScaledVector(n, -2 * dn).normalize();
          a.copy(b);
        } else {
          b.copy(a).addScaledVector(d, clip(a, d));
          setBeam(seg++, a, b);
          break;
        }
      }
    }
    const lit = solved || hit;
    if (solved) setBeam(4, RECEPTOR, tmp.set(-19, 1.0, -6));
    const rm = recGlow.material as THREE.SpriteMaterial;
    rm.opacity = damp(rm.opacity, lit ? 0.9 : 0, 5, f.dt);
    recMat.emissiveIntensity = damp(recMat.emissiveIntensity, lit ? 2.6 : 0.1, 5, f.dt);
    rec.rotation.y = f.t * (lit ? 1.2 : 0.25);
    (prismGlow.material as THREE.SpriteMaterial).opacity = 0.75 * pulse;
  });
}

// ============================================================
// BOTANICAL CONSERVATORY
// ============================================================
function buildConservatory(c: Ctx): void {
  const { B, M, scene } = c;
  const k = B.kit('cons');
  k.floor(M.consFloor, -26, -12, -14, 2, 0);

  const glassWall = (axis: 'x' | 'z', at: number, from: number, to: number): void => {
    wall(c, k, { axis, at, from, to, h: 0.85, neg: M.ashlar, pos: M.ashlar });
    const len = to - from;
    const mid = (from + to) / 2;
    const g = new THREE.PlaneGeometry(len, 4.55);
    scaleUv(g, len, 4.55);
    if (axis === 'x') k.put(g, M.glassIron, mid, 0.95 + 2.275, at);
    else k.put(g, M.glassIron, at, 0.95 + 2.275, mid, 0, Math.PI / 2);
    const bar = (w: number, y: number, h: number): void =>
      axis === 'x' ? k.box(M.iron, len, h, w, mid, y, at) : k.box(M.iron, w, h, len, at, y, mid);
    bar(0.78, 0.85, 0.1);
    bar(0.14, 3.2, 0.1);
    bar(0.4, 5.3, 0.22);
    const n = Math.round(len / 2);
    for (let i = 0; i <= n; i++) {
      const p = from + (len * i) / n;
      if (axis === 'x') k.box(M.iron, 0.14, 4.5, 0.2, p, 0.9, at);
      else k.box(M.iron, 0.2, 4.5, 0.14, at, 0.9, p);
    }
  };
  glassWall('x', -14, -26.3, -12.35);
  glassWall('x', 2, -26.3, -12.35);
  glassWall('z', -26, -14.35, 2.35);
  k.box(M.iron, 0.4, 0.52, 16.4, -12.1, 5.0, -6);

  // Barrel vault
  const RX = 7;
  const RY = 3.1;
  const Y0 = 5.4;
  const N = 28;
  const pos: number[] = [];
  const uv: number[] = [];
  let arc = 0;
  let px = -26;
  let py = Y0;
  for (let i = 1; i <= N; i++) {
    const th = Math.PI - (i / N) * Math.PI;
    const x = -19 + Math.cos(th) * RX;
    const y = Y0 + Math.sin(th) * RY;
    const s = Math.hypot(x - px, y - py);
    pos.push(px, py, -14, px, py, 2, x, y, 2, px, py, -14, x, y, 2, x, y, -14);
    uv.push(0, arc, 16, arc, 16, arc + s, 0, arc, 16, arc + s, 0, arc + s);
    arc += s;
    px = x;
    py = y;
  }
  const vault = new THREE.BufferGeometry();
  vault.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  vault.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  vault.computeVertexNormals();
  k.put(vault, M.glassIron);
  const archPts = Array.from({ length: 25 }, (_, i) => {
    const th = (i / 24) * Math.PI;
    return new THREE.Vector3(-19 + Math.cos(th) * RX, Y0 + Math.sin(th) * RY, 0);
  });
  const curve = new THREE.CatmullRomCurve3(archPts);
  for (let i = 0; i <= 8; i++) k.put(new THREE.TubeGeometry(curve, 40, i % 8 === 0 ? 0.11 : 0.065, 6), M.iron, 0, 0, -14 + i * 2);
  k.rod(M.iron, 0.09, [-19, Y0 + RY, -14], [-19, Y0 + RY, 2]);
  for (const s of [-1, 1]) k.rod(M.iron, 0.06, [-19 + s * 4.95, Y0 + RY * 0.707, -14], [-19 + s * 4.95, Y0 + RY * 0.707, 2]);
  for (const z of [-14, -10, -6, -2, 2]) {
    k.cone(M.brass, 0.1, 0.7, -19, Y0 + RY, z, 8);
    k.sph(M.brass, 0.13, -19, Y0 + RY + 0.1, z);
  }
  const gable = new THREE.Shape();
  gable.moveTo(RX, 0);
  for (let i = 1; i <= 24; i++) gable.lineTo(Math.cos((i / 24) * Math.PI) * RX, Math.sin((i / 24) * Math.PI) * RY);
  gable.closePath();
  for (const z of [-14, 2]) {
    k.put(new THREE.ShapeGeometry(gable), M.glassIron, -19, Y0, z);
    for (let i = 1; i < 6; i++) {
      const th = (i / 6) * Math.PI;
      k.rod(M.iron, 0.045, [-19, Y0, z], [-19 + Math.cos(th) * RX, Y0 + Math.sin(th) * RY, z]);
    }
    k.torus(M.brass, 1.0, 0.05, -19, Y0, z, 0, 0, 0, 24, Math.PI);
  }

  // --- Koi pond ---
  const pond: [number, number, number, number][] = [
    [-19, -7.2, 6.4, 0.4],
    [-19, -4.8, 6.4, 0.4],
    [-22.0, -6, 0.4, 2.8],
    [-16.0, -6, 0.4, 2.8],
  ];
  for (const [x, z, w, d] of pond) {
    k.box(M.trimStone, w, 0.5, d, x, 0, z);
    k.box(M.marble, w + 0.08, 0.08, d + 0.08, x, 0.5, z);
  }
  k.floor(M.std({ color: 0x1d6f78, roughness: 0.6 }), -22, -16, -7.2, -4.8, 0.06);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(5.7, 2.1), waterMat(c, 0x1aa6a0, 0x6ff0d6));
  water.rotation.x = -Math.PI / 2;
  water.position.set(-19, 0.42, -6);
  scene.add(noRay(water));
  for (let i = 0; i < 4; i++) {
    const koi = group(scene, -19, 0.3, -6, 0, (g) => {
      const m = M.std({ color: i % 2 ? 0xff7a35 : 0xfff0dc, emissive: i % 2 ? 0x7a2a08 : 0x6b5a40, emissiveIntensity: 0.4 });
      g.sph(m, 0.13, 0, 0, 0, 0.6, 0.5, 1.8, 10);
      g.cone(m, 0.1, 0.2, 0, -0.1, -0.3, 4, Math.PI / 2);
    });
    c.ambient.push((t) => {
      const a = t * (0.22 + i * 0.05) + i * 1.7;
      const nx = -19 + Math.cos(a) * (2.2 - (i % 2) * 0.35);
      const nz = -6 + Math.sin(a) * (0.75 - (i % 2) * 0.12);
      koi.rotation.y = Math.atan2(-Math.sin(a) * 2.2, Math.cos(a) * 0.75);
      koi.position.set(nx, 0.34, nz);
    });
  }
  const r = makeRng(55);
  for (let i = 0; i < 13; i++) {
    const a = r() * TAU;
    const x = -19 + Math.cos(a) * (1.1 + r() * 1.5);
    const z = -6 + Math.sin(a) * (0.45 + r() * 0.45);
    const pad = new THREE.CircleGeometry(0.18 + r() * 0.16, 20, 0.3, TAU - 0.6);
    const lily = group(scene, x, 0.44 + i * 0.0015, z, r() * 6, (g) => {
      g.put(pad, M.leaf, 0, 0, 0, -Math.PI / 2);
      if (i % 3 === 0) {
        for (let p = 0; p < 6; p++) g.put(new THREE.ConeGeometry(0.05, 0.16, 4), M.petalPink, Math.cos((p / 6) * TAU) * 0.05, 0.07, Math.sin((p / 6) * TAU) * 0.05, Math.sin((p / 6) * TAU) * 0.6, 0, -Math.cos((p / 6) * TAU) * 0.6);
      }
    });
    c.ambient.push((t) => {
      lily.position.y = 0.44 + i * 0.0015 + Math.sin(t * 1.1 + i) * 0.008;
      lily.rotation.y += 0.0006 * (i % 2 ? 1 : -1);
    });
  }

  // --- Glass Lotus ---
  const lotus = group(scene, -19, 0.36, -6, 0, (g) => {
    g.cyl(M.leafDark, 0.06, 0.09, 0.5, 0, -0.3, 0, 10);
    g.put(new THREE.SphereGeometry(0.3, 16, 8, 0, TAU, Math.PI / 2, Math.PI / 2), M.leaf, 0, 0.36, 0, 0, 0, 0, 1, 0.5, 1);
  });
  const petalShape = new THREE.Shape();
  petalShape.moveTo(0, 0);
  petalShape.bezierCurveTo(0.34, 0.22, 0.26, 0.75, 0, 1);
  petalShape.bezierCurveTo(-0.26, 0.75, -0.34, 0.22, 0, 0);
  const petalGeo = new THREE.ShapeGeometry(petalShape, 10);
  {
    const p = petalGeo.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      p.setZ(i, x * x * 1.6 - Math.sin(y * Math.PI) * 0.16);
    }
    petalGeo.computeVertexNormals();
  }
  const lotusMat = new THREE.MeshStandardMaterial({
    color: 0xffd9ef,
    emissive: 0xff8fd0,
    emissiveIntensity: 0.25,
    roughness: 0.06,
    metalness: 0.1,
    envMapIntensity: 2.2,
    transparent: true,
    opacity: 0.78,
    side: THREE.DoubleSide,
  });
  const petals: { g: THREE.Group; layer: number }[] = [];
  for (let layer = 0; layer < 3; layer++) {
    const n = 8 - layer;
    for (let i = 0; i < n; i++) {
      const holder = group(lotus, 0, 0.38 + layer * 0.02, 0, (i / n) * TAU + layer * 0.35);
      const pg = new THREE.Group();
      const s = 0.82 - layer * 0.16;
      const mesh = new THREE.Mesh(petalGeo, lotusMat);
      mesh.scale.setScalar(s);
      pg.add(mesh);
      pg.position.z = 0.05;
      holder.add(pg);
      petals.push({ g: pg, layer });
    }
  }
  const heart = M.glow(0xffc23a, 0.3);
  group(lotus, 0, 0.5, 0, 0, (g) => g.sph(heart, 0.12));
  const lotusGlow = glowSprite(M, 0xffc0a0, 3.4, 0.08);
  lotusGlow.position.set(0, 0.7, 0);
  lotus.add(lotusGlow);
  const lotusLight = c.light(-19, 1.8, -6, 0xffd0b0, 20, 14);
  let bloom = 0;
  c.updaters.push((f) => {
    const s = f.state.solvedPuzzles;
    const target = s.p7_light_relay && s.p8_irrigation ? 1 : s.p7_light_relay || s.p8_irrigation ? 0.28 : 0;
    bloom = damp(bloom, target, 1.1, f.dt);
    for (const { g, layer } of petals) g.rotation.x = 0.08 + bloom * (1.12 - layer * 0.3) + Math.sin(f.t * 1.3 + layer) * 0.02;
    lotusMat.emissiveIntensity = 0.25 + bloom * 1.15 + Math.sin(f.t * 2) * 0.06;
    heart.emissiveIntensity = 0.3 + bloom * 3;
    (lotusGlow.material as THREE.SpriteMaterial).opacity = 0.08 + bloom * 0.55;
    lotus.position.y = 0.36 + bloom * 0.28;
    lotusLight.gain = 0.6 + bloom * 1.1;
  });

  // --- Valve banks ---
  valveBank(c, 'A', -19, -12.9, 0, 'p8_irrigation_a');
  valveBank(c, 'B', -19, 0.9, Math.PI, 'p8_irrigation_b');
  for (const x of [-19.6, -19, -18.4]) {
    k.rod(M.copper, 0.06, [x, 0.06, -12.6], [x, 0.06, -7.4]);
    k.rod(M.copper, 0.06, [x, 0.06, -4.6], [x, 0.06, 0.6]);
  }
  plaque(c, k, makePlaqueTexture(WORLD_CLUES.clue_irrigation_plaque.title, WORLD_CLUES.clue_irrigation_plaque.body, { style: 'brass', w: 900, h: 680 }), 1.3, 0.98, -12.44, 1.75, -2.9, -Math.PI / 2);
  c.reg({ id: 'clue_irrigation_plaque', label: clueLabel('clue_irrigation_plaque'), actionType: 'clue', clueId: 'clue_irrigation_plaque' }, -12.5, 1.75, -2.9, 1.5, 1.2, 0.3, Math.PI / 2);

  // --- Planting ---
  const bed = (x0: number, x1: number, z0: number, z1: number, seed: number): void => {
    const w = x1 - x0;
    const d = z1 - z0;
    k.box(M.trimStone, w, 0.4, d, (x0 + x1) / 2, 0, (z0 + z1) / 2);
    k.box(M.soil, w - 0.16, 0.05, d - 0.16, (x0 + x1) / 2, 0.38, (z0 + z1) / 2);
    const rr = makeRng(seed);
    const n = Math.round(w * d * 3.2);
    for (let i = 0; i < n; i++) {
      const x = x0 + 0.2 + rr() * (w - 0.4);
      const z = z0 + 0.2 + rr() * (d - 0.4);
      const pick = rr();
      if (pick < 0.5) k.put(fernGeo(12, 0.75 + rr() * 0.6, seed + i, 0.12 + rr() * 0.06), pick < 0.2 ? M.leafDark : M.leaf, x, 0.4, z, 0, rr() * 6);
      else if (pick < 0.72) flowerClump(c, k, x, 0.4, z, 5, 0.45, seed * 3 + i);
      else {
        k.rod(M.leafDark, 0.012, [x, 0.4, z], [x + 0.1, 1.0 + rr() * 0.4, z]);
        const om = rr() > 0.5 ? M.orchid : M.orchidCyan;
        for (let p = 0; p < 4; p++) {
          const oy = 0.9 + p * 0.13;
          for (let q = 0; q < 5; q++) {
            const a = (q / 5) * TAU;
            k.put(new THREE.SphereGeometry(0.055, 6, 5), om, x + 0.07 + Math.cos(a) * 0.06, oy + Math.sin(a) * 0.06, z + (p % 2 ? 0.05 : -0.05), 0, 0, 0, 1, 1, 0.35);
          }
        }
      }
    }
  };
  bed(-25.6, -24.2, -13.5, 1.5, 301);
  bed(-24.1, -21.4, -13.6, -12.7, 302);
  bed(-16.6, -12.5, -13.6, -12.6, 303);
  bed(-24.1, -21.4, 0.7, 1.6, 304);
  bed(-16.6, -12.5, 0.6, 1.6, 305);
  bed(-13.2, -12.4, -11.9, -8.6, 306);
  const palm = (x: number, z: number, h: number, seed: number): void => {
    let cx = x;
    for (let i = 0; i < 7; i++) {
      const nx = cx + Math.sin(i * 0.5 + seed) * 0.07;
      k.rod(M.bark, 0.13 - i * 0.008, [cx, 0.35 + (i * h) / 7, z], [nx, 0.35 + ((i + 1) * h) / 7, z], 8);
      cx = nx;
    }
    k.put(fernGeo(15, 2.1, seed, 0.1, 1.15), M.leaf, cx, 0.3 + h, z);
    k.put(fernGeo(9, 1.5, seed + 3, 0.12, 0.7), M.leafLime, cx, 0.3 + h, z);
  };
  palm(-24.9, -12.6, 3.2, 1);
  palm(-24.9, 0.6, 3.5, 2);
  palm(-13.6, 1.0, 2.9, 3);
  palm(-13.4, -13.1, 3.0, 4);
  palm(-24.9, -6.2, 3.7, 5);
  // Hanging baskets & lanterns
  for (let i = 0; i < 6; i++) {
    const x = i % 2 ? -15.4 : -22.6;
    const z = -11 + Math.floor(i / 2) * 5;
    const top = Y0 + RY * Math.sqrt(1 - ((x + 19) / RX) ** 2);
    k.rod(M.brass, 0.012, [x, 3.7, z], [x, top, z], 5);
    k.put(lathe([[0.01, 0], [0.22, 0.08], [0.3, 0.26], [0.3, 0.3], [0.01, 0.3]], 16), M.terracotta, x, 3.4, z);
    k.put(fernGeo(18, 1.0, 400 + i, 0.1, 1.7), M.leafLime, x, 3.65, z);
    flowerClump(c, k, x, 3.62, z, 8, 0.5, 420 + i, [M.orchid, M.orchidCyan, M.petalGold]);
  }
  c.light(-23, 2.6, -11, 0xbdfce0, 10, 9);
  c.light(-15, 2.6, -0.6, 0xffc9ee, 10, 9);
}

function valveBank(c: Ctx, bank: 'A' | 'B', x: number, z: number, ry: number, modalId: string): void {
  const { B, M, scene } = c;
  const k = B.kit('cons').at(x, 0, z, ry);
  k.box(M.brassDark, 3.0, 0.16, 0.7);
  k.box(M.verdigris, 2.8, 1.85, 0.2, 0, 0.14, -0.2);
  k.box(M.brass, 2.94, 0.08, 0.3, 0, 1.95, -0.2);
  k.rod(M.copper, 0.07, [-1.3, 0.9, 0], [1.3, 0.9, 0], 14);
  const root = group(scene, x, 0, z, ry);
  const targets = bank === 'A' ? SOLUTIONS.p8_targetsG : SOLUTIONS.p8_targetsH;
  const letter = bank === 'A' ? 'G' : 'H';
  const wheels: THREE.Group[] = [];
  const needles: THREE.Group[] = [];
  for (let i = 0; i < 3; i++) {
    const px = -0.9 + i * 0.9;
    k.cyl(M.copper, 0.08, 0.08, 0.75, px, 0.15, 0, 14);
    k.torus(M.brass, 0.1, 0.03, px, 0.9, 0, Math.PI / 2);
    k.put(new THREE.CylinderGeometry(0.05, 0.05, 0.28, 12), M.brass, px, 0.9, 0.14, Math.PI / 2);
    wheels.push(
      group(root, px, 0.9, 0.3, 0, (g) => {
        g.torus(M.velvetRed, 0.22, 0.032);
        for (let s = 0; s < 4; s++) g.rod(M.brass, 0.016, [0, 0, 0], [Math.cos((s / 4) * TAU) * 0.22, Math.sin((s / 4) * TAU) * 0.22, 0]);
        g.sph(M.brass, 0.05);
        g.box(M.cream, 0.04, 0.07, 0.04, 0, 0.19, 0.02);
      }),
    );
    k.put(new THREE.CylinderGeometry(0.31, 0.31, 0.08, 36), M.brass, px, 1.6, -0.08, Math.PI / 2);
    k.put(new THREE.CircleGeometry(0.28, 36), paintedMat(makeGaugeTexture(targets[i], `${letter}${i + 1}`), 0.4), px, 1.6, -0.035);
    needles.push(
      group(root, px, 1.6, -0.02, 0, (g) => {
        g.box(M.velvetRed, 0.2, 0.018, 0.01, 0.08, -0.009, 0);
        g.sph(M.brass, 0.026);
      }),
    );
  }
  c.updaters.push((f) => {
    const g = computeIrrigationGauges(f.p.valvesA, f.p.valvesB);
    const vals = bank === 'A' ? g.gaugesAtA : g.gaugesAtB;
    const valves = bank === 'A' ? f.p.valvesA : f.p.valvesB;
    for (let i = 0; i < 3; i++) {
      wheels[i].rotation.z = damp(wheels[i].rotation.z, -valves[i] * (Math.PI / 2), 5, f.dt);
      // matches makeGaugeTexture: 0 at lower-left, sweeping 270 degrees clockwise
      const a = (225 - (vals[i] / 80) * 270) * (Math.PI / 180);
      needles[i].rotation.z = damp(needles[i].rotation.z, a + Math.sin(f.t * 9 + i) * 0.008, 4, f.dt);
    }
  });
  const name = bank === 'A' ? 'North Valve Bank' : 'South Valve Bank';
  c.reg(
    { id: modalId, label: `Operate the ${name}`, actionType: 'modal', modalId, getLabel: (s) => solvedTag(s, 'p8_irrigation', `Operate the ${name}`) },
    x,
    1.1,
    z,
    3.0,
    2.1,
    0.9,
    ry,
  );
}

// ============================================================
// CLOCKWORK WORKSHOP
// ============================================================
function buildWorkshop(c: Ctx): void {
  const { B, M, scene } = c;
  const k = B.kit('workshop');
  k.floor(M.workFloor, 12, 26, -14, 2, 0);
  const win = (a: number, b: number): Opening => ({ a, b, y0: 2.6, y1: 4.8, win: true });
  wall(c, k, { axis: 'x', at: -14, from: 12, to: 26.3, h: 5.5, neg: M.brick, pos: M.brick, core: M.trimStone, openings: [win(13.2, 14.8), win(23.4, 25)] });
  wall(c, k, { axis: 'x', at: 2, from: 12, to: 26.3, h: 5.5, neg: M.brick, pos: M.brick, core: M.trimStone, openings: [win(13.2, 14.8), win(22.6, 25.2)] });
  wall(c, k, { axis: 'z', at: 26, from: -14, to: 2.3, h: 5.5, neg: M.brick, pos: M.brick, core: M.trimStone, openings: [win(-12.6, -10.2), win(-1.8, 0.6)] });
  k.box(M.brick, 0.7, 0.5, 16.4, 12, 5.0, -6);
  k.box(M.trimStone, 0.9, 0.16, 16.8, 12, 5.5, -6);

  // Pitched roof with a glazed ridge
  const ridge = 8.2;
  const gx0 = 17.4;
  const gx1 = 20.6;
  const yAt = (x: number): number => 5.55 + (1 - Math.abs(x - 19) / 7.4) * (ridge - 5.55);
  for (const [x0, x1, mat] of [
    [11.6, gx0, M.roof],
    [gx0, 19, M.glassIron],
    [19, gx1, M.glassIron],
    [gx1, 26.4, M.roof],
  ] as [number, number, THREE.Material][]) {
    k.quad(mat, [x0, yAt(x0), 2.5], [x1, yAt(x1), 2.5], [x1, yAt(x1), -14.5], [x0, yAt(x0), -14.5]);
    if (mat === M.roof) k.quad(M.deckWood, [x0, yAt(x0) - 0.06, -14.5], [x1, yAt(x1) - 0.06, -14.5], [x1, yAt(x1) - 0.06, 2.5], [x0, yAt(x0) - 0.06, 2.5]);
  }
  for (const z of [-14, 2]) {
    const t = 0.3;
    for (const zz of [z - t, z + t]) {
      const s = new THREE.Shape();
      s.moveTo(-7.2, 0);
      s.lineTo(7.2, 0);
      s.lineTo(0, ridge - 5.6);
      s.closePath();
      k.put(new THREE.ShapeGeometry(s), M.brick, 19, 5.5, zz, 0, zz > z ? 0 : Math.PI);
    }
  }
  for (let i = 0; i < 5; i++) {
    const z = -12.4 + i * 3.2;
    k.box(M.walnut, 14, 0.26, 0.22, 19, 5.3, z);
    k.rod(M.walnut, 0.1, [12.3, 5.5, z], [19, ridge - 0.2, z], 4);
    k.rod(M.walnut, 0.1, [25.7, 5.5, z], [19, ridge - 0.2, z], 4);
    k.box(M.walnut, 0.2, ridge - 5.6, 0.2, 19, 5.5, z);
    k.box(M.brass, 0.4, 0.3, 0.26, 19, 5.28, z);
  }
  k.box(M.brick, 1.6, 5, 1.4, 25.2, 5.5, -6);
  k.box(M.trimStone, 1.9, 0.25, 1.7, 25.2, 10.4, -6);

  // Giant decorative wall cogs
  const cog = (x: number, y: number, z: number, ry: number, teeth: number, r: number, speed: number, mat: THREE.Material): void => {
    const g = group(scene, x, y, z, ry);
    const spin = group(g, 0, 0, 0, 0, (q) => {
      q.put(gearGeo(teeth, r, 0.16, 0.2, 6), mat);
      q.put(new THREE.CylinderGeometry(r * 0.2, r * 0.2, 0.28, 24), M.brass, 0, 0, 0, Math.PI / 2);
    });
    c.ambient.push((t) => (spin.rotation.z = t * speed));
    B.kit('workshop').at(x, y, z, ry).put(new THREE.CylinderGeometry(r * 0.1, r * 0.1, 0.5, 14), M.darkIron, 0, 0, -0.1, Math.PI / 2);
  };
  // Wall cogs: every spinning cog meshes tooth-to-tooth with an adjacent cog!
  // North wall train (4 meshing gears: 28T <-> 16T <-> 14T, and 28T <-> 12T)
  cog(17.4, 3.0, -13.4, 0, 28, 1.75, 0.18, M.brass);
  cog(20.02, 3.82, -13.38, 0, 16, 1.0, -0.315, M.copper);
  cog(21.4, 2.55, -13.38, 0, 14, 0.88, 0.36, M.brassDark);
  cog(15.42, 4.50, -13.42, 0, 12, 0.75, -0.42, M.copper);
  // West wall pair (24T <-> 14T meshing at distance 2.136 ≈ 1.35 + 0.80)
  cog(12.55, 3.6, -10.6, Math.PI / 2, 24, 1.35, 0.2, M.brassDark);
  cog(12.55, 2.45, -12.40, Math.PI / 2, 14, 0.8, -0.34, M.copper);
  // East wall pairs (each 18T gear meshes with a 10T brass drive pinion!)
  cog(25.45, 4.4, -9.8, -Math.PI / 2, 18, 0.95, 0.3, M.brass);
  cog(25.45, 3.45, -10.92, -Math.PI / 2, 10, 0.54, -0.54, M.brassDark);
  cog(25.45, 4.4, -2.2, -Math.PI / 2, 18, 0.95, -0.3, M.copper);
  cog(25.45, 3.45, -1.08, -Math.PI / 2, 10, 0.54, 0.54, M.brassDark);

  // --- Gear-Train workbench (south wall) ---
  const bx = 17.4;
  const bz = 1.15;
  const bk = k.at(bx, 0, bz, Math.PI);
  bk.box(M.walnutRed, 5.2, 0.12, 1.0, 0, 0.85, 0.05);
  for (const x of [-2.4, 0, 2.4]) bk.box(M.walnut, 0.18, 0.85, 0.8, x, 0, 0);
  bk.box(M.walnut, 5, 0.06, 0.8, 0, 0.25, 0);
  bk.box(M.walnut, 5.2, 1.9, 0.1, 0, 0.97, -0.42);
  bk.box(M.brass, 5.3, 0.08, 0.14, 0, 2.85, -0.42);
  // Horizontal slotted brass guide rail so mounted gears slide into exact tooth-to-tooth mesh!
  bk.box(M.brassDark, 4.6, 0.14, 0.08, 0.1, 1.73, -0.36);
  for (let i = 0; i < 6; i++) bk.box([M.copper, M.darkIron, M.brass][i % 3], 0.25, 0.2, 0.3, -2.1 + i * 0.8, 0.31, 0.1, i);
  bk.box(M.darkIron, 0.5, 0.2, 0.35, 2.2, 0.97, 0.2);
  bk.rod(M.walnut, 0.02, [1.4, 1.0, 0.3], [1.8, 1.0, 0.1]);
  const root = group(scene, bx, 0, bz, Math.PI);
  // Consistent gear pitch radius = teeth * 0.019 so every meshing pair touches tooth-to-tooth!
  const GEAR_MOD = 0.019;
  const gearR = (teeth: number): number => teeth * GEAR_MOD;
  const MOTOR_X = -1.78;
  const MOTOR_R = gearR(12); // 0.228m
  const motor = group(root, MOTOR_X, 1.8, -0.14, 0, (g) => g.put(gearGeo(12, MOTOR_R, 0.1), M.copper));
  bk.box(M.darkIron, 0.54, 0.54, 0.2, MOTOR_X, 1.53, -0.32);
  const gearCache: Record<string, THREE.BufferGeometry> = {};
  const EMPTY_R = 0.34;
  const shafts = [0, 1, 2].map((i) => {
    const carriage = group(root, 0, 1.8, -0.14, 0);
    // Sliding shaft collar & axle
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.36, 14), M.silver);
    axle.rotation.x = Math.PI / 2;
    axle.position.z = -0.06;
    carriage.add(axle);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.02, 10, 20), M.brass);
    collar.position.z = -0.2;
    carriage.add(collar);
    const labelMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.21),
      paintedMat(makePlaqueTexture(`SHAFT ${i + 1}`, `${[30, 40, 20][i]} RPM`, { style: 'brass', w: 256, h: 128 }), 0.35),
    );
    labelMesh.position.set(0, 0.82, -0.21);
    carriage.add(labelMesh);
    const lamp = M.glow(0x64ff8c, 0.05);
    const lampMesh = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), lamp);
    lampMesh.position.set(0, 0.6, -0.19);
    carriage.add(lampMesh);
    const spin = group(carriage, 0, 0, 0, 0);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), i === 1 ? M.copper : M.brass);
    mesh.castShadow = true;
    mesh.visible = false;
    spin.add(mesh);
    return { carriage, spin, mesh, lamp, cur: null as string | null };
  });
  c.updaters.push((f) => {
    const solved = f.state.solvedPuzzles.p9_gear_train;
    motor.rotation.z -= f.dt * (60 / 60) * TAU * 0.35;
    let curX = MOTOR_X;
    let prevR = MOTOR_R;
    let driven = true;
    shafts.forEach((s, i) => {
      const teeth = f.p.gearSlots[i];
      const r = teeth ? gearR(Number(teeth)) : EMPTY_R;
      // Mounted gears slide into exact tooth-to-tooth contact; empty shafts leave a clear air gap
      curX += prevR + r + (teeth ? 0.005 : 0.12);
      prevR = r + (teeth ? 0 : 0.12);
      s.carriage.position.x = curX;

      if (teeth !== s.cur) {
        s.cur = teeth;
        s.mesh.visible = teeth !== null;
        if (teeth) {
          gearCache[teeth] ??= gearGeo(Number(teeth), r, 0.1);
          s.mesh.geometry = gearCache[teeth];
        }
      }
      if (!teeth) {
        driven = false;
      } else if (driven) {
        const rpm = 720 / Number(teeth);
        s.spin.rotation.z += f.dt * (rpm / 60) * TAU * (solved ? 0.8 : 0.35) * (i % 2 ? -1 : 1);
      }
      // Disconnected downstream gears after an empty shaft DO NOT SPIN!
      s.lamp.emissiveIntensity = solved ? 2.4 : 0.05;
    });
  });
  c.reg({ id: 'p9_gear_train', label: 'Assemble the Gear-Train', actionType: 'modal', modalId: 'p9_gear_train', getLabel: (s) => solvedTag(s, 'p9_gear_train', 'Assemble the Gear-Train') }, bx + 0.3, 1.8, bz + 0.15, 4.2, 1.6, 0.6);
  plaque(c, k, makePlaqueTexture(WORLD_CLUES.clue_workshop_blueprint.title, WORLD_CLUES.clue_workshop_blueprint.body, { style: 'blueprint', w: 900, h: 720 }), 1.8, 1.44, 21.4, 2.0, 1.58, Math.PI, 0, M.walnutRed, 0.45);
  c.reg({ id: 'clue_workshop_blueprint', label: clueLabel('clue_workshop_blueprint'), actionType: 'clue', clueId: 'clue_workshop_blueprint' }, 21.4, 2.0, 1.5, 2.0, 1.6, 0.3);

  // --- Forge hearth (east) & central anvil ---
  const hk = k.at(25.0, 0, -6, -Math.PI / 2);
  hk.box(M.brick, 0.9, 2.2, 1.3, -1.35, 0, 0);
  hk.box(M.brick, 0.9, 2.2, 1.3, 1.35, 0, 0);
  hk.box(M.brick, 3.6, 0.9, 1.3, 0, 2.1, 0);
  hk.box(M.brick, 3.6, 0.7, 1.3, 0, 0, 0);
  hk.box(M.soot, 1.8, 1.5, 0.1, 0, 0.7, -0.5);
  hk.box(M.darkIron, 3.8, 0.16, 1.5, 0, 2.98, 0);
  for (let i = 0; i < 4; i++) hk.box(M.brick, 3.2 - i * 0.6, 0.6, 1.2 - i * 0.1, 0, 3.1 + i * 0.6, -0.1);
  const coal = M.glow(0xff5a1e, 1.2);
  hk.box(M.soot, 1.7, 0.12, 1.0, 0, 0.7, 0);
  const coals = group(scene, 25.0, 0.82, -6, -Math.PI / 2, (g) => {
    const r = makeRng(3);
    for (let i = 0; i < 34; i++) g.ico(coal, 0.09 + r() * 0.06, (r() - 0.5) * 1.5, 0.03 + r() * 0.07, (r() - 0.5) * 0.8, 1, 0.8, 1, 0);
  });
  coals.name = 'forge_coals';
  const forgeGlow = glowSprite(M, 0xff7a2a, 3.2, 0.4);
  forgeGlow.position.set(24.3, 1.3, -6);
  scene.add(forgeGlow);
  const forgeLight = c.light(23.6, 1.6, -6, 0xff8a3a, 26, 12, 0.25);
  c.light(17, 3.6, -3, 0xffdcaa, 30, 14);
  c.light(17, 3.6, -10, 0xffdcaa, 28, 14);
  // Great cog inlaid in the floor around the anvil
  k.put(gearGeo(24, 2.7, 0.02, 0.5, 8), M.brass, 19.6, 0.004, -6, -Math.PI / 2);
  for (const [x, z] of [[16.5, -3], [16.5, -10], [21.5, -3], [21.5, -10]] as const) {
    k.rod(M.darkIron, 0.015, [x, 3.9, z], [x, 5.4, z], 5);
    k.put(new THREE.ConeGeometry(0.4, 0.28, 22, 1, true), M.copper, x, 3.85, z);
    k.sph(M.lampGlow, 0.14, x, 3.72, z);
  }
  // Anvil
  const ax = 19.6;
  k.cyl(M.bark, 0.46, 0.5, 0.5, ax, 0, -6, 14);
  k.torus(M.brass, 0.48, 0.03, ax, 0.4, -6, Math.PI / 2);
  k.box(M.darkIron, 0.5, 0.14, 0.4, ax, 0.5, -6);
  k.box(M.darkIron, 0.26, 0.16, 0.26, ax, 0.64, -6);
  k.box(M.darkIron, 0.9, 0.2, 0.36, ax, 0.8, -6);
  k.put(new THREE.ConeGeometry(0.16, 0.5, 14), M.darkIron, ax - 0.66, 0.9, -6, 0, 0, Math.PI / 2);
  const ingot = M.glow(0xff6a2a, 0.4);
  group(scene, ax, 1.0, -6, 0, (g) => g.box(ingot, 0.4, 0.07, 0.2));
  const anvilGlow = glowSprite(M, 0xff9a4a, 1.6, 0.2);
  anvilGlow.position.set(ax, 1.2, -6);
  scene.add(anvilGlow);
  // Bellows piping from each lever to the hearth
  const north = leverUnit(c, 24.2, 1.2, -12.2, -Math.PI / 4 - 0.4, 'workshop', true, 0xff9d3a);
  const south = leverUnit(c, 24.2, 1.2, -0.2, -Math.PI + Math.PI / 4 + 0.4, 'workshop', true, 0xff9d3a);
  k.rod(M.copper, 0.08, [24.7, 0.15, -11.8], [25.1, 0.15, -7.9], 12);
  k.rod(M.copper, 0.08, [24.7, 0.15, -0.6], [25.1, 0.15, -4.1], 12);
  const stageLamps = [0, 1, 2].map((i) => {
    const m = M.glow(0xffb347, 0.05);
    group(scene, 24.3, 2.5, -6.6 + i * 0.6, 0, (g) => {
      g.sph(m, 0.13);
      g.torus(M.brass, 0.16, 0.03, 0.02, 0, 0, 0, Math.PI / 2);
    });
    return m;
  });
  let flare = 0;
  let lastStage = -1;
  c.updaters.push((f) => {
    const on = f.state.solvedPuzzles.p9_gear_train;
    const done = f.state.solvedPuzzles.p10_foundry_sync;
    const now = Date.now();
    for (const [u, at] of [
      [north, f.p.foundryLeverNorthAt],
      [south, f.p.foundryLeverSouthAt],
    ] as const) {
      const down = at > 0 && now - at < 1400 && now - at > -4000;
      u.arm.rotation.x = damp(u.arm.rotation.x, down ? 0.75 : -0.75, 11, f.dt);
      u.lamp.emissiveIntensity = done ? 2 : on ? 1.2 + Math.sin(f.t * 5) * 0.7 : 0.1;
    }
    if (lastStage >= 0 && f.p.foundryStage > lastStage) flare = 1;
    lastStage = f.p.foundryStage;
    flare = damp(flare, 0, 1.4, f.dt);
    const heat = (on ? 1 : 0.45) + f.p.foundryStage * 0.25;
    coal.emissiveIntensity = heat * 1.5 + flare * 2.5 + Math.sin(f.t * 7) * 0.15;
    ingot.emissiveIntensity = 0.2 + (on ? 0.5 : 0) + f.p.foundryStage * 0.6 + flare * 2;
    (forgeGlow.material as THREE.SpriteMaterial).opacity = 0.25 * heat + flare * 0.5;
    forgeGlow.scale.setScalar(3.2 + flare * 2.5);
    (anvilGlow.material as THREE.SpriteMaterial).opacity = 0.1 + f.p.foundryStage * 0.14 + flare * 0.5;
    forgeLight.gain = heat + flare * 1.6;
    stageLamps.forEach((m, i) => (m.emissiveIntensity = f.p.foundryStage > i ? 2.6 : 0.05));
  });
  for (const [id, z, side] of [
    ['lever_foundry_north', -12.2, 'North-East'],
    ['lever_foundry_south', -0.2, 'South-East'],
  ] as const) {
    c.reg(
      {
        id,
        label: `Pull the ${side} Bellows Lever`,
        actionType: 'direct',
        maxDistance: 3.4,
        getLabel: (s) =>
          s.solvedPuzzles.p10_foundry_sync
            ? null
            : s.solvedPuzzles.p9_gear_train
              ? `Pull the ${side} Bellows Lever together (${s.puzzles.foundryStage}/3)`
              : `${side} Bellows Lever (gear-train must run first)`,
      },
      24.2,
      1.2,
      z,
      1.1,
      1.9,
      1.1,
    );
  }
  // Clutter: barrels, shelves, hanging tools
  for (const [x, z, s] of [[13.1, 0.9, 1], [13.9, 1.1, 0.85], [13.2, -13.0, 1]] as const) {
    k.put(lathe([[0.01, 0], [0.3, 0], [0.38, 0.35], [0.38, 0.5], [0.3, 0.85], [0.01, 0.85]], 18), M.walnutRed, x, 0, z, 0, 0, 0, s);
    for (const y of [0.15, 0.7]) k.torus(M.darkIron, 0.35 * s, 0.018, x, y * s, z, Math.PI / 2);
  }
  for (let i = 0; i < 5; i++) {
    k.put(gearGeo(10 + i * 2, 0.16 + i * 0.03, 0.04), [M.brass, M.copper, M.silver][i % 3], 22.6 + i * 0.5, 0.9 + (i % 2) * 0.5, 1.6, 0, 0, i);
  }
}

// ============================================================
// STARLIGHT OBSERVATORY SKY-DECK + RAMP
// ============================================================
function railing(k: Kit, M: Mats, x0: number, z0: number, x1: number, z1: number, y: number): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ry = Math.atan2(-(z1 - z0), x1 - x0);
  const r = k.at((x0 + x1) / 2, y, (z0 + z1) / 2, ry);
  r.box(M.brass, len, 0.07, 0.12, 0, 1.02, 0);
  r.box(M.brass, len, 0.04, 0.06, 0, 0.12, 0);
  r.box(M.brass, len, 0.03, 0.05, 0, 0.78, 0);
  const posts = Math.max(1, Math.round(len / 1.8));
  for (let i = 0; i <= posts; i++) {
    const x = -len / 2 + (len * i) / posts;
    r.box(M.brassDark, 0.13, 1.1, 0.13, x, 0, 0);
    r.sph(M.brass, 0.1, x, 1.2, 0, 1, 1, 1, 12);
  }
  const bars = Math.round(len / 0.24);
  for (let i = 0; i < bars; i++) r.cyl(M.brass, 0.013, 0.013, 0.68, -len / 2 + (len * (i + 0.5)) / bars, 0.13, 0, 5);
  const rings = Math.round(len / 0.48);
  for (let i = 0; i < rings; i++) r.torus(M.copper, 0.085, 0.012, -len / 2 + (len * (i + 0.5)) / rings, 0.89, 0, 0, 0, 0, 14);
}

function buildObservatory(c: Ctx): void {
  const { B, M, scene } = c;
  const k = B.kit('observatory');
  const Y = OBSERVATORY_DECK.y;
  const { minX, maxX, minZ, maxZ } = OBSERVATORY_DECK;
  const RX0 = SKYLIFT_RAMP.minX;

  // Deck slabs (the ramp footprint stays open; Z: minZ..SKYLIFT_RAMP.zEnd is a wide 2.7m top landing!)
  k.floor(M.deckWood, minX, RX0, minZ, maxZ, Y);
  k.floor(M.deckWood, RX0, maxX, minZ, SKYLIFT_RAMP.zEnd, Y);
  k.box(M.plaster, RX0 - minX, 0.28, maxZ - minZ, (minX + RX0) / 2, Y - 0.29, (minZ + maxZ) / 2);
  k.box(M.plaster, maxX - RX0, 0.28, SKYLIFT_RAMP.zEnd - minZ, (RX0 + maxX) / 2, Y - 0.29, (minZ + SKYLIFT_RAMP.zEnd) / 2);
  k.box(M.brassDark, RX0 - minX + 0.2, 0.4, 0.12, (minX + RX0) / 2, Y - 0.4, maxZ + 0.04);
  k.box(M.brassDark, maxX - minX + 0.2, 0.4, 0.12, (minX + maxX) / 2, Y - 0.4, minZ - 0.04);
  k.box(M.brassDark, 0.12, 0.4, maxZ - minZ, minX - 0.04, Y - 0.4, (minZ + maxZ) / 2);
  k.box(M.brass, RX0 - minX, 0.02, 0.1, (minX + RX0) / 2, Y - 0.005, maxZ - 0.45);
  k.box(M.brass, maxX - minX, 0.02, 0.1, (minX + maxX) / 2, Y - 0.005, minZ + 0.6);
  // Flush brass threshold strip where the top of the ramp meets the flat wooden landing!
  k.box(M.brass, maxX - RX0, 0.03, 0.16, (RX0 + maxX) / 2, Y - 0.005, SKYLIFT_RAMP.zEnd);
  // Brass curb along the stairwell cutout edge
  k.box(M.brass, 0.14, 0.08, maxZ - SKYLIFT_RAMP.zEnd, RX0 - 0.05, Y, (maxZ + SKYLIFT_RAMP.zEnd) / 2);
  // Underside joists + slender columns on the terrace side
  for (let x = -9; x <= 8; x += 2.43) k.box(M.walnut, 0.22, 0.26, maxZ - minZ - 0.3, x, Y - 0.54, (minZ + maxZ) / 2);
  for (const x of [-9.4, -3.6, 3.6, 8.5]) {
    k.cyl(M.trimStone, 0.24, 0.3, 0.3, x, 0, -20.1, 10);
    k.cyl(M.brass, 0.1, 0.13, 3.8, x, 0.3, -20.1, 14);
    k.cyl(M.brass, 0.22, 0.1, 0.25, x, 4.0, -20.1, 14);
    for (const s of [-1, 1]) k.torus(M.brass, 0.55, 0.03, x + s * 0.62, 3.75, -20.1, 0, 0, s > 0 ? Math.PI / 2 : 0, 14, Math.PI / 2);
  }
  railing(k, M, -9.85, -20.45, 11.95, -20.45, Y);
  railing(k, M, -9.85, -20.4, -9.85, -13.25, Y);
  railing(k, M, -9.85, -13.25, 8.75, -13.25, Y);
  // Full brass guard railing along the stairwell opening beside the ramp (leaves Z: -20.4..-17.8 landing wide open!)
  railing(k, M, 8.75, -13.25, 8.75, SKYLIFT_RAMP.zEnd, Y);
  railing(k, M, 12.0, -20.4, 12.0, -14.0, Y);

  // --- Ramp ---
  const z0 = SKYLIFT_RAMP.zStart;
  const z1 = SKYLIFT_RAMP.zEnd;
  const rampLen = z0 - z1;
  const X0 = 8.8;
  const X1 = 11.9;
  k.quad(M.brassDark, [X0, 0.005, z0], [X1, 0.005, z0], [X1, Y, z1], [X0, Y, z1]);
  k.quad(M.trimStone, [X0, -0.25, z0], [X0, Y - 0.25, z1], [X1, Y - 0.25, z1], [X1, -0.25, z0]);
  const slope = Math.atan2(Y, rampLen);
  for (let i = 1; i < 20; i++) {
    const t = i / 20;
    k.box(M.brass, X1 - X0 - 0.3, 0.025, 0.07, (X0 + X1) / 2, Y * t - 0.002, z0 + (z1 - z0) * t, 0, slope);
  }
  // Inner flank: masonry below the slope, brass lattice above (collider X 8.5..8.9)
  for (const x of [8.5, 8.9]) {
    const a = [x, 0, -10.4];
    const b = [x, 0, z1];
    const cc = [x, 4.5, z1];
    const d = [x, 0.35, -10.4];
    if (x < 8.7) k.quad(M.ashlar, b, a, d, cc);
    else k.quad(M.ashlar, a, b, cc, d);
  }
  k.quad(M.trimStone, [8.46, 0.36, -10.4], [8.94, 0.36, -10.4], [8.94, 4.52, z1], [8.46, 4.52, z1]);
  k.quad(M.ashlar, [8.5, 0, -10.4], [8.9, 0, -10.4], [8.9, 0.35, -10.4], [8.5, 0.35, -10.4]);
  const flankLen = -10.4 - z1;
  k.box(M.brass, 0.1, 0.1, flankLen, 8.7, 4.42, (-10.4 + z1) / 2);
  for (let i = 0; i <= 22; i++) {
    const z = -10.4 - (i * flankLen) / 22;
    const yb = 0.35 + (4.15 * i) / 22;
    if (yb < 4.35) k.cyl(i % 5 === 0 ? M.brassDark : M.brass, i % 5 === 0 ? 0.04 : 0.016, i % 5 === 0 ? 0.04 : 0.016, 4.42 - yb, 8.7, yb, z, 7);
  }
  for (const y of [1.4, 2.4, 3.4]) {
    const zEnd = -10.4 - ((y - 0.35) / 4.15) * flankLen;
    k.box(M.brass, 0.04, 0.04, -10.4 - zEnd, 8.7, y, (-10.4 + zEnd) / 2);
  }
  {
    const iv = k.at(8.86, 4.4, (-10.4 + z1) / 2, Math.PI / 2);
    iv.put(ivyGeo(4.8, 1.8, 130, 91), M.leaf);
    iv.put(ivyGeo(4.8, 1.6, 40, 92), M.petalViolet);
  }
  // Masonry end wall beneath the top of the ramp (supports the flat landing!)
  k.box(M.ashlar, 3.1, 4.32, 0.3, 10.35, 0, z1);
  k.torus(M.trimStone, 1.0, 0.1, 10.35, 1.6, z1 - 0.16, 0, 0, 0, 24, Math.PI);
  k.put(ivyGeo(3, 3.4, 130, 95), M.leafDark, 10.35, 4.3, z1 - 0.17, 0, Math.PI);

  // --- Rotating orrery under the starry cupola ---
  const ox = -1;
  const oz = -16.85;
  k.cyl(M.trimStone, 2.35, 2.5, 0.12, ox, Y, oz, 48);
  k.disc(paintedMat(makeNumberRing(8, '', '#233f86', '#ffe2a0', true), 0.4), 2.2, ox, Y + 0.13, oz, 64);
  k.disc(paintedMat(makeNumberRing(8, '', '#e9cf95', '#47290f', true), 0.3), 1.02, ox, Y + 0.135, oz, 48);
  k.put(lathe([[0.01, 0], [0.5, 0], [0.44, 0.1], [0.2, 0.2], [0.12, 0.5], [0.16, 0.85], [0.1, 1.0], [0.01, 1.0]], 24), M.brass, ox, Y + 0.13, oz);
  const orr = group(scene, ox, Y + 1.2, oz, 0);
  group(orr, 0, 0, 0, 0, (g) => {
    g.sph(M.lampGlow, 0.26, 0, 0.05, 0, 1, 1, 1, 24);
    g.torus(M.brass, 0.33, 0.02, 0, 0.05, 0, Math.PI / 2);
  });
  const sunGlow = glowSprite(M, 0xffd27a, 1.8, 0.6);
  sunGlow.position.y = 0.05;
  orr.add(sunGlow);
  const planets: { key: 'sun' | 'mars' | 'moon' | 'sea'; r: number; y: number; size: number; mat: THREE.Material; col: number }[] = [
    { key: 'sun', r: 0.8, y: -0.1, size: 0.17, mat: M.glow(0xffc23c, 0.7), col: 0xffc23c },
    { key: 'mars', r: 1.2, y: -0.22, size: 0.15, mat: M.std({ color: 0xd9733f, metalness: 0.5, roughness: 0.35, emissive: 0x8a3210, emissiveIntensity: 0.5 }), col: 0xff8a4a },
    { key: 'moon', r: 1.58, y: -0.34, size: 0.13, mat: M.std({ color: 0xeef2fa, metalness: 0.7, roughness: 0.2, emissive: 0x8090b0, emissiveIntensity: 0.4 }), col: 0xe6eeff },
    { key: 'sea', r: 1.98, y: -0.46, size: 0.16, mat: M.std({ color: 0x2f6bff, metalness: 0.4, roughness: 0.25, emissive: 0x1238b0, emissiveIntensity: 0.7 }), col: 0x5a90ff },
  ];
  const arms = planets.map((p) => {
    group(orr, 0, p.y - 0.12, 0, 0, (g) => g.torus(M.brassDark, p.r, 0.013, 0, 0, 0, Math.PI / 2, 0, 0, 72));
    const arm = group(orr, 0, p.y, 0, 0, (g) => {
      g.rod(M.brass, 0.018, [0, -0.12, 0], [0, -0.12, -p.r]);
      g.cyl(M.brass, 0.014, 0.014, 0.14, 0, -0.12, -p.r, 6);
      g.sph(p.mat, p.size, 0, 0.06, -p.r, 1, 1, 1, 20);
      if (p.key === 'sea') g.torus(M.silver, p.size * 1.6, 0.014, 0, 0.06, -p.r, 1.2);
      if (p.key === 'sun') for (let i = 0; i < 8; i++) g.put(new THREE.ConeGeometry(0.03, 0.1, 4), M.brass, Math.cos((i / 8) * TAU) * 0.22, 0.06 + Math.sin((i / 8) * TAU) * 0.22, -p.r, 0, 0, (i / 8) * TAU - Math.PI / 2);
    });
    const s = glowSprite(M, p.col, p.size * 5, 0.45);
    s.position.set(0, 0.06, -p.r);
    arm.add(s);
    return arm;
  });
  const armill = [0.55, 0.64].map((r, i) => group(orr, 0, 0.05, 0, 0, (g) => g.torus(i ? M.silver : M.copper, r, 0.012)));
  c.ambient.push((t) => {
    armill[0].rotation.set(t * 0.5, t * 0.3, 0);
    armill[1].rotation.set(-t * 0.35, 0.4, t * 0.4);
  });
  c.updaters.push((f) => {
    const solved = f.state.solvedPuzzles.p11_orrery;
    planets.forEach((p, i) => {
      const a = ((f.p.orrery[p.key] - 1) / 8) * TAU;
      arms[i].rotation.y = dampAngle(arms[i].rotation.y, -a + Math.sin(f.t * 0.8 + i) * 0.012, 3, f.dt);
      arms[i].position.y = p.y + Math.sin(f.t * 1.2 + i * 1.6) * 0.02;
    });
    (sunGlow.material as THREE.SpriteMaterial).opacity = solved ? 0.95 : 0.5;
  });
  c.reg({ id: 'p11_orrery', label: 'Align the Planetary Orrery', actionType: 'modal', modalId: 'p11_orrery', maxDistance: 4.4, getLabel: (s) => solvedTag(s, 'p11_orrery', 'Align the Planetary Orrery') }, ox, Y + 0.95, oz, 3.6, 1.5, 3.6);

  // Cupola
  const R = 3.15;
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) / 8) * TAU;
    const x = ox + Math.cos(a) * R;
    const z = oz + Math.sin(a) * R;
    k.cyl(M.trimStone, 0.2, 0.24, 0.3, x, Y, z, 10);
    k.cyl(M.marble, 0.1, 0.13, 2.5, x, Y + 0.3, z, 14);
    k.cyl(M.brass, 0.2, 0.12, 0.22, x, Y + 2.8, z, 12);
  }
  k.torus(M.trimStone, R, 0.17, ox, Y + 3.12, oz, Math.PI / 2, 0, 0, 56);
  k.torus(M.brass, R + 0.13, 0.06, ox, Y + 3.2, oz, Math.PI / 2, 0, 0, 56);
  const dome = new THREE.SphereGeometry(R, 48, 20, 0, TAU, 0, Math.PI / 2);
  k.put(dome, M.starDome, ox, Y + 3.15, oz, 0, 0, 0, 0.985, 0.8, 0.985);
  k.put(dome, M.copperRoof, ox, Y + 3.15, oz, 0, 0, 0, 1.01, 0.83, 1.01);
  for (let i = 0; i < 8; i++) {
    const pts = Array.from({ length: 12 }, (_, j) => {
      const th = (j / 11) * (Math.PI / 2);
      return new THREE.Vector3(Math.cos(th) * R * 1.02, Math.sin(th) * R * 0.84, 0);
    });
    k.put(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.045, 6), M.brass, ox, Y + 3.15, oz, 0, ((i + 0.5) / 8) * TAU);
  }
  k.cyl(M.brass, 0.25, 0.4, 0.3, ox, Y + 5.75, oz, 12);
  k.put(new THREE.ExtrudeGeometry(starShape(8, 0.45, 0.17), { depth: 0.08, bevelEnabled: false }), M.brass, ox, Y + 6.5, oz - 0.04);
  c.light(ox, Y + 2.6, oz, 0xbfcaff, 12, 9);

  // Orrery ledger + star plaque + core dais
  lectern(c, k, -5.6, -14.7, 0.35, makePlaqueTexture(WORLD_CLUES.clue_orrery_ledger.title, WORLD_CLUES.clue_orrery_ledger.body, { w: 900, h: 720 }), 'clue_orrery_ledger', Y);
  pedestal(c, k, 2.9, -14.5, 1.0, Y);
  const starPlate = group(scene, 4.2, Y, -14.2, -0.3, (g) => {
    g.cyl(M.brass, 0.04, 0.05, 1.0, 0, 0, 0, 10);
    const t = g.at(0, 1.1, 0, 0, -0.5);
    t.box(M.brass, 0.66, 0.5, 0.05, 0, -0.25, 0);
    t.panel(paintedMat(makePlaqueTexture('STAR CORE', 'Turn the STAR Resonance Pedestal toward the pole star: NORTH (N).', { style: 'brass', w: 512, h: 384 }), 0.4), 0.6, 0.45, 0, 0, 0.03);
  });
  c.updaters.push((f) => (starPlate.visible = f.state.solvedPuzzles.p11_orrery));
  c.reg({ id: 'clue_core_star_cardinal', label: clueLabel('clue_core_star_cardinal'), actionType: 'clue', clueId: 'clue_core_star_cardinal', enabled: (s) => s.solvedPuzzles.p11_orrery }, 4.2, Y + 0.95, -14.2, 0.8, 1.2, 0.6);

  // Telescope
  const tel = group(scene, 6.4, Y, -15.4, 0.6, (g) => {
    for (let i = 0; i < 3; i++) g.rod(M.walnutRed, 0.035, [0, 1.15, 0], [Math.cos((i / 3) * TAU) * 0.55, 0, Math.sin((i / 3) * TAU) * 0.55]);
  });
  const tube = group(tel, 0, 1.3, 0, 0, (g) => {
    const t = g.at(0, 0, 0, 0, -0.6);
    t.put(new THREE.CylinderGeometry(0.13, 0.1, 1.3, 20), M.brass, 0, 0, -0.2, Math.PI / 2);
    t.put(new THREE.CylinderGeometry(0.17, 0.17, 0.16, 20), M.copper, 0, 0, -0.85, Math.PI / 2);
    t.put(new THREE.CylinderGeometry(0.05, 0.06, 0.4, 14), M.brass, 0, 0, 0.6, Math.PI / 2);
  });
  c.ambient.push((t) => (tube.rotation.y = Math.sin(t * 0.12) * 0.6));
  for (const [x, z] of [[-9.2, -13.8], [8.1, -13.8], [-9.2, -19.8], [8.1, -19.8]] as const) pottedPlant(c, k, x, z, 0.9, Math.round(x * 3 + z), Y);
  for (const [x, z] of [[-8.6, -16.8], [11.5, -20.0]] as const) lampPost(c, k, x, z, Y);

  // --- Wind-Harp chimes along the north balcony ---
  const harps: [HarpColor, number][] = [
    ['azure', FLOOR_PLATES.terrace_azure.x],
    ['amber', FLOOR_PLATES.terrace_amber.x],
    ['violet', FLOOR_PLATES.terrace_violet.x],
    ['emerald', FLOOR_PLATES.terrace_emerald.x],
  ];
  harps.forEach(([col, x], hi) => {
    const hex = new THREE.Color(HARP_HEX[col]).getHex();
    const mat = M.glow(hex, 0.6);
    const hk = k.at(x, Y, -19.8, 0);
    hk.cyl(M.trimStone, 0.42, 0.46, 0.1, 0, 0, 0, 24);
    for (const s of [-1, 1]) hk.rod(M.brass, 0.035, [s * 0.4, 0.1, 0], [s * 0.46, 1.95, 0], 10);
    hk.torus(M.brass, 0.46, 0.035, 0, 1.95, 0, 0, 0, 0, 28, Math.PI);
    hk.box(M.brass, 0.92, 0.05, 0.08, 0, 1.92, 0);
    hk.sph(mat, 0.1, 0, 2.48, 0);
    const root = group(scene, x, Y + 1.9, -19.8, 0);
    const tubes = [0, 1, 2, 3, 4].map((i) =>
      group(root, -0.3 + i * 0.15, 0, 0, 0, (g) => {
        g.rod(M.brass, 0.005, [0, 0, 0], [0, -0.14, 0], 4);
        g.cyl(i % 2 ? M.brass : mat, 0.036, 0.036, 0.72 + i * 0.13, 0, -0.14 - (0.72 + i * 0.13), 0, 14);
      }),
    );
    const halo = glowSprite(M, hex, 2.2, 0.2);
    halo.position.set(x, Y + 1.3, -19.7);
    scene.add(halo);
    let ring = 0;
    let last = -1;
    c.ambient.push((t) => tubes.forEach((g, i) => (g.rotation.z = Math.sin(t * 1.7 + i * 1.1 + hi) * (0.03 + ring * 0.16))));
    c.updaters.push((f) => {
      const step = f.p.windHarpStep;
      if (last >= 0 && step > last && SOLUTIONS.p12_sequence[last] === col) ring = 1;
      last = step;
      ring = damp(ring, 0, 1.1, f.dt);
      const stone = f.p.terracePadOccupied[col].length > 0;
      const done = f.state.solvedPuzzles.p12_wind_harp;
      mat.emissiveIntensity = damp(mat.emissiveIntensity, 0.5 + (stone ? 0.8 : 0) + (done ? 0.8 : 0) + ring * 2, 6, f.dt);
      (halo.material as THREE.SpriteMaterial).opacity = 0.1 + ring * 0.6 + (done || stone ? 0.2 : 0);
    });
    c.reg({ id: `harp_${col}`, label: `Pluck the ${col.toUpperCase()} Wind-Harp Chime`, actionType: 'direct', maxDistance: 3.4 }, x, Y + 1.25, -19.8, 1.05, 2.5, 0.7);
  });
  // Step lamps (how many chords have resonated)
  const steps = [0, 1, 2, 3].map((i) => {
    const m = M.glow(0xfff0b0, 0.05);
    group(scene, -0.45 + i * 0.3, Y + 1.15, -20.45, 0, (g) => g.sph(m, 0.1));
    return m;
  });
  c.updaters.push((f) => steps.forEach((m, i) => (m.emissiveIntensity = f.state.solvedPuzzles.p12_wind_harp || f.p.windHarpStep > i ? 2.4 : 0.05)));

  // Sky-Lift gate arch at the foot of the ramp
  const gk = B.kit('courtyard');
  for (const x of [8.62, 11.82]) {
    gk.box(M.trimStone, 0.4, 3.3, 0.5, x, 0, -10.35);
    gk.sph(M.brass, 0.2, x, 3.52, -10.35);
  }
  gk.box(M.brass, 3.4, 0.22, 0.3, 10.22, 3.2, -10.35);
  plaque(c, gk, makePlaqueTexture('SKY-LIFT', 'Observatory', { style: 'brass', w: 512, h: 160 }), 1.7, 0.42, 10.22, 3.62, -10.28, 0);
}

// ============================================================
// SKY-GARDEN TERRACE & GRAND SOLSTICE GATE
// ============================================================
const GATE_Z = -27.6;
const GATE_Y = 2.72;
const IRIS_R = 2.66;

function buildTerrace(c: Ctx): void {
  const { B, M, scene } = c;
  const k = B.kit('terrace');
  k.floor(M.grass, -12, 12, -29, -14, 0);
  k.floor(M.flag, -2.6, 2.6, -28.8, -14, 0.011);
  const plaza = new THREE.CircleGeometry(5.4, 56);
  scaleUv(plaza, 10.8, 10.8);
  k.put(plaza, M.flag, 0, 0.016, -24.4, -Math.PI / 2);
  k.disc(M.rosette, 3.0, 0, 0.022, -22.7, 64);
  k.floor(M.flag, -7.2, 7.2, -21.7, -19.3, 0.013);

  // North courtyard arch
  const ak = B.kit('arch');
  wall(c, ak, { axis: 'x', at: -14, from: -12.3, to: -5.2, h: 4.3, half: 0.3, neg: M.ashlar, pos: M.ashlar });
  wall(c, ak, { axis: 'x', at: -14, from: 5.2, to: 8.6, h: 4.3, half: 0.3, neg: M.ashlar, pos: M.ashlar });
  const arch = new THREE.Shape();
  arch.moveTo(-5.3, 4.3);
  arch.lineTo(-5.3, 3.3);
  arch.absellipse(0, 3.3, 5.2, 0.88, Math.PI, 0, true);
  arch.lineTo(5.3, 3.3);
  arch.lineTo(5.3, 4.3);
  arch.closePath();
  const ag = new THREE.ExtrudeGeometry(arch, { depth: 0.6, bevelEnabled: false, curveSegments: 32 });
  ak.put(ag, M.ashlar, 0, 0, -14.3);
  for (const s of [-1, 1]) {
    for (const z of [-14.34, -13.66]) {
      ak.box(M.trimStone, 0.56, 3.4, 0.16, s * 5.5, 0, z);
      ak.box(M.trimStone, 0.7, 0.3, 0.26, s * 5.5, 3.25, z);
      ak.box(M.trimStone, 0.7, 0.35, 0.26, s * 5.5, 0, z);
    }
    const iv = ak.at(s * 7.4, 4.2, -14.34, Math.PI);
    iv.put(ivyGeo(2.2, 3.2, 120, 200 + s), M.leafDark);
    iv.put(ivyGeo(2.2, 2.6, 40, 210 + s), M.petalPink);
  }
  {
    const iv = ak.at(-8.6, 4.2, -13.64, 0);
    iv.put(ivyGeo(5.4, 3.0, 240, 222), M.leaf);
    iv.put(ivyGeo(5.4, 2.4, 70, 223), M.petalViolet);
  }

  // Under-Arch Resonance Relief (faces the terrace, tilted down)
  const rk = k.at(0, 3.2, -14.2 - 0.25, Math.PI, 0.42);
  rk.box(M.trimStone, 4.7, 1.62, 0.16, 0, -0.81, -0.1);
  rk.box(M.brass, 4.8, 0.06, 0.2, 0, 0.8, -0.09);
  rk.box(M.brass, 4.8, 0.06, 0.2, 0, -0.86, -0.09);
  rk.panel(paintedMat(M.T.archRelief, 0.42), 4.5, 1.5, 0, 0, 0.0);
  for (const x of [-2.1, 0, 2.1]) k.rod(M.brass, 0.03, [x, 3.6, -14.6], [x, 4.3, -14.75]);
  rk.put(new THREE.ExtrudeGeometry(starShape(16, 0.6, 0.42), { depth: 0.04, bevelEnabled: false }), M.brass, 0, 0, -0.23);
  c.reg({ id: 'clue_terrace_arch', label: clueLabel('clue_terrace_arch'), actionType: 'clue', clueId: 'clue_terrace_arch', maxDistance: 5.2 }, 0, 3.15, -14.5, 4.8, 1.6, 0.5);

  // Balustrade walls
  wall(c, k, { axis: 'z', at: -12.1, from: -29.5, to: -14, h: 3.5, half: 0.3, neg: M.ashlar, pos: M.ashlar, coping: M.trimStone });
  wall(c, k, { axis: 'z', at: 12.1, from: -29.5, to: -20.6, h: 3.5, half: 0.3, neg: M.ashlar, pos: M.ashlar, coping: M.trimStone });
  wall(c, k, { axis: 'z', at: 12.1, from: -20.6, to: -14, h: 4.5, half: 0.3, neg: M.ashlar, pos: M.ashlar, coping: M.trimStone });
  wall(c, k, { axis: 'x', at: GATE_Z, from: -12.4, to: -3.2, h: 4.5, half: 0.4, neg: M.ashlar, pos: M.ashlar, coping: M.trimStone });
  wall(c, k, { axis: 'x', at: GATE_Z, from: 3.2, to: 12.4, h: 4.5, half: 0.4, neg: M.ashlar, pos: M.ashlar, coping: M.trimStone });
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = -15.6 - i * 4;
      if (s > 0 && i < 2) continue;
      k.box(M.trimStone, 0.2, 3.5, 0.6, s * 11.74, 0, z);
      k.put(lathe([[0.01, 0], [0.2, 0], [0.12, 0.12], [0.3, 0.4], [0.34, 0.52], [0.01, 0.52]], 16), M.marble, s * 12.1, 3.66, z);
      k.put(fernGeo(16, 0.9, 500 + i, 0.12, 1.2), M.leafLime, s * 12.1, 4.12, z);
    }
    const iv = k.at(s * 11.78, 3.5, s < 0 ? -21.5 : -24.6, s > 0 ? -Math.PI / 2 : Math.PI / 2);
    iv.put(ivyGeo(s < 0 ? 13 : 8, 2.9, 420, 230 + s), M.leaf);
    iv.put(ivyGeo(s < 0 ? 13 : 8, 2.3, 90, 240 + s), s > 0 ? M.petalGold : M.petalPink);
    const iv2 = k.at(s * 8.2, 4.5, GATE_Z + 0.42, 0);
    iv2.put(ivyGeo(5.6, 3.2, 260, 250 + s), M.leafDark);
    iv2.put(ivyGeo(5.6, 2.6, 90, 260 + s), M.petalWhite);
  }

  // Amphitheatre tiers
  const tier = (cx: number, r: number, h: number, a0: number, a1: number): void => {
    const sh = new THREE.Shape();
    sh.absarc(0, 0, r + 0.75, a0, a1, false);
    sh.absarc(0, 0, r, a1, a0, true);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false, curveSegments: 24 });
    k.put(g, M.trimStone, cx, 0, -24.0, -Math.PI / 2);
  };
  for (let i = 0; i < 3; i++) {
    tier(0, 7.6 + i * 0.95, 0.28 + i * 0.28, Math.PI - 0.34, Math.PI + 0.42);
    tier(0, 7.6 + i * 0.95, 0.28 + i * 0.28, -0.42, 0.12);
  }

  // Grass tufts + meadow flowers
  const r = makeRng(808);
  const tuft = fernGeo(7, 0.34, 7, 0.07, 0.35);
  for (let i = 0; i < 420; i++) {
    const x = -11.5 + r() * 23;
    const z = -28.6 + r() * 14;
    if (Math.abs(x) < 2.9 || (Math.hypot(x, z + 24.4) < 5.7) || (z > -21.9 && z < -19.1 && Math.abs(x) < 7.4) || (x > 8.3 && z > -19.8)) continue;
    k.put(tuft, r() > 0.5 ? M.leaf : M.leafLime, x, 0, z, 0, r() * 6, 0, 0.6 + r() * 0.7);
  }
  for (let i = 0; i < 46; i++) {
    const s = i % 2 ? 1 : -1;
    flowerClump(c, k, s * (3.2 + r() * 0.5), 0, -15 - r() * 4, 6, 0.6, 900 + i);
  }
  for (let i = 0; i < 26; i++) {
    const x = (i % 2 ? 1 : -1) * (6.3 + r() * 5);
    flowerClump(c, k, x, 0, -22.2 - r() * 5.4, 7, 0.8, 960 + i);
  }
  for (const [x, z, h] of [[-10.9, -27.0, 4.8], [10.9, -27.0, 4.8], [-10.9, -15.0, 3.6]] as const) {
    k.cyl(M.trimStone, 0.6, 0.5, 0.5, x, 0, z, 8);
    k.put(cypressGeo(h, 0.6), M.cypress, x, 0.4, z);
  }
  for (const [x, z] of [[-6.2, -23.2], [6.6, -23.4], [-3.3, -17.6], [3.3, -17.6]] as const) lampPost(c, k, x, z);
  c.light(0, 3.4, -17, 0xffe0b0, 14, 11);

  // Resonance stones
  for (const col of ['azure', 'amber', 'violet', 'emerald'] as const) {
    floorPlate(c, `terrace_${col}`, new THREE.Color(HARP_HEX[col]).getHex(), (f) => f.p.terracePadOccupied[col].length > 0 || f.state.solvedPuzzles.p12_wind_harp, 0.75);
  }
  floorPlate(c, 'finale_pad_left', 0xffd24a, (f) => f.p.finalePadLeftBy.length > 0, 0.5);
  floorPlate(c, 'finale_pad_right', 0xffd24a, (f) => f.p.finalePadRightBy.length > 0, 0.5);

  // --- Wind Spire ---
  const wx = 9.6;
  const wz = -22.4;
  k.cyl(M.trimStone, 0.95, 1.1, 0.3, wx, 0, wz, 8);
  k.put(lathe([[0.01, 0], [0.6, 0], [0.5, 0.2], [0.34, 0.5], [0.26, 2.2], [0.16, 3.6], [0.06, 5.0], [0.01, 5.0]], 24), M.marble, wx, 0.3, wz);
  for (const [y, rr] of [[1.2, 0.36], [2.4, 0.3], [3.6, 0.22]] as const) k.torus(M.brass, rr, 0.035, wx, y, wz, Math.PI / 2);
  const spinner = group(scene, wx, 5.3, wz, 0, (g) => {
    g.cyl(M.brass, 0.04, 0.05, 1.3, 0, -0.3, 0, 8);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      g.rod(M.brass, 0.022, [0, 0.5, 0], [Math.cos(a) * 0.85, 0.5, Math.sin(a) * 0.85]);
      g.put(new THREE.SphereGeometry(0.19, 14, 8, 0, Math.PI), M.copper, Math.cos(a) * 0.85, 0.5, Math.sin(a) * 0.85, 0, -a + Math.PI / 2);
    }
    g.sph(M.brass, 0.1, 0, 1.05, 0);
  });
  const spireMat = M.glow(0x2fe0c8, 0.2);
  group(scene, wx, 0, wz, 0, (g) => {
    for (let i = 0; i < 4; i++) g.torus(spireMat, 0.31 - i * 0.045, 0.02, 0, 1.7 + i * 0.75, 0, Math.PI / 2 + 0.2);
  });
  let spin = 0.8;
  c.ambient.push((_t, dt) => (spinner.rotation.y += dt * spin));
  c.updaters.push((f) => {
    const s = f.state.solvedPuzzles.p12_wind_harp;
    spin = damp(spin, 0.8 + f.p.windHarpStep * 1.2 + (s ? 4 : 0), 1, f.dt);
    spireMat.emissiveIntensity = damp(spireMat.emissiveIntensity, s ? 2.2 : 0.2 + f.p.windHarpStep * 0.3, 2, f.dt);
  });
  const windPlate = group(scene, wx - 0.75, 1.0, wz + 0.45, -1.0, (g) => {
    g.box(M.brass, 0.66, 0.5, 0.05, 0, -0.25, 0);
    g.panel(paintedMat(makePlaqueTexture('WIND CORE', 'Turn the WIND Resonance Pedestal toward the evening breeze: WEST (W).', { style: 'brass', w: 512, h: 384 }), 0.4), 0.6, 0.45, 0, 0, 0.03);
    g.rod(M.brass, 0.03, [0, -0.25, -0.02], [0, -0.95, -0.02]);
  });
  c.updaters.push((f) => (windPlate.visible = f.state.solvedPuzzles.p12_wind_harp));
  c.reg({ id: 'clue_core_wind_cardinal', label: clueLabel('clue_core_wind_cardinal'), actionType: 'clue', clueId: 'clue_core_wind_cardinal', enabled: (s) => s.solvedPuzzles.p12_wind_harp }, wx - 0.75, 0.95, wz + 0.45, 0.8, 0.7, 0.5, -1.0);
  pedestal(c, k, 8.0, -23.6, 0.95);

  buildGate(c, k);
}

function buildGate(c: Ctx, k: Kit): void {
  const { M, scene } = c;
  // Frame: a towering stepped arch with a brass sun-ring
  for (const s of [-1, 1]) {
    k.box(M.trimStone, 1.2, 0.5, 1.5, s * 4.9, 0, GATE_Z + 0.1);
    k.box(M.marble, 0.9, 5.6, 1.1, s * 4.9, 0.5, GATE_Z + 0.1);
    k.box(M.trimStone, 1.2, 0.4, 1.4, s * 4.9, 6.1, GATE_Z + 0.1);
    k.put(lathe([[0.01, 0], [0.4, 0], [0.5, 0.3], [0.3, 0.6], [0.12, 1.1], [0.01, 1.6]], 20), M.brass, s * 4.9, 6.5, GATE_Z + 0.1);
    for (let i = 0; i < 3; i++) k.torus(M.brass, 0.2, 0.03, s * 4.9, 1.8 + i * 1.4, GATE_Z + 0.68);
  }
  const plate = new THREE.Shape();
  plate.absellipse(0, 0, 4.5, 4.5, 0, TAU, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, IRIS_R, 0, TAU, true);
  plate.holes.push(hole);
  const pg = new THREE.ExtrudeGeometry(plate, { depth: 0.22, bevelEnabled: false, curveSegments: 72 });
  k.put(pg, M.trimStone, 0, GATE_Y, GATE_Z + 0.36);
  k.put(pg, M.trimStone, 0, GATE_Y, GATE_Z - 0.58);
  k.put(new THREE.CylinderGeometry(4.5, 4.5, 1.0, 72, 1, true), M.trimStone, 0, GATE_Y, GATE_Z, Math.PI / 2);
  for (const [r, t, m] of [[IRIS_R + 0.03, 0.1, M.brass], [3.5, 0.06, M.copper], [4.4, 0.13, M.brass]] as const) k.torus(m, r, t, 0, GATE_Y, GATE_Z + 0.6, 0, 0, 0, 96);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    if (GATE_Y + Math.sin(a) * 4.8 < 0.3) continue;
    k.put(new THREE.ConeGeometry(i % 2 ? 0.16 : 0.24, i % 2 ? 0.7 : 1.15, 4), M.brass, Math.cos(a) * (i % 2 ? 4.8 : 4.95), GATE_Y + Math.sin(a) * (i % 2 ? 4.8 : 4.95), GATE_Z, 0, 0, a - Math.PI / 2);
  }
  // Runic studs light as cores are seated
  const studMats = (['sun', 'gear', 'star', 'wind'] as const).map((kind) => M.glow(CORE_COLORS[kind], 0.15));
  const ringSpin = group(scene, 0, GATE_Y, GATE_Z + 0.62, 0);
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * TAU;
    group(ringSpin, Math.cos(a) * 3.95, Math.sin(a) * 3.95, 0, 0, (g) => {
      g.sph(studMats[i % 4], 0.12, 0, 0, 0, 1, 1, 0.5, 12);
      g.torus(M.brass, 0.14, 0.025);
    });
  }
  const innerGear = group(scene, 0, GATE_Y, GATE_Z + 0.5, 0, (g) => {
    const sh = new THREE.Shape();
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      for (const [da, rr] of [[-0.06, 3.28], [-0.03, 3.42], [0.03, 3.42], [0.06, 3.28]] as const) {
        const x = Math.cos(a + da) * rr;
        const y = Math.sin(a + da) * rr;
        if (i === 0 && da === -0.06) sh.moveTo(x, y);
        else sh.lineTo(x, y);
      }
    }
    sh.closePath();
    const h = new THREE.Path();
    h.absarc(0, 0, 2.8, 0, TAU, true);
    sh.holes.push(h);
    g.put(new THREE.ExtrudeGeometry(sh, { depth: 0.12, bevelEnabled: false }), M.brassDark);
  });

  // Iris blades
  const N = 16;
  const P = 3.02;
  const half = TAU / N;
  const blade = new THREE.Shape();
  blade.moveTo(0.1, -0.12);
  blade.lineTo(-P - 0.12, -0.06);
  blade.quadraticCurveTo(-P * 0.75, 0.42, -P + 2.0 * Math.cos(half) + 0.05, 2.0 * Math.sin(half) + 0.32);
  blade.quadraticCurveTo(-0.35, 1.2, 0.02, 0.9);
  blade.quadraticCurveTo(0.2, 0.3, 0.1, -0.12);
  const bg = new THREE.ExtrudeGeometry(blade, { depth: 0.022, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.008, bevelSegments: 1, curveSegments: 10 });
  const bladeMats = [M.brass, M.copper];
  const blades = Array.from({ length: N }, (_, i) => {
    const a = (i / N) * TAU;
    const pivot = group(scene, Math.cos(a) * P, GATE_Y + Math.sin(a) * P, GATE_Z - 0.14 + (i % 4) * 0.045 + i * 0.004, 0);
    pivot.rotation.order = 'XYZ';
    const m = new THREE.Mesh(bg, bladeMats[i % 2]);
    m.castShadow = true;
    m.receiveShadow = true;
    pivot.add(m);
    return { pivot, a };
  });
  const bossMat = M.glow(0xffd257, 0.4);
  const boss = group(scene, 0, GATE_Y, GATE_Z + 0.16, 0, (g) => {
    g.put(new THREE.CylinderGeometry(0.62, 0.72, 0.16, 40), M.brass, 0, 0, 0, Math.PI / 2);
    g.put(new THREE.ExtrudeGeometry(starShape(16, 0.56, 0.36), { depth: 0.06, bevelEnabled: false }), bossMat, 0, 0, 0.07);
    g.sph(M.brass, 0.2, 0, 0, 0.12, 1, 1, 0.6);
  });
  // Light beyond
  const portalMat = new THREE.MeshBasicMaterial({ map: M.T.portal, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false });
  const portal = noRay(new THREE.Mesh(new THREE.CircleGeometry(2.9, 48), portalMat));
  portal.position.set(0, GATE_Y, GATE_Z - 0.72);
  scene.add(portal);
  const burst = glowSprite(M, 0xffdf90, 12, 0);
  burst.position.set(0, GATE_Y, GATE_Z - 1.2);
  scene.add(burst);
  const gateLight = c.light(0, 3.2, -26.3, 0xffcf80, 20, 13);
  const k2 = c.B.kit('beyond');
  k2.floor(M.flag, -2.6, 2.6, -37, -28.4, -0.02);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      lampPost(c, k2, s * 3, -30 - i * 2.6, -0.05);
      flowerClump(c, k2, s * 3, -0.05, -31.2 - i * 2.6, 14, 1.2, 70 + i + s);
    }
  }
  k2.cyl(M.trimStone, 3.4, 3.6, 0.2, 0, -0.1, -38.5, 32);
  let open = 0;
  c.updaters.push((f) => {
    const isOpen = f.state.doors.solstice_gate;
    open = damp(open, isOpen ? 1 : 0, 0.8, f.dt);
    const e = smooth(0, 1, open);
    for (const { pivot, a } of blades) pivot.rotation.z = a - e * (Math.PI / 2 + 0.04);
    ringSpin.rotation.z = f.t * 0.04 + e * 2.5;
    innerGear.rotation.z = -f.t * 0.03 - e * 3.5;
    boss.scale.setScalar(Math.max(0.001, 1 - smooth(0, 0.35, open)));
    boss.rotation.z = e * 4 + Math.sin(f.t * 0.5) * 0.08;
    boss.visible = open < 0.36;
    portalMat.opacity = smooth(0.15, 0.9, open) * (0.4 + Math.sin(f.t * 2) * 0.05);
    portal.rotation.z = f.t * 0.25;
    (burst.material as THREE.SpriteMaterial).opacity = smooth(0.1, 0.8, open) * 0.3;
    const cores = f.p.gateCoresInserted;
    (['sun', 'gear', 'star', 'wind'] as const).forEach((kind, i) => {
      studMats[i].emissiveIntensity = damp(studMats[i].emissiveIntensity, cores[kind] ? 2.2 + Math.sin(f.t * 3 + i) * 0.4 : 0.15, 4, f.dt);
    });
    const n = Object.values(cores).filter(Boolean).length;
    bossMat.emissiveIntensity = 0.3 + n * 0.4;
    gateLight.gain = 0.3 + n * 0.2 + e * 1.5;
  });

  // --- Core pedestals ---
  const defs: ['sun' | 'gear' | 'star' | 'wind', number][] = [
    ['sun', -5.4],
    ['gear', -1.5],
    ['star', 1.5],
    ['wind', 5.4],
  ];
  const DIR: Record<CardinalDir, number> = { N: 0, E: 1, S: 2, W: 3 };
  for (const [kind, x] of defs) {
    const z = Math.abs(x) < 2 ? -26.35 : -25.8;
    const hex = CORE_COLORS[kind];
    pedestal(c, k, x, z, 0.95, 0, 0.34);
    k.disc(paintedMat(M.T.compassDial, 0.3), 0.385, x, 0.958, z, 40);
    k.torus(M.brass, 0.39, 0.03, x, 0.96, z, Math.PI / 2);
    plaque(c, k, makePlaqueTexture(kind.toUpperCase(), '', { style: 'brass', w: 256, h: 96 }), 0.36, 0.13, x, 0.5, z + 0.25, 0, 0, M.brassDark, 0.4);
    const ptrMat = M.glow(hex, 0.8);
    const ptr = group(scene, x, 0.985, z, 0, (g) => {
      g.put(new THREE.ConeGeometry(0.06, 0.26, 4), ptrMat, 0, 0.01, -0.2, -Math.PI / 2, 0, 0, 1, 1, 0.5);
      g.torus(M.brass, 0.14, 0.02, 0, 0.01, 0, Math.PI / 2);
    });
    const core = group(scene, x, 1.45, z, 0);
    const coreMesh = makeItemMesh(M, `core_${kind}` as ItemId);
    core.add(coreMesh);
    core.add(glowSprite(M, hex, 1.5, 0.6));
    const socket = M.glow(hex, 0.15);
    group(scene, x, 1.0, z, 0, (g) => g.torus(socket, 0.1, 0.022, 0, 0, 0, Math.PI / 2));
    c.updaters.push((f) => {
      const on = f.p.gateCoresInserted[kind];
      core.visible = on;
      coreMesh.rotation.y = f.t * 0.9;
      core.position.y = 1.45 + Math.sin(f.t * 1.8 + x) * 0.05;
      ptr.rotation.y = dampAngle(ptr.rotation.y, -DIR[f.p.gateDials[kind]] * (Math.PI / 2), 6, f.dt);
      socket.emissiveIntensity = on ? 2 : 0.2 + Math.sin(f.t * 2.4 + x) * 0.12;
    });
    const nm = kind[0].toUpperCase() + kind.slice(1);
    c.reg(
      {
        id: `p13_pedestal_${kind}`,
        label: `Use the ${nm} Core Pedestal`,
        actionType: 'modal',
        modalId: 'p13_solstice_gate',
        getLabel: (s) =>
          s.puzzles.gateCoresInserted[kind]
            ? `${nm} Core Pedestal (facing ${s.puzzles.gateDials[kind]})`
            : `${nm} Core Pedestal (empty socket)`,
      },
      x,
      0.9,
      z,
      0.95,
      1.8,
      0.95,
    );
  }
}

// ============================================================
// DOORS
// ============================================================
function buildDoors(c: Ctx): void {
  const { M, scene } = c;
  const leaf = (k: Kit, w: number, h: number, dirX: 1 | -1, wood: THREE.Material): void => {
    const cx = (dirX * w) / 2;
    k.box(wood, w - 0.02, h - 0.02, 0.1, cx, 0.01, 0);
    for (const zz of [-0.06, 0.06]) {
      const n = Math.round(h / 1.3);
      for (let i = 0; i < n; i++) k.box(M.walnut, w - 0.4, h / n - 0.25, 0.03, cx, (i * h) / n + 0.14, zz);
      k.box(M.brass, w - 0.06, 0.06, 0.02, cx, 0.02, zz);
      k.box(M.brass, w - 0.06, 0.06, 0.02, cx, h - 0.1, zz);
      k.box(M.brass, 0.1, 0.5, 0.025, dirX * (w - 0.18), 0.95, zz);
      k.sph(M.brass, 0.065, dirX * (w - 0.18), 1.2, zz * 1.9);
    }
    for (let i = 0; i < 3; i++) k.cyl(M.brass, 0.05, 0.05, 0.24, 0, 0.4 + (i * (h - 1)) / 2, 0, 8);
  };

  // Courtyard double doors — swing out to the north, flat against the facade
  const cyL = group(scene, -2, 0, 5.62, 0, (k) => {
    leaf(k, 2, 4, 1, M.walnutRed);
    k.torus(M.brass, 0.62, 0.04, 1.99, 2.55, 0.08, 0, 0, Math.PI / 2, 24, Math.PI);
    for (let i = 0; i < 5; i++) {
      const a = Math.PI / 2 + ((i + 0.5) / 5) * Math.PI;
      k.rod(M.brass, 0.02, [1.97 + Math.cos(a) * 0.25, 2.55 + Math.sin(a) * 0.25, 0.08], [1.97 + Math.cos(a) * 0.58, 2.55 + Math.sin(a) * 0.58, 0.08]);
    }
  });
  const cyR = group(scene, 2, 0, 5.62, 0, (k) => {
    leaf(k, 2, 4, -1, M.walnutRed);
    k.torus(M.brass, 0.62, 0.04, -1.99, 2.55, 0.08, 0, 0, -Math.PI / 2, 24, Math.PI);
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + ((i + 0.5) / 5) * Math.PI;
      k.rod(M.brass, 0.02, [-1.97 + Math.cos(a) * 0.25, 2.55 + Math.sin(a) * 0.25, 0.08], [-1.97 + Math.cos(a) * 0.58, 2.55 + Math.sin(a) * 0.58, 0.08]);
    }
  });
  // Study double doors — swing west, flat against the study side
  const stN = group(scene, -8.42, 0, 10.5, 0, (k) => leaf(k, 1.5, 3.6, 1, M.walnutRed));
  const stS = group(scene, -8.42, 0, 13.5, 0, (k) => leaf(k, 1.5, 3.6, 1, M.walnutRed));
  // Tea grille — slides south inside the wall
  const grille = group(scene, 8, 0, 8.5, 0, (k) => {
    for (let i = 0; i <= 12; i++) k.cyl(M.brass, 0.022, 0.022, 3.55, 0, 0.02, -1.26 + i * 0.21, 8);
    for (const y of [0.05, 1.2, 2.35, 3.5]) k.box(M.brass, 0.06, 0.07, 2.6, 0, y, 0);
    for (let i = 0; i < 6; i++) k.torus(M.copper, 0.1, 0.015, 0, 1.8, -1.05 + i * 0.42, 0, Math.PI / 2);
  });
  // Conservatory & workshop sliding doors
  const slab = (x: number, sgn: number, kind: 'glass' | 'gear'): THREE.Group =>
    group(scene, x, 0, -6 + sgn * 0.75, 0, (k) => {
      const frame = kind === 'glass' ? M.iron : M.darkIron;
      for (const s of [-1, 1]) k.box(frame, 0.12, 3.78, 0.12, 0, 0.01, s * 0.69);
      for (const y of [0.01, 1.1, 2.4, 3.67]) k.box(frame, 0.12, 0.12, 1.5, 0, y, 0);
      if (kind === 'glass') {
        k.box(M.verdigris, 0.08, 1.0, 1.3, 0, 0.1, 0);
        const g = new THREE.PlaneGeometry(1.3, 2.6);
        k.put(g, M.glassIron, 0, 2.4, 0, 0, Math.PI / 2);
        k.torus(M.brass, 0.5, 0.025, 0, 2.4, 0, 0, Math.PI / 2);
        for (const xx of [-0.07, 0.07]) k.put(fernGeo(8, 0.34, 5, 0.2, 0.5), M.leafLime, xx, 0.3, 0, 0, 0, 0, 0.4, 1.6, 1.2);
      } else {
        k.box(M.walnutRed, 0.09, 3.6, 1.36, 0, 0.1, 0);
        for (const xx of [-0.08, 0.08]) {
          k.put(gearGeo(18, 0.55, 0.05, 0.25, 5), M.brass, xx, 2.05, sgn * -0.05, 0, Math.PI / 2);
          k.put(gearGeo(12, 0.3, 0.05, 0.25, 0), M.copper, xx, 1.2, sgn * 0.3, 0, Math.PI / 2);
          for (let i = 0; i < 6; i++) k.sph(M.brass, 0.04, xx, 0.3 + i * 0.62, 0.62, 1, 1, 1, 8);
        }
      }
      for (const xx of [-0.1, 0.1]) k.box(M.brass, 0.06, 0.6, 0.06, xx, 1.2, -sgn * 0.58);
    });
  const consN = slab(-12, -1, 'glass');
  const consS = slab(-12, 1, 'glass');
  const wsN = slab(12, -1, 'gear');
  const wsS = slab(12, 1, 'gear');
  // Sky-Lift accordion gate
  const scissor = (x: number, dir: 1 | -1): THREE.Group =>
    group(scene, x, 0, -10.35, 0, (k) => {
      const w = 1.5;
      const n = 5;
      for (let i = 0; i <= n; i++) k.box(M.brassDark, 0.05, 3.1, 0.06, (dir * (i * w)) / n, 0.03, 0);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < 4; j++) {
          const xa = (dir * i * w) / n;
          const xb = (dir * (i + 1) * w) / n;
          k.rod(M.brass, 0.018, [xa, 0.15 + j * 0.74, 0.03], [xb, 0.75 + j * 0.74, 0.03], 6);
          k.rod(M.brass, 0.018, [xa, 0.75 + j * 0.74, -0.03], [xb, 0.15 + j * 0.74, -0.03], 6);
        }
      }
    });
  const slL = scissor(8.75, 1);
  const slR = scissor(11.75, -1);
  // Keyhole escutcheons
  const lockGlow = M.glow(0xffc860, 0.6);
  const locks: Partial<Record<DoorId, THREE.Object3D>> = {
    study_door: group(scene, -7.62, 1.2, 12, Math.PI / 2, (k) => {
      k.put(new THREE.CylinderGeometry(0.16, 0.16, 0.06, 24), M.brass, 0, 0, -0.7, Math.PI / 2);
      k.sph(lockGlow, 0.05, 0, 0, -0.66, 1, 1.4, 0.4, 10);
    }),
    conservatory_door: group(scene, -11.86, 1.25, -6, Math.PI / 2, (k) => {
      k.put(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 24), M.brass, 0, 0, 0, Math.PI / 2);
      k.sph(M.glow(0x39e07f, 1), 0.06, 0, 0, 0.05, 1, 1.4, 0.4, 10);
    }),
    skylift_door: group(scene, 10.25, 1.3, -10.28, 0, (k) => {
      k.put(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 6), M.copper, 0, 0, 0, Math.PI / 2);
      k.sph(lockGlow, 0.06, 0, 0, 0.06, 1, 1.4, 0.4, 10);
    }),
  };

  const amt: Record<DoorId, number> = {
    courtyard_door: 0,
    tea_north_grille: 0,
    study_door: 0,
    conservatory_door: 0,
    workshop_door: 0,
    skylift_door: 0,
    solstice_gate: 0,
  };
  const pose = (): void => {
    const e = (d: DoorId): number => smooth(0, 1, amt[d]);
    cyL.rotation.y = e('courtyard_door') * 3.02;
    cyR.rotation.y = -e('courtyard_door') * 3.02;
    stN.rotation.y = -Math.PI / 2 - e('study_door') * 3.02;
    stS.rotation.y = Math.PI / 2 + e('study_door') * 3.02;
    grille.position.z = 8.5 + e('tea_north_grille') * 2.62;
    const co = e('conservatory_door') * 1.47;
    consN.position.z = -6.75 - co;
    consS.position.z = -5.25 + co;
    const ws = e('workshop_door') * 1.47;
    wsN.position.z = -6.75 - ws;
    wsS.position.z = -5.25 + ws;
    const sl = 1 - e('skylift_door') * 0.92;
    slL.scale.x = sl;
    slR.scale.x = sl;
  };
  pose();
  c.updaters.push((f) => {
    for (const id of Object.keys(amt) as DoorId[]) {
      const tgt = f.state.doors[id] ? 1 : 0;
      const sp = id === 'tea_north_grille' ? 1.5 : 0.6;
      amt[id] += Math.max(-f.dt * sp, Math.min(f.dt * sp, tgt - amt[id]));
    }
    pose();
    for (const id of Object.keys(locks) as DoorId[]) {
      const o = locks[id];
      if (o) o.visible = amt[id] < 0.02;
    }
    lockGlow.emissiveIntensity = 0.8 + Math.sin(f.t * 2.5) * 0.4;
  });

  const defs: [DoorId, string, number, number, number, number, number, number][] = [
    ['courtyard_door', 'Courtyard Doors', 0, 2, 5.9, 4, 4, 0.7],
    ['tea_north_grille', 'North Booth Grille', 8, 1.8, 8.5, 0.6, 3.6, 2.6],
    ['study_door', 'Study Doors', -8, 1.8, 12, 0.8, 3.6, 3],
    ['conservatory_door', 'Conservatory Doors', -12, 1.5, -6, 0.6, 3.0, 3],
    ['workshop_door', 'Workshop Doors', 12, 1.9, -6, 0.6, 3.8, 3],
    ['skylift_door', 'Sky-Lift Gate', 10.25, 1.6, -10.35, 3.1, 3.2, 0.5],
    ['solstice_gate', 'Grand Solstice Gate', 0, 2.7, GATE_Z, 5.2, 5.2, 0.6],
  ];
  const needs: Partial<Record<DoorId, string>> = {
    courtyard_door: 'sealed by the clock and twin levers',
    tea_north_grille: 'held by the brass floor plate in the Foyer',
    workshop_door: 'sealed by the courtyard sundial',
    solstice_gate: 'awaiting four aligned cores and both pads',
  };
  for (const [id, name, x, y, z, w, h, d] of defs) {
    c.reg(
      {
        id: `door_${id}`,
        label: name,
        actionType: 'door',
        doorId: id,
        maxDistance: id === 'solstice_gate' ? 4.5 : 3.6,
        enabled: (s) => !s.doors[id],
        getLabel: (s) => {
          const key = DOOR_KEY_REQUIREMENTS[id];
          if (!key) return `${name}: ${needs[id] ?? 'sealed'}`;
          return s.inventory.includes(key)
            ? `Unlock the ${name} with the ${ITEMS[key].name}`
            : `${name}: locked, needs the ${ITEMS[key].name}`;
        },
      },
      x,
      y,
      z,
      w,
      h,
      d,
    );
  }
}

// ============================================================
// FLOATING PICKUPS
// ============================================================
function buildPickups(c: Ctx): void {
  const { M, scene } = c;
  const Y = OBSERVATORY_DECK.y;
  const defs: [ItemId, number, number, number, (s: WorldState) => boolean][] = [
    ['key_study', -5.9, 1.42, 9.2, (s) => s.solvedPuzzles.p1_twin_levers],
    ['tool_uv_lamp', 11.6, 1.45, 17.25, (s) => s.solvedPuzzles.p2_tea_cipher],
    ['key_conservatory', -19.0, 1.4, 7.28, (s) => s.solvedPuzzles.p4_uv_safe],
    ['tool_prism', -19.0, 1.4, 7.98, (s) => s.solvedPuzzles.p4_uv_safe],
    ['item_gear_18t', -14, 1.35, 16.35, (s) => s.solvedPuzzles.p5_pipe_organ],
    ['core_sun', -15.95, 1.0, -6, (s) => s.solvedPuzzles.p7_light_relay && s.solvedPuzzles.p8_irrigation],
    ['key_skylift', 19.3, 1.4, 0.75, (s) => s.solvedPuzzles.p9_gear_train],
    ['core_gear', 19.6, 1.55, -6, (s) => s.solvedPuzzles.p10_foundry_sync],
    ['core_star', 2.9, Y + 1.45, -14.5, (s) => s.solvedPuzzles.p11_orrery],
    ['core_wind', 8.0, 1.42, -23.6, (s) => s.solvedPuzzles.p12_wind_harp],
  ];
  defs.forEach(([id, x, y, z, ready], i) => {
    const root = group(scene, x, y, z, 0);
    const mesh = makeItemMesh(M, id);
    mesh.scale.setScalar(id.startsWith('core') ? 1.15 : id === 'key_conservatory' || id === 'tool_prism' ? 0.8 : 1);
    root.add(mesh);
    const halo = glowSprite(M, ITEM_GLOW[id], 1.5, 0.55);
    root.add(halo);
    const ringMat = new THREE.MeshBasicMaterial({ color: ITEM_GLOW[id], transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    const ring = noRay(new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.012, 8, 40), ringMat));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.3;
    root.add(ring);
    root.visible = false;
    let pop = 0;
    const avail = (s: WorldState): boolean => ready(s) && !s.collectedWorldItems.includes(id);
    c.updaters.push((f) => {
      const on = avail(f.state);
      pop = damp(pop, on ? 1 : 0, on ? 3 : 10, f.dt);
      root.visible = pop > 0.02;
      if (!root.visible) return;
      root.scale.setScalar(pop);
      root.position.y = y + Math.sin(f.t * 1.8 + i) * 0.06;
      mesh.rotation.y = f.t * 0.9 + i;
      (halo.material as THREE.SpriteMaterial).opacity = 0.45 + Math.sin(f.t * 3 + i) * 0.14;
      ring.scale.setScalar(1 + (f.t * 0.6 + i * 0.3) % 1 * 0.7);
      ringMat.opacity = 0.6 * (1 - ((f.t * 0.6 + i * 0.3) % 1));
    });
    c.reg(
      {
        id: `pickup_${id}`,
        label: `Take the ${ITEMS[id].name}`,
        actionType: 'pickup',
        itemId: id,
        maxDistance: 3.8,
        enabled: avail,
      },
      x,
      y,
      z,
      id === 'key_conservatory' || id === 'tool_prism' ? 0.5 : 0.8,
      0.85,
      0.8,
    );
  });
}

// ============================================================
// PARTNER AVATAR
// ============================================================
// PlayerController uses the three.js camera convention: forward = (-sin yaw, -cos yaw).
// The avatar is modelled facing +Z, hence the half-turn.
const AVATAR_YAW_OFFSET = Math.PI;

interface Avatar {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  legs: THREE.Group[];
  arms: THREE.Group[];
  hand: THREE.Group;
  heldId: ItemId | null;
  name: string;
  nameSprite: THREE.Sprite;
  cone: THREE.Mesh;
  coneMat: THREE.MeshBasicMaterial;
  gait: number;
  stride: number;
  fresh: boolean;
}

function buildAvatar(c: Ctx, info: PlayerInfo): Avatar {
  const { M, scene } = c;
  const accent = M.std({ color: new THREE.Color(info.color), roughness: 0.7, emissive: new THREE.Color(info.color), emissiveIntensity: 0.12 });
  const coat = M.std({ color: info.slot === 1 ? 0x8a4a2c : 0x2d6270, roughness: 0.85 });
  const coatDark = M.std({ color: info.slot === 1 ? 0x653219 : 0x1f4650, roughness: 0.9 });
  const skin = M.std({ color: 0xf0d3b4, roughness: 0.65 });
  const boots = M.std({ color: 0x4a2f20, roughness: 0.7 });
  const trousers = M.std({ color: 0x5c4a3c, roughness: 0.9 });

  const root = group(scene, info.transform.x, info.transform.y, info.transform.z, info.transform.yaw + AVATAR_YAW_OFFSET);
  const body = group(root, 0, 0, 0, 0, (k) => {
    k.put(lathe([[0.01, 0.62], [0.36, 0.62], [0.34, 0.7], [0.24, 0.98], [0.23, 1.06], [0.28, 1.3], [0.25, 1.42], [0.12, 1.48], [0.01, 1.48]], 22), coat, 0, 0, 0, 0, 0, 0, 1, 1, 0.78);
    k.torus(M.brass, 0.235, 0.03, 0, 1.02, 0, Math.PI / 2);
    k.put(gearGeo(10, 0.07, 0.03, 0.4, 0), M.brass, 0, 1.02, 0.2);
    k.torus(accent, 0.14, 0.055, 0, 1.46, 0, Math.PI / 2);
    k.box(accent, 0.11, 0.34, 0.035, 0.09, 1.1, 0.215, 0, 0.1, 0.1);
    for (let i = 0; i < 3; i++) k.sph(M.brass, 0.018, -0.06, 1.14 + i * 0.08, 0.21, 1, 1, 1, 8);
    for (const s of [-1, 1]) k.box(coatDark, 0.11, 0.26, 0.03, s * 0.12, 1.16, 0.2, 0, 0.06, s * 0.2);
    // Clockwork key winding in the back
    k.cyl(M.brass, 0.1, 0.1, 0.05, 0, 1.2, -0.22, 16);
  });
  const wind = group(body, 0, 1.22, -0.3, 0, (k) => {
    k.put(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), M.brass, 0, 0, 0.02, Math.PI / 2);
    k.torus(M.brass, 0.07, 0.02, -0.08, 0, -0.06);
    k.torus(M.brass, 0.07, 0.02, 0.08, 0, -0.06);
  });
  c.ambient.push((t) => (wind.rotation.z = t * 1.4));
  const head = group(root, 0, 1.6, 0, 0, (k) => {
    k.sph(skin, 0.17, 0, 0.06, 0, 1, 1.12, 1);
    k.sph(skin, 0.03, 0, 0.04, 0.175, 1, 1, 1, 10);
    // goggles
    k.torus(M.brassDark, 0.172, 0.02, 0, 0.1, 0, Math.PI / 2);
    for (const s of [-1, 1]) {
      k.put(new THREE.CylinderGeometry(0.062, 0.062, 0.05, 20), M.brass, s * 0.07, 0.1, 0.16, Math.PI / 2);
      k.put(new THREE.CylinderGeometry(0.048, 0.048, 0.055, 20), M.glow(0x8fe8ff, 0.5), s * 0.07, 0.1, 0.162, Math.PI / 2);
    }
    // cap
    k.put(new THREE.SphereGeometry(0.195, 20, 10, 0, TAU, 0, Math.PI / 2), coatDark, 0, 0.13, -0.01, 0, 0, 0, 1, 0.85, 1.05);
    k.put(new THREE.CylinderGeometry(0.17, 0.2, 0.025, 20), coat, 0, 0.14, 0.09, 0.14, 0, 0, 1, 1, 0.9);
    k.put(gearGeo(10, 0.06, 0.025, 0.4, 0), M.brass, 0.14, 0.2, 0.1, 0, 0.9);
    k.torus(accent, 0.196, 0.018, 0, 0.155, -0.01, Math.PI / 2);
    k.box(M.bark, 0.07, 0.012, 0.01, 0, -0.035, 0.165);
  });
  const legs = [-1, 1].map((s) =>
    group(root, s * 0.11, 0.72, 0, 0, (k) => {
      k.cyl(trousers, 0.085, 0.07, 0.4, 0, -0.42, 0, 12);
      k.cyl(boots, 0.085, 0.08, 0.28, 0, -0.68, 0, 12);
      k.box(boots, 0.14, 0.09, 0.26, 0, -0.72, 0.05);
      k.torus(M.brass, 0.085, 0.014, 0, -0.42, 0, Math.PI / 2);
    }),
  );
  const arms = [-1, 1].map((s) =>
    group(root, s * 0.29, 1.38, 0, 0, (k) => {
      k.sph(coat, 0.095, 0, 0, 0);
      k.cyl(coat, 0.075, 0.06, 0.3, 0, -0.31, 0, 12);
      k.sph(M.brass, 0.065, 0, -0.32, 0, 1, 1, 1, 12);
      k.cyl(M.brassDark, 0.05, 0.045, 0.24, 0, -0.56, 0, 12);
      k.torus(M.brass, 0.055, 0.014, 0, -0.4, 0, Math.PI / 2);
      k.sph(s < 0 ? skin : M.copper, 0.06, 0, -0.6, 0, 1, 1, 1, 12);
    }),
  );
  // Facing +Z, the character's right hand is on -X.
  const hand = group(arms[0], 0, -0.64, 0.08, 0);
  hand.rotation.x = Math.PI / 2;
  hand.scale.setScalar(0.75);

  const coneGeo = new THREE.ConeGeometry(1.35, 4.2, 28, 1, true);
  coneGeo.translate(0, -2.1, 0);
  coneGeo.rotateX(-Math.PI / 2);
  const coneMat = new THREE.MeshBasicMaterial({ color: 0x8a5cff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const cone = noRay(new THREE.Mesh(coneGeo, coneMat));
  cone.position.set(-0.25, -0.2, 0.3);
  head.add(cone);

  const nameSprite = noRay(new THREE.Sprite(new THREE.SpriteMaterial({ map: makeNameTexture(info.name, info.color), transparent: true, depthWrite: false, fog: false })));
  nameSprite.scale.set(1.3, 0.325, 1);
  nameSprite.position.y = 2.2;
  root.add(nameSprite);
  const bob = glowSprite(M, new THREE.Color(info.color).getHex(), 0.5, 0.6);
  bob.position.y = 2.45;
  root.add(bob);
  return { root, body, head, legs, arms, hand, heldId: null, name: info.name, nameSprite, cone, coneMat, gait: 0, stride: 0, fresh: true };
}

function buildAvatars(c: Ctx, partnerUv: THREE.SpotLight): void {
  const avatars = new Map<string, Avatar>();
  const dir = new THREE.Vector3();
  c.updaters.push((f) => {
    let uvI = 0;
    for (const info of Object.values(f.state.players)) {
      if (info.id === f.myId) continue;
      let av = avatars.get(info.id);
      if (!av) {
        av = buildAvatar(c, info);
        avatars.set(info.id, av);
      }
      av.root.visible = info.connected;
      if (!info.connected) {
        av.fresh = true;
        continue;
      }
      const t = info.transform;
      const p = av.root.position;
      const jump = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
      if (av.fresh || jump > 5) {
        p.set(t.x, t.y, t.z);
        av.root.rotation.y = t.yaw + AVATAR_YAW_OFFSET;
        av.fresh = false;
      }
      const px = p.x;
      const pz = p.z;
      p.x = damp(p.x, t.x, 14, f.dt);
      p.y = damp(p.y, t.y, 14, f.dt);
      p.z = damp(p.z, t.z, 14, f.dt);
      const speed = f.dt > 0 ? Math.hypot(p.x - px, p.z - pz) / f.dt : 0;
      av.root.rotation.y = dampAngle(av.root.rotation.y, t.yaw + AVATAR_YAW_OFFSET, 14, f.dt);
      av.stride = damp(av.stride, t.moving || speed > 0.5 ? Math.min(1, 0.45 + speed / 6) : 0, 9, f.dt);
      av.gait += f.dt * (4 + speed * 1.5);
      const sw = Math.sin(av.gait) * 0.72 * av.stride;
      av.legs[0].rotation.x = sw;
      av.legs[1].rotation.x = -sw;
      const holding = t.heldItem !== null || t.uvOn;
      av.arms[1].rotation.x = sw * 0.85;
      av.arms[1].rotation.z = 0.09;
      av.arms[0].rotation.x = damp(av.arms[0].rotation.x, holding ? -1.25 - t.pitch * 0.6 : -sw * 0.85, 12, f.dt);
      av.arms[0].rotation.z = -0.09;
      av.body.position.y = Math.abs(Math.cos(av.gait)) * 0.035 * av.stride + Math.sin(f.t * 1.8) * 0.006;
      av.body.rotation.z = Math.sin(av.gait) * 0.025 * av.stride;
      av.head.rotation.x = damp(av.head.rotation.x, -t.pitch * 0.8, 12, f.dt);
      av.head.position.y = 1.6 + av.body.position.y;
      const held: ItemId | null = t.uvOn ? 'tool_uv_lamp' : t.heldItem;
      if (held !== av.heldId) {
        av.heldId = held;
        av.hand.clear();
        if (held) {
          av.hand.add(makeItemMesh(c.M, held));
          av.hand.add(glowSprite(c.M, ITEM_GLOW[held], 0.8, 0.4));
        }
      }
      if (info.name !== av.name) {
        av.name = info.name;
        const sm = av.nameSprite.material;
        sm.map?.dispose();
        sm.map = makeNameTexture(info.name, info.color);
      }
      av.coneMat.opacity = damp(av.coneMat.opacity, t.uvOn ? 0.13 : 0, 8, f.dt);
      if (t.uvOn) {
        uvI = 1;
        const cp = Math.cos(t.pitch);
        dir.set(-Math.sin(t.yaw) * cp, Math.sin(t.pitch), -Math.cos(t.yaw) * cp);
        partnerUv.position.set(p.x, p.y + 1.45, p.z).addScaledVector(dir, 0.35);
        partnerUv.target.position.copy(partnerUv.position).addScaledVector(dir, 4);
        partnerUv.target.updateMatrixWorld();
      }
    }
    partnerUv.intensity = damp(partnerUv.intensity, uvI * 60, 10, f.dt);
    for (const [id, av] of avatars) if (!f.state.players[id]) av.root.visible = false;
  });
}

// ============================================================
// CO-OP PINGS
// ============================================================
function buildPings(c: Ctx): void {
  const { M, scene } = c;
  interface Beacon {
    root: THREE.Group;
    rings: THREE.Group;
    beam: THREE.MeshBasicMaterial;
    born: number;
    label: THREE.SpriteMaterial;
  }
  const live = new Map<string, Beacon>();
  const beamGeo = new THREE.CylinderGeometry(0.1, 0.18, 6, 18, 1, true);
  beamGeo.translate(0, 3, 0);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd257, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
  const make = (pg: CoopPing): Beacon => {
    const root = group(scene, pg.x, pg.y, pg.z, 0);
    const beam = new THREE.MeshBasicMaterial({ color: 0xffc443, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    root.add(noRay(new THREE.Mesh(beamGeo, beam)));
    const rings = group(root, 0, 0, 0, 0);
    for (let i = 0; i < 3; i++) {
      const r = noRay(new THREE.Mesh(new THREE.TorusGeometry(0.35 + i * 0.16, 0.022, 8, 44, i === 1 ? TAU : TAU * 0.8), ringMat));
      r.rotation.x = Math.PI / 2 + (i - 1) * 0.35;
      r.position.y = 0.25 + i * 0.25;
      rings.add(r);
    }
    const g = glowSprite(M, 0xffd257, 1.8, 0.7);
    g.position.y = 0.3;
    root.add(g);
    const label = new THREE.SpriteMaterial({ map: makeNameTexture(pg.playerName, '#ffd257'), transparent: true, depthWrite: false, depthTest: false, fog: false });
    const s = noRay(new THREE.Sprite(label));
    s.scale.set(1.2, 0.3, 1);
    s.position.y = 1.7;
    root.add(s);
    return { root, rings, beam, born: performance.now() / 1000, label };
  };
  c.updaters.push((f) => {
    const now = performance.now() / 1000;
    for (const pg of f.state.pings) if (!live.has(pg.id)) live.set(pg.id, make(pg));
    for (const [id, b] of live) {
      const age = now - b.born;
      if (!f.state.pings.some((p) => p.id === id)) {
        scene.remove(b.root);
        b.label.map?.dispose();
        live.delete(id);
        continue;
      }
      // The server only prunes old pings when a new one arrives, so fade locally too.
      const fade = 1 - smooth(6, 7, age);
      b.root.visible = fade > 0.01;
      b.root.scale.setScalar(smooth(0, 0.35, age) * Math.max(0.001, fade));
      b.rings.rotation.y = f.t * 2.4;
      b.rings.children.forEach((r, i) => (r.position.y = 0.25 + i * 0.25 + Math.sin(f.t * 3 + i) * 0.1));
      b.beam.opacity = (0.4 + Math.sin(f.t * 6) * 0.18) * fade;
    }
  });
}

// ============================================================
// OPTIONAL FURNITURE COLLIDERS
// ============================================================
const box = (id: string, x: number, z: number, w: number, d: number, h = 1.2, y = 0): BoxCollider => ({
  id: `decor_${id}`,
  minX: x - w / 2,
  maxX: x + w / 2,
  minY: y,
  maxY: y + h,
  minZ: z - d / 2,
  maxZ: z + d / 2,
});

/**
 * Colliders for the solid props drawn here. Not part of WORLD_COLLIDERS; a controller may
 * append them so players cannot walk through furniture. `ramp_end` also closes the gap under
 * the top of the Sky-Lift ramp, where the Sky-Garden otherwise leads around the locked gate.
 */
export const DECOR_COLLIDERS: BoxCollider[] = [
  box('ramp_end', 10.35, SKYLIFT_RAMP.zEnd, 3.1, 0.35, 4.2),
  box('clock', -3.75, 6.6, 1.1, 0.6, 3),
  box('lectern', 3.5, 8.5, 0.6, 0.6),
  box('hearth', 0, 17.3, 3.3, 0.8),
  box('foyer_oracle', -6.6, 16.6, 1.3, 1.3, 2.6),
  box('foyer_pedestal', -5.9, 9.2, 0.6, 0.6, 1),
  box('cipher', 11.4, 11.6, 2.2, 0.8),
  box('balance', 19.2, 14.9, 0.9, 2.6, 1),
  box('cabinet', 11.6, 17.4, 2.2, 0.6, 2.4),
  box('tea_table', 9.5, 17, 0.9, 0.9, 0.8),
  box('tea_planter', 11.1, 10.6, 4.2, 0.35, 0.9),
  box('tea_bench', 10.4, 6.75, 2.2, 0.5, 0.6),
  box('bookshelves', -16.05, 5.6, 7.1, 0.5, 3.6),
  box('desk', -10.3, 6.95, 2.4, 1.0, 0.9),
  box('organ', -14, 17.3, 3.7, 0.8, 3),
  box('organ_bench', -14, 16.2, 1.1, 0.4, 0.5),
  box('safe_console', -19.4, 7.6, 0.5, 1.5, 0.9),
  box('globe', -18.6, 16.6, 0.7, 0.7, 1.4),
  box('sundial', -6.2, -9.4, 1.5, 1.5, 1.2),
  box('tablet', -3.9, -9.9, 1.3, 0.5, 1.5),
  box('emitter', 0, -12.8, 0.6, 0.6, 2),
  box('relay_notice', 2.5, -12.3, 1.2, 0.2, 1.8),
  ...MIRRORS.map((m, i) => box(`mirror_${i}`, m.x, m.z, 0.6, 0.6, 2)),
  box('court_oracle', 10.3, 4.0, 1.3, 1.3, 2.6),
  box('hedge_w1', -11.15, 1.4, 0.8, 5.2, 1),
  box('hedge_w2', -11.15, -10.6, 0.8, 4.2, 1),
  box('hedge_e', 11.15, 0.2, 0.8, 4.6, 1),
  box('hedge_s1', -6.6, 5.15, 4.8, 0.7, 1),
  box('hedge_s2', 6.6, 5.15, 4.8, 0.7, 1),
  box('hedge_n', -7.6, -13.3, 4, 0.7, 1),
  box('valves_a', -19, -13, 2.9, 0.5, 2),
  box('valves_b', -19, 1.0, 2.9, 0.5, 2),
  box('anvil', 19.6, -6, 0.9, 0.8, 1.1),
  box('workbench', 17.4, 1.2, 5.2, 1.0, 1),
  box('forge', 25.0, -6, 1.3, 3.6, 3),
  box('foundry_n', 24.2, -12.2, 0.4, 0.4, 1.6),
  box('foundry_s', 24.2, -0.2, 0.4, 0.4, 1.6),
  box('orrery', -1, -16.85, 1.0, 1.0, 1.4, OBSERVATORY_DECK.y),
  box('orrery_ledger', -5.6, -14.7, 0.5, 0.5, 1.2, OBSERVATORY_DECK.y),
  box('star_pedestal', 2.9, -14.5, 0.6, 0.6, 1, OBSERVATORY_DECK.y),
  ...([-5.4, -1.5, 1.5, 5.4] as const).map((x, i) => box(`gate_pedestal_${i}`, x, Math.abs(x) < 2 ? -26.35 : -25.8, 0.6, 0.6, 1)),
  box('spire', 9.6, -22.4, 1.2, 1.2, 4),
  box('wind_pedestal', 8.0, -23.6, 0.6, 0.6, 1),
];

// ============================================================
// ENTRY POINT
// ============================================================
export function buildSolsticeWorld(): BuiltWorld {
  const scene = new THREE.Scene();
  const M = makeMaterials();
  const B = new Batcher();
  const interactables: InteractableObject[] = [];
  const updaters: Ctx['updaters'] = [];
  const ambient: Ctx['ambient'] = [];
  const anchors: LightAnchor[] = [];
  const uv: Ctx['uv'] = { camera: null, enabled: false };
  const gates: { mesh: THREE.Mesh; enabled: (s: WorldState) => boolean }[] = [];

  const c: Ctx = {
    scene,
    M,
    B,
    interactables,
    updaters,
    ambient,
    anchors,
    uvFrames: [],
    uv,
    reg: (o, x, y, z, w, h, d, ry = 0) => {
      const { enabled, ...rest } = o;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), PROXY_MAT);
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      mesh.name = `hit_${o.id}`;
      mesh.userData.interactableId = o.id;
      mesh.updateMatrixWorld();
      scene.add(mesh);
      interactables.push({ ...rest, mesh });
      if (enabled) {
        gates.push({ mesh, enabled });
        if (o.actionType !== 'door') setProxyActive(mesh, false);
      }
      return mesh;
    },
    light: (x, y, z, color, intensity, distance, flicker = 0) => {
      const a: LightAnchor = { pos: new THREE.Vector3(x, y, z), color: new THREE.Color(color), intensity, distance, flicker, gain: 1 };
      anchors.push(a);
      return a;
    },
  };

  buildSky(c);
  buildSouthWing(c);
  buildFoyer(c);
  buildTea(c);
  buildStudy(c);
  buildCourtyard(c);
  buildConservatory(c);
  buildWorkshop(c);
  buildObservatory(c);
  buildTerrace(c);
  buildDoors(c);
  buildPickups(c);
  B.flush(scene);

  // UV lanterns: always present (intensity 0 when off) so shaders never recompile mid-game
  const mkUv = (): THREE.SpotLight => {
    const s = new THREE.SpotLight(0x8a55ff, 0, 10, 0.5, 0.55, 1.4);
    scene.add(s, s.target);
    return s;
  };
  const myUv = mkUv();
  const partnerUv = mkUv();
  buildAvatars(c, partnerUv);
  buildPings(c);

  // A small pool of point lights follows the anchors nearest to the viewer.
  const POOL = 6;
  const pool = Array.from({ length: POOL }, () => {
    const l = new THREE.PointLight(0xffffff, 0, 12, 1.7);
    scene.add(l);
    return { l, anchor: null as LightAnchor | null };
  });
  const camPos = new THREE.Vector3();
  ambient.push((t, dt, camera) => {
    camera.getWorldPosition(camPos);
    const near = anchors
      .map((a) => ({ a, d: a.pos.distanceTo(camPos) - a.distance * 0.35 }))
      .sort((p, q) => p.d - q.d)
      .slice(0, POOL)
      .map((n) => n.a);
    for (const slot of pool) {
      if (slot.anchor && !near.includes(slot.anchor)) {
        slot.l.intensity = damp(slot.l.intensity, 0, 7, dt);
        if (slot.l.intensity < 0.2) slot.anchor = null;
      }
    }
    for (const a of near) {
      if (pool.some((s) => s.anchor === a)) continue;
      const free = pool.find((s) => s.anchor === null);
      if (!free) break;
      free.anchor = a;
      free.l.position.copy(a.pos);
      free.l.color.copy(a.color);
      free.l.distance = a.distance;
      free.l.intensity = 0;
    }
    for (const { l, anchor } of pool) {
      if (!anchor) l.intensity = 0;
      else if (near.includes(anchor)) {
        const fl = 1 + anchor.flicker * (Math.sin(t * 11) * 0.3 + Math.sin(t * 17.3 + 1) * 0.25 + Math.sin(t * 6.1) * 0.25);
        l.intensity = damp(l.intensity, anchor.intensity * anchor.gain * fl, 8, dt);
      }
    }
  });

  const uvDir = new THREE.Vector3();
  const aimLocalUv = (): void => {
    if (!uv.camera) return;
    uv.camera.getWorldPosition(myUv.position);
    uv.camera.getWorldDirection(uvDir);
    myUv.target.position.copy(myUv.position).addScaledVector(uvDir, 4);
    myUv.target.updateMatrixWorld();
  };

  return {
    scene,
    interactables,
    uvFrames: c.uvFrames,
    updateFromState: (state, myPlayerId, dt, elapsed) => {
      const frame: Frame = { state, p: state.puzzles, myId: myPlayerId, dt: Math.min(dt, 0.1), t: elapsed };
      for (const g of gates) setProxyActive(g.mesh, g.enabled(state));
      for (const fn of updaters) fn(frame);
      myUv.intensity = damp(myUv.intensity, uv.enabled ? 70 : 0, 14, frame.dt);
      aimLocalUv();
    },
    setLocalUvLight: (camera, enabled) => {
      uv.camera = camera;
      uv.enabled = enabled;
      aimLocalUv();
    },
  };
}
