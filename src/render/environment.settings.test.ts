import { describe, expect, it } from 'vitest';
import { DEFAULT_TONEMAP } from './tonemapping';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  DEFAULT_HDRI,
  DEFAULT_SHADING_MODE,
  SHADING_MODES,
  equirectMipLevelCount,
  gaussianBlurKernel,
  loadEnvironmentSettings,
  nextShadingMode,
  shadingModeLabel,
} from './environment';

describe('shading mode helpers', () => {
  it('cycles wireframe -> simple -> pbr and wraps around', () => {
    expect(SHADING_MODES).toEqual(['wireframe', 'simple', 'pbr']);
    expect(nextShadingMode('wireframe')).toBe('simple');
    expect(nextShadingMode('simple')).toBe('pbr');
    expect(nextShadingMode('pbr')).toBe('wireframe');
  });

  it('labels each mode', () => {
    expect(shadingModeLabel('wireframe')).toBe('Wireframe');
    expect(shadingModeLabel('simple')).toBe('Simple');
    expect(shadingModeLabel('pbr')).toBe('PBR');
  });
});

describe('gaussianBlurKernel', () => {
  it('is a normalised gaussian with more taps as sigma grows', () => {
    const small = gaussianBlurKernel(2, 24);
    const large = gaussianBlurKernel(12, 24);
    expect(small.radius).toBe(6);
    expect(large.radius).toBe(24);
    const sum = (kernel: ReturnType<typeof gaussianBlurKernel>) =>
      kernel.weights[0]! +
      2 * kernel.weights.slice(1, kernel.radius + 1).reduce((n, w) => n + w, 0);
    expect(sum(small)).toBeCloseTo(1);
    expect(sum(large)).toBeCloseTo(1);
    // The centre is the heaviest weight, and weights fall away from it.
    for (const kernel of [small, large]) {
      for (let i = 1; i <= kernel.radius; i++) {
        expect(kernel.weights[i]!).toBeLessThan(kernel.weights[i - 1]!);
      }
    }
  });

  it('collapses to a single centre tap at zero blur', () => {
    for (const sigma of [0, -1, Number.NaN]) {
      const kernel = gaussianBlurKernel(sigma, 24);
      expect(kernel.radius).toBe(0);
      expect(kernel.weights[0]).toBe(1);
      expect(kernel.weights.slice(1).every((w) => w === 0)).toBe(true);
    }
  });
});

describe('equirectMipLevelCount', () => {
  it('halves down to a single texel but stops at the softest blur level', () => {
    expect(equirectMipLevelCount(1024)).toBe(7);
    expect(equirectMipLevelCount(256)).toBe(7);
    expect(equirectMipLevelCount(64)).toBe(7);
    expect(equirectMipLevelCount(32)).toBe(6);
    expect(equirectMipLevelCount(2)).toBe(2);
    expect(equirectMipLevelCount(1)).toBe(1);
  });

  it('survives a missing image', () => {
    expect(equirectMipLevelCount(0)).toBe(1);
    expect(equirectMipLevelCount(Number.NaN)).toBe(1);
  });
});

describe('loadEnvironmentSettings', () => {
  it('falls back to the defaults for an empty store', () => {
    expect(loadEnvironmentSettings()).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
    // A 3D viewport opens in PBR: it is the look the app is for.
    expect(DEFAULT_ENVIRONMENT_SETTINGS.shading).toBe('pbr');
    expect(DEFAULT_SHADING_MODE).toBe('pbr');
    expect(DEFAULT_ENVIRONMENT_SETTINGS.blur).toBe(0.5);
    expect(DEFAULT_ENVIRONMENT_SETTINGS.exposure).toBe(1);
    expect(DEFAULT_ENVIRONMENT_SETTINGS.hdri).toBe(DEFAULT_HDRI);
    expect(DEFAULT_HDRI).toBe('little_paris_eiffel_tower_1k.exr');
    expect(DEFAULT_ENVIRONMENT_SETTINGS.tonemap).toBe(DEFAULT_TONEMAP);
    expect(DEFAULT_TONEMAP).toBe('aces');
  });

  it('round-trips saved settings and repairs junk', () => {
    localStorage.setItem(
      'patternCanvas.environment',
      JSON.stringify({
        hdri: 'studio.exr',
        blur: 0.4,
        exposure: 2.5,
        tonemap: 'lottes',
        background: false,
        shading: 'pbr',
      })
    );
    expect(loadEnvironmentSettings()).toEqual({
      hdri: 'studio.exr',
      blur: 0.4,
      exposure: 2.5,
      tonemap: 'lottes',
      background: false,
      shading: 'pbr',
    });

    localStorage.setItem(
      'patternCanvas.environment',
      JSON.stringify({
        hdri: 7,
        blur: 9,
        exposure: 99,
        tonemap: 'filmic',
        background: 'yes',
        shading: 'smooth',
      })
    );
    expect(loadEnvironmentSettings()).toEqual({
      hdri: DEFAULT_HDRI,
      blur: 1,
      exposure: 4,
      tonemap: DEFAULT_TONEMAP,
      background: true,
      shading: DEFAULT_SHADING_MODE,
    });

    localStorage.setItem('patternCanvas.environment', 'not json');
    expect(loadEnvironmentSettings()).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
  });
});
