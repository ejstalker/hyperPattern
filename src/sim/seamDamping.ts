/**
 * Viscosity for the material around a stitch.
 *
 * A seam is the one place in a garment where the solver asks for two
 * incompatible things at once: the stitch pulls its two rows to their sewn gap,
 * the contact model wants a cloth thickness between layers that have been sewn
 * together, and bending wants the panels flat across the join. No number of
 * iterations settles that — it is a conflict, not slow convergence — so a
 * little residual motion is regenerated at the seam every substep. Measured on
 * a two-layer circle skirt, particles within two edges of a stitch moved 3×
 * more than the cloth around them, and the whole drape read as a fine crawl.
 *
 * Real seams are not ordinary fabric either: the seam allowance doubles the
 * material and the thread runs through it, so it is both stiffer and much more
 * damped than the panel. This damps the *velocity* of that band only — nothing
 * else about the cloth changes, so the panels keep their weight and swing.
 */
export const SEAM_DAMPING_RINGS = 2;

/**
 * How quickly the seam band's velocity decays, in seconds.
 *
 * Tuned on a two-layer circle skirt at 14 substeps: the jitter within two edges
 * of a stitch fell from 0.035 to 0.0095 edge-lengths per frame, and the band
 * still moves about as much as the cloth around it (0.0095 against 0.0085), so a
 * moving seam does not read as frozen. Shorter time constants keep improving the
 * number but start to deaden the seam instead of calming it.
 */
export const SEAM_VELOCITY_DECAY_SECONDS = 0.025;

/**
 * Particles within `rings` edges of a stitch.
 *
 * `oneRingOffsets[i]..oneRingOffsets[i+1]` indexes `oneRingNeighbors`, the same
 * CSR the solver uses.
 */
export function seamBandMask(
  particleCount: number,
  oneRingOffsets: ArrayLike<number>,
  oneRingNeighbors: ArrayLike<number>,
  seamPairs: ReadonlyArray<readonly [number, number]>,
  rings = SEAM_DAMPING_RINGS
): Uint8Array {
  const mask = new Uint8Array(particleCount);
  for (const [a, b] of seamPairs) {
    if (a < particleCount) mask[a] = 1;
    if (b < particleCount) mask[b] = 1;
  }
  for (let pass = 0; pass < Math.max(0, rings); pass++) {
    const added: number[] = [];
    for (let i = 0; i < particleCount; i++) {
      if (mask[i]) continue;
      const from = oneRingOffsets[i] ?? 0;
      const to = oneRingOffsets[i + 1] ?? 0;
      for (let k = from; k < to; k++) {
        if (mask[oneRingNeighbors[k]!]) {
          added.push(i);
          break;
        }
      }
    }
    if (added.length === 0) break;
    for (const i of added) mask[i] = 1;
  }
  return mask;
}

/** Share of the band's velocity kept over one frame of `dtSeconds`. */
export function seamVelocityRetain(
  dtSeconds: number,
  decaySeconds = SEAM_VELOCITY_DECAY_SECONDS
): number {
  if (!(dtSeconds > 0) || !(decaySeconds > 0)) return 1;
  return Math.max(0, Math.min(1, Math.exp(-dtSeconds / decaySeconds)));
}
