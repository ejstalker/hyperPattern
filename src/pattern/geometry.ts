import type { BezierPoint, PatternPiece, SeamEdgeRef, Vec2 } from '../project/types';

export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Closest point on segment AB to P. */
export function closestPointOnSegment(
  p: Vec2,
  a: Vec2,
  b: Vec2
): { point: Vec2; t: number; dist: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) {
    return { point: { ...a }, t: 0, dist: dist(p, a) };
  }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + t * abx, y: a.y + t * aby };
  return { point, t, dist: dist(p, point) };
}

/**
 * Closest location on piece edge `edgeIndex` to point `p`.
 * Samples cubics when handles are present.
 */
export function closestPointOnEdge(
  points: BezierPoint[],
  closed: boolean,
  edgeIndex: number,
  p: Vec2,
  samples = 24
): { point: Vec2; t: number; dist: number } | null {
  const n = points.length;
  const edgeCount = closed ? n : Math.max(0, n - 1);
  if (edgeIndex < 0 || edgeIndex >= edgeCount) return null;
  const a = points[edgeIndex];
  const b = points[(edgeIndex + 1) % n];
  const { c0, c1 } = edgeHandles(a, b);
  const linear =
    (!a.handleOut || (a.handleOut.x === a.anchor.x && a.handleOut.y === a.anchor.y)) &&
    (!b.handleIn || (b.handleIn.x === b.anchor.x && b.handleIn.y === b.anchor.y));
  if (linear) {
    return closestPointOnSegment(p, a.anchor, b.anchor);
  }
  const pts = sampleCubic(a.anchor, c0, c1, b.anchor, samples);
  let best = { point: pts[0], t: 0, dist: dist(p, pts[0]) };
  for (let i = 1; i < pts.length; i++) {
    const d = dist(p, pts[i]);
    if (d < best.dist) best = { point: pts[i], t: i / (pts.length - 1), dist: d };
  }
  return best;
}

/** Nearest edge on a piece to point p. */
export function findNearestEdge(
  points: BezierPoint[],
  closed: boolean,
  p: Vec2
): { edgeIndex: number; point: Vec2; t: number; dist: number } | null {
  const n = points.length;
  const edgeCount = closed ? n : Math.max(0, n - 1);
  if (edgeCount < 1) return null;
  let best: { edgeIndex: number; point: Vec2; t: number; dist: number } | null = null;
  for (let i = 0; i < edgeCount; i++) {
    const hit = closestPointOnEdge(points, closed, i, p);
    if (!hit) continue;
    if (!best || hit.dist < best.dist) {
      best = { edgeIndex: i, point: hit.point, t: hit.t, dist: hit.dist };
    }
  }
  return best;
}

/** Nearest edge on a piece to point p, holes included. */
export function findNearestPieceEdge(
  piece: PatternPiece,
  p: Vec2
): { ring: BezierPoint[]; ringIndex: number; edgeIndex: number; edgeNumber: number; point: Vec2; t: number; dist: number } | null {
  const rings = pieceRings(piece);
  let best: {
    ring: BezierPoint[];
    ringIndex: number;
    edgeIndex: number;
    edgeNumber: number;
    point: Vec2;
    t: number;
    dist: number;
  } | null = null;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    const hit = findNearestEdge(ring, r === 0 ? piece.closed : true, p);
    if (!hit) continue;
    if (!best || hit.dist < best.dist) {
      best = {
        ring,
        ringIndex: r,
        edgeIndex: hit.edgeIndex,
        edgeNumber: pieceEdgeNumber(piece, r, hit.edgeIndex),
        point: hit.point,
        t: hit.t,
        dist: hit.dist,
      };
    }
  }
  return best;
}

/** A point's own copy, with an ID of its own: what a cut leaves behind twice. */
export function cloneBezierPoint(pt: BezierPoint, makeId: () => string): BezierPoint {
  return {
    id: makeId(),
    anchor: { ...pt.anchor },
    handleIn: pt.handleIn ? { ...pt.handleIn } : null,
    handleOut: pt.handleOut ? { ...pt.handleOut } : null,
    handlesParallel: pt.handlesParallel,
  };
}

