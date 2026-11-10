import type { PatternDocument, PatternGroup, PatternPiece } from '../project/types';

/**
 * Groups inside a pattern: the same idea as the groups on the board, for pieces
 * rather than nodes.
 *
 * A pattern group owns nothing. What it holds is worked out from where the pieces
 * are, so dragging a piece into the frame puts it in the group and dragging it out
 * takes it out again — a copied, undone or re-cut pattern can never end up with a
 * group pointing at pieces that are no longer where they were.
 */

/** The rectangle a piece occupies, in pattern centimetres, from its anchors. */
export function pieceRect(piece: PatternPiece): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of piece.points) {
    if (point.anchor.x < minX) minX = point.anchor.x;
    if (point.anchor.x > maxX) maxX = point.anchor.x;
    if (point.anchor.y < minY) minY = point.anchor.y;
    if (point.anchor.y > maxY) maxY = point.anchor.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Is `inner` wholly inside `outer`? Touching an edge counts as inside. */
function contains(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number }
): boolean {
  const slack = 0.05;
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

export const patternGroups = (pattern: PatternDocument | null | undefined): PatternGroup[] =>
  pattern?.groups ?? [];

/** The frame as a plain rectangle, which is all the containment test needs. */
export function groupRect(group: PatternGroup): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return { x: group.x, y: group.y, width: group.widthCm, height: group.heightCm };
}

/** The pieces a group holds: those lying wholly inside its frame, in piece order. */
export function piecesInGroup(
  pattern: PatternDocument | null | undefined,
  group: PatternGroup
): PatternPiece[] {
  if (!pattern) return [];
  return pattern.pieces.filter((piece) => contains(groupRect(group), pieceRect(piece)));
}

/**
 * The groups a piece belongs to, innermost first — the tighter frame is the more
 * specific group, which is what decides what a click on the piece is picking.
 */
export function groupsForPiece(
  pattern: PatternDocument | null | undefined,
  pieceId: string
): PatternGroup[] {
  const piece = pattern?.pieces.find((entry) => entry.id === pieceId);
  if (!pattern || !piece) return [];
  const rect = pieceRect(piece);
  return patternGroups(pattern)
    .filter((group) => contains(groupRect(group), rect))
    .sort((a, b) => a.widthCm * a.heightCm - b.widthCm * b.heightCm);
}

/** Where a new group's frame goes: round the pieces it was drawn over. */
export function groupBoxForPieces(pieces: readonly PatternPiece[]): {
  x: number;
  y: number;
  widthCm: number;
  heightCm: number;
} | null {
  if (pieces.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const piece of pieces) {
    const rect = pieceRect(piece);
    if (rect.x < minX) minX = rect.x;
    if (rect.y < minY) minY = rect.y;
    if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
    if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
  }
  return { x: minX, y: minY, widthCm: maxX - minX, heightCm: maxY - minY };
}
