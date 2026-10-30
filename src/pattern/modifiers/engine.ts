import type {
  AttributeValue,
  BezierPoint,
  PatternDocument,
  PatternPiece,
  SeamBinding,
  Vec2,
} from '../../project/types';
import {
  ANCHOR_ATTR,
  carryAttributesThroughSplit,
  edgeAttributes,
  pieceAttributes,
  pieceEdges,
  pieceCentroid,
  pointAttributes,
  pointOrder,
  setEdgeAttribute,
  setPieceAttribute,
  setPointAttribute,
} from '../../project/attributes';
import { edgeLengthByPointIds, pieceRings, ringEdgeCount } from '../geometry';
import {
  insertPointOnEdgePreserving,
  slicePiece,
  type CutterChainPoint,
  type CutterPath,
} from '../slice';
import { sampleNoise } from './noise';
import type {
  AnchorNode,
  AttributeNode,
  CreateNode,
  CutNode,
  DisplaceNode,
  ModifierMask,
  ModifierNode,
  NoiseNode,
  SubdivideNode,
  TransformNode,
} from './types';

/**
 * The cook: run a pattern's modifier stack over its geometry.
 *
 * Nothing here mutates the document. The stack is a pure function of the pieces,
 * the stack and a counter for the ids it makes — the same document cooked twice
 * gives the same geometry *and the same ids*, which is what lets a drape keep its
 * per-piece arrangement across a cook.
 *
 * Nodes run in stack order, and each sees what the one before it made.
 */

export type CookDiagnostic = { nodeId: string; message: string };

export type CookResult = {
  pieces: PatternPiece[];
  seams: SeamBinding[];
  /** Piece id → the ids that replaced it, for downstream arrangement carry-over. */
  pieceSuccessors: Record<string, string[]>;
  diagnostics: CookDiagnostic[];
  /** How many points came out, for the sidebar's readout. */
  pointCount: number;
};

type CookState = {
  pieces: PatternPiece[];
  seams: SeamBinding[];
  successors: Record<string, string[]>;
  diagnostics: CookDiagnostic[];
  /** Deterministic ids: the cook's own namespace, restarted every run. */
  makeId: (prefix: string) => string;
  /** The stack node being cooked, for diagnostics. */
  nodeId: string;
};

/** True when the stack has anything that would change the geometry. */
export function hasEnabledModifiers(pattern: PatternDocument | undefined): boolean {
  return (pattern?.modifiers ?? []).some((node) => node.enabled !== false);
}

/**
 * Cook the stack. A pattern with no enabled modifier comes back as its own pieces
 * (cloned), which is what every consumer wants: one code path, no special case.
 */