/**
 * The piece's grainline, when it falls on this ring — a piece cut out of another
 * keeps the grain it was cut with, and a piece that does not hold it does not
 * claim it.
 */
export function grainlineInside(
  piece: PatternPiece,
  ring: BezierPoint[]
): PatternPiece['grainline'] | undefined {
  if (!piece.grainline) return undefined;
  const mid = {
    x: (piece.grainline.from.x + piece.grainline.to.x) / 2,
    y: (piece.grainline.from.y + piece.grainline.to.y) / 2,
  };
  if (!pointInPolygon(mid, pieceToPolyline(ring, true))) return undefined;
  return { from: { ...piece.grainline.from }, to: { ...piece.grainline.to } };
}

/**
 * Flatten a single ring to a polyline (cm). `pieceToPolyline` does the same for
 * a bare ring of points; this is the same call with the ring's own closing rule.
 */
export function ringToPolyline(ring: BezierPoint[], stepsPerEdge = 12): Vec2[] {
  return pieceToPolyline(ring, true, stepsPerEdge);
}

/**
 * Find the edge index whose endpoints match fromPointId → toPointId
 * (piece winding order). Returns null if the points are no longer adjacent
 * (stale seam after insert/delete).
 */
export function edgeIndexForPointIds(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string
): number | null {
  return edgeRingForPointIds(piece, fromPointId, toPointId)?.edgeIndex ?? null;
}

/**
 * Every closed ring of a piece: the outline first, then its holes. Point IDs are
 * unique across the whole piece, so an edge or a point always resolves to a ring
 * without anyone having to name one.
 */
export function pieceRings(piece: PatternPiece): BezierPoint[][] {
  const holes = piece.closed ? piece.holes ?? [] : [];
  return [piece.points, ...holes.filter((ring) => ring.length >= 2)];
}

/**
 * How many edges a ring has. A hole is always closed; an open outline is the
 * only ring without a closing edge.
 */
export function ringEdgeCount(piece: PatternPiece, ringIndex: number): number {
  const ring = pieceRings(piece)[ringIndex];
  if (!ring) return 0;
  return piece.closed || ringIndex > 0 ? ring.length : Math.max(0, ring.length - 1);
}

/** How many edges a piece has, its holes' edges included. */
export function pieceEdgeCount(piece: PatternPiece): number {
  const rings = pieceRings(piece);
  let total = 0;
  for (let r = 0; r < rings.length; r++) total += ringEdgeCount(piece, r);
  return total;
}

/**
 * The edge a piece edge number names. The numbers run right round the outline
 * first and then round each hole in turn, so an edge index stays a plain number
 * wherever the editor passes one about — while a hole's edges are drawn, picked,
 * measured and sewn exactly like the outline's.
 */
export function pieceEdgeAt(
  piece: PatternPiece,
  edgeNumber: number
): { ring: BezierPoint[]; ringIndex: number; edgeIndex: number; from: BezierPoint; to: BezierPoint } | null {
  const rings = pieceRings(piece);
  let n = edgeNumber;
  for (let r = 0; r < rings.length; r++) {
    const count = ringEdgeCount(piece, r);
    if (n < count) {
      const ring = rings[r]!;
      const from = ring[n]!;
      const to = ring[(n + 1) % ring.length]!;
      return { ring, ringIndex: r, edgeIndex: n, from, to };
    }
    n -= count;
  }
  return null;
}

/** The piece-wide edge number of an edge on one of its rings. */
export function pieceEdgeNumber(piece: PatternPiece, ringIndex: number, edgeIndex: number): number {
  let total = 0;
  for (let r = 0; r < ringIndex; r++) total += ringEdgeCount(piece, r);
  return total + edgeIndex;
}

/** The ring a point lives on, or null when the piece has no such point. */
export function pieceRingForPoint(piece: PatternPiece, pointId: string): BezierPoint[] | null {
  for (const ring of pieceRings(piece)) {
    if (ring.some((pt) => pt.id === pointId)) return ring;
  }
  return null;
}

