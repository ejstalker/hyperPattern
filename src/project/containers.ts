/**
 * Containers — the canvas model.
 *
 * The canvas is a page you can draw on, and a 2D container is a frame that looks
 * at a pattern's centimetre space. The mapping is the whole of it:
 *
 *   canvas units = frame origin + (cm − view origin) × cmScale
 *
 * so a container has no zoom of its own: work is the same size inside the frame
 * as it is on the canvas. Everything here is that one mapping plus what follows
 * from it — fitting a frame around work, and moving work off the canvas into a
 * container.
 */

import type {
  CanvasNode,
  MeasureAnchor,
  MeasureItem,
  PatternDocument,
  PatternFrameNode,
  PatternPiece,
  ProjectDocument,
  SeamBinding,
  Vec2,
} from './types';
import { uid } from './createDefault';
import { boundsOf, pieceToPolyline } from '../pattern/geometry';

/** Canvas units per centimetre for work drawn straight on the canvas. */
export const DEFAULT_CANVAS_CM_SCALE = 6.5;

/** Centimetres of breathing room a fitted container leaves around its work. */
export const CONTAINER_PADDING_CM = 8;

export type ContainerView = {
  cmScale: number;
  viewX: number;
  viewY: number;
};

/** Bounds of the outlines of a run of pieces, in cm — as fit-to-view used them. */
export function piecesBoundsCm(
  pieces: readonly PatternPiece[]
): { min: Vec2; max: Vec2 } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const piece of pieces) {
    if (piece.points.length === 0) continue;
    const poly = pieceToPolyline(piece.points, piece.closed);
    if (poly.length === 0) continue;
    const box = boundsOf(poly);
    minX = Math.min(minX, box.min.x);
    minY = Math.min(minY, box.min.y);
    maxX = Math.max(maxX, box.max.x);
    maxY = Math.max(maxY, box.max.y);
    found = true;
  }
  return found ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
}

/**
 * The view that shows `pieces` inside a frame of `width × height` canvas units
 * the way a pattern node used to show them: padded, then centred and scaled to
 * fit (`xMidYMid meet`). Migration uses this so an existing file keeps looking
 * the way it looked.
 */
export function fitContainerView(
  pieces: readonly PatternPiece[],
  width: number,
  height: number,
  padCm = CONTAINER_PADDING_CM
): ContainerView {
  const bounds = piecesBoundsCm(pieces);
  if (!bounds || width < 1 || height < 1) {
    return { cmScale: DEFAULT_CANVAS_CM_SCALE, viewX: 0, viewY: 0 };
  }
  const boxW = Math.max(bounds.max.x - bounds.min.x + padCm * 2, 20);
  const boxH = Math.max(bounds.max.y - bounds.min.y + padCm * 2, 20);
  const cmScale = Math.min(width / boxW, height / boxH);
  // The fitted box was letterboxed inside the frame, so the frame's own corner
  // sits half the leftover gap further out than the padded bounds do.
  const gapX = (width - boxW * cmScale) / 2 / cmScale;
  const gapY = (height - boxH * cmScale) / 2 / cmScale;
  return {
    cmScale,
    viewX: bounds.min.x - padCm - gapX,
    viewY: bounds.min.y - padCm - gapY,
  };
}

/** A container's view, with the defaults an older or hand-made node implies. */
export function containerView(node: PatternFrameNode): ContainerView {
  return {
    cmScale:
      node.cmScale && node.cmScale > 0 ? node.cmScale : DEFAULT_CANVAS_CM_SCALE,
    viewX: node.viewX ?? 0,
    viewY: node.viewY ?? 0,
  };
}

/** Containers clip by default: a frame that shows everything shows nothing. */
export function containerClips(node: PatternFrameNode): boolean {
  return node.clip !== false;
}

/**
 * The view a frame shows once it has moved by (dx, dy) from where the gesture
 * started, so its work stays exactly where it was on the canvas.
 *
 * This is what makes a frame resized by its top or left edge behave like Figma's:
 * the frame grows outwards and the pieces are left alone. It is written against
 * the gesture's *starting* view rather than nudged, because a resize recomputes
 * its geometry on every pointer move — nudging would slide the work further with
 * each one.
 */
