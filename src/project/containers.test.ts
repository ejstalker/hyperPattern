import { describe, expect, it } from 'vitest';
import type { PatternDocument, PatternFrameNode, ProjectDocument, Vec2 } from './types';
import { rectPiece } from './createDefault';
import {
  CONTAINER_PADDING_CM,
  DEFAULT_CANVAS_CM_SCALE,
  canvasAtCm,
  canvasCmAt,
  canvasCmScale,
  containerCanvasAt,
  containerCmAt,
  containerView,
  fitContainerView,
  groupIntoContainer,
  movePiecesBetweenPatterns,
  movePiecesBetweenSpaces,
  piecesBoundsCm,
  containerViewShifted,
  rootPattern,
} from './containers';

function emptyPattern(id: string, name = id): PatternDocument {
  return { id, name, pieces: [], seams: [] };
}

function projectWithCanvas(): ProjectDocument {
  const canvas = emptyPattern('pattern_canvas', 'Canvas');
  return {
    version: 3,
    id: 'project_test',
    name: 'Test',
    displayUnit: 'cm',
    canvas: {
      panX: 0,
      panY: 0,
      zoom: 1,
      nodes: [],
      rootPatternId: canvas.id,
      draftScale: DEFAULT_CANVAS_CM_SCALE,
    },
    patterns: [canvas],
    meshes: [],
    transforms: [],
    sims: [],
    assignments: [],
    meshTransformAssignments: [],
    transformSimAssignments: [],
    activeSimId: null,
  };
}

describe('container mapping', () => {
  it('round-trips a point through the frame', () => {
    const node: PatternFrameNode = {
      type: 'patternFrame',
      id: 'node',
      patternId: 'p',
      x: 120,
      y: 60,
      width: 300,
      height: 200,
      zIndex: 1,
      cmScale: 6,
      viewX: 2,
      viewY: -4,
    };
    for (const [x, y] of [
      [120, 60],
      [420, 260],
      [200, 130],
    ]) {
      const cm = containerCmAt(node, x!, y!);
      const back = containerCanvasAt(node, cm.x, cm.y);
      expect(back.x).toBeCloseTo(x!, 10);
      expect(back.y).toBeCloseTo(y!, 10);
    }
  });

  it('defaults an unspecified view to the frame corner at the canvas scale', () => {
    const node: PatternFrameNode = {
      type: 'patternFrame',
      id: 'node',
      patternId: 'p',
      x: 10,
      y: 20,
      width: 100,
      height: 100,
      zIndex: 1,
    };
    expect(containerView(node)).toEqual({
      cmScale: DEFAULT_CANVAS_CM_SCALE,
      viewX: 0,
      viewY: 0,
    });
    expect(containerCmAt(node, 10, 20)).toEqual({ x: 0, y: 0 });
  });

  it('puts page centimetres back where they came from', () => {
    const project = projectWithCanvas();
    const cm = canvasCmAt(project, 325, 130);
    const board = canvasAtCm(project, cm.x, cm.y);
    expect(canvasCmScale(project)).toBe(DEFAULT_CANVAS_CM_SCALE);
    expect(board.x).toBeCloseTo(325, 10);
    expect(board.y).toBeCloseTo(130, 10);
  });
});

describe('fitting a frame', () => {
  it('reproduces the old fit-to-node view', () => {
    const piece = rectPiece('Panel', 40, 50, { x: 5, y: 5 });
    const view = fitContainerView([piece], 360, 440);
    // 40×50 cm with 8 cm of padding is 56×66 cm; letterboxed into 360×440 the
    // shorter axis sets the scale.
    expect(view.cmScale).toBeCloseTo(Math.min(360 / 56, 440 / 66), 10);
    // Content stays centred, so the frame is centred on the padded work.
    const frameCentreCm = {
      x: view.viewX + 360 / view.cmScale / 2,
      y: view.viewY + 440 / view.cmScale / 2,
    };
    expect(frameCentreCm.x).toBeCloseTo(25, 6);
    expect(frameCentreCm.y).toBeCloseTo(30, 6);
  });

  it('falls back to the canvas default for work with no outline', () => {
    expect(fitContainerView([], 300, 300).cmScale).toBe(DEFAULT_CANVAS_CM_SCALE);
    expect(piecesBoundsCm([])).toBeNull();
  });

  it('keeps the frame around the whole run', () => {
    const a = rectPiece('A', 10, 10, { x: 0, y: 0 });
    const b = rectPiece('B', 10, 10, { x: 40, y: 30 });
    const view = fitContainerView([a, b], 500, 500);
    expect(500 / view.cmScale).toBeGreaterThanOrEqual(50 + CONTAINER_PADDING_CM * 2 - 1e-9);
    expect(500 / view.cmScale).toBeGreaterThanOrEqual(40 + CONTAINER_PADDING_CM * 2 - 1e-9);
  });
});

