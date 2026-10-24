import { vec3 } from 'gl-matrix';
import { boundsOf } from '../pattern/geometry';
import { resolveSeamParticlePairs } from '../mesh/triangulate';
import type { MeshGeometry, PatternDocument } from '../project/types';
import { CM_TO_WORLD } from './units';

export const FALLBACK_PIECE_ID = '__cloth__';

export type StretchConstraint = {
  i: number;
  j: number;
  rest: number;
  /**
   * Crowd floor of an edge that runs along a sewn edge, as a share of its rest
   * length — how far this row may shorten before it pushes back. Only the row
   * along the *long* side of a gathered seam gets one (the side with fabric to
   * give); ordinary fabric, and the short side of a gather, is two-sided and
   * inextensible exactly as it has always been.
   */
  slack?: number;
};
export type BendConstraint = { i0: number; i1: number; i2: number; i3: number; restAngle: number };
/** Long-range / attach: particle i capped to maxDist from slot position. */
export type LraConstraint = {
  particleId: number;
  slotId: number;
  maxDist: number;
  /** If set, maxDist ramps from initialDist → maxDist over time (seams). */
  initialDist?: number;
  isSeam?: boolean;
};

/** Pairwise sew distance: |x_i − x_j| ≤ rest, ramped from initialDist. */
/**
 * Fold resistance across a stitch, as the two diagonals of a stitch quad.
 *
 * A seam held only by pairwise stitches is a free hinge: the panels either side
 * of it can swing to a knife edge about the stitch line and keep going. Real
 * cloth does not — the seam is where the fabric is doubled, and the two panels
 * behave as one sheet across it. These are the same cross-fold distance
 * constraints `buildBendConstraints` makes inside a panel, taken across the
 * stitch: for two stitch rows joined by a mesh edge, the quad's two diagonals.
 */
export type SeamBendConstraint = {
  i: number;
  j: number;
  /** Diagonal length with the seam lying flat (the shorter of the two rows). */
  rest: number;
};

export type SeamDistanceConstraint = {
  i: number;
  j: number;
  /** Target gap in world units after seam closure. */
  rest: number;
  /** Laid-out separation before sewing (world units). */
  initialDist: number;
};

export type ClothTopology = {
  positions: Float32Array;
  initialPositions: Float32Array;
  inverseMasses: Float32Array;
  radii: Float32Array;
  /** Mean incident edge length per particle (world units) — drives collision margin. */
  edgeLengths: Float32Array;
  indices: Uint32Array;
  vertexPieceIds: string[];
  stretch: StretchConstraint[];
  bend: BendConstraint[];
  /** Attach slot world positions (xyz). Non-seam LRA only. */
  attachSlots: Float32Array;
  lra: LraConstraint[];
  /** Sew distance constraints (preferred over mutual-slot LRA). */
  seamConstraints: SeamDistanceConstraint[];
  /** Seam particle pairs for overlay (a,b). */
  seamPairs: Array<[number, number]>;
  /** Cross-seam fold resistance — see {@link SeamBendConstraint}. */
  seamBend: SeamBendConstraint[];
  /** CSR one-ring: offsets[i]..offsets[i+1] → neighbors. */
  oneRingOffsets: Uint32Array;
  oneRingNeighbors: Uint32Array;
  avgEdgeLength: number;
  particleMass: number;
  numParticles: number;
};

function fallbackMesh(): {
  vertices: MeshGeometry['vertices'];
  triangles: number[];
  edges: Array<[number, number]>;
  vertexPieceIds: string[];
} {
  const vertices = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 50 },
    { x: 0, y: 50 },
  ];
  return {
    vertices,
    triangles: [0, 1, 2, 0, 2, 3],
    edges: [
      [0, 1],
      [1, 2],
      [2, 0],
      [0, 2],
      [2, 3],
      [3, 0],
    ],
    vertexPieceIds: vertices.map(() => FALLBACK_PIECE_ID),
  };
}

/** Build dihedral bend constraints from triangle adjacency (shared edge → opposite verts). */
export function buildBendConstraints(
  positions: Float32Array,
  triangles: number[]
): BendConstraint[] {
  const edgeMap = new Map<string, { a: number; b: number; opp: number }>();
  const bends: BendConstraint[] = [];

  const key = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);

  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const i0 = triangles[t];
    const i1 = triangles[t + 1];
    const i2 = triangles[t + 2];
    const faces: Array<[number, number, number]> = [
      [i0, i1, i2],
      [i1, i2, i0],
      [i2, i0, i1],
    ];
    for (const [a, b, opp] of faces) {
      const k = key(a, b);
      const existing = edgeMap.get(k);
      if (!existing) {
        edgeMap.set(k, { a, b, opp });
        continue;
      }
      // Shared edge existing.a–existing.b; opposite verts existing.opp and opp.
      const i0b = existing.opp;
      const i1b = a;
      const i2b = b;
      const i3b = opp;
      const restAngle = dihedralRestAngle(positions, i0b, i1b, i2b, i3b);
      bends.push({ i0: i0b, i1: i1b, i2: i2b, i3: i3b, restAngle });
      edgeMap.delete(k);
    }
  }
  return bends;
}

