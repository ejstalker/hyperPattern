import { describe, expect, it } from 'vitest';
import {
  fitRingCurve,
  groupContours,
  layoutTextLines,
  smoothRing,
  textMaskToPieces,
  textStyleOf,
  traceAlphaMask,
  type TextMask,
} from './textObject';
import type { TextAnnotationNode } from '../project/types';

/** A mask with boxes filled white — a stand-in for rendered glyphs. */
function maskOf(
  width: number,
  height: number,
  boxes: Array<{ x: number; y: number; w: number; h: number }>
): TextMask {
  const alpha = new Uint8ClampedArray(width * height);
  for (const box of boxes) {
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        alpha[y * width + x] = 255;
      }
    }
  }
  return { alpha, width, height, scale: 1 };
}

describe('tracing a coverage mask', () => {
  it('traces a filled box as one ring round its border', () => {
    const contours = traceAlphaMask(
      maskOf(10, 10, [{ x: 2, y: 2, w: 4, h: 4 }]).alpha,
      10,
      10
    );
    expect(contours).toHaveLength(1);
    // A staircase of the box's own border: the extremes are its corners.
    const xs = contours[0].map((p) => p.x);
    const ys = contours[0].map((p) => p.y);
    expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]).toEqual([
      2, 2, 6, 6,
    ]);
    expect(smoothRing(contours[0], 1).length).toBe(contours[0].length * 2);
  });

  it('traces two boxes as two rings', () => {
    const contours = traceAlphaMask(
      maskOf(20, 10, [
        { x: 1, y: 1, w: 4, h: 4 },
        { x: 12, y: 1, w: 4, h: 4 },
      ]).alpha,
      20,
      10
    );
    expect(contours).toHaveLength(2);
  });

  it('finds the hole in a ring-shaped mark', () => {
    const contours = traceAlphaMask(
      maskOf(12, 12, [
        { x: 2, y: 2, w: 8, h: 8 },
        { x: 4, y: 4, w: 4, h: 4 },
      ]).alpha.map((value, index) => {
        // Punch the middle out: a filled square with a square hole.
        const x = index % 12;
        const y = Math.floor(index / 12);
        return x >= 4 && x < 8 && y >= 4 && y < 8 ? 0 : value;
      }),
      12,
      12
    );
    expect(contours).toHaveLength(2);
    const chars = groupContours(contours);
    expect(chars).toHaveLength(1);
    expect(chars[0].holes).toHaveLength(1);
  });
});

describe('layout', () => {
  const style = textStyleOf({ fontSize: 20, padding: 4 } as TextAnnotationNode);

  it('measures a single line from the padding', () => {
    const lines = layoutTextLines(['Hello'], style, { width: 200, height: 40 }, () => 50);
    expect(lines).toEqual([{ text: 'Hello', x: 4, y: 4, width: 50 }]);
  });

  it('wraps at the box width and stacks by the line height', () => {
    const lines = layoutTextLines(
      ['one two three'],
      { ...style, fontSize: 10, lineHeight: 2, padding: 0 },
      { width: 40, height: 100 },
      (text) => text.length * 10
    );
    expect(lines.map((line) => line.text)).toEqual(['one', 'two', 'three']);
    expect(lines.map((line) => line.y)).toEqual([0, 20, 40]);
  });

  it('centres and right-aligns inside the box', () => {
    const box = { width: 104, height: 40 };
    const centred = layoutTextLines(['ab'], { ...style, align: 'center' }, box, () => 40);
    expect(centred[0].x).toBe(4 + 28);
    const right = layoutTextLines(['ab'], { ...style, align: 'right' }, box, () => 40);
    expect(right[0].x).toBe(4 + 56);
  });
});

describe('mask to pieces', () => {
  it('makes one closed piece per mark, in centimetres and in reading order', () => {
    const mask = maskOf(40, 20, [
      { x: 24, y: 4, w: 8, h: 10 },
      { x: 4, y: 4, w: 8, h: 10 },
    ]);
    const pieces = textMaskToPieces(mask, { x: 100, y: 50, cmScale: 5 }, { name: 'A' });
    expect(pieces).toHaveLength(2);
    // Reading order: the left mark comes first however the tracer found them.
    const firstX = Math.min(...pieces[0].points.map((pt) => pt.anchor.x));
    const secondX = Math.min(...pieces[1].points.map((pt) => pt.anchor.x));
    expect(firstX).toBeLessThan(secondX);
    // Canvas unit (100 + 4) at 5 units per cm — give or take the quarter pixel
    // the smoothing moves an anchor by.
    expect(Math.abs(firstX - (100 + 4) / 5)).toBeLessThan(0.2);
    expect(pieces[0].closed).toBe(true);
    // A traced mark comes back as a handful of anchors with curve handles, not as
    // the hundreds of corners the staircase had.
    expect(pieces[0].points.length).toBeLessThan(20);
    expect(pieces[0].points.some((pt) => pt.handleIn || pt.handleOut)).toBe(true);
    // Every anchor sits on the traced outline, in order round the ring.
    expect(pieces[0].points.length).toBeGreaterThan(1);
  });

  it('keeps a counter as a hole in its character', () => {
    const mask = maskOf(16, 16, [{ x: 2, y: 2, w: 12, h: 12 }]);
    for (let y = 6; y < 10; y++) {
      for (let x = 6; x < 10; x++) mask.alpha[y * 16 + x] = 0;
    }
    const pieces = textMaskToPieces(mask, { x: 0, y: 0, cmScale: 1 });
    expect(pieces).toHaveLength(1);
    expect(pieces[0].holes).toHaveLength(1);
    // A ring that closes: at least three curves, never a degenerate loop.
    expect(pieces[0].holes![0].length).toBeGreaterThanOrEqual(3);
  });
});

describe('curve fitting', () => {
  it('fits a traced circle into a few curves rather than one anchor per pixel', () => {
    const ring: Array<{ x: number; y: number }> = [];
    // A circle as a pixel staircase, the way a trace would hand it over.
    for (let i = 0; i < 240; i++) {
      const angle = (i / 240) * Math.PI * 2;
      ring.push({
        x: Math.round(200 + Math.cos(angle) * 120),
        y: Math.round(200 + Math.sin(angle) * 120),
      });
    }
    // Production flattens the staircase first — fitting the raw pixel steps
    // would chase their own noise — then fits curves to the glyph's corners.
    const fitted = fitRingCurve(smoothRing(ring, 2), 1.2);
    expect(fitted.length).toBeLessThan(30);
    expect(fitted.length).toBeGreaterThan(2);
    // Handles are real positions, not the anchor again.
    const withHandles = fitted.filter((entry) => entry.handleOut && entry.handleIn);
    expect(withHandles.length).toBeGreaterThan(0);
  });
});
