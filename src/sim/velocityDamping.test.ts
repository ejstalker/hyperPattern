import { describe, expect, it } from 'vitest';
import { perSubstepRetain } from './velocityDamping';

describe('perSubstepRetain', () => {
  it('keeps the per-frame rate independent of the substep count', () => {
    for (const steps of [1, 4, 8, 24, 64]) {
      const kept = Math.pow(perSubstepRetain(0.998, steps), steps);
      expect(kept).toBeCloseTo(0.998, 10);
    }
  });

  it('applies the frame rate once when there is a single substep', () => {
    expect(perSubstepRetain(0.95, 1)).toBeCloseTo(0.95, 12);
  });

  it('removes less per substep the more substeps there are', () => {
    expect(perSubstepRetain(0.998, 8)).toBeLessThan(perSubstepRetain(0.998, 24));
  });

  it('never removes more than a tenth of the speed per frame', () => {
    // 0.5 would be half the speed per frame; the floor is 0.9.
    expect(Math.pow(perSubstepRetain(0.5, 12), 12)).toBeCloseTo(0.9, 10);
  });

  it('treats a missing or out-of-range value as the default', () => {
    expect(perSubstepRetain(undefined, 8)).toBeCloseTo(Math.pow(0.998, 1 / 8), 12);
    expect(perSubstepRetain(2, 8)).toBe(1);
  });
});