export function cookPattern(pattern: PatternDocument): CookResult {
  let serial = 0;
  const state: CookState = {
    pieces: (pattern.pieces ?? []).map(clonePiece),
    seams: (pattern.seams ?? []).map(cloneSeam),
    successors: {},
    diagnostics: [],
    makeId: (prefix) => `${prefix}_cook${(serial += 1).toString(36)}`,
    nodeId: '',
  };

  for (const node of pattern.modifiers ?? []) {
    if (node?.enabled === false) continue;
    state.nodeId = node.id;
    const iterations = clampInt(node.iterations ?? 1, 1, 24);
    for (let i = 0; i < iterations; i++) applyNode(node, state);
  }

  return {
    pieces: state.pieces,
    seams: state.seams,
    pieceSuccessors: { ...(pattern.pieceSuccessors ?? {}), ...state.successors },
    diagnostics: state.diagnostics,
    pointCount: state.pieces.reduce((n, piece) => n + countPoints(piece), 0),
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

function applyNode(node: ModifierNode, state: CookState): void {
  switch (node.type) {
    case 'cut':
      return applyCut(node, state);
    case 'transform':
      return applyTransform(node, state);
    case 'subdivide':
      return applySubdivide(node, state);
    case 'displace':
      return applyDisplace(node, state);
    case 'noise':
      return applyNoise(node, state);
    case 'create':
      return applyCreate(node, state);
    case 'attribute':
      return applyAttribute(node, state);
    case 'anchor':
      return applyAnchor(node, state);
  }
}

// ── Masks ────────────────────────────────────────────────────────────────────

/**
 * What a mask is being asked about.
 *
 * A node that runs over points hands the point it is on; one that runs over edges
 * hands the edge; one that runs over pieces hands neither, and the masks then
 * answer for the piece's best element — "does any of it fall inside?". That is
 * what makes one mask mean the same thing on every node: a window onto the work.
 */
type MaskContext = {
  piece: PatternPiece;
  /** The piece's number in the pattern, counting from 1. */
  pieceIndex: number;
  /** The point being visited, when the node runs over points. */
  point?: BezierPoint;
  /** The edge being visited, when the node runs over edges. */
  edge?: { from: BezierPoint; to: BezierPoint };
};

/**
 * How strongly the masks let an element through: 1 is untouched, 0 is masked out,
 * and anything between is a fade the node attenuates by.
 *
 * Masks multiply, so two masks narrow each other: a half-strength edge on one and
 * a half-strength edge on the other leaves a quarter. No masks is 1 everywhere.
 */
function masksDensity(masks: readonly ModifierMask[] | undefined, ctx: MaskContext): number {
  if (!masks || masks.length === 0) return 1;
  let density = 1;
  for (const mask of masks) {
    const value = maskDensity(mask, ctx);
    if (value <= 0) return 0;
    density *= value;
  }
  return density;
}

function maskDensity(mask: ModifierMask, ctx: MaskContext): number {
  switch (mask.kind) {
    case 'piece':
      return rangeDensity(ctx.pieceIndex + 1, mask.min, mask.max, mask.falloff ?? 0);
    case 'point': {
      const order = ctx.point
        ? pointOrder(ctx.piece, ctx.point.id)
        : ctx.edge
          ? pointOrder(ctx.piece, ctx.edge.from.id)
          : null;
      if (order !== null) return rangeDensity(order, mask.min, mask.max, mask.falloff ?? 0);
      // A whole-piece node: the piece is as strong as its strongest point.
      let best = 0;
      for (const ring of pieceRings(ctx.piece)) {
        for (const pt of ring) {
          const at = pointOrder(ctx.piece, pt.id);
          if (at === null) continue;
          best = Math.max(best, rangeDensity(at, mask.min, mask.max, mask.falloff ?? 0));
          if (best >= 1) return 1;
        }
      }
      return best;
    }
    case 'attribute': {
      const name = (mask.name ?? '').trim();
      if (!name) return 1; // a mask with no attribute yet passes everything
      const value = maskValue(mask.attributeClass, name, ctx);
      if (value !== null) return inRange(value, mask.min, mask.max) ? 1 : 0;
      // No element in hand: the piece runs if any element of that class passes.
      return anyElementPasses(mask, ctx) ? 1 : 0;
    }
  }
}

/**
 * The mask's profile: full strength inside `[min, max]`, then a straight ramp to
 * nothing across `falloff` on either side. A falloff of 0 is a hard edge.
 *
 * Exported so the panel can draw the very curve the cook uses — a picture of a
 * mask that could disagree with the shader of it would be worse than none.
 */
export function rangeDensity(value: number, min: number, max: number, falloff: number): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const fade = Number.isFinite(falloff) ? Math.max(0, falloff) : 0;
  if (value >= low && value <= high) return 1;
  if (fade <= 0) return 0;
  if (value < low) return clamp01((value - (low - fade)) / fade);
  return clamp01((high + fade - value) / fade);
}

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function maskValue(
  attributeClass: 'point' | 'edge' | 'piece',
  name: string,
  ctx: MaskContext
): number | null {
  if (attributeClass === 'piece') return numeric(pieceAttributes(ctx.piece)[name]);
  if (attributeClass === 'edge') {
    if (!ctx.edge) return null;
    return numeric(edgeAttributes(ctx.piece, ctx.edge.from.id, ctx.edge.to.id)[name]);
  }
  if (ctx.point) return numeric(pointAttributes(ctx.piece, ctx.point.id)[name]);
  if (ctx.edge) return numeric(pointAttributes(ctx.piece, ctx.edge.from.id)[name]);
  return null;
}

function anyElementPasses(
  mask: Extract<ModifierMask, { kind: 'attribute' }>,
  ctx: MaskContext
): boolean {
  const name = mask.name.trim();
  if (mask.attributeClass === 'edge') {
    return pieceEdges(ctx.piece).some((edge) => {
      const value = numeric(edgeAttributes(ctx.piece, edge.from.id, edge.to.id)[name]);
      return value !== null && inRange(value, mask.min, mask.max);
    });
  }
  if (mask.attributeClass === 'piece') {
    const value = numeric(pieceAttributes(ctx.piece)[name]);
    return value !== null && inRange(value, mask.min, mask.max);
  }
  return pieceRings(ctx.piece).some((ring) =>
    ring.some((pt) => {
      const value = numeric(pointAttributes(ctx.piece, pt.id)[name]);
      return value !== null && inRange(value, mask.min, mask.max);
    })
  );
}

function numeric(value: AttributeValue | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && typeof value[0] === 'number' && Number.isFinite(value[0])) {
    return value[0];
  }
  return null;
}

