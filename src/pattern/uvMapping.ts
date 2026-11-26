/**
 * Texture coordinates for pattern pieces.
 *
 * A piece's own box — the bounds of its flattened outline — is the mapping's
 * frame: the top-left of the box is UV (0,0) and the bottom-right is (1,1), so
 * an unedited piece fills the image top-side up. The piece's `uv` transform
 * scales that box and slides it afterwards, which is what lets two panels share
 * one image at different spots.
 */
import type {
  MeshGeometry,
  PatternDocument,
  PatternPiece,
  PieceUvTransform,
  UvBox,
  Vec2,
} from '../project/types';
import { boundsOf, pieceToPolyline } from './geometry';

export const DEFAULT_PIECE_UV: PieceUvTransform = Object.freeze({
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
});

function finite(value: unknown, fallback: number): number {
  // null is what JSON turns a NaN into — read it as missing, not as zero.
  if (value === null || value === undefined) return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** A complete transform, with the identity filling anything an old file left out. */
export function normalizePieceUv(
  value: Partial<PieceUvTransform> | null | undefined
): PieceUvTransform {
  return {
    offsetX: finite(value?.offsetX, DEFAULT_PIECE_UV.offsetX),
    offsetY: finite(value?.offsetY, DEFAULT_PIECE_UV.offsetY),
    scaleX: finite(value?.scaleX, DEFAULT_PIECE_UV.scaleX),
    scaleY: finite(value?.scaleY, DEFAULT_PIECE_UV.scaleY),
  };
}

/** True when the transform would leave the piece's box exactly at 0..1. */
export function isDefaultPieceUv(value: Partial<PieceUvTransform> | null | undefined): boolean {
  const uv = normalizePieceUv(value);
  return (
    uv.offsetX === DEFAULT_PIECE_UV.offsetX &&
    uv.offsetY === DEFAULT_PIECE_UV.offsetY &&
    uv.scaleX === DEFAULT_PIECE_UV.scaleX &&
    uv.scaleY === DEFAULT_PIECE_UV.scaleY
  );
}

/** The box a piece's mapping is measured from, in pattern centimetres. */
export function pieceUvBounds(piece: PatternPiece): { min: Vec2; max: Vec2 } {
  return boundsOf(pieceToPolyline(piece.points, piece.closed, 20));
}

/** A complete reference box, with sane sizes for anything an old file left out. */
export function normalizeUvBox(
  value: Partial<UvBox> | null | undefined,
  fallback?: UvBox
): UvBox | null {
  if (!value) return fallback ?? null;
  const box: UvBox = {
    x: finite(value.x, fallback?.x ?? 0),
    y: finite(value.y, fallback?.y ?? 0),
    widthCm: finite(value.widthCm, fallback?.widthCm ?? 1),
    heightCm: finite(value.heightCm, fallback?.heightCm ?? 1),
  };
  if (box.widthCm <= 1e-6 || box.heightCm <= 1e-6) {
    if (!fallback) return null;
    box.widthCm = Math.max(1e-6, fallback.widthCm);
    box.heightCm = Math.max(1e-6, fallback.heightCm);
  }
  return box;
}

/** The union of the pieces' own boxes, in pattern centimetres. */
export function defaultSharedUvBox(pieces: readonly PatternPiece[]): UvBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const piece of pieces) {
    if (piece.points.length < 2) continue;
    const box = pieceUvBounds(piece);
    minX = Math.min(minX, box.min.x);
    minY = Math.min(minY, box.min.y);
    maxX = Math.max(maxX, box.max.x);
    maxY = Math.max(maxY, box.max.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: 0, y: 0, widthCm: 40, heightCm: 40 };
  }
  return {
    x: minX,
    y: minY,
    widthCm: Math.max(maxX - minX, 1e-3),
    heightCm: Math.max(maxY - minY, 1e-3),
  };
}

