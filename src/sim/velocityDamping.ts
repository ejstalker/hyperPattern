/**
 * Velocity retention for one integration substep.
 *
 * `velocityDamping` is a *per frame* fraction (0.998 = keep 99.8 % of the speed
 * over a frame). Applying that number once per substep makes the fabric's drag
 * depend on how finely the frame happens to be sliced: at 24 substeps it becomes
 * 0.998²⁴ ≈ 0.953 per frame — forty-four times the intended damping rate, which
 * is enough to turn a drape into syrup. Taking the substeps-th root keeps the
 * per-frame rate exactly what the slider says, at any substep count, in both
 * engines.
 *
 * The floor of 0.9 caps the rate a frame may remove at 10 %.
 */
export function perSubstepRetain(damping: number | undefined, substeps: number): number {
  const perFrame = Math.min(1, Math.max(0.9, damping ?? 0.998));
  const steps = Math.max(1, Math.round(substeps));
  if (perFrame >= 1) return 1;
  return Math.pow(perFrame, 1 / steps);
}