describe('resizing a frame', () => {
  it('moves the frame over the work instead of dragging the work along', () => {
    const node: PatternFrameNode = {
      type: 'patternFrame',
      id: 'node',
      patternId: 'p',
      x: 200,
      y: 160,
      width: 360,
      height: 440,
      zIndex: 1,
      cmScale: 6.5,
      viewX: 0,
      viewY: 0,
      clip: true,
    };
    const cm = { x: 30, y: 20 };
    const before = containerCanvasAt(node, cm.x, cm.y);
    const start = containerView(node);

    // Pull the top-left corner out by 130×65 canvas units: the frame grows...
    const dx = -130;
    const dy = -65;
    node.x += dx;
    node.y += dy;
    node.width -= dx;
    node.height -= dy;
    // ...and the work stays exactly where it was on the canvas.
    const view = containerViewShifted(start, dx, dy);
    node.viewX = view.viewX;
    node.viewY = view.viewY;
    const after = containerCanvasAt(node, cm.x, cm.y);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);

    // The frame's corner now reads the centimetres its old position sat over, so
    // the frame shows more on the side that moved.
    expect(node.viewX).toBeCloseTo(dx / 6.5, 9);
    expect(containerCmAt(node, node.x, node.y)).toEqual({
      x: node.viewX,
      y: node.viewY,
    });
  });

  it('is written against the start of the gesture, so recomputed moves cannot drift', () => {
    const start = { cmScale: 6.5, viewX: 1.5, viewY: -2 };
    const once = containerViewShifted(start, -130, -65);
    // A resize recomputes on every pointer move; the tenth must match the first.
    const tenth = containerViewShifted(start, -130, -65);
    expect(tenth).toEqual(once);
    expect(once.viewX).toBeCloseTo(1.5 - 20, 9);
    expect(once.viewY).toBeCloseTo(-2 - 10, 9);
    // Far edges moving means the frame's corner never moved at all.
    expect(containerViewShifted(start, 0, 0)).toEqual(start);
  });
});

describe('page pattern', () => {
  it('creates the canvas pattern when the document has none', () => {
    const project = projectWithCanvas();
    project.canvas.rootPatternId = undefined;
    const pattern = rootPattern(project);
    expect(project.canvas.rootPatternId).toBe(pattern.id);
    expect(project.patterns).toContain(pattern);
    expect(rootPattern(project)).toBe(pattern);
  });
});

describe('grouping work into a container', () => {
  it('moves selected pieces without moving or resizing them on screen', () => {
    const project = projectWithCanvas();
    const canvas = rootPattern(project);
    const piece = rectPiece('Front', 40, 50, { x: 5, y: 5 });
    canvas.pieces.push(piece);
    const scale = canvasCmScale(project);
    const anchor = { ...piece.points[0]!.anchor };
    const beforeBoard = canvasAtCm(project, anchor.x, anchor.y);

    const outcome = groupIntoContainer(project, [piece.id], 'Front panel');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const node = outcome.node;

    // The frame claims the canvas space the work already occupied.
    expect(node.x).toBeCloseTo((5 - CONTAINER_PADDING_CM) * scale, 9);
    expect(node.y).toBeCloseTo((5 - CONTAINER_PADDING_CM) * scale, 9);
    expect(node.width).toBeCloseTo((40 + CONTAINER_PADDING_CM * 2) * scale, 9);
    expect(node.height).toBeCloseTo((50 + CONTAINER_PADDING_CM * 2) * scale, 9);
    expect(node.cmScale).toBe(scale);
    expect(node.viewX).toBe(0);
    expect(node.clip).toBe(true);

    // The same centimetre point, read through the container, lands on the same
    // canvas pixel it did before the move.
    const moved = outcome.pattern.pieces[0]!;
    const afterBoard = containerCanvasAt(
      node,
      moved.points[0]!.anchor.x,
      moved.points[0]!.anchor.y
    );
    expect(afterBoard.x).toBeCloseTo(beforeBoard.x, 9);
    expect(afterBoard.y).toBeCloseTo(beforeBoard.y, 9);

    expect(canvas.pieces).toHaveLength(0);
    expect(outcome.pattern.pieces).toHaveLength(1);
    expect(project.canvas.nodes).toContain(node);
  });

  it('refuses work that is not on the canvas', () => {
    const project = projectWithCanvas();
    const outcome = groupIntoContainer(project, ['nope']);
    expect(outcome.ok).toBe(false);
    expect(project.canvas.nodes).toHaveLength(0);
    expect(project.patterns).toHaveLength(1);
  });

  it('refuses to split a block', () => {
    const project = projectWithCanvas();
    const canvas = rootPattern(project);
    const piece = rectPiece('Block panel', 20, 20, { x: 0, y: 0 });
    canvas.pieces.push(piece);
    canvas.blocks = [
      {
        id: 'block_1',
        definitionId: 'def',
        personId: null,
        personName: 'Test',
        origin: { x: 0, y: 0 },
        bindings: {},
        pieces: [{ role: 'front', pieceId: piece.id }],
      },
    ];
    const outcome = groupIntoContainer(project, [piece.id]);
    expect(outcome.ok).toBe(false);
    expect(canvas.pieces).toHaveLength(1);
  });

  it('leaves the canvas alone when nothing is selected', () => {
    const project = projectWithCanvas();
    const outcome = groupIntoContainer(project, []);
    expect(outcome.ok).toBe(false);
    expect(project.canvas.nodes).toHaveLength(0);
  });
});

