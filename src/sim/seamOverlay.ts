/**
 * The stitch pairs the overlay should draw.
 *
 * A ghosted piece is out of the simulation — no mass, no constraints, no claim
 * on anything it was sewn to. Its stitches still exist as data, so drawing them
 * would say the opposite of what ghosting means: the seam is not holding that
 * piece to anything. Dropping them here keeps the overlay honest, and matches
 * the CPU engine, which takes ghosted pieces out of its seam springs.
 */
export function stitchOverlayPairs(
  pairs: ReadonlyArray<readonly [number, number]>,
  vertexPieceIds: readonly string[],
  ghostedPieceIds: ReadonlySet<string>
): Array<[number, number]> {
  if (ghostedPieceIds.size === 0) return pairs.map(([a, b]) => [a, b]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of pairs) {
    if (ghostedPieceIds.has(vertexPieceIds[a] ?? '')) continue;
    if (ghostedPieceIds.has(vertexPieceIds[b] ?? '')) continue;
    out.push([a, b]);
  }
  return out;
}
