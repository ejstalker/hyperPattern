import { describe, expect, it } from 'vitest';
import { computeSdfGrid } from './sdfBake';

/**
 * The bake grid a body gets.
 *
 * `resolution` sets the voxel size along the model's longest axis — that is
 * what decides collision fidelity — but the other axes only take the cells they
 * need. A cube wasted most of its cells on a body that is a few units deep and
 * sixteen tall, and the bake pays for every one of them.
 */
describe('computeSdfGrid', () => {
  const min: [number, number, number] = [-5.51, 0, -0.98];
  const max: [number, number, number] = [5.51, 16.17, 3.53];

  it('keeps the voxel size the longest axis asks for', () => {
    for (const resolution of [48, 64, 96, 128]) {
      const grid = computeSdfGrid(min, max, resolution);
      expect(grid.voxelSize).toBeCloseTo((16.17 + 2 * (16.17 * 0.05 + 0.25)) / resolution, 12);
    }
  });

  it('gives every axis only the cells it needs, and still covers the model', () => {
    const grid = computeSdfGrid(min, max, 64);
    const [nx, ny, nz] = grid.dim;
    // Height is the long axis; the body is far shallower than it is tall.
    expect(ny).toBeGreaterThan(nx);
    expect(nx).toBeGreaterThan(nz);
    // A cube would be 64³ of cells; this body needs well under a third of them.
    expect((nx * ny * nz) / 64 ** 3).toBeLessThan(0.35);
    // Every axis still covers the model, padding included (bar the half voxel
    // that rounding the cell count can leave).
    for (let k = 0; k < 3; k++) {
      expect(grid.origin[k]).toBeLessThanOrEqual(min[k]);
      const reach = grid.origin[k] + (grid.dim[k] - 1) * grid.voxelSize;
      expect(reach).toBeGreaterThanOrEqual(max[k]);
    }
  });

  it('never collapses an axis of a flat model', () => {
    expect(computeSdfGrid([-1, -1, -0.0001], [1, 1, 0.0001], 32).dim[2]).toBeGreaterThanOrEqual(2);
  });
});
