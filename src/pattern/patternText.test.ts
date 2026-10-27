import { describe, expect, it } from 'vitest';
import {
  PATTERN_TEXT_CLICK_BOX,
  PATTERN_TEXT_DEFAULTS,
  createPatternText,
  normalizePatternText,
  normalizePatternTexts,
  patternTextCss,
} from './patternText';
import type { PatternText } from '../project/types';

const base = (patch: Partial<PatternText> = {}): PatternText => ({
  ...createPatternText({ x: 0, y: 0, w: 0, h: 0 }, { id: 'txt_1' }),
  ...patch,
});

describe('pattern notes', () => {
  it('draws a dragged box, and sizes a clicked one itself', () => {
    const dragged = createPatternText({ x: 5, y: 6, w: 20, h: 8 }, { id: 'txt_a' });
    expect(dragged).toMatchObject({ x: 5, y: 6, widthCm: 20, heightCm: 8, autoWidth: false });

    const clicked = createPatternText({ x: 5, y: 6, w: 0, h: 0 }, { id: 'txt_b' });
    expect(clicked).toMatchObject({
      widthCm: PATTERN_TEXT_CLICK_BOX.widthCm,
      heightCm: PATTERN_TEXT_CLICK_BOX.heightCm,
      autoWidth: true,
    });
  });

  it('takes the starting type the host asks for, or the studio default', () => {
    const sized = createPatternText({ x: 0, y: 0, w: 0, h: 0 }, { fontSizeCm: 4.3, paddingCm: 1.2 });
    expect(sized.fontSizeCm).toBe(4.3);
    expect(sized.paddingCm).toBe(1.2);
  });

  it('starts as a note in the studio’s own type, in the pattern’s centimetres', () => {
    const note = createPatternText({ x: 0, y: 0, w: 0, h: 0 }, { id: 'txt_c' });
    expect(note.fontSizeCm).toBe(PATTERN_TEXT_DEFAULTS.fontSizeCm);
    expect(note.text).toBe('');
    expect(note.color).toBe(PATTERN_TEXT_DEFAULTS.color);
  });

  it('writes the type into the CSS the box carries, in user units', () => {
    const css = patternTextCss(base({ fontSizeCm: 4, fontWeight: 700, fontStyle: 'italic' }));
    expect(css.font).toContain('italic 700 4px');
    expect(css['letter-spacing']).toBe('0px');
    expect(css['white-space']).toBe('pre-wrap');
    // The pattern's user unit *is* the centimetre, so the box's own numbers go
    // into the stylesheet unchanged.
    expect(css.padding).toBe(`${PATTERN_TEXT_DEFAULTS.paddingCm}px`);
  });

  it('keeps a note readable when the file brings nonsense', () => {
    const note = normalizePatternText({
      ...base(),
      x: Number.NaN as unknown as number,
      widthCm: 0,
      fontSizeCm: -4,
      lineHeight: 0,
      align: 'sideways' as never,
      text: undefined as unknown as string,
    });
    expect(note.x).toBe(0);
    expect(note.widthCm).toBe(PATTERN_TEXT_CLICK_BOX.widthCm);
    expect(note.fontSizeCm).toBe(PATTERN_TEXT_DEFAULTS.fontSizeCm);
    expect(note.lineHeight).toBe(PATTERN_TEXT_DEFAULTS.lineHeight);
    expect(note.align).toBe('left');
    expect(note.text).toBe('');
  });

  it('gives an id back to a note that lost one, and keeps the rest', () => {
    const note = normalizePatternText({ ...base({ text: 'Hem' }), id: '' });
    expect(note.id).not.toBe('');
    expect(note.text).toBe('Hem');
  });

  it('handles a pattern with no notes at all', () => {
    expect(normalizePatternTexts(undefined)).toEqual([]);
    expect(normalizePatternTexts([base({ text: 'a' }), base({ text: 'b' })])).toHaveLength(2);
  });
});
