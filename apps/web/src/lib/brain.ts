import { REGIONS, type Region } from '@cortex/core';

/**
 * Procedural brain: neuron point cloud + synapse/tract line geometry.
 * Axes: +x anterior (front), +y up, z = left/right hemisphere.
 * Deterministic (seeded) so the brain looks identical on every load.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type V3 = [number, number, number];
const ri = (r: Region) => REGIONS.indexOf(r);

export interface BrainGeometry {
  count: number;
  positions: Float32Array; // xyz
  regions: Float32Array; // region index
  phases: Float32Array;
  sizes: Float32Array;
  centroids: Record<Region, V3>;
  /** Real cortical surface (pial mesh) rendered as a glowing shell; absent for the procedural fallback. */
  shell?: { positions: Float32Array; regions: Float32Array; indices: Uint32Array };
  lines: {
    positions: Float32Array;
    t: Float32Array;
    phase: Float32Array;
    reg: Float32Array; // vec2 per vertex
    vertexCount: number;
  };
}

function classifyCortex(x: number, y: number): Region {
  if (y < 0.1 && x > -0.7 && x < 1.0) return 'temporal';
  if (x >= 0.8) return 'prefrontal';
  if (x >= 0.2) return 'motor';
  if (x >= -0.55) return 'parietal';
  return 'occipital';
}

export function buildBrain(count = 15000): BrainGeometry {
  const rnd = mulberry32(1337);
  const gauss = () => {
    let u = 0;
    for (let i = 0; i < 6; i++) u += rnd();
    return (u - 3) / 0.7071;
  };
  const dir = (): V3 => {
    const x = gauss(), y = gauss(), z = gauss();
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };

  const pts: V3[] = [];
  const reg: number[] = [];
  const push = (p: V3, r: Region) => {
    pts.push(p);
    reg.push(ri(r));
  };

  // --- cerebrum: two folded ellipsoid hemispheres (surface + some interior) ---
  const nCortex = Math.floor(count * 0.68);
  for (let i = 0; i < nCortex; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    const [dx, dy, dz] = dir();
    const gyri =
      0.05 * Math.sin(dx * 9 + dy * 5) * Math.cos(dz * 8 + dx * 3) +
      0.03 * Math.sin(dy * 17 + dz * 11) +
      0.02 * Math.sin(dx * 23 - dz * 19);
    const depth = rnd() < 0.7 ? 1 : 0.5 + 0.5 * Math.cbrt(rnd());
    const k = (1 + gyri) * depth;
    let x = dx * 1.55 * k;
    let y = 0.15 + dy * 1.05 * k;
    const z = s * 0.52 + dz * 0.62 * k;
    if (s * z < 0.03) continue; // longitudinal fissure
    if (y < -0.5) y = -0.5 + (y + 0.5) * 0.4; // flatten the underside
    push([x, y, z], classifyCortex(x, y));
  }

  // --- cerebellum + brainstem ---
  const nCb = Math.floor(count * 0.11);
  for (let i = 0; i < nCb; i++) {
    const [dx, dy, dz] = dir();
    const stripe = 0.04 * Math.sin(dy * 34);
    push([-1.0 + dx * 0.62 * (1 + stripe), -0.8 + dy * 0.36 * (1 + stripe), dz * 0.6], 'cerebellum');
  }
  const nStem = Math.floor(count * 0.03);
  for (let i = 0; i < nStem; i++) {
    const t = rnd();
    const a = rnd() * Math.PI * 2;
    const r = 0.14 * Math.sqrt(rnd());
    push([-0.35 - 0.15 * t + Math.cos(a) * r, -0.55 - 0.95 * t, Math.sin(a) * r], 'cerebellum');
  }

  // --- hippocampus (curved seahorse arc, both sides) + amygdala (small nuclei) ---
  const nHip = Math.floor(count * 0.025);
  for (let i = 0; i < nHip; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    const t = rnd();
    const x = 0.25 - 0.85 * t;
    const y = -0.32 + 0.36 * Math.sin(Math.PI * 0.9 * t) - 0.1 * t;
    const z = s * (0.34 + 0.12 * t);
    push([x + gauss() * 0.03, y + gauss() * 0.03, z + gauss() * 0.03], 'hippocampus');
  }
  const nAmy = Math.floor(count * 0.012);
  for (let i = 0; i < nAmy; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    const [dx, dy, dz] = dir();
    const r = 0.14 * Math.cbrt(rnd());
    push([0.48 + dx * r, -0.4 + dy * r, s * 0.38 + dz * r], 'amygdala');
  }

  const n = pts.length;
  const positions = new Float32Array(n * 3);
  const regions = new Float32Array(n);
  const phases = new Float32Array(n);
  const sizes = new Float32Array(n);
  const sums: Record<number, V3> = {};
  const counts: Record<number, number> = {};
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    positions.set(p, i * 3);
    regions[i] = reg[i]!;
    phases[i] = rnd();
    sizes[i] = 0.5 + Math.pow(rnd(), 6) * 3.4;
    const r = reg[i]!;
    const s = (sums[r] ??= [0, 0, 0]);
    s[0] += p[0]; s[1] += p[1]; s[2] += p[2];
    counts[r] = (counts[r] ?? 0) + 1;
  }
  const centroids = {} as Record<Region, V3>;
  for (const [r, s] of Object.entries(sums)) {
    const c = counts[Number(r)]!;
    centroids[REGIONS[Number(r)]!] = [s[0] / c, s[1] / c, s[2] / c];
  }

  return { count: n, positions, regions, phases, sizes, centroids, lines: buildLines(pts, reg, centroids, rnd) };
}

