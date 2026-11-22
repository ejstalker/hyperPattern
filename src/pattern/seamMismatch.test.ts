import { describe, expect, it } from 'vitest';
import type { BezierPoint, PatternPiece, SeamBinding, SeamEdgeRef } from '../project/types';
import { seamEdgeLengthGaps } from './seamMismatch';

function pt(id: string, x: number, y: number): BezierPoint {
  return { id, anchor: { x, y }, handleIn: null, handleOut: null };
}

/** A square piece `size` cm on a side, its edges named by their corner points. */
function square(id: string, size: number): PatternPiece {
  return {
    id,
    name: id,
    closed: true,
    points: [pt(`${id}-a`, 0, 0), pt(`${id}-b`, size, 0), pt(`${id}-c`, size, size), pt(`${id}-d`, 0, size)],
  };
}

function edge(
  pieceId: string,
  fromPointId: string,
  toPointId: string,
  t0 = 0,
  t1 = 1
): SeamEdgeRef {
  return { pieceId, fromPointId, toPointId, t0, t1 };
}

function seam(a: SeamEdgeRef, b: SeamEdgeRef): SeamBinding {
  return { id: `${a.pieceId}-${b.pieceId}`, a, b, restGapCm: 0 };
}

describe('sewn edge length mismatches', () => {
  it('says nothing when the edges are the same length', () => {
    const left = square('left', 40);
    const right = square('right', 40);
    // a→b is the bottom edge of each square: 40 cm both sides.
    expect(seamEdgeLengthGaps([left, right], [seam(edge('left', 'left-a', 'left-b'), edge('right', 'right-a', 'right-b'))])).toEqual([]);
  });

  it('reports both sides of a mismatch, the longer positive and the shorter negative', () => {
    const waistband = square('band', 44);
    const skirt = square('skirt', 40);
    const gaps = seamEdgeLengthGaps(
      [waistband, skirt],
      [seam(edge('band', 'band-a', 'band-b'), edge('skirt', 'skirt-a', 'skirt-b'))]
    );
    expect(gaps).toHaveLength(2);
    const band = gaps.find((g) => g.ref.pieceId === 'band')!;
    const skirtGap = gaps.find((g) => g.ref.pieceId === 'skirt')!;
    expect(band.lengthCm).toBeCloseTo(44, 6);
    expect(band.partnerCm).toBeCloseTo(40, 6);
    expect(band.differenceCm).toBeCloseTo(4, 6);
    expect(skirtGap.differenceCm).toBeCloseTo(-4, 6);
    // Both sides of one seam read the same magnitude.
    expect(Math.abs(band.differenceCm)).toBeCloseTo(Math.abs(skirtGap.differenceCm), 9);
  });

  it('reads a span, not the whole edge', () => {
    const band = square('band', 40);
    const panel = square('panel', 40);
    // The band's edge sewn across half its length to a 20 cm panel edge.
    const gaps = seamEdgeLengthGaps(
      [band, panel],
      [seam(edge('band', 'band-a', 'band-b', 0, 0.5), edge('panel', 'panel-a', 'panel-b', 0, 0.5))]
    );
    expect(gaps).toEqual([]);
  });

  it('adds up every partner of an edge split across several pieces', () => {
    const band = square('band', 40);
    const left = square('left', 10);
    const right = square('right', 12);
    // Both panel edges are sewn to the band's one whole edge, and together they
    // are shorter than it by 18 cm.
    const gaps = seamEdgeLengthGaps(
      [band, left, right],
      [
        seam(edge('band', 'band-a', 'band-b'), edge('left', 'left-a', 'left-b')),
        seam(edge('band', 'band-a', 'band-b'), edge('right', 'right-a', 'right-b')),
      ]
    );
    const bandGap = gaps.find((g) => g.ref.pieceId === 'band')!;
    expect(bandGap.partnerCm).toBeCloseTo(22, 6);
    expect(bandGap.differenceCm).toBeCloseTo(18, 6);
    // Each panel edge is only 18 cm short of the whole band, not of its own share.
    expect(gaps.find((g) => g.ref.pieceId === 'left')!.differenceCm).toBeCloseTo(-30, 6);
    expect(gaps.filter((g) => g.ref.pieceId === 'band')).toHaveLength(1);
  });

  it('reads an edge cut into spans by many-to-many sewing as one edge', () => {
    const band = square('band', 40);
    const left = square('left', 10);
    const right = square('right', 12);
    // The sew tool cuts the band's edge in two, one span per panel — the halves
    // are the mesher's bookkeeping, not something to report twice.
    const gaps = seamEdgeLengthGaps(
      [band, left, right],
      [
        seam(edge('band', 'band-a', 'band-b', 0, 0.5), edge('left', 'left-a', 'left-b')),
        seam(edge('band', 'band-a', 'band-b', 0.5, 1), edge('right', 'right-a', 'right-b')),
      ]
    );
    const bandGaps = gaps.filter((g) => g.ref.pieceId === 'band');
    expect(bandGaps).toHaveLength(1);
    expect(bandGaps[0].lengthCm).toBeCloseTo(40, 6);
    expect(bandGaps[0].partnerCm).toBeCloseTo(22, 6);
    // And its number covers the whole sewn run, not the first half.
    expect(bandGaps[0].ref.t0).toBeCloseTo(0, 6);
    expect(bandGaps[0].ref.t1).toBeCloseTo(1, 6);
  });

  it('counts an edge read the other way round as the same edge', () => {
    const band = square('band', 40);
    const panel = square('panel', 12);
    const gaps = seamEdgeLengthGaps(
      [band, panel],
      [
        // One seam reads the band's edge forwards, another backwards: still one
        // edge, so one number, measured against both partners.
        seam(edge('band', 'band-a', 'band-b', 0, 1), edge('panel', 'panel-a', 'panel-b', 0, 0.3)),
        seam(edge('band', 'band-a', 'band-b', 1, 0), edge('panel', 'panel-b', 'panel-c', 0, 0.3)),
      ]
    );
    expect(gaps.filter((g) => g.ref.pieceId === 'band')).toHaveLength(1);
    const bandGap = gaps.find((g) => g.ref.pieceId === 'band')!;
    // Two 3.6 cm spans, one read forwards and one backwards.
    expect(bandGap.partnerCm).toBeCloseTo(7.2, 6);
    expect(bandGap.differenceCm).toBeCloseTo(32.8, 6);
  });

  it('ignores seams whose edges are no longer in the pattern', () => {
    const band = square('band', 40);
    const gaps = seamEdgeLengthGaps(
      [band],
      [seam(edge('band', 'band-a', 'band-b'), edge('gone', 'x', 'y'))]
    );
    expect(gaps).toEqual([]);
    // And an edge that no longer resolves on its own piece.
    expect(seamEdgeLengthGaps([band], [seam(edge('band', 'band-a', 'missing'), edge('band', 'band-b', 'band-c'))])).toEqual([]);
  });

  it('follows the curve, not the chord', () => {
    const straight = square('straight', 40);
    const curved: PatternPiece = {
      id: 'curved',
      name: 'curved',
      closed: false,
      points: [
        { id: 'c-a', anchor: { x: 0, y: 0 }, handleIn: null, handleOut: { x: 10, y: 30 } },
        { id: 'c-b', anchor: { x: 40, y: 0 }, handleIn: { x: 30, y: 30 }, handleOut: null },
      ],
    };
    const gaps = seamEdgeLengthGaps(
      [straight, curved],
      [seam(edge('straight', 'straight-a', 'straight-b'), edge('curved', 'c-a', 'c-b'))]
    );
    expect(gaps).toHaveLength(2);
    const bow = gaps.find((g) => g.ref.pieceId === 'curved')!;
    // The bowed edge is longer than the 40 cm straight one it is sewn to.
    expect(bow.lengthCm).toBeGreaterThan(40);
    expect(bow.differenceCm).toBeCloseTo(bow.lengthCm - 40, 6);
  });
});