/** Inclusive on both ends, and forgiving about the ends being the wrong way round. */
function inRange(value: number, min: number, max: number): boolean {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return value >= low && value <= high;
}

/**
 * Whether a whole-piece node should act on this piece.
 *
 * A panel cannot be half cut, so a whole-piece node takes the piece when its
 * density is over a half — which is what gives a falloff its meaning there: the
 * pieces at the edge of the range drop out as the fade reaches them.
 */
function pieceRuns(node: ModifierNode, ctx: MaskContext): boolean {
  return masksDensity(node.masks, ctx) > 0.5;
}

/** The pieces a node runs on at all: the ones its masks let through, somewhere. */
function piecesFor(node: ModifierNode, state: CookState): PieceAt[] {
  const out: PieceAt[] = [];
  state.pieces.forEach((piece, index) => {
    if (masksDensity(node.masks, { piece, pieceIndex: index }) > 0) {
      out.push({ piece, index });
    }
  });
  return out;
}

type PieceAt = { piece: PatternPiece; index: number };

// ── Cut ──────────────────────────────────────────────────────────────────────

/**
 * Split every matching piece along a line or a chain of cuts.
 *
 * The children keep their parent's attributes through the point-id maps the
 * slicer returns, and the parent's seams follow whichever child still holds both
 * of their ends. A seam whose edge was cut in two is reported: the pieces are no
 * longer sewn where they used to be, and silently forgetting that would move a
 * seam on the cloth without saying so.
 */
function applyCut(node: CutNode, state: CookState): void {
  const cutter = cutterFor(node);
  if (!cutter) {
    diagnostic(state, 'Cut needs a line or at least two points');
    return;
  }
  // A cut is all or nothing on a piece, so the mask is read as a yes/no at its
  // half-strength: pieces inside the range are cut, pieces out in the fade are not.
  const targets = new Map<string, number>();
  for (const target of piecesFor(node, state)) {
    if (pieceRuns(node, { piece: target.piece, pieceIndex: target.index })) {
      targets.set(target.piece.id, target.index);
    }
  }
  if (targets.size === 0) return;
  const next: PatternPiece[] = [];

  for (const piece of state.pieces) {
    if (!targets.has(piece.id)) {
      next.push(piece);
      continue;
    }
    const sliced = slicePiece(piece, cutter, () => state.makeId('pt'));
    if (!sliced.ok) {
      diagnostic(state, `“${piece.name}”: ${sliced.reason}`);
      next.push(piece);
      continue;
    }
    const [a, b] = sliced.pieces;
    carryAttributesThroughSplit(piece, [a, b], sliced.pointIdMaps);
    state.successors[piece.id] = [a.id, b.id];
    const kept = node.keep === 'a' ? [0] : node.keep === 'b' ? [1] : [0, 1];
    remapSeams(state, piece.id, [a, b], sliced.pointIdMaps, kept);
    for (const index of kept) next.push(index === 0 ? a : b);
  }
  state.pieces = next;
}

function cutterFor(node: CutNode): CutterPath | null {
  if (node.mode === 'polyline') {
    const points = (node.points ?? []).filter(
      (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)
    );
    if (points.length < 2) return null;
    const chain: CutterChainPoint[] = points.map((point) => ({
      anchor: { ...point },
      handleIn: null,
      handleOut: null,
    }));
    return { kind: 'path', points: chain };
  }
  if (!node.a || !node.b) return null;
  if (Math.hypot(node.b.x - node.a.x, node.b.y - node.a.y) < 1e-6) return null;
  return { kind: 'line', a: { ...node.a }, b: { ...node.b } };
}