// ---------------------------------------------------------------------------

const TRACTS: [Region, Region][] = [
  ['prefrontal', 'parietal'], ['prefrontal', 'motor'], ['prefrontal', 'hippocampus'],
  ['prefrontal', 'temporal'], ['occipital', 'temporal'], ['occipital', 'parietal'],
  ['hippocampus', 'temporal'], ['hippocampus', 'amygdala'], ['amygdala', 'prefrontal'],
  ['motor', 'cerebellum'], ['parietal', 'motor'], ['cerebellum', 'occipital'],
  ['temporal', 'parietal'], ['hippocampus', 'parietal'],
];

function buildLines(pts: V3[], reg: number[], centroids: Record<Region, V3>, rnd: () => number) {
  const P: number[] = [], T: number[] = [], PH: number[] = [], RG: number[] = [];
  const seg = (a: V3, b: V3, ta: number, tb: number, ph: number, ra: number, rb: number) => {
    P.push(...a, ...b);
    T.push(ta, tb);
    PH.push(ph, ph);
    RG.push(ra, rb, ra, rb);
  };

  // short synapses: connect hub neurons to near neighbours of the same region
  const CELL = 0.2;
  const key = (x: number, y: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  const grid = new Map<string, number[]>();
  pts.forEach((p, i) => {
    const k = key(p[0], p[1], p[2]);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  const hubs = Math.min(pts.length, 9000);
  for (let h = 0; h < hubs; h++) {
    const i = Math.floor(rnd() * pts.length);
    const p = pts[i]!;
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), cz = Math.floor(p[2] / CELL);
    const near: number[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j === i || reg[j] !== reg[i]) continue;
            const q = pts[j]!;
            const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
            if (d > 0.04 && d < 0.2) near.push(j);
          }
    for (let k = 0; k < 3 && near.length; k++) {
      const j = near.splice(Math.floor(rnd() * near.length), 1)[0]!;
      seg(p, pts[j]!, 0, 1, rnd(), reg[i]!, reg[j]!);
    }
  }

  // long-range tracts: curved bundles between region centroids
  const SEG = 22;
  for (const [a, b] of TRACTS) {
    const A = centroids[a], B = centroids[b];
    const mid: V3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
    const bundle = 7;
    for (let k = 0; k < bundle; k++) {
      const side = rnd() < 0.5 ? 1 : -1;
      const off = (): number => (rnd() - 0.5) * 0.35;
      const sa: V3 = [A[0] + off(), A[1] + off(), side * Math.abs(A[2] || 0.45) + off() * 0.5];
      const sb: V3 = [B[0] + off(), B[1] + off(), side * Math.abs(B[2] || 0.45) + off() * 0.5];
      const m: V3 = [mid[0], mid[1] + 0.35 + rnd() * 0.25, side * (0.55 + rnd() * 0.25)];
      const ph = rnd();
      let prev = sa;
      for (let s = 1; s <= SEG; s++) {
        const t = s / SEG, u = 1 - t;
        const q: V3 = [
          u * u * sa[0] + 2 * u * t * m[0] + t * t * sb[0],
          u * u * sa[1] + 2 * u * t * m[1] + t * t * sb[1],
          u * u * sa[2] + 2 * u * t * m[2] + t * t * sb[2],
        ];
        seg(prev, q, (s - 1) / SEG, t, ph, ri(a), ri(b));
        prev = q;
      }
    }
  }

  return {
    positions: new Float32Array(P),
    t: new Float32Array(T),
    phase: new Float32Array(PH),
    reg: new Float32Array(RG),
    vertexCount: T.length,
  };
}

// ---------------------------------------------------------------------------
// Real anatomical asset (apps/web/public/brain, generated from the FreeSurfer fsaverage template)

interface AssetMeta {
  neuronPos: { offset: number; count: number };
  neuronReg: { offset: number; count: number };
  shellPos: { offset: number; count: number };
  shellReg: { offset: number; count: number };
  shellIdx: { offset: number; count: number };
}

export async function loadBrain(): Promise<BrainGeometry> {
  try {
    const base = import.meta.env.BASE_URL + "brain/";
    const [meta, buf] = await Promise.all([
      fetch(base + "brain.json").then((r) => (r.ok ? (r.json() as Promise<AssetMeta>) : Promise.reject(r.status))),
      fetch(base + "brain.bin").then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status))),
    ]);
    return fromAsset(meta, buf);
  } catch (err) {
    console.warn("[cortex] brain asset unavailable, using procedural brain:", err);
    return buildBrain(15000);
  }
}