describe('moving pieces between patterns', () => {
  it('translates geometry and drops references that cross the split', () => {
    const source = emptyPattern('source');
    const target = emptyPattern('target');
    const stays = rectPiece('Stays', 10, 10, { x: 0, y: 0 });
    const goes = rectPiece('Goes', 10, 10, { x: 20, y: 0 });
    source.pieces.push(stays, goes);
    const edge = (piece: typeof goes, index: number, id: string) => ({
      id,
      a: {
        pieceId: piece.id,
        fromPointId: piece.points[index]!.id,
        toPointId: piece.points[(index + 1) % 4]!.id,
        t0: 0,
        t1: 1,
      },
      b: {
        pieceId: piece.id,
        fromPointId: piece.points[(index + 1) % 4]!.id,
        toPointId: piece.points[(index + 2) % 4]!.id,
        t0: 0,
        t1: 1,
      },
      restGapCm: 0,
    });
    source.seams.push(edge(goes, 0, 'seam_inside'), {
      ...edge(goes, 1, 'seam_across'),
      a: {
        pieceId: stays.id,
        fromPointId: stays.points[0]!.id,
        toPointId: stays.points[1]!.id,
        t0: 0,
        t1: 1,
      },
    });

    const anchorBefore = { ...goes.points[0]!.anchor };
    const handleBefore = goes.points[0]!.handleOut
      ? { ...goes.points[0]!.handleOut! }
      : null;
    const moved = movePiecesBetweenPatterns(source, target, [goes.id], {
      x: -20,
      y: -1.5,
    });

    expect(moved).toHaveLength(1);
    expect(moved[0]!.points[0]!.anchor.x).toBeCloseTo(anchorBefore.x - 20, 10);
    expect(moved[0]!.points[0]!.anchor.y).toBeCloseTo(anchorBefore.y - 1.5, 10);
    if (handleBefore && moved[0]!.points[0]!.handleOut) {
      expect(moved[0]!.points[0]!.handleOut!.x).toBeCloseTo(handleBefore.x - 20, 10);
    }
    expect(source.pieces.map((p) => p.id)).toEqual([stays.id]);
    expect(target.pieces.map((p) => p.id)).toEqual([goes.id]);
    expect(target.seams.map((s) => s.id)).toEqual(['seam_inside']);
    expect(source.seams).toHaveLength(0);
    // The piece that stayed behind is untouched.
    expect(source.pieces[0]!.points[0]!.anchor).toEqual(stays.points[0]!.anchor);
  });
});

