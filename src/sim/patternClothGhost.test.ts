import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatternCloth } from './PatternCloth';
import { DEFAULT_SIM_PARAMS } from '../project/createDefault';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';
import type { AvatarBody } from '../mesh/AvatarBody';
import type { MeshGeometry, PatternDocument, PatternPiece, SeamBinding } from '../project/types';

/** Minimal stand-in for a GPUBuffer — enough for buffer creation + writes. */
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

type Write = { buffer: unknown; data: Float32Array };

function fakeDevice(writes: Write[]): GPUDevice {
  return {
    createBuffer: (desc: { size: number }) => new FakeBuffer(desc.size),
    queue: {
      writeBuffer: (buffer: unknown, _offset: number, data: ArrayBufferView) => {
        if (data instanceof Float32Array) writes.push({ buffer, data: Float32Array.from(data) });
      },
    },
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

/**
 * Two separate panels stitched along facing edges, so the cloth carries real
 * seam constraints between the pieces — the thing ghosting has to switch off.
 */
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
  const pattern = { id: 'p', name: 'p', pieces: [left, right], seams } as unknown as PatternDocument;
  return { mesh: triangulatePattern(pattern, DEFAULT_MESH_SETTINGS), pattern };
}

function pieceCentroid(cloth: PatternCloth, pieceId: string): number[] {
  const ids = cloth.getVertexPieceIds();
  const snap = cloth.getPositionsSnapshot()!;
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== pieceId) continue;
    sum[0] += snap[i * 3];
    sum[1] += snap[i * 3 + 1];
    sum[2] += snap[i * 3 + 2];
    n++;
  }
  return sum.map((v) => v / Math.max(n, 1));
}

describe('PatternCloth ghost pieces', () => {
  let writes: Write[];
  let now = 0;

  beforeEach(() => {
    (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage = {
      VERTEX: 1,
      INDEX: 2,
      COPY_DST: 4,
      STORAGE: 8,
      UNIFORM: 16,
      COPY_SRC: 32,
    };
    writes = [];
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 16));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCloth(): PatternCloth {
    const { mesh, pattern } = sewnPair();
    return new PatternCloth(
      mesh,
      { ...DEFAULT_SIM_PARAMS, gravity: 0.5 },
      fakeDevice(writes),
      fakeAvatar(),
      pattern
    );
  }

  it('drops a ghosted piece out of the seam springs and pins it in place', () => {
    const cloth = makeCloth();
    const seamPairs = () => (cloth as unknown as { seamPairIndices: Array<[number, number]> }).seamPairIndices;
    expect(seamPairs().length).toBeGreaterThan(0);

    cloth.setPieceGhosted('left', true);
    expect(cloth.isPieceGhosted('left')).toBe(true);
    expect(cloth.getGhostedPieceIds()).toEqual(['left']);
    // Its seam springs are gone: nothing of the piece pulls on the fabric.
    expect(seamPairs().length).toBe(0);

    const before = cloth.captureGhostState()['left']!;
    expect(before).toHaveLength((cloth.getVertexPieceIds().filter((id) => id === 'left')).length * 3);
    const rightBeforeY = pieceCentroid(cloth, 'right')[1];
    for (let i = 0; i < 40; i++) cloth.update(true);

    // The ghosted piece held its exact pose…
    expect(cloth.captureGhostState()['left']).toEqual(before);
    // …and the piece still in the simulation did not hang off it.
    expect(pieceCentroid(cloth, 'right')[1]).toBeLessThan(rightBeforeY - 1e-4);

    cloth.setPieceGhosted('left', false);
    expect(cloth.isPieceGhosted('left')).toBe(false);
    expect(seamPairs().length).toBeGreaterThan(0);
  });

  it('keeps ghosting and freezing mutually exclusive', () => {
    const cloth = makeCloth();
    cloth.setPieceGhosted('left', true);
    cloth.setPieceFrozen('left', true);
    expect(cloth.isPieceFrozen('left')).toBe(true);
    expect(cloth.isPieceGhosted('left')).toBe(false);

    cloth.setPieceGhosted('left', true);
    expect(cloth.isPieceFrozen('left')).toBe(false);
    expect(cloth.isPieceGhosted('left')).toBe(true);
  });

  it('re-ghosts a rebuilt cloth at the saved positions', () => {
    const cloth = makeCloth();
    cloth.setPieceGhosted('left', true);
    const saved = cloth.captureGhostState();
    expect(Object.keys(saved)).toEqual(['left']);

    const rebuilt = makeCloth();
    rebuilt.applyGhostState(saved);
    expect(rebuilt.isPieceGhosted('left')).toBe(true);
    expect(rebuilt.isPieceGhosted('right')).toBe(false);
    expect(rebuilt.captureGhostState()['left']).toEqual(saved['left']);
    // Re-applying the state must not leave the piece's seams live again.
    expect(
      (rebuilt as unknown as { seamPairIndices: Array<[number, number]> }).seamPairIndices.length
    ).toBe(0);
  });

  it('clears the ghost set on reset', () => {
    const cloth = makeCloth();
    cloth.setPieceGhosted('left', true);
    cloth.resetToInitialState();
    expect(cloth.getGhostedPieceIds()).toEqual([]);
    expect(cloth.isPieceGhosted('left')).toBe(false);
    expect(
      (cloth as unknown as { seamPairIndices: Array<[number, number]> }).seamPairIndices.length
    ).toBeGreaterThan(0);
  });

  it('publishes per-vertex opacity for frozen and ghosted pieces', () => {
    const cloth = makeCloth();
    const alphaBuffer = cloth.getAlphaBuffer()!;
    const lastAlpha = () => {
      for (let i = writes.length - 1; i >= 0; i--) {
        if (writes[i].buffer === alphaBuffer) return writes[i].data;
      }
      return null;
    };
    const ids = cloth.getVertexPieceIds();
    expect(cloth.hasTranslucentPieces()).toBe(false);
    expect(Array.from(lastAlpha()!)).toEqual(ids.map(() => 1));

    cloth.setPieceFrozen('left', true);
    expect(cloth.hasTranslucentPieces()).toBe(true);
    expect(Array.from(lastAlpha()!)).toEqual(ids.map((id) => (id === 'left' ? 0.75 : 1)));

    cloth.setPieceGhosted('left', true);
    expect(Array.from(lastAlpha()!)).toEqual(ids.map((id) => (id === 'left' ? 0.25 : 1)));

    cloth.setPieceGhosted('left', false);
    expect(cloth.hasTranslucentPieces()).toBe(false);
    expect(Array.from(lastAlpha()!)).toEqual(ids.map(() => 1));
  });
});
