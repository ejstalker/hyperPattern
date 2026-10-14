import { describe, expect, it } from 'vitest';
import { rectPiece, uid } from '../project/createDefault';
import type {
  BezierPoint,
  MeasureAnchor,
  MeasureItem,
  PatternMeasure,
  PatternPiece,
  Vec2,
} from '../project/types';
import { dist, pointOnEdgeAtT } from './geometry';
import {
  measureAnchorPoints,
  measureItemSpan,
  measureLabelText,
  measureLineSpans,
  measureReading,
  measureReferences,
  normalizeMeasures,
  resolveMeasureAnchor,
} from './measures';

/** A 20 × 10 rectangle: its edges run exactly along the axes, so a crossing's
 * t is easy to state by hand. */
function rectangle(): PatternPiece {
  return rectPiece('Panel', 20, 10, { x: 0, y: 0 });
}

/** A circle of `radius` as four cubic arcs, the way a round panel is drafted. */
function circle(radius = 10, arcs = 4): PatternPiece {
  const points: BezierPoint[] = [];
  const k = (4 / 3) * Math.tan(Math.PI / (2 * arcs)) * radius;
  for (let i = 0; i < arcs; i++) {
    const t = (i / arcs) * Math.PI * 2;
    const anchor = { x: Math.cos(t) * radius, y: Math.sin(t) * radius };
    const tangent = { x: -Math.sin(t), y: Math.cos(t) };
    points.push({
      id: uid('pt'),
      anchor,
      handleIn: { x: anchor.x - tangent.x * k, y: anchor.y - tangent.y * k },
      handleOut: { x: anchor.x + tangent.x * k, y: anchor.y + tangent.y * k },
      handlesParallel: true,
    });
  }
  return { id: uid('piece'), name: 'Circle', points, closed: true };
}

/** The edge of a piece that starts at its first point, as an anchor's edge key. */
function firstEdge(piece: PatternPiece) {
  return {
    pieceId: piece.id,
    fromPointId: piece.points[0]!.id,
    toPointId: piece.points[1 % piece.points.length]!.id,
  };
}


/** The anchors a list of spans measures, in order. */
function anchorsOf(spans: readonly MeasureItem[]): MeasureAnchor[] {
  const out: MeasureAnchor[] = [];
  for (const span of spans) {
    if (span.kind !== 'span') continue;
    out.push(span.a, span.b);
  }
  return out;
}

/** The resolved points a span reads, in order. */
function stopsOf(span: MeasureItem, pieces: readonly PatternPiece[]): Vec2[] {
  if (span.kind !== 'span') return [];
  return [span.a, span.b]
    .map((anchor) => resolveMeasureAnchor(pieces, anchor))
    .filter((p): p is Vec2 => p !== null);
}


/** A U-shaped panel: two arms joined at the bottom, 10 wide each, 30 tall. */
function uShape(): PatternPiece {
  const corners: Array<[number, number]> = [
    [0, 0],
    [30, 0],
    [30, 30],
    [20, 30],
    [20, 10],
    [10, 10],
    [10, 30],
    [0, 30],
  ];
  return {
    id: uid('piece'),
    name: 'U',
    points: corners.map(([x, y]) => ({
      id: uid('pt'),
      anchor: { x, y },
      handleIn: null,
      handleOut: null,
    })),
    closed: true,
  };
}

