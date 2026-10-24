import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatternCloth } from './PatternCloth';
import { buildClothTopology } from './meshTopology';
import { DEFAULT_SIM_PARAMS } from '../project/createDefault';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';
import type { AvatarBody } from '../mesh/AvatarBody';
import type { MeshGeometry, PatternDocument, PatternPiece, SeamBinding } from '../project/types';

class FakeBuffer {
  private mapped: ArrayBuffer | null = null;
  constructor(readonly size: number) {}
  getMappedRange(): ArrayBuffer {
    if (!this.mapped) this.mapped = new ArrayBuffer(this.size);
    return this.mapped;
  }
  unmap(): void {
    this.mapped = null;
  }
  destroy(): void {}
}

function fakeDevice(): GPUDevice {
  return {
    createBuffer: (desc: { size: number }) => new FakeBuffer(desc.size),
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice;
}

function fakeAvatar(): AvatarBody {
  return {
    getFootprintRadius: () => 3,
    resolveParticle: () => false,
    getModelMatrix: () => new Float32Array(16),
    getPositionBuffer: () => new FakeBuffer(4),
    getNormalBuffer: () => new FakeBuffer(4),
    getIndexBuffer: () => new FakeBuffer(4),
    getIndexCount: () => 0,
    getSdfVolume: () => null,
  } as unknown as AvatarBody;
}

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

/** Two panels stitched along their facing edges, so real seam constraints exist. */
function sewnPair(): { mesh: MeshGeometry; pattern: PatternDocument } {
  const left = panel('left', 0, 20);
  const right = panel('right', 30, 20);
  const seams: SeamBinding[] = [
    {
      id: 'seam-0',
      a: { pieceId: 'left', fromPointId: 'left-1', toPointId: 'left-2', t0: 0, t1: 1 },
      b: { pieceId: 'right', fromPointId: 'right-3', toPointId: 'right-0', t0: 0, t1: 1 },
      restGapCm: 0.15,
    },
  ];
  const pattern = {
    id: 'p',
    name: 'p',
    pieces: [left, right],
    seams,
  } as unknown as PatternDocument;
  return { mesh: triangulatePattern(pattern, DEFAULT_MESH_SETTINGS), pattern };
}

function pieceCentroidY(cloth: PatternCloth, pieceId: string): number {
  const ids = cloth.getVertexPieceIds();
  const snap = cloth.getPositionsSnapshot()!;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== pieceId) continue;
    sum += snap[i * 3 + 1];
    n++;
  }
  return sum / Math.max(n, 1);
}

describe('seam fold resistance (topology)', () => {
  it('adds a constraint for each stitch-quad diagonal, and only across the seam', () => {
    const { mesh, pattern } = sewnPair();
    const topo = buildClothTopology(mesh, 100, pattern);
    expect(topo.seamBend.length).toBeGreaterThan(0);
    for (const bend of topo.seamBend) {
      // Every one of these straddles the seam: its ends belong to different panels.
      expect(topo.vertexPieceIds[bend.i]).not.toBe(topo.vertexPieceIds[bend.j]);
      expect(bend.rest).toBeGreaterThan(0);
    }
  });

  it('takes its rest from the stitch spacing, not the layout gap', () => {
    const { mesh, pattern } = sewnPair();
    const topo = buildClothTopology(mesh, 100, pattern);
    for (const bend of topo.seamBend) {
      // The panels sit 10 cm apart in the layout; a rest anywhere near that
      // would mean the constraint was measured across the gap instead of along
      // the seam, and it would hold the seam open.
      expect(bend.rest).toBeLessThan(topo.avgEdgeLength * 3);
    }
  });

  it('leaves an unsewn pair alone', () => {
    const { mesh } = sewnPair();
    const topo = buildClothTopology(mesh, 100, undefined);
    expect(topo.seamBend).toHaveLength(0);
  });
});

describe('seam fold resistance (solver)', () => {
  let time = 0;

  beforeEach(() => {
    (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage = {
      VERTEX: 1,
      INDEX: 2,
      COPY_DST: 4,
      STORAGE: 8,
      UNIFORM: 16,
      COPY_SRC: 32,
    };
    time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (time += 16));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCloth(bendSpringScale: number): PatternCloth {
    const { mesh, pattern } = sewnPair();
    return new PatternCloth(
      mesh,
      // Explicit, not inherited: this test is about the fold constraint, and it
      // must not change behaviour when the app's default step counts do.
      { ...DEFAULT_SIM_PARAMS, gravity: 0, bendSpringScale, substeps: 24, constraintIterations: 6 },
      fakeDevice(),
      fakeAvatar(),
      pattern
    );
  }

  /** Fold the right panel 90° up about the seam line. */
  function foldRightPanel(cloth: PatternCloth): void {
    const ids = cloth.getVertexPieceIds();
    const positions = Array.from(cloth.getRestPositionsSnapshot());
    let pivotX = Infinity;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === 'right') pivotX = Math.min(pivotX, positions[i * 3]);
    }
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== 'right') continue;
      const dx = positions[i * 3] - pivotX;
      const y = positions[i * 3 + 1];
      // Rotate about the world Z axis through the seam: +X folds up into +Y.
      positions[i * 3] = pivotX;
      positions[i * 3 + 1] = y + dx;
    }
    cloth.applyPose({ positions, velocities: [] });
  }

  function step(cloth: PatternCloth, frames: number): void {
    for (let f = 0; f < frames; f++) {
      (cloth as unknown as { prevT: number }).prevT = performance.now() - 16;
      cloth.update(true);
    }
  }

  it('pulls a folded seam back toward flat, and does not when bending is off', () => {
    const withBend = makeCloth(DEFAULT_SIM_PARAMS.bendSpringScale ?? 0.04);
    const free = makeCloth(0);
    foldRightPanel(withBend);
    foldRightPanel(free);

    // The fold stands the right panel up, so the two centroids separate in Y.
    const startGap = Math.abs(
      pieceCentroidY(withBend, 'right') - pieceCentroidY(withBend, 'left')
    );
    expect(startGap).toBeGreaterThan(0.5);

    step(withBend, 150);
    step(free, 150);

    const bentGap = Math.abs(
      pieceCentroidY(withBend, 'right') - pieceCentroidY(withBend, 'left')
    );
    const freeGap = Math.abs(pieceCentroidY(free, 'right') - pieceCentroidY(free, 'left'));
    // Cross-seam bending unfolds most of it…
    expect(bentGap).toBeLessThan(startGap * 0.5);
    // …while with bending off the fold is free to stand there.
    expect(bentGap).toBeLessThan(freeGap);
  });
});
