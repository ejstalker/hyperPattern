import type { BezierPoint, PatternDocument } from '../project/types';

/** Points are compared to a ten-thousandth of a unit: a smaller move is not geometry. */
const PRECISION = 4;

/**
 * A cheap fingerprint of the geometry a pattern draws.
 *
 * A pattern fires a change for far more than geometry — selecting a point,
 * restyling a note, typing in a ruler — and rebuilding a running drape on each
 * of those would do the same work over and over. Comparing fingerprints is how
 * a live remesh knows an edit actually moved something.
 */
export function patternGeometrySignature(
  pattern: PatternDocument | null | undefined
): string {
  if (!pattern) return '';
  const parts: string[] = [];
  for (const piece of pattern.pieces) {
    parts.push(piece.id, piece.closed ? 'c' : 'o');
    pushPoints(parts, piece.points);
    for (const hole of piece.holes ?? []) {
      parts.push('h');
      pushPoints(parts, hole);
    }
  }
  // Seams decide where the mesher forces a shared sample count, so a seam edit
  // changes the mesh even when no point moved.
  for (const seam of pattern.seams) {
    for (const side of [seam.a, seam.b]) {
      parts.push(
        side.pieceId,
        side.fromPointId,
        side.toPointId,
        side.t0.toFixed(PRECISION),
        side.t1.toFixed(PRECISION)
      );
    }
  }
  return parts.join('|');
}

function pushPoints(out: string[], points: readonly BezierPoint[]): void {
  for (const point of points) {
    out.push(point.id, coord(point.anchor.x), coord(point.anchor.y));
    // A handle shapes the curve between two points, so it is geometry too.
    for (const handle of [point.handleIn, point.handleOut]) {
      if (handle) out.push(coord(handle.x), coord(handle.y));
      else out.push('-');
    }
  }
}

function coord(value: number): string {
  return value.toFixed(PRECISION);
}
