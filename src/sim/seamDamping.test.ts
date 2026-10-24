import { describe, expect, it } from 'vitest';
import {
  SEAM_DAMPING_RINGS,
  seamBandMask,
  seamVelocityRetain,
} from './seamDamping';

/** A straight chain 0-1-2-3-4-5, stitched 0↔5. */
const neighbours = Uint32Array.from([1, 0, 2, 1, 3, 2, 4, 3, 5, 4]);
const offsets = Uint32Array.from([0, 1, 3, 5, 7, 9, 10]);
const pairs: Array<[number, number]> = [[0, 5]];

describe('seamBandMask', () => {
  it('covers the stitches and the material within the ring count', () => {
    const mask = seamBandMask(6, offsets, neighbours, pairs, 1);
    // 0 and 5 are stitched; 1 and 4 are their neighbours.
    expect(Array.from(mask)).toEqual([1, 1, 0, 0, 1, 1]);
  });

  it('widens with the ring count', () => {
    const mask = seamBandMask(6, offsets, neighbours, pairs, SEAM_DAMPING_RINGS);
    expect(Array.from(mask)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('is empty without seams', () => {
    expect(Array.from(seamBandMask(6, offsets, neighbours, [], 2))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('ignores indices outside the mesh', () => {
    const mask = seamBandMask(3, offsets, neighbours, [[0, 99]], 0);
    expect(Array.from(mask)).toEqual([1, 0, 0]);
  });
});

describe('seamVelocityRetain', () => {
  it('damps a frame but never freezes the band', () => {
    // Half the band's speed survives a 16 ms frame, and a 1 ms frame barely
    // touches it: the band is viscous, not pinned.
    expect(seamVelocityRetain(0.016)).toBeGreaterThan(0.4);
    expect(seamVelocityRetain(0.016)).toBeLessThan(0.9);
    expect(seamVelocityRetain(0.001)).toBeGreaterThan(0.9);
  });

  it('removes more over a long frame', () => {
    expect(seamVelocityRetain(0.03)).toBeLessThan(seamVelocityRetain(0.016));
  });

  it('decays to the time constant regardless of frame length', () => {
    // Four quarter-frames decay the same as one whole frame.
    const whole = seamVelocityRetain(0.1);
    const quarter = Math.pow(seamVelocityRetain(0.025), 4);
    expect(quarter).toBeCloseTo(whole, 10);
  });

  it('is a no-op for a degenerate frame', () => {
    expect(seamVelocityRetain(0)).toBe(1);
    expect(seamVelocityRetain(-1)).toBe(1);
  });
});