/**
 * Point the parent's seams at the child that still holds both of their ends.
 * Anything that cannot be placed — an edge the cut went through — is dropped and
 * counted, so the stack can say what it did rather than quietly losing a seam.
 */
function remapSeams(
  state: CookState,
  parentId: string,
  children: PatternPiece[],
  pointMaps: Array<Map<string, string>>,
  kept: number[]
): void {
  const survivors: SeamBinding[] = [];
  let lost = 0;
  for (const seam of state.seams) {
    const sides = [seam.a, seam.b] as const;
    const touched = sides.some((side) => side.pieceId === parentId);
    if (!touched) {
      survivors.push(seam);
      continue;
    }
    const rewrite = (side: SeamBinding['a']): SeamBinding['a'] | null => {
      if (side.pieceId !== parentId) return { ...side };
      for (const index of kept) {
        const map = pointMaps[index];
        const from = map.get(side.fromPointId);
        const to = map.get(side.toPointId);
        if (from && to) return { ...side, pieceId: children[index]!.id, fromPointId: from, toPointId: to };
      }
      return null;
    };
    const a = rewrite(seam.a);
    const b = rewrite(seam.b);
    if (a && b) survivors.push({ ...seam, a, b });
    else lost += 1;
  }
  state.seams = survivors;
  if (lost > 0) {
    diagnostic(
      state,
      lost === 1 ? '1 seam no longer spans one edge' : `${lost} seams no longer span one edge`
    );
  }
}

// ── Transform ────────────────────────────────────────────────────────────────

/**
 * Move, turn and scale points about a pivot.
 *
 * A transform writes every point of the pieces it matches, handles included, so
 * curves stay curves rather than being flattened into their anchors.
 */
function applyTransform(node: TransformNode, state: CookState): void {
  const targets = piecesFor(node, state);
  if (targets.length === 0) return;
  const pivot = pivotFor(node, targets.map((target) => target.piece));
  if (!pivot) {
    diagnostic(state, `No point carries an anchor named “${node.anchor}”`);
    return;
  }

  const angle = (Number.isFinite(node.rotateDeg) ? node.rotateDeg : 0) * (Math.PI / 180);
  const sx = Number.isFinite(node.scale?.x) ? node.scale.x : 1;
  const sy = Number.isFinite(node.scale?.y) ? node.scale.y : 1;
  const tx = Number.isFinite(node.translate?.x) ? node.translate.x : 0;
  const ty = Number.isFinite(node.translate?.y) ? node.translate.y : 0;

  /**
   * The transform at one element's density: a half-strength mask moves half as
   * far, turns half as far, and scales half of the way from 1 — so the fade the
   * mask describes is a fade in the result, not a line in the sand.
   */
  const placeAt = (density: number) => (p: Vec2): Vec2 => {
    const turn = angle * density;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const dx = (p.x - pivot.x) * (1 + (sx - 1) * density);
    const dy = (p.y - pivot.y) * (1 + (sy - 1) * density);
    return {
      x: pivot.x + dx * cos - dy * sin + tx * density,
      y: pivot.y + dx * sin + dy * cos + ty * density,
    };
  };

  for (const { piece, index } of targets) {
    for (const ring of pieceRings(piece)) {
      for (const pt of ring) {
        const density = masksDensity(node.masks, { piece, pieceIndex: index, point: pt });
        if (density <= 0) continue;
        movePoint(pt, placeAt(density));
      }
    }
    // A grainline is a mark on the piece, not a point: it turns with the work as
    // far as the piece as a whole does.
    const pieceDensity = masksDensity(node.masks, { piece, pieceIndex: index });
    if (piece.grainline && pieceDensity > 0) {
      const place = placeAt(pieceDensity);
      piece.grainline = {
        from: place(piece.grainline.from),
        to: place(piece.grainline.to),
      };
    }
  }
}

function movePoint(pt: BezierPoint, place: (p: Vec2) => Vec2): void {
  pt.anchor = place(pt.anchor);
  if (pt.handleIn) pt.handleIn = place(pt.handleIn);
  if (pt.handleOut) pt.handleOut = place(pt.handleOut);
}

