/**
 * How a per-frame contact correction is eased into the committed positions.
 *
 * The GPU solver resolves contact against the avatar inside every substep; the
 * CPU pass that runs on the readback is a second, *slower* opinion (it sees the
 * exact triangle mesh rather than the baked SDF proxy, so it is the authority
 * on where the surface really is). Its correction used to be applied in full,
 * once per frame — a jump in the positions the substep constraints had already
 * settled, which they then pulled straight back. On a resting circle skirt that
 * moved 9 % of the mesh by about 0.2 of an edge every single frame, and the
 * ripple read as a fine turbulent crawl over the whole garment.
 *
 * Taking a fraction of it per frame converges to the same place — the same
 * correction is proposed again next frame — but the cloth eases out of the body
 * instead of snapping in and out of it.
 */
export const CPU_CONTACT_RELAX = 0.15;

/** One frame of that easing: `current` moved a fraction of the way to `target`. */
export function relaxContactPush(current: number, target: number, moved: boolean): number {
  if (!moved) return current;
  return current + (target - current) * CPU_CONTACT_RELAX;
}
