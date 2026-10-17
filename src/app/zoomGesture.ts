/**
 * A zoom in flight.
 *
 * The board's drawing is in screen pixels twice over: the page and the wires are
 * drawn outside the board's own transform, at whatever zoom they were last told,
 * and every container inside it re-draws its chrome to match. Repainting all of
 * that on each step of a gesture is work the next step throws away — so while a
 * gesture is in flight the drawing is *not* repainted. Instead it is moved: the
 * layers are scaled as the pixels they already have, and the crisp re-draw happens
 * once, when the board stops. This class holds the view the frozen layers were
 * drawn at and works out the transform that puts them exactly where a repaint
 * would have put them.
 */
export type BoardView = {
  zoom: number;
  panX: number;
  panY: number;
};

/** Where a layer's own box starts, in the board wrap's coordinates. */
export type LayerOrigin = { x: number; y: number };

/** A CSS `translate(…) scale(…)` about the layer's own top-left corner. */
export type LayerTransform = { tx: number; ty: number; scale: number };

const NO_ORIGIN: LayerOrigin = { x: 0, y: 0 };

export class BoardZoomGesture {
  private start: BoardView | null = null;

  get active(): boolean {
    return this.start !== null;
  }

  /** The view the layers being frozen are drawn at. */
  get startView(): BoardView | null {
    return this.start;
  }

  /**
   * Open a gesture over the view that is currently on screen — not the one being
   * asked for, since the layers are drawn at the old one.
   */
  begin(view: BoardView): void {
    this.start = { zoom: view.zoom, panX: view.panX, panY: view.panY };
  }

  /** Forget the gesture. True when there was one to forget. */
  end(): boolean {
    const had = this.start !== null;
    this.start = null;
    return had;
  }

  /**
   * The transform that keeps a frozen layer in step with a board that has moved on.
   *
   * A canvas point `c` is drawn at `pan + zoom·c` in the wrap's coordinates — that
   * is the mapping the page and the wires are given, and the board's own transform
   * is the same one. Frozen at `<pan0, zoom0>` and now wanting `<pan1, zoom1>`,
   * the drawn pixels have to be scaled by `k = zoom1 / zoom0` and shifted so the
   * point they sit at lands where it now belongs.
   *
   * The shift depends on the layer's own origin because a CSS transform acts in
   * the layer's frame, not the wrap's: a point of the drawing at local `p` is at
   * `origin + p` in the wrap, and the transform puts it at `origin + t + k·p`. The
   * drawing sits at `pan0 + zoom0·c`, so `p = pan0 + zoom0·c - origin` and the
   * requirement `origin + t + k·p = pan1 + zoom1·c` solves to
   *
   *     t = pan1 - k·pan0 + (k - 1)·origin
   *
   * which is why a layer pinned to the wrap (the wires) passes no origin and the
   * page — drawn inside a host whose drawing starts one rail to the right — passes
   * the rail's width. Get that term wrong and a zoom drags the page sideways by
   * `(k - 1)·origin`, which is a pixel at no zoom, 50 px at 2×, and never at rest.
   */
  layerTransform(view: BoardView, origin: LayerOrigin = NO_ORIGIN): LayerTransform | null {
    const start = this.start;
    if (!start) return null;
    const scale = view.zoom / start.zoom;
    return {
      tx: view.panX - scale * start.panX + (scale - 1) * origin.x,
      ty: view.panY - scale * start.panY + (scale - 1) * origin.y,
      scale,
    };
  }
}

export function formatLayerTransform(t: LayerTransform): string {
  return `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`;
}