function dihedralRestAngle(
  positions: Float32Array,
  i0: number,
  i1: number,
  i2: number,
  i3: number
): number {
  const p0 = vec3.fromValues(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
  const p1 = vec3.fromValues(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
  const p2 = vec3.fromValues(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
  const p3 = vec3.fromValues(positions[i3 * 3], positions[i3 * 3 + 1], positions[i3 * 3 + 2]);
  const e1 = vec3.create();
  const e2 = vec3.create();
  const n1 = vec3.create();
  const n2 = vec3.create();
  vec3.sub(e1, p1, p0);
  vec3.sub(e2, p2, p0);
  vec3.cross(n1, e1, e2);
  vec3.sub(e1, p1, p3);
  vec3.sub(e2, p2, p3);
  vec3.cross(n2, e1, e2);
  if (vec3.squaredLength(n1) < 1e-12 || vec3.squaredLength(n2) < 1e-12) return Math.PI;
  vec3.normalize(n1, n1);
  vec3.normalize(n2, n2);
  const d = Math.max(-1, Math.min(1, vec3.dot(n1, n2)));
  return Math.acos(d);
}

function buildOneRing(numParticles: number, edges: Array<[number, number]>): {
  offsets: Uint32Array;
  neighbors: Uint32Array;
} {
  const lists: number[][] = Array.from({ length: numParticles }, () => []);
  for (const [a, b] of edges) {
    if (a === b) continue;
    lists[a].push(b);
    lists[b].push(a);
  }
  const offsets = new Uint32Array(numParticles + 1);
  let total = 0;
  for (let i = 0; i < numParticles; i++) {
    offsets[i] = total;
    // unique
    const uniq = [...new Set(lists[i])];
    lists[i] = uniq;
    total += uniq.length;
  }
  offsets[numParticles] = total;
  const neighbors = new Uint32Array(total);
  for (let i = 0; i < numParticles; i++) {
    neighbors.set(lists[i], offsets[i]);
  }
  return { offsets, neighbors };
}

/**
 * Re-wind the mesh's triangles for the world they are laid out in.
 *
 * Pattern space is a drafting canvas: x right, y *down*. The layout above maps
 * it to world (x, ·, −y) — a mirror — and a mirror reverses handedness, so every
 * triangle that was wound front-first in the pattern arrives back-to-front in
 * the scene. Nothing noticed for a long time because the drapes are drawn with
 * culling off and the mistake is invisible until you read the mesh out: the
 * exported OBJ's fabric has its normals pointing into the body. Reversing each
 * triangle here, once, is what makes the cloth's outside its front face — for
 * the renderer's normals and for every export.
 */
function windOutward(triangles: ArrayLike<number>): Uint32Array {
  const indices = new Uint32Array(triangles.length);
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    indices[t] = triangles[t]!;
    indices[t + 1] = triangles[t + 2]!;
    indices[t + 2] = triangles[t + 1]!;
  }
  return indices;
}

/**
 * Shared mesh → particle/constraint topology for CPU and GPU engines.
 */
/**
 * Cross-seam fold constraints: the two triangles either side of the stitch.
 *
 * Inside a panel, bending is resisted by one distance constraint across each
 * shared edge — the two opposite vertices of the adjacent triangles. Sewing
 * makes two *boundary* triangles adjacent, so the same constraint has to cross
 * the stitch: `x`, the interior vertex of the triangle on the seam edge
 * `(a, b)` of one panel, against `y`, the interior vertex of the triangle on
 * the stitched edge `(a', b')` of the other.
 *
 * The rest is `h(a,b) + h(a',b')` — the two triangle heights. Sewn flat, the
 * second triangle is the mirror of the first across the stitch line, so the two
 * interior vertices sit on opposite sides of that line at the same station
 * along it, exactly `hA + hB` apart. Folding the panels about the stitch
 * shortens `x–y` (a 90° fold takes it to about 70 %), so the constraint pulls
 * the seam back flat, with the same compliance as ordinary bending.
 *
 * Note which pair this is *not*: the diagonals of the stitch quad (`a–b'`,
 * `b–a'`) lie along the seam, so folding about the seam does not shorten them
 * at all — they cannot feel a fold.
 */
export function buildSeamBendConstraints(
  positions: Float32Array,
  triangles: number[],
  seamPairs: Array<[number, number]>
): SeamBendConstraint[] {
  if (seamPairs.length === 0) return [];

  // Mesh edge → the vertex of the (single) triangle on it. Both rows of a seam
  // are boundaries, so each edge here has exactly one.
  const opposite = new Map<string, number>();
  const edgeKey = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const i0 = triangles[t]!;
    const i1 = triangles[t + 1]!;
    const i2 = triangles[t + 2]!;
    opposite.set(edgeKey(i0, i1), i2);
    opposite.set(edgeKey(i1, i2), i0);
    opposite.set(edgeKey(i2, i0), i1);
  }

  /** Perpendicular distance from `p` to the line through edge (a, b). */
  const height = (p: number, a: number, b: number): number => {
    const abx = positions[b * 3] - positions[a * 3];
    const aby = positions[b * 3 + 1] - positions[a * 3 + 1];
    const abz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const apx = positions[p * 3] - positions[a * 3];
    const apy = positions[p * 3 + 1] - positions[a * 3 + 1];
    const apz = positions[p * 3 + 2] - positions[a * 3 + 2];
    const cx = aby * apz - abz * apy;
    const cy = abz * apx - abx * apz;
    const cz = abx * apy - aby * apx;
    const area2 = Math.hypot(cx, cy, cz);
    const base = Math.hypot(abx, aby, abz);
    return base > 1e-9 ? area2 / base : 0;
  };

  const out: SeamBendConstraint[] = [];
  const seen = new Set<string>();
  const add = (i: number, j: number, rest: number) => {
    if (i === j || !(rest > 1e-6)) return;
    const key = i < j ? `${i}_${j}` : `${j}_${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ i, j, rest });
  };

  // Consecutive stitch pairs walk along one seam, so their two rows are the
  // edges of the adjacent triangles — the pair of triangles the fold happens
  // between.
  for (let k = 0; k + 1 < seamPairs.length; k++) {
    const [a0, b0] = seamPairs[k]!;
    const [a1, b1] = seamPairs[k + 1]!;
    const x = opposite.get(edgeKey(a0, a1));
    const y = opposite.get(edgeKey(b0, b1));
    if (x === undefined || y === undefined) continue;
    const rest = height(x, a0, a1) + height(y, b0, b1);
    add(x, y, rest);
  }
  return out;
}

export function buildClothTopology(
  mesh: MeshGeometry,
  mass: number,
  pattern?: PatternDocument | null,
  opts?: {
    particleDiameterScalar?: number;
    longRangeStretchiness?: number;
    layoutY?: number;
  }
): ClothTopology {
  const diameterScalar = opts?.particleDiameterScalar ?? 1.5;
  const lraSlack = opts?.longRangeStretchiness ?? 1.2;
  const layoutY = opts?.layoutY ?? 4.0;

  let vertices = mesh.vertices;
  let triangles = mesh.triangles;
  let edges = mesh.edges;
  let vertexPieceIds = mesh.vertexPieceIds;

  if (vertices.length < 3 || triangles.length < 3) {
    const fb = fallbackMesh();
    vertices = fb.vertices;
    triangles = fb.triangles;
    edges = fb.edges;
    vertexPieceIds = fb.vertexPieceIds;
  }

  const pieceIds =
    vertexPieceIds?.length === vertices.length
      ? vertexPieceIds.map((id) => id ?? FALLBACK_PIECE_ID)
      : vertices.map(() => FALLBACK_PIECE_ID);

  const { min, max } = boundsOf(vertices);
  const width = Math.max(max.x - min.x, 1);
  const height = Math.max(max.y - min.y, 1);
  const worldW = width * CM_TO_WORLD;
  const worldH = height * CM_TO_WORLD;
  const originX = -worldW * 0.5;
  const originZ = worldH * 0.5;

  const n = vertices.length;
  const positions = new Float32Array(n * 3);
  const initialPositions = new Float32Array(n * 3);
  const inverseMasses = new Float32Array(n);
  const radii = new Float32Array(n);
  const edgeLengths = new Float32Array(n);
  const particleMass = mass / Math.max(n, 1);
  const invMass = particleMass > 0 ? 1 / particleMass : 0;

  let avgEdge = 0;
  for (const [a, b] of edges) {
    avgEdge +=
      Math.hypot(vertices[a].x - vertices[b].x, vertices[a].y - vertices[b].y) * CM_TO_WORLD;
  }
  const avgEdgeLength = edges.length > 0 ? avgEdge / edges.length : 0.4;

  for (let i = 0; i < n; i++) {
    const p = vertices[i];
    const u = (p.x - min.x) / width;
    const v = (p.y - min.y) / height;
    const x = originX + u * worldW;
    const y = layoutY;
    const z = originZ - v * worldH;
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    initialPositions[i * 3] = x;
    initialPositions[i * 3 + 1] = y;
    initialPositions[i * 3 + 2] = z;
    inverseMasses[i] = invMass;
  }

  // Per-particle local edge length. A global average is wrong for strips that
  // mix long along-axis edges with very short cross-width edges, and it makes
  // the collision margin float or sink the strip.
  {
    const localSum = new Float32Array(n);
    const localCount = new Float32Array(n);
    const dist3 = (a: number, b: number): number =>
      Math.hypot(
        positions[a * 3] - positions[b * 3],
        positions[a * 3 + 1] - positions[b * 3 + 1],
        positions[a * 3 + 2] - positions[b * 3 + 2]
      );
    for (const [a, b] of edges) {
      const len = dist3(a, b);
      localSum[a] += len;
      localCount[a] += 1;
      localSum[b] += len;
      localCount[b] += 1;
    }
    for (let i = 0; i < n; i++) {
      const localAvg = localCount[i] > 0 ? localSum[i] / localCount[i] : avgEdgeLength;
      edgeLengths[i] = localAvg;
      radii[i] = localAvg * diameterScalar * 0.5;
    }
  }

  const stretch: StretchConstraint[] = [];
  for (const [a, b] of edges) {
    const dx = positions[a * 3] - positions[b * 3];
    const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
    const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
    const rest = Math.hypot(dx, dy, dz);
    stretch.push({ i: a, j: b, rest });
  }

  const bend = buildBendConstraints(positions, triangles);

  // Seams as pairwise distance constraints (not mutual stale-slot LRAs).
  const seamPairsRaw = resolveSeamParticlePairs(pattern ?? undefined, {
    ...mesh,
    vertices,
    triangles,
    edges,
    vertexPieceIds: pieceIds,
  });
  const seamPairs: Array<[number, number]> = [];
  const seamConstraints: SeamDistanceConstraint[] = [];
  // Non-seam attach slots reserved for future pin/LRA use.
  const lra: LraConstraint[] = [];
  const slotList: number[] = [];

  for (const pair of seamPairsRaw) {
    if (pair.a < 0 || pair.b < 0 || pair.a >= n || pair.b >= n) continue;
    if (pair.a === pair.b) continue;
    const ax = positions[pair.a * 3];
    const ay = positions[pair.a * 3 + 1];
    const az = positions[pair.a * 3 + 2];
    const bx = positions[pair.b * 3];
    const by = positions[pair.b * 3 + 1];
    const bz = positions[pair.b * 3 + 2];
    const initialDist = Math.hypot(ax - bx, ay - by, az - bz);
    // Small positive gap; lraSlack slightly loosens the final sew allowance.
    const targetRest = Math.max(1e-4, pair.restCm * CM_TO_WORLD * Math.max(1, lraSlack * 0.5 + 0.5));
    seamConstraints.push({
      i: pair.a,
      j: pair.b,
      rest: targetRest,
      initialDist: Math.max(initialDist, targetRest),
    });
    seamPairs.push([pair.a, pair.b]);
  }

  // Edges that run along a sewn edge: both ends are stitched, so this is the
  // row of fabric the seam is cinching — and the only place a crowd floor can
  // apply. A vertex only carries one when its seam asked for fabric to give, so
  // a plain 1:1 seam leaves every stretch edge two-sided and inextensible.
  const crowdFloorByVertex = new Map<number, number>();
  for (const pair of seamPairsRaw) {
    if (pair.crowdA !== undefined) {
      const current = crowdFloorByVertex.get(pair.a) ?? 1;
      crowdFloorByVertex.set(pair.a, Math.min(current, pair.crowdA));
    }
    if (pair.crowdB !== undefined) {
      const current = crowdFloorByVertex.get(pair.b) ?? 1;
      crowdFloorByVertex.set(pair.b, Math.min(current, pair.crowdB));
    }
  }
  if (crowdFloorByVertex.size > 0) {
    for (const c of stretch) {
      const floorI = crowdFloorByVertex.get(c.i);
      const floorJ = crowdFloorByVertex.get(c.j);
      if (floorI !== undefined && floorJ !== undefined) c.slack = Math.min(floorI, floorJ);
    }
  }

  const seamBend = buildSeamBendConstraints(positions, triangles, seamPairs);

  const { offsets, neighbors } = buildOneRing(n, edges);

  return {
    positions,
    initialPositions,
    inverseMasses,
    radii,
    edgeLengths,
    indices: windOutward(triangles),
    vertexPieceIds: pieceIds,
    stretch,
    bend,
    attachSlots: new Float32Array(slotList),
    lra,
    seamConstraints,
    seamPairs,
    seamBend,
    oneRingOffsets: offsets,
    oneRingNeighbors: neighbors,
    avgEdgeLength,
    particleMass,
    numParticles: n,
  };
}
