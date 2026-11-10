/**
 * Carry a running cloth's particles onto a rebuilt mesh.
 *
 * Fitting a pattern is a loop of small moves: a point is nudged, the drape is
 * looked at, the point is nudged again. Rebuilding the cloth from its rest layout
 * would throw the drape away every time, so instead every particle of the new
 * cloth takes the old particle nearest it — plus however far that part of the
 * pattern moved, so the fabric follows the edit rather than merely keeping the
 * shape it had.
 *
 * Nearest is measured *within a piece*: the panels of a pattern lie close to one
 * another in the flat layout, and a particle that took over one from the panel
 * next door would drag the fabric apart. Only a particle whose piece is new has
 * to look outside its own panel.
 *
 * Pure arithmetic over flat xyz arrays, so the rules can be tested without a GPU.
 */

export type ClothParticles = {
  /** Live world positions, xyz interleaved. */
  positions: ArrayLike<number>;
  /** Live velocities, xyz interleaved, when the cloth had them. */
  velocities?: ArrayLike<number> | null;
  /** The flat layout the old cloth was built from, xyz interleaved. */
  rest: ArrayLike<number>;
  /** Which piece each particle belongs to, when the cloth knows. */
  pieceIds?: readonly string[] | null;
};

export type CarriedParticles = {
  /** Positions for the new cloth, xyz interleaved. */
  positions: number[];
  /** Velocities for the new cloth, xyz interleaved. */
  velocities: number[];
};

/**
 * Whether a stored pose describes this cloth.
 *
 * A pose is a vertex-for-vertex record of one mesh: after the pattern is re-cut
 * every index means something else, and applying the old numbers by index would
 * scramble the drape into spikes. An unknown rest layout cannot be judged, so it
 * is taken on trust.
 */
export function poseFitsCloth(
  positions: ArrayLike<number>,
  particleCount: number | null
): boolean {
  if (positions.length < 12) return false;
  if (!particleCount || particleCount <= 0) return true;
  return positions.length === particleCount * 3;
}

/**
 * The new cloth's particles, carried over from the old cloth's live pose.
 *
 * Null when there is nothing to carry: no old particles, or live positions that
 * do not match them. The caller then rebuilds from scratch, which is what a
 * fresh drape does anyway.
 */
export function carryParticles(
  before: ClothParticles,
  afterRest: ArrayLike<number>,
  afterPieceIds?: readonly string[] | null
): CarriedParticles | null {
  const oldCount = Math.floor(before.rest.length / 3);
  const newCount = Math.floor(afterRest.length / 3);
  if (oldCount === 0 || newCount === 0) return null;
  if (Math.floor(before.positions.length / 3) < oldCount) return null;

  const positions = new Array<number>(newCount * 3);
  const velocities = new Array<number>(newCount * 3);

  if (sameParticles(before.pieceIds, afterPieceIds, oldCount, newCount)) {
    // The same tessellation — a point moved without changing how the piece is
    // cut up — so particle i is particle i, motion and all.
    for (let i = 0; i < newCount * 3; i++) {
      positions[i] = before.positions[i] ?? 0;
      velocities[i] = before.velocities?.[i] ?? 0;
    }
    return { positions, velocities };
  }

  const nearest = nearestIndices(
    before.rest,
    afterRest,
    oldCount,
    newCount,
    before.pieceIds ?? null,
    afterPieceIds ?? null
  );
  for (let i = 0; i < newCount; i++) {
    const from = nearest[i]!;
    for (let axis = 0; axis < 3; axis++) {
      const o = from * 3 + axis;
      const n = i * 3 + axis;
      positions[n] = (before.positions[o] ?? 0) + ((afterRest[n] ?? 0) - (before.rest[o] ?? 0));
      // Velocities are not resampled: the motion restarts from rest, which reads
      // as a moment of stillness rather than a jump.
      velocities[n] = 0;
    }
  }
  return { positions, velocities };
}

/**
 * Whether the two cloths are the same cloth particle for particle.
 *
 * The count alone is not enough: a cut that closes one hole and opens another
 * can leave the count where it was while every index now means something else,
 * and copying across that would scramble the drape. Without piece tags there is
 * nothing to compare, so the count has to do.
 */
function sameParticles(
  beforeIds: readonly string[] | null | undefined,
  afterIds: readonly string[] | null | undefined,
  oldCount: number,
  newCount: number
): boolean {
  if (oldCount !== newCount) return false;
  if (!beforeIds || !afterIds) return true;
  if (beforeIds.length < oldCount || afterIds.length < newCount) return true;
  for (let i = 0; i < oldCount; i++) {
    if (beforeIds[i] !== afterIds[i]) return false;
  }
  return true;
}