function pivotFor(node: TransformNode, pieces: PatternPiece[]): Vec2 | null {
  switch (node.pivot) {
    case 'origin':
      return { x: 0, y: 0 };
    case 'world':
      return node.pivotAt ? { ...node.pivotAt } : { x: 0, y: 0 };
    case 'anchor':
      return anchorPoint(pieces, node.anchor ?? '');
    case 'centroid':
    default: {
      let x = 0;
      let y = 0;
      let n = 0;
      for (const piece of pieces) {
        for (const ring of pieceRings(piece)) {
          for (const pt of ring) {
            x += pt.anchor.x;
            y += pt.anchor.y;
            n += 1;
          }
        }
      }
      if (n === 0) return null;
      return { x: x / n, y: y / n };
    }
  }
}

/** The first point tagged with an anchor name, anywhere in the work. */
function anchorPoint(pieces: PatternPiece[], name: string): Vec2 | null {
  if (!name) return null;
  for (const piece of pieces) {
    for (const ring of pieceRings(piece)) {
      for (const pt of ring) {
        const tagged = pointAttributes(piece, pt.id)[ANCHOR_ATTR];
        if (typeof tagged === 'string' && tagged === name) return { ...pt.anchor };
      }
    }
  }
  return null;
}

// ── Subdivide ────────────────────────────────────────────────────────────────

/**
 * Insert points along edges, keeping the curves' shape.
 *
 * The insertion is the drafting "insert a point on this edge" operation, run per
 * edge: each new point splits the edge it lands on into two real edges, so a
 * point's order, the edge UVs and every edge-keyed record stay meaningful.
 */
function applySubdivide(node: SubdivideNode, state: CookState): void {
  const targets = new Map(piecesFor(node, state).map((target) => [target.piece.id, target.index]));
  const every = Math.max(1, Math.round(node.every || 1));
  const maxLength = Number.isFinite(node.maxLengthCm) ? Math.max(0, node.maxLengthCm) : 0;
  const wanted = Math.max(0, Math.round(node.cuts ?? 0));
  if (wanted === 0 && maxLength === 0) return;

  for (const piece of state.pieces) {
    const pieceIndex = targets.get(piece.id);
    if (pieceIndex === undefined) continue;
    const rings = pieceRings(piece);
    rings.forEach((ring, ringIndex) => {
      const closed = piece.closed || ringIndex > 0;
      const count = ringEdgeCount(piece, ringIndex);
      // Backwards: inserting a point shifts everything after it, and nothing
      // before it — so the edges still to be handled keep their indices.
      for (let edgeIndex = count - 1; edgeIndex >= 0; edgeIndex--) {
        if (every > 1 && edgeIndex % every !== 0) continue;
        const from = ring[edgeIndex]!;
        const to = ring[(edgeIndex + 1) % ring.length]!;
        const density = masksDensity(node.masks, { piece, pieceIndex, edge: { from, to } });
        if (density <= 0) continue;
        const length = edgeLengthByPointIds(piece, from.id, to.id);
        let cuts = wanted;
        if (maxLength > 0 && length > maxLength) {
          cuts = Math.max(cuts, Math.ceil(length / maxLength) - 1);
        }
        // Subdivision has no half-step, so the density scales how many of the
        // cuts land: a half-strength edge gets half the points.
        if (density < 1) cuts = Math.round(cuts * density);
        if (cuts <= 0) continue;
        let edge = edgeIndex;
        let from_t = 0;
        for (let k = 1; k <= cuts; k++) {
          const target = k / (cuts + 1);
          const t = (target - from_t) / (1 - from_t);
          const inserted = insertPointOnEdgePreserving(ring, closed, edge, t, () => state.makeId('pt'));
          if (!inserted) break;
          if (node.carryAttributes) {
            const bag = piece.attributes?.point?.[from.id];
            if (bag) {
              if (!piece.attributes) piece.attributes = {};
              if (!piece.attributes.point) piece.attributes.point = {};
              piece.attributes.point[inserted.id] = structuredClone(bag);
            }
          }
          edge += 1;
          from_t = target;
        }
      }
    });
  }
}

// ── Displace ─────────────────────────────────────────────────────────────────

