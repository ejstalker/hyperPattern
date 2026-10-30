import { describe, expect, it } from 'vitest';
import { createModifierNode, type ModifierMask, type ModifierNode } from './types';
import { cookPattern } from './engine';
import { NOISE_DEFAULTS } from './noise';
import { rectPiece } from '../../project/createDefault';
import { pieceRings, ringEdgeCount } from '../geometry';
import type { PatternDocument, PatternPiece } from '../../project/types';
import {
  POINT_ORDER,
  edgeUv,
  pieceAttributes,
  pointAttributes,
  setPointAttribute,
} from '../../project/attributes';

function patternOf(...pieces: PatternPiece[]): PatternDocument {
  return { id: 'p1', name: 'Test', pieces, seams: [] };
}

function stack(pattern: PatternDocument, ...nodes: ModifierNode[]): PatternDocument {
  return { ...pattern, modifiers: nodes };
}

function box(name = 'Box', w = 40, h = 20, x = 0, y = 0): PatternPiece {
  return rectPiece(name, w, h, { x, y });
}

const near = (a: number, b: number, dp = 6) => Math.abs(a - b) < 10 ** -dp;


/** A regular polygon: `n` points, orders 0..n-1, easy to reason about. */
function polygonPiece(n: number, radius = 20): PatternPiece {
  const points = Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2;
    return {
      id: `poly${i}`,
      anchor: { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
      handleIn: null,
      handleOut: null,
    };
  });
  return { id: `poly-${n}`, name: 'Poly', closed: true, points };
}

describe('cookPattern — the basics', () => {
  it('cooks an empty stack to a clone of the same pieces', () => {
    const piece = box();
    const result = cookPattern(patternOf(piece));
    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]!.id).toBe(piece.id);
    // A clone: cooking never hands back the document's own geometry.
    expect(result.pieces[0]).not.toBe(piece);
    expect(result.diagnostics).toEqual([]);
  });

  it('skips bypassed nodes but keeps them in the stack', () => {
    const piece = box();
    const move = createModifierNode('transform', 'n1');
    if (move.type !== 'transform') throw new Error('expected transform');
    move.translate = { x: 100, y: 0 };
    move.enabled = false;
    const result = cookPattern(stack(patternOf(piece), move));
    expect(result.pieces[0]!.points[0]!.anchor.x).toBeCloseTo(0);
  });

  it('is deterministic: the same document cooks to the same ids and numbers', () => {
    const move = createModifierNode('transform', 'n1');
    if (move.type !== 'transform') throw new Error('expected transform');
    move.translate = { x: 5, y: 3 };
    const cut = createModifierNode('cut', 'n2');
    if (cut.type !== 'cut') throw new Error('expected cut');
    cut.a = { x: 20, y: -100 };
    cut.b = { x: 20, y: 100 };
    const doc = stack(patternOf(box()), move, cut);
    const a = cookPattern(doc);
    const b = cookPattern(doc);
    expect(a.pieces.map((p) => p.id)).toEqual(b.pieces.map((p) => p.id));
    expect(a.pieces[0]!.points[0]!.anchor).toEqual(b.pieces[0]!.points[0]!.anchor);
  });
});

describe('Transform', () => {
  it('translates every point and handle', () => {
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.translate = { x: 3, y: -2 };
    const result = cookPattern(stack(patternOf(box()), node));
    expect(result.pieces[0]!.points[0]!.anchor).toEqual({ x: 3, y: -2 });
    expect(result.pieces[0]!.points[1]!.anchor).toEqual({ x: 43, y: -2 });
  });

  it('turns about the centroid without moving it', () => {
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.rotateDeg = 90;
    const result = cookPattern(stack(patternOf(box()), node));
    const xs = result.pieces[0]!.points.map((p) => p.anchor.x);
    const ys = result.pieces[0]!.points.map((p) => p.anchor.y);
    const centreX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const centreY = ys.reduce((a, b) => a + b, 0) / ys.length;
    expect(centreX).toBeCloseTo(20);
    expect(centreY).toBeCloseTo(10);
    // A quarter turn of a 40×20 box is 20×40.
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(width).toBeCloseTo(20);
    expect(height).toBeCloseTo(40);
  });

  it('scales about a world pivot', () => {
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.pivot = 'world';
    node.pivotAt = { x: 0, y: 0 };
    node.scale = { x: 2, y: 2 };
    const result = cookPattern(stack(patternOf(box()), node));
    expect(result.pieces[0]!.points[1]!.anchor).toEqual({ x: 80, y: 0 });
  });

  it('pivots on a point an Anchor node named', () => {
    const anchor = createModifierNode('anchor', 'a');
    if (anchor.type !== 'anchor') throw new Error('expected anchor');
    anchor.anchor = 'hinge';
    anchor.at = { x: 0, y: 0 };
    anchor.maxDistanceCm = 1;

    const turn = createModifierNode('transform', 't');
    if (turn.type !== 'transform') throw new Error('expected transform');
    turn.pivot = 'anchor';
    turn.anchor = 'hinge';
    turn.rotateDeg = 90;

    const result = cookPattern(stack(patternOf(box()), anchor, turn));
    // The corner at the origin is the hinge, so it stays put.
    const corner = result.pieces[0]!.points[0]!.anchor;
    expect(corner.x).toBeCloseTo(0);
    expect(corner.y).toBeCloseTo(0);
  });
});