/** A point of the piece by ID, hole points included. */
export function piecePointById(piece: PatternPiece, pointId: string): BezierPoint | null {
  for (const ring of pieceRings(piece)) {
    const pt = ring.find((candidate) => candidate.id === pointId);
    if (pt) return pt;
  }
  return null;
}

/** The ring an edge lives on, with the edge's index inside that ring. */
export function edgeRingForPointIds(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string
): { ring: BezierPoint[]; ringIndex: number; edgeIndex: number } | null {
  const rings = pieceRings(piece);
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    const n = ring.length;
    // A hole is a closed ring whether or not the piece calls itself closed; an
    // open outline is the only ring without a closing edge.
    const edgeCount = piece.closed || r > 0 ? n : Math.max(0, n - 1);
    for (let i = 0; i < edgeCount; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      if (a.id === fromPointId && b.id === toPointId) return { ring, ringIndex: r, edgeIndex: i };
    }
  }
  return null;
}

/** True when a seam edge ref still maps to an adjacent pair of points on its piece. */
export function isSeamEdgeValid(
  pieces: PatternPiece[],
  ref: { pieceId: string; fromPointId: string; toPointId: string }
): boolean {
  const piece = pieces.find((p) => p.id === ref.pieceId);
  if (!piece) return false;
  return edgeIndexForPointIds(piece, ref.fromPointId, ref.toPointId) !== null;
}

/** Sample points along a piece edge (by point ids) for drawing. */
export function sampleEdgeByPointIds(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string,
  steps = 16
): Vec2[] | null {
  const edge = edgeRingForPointIds(piece, fromPointId, toPointId);
  if (!edge) return null;
  const { ring, edgeIndex } = edge;
  const n = ring.length;
  const a = ring[edgeIndex]!;
  const b = ring[(edgeIndex + 1) % n]!;
  const { c0, c1 } = edgeHandles(a, b);
  const linear =
    (!a.handleOut || (a.handleOut.x === a.anchor.x && a.handleOut.y === a.anchor.y)) &&
    (!b.handleIn || (b.handleIn.x === b.anchor.x && b.handleIn.y === b.anchor.y));
  if (linear) return [a.anchor, b.anchor];
  return sampleCubic(a.anchor, c0, c1, b.anchor, steps);
}

/** Sample points along a parametric sub-span [t0, t1] of an edge (for seam drawing). */
export function sampleEdgeSpanByPointIds(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string,
  t0: number,
  t1: number,
  steps = 16
): Vec2[] | null {
  const table = buildEdgeArcTable(piece, fromPointId, toPointId);
  if (!table) return null;
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  if (hi - lo < 1e-6) return null;
  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const hit = pointOnEdgeAtArcFractionInSpan(piece, fromPointId, toPointId, lo, hi, i / steps, table);
    if (hit) pts.push(hit.pos);
  }
  return pts.length >= 2 ? pts : null;
}

export function sameSeamEdgeTopology(
  a: { pieceId: string; fromPointId: string; toPointId: string },
  b: { pieceId: string; fromPointId: string; toPointId: string }
): boolean {
  return (
    a.pieceId === b.pieceId &&
    a.fromPointId === b.fromPointId &&
    a.toPointId === b.toPointId
  );
}

/**
 * Which half of an edge a seam reference is read from.
 *
 * A click on the near half reads forward (t0→t1); the far half reads the other
 * way. This is the Marvelous Designer direction gesture: the half you pick is the
 * end the edge is read from, so both sew tools derive direction the same way.
 */
export function seamRefFromHalf(
  pieceId: string,
  fromPointId: string,
  toPointId: string,
  t: number
): SeamEdgeRef {
  const reversed = t > 0.5;
  return {
    pieceId,
    fromPointId,
    toPointId,
    t0: reversed ? 1 : 0,
    t1: reversed ? 0 : 1,
  };
}

/** True when a directed reference is read from the far half (t0 > t1). */
export function seamReadsFromSecondHalf(ref: { t0: number; t1: number }): boolean {
  return ref.t0 > ref.t1;
}