describe('measureLineSpans', () => {
  it('measures between where a line enters and leaves a piece', () => {
    const piece = rectangle();
    // Straight down the middle: in at the top edge, out at the bottom.
    const spans = measureLineSpans([piece], { x: 10, y: -5 }, { x: 10, y: 15 });
    expect(spans).toHaveLength(1);
    const stops = stopsOf(spans[0]!, [piece]);
    expect(stops[0]!.y).toBeCloseTo(0, 6);
    expect(stops[1]!.y).toBeCloseTo(10, 6);
    for (const anchor of anchorsOf(spans)) {
      expect(anchor.kind).toBe('edge');
      if (anchor.kind !== 'edge') continue;
      expect(anchor.t).toBeCloseTo(0.5, 6);
    }
  });

  it('does not measure the space between two pieces', () => {
    const first = rectangle();
    const second = rectangle();
    // A second panel 30 away, leaving a 10 cm gap between them.
    for (const pt of second.points) pt.anchor.x += 30;

    // Straight across both, along their full width.
    const spans = measureLineSpans([first, second], { x: -5, y: 5 }, { x: 55, y: 5 });
    expect(spans).toHaveLength(2);
    const reading = measureReading([first, second], {
      id: 'm',
      label: { x: 0, y: 0 },
      items: spans,
    });
    // 20 across the first panel plus 20 across the second, and the 10 cm of empty
    // canvas between them is measured by neither.
    expect(reading.totalCm).toBeCloseTo(40, 6);
    expect(reading.live).toBe(2);
  });

  it('sums several pieces crossed by one line', () => {
    const one = rectangle();
    const two = rectangle();
    const three = rectangle();
    for (const pt of two.points) pt.anchor.x += 30;
    for (const pt of three.points) pt.anchor.x += 60;
    const spans = measureLineSpans([one, two, three], { x: -5, y: 5 }, { x: 85, y: 5 });
    expect(spans).toHaveLength(3);
    const reading = measureReading([one, two, three], { id: 'm', label: { x: 0, y: 0 }, items: spans });
    expect(reading.totalCm).toBeCloseTo(60, 6);
  });

  it('reads nothing from a line that starts inside a convex piece', () => {
    const piece = rectangle();
    // The measured stretches run from where the line enters a piece to where it
    // leaves, and this one entered before the drag began: it only ever leaves.
    expect(measureLineSpans([piece], { x: 10, y: 5 }, { x: 10, y: 15 })).toHaveLength(0);
  });

  it('reads the stretch inside a piece the line started in, when it re-enters', () => {
    const piece = uShape();
    // Outside, across both arms: two stretches of 10.
    const outside = measureLineSpans([piece], { x: -5, y: 15 }, { x: 35, y: 15 });
    expect(outside).toHaveLength(2);

    // Starting inside the left arm leaves only the right arm's stretch to read:
    // the crossing at x = 10 is the way *out*, so the first pair is the way back
    // in and the way out again — not the gap between the arms.
    const inside = measureLineSpans([piece], { x: 5, y: 15 }, { x: 35, y: 15 });
    expect(inside).toHaveLength(1);
    const stops = stopsOf(inside[0]!, [piece]);
    expect(stops[0]!.x).toBeCloseTo(20, 6);
    expect(stops[1]!.x).toBeCloseTo(30, 6);
  });

  it('has no spans for a line that misses the work', () => {
    const piece = rectangle();
    expect(measureLineSpans([piece], { x: -50, y: -50 }, { x: -40, y: -30 })).toHaveLength(0);
  });

  it('has no span for a line that only grazes one edge', () => {
    const piece = rectangle();
    // In through the left edge and out of the canvas before reaching another.
    expect(measureLineSpans([piece], { x: -5, y: -5 }, { x: 10, y: 5 })).toHaveLength(0);
  });

  it('reports one measure point where two edges meet at a shared corner', () => {
    const piece = rectangle();
    // Through the bottom-left corner exactly: two edges report the same stop, so
    // the corner is one measure point — a third raw crossing would leave a
    // degenerate span behind.
    const spans = measureLineSpans([piece], { x: -5, y: -5 }, { x: 25, y: 25 });
    expect(spans).toHaveLength(1);
    const stops = stopsOf(spans[0]!, [piece]);
    expect(stops[0]!.x).toBeCloseTo(0, 6);
    expect(stops[0]!.y).toBeCloseTo(0, 6);
    expect(stops[1]!.x).toBeCloseTo(10, 6);
    expect(stops[1]!.y).toBeCloseTo(10, 6);
  });

  it('lands on a curved edge, not on the chords used to find it', () => {
    const piece = circle(10);
    const spans = measureLineSpans([piece], { x: -20, y: 0 }, { x: 20, y: 0 });
    expect(spans).toHaveLength(1);
    for (const anchor of anchorsOf(spans)) {
      const p = resolveMeasureAnchor([piece], anchor)!;
      // The circle's radius is 10, so both stops sit on it.
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 2);
    }
  });
});

