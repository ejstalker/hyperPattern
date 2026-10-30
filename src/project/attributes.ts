import type {
  AttributeBag,
  AttributeValue,
  BezierPoint,
  PatternPiece,
  PieceAttributes,
  Vec2,
} from './types';
import { edgeLengthByPointIds, pieceRings, ringEdgeCount } from '../pattern/geometry';

/**
 * Geometry attributes.
 *
 * The pattern's geometry is points and edges inside pieces, but a draughtsperson —
 * and every modifier node that comes later — needs to say things *about* those
 * elements: how far along the outline a point sits, what the weather is at the
 * point's position, where a piece rests in space before it is draped. Houdini
 * calls that data attributes; so does this.
 *
 * Attributes live on the piece (`PatternPiece.attributes`) keyed by element, so a
 * document that has never run a modifier carries none of them and costs nothing.
 * The defaults below are *derived* rather than stored — a point's order is its
 * index round its ring, which cannot drift from the ring it describes — and a
 * stored attribute of the same name shadows the derived one.
 */

export type { AttributeBag, AttributeValue, PieceAttributes };

/** A point's index round the whole piece: outline first, then each hole. */
export const POINT_ORDER = 'order';
/** Which ring a point is on: 0 is the outline, 1.. the holes. */
export const POINT_RING = 'ring';
/** An edge's UV span along the outline: `[u0, u1]`, 0..1 of the ring. */
export const EDGE_UV = 'uv';
/** A named anchor point a transform can pivot on. */
export const ANCHOR_ATTR = 'anchor';
/** A piece's rest position in world space: `[x, y, z]` (cm). */
export const REST_POSITION = 'restP';
/** A piece's rest orientation: `[x, y, z, w]`. */
export const REST_ROTATION = 'restQ';

/** The key an edge's attributes are stored under. */
export function edgeKey(fromPointId: string, toPointId: string): string {
  return `${fromPointId}>${toPointId}`;
}

/** Split an edge key back into its endpoints, or null when it is not one. */
export function edgeKeyEnds(key: string): { from: string; to: string } | null {
  const at = key.indexOf('>');
  if (at <= 0 || at >= key.length - 1) return null;
  return { from: key.slice(0, at), to: key.slice(at + 1) };
}

// ── Reading and writing ──────────────────────────────────────────────────────

function bagOf(store: Record<string, AttributeBag>, key: string): AttributeBag {
  return store[key] ?? (store[key] = {});
}

/** The piece's own attributes, created on demand when `create` is set. */
export function pieceAttributes(piece: PatternPiece, create = false): AttributeBag {
  if (!piece.attributes) {
    if (!create) return {};
    piece.attributes = {};
  }
  if (!piece.attributes.piece) {
    if (!create) return {};
    piece.attributes.piece = {};
  }
  return piece.attributes.piece;
}

/**
 * One point's attributes. The derived defaults — its order and its ring — are
 * merged underneath what is stored, so a reader always sees a complete point.
 */
export function pointAttributes(piece: PatternPiece, pointId: string): AttributeBag {
  const defaults = pointDefaults(piece);
  const derived = defaults.get(pointId);
  const stored = piece.attributes?.point?.[pointId];
  if (!stored) return derived ? { ...derived } : {};
  return derived ? { ...derived, ...stored } : { ...stored };
}

/** Write one point attribute; `undefined` removes it and uncovers the default. */
export function setPointAttribute(
  piece: PatternPiece,
  pointId: string,
  name: string,
  value: AttributeValue | undefined
): void {
  if (!piece.attributes) piece.attributes = {};
  if (!piece.attributes.point) piece.attributes.point = {};
  const bag = bagOf(piece.attributes.point!, pointId);
  if (value === undefined) delete bag[name];
  else bag[name] = value;
  if (Object.keys(bag).length === 0) {
    delete piece.attributes.point[pointId];
    if (Object.keys(piece.attributes.point).length === 0) delete piece.attributes.point;
  }
}

/** One edge's attributes: the derived UV span merged under whatever is stored. */
export function edgeAttributes(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string
): AttributeBag {
  const derived = edgeUv(piece, fromPointId, toPointId);
  const stored = piece.attributes?.edge?.[edgeKey(fromPointId, toPointId)];
  const base: AttributeBag = derived ? { [EDGE_UV]: [derived.u0, derived.u1] } : {};
  return stored ? { ...base, ...stored } : base;
}

/** Write one edge attribute; `undefined` removes it. */
export function setEdgeAttribute(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string,
  name: string,
  value: AttributeValue | undefined
): void {
  if (!piece.attributes) piece.attributes = {};
  if (!piece.attributes.edge) piece.attributes.edge = {};
  const key = edgeKey(fromPointId, toPointId);
  const bag = bagOf(piece.attributes.edge!, key);
  if (value === undefined) delete bag[name];
  else bag[name] = value;
  if (Object.keys(bag).length === 0) {
    delete piece.attributes.edge[key];
    if (Object.keys(piece.attributes.edge).length === 0) delete piece.attributes.edge;
  }
}