/**
 * Which axis a Shift-held drag is locked to: the one it has moved along most.
 * Returns null when Shift is not held, so movement stays free in 2D. A tie
 * (including no movement yet) locks to x.
 */
export function axisLockFromDelta(dx: number, dy: number, shift: boolean): 'x' | 'y' | null {
  if (!shift) return null;
  return Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
}

export function sameSeamSpan(a: SeamEdgeRef, b: SeamEdgeRef): boolean {
  return (
    sameSeamEdgeTopology(a, b) &&
    Math.abs(a.t0 - b.t0) < 1e-5 &&
    Math.abs(a.t1 - b.t1) < 1e-5
  );
}

export function sameSeamBindingPair(
  a1: SeamEdgeRef,
  b1: SeamEdgeRef,
  a2: SeamEdgeRef,
  b2: SeamEdgeRef
): boolean {
  return (
    (sameSeamSpan(a1, a2) && sameSeamSpan(b1, b2)) ||
    (sameSeamSpan(a1, b2) && sameSeamSpan(b1, a2))
  );
}

/** Arc length (cm) of the edge fromPointId → toPointId. */
export function edgeLengthByPointIds(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string
): number {
  const table = buildEdgeArcTable(piece, fromPointId, toPointId);
  return table?.total ?? 0;
}

/** Point at parametric t ∈ [0,1] along edge fromPointId → toPointId. */
export function pointOnEdgeAtT(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string,
  t: number
): Vec2 | null {
  const edge = edgeRingForPointIds(piece, fromPointId, toPointId);
  if (!edge) return null;
  const { ring, edgeIndex } = edge;
  const n = ring.length;
  const a = ring[edgeIndex]!;
  const b = ring[(edgeIndex + 1) % n]!;
  const { c0, c1 } = edgeHandles(a, b);
  const tt = Math.max(0, Math.min(1, t));
  const linear =
    (!a.handleOut || (a.handleOut.x === a.anchor.x && a.handleOut.y === a.anchor.y)) &&
    (!b.handleIn || (b.handleIn.x === b.anchor.x && b.handleIn.y === b.anchor.y));
  if (linear) return lerp(a.anchor, b.anchor, tt);
  const u = 1 - tt;
  return {
    x:
      u * u * u * a.anchor.x +
      3 * u * u * tt * c0.x +
      3 * u * tt * tt * c1.x +
      tt * tt * tt * b.anchor.x,
    y:
      u * u * u * a.anchor.y +
      3 * u * u * tt * c0.y +
      3 * u * tt * tt * c1.y +
      tt * tt * tt * b.anchor.y,
  };
}

/** Dense parametric samples + cumulative arc length for an edge (cm). */
export type EdgeArcTable = {
  ts: number[];
  cum: number[];
  total: number;
};

/**
 * Build an arc-length table for edge from→to.
 * Uniform parametric steps ≈64; enough for stable inversion on garment curves.
 */
export function buildEdgeArcTable(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string,
  steps = 64
): EdgeArcTable | null {
  const idx = edgeIndexForPointIds(piece, fromPointId, toPointId);
  if (idx === null) return null;
  const nSteps = Math.max(2, steps);
  const ts: number[] = [];
  const cum: number[] = [];
  let total = 0;
  let prev: Vec2 | null = null;
  for (let i = 0; i <= nSteps; i++) {
    const t = i / nSteps;
    const p = pointOnEdgeAtT(piece, fromPointId, toPointId, t);
    if (!p) return null;
    if (prev) total += dist(prev, p);
    ts.push(t);
    cum.push(total);
    prev = p;
  }
  return { ts, cum, total };
}

/** Arc length along the edge from parametric 0 to t. */
export function arcLengthAtParamT(table: EdgeArcTable, t: number): number {
  const tt = Math.max(0, Math.min(1, t));
  const { ts, cum } = table;
  if (tt <= ts[0]) return cum[0];
  if (tt >= ts[ts.length - 1]) return cum[cum.length - 1];
  for (let i = 1; i < ts.length; i++) {
    if (tt <= ts[i]) {
      const u0 = ts[i - 1];
      const u1 = ts[i];
      const w = u1 > u0 ? (tt - u0) / (u1 - u0) : 0;
      return cum[i - 1] + (cum[i] - cum[i - 1]) * w;
    }
  }
  return table.total;
}

