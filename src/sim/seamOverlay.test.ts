import { describe, expect, it } from 'vitest';
import { stitchOverlayPairs } from './seamOverlay';

/** Two pieces, four particles: A = 0,1 · B = 2,3, stitched 0-2 and 1-3. */
const pairs: Array<[number, number]> = [
  [0, 2],
  [1, 3],
];
const pieces = ['A', 'A', 'B', 'B'];

describe('stitchOverlayPairs', () => {
  it('draws every stitch when nothing is ghosted', () => {
    expect(stitchOverlayPairs(pairs, pieces, new Set())).toEqual(pairs);
  });

  it('drops the stitches of a ghosted piece', () => {
    expect(stitchOverlayPairs(pairs, pieces, new Set(['B']))).toEqual([]);
    expect(stitchOverlayPairs(pairs, pieces, new Set(['A']))).toEqual([]);
  });

  it('keeps the stitches that involve no ghosted piece', () => {
    const mixed: Array<[number, number]> = [...pairs, [0, 1]];
    expect(stitchOverlayPairs(mixed, pieces, new Set(['B']))).toEqual([[0, 1]]);
  });

  it('does not mutate the pairs it was given', () => {
    const input: Array<[number, number]> = [
      [0, 2],
      [1, 3],
    ];
    stitchOverlayPairs(input, pieces, new Set(['A']));
    expect(input).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });
});
