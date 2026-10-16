import { describe, expect, it } from 'vitest';
import { ghostInverseMass } from './ghostMass';

describe('ghostInverseMass', () => {
  it('outweighs any sum of live inverse masses', () => {
    // The solvers skip a constraint when `w_i + w_j <= 0`, so a ghost has to
    // stay negative against every partner, including the heaviest one.
    for (const weights of [
      [55, 55, 55],
      [1e-6, 1e6, 3.5],
      [0.5],
      Array.from({ length: 500 }, (_, i) => (i % 7) * 12.5),
    ]) {
      const ghost = ghostInverseMass(weights);
      const sum = weights.reduce((a, b) => a + b, 0);
      expect(ghost).toBeLessThan(0);
      for (const w of weights) expect(ghost + w).toBeLessThan(0);
      expect(ghost + ghost).toBeLessThan(0);
      expect(ghost + sum).toBeLessThan(0);
    }
  });

  it('is exact enough to stay strictly negative in float32', () => {
    // The weights live in a Float32Array; a sentinel that only just outweighed
    // the cloth could round to zero when a live weight is added to it.
    const weights = new Float32Array(20000).fill(55.1);
    const ghost = Math.fround(ghostInverseMass(weights));
    const sum = weights.reduce((a, b) => a + b, 0);
    expect(Math.fround(ghost + Math.fround(sum))).toBeLessThan(-1);
    expect(ghost).toBeLessThan(-sum);
  });
});
