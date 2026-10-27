import type { PatternText, TextAlign } from '../project/types';
import { uid } from '../project/createDefault';

/**
 * Notes written over a pattern.
 *
 * A note is not pattern geometry: it is drawn by the browser, it never reaches a
 * mesh, and the only thing that ties it to the pattern is that its numbers are in
 * the pattern's own centimetres. That is what makes it belong to the pattern — on
 * the board a note rides inside the container's frame and scales with the work,
 * the way a pencil note on the pattern paper would.
 */

/** The studio's first family — the canvas text's list, led with the same face. */
const DEFAULT_FAMILY = 'IBM Plex Sans';

/**
 * What a new note looks like, in pattern centimetres.
 *
 * The host reads these as canvas units when the style bar is in play (multiplied
 * by the drafting scale), so a note and a canvas text object are the same size on
 * screen when nothing has been changed.
 */
export const PATTERN_TEXT_DEFAULTS = {
  fontSizeCm: 4.3,
  lineHeight: 1.3,
  letterSpacingCm: 0,
  paddingCm: 1.2,
  color: '#f2ebe3',
  background: 'transparent',
} as const;

/** A click-placed note's box, in centimetres: a short paragraph, roughly. */
export const PATTERN_TEXT_CLICK_BOX = { widthCm: 40, heightCm: 7 } as const;

/** The narrowest box a note may be dragged down to, in centimetres. */
export const PATTERN_TEXT_MIN_CM = 1;

/**
 * A note for the box the Add tool drew. A click rather than a drag draws no box,
 * and that means a box of its own natural size — one that grows as it is typed.
 */
export function createPatternText(
  box: { x: number; y: number; w: number; h: number },
  options: { id?: string; fontSizeCm?: number; paddingCm?: number } = {}
): PatternText {
  const dragged = box.w > 0.5 && box.h > 0.5;
  return {
    id: options.id ?? uid('txt'),
    x: box.x,
    y: box.y,
    widthCm: dragged ? Math.max(PATTERN_TEXT_MIN_CM, box.w) : PATTERN_TEXT_CLICK_BOX.widthCm,
    heightCm: dragged ? Math.max(PATTERN_TEXT_MIN_CM, box.h) : PATTERN_TEXT_CLICK_BOX.heightCm,
    text: '',
    fontSizeCm: options.fontSizeCm ?? PATTERN_TEXT_DEFAULTS.fontSizeCm,
    fontFamily: DEFAULT_FAMILY,
    fontWeight: 400,
    fontStyle: 'normal',
    lineHeight: PATTERN_TEXT_DEFAULTS.lineHeight,
    letterSpacingCm: PATTERN_TEXT_DEFAULTS.letterSpacingCm,
    align: 'left',
    color: PATTERN_TEXT_DEFAULTS.color,
    background: PATTERN_TEXT_DEFAULTS.background,
    paddingCm: options.paddingCm ?? PATTERN_TEXT_DEFAULTS.paddingCm,
    autoWidth: !dragged,
  };
}

/**
 * The CSS a note's content carries, in the pattern's user units — inside the
 * editor's SVG a CSS pixel *is* a centimetre, so the numbers go straight in.
 */
export function patternTextCss(note: PatternText): Record<string, string> {
  const style = note.fontStyle === 'italic' ? 'italic' : 'normal';
  const weight = note.fontWeight ?? 400;
  const size = Math.max(0.1, note.fontSizeCm);
  return {
    font: `${style} ${weight} ${size}px "${note.fontFamily ?? DEFAULT_FAMILY}", sans-serif`,
    'line-height': String(note.lineHeight ?? PATTERN_TEXT_DEFAULTS.lineHeight),
    'letter-spacing': `${note.letterSpacingCm ?? PATTERN_TEXT_DEFAULTS.letterSpacingCm}px`,
    'text-align': note.align ?? 'left',
    color: note.color ?? PATTERN_TEXT_DEFAULTS.color,
    background: note.background ?? PATTERN_TEXT_DEFAULTS.background,
    padding: `${note.paddingCm ?? PATTERN_TEXT_DEFAULTS.paddingCm}px`,
    'white-space': 'pre-wrap',
    'overflow-wrap': 'break-word',
  };
}

const ALIGNMENTS: readonly TextAlign[] = ['left', 'center', 'right', 'justify'];

function positive(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Make a loaded note safe to draw: numbers where numbers belong, an id, a box
 * with some size to it, and type that is not invisible. Anything unrecognisable
 * falls back to the defaults rather than being dropped — a note is someone's
 * writing, and losing it silently is worse than drawing it plainly.
 */
export function normalizePatternText(note: PatternText): PatternText {
  const x = Number(note.x);
  const y = Number(note.y);
  const align = ALIGNMENTS.includes(note.align as TextAlign) ? note.align : 'left';
  return {
    ...note,
    id: note.id || uid('txt'),
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    widthCm: positive(note.widthCm, PATTERN_TEXT_CLICK_BOX.widthCm),
    heightCm: positive(note.heightCm, PATTERN_TEXT_CLICK_BOX.heightCm),
    text: typeof note.text === 'string' ? note.text : '',
    fontSizeCm: positive(note.fontSizeCm, PATTERN_TEXT_DEFAULTS.fontSizeCm),
    lineHeight: positive(note.lineHeight, PATTERN_TEXT_DEFAULTS.lineHeight),
    letterSpacingCm: Number.isFinite(note.letterSpacingCm)
      ? Number(note.letterSpacingCm)
      : PATTERN_TEXT_DEFAULTS.letterSpacingCm,
    paddingCm: Number.isFinite(note.paddingCm)
      ? Math.max(0, Number(note.paddingCm))
      : PATTERN_TEXT_DEFAULTS.paddingCm,
    align: align as TextAlign,
    autoWidth: !!note.autoWidth,
  };
}

/** The same, for a whole list — a pattern with no notes keeps none. */
export function normalizePatternTexts(texts: readonly PatternText[] | undefined): PatternText[] {
  return (texts ?? []).filter((note) => !!note).map((note) => normalizePatternText(note));
}