function fromAsset(meta: AssetMeta, buf: ArrayBuffer): BrainGeometry {
  const rnd = mulberry32(1337);
  const n = meta.neuronPos.count;
  const positions = new Float32Array(buf, meta.neuronPos.offset, n * 3);
  const regU8 = new Uint8Array(buf, meta.neuronReg.offset, n);

  const pts: V3[] = new Array(n);
  const reg: number[] = new Array(n);
  const regions = new Float32Array(n);
  const phases = new Float32Array(n);
  const sizes = new Float32Array(n);
  const sums: V3[] = Array.from({ length: REGIONS.length }, () => [0, 0, 0] as V3);
  const counts = new Array(REGIONS.length).fill(0);
  for (let i = 0; i < n; i++) {
    const p: V3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const r = regU8[i]!;
    pts[i] = p;
    reg[i] = r;
    regions[i] = r;
    phases[i] = rnd();
    sizes[i] = 0.5 + Math.pow(rnd(), 6) * 3.4;
    sums[r]![0] += p[0]; sums[r]![1] += p[1]; sums[r]![2] += p[2];
    counts[r]++;
  }
  const centroids = {} as Record<Region, V3>;
  REGIONS.forEach((name, r) => {
    const c = Math.max(1, counts[r]);
    centroids[name] = [sums[r]![0] / c, sums[r]![1] / c, sums[r]![2] / c];
  });

  const shell = {
    positions: new Float32Array(buf, meta.shellPos.offset, meta.shellPos.count * 3),
    regions: Float32Array.from(new Uint8Array(buf, meta.shellReg.offset, meta.shellReg.count)),
    indices: new Uint32Array(buf, meta.shellIdx.offset, meta.shellIdx.count), // count is already flattened (3 per triangle)
  };
  return { count: n, positions, regions, phases, sizes, centroids, shell, lines: buildLines(pts, reg, centroids, rnd) };
}
