import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { PlacementGesture } from './placementGesture';

describe('PlacementGesture', () => {
  it('reports nothing for a gesture that never moved the cloth', () => {
    const gesture = new PlacementGesture();
    gesture.begin(['a']);
    expect(gesture.end()).toBeNull();
  });

  it('reports the translated pieces', () => {
    const gesture = new PlacementGesture();
    gesture.begin(['a', 'b']);
    gesture.movedBy(vec3.fromValues(0.1, 0, 0));
    expect(gesture.end()).toEqual({ pieceIds: ['a', 'b'], moved: true, turns: [] });
  });

  it('ignores sub-micron jitter from a click', () => {
    const gesture = new PlacementGesture();
    gesture.begin(['a']);
    gesture.movedBy(vec3.fromValues(1e-9, 0, 0));
    expect(gesture.end()).toBeNull();
  });

  it('accumulates normalised world-axis turns in order', () => {
    const gesture = new PlacementGesture();
    gesture.begin(['a']);
    gesture.turned(vec3.fromValues(0, 2, 0), Math.PI / 2);
    gesture.turned(vec3.fromValues(1, 0, 0), -0.25);
    const commit = gesture.end();
    expect(commit?.moved).toBe(false);
    expect(commit?.turns).toEqual([
      { axis: [0, 1, 0], radians: Math.PI / 2 },
      { axis: [1, 0, 0], radians: -0.25 },
    ]);
  });

  it('drops degenerate turns and turns below the epsilon', () => {
    const gesture = new PlacementGesture();
    gesture.begin(['a']);
    gesture.turned(vec3.fromValues(0, 0, 0), 0.5);
    gesture.turned(vec3.fromValues(0, 1, 0), 0);
    gesture.turned(vec3.fromValues(0, 1, 0), Number.NaN);
    expect(gesture.end()).toBeNull();
  });

  it('starts clean for the next gesture and ignores input for no selection', () => {
    const gesture = new PlacementGesture();
    gesture.begin(['a']);
    gesture.movedBy(vec3.fromValues(1, 0, 0));
    expect(gesture.end()?.pieceIds).toEqual(['a']);

    gesture.begin([]);
    gesture.movedBy(vec3.fromValues(1, 0, 0));
    gesture.turned(vec3.fromValues(0, 1, 0), 1);
    expect(gesture.end()).toBeNull();

    gesture.begin(['b']);
    expect(gesture.end()).toBeNull();
  });

  it('can be abandoned without reporting', () => {
    const gesture = new PlacementGesture();
    gesture.begin(['a']);
    gesture.movedBy(vec3.fromValues(1, 0, 0));
    gesture.cancel();
    expect(gesture.end()).toBeNull();
  });
});
