import { describe, expect, it } from 'vitest';
import { rectPiece } from './createDefault';
import {
  ANCHOR_ATTR,
  EDGE_UV,
  POINT_ORDER,
  POINT_RING,
  REST_POSITION,
  REST_ROTATION,
  carryAttributesThroughSplit,
  edgeAttributes,
  edgeKey,
  edgeKeyEnds,
  edgeUv,
  hasRestPose,
  normalizePieceAttributes,
  pieceAttributes,
  pieceCentroid,
  pieceEdges,
  pieceRestPose,
  pointAttributes,
  pointDefaults,
  pointOrder,
  setEdgeAttribute,
  setPieceRestPose,
  setPointAttribute,
} from './attributes';
import type { PatternPiece } from './types';

function box(w = 40, h = 20, x = 0, y = 0): PatternPiece {
  return rectPiece('Box', w, h, { x, y });
}

describe('derived defaults', () => {
  it('numbers a piece’s points round its rings: the outline, then each hole', () => {
    const piece = box();
    piece.holes = [
      [
        { id: 'h0', anchor: { x: 5, y: 5 }, handleIn: null, handleOut: null },
        { id: 'h1', anchor: { x: 10, y: 5 }, handleIn: null, handleOut: null },
        { id: 'h2', anchor: { x: 10, y: 10 }, handleIn: null, handleOut: null },
      ],
    ];
    const defaults = pointDefaults(piece);
    expect(defaults.get(piece.points[0]!.id)).toEqual({ [POINT_ORDER]: 0, [POINT_RING]: 0 });
    expect(defaults.get(piece.points[3]!.id)).toEqual({ [POINT_ORDER]: 3, [POINT_RING]: 0 });
    expect(defaults.get('h0')).toEqual({ [POINT_ORDER]: 4, [POINT_RING]: 1 });
    expect(pointOrder(piece, 'h2')).toBe(6);
  });

  it('gives an edge a 0..1 UV span along its ring', () => {
    const piece = box();
    const first = edgeUv(piece, piece.points[0]!.id, piece.points[1]!.id)!;
    expect(first.u0).toBeCloseTo(0);
    expect(first.u1).toBeCloseTo(0.25);
    expect(first.lengthCm).toBeCloseTo(40);
    const closing = edgeUv(piece, piece.points[3]!.id, piece.points[0]!.id)!;
    expect(closing.u0).toBeCloseTo(0.75);
    expect(closing.u1).toBeCloseTo(1);
  });

  it('has no UV for a pair of points that are not an edge', () => {
    const piece = box();
    expect(edgeUv(piece, piece.points[0]!.id, piece.points[2]!.id)).toBeNull();
  });

  it('shows the derived UV on the edge’s attributes', () => {
    const piece = box();
    const bag = edgeAttributes(piece, piece.points[0]!.id, piece.points[1]!.id);
    expect(bag[EDGE_UV]).toEqual([0, 0.25]);
  });

  it('lets a stored attribute shadow a derived one', () => {
    const piece = box();
    const id = piece.points[1]!.id;
    setPointAttribute(piece, id, POINT_ORDER, 99);
    expect(pointOrder(piece, id)).toBe(99);
    setPointAttribute(piece, id, POINT_ORDER, undefined);
    expect(pointOrder(piece, id)).toBe(1);
  });
});

describe('reading and writing', () => {
  it('keeps point, edge and piece classes apart', () => {
    const piece = box();
    const a = piece.points[0]!.id;
    const b = piece.points[1]!.id;
    setPointAttribute(piece, a, ANCHOR_ATTR, 'waist');
    setEdgeAttribute(piece, a, b, 'gather', 0.5);
    pieceAttributes(piece, true).zone = 'skirt';

    expect(pointAttributes(piece, a)[ANCHOR_ATTR]).toBe('waist');
    expect(piece.attributes?.edge?.[edgeKey(a, b)]?.gather).toBe(0.5);
    expect(piece.attributes?.piece?.zone).toBe('skirt');
    // Endpoints carry no edge attribute of their own.
    expect(pointAttributes(piece, a).gather).toBeUndefined();
  });

  it('cleans up after itself when a write is removed', () => {
    const piece = box();
    setPointAttribute(piece, piece.points[0]!.id, 'x', 1);
    setPointAttribute(piece, piece.points[0]!.id, 'x', undefined);
    expect(piece.attributes?.point).toBeUndefined();
  });

  it('lists the edges of a piece in ring order', () => {
    const piece = box();
    const edges = pieceEdges(piece);
    expect(edges).toHaveLength(4);
    expect(edges[3]!.to.id).toBe(piece.points[0]!.id);
  });

  it('splits an edge key back into its ends', () => {
    expect(edgeKeyEnds(edgeKey('a', 'b'))).toEqual({ from: 'a', to: 'b' });
    expect(edgeKeyEnds('nonsense')).toBeNull();
  });
});

