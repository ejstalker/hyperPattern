import type { SimParams } from '../project/types';
import {
  DEFAULT_GRAVITY,
  DEFAULT_BEND_COMPLIANCE,
  DEFAULT_BEND_SPRING_SCALE,
  DEFAULT_MAX_SPEED,
} from '../project/createDefault';

/**
 * The fabric parameters as they shipped before the drape was re-calibrated.
 *
 * A project saved under these values hangs like card: the panels hold their
 * drafted shape, the gathers balloon and the hem never falls. They are exact
 * numbers rather than a range on purpose — a project whose owner has moved any
 * of these away from the old default has made a choice, and that choice is not
 * ours to overwrite.
 */
const LEGACY_GRAVITY = 0.8;
const LEGACY_BEND_COMPLIANCE = 1e-3;
const LEGACY_BEND_SPRING_SCALE = 0.2;
const LEGACY_MAX_SPEEDS = new Set([4, 2.5]);

/**
 * Bring one stored drape to the current fabric calibration.
 *
 * Each field upgrades on its own, so a project that had already softened its
 * bends but left gravity alone keeps the softening and gains the weight. Returns
 * whether anything moved, so the caller knows the document is dirty.
 */
export function upgradeLegacyFabric(params: SimParams): boolean {
  let changed = false;

  if (params.gravity === LEGACY_GRAVITY) {
    params.gravity = DEFAULT_GRAVITY;
    changed = true;
  }
  if (params.bendCompliance === LEGACY_BEND_COMPLIANCE) {
    params.bendCompliance = DEFAULT_BEND_COMPLIANCE;
    changed = true;
  }
  if (params.bendSpringScale === LEGACY_BEND_SPRING_SCALE) {
    params.bendSpringScale = DEFAULT_BEND_SPRING_SCALE;
    changed = true;
  }
  if (params.maxSpeed !== undefined && LEGACY_MAX_SPEEDS.has(params.maxSpeed)) {
    params.maxSpeed = DEFAULT_MAX_SPEED;
    changed = true;
  }

  return changed;
}

/** Every drape in a project, for the load path. */
export function upgradeLegacyFabrics(project: { sims: Array<{ params: SimParams }> }): boolean {
  let changed = false;
  for (const sim of project.sims) {
    if (upgradeLegacyFabric(sim.params)) changed = true;
  }
  return changed;
}
