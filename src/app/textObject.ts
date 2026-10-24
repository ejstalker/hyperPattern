import type { BezierPoint, PatternPiece, TextAlign, TextAnnotationNode } from '../project/types';
import { uid } from '../project/createDefault';

/**
 * Text on the canvas, and what it takes to turn it into pattern work.
 *
 * A text object is not pattern material: it is drawn by the browser in a font the
 * studio does not own, and its shape lives in that font's outlines rather than in
 * the document. Rasterizing is what crosses that line — the laid-out text is
 * rendered to a mask, the mask is traced into closed contours, and each character
 * becomes a piece whose outline is that contour (holes and all).
 *
 * The tracing half is plain arithmetic over a byte mask, so it is testable
 * without a canvas; only `renderTextMask` needs the browser.
 */

export const TEXT_FONT_FAMILIES = [
  'IBM Plex Sans',
  'IBM Plex Mono',
  'IBM Plex Serif',
  'Georgia',
  'Helvetica',
  'Arial',
] as const;

export const TEXT_WEIGHTS = [
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'SemiBold' },
  { value: 700, label: 'Bold' },
] as const;

export const DEFAULT_TEXT_COLOR = '#f2ebe3';
/** Barely-there graphite: the object reads as text on the page, not as a card. */
export const DEFAULT_TEXT_BACKGROUND = 'transparent';

export type TextStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  lineHeight: number;
  letterSpacing: number;
  align: TextAlign;
  color: string;
  background: string;
  padding: number;
  autoWidth: boolean;
};

export function textStyleOf(node: TextAnnotationNode): TextStyle {
  return {
    fontFamily: node.fontFamily ?? TEXT_FONT_FAMILIES[0],
    fontSize: node.fontSize > 0 ? node.fontSize : 14,
    fontWeight: node.fontWeight ?? 400,
    fontStyle: node.fontStyle ?? 'normal',
    lineHeight: node.lineHeight ?? 1.3,
    letterSpacing: node.letterSpacing ?? 0,
    align: node.align ?? 'left',
    color: node.color ?? DEFAULT_TEXT_COLOR,
    background: node.background ?? DEFAULT_TEXT_BACKGROUND,
    padding: node.padding ?? 8,
    autoWidth: node.autoWidth ?? false,
  };
}