/** Write one attribute on the piece itself; `undefined` removes it. */
export function setPieceAttribute(
  piece: PatternPiece,
  name: string,
  value: AttributeValue | undefined
): void {
  const bag = pieceAttributes(piece, value !== undefined);
  if (value === undefined) delete bag[name];
  else bag[name] = value;
  if (piece.attributes?.piece && Object.keys(piece.attributes.piece).length === 0) {
    delete piece.attributes.piece;
  }
}

/** Every edge of a piece, in ring order, with the ids attributes are keyed by. */
export function pieceEdges(
  piece: PatternPiece
): Array<{ ring: BezierPoint[]; ringIndex: number; edgeIndex: number; from: BezierPoint; to: BezierPoint }> {
  const rings = pieceRings(piece);
  const edges: Array<{
    ring: BezierPoint[];
    ringIndex: number;
    edgeIndex: number;
    from: BezierPoint;
    to: BezierPoint;
  }> = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    const count = ringEdgeCount(piece, r);
    for (let i = 0; i < count; i++) {
      edges.push({
        ring,
        ringIndex: r,
        edgeIndex: i,
        from: ring[i]!,
        to: ring[(i + 1) % ring.length]!,
      });
    }
  }
  return edges;
}

// ── Derived defaults ─────────────────────────────────────────────────────────

/**
 * Every point's order and ring, derived from the rings themselves.
 *
 * The order runs right round the outline and then round each hole in turn, the
 * same numbering edges use, so `order` and edge numbers agree.
 */
export function pointDefaults(piece: PatternPiece): Map<string, AttributeBag> {
  const out = new Map<string, AttributeBag>();
  const rings = pieceRings(piece);
  let order = 0;
  for (let r = 0; r < rings.length; r++) {
    for (const pt of rings[r]!) {
      out.set(pt.id, { [POINT_ORDER]: order, [POINT_RING]: r });
      order += 1;
    }
  }
  return out;
}

/** A point's order — its index round the whole piece — or null when unknown. */
export function pointOrder(piece: PatternPiece, pointId: string): number | null {
  const order = pointAttributes(piece, pointId)[POINT_ORDER];
  return typeof order === 'number' ? order : null;
}

/**
 * The UV span of an edge along its ring, which is what a point order is for.
 *
 * `u` runs 0..1 round the ring that holds the edge, so the outline of a four
 * point piece gives 0, 0.25, 0.5 and 0.75 at its corners and the closing edge
 * runs 0.75 → 1. A hole has its own ring and its own 0..1. `lengthCm` comes along
 * so a caller reading UVs can also measure what it just indexed.
 */
export function edgeUv(
  piece: PatternPiece,
  fromPointId: string,
  toPointId: string
): { u0: number; u1: number; lengthCm: number } | null {
  const rings = pieceRings(piece);
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    const a = ring.findIndex((pt) => pt.id === fromPointId);
    if (a < 0) continue;
    const count = ringEdgeCount(piece, r);
    const closed = piece.closed || r > 0;
    // The edge has to be the next point round *this* ring, in this direction.
    const next = ring[(a + 1) % ring.length];
    if (!next || next.id !== toPointId) return null;
    if (!closed && a >= ring.length - 1) return null;
    const u0 = count > 0 ? a / count : 0;
    return {
      u0,
      u1: count > 0 ? (a + 1) / count : 0,
      lengthCm: edgeLengthByPointIds(piece, fromPointId, toPointId),
    };
  }
  return null;
}

// ── Rest pose ────────────────────────────────────────────────────────────────

export type PieceRestPose = {
  position: [number, number, number];
  rotationQuat: [number, number, number, number];
};

/** The centroid of a piece's anchors, which is the position a flat piece rests at. */
export function pieceCentroid(piece: PatternPiece): Vec2 {
  const rings = pieceRings(piece);
  let x = 0;
  let y = 0;
  let n = 0;
  for (const ring of rings) {
    for (const pt of ring) {
      x += pt.anchor.x;
      y += pt.anchor.y;
      n += 1;
    }
  }
  if (n === 0) return { x: 0, y: 0 };
  return { x: x / n, y: y / n };
}

