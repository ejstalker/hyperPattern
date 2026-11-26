import { describe, expect, it } from 'vitest';
import { buildClothTopology, refreshFabricScales } from './meshTopology';
import type { FabricPhysics } from '../fabrics/library';
import type { MeshGeometry } from '../project/types';

/** Two squares, one per piece, so a fabric can be measured per piece. */
function twoPieceMesh(): MeshGeometry {
  return {
    vertices: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 14, y: 0 },
      { x: 24, y: 0 },
      { x: 24, y: 10 },
      { x: 14, y: 10 },
    ],
    triangles: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [0, 2],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4],
      [4, 6],
    ],
    vertexPieceIds: ['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b'],
  };
}

const heavy: FabricPhysics = { weight: 2, stiffness: 1.5, bend: 3 };
const light: FabricPhysics = { weight: 0.5, stiffness: 0.5, bend: 0.25 };

describe('cloth topology fabric multipliers', () => {
  it('gives each piece its own particle weight', () => {
    const topo = buildClothTopology(twoPieceMesh(), 100, null, {
      fabricForPiece: (id) => (id === 'a' ? heavy : id === 'b' ? light : null),
    });
    expect(topo.massScales[0]).toBeCloseTo(2);
    expect(topo.massScales[4]).toBeCloseTo(0.5);
    // Same base mass per particle; inverse mass follows the fabric weight.
    expect(topo.inverseMasses[0]! * 2).toBeCloseTo(topo.inverseMasses[4]! * 0.5);
  });

  it('gives each edge the stiffness of the pieces it joins', () => {
    const topo = buildClothTopology(twoPieceMesh(), 100, null, {
      fabricForPiece: (id) => (id === 'a' ? heavy : id === 'b' ? light : null),
    });
    for (const edge of topo.stretch) {
      const first = topo.vertexPieceIds[edge.i];
      const second = topo.vertexPieceIds[edge.j];
      const expected =
        first === second ? (first === 'a' ? 1.5 : 0.5) : (1.5 + 0.5) / 2;
      expect(edge.stiffness).toBeCloseTo(expected);
    }
    for (const bend of topo.bend) {
      expect(bend.stiffness).toBeGreaterThan(0);
    }
  });

  it('leaves an unassigned piece at the drape’s own physics', () => {
    const topo = buildClothTopology(twoPieceMesh(), 100, null, {});
    expect(Array.from(topo.massScales)).toEqual(new Array(8).fill(1));
    expect(topo.stretch.every((edge) => edge.stiffness === 1)).toBe(true);
  });

  it('re-bakes weight and stiffness in place when the assignment changes', () => {
    const topo = buildClothTopology(twoPieceMesh(), 100, null, {
      fabricForPiece: () => null,
    });
    const before = topo.inverseMasses[0]!;
    refreshFabricScales(topo, 100 / 8, (id) => (id === 'a' ? heavy : null));
    expect(topo.massScales[0]).toBeCloseTo(2);
    expect(topo.massScales[4]).toBeCloseTo(1);
    expect(topo.inverseMasses[0]!).toBeCloseTo(before / 2);
    expect(topo.stretch.find((edge) => topo.vertexPieceIds[edge.i] === 'a')!.stiffness).toBeCloseTo(
      1.5
    );
    expect(topo.stretch.find((edge) => topo.vertexPieceIds[edge.i] === 'b')!.stiffness).toBeCloseTo(
      1
    );
    // Switching the second piece to the floppy fabric moves its edges too.
    refreshFabricScales(topo, 100 / 8, (id) => (id === 'a' ? heavy : light));
    expect(topo.massScales[4]).toBeCloseTo(0.5);
    expect(topo.stretch.find((edge) => topo.vertexPieceIds[edge.i] === 'b')!.stiffness).toBeCloseTo(
      0.5
    );
  });
});
