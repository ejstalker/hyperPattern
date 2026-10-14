import {
  formatLength,
  type MeasureAnchor,
  type MeasureItem,
  type PatternMeasure,
  type PatternPiece,
  type UnitDisplay,
  type Vec2,
} from '../project/types';
import {
  dist,
  edgeIndexForPointIds,
  edgeIsStraight,
  edgeLengthByPointIds,
  edgeHandles,
  pieceToPolyline,
  pointInPolygon,
  pointOnEdgeAtT,
  sampleCubic,
} from './geometry';

/**
 * Reading a `PatternMeasure`: turning what it points at into lengths, in cm, as
 * the pattern stands right now. Pure functions only — the editor owns the DOM.
 *
 * Everything here resolves *through the piece*, never from a stored coordinate,
 * which is what makes a measurement follow the pattern: drag an outline and its
 * measurements are already reading the new shape.
 */

/** How finely an edge is walked when hunting for a crossing, and how finely the
 * crossing is then refined. Tuned for drafting tolerance, not for exactness. */
const EDGE_SCAN_STEPS = 24;
const REFINE_ITERATIONS = 18;

/** Two crossings closer than this (in cm) are the same crossing. */
const SAME_CROSSING_CM = 1e-4;

function pieceById(pieces: readonly PatternPiece[], pieceId: string): PatternPiece | null {
  return pieces.find((piece) => piece.id === pieceId) ?? null;
}

/**
 * Where an anchor sits right now, or null when what it points at is gone —
 * a deleted piece, a deleted point, or an edge that an edit has split.
 */
export function resolveMeasureAnchor(
  pieces: readonly PatternPiece[],
  anchor: MeasureAnchor
): Vec2 | null {
  const piece = pieceById(pieces, anchor.pieceId);
  if (!piece) return null;
  if (anchor.kind === 'point') {
    const pt = piece.points.find((candidate) => candidate.id === anchor.pointId);
    return pt ? { ...pt.anchor } : null;
  }
  // The fraction is clamped, so an anchor always lands on the edge even if the
  // stored value came in from outside the range.
  return pointOnEdgeAtT(piece, anchor.fromPointId, anchor.toPointId, anchor.t);
}

