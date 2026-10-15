import { describe, expect, it } from 'vitest';
import { DEFAULT_MESH_SETTINGS, triangulate, triangulatePattern } from './triangulate';
import { pointInPolygon } from '../pattern/geometry';
import type { BezierPoint, MeshGeometry, PatternDocument, PatternPiece, Vec2 } from '../project/types';

function rectRing(x: number, y: number, w: number, h: number): Vec2[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** Thin band along the diagonal (0,0)→(len,len), half-width derived from width. */
function diagonalStripRing(len: number, width: number): Vec2[] {
  const n = { x: -width / 2, y: width / 2 };
  const a = { x: 0, y: 0 };
  const b = { x: len, y: len };
  return [
    { x: a.x + n.x, y: a.y + n.y },
    { x: b.x + n.x, y: b.y + n.y },
    { x: b.x - n.x, y: b.y - n.y },
    { x: a.x - n.x, y: a.y - n.y },
  ];
}

describe('pattern piece order through the mesh', () => {
  // The 3D stages match an arrangement to the cloth by piece id, and fall back to
  // pairing by order when a whole other pattern is plugged in — which needs the
  // mesh to hand the pieces back in the pattern's own order.
  it('tags the vertices piece by piece in the order the pattern lists them', () => {
    const make = (id: string, x: number): PatternPiece => ({
      id,
      name: id,
      closed: true,
      points: rectPoints(`${id}-p`, x, 0, 10, 10),
    });
    const pattern: PatternDocument = {
      id: 'pat',
      name: 'pat',
      pieces: [make('first', 0), make('second', 20)],
      seams: [],
    };
    const mesh = triangulatePattern(pattern, DEFAULT_MESH_SETTINGS);
    const seen: string[] = [];
    for (const id of mesh.vertexPieceIds ?? []) {
      if (id && !seen.includes(id)) seen.push(id);
    }
    expect(seen).toEqual(['first', 'second']);
  });
});

function rectPoints(prefix: string, x: number, y: number, w: number, h: number): BezierPoint[] {
  return rectRing(x, y, w, h).map((p, i) => ({
    id: `${prefix}-${i}`,
    anchor: { ...p },
    handleIn: null,
    handleOut: null,
  }));
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function distanceToPolyline(poly: Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, distanceToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return best;
}

function area2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function usedVertices(mesh: MeshGeometry): Set<number> {
  return new Set(mesh.triangles);
}

function expectNoDegenerateTriangles(mesh: MeshGeometry): void {
  for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
    const a = mesh.vertices[mesh.triangles[t]];
    const b = mesh.vertices[mesh.triangles[t + 1]];
    const c = mesh.vertices[mesh.triangles[t + 2]];
    expect(Math.abs(area2(a, b, c))).toBeGreaterThan(1e-12);
  }
}

describe('thin-strip meshing', () => {
  it('gives a narrow delaunay strip interior vertices and no isolated vertices', () => {
    const poly = rectRing(0, 0, 2, 100);
    const mesh = triangulate(poly, DEFAULT_MESH_SETTINGS);

    expect(mesh.triangles.length).toBeGreaterThanOrEqual(6);
    // Every vertex is referenced by a triangle (no unconstrained floaters).
    expect(usedVertices(mesh).size).toBe(mesh.vertices.length);
    // A strip that is only boundary-sampled would have every vertex on the edge.
    const interior = mesh.vertices.filter((v) => distanceToPolyline(poly, v) > 0.1);
    expect(interior.length).toBeGreaterThan(0);
    expectNoDegenerateTriangles(mesh);
  });

  it('does not fall back to meshing the bounding box of a diagonal strip', () => {
    const poly = diagonalStripRing(60, 2);
    const mesh = triangulate(poly, { ...DEFAULT_MESH_SETTINGS, algorithm: 'structuredGrid' });

    expect(mesh.triangles.length).toBeGreaterThanOrEqual(3);
    expect(usedVertices(mesh).size).toBe(mesh.vertices.length);
    for (const v of mesh.vertices) {
      const onOrInside = pointInPolygon(v, poly) || distanceToPolyline(poly, v) < 0.75;
      expect(onOrInside).toBe(true);
    }
  });

  it('meshes a thin pattern piece with interior vertices', () => {
    const piece: PatternPiece = {
      id: 'strap',
      name: 'strap',
      closed: true,
      points: rectPoints('strap', 0, 0, 1.5, 90),
    };
    const pattern: PatternDocument = { id: 'pat', name: 'pat', pieces: [piece], seams: [] };

    const mesh = triangulatePattern(pattern, DEFAULT_MESH_SETTINGS);
    expect(mesh.triangles.length).toBeGreaterThanOrEqual(6);
    expect(usedVertices(mesh).size).toBe(mesh.vertices.length);
    expect(mesh.vertices.length).toBeGreaterThan(20);
    const poly = rectRing(0, 0, 1.5, 90);
    const interior = mesh.vertices.filter((v) => distanceToPolyline(poly, v) > 0.1);
    expect(interior.length).toBeGreaterThan(0);
    expectNoDegenerateTriangles(mesh);
  });
});

/**
 * A panel with a hole cut out of it.
 *
 * The hole is real cloth geometry, not a drawing: the mesh has to leave it empty,
 * and its rim is a boundary of the cloth with vertices on it — which is what lets
 * a piece be sewn into the opening, and what stops the drape hanging a curtain
 * across it.
 */
describe('meshing a panel with a hole', () => {
  const frame = (holes?: BezierPoint[][]): PatternPiece => ({
    id: 'frame',
    name: 'Frame',
    closed: true,
    points: rectPoints('outer', 0, 0, 40, 40),
    holes,
  });

  const pattern = (piece: PatternPiece): PatternDocument => ({
    id: 'pat',
    name: 'Pat',
    pieces: [piece],
    seams: [],
  });

  const triangleCentroids = (mesh: MeshGeometry): Vec2[] => {
    const out: Vec2[] = [];
    for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
      const [a, b, c] = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]].map(
        (i) => mesh.vertices[i]!
      );
      out.push({ x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 });
    }
    return out;
  };

  it('leaves the hole empty and keeps the cloth around it', () => {
    const hole = rectRing(15, 15, 10, 10);
    const mesh = triangulatePattern(pattern(frame([rectPoints('hole', 15, 15, 10, 10)])), DEFAULT_MESH_SETTINGS);
    expect(mesh.triangles.length).toBeGreaterThan(0);
    // Nothing spans the hole: no triangle has its middle inside it.
    for (const c of triangleCentroids(mesh)) {
      expect(pointInPolygon(c, hole)).toBe(false);
    }
    // But the cloth is still there around it, on all four sides.
    const centroids = triangleCentroids(mesh);
    expect(centroids.some((c) => c.x < 15 && c.y < 15)).toBe(true);
    expect(centroids.some((c) => c.x > 25 && c.y > 25)).toBe(true);
    expect(centroids.some((c) => c.y > 25)).toBe(true);
    expect(centroids.some((c) => c.y < 15)).toBe(true);
    expectNoDegenerateTriangles(mesh);
  });

  it('puts mesh verts on the hole rim, tagged to its edges', () => {
    const piece = frame([rectPoints('hole', 15, 15, 10, 10)]);
    const mesh = triangulatePattern(pattern(piece), DEFAULT_MESH_SETTINGS);
    const rim = piece.holes![0]!;
    const onRim = (mesh.boundary ?? []).filter((tag) => tag?.pieceId === 'frame' && tag.fromPointId.startsWith('hole'));
    expect(onRim.length).toBeGreaterThan(4);
    for (const tag of onRim) {
      // Every one of those tags names a real edge of the hole ring.
      expect(rim.some((pt) => pt.id === tag!.fromPointId)).toBe(true);
    }
  });

  it('meshes the same panel solid when nothing is cut out of it', () => {
    // The contrast that says the hole is doing the work: the same panel with no
    // hole has cloth — and so mesh — right across where the hole would be.
    const hole = rectRing(15, 15, 10, 10);
    const solid = triangulatePattern(pattern(frame()), DEFAULT_MESH_SETTINGS);
    const holed = triangulatePattern(pattern(frame([rectPoints('hole', 15, 15, 10, 10)])), DEFAULT_MESH_SETTINGS);
    expect(triangleCentroids(solid).some((c) => pointInPolygon(c, hole))).toBe(true);
    expect(triangleCentroids(holed).some((c) => pointInPolygon(c, hole))).toBe(false);
  });
});
