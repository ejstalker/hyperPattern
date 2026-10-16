import { vec3 } from 'gl-matrix';
import type { Particle } from './Particle';

/**
 * Give back the tangential travel a gripped particle just made over `stepSeconds`.
 *
 * Velocity damping alone tops out at "no tangential speed left", which still
 * lets cloth creep wherever a tangential load keeps re-applying it — a skirt on
 * a smooth body slides down however high the damping is. Taking the
 * displacement back is what makes a high grip *hold*: at hold = 1 the particle
 * keeps none of its tangential step and stays where the contact caught it, while
 * hold = 0 (every grip up to `GRIP_SLIDE_LIMIT`) leaves the old behaviour
 * untouched. It is applied before the normal projection, which is orthogonal to
 * it either way.
 */
export function holdTangentialTravel(
  p: Particle,
  normal: vec3,
  contact?: { hold?: number; stepSeconds?: number }
): void {
  const hold = contact?.hold ?? 0;
  const step = contact?.stepSeconds ?? 0;
  if (hold <= 0 || step <= 0) return;
  const vel = p.getVelocity();
  const vn = vec3.dot(vel, normal);
  const slip = vec3.create();
  vec3.scale(slip, normal, vn);
  vec3.sub(slip, vel, slip);
  const pos = p.getPosition();
  vec3.scaleAndAdd(pos, pos, slip, -hold * step);
}