/** The `font` shorthand a canvas context and a CSS div both understand. */
export function cssFont(style: TextStyle): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px "${style.fontFamily}", sans-serif`;
}

/** One line's worth of laid-out text: where it starts and how wide it is. */
type LaidLine = { text: string; x: number; y: number; width: number };

/**
 * Lay the text out line by line, in canvas units, exactly as the node draws it.
 *
 * Canvas has no line-breaking to offer, and the object's own wrapping has to be
 * the one that is traced, so this doubles as the measurement pass: it asks a
 * measuring context for each line (and for each word, when it has to wrap) and
 * returns where every line sits inside the box.
 */
export function layoutTextLines(
  lines: readonly string[],
  style: TextStyle,
  box: { width: number; height: number },
  measure: (text: string) => number
): LaidLine[] {
  const innerWidth = Math.max(0, box.width - style.padding * 2);
  const lineStep = style.fontSize * style.lineHeight;
  const wrapped: string[] = [];
  for (const line of lines) {
    if (style.autoWidth || !(innerWidth > 0) || measure(line) <= innerWidth) {
      wrapped.push(line);
      continue;
    }
    // Greedy wrap on spaces — the same rule the browser applies to the div.
    let current = '';
    for (const word of line.split(/(\s+)/)) {
      if (!word) continue;
      const candidate = current + word;
      if (current && measure(candidate) > innerWidth) {
        wrapped.push(current.trimEnd());
        current = word.trimStart();
      } else {
        current = candidate;
      }
    }
    if (current.trim()) wrapped.push(current.trimEnd());
  }
  return wrapped.map((text, index) => {
    const width = measure(text);
    const slack = Math.max(0, innerWidth - width);
    const x =
      style.align === 'center'
        ? style.padding + slack / 2
        : style.align === 'right'
          ? style.padding + slack
          : style.padding;
    return { text, x, y: style.padding + index * lineStep, width };
  });
}

/** What `renderTextMask` hands back: a coverage mask and the box it covers. */
export type TextMask = {
  /** Alpha per pixel, row-major, `width × height`, at `scale` px per unit. */
  alpha: Uint8ClampedArray;
  width: number;
  height: number;
  /** Pixels per canvas unit the mask was rendered at. */
  scale: number;
};

/**
 * Render the text to a coverage mask, the way the node draws it.
 *
 * Only the browser can do this — the glyph outlines belong to the font, and a
 * canvas is the one way to ask for them without shipping a font parser. White on
 * transparent, so the alpha channel *is* the coverage.
 */
export function renderTextMask(
  node: TextAnnotationNode,
  opts: { scale?: number } = {}
): TextMask | null {
  if (typeof document === 'undefined') return null;
  const style = textStyleOf(node);
  // A generous scale keeps the traced curves from going polygonal at text sizes.
  const scale = Math.max(1, opts.scale ?? 6);
  const lines = node.text.split('\n');
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  probe.font = cssFont(style);
  const measure = (text: string) => probe.measureText(text).width + style.letterSpacing * text.length;

  const width = Math.max(1, node.width);
  const height = Math.max(1, node.height);
  const laid = layoutTextLines(lines, style, { width, height }, measure);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  ctx.font = cssFont(style);
  ctx.letterSpacing = `${style.letterSpacing}px`;
  for (const line of laid) {
    // Justified text is stretched a word at a time, the way the div stretches it.
    if (style.align === 'justify' && line.text.includes(' ')) {
      const target = Math.max(0, width - style.padding * 2);
      ctx.save();
      ctx.textAlign = 'left';
      drawJustified(ctx, line, target, style, measure);
      ctx.restore();
      continue;
    }
    ctx.textAlign = 'left';
    ctx.fillText(line.text, line.x, line.y);
  }
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) alpha[i] = data[p];
  return { alpha, width: canvas.width, height: canvas.height, scale };
}

function drawJustified(
  ctx: CanvasRenderingContext2D,
  line: LaidLine,
  target: number,
  style: TextStyle,
  measure: (text: string) => number
): void {
  const words = line.text.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    ctx.fillText(line.text, line.x, line.y);
    return;
  }
  const wordsWidth = words.reduce((sum, word) => sum + measure(word), 0);
  const gap = Math.max(0, (target - wordsWidth) / (words.length - 1));
  let x = style.padding;
  for (const word of words) {
    ctx.fillText(word, x, line.y);
    x += measure(word) + gap;
  }
}

/** A closed contour traced off the mask, in mask pixels. */
export type Contour = Array<{ x: number; y: number }>;

/**
 * Trace the outline of everything covered by the mask.
 *
 * The crack outline: every filled pixel contributes the sides it does not share
 * with another filled pixel, each drawn so the fill stays on the left. Walking
 * those sides gives one closed ring per boundary — outer rings one way round,
 * holes the other — and each ring is a staircase of single-pixel steps that the
 * simplifier turns into the glyph's corners.
 */
export function traceAlphaMask(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 128
): Contour[] {
  const filled = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return alpha[y * width + x] >= threshold;
  };

  // Side runs, keyed by their starting corner, so rings can be stitched together.
  const outgoing = new Map<string, Array<{ to: string; point: { x: number; y: number } }>>();
  const key = (x: number, y: number) => `${x},${y}`;
  const add = (
    from: [number, number],
    to: [number, number]
  ): void => {
    const fromKey = key(from[0], from[1]);
    const list = outgoing.get(fromKey) ?? [];
    list.push({ to: key(to[0], to[1]), point: { x: to[0], y: to[1] } });
    outgoing.set(fromKey, list);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!filled(x, y)) continue;
      // Fill on the left of each direction of travel.
      if (!filled(x, y - 1)) add([x, y], [x + 1, y]);
      if (!filled(x + 1, y)) add([x + 1, y], [x + 1, y + 1]);
      if (!filled(x, y + 1)) add([x + 1, y + 1], [x, y + 1]);
      if (!filled(x - 1, y)) add([x, y + 1], [x, y]);
    }
  }

  const contours: Contour[] = [];
  const used = new Set<string>();
  for (const [startKey, edges] of outgoing) {
    for (const edge of edges) {
      if (used.has(`${startKey}>${edge.to}`)) continue;
      const [sx, sy] = startKey.split(',').map(Number);
      const ring: Contour = [{ x: sx, y: sy }];
      let from = startKey;
      let current = edge;
      let guard = 0;
      while (guard++ < 4_000_000) {
        used.add(`${from}>${current.to}`);
        ring.push(current.point);
        from = current.to;
        if (from === startKey) break;
        const next = (outgoing.get(from) ?? []).find(
          (candidate) => !used.has(`${from}>${candidate.to}`)
        );
        if (!next) break;
        current = next;
      }
      // Drop the closing duplicate: a ring is the points between repeats.
      ring.pop();
      if (ring.length >= 4) contours.push(ring);
    }
  }
  return contours;
}

/**
 * Chaikin corner cutting: replace every corner of a ring with two points a
 * quarter and three quarters along its edges, twice over.
 *
 * A traced outline is a staircase, and fitting curves to the stairs themselves
 * makes the anchor positions ride the pixel grid — visible as a wobble along
 * what should be a smooth flank. Cutting the corners is the cheapest way to
 * recover the curve the stairs approximate.
 */
export function smoothRing(ring: Contour, passes: number): Contour {
  let current = ring;
  for (let pass = 0; pass < passes; pass++) {
    const next: Contour = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    current = next;
  }
  return current;
}

function signedArea(contour: Contour): number {
  let area = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function pointInRing(point: { x: number; y: number }, ring: Contour): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}


type Pt = { x: number; y: number };

function samePoint(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

/**
 * Group traced rings into characters: an outer ring per character, holes inside.
 *
 * Direction is the tell. The trace keeps the fill on its left, so an outer ring
 * runs one way and a counter runs the other; which is which falls out of the
 * signed area, and a counter belongs to the smallest outer ring that holds it.
 */
export type TracedCharacter = { outer: Contour; holes: Contour[]; area: number };

export function groupContours(contours: Contour[]): TracedCharacter[] {
  const rings = contours
    .filter((contour) => contour.length >= 4)
    .map((contour) => ({ contour, area: signedArea(contour) }))
    // Largest first, so a ring is always tested against the rings that can hold it.
    .sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

  const characters: TracedCharacter[] = [];
  const holes: Array<{ contour: Contour }> = [];
  for (const ring of rings) {
    if (ring.area < 0) {
      // Anticlockwise: a hole until an outer ring claims it.
      holes.push({ contour: ring.contour });
      continue;
    }
    characters.push({ outer: ring.contour, holes: [], area: ring.area });
  }
  for (const hole of holes) {
    const host = characters
      .filter((char) => pointInRing(hole.contour[0], char.outer))
      .sort((a, b) => a.area - b.area)[0];
    if (host) host.holes.push(hole.contour);
  }
  return characters;
}

/**
 * Fit cubic Béziers to a closed traced ring.
 *
 * A traced glyph is a staircase of single pixels: hundreds of corners that no one
 * could edit. Fitting curves to it turns each letter back into a handful of
 * anchors with handles, which is what a pattern piece is made of.
 */
export function fitRingCurve(
  ring: Contour,
  error: number
): Array<{
  anchor: Pt;
  handleIn: Pt | null;
  handleOut: Pt | null;
}> {
  if (ring.length < 3) {
    return ring.map((point) => ({ anchor: point, handleIn: null, handleOut: null }));
  }
  // Closed ring: fit it as an open run that returns to where it started, then let
  // the last anchor fold back into the first one.
  const points = [...ring, ring[0]];
  const segments: Array<[Pt, Pt, Pt, Pt]> = [];
  fitCubic(points, 0, points.length - 1, error, segments);
  // A ring has to come back round: one or two segments would be a loop rather
  // than a shape, which is what a mark only a few pixels across can fit into.
  // Such a mark is split into three runs and fitted again, tighter.
  if (segments.length < 3) {
    segments.length = 0;
    const third = Math.floor(ring.length / 3);
    const cuts = [0, third, third * 2, points.length - 1];
    for (let run = 0; run < 3; run++) {
      fitCubic(points, cuts[run], cuts[run + 1], error / 2, segments);
    }
  }

  // One anchor per fitted segment: its start point carries the outgoing handle,
  // and takes the incoming handle from the segment that arrives at it.
  return segments.map(([p0, c1], index) => {
    const previous = segments[(index - 1 + segments.length) % segments.length];
    return {
      anchor: { x: p0.x, y: p0.y },
      handleIn: samePoint(previous[2], p0) ? null : { x: previous[2].x, y: previous[2].y },
      handleOut: samePoint(c1, p0) ? null : { x: c1.x, y: c1.y },
    };
  });
}

/** Chord-length parameterisation: how far along the run each point sits. */
function chordParameters(points: Pt[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    u.push(u[u.length - 1] + Math.hypot(dx, dy));
  }
  const total = u[u.length - 1] || 1;
  return u.map((value) => value / total);
}

function bezierPoint(t: number, p0: Pt, c1: Pt, c2: Pt, p3: Pt): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  };
}

/**
 * Least-squares fit of one cubic through the first and last points.
 *
 * The end points are anchored by the curve itself (a cubic passes through its
 * outer control points), so only the two middle controls are solved for — a 2×2
 * system per axis. Leaving the controls free rather than pinning them to tangent
 * directions is what lets one segment swallow a whole arc: a cubic with fixed
 * tangents cannot represent curvature the way the glyphs actually have it.
 */
function fitSegment(
  points: Pt[],
  first: number,
  last: number,
  u: number[]
): [Pt, Pt, Pt, Pt] {
  const p0 = points[first];
  const p3 = points[last];
  let m11 = 0;
  let m12 = 0;
  let m22 = 0;
  let r1x = 0;
  let r1y = 0;
  let r2x = 0;
  let r2y = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i];
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;
    const point = points[first + i];
    const rx = point.x - (b0 * p0.x + b3 * p3.x);
    const ry = point.y - (b0 * p0.y + b3 * p3.y);
    m11 += b1 * b1;
    m12 += b1 * b2;
    m22 += b2 * b2;
    r1x += b1 * rx;
    r1y += b1 * ry;
    r2x += b2 * rx;
    r2y += b2 * ry;
  }
  const det = m11 * m22 - m12 * m12;
  if (Math.abs(det) < 1e-9) {
    // Degenerate run (all samples at one end): a straight chord is the honest fit.
    const third = Math.hypot(p3.x - p0.x, p3.y - p0.y) / 3;
    const nx = p3.x - p0.x;
    const ny = p3.y - p0.y;
    const len = Math.hypot(nx, ny) || 1;
    return [
      p0,
      { x: p0.x + (nx / len) * third, y: p0.y + (ny / len) * third },
      { x: p3.x - (nx / len) * third, y: p3.y - (ny / len) * third },
      p3,
    ];
  }
  return [
    p0,
    { x: (r1x * m22 - r2x * m12) / det, y: (r1y * m22 - r2y * m12) / det },
    { x: (m11 * r2x - m12 * r1x) / det, y: (m11 * r2y - m12 * r1y) / det },
    p3,
  ];
}

function maxError(
  points: Pt[],
  first: number,
  last: number,
  u: number[],
  [p0, c1, c2, p3]: [Pt, Pt, Pt, Pt]
): [number, number] {
  let split = Math.floor((last - first + 1) / 2);
  let maxDist = 0;
  for (let i = first + 1; i < last; i++) {
    const onCurve = bezierPoint(u[i - first], p0, c1, c2, p3);
    const dist = Math.hypot(onCurve.x - points[i].x, onCurve.y - points[i].y);
    if (dist >= maxDist) {
      maxDist = dist;
      split = i;
    }
  }
  return [maxDist, split];
}

function reparameterize(
  points: Pt[],
  first: number,
  last: number,
  u: number[],
  bez: [Pt, Pt, Pt, Pt]
): number[] {
  return u.map((value, index) => {
    if (index === 0) return 0;
    if (index === u.length - 1) return 1;
    const point = points[first + index];
    // One Newton step towards the parameter that projects onto the curve.
    const t = value;
    const mt = 1 - t;
    const d = {
      x:
        3 * mt * mt * (bez[1].x - bez[0].x) +
        6 * mt * t * (bez[2].x - bez[1].x) +
        3 * t * t * (bez[3].x - bez[2].x),
      y:
        3 * mt * mt * (bez[1].y - bez[0].y) +
        6 * mt * t * (bez[2].y - bez[1].y) +
        3 * t * t * (bez[3].y - bez[2].y),
    };
    const onCurve = bezierPoint(t, bez[0], bez[1], bez[2], bez[3]);
    const diff = { x: onCurve.x - point.x, y: onCurve.y - point.y };
    const numerator = diff.x * d.x + diff.y * d.y;
    const denominator = d.x * d.x + d.y * d.y;
    if (denominator < 1e-12) return t;
    const next = t - numerator / denominator;
    return Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : t;
  }).map((value, index, all) => (index === 0 ? 0 : index === all.length - 1 ? 1 : value));
}

function fitCubic(
  points: Pt[],
  first: number,
  last: number,
  error: number,
  out: Array<[Pt, Pt, Pt, Pt]>
): void {
  if (last - first === 1) {
    const dist =
      Math.hypot(points[last].x - points[first].x, points[last].y - points[first].y) / 3;
    const nx = (points[last].x - points[first].x) / (dist || 1);
    const ny = (points[last].y - points[first].y) / (dist || 1);
    out.push([
      points[first],
      { x: points[first].x + nx * dist, y: points[first].y + ny * dist },
      { x: points[last].x - nx * dist, y: points[last].y - ny * dist },
      points[last],
    ]);
    return;
  }
  let u = chordParameters(points, first, last);
  let bez = fitSegment(points, first, last, u);
  let [err, split] = maxError(points, first, last, u, bez);
  if (err < error) {
    out.push(bez);
    return;
  }
  // Reparameterise before giving up and splitting: the least-squares fit is only
  // as good as the parameters it was handed, and a few Newton steps usually turn
  // a rejected run into an accepted one.
  for (let step = 0; step < 6; step++) {
    u = reparameterize(points, first, last, u, bez);
    bez = fitSegment(points, first, last, u);
    [err, split] = maxError(points, first, last, u, bez);
    if (err < error) {
      out.push(bez);
      return;
    }
  }
  if (split <= first) split = first + 1;
  if (split >= last) split = last - 1;
  fitCubic(points, first, split, error, out);
  fitCubic(points, split, last, error, out);
}

/** Where a traced point lands in the pattern, in centimetres. */
export type RasterizeFrame = {
  /** The node's top-left corner, in canvas units. */
  x: number;
  y: number;
  /** Canvas units per centimetre — the page's drafting scale. */
  cmScale: number;
};

/**
 * Turn laid-out text into one piece per character.
 *
 * `mask` is in pixels; every point is mapped back through the box the mask
 * covers so the pieces land exactly where the text was drawn. Straight corners
 * rather than curves: the contour is already the glyph's own shape, sampled
 * finely enough at rasterization scale that a corner at every point reads as the
 * letter, and a piece of a few hundred points is still editable.
 */
export function textMaskToPieces(
  mask: TextMask,
  frame: RasterizeFrame,
  opts: { tolerance?: number; name?: string } = {}
): PatternPiece[] {
  // Two passes, because a trace and a font are different kinds of shape. The
  // staircase is smoothed away first — a corner at every pixel is noise, not
  // detail — and the fit then works on the glyph's own shape. The fit's
  // tolerance is a fifth of a canvas unit whatever scale the mask was rendered
  // at: smooth to the eye, and few enough anchors to edit.
  const tolerance = opts.tolerance ?? Math.max(1.2, mask.scale * 0.2);
  const characters = groupContours(
    traceAlphaMask(mask.alpha, mask.width, mask.height).map((ring) => smoothRing(ring, 2))
  );
  // Left to right, the way the text reads: also the order they are named and
  // selected in.
  characters.sort((a, b) => centreOf(a.outer).x - centreOf(b.outer).x);

  return characters.map((char, index) => {
    const name = opts.name ? `${opts.name} ${index + 1}` : `Text ${index + 1}`;
    return {
      id: uid('piece'),
      name,
      closed: true,
      points: ringToPoints(char.outer, mask, frame, tolerance),
      holes: char.holes.length
        ? char.holes.map((hole) => ringToPoints(hole, mask, frame, tolerance))
        : undefined,
    };
  });
}

function centreOf(contour: Contour): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const point of contour) {
    x += point.x;
    y += point.y;
  }
  return { x: x / contour.length, y: y / contour.length };
}

function ringToPoints(
  ring: Contour,
  mask: TextMask,
  frame: RasterizeFrame,
  tolerance: number
): BezierPoint[] {
  let error = tolerance;
  let fitted = fitRingCurve(ring, error);
  // A glyph of very fine hairlines can still fit into a crowd of anchors; widen
  // the tolerance until the piece is something a person can grab.
  for (let pass = 0; pass < 4 && fitted.length > 96; pass++) {
    error *= 2;
    fitted = fitRingCurve(ring, error);
  }
  // Mask pixels → canvas units → centimetres, offset by the node's corner.
  const toPattern = (point: { x: number; y: number }) => ({
    x: (frame.x + point.x / mask.scale) / frame.cmScale,
    y: (frame.y + point.y / mask.scale) / frame.cmScale,
  });
  return fitted.map((entry) => ({
    id: uid('pt'),
    anchor: toPattern(entry.anchor),
    handleIn: entry.handleIn ? toPattern(entry.handleIn) : null,
    handleOut: entry.handleOut ? toPattern(entry.handleOut) : null,
    handlesParallel: false,
  }));
}
