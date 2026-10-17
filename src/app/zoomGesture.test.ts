import { describe, expect, it } from 'vitest';
import { BoardZoomGesture, formatLayerTransform, type BoardView, type LayerOrigin } from './zoomGesture';

const view = (zoom: number, panX: number, panY: number): BoardView => ({ zoom, panX, panY });

/**
 * Where a canvas point ends up, given a layer drawn at `start` and then carrying
 * `transform`. Mirrors what the browser does: the transform acts in the layer's own
 * frame, which sits at `origin` in the wrap, and the drawing within it is at
 * `pan + zoom·c - origin` because that is where a repaint would have drawn it.
 */
function frozenPosition(
  start: BoardView,
  transform: { tx: number; ty: number; scale: number },
  origin: LayerOrigin,
  c: { x: number; y: number }
): { x: number; y: number } {
  const local = { x: start.panX + start.zoom * c.x - origin.x, y: start.panY + start.zoom * c.y - origin.y };
  return {
    x: origin.x + transform.tx + transform.scale * local.x,
    y: origin.y + transform.ty + transform.scale * local.y,
  };
}

/** Where a repaint at `end` puts the same point. */
function paintedPosition(end: BoardView, c: { x: number; y: number }): { x: number; y: number } {
  return { x: end.panX + end.zoom * c.x, y: end.panY + end.zoom * c.y };
}

describe('BoardZoomGesture', () => {
  it('reports nothing while no gesture is in flight', () => {
    const gesture = new BoardZoomGesture();
    expect(gesture.active).toBe(false);
    expect(gesture.startView).toBeNull();
    expect(gesture.layerTransform(view(1, 0, 0))).toBeNull();
    expect(gesture.end()).toBe(false);
  });

  it('holds the view the layers were drawn at, and forgets it when it ends', () => {
    const gesture = new BoardZoomGesture();
    const start = view(0.5, 100, 200);
    gesture.begin(start);
    expect(gesture.active).toBe(true);
    start.zoom = 9; // a caller mutating its object must not move the frozen view
    expect(gesture.startView).toEqual(view(0.5, 100, 200));
    expect(gesture.end()).toBe(true);
    expect(gesture.active).toBe(false);
    expect(gesture.end()).toBe(false);
  });

  it('is the identity when the view has not moved', () => {
    const gesture = new BoardZoomGesture();
    gesture.begin(view(0.5, 100, 200));
    const t = gesture.layerTransform(view(0.5, 100, 200), { x: 53, y: 0 });
    expect(t).toEqual({ tx: 0, ty: 0, scale: 1 });
    expect(formatLayerTransform(t!)).toBe('translate(0px, 0px) scale(1)');
  });

  it('slides a frozen layer by the pan alone, however it was drawn', () => {
    const gesture = new BoardZoomGesture();
    gesture.begin(view(0.4, 10, 20));
    const t = gesture.layerTransform(view(0.4, 60, 5), { x: 53, y: 7 })!;
    expect(t.scale).toBe(1);
    expect(t.tx).toBeCloseTo(50, 10);
    expect(t.ty).toBeCloseTo(-15, 10);
  });

  it('lands a frozen layer exactly where a repaint would, origin and all', () => {
    const cases: Array<{ start: BoardView; end: BoardView; origin: LayerOrigin }> = [
      // the wires: pinned to the wrap
      { start: view(0.6, 534, 320), end: view(0.9663, 534, 320), origin: { x: 0, y: 0 } },
      // the page: drawn inside a host one rail to the right
      { start: view(0.6, 534, 320), end: view(0.9663, 661, 288), origin: { x: 53, y: 0 } },
      { start: view(0.248, 660, 157), end: view(1.44, -120, 900), origin: { x: 53, y: 0 } },
      // zooming out, panning the other way, and a layer with a vertical origin
      { start: view(2.5, -900, 40), end: view(0.04, 300, -700), origin: { x: 53, y: 46 } },
    ];
    for (const { start, end, origin } of cases) {
      const gesture = new BoardZoomGesture();
      gesture.begin(start);
      const t = gesture.layerTransform(end, origin)!;
      for (const c of [{ x: 0, y: 0 }, { x: 400, y: 300 }, { x: -250, y: 620 }, { x: 1200, y: -800 }]) {
        const frozen = frozenPosition(start, t, origin, c);
        const painted = paintedPosition(end, c);
        expect(frozen.x).toBeCloseTo(painted.x, 8);
        expect(frozen.y).toBeCloseTo(painted.y, 8);
      }
    }
  });

  it('drifts by the origin term if a layer is transformed as if it were at the wrap', () => {
    // The failure this guards: applying the wrap's transform to a layer that is
    // not at the wrap's origin — invisible at rest, `(k-1)·origin` while zooming.
    const start = view(0.6, 534, 320);
    const end = view(0.9663, 534, 320);
    const origin = { x: 53, y: 0 };
    const gesture = new BoardZoomGesture();
    gesture.begin(start);
    const wrong = gesture.layerTransform(end)!; // origin left at 0
    const atZero = frozenPosition(start, wrong, origin, { x: 400, y: 300 });
    const painted = paintedPosition(end, { x: 400, y: 300 });
    expect(atZero.x - painted.x).toBeCloseTo(-(end.zoom / start.zoom - 1) * 53, 6);
    expect(Math.abs(atZero.x - painted.x)).toBeGreaterThan(30);
    expect(atZero.y).toBeCloseTo(painted.y, 8);
  });
});