/** Parametric t whose arc length from the start equals `arc` (clamped). */
export function paramTAtArcLength(table: EdgeArcTable, arc: number): number {
  const target = Math.max(0, Math.min(table.total, arc));
  const { ts, cum } = table;
  if (target <= cum[0]) return ts[0];
  if (target >= cum[cum.length - 1]) return ts[ts.length - 1];
  for (let i = 1; i < cum.length; i++) {
    if (target <= cum[i]) {
      const a0 = cum[i - 1];
      const a1 = cum[i];
      const w = a1 > a0 ? (target - a0) / (a1 - a0) : 0;
      return ts[i - 1] + (ts[i] - ts[i - 1]) * w;
    }
  }
  return ts[ts.length - 1];
}

/** True arc length (cm) of the parametric sub-span [t0, t1] on an edge. */
export function edgeArcLengthBetweenParams(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string,
  t0: number,
  t1: number
): number {
  const table = buildEdgeArcTable(piece, fromPointId, toPointId);
  if (!table) return 0;
  return Math.abs(arcLengthAtParamT(table, t1) - arcLengthAtParamT(table, t0));
}

/**
 * Point at fraction s ∈ [0,1] of arc length along the parametric window [t0, t1].
 * Returns both the position and the parametric t (for seam tags / pairing).
 */
export function pointOnEdgeAtArcFractionInSpan(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string,
  t0: number,
  t1: number,
  s: number,
  table?: EdgeArcTable | null
): { pos: Vec2; t: number } | null {
  const tab = table ?? buildEdgeArcTable(piece, fromPointId, toPointId);
  if (!tab) return null;
  const a0 = arcLengthAtParamT(tab, t0);
  const a1 = arcLengthAtParamT(tab, t1);
  const ss = Math.max(0, Math.min(1, s));
  const arc = a0 + (a1 - a0) * ss;
  const t = paramTAtArcLength(tab, arc);
  const pos = pointOnEdgeAtT(piece, fromPointId, toPointId, t);
  if (!pos) return null;
  return { pos, t };
}

/** Sample cubic bezier P0,C0,C1,P1 */
export function sampleCubic(
  p0: Vec2,
  c0: Vec2,
  c1: Vec2,
  p1: Vec2,
  steps: number
): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x =
      u * u * u * p0.x +
      3 * u * u * t * c0.x +
      3 * u * t * t * c1.x +
      t * t * t * p1.x;
    const y =
      u * u * u * p0.y +
      3 * u * u * t * c0.y +
      3 * u * t * t * c1.y +
      t * t * t * p1.y;
    out.push({ x, y });
  }
  return out;
}

export function edgeHandles(
  a: BezierPoint,
  b: BezierPoint
): { c0: Vec2; c1: Vec2 } {
  const c0 = a.handleOut ?? a.anchor;
  const c1 = b.handleIn ?? b.anchor;
  return { c0, c1 };
}

/** Is the edge between two points a straight segment (both handles zeroed)? */
export function edgeIsStraight(a: BezierPoint, b: BezierPoint): boolean {
  const { c0, c1 } = edgeHandles(a, b);
  return c0.x === a.anchor.x && c0.y === a.anchor.y && c1.x === b.anchor.x && c1.y === b.anchor.y;
}

/** Flatten closed piece to polyline (cm). */
export function pieceToPolyline(points: BezierPoint[], closed: boolean, stepsPerEdge = 12): Vec2[] {
  if (points.length === 0) return [];
  const poly: Vec2[] = [];
  const n = points.length;
  const edgeCount = closed ? n : Math.max(0, n - 1);

  for (let i = 0; i < edgeCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const { c0, c1 } = edgeHandles(a, b);
    const isLinear =
      (!a.handleOut || (a.handleOut.x === a.anchor.x && a.handleOut.y === a.anchor.y)) &&
      (!b.handleIn || (b.handleIn.x === b.anchor.x && b.handleIn.y === b.anchor.y));

    if (isLinear) {
      if (i === 0) poly.push({ ...a.anchor });
      poly.push({ ...b.anchor });
    } else {
      const samples = sampleCubic(a.anchor, c0, c1, b.anchor, stepsPerEdge);
      if (i === 0) poly.push(samples[0]);
      for (let s = 1; s < samples.length; s++) poly.push(samples[s]);
    }
  }
  return poly;
}