/** The arc midpoint of an item, and its length in cm — or null when stale. */
export function measureItemSpan(
  pieces: readonly PatternPiece[],
  item: MeasureItem
): { a: Vec2; b: Vec2; mid: Vec2; lengthCm: number } | null {
  if (item.kind === 'edge') {
    const piece = pieceById(pieces, item.pieceId);
    if (!piece) return null;
    const idx = edgeIndexForPointIds(piece, item.fromPointId, item.toPointId);
    if (idx === null) return null;
    const n = piece.points.length;
    const from = piece.points[idx];
    const to = piece.points[(idx + 1) % n];
    const a = { ...from.anchor };
    const b = { ...to.anchor };
    const mid = pointOnEdgeAtT(piece, item.fromPointId, item.toPointId, 0.5) ?? {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
    return { a, b, mid, lengthCm: edgeLengthByPointIds(piece, item.fromPointId, item.toPointId) };
  }

  const a = resolveMeasureAnchor(pieces, item.a);
  const b = resolveMeasureAnchor(pieces, item.b);
  if (!a || !b) return null;
  return { a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, lengthCm: dist(a, b) };
}

export type MeasureReading = {
  /** Summed length in cm. */
  totalCm: number;
  /** Items that read something. */
  live: number;
  /** Items whose piece or edge is gone, so they contribute nothing. */
  stale: number;
};

/** The whole measurement, as it stands. */
export function measureReading(
  pieces: readonly PatternPiece[],
  measure: PatternMeasure
): MeasureReading {
  let totalCm = 0;
  let live = 0;
  let stale = 0;
  for (const item of measure.items) {
    const span = measureItemSpan(pieces, item);
    if (!span) {
      stale += 1;
      continue;
    }
    live += 1;
    totalCm += span.lengthCm;
  }
  return { totalCm, live, stale };
}

/** The readout: the summed value, with a marker when part of it is missing. */
export function measureLabelText(
  reading: MeasureReading,
  unit: UnitDisplay,
  measure: PatternMeasure
): { primary: string; secondary: string } {
  const shown = formatLength(reading.totalCm, unit, 1);
  const primary = reading.stale > 0 ? `${shown} — incomplete` : shown;
  // A sum says what it totals rather than listing parts that are already
  // dimensioned on their own readouts.
  if (measure.sumOf && measure.sumOf > 1) {
    return { primary, secondary: `sum of ${measure.sumOf}` };
  }
  const edges = measure.items.filter((item) => item.kind === 'edge').length;
  const spans = measure.items.length - edges;
  const parts: string[] = [];
  if (spans > 0) parts.push(`${spans} span${spans === 1 ? '' : 's'}`);
  if (edges > 0) parts.push(`${edges} edge${edges === 1 ? '' : 's'}`);
  return {
    primary,
    secondary: parts.length > 0 ? parts.join(' + ') : 'nothing picked',
  };
}

/**
 * Which edges and which points the measurement reads, so hovering the value can
 * light them up.
 */
export type MeasureReferences = {
  edges: Array<{ pieceId: string; fromPointId: string; toPointId: string }>;
  points: Array<{ pieceId: string; pointId: string }>;
};

export function measureReferences(measure: PatternMeasure): MeasureReferences {
  const edges: MeasureReferences['edges'] = [];
  const points: MeasureReferences['points'] = [];
  // Keyed by the edge's identity alone: the highlight is the edge, so two
  // measure points on one edge still light it up once.
  const seenEdge = new Set<string>();
  const addEdge = (edge: MeasureReferences['edges'][number]): void => {
    const key = `${edge.pieceId}\u0000${edge.fromPointId}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push(edge);
  };
  for (const item of measure.items) {
    if (item.kind === 'edge') {
      addEdge(item);
      continue;
    }
    for (const anchor of [item.a, item.b]) {
      if (anchor.kind === 'point') {
        points.push({ pieceId: anchor.pieceId, pointId: anchor.pointId });
      } else {
        addEdge({
          pieceId: anchor.pieceId,
          fromPointId: anchor.fromPointId,
          toPointId: anchor.toPointId,
        });
      }
    }
  }
  return { edges, points };
}

/** Every anchor a measurement reads, resolved — for placing its readout. */
export function measureAnchorPoints(
  pieces: readonly PatternPiece[],
  measure: PatternMeasure
): Vec2[] {
  const out: Vec2[] = [];
  for (const item of measure.items) {
    if (item.kind === 'edge') {
      const piece = pieceById(pieces, item.pieceId);
      if (!piece) continue;
      const mid = pointOnEdgeAtT(piece, item.fromPointId, item.toPointId, 0.5);
      if (mid) out.push(mid);
      continue;
    }
    for (const anchor of [item.a, item.b]) {
      const p = resolveMeasureAnchor(pieces, anchor);
      if (p) out.push(p);
    }
  }
  return out;
}

type Crossing = { pieceId: string; fromPointId: string; toPointId: string; t: number; point: Vec2; along: number };

/**
 * Where a drawn line crosses piece outlines, as measure points.
 *
 * Each crossing is stored as a fraction along the edge it landed on rather than
 * as a coordinate, so the point it puts on the pattern belongs to that edge and
 * rides it: move the edge and the measure point moves with it, staying at the
 * same relative position.
 */
export function measureLineSpans(
  pieces: readonly PatternPiece[],
  a: Vec2,
  b: Vec2
): MeasureItem[] {
  const along = { x: b.x - a.x, y: b.y - a.y };
  const total = Math.hypot(along.x, along.y);
  if (!(total > 1e-6)) return [];

  const byPiece = new Map<string, Crossing[]>();
  for (const piece of pieces) {
    const n = piece.points.length;
    const edgeCount = piece.closed ? n : Math.max(0, n - 1);
    const hits: Crossing[] = [];
    for (let i = 0; i < edgeCount; i++) {
      const from = piece.points[i];
      const to = piece.points[(i + 1) % n];
      for (const t of crossEdge(piece, from, to, a, along)) {
        hits.push({
          pieceId: piece.id,
          fromPointId: from.id,
          toPointId: to.id,
          t,
          point: pointOnEdgeAtT(piece, from.id, to.id, t) ?? a,
          along: 0,
        });
      }
    }
    if (hits.length === 0) continue;
    // Order along the line. Two edges meeting at a shared vertex both report the
    // same crossing, so that it is one measure point rather than two; the
    // duplicate is dropped after sorting, where the two are neighbours.
    for (const hit of hits) {
      hit.along = ((hit.point.x - a.x) * along.x + (hit.point.y - a.y) * along.y) / total;
    }
    hits.sort((first, second) => first.along - second.along);
    const unique: Crossing[] = [];
    for (const hit of hits) {
      const previous = unique[unique.length - 1];
      if (previous && dist(previous.point, hit.point) <= SAME_CROSSING_CM) continue;
      unique.push(hit);
    }
    byPiece.set(piece.id, unique);
  }

  const spans: MeasureItem[] = [];
  for (const piece of pieces) {
    const hits = byPiece.get(piece.id);
    if (!hits) continue;
    // The line alternates outside/inside as it crosses a piece, so the crossings
    // pair up into the stretches that lie *within* a piece — entry to exit — and
    // the stretch of empty canvas between two pieces is measured by neither.
    // Knowing which side the drawn line starts on says where the pairing begins.
    const startsInside = pointInPolygon(a, pieceToPolyline(piece.points, piece.closed));
    for (let i = startsInside ? 1 : 0; i + 1 < hits.length; i += 2) {
      spans.push({ kind: 'span', a: anchorOf(hits[i]!), b: anchorOf(hits[i + 1]!) });
    }
  }
  return spans;
}

/** A crossing as a measure point: a fraction along the edge it landed on. */
function anchorOf(crossing: Crossing): MeasureAnchor {
  return {
    kind: 'edge',
    pieceId: crossing.pieceId,
    fromPointId: crossing.fromPointId,
    toPointId: crossing.toPointId,
    t: crossing.t,
  };
}

/**
 * The fractions along one edge where the line from `a` along `along` crosses it
 * (empty for no crossing). Straight edges are solved directly; curved ones are
 * walked and then refined, so the answer is on the curve rather than on the
 * chords that stand in for it.
 */
function crossEdge(
  piece: PatternPiece,
  from: PatternPiece['points'][number],
  to: PatternPiece['points'][number],
  a: Vec2,
  along: Vec2
): number[] {
  if (edgeIsStraight(from, to)) {
    const s = crossSegments(from.anchor, to.anchor, a, along);
    return s == null ? [] : [s];
  }
  const { c0, c1 } = edgeHandles(from, to);
  const samples = sampleCubic(from.anchor, c0, c1, to.anchor, EDGE_SCAN_STEPS);
  const span = 1 / EDGE_SCAN_STEPS;
  const out: number[] = [];
  for (let i = 0; i + 1 < samples.length; i++) {
    const s = crossSegments(samples[i]!, samples[i + 1]!, a, along);
    if (s == null) continue;
    out.push(refineCurveCrossing(from.anchor, c0, c1, to.anchor, a, along, (i + s) * span, span));
  }
  return out;
}

/** Fractions along two crossing segments. The value returned is along `p0`→`p1`;
 * null when they are parallel or do not meet within either segment. */
function crossSegments(p0: Vec2, p1: Vec2, a: Vec2, along: Vec2): number | null {
  const rx = p1.x - p0.x;
  const ry = p1.y - p0.y;
  // Edge direction crossed with the drawn line's: zero means parallel.
  const denom = along.x * ry - along.y * rx;
  if (Math.abs(denom) < 1e-12) return null;
  // `d` runs from the edge's start to the drawn line's start; solving
  // p0 + s·r = a + u·along for both parameters gives the two below.
  const dx = a.x - p0.x;
  const dy = a.y - p0.y;
  const s = (dy * along.x - dx * along.y) / denom;
  const u = (dy * rx - dx * ry) / denom;
  if (s < -1e-9 || s > 1 + 1e-9) return null;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  return Math.max(0, Math.min(1, s));
}

/**
 * Bisect the curve around the bracketing sample for the crossing. The curve is
 * sampled densely enough that a bracket holds one crossing, so bisection on the
 * signed side of the line converges on it.
 */
function refineCurveCrossing(
  p0: Vec2,
  c0: Vec2,
  c1: Vec2,
  p1: Vec2,
  a: Vec2,
  along: Vec2,
  t0: number,
  span: number
): number {
  const side = (x: number, y: number): number => (x - a.x) * along.y - (y - a.y) * along.x;
  const at = (t: number): Vec2 => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
      y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
    };
  };
  let lo = Math.max(0, t0 - span);
  let hi = Math.min(1, t0 + span);
  let loSide = side(at(lo).x, at(lo).y);
  let hiSide = side(at(hi).x, at(hi).y);
  if (loSide === 0) return lo;
  if (hiSide === 0) return hi;
  if (loSide * hiSide > 0) return Math.max(0, Math.min(1, t0));
  for (let i = 0; i < REFINE_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const midSide = side(at(mid).x, at(mid).y);
    if (midSide === 0) return mid;
    if (loSide * midSide < 0) {
      hi = mid;
      hiSide = midSide;
    } else {
      lo = mid;
      loSide = midSide;
    }
  }
  return (lo + hi) / 2;
}

/** Defensive load for measurements written by an older or hand-edited file. */
export function normalizeMeasures(raw: unknown): PatternMeasure[] {
  if (!Array.isArray(raw)) return [];
  const out: PatternMeasure[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as Partial<PatternMeasure>;
    if (typeof m.id !== 'string' || !m.id) continue;
    const label = m.label as Vec2 | undefined;
    if (!label || !Number.isFinite(label.x) || !Number.isFinite(label.y)) continue;
    const items = Array.isArray(m.items) ? m.items.filter(isMeasureItem) : [];
    if (items.length === 0) continue;
    const sumOf = Number.isFinite(m.sumOf) ? Math.max(0, Math.round(m.sumOf as number)) : undefined;
    out.push({
      id: m.id,
      label: { x: label.x, y: label.y },
      items,
      ...(sumOf && sumOf > 1 ? { sumOf } : {}),
    });
  }
  return out;
}

function isMeasureItem(raw: unknown): raw is MeasureItem {
  if (!raw || typeof raw !== 'object') return false;
  const item = raw as MeasureItem;
  if (item.kind === 'edge') {
    return (
      typeof item.pieceId === 'string' &&
      typeof item.fromPointId === 'string' &&
      typeof item.toPointId === 'string'
    );
  }
  if (item.kind === 'span') return isMeasureAnchor(item.a) && isMeasureAnchor(item.b);
  return false;
}

function isMeasureAnchor(raw: unknown): raw is MeasureAnchor {
  if (!raw || typeof raw !== 'object') return false;
  const anchor = raw as MeasureAnchor;
  if (typeof anchor.pieceId !== 'string') return false;
  if (anchor.kind === 'point') return typeof anchor.pointId === 'string';
  if (anchor.kind === 'edge') {
    return (
      typeof anchor.fromPointId === 'string' &&
      typeof anchor.toPointId === 'string' &&
      Number.isFinite(anchor.t)
    );
  }
  return false;
}