/** The reference box a shared pattern maps with. */
export function sharedUvBoxFor(pattern: PatternDocument | null | undefined): UvBox {
  const fallback = defaultSharedUvBox(pattern?.pieces ?? []);
  return normalizeUvBox(pattern?.uvSharedBox, fallback) ?? fallback;
}

/** True when a pattern's pieces all map through one reference box. */
export function patternUsesSharedUvs(pattern: PatternDocument | null | undefined): boolean {
  return pattern?.uvMode === 'shared';
}

/**
 * The rectangle in pattern space whose corners are UV (0,0) and (1,1) for one
 * piece. This is the box the Remesh overlay draws: dragging it changes the
 * offset, and its corners change the scale.
 */
export function uvBoxForPiece(piece: PatternPiece): UvBox {
  const bounds = pieceUvBounds(piece);
  const uv = normalizePieceUv(piece.uv);
  const widthCm = bounds.max.x - bounds.min.x;
  const heightCm = bounds.max.y - bounds.min.y;
  const scaleX = Math.abs(uv.scaleX) > 1e-6 ? uv.scaleX : 1e-6;
  const scaleY = Math.abs(uv.scaleY) > 1e-6 ? uv.scaleY : 1e-6;
  return {
    x: bounds.min.x - (uv.offsetX * widthCm) / scaleX,
    y: bounds.min.y - (uv.offsetY * heightCm) / scaleY,
    widthCm: Math.max(Math.abs(widthCm / scaleX), 1e-6),
    heightCm: Math.max(Math.abs(heightCm / scaleY), 1e-6),
  };
}

/** The transform that puts a piece's UV box at `box` (the inverse of `uvBoxForPiece`). */
export function pieceUvForBox(piece: PatternPiece, box: UvBox): PieceUvTransform {
  const bounds = pieceUvBounds(piece);
  const widthCm = Math.max(bounds.max.x - bounds.min.x, 1e-9);
  const heightCm = Math.max(bounds.max.y - bounds.min.y, 1e-9);
  const width = Math.max(box.widthCm, 1e-6);
  const height = Math.max(box.heightCm, 1e-6);
  return {
    scaleX: widthCm / width,
    scaleY: heightCm / height,
    offsetX: (bounds.min.x - box.x) / width,
    offsetY: (bounds.min.y - box.y) / height,
  };
}

/**
 * The mapping a child of a cut keeps: the same slice of the image it showed
 * before, expressed over the child's smaller box, so a cut does not re-fit the
 * texture onto each half.
 */
export function splitPieceUv(parent: PatternPiece, child: PatternPiece): PieceUvTransform {
  const uv = normalizePieceUv(parent.uv);
  const parentBox = pieceUvBounds(parent);
  const childBox = pieceUvBounds(child);
  const parentWidth = parentBox.max.x - parentBox.min.x;
  const parentHeight = parentBox.max.y - parentBox.min.y;
  if (parentWidth <= 1e-9 || parentHeight <= 1e-9) return { ...uv };
  return {
    scaleX: (uv.scaleX * (childBox.max.x - childBox.min.x)) / parentWidth,
    scaleY: (uv.scaleY * (childBox.max.y - childBox.min.y)) / parentHeight,
    offsetX: uv.offsetX + (uv.scaleX * (childBox.min.x - parentBox.min.x)) / parentWidth,
    offsetY: uv.offsetY + (uv.scaleY * (childBox.min.y - parentBox.min.y)) / parentHeight,
  };
}

function uvInBox(
  point: Vec2,
  box: { min: Vec2; max: Vec2 },
  uv: PieceUvTransform
): [number, number] {
  const width = box.max.x - box.min.x;
  const height = box.max.y - box.min.y;
  const u = width > 1e-9 ? (point.x - box.min.x) / width : 0;
  const v = height > 1e-9 ? (point.y - box.min.y) / height : 0;
  return [u * uv.scaleX + uv.offsetX, v * uv.scaleY + uv.offsetY];
}

/**
 * The UVs of a piece's mesh vertices, two floats per vertex, in the order the
 * vertices are given.
 */