function numbers(value: AttributeValue | undefined, count: number): number[] | null {
  if (!Array.isArray(value) || value.length !== count) return null;
  const out: number[] = [];
  for (const entry of value) {
    const n = Number(entry);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

/**
 * Where a piece rests before it is draped: `restP` and `restQ` when they have been
 * stored, and a flat, upright default when they have not — the piece lying on the
 * table at its own centroid, which is what an unmodified pattern has always been.
 */
export function pieceRestPose(piece: PatternPiece): PieceRestPose {
  const bag = pieceAttributes(piece);
  const centre = pieceCentroid(piece);
  const position = numbers(bag[REST_POSITION], 3) as [number, number, number] | null;
  const rotation = numbers(bag[REST_ROTATION], 4) as
    | [number, number, number, number]
    | null;
  return {
    position: position ?? [centre.x, centre.y, 0],
    rotationQuat: rotation && normalised(rotation) ? normaliseQuat(rotation) : [0, 0, 0, 1],
  };
}

/** Whether the piece carries a rest pose of its own, rather than the flat default. */
export function hasRestPose(piece: PatternPiece): boolean {
  const bag = pieceAttributes(piece);
  return Array.isArray(bag[REST_POSITION]) || Array.isArray(bag[REST_ROTATION]);
}

/** Store where a piece rests, or clear it with `null` to fall back to the default. */
export function setPieceRestPose(piece: PatternPiece, pose: PieceRestPose | null): void {
  const bag = pieceAttributes(piece, true);
  if (!pose) {
    delete bag[REST_POSITION];
    delete bag[REST_ROTATION];
    return;
  }
  bag[REST_POSITION] = [...pose.position];
  bag[REST_ROTATION] = [...pose.rotationQuat];
}

function normalised(q: number[]): boolean {
  const length = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
  return Number.isFinite(length) && length > 1e-6;
}

function normaliseQuat(q: number[]): [number, number, number, number] {
  const length = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
  return [q[0]! / length, q[1]! / length, q[2]! / length, q[3]! / length];
}

// ── Normalisation ────────────────────────────────────────────────────────────

function isValue(value: unknown): value is AttributeValue {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  return Array.isArray(value) && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function cleanBag(bag: unknown): AttributeBag | null {
  if (!bag || typeof bag !== 'object') return null;
  const out: AttributeBag = {};
  for (const [name, value] of Object.entries(bag as Record<string, unknown>)) {
    if (isValue(value)) out[name] = Array.isArray(value) ? [...value] : value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Make a loaded piece's attributes safe: named bags with finite numbers, strings
 * and finite number arrays in them, and nothing at all where nothing was written.
 * Attributes never affect geometry, so anything unreadable is dropped rather than
 * repaired — a number nobody can read is a number nobody meant.
 */
export function normalizePieceAttributes(piece: PatternPiece): void {
  const source = piece.attributes;
  if (!source) return;
  const out: PieceAttributes = {};
  const pieceBag = cleanBag(source.piece);
  if (pieceBag) out.piece = pieceBag;
  if (source.point && typeof source.point === 'object') {
    const points: Record<string, AttributeBag> = {};
    for (const [id, bag] of Object.entries(source.point)) {
      const clean = cleanBag(bag);
      if (clean) points[id] = clean;
    }
    if (Object.keys(points).length > 0) out.point = points;
  }
  if (source.edge && typeof source.edge === 'object') {
    const edges: Record<string, AttributeBag> = {};
    for (const [key, bag] of Object.entries(source.edge)) {
      if (!edgeKeyEnds(key)) continue;
      const clean = cleanBag(bag);
      if (clean) edges[key] = clean;
    }
    if (Object.keys(edges).length > 0) out.edge = edges;
  }
  if (Object.keys(out).length === 0) delete piece.attributes;
  else piece.attributes = out;
}

/**
 * Carry a piece's attributes onto the pieces that replaced it.
 *
 * A cut makes new pieces with new point ids; `pointMaps` says which new id each
 * old point became. Attributes follow the points that survived, the piece's own
 * attributes are copied onto every child, and edge attributes follow only the
 * edges whose both ends survived — a split edge's attributes describe a span that
 * no longer exists. Edge *defaults* (the UV span) always come out right, because
 * they are derived from the child's own rings.
 */
export function carryAttributesThroughSplit(
  parent: PatternPiece,
  children: PatternPiece[],
  pointMaps: Array<Map<string, string>>
): void {
  children.forEach((child, index) => {
    const map = pointMaps[index];
    if (!map) return;
    const attrs: PieceAttributes = {};
    const pieceBag = cleanBag(parent.attributes?.piece);
    if (pieceBag) attrs.piece = { ...pieceBag };
    const points: Record<string, AttributeBag> = {};
    for (const [oldId, bag] of Object.entries(parent.attributes?.point ?? {})) {
      const newId = map.get(oldId);
      const clean = cleanBag(bag);
      if (newId && clean) points[newId] = { ...clean };
    }
    if (Object.keys(points).length > 0) attrs.point = points;
    const edges: Record<string, AttributeBag> = {};
    for (const [key, bag] of Object.entries(parent.attributes?.edge ?? {})) {
      const ends = edgeKeyEnds(key);
      const clean = cleanBag(bag);
      if (!ends || !clean) continue;
      const from = map.get(ends.from);
      const to = map.get(ends.to);
      if (!from || !to) continue;
      // Only when those two points are still next to each other in the child.
      const stillAnEdge = pieceEdges(child).some(
        (edge) => edge.from.id === from && edge.to.id === to
      );
      if (stillAnEdge) edges[edgeKey(from, to)] = { ...clean };
    }
    if (Object.keys(edges).length > 0) attrs.edge = edges;
    if (Object.keys(attrs).length > 0) child.attributes = attrs;
  });
}