describe('rest pose', () => {
  it('rests flat at the piece’s centroid until told otherwise', () => {
    const piece = box(40, 20, 10, 5);
    const pose = pieceRestPose(piece);
    expect(pose.position[0]).toBeCloseTo(30);
    expect(pose.position[1]).toBeCloseTo(15);
    expect(pose.position[2]).toBe(0);
    expect(pose.rotationQuat).toEqual([0, 0, 0, 1]);
    expect(hasRestPose(piece)).toBe(false);
    expect(pieceCentroid(piece)).toEqual({ x: 30, y: 15 });
  });

  it('stores a rest position and rotation, and normalises the quaternion', () => {
    const piece = box();
    setPieceRestPose(piece, { position: [1, 2, 3], rotationQuat: [0, 0, 0, 2] });
    const pose = pieceRestPose(piece);
    expect(pose.position).toEqual([1, 2, 3]);
    expect(pose.rotationQuat).toEqual([0, 0, 0, 1]);
    expect(piece.attributes?.piece?.[REST_POSITION]).toEqual([1, 2, 3]);
    expect(piece.attributes?.piece?.[REST_ROTATION]).toEqual([0, 0, 0, 2]);

    setPieceRestPose(piece, null);
    expect(hasRestPose(piece)).toBe(false);
    expect(pieceRestPose(piece).position[0]).toBeCloseTo(20);
  });

  it('ignores a rest pose that is not four finite numbers', () => {
    const piece = box();
    pieceAttributes(piece, true)[REST_ROTATION] = [0, 0, 1];
    expect(pieceRestPose(piece).rotationQuat).toEqual([0, 0, 0, 1]);
  });
});

describe('normalisation', () => {
  it('drops attributes that are not readable values', () => {
    const piece = box();
    piece.attributes = {
      piece: { good: 1, bad: Number.NaN, text: 'x', list: [1, 2] },
      point: { p: { ok: 2, nope: [1, 'a'] as unknown as number[] } },
      edge: { 'a>b': { uv: [0, 1] }, broken: { x: 1 } },
    } as PatternPiece['attributes'];
    normalizePieceAttributes(piece);
    expect(piece.attributes?.piece).toEqual({ good: 1, text: 'x', list: [1, 2] });
    expect(piece.attributes?.point).toEqual({ p: { ok: 2 } });
    expect(piece.attributes?.edge).toEqual({ 'a>b': { uv: [0, 1] } });
  });

  it('removes an empty attribute store altogether', () => {
    const piece = box();
    piece.attributes = { point: {} };
    normalizePieceAttributes(piece);
    expect(piece.attributes).toBeUndefined();
  });
});

describe('carrying attributes through a split', () => {
  it('follows the points that survived and keeps only edges that are still edges', () => {
    const parent = box();
    const a = parent.points[0]!.id;
    const b = parent.points[1]!.id;
    setPointAttribute(parent, a, ANCHOR_ATTR, 'left');
    setPointAttribute(parent, b, ANCHOR_ATTR, 'top');
    setEdgeAttribute(parent, a, b, 'seam', 1);
    pieceAttributes(parent, true).zone = 'panel';

    const childA: PatternPiece = {
      id: 'childA',
      name: 'A',
      closed: true,
      points: [
        { id: 'A0', anchor: { x: 0, y: 0 }, handleIn: null, handleOut: null },
        { id: 'A1', anchor: { x: 40, y: 0 }, handleIn: null, handleOut: null },
        { id: 'A2', anchor: { x: 0, y: 20 }, handleIn: null, handleOut: null },
      ],
    };
    const maps = [new Map([
      [a, 'A0'],
      [b, 'A1'],
    ])];
    carryAttributesThroughSplit(parent, [childA], maps);

    expect(childA.attributes?.piece).toEqual({ zone: 'panel' });
    expect(childA.attributes?.point?.A0?.[ANCHOR_ATTR]).toBe('left');
    expect(childA.attributes?.point?.A1?.[ANCHOR_ATTR]).toBe('top');
    // A0 → A1 is an edge of the child, so the edge attribute came across.
    expect(childA.attributes?.edge?.[edgeKey('A0', 'A1')]?.seam).toBe(1);
  });

  it('drops an edge attribute whose span is no longer an edge', () => {
    const parent = box();
    const a = parent.points[0]!.id;
    const b = parent.points[2]!.id;
    setEdgeAttribute(parent, a, b, 'seam', 1);
    const child: PatternPiece = {
      id: 'child',
      name: 'A',
      closed: true,
      points: [
        { id: 'C0', anchor: { x: 0, y: 0 }, handleIn: null, handleOut: null },
        { id: 'C1', anchor: { x: 40, y: 0 }, handleIn: null, handleOut: null },
        { id: 'C2', anchor: { x: 0, y: 20 }, handleIn: null, handleOut: null },
      ],
    };
    carryAttributesThroughSplit(parent, [child], [new Map([[a, 'C0'], [b, 'C2']])]);
    expect(child.attributes?.edge).toBeUndefined();
  });
});
