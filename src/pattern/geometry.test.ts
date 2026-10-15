import { describe, expect, it } from 'vitest';
import {
  axisLockFromDelta,
  clonePatternPiece,
  edgeIndexForPointIds,
  edgeLengthByPointIds,
  findNearestPieceEdge,
  mirrorClonePatternPiece,
  pieceEdgeAt,
  pieceEdgeCount,
  pieceEdgeNumber,
  piecePointById,
  pieceRings,
  pointInPiece,
  pointOnEdgeAtT,
  sampleEdgeByPointIds,
} from './geometry';
import type { BezierPoint, PatternPiece } from '../project/types';

describe('axis lock for Shift-held drags', () => {
  it('leaves movement free without Shift', () => {
    expect(axisLockFromDelta(10, 3, false)).toBeNull();
    expect(axisLockFromDelta(0, 0, false)).toBeNull();
  });

  it('locks to the axis the drag has moved along most', () => {
    expect(axisLockFromDelta(10, 3, true)).toBe('x');
    expect(axisLockFromDelta(-10, 3, true)).toBe('x');
    expect(axisLockFromDelta(2, -9, true)).toBe('y');
  });

  it('locks to x on a tie, including before any movement', () => {
    expect(axisLockFromDelta(5, 5, true)).toBe('x');
    expect(axisLockFromDelta(0, 0, true)).toBe('x');
  });
});

/**
 * A piece with a hole in it.
 *
 * The hole is one field on the piece and nothing else: point and edge lookups
 * name points by ID, and IDs are unique across the whole piece, so a seam, a
 * measurement or a seam allowance override on a hole's edge never has to say
 * which ring it lives on — and the cloth is the outline *less* the holes, which
 * is what every "is this point on the piece" test has to answer now.
 */
describe('a piece with a hole in it', () => {
  const rect = (name: string, x: number, y: number, w: number, h: number): PatternPiece => ({
    id: name,
    name,
    closed: true,
    points: [
      { id: `${name}-a`, anchor: { x, y }, handleIn: null, handleOut: null, handlesParallel: false },
      { id: `${name}-b`, anchor: { x: x + w, y }, handleIn: null, handleOut: null, handlesParallel: false },
      { id: `${name}-c`, anchor: { x: x + w, y: y + h }, handleIn: null, handleOut: null, handlesParallel: false },
      { id: `${name}-d`, anchor: { x, y: y + h }, handleIn: null, handleOut: null, handlesParallel: false },
    ],
  });

  const holed = (): PatternPiece => ({
    ...rect('panel', 0, 0, 20, 20),
    holes: [rect('hole', 5, 5, 10, 10).points],
  });

  it('is not cloth inside the hole', () => {
    const piece = holed();
    expect(pointInPiece({ x: 2, y: 2 }, piece)).toBe(true);
    expect(pointInPiece({ x: 10, y: 10 }, piece)).toBe(false);
    expect(pointInPiece({ x: 30, y: 10 }, piece)).toBe(false);
  });

  it('counts and names every edge, hole edges included', () => {
    const piece = holed();
    expect(pieceEdgeCount(piece)).toBe(8);
    // 0..3 are the outline, 4..7 the hole: the numbers run round one ring and then
    // the next, so an edge index stays a plain number.
    expect(pieceEdgeAt(piece, 0)?.from.id).toBe('panel-a');
    expect(pieceEdgeAt(piece, 4)?.from.id).toBe('hole-a');
    expect(pieceEdgeAt(piece, 8)).toBeNull();
    expect(pieceEdgeNumber(piece, 1, 0)).toBe(4);
  });

  it('resolves a hole edge by its point IDs, arc table and all', () => {
    const piece = holed();
    expect(edgeIndexForPointIds(piece, 'hole-b', 'hole-c')).toBe(1);
    expect(sampleEdgeByPointIds(piece, 'hole-b', 'hole-c')).toEqual([
      { x: 15, y: 5 },
      { x: 15, y: 15 },
    ]);
    expect(edgeLengthByPointIds(piece, 'hole-b', 'hole-c')).toBeCloseTo(10, 6);
    expect(pointOnEdgeAtT(piece, 'hole-b', 'hole-c', 0.5)).toEqual({ x: 15, y: 10 });
  });

  it('finds a point by ID wherever on the piece it lives', () => {
    const piece = holed();
    expect(piecePointById(piece, 'panel-c')?.anchor).toEqual({ x: 20, y: 20 });
    expect(piecePointById(piece, 'hole-c')?.anchor).toEqual({ x: 15, y: 15 });
    expect(piecePointById(piece, 'nope')).toBeNull();
    expect(pieceRings(piece)).toHaveLength(2);
  });

  it('picks the nearest edge over every ring', () => {
    const piece = holed();
    const hit = findNearestPieceEdge(piece, { x: 15.5, y: 10 });
    expect(hit?.ringIndex).toBe(1);
    expect(hit?.edgeNumber).toBe(5);
    expect(hit?.dist).toBeCloseTo(0.5, 6);
  });

  it('carries the hole with the piece when it is copied or mirrored', () => {
    const piece = holed();
    let n = 0;
    const copy = clonePatternPiece(piece, () => `id${++n}`, { x: 100, y: 0 });
    expect(copy.holes?.[0]?.map((pt) => pt.anchor)).toEqual(
      piece.holes?.[0]?.map((pt) => ({ x: pt.anchor.x + 100, y: pt.anchor.y }))
    );
    // Every point of the hole is a point of its own on the copy, so editing the
    // two apart works.
    expect(copy.holes?.[0]?.every((pt) => pt.id !== piece.holes?.[0]?.[0]?.id)).toBe(true);

    const mirrored = mirrorClonePatternPiece(piece, 'x', () => `m${++n}`);
    expect(mirrored.holes).toHaveLength(1);
    const ring = mirrored.holes![0]!;
    const centre = {
      x: ring.reduce((sum, pt) => sum + pt.anchor.x, 0) / ring.length,
      y: ring.reduce((sum, pt) => sum + pt.anchor.y, 0) / ring.length,
    };
    expect(pointInPiece(centre, mirrored)).toBe(false);
    // The hole travelled with the outline: it is inside the mirrored panel, not
    // left behind where the original's hole was.
    const holeBox = (boxRing: BezierPoint[]) => {
      const xs = boxRing.map((pt) => pt.anchor.x);
      const ys = boxRing.map((pt) => pt.anchor.y);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    };
    const panel = holeBox(mirrored.points);
    const hole = holeBox(mirrored.holes![0]!);
    expect(hole.minX).toBeGreaterThan(panel.minX);
    expect(hole.maxX).toBeLessThan(panel.maxX);
    expect(hole.minY).toBeGreaterThan(panel.minY);
    expect(hole.maxY).toBeLessThan(panel.maxY);
  });
});
