import { describe, expect, it } from 'vitest';
import { CPU_CONTACT_RELAX, relaxContactPush } from './contactRelax';

/** One frame of the ease, from `current` toward `target`. */
function easeFrames(current: number, target: number, frames: number): number[] {
  const out: number[] = [];
  let v = current;
  for (let f = 0; f < frames; f++) {
    v = relaxContactPush(v, target, true);
    out.push(v);
  }
  return out;
}

describe('relaxContactPush', () => {
  it('takes a small share of the correction each frame', () => {
    expect(relaxContactPush(0, 1, true)).toBeCloseTo(CPU_CONTACT_RELAX, 12);
    expect(CPU_CONTACT_RELAX).toBeLessThan(0.5);
  });

  it('never overshoots or reverses', () => {
    let v = 0;
    for (let f = 0; f < 40; f++) {
      const next = relaxContactPush(v, 1, true);
      expect(next).toBeGreaterThanOrEqual(v);
      expect(next).toBeLessThanOrEqual(1);
      v = next;
    }
  });

  it('converges on the target within a few frames', () => {
    const frames = easeFrames(0, 1, 40);
    expect(frames.at(-1)).toBeGreaterThan(0.99);
    // 90 % of the way inside 20 frames (a third of a second at 60 fps).
    expect(frames[19]).toBeGreaterThan(0.9);
  });

  it('leaves a particle the contact did not move alone', () => {
    expect(relaxContactPush(0.25, 0.9, false)).toBe(0.25);
  });
});