/**
 * For each point of `to`, the index of the nearest point of `from`.
 *
 * Two clouds of the same fabric, so neighbours are local: a uniform grid makes
 * each query a walk out from its own cell, ending as soon as nothing outside the
 * ring walked can be closer.
 *
 * One grid per piece, because nearest is measured within a piece — and because a
 * piece the old cloth never had must not turn the search into a walk across the
 * whole layout. A particle whose piece is unknown takes the nearest of any piece
 * instead, from the whole cloth's grid. Both searches are bounded by the cells
 * they visit, never by the particle count all over again: a re-cut of forty
 * thousand particles is a few tens of milliseconds, not minutes.
 */
function nearestIndices(
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  oldCount: number,
  newCount: number,
  fromPieceIds: readonly string[] | null,
  toPieceIds: readonly string[] | null
): Uint32Array {
  const out = new Uint32Array(newCount);
  if (oldCount === 0) return out;

  const tagged =
    !!fromPieceIds && fromPieceIds.length >= oldCount && !!toPieceIds && toPieceIds.length >= newCount;
  // One grid per piece the old cloth had, built the first time a particle asks
  // for it, plus the whole cloth for anything with no piece here to match: an
  // untagged cloth, or a piece the edit created.
  const byPiece = new Map<string, Int32Array>();
  const grids = new Map<string, Grid>();
  let whole: Grid | null = null;
  if (tagged) {
    const lists = new Map<string, number[]>();
    for (let i = 0; i < oldCount; i++) {
      const piece = fromPieceIds![i] ?? '';
      const bucket = lists.get(piece);
      if (bucket) bucket.push(i);
      else lists.set(piece, [i]);
    }
    for (const [piece, indices] of lists) byPiece.set(piece, Int32Array.from(indices));
  }
  const wholeGrid = (): Grid =>
    (whole ??= buildGrid(
      from,
      Int32Array.from({ length: oldCount }, (_, i) => i),
      WHOLE_CLOTH_PARTICLE_BUDGET
    ));

  for (let j = 0; j < newCount; j++) {
    const x = to[j * 3] ?? 0;
    const y = to[j * 3 + 1] ?? 0;
    const z = to[j * 3 + 2] ?? 0;
    const piece = tagged ? toPieceIds![j] ?? '' : null;
    const indices = piece !== null ? byPiece.get(piece) : undefined;
    let grid: Grid;
    if (indices) {
      grid = grids.get(piece!) ?? buildGrid(from, indices, PIECE_PARTICLE_BUDGET);
      grids.set(piece!, grid);
    } else {
      grid = wholeGrid();
    }
    out[j] = nearestInGrid(grid, from, x, y, z);
  }
  return out;
}

/**
 * Particles a search may look at before it settles for the coarse sample.
 *
 * A query that has a neighbour settles in a ring or two; this is the ceiling for
 * the ones that do not — a corner of the cloth with nothing of its own near it.
 * Counting particles rather than cells is what keeps the ceiling real: a grid of
 * empty cells costs nothing to walk, a cell packed with fabric costs everything.
 */
const PIECE_PARTICLE_BUDGET = 128;
/**
 * The same ceiling for the whole cloth, used when a particle has no piece to
 * match: none at all. The answer is a stand-in for a panel that did not exist
 * before, so the nearest of a sample of the cloth is as good as a walk across it,
 * and a walk across it is what made a new panel cost minutes.
 */
const WHOLE_CLOTH_PARTICLE_BUDGET = 0;

/** Particle indices of one piece, bucketed into a uniform grid over its layout. */
type Grid = {
  start: Int32Array;
  items: Int32Array;
  /** Every k-th particle, for a nearest when the rings run out. */
  coarse: Int32Array;
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  /** Square cells: one size on both axes. */
  cell: number;
  /** Particles the walk may look at before it settles for the coarse sample. */
  budget: number;
};

