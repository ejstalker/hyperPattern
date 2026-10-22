/**
 * The "+ 3d container" prompt that a 2D container's free output terminal offers.
 *
 * A container's output is the one place a drape can start from: dragging it onto a
 * drape's input wires the two up, and this is the same thing without the dragging —
 * one click, and the drape appears beside the terminal, already carrying the remesh
 * and transform stages it needs.
 */

/** The new drape's size in board units, matching what the Add menu makes. */
export const DRAPE_NODE_WIDTH = 420;
export const DRAPE_NODE_HEIGHT = 320;

/** Screen px between the terminal and the drape that would appear beside it. */
const ATTACH_GAP_PX = 26;

/** What a hovered port is, as far as this prompt is concerned. */
export type PortFacts = {
  /** The canvas node that owns the port. */
  nodeType: string;
  direction: 'in' | 'out' | string;
  /** `pattern`, `mesh`, `transform`, `sim`. */
  kind: string;
  /** Something is wired to it — the prompt would be offering a second drape. */
  connected: boolean;
  /** A wire is being dragged right now; the board is mid-gesture. */
  wiring: boolean;
  /** A stage that lives inside a drape has no board presence to attach from. */
  embedded: boolean;
};

/**
 * Whether this terminal can grow a 3D container: only a 2D container's output, and
 * only while nothing is wired to it. An output that is already feeding a remesh
 * stage has a drape (or is one drag away from having one), so offering to make a
 * second would be a lie.
 */
export function canAttach3dContainer(port: PortFacts): boolean {
  return (
    port.nodeType === 'patternFrame' &&
    port.direction === 'out' &&
    port.kind === 'pattern' &&
    !port.connected &&
    !port.wiring &&
    !port.embedded
  );
}

/** A rectangle in client coordinates. */
export type ScreenRect = { left: number; top: number; right: number; bottom: number };

/**
 * Where a drape made from `port` should be centred, in client coordinates.
 *
 * Beside the terminal rather than on it, and kept inside the board so a container
 * hard against the edge of the view still gets a drape you can see and grab.
 */
export function attachDrapeAnchor(
  port: { right: number; top: number; height: number },
  zoom: number,
  size: { width: number; height: number },
  bounds: ScreenRect
): { clientX: number; clientY: number } {
  const widthPx = size.width * zoom;
  const heightPx = size.height * zoom;
  const margin = 8;
  // Beside the terminal, with its top a little above the terminal's own centre.
  let left = port.right + ATTACH_GAP_PX;
  let top = port.top + port.height / 2 - heightPx * 0.2;
  if (bounds.right - bounds.left > 0) {
    left = Math.min(left, bounds.right - widthPx - margin);
    left = Math.max(left, bounds.left + margin);
  }
  if (bounds.bottom - bounds.top > 0) {
    top = Math.min(top, bounds.bottom - heightPx - margin);
    top = Math.max(top, bounds.top + margin);
  }
  // The drape is placed by its centre, which is how every node created from the
  // board's Add menu is placed.
  return { clientX: left + widthPx / 2, clientY: top + heightPx / 2 };
}