describe('dragging work between the page and a container', () => {
  function projectWithFrame(cmScale = DEFAULT_CANVAS_CM_SCALE) {
    const project = projectWithCanvas();
    const node: PatternFrameNode = {
      type: 'patternFrame',
      id: 'node_frame',
      patternId: 'pattern_frame',
      x: 0,
      y: 0,
      width: 130,
      height: 130,
      zIndex: 1,
      cmScale,
      viewX: 4,
      viewY: 6,
      clip: true,
    };
    project.canvas.nodes.push(node);
    project.patterns.push(emptyPattern('pattern_frame', 'Frame'));
    return { project, node };
  }

  /** Where a piece's outline sits on the canvas, as the canvas would draw it. */
  function outlineOnCanvas(
    project: ProjectDocument,
    frame: PatternFrameNode | null,
    piece: { points: readonly { anchor: Vec2 }[] }
  ): Vec2[] {
    return piece.points.map((pt) => {
      const cm = pt.anchor;
      return frame
        ? containerCanvasAt(frame, cm.x, cm.y)
        : canvasAtCm(project, cm.x, cm.y);
    });
  }

  it('drops a panel into the frame without it moving, at one scale', () => {
    const { project, node } = projectWithFrame();
    const canvas = rootPattern(project);
    const piece = rectPiece('Panel', 20, 30, { x: 0, y: 0 });
    canvas.pieces.push(piece);
    const before = outlineOnCanvas(project, null, piece);

    // Let go at a point inside the panel, ten by twelve centimetres in.
    const hand = canvasAtCm(project, 10, 12);
    const outcome = movePiecesBetweenSpaces(project, null, node, [piece.id], hand);

    expect(outcome.ok).toBe(true);
    expect(canvas.pieces).toHaveLength(0);
    expect(project.patterns.find((p) => p.id === 'pattern_frame')!.pieces).toEqual([piece]);
    expect(outlineOnCanvas(project, node, piece)).toEqual(before);
  });

  it('drags a panel back out of the frame without it moving', () => {
    const { project, node } = projectWithFrame();
    const frame = project.patterns.find((p) => p.id === 'pattern_frame')!;
    const piece = rectPiece('Panel', 20, 30, { x: 3, y: 2 });
    frame.pieces.push(piece);
    const before = outlineOnCanvas(project, node, piece);

    const hand = containerCanvasAt(node, 12, 9);
    const outcome = movePiecesBetweenSpaces(project, node, null, [piece.id], hand);

    expect(outcome.ok).toBe(true);
    expect(frame.pieces).toHaveLength(0);
    expect(rootPattern(project).pieces).toEqual([piece]);
    expect(outlineOnCanvas(project, null, piece)).toEqual(before);
  });

  it('keeps the work its own size in centimetres where the scales differ', () => {
    // A frame migrated from the old pattern node: fitted, so it draws its
    // centimetres at a scale of its own rather than the page's.
    const { project, node } = projectWithFrame(4);
    const canvas = rootPattern(project);
    const piece = rectPiece('Panel', 20, 30, { x: 0, y: 0 });
    canvas.pieces.push(piece);
    const widthBefore = piecesBoundsCm([piece])!;

    const hand = canvasAtCm(project, 10, 12);
    const outcome = movePiecesBetweenSpaces(project, null, node, [piece.id], hand);

    expect(outcome.ok).toBe(true);
    const bounds = piecesBoundsCm([piece])!;
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(widthBefore.max.x - widthBefore.min.x, 10);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(widthBefore.max.y - widthBefore.min.y, 10);
    // The point the drag was holding is still under the hand: a rigid move, so
    // the panel is where it was let go of rather than where it was picked up.
    const handCmHere = canvasCmAt(project, hand.x, hand.y);
    const handCmThere = containerCmAt(node, hand.x, hand.y);
    expect(piece.points[0]!.anchor.x).toBeCloseTo(handCmThere.x - handCmHere.x, 10);
    expect(piece.points[0]!.anchor.y).toBeCloseTo(handCmThere.y - handCmHere.y, 10);
  });

  it('says so rather than splitting a block', () => {
    const { project, node } = projectWithFrame();
    const canvas = rootPattern(project);
    const piece = rectPiece('Block panel', 20, 20, { x: 0, y: 0 });
    canvas.pieces.push(piece);
    canvas.blocks = [
      {
        id: 'block_1',
        definitionId: 'def',
        personId: null,
        personName: 'Test',
        origin: { x: 0, y: 0 },
        bindings: {},
        pieces: [{ role: 'front', pieceId: piece.id }],
      },
    ];

    const outcome = movePiecesBetweenSpaces(project, null, node, [piece.id], { x: 0, y: 0 });

    expect(outcome.ok).toBe(false);
    expect(canvas.pieces).toHaveLength(1);
    expect(project.patterns.find((p) => p.id === 'pattern_frame')!.pieces).toHaveLength(0);
  });

  it('refuses a drop in the space the work is already in', () => {
    const { project, node } = projectWithFrame();
    const canvas = rootPattern(project);
    const piece = rectPiece('Panel', 20, 20, { x: 0, y: 0 });
    canvas.pieces.push(piece);

    expect(movePiecesBetweenSpaces(project, null, null, [piece.id], { x: 0, y: 0 }).ok).toBe(false);
    expect(movePiecesBetweenSpaces(project, node, node, [piece.id], { x: 0, y: 0 }).ok).toBe(false);
    // Two frames on one pattern are still one space.
    const twin = { ...node, id: 'node_twin' };
    expect(movePiecesBetweenSpaces(project, node, twin, [piece.id], { x: 0, y: 0 }).ok).toBe(false);
    expect(canvas.pieces).toHaveLength(1);
  });
});