/**
 * Push points off the outline. This is the primitive gathers, puff and pleats are
 * built from: a direction, an amount, and something driving the amount — a
 * constant, an attribute the Noise node wrote, or a noise field read here.
 */
function applyDisplace(node: DisplaceNode, state: CookState): void {
  const targets = new Map(piecesFor(node, state).map((target) => [target.piece.id, target.index]));
  const amount = Number.isFinite(node.amount) ? node.amount : 0;
  const angle = ((Number.isFinite(node.angleDeg) ? node.angleDeg : 0) * Math.PI) / 180;
  const fixed: Vec2 = { x: Math.cos(angle), y: Math.sin(angle) };
  const attribute = (node.amountAttribute ?? '').trim();

  for (const piece of state.pieces) {
    const pieceIndex = targets.get(piece.id);
    if (pieceIndex === undefined) continue;
    const centre = pieceCentroid(piece);
    for (const ring of pieceRings(piece)) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const pt = ring[i]!;
        const density = masksDensity(node.masks, { piece, pieceIndex, point: pt });
        if (density <= 0) continue;
        const prev = ring[(i - 1 + n) % n]!;
        const next = ring[(i + 1) % n]!;
        const direction = directionAt(node, pt, prev, next, ring, centre, fixed);
        let scale = 1;
        if (attribute) {
          const value = pointAttributes(piece, pt.id)[attribute];
          scale *= typeof value === 'number' ? value : 0;
        }
        if (node.useNoise) scale *= sampleNoise(node.noise, pt.anchor.x, pt.anchor.y);
        if (!Number.isFinite(scale) || scale === 0) continue;
        const delta = amount * scale * density;
        pt.anchor = { x: pt.anchor.x + direction.x * delta, y: pt.anchor.y + direction.y * delta };
        if (pt.handleIn) pt.handleIn = { x: pt.handleIn.x + direction.x * delta, y: pt.handleIn.y + direction.y * delta };
        if (pt.handleOut) pt.handleOut = { x: pt.handleOut.x + direction.x * delta, y: pt.handleOut.y + direction.y * delta };
      }
    }
  }
}

/**
 * Which way "off the outline" points at one point: away from the cloth, along the
 * ring's own normal. The normal is squared up to the neighbours and then turned to
 * face outwards using the ring's winding, so a piece drawn either way round puffs
 * out rather than in.
 */
