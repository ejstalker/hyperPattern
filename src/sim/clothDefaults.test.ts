import { describe, expect, it } from 'vitest';
import { upgradeLegacyFabric, upgradeLegacyFabrics } from './clothDefaults';
import {
  DEFAULT_SIM_PARAMS,
  DEFAULT_GRAVITY,
  DEFAULT_BEND_COMPLIANCE,
  DEFAULT_BEND_SPRING_SCALE,
  DEFAULT_MAX_SPEED,
} from '../project/createDefault';
import type { SimParams } from '../project/types';

/** The parameters a project saved before the re-calibration carries. */
function legacyParams(over: Partial<SimParams> = {}): SimParams {
  return {
    ...DEFAULT_SIM_PARAMS,
    gravity: 0.8,
    bendCompliance: 1e-3,
    bendSpringScale: 0.2,
    maxSpeed: 4,
    ...over,
  };
}

describe('upgradeLegacyFabric', () => {
  it('moves a project off the old calibration', () => {
    const params = legacyParams();
    expect(upgradeLegacyFabric(params)).toBe(true);
    expect(params.gravity).toBe(DEFAULT_GRAVITY);
    expect(params.bendCompliance).toBe(DEFAULT_BEND_COMPLIANCE);
    expect(params.bendSpringScale).toBe(DEFAULT_BEND_SPRING_SCALE);
    expect(params.maxSpeed).toBe(DEFAULT_MAX_SPEED);
  });

  it('leaves a hand-tuned project alone', () => {
    const tuned = legacyParams({
      gravity: 1.2,
      bendCompliance: 5e-3,
      bendSpringScale: 0.35,
      maxSpeed: 6,
    });
    const before = { ...tuned };
    expect(upgradeLegacyFabric(tuned)).toBe(false);
    expect(tuned).toEqual(before);
  });

  it('upgrades field by field', () => {
    const params = legacyParams({ bendSpringScale: 0.5, maxSpeed: 8 });
    expect(upgradeLegacyFabric(params)).toBe(true);
    expect(params.gravity).toBe(DEFAULT_GRAVITY);
    // Bending and the speed clamp were hand-set, so they stay where they are.
    expect(params.bendSpringScale).toBe(0.5);
    expect(params.maxSpeed).toBe(8);
    expect(params.bendCompliance).toBe(DEFAULT_BEND_COMPLIANCE);
  });

  it('is idempotent', () => {
    const params = legacyParams();
    upgradeLegacyFabric(params);
    expect(upgradeLegacyFabric(params)).toBe(false);
  });

  it('keeps the rest of the fabric settings', () => {
    const params = legacyParams({ mass: 54, springConst: 601, contactFriction: 1.3 });
    upgradeLegacyFabric(params);
    expect(params.mass).toBe(54);
    expect(params.springConst).toBe(601);
    expect(params.contactFriction).toBe(1.3);
  });
});

describe('upgradeLegacyFabrics', () => {
  it('reports whether any drape in the project moved', () => {
    const untouched = { params: { ...DEFAULT_SIM_PARAMS } };
    expect(upgradeLegacyFabrics({ sims: [untouched] })).toBe(false);
    expect(upgradeLegacyFabrics({ sims: [untouched, { params: legacyParams() }] })).toBe(true);
  });
});
