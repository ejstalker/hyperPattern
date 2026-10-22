import { describe, expect, it } from 'vitest';
import { attachDrapeAnchor, canAttach3dContainer, DRAPE_NODE_HEIGHT, DRAPE_NODE_WIDTH } from './attachDrape';

const freePatternOutput = {
  nodeType: 'patternFrame',
  direction: 'out',
  kind: 'pattern',
  connected: false,
  wiring: false,
  embedded: false,
};

describe('canAttach3dContainer', () => {
  it('offers on a 2D container output that is not wired to anything', () => {
    expect(canAttach3dContainer(freePatternOutput)).toBe(true);
  });

  it('does not offer when the output already feeds something', () => {
    expect(canAttach3dContainer({ ...freePatternOutput, connected: true })).toBe(false);
  });

  it('does not offer mid-wire, or from a stage with no board presence', () => {
    expect(canAttach3dContainer({ ...freePatternOutput, wiring: true })).toBe(false);
    expect(canAttach3dContainer({ ...freePatternOutput, embedded: true })).toBe(false);
  });

  it('does not offer on inputs, on other kinds, or on other nodes', () => {
    expect(canAttach3dContainer({ ...freePatternOutput, direction: 'in' })).toBe(false);
    for (const kind of ['mesh', 'transform', 'sim']) {
      expect(canAttach3dContainer({ ...freePatternOutput, kind })).toBe(false);
    }
    for (const nodeType of ['meshFrame', 'transform3d', 'simViewport', 'image', 'text']) {
      expect(canAttach3dContainer({ ...freePatternOutput, nodeType })).toBe(false);
    }
  });
});

describe('attachDrapeAnchor', () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };
  const port = { right: 300, top: 100, height: 16 };
  const size = { width: DRAPE_NODE_WIDTH, height: DRAPE_NODE_HEIGHT };

  /** Where the App's centring puts the node's top-left, in client px. */
  const topLeft = (anchor: { clientX: number; clientY: number }, zoom: number) => ({
    x: anchor.clientX - (size.width * zoom) / 2,
    y: anchor.clientY - (size.height * zoom) / 2,
  });

  it('puts the drape beside the terminal, slightly above its centre line', () => {
    const zoom = 0.5;
    const anchor = attachDrapeAnchor(port, zoom, size, bounds);
    const at = topLeft(anchor, zoom);
    expect(at.x).toBe(326); // port.right + the gap
    expect(at.y).toBe(76); // the port's middle, less a fifth of the drape's height
  });

  it('keeps the drape on screen when the terminal is at the edge', () => {
    const zoom = 0.5;
    const right = topLeft(attachDrapeAnchor({ ...port, right: 990 }, zoom, size, bounds), zoom);
    expect(right.x).toBe(bounds.right - size.width * zoom - 8);
    const bottom = topLeft(attachDrapeAnchor({ ...port, top: 790 }, zoom, size, bounds), zoom);
    expect(bottom.y).toBe(bounds.bottom - size.height * zoom - 8);
    const corner = topLeft(attachDrapeAnchor({ ...port, top: 0, right: 995 }, zoom, size, bounds), zoom);
    expect(corner.y).toBe(bounds.top + 8);
    expect(corner.x).toBeGreaterThanOrEqual(bounds.left + 8);
  });

  it('never leaves the top-left corner off the board', () => {
    // Zoomed in far enough that the drape is wider than the view: the left edge
    // wins, so the node's corner stays reachable.
    const zoom = 4;
    const at = topLeft(attachDrapeAnchor({ ...port, right: 900 }, zoom, size, bounds), zoom);
    expect(at.x).toBe(bounds.left + 8);
  });

  it('leaves the placement alone when the board has no measured size', () => {
    const zoom = 1;
    const anchor = attachDrapeAnchor(port, zoom, size, { left: 0, top: 0, right: 0, bottom: 0 });
    const at = topLeft(anchor, zoom);
    expect(at.x).toBe(326);
    expect(Number.isFinite(at.y)).toBe(true);
  });
});