describe('proportional measure points', () => {
  it('keeps a measure point at the same place on its edge when the edge moves', () => {
    const piece = rectangle();
    const top = anchorsOf(measureLineSpans([piece], { x: 10, y: -5 }, { x: 10, y: 15 }))[0]!;
    expect(resolveMeasureAnchor([piece], top)!.x).toBeCloseTo(10, 6);

    // Widen the piece: the top edge is now twice as long. The measure point was
    // halfway along it, so it is halfway along the new one.
    piece.points[1]!.anchor.x = 40;
    expect(resolveMeasureAnchor([piece], top)!.x).toBeCloseTo(20, 6);
    expect(resolveMeasureAnchor([piece], top)!.y).toBeCloseTo(0, 6);
  });

  it('follows a bend in the edge it was placed on', () => {
    const piece = rectangle();
    const edge = firstEdge(piece);
    const anchor: MeasureAnchor = { kind: 'edge', ...edge, t: 0.5 };
    expect(resolveMeasureAnchor([piece], anchor)!.x).toBeCloseTo(10, 6);

    // Bend the top edge upwards in the middle by giving its ends handles.
    piece.points[0]!.handleOut = { x: 0, y: -8 };
    piece.points[1]!.handleIn = { x: 20, y: -8 };
    const bent = resolveMeasureAnchor([piece], anchor)!;
    expect(bent.y).toBeLessThan(-1);
    expect(bent.x).toBeCloseTo(10, 3);
    // Halfway along the parametrisation is still the curve's midpoint.
    expect(pointOnEdgeAtT(piece, edge.fromPointId, edge.toPointId, 0.5)!.x).toBeCloseTo(
      bent.x,
      6
    );
  });

  it('reports nothing for an anchor whose edge an edit has split', () => {
    const piece = rectangle();
    const anchor: MeasureAnchor = { kind: 'edge', ...firstEdge(piece), t: 0.5 };
    // Insert a point midway along the top edge, splitting it in two.
    const inserted: BezierPoint = { id: uid('pt'), anchor: { x: 10, y: 0 }, handleIn: null, handleOut: null };
    piece.points.splice(1, 0, inserted);
    expect(resolveMeasureAnchor([piece], anchor)).toBeNull();
  });
});

