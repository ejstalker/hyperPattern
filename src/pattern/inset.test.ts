/**
 * The inset loop.
 *
 * It is the ring scaled down about its own centre, which is the whole point of
 * it: a smaller *version* of the piece rather than a line held a fixed distance
 * from its edge. What these tests hold it to is exactly that — the proportions
 * and the ratios of curvature survive the scaling, the pointer sets the size, and
 * a loop with nowhere to go is refused rather than handed back.
 */
import { describe, expect, it } from 'vitest';
import { insetGap, insetScaleThrough, loopFitsOnCloth, ringFromCircle, scaleRing } from './inset';
import { pieceToPolyline, polygonCentroid } from './geometry';
import { circlePiece, ellipsePiece, rectPiece } from '../project/createDefault';
import type { BezierPoint, PatternPiece, Vec2 } from '../project/types';

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Dense samples of a ring, for measuring what it actually draws. */
const samples = (ring: BezierPoint[], steps = 32): Vec2[] => pieceToPolyline(ring, true, steps);

/**
 * How far a point sits from a ring, edge and all. Straight edges come back from
 * `pieceToPolyline` as their endpoints alone, so measuring corner to corner would
 * call the middle of an edge far away.
 */
function distanceToRing(ring: BezierPoint[], p: Vec2): number {
  const edge = samples(ring, 48);
  let best = Infinity;
  for (let i = 0; i < edge.length; i++) {
    const a = edge[i]!;
    const b = edge[(i + 1) % edge.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

const box = (ring: BezierPoint[]) => {
  const pts = samples(ring);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
    minX: Math.min(...xs),
    minY: Math.min(...ys),
  };
};

describe('insetting a ring', () => {
  it('keeps a panel’s proportions, however far in it goes', () => {
    const piece = rectPiece('Panel', 40, 20);
    const centre = polygonCentroid(samples(piece.points));
    for (const factor of [0.9, 0.6, 0.25]) {
      const loop = scaleRing(piece.points, factor, centre);
      const outer = box(piece.points);
      const inner = box(loop);
      // A uniform offset of 40 × 20 by any distance cannot keep 2:1; a scaled copy
      // cannot lose it. This is the difference the inset is asked to make.
      expect(inner.w / inner.h).toBeCloseTo(outer.w / outer.h, 6);
      expect(inner.w).toBeCloseTo(outer.w * factor, 6);
      expect(inner.h).toBeCloseTo(outer.h * factor, 6);
    }
  });

  it('holds the ratio between two bends of different tightness', () => {
    // A 3:1 ellipse: the tight end and the flat side have radii in a fixed ratio,
    // and a scaled copy keeps it — which an offset cannot, because taking the same
    // distance off both bends leaves them unequal in proportion.
    const piece = ellipsePiece('Long', 0, 0, 30, 10);
    const centre = polygonCentroid(samples(piece.points, 64));
    const loop = scaleRing(piece.points, 0.5, centre);
    const radiiOf = (ring: BezierPoint[]) =>
      ring.map((pt) => dist(pt.anchor, centre)).sort((a, b) => a - b);
    const outer = radiiOf(piece.points);
    const inner = radiiOf(loop);
    for (let i = 0; i < outer.length; i++) {
      expect(inner[i]! / outer[i]!).toBeCloseTo(0.5, 6);
    }
  });

  it('carries a circle in to a circle', () => {
    const piece = circlePiece('Round', 100, 50, 20);
    const centre = polygonCentroid(samples(piece.points, 64));
    expect(centre.x).toBeCloseTo(100, 6);
    expect(centre.y).toBeCloseTo(50, 6);
    for (const factor of [0.9, 0.5, 0.1]) {
      const loop = scaleRing(piece.points, factor, centre);
      for (const p of samples(loop, 64)) {
        // Within a tenth of a percent of the exact circle: the loop is the smaller
        // circle, not a polygon standing in for one, and scaling cannot drift it.
        const radius = dist(p, { x: 100, y: 50 });
        expect(Math.abs(radius - 20 * factor) / (20 * factor)).toBeLessThan(1e-3);
      }
    }
  });

  it('sizes the loop through the pointer, in and out', () => {
    const piece = rectPiece('Panel', 40, 20);
    const centre = polygonCentroid(samples(piece.points));
    expect(centre).toEqual({ x: 20, y: 10 });
    const at = (t: number): Vec2 => ({ x: 20, y: 10 - 10 * t });
    // A point on the edge is the outline itself; half way in is half the size.
    expect(insetScaleThrough(piece.points, centre, at(0.5))).toBeCloseTo(0.5, 6);
    expect(insetScaleThrough(piece.points, centre, at(0.75))).toBeCloseTo(0.75, 6);
    // Further in is a smaller loop; nearer the edge is a bigger one.
    expect(insetScaleThrough(piece.points, centre, at(0.35))).toBeLessThan(0.5);
    expect(insetScaleThrough(piece.points, centre, at(0.9))).toBeGreaterThan(0.5);
    // And the loop really does pass through the point it was sized by.
    const scale = insetScaleThrough(piece.points, centre, at(0.5))!;
    const loop = scaleRing(piece.points, scale, centre);
    expect(distanceToRing(loop, at(0.5))).toBeLessThan(0.01);
  });

  it('refuses a pointer the loop could not pass through', () => {
    const piece = rectPiece('Panel', 40, 20);
    const centre = polygonCentroid(samples(piece.points));
    // On the outline itself (that is the piece, not an inset of it)…
    expect(insetScaleThrough(piece.points, centre, { x: 20, y: 0 })).toBeNull();
    // …outside it, and at the very centre, where no copy is left.
    expect(insetScaleThrough(piece.points, centre, { x: 90, y: 10 })).toBeNull();
    expect(insetScaleThrough(piece.points, centre, centre)).toBeNull();
  });

  it('reads how far in the loop runs at its tightest', () => {
    const piece = rectPiece('Panel', 40, 20);
    const centre = polygonCentroid(samples(piece.points));
    const loop = scaleRing(piece.points, 0.5, centre);
    // Halving a 40 × 20 panel leaves 10 cm of panel above the loop and 5 to the side.
    expect(insetGap(piece.points, loop)).toBeCloseTo(5, 1);
  });

  it('leaves a loop the piece can carry, and only such a loop', () => {
    const piece: PatternPiece = circlePiece('Round', 0, 0, 20);
    const centre = polygonCentroid(samples(piece.points));
    const good = scaleRing(piece.points, 0.5, centre);
    expect(loopFitsOnCloth(piece, good)).toBe(true);
    // A loop that runs off the cloth is not a hole the piece could hold.
    const stray = good.map((pt, i) => (i === 0 ? { ...pt, anchor: { x: 100, y: 100 } } : pt));
    expect(loopFitsOnCloth(piece, stray)).toBe(false);
    expect(loopFitsOnCloth(piece, [])).toBe(false);
  });

  it('builds a circle cut out of a panel as a circle', () => {
    const ring = ringFromCircle({ center: { x: 5, y: 5 }, radius: 10 }, (() => {
      let n = 0;
      return () => `id${++n}`;
    })());
    expect(ring).toHaveLength(4);
    for (const p of samples(ring, 64)) {
      expect(Math.abs(dist(p, { x: 5, y: 5 }) - 10) / 10).toBeLessThan(1e-3);
    }
  });
});
