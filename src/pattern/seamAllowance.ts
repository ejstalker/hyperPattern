import type { BezierPoint, PatternPiece, Vec2 } from '../project/types';
import { CM_PER_INCH } from '../project/types';
import {
  edgeHandles,
  edgeIsStraight,
  pieceEdgeAt,
  pieceEdgeNumber,
  pieceRings,
  ringEdgeCount,
  sampleCubic,
} from './geometry';
import { polygonArea } from './ringDraft';

/**
 * Seam allowance: the fabric left outside the seam line.
 *
 * A piece carries one allowance for all of its edges plus any number of per-edge
 * overrides — a neckline usually wants less than a side seam. The values live on
 * the piece (cm, like all pattern geometry) and an edge with no override of its
 * own reads the piece default, so a piece that has never been touched shows the
 * standard half inch without the document carrying a field for it.
 *
 * `seamAllowanceOutline` is the drawing half: it offsets every edge outward by
 * its own allowance and joins the results, which is the line a cutter would
 * follow. It is a visual aid — the mesh, the seams and the sewing all stay on
 * the seam line.
 */

/** The allowance a piece carries until it is set otherwise. */
export const DEFAULT_SEAM_ALLOWANCE_IN = 0.5;
export const DEFAULT_SEAM_ALLOWANCE_CM = DEFAULT_SEAM_ALLOWANCE_IN * CM_PER_INCH;

/** Nothing usable is wider than this, and a negative allowance turns the piece inside out. */
export const MAX_SEAM_ALLOWANCE_CM = 10;

export function clampSeamAllowance(cm: number): number {
  if (!Number.isFinite(cm)) return DEFAULT_SEAM_ALLOWANCE_CM;
  return Math.min(MAX_SEAM_ALLOWANCE_CM, Math.max(0, cm));
}

/** The allowance a piece's edges use when they have no override of their own. */
export function defaultSeamAllowanceCm(piece: PatternPiece): number {
  return clampSeamAllowance(piece.seamAllowance?.defaultCm ?? DEFAULT_SEAM_ALLOWANCE_CM);
}

/**
 * The edge that starts at `edgeIndex` is identified by that point's id: an edge
 * runs from its point to the next one in winding order, so the key is the edge
 * and it survives inserts and deletes elsewhere on the piece.
 */
export function allowanceEdgeKey(piece: PatternPiece, edgeIndex: number): string | null {
  if (!piece.closed) return null;
  return pieceEdgeAt(piece, edgeIndex)?.from.id ?? null;
}

/** The allowance one edge uses: its own override, or the piece's. */
export function allowanceForEdge(piece: PatternPiece, edgeIndex: number): number {
  const key = allowanceEdgeKey(piece, edgeIndex);
  const override = key ? piece.seamAllowance?.edges?.[key] : undefined;
  return override == null ? defaultSeamAllowanceCm(piece) : clampSeamAllowance(override);
}

/** Is this edge carrying an override of its own, rather than the piece default? */
export function edgeHasOwnAllowance(piece: PatternPiece, edgeIndex: number): boolean {
  const key = allowanceEdgeKey(piece, edgeIndex);
  return !!key && piece.seamAllowance?.edges?.[key] != null;
}

/** Set one edge's allowance. `null` hands the edge back to the piece default. */
export function setEdgeAllowance(piece: PatternPiece, edgeIndex: number, cm: number | null): void {
  const key = allowanceEdgeKey(piece, edgeIndex);
  if (!key) return;
  if (cm == null) {
    const edges = piece.seamAllowance?.edges;
    if (!edges) return;
    delete edges[key];
    if (Object.keys(edges).length === 0 && piece.seamAllowance) {
      delete piece.seamAllowance.edges;
    }
    return;
  }
  const allowance = piece.seamAllowance ?? seedAllowance(piece);
  allowance.edges = { ...allowance.edges, [key]: clampSeamAllowance(cm) };
}