describe('Subdivide', () => {
  it('adds one point per edge and keeps the outline where it was', () => {
    const node = createModifierNode('subdivide', 's');
    if (node.type !== 'subdivide') throw new Error('expected subdivide');
    node.cuts = 1;
    const result = cookPattern(stack(patternOf(box()), node));
    const ring = result.pieces[0]!.points;
    expect(ring).toHaveLength(8);
    // The new point sits halfway along the first edge.
    expect(ring[1]!.anchor).toEqual({ x: 20, y: 0 });
    expect(ringEdgeCount(result.pieces[0]!, 0)).toBe(8);
  });

  it('cuts every Nth edge only', () => {
    const node = createModifierNode('subdivide', 's');
    if (node.type !== 'subdivide') throw new Error('expected subdivide');
    node.cuts = 1;
    node.every = 2;
    const result = cookPattern(stack(patternOf(box()), node));
    expect(result.pieces[0]!.points).toHaveLength(6);
  });

  it('splits long edges into pieces no longer than asked', () => {
    const node = createModifierNode('subdivide', 's');
    if (node.type !== 'subdivide') throw new Error('expected subdivide');
    node.cuts = 0;
    node.maxLengthCm = 10;
    const result = cookPattern(stack(patternOf(box('Box', 40, 20)), node));
    // 40 cm edges become four 10 cm pieces, 20 cm edges two.
    expect(result.pieces[0]!.points).toHaveLength(12);
  });

  it('reports the point order of the new ring', () => {
    const node = createModifierNode('subdivide', 's');
    if (node.type !== 'subdivide') throw new Error('expected subdivide');
    node.cuts = 1;
    const result = cookPattern(stack(patternOf(box()), node));
    const piece = result.pieces[0]!;
    const orders = piece.points.map((pt) => pointAttributes(piece, pt.id)[POINT_ORDER]);
    expect(orders).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('Cut', () => {
  it('splits a piece in two and records the lineage', () => {
    const node = createModifierNode('cut', 'c');
    if (node.type !== 'cut') throw new Error('expected cut');
    node.a = { x: 20, y: -100 };
    node.b = { x: 20, y: 100 };
    const source = box();
    const result = cookPattern(stack(patternOf(source), node));
    expect(result.pieces).toHaveLength(2);
    expect(result.pieces.map((p) => p.name)).toEqual(['Box A', 'Box B']);
    expect(result.pieceSuccessors[source.id]).toEqual([
      result.pieces[0]!.id,
      result.pieces[1]!.id,
    ]);
    for (const piece of result.pieces) {
      expect(piece.closed).toBe(true);
      expect(piece.points.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps attributes on the points that survived', () => {
    const source = box();
    const corner = source.points[0]!;
    setPointAttribute(source, corner.id, 'seam', 7);
    const node = createModifierNode('cut', 'c');
    if (node.type !== 'cut') throw new Error('expected cut');
    node.a = { x: 20, y: -100 };
    node.b = { x: 20, y: 100 };
    const result = cookPattern(stack(patternOf(source), node));
    const carried = result.pieces
      .flatMap((piece) => pieceRings(piece).flat())
      .filter((pt) => pointAttributes(result.pieces.find((p) => p.points.includes(pt))!, pt.id).seam === 7);
    expect(carried.length).toBe(1);
  });

  it('can keep one side only', () => {
    const node = createModifierNode('cut', 'c');
    if (node.type !== 'cut') throw new Error('expected cut');
    node.a = { x: 20, y: -100 };
    node.b = { x: 20, y: 100 };
    node.keep = 'a';
    const result = cookPattern(stack(patternOf(box()), node));
    expect(result.pieces).toHaveLength(1);
  });

  it('says so when the line misses the piece', () => {
    const node = createModifierNode('cut', 'c');
    if (node.type !== 'cut') throw new Error('expected cut');
    node.a = { x: 500, y: -100 };
    node.b = { x: 500, y: 100 };
    const result = cookPattern(stack(patternOf(box()), node));
    expect(result.pieces).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.nodeId).toBe('c');
  });
});

describe('Displace', () => {
  /** Area of a piece's outline, for measuring whether a push inflated it. */
  const area = (piece: PatternPiece): number => {
    const ring = piece.points;
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!.anchor;
      const b = ring[(i + 1) % ring.length]!.anchor;
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum / 2);
  };

  it('pushes every point outwards by the amount, whichever way the ring winds', () => {
    const node = createModifierNode('displace', 'd');
    if (node.type !== 'displace') throw new Error('expected displace');
    node.amount = 2;
    node.direction = 'normal';
    const source = box();
    const result = cookPattern(stack(patternOf(source), node));
    const piece = result.pieces[0]!;
    expect(area(piece)).toBeGreaterThan(area(source));
    // Each point moved by exactly the amount, away from the piece's middle.
    for (let i = 0; i < piece.points.length; i++) {
      const before = source.points[i]!.anchor;
      const after = piece.points[i]!.anchor;
      const moved = Math.hypot(after.x - before.x, after.y - before.y);
      expect(moved).toBeCloseTo(2);
      const centre = { x: 20, y: 10 };
      const outward =
        (after.x - centre.x) * (before.x - centre.x) +
        (after.y - centre.y) * (before.y - centre.y);
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('scales the amount by an attribute the Noise node wrote', () => {
    const noise = createModifierNode('noise', 'n');
    if (noise.type !== 'noise') throw new Error('expected noise');
    noise.attribute = 'push';
    const displace = createModifierNode('displace', 'd');
    if (displace.type !== 'displace') throw new Error('expected displace');
    displace.amount = 10;
    displace.amountAttribute = 'push';
    const source = box();
    const result = cookPattern(stack(patternOf(source), noise, displace));
    const pt = result.pieces[0]!.points[0]!;
    const value = pointAttributes(result.pieces[0]!, pt.id).push as number;
    expect(typeof value).toBe('number');
    const moved = Math.hypot(
      pt.anchor.x - source.points[0]!.anchor.x,
      pt.anchor.y - source.points[0]!.anchor.y
    );
    expect(moved).toBeCloseTo(Math.abs(10 * value));
  });

  it('runs again for each iteration', () => {
    const once = createModifierNode('displace', 'd');
    if (once.type !== 'displace') throw new Error('expected displace');
    once.amount = 1;
    const thrice: ModifierNode = { ...structuredClone(once), iterations: 3 };
    const source = box();
    const a = cookPattern(stack(patternOf(source), once));
    const b = cookPattern(stack(patternOf(source), thrice));
    // Normals turn as the shape grows, so the pushes are not collinear — but
    // three of them inflate further than one.
    expect(area(b.pieces[0]!)).toBeGreaterThan(area(a.pieces[0]!));
    expect(area(a.pieces[0]!)).toBeGreaterThan(area(source));
  });
});

describe('Noise', () => {
  it('writes the sampled field to every matching point', () => {
    const node = createModifierNode('noise', 'n');
    if (node.type !== 'noise') throw new Error('expected noise');
    node.attribute = 'n1';
    node.noise = { ...NOISE_DEFAULTS, frequency: 0.1, fractal: 'none' };
    const result = cookPattern(stack(patternOf(box()), node));
    for (const pt of result.pieces[0]!.points) {
      const value = pointAttributes(result.pieces[0]!, pt.id).n1;
      expect(typeof value).toBe('number');
      expect(Math.abs(value as number)).toBeLessThanOrEqual(1.000001);
    }
  });
});

describe('Create', () => {
  it('makes a rectangle', () => {
    const node = createModifierNode('create', 'k', { x: 0, y: 0 });
    if (node.type !== 'create') throw new Error('expected create');
    node.shape = 'rect';
    node.width = 10;
    node.height = 20;
    const result = cookPattern(stack(patternOf(), node));
    expect(result.pieces).toHaveLength(1);
    expect(result.pieces[0]!.points).toHaveLength(4);
    expect(result.pieces[0]!.closed).toBe(true);
  });

  it('makes a circle with enough sides to read as one', () => {
    const node = createModifierNode('create', 'k');
    if (node.type !== 'create') throw new Error('expected create');
    node.shape = 'circle';
    node.radius = 5;
    const result = cookPattern(stack(patternOf(), node));
    expect(result.pieces[0]!.points.length).toBeGreaterThanOrEqual(24);
  });

  it('repeats with a spacing', () => {
    const node = createModifierNode('create', 'k');
    if (node.type !== 'create') throw new Error('expected create');
    node.count = 3;
    node.spacing = 15;
    const result = cookPattern(stack(patternOf(), node));
    expect(result.pieces).toHaveLength(3);
    const xs = result.pieces.map((p) => p.points[0]!.anchor.x);
    expect(xs[1]! - xs[0]!).toBeCloseTo(15);
  });
});

describe('Masks', () => {
  it('run on the pieces a piece mask names, counting from 1', () => {
    const a = box('A');
    const b = box('B', 40, 20, 100, 0);
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.translate = { x: 5, y: 0 };
    node.masks = [{ kind: 'piece', min: 2, max: 2 }];
    const result = cookPattern(stack(patternOf(a, b), node));
    expect(result.pieces.find((p) => p.name === 'A')!.points[0]!.anchor.x).toBeCloseTo(0);
    expect(result.pieces.find((p) => p.name === 'B')!.points[0]!.anchor.x).toBeCloseTo(105);
  });

  it('take a range of piece numbers', () => {
    const pieces = [box('A'), box('B', 40, 20, 100, 0), box('C', 40, 20, 200, 0)];
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.translate = { x: 5, y: 0 };
    node.masks = [{ kind: 'piece', min: 2, max: 3 }];
    const result = cookPattern(stack(patternOf(...pieces), node));
    expect(result.pieces.map((p) => p.points[0]!.anchor.x)).toEqual([0, 105, 205]);
  });

  it('take a range of point orders', () => {
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.translate = { x: 5, y: 0 };
    node.masks = [{ kind: 'point', min: 2, max: 3 }];
    const result = cookPattern(stack(patternOf(box()), node));
    expect(result.pieces[0]!.points.map((p) => p.anchor.x)).toEqual([0, 40, 45, 5]);
  });

  it('read an attribute the Noise node wrote, as a range that counts as true', () => {
    const noise = createModifierNode('noise', 'n');
    if (noise.type !== 'noise') throw new Error('expected noise');
    noise.attribute = 'gather';
    noise.noise = { ...NOISE_DEFAULTS, frequency: 0.05, fractal: 'none', amplitude: 1 };
    const move = createModifierNode('transform', 't');
    if (move.type !== 'transform') throw new Error('expected transform');
    move.translate = { x: 100, y: 0 };
    move.masks = [
      { kind: 'attribute', attributeClass: 'point', name: 'gather', min: 0.2, max: 1 },
    ];
    const first = cookPattern(stack(patternOf(box()), noise));
    const cooked = cookPattern(stack(patternOf(box()), noise, move));
    const passes = first.pieces[0]!.points.map(
      (pt) => (pointAttributes(first.pieces[0]!, pt.id).gather as number) >= 0.2
    );
    // Only the points inside the range moved, and they moved the whole way.
    cooked.pieces[0]!.points.forEach((pt, i) => {
      const before = first.pieces[0]!.points[i]!.anchor.x;
      expect(pt.anchor.x).toBeCloseTo(before + (passes[i] ? 100 : 0));
    });
    expect(passes.filter(Boolean).length).toBeGreaterThan(0);
    expect(passes.filter((n) => !n).length).toBeGreaterThan(0);
  });

  it('read a piece attribute for every point of that piece', () => {
    const a = box('A');
    const b = box('B', 40, 20, 100, 0);
    pieceAttributes(b, true).zone = 2;
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.translate = { x: 5, y: 0 };
    node.masks = [
      { kind: 'attribute', attributeClass: 'piece', name: 'zone', min: 2, max: 2 },
    ];
    const result = cookPattern(stack(patternOf(a, b), node));
    expect(result.pieces.find((p) => p.name === 'A')!.points[0]!.anchor.x).toBeCloseTo(0);
    expect(result.pieces.find((p) => p.name === 'B')!.points[0]!.anchor.x).toBeCloseTo(105);
  });

  it('need every mask to pass, so masks narrow each other', () => {
    const a = box('A');
    const b = box('B', 40, 20, 100, 0);
    pieceAttributes(b, true).zone = 2;
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.translate = { x: 5, y: 0 };
    node.masks = [
      { kind: 'point', min: 0, max: 1 },
      { kind: 'attribute', attributeClass: 'piece', name: 'zone', min: 2, max: 2 },
    ];
    const result = cookPattern(stack(patternOf(a, b), node));
    // A fails the attribute mask, so its points are untouched even though they
    // are inside the order range.
    expect(result.pieces.find((p) => p.name === 'A')!.points[0]!.anchor.x).toBeCloseTo(0);
    // B's points 0 and 1 move; 2 and 3 are outside the order mask.
    expect(result.pieces.find((p) => p.name === 'B')!.points.map((p) => p.anchor.x)).toEqual([
      105, 145, 140, 100,
    ]);
  });

  it('mask a whole-piece node by "some point of it falls inside"', () => {
    const a = box('A');
    const b = box('B', 40, 20, 100, 0);
    const cut = createModifierNode('cut', 'c');
    if (cut.type !== 'cut') throw new Error('expected cut');
    cut.a = { x: 120, y: -100 };
    cut.b = { x: 120, y: 100 };
    cut.masks = [{ kind: 'piece', min: 2, max: 2 }];
    const result = cookPattern(stack(patternOf(a, b), cut));
    expect(result.pieces.filter((p) => p.name.startsWith('B'))).toHaveLength(2);
    expect(result.pieces.filter((p) => p.name === 'A')).toHaveLength(1);
  });

  it('leave everything running when a mask names no attribute yet', () => {
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.translate = { x: 5, y: 0 };
    node.masks = [{ kind: 'attribute', attributeClass: 'point', name: '', min: 0, max: 0 }];
    const result = cookPattern(stack(patternOf(box()), node));
    expect(result.pieces[0]!.points[0]!.anchor.x).toBeCloseTo(5);
  });

  it('mask a displace by point order', () => {
    const node = createModifierNode('displace', 'd');
    if (node.type !== 'displace') throw new Error('expected displace');
    node.amount = 2;
    node.masks = [{ kind: 'point', min: 0, max: 0 }];
    const result = cookPattern(stack(patternOf(box()), node));
    // One point moved — the one the mask named — and it moved by the amount.
    expect(Math.hypot(result.pieces[0]!.points[0]!.anchor.x, result.pieces[0]!.points[0]!.anchor.y)).toBeCloseTo(2);
    expect(result.pieces[0]!.points[1]!.anchor).toEqual({ x: 40, y: 0 });
  });
});

describe('Falloff', () => {
  it('attenuates a transform by the ramp, not by a line in the sand', () => {
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.translate = { x: 10, y: 0 };
    // Orders 4–5 at full strength, fading to nothing two orders either side.
    node.masks = [{ kind: 'point', min: 4, max: 5, falloff: 2 }];
    const piece = polygonPiece(6);
    const result = cookPattern(stack(patternOf(piece), node));
    const moved = result.pieces[0]!.points.map((pt, i) => pt.anchor.x - piece.points[i]!.anchor.x);
    expect(moved[0]).toBeCloseTo(0); // 2 below the range: outside the fade
    expect(moved[1]).toBeCloseTo(0); // 1 below: the fade starts here, at 0
    expect(moved[2]).toBeCloseTo(0);
    expect(moved[3]).toBeCloseTo(5); // halfway up the ramp
    expect(moved[4]).toBeCloseTo(10); // inside the range
    expect(moved[5]).toBeCloseTo(10);
  });

  it('fades a displace by the same ramp', () => {
    const displace = createModifierNode('displace', 'd');
    if (displace.type !== 'displace') throw new Error('expected displace');
    displace.amount = 4;
    displace.direction = 'angle';
    displace.angleDeg = 0;
    displace.masks = [{ kind: 'point', min: 1, max: 2, falloff: 1 }];
    const piece = polygonPiece(4);
    const result = cookPattern(stack(patternOf(piece), displace));
    const moved = result.pieces[0]!.points.map((pt, i) => pt.anchor.x - piece.points[i]!.anchor.x);
    expect(moved[0]).toBeCloseTo(0); // one below the range: at the foot of the fade
    expect(moved[1]).toBeCloseTo(4);
    expect(moved[2]).toBeCloseTo(4);
    expect(moved[3]).toBeCloseTo(0);
  });

  it('fades a noise value toward zero', () => {
    const noise = createModifierNode('noise', 'n');
    if (noise.type !== 'noise') throw new Error('expected noise');
    noise.attribute = 'fade';
    noise.noise = { ...NOISE_DEFAULTS, frequency: 0.05, fractal: 'none', amplitude: 1 };
    const full = cookPattern(
      stack(patternOf(polygonPiece(4)), {
        ...noise,
        masks: [{ kind: 'point', min: 0, max: 3 }],
      })
    );
    const faded = cookPattern(
      stack(patternOf(polygonPiece(4)), {
        ...noise,
        masks: [{ kind: 'point', min: 0, max: 1, falloff: 2 }],
      })
    );
    const at = (result: typeof full, index: number) =>
      pointAttributes(result.pieces[0]!, result.pieces[0]!.points[index]!.id).fade as number;
    expect(at(faded, 0)).toBeCloseTo(at(full, 0));
    expect(at(faded, 1)).toBeCloseTo(at(full, 1));
    // Order 2 is one step into a fade of 2, so it keeps half its value.
    expect(at(faded, 2)).toBeCloseTo(at(full, 2) / 2);
  });

  it('multiplies the densities of several masks', () => {
    const node = createModifierNode('transform', 't');
    if (node.type !== 'transform') throw new Error('expected transform');
    node.translate = { x: 8, y: 0 };
    node.masks = [
      { kind: 'point', min: 0, max: 1, falloff: 2 },
      { kind: 'point', min: 0, max: 0, falloff: 2 },
    ];
    const piece = polygonPiece(3);
    const result = cookPattern(stack(patternOf(piece), node));
    const moved = result.pieces[0]!.points.map((pt, i) => pt.anchor.x - piece.points[i]!.anchor.x);
    // Order 0: full on both. Order 1: full on the first, half on the second.
    // Order 2: half on the first, nothing on the second.
    expect(moved[0]).toBeCloseTo(8);
    expect(moved[1]).toBeCloseTo(4);
    expect(moved[2]).toBeCloseTo(0);
  });

  it('takes a whole piece only when the fade has it over half', () => {
    const cut = createModifierNode('cut', 'c');
    if (cut.type !== 'cut') throw new Error('expected cut');
    // A line down the middle of A, which also passes through B.
    cut.a = { x: 20, y: -100 };
    cut.b = { x: 20, y: 100 };
    // Piece 1 is the range; piece 2 sits half a step into a fade of 1, which is
    // not over half, so it is left whole.
    cut.masks = [{ kind: 'piece', min: 1, max: 1, falloff: 1 }];
    const result = cookPattern(stack(patternOf(box('A'), box('B', 40, 20, 0, 40)), cut));
    expect(result.pieces.filter((p) => p.name.startsWith('A'))).toHaveLength(2);
    expect(result.pieces.filter((p) => p.name === 'B')).toHaveLength(1);
    expect(result.pieces.find((p) => p.name === 'B')!.points[0]!.anchor.x).toBeCloseTo(0);
  });

  it('scales how many cuts a subdivide lands', () => {
    const node = createModifierNode('subdivide', 's');
    if (node.type !== 'subdivide') throw new Error('expected subdivide');
    node.cuts = 4;
    // Piece 1 at full strength, piece 2 at half, piece 3 out in the fade's tail.
    node.masks = [{ kind: 'piece', min: 1, max: 1, falloff: 2 }];
    const result = cookPattern(
      stack(patternOf(box('A'), box('B', 40, 20, 100, 0), box('C', 40, 20, 200, 0)), node)
    );
    const points = (name: string) =>
      result.pieces.find((p) => p.name === name)!.points.length;
    expect(points('A')).toBe(4 * 5); // 4 cuts on each of 4 edges
    expect(points('B')).toBe(4 * 3); // half the cuts: 2 on each edge
    expect(points('C')).toBe(4); // untouched
  });
});

describe('edge UVs through a cook', () => {
  it('stay a 0..1 span round the ring after subdividing', () => {
    const node = createModifierNode('subdivide', 's');
    if (node.type !== 'subdivide') throw new Error('expected subdivide');
    node.cuts = 1;
    const result = cookPattern(stack(patternOf(box()), node));
    const piece = result.pieces[0]!;
    const uv = edgeUv(piece, piece.points[0]!.id, piece.points[1]!.id)!;
    expect(uv.u0).toBeCloseTo(0);
    expect(uv.u1).toBeCloseTo(1 / 8);
    expect(uv.lengthCm).toBeCloseTo(20);
  });

  it('is carried on the edge attributes', () => {
    const piece = box();
    const uv = edgeUv(piece, piece.points[0]!.id, piece.points[1]!.id)!;
    expect(uv.u1).toBeCloseTo(0.25);
  });
});

describe('seams through a cook', () => {
  it('are kept when their edge survives a cut, and lost when it is cut in two', () => {
    const a = box('A');
    const b = box('B', 40, 20, 60, 0);
    // This seam runs along B's top edge, which the cut below goes straight through.
    const seam = {
      id: 's1',
      a: { pieceId: a.id, fromPointId: a.points[1]!.id, toPointId: a.points[2]!.id, t0: 0, t1: 1 },
      b: { pieceId: b.id, fromPointId: b.points[0]!.id, toPointId: b.points[1]!.id, t0: 0, t1: 1 },
      restGapCm: 0,
    };
    const doc: PatternDocument = { id: 'p', name: 'T', pieces: [a, b], seams: [seam] };
    const cut = createModifierNode('cut', 'c');
    if (cut.type !== 'cut') throw new Error('expected cut');
    cut.a = { x: 80, y: -100 };
    cut.b = { x: 80, y: 100 };
    cut.masks = [{ kind: 'piece', min: 2, max: 2 }];
    const result = cookPattern({ ...doc, modifiers: [cut] });
    expect(result.seams).toHaveLength(0);
    expect(result.diagnostics.some((d) => /seam/i.test(d.message))).toBe(true);
  });

  it('follow their piece into the half that still holds both ends', () => {
    const a = box('A');
    const b = box('B', 40, 20, 60, 0);
    // This seam runs along B's *left* edge, which the cut leaves in one piece.
    const seam = {
      id: 's1',
      a: { pieceId: a.id, fromPointId: a.points[1]!.id, toPointId: a.points[2]!.id, t0: 0, t1: 1 },
      b: { pieceId: b.id, fromPointId: b.points[3]!.id, toPointId: b.points[0]!.id, t0: 0, t1: 1 },
      restGapCm: 0,
    };
    const doc: PatternDocument = { id: 'p', name: 'T', pieces: [a, b], seams: [seam] };
    const cut = createModifierNode('cut', 'c');
    if (cut.type !== 'cut') throw new Error('expected cut');
    cut.a = { x: 80, y: -100 };
    cut.b = { x: 80, y: 100 };
    cut.masks = [{ kind: 'piece', min: 2, max: 2 }];
    const result = cookPattern({ ...doc, modifiers: [cut] });
    expect(result.seams).toHaveLength(1);
    const moved = result.seams[0]!.b;
    expect(moved.pieceId).not.toBe(b.id);
    expect(result.pieces.some((piece) => piece.id === moved.pieceId)).toBe(true);
  });

  it('are untouched by a transform', () => {
    const a = box('A');
    const b = box('B', 40, 20, 60, 0);
    const seam = {
      id: 's1',
      a: { pieceId: a.id, fromPointId: a.points[1]!.id, toPointId: a.points[2]!.id, t0: 0, t1: 1 },
      b: { pieceId: b.id, fromPointId: b.points[3]!.id, toPointId: b.points[0]!.id, t0: 0, t1: 1 },
      restGapCm: 0,
    };
    const doc: PatternDocument = { id: 'p', name: 'T', pieces: [a, b], seams: [seam] };
    const move = createModifierNode('transform', 't');
    if (move.type !== 'transform') throw new Error('expected transform');
    move.translate = { x: 1, y: 1 };
    const result = cookPattern({ ...doc, modifiers: [move] });
    expect(result.seams).toHaveLength(1);
    expect(near(result.seams[0]!.a.t1, 1)).toBe(true);
  });
});

describe('Attribute', () => {
  const attrNode = (patch: Partial<ModifierNode> = {}): ModifierNode => {
    const node = createModifierNode('attribute', 'a');
    if (node.type !== 'attribute') throw new Error('expected attribute');
    return { ...node, ...patch } as ModifierNode;
  };

  it('writes a number to every point', () => {
    const node = attrNode({ attribute: 'gather', value: '0.5' } as Partial<ModifierNode>);
    const result = cookPattern(stack(patternOf(box()), node));
    for (const pt of result.pieces[0]!.points) {
      expect(pointAttributes(result.pieces[0]!, pt.id).gather).toBe(0.5);
    }
  });

  it('keeps words as words and marks flags', () => {
    const word = cookPattern(stack(patternOf(box()), attrNode({ attribute: 'zone', value: 'sleeve' } as Partial<ModifierNode>)));
    expect(pointAttributes(word.pieces[0]!, word.pieces[0]!.points[0]!.id).zone).toBe('sleeve');
    const flag = cookPattern(stack(patternOf(box()), attrNode({ attribute: 'on', value: 'true' } as Partial<ModifierNode>)));
    expect(pointAttributes(flag.pieces[0]!, flag.pieces[0]!.points[0]!.id).on).toBe(true);
  });

  it('writes to edges when asked to', () => {
    const node = attrNode({ attribute: 'stiff', value: '3', domain: 'edge' } as Partial<ModifierNode>);
    const result = cookPattern(stack(patternOf(box()), node));
    const piece = result.pieces[0]!;
    expect(piece.attributes?.edge).toBeDefined();
    const entries = Object.values(piece.attributes?.edge ?? {});
    expect(entries).toHaveLength(4);
    expect(entries[0]?.stiff).toBe(3);
  });

  it('writes to the piece itself', () => {
    const node = attrNode({ attribute: 'zone', value: 'sleeve', domain: 'piece' } as Partial<ModifierNode>);
    const result = cookPattern(stack(patternOf(box()), node));
    expect(pieceAttributes(result.pieces[0]!).zone).toBe('sleeve');
  });

  it('removes an attribute an earlier node wrote', () => {
    const set = attrNode({ attribute: 'tmp', value: '1' } as Partial<ModifierNode>);
    const clear: ModifierNode = { ...set, id: 'b', remove: true } as ModifierNode;
    const result = cookPattern(stack(patternOf(box()), set, clear));
    expect(pointAttributes(result.pieces[0]!, result.pieces[0]!.points[0]!.id).tmp).toBeUndefined();
  });

  it('feeds a group on a later node', () => {
    const tag = attrNode({ attribute: 'move', value: '1' } as Partial<ModifierNode>);
    const turn = createModifierNode('transform', 't');
    if (turn.type !== 'transform') throw new Error('expected transform');
    turn.translate = { x: 5, y: 0 };
    turn.masks = [
      { kind: 'attribute', attributeClass: 'point', name: 'move', min: 1, max: 1 },
    ];
    const result = cookPattern(stack(patternOf(box()), tag, turn));
    expect(result.pieces[0]!.points.every((pt) => pt.anchor.x >= 5)).toBe(true);
  });
});

describe('normalizeModifiers', () => {
  it('drops a node it does not know and keeps the rest', async () => {
    const { normalizeModifiers } = await import('./types');
    const stackIn = [
      { id: 'x', type: 'not-a-node' },
      { id: 'y', type: 'transform' },
    ] as unknown as ModifierNode[];
    const out = normalizeModifiers(stackIn);
    expect(out.map((n) => n.type)).toEqual(['transform']);
    expect(out[0]!.id).toBe('y');
  });

  it('fills a loaded node out from its defaults and clamps the repeat', async () => {
    const { normalizeModifiers } = await import('./types');
    const out = normalizeModifiers([
      { id: 'z', type: 'displace', iterations: 99 } as unknown as ModifierNode,
    ]);
    const node = out[0]!;
    expect(node.type).toBe('displace');
    expect(node.iterations).toBe(24);
    if (node.type === 'displace') {
      expect(node.amount).toBe(1);
      expect(node.direction).toBe('normal');
    }
  });
});