function directionAt(
  node: DisplaceNode,
  pt: BezierPoint,
  prev: BezierPoint,
  next: BezierPoint,
  ring: BezierPoint[],
  centre: Vec2,
  fixed: Vec2
): Vec2 {
  if (node.direction === 'angle') return fixed;
  if (node.direction === 'radial') {
    const dx = pt.anchor.x - centre.x;
    const dy = pt.anchor.y - centre.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  }
  const tx = next.anchor.x - prev.anchor.x;
  const ty = next.anchor.y - prev.anchor.y;
  const length = Math.hypot(tx, ty);
  if (length < 1e-9) return fixed;
  let nx = ty / length;
  let ny = -tx / length;
  const area = signedArea(ring);
  if (area > 0) {
    nx = -nx;
    ny = -ny;
  }
  // Face away from the piece's middle as a backstop for a ring drawn oddly.
  const ox = pt.anchor.x - centre.x;
  const oy = pt.anchor.y - centre.y;
  if (nx * ox + ny * oy < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

function signedArea(ring: BezierPoint[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!.anchor;
    const b = ring[(i + 1) % ring.length]!.anchor;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

// ── Noise ────────────────────────────────────────────────────────────────────

/** Sample the field at every matching point and write it as an attribute. */
function applyNoise(node: NoiseNode, state: CookState): void {
  const targets = new Map(piecesFor(node, state).map((target) => [target.piece.id, target.index]));
  const name = (node.attribute ?? 'noise').trim() || 'noise';
  for (const piece of state.pieces) {
    const pieceIndex = targets.get(piece.id);
    if (pieceIndex === undefined) continue;
    for (const ring of pieceRings(piece)) {
      for (const pt of ring) {
        const density = masksDensity(node.masks, { piece, pieceIndex, point: pt });
        if (density <= 0) continue;
        setPointAttribute(
          piece,
          pt.id,
          name,
          round(sampleNoise(node.noise, pt.anchor.x, pt.anchor.y) * density)
        );
      }
    }
  }
}

// ── Create ───────────────────────────────────────────────────────────────────

/** Make geometry: a line, a rectangle, a circle or a polygon, repeated if asked. */
function applyCreate(node: CreateNode, state: CookState): void {
  const count = Math.max(1, Math.min(64, Math.round(node.count ?? 1)));
  const spacing = Number.isFinite(node.spacing) ? node.spacing : 0;
  for (let i = 0; i < count; i++) {
    const dx = spacing * i;
    const piece = shapeFor(node, dx, state.makeId);
    if (piece) state.pieces.push(piece);
  }
}

function shapeFor(
  node: CreateNode,
  dx: number,
  makeId: (prefix: string) => string
): PatternPiece | null {
  const name = (node.name ?? '').trim() || 'Created';
  const x = (Number.isFinite(node.x) ? node.x : 0) + dx;
  const y = Number.isFinite(node.y) ? node.y : 0;
  const width = Math.abs(Number.isFinite(node.width) ? node.width : 0);
  const height = Math.abs(Number.isFinite(node.height) ? node.height : 0);
  const radius = Math.abs(Number.isFinite(node.radius) ? node.radius : 0);
  const sides = Math.max(3, Math.min(128, Math.round(node.sides ?? 6)));
  const point = (px: number, py: number): BezierPoint => ({
    id: makeId('pt'),
    anchor: { x: px, y: py },
    handleIn: null,
    handleOut: null,
  });

  let points: BezierPoint[];
  let closed = node.closed;
  switch (node.shape) {
    case 'line':
      points = [point(x, y), point(x + width, y + height)];
      closed = false;
      break;
    case 'polygon': {
      points = [];
      for (let i = 0; i < sides; i++) {
        const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
        points.push(point(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius));
      }
      closed = true;
      break;
    }
    case 'circle': {
      // A circle is a polygon with enough sides to read as one.
      const n = Math.max(24, sides);
      points = [];
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2;
        points.push(point(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius));
      }
      closed = true;
      break;
    }
    case 'rect':
    default:
      points = [
        point(x, y),
        point(x + width, y),
        point(x + width, y + height),
        point(x, y + height),
      ];
      closed = true;
      break;
  }
  if (points.length < 2) return null;
  return { id: makeId('piece'), name, closed, points };
}

// ── Attribute ────────────────────────────────────────────────────────────────

/**
 * Write a named attribute onto every element the node runs over.
 *
 * This is the node that makes the attribute system usable on its own: tag a run
 * of points `gather = 1`, give a panel `zone = sleeve`, or clear what an earlier
 * node wrote. Later nodes read what it stores through their groups and their
 * `attribute` parameters, which is how a stack says "these points, not those".
 */
function applyAttribute(node: AttributeNode, state: CookState): void {
  const name = (node.attribute ?? '').trim();
  if (!name) {
    diagnostic(state, 'Attribute needs a name');
    return;
  }
  const domain = node.domain ?? 'point';
  const value = node.remove ? undefined : parseAttributeValue(node.value);
  if (!node.remove && value === undefined) {
    diagnostic(state, `“${node.value}” is not a number or a word`);
    return;
  }
  /**
   * The value as a faded mask leaves it: a number scales with the density, and a
   * word or a flag is written only where the mask is at least half on, because
   * there is no such thing as half a word.
   */
  const scale = (density: number) => {
    if (typeof value === 'number') return value * density;
    return density > 0.5 ? value : undefined;
  };

  for (const { piece, index } of piecesFor(node, state)) {
    if (domain === 'piece') {
      const density = masksDensity(node.masks, { piece, pieceIndex: index });
      if (density <= 0) continue;
      setPieceAttribute(piece, name, scale(density));
      continue;
    }
    if (domain === 'edge') {
      for (const edge of pieceEdges(piece)) {
        const density = masksDensity(node.masks, { piece, pieceIndex: index, edge });
        if (density <= 0) continue;
        setEdgeAttribute(piece, edge.from.id, edge.to.id, name, scale(density));
      }
      continue;
    }
    for (const ring of pieceRings(piece)) {
      for (const pt of ring) {
        const density = masksDensity(node.masks, { piece, pieceIndex: index, point: pt });
        if (density <= 0) continue;
        setPointAttribute(piece, pt.id, name, scale(density) ?? (node.remove ? undefined : value));
      }
    }
  }
}

/** `"0.5"` becomes a number, `"sleeve"` stays a word, `"true"` a flag. */
function parseAttributeValue(raw: string): number | string | boolean | undefined {
  const text = (raw ?? '').trim();
  if (text === '') return undefined;
  if (text === 'true') return true;
  if (text === 'false') return false;
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
}

// ── Anchor ───────────────────────────────────────────────────────────────────

/**
 * Tag a point as a named anchor. A transform can then pivot on it, which is how a
 * rotate node keeps its hinge on a shoulder point instead of the centroid.
 */
function applyAnchor(node: AnchorNode, state: CookState): void {
  const name = (node.anchor ?? '').trim();
  if (!name) {
    diagnostic(state, 'Anchor needs a name');
    return;
  }
  const maxDistance = Math.max(0, Number.isFinite(node.maxDistanceCm) ? node.maxDistanceCm : 0);
  const at = {
    x: Number.isFinite(node.at?.x) ? node.at.x : 0,
    y: Number.isFinite(node.at?.y) ? node.at.y : 0,
  };

  let best: { piece: PatternPiece; point: BezierPoint; distance: number } | null = null;
  for (const { piece, index } of piecesFor(node, state)) {
    for (const ring of pieceRings(piece)) {
      for (const pt of ring) {
        // An anchor is one point: it takes one that the mask lets through at
        // least half, so a fade cannot pick a point that is not really in range.
        if (masksDensity(node.masks, { piece, pieceIndex: index, point: pt }) <= 0.5) continue;
        const distance = Math.hypot(pt.anchor.x - at.x, pt.anchor.y - at.y);
        if (maxDistance > 0 && distance > maxDistance) continue;
        if (!best || distance < best.distance) best = { piece, point: pt, distance };
      }
    }
  }
  if (!best) {
    diagnostic(state, `No point near the anchor “${name}”`);
    return;
  }
  setPointAttribute(best.piece, best.point.id, ANCHOR_ATTR, name);
  if (node.move) {
    const delta = { x: at.x - best.point.anchor.x, y: at.y - best.point.anchor.y };
    best.point.anchor = { ...at };
    if (best.point.handleIn) {
      best.point.handleIn = {
        x: best.point.handleIn.x + delta.x,
        y: best.point.handleIn.y + delta.y,
      };
    }
    if (best.point.handleOut) {
      best.point.handleOut = {
        x: best.point.handleOut.x + delta.x,
        y: best.point.handleOut.y + delta.y,
      };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function diagnostic(state: CookState, message: string): void {
  if (state.diagnostics.some((d) => d.nodeId === state.nodeId && d.message === message)) return;
  state.diagnostics.push({ nodeId: state.nodeId, message });
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function countPoints(piece: PatternPiece): number {
  return pieceRings(piece).reduce((n, ring) => n + ring.length, 0);
}

function clonePoint(pt: BezierPoint): BezierPoint {
  return {
    id: pt.id,
    anchor: { ...pt.anchor },
    handleIn: pt.handleIn ? { ...pt.handleIn } : null,
    handleOut: pt.handleOut ? { ...pt.handleOut } : null,
    handlesParallel: pt.handlesParallel,
  };
}

function cloneRing(ring: BezierPoint[]): BezierPoint[] {
  return ring.map(clonePoint);
}

function clonePiece(piece: PatternPiece): PatternPiece {
  const copy: PatternPiece = {
    id: piece.id,
    name: piece.name,
    closed: piece.closed,
    points: cloneRing(piece.points ?? []),
  };
  if (piece.holes?.length) copy.holes = piece.holes.map(cloneRing);
  if (piece.grainline) copy.grainline = { from: { ...piece.grainline.from }, to: { ...piece.grainline.to } };
  if (piece.seamAllowance) copy.seamAllowance = structuredClone(piece.seamAllowance);
  if (piece.attributes) copy.attributes = structuredClone(piece.attributes);
  return copy;
}

function cloneSeam(seam: SeamBinding): SeamBinding {
  return { id: seam.id, a: { ...seam.a }, b: { ...seam.b }, restGapCm: seam.restGapCm };
}