describe('measureReading', () => {
  const measure = (items: PatternMeasure['items']): PatternMeasure => ({
    id: 'm1',
    label: { x: 0, y: 0 },
    items,
  });

  it('sums edge lengths and spans into one value', () => {
    const piece = rectangle();
    const top = firstEdge(piece);
    const left: MeasureAnchor = { kind: 'point', pieceId: piece.id, pointId: piece.points[0]!.id };
    const right: MeasureAnchor = { kind: 'point', pieceId: piece.id, pointId: piece.points[1]!.id };
    const reading = measureReading([piece], measure([
      { kind: 'edge', ...top },
      { kind: 'span', a: left, b: right },
    ]));
    // The top edge is 20, and so is the gap between its two ends.
    expect(reading.totalCm).toBeCloseTo(40, 6);
    expect(reading.live).toBe(2);
    expect(reading.stale).toBe(0);
  });

  it('counts what a measurement reads, for the label', () => {
    const piece = rectangle();
    const reading = measureReading([piece], measure([{ kind: 'edge', ...firstEdge(piece) }]));
    const label = measureLabelText(reading, 'cm', measure([{ kind: 'edge', ...firstEdge(piece) }]));
    expect(label.primary).toBe('20.0 cm');
    expect(label.secondary).toBe('1 edge');
  });

  it('labels a summed measurement by what it totals', () => {
    const piece = rectangle();
    const summed = { ...measure([{ kind: 'edge', ...firstEdge(piece) }]), sumOf: 3 };
    const label = measureLabelText(measureReading([piece], summed), 'cm', summed);
    expect(label.primary).toBe('20.0 cm');
    expect(label.secondary).toBe('sum of 3');
  });

  it('drops the sum note when it stands for nothing but itself', () => {
    const piece = rectangle();
    const alone = { ...measure([{ kind: 'edge', ...firstEdge(piece) }]), sumOf: 1 };
    expect(measureLabelText(measureReading([piece], alone), 'cm', alone).secondary).toBe('1 edge');
  });

  it('says so when part of the measurement has gone', () => {
    const piece = rectangle();
    const measureWithGhost = measure([
      { kind: 'edge', ...firstEdge(piece) },
      { kind: 'edge', pieceId: 'gone', fromPointId: 'a', toPointId: 'b' },
    ]);
    const reading = measureReading([piece], measureWithGhost);
    expect(reading.stale).toBe(1);
    expect(reading.totalCm).toBeCloseTo(20, 6);
    expect(measureLabelText(reading, 'cm', measureWithGhost).primary).toContain('incomplete');
  });

  it('gives an item its arc midpoint and its length', () => {
    const piece = rectangle();
    const span = measureItemSpan([piece], { kind: 'edge', ...firstEdge(piece) })!;
    expect(span.lengthCm).toBeCloseTo(20, 6);
    expect(span.mid.x).toBeCloseTo(10, 6);
    expect(span.mid.y).toBeCloseTo(0, 6);
  });

  it('names every edge and point it reads, so hovering can light them up', () => {
    const piece = rectangle();
    const refs = measureReferences(
      measure([
        { kind: 'edge', ...firstEdge(piece) },
        {
          kind: 'span',
          a: { kind: 'point', pieceId: piece.id, pointId: piece.points[2]!.id },
          b: { kind: 'edge', ...firstEdge(piece), t: 0.25 },
        },
      ])
    );
    expect(refs.edges).toHaveLength(1);
    expect(refs.points).toHaveLength(1);
    expect(refs.points[0]!.pointId).toBe(piece.points[2]!.id);
  });
});

describe('normalizeMeasures', () => {
  it('keeps well-formed measurements and drops the rest', () => {
    const good: PatternMeasure = {
      id: 'm1',
      label: { x: 1, y: 2 },
      items: [{ kind: 'span', a: { kind: 'point', pieceId: 'p', pointId: 'q' }, b: { kind: 'point', pieceId: 'p', pointId: 'r' } }],
    };
    const out = normalizeMeasures([
      good,
      { id: 'm2' },
      { id: '', label: { x: 0, y: 0 }, items: [] },
      { id: 'm3', label: { x: 0, y: 0 }, items: [{ kind: 'span', a: { kind: 'point' }, b: {} }] },
      'nonsense',
      null,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(good);
  });

  it('keeps a sum note and drops a nonsensical one', () => {
    const base = {
      id: 'm1',
      label: { x: 0, y: 0 },
      items: [
        {
          kind: 'span' as const,
          a: { kind: 'point' as const, pieceId: 'p', pointId: 'q' },
          b: { kind: 'point' as const, pieceId: 'p', pointId: 'r' },
        },
      ],
    };
    expect(normalizeMeasures([{ ...base, sumOf: 3 }])[0]!.sumOf).toBe(3);
    expect(normalizeMeasures([{ ...base, sumOf: 1 }])[0]!.sumOf).toBeUndefined();
    expect(normalizeMeasures([{ ...base, sumOf: 'three' }])[0]!.sumOf).toBeUndefined();
  });

  it('returns nothing for a document with no measurements at all', () => {
    expect(normalizeMeasures(undefined)).toEqual([]);
    expect(normalizeMeasures({})).toEqual([]);
  });
});