function buildGrid(from: ArrayLike<number>, indices: Int32Array, budget: number): Grid {
  const count = indices.length;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < count; k++) {
    const i = indices[k]!;
    const x = from[i * 3] ?? 0;
    const y = from[i * 3 + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    return {
      start: new Int32Array(2),
      items: new Int32Array(0),
      coarse: new Int32Array(0),
      minX: 0,
      minY: 0,
      cols: 1,
      rows: 1,
      cell: 1,
      budget,
    };
  }
  const width = maxX - minX;
  const height = maxY - minY;
  // A square cell holding about one particle, so a query usually settles in its
  // own cell and the rings after it are spent on a handful of neighbours. The
  // same size on both axes: a panel that is a strip — a waistband, a grainline
  // sliver — must not be cut into cells its neighbours are never in.
  const cell = Math.max(Math.sqrt(Math.max(width * height, 1e-12) / Math.max(1, count)), 1e-6);
  // Never more cells than particles: a cloth on a line still gets one bucket per
  // particle, and the walk stays bounded by the particles there are.
  const cols = Math.max(1, Math.min(count, Math.ceil(width / cell) || 1));
  const rows = Math.max(1, Math.min(count, Math.ceil(height / cell) || 1));
  const cellOfX = (x: number): number =>
    Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell)));
  const cellOfY = (y: number): number =>
    Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell)));

  const start = new Int32Array(cols * rows + 1);
  const cells = new Int32Array(count);
  for (let k = 0; k < count; k++) {
    const i = indices[k]!;
    const cell = cellOfY(from[i * 3 + 1] ?? 0) * cols + cellOfX(from[i * 3] ?? 0);
    cells[k] = cell;
    start[cell + 1]! += 1;
  }
  for (let cell = 0; cell < cols * rows; cell++) start[cell + 1]! += start[cell]!;
  const fill = start.slice(0, cols * rows);
  const items = new Int32Array(count);
  for (let k = 0; k < count; k++) {
    items[fill[cells[k]!]!] = indices[k]!;
    fill[cells[k]!]! += 1;
  }
  const stride = Math.max(1, Math.ceil(count / 256));
  const coarse = new Int32Array(Math.ceil(count / stride));
  for (let k = 0, c = 0; k < count; k += stride, c++) coarse[c] = items[k]!;
  return {
    start,
    items,
    coarse,
    minX,
    minY,
    cols,
    rows,
    cell,
    budget,
  };
}

/**
 * The index of the point of `grid` nearest (x, y, z).
 *
 * Rings are walked outwards and the search stops as soon as the best hit is
 * within reach of what has been walked. A grid whose cells are mostly empty —
 * a skirt's band, a thin panel — settles in a ring or two. A piece that is
 * nowhere near where it used to be would otherwise walk the whole layout, so
 * there is a budget: once it is spent, the nearest of a few hundred sampled
 * particles is a better answer than a walk to the far corner.
 */
function nearestInGrid(grid: Grid, from: ArrayLike<number>, x: number, y: number, z: number): number {
  const { start, items, minX, minY, cols, rows, cell } = grid;
  if (items.length === 0) return 0;
  const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell)));
  const cy = Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell)));
  const maxRing = Math.max(cols, rows) - 1;
  let best = -1;
  let bestDist = Infinity;
  let seen = 0;
  let exhausted = false;
  for (let ring = 0; ring <= maxRing && grid.budget > 0; ring++) {
    // Walked inside the grid only: a strip's row runs out long before its
    // column does, and the rings past that have nothing left to visit.
    const yFrom = Math.max(-ring, -cy);
    const yTo = Math.min(ring, rows - 1 - cy);
    const xFrom = Math.max(-ring, -cx);
    const xTo = Math.min(ring, cols - 1 - cx);
    if (yFrom > yTo || xFrom > xTo) {
      exhausted = true;
      break;
    }
    for (let dy = yFrom; dy <= yTo; dy++) {
      const gy = cy + dy;
      const edgeRow = Math.abs(dy) === ring;
      // On the ring's own rows every column; on the rows inside it, only the two
      // ends — the middle was walked by a smaller ring.
      const step = edgeRow ? 1 : Math.max(1, xTo - xFrom);
      for (let dx = xFrom; dx <= xTo; dx += step) {
        const gx = cx + dx;
        const cellIndex = gy * cols + gx;
        const end = start[cellIndex + 1]!;
        for (let s = start[cellIndex]!; s < end; s++) {
          const i = items[s]!;
          const ddx = (from[i * 3] ?? 0) - x;
          const ddy = (from[i * 3 + 1] ?? 0) - y;
          const ddz = (from[i * 3 + 2] ?? 0) - z;
          const distance = ddx * ddx + ddy * ddy + ddz * ddz;
          if (distance < bestDist) {
            bestDist = distance;
            best = i;
          }
        }
        seen += end - start[cellIndex]!;
      }
    }
    // Nothing outside the rings walked can be nearer than this: the query point
    // can sit anywhere in its own cell, so the nearest unvisited cell is a whole
    // ring of cells away.
    if (best >= 0 && bestDist <= (ring * cell) ** 2) return best;
    if (seen >= grid.budget) break;
    if (ring === maxRing) exhausted = true;
  }
  if (exhausted && best >= 0) return best;
  // The walk ran out of rings before it ran out of cloth: the nearest of a sample
  // of it is a better stand-in than whatever the corner of the walk happened to
  // hold, and a fixed 256 reads instead of another sweep of the layout.
  for (const i of grid.coarse) {
    const ddx = (from[i * 3] ?? 0) - x;
    const ddy = (from[i * 3 + 1] ?? 0) - y;
    const ddz = (from[i * 3 + 2] ?? 0) - z;
    const distance = ddx * ddx + ddy * ddy + ddz * ddz;
    if (distance < bestDist) {
      bestDist = distance;
      best = i;
    }
  }
  return best >= 0 ? best : items[0]!;
}
