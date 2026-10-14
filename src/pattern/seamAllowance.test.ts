import { describe, expect, it } from 'vitest';
import { rectPiece, uid } from '../project/createDefault';
import type { BezierPoint, PatternPiece, Vec2 } from '../project/types';
import { clonePatternPiece, remapSeamAllowance } from './geometry';
import {
  DEFAULT_SEAM_ALLOWANCE_CM,
  DEFAULT_SEAM_ALLOWANCE_IN,
  MAX_SEAM_ALLOWANCE_CM,
  allowanceEdgeKey,
  allowanceForEdge,
  allowanceRingPath,
  allowanceSpanForEdge,
  clampSeamAllowance,
  defaultSeamAllowanceCm,
  edgeHasOwnAllowance,
  seamAllowanceOutline,
  setEdgeAllowance,
  setEveryEdgeAllowance,
  setPieceAllowance
} from './seamAllowance';

/** A 10 × 10 square, the way a rectangular panel is drafted. */
function square(): PatternPiece {
  return rectPiece('Panel', 10, 10, { x: 0, y: 0 });
}

/** A circle of `radius` as four cubic arcs, the way a round panel is drafted. */
function circle(radius = 10, arcs = 4): PatternPiece {
  const points: BezierPoint[] = [];
  const k = (4 / 3) * Math.tan(Math.PI / (2 * arcs)) * radius;
  for (let i = 0; i < arcs; i++) {
    const t = (i / arcs) * Math.PI * 2;
    const anchor = { x: Math.cos(t) * radius, y: Math.sin(t) * radius };
    const tangent = { x: -Math.sin(t), y: Math.cos(t) };
    points.push({
      id: uid('pt'),
      anchor,
      handleIn: { x: anchor.x - tangent.x * k, y: anchor.y - tangent.y * k },
      handleOut: { x: anchor.x + tangent.x * k, y: anchor.y + tangent.y * k },
      handlesParallel: true
    });
  }
  return { id: uid('piece'), name: 'Circle', closed: true, points };
}

function bounds(points: readonly Vec2[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  };
}

function hasPoint(points: readonly Vec2[], x: number, y: number, tol = 1e-6): boolean {
  return points.some((p) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol);
}

describe('seam allowance values', () => {
  it('defaults to half an inch, in cm', () => {
    expect(DEFAULT_SEAM_ALLOWANCE_IN).toBe(0.5);
    expect(DEFAULT_SEAM_ALLOWANCE_CM).toBeCloseTo(1.27, 6);
    expect(defaultSeamAllowanceCm(square())).toBeCloseTo(1.27, 6);
  });

  it('clamps a negative or absurd allowance', () => {
    expect(clampSeamAllowance(-3)).toBe(0);
    expect(clampSeamAllowance(MAX_SEAM_ALLOWANCE_CM + 5)).toBe(MAX_SEAM_ALLOWANCE_CM);
    expect(clampSeamAllowance(Number.NaN)).toBeCloseTo(DEFAULT_SEAM_ALLOWANCE_CM, 6);
  });

  it('keys an edge by the point it starts at', () => {
    const piece = square();
    expect(allowanceEdgeKey(piece, 0)).toBe(piece.points[0].id);
    expect(allowanceEdgeKey(piece, 3)).toBe(piece.points[3].id);
    expect(allowanceEdgeKey(piece, 4)).toBeNull();
    expect(allowanceEdgeKey({ ...piece, closed: false }, 0)).toBeNull();
  });

  it('reads the piece default, then an edge override over it', () => {
    const piece = square();
    expect(allowanceForEdge(piece, 1)).toBeCloseTo(DEFAULT_SEAM_ALLOWANCE_CM, 6);
    setPieceAllowance(piece, 2);
    expect(allowanceForEdge(piece, 1)).toBeCloseTo(2, 6);
    setEdgeAllowance(piece, 1, 0.6);
    expect(allowanceForEdge(piece, 0)).toBeCloseTo(2, 6);
    expect(allowanceForEdge(piece, 1)).toBeCloseTo(0.6, 6);
    expect(edgeHasOwnAllowance(piece, 1)).toBe(true);
    expect(edgeHasOwnAllowance(piece, 0)).toBe(false);
  });

  it('hands an edge back to the piece default, and can set every edge at once', () => {
    const piece = square();
    setPieceAllowance(piece, 2);
    setEdgeAllowance(piece, 2, 0.75);
    setEdgeAllowance(piece, 2, null);
    expect(edgeHasOwnAllowance(piece, 2)).toBe(false);
    expect(piece.seamAllowance?.edges).toBeUndefined();

    setEdgeAllowance(piece, 2, 0.75);
    setEveryEdgeAllowance(piece, 1.5);
    expect(piece.seamAllowance?.edges).toBeUndefined();
    expect(allowanceForEdge(piece, 2)).toBeCloseTo(1.5, 6);
  });

  it('carries overrides onto a clone whose points were renamed', () => {
    const piece = square();
    setEdgeAllowance(piece, 1, 0.4);
    const clone = clonePatternPiece(piece, () => uid('pt'));
    expect(clone.seamAllowance?.defaultCm).toBeCloseTo(DEFAULT_SEAM_ALLOWANCE_CM, 6);
    expect(allowanceForEdge(clone, 1)).toBeCloseTo(0.4, 6);
    expect(allowanceForEdge(clone, 0)).toBeCloseTo(DEFAULT_SEAM_ALLOWANCE_CM, 6);
    expect(remapSeamAllowance(undefined, new Map())).toBeUndefined();
  });
});