export function polylineLength(poly: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) len += dist(poly[i - 1], poly[i]);
  return len;
}

export function segmentLengths(points: BezierPoint[], closed: boolean): number[] {
  const n = points.length;
  const edgeCount = closed ? n : Math.max(0, n - 1);
  const lengths: number[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const { c0, c1 } = edgeHandles(a, b);
    const samples = sampleCubic(a.anchor, c0, c1, b.anchor, 16);
    lengths.push(polylineLength(samples));
  }
  return lengths;
}

export function boundsOf(points: Vec2[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) {
    return { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } };
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** Ray-cast point-in-polygon */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Inside the outline and outside every hole: where a piece's cloth actually is.
 * The rings come in already flattened, because the callers that care are the
 * ones sampling a boundary or testing a cut against a piece.
 */
export function pointInCloth(p: Vec2, outline: Vec2[], holes: Vec2[][] = []): boolean {
  if (!pointInPolygon(p, outline)) return false;
  for (const hole of holes) {
    if (pointInPolygon(p, hole)) return false;
  }
  return true;
}

/** Is a point on a piece's cloth? Holes are not cloth. */
export function pointInPiece(p: Vec2, piece: PatternPiece): boolean {
  return pointInCloth(
    p,
    pieceToPolyline(piece.points, piece.closed),
    (piece.closed ? piece.holes ?? [] : []).map((ring) => ringToPolyline(ring))
  );
}

/**
 * The area centroid of a closed polygon — where the shape balances, not where its
 * points average out. Scaling about it is what makes a piece's smaller copy look
 * like the piece: a boundary that happens to carry more points on one side does
 * not pull the copy off centre.
 */
export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) return averagePoint([...poly]);
  return { x: x / (3 * twiceArea), y: y / (3 * twiceArea) };
}

