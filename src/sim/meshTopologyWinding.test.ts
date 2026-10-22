import { describe, expect, it } from 'vitest';
import { buildClothTopology } from './meshTopology';
import type { MeshGeometry } from '../project/types';

/**
 * A 20 cm square, wound the way the mesher winds a piece: positive signed area
 * in the pattern's own (x right, y down) coordinates.
 */
function squareMesh(): MeshGeometry {
  return {
    vertices: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ],
    triangles: [0, 1, 2, 0, 2, 3],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ],
    vertexPieceIds: ['piece', 'piece', 'piece', 'piece'],
  };
}

/** World-space triangle normal, the same cross product the renderer uses. */
function faceNormal(
  positions: Float32Array,
  indices: Uint32Array,
  triangle: number
): [number, number, number] {
  const [i0, i1, i2] = [indices[triangle * 3]!, indices[triangle * 3 + 1]!, indices[triangle * 3 + 2]!];
  const p = (i: number) => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  const [a, b, c] = [p(i0), p(i1), p(i2)];
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  return [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
}

describe('buildClothTopology winding', () => {
  it('flips the mesher’s orientation, because the layout mirrors the pattern', () => {
    const topo = buildClothTopology(squareMesh(), 1, null, {});
    expect(topo.indices.length).toBe(6);
    // Pattern space is y-down (a drafting canvas), so the mesher's triangles are
    // visually clockwise, and the layout maps pattern y to world −z — a mirror.
    // Pinning the resulting sign is the point: it is the one that makes the
    // cloth's front its outside. Measured on a draped skirt, this winding agrees
    // with the body surface on 74 % of the faces that touch it, against 26 % the
    // other way round — which is what an OBJ of an inside-out drape looks like.
    for (let t = 0; t < 2; t++) {
      expect(faceNormal(topo.positions, topo.indices, t)[1]).toBeLessThan(0);
    }
  });

  it('keeps each triangle’s own vertices, only their order reversed', () => {
    const mesh = squareMesh();
    const topo = buildClothTopology(mesh, 1, null, {});
    for (let t = 0; t < mesh.triangles.length / 3; t++) {
      const original = mesh.triangles.slice(t * 3, t * 3 + 3);
      const wound = Array.from(topo.indices.slice(t * 3, t * 3 + 3));
      expect(wound).toEqual([original[0], original[2], original[1]]);
    }
  });
});
