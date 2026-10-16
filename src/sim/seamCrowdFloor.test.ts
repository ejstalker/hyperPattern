import { describe, expect, it } from 'vitest';
import { buildClothTopology } from './meshTopology';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';
import type { PatternDocument, PatternPiece, SeamBinding } from '../project/types';

/**
 * Which rows of fabric a seam lets crowd, and how far.
 *
 * A gathered seam — a long edge sewn into a short one — needs the fabric along
 * its long side to fold up somewhere, or the stitch ends up fighting the panel
 * forever. Ordinary fabric must stay two-sided and inextensible: a crowd floor
 * on every sewn row leaves the whole stitched area free to compress, which is
 * what made sewn cloth buzz and churn instead of settling.
 */

function panel(id: string, x: number, width: number, height = 10): PatternPiece {
  return {
    id,
    name: id,
    closed: true,
    points: [
      { id: `${id}-0`, anchor: { x, y: 0 }, handleIn: null, handleOut: null },
      { id: `${id}-1`, anchor: { x: x + width, y: 0 }, handleIn: null, handleOut: null },
      { id: `${id}-2`, anchor: { x: x + width, y: height }, handleIn: null, handleOut: null },
      { id: `${id}-3`, anchor: { x, y: height }, handleIn: null, handleOut: null },
    ],
  };
}

const edge = (pieceId: string, from: number, to: number) => ({
  pieceId,
  fromPointId: `${pieceId}-${from}`,
  toPointId: `${pieceId}-${to}`,
  t0: 0,
  t1: 1,
});

function topologyOf(left: PatternPiece, right: PatternPiece) {
  const seams: SeamBinding[] = [
    {
      id: 'seam-0',
      // The pieces' bottom edges: 20 cm on the left, 10 cm on the right.
      a: edge(left.id, 0, 1),
      b: edge(right.id, 0, 1),
      restGapCm: 0.15,
    },
  ];
  const pattern = { id: 'p', name: 'p', pieces: [left, right], seams } as unknown as PatternDocument;
  const mesh = triangulatePattern(pattern, DEFAULT_MESH_SETTINGS);
  return buildClothTopology(mesh, 1, pattern, { layoutY: 4 });
}

/** Crowd floors in play, with the piece each edge belongs to. */
function crowdFloors(left: PatternPiece, right: PatternPiece) {
  const topo = topologyOf(left, right);
  const rows = topo.stretch.filter((c) => c.slack !== undefined);
  const byPiece = new Map<string, number[]>();
  for (const c of rows) {
    const piece = topo.vertexPieceIds[c.i]!;
    expect(topo.vertexPieceIds[c.j]).toBe(piece);
    if (!byPiece.has(piece)) byPiece.set(piece, []);
    byPiece.get(piece)!.push(c.slack!);
  }
  return { topo, rows, byPiece };
}

describe('seam crowd floors', () => {
  it('leaves a plain seam, edge for edge, two-sided', () => {
    const { rows } = crowdFloors(panel('left', 0, 20), panel('right', 30, 20));
    expect(rows).toHaveLength(0);
  });

  it('lets only the long side of a gather crowd, by the seam’s own length ratio', () => {
    const left = panel('left', 0, 20);
    const right = panel('right', 30, 10);
    const { rows, byPiece, topo } = crowdFloors(left, right);

    expect(rows.length).toBeGreaterThan(0);
    // Every floor sits on the long ("left") side…
    expect([...byPiece.keys()]).toEqual(['left']);
    // …and lets the row give exactly what the 2:1 seam needs, no more.
    for (const floor of byPiece.get('left')!) {
      expect(floor).toBeGreaterThan(0.45);
      expect(floor).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    // The short side's row is ordinary fabric.
    expect(topo.stretch.some((c) => c.slack !== undefined && topo.vertexPieceIds[c.i] === 'right')).toBe(false);
  });

  it('treats a hair’s-breadth mismatch as no gather at all', () => {
    const { rows } = crowdFloors(panel('left', 0, 20), panel('right', 30, 20.2));
    expect(rows).toHaveLength(0);
  });
});