export function containerViewShifted(
  from: ContainerView,
  dx: number,
  dy: number
): ContainerView {
  const scale = from.cmScale > 0 ? from.cmScale : DEFAULT_CANVAS_CM_SCALE;
  return {
    cmScale: from.cmScale,
    viewX: from.viewX + dx / scale,
    viewY: from.viewY + dy / scale,
  };
}

/** The centimetre point under a canvas point inside a container. */
export function containerCmAt(node: PatternFrameNode, x: number, y: number): Vec2 {
  const view = containerView(node);
  return {
    x: (x - node.x) / view.cmScale + view.viewX,
    y: (y - node.y) / view.cmScale + view.viewY,
  };
}

/** The canvas point a centimetre point inside a container lands on. */
export function containerCanvasAt(node: PatternFrameNode, x: number, y: number): Vec2 {
  const view = containerView(node);
  return {
    x: node.x + (x - view.viewX) * view.cmScale,
    y: node.y + (y - view.viewY) * view.cmScale,
  };
}

/** The canvas drafting scale: canvas units per centimetre on the page itself. */
export function canvasCmScale(project: ProjectDocument): number {
  const scale = project.canvas.draftScale;
  return scale && scale > 0 ? scale : DEFAULT_CANVAS_CM_SCALE;
}

/** Canvas point → page centimetres. The page's origin is the canvas origin. */
export function canvasCmAt(project: ProjectDocument, x: number, y: number): Vec2 {
  const scale = canvasCmScale(project);
  return { x: x / scale, y: y / scale };
}

/** Page centimetres → canvas point. */
export function canvasAtCm(project: ProjectDocument, x: number, y: number): Vec2 {
  const scale = canvasCmScale(project);
  return { x: x * scale, y: y * scale };
}

/** The pattern the canvas itself draws — created on demand, never missing. */
export function rootPattern(project: ProjectDocument): PatternDocument {
  const id = project.canvas.rootPatternId;
  const existing = id ? project.patterns.find((p) => p.id === id) : undefined;
  if (existing) return existing;
  const created: PatternDocument = {
    id: uid('pattern'),
    name: 'Canvas',
    pieces: [],
    seams: [],
  };
  project.patterns.push(created);
  project.canvas.rootPatternId = created.id;
  return created;
}

/** Highest z-index in use on the canvas. */
export function topNodeZ(nodes: readonly CanvasNode[]): number {
  return nodes.reduce((max, node) => Math.max(max, node.zIndex), 0);
}

type Ownership = 'moved' | 'stayed' | 'split';

function combine(...states: Ownership[]): Ownership {
  let sawMoved = false;
  let sawStayed = false;
  for (const state of states) {
    if (state === 'split') return 'split';
    if (state === 'moved') sawMoved = true;
    else if (state === 'stayed') sawStayed = true;
  }
  if (sawMoved && sawStayed) return 'split';
  return sawMoved ? 'moved' : 'stayed';
}

/**
 * Move a run of pieces out of `source` and into `target`, translating them by
 * `offset` into the container's own centimetre space.
 *
 * A reference that spans the two sides of the split — a seam whose other half is
 * a piece that stayed on the canvas — cannot mean anything in either container,
 * so it is dropped rather than left dangling at half a seam. Nothing else about
 * a piece changes: the translation is rigid, so work looks exactly where it
 * looked before.
 */
