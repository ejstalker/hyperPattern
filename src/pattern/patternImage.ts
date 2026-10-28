import type { PatternImage } from '../project/types';
import { uid } from '../project/createDefault';

/**
 * Reference images placed in a pattern.
 *
 * An image is not pattern geometry either: nothing about it is sewn or meshed,
 * and the only thing that ties it to the pattern is that its box is in the
 * pattern's own centimetres. That is what makes it belong to the pattern — on the
 * board it rides inside the container's frame and scales with the work, and in a
 * sheet it sits under the pieces so the drafting can be traced over it.
 */

/** The narrowest an image may be dragged down to, in centimetres. */
export const PATTERN_IMAGE_MIN_CM = 2;

/** A click-placed image's longest edge, in centimetres — a hand's span of sheet. */
export const PATTERN_IMAGE_CLICK_CM = 30;

/** What an image of unknown proportions is assumed to be, so it is never a sliver. */
const FALLBACK_ASPECT = 4 / 3;

/** A dragged box, or a press no bigger than a click? */
function isDragged(box: { w: number; h: number }): boolean {
  return box.w > 0.5 && box.h > 0.5;
}

/**
 * An image for the box the Add tool drew. Dragged out, the picture is fitted
 * inside the box rather than stretched by it, and sits in the middle of it: a
 * reference is traced, so its proportions are the thing worth keeping.
 *
 * A click instead of a drag draws no box, and that means an image of its own
 * size, centred on the point that was clicked.
 */
export function createPatternImage(
  box: { x: number; y: number; w: number; h: number },
  source: { src: string; label?: string; naturalAspect?: number },
  options: { id?: string } = {}
): PatternImage {
  const dragged = isDragged(box);
  const aspect =
    Number.isFinite(source.naturalAspect) && (source.naturalAspect as number) > 0
      ? (source.naturalAspect as number)
      : dragged
        ? box.w / box.h
        : FALLBACK_ASPECT;

  let widthCm: number;
  let heightCm: number;
  let x: number;
  let y: number;
  if (dragged) {
    heightCm = Math.max(PATTERN_IMAGE_MIN_CM, Math.min(box.w / aspect, box.h));
    widthCm = heightCm * aspect;
    x = box.x + (box.w - widthCm) / 2;
    y = box.y + (box.h - heightCm) / 2;
  } else {
    if (aspect >= 1) {
      widthCm = PATTERN_IMAGE_CLICK_CM;
      heightCm = PATTERN_IMAGE_CLICK_CM / aspect;
    } else {
      heightCm = PATTERN_IMAGE_CLICK_CM;
      widthCm = PATTERN_IMAGE_CLICK_CM * aspect;
    }
    x = box.x - widthCm / 2;
    y = box.y - heightCm / 2;
  }

  const image: PatternImage = {
    id: options.id ?? uid('img'),
    x,
    y,
    widthCm,
    heightCm,
    src: source.src,
  };
  if (source.label) image.label = source.label;
  if (Number.isFinite(source.naturalAspect) && (source.naturalAspect as number) > 0) {
    image.naturalAspect = source.naturalAspect;
  }
  return image;
}

/**
 * The image's own proportions, for the resize that follows them: what the source
 * said, or what the box has been — never zero, so a drag cannot divide by it.
 */
export function patternImageAspect(image: PatternImage): number {
  if (Number.isFinite(image.naturalAspect) && (image.naturalAspect as number) > 0) {
    return image.naturalAspect as number;
  }
  if (image.heightCm > 0) return image.widthCm / image.heightCm;
  return FALLBACK_ASPECT;
}

/** A size for the image that keeps its proportions and is never smaller than a nub. */
export function patternImageSize(
  image: PatternImage,
  drag: { width: number; height: number; aspect: number; lockAspect: boolean }
): { widthCm: number; heightCm: number } {
  const widthCm = Math.max(PATTERN_IMAGE_MIN_CM, drag.width);
  if (!drag.lockAspect) {
    return { widthCm, heightCm: Math.max(PATTERN_IMAGE_MIN_CM, drag.height) };
  }
  const aspect = drag.aspect > 0 ? drag.aspect : FALLBACK_ASPECT;
  return { widthCm, heightCm: Math.max(PATTERN_IMAGE_MIN_CM, widthCm / aspect) };
}

function positive(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Make a loaded image safe to draw: numbers where numbers belong, an id, a box
 * with some size to it. An entry with no source at all is the one thing that
 * cannot be drawn, and it is dropped.
 */
export function normalizePatternImage(image: PatternImage): PatternImage | null {
  if (!image || typeof image.src !== 'string' || image.src.length === 0) return null;
  const x = Number(image.x);
  const y = Number(image.y);
  const normalized: PatternImage = {
    ...image,
    id: image.id || uid('img'),
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    widthCm: positive(image.widthCm, PATTERN_IMAGE_CLICK_CM),
    heightCm: positive(image.heightCm, PATTERN_IMAGE_CLICK_CM),
    src: image.src,
  };
  if (image.label != null) normalized.label = String(image.label);
  const aspect = Number(image.naturalAspect);
  if (Number.isFinite(aspect) && aspect > 0) normalized.naturalAspect = aspect;
  else delete normalized.naturalAspect;
  return normalized;
}

/** The same, for a whole list — an unreadable entry is the only thing dropped. */
export function normalizePatternImages(
  images: readonly PatternImage[] | undefined
): PatternImage[] {
  const out: PatternImage[] = [];
  for (const image of images ?? []) {
    const normalized = normalizePatternImage(image);
    if (normalized) out.push(normalized);
  }
  return out;
}