function seedAllowance(piece: PatternPiece): NonNullable<PatternPiece['seamAllowance']> {
  const allowance = piece.seamAllowance ?? { defaultCm: DEFAULT_SEAM_ALLOWANCE_CM };
  piece.seamAllowance = allowance;
  return allowance;
}

/** Set the piece-wide allowance. Edges with overrides of their own keep them. */
export function setPieceAllowance(piece: PatternPiece, cm: number): void {
  seedAllowance(piece).defaultCm = clampSeamAllowance(cm);
}

/** Give every edge of the piece the same allowance, dropping the overrides. */
export function setEveryEdgeAllowance(piece: PatternPiece, cm: number): void {
  const allowance = seedAllowance(piece);
  allowance.defaultCm = clampSeamAllowance(cm);
  delete allowance.edges;
}

// ── The outline ─────────────────────────────────────────────────────────────

/** Flattening steps for a curved edge; straight ones need a single segment. */
const CURVE_STEPS = 16;
/** A mitre longer than this many allowances is bevelled instead of spiked. */
const MITER_LIMIT = 4;

type Segment = { a: Vec2; b: Vec2; offset: number; nx: number; ny: number };

/**
 * One seam segment with its outward normal. `winding` is +1 for a ring that
 * reads positive (clockwise with y down), the direction that makes the normal
 * point away from the piece.
 */
function segment(a: Vec2, b: Vec2, offset: number, winding: number): Segment | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { a, b, offset, nx: (dy / len) * winding, ny: (-dx / len) * winding };
}

function shiftedPoint(p: Vec2, seg: Segment): Vec2 {
  return { x: p.x + seg.nx * seg.offset, y: p.y + seg.ny * seg.offset };
}

/**
 * Where two shifted segments cross, when a mitre is the right join for them.
 * Parallel lines (a step between collinear edges) and mitres that shoot off into
 * a spike both fall back to a bevel.
 */
function mitrePoint(prev: Segment, cur: Segment): Vec2 | null {
  const p = shiftedPoint(prev.b, prev);
  const q = shiftedPoint(cur.a, cur);
  const d1x = prev.b.x - prev.a.x;
  const d1y = prev.b.y - prev.a.y;
  const d2x = cur.b.x - cur.a.x;
  const d2y = cur.b.y - cur.a.y;
  const denom = d1x * d2y - d1y * d2x;
  const scale = Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y);
  if (scale < 1e-12 || Math.abs(denom) < 1e-6 * scale) return null;
  const t = ((q.x - p.x) * d2y - (q.y - p.y) * d2x) / denom;
  const join = { x: p.x + d1x * t, y: p.y + d1y * t };
  const limit = MITER_LIMIT * Math.max(prev.offset, cur.offset) + 1e-6;
  if (Math.hypot(join.x - p.x, join.y - p.y) > limit) return null;
  return join;
}

function samplesOfEdge(piece: PatternPiece, edgeIndex: number): Vec2[] {
  const edge = pieceEdgeAt(piece, edgeIndex);
  if (!edge) return [];
  const a = edge.from;
  const b = edge.to;
  if (edgeIsStraight(a, b)) return [a.anchor, b.anchor];
  const { c0, c1 } = edgeHandles(a, b);
  return sampleCubic(a.anchor, c0, c1, b.anchor, CURVE_STEPS);
}

/** Every seam segment of one ring, flattened, in that ring's winding order. */
function segmentsOfRing(piece: PatternPiece, ringIndex: number): Segment[] {
  const ring = pieceRings(piece)[ringIndex];
  if (!ring) return [];
  const winding = outwardWinding(ring, ringIndex > 0);
  const out: Segment[] = [];
  const edgeCount = ringEdgeCount(piece, ringIndex);
  for (let i = 0; i < edgeCount; i++) {
    const edgeNumber = pieceEdgeNumber(piece, ringIndex, i);
    const offset = allowanceForEdge(piece, edgeNumber);
    const samples = samplesOfEdge(piece, edgeNumber);
    for (let j = 0; j + 1 < samples.length; j++) {
      const seg = segment(samples[j], samples[j + 1], offset, winding);
      if (seg) out.push(seg);
    }
  }
  return out;
}

