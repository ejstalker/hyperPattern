import { describe, expect, it } from 'vitest';
import { patternGeometrySignature } from './geometrySignature';
import type { BezierPoint, PatternDocument, PatternPiece } from '../project/types';

function point(id: string, x: number, y: number): BezierPoint {
  return { id, anchor: { x, y }, handleIn: null, handleOut: null };
}

function piece(points: BezierPoint[]): PatternPiece {
  return { id: 'piece', name: 'Front', closed: true, points };
}

function document(points: BezierPoint[]): PatternDocument {
  return { id: 'pattern', name: 'Skirt', pieces: [piece(points)], seams: [] } as PatternDocument;
}

describe('fingerprinting the geometry a pattern draws', () => {
  it('is the same for the same geometry, twice', () => {
    const a = document([point('a', 0, 0), point('b', 10, 0), point('c', 10, 10)]);
    const b = document([point('a', 0, 0), point('b', 10, 0), point('c', 10, 10)]);
    expect(patternGeometrySignature(a)).toBe(patternGeometrySignature(b));
  });

  it('changes when a point moves', () => {
    const before = document([point('a', 0, 0), point('b', 10, 0)]);
    const after = document([point('a', 0, 0), point('b', 11, 0)]);
    expect(patternGeometrySignature(after)).not.toBe(patternGeometrySignature(before));
  });

  it('changes when a handle moves', () => {
    const straight = document([point('a', 0, 0), point('b', 10, 0)]);
    const curved = document([
      { ...point('a', 0, 0), handleOut: { x: 4, y: 0 } },
      point('b', 10, 0),
    ]);
    expect(patternGeometrySignature(curved)).not.toBe(patternGeometrySignature(straight));
  });

  it('changes when a point is added', () => {
    const before = document([point('a', 0, 0), point('b', 10, 0)]);
    const after = document([point('a', 0, 0), point('m', 5, 0), point('b', 10, 0)]);
    expect(patternGeometrySignature(after)).not.toBe(patternGeometrySignature(before));
  });

  it('notices a seam, which the mesher samples along', () => {
    const base = document([point('a', 0, 0), point('b', 10, 0)]);
    const sewn: PatternDocument = {
      ...base,
      seams: [
        {
          id: 's1',
          a: { pieceId: 'piece', fromPointId: 'a', toPointId: 'b', t0: 0, t1: 1 },
          b: { pieceId: 'piece', fromPointId: 'b', toPointId: 'a', t0: 0, t1: 1 },
          restGapCm: 1,
        },
      ],
    };
    expect(patternGeometrySignature(sewn)).not.toBe(patternGeometrySignature(base));
  });

  it('has nothing to say about a pattern that is not there', () => {
    expect(patternGeometrySignature(undefined)).toBe('');
    expect(patternGeometrySignature(null)).toBe('');
  });
});