export function averagePoint(points: Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0,
    y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** Bounding box of bezier anchors. */
export function anchorsBounds(points: BezierPoint[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const pt of points) {
    minX = Math.min(minX, pt.anchor.x);
    minY = Math.min(minY, pt.anchor.y);
    maxX = Math.max(maxX, pt.anchor.x);
    maxY = Math.max(maxY, pt.anchor.y);
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return { minX, minY, maxX, maxY };
}

function mirrorVec2(v: Vec2, cx: number, cy: number, axis: 'x' | 'y'): Vec2 {
  // 'x' = flip horizontally (across vertical axis through cx)
  if (axis === 'x') return { x: 2 * cx - v.x, y: v.y };
  return { x: v.x, y: 2 * cy - v.y };
}

function offsetVec2(v: Vec2, dx: number, dy: number): Vec2 {
  return { x: v.x + dx, y: v.y + dy };
}

/** Deep-clone a pattern piece with new ids and optional translation. */
/**
 * Carry seam allowance overrides onto a copy: they are keyed by the id of the
 * point an edge starts at, so a clone that renames its points renames the keys.
 */
export function remapSeamAllowance(
  allowance: PatternPiece['seamAllowance'],
  pointIdMap: Map<string, string>
): PatternPiece['seamAllowance'] {
  if (!allowance) return undefined;
  const edges: Record<string, number> = {};
  for (const [key, value] of Object.entries(allowance.edges ?? {})) {
    edges[pointIdMap.get(key) ?? key] = value;
  }
  return Object.keys(edges).length > 0
    ? { defaultCm: allowance.defaultCm, edges }
    : { defaultCm: allowance.defaultCm };
}

export function clonePatternPiece(
  piece: PatternPiece,
  makeId: () => string,
  offset: Vec2 = { x: 0, y: 0 }
): PatternPiece {
  const pointIdMap = new Map<string, string>();
  const cloneRing = (ring: BezierPoint[]): BezierPoint[] =>
    ring.map((pt) => {
      const id = makeId();
      pointIdMap.set(pt.id, id);
      return {
        id,
        anchor: offsetVec2(pt.anchor, offset.x, offset.y),
        handleIn: pt.handleIn ? offsetVec2(pt.handleIn, offset.x, offset.y) : null,
        handleOut: pt.handleOut ? offsetVec2(pt.handleOut, offset.x, offset.y) : null,
        handlesParallel: pt.handlesParallel,
      };
    });
  const points = cloneRing(piece.points);
  const holes = piece.holes?.map(cloneRing);
  return {
    id: makeId(),
    name: piece.name.endsWith(' copy') ? piece.name : `${piece.name} copy`,
    closed: piece.closed,
    points,
    holes: holes && holes.length > 0 ? holes : undefined,
    grainline: piece.grainline
      ? {
          from: offsetVec2(piece.grainline.from, offset.x, offset.y),
          to: offsetVec2(piece.grainline.to, offset.x, offset.y),
        }
      : undefined,
    seamAllowance: remapSeamAllowance(piece.seamAllowance, pointIdMap),
  };
}

/**
 * Mirror-duplicate a piece across a vertical ('x') or horizontal ('y') axis
 * through its centroid, then nudge so it sits beside the original.
 */
export function mirrorClonePatternPiece(
  piece: PatternPiece,
  axis: 'x' | 'y',
  makeId: () => string,
  gapCm = 2
): PatternPiece {
  const box = anchorsBounds(piece.points);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;

  const pointIdMap = new Map<string, string>();
  // Every ring mirrors the same way: across the axis, then reversed with its
  // handles swapped, because mirroring turns the winding of each ring over.
  const mirrorRing = (ring: BezierPoint[]): BezierPoint[] => {
    const mirrored: BezierPoint[] = ring.map((pt) => {
      const id = makeId();
      pointIdMap.set(pt.id, id);
      return {
        id,
        anchor: mirrorVec2(pt.anchor, cx, cy, axis),
        handleIn: pt.handleIn ? mirrorVec2(pt.handleIn, cx, cy, axis) : null,
        handleOut: pt.handleOut ? mirrorVec2(pt.handleOut, cx, cy, axis) : null,
        handlesParallel: pt.handlesParallel,
      };
    });
    mirrored.reverse();
    for (const pt of mirrored) {
      const tmp = pt.handleIn;
      pt.handleIn = pt.handleOut;
      pt.handleOut = tmp;
    }
    return mirrored;
  };

  const mirroredPts = mirrorRing(piece.points);
  const mirroredHoles = piece.holes?.map(mirrorRing);

  const mirroredBox = anchorsBounds(mirroredPts);
  let dx = 0;
  let dy = 0;
  if (axis === 'x') {
    // Place to the right of the original
    dx = box.maxX - mirroredBox.minX + gapCm;
  } else {
    dy = box.maxY - mirroredBox.minY + gapCm;
  }

  const offsetRing = (ring: BezierPoint[]) => {
    for (const pt of ring) {
      pt.anchor = offsetVec2(pt.anchor, dx, dy);
      if (pt.handleIn) pt.handleIn = offsetVec2(pt.handleIn, dx, dy);
      if (pt.handleOut) pt.handleOut = offsetVec2(pt.handleOut, dx, dy);
    }
  };
  offsetRing(mirroredPts);
  for (const ring of mirroredHoles ?? []) offsetRing(ring);

  let grainline = piece.grainline;
  if (grainline) {
    grainline = {
      from: offsetVec2(mirrorVec2(grainline.from, cx, cy, axis), dx, dy),
      to: offsetVec2(mirrorVec2(grainline.to, cx, cy, axis), dx, dy),
    };
  }

  return {
    id: makeId(),
    name: `${piece.name} ${axis === 'x' ? '↔' : '↕'}`,
    closed: piece.closed,
    points: mirroredPts,
    holes: mirroredHoles && mirroredHoles.length > 0 ? mirroredHoles : undefined,
    grainline,
    // Mirroring reverses the winding, so the allowance travels with the points
    // it was set on rather than with the edge numbers.
    seamAllowance: remapSeamAllowance(piece.seamAllowance, pointIdMap),
  };
}

/** Unit inward normal for edge AB (toward piece interior). */
export function edgeInwardNormal(a: Vec2, b: Vec2, interiorHint: Vec2): Vec2 {
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  const ux = tx / len;
  const uy = ty / len;
  // Left of directed edge
  let nx = -uy;
  let ny = ux;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const toHint = { x: interiorHint.x - mid.x, y: interiorHint.y - mid.y };
  if (nx * toHint.x + ny * toHint.y < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

/** Default single-point dart: length to apex, intake width at the edge (cm). */
export const DART_LENGTH_CM = 4;
export const DART_INTAKE_CM = 2;

export type DartInsertResult =
  | { ok: true; apexId: string; legIds: [string, string] }
  | { ok: false; reason: string };

/**
 * Insert a single-point dart (V-notch) into a closed piece outline at the
 * nearest perimeter location to `click`. The apex lies `lengthCm` inward;
 * legs meet the edge `intakeCm` apart (classic pattern dart geometry).
 */
export function insertDartOnPiece(
  points: BezierPoint[],
  closed: boolean,
  click: Vec2,
  makeId: () => string,
  lengthCm = DART_LENGTH_CM,
  intakeCm = DART_INTAKE_CM
): DartInsertResult {
  if (!closed || points.length < 3) {
    return { ok: false, reason: 'Dart needs a closed pattern piece' };
  }
  const hit = findNearestEdge(points, closed, click);
  if (!hit) return { ok: false, reason: 'No edge under click' };

  const n = points.length;
  const a = points[hit.edgeIndex];
  const b = points[(hit.edgeIndex + 1) % n];
  const ax = a.anchor.x;
  const ay = a.anchor.y;
  const bx = b.anchor.x;
  const by = b.anchor.y;
  const edgeLen = Math.hypot(bx - ax, by - ay);
  if (edgeLen < intakeCm + 0.4) {
    return { ok: false, reason: 'Edge too short for dart intake' };
  }

  const ux = (bx - ax) / edgeLen;
  const uy = (by - ay) / edgeLen;
  // Place mouth center on the chord, clamped so both legs fit on the edge
  let along = hit.t * edgeLen;
  const half = Math.min(intakeCm / 2, (edgeLen - 0.2) / 2);
  along = Math.max(half + 0.05, Math.min(edgeLen - half - 0.05, along));
  const mouth = { x: ax + ux * along, y: ay + uy * along };
  const legA = { x: mouth.x - ux * half, y: mouth.y - uy * half };
  const legB = { x: mouth.x + ux * half, y: mouth.y + uy * half };

  const interior = averagePoint(points.map((p) => p.anchor));
  const inward = edgeInwardNormal(a.anchor, b.anchor, interior);
  const apex = {
    x: mouth.x + inward.x * lengthCm,
    y: mouth.y + inward.y * lengthCm,
  };

  // Apex should land inside the piece; flip if the winding hint was wrong
  const poly = pieceToPolyline(points, true);
  if (!pointInPolygon(apex, poly)) {
    apex.x = mouth.x - inward.x * lengthCm;
    apex.y = mouth.y - inward.y * lengthCm;
    if (!pointInPolygon(apex, poly)) {
      return { ok: false, reason: 'Could not place dart apex inside piece' };
    }
  }

  const mkCorner = (anchor: Vec2, id: string): BezierPoint => ({
    id,
    anchor: { ...anchor },
    handleIn: null,
    handleOut: null,
    handlesParallel: false,
  });

  const idLegA = makeId();
  const idApex = makeId();
  const idLegB = makeId();

  // Split the edge: … → a → legA → apex → legB → b → …
  a.handleOut = null;
  b.handleIn = null;
  points.splice(
    hit.edgeIndex + 1,
    0,
    mkCorner(legA, idLegA),
    mkCorner(apex, idApex),
    mkCorner(legB, idLegB)
  );

  return { ok: true, apexId: idApex, legIds: [idLegA, idLegB] };
}
