import { describe, expect, it } from 'vitest';
import {
  PATTERN_IMAGE_CLICK_CM,
  PATTERN_IMAGE_MIN_CM,
  createPatternImage,
  normalizePatternImage,
  normalizePatternImages,
  patternImageAspect,
  patternImageSize,
} from './patternImage';
import type { PatternImage } from '../project/types';

const SOURCE = { src: 'data:image/png;base64,AAAA', naturalAspect: 2 };

describe('createPatternImage', () => {
  it('fits a dragged-out picture inside its box and centres it', () => {
    const image = createPatternImage({ x: 10, y: 20, w: 40, h: 10 }, SOURCE);
    // The box is the limit, the picture keeps its 2:1 shape.
    expect(image.widthCm).toBeCloseTo(20);
    expect(image.heightCm).toBeCloseTo(10);
    expect(image.x).toBeCloseTo(20);
    expect(image.y).toBeCloseTo(20);
  });

  it('sizes a click-placed image by its longest edge, centred on the point', () => {
    const image = createPatternImage({ x: 50, y: 50, w: 0, h: 0 }, SOURCE);
    expect(image.widthCm).toBeCloseTo(PATTERN_IMAGE_CLICK_CM);
    expect(image.heightCm).toBeCloseTo(PATTERN_IMAGE_CLICK_CM / 2);
    expect(image.x).toBeCloseTo(50 - PATTERN_IMAGE_CLICK_CM / 2);
    expect(image.y).toBeCloseTo(50 - PATTERN_IMAGE_CLICK_CM / 4);
  });

  it('turns a portrait source on its side: the longest edge is the height', () => {
    const image = createPatternImage({ x: 0, y: 0, w: 0, h: 0 }, { src: 'x', naturalAspect: 0.5 });
    expect(image.heightCm).toBeCloseTo(PATTERN_IMAGE_CLICK_CM);
    expect(image.widthCm).toBeCloseTo(PATTERN_IMAGE_CLICK_CM / 2);
  });

  it('assumes proportions when the source has none, rather than making a sliver', () => {
    const image = createPatternImage({ x: 0, y: 0, w: 0, h: 0 }, { src: 'x' });
    expect(image.widthCm).toBeCloseTo(PATTERN_IMAGE_CLICK_CM);
    expect(image.heightCm).toBeCloseTo(PATTERN_IMAGE_CLICK_CM / (4 / 3));
    expect(image.naturalAspect).toBeUndefined();
  });

  it('keeps a tiny dragged box to the smallest the image may be', () => {
    const image = createPatternImage({ x: 0, y: 0, w: 1, h: 1 }, SOURCE);
    expect(image.heightCm).toBeGreaterThanOrEqual(PATTERN_IMAGE_MIN_CM);
    expect(image.widthCm).toBeCloseTo(image.heightCm * 2);
  });

  it('takes an id when one is given, and mints one otherwise', () => {
    expect(createPatternImage({ x: 0, y: 0, w: 0, h: 0 }, SOURCE, { id: 'img-1' }).id).toBe(
      'img-1'
    );
    expect(createPatternImage({ x: 0, y: 0, w: 0, h: 0 }, SOURCE).id).toMatch(/^img_/);
  });
});

describe('patternImageAspect', () => {
  it('prefers what the source reported', () => {
    const image = { widthCm: 10, heightCm: 10, naturalAspect: 3 } as PatternImage;
    expect(patternImageAspect(image)).toBe(3);
  });

  it('falls back to the box, then to a default — never to zero', () => {
    expect(patternImageAspect({ widthCm: 10, heightCm: 5 } as PatternImage)).toBeCloseTo(2);
    expect(patternImageAspect({ widthCm: 10, heightCm: 0 } as PatternImage)).toBeGreaterThan(0);
  });
});

describe('patternImageSize', () => {
  it('resizes freely by default', () => {
    const size = patternImageSize({ widthCm: 10, heightCm: 5 } as PatternImage, {
      width: 20,
      height: 9,
      aspect: 2,
      lockAspect: false,
    });
    expect(size).toEqual({ widthCm: 20, heightCm: 9 });
  });

  it('holds the proportions when asked to', () => {
    const size = patternImageSize({ widthCm: 10, heightCm: 5 } as PatternImage, {
      width: 20,
      height: 9,
      aspect: 2,
      lockAspect: true,
    });
    expect(size.widthCm).toBeCloseTo(20);
    expect(size.heightCm).toBeCloseTo(10);
  });

  it('never gets smaller than the minimum', () => {
    const size = patternImageSize({ widthCm: 10, heightCm: 5 } as PatternImage, {
      width: -40,
      height: -40,
      aspect: 2,
      lockAspect: true,
    });
    expect(size.widthCm).toBe(PATTERN_IMAGE_MIN_CM);
    expect(size.heightCm).toBeGreaterThanOrEqual(PATTERN_IMAGE_MIN_CM);
  });
});

describe('normalizePatternImages', () => {
  it('drops an entry with no source and keeps the rest', () => {
    const list = normalizePatternImages([
      { id: 'a', x: 1, y: 2, widthCm: 10, heightCm: 5, src: 'data:x' },
      { id: 'b', x: 1, y: 2, widthCm: 10, heightCm: 5, src: '' },
    ]);
    expect(list.map((image) => image.id)).toEqual(['a']);
  });

  it('repairs numbers and mints a missing id', () => {
    const image = normalizePatternImage({
      id: '',
      x: Number.NaN,
      y: '4',
      widthCm: 0,
      heightCm: -2,
      src: 'data:x',
    } as unknown as PatternImage)!;
    expect(image.id).toMatch(/^img_/);
    expect(image.x).toBe(0);
    expect(image.y).toBe(4);
    expect(image.widthCm).toBeGreaterThan(0);
    expect(image.heightCm).toBeGreaterThan(0);
  });

  it('has nothing to say about a pattern with no images', () => {
    expect(normalizePatternImages(undefined)).toEqual([]);
  });
});
