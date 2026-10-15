import type { BezierPoint, PatternPiece, Vec2 } from '../project/types';
import { cloneBezierPoint, edgeHandles, pointInCloth, ringToPolyline, sampleCubic } from './geometry';
import { polygonArea } from './ringDraft';

/**
 * The inset loop: the ring's own contour, scaled down about its centre.
 *
 * Deliberately a *similar* shape rather than a uniform offset. An offset moves
 * every edge in by the same distance, which quietly changes the proportions —
 * take 2 cm off every side of a 40 × 20 panel and you get 36 × 16, no longer the
 * same panel at all, and on a curve of varying tightness the bends come out
 * wrong relative to each other. A scaled copy keeps every proportion and every
 * ratio of curvature exactly, so the loop reads as a smaller version of the
 * piece — which is what an inset is for: the facing, the lining, the stitch line
 * drawn a little way inside the edge, recognisably the shape it came from.
 *
 * It is exact, too, rather than near: scaling a cubic's anchors and handles about
 * a point scales the whole curve about that point, so a round panel gives a
 * round loop to the last decimal and a shaped edge keeps its shape.
 */

/** Handle length of a quarter-circle cubic, as a share of the radius. */
const BEZIER_CIRCLE_K = 0.5522847498;

/** A loop closer in than this to the outline is the outline: no cut at all. */
export const MIN_INSET_SCALE = 0.02;

/** The ring scaled about `centre`: the similar shape, `factor` of the size. */
export function scaleRing(ring: BezierPoint[], factor: number, centre: Vec2): BezierPoint[] {
  const about = (v: Vec2): Vec2 => ({
    x: centre.x + (v.x - centre.x) * factor,
    y: centre.y + (v.y - centre.y) * factor,
  });
  return ring.map((pt) => ({
    id: pt.id,
    anchor: about(pt.anchor),
    handleIn: pt.handleIn ? about(pt.handleIn) : null,
    handleOut: pt.handleOut ? about(pt.handleOut) : null,
    handlesParallel: pt.handlesParallel,
  }));
}

/**
 * Where a ray from `origin` leaves a closed polyline, as a distance along it: the
 * outermost crossing, which is the boundary as seen from the origin. Null when
 * the ray misses the shape altogether.
 */
function rayReach(poly: readonly Vec2[], origin: Vec2, dir: Vec2): number | null {
  let farthest: number | null = null;
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len;
  const uy = dir.y / len;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    // Where the ray meets the edge: t along the edge, from the cross product of
    // both sides with the ray's direction.
    const den = ex * uy - ey * ux;
    if (Math.abs(den) < 1e-12) continue;
    const t = -((a.x - origin.x) * uy - (a.y - origin.y) * ux) / den;
    if (t < 0 || t > 1) continue;
    const s = (a.x + ex * t - origin.x) * ux + (a.y + ey * t - origin.y) * uy;
    if (s <= 0) continue;
    if (farthest === null || s > farthest) farthest = s;
  }
  return farthest;
}

/**
 * The scale whose copy of `ring` passes through `p` — so the loop runs through
 * the pointer and moving the pointer in and out sizes the loop, while the shape
 * stays the shape. Null when the pointer is not inside the ring, or is so near
 * its centre that there is no sensible copy left.
 */
export function insetScaleThrough(ring: BezierPoint[], centre: Vec2, p: Vec2): number | null {
  const poly = ringToPolyline(ring);
  const reach = rayReach(poly, centre, { x: p.x - centre.x, y: p.y - centre.y });
  if (reach === null) return null;
  const distance = Math.hypot(p.x - centre.x, p.y - centre.y);
  const scale = distance / reach;
  if (!Number.isFinite(scale) || scale <= MIN_INSET_SCALE || scale >= 1) return null;
  return scale;
}

/**
 * How far inside the outline the loop runs, at its tightest — the number a
 * draftsperson wants when the loop is a facing depth: the smallest gap between
 * the two contours, measured along the loop.
 */
export function insetGap(outline: BezierPoint[], loop: BezierPoint[]): number {
  const edge = ringToPolyline(outline);
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    const { c0, c1 } = edgeHandles(a, b);
    for (const sample of sampleCubic(a.anchor, c0, c1, b.anchor, 12)) {
      for (let j = 0; j < edge.length; j++) {
        const s = edge[j]!;
        const e = edge[(j + 1) % edge.length]!;
        const dx = e.x - s.x;
        const dy = e.y - s.y;
        const lenSq = dx * dx + dy * dy;
        const t =
          lenSq < 1e-12
            ? 0
            : Math.max(0, Math.min(1, ((sample.x - s.x) * dx + (sample.y - s.y) * dy) / lenSq));
        best = Math.min(best, Math.hypot(sample.x - (s.x + dx * t), sample.y - (s.y + dy * t)));
      }
    }
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * A circle's rim as a ring of points: four cubic arcs, the handle length a
 * quarter-circle wants, so a circle cut out of a panel arrives as the same shape
 * as one drawn with the circle tool.
 */
export function ringFromCircle(
  circle: { center: Vec2; radius: number },
  makeId: () => string
): BezierPoint[] {
  const k = circle.radius * BEZIER_CIRCLE_K;
  const cx = circle.center.x;
  const cy = circle.center.y;
  const r = circle.radius;
  return [
    {
      id: makeId(),
      anchor: { x: cx + r, y: cy },
      handleIn: { x: cx + r, y: cy - k },
      handleOut: { x: cx + r, y: cy + k },
      handlesParallel: true,
    },
    {
      id: makeId(),
      anchor: { x: cx, y: cy + r },
      handleIn: { x: cx + k, y: cy + r },
      handleOut: { x: cx - k, y: cy + r },
      handlesParallel: true,
    },
    {
      id: makeId(),
      anchor: { x: cx - r, y: cy },
      handleIn: { x: cx - r, y: cy + k },
      handleOut: { x: cx - r, y: cy - k },
      handlesParallel: true,
    },
    {
      id: makeId(),
      anchor: { x: cx, y: cy - r },
      handleIn: { x: cx - k, y: cy - r },
      handleOut: { x: cx + k, y: cy - r },
      handlesParallel: true,
    },
  ];
}

/** A fresh copy of a ring, with IDs of its own. */
export function copyRing(ring: BezierPoint[], makeId: () => string): BezierPoint[] {
  return ring.map((pt) => cloneBezierPoint(pt, makeId));
}

/**
 * Is this loop a hole the piece could actually carry? Every part of it has to lie
 * on the cloth: inside the outline, outside whatever is already cut out, and with
 * room left over. A scaled copy of a shape that folds around itself can reach
 * outside the piece, so this is checked rather than assumed.
 */
export function loopFitsOnCloth(piece: PatternPiece, loop: BezierPoint[]): boolean {
  if (loop.length < 3) return false;
  if (Math.abs(polygonArea(loop.map((pt) => pt.anchor))) < 0.05) return false;
  const outline = ringToPolyline(piece.points);
  const holes = (piece.holes ?? []).map((ring) => ringToPolyline(ring));
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    const { c0, c1 } = edgeHandles(a, b);
    for (const p of sampleCubic(a.anchor, c0, c1, b.anchor, 8)) {
      if (!pointInCloth(p, outline, holes)) return false;
    }
  }
  return true;
}
