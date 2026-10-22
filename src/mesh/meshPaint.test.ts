import { describe, expect, it } from 'vitest';
import { MIN_EDGE_PX, meshEdgePath, meshSurfacePath, meshViewScale } from './meshPaint';
import type { MeshGeometry } from '../project/types';

/** A triangle strip covering a `w`×`h` square, as two triangles. */
function square(x: number, y: number, w: number, h: number): { vertices: MeshGeometry['vertices']; triangles: number[] } {
  return {
    vertices: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    triangles: [0, 1, 2, 0, 2, 3],
  };
}

function mesh(
  vertices: MeshGeometry['vertices'],
  triangles: number[],
  edges: Array<[number, number]>
): MeshGeometry {
  return { vertices, triangles, edges, boundary: [] } as unknown as MeshGeometry;
}

describe('meshSurfacePath', () => {
  it('is empty without geometry', () => {
    expect(meshSurfacePath(null)).toBe('');
    expect(meshSurfacePath(undefined)).toBe('');
    expect(meshSurfacePath(mesh([], [], []))).toBe('');
  });

  it('writes one closed subpath per triangle', () => {
    const { vertices, triangles } = square(0, 0, 10, 10);
    const path = meshSurfacePath(mesh(vertices, triangles, []));
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path.match(/Z/g)).toHaveLength(2);
    expect(path.startsWith('M0 0L10 0L10 10Z')).toBe(true);
  });

  it('keeps pattern units, rounded to a hundredth', () => {
    const { vertices, triangles } = square(0, 0, 1.23456789, 2);
    const path = meshSurfacePath(mesh(vertices, triangles, []));
    expect(path).toContain('L1.23 0');
    expect(path).not.toContain('1.23456789');
  });

  it('skips a triangle that points at a missing vertex', () => {
    const { vertices } = square(0, 0, 10, 10);
    const path = meshSurfacePath(mesh(vertices, [0, 1, 2, 0, 1, 99], []));
    expect(path.match(/M/g)).toHaveLength(1);
  });
});

describe('meshViewScale', () => {
  it('is the smaller of the two fits, and refuses a degenerate box', () => {
    expect(meshViewScale({ x: 0, y: 0, w: 100, h: 50 }, { width: 200, height: 200 })).toBe(2);
    expect(meshViewScale({ x: 0, y: 0, w: 50, h: 100 }, { width: 200, height: 200 })).toBe(2);
    expect(meshViewScale({ x: 0, y: 0, w: 0, h: 10 }, { width: 200, height: 200 })).toBe(1);
    expect(meshViewScale({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe('meshEdgePath', () => {
  const layout = { width: 400, height: 400 };
  const view = { x: 0, y: 0, w: 400, h: 400 };

  it('drops edges that would be shorter than the threshold on screen', () => {
    // 1 unit at scale 1 is 1 px; at scale 0.1 it is a tenth of a pixel.
    const geom = mesh([{ x: 0, y: 0 }, { x: 1, y: 0 }], [], [[0, 1]]);
    expect(meshEdgePath(geom, view, layout).count).toBe(1);
    const tiny = meshEdgePath(geom, { x: 0, y: 0, w: 4000, h: 4000 }, layout);
    expect(tiny.count).toBe(0);
    expect(tiny.path).toBe('');
    // and the threshold is the one advertised
    const justUnder = meshEdgePath(geom, { x: 0, y: 0, w: 400 / (MIN_EDGE_PX * 0.99), h: 400 }, layout);
    expect(justUnder.count).toBe(0);
  });

  it('keeps an edge that spans the view with both its ends outside it', () => {
    const geom = mesh([{ x: -1000, y: 10 }, { x: 1000, y: 10 }], [], [[0, 1]]);
    const zoomed = { x: 0, y: 0, w: 20, h: 20 };
    expect(meshEdgePath(geom, zoomed, layout).count).toBe(1);
  });

  it('drops an edge that lies entirely outside the view', () => {
    const geom = mesh([{ x: 500, y: 500 }, { x: 600, y: 500 }], [], [[0, 1]]);
    expect(meshEdgePath(geom, { x: 0, y: 0, w: 100, h: 100 }, layout).count).toBe(0);
  });

  it('writes segments in pattern units', () => {
    const geom = mesh([{ x: 2, y: 3 }, { x: 42, y: 3 }], [], [[0, 1]]);
    expect(meshEdgePath(geom, view, layout).path).toBe('M2 3L42 3');
  });

  it('is empty without edges or geometry', () => {
    expect(meshEdgePath(null, view, layout)).toEqual({ path: '', count: 0 });
    expect(meshEdgePath(mesh([], [], []), view, layout)).toEqual({ path: '', count: 0 });
  });

  it('skips an edge whose vertices are missing', () => {
    const geom = mesh([{ x: 0, y: 0 }], [], [[0, 1]]);
    expect(meshEdgePath(geom, view, layout).count).toBe(0);
  });
});