export function pieceMeshUvs(piece: PatternPiece, vertices: readonly Vec2[]): number[] {
  const box = pieceUvBounds(piece);
  const uv = normalizePieceUv(piece.uv);
  const out = new Array<number>(vertices.length * 2);
  for (let i = 0; i < vertices.length; i++) {
    const [u, v] = uvInBox(vertices[i], box, uv);
    out[i * 2] = u;
    out[i * 2 + 1] = v;
  }
  return out;
}

/** The normalised planar UVs of a whole mesh — the fallback for a piece with no mapping. */
export function planarMeshUvs(vertices: readonly Vec2[]): number[] {
  const box = boundsOf(vertices as Vec2[]);
  const uv = DEFAULT_PIECE_UV;
  const out = new Array<number>(vertices.length * 2);
  for (let i = 0; i < vertices.length; i++) {
    const [u, v] = uvInBox(vertices[i], box, uv);
    out[i * 2] = u;
    out[i * 2 + 1] = v;
  }
  return out;
}

/** UVs for every vertex read through one shared reference box. */
export function sharedMeshUvs(vertices: readonly Vec2[], box: UvBox): number[] {
  const bounds = {
    min: { x: box.x, y: box.y },
    max: { x: box.x + Math.max(box.widthCm, 1e-6), y: box.y + Math.max(box.heightCm, 1e-6) },
  };
  const out = new Array<number>(vertices.length * 2);
  for (let i = 0; i < vertices.length; i++) {
    const [u, v] = uvInBox(vertices[i], bounds, DEFAULT_PIECE_UV);
    out[i * 2] = u;
    out[i * 2 + 1] = v;
  }
  return out;
}

/**
 * UVs for an already-built mesh: the baked `uvs` when they are the right size,
 * otherwise recomputed from the pieces its vertices belong to. Older saved
 * meshes have no baked UVs, and a piece whose id is missing falls back to the
 * whole mesh's box so the cloth still samples something sensible.
 */
export function uvsForGeometry(
  geometry: Pick<MeshGeometry, 'vertices' | 'uvs' | 'vertexPieceIds'>,
  pattern?: PatternDocument | null
): Float32Array {
  if (geometry.uvs && geometry.uvs.length === geometry.vertices.length * 2) {
    return Float32Array.from(geometry.uvs);
  }
  return Float32Array.from(computedUvsForGeometry(geometry, pattern));
}

/** Always recomputes, for a live edit that must not trust the baked copy. */
export function computedUvsForGeometry(
  geometry: Pick<MeshGeometry, 'vertices' | 'vertexPieceIds'>,
  pattern?: PatternDocument | null
): number[] {
  if (patternUsesSharedUvs(pattern)) {
    return sharedMeshUvs(geometry.vertices, sharedUvBoxFor(pattern));
  }
  const pieces = pattern?.pieces ?? [];
  const byId = new Map(pieces.map((piece) => [piece.id, piece]));
  const frames = new Map<string, { box: { min: Vec2; max: Vec2 }; uv: PieceUvTransform }>();
  const fallbackFrame = {
    box: boundsOf(geometry.vertices as Vec2[]),
    uv: DEFAULT_PIECE_UV,
  };
  const out = new Array<number>(geometry.vertices.length * 2);
  for (let i = 0; i < geometry.vertices.length; i++) {
    const pieceId = geometry.vertexPieceIds?.[i] ?? null;
    let frame = pieceId ? frames.get(pieceId) : undefined;
    if (!frame) {
      const piece = pieceId ? byId.get(pieceId) : undefined;
      frame = piece
        ? { box: pieceUvBounds(piece), uv: normalizePieceUv(piece.uv) }
        : fallbackFrame;
      if (pieceId) frames.set(pieceId, frame);
    }
    const [u, v] = uvInBox(geometry.vertices[i], frame.box, frame.uv);
    out[i * 2] = u;
    out[i * 2 + 1] = v;
  }
  return out;
}
