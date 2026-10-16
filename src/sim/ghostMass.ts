/**
 * How a ghosted particle is marked in the XPBD weight arrays.
 *
 * Every solver kernel skips a constraint whose weight sum is not positive
 * (`wSum <= 0`), which is how a *frozen* particle (inverse mass 0) still takes
 * part while a ghosted one does not. Particle inverse masses are `1 / mass`
 * and are routinely far larger than 1 — this project's cloth sits near 55 — so
 * a marker of -1 would lose that test against a live neighbour and the ghost
 * would be dragged around the scene. The sentinel therefore has to outweigh any
 * sum of live weights, which is what `ghostInverseMass` builds from the cloth's
 * own weights.
 */
export function ghostInverseMass(invMasses: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < invMasses.length; i++) total += invMasses[i] ?? 0;
  return -(4 * total + 1024);
}
