import { describe, expect, it } from 'vitest';
import {
  NOISE_DEFAULTS,
  normalizeNoiseParams,
  perlin2,
  sampleNoise,
  simplex2,
  worley2,
  type NoiseParams,
} from './noise';

const base = (patch: Partial<NoiseParams> = {}): NoiseParams => ({ ...NOISE_DEFAULTS, ...patch });

describe('the noise primitives', () => {
  it('are deterministic for a seed, and different between seeds', () => {
    expect(simplex2(1.3, 2.7, 1)).toBe(simplex2(1.3, 2.7, 1));
    expect(simplex2(1.3, 2.7, 1)).not.toBe(simplex2(1.3, 2.7, 2));
    expect(perlin2(1.3, 2.7, 1)).toBe(perlin2(1.3, 2.7, 1));
    expect(worley2(1.3, 2.7, 1)).toBe(worley2(1.3, 2.7, 1));
  });

  it('stay inside −1..1 for simplex and Perlin', () => {
    for (let i = 0; i < 400; i++) {
      const x = i * 0.37;
      const y = i * 0.11;
      expect(Math.abs(simplex2(x, y, 7))).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(perlin2(x, y, 7))).toBeLessThanOrEqual(1.0001);
    }
  });

  it('stay inside 0..1 for worley', () => {
    for (let i = 0; i < 200; i++) {
      const value = worley2(i * 0.41, i * 0.23, 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('varies across space rather than sitting still', () => {
    const values = new Set<number>();
    for (let i = 0; i < 40; i++) values.add(Math.round(simplex2(i * 0.3, i * 0.2, 1) * 1e6));
    expect(values.size).toBeGreaterThan(30);
  });
});

describe('sampleNoise — the Unified Noise shape', () => {
  it('is flat when the amplitude is zero and biased when it is not', () => {
    expect(sampleNoise(base({ amplitude: 0, bias: 0 }), 3, 4)).toBeCloseTo(0);
    expect(sampleNoise(base({ amplitude: 0, bias: 2.5 }), 3, 4)).toBeCloseTo(2.5);
  });

  it('scales with amplitude, in the node’s own units', () => {
    const one = sampleNoise(base({ fractal: 'none', amplitude: 1 }), 3, 4);
    const ten = sampleNoise(base({ fractal: 'none', amplitude: 10 }), 3, 4);
    expect(ten).toBeCloseTo(one * 10);
  });

  it('moves the field with its offset rather than re-rolling it', () => {
    // Sliding the sample point by (2, 1) and the offset back by the same is the
    // same sample — the field is one field, panned.
    const a = sampleNoise(base({ fractal: 'none' }), 3, 4);
    const b = sampleNoise(base({ fractal: 'none', offset: [-2, -1] }), 5, 5);
    expect(a).toBeCloseTo(b, 6);
  });

  it('adds detail as octaves are added', () => {
    const one = sampleNoise(base({ octaves: 1 }), 3.1, 4.2);
    const four = sampleNoise(base({ octaves: 4 }), 3.1, 4.2);
    expect(one).not.toBeCloseTo(four, 6);
  });

  it('fractal types give different fields from the same seed', () => {
    const fbm = sampleNoise(base({ fractal: 'fbm' }), 3.1, 4.2);
    const turbulence = sampleNoise(base({ fractal: 'turbulence' }), 3.1, 4.2);
    const ridged = sampleNoise(base({ fractal: 'ridged' }), 3.1, 4.2);
    expect(fbm).not.toBeCloseTo(turbulence, 6);
    expect(fbm).not.toBeCloseTo(ridged, 6);
  });

  it('samples every noise type', () => {
    for (const type of ['perlin', 'simplex', 'worley'] as const) {
      const value = sampleNoise(base({ type, fractal: 'none' }), 1.7, 2.9);
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('normalizeNoiseParams', () => {
  it('fills in the defaults', () => {
    expect(normalizeNoiseParams(undefined)).toEqual(NOISE_DEFAULTS);
  });

  it('clamps nonsense into a usable range', () => {
    const p = normalizeNoiseParams({
      octaves: 999,
      lacunarity: 0.1,
      roughness: 5,
      frequency: 0,
      amplitude: Number.NaN,
      noise: 1,
    } as unknown as Partial<NoiseParams>);
    expect(p.octaves).toBe(12);
    expect(p.lacunarity).toBe(1);
    expect(p.roughness).toBe(1);
    expect(p.frequency).toBeGreaterThan(0);
    expect(p.amplitude).toBe(1);
    expect(p.type).toBe(NOISE_DEFAULTS.type);
  });
});
