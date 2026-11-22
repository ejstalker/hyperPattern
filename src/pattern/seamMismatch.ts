/**
 * How far a sewn edge is from matching the fabric sewn to it.
 *
 * A seam is a promise that two edges are the same length: the mesher pairs
 * stitches along arc length, so a waistband drafted 2 cm longer than the skirt it
 * is sewn to gathers one of them into folds rather than fitting. The editor shows
 * the difference beside each edge so it can be evened out by moving the points
 * that shape either side.
 *
 * Measured edge by edge rather than seam by seam. Many-to-many sewing cuts an
 * edge into spans, one per partner, but a draughtsperson resizes an edge, not a
 * span — so an edge's spans are added up and compared with everything sewn along
 * it, and it gets one number.
 */

import type { PatternPiece, SeamBinding, SeamEdgeRef } from '../project/types';
import { edgeArcLengthBetweenParams } from './geometry';

/** A sewn edge whose length does not match the fabric sewn to it. */
export type SeamEdgeLengthGap = {
  /** The edge, covering everything sewn along it. */
  ref: SeamEdgeRef;
  /** Arc length of the part of the edge that is sewn. */
  lengthCm: number;
  /** Everything sewn to it, added up. */
  partnerCm: number;
  /** Positive when this edge is longer than what it is sewn to. */
  differenceCm: number;
};

/** Below this a difference is float noise, not drafting. */
const NEGLIGIBLE_CM = 1e-6;

type EdgeTally = {
  ref: SeamEdgeRef;
  lengthCm: number;
  partnerCm: number;
  /** Spans already counted, so an edge bound in two halves is not measured twice. */
  spans: Set<string>;
};

/**
 * Every sewn edge whose length differs from its partners'.
 *
 * Both sides of a mismatch are reported, with opposite signs: the longer edge
 * says how much it has to give, the shorter how much it is missing. Seams whose
 * edges are gone from the pattern are skipped — a stale seam already says so.
 */
export function seamEdgeLengthGaps(
  pieces: readonly PatternPiece[],
  seams: readonly SeamBinding[]
): SeamEdgeLengthGap[] {
  const byEdge = new Map<string, EdgeTally>();

  const add = (
    ref: SeamEdgeRef,
    lengthCm: number,
    partnerCm: number
  ): void => {
    const key = `${ref.pieceId}|${ref.fromPointId}|${ref.toPointId}`;
    let tally = byEdge.get(key);
    if (!tally) {
      tally = { ref: { ...ref }, lengthCm: 0, partnerCm: 0, spans: new Set() };
      byEdge.set(key, tally);
    }
    const span = `${Math.min(ref.t0, ref.t1).toFixed(5)}|${Math.max(ref.t0, ref.t1).toFixed(5)}`;
    if (!tally.spans.has(span)) {
      tally.spans.add(span);
      tally.lengthCm += lengthCm;
    }
    tally.partnerCm += partnerCm;
    // The number hangs beside the part of the edge that is actually sewn.
    tally.ref.t0 = Math.min(tally.ref.t0, ref.t0, ref.t1);
    tally.ref.t1 = Math.max(tally.ref.t1, ref.t0, ref.t1);
  };

  for (const seam of seams) {
    const pieceA = pieces.find((p) => p.id === seam.a.pieceId);
    const pieceB = pieces.find((p) => p.id === seam.b.pieceId);
    if (!pieceA || !pieceB) continue;
    const lengthA = edgeArcLengthBetweenParams(
      pieceA,
      seam.a.fromPointId,
      seam.a.toPointId,
      seam.a.t0,
      seam.a.t1
    );
    const lengthB = edgeArcLengthBetweenParams(
      pieceB,
      seam.b.fromPointId,
      seam.b.toPointId,
      seam.b.t0,
      seam.b.t1
    );
    if (lengthA <= NEGLIGIBLE_CM || lengthB <= NEGLIGIBLE_CM) continue;
    add(seam.a, lengthA, lengthB);
    add(seam.b, lengthB, lengthA);
  }

  const gaps: SeamEdgeLengthGap[] = [];
  for (const { ref, lengthCm, partnerCm } of byEdge.values()) {
    const differenceCm = lengthCm - partnerCm;
    if (Math.abs(differenceCm) <= NEGLIGIBLE_CM) continue;
    gaps.push({ ref, lengthCm, partnerCm, differenceCm });
  }
  return gaps;
}
