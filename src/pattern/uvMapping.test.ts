import { describe, expect, it } from 'vitest';
import {
  computedUvsForGeometry,
  defaultSharedUvBox,
  normalizePieceUv,
  pieceMeshUvs,
  pieceUvForBox,
  sharedMeshUvs,
  sharedUvBoxFor,
  splitPieceUv,
  uvBoxForPiece,
} from './uvMapping';
import { rectPiece } from '../project/createDefault';
import type { MeshGeometry, PatternDocument, PatternPiece } from '../project/types';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';

function piece(uv?: PatternPiece['uv']): PatternPiece {
  const rect = rectPiece('panel', 20, 20, { x: 10, y: 20 });
  if (uv) rect.uv = uv;
  return rect;
}

describe('piece texture coordinates', () => {
  it('maps the piece box to 0..1 with y running down the image', () => {
    const vertices = [
      { x: 10, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 40 },
      { x: 10, y: 40 },
    ];
    expect(pieceMeshUvs(piece(), vertices)).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  });

  it('applies scale before offset', () => {
    const vertices = [{ x: 20, y: 30 }];
    const uvs = pieceMeshUvs(piece({ offsetX: 0.25, offsetY: -0.5, scaleX: 2, scaleY: 0.5 }), vertices);
    expect(uvs[0]).toBeCloseTo(0.25 + 0.5 * 2);
    expect(uvs[1]).toBeCloseTo(-0.5 + 0.5 * 0.5);
  });

  it('fills the identity for a partial or missing transform', () => {
    expect(normalizePieceUv(undefined)).toEqual({ offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 });
    expect(normalizePieceUv({ scaleX: 2 })).toEqual({
      offsetX: 0,
      offsetY: 0,
      scaleX: 2,
      scaleY: 1,
    });
    expect(normalizePieceUv({ offsetX: NaN, scaleY: Infinity })).toEqual({
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
    });
    // JSON writes a NaN as null; the scale must fall back to 1, not 0.
    expect(normalizePieceUv({ scaleX: null as unknown as number })).toEqual({
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
    });
  });

  it('keeps a cut child on the slice of the image it showed', () => {
    const parent = piece({ offsetX: 0.1, offsetY: 0, scaleX: 1, scaleY: 1 });
    // The right half of the parent's box.
    const child: PatternPiece = {
      ...parent,
      id: 'child',
      points: parent.points.map((point) => ({
        ...point,
        anchor: { x: point.anchor.x <= 20 ? point.anchor.x + 10 : point.anchor.x, y: point.anchor.y },
        handleIn: null,
        handleOut: null,
      })),
    };
    const uv = splitPieceUv(parent, child);
    expect(uv.offsetX).toBeCloseTo(0.1 + 0.5);
    expect(uv.scaleX).toBeCloseTo(0.5);
    expect(uv.offsetY).toBeCloseTo(0);
    expect(uv.scaleY).toBeCloseTo(1);
  });

  it('recomputes from the piece each mesh vertex belongs to', () => {
    const first = piece();
    const second = rectPiece('other', 40, 50, { x: 50, y: 10 });
    const geometry: MeshGeometry = {
      vertices: [
        { x: first.points[0]!.anchor.x, y: first.points[0]!.anchor.y },
        { x: second.points[2]!.anchor.x, y: second.points[2]!.anchor.y },
      ],
      vertexPieceIds: [first.id, second.id],
      triangles: [],
      edges: [],
    };
    const pattern: PatternDocument = {
      id: 'pat',
      name: 'pat',
      pieces: [first, second],
      seams: [],
    };
    const uvs = computedUvsForGeometry(geometry, pattern);
    expect(uvs).toEqual([0, 0, 1, 1]);
  });

  it('maps every vertex through one shared reference box', () => {
    const vertices = [
      { x: 20, y: 30 },
      { x: 60, y: 70 },
    ];
    expect(sharedMeshUvs(vertices, { x: 20, y: 30, widthCm: 40, heightCm: 40 })).toEqual([
      0, 0, 1, 1,
    ]);
  });

  it('round-trips a piece between its mapping and the box drawn for it', () => {
    const panel = piece({ offsetX: 0.2, offsetY: -0.1, scaleX: 1.5, scaleY: 0.5 });
    const box = uvBoxForPiece(panel);
    const back = pieceUvForBox(panel, box);
    expect(back.offsetX).toBeCloseTo(0.2);
    expect(back.offsetY).toBeCloseTo(-0.1);
    expect(back.scaleX).toBeCloseTo(1.5);
    expect(back.scaleY).toBeCloseTo(0.5);
  });

  it('defaults shared mode to the union of the pieces and keeps a stored box', () => {
    const first = piece();
    const second = rectPiece('other', 20, 20, { x: 50, y: 60 });
    const pattern: PatternDocument = {
      id: 'pat',
      name: 'pat',
      pieces: [first, second],
      seams: [],
    };
    const union = defaultSharedUvBox(pattern.pieces);
    expect(union.x).toBeCloseTo(10);
    expect(union.y).toBeCloseTo(20);
    expect(union.widthCm).toBeCloseTo(60);
    expect(union.heightCm).toBeCloseTo(60);

    pattern.uvMode = 'shared';
    expect(sharedUvBoxFor(pattern)).toEqual(union);
    pattern.uvSharedBox = { x: 0, y: 0, widthCm: 10, heightCm: 10 };
    expect(sharedUvBoxFor(pattern)).toEqual(pattern.uvSharedBox);
  });

  it('bakes one shared box into every piece of the remeshed cloth', () => {
    const first = rectPiece('first', 20, 20, { x: 0, y: 0 });
    const second = rectPiece('second', 20, 20, { x: 40, y: 0 });
    const pattern: PatternDocument = {
      id: 'pat',
      name: 'pat',
      pieces: [first, second],
      seams: [],
      uvMode: 'shared',
      uvSharedBox: { x: 0, y: 0, widthCm: 60, heightCm: 20 },
    };
    const mesh = triangulatePattern(pattern, DEFAULT_MESH_SETTINGS);
    expect(mesh.uvs).toHaveLength(mesh.vertices.length * 2);
    let maxU = -Infinity;
    for (let i = 0; i < mesh.uvs!.length; i += 2) maxU = Math.max(maxU, mesh.uvs![i]!);
    // The right edge of the second panel sits at u = 1 of the shared box.
    expect(maxU).toBeCloseTo(1);
  });

  it('bakes a piece mapping into the remeshed cloth', () => {
    const panel = rectPiece('panel', 10, 20, { x: 10, y: 20 });
    panel.uv = { offsetX: 0.5, offsetY: 0, scaleX: 0.5, scaleY: 1 };
    const pattern: PatternDocument = { id: 'pat', name: 'pat', pieces: [panel], seams: [] };
    const mesh = triangulatePattern(pattern, DEFAULT_MESH_SETTINGS);
    expect(mesh.uvs).toHaveLength(mesh.vertices.length * 2);
    let minU = Infinity;
    let maxU = -Infinity;
    for (let i = 0; i < mesh.uvs!.length; i += 2) {
      minU = Math.min(minU, mesh.uvs![i]!);
      maxU = Math.max(maxU, mesh.uvs![i]!);
    }
    expect(minU).toBeCloseTo(0.5);
    expect(maxU).toBeCloseTo(1);
  });
});
