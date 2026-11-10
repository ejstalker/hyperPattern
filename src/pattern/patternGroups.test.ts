import { describe, expect, it } from 'vitest';
import { groupBoxForPieces, groupsForPiece, pieceRect, piecesInGroup } from './patternGroups';
import type { BezierPoint, PatternDocument, PatternGroup, PatternPiece } from '../project/types';

function point(id: string, x: number, y: number): BezierPoint {
  return { id, anchor: { x, y }, handleIn: null, handleOut: null };
}

/** A piece as a square from (x, y), so the bounds are obvious. */
function piece(id: string, x: number, y: number, size = 10): PatternPiece {
  return {
    id,
    name: id,
    closed: true,
    points: [point(`${id}a`, x, y), point(`${id}b`, x + size, y), point(`${id}c`, x + size, y + size)],
  };
}

function group(id: string, x: number, y: number, widthCm: number, heightCm: number): PatternGroup {
  return { id, label: id, x, y, widthCm, heightCm };
}

function pattern(pieces: PatternPiece[], groups: PatternGroup[] = []): PatternDocument {
  return { id: 'p', name: 'Pattern', pieces, seams: [], groups } as PatternDocument;
}

describe('measuring a piece', () => {
  it('takes the box round its anchors', () => {
    expect(pieceRect(piece('a', 5, 7, 10))).toEqual({ x: 5, y: 7, width: 10, height: 10 });
  });

  it('has nothing to measure when a piece has no points', () => {
    const empty: PatternPiece = { id: 'e', name: 'e', closed: true, points: [] };
    expect(pieceRect(empty)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('what a pattern group holds', () => {
  it('takes the pieces lying wholly inside it and leaves the rest', () => {
    const doc = pattern([piece('in', 10, 10), piece('out', 200, 200)], [group('g', 0, 0, 100, 100)]);
    expect(piecesInGroup(doc, doc.groups![0]!).map((p) => p.id)).toEqual(['in']);
  });

  it('counts a piece touching the frame as inside it', () => {
    const doc = pattern([piece('flush', 0, 0, 20)], [group('g', 0, 0, 20, 20)]);
    expect(piecesInGroup(doc, doc.groups![0]!).map((p) => p.id)).toEqual(['flush']);
  });

  it('leaves a piece hanging over the edge out', () => {
    const doc = pattern([piece('half', 15, 5, 20)], [group('g', 0, 0, 25, 25)]);
    expect(piecesInGroup(doc, doc.groups![0]!)).toEqual([]);
  });

  it('gives a piece the tighter of two groups it lies in', () => {
    const doc = pattern(
      [piece('p', 10, 10, 10)],
      [group('wide', 0, 0, 500, 500), group('tight', 5, 5, 100, 100)]
    );
    expect(groupsForPiece(doc, 'p').map((g) => g.id)).toEqual(['tight', 'wide']);
  });

  it('forgets a piece that was dragged out of the frame', () => {
    const doc = pattern([piece('p', 10, 10)]);
    doc.groups = [group('g', 0, 0, 100, 100)];
    expect(groupsForPiece(doc, 'p')).toHaveLength(1);
    doc.pieces[0] = piece('p', 400, 400);
    expect(groupsForPiece(doc, 'p')).toHaveLength(0);
  });

  it('frames the pieces it was drawn over', () => {
    const box = groupBoxForPieces([piece('a', 10, 20), piece('b', 40, 50, 20)]);
    expect(box).toEqual({ x: 10, y: 20, widthCm: 50, heightCm: 50 });
    expect(groupBoxForPieces([])).toBeNull();
  });
});