/**
 * Which way is out for a ring: the sign that makes a segment's normal point off
 * the cloth. For the outline that is away from the piece; for a hole it is the
 * other way about, because the cloth lies *outside* a hole — the allowance
 * around a hole runs into the hole, making the opening bigger, exactly as an
 * allowance along the outline runs off the edge of the panel.
 */
function outwardWinding(ring: BezierPoint[], isHole = false): number {
  const sign = polygonArea(ring.map((pt) => pt.anchor)) >= 0 ? 1 : -1;
  return isHole ? -sign : sign;
}

/** One ring's allowance line, mitred at every joiner. */
function allowanceRingFor(piece: PatternPiece, ringIndex: number): Vec2[] {
  const segments = segmentsOfRing(piece, ringIndex);
  if (segments.length < 3) return [];
  const out: Vec2[] = [];
  for (let i = 0; i < segments.length; i++) {
    const prev = segments[(i - 1 + segments.length) % segments.length];
    const cur = segments[i];
    const join = mitrePoint(prev, cur);
    if (join) {
      out.push(join);
    } else {
      // Bevel: keep both ends. That is a step where the two allowances differ
      // and a harmless pair of coincident points where they do not.
      out.push(shiftedPoint(prev.b, prev), shiftedPoint(cur.a, cur));
    }
  }
  return dedupe(out);
}

function dedupe(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-7 && Math.abs(last.y - p.y) < 1e-7) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(last.x - first.x) < 1e-7 && Math.abs(last.y - first.y) < 1e-7) out.pop();
    else break;
  }
  return out;
}

/**
 * The allowance line for a piece: each edge pushed out by its own allowance, with
 * the joins mitred so a change of allowance at a corner reads as a step in the
 * line. Empty for anything with no inside to be outside of (an open or
 * degenerate piece).
 */
export function seamAllowanceOutline(piece: PatternPiece): Vec2[] {
  return seamAllowanceRings(piece)[0] ?? [];
}

/**
 * The allowance line for every contour of the piece: the outline's clock-wise
 * ring first, then one per hole. A hole's allowance runs *into* the hole, so the
 * ring drawn for it is the opening the cutter follows rather than the seam line.
 */
export function seamAllowanceRings(piece: PatternPiece): Vec2[][] {
  if (!piece.closed || piece.points.length < 3) return [];
  const rings: Vec2[][] = [];
  for (let r = 0; r < pieceRings(piece).length; r++) {
    const ring = allowanceRingFor(piece, r);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** The allowance ring as an SVG path. */
export function allowanceRingPath(ring: readonly Vec2[]): string {
  if (ring.length < 3) return '';
  let d = `M ${ring[0].x} ${ring[0].y}`;
  for (let i = 1; i < ring.length; i++) d += ` L ${ring[i].x} ${ring[i].y}`;
  return `${d} Z`;
}

/**
 * One edge's own allowance, shifted out: what is stroked when that edge is
 * hovered or picked, so the offset can be seen against the seam line it belongs
 * to. The ends are not mitred — it highlights an edge, not a ring.
 */
export function allowanceSpanForEdge(piece: PatternPiece, edgeIndex: number): Vec2[] {
  if (!piece.closed || piece.points.length < 2) return [];
  const edge = pieceEdgeAt(piece, edgeIndex);
  if (!edge) return [];
  const offset = allowanceForEdge(piece, edgeIndex);
  const samples = samplesOfEdge(piece, edgeIndex);
  if (samples.length < 2) return [];
  const winding = outwardWinding(edge.ring, edge.ringIndex > 0);
  const out: Vec2[] = [];
  for (let j = 0; j + 1 < samples.length; j++) {
    const seg = segment(samples[j], samples[j + 1], offset, winding);
    if (seg) out.push(shiftedPoint(seg.a, seg));
  }
  const tail = segment(samples[samples.length - 2], samples[samples.length - 1], offset, winding);
  if (tail) out.push(shiftedPoint(samples[samples.length - 1], tail));
  return out;
}
