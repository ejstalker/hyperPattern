/**
 * Noise, shaped like Houdini's Unified Noise.
 *
 * One function samples Perlin, simplex or cellular (Worley) noise, lays an
 * optional fractal on top — fBm, turbulence or ridged — and returns a number in
 * −1..1 for Perlin/simplex and 0..1 for Worley (which has no negative lobe). The
 * parameters are the ones the VOP exposes, so a modifier node's noise panel maps
 * straight onto them.
 *
 * Everything here is seeded and pure: the same sample at the same point always
 * gives the same number, so cooking a stack twice cannot move geometry.
 */

export type NoiseType = 'perlin' | 'simplex' | 'worley';

/** How octaves are summed — Houdini's fractal types, minus the exotic ones. */
export type NoiseFractal = 'none' | 'fbm' | 'turbulence' | 'ridged';

export type NoiseParams = {
  type: NoiseType;
  fractal: NoiseFractal;
  /** Whole number of octaves; ignored by `none`. */
  octaves: number;
  /** Frequency multiplier between octaves. */
  lacunarity: number;
  /** Amplitude multiplier between octaves — Houdini calls it roughness. */
  roughness: number;
  /** Cycles per centimetre. */
  frequency: number;
  /** Sample-space offset, in pattern centimetres. */
  offset: [number, number];
  /** Multiplies the sampled value. */
  amplitude: number;
  /** Added after the amplitude. */
  bias: number;
  seed: number;
  /** Turbulence's absolute-value pass on every octave, whatever the fractal. */
  turbulence?: boolean;
};

export const NOISE_DEFAULTS: NoiseParams = {
  type: 'simplex',
  fractal: 'fbm',
  octaves: 3,
  lacunarity: 2,
  roughness: 0.5,
  frequency: 0.08,
  offset: [0, 0],
  amplitude: 1,
  bias: 0,
  seed: 1,
  turbulence: false,
};

/** Fill in whatever a stored node left out, and keep the numbers sane. */
export function normalizeNoiseParams(params: Partial<NoiseParams> | undefined): NoiseParams {
  const p = { ...NOISE_DEFAULTS, ...(params ?? {}) };
  const finite = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) ? (value as number) : fallback;
  const types: NoiseType[] = ['perlin', 'simplex', 'worley'];
  const fractals: NoiseFractal[] = ['none', 'fbm', 'turbulence', 'ridged'];
  return {
    type: types.includes(p.type) ? p.type : NOISE_DEFAULTS.type,
    fractal: fractals.includes(p.fractal) ? p.fractal : NOISE_DEFAULTS.fractal,
    octaves: Math.max(1, Math.min(12, Math.round(finite(p.octaves, 3)))),
    lacunarity: Math.max(1, Math.min(8, finite(p.lacunarity, 2))),
    roughness: Math.max(0, Math.min(1, finite(p.roughness, 0.5))),
    frequency: Math.max(1e-4, Math.min(4, finite(p.frequency, 0.08))),
    offset: [finite(p.offset?.[0], 0), finite(p.offset?.[1], 0)],
    amplitude: finite(p.amplitude, 1),
    bias: finite(p.bias, 0),
    seed: Math.round(finite(p.seed, 1)),
    turbulence: !!p.turbulence,
  };
}

/** Sample the noise at a pattern-space point, in the node's units. */
export function sampleNoise(params: NoiseParams, x: number, y: number): number {
  const p = normalizeNoiseParams(params);
  const sx = (x + p.offset[0]) * p.frequency;
  const sy = (y + p.offset[1]) * p.frequency;
  if (p.fractal === 'none' || p.octaves <= 1) {
    return p.amplitude * noisy(p, sx, sy) + p.bias;
  }

  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  for (let octave = 0; octave < p.octaves; octave++) {
    let value = noisy({ ...p, seed: p.seed + octave * 101 }, sx * frequency, sy * frequency);
    if (p.fractal === 'turbulence' || p.turbulence) value = Math.abs(value) * 2 - 1;
    if (p.fractal === 'ridged') value = 1 - Math.abs(value);
    sum += value * amplitude;
    total += amplitude;
    amplitude *= p.roughness;
    frequency *= p.lacunarity;
  }
  const value = total > 0 ? sum / total : 0;
  return p.amplitude * value + p.bias;
}

function noisy(p: NoiseParams, x: number, y: number): number {
  if (p.type === 'perlin') return perlin2(x, y, p.seed);
  if (p.type === 'worley') return worley2(x, y, p.seed);
  return simplex2(x, y, p.seed);
}

// ── Seeded hashing ───────────────────────────────────────────────────────────

/** A small integer hash — deterministic everywhere, no big permutation table. */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** A hashed unit vector at a lattice point, for Perlin's gradients. */
function gradient(x: number, y: number, seed: number): [number, number] {
  const h = hash2(x, y, seed);
  const angle = (h / 4294967296) * Math.PI * 2;
  return [Math.cos(angle), Math.sin(angle)];
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function dot(ax: number, ay: number, bx: number, by: number): number {
  return ax * bx + ay * by;
}

/** Classic gradient noise, in −1..1. */
export function perlin2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const g00 = gradient(xi, yi, seed);
  const g10 = gradient(xi + 1, yi, seed);
  const g01 = gradient(xi, yi + 1, seed);
  const g11 = gradient(xi + 1, yi + 1, seed);
  const n00 = dot(g00[0], g00[1], xf, yf);
  const n10 = dot(g10[0], g10[1], xf - 1, yf);
  const n01 = dot(g01[0], g01[1], xf, yf - 1);
  const n11 = dot(g11[0], g11[1], xf - 1, yf - 1);
  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  // Perlin's 2D gradient noise peaks near ±0.71; scale it to the familiar range.
  return (nx0 + v * (nx1 - nx0)) * Math.SQRT2;
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** Simplex noise, in −1..1. */
export function simplex2(x: number, y: number, seed: number): number {
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;

  const corner = (gi: number, gj: number, dx: number, dy: number): number => {
    const g = gradient(i + gi, j + gj, seed);
    const falloff = 0.5 - dx * dx - dy * dy;
    if (falloff <= 0) return 0;
    return falloff * falloff * falloff * falloff * dot(g[0], g[1], dx, dy);
  };

  const n0 = corner(0, 0, x0, y0);
  const n1 = corner(i1, j1, x1, y1);
  const n2 = corner(1, 1, x2, y2);
  // 70 is the usual normalising constant for 2D simplex.
  return 70 * (n0 + n1 + n2);
}

/** Cellular noise: distance to the nearest feature point, 0..1. */
export function worley2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let nearest = Infinity;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      const h = hash2(cx, cy, seed);
      // Two independent fractions of the hash: the cell's feature point.
      const fx = cx + (h & 0xffff) / 65536;
      const fy = cy + (h >>> 16) / 65536;
      const distance = Math.hypot(x - fx, y - fy);
      if (distance < nearest) nearest = distance;
    }
  }
  // Feature points are never further than the diagonal of a cell away.
  return Math.min(1, nearest / Math.SQRT1_2);
}