describe('seam allowance outline', () => {
  it('offsets a square by its allowance and mitres the corners', () => {
    const piece = square();
    setPieceAllowance(piece, 1);
    const ring = seamAllowanceOutline(piece);
    expect(ring).toHaveLength(4);
    expect(bounds(ring)).toEqual({ minX: -1, maxX: 11, minY: -1, maxY: 11 });
  });

  it('offsets outward whichever way the outline is wound', () => {
    const piece = square();
    piece.points.reverse();
    setPieceAllowance(piece, 1);
    const ring = seamAllowanceOutline(piece);
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(bounds(ring).minX).toBeCloseTo(-1, 6);
    expect(bounds(ring).maxX).toBeCloseTo(11, 6);
    expect(bounds(ring).minY).toBeCloseTo(-1, 6);
    expect(bounds(ring).maxY).toBeCloseTo(11, 6);
  });

  it('leaves an edge with no allowance on the seam line, as a step in the ring', () => {
    const piece = square();
    setPieceAllowance(piece, 1);
    setEdgeAllowance(piece, 0, 0);
    const ring = seamAllowanceOutline(piece);
    // The edge stays put and the two sides reach out past it, so the ring
    // carries the two step corners where the allowance changes.
    expect(hasPoint(ring, -1, 0)).toBe(true);
    expect(hasPoint(ring, 11, 0)).toBe(true);
    expect(bounds(ring).maxY).toBeCloseTo(11, 6);
  });

  it('keeps a curved edge at an even distance from it', () => {
    const piece = circle(10);
    setPieceAllowance(piece, 1);
    const ring = seamAllowanceOutline(piece);
    expect(ring.length).toBeGreaterThan(16);
    for (const p of ring) {
      // A four-arc circle is a hair inside the true circle, so the offset lands
      // just under 11 from the centre.
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(10.8);
      expect(Math.hypot(p.x, p.y)).toBeLessThan(11.2);
    }
  });

  it('gives up on a piece with no inside', () => {
    const piece = square();
    expect(seamAllowanceOutline({ ...piece, closed: false })).toEqual([]);
    expect(seamAllowanceOutline({ ...piece, points: piece.points.slice(0, 2) })).toEqual([]);
    expect(allowanceRingPath([])).toBe('');
    const path = allowanceRingPath(seamAllowanceOutline(piece));
    expect(path.startsWith('M ')).toBe(true);
    expect(path.endsWith(' Z')).toBe(true);
  });

  it('highlights one edge at its own allowance', () => {
    const piece = square();
    setPieceAllowance(piece, 1);
    const span = allowanceSpanForEdge(piece, 0);
    expect(span).toHaveLength(2);
    expect(span.every((p) => Math.abs(p.y + 1) < 1e-6)).toBe(true);
    expect(Math.min(...span.map((p) => p.x))).toBeCloseTo(0, 6);
    expect(Math.max(...span.map((p) => p.x))).toBeCloseTo(10, 6);
    setEdgeAllowance(piece, 0, 0);
    expect(allowanceSpanForEdge(piece, 0).every((p) => Math.abs(p.y) < 1e-6)).toBe(true);
  });
});