export function movePiecesBetweenPatterns(
  source: PatternDocument,
  target: PatternDocument,
  pieceIds: readonly string[],
  offset: Vec2
): PatternPiece[] {
  const wanted = new Set(pieceIds);
  const moved: PatternPiece[] = [];
  source.pieces = source.pieces.filter((piece) => {
    if (!wanted.has(piece.id)) return true;
    moved.push(piece);
    return false;
  });
  if (moved.length === 0) return moved;

  for (const piece of moved) {
    for (const ring of [piece.points, ...(piece.holes ?? [])]) {
      for (const point of ring) {
        point.anchor = { x: point.anchor.x + offset.x, y: point.anchor.y + offset.y };
        if (point.handleIn) {
          point.handleIn = { x: point.handleIn.x + offset.x, y: point.handleIn.y + offset.y };
        }
        if (point.handleOut) {
          point.handleOut = { x: point.handleOut.x + offset.x, y: point.handleOut.y + offset.y };
        }
      }
    }
  }

  const movedPieceIds = new Set(moved.map((piece) => piece.id));
  const ownership = (pieceId: string): Ownership =>
    movedPieceIds.has(pieceId) ? 'moved' : 'stayed';
  const anchorOwnership = (anchor: MeasureAnchor): Ownership => ownership(anchor.pieceId);
  const itemOwnership = (item: MeasureItem): Ownership =>
    item.kind === 'edge'
      ? ownership(item.pieceId)
      : combine(anchorOwnership(item.a), anchorOwnership(item.b));

  target.pieces.push(...moved);

  const keptSeams: SeamBinding[] = [];
  const carriedSeams: SeamBinding[] = [];
  for (const seam of source.seams) {
    const state = combine(ownership(seam.a.pieceId), ownership(seam.b.pieceId));
    if (state === 'moved') carriedSeams.push(seam);
    else if (state === 'stayed') keptSeams.push(seam);
  }
  source.seams = keptSeams;
  target.seams.push(...carriedSeams);

  if (source.measures?.length) {
    const here: NonNullable<PatternDocument['measures']> = [];
    const there: NonNullable<PatternDocument['measures']> = [];
    for (const measure of source.measures) {
      const state = combine(...measure.items.map(itemOwnership));
      if (state === 'moved') there.push(measure);
      else if (state === 'stayed') here.push(measure);
    }
    source.measures = here;
    if (there.length) target.measures = [...(target.measures ?? []), ...there];
  }

  // Blocks are regenerated as a set, so a block can never be half in a
  // container: callers refuse to group a piece that belongs to one.
  return moved;
}

/** The pattern a space draws: the page's own, or the frame's. */
export function patternForSpace(
  project: ProjectDocument,
  frame: PatternFrameNode | null
): PatternDocument | undefined {
  if (!frame) return rootPattern(project);
  return project.patterns.find((pattern) => pattern.id === frame.patternId);
}

/**
 * The centimetre point a canvas point means in a space: the page's own
 * centimetres for the page, the frame's for a container. Both are affine, so
 * this also answers where a drag's own hand is in the space it is leaving.
 */
export function spaceCmAt(
  project: ProjectDocument,
  frame: PatternFrameNode | null,
  x: number,
  y: number
): Vec2 {
  return frame ? containerCmAt(frame, x, y) : canvasCmAt(project, x, y);
}

export type MovePiecesOutcome =
  | { ok: true; pieces: PatternPiece[]; pieceCount: number }
  | { ok: false; reason: string };

/**
 * Move work between the page and a container, or between two containers.
 *
 * The two spaces are named by their frame node, with `null` for the page itself.
 * The run is translated so that the canvas point the drag let go of (`hand`)
 * means the same place in the space it lands in. When the two draw centimetres
 * at the same scale — the page and every frame made on it — that offset is the
 * same for every point, so the work does not move at all: it simply changes
 * hands. Where the scales differ the work keeps its centimetres and lands at
 * the hand, which changes its size on screen and nothing else.
 */
export function movePiecesBetweenSpaces(
  project: ProjectDocument,
  from: PatternFrameNode | null,
  to: PatternFrameNode | null,
  pieceIds: readonly string[],
  hand: Vec2
): MovePiecesOutcome {
  if ((from?.id ?? null) === (to?.id ?? null)) {
    return { ok: false, reason: 'Those pieces are already there.' };
  }
  const source = patternForSpace(project, from);
  const target = patternForSpace(project, to);
  if (!source || !target) {
    return { ok: false, reason: 'That container has no pattern to move work into.' };
  }
  // Two frames can name the same pattern; that is still one space.
  if (source === target) return { ok: false, reason: 'Those pieces are already there.' };
  const wanted = new Set(pieceIds);
  const chosen = source.pieces.filter((piece) => wanted.has(piece.id));
  if (chosen.length === 0) return { ok: false, reason: 'Those pieces are not here.' };

  // Blocks are regenerated as a set, so a block can never be half in a
  // container: a drag that would split one is refused, as grouping refuses it.
  const blockOwned = (source.blocks ?? []).some((block) =>
    block.pieces.some((entry) => wanted.has(entry.pieceId))
  );
  if (blockOwned) {
    return { ok: false, reason: 'A block has to stay together — move it as a whole.' };
  }

  const here = spaceCmAt(project, from, hand.x, hand.y);
  const there = spaceCmAt(project, to, hand.x, hand.y);
  const pieces = movePiecesBetweenPatterns(
    source,
    target,
    chosen.map((piece) => piece.id),
    { x: there.x - here.x, y: there.y - here.y }
  );
  if (pieces.length === 0) return { ok: false, reason: 'Nothing to move.' };
  return { ok: true, pieces, pieceCount: pieces.length };
}

export type GroupIntoContainerOutcome =
  | { ok: true; node: PatternFrameNode; pattern: PatternDocument; pieceCount: number }
  | { ok: false; reason: string };

/**
 * Put a run of canvas pieces into a new 2D container.
 *
 * The container opens at the canvas drafting scale, so nothing changes size, and
 * the pieces are translated into the frame's own space, so nothing moves either:
 * the frame simply claims the canvas coordinates it was drawn around.
 */
export function groupIntoContainer(
  project: ProjectDocument,
  pieceIds: readonly string[],
  name = 'Container'
): GroupIntoContainerOutcome {
  const canvas = rootPattern(project);
  if (pieceIds.length === 0) {
    return { ok: false, reason: 'Select the work to put in a container first.' };
  }
  const chosen = canvas.pieces.filter((piece) => pieceIds.includes(piece.id));
  if (chosen.length === 0) {
    return { ok: false, reason: 'Those pieces are not on the canvas.' };
  }

  const blockOwned = (canvas.blocks ?? []).find((block) =>
    block.pieces.some((entry) => pieceIds.includes(entry.pieceId))
  );
  if (blockOwned) {
    return { ok: false, reason: 'A block has to stay together — move it as a whole.' };
  }

  const bounds = piecesBoundsCm(chosen);
  if (!bounds) {
    return { ok: false, reason: 'Those pieces have no outline to fit a frame around.' };
  }

  const scale = canvasCmScale(project);
  const pad = CONTAINER_PADDING_CM;
  const pattern: PatternDocument = {
    id: uid('pattern'),
    name,
    pieces: [],
    seams: [],
  };
  project.patterns.push(pattern);

  const node: PatternFrameNode = {
    type: 'patternFrame',
    id: uid('node'),
    patternId: pattern.id,
    x: (bounds.min.x - pad) * scale,
    y: (bounds.min.y - pad) * scale,
    width: (bounds.max.x - bounds.min.x + pad * 2) * scale,
    height: (bounds.max.y - bounds.min.y + pad * 2) * scale,
    zIndex: topNodeZ(project.canvas.nodes) + 1,
    cmScale: scale,
    viewX: 0,
    viewY: 0,
    clip: true,
  };
  project.canvas.nodes.push(node);

  const moved = movePiecesBetweenPatterns(canvas, pattern, pieceIds, {
    x: -(bounds.min.x - pad),
    y: -(bounds.min.y - pad),
  });
  if (moved.length === 0) {
    // Nothing moved: take the empty container back rather than leave a ghost.
    project.canvas.nodes = project.canvas.nodes.filter((n) => n.id !== node.id);
    project.patterns = project.patterns.filter((p) => p.id !== pattern.id);
    return { ok: false, reason: 'Nothing to put in a container.' };
  }
  return { ok: true, node, pattern, pieceCount: moved.length };
}
