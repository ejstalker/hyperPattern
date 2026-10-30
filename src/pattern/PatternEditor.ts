import type {
  BezierPoint,
  BlockDivisor,
  BlockInstance,
  BlockVariableBinding,
  BlockVariableDecl,
  MeasureAnchor,
  MeasureItem,
  PatternDocument,
  PatternImage,
  PatternMeasure,
  PatternPiece,
  PatternRuler,
  PatternText,
  SeamBinding,
  SeamEdgeRef,
  UnitDisplay,
  Vec2,
} from '../project/types';
import { formatLength, cmToDisplay, displayToCm } from '../project/types';
import {
  PATTERN_TEXT_MIN_CM,
  createPatternText,
  normalizePatternTexts,
  patternTextCss,
} from './patternText';
import { cookPattern } from './modifiers/engine';
import {
  PATTERN_IMAGE_MIN_CM,
  createPatternImage,
  normalizePatternImages,
  patternImageAspect,
  patternImageSize,
} from './patternImage';
import { normalizePieceAttributes } from '../project/attributes';
import { normalizeModifiers } from './modifiers/types';
import type { MeasurementLibrary, MeasurementSet } from '../project/measurements';
import { MEASUREMENT_FIELDS } from '../project/measurements';
import {
  buildMeasurementMenu,
  distanceToSegment,
  filterMeasurementMenu,
  measurementField,
  measurementSearchTokens,
  measurementValueCm,
  nearestMeasurementField,
  normalizeRulers,
  rulerAngle,
  rulerEndpoints,
  rulerGraduations,
  rulerLabel,
  rulerTextFlipped,
  setRulerDrawnLength,
  type RulerHit,
} from './rulers';
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
import {
  buildSeamConnectorPointPairs,
  drawMeshSeamConnectors,
  drawSeamConnectorPairs,
} from '../mesh/meshSeamDraw';
import { recordPieceSuccessors } from '../sim/pieceTransforms';
import { circlePiece, rectPiece, uid } from '../project/createDefault';
import {
  anchorsBounds,
  cloneBezierPoint,
  clonePatternPiece,
  dist,
  edgeHandles,
  edgeIndexForPointIds,
  edgeIsStraight,
  edgeRingForPointIds,
  findNearestEdge,
  findNearestPieceEdge,
  grainlineInside,
  insertDartOnPiece,
  isSeamEdgeValid,
  lerp,
  mirrorClonePatternPiece,
  pieceEdgeAt,
  pieceEdgeNumber,
  piecePointById,
  pieceRings,
  pieceRingForPoint,
  pieceToPolyline,
  pointInPolygon,
  pointInPiece,
  polygonCentroid,
  ringEdgeCount,
  ringToPolyline,
  pointOnEdgeAtT,
  sameSeamBindingPair,
  sameSeamEdgeTopology,
  seamReadsFromSecondHalf,
  seamRefFromHalf,
  axisLockFromDelta,
  sampleEdgeByPointIds,
  sampleEdgeSpanByPointIds,
  segmentLengths,
} from './geometry';
import {
  allowanceForEdge,
  allowanceRingPath,
  allowanceSpanForEdge,
  seamAllowanceOutline,
  seamAllowanceRings,
  setEdgeAllowance,
  setEveryEdgeAllowance,
  setPieceAllowance,
  defaultSeamAllowanceCm,
  edgeHasOwnAllowance,
} from './seamAllowance';
import {
  findSeamNearPoint,
  reverseSeamsAcrossEdge,
  seamCoversEdge,
  type EdgeParamHit,
} from './seamHit';
import {
  cutterCrossings,
  cutterPathThrough,
  findBoundaryHits,
  pieceUnderChain,
  sampleCutterPath,
  slicePiece,
  snapAngleDegrees,
  type BoundaryHit,
  type CutterChainFit,
  type CutterPath,
} from './slice';
import {
  loopCutAt,
  loopCutCutter,
  sampleLoopCutPath,
  type LoopCut,
} from './loopCut';
import { parseSvgToPieces, scalePieces, type SvgImportResult } from './importSvg';
import {
  insetGap,
  insetScaleThrough,
  loopFitsOnCloth,
  MIN_INSET_SCALE,
  ringFromCircle,
  scaleRing,
} from './inset';
import { keepCount, MIN_RUN, selectedPointRuns, simplifyRun, type SimplifyFit } from './simplify';
import { buildGridGroup } from './grid';
import { buildManyToManySeams } from './multiSew';
import { bridgePieces } from './bridge';
import { joinPieces, type JoinFit, type JoinResult } from './join';
import { drivenPointIds } from './blocks/driven';
import {
  createBlockInstance,
  generateBlockPieces,
  generateBlockSeams,
  nextBlockOrigin,
  normalizeBlocks,
  spliceBlockPieces,
} from './blocks/generate';
import { BLOCK_DEFINITIONS, getBlockDefinition } from './blocks/registry';
import { bindingValueCm, clampToDeclared, resolveBlockValues, sourceValueCm } from './blocks/resolve';
import type { BlockDefinition } from './blocks/spec';
import { DEFAULT_SEAM_GAP_CM } from '../mesh/triangulate';
import {
  AVATAR_OVERLAY_VIEWS,
  buildAvatarOverlayPath,
  ensureAvatarOverlaySource,
  type AvatarOverlayView,
} from './avatarPatternOverlay';
import {
  CORNER_HANDLES,
  angleAbout,
  boxesOverlap,
  handleCentre,
  rotatePoint,
  rotateZoneAt,
  snapAngle,
  type ScaleHandle,
} from './selectionHandles';

export type PatternEditorCallbacks = {
  onChange: () => void;
  /** Fired once before a gesture/mutation so the host can snapshot undo history. */
  onBeforeChange?: () => void;
  /**
   * Drafting references — rulers, seam allowance — never change geometry, so they
   * must not invalidate the mesh the way `onChange` does.
   */
  onRulerChange?: () => void;
  /** Body-measurement library (people + values) used to size and label rulers. */
  getMeasurementLibrary?: () => MeasurementLibrary | null;
  /**
   * The picked pieces changed (primary first). The split view mirrors this onto
   * the 3D selection; it is not a document edit.
   */
  onSelectionChange?: (pieceIds: string[]) => void;
  /**
   * The canvas surface is asked to put a run of its own pieces into a container.
   * Only wired up where that makes sense — on the canvas itself.
   */
  onGroupIntoContainer?: (pieceIds: string[]) => void;
  /**
   * A panel marquee finished, in pattern centimetres. On the canvas the hosts
   * read this as "and the frames the rectangle crossed", so one ⌘/Ctrl-drag
   * picks up whole panels and whole containers together.
   */
  onPanelMarquee?: (box: { x: number; y: number; w: number; h: number }) => void;
  /**
   * The rectangle a marquee is drawing right now, in pattern centimetres, and
   * `null` when it finishes.
   *
   * A board reads this to take the frames the rectangle crosses with it: on the
   * canvas the page and the containers in front of it are one surface, so one
   * drag should be able to pick up points *and* the nodes they came in.
   */
  /**
   * The Add tool's Text or Section mode let go of the canvas: place one covering
   * this box, in pattern centimetres. A click rather than a drag reports a box
   * with no size, which means "wherever I clicked, at its own natural size".
   *
   * Only hosts that can own such an object pass this, and the modes are hidden
   * where it is missing — or where `canPlaceObject` says that one of them is not
   * on offer here.
   */
  onAddObject?: (kind: PlacedObjectKind, box: ObjectBoxPlace) => void;
  /**
   * Whether this host can place this kind of object *here*. A canvas that holds
   * both patterns and notes takes both; a pattern opened full screen takes a note
   * over its work but has nowhere to put a section, which groups canvas objects.
   */
  canPlaceObject?: (kind: PlacedObjectKind) => boolean;
  /**
   * The note in hand changed — picked, let go, or started being typed into. The
   * host reads `getSelectedText()` and puts its style bar up when there is one.
   */
  onTextSelectionChange?: () => void;
  /**
   * A press landed on a cooked document. The stack's output is a result, not a
   * document, so the press does nothing — the host says how to get back to the
   * editable copy.
   */
  onLockedPress?: () => void;
  onMarqueeRect?: (
    box: { x: number; y: number; w: number; h: number } | null,
    info: { additive: boolean; panels: boolean }
  ) => void;
  /**
   * A drag of whole pieces finished, at the screen point it let go of.
   *
   * Whether that point means "inside a container" or "outside the frame this
   * editor is showing" is the host's to answer — it is the one holding the
   * frames — and a piece handed over belongs to another pattern from here on.
   */
  onPiecesDropped?: (drop: {
    clientX: number;
    clientY: number;
    pieceIds: string[];
  }) => void;
};

/**
 * How much of a pattern to draw.
 *
 * A pattern drawn a hundred pixels wide is a smudge, and every mark on it — the
 * points, the edge lengths, the measurement chips, all of them a fixed size on
 * screen — would be a smear of chrome over the work rather than a reading of it.
 * So the drawing thins out as it shrinks: `preview` keeps the silhouettes,
 * `frame` keeps nothing but the grid the frame sits on.
 */
export type PatternDetail = 'full' | 'preview' | 'frame';

/**
 * A frame that looks at this pattern's centimetre space — see `containers.ts`.
 *
 * A locked container *is* its view: the box the element occupies is the box the
 * pattern shows, at `cmScale` canvas units per centimetre, so the work is the
 * same size inside a frame as it is on the canvas and nothing zooms it. An
 * unlocked one is a container opened full screen: free pan and zoom, with the
 * frame drawn where it sits so you can work past its edge.
 */
export type PatternEditorContainer = {
  /** Canvas units per centimetre. */
  cmScale: number;
  /** Centimetre point shown at the frame's top-left corner. */
  viewX: number;
  viewY: number;
  /** The frame's own size in cm — where its boundary is drawn when expanded. */
  frameWidthCm: number;
  frameHeightCm: number;
  /** Figma's "clip contents": hide work outside the frame without moving it. */
  clip: boolean;
  /** Freeze the view to the frame. False once the container is opened up. */
  locked: boolean;
  /**
   * Draw this editor's own reference grid. A frame sitting on the canvas does
   * not: the page's grid runs behind it, so the two would disagree by a hair and
   * the frame would look pasted on. The page itself, and a frame opened full
   * screen (no page behind it), draw their own.
   */
  drawsGrid: boolean;
  /**
   * The CSS scale the host puts *on top of* this editor's layout box — the board's
   * zoom, for a frame sitting on the canvas.
   *
   * Every fixed-size thing the editor draws (strokes, labels, handles, hit radii)
   * is worked out from `viewScale`, the layout pixels per centimetre, so a host
   * that scales the whole element would scale all of it too and zooming the canvas
   * would turn outlines into hairlines. Dividing by the host's scale puts the
   * chrome back to the size it has in a full-screen container, which is what the
   * canvas is supposed to feel like. 1 means the element is drawn 1:1.
   */
  chromeScale: number;
  /** How much of the pattern to draw — see `PatternDetail`. */
  detail: PatternDetail;
  /**
   * Who takes the pointer when `detail` is coarser than full.
   *
   * A container sitting on the canvas is a window: at the canvas's lowest zooms a
   * press belongs to the frame, so a drag moves the container rather than grabbing
   * a point that is not on screen. The page and a full-screen container are
   * workspaces, and take the pointer at every zoom.
   */
  coarsePointer: 'editor' | 'frame';
};

const CONTAINER_MODE_FIELDS = [
  'cmScale',
  'viewX',
  'viewY',
  'frameWidthCm',
  'frameHeightCm',
  'clip',
  'locked',
  'drawsGrid',
  'chromeScale',
  'detail',
  'coarsePointer',
] as const satisfies readonly (keyof PatternEditorContainer)[];

/** The fields that change the *drawing*, as opposed to how big its chrome is. */
const CONTAINER_SHAPE_FIELDS = CONTAINER_MODE_FIELDS.filter(
  (field) => field !== 'chromeScale'
);

/** Do two container modes ask for the same drawing? */
function sameContainerMode(
  a: PatternEditorContainer | null,
  b: PatternEditorContainer | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return CONTAINER_MODE_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Same frame, same detail, same clipping — only the host's scale differs. That is
 * the one difference a moving zoom make that can wait for the gesture to settle.
 */
function sameContainerShape(
  a: PatternEditorContainer | null,
  b: PatternEditorContainer | null
): boolean {
  if (!a || !b) return false;
  return CONTAINER_SHAPE_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Figma-aligned vector tools inside a pattern frame.
 *
 * A tool is one thing to pick up, and what it does is its *mode*: Add draws a
 * pen stroke, a rectangle or a circle, Cut cuts along a line, a circle, a chain
 * of clicks, an inset loop, a loop cut, or a dart. The modes live in the ribbon
 * beside the canvas, where the work they change is.
 */
export type PatternTool =
  | 'move'
  | 'add'
  | 'cut'
  | 'modify'
  | 'sew'
  | 'ruler';

/**
 * What the Add tool is drawing: a pen stroke, a rectangle, a circle, or a box for
 * an object the host owns.
 *
 * Text, sections and images are not pattern work — a note and a section are canvas
 * objects the host places, and an image is a reference the host has to load — so
 * the editor only draws the box and asks the host to fill it. Those modes are
 * offered only where a host says it can take one.
 */
export type AddMode = 'pen' | 'rect' | 'circle' | 'text' | 'section' | 'image';

/** What an object box is for: the kinds of object a host can place. */
export type PlacedObjectKind = 'text' | 'section' | 'image';

/** A box dragged out on the canvas: pattern centimetres, `w`/`h` 0 for a click. */
export type ObjectBoxPlace = { x: number; y: number; w: number; h: number };

/** What the Modify tool is doing, and what its ribbon and bar show. */
export type ModifyMode = 'extrude' | 'join' | 'bridge';

/**
 * What a Move drag does: carry the picked points freely, or swing one point about
 * another at a fixed radius.
 *
 * Orbit is the compass gesture a draughtsperson uses to keep a length honest —
 * swinging a dart leg shut without shortening it: pick the point that moves,
 * pick the point it turns about, and the moving point then only travels round
 * that second point, at the distance the two had when they were picked.
 */
export type MoveMode = 'free' | 'orbit';

/**
 * What the Ruler tool is in hand as: a real rule laid over the work, or a
 * measurement read off the pattern. The measuring half is what the tool opens
 * as — it is the one you reach for without looking.
 */
export type RulerMode = 'ruler' | 'measure';

/**
 * A dropdown on the canvas ribbon: the options a tool carries that are not
 * modes — the block library and the SVG import beside Add's shapes, the
 * measurement library beside the ruler's two tools.
 */
type SettingsMenuKey = 'block' | 'svg' | 'measurement';

/**
 * The rail's single-key shortcuts. `r` is the measure *line* rather than the
 * ruler: the ruler's menu holds both, and the measuring tool is the one you
 * reach for without looking.
 */
const TOOL_KEYS: Record<string, PatternTool> = {
  v: 'move',
  a: 'add',
  m: 'modify',
  c: 'cut',
  s: 'sew',
  r: 'ruler',
};

/** Inline icons, in the rail's own 16px line-art style. */
const ICONS = {
  add: `<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M8 2.8 V13.2 M2.8 8 H13.2"/>`,
  // A shape with a corner node and a handle: the outline is being edited.
  modify: `<rect x="3" y="4.5" width="7.6" height="7.6" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.3"/>
           <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" d="M10.6 4.5 L12.6 2.5"/>
           <circle cx="13" cy="2.1" r="1.15" fill="currentColor"/>
           <rect x="1.8" y="3.3" width="2.4" height="2.4" fill="currentColor"/>`,
  // Scissors: material is cut away.
  sew: `<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M3 12.5 L12.5 3"/>
        <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="1.6 1.3" d="M2.8 8.2 L7.8 8.2"/>
        <circle cx="2.6" cy="8.2" r="1" fill="currentColor"/>
        <circle cx="8.2" cy="8.2" r="1" fill="currentColor"/>`,
  scissors: `<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M4.9 11.2 L13.4 3.5 M4.9 4.8 L13.4 12.5"/>
           <circle cx="3.9" cy="12.1" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>
           <circle cx="3.9" cy="3.9" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>`,
} as const;

/** What each cutter is called on the ribbon, and the tip it carries. */
const CUT_TIPS: Record<CutMode, string> = {
  linear: 'Cut · Line — drag across a panel',
  circle: 'Cut · Circle — drag out the radius',
  inset: 'Cut · Inset — hover inside a panel to score a parallel loop',
  curve: 'Cut · Curve — click points, then Done (or Enter) to cut',
  loop: 'Cut · Loop — hover an edge to follow the contours',
  'loop-straight': 'Cut · Loop straight — hover an edge to run straight across',
  dart: 'Cut · Dart — click the outline to cut a dart into it',
};

/**
 * The cut's modes, in the order the settings ribbon shows them.
 */
const CUT_MODES: ReadonlyArray<{ mode: CutMode; label: string }> = [
  { mode: 'linear', label: 'Line' },
  { mode: 'circle', label: 'Circle' },
  { mode: 'inset', label: 'Inset' },
  { mode: 'curve', label: 'Curve' },
  { mode: 'loop', label: 'Loop' },
  { mode: 'loop-straight', label: 'Loop straight' },
  { mode: 'dart', label: 'Dart' },
];

/** One edge onto one edge, or runs of edges onto runs of edges. */
const EDGE_PAIR_MODES: ReadonlyArray<{ mode: JoinMode; label: string; tip: string }> = [
  { mode: 'segment', label: '1:1', tip: 'One edge on each piece' },
  { mode: 'many', label: 'Many : many', tip: 'Runs of whole edges, many to many' },
];

/** The Ruler tool's modes, in the order the ribbon and its menu show them. */
const RULER_MODES: ReadonlyArray<{ mode: RulerMode; label: string; tip: string }> = [
  { mode: 'ruler', label: 'Ruler', tip: 'Ruler · a real rule laid over the work' },
  { mode: 'measure', label: 'Measure line', tip: 'Ruler · Measure line — read the pattern' },
];

/** The Modify tool's modes, in the order the ribbon shows them. */
const MODIFY_MODES: ReadonlyArray<{ mode: ModifyMode; label: string; tip: string }> = [
  { mode: 'extrude', label: 'Extrude', tip: 'Modify · Extrude — drag away from an edge to grow a parallel copy' },
  { mode: 'join', label: 'Join', tip: 'Modify · Join — fuse two pieces along picked edges' },
  { mode: 'bridge', label: 'Bridge', tip: 'Modify · Bridge — fill between picked edges without moving them' },
];

/** The Move tool's modes, in the order the ribbon shows them. */
const MOVE_MODES: ReadonlyArray<{ mode: MoveMode; label: string; tip: string }> = [
  { mode: 'free', label: 'Free', tip: 'Move · Free — carry whatever is picked anywhere' },
  {
    mode: 'orbit',
    label: 'Orbit',
    tip: 'Move · Orbit — pick the point that moves, then the point it turns about; it swings at a fixed radius',
  },
];

/** The tightest orbit: a point cannot be tethered to nothing. */
const MIN_ORBIT_RADIUS_CM = 0.05;

/** What the Add tool is drawing, in the order the ribbon shows the modes. */
const ADD_MODES: ReadonlyArray<{ mode: AddMode; label: string; tip: string }> = [
  { mode: 'pen', label: 'Pen', tip: 'Add · Pen — click points down, close on the first' },
  { mode: 'rect', label: 'Rectangle', tip: 'Add · Rectangle — drag out a rectangular panel' },
  { mode: 'circle', label: 'Circle', tip: 'Add · Circle — drag out a round piece' },
  { mode: 'text', label: 'Text', tip: 'Add · Text — click for a text object, or drag out its box' },
  {
    mode: 'image',
    label: 'Image',
    tip: 'Add · Image — drag out the box for a reference image, or click to place one at its own size',
  },
  {
    mode: 'section',
    label: 'Section',
    tip: 'Add · Section — drag out a group: anything inside it joins it',
  },
];

/**
 * How faint a silhouette is when the canvas is zoomed too far out to draw the work
 * properly. Solid enough to read the shape of a panel, light enough that the grid
 * underneath still shows through it.
 */
const SILHOUETTE_FILL_OPACITY = 0.45;

/** The viewBox width the wheel and the zoom control may not pass, in pattern units. */
const MIN_VIEW_WIDTH = 8;
const MAX_VIEW_WIDTH = 400;

/**
 * The viewBox width the zoom control reads as 100%.
 *
 * The editor's own default framing — not "fit to the pattern", which would move
 * under the readout every time a piece did — so the number only changes when the
 * view does. `Fit to pattern` is the button for framing the work.
 */
const ZOOM_BASE_WIDTH = 80;
const MIN_ZOOM_PERCENT = Math.round((ZOOM_BASE_WIDTH / MAX_VIEW_WIDTH) * 100);
const MAX_ZOOM_PERCENT = Math.round((ZOOM_BASE_WIDTH / MIN_VIEW_WIDTH) * 100);


export type CutMode =
  | 'linear'
  | 'circle'
  | 'curve'
  | 'inset'
  | 'loop'
  | 'loop-straight'
  | 'dart';

/** What the cut bar calls the cut in hand. */
const CUT_BAR_TITLES: Record<CutMode, string> = {
  linear: 'Line cut',
  circle: 'Circle cut',
  curve: 'Curve cut',
  inset: 'Inset cut',
  loop: 'Loop cut',
  'loop-straight': 'Loop cut',
  dart: 'Dart',
};
export type SewMode = 'segment' | 'many';
/** Join picks edge by edge, or a whole run across the outline. */
export type JoinMode = 'segment' | 'many';

/**
 * The edge under the pointer. Carries the direction a click here would sew
 * (read from the half the pointer is on), the same gesture the 3D sew tool uses,
 * so the hover stroke can preview it.
 */
type HoverEdge = { pieceId: string; fromPointId: string; toPointId: string; t0: number; t1: number };

/** A whole edge of a piece, in the piece's winding order. */
type PieceEdge = { pieceId: string; fromPointId: string; toPointId: string };

/**
 * One open "simplify the picked points" session.
 *
 * Simplifying is previewed live — the outline really is rewritten as the slider
 * moves — so everything needed to put it back is kept here: the piece's points as
 * they were, the runs the draftsperson picked, and the pick itself, which has to
 * survive points disappearing under it.
 */
type SimplifySession = {
  pieceId: string;
  /** Runs of picked point ids, in outline order, as they were when it began. */
  runs: string[][];
  /** The piece's outline before the session; every preview is rebuilt from this. */
  originalPoints: BezierPoint[];
  /** The picks on this piece — the runs' own points — so the reduce count reads them. */
  runIds: string[];
  /** Picks elsewhere, kept so a preview does not clear the rest of the selection. */
  otherPickedIds: string[];
  reduce: number;
  fit: SimplifyFit;
};

/** Corner = free/proportional 2-axis; edge = single-axis (n/s → Y, e/w → X). */
type PointSnapshot = {
  pieceId: string;
  pointId: string;
  anchor: Vec2;
  handleIn: Vec2 | null;
  handleOut: Vec2 | null;
};

type DragKind =
  | { type: 'handle'; pieceId: string; pointId: string; which: 'in' | 'out'; mirror: boolean }
  | { type: 'penCurve'; pieceId: string; pointId: string }
  | { type: 'pan'; startClient: Vec2; startView: { x: number; y: number } }
  | {
      type: 'marquee';
      start: Vec2;
      current: Vec2;
      /** Shift: the rectangle adds to the selection instead of replacing it. */
      additive: boolean;
      /** Cmd/Ctrl: the rectangle takes whole panels rather than the points in it. */
      panels: boolean;
      /** The panel under a Cmd/Ctrl press, for one drawn no further than a click. */
      togglePieceId?: string;
    }
  | {
      type: 'drawShape';
      shape: 'rect' | 'circle';
      start: Vec2;
      current: Vec2;
      /** Shift locks rectangle to square; ignored for circle (always circular). */
      lockAspect: boolean;
    }
  | {
      /** The Add tool's Text / Section mode: the box the host is asked to fill. */
      type: 'objectBox';
      kind: PlacedObjectKind;
      start: Vec2;
      current: Vec2;
    }
  | {
      type: 'extrudeEdge';
      pieceId: string;
      /** The edge being duplicated, by endpoint id, in the piece's winding order. */
      fromPointId: string;
      toPointId: string;
      /** Where the drag began; the offset is `current - start`. */
      start: Vec2;
      current: Vec2;
    }
  | { type: 'rulerCreate'; start: Vec2; current: Vec2; snap: boolean }
  /** The note in hand being carried, in pattern centimetres. */
  | { type: 'moveText'; id: string; start: Vec2; origin: Vec2 }
  /** A note's corner being dragged out, in pattern centimetres. */
  | { type: 'resizeText'; id: string; start: Vec2; width: number; height: number }
  /** A reference image being carried, in pattern centimetres. */
  | { type: 'moveImage'; id: string; start: Vec2; origin: Vec2 }
  /** An image's corner being dragged out, in pattern centimetres. */
  | { type: 'resizeImage'; id: string; start: Vec2; width: number; height: number; aspect: number }
  | { type: 'rulerMove'; id: string; start: Vec2; origin: Vec2 }
  | { type: 'rulerTurn'; id: string; which: 'a' | 'b' }
  /** A measure line being drawn across the pattern. */
  | { type: 'measureLine'; start: Vec2; current: Vec2 }
  /** A measurement's readout being carried somewhere else. */
  | { type: 'measureMove'; id: string; start: Vec2; origin: Vec2 }
  | { type: 'blockMove'; id: string; start: Vec2; origin: Vec2 }
  | { type: 'cutLine'; start: Vec2; current: Vec2; shift: boolean }
  | { type: 'cutCircle'; center: Vec2; radius: number; shift: boolean }
  | {
      type: 'moveSelection';
      start: Vec2;
      snapshots: PointSnapshot[];
      /** The pointer has actually moved: a press and release is a pick, not a drag. */
      moved: boolean;
    }
  | {
      type: 'rotateSelection';
      /** Pivot: the centre of the selection box. */
      center: Vec2;
      /** Pointer angle about `center` when the drag began, radians. */
      startAngle: number;
      snapshots: PointSnapshot[];
    }
  | {
      type: 'scaleSelection';
      handle: ScaleHandle;
      /** 'both' = corner (Shift locks aspect); 'x'/'y' = edge handle. */
      axis: 'both' | 'x' | 'y';
      start: Vec2;
      /** Default pivot: the opposite corner / edge of the selection box. */
      fixed: Vec2;
      /** Alt pivot: the centre of the selection box, so scaling is symmetric. */
      center: Vec2;
      /** Grabbed handle's offset from `fixed`. */
      startSize: Vec2;
      /** Grabbed handle's offset from `center`. */
      centerSize: Vec2;
      snapshots: PointSnapshot[];
    }
  | {
      /**
       * Orbit: the picked point swung about a pivot at a fixed radius. Shift pulls
       * the tether in or out instead of swinging it.
       */
      type: 'orbit';
      /** The point it turns about — the second pick, which never moves. */
      center: Vec2;
      /** The radius the tether had when the drag began, for the radial scale. */
      startRadius: number;
      /** The radius in force now: what the drag sets, and what the guide draws. */
      radius: number;
      /** The moving point's angle about the centre when the drag began. */
      baseAngle: number;
      /** How far round it has been carried since. */
      angle: number;
      /** The moving point alone: an orbit is one point's business. */
      snapshots: PointSnapshot[];
      moved: boolean;
    };

type BBox = { minX: number; minY: number; maxX: number; maxY: number };

/** Figma-like soft-snap alignment guide while moving points. */
type SnapGuide =
  | {
      kind: 'axis';
      axis: 'x' | 'y';
      /** Shared x (vertical guide) or y (horizontal guide). */
      at: number;
      /** Extent along the other axis. */
      from: number;
      to: number;
    }
  | {
      kind: 'mid';
      at: Vec2;
      /** Parent points whose midpoint we snapped to (for guide stubs). */
      a: Vec2;
      b: Vec2;
    };

type SnapMidTarget = { at: Vec2; a: Vec2; b: Vec2 };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Samples used to ghost a curved edge while it is being extruded. */
const EXTRUDE_PREVIEW_STEPS = 24;

/**
 * Turn arrow for the rotate zone, inline because CSS has no rotate cursor and
 * the gesture — "grab beside the corner" — is exactly what the pointer has to
 * say. Hotspot at the centre of the arc, where the pivot sits.
 */
const ROTATE_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23f2ebe3' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M12 6.5a6 6 0 1 1-5.2 3'/%3E%3Cpath d='M12 2.6v5.2l-4.4-2.6z' fill='%23f2ebe3' stroke='none'/%3E%3C/svg%3E\") 12 12, grabbing";

/** True for a target that wants keystrokes for itself, not for the canvas. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'SELECT' ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable === true
  );
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

/** A point detached from the document, for snapshots and previews. */
function clonePoint(pt: BezierPoint): BezierPoint {
  return {
    ...pt,
    anchor: { ...pt.anchor },
    handleIn: pt.handleIn ? { ...pt.handleIn } : null,
    handleOut: pt.handleOut ? { ...pt.handleOut } : null,
  };
}

function svgLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cls: string,
  strokeWidth: number
): SVGLineElement {
  const line = svgEl('line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('class', cls);
  line.setAttribute('stroke-width', String(strokeWidth));
  return line;
}

/**
 * Repair a pattern's derived data on the way in.
 *
 * Both of these are caches that a document can carry stale copies of: ruler
 * labels are resolved live, and block outlines are a rendering of the block's
 * variables. Nothing should ever draw before this has run — an older build, a
 * hand-edited archive or a clamped variable would otherwise keep showing a
 * shape the data no longer describes.
 */
function normalizePattern(
  pattern: PatternDocument,
  setFor: (personId: string | null) => MeasurementSet | null | undefined
): void {
  if (pattern.rulers) pattern.rulers = normalizeRulers(pattern.rulers);
  if (pattern.measures) pattern.measures = normalizeMeasures(pattern.measures);
  if (pattern.texts) pattern.texts = normalizePatternTexts(pattern.texts);
  if (pattern.modifiers) pattern.modifiers = normalizeModifiers(pattern.modifiers);
  // Attributes never affect geometry, but a document written elsewhere may hold
  // numbers nobody can read; dropping them keeps every reader's job simple.
  for (const piece of pattern.pieces) normalizePieceAttributes(piece);
  if (pattern.images) pattern.images = normalizePatternImages(pattern.images);
  normalizeBlocks(pattern, getBlockDefinition, setFor);
}

/** Do two anchors name the same point on the same piece? */
function samePoint(a: MeasureAnchor, b: MeasureAnchor): boolean {
  if (a.kind !== b.kind || a.pieceId !== b.pieceId) return false;
  if (a.kind === 'point' && b.kind === 'point') return a.pointId === b.pointId;
  if (a.kind === 'edge' && b.kind === 'edge') {
    return a.fromPointId === b.fromPointId && a.toPointId === b.toPointId && a.t === b.t;
  }
  return false;
}

/**
 * SVG pattern editor with Move / Add tools (Figma-like) and
 * middle-mouse pan + scroll-wheel zoom.
 */
export class PatternEditor {
  private root: HTMLElement;
  private viewport: HTMLElement;
  private toolbar: HTMLElement;
  private snapBtn: HTMLButtonElement;
  private pointBar: HTMLElement;
  /** The tool in hand's own options, top-left of the canvas. */
  private toolSettings: HTMLElement;
  private parallelCheck: HTMLInputElement;
  private cornerCheck: HTMLInputElement;
  private svg: SVGSVGElement;
  /** Separate layer so avatar tris aren't rebuilt on every pattern redraw. */
  private avatarSvg: SVGSVGElement;
  private tipEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Last svg layout size used for chrome scaling (skip redundant redraws). */
  private lastChromeLayout = { w: 0, h: 0 };
  /**
   * Layout px per pattern unit, captured once per redraw.
   *
   * Every stroke width, dash pattern, handle radius and label size goes through
   * `px()`, and each of those used to read the element's `clientWidth`. Reading
   * layout after the DOM has been mutated forces a synchronous style flush, so a
   * redraw that wrote an element and then measured one was doing it hundreds of
   * times: dragging a piece spent most of its time in layout, not drawing.
   */
  private viewScaleCache: number | null = null;
  private pattern: PatternDocument;
  private unit: UnitDisplay;
  private tool: PatternTool = 'move';
  private cutMode: CutMode = 'linear';
  /** Which of Modify's jobs is in hand: extrude, join, or bridge. */
  private modifyMode: ModifyMode = 'extrude';
  /** Free carries the pick anywhere; Orbit swings one point about another. */
  private moveMode: MoveMode = 'free';
  /** Orbit: the point waiting for the point it turns about — the first pick. */
  private orbitPickId: string | null = null;
  /** Orbit: an armed tether, from the point that moves to the point it turns about. */
  private orbit: { movingPointId: string; centerPointId: string; radius: number } | null = null;
  /** Which half of the Ruler tool is in hand. */
  private rulerMode: RulerMode = 'measure';
  /**
   * What the Add tool draws. A rectangle is the shape a panel usually starts
   * as, so that is what picking Add up gives you first.
   */
  private addMode: AddMode = 'rect';
  /**
   * The loop cut's live cut: the pointer is on an edge, and this is what a
   * click would cut. Hover-driven rather than dragged, so it lives outside
   * `drag`.
   */
  private cutLoop: { pieceId: string; edgeIndex: number; t: number; cut: LoopCut } | null =
    null;
  /**
   * Curve cut: the points clicked down so far and where the pointer is now.
   * The cut is the chain through them, carried out to the outline at both ends,
   * so a cut started inside a panel still runs edge to edge.
   */
  private cutChain: Vec2[] = [];
  private cutChainHover: Vec2 | null = null;
  /** Why the last Done was refused, until the chain changes again. */
  private cutChainRefusal: string | null = null;
  /** How the clicks are joined: a curve through them, or straight edges. */
  private cutChainFit: CutterChainFit = 'smooth';
  /**
   * Sew what the cut separates back together along the cut — cutting a piece to
   * keep its cloth, not to separate it. For a cut that leaves two halves that
   * means welding them; for an inset, or a circle dropped inside a panel, it
   * means sewing the piece that was cut out back into the opening it came from.
   * Sticky, because it is a way of working.
   */
  private cutSew = false;
  /**
   * Leave the piece that was cut out behind: the opening is a hole and nothing
   * else. Only an inset or a circle can cut one out, so only they offer it.
   */
  private cutHole = false;
  /**
   * Why the last drag cut was refused, shown in the cut bar until the next one.
   * A drag has no chain to leave a mark on, so the bar is where it says so.
   */
  private cutNotice: string | null = null;
  /**
   * The inset the pointer is asking for: which panel, the loop it would cut, how
   * much of the size it keeps, and how far in it runs at its tightest.
   */
  private cutInset: {
    pieceId: string;
    loop: BezierPoint[];
    scale: number;
    gap: number;
  } | null = null;
  private cutBar: HTMLElement;
  private sewMode: SewMode = 'segment';
  private sewBar: HTMLElement;
  private joinMode: JoinMode = 'segment';
  /** Whether the moving piece is warped onto the other, or moved and scaled to match. */
  private joinFit: JoinFit = 'match';
  /** In Move & scale, how far apart the picked edges may sit and still match, in cm. */
  private joinTolerance = 0.5;
  private joinBar: HTMLElement;
  /** The orbit tether's length, as typed in the Move ribbon. */
  private orbitRadiusInput!: HTMLInputElement;
  /** Edges picked for the piece that moves, and for the piece it fuses onto. */
  private joinMove: SeamEdgeRef[] = [];
  private joinKeep: SeamEdgeRef[] = [];
  /**
   * Which side the next click is for. Edges of two pieces laid along the same
   * boundary sit on top of each other, so a click there cannot say which piece
   * it means; the side being worked on says it.
   */
  private joinPhase: 'move' | 'keep' = 'move';
  /** Live result of the join the picks would make, so it can be drawn and explained. */
  private joinPreview: { piece: PatternPiece | null; reason: string | null; gap: number } = {
    piece: null,
    reason: null,
    gap: 0,
  };
  private bridgeMode: JoinMode = 'segment';
  private bridgeBar: HTMLElement;
  /** Edges picked for the first piece, and for the piece it is bridged to. */
  private bridgeFirst: SeamEdgeRef[] = [];
  private bridgeSecond: SeamEdgeRef[] = [];
  /** Which side the next click is for — same problem as a fuse, same answer. */
  private bridgePhase: 'first' | 'second' = 'first';
  /** Live result of the bridge the picks would make, so it can be drawn and said. */
  private bridgePreview: { piece: PatternPiece | null; reason: string | null } = {
    piece: null,
    reason: null,
  };
  private simplifyBar: HTMLElement;
  /** The open simplify session, if the bottom bar is up. */
  private simplify: SimplifySession | null = null;
  /** Primary selected point (for point bar / single-point UI). */
  private selectedPointId: string | null = null;
  private selectedIds = new Set<string>();
  private selectedPieceId: string | null = null;
  private drag: DragKind | null = null;
  private viewBox = { x: -10, y: -10, w: 80, h: 90 };
  /**
   * The frame this pattern is shown through, when it is shown through one — see
   * `PatternEditorContainer`. Null is a plain pattern window with its own zoom.
   */
  private container: PatternEditorContainer | null = null;
  /** The host scale the drawing was last built with — see `restateContainer`. */
  private drawnChromeScale = 1;
  private cbs: PatternEditorCallbacks;
  /** Last reported piece selection, so `onSelectionChange` only fires on change. */
  private lastSelectionSig = '';
  /** Coalesce one undo checkpoint per gesture / discrete edit. */
  private historyArmed = false;
  /** The open path the pen is drawing, while it has one in hand. */
  private penStrokeId: string | null = null;
  /**
   * Figma "Snap to geometry": soft-align moving points to other anchors.
   * Hold Ctrl during drag to temporarily disable.
   */
  private softSnap = true;
  private snapGuides: SnapGuide[] = [];
  /** Orthographic avatar silhouette under the pattern (15% opacity). */
  private avatarOverlayOn = false;
  private avatarOverlayView: AvatarOverlayView = 'front';
  private avatarOverlayPath = '';
  private avatarOverlayLoading = false;
  private avatarOverlayError: string | null = null;
  /** Pattern-space cm offset applied after projection (hips stay at 0,0 before this). */
  private avatarOffsetX = 0;
  private avatarOffsetY = 0;
  private avatarBar: HTMLElement;
  private avatarToggleBtn: HTMLButtonElement;
  private avatarViewSelect: HTMLSelectElement;
  private avatarOffsetXInput: HTMLInputElement;
  private avatarOffsetYInput: HTMLInputElement;
  /** See avatar through pattern fills (adjustable opacity). */
  private xrayOn = false;
  /** Show dashed links between paired seam edges. */
  private seamConnectorsOn = false;
  /** Show each piece's seam allowance, and pick edges to set their own. */
  private allowanceOn = false;
  /** Edge under the pointer while the allowance is shown. */
  private allowanceHover: { pieceId: string; edgeIndex: number } | null = null;
  /** Edge whose allowance the ribbon is showing. */
  private allowanceEdge: { pieceId: string; edgeIndex: number } | null = null;
  /** Pattern fill opacity while x-ray is on (0–1). */
  private xrayOpacity = 0.35;
  /**
   * The zoom is frozen: the wheel and the zoom control leave it where it is.
   * Panning is untouched — the lock is about the level, not the position.
   */
  private zoomLocked = false;
  /**
   * Hicon projection: the sheet as a line drawing — no fills, white outlines and
   * measurements, the seam allowance shown, and a grid strong enough to read
   * them against. Purely presentational; nothing about it touches the document.
   */
  private hiconOn = false;
  private viewBtn!: HTMLButtonElement;
  private viewMenu!: HTMLElement;
  private zoomMenu!: HTMLElement;
  private zoomInput!: HTMLInputElement;
  private zoomHint!: HTMLElement;
  private zoomLockBtn!: HTMLButtonElement;
  private hiconBtn!: HTMLButtonElement;
  /** The readout last written, so redraw does not rewrite the same numbers. */
  private lastZoomSig = '';
  private viewMenuDocPointerDown: ((e: PointerEvent) => void) | null = null;
  private xrayBtn: HTMLButtonElement;
  private seamLinksBtn: HTMLButtonElement;
  private allowanceBtn: HTMLButtonElement;
  private grainBtn: HTMLButtonElement;
  /**
   * The grainline every piece is drafted with, drawn on the sheet. Off to begin
   * with: a new piece is marked up in the data, but a dashed line down its
   * middle is the first thing a draughtsperson would ask about, so it has to be
   * asked for.
   */
  private grainOn = false;
  private allowanceBar: HTMLElement;
  private allowancePieceInput!: HTMLInputElement;
  private allowanceEdgeInput!: HTMLInputElement;
  private allowanceEdgeLabel!: HTMLElement;
  private allowanceUnitLabel!: HTMLElement;
  private xrayBar: HTMLElement;
  private xrayOpacityInput: HTMLInputElement;
  private contextMenu: HTMLElement;
  /** Piece targeted by the open context menu. */
  private contextPieceId: string | null = null;
  /** Seam targeted by the open context menu (when right-clicking a seam). */
  private contextSeamId: string | null = null;
  /** Where on its edge the seam menu was opened — which seam, and which part of a shared edge. */
  private contextSeamHit: EdgeParamHit | null = null;
  /** First edge locked while sewing (MD segment sewing). */
  private pendingSeam: SeamEdgeRef | null = null;
  /** Ordered edge groups for many-to-many sewing. */
  private multiSewPhase: 'source' | 'target' = 'source';
  private multiSewSource: SeamEdgeRef[] = [];
  private multiSewTarget: SeamEdgeRef[] = [];
  /** Edge under the cursor while the sew tool is active. */
  private hoverEdge: HoverEdge | null = null;
  /** The edge the extrude tool would duplicate, under the pointer. */
  private extrudeHover: PieceEdge | null = null;
  /** Corner whose rotate zone the pointer is in, while a selection has handles. */
  private hoverRotate: ScaleHandle | null = null;
  private svgFileInput!: HTMLInputElement;
  private importDialog: HTMLElement | null = null;
  private pendingSvgImport: SvgImportResult | null = null;
  /** Ruler tool state — rulers are document data on `pattern.rulers`. */
  private selectedRulerId: string | null = null;
  private hoverRulerId: string | null = null;
  /** The note in hand — document data on `pattern.texts`. */
  private selectedTextId: string | null = null;
  /** The note being typed into: its box is a live contenteditable while set. */
  private textEditingId: string | null = null;
  /** When the note in hand was last pressed, for the double-press that types. */
  private lastTextPress = 0;
  /** The image in hand — document data on `pattern.images`. */
  private selectedImageId: string | null = null;
  /**
   * This editor is showing the cook of a modifier stack rather than the document
   * itself: something to look at, not to draw on.
   */
  private readOnly = false;
  private rulerBtn!: HTMLButtonElement;
  private cutBtn!: HTMLButtonElement;
  private settingsMenuOpen: SettingsMenuKey | null = null;
  private settingsMenuDocPointerDown: ((e: PointerEvent) => void) | null = null;

  private rulerSearchInput!: HTMLInputElement;
  private rulerTree!: HTMLElement;
  /**
   * A measurement chosen from the hold-open menu, waiting for the next drag.
   * Lets you lay out several rulers of the same body dimension in a row.
   */
  private rulerArmed: {
    personId: string;
    personName: string;
    fieldId: string;
    lengthCm: number;
  } | null = null;
  private rulerBar!: HTMLElement;
  // ── Measurements ─────────────────────────────────────────────────────────
  //
  // A measurement reads the pattern itself (unlike a ruler, which reads a
  // person). They are document data on `pattern.measures`, and they never touch
  // geometry, so editing one leaves the mesh alone.
  /** The measurement the measure tool is still adding to, if any. */
  private measureDraftId: string | null = null;
  /**
   * The point the measure tool is waiting to pair with the next one. Session
   * state, not document data: a measurement never holds half a span.
   */
  private measureChainTail: MeasureAnchor | null = null;
  /** The measurement whose value the pointer is over, so its work lights up. */
  private measureHoverId: string | null = null;
  /**
   * Measurements gathered with Shift-click, waiting to be totalled. Session
   * state: what makes the Sum button meaningful.
   */
  private measureSelection = new Set<string>();
  private measureBar!: HTMLElement;
  /** Block tool state — instances are document data on `pattern.blocks`. */
  private selectedBlockId: string | null = null;
  /**
   * Which block owns each generated piece. Rebuilt at the top of `redraw()` so
   * `drawPiece` can tint block geometry without a scan per piece.
   */
  private blockOwnership = new Map<string, BlockInstance>();
  /** The variable row under the pointer, and the points its value moves. */
  /**
   * Inspector sections the user has folded shut, by group name.
   *
   * Held here rather than read back off the DOM because the rows are rebuilt
   * whenever a binding changes shape — switching one variable to Measure
   * rewrites the whole panel, and a section that sprang open every time you did
   * that would be worse than no accordion at all.
   */
  private collapsedBlockGroups = new Set<string>();
  private hoverVarId: string | null = null;  private hoverDriven: Set<string> | null = null;
  /** One button and popup per rail menu, and the view each is showing. */
  private blockBar!: HTMLElement;
  private blockPersonSelect!: HTMLSelectElement;
  private blockSourceNote!: HTMLElement;
  private blockVarsHost!: HTMLElement;
  private rulerPersonSelect!: HTMLSelectElement;
  private rulerMeasureSelect!: HTMLSelectElement;
  private rulerScaleBtns: HTMLButtonElement[] = [];
  private rulerReadout!: HTMLElement;

  constructor(
    host: HTMLElement,
    pattern: PatternDocument,
    unit: UnitDisplay,
    cbs: PatternEditorCallbacks
  ) {
    this.root = host;
    this.pattern = pattern;
    this.unit = unit;
    this.cbs = cbs;
    normalizePattern(pattern, (id) => this.measurementSet(id));

    this.root.innerHTML = '';
    this.root.classList.add('pattern-editor');

    this.toolbar = document.createElement('div');
    this.toolbar.className = 'pattern-toolbar';
    this.toolbar.innerHTML = `
      <div class="pattern-toolbar-tools">
        <!-- Every tool button is the same: clicking it takes its tool up, the
             mode it is set to and all, so it does exactly what its key does.
             The modes themselves live on the ribbon beside the canvas. -->
        <button type="button" data-tool="move" data-tip="Move · ⌘/Ctrl-click an edge to drop a point, a panel to pick it" aria-label="Move">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M3.6 1.9 L3.6 12.5 L6.5 9.8 L8.4 14.1 L10.5 13.1 L8.6 8.9 L12.7 8.9 Z"/>
          </svg>
          <span class="pattern-tool-key" aria-hidden="true">V</span>
        </button>
        <button type="button" data-tool="add" aria-label="Add">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            ${ICONS.add}
          </svg>
          <span class="pattern-tool-key" aria-hidden="true">A</span>
        </button>
        <button type="button" data-tool="modify" aria-label="Modify">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            ${ICONS.modify}
          </svg>
          <span class="pattern-tool-key" aria-hidden="true">M</span>
        </button>
        <button type="button" data-tool="cut" data-tip="Cut · line, circle, inset, curve, loop or dart — pick the mode in the canvas ribbon" aria-label="Cut">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            ${ICONS.scissors}
          </svg>
          <span class="pattern-tool-key" aria-hidden="true">C</span>
        </button>
        <button type="button" data-tool="sew" aria-label="Sew">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            ${ICONS.sew}
          </svg>
          <span class="pattern-tool-key" aria-hidden="true">S</span>
        </button>
        <button type="button" data-tool="ruler" aria-label="Ruler">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <g transform="rotate(-45 8 8)">
              <rect x="1.2" y="5.4" width="13.6" height="5.2" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.3"/>
              <path fill="none" stroke="currentColor" stroke-width="1.1" d="M4 5.4v2M6.6 5.4v1.3M9.2 5.4v2M11.8 5.4v1.3"/>
            </g>
          </svg>
          <span class="pattern-tool-key" aria-hidden="true">R</span>
        </button>
      </div>
      <!-- Everything that changes how the work is *seen* rather than what it is:
           one menu in the corner, so the rail stays a row of tools. -->
      <div class="pattern-view-wrap">
        <button type="button" class="pattern-view-btn" data-view-toggle aria-haspopup="menu" aria-expanded="false" aria-label="View settings" title="View settings">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M2.2 4.6h11.6M2.2 8h11.6M2.2 11.4h11.6"/>
            <circle cx="5.4" cy="4.6" r="1.5" fill="var(--bg-elev)" stroke="currentColor" stroke-width="1.3"/>
            <circle cx="10.6" cy="8" r="1.5" fill="var(--bg-elev)" stroke="currentColor" stroke-width="1.3"/>
            <circle cx="6.8" cy="11.4" r="1.5" fill="var(--bg-elev)" stroke="currentColor" stroke-width="1.3"/>
          </svg>
          <svg class="pattern-view-caret" width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M3.6 6.2 8 10.4 12.4 6.2"/>
          </svg>
        </button>
        <div class="pattern-view-menu" hidden role="menu" aria-label="View settings">
          <span class="pattern-view-title">View</span>
          <div class="pattern-zoom-menu" aria-label="Viewport zoom">
            <div class="pattern-view-label"><span>Zoom</span><span class="pattern-view-note" data-zoom-hint></span></div>
            <div class="pattern-zoom-row">
              <button type="button" data-zoom-act="out" title="Zoom out 1%" aria-label="Zoom out 1%">−</button>
              <label class="pattern-zoom-field">
                <input type="number" data-zoom-input min="20" max="1000" step="1" value="100" aria-label="Zoom percent" />
                <span class="pattern-zoom-unit">%</span>
              </label>
              <button type="button" data-zoom-act="in" title="Zoom in 1%" aria-label="Zoom in 1%">+</button>
            </div>
            <button type="button" class="pattern-view-row" data-zoom-act="fit">
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M2.4 6V2.4h3.6M10 2.4h3.6V6M13.6 10v3.6H10M6 13.6H2.4V10"/>
              </svg>
              <span class="pattern-view-name">Fit to pattern</span>
            </button>
            <button type="button" class="pattern-view-row pattern-zoom-lock" data-zoom-act="lock" title="Hold the zoom level where it is — the wheel and the zoom controls stop moving it" aria-label="Lock zoom" aria-pressed="false">
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.3"/>
                <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M5.6 7 V5.2 a2.4 2.4 0 0 1 4.8 0 V7"/>
                <circle cx="8" cy="10.3" r="0.95" fill="currentColor"/>
              </svg>
              <span class="pattern-view-name">Lock zoom</span>
            </button>
          </div>
          <div class="pattern-view-sep" aria-hidden="true"></div>
          <button type="button" class="pattern-view-row" role="menuitemcheckbox" data-opt="hicon" aria-label="Hicon projection" aria-pressed="false">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1" opacity="0.5" d="M2.4 8.6 H13.6 M2.4 11 H13.6 M6.2 2.9 V12.6 M10.2 3.9 V12.6"/>
              <path fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" d="M4.4 12.4 V6.6 L7.6 3.4 L13.2 5.2 V12.4 Z"/>
            </svg>
            <span class="pattern-view-name">Hicon projection</span>
          </button>
          <button type="button" class="pattern-view-row" role="menuitemcheckbox" data-opt="allowance" aria-label="Seam allowance" aria-pressed="false">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" d="M4.6 1.9 H 11.4 L 14.1 8 L 11.4 14.1 H 4.6 L 1.9 8 Z"/>
              <path fill="none" stroke="currentColor" stroke-width="1.05" stroke-dasharray="1.7 1.5" stroke-linejoin="round" d="M6.3 4.2 H 9.8 L 11.7 8 L 9.8 11.8 H 6.3 L 4.3 8 Z"/>
            </svg>
            <span class="pattern-view-name">Seam allowance</span>
          </button>
          <button type="button" class="pattern-view-row" role="menuitemcheckbox" data-opt="grain" aria-label="Grainlines" aria-pressed="false">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5" d="M8 2.8 V 13.2"/>
              <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" d="M6.4 4.4 L8 2.8 L9.6 4.4 M6.4 11.6 L8 13.2 L9.6 11.6"/>
            </svg>
            <span class="pattern-view-name">Grainlines</span>
          </button>
          <button type="button" class="pattern-view-row" role="menuitemcheckbox" data-opt="seam-links" aria-label="Seam links" aria-pressed="false">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="4.5" cy="5" r="1.4" fill="currentColor"/>
              <circle cx="11.5" cy="11" r="1.4" fill="currentColor"/>
              <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5" stroke-linecap="round" d="M5.6 5.8 L10.4 10.2"/>
            </svg>
            <span class="pattern-view-name">Seam links</span>
          </button>
          <button type="button" class="pattern-view-row" role="menuitemcheckbox" data-opt="xray" aria-label="X-ray" aria-pressed="false">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.5 8c1.8-3.2 4-4.8 5.5-4.8S11.7 4.8 13.5 8c-1.8 3.2-4 4.8-5.5 4.8S4.3 11.2 2.5 8z"/>
              <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
              <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.2 1" d="M3 11.5 L13 4.5"/>
            </svg>
            <span class="pattern-view-name">X-ray</span>
          </button>
          <button type="button" class="pattern-view-row" role="menuitemcheckbox" data-opt="avatar" aria-label="Avatar reference" aria-pressed="false">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="4.2" r="2.2" fill="currentColor"/>
              <path fill="currentColor" d="M3.2 13.5c.4-2.8 2.2-4.2 4.8-4.2s4.4 1.4 4.8 4.2H3.2z"/>
            </svg>
            <span class="pattern-view-name">Avatar reference</span>
          </button>
          <button type="button" class="pattern-view-row active" role="menuitemcheckbox" data-opt="snap" aria-label="Snap" aria-pressed="true">
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="currentColor" d="M3 2h4v1.5H4.5V6H3V2zm6 0h4v4h-1.5V3.5H9V2zM3 10h1.5v2.5H7V14H3v-4zm8.5 0H14v4h-4v-1.5h2.5V10z"/>
              <circle cx="8" cy="8" r="1.6" fill="currentColor"/>
            </svg>
            <span class="pattern-view-name">Snap</span>
          </button>
        </div>
      </div>
    `;
    this.root.appendChild(this.toolbar);
    this.svgFileInput = document.createElement('input');
    this.svgFileInput.type = 'file';
    this.svgFileInput.accept = '.svg,image/svg+xml';
    this.svgFileInput.hidden = true;
    this.svgFileInput.addEventListener('change', () => {
      const file = this.svgFileInput.files?.[0];
      this.svgFileInput.value = '';
      if (file) void this.beginSvgImport(file);
    });
    this.root.appendChild(this.svgFileInput);
    this.bindToolbarTips();
    this.snapBtn = this.toolbar.querySelector('button[data-opt="snap"]') as HTMLButtonElement;
    this.seamLinksBtn = this.toolbar.querySelector('button[data-opt="seam-links"]') as HTMLButtonElement;
    this.allowanceBtn = this.toolbar.querySelector(
      'button[data-opt="allowance"]'
    ) as HTMLButtonElement;
    this.grainBtn = this.toolbar.querySelector('button[data-opt="grain"]') as HTMLButtonElement;
    this.viewBtn = this.toolbar.querySelector('[data-view-toggle]') as HTMLButtonElement;
    this.viewMenu = this.toolbar.querySelector('.pattern-view-menu') as HTMLElement;
    this.zoomMenu = this.toolbar.querySelector('.pattern-zoom-menu') as HTMLElement;
    this.zoomInput = this.toolbar.querySelector('input[data-zoom-input]') as HTMLInputElement;
    this.zoomHint = this.toolbar.querySelector('[data-zoom-hint]') as HTMLElement;
    this.zoomLockBtn = this.toolbar.querySelector(
      '.pattern-zoom-lock'
    ) as HTMLButtonElement;
    this.hiconBtn = this.toolbar.querySelector('button[data-opt="hicon"]') as HTMLButtonElement;
    this.zoomInput.min = String(MIN_ZOOM_PERCENT);
    this.zoomInput.max = String(MAX_ZOOM_PERCENT);
    this.bindViewMenu();
    this.bindZoomMenu();
    this.xrayBtn = this.toolbar.querySelector('button[data-opt="xray"]') as HTMLButtonElement;
    this.avatarToggleBtn = this.toolbar.querySelector('button[data-opt="avatar"]') as HTMLButtonElement;
    this.rulerBtn = this.toolbar.querySelector('button[data-tool="ruler"]') as HTMLButtonElement;
    this.cutBtn = this.toolbar.querySelector('button[data-tool="cut"]') as HTMLButtonElement;
    this.toolbar.addEventListener('click', (e) => {
      const hiconBtn = (e.target as HTMLElement).closest(
        'button[data-opt="hicon"]'
      ) as HTMLButtonElement | null;
      if (hiconBtn) {
        this.setHiconEnabled(!this.hiconOn);
        return;
      }
      const allowanceBtn = (e.target as HTMLElement).closest(
        'button[data-opt="allowance"]'
      ) as HTMLButtonElement | null;
      if (allowanceBtn) {
        this.setSeamAllowanceEnabled(!this.allowanceOn);
        return;
      }
      const grainBtn = (e.target as HTMLElement).closest(
        'button[data-opt="grain"]'
      ) as HTMLButtonElement | null;
      if (grainBtn) {
        this.setGrainEnabled(!this.grainOn);
        return;
      }
      const seamLinksBtn = (e.target as HTMLElement).closest(
        'button[data-opt="seam-links"]'
      ) as HTMLButtonElement | null;
      if (seamLinksBtn) {
        this.setSeamConnectorsEnabled(!this.seamConnectorsOn);
        return;
      }
      const xrayBtn = (e.target as HTMLElement).closest(
        'button[data-opt="xray"]'
      ) as HTMLButtonElement | null;
      if (xrayBtn) {
        this.setXrayEnabled(!this.xrayOn);
        return;
      }
      const avatarBtn = (e.target as HTMLElement).closest(
        'button[data-opt="avatar"]'
      ) as HTMLButtonElement | null;
      if (avatarBtn) {
        void this.setAvatarOverlayEnabled(!this.avatarOverlayOn);
        return;
      }
      const snap = (e.target as HTMLElement).closest('button[data-opt="snap"]') as HTMLButtonElement | null;
      if (snap) {
        this.softSnap = !this.softSnap;
        this.snapBtn.classList.toggle('active', this.softSnap);
        this.snapBtn.setAttribute('aria-pressed', String(this.softSnap));
        this.snapGuides = [];
        this.redraw();
        return;
      }
      const btn = (e.target as HTMLElement).closest('button[data-tool]') as HTMLButtonElement | null;
      if (!btn) return;
      // A rail button does what its key does: it takes its tool up in whatever
      // mode it is set to. The modes themselves are on the ribbon.
      const railTool = btn.dataset.tool as PatternTool;
      if (railTool === 'add') this.setAddMode(this.addMode);
      else if (railTool === 'modify') this.setModifyMode(this.modifyMode);
      else if (railTool === 'ruler') this.setRulerMode(this.rulerMode);
      else this.setTool(railTool);
    });

    const main = document.createElement('div');
    main.className = 'pattern-editor-main';
    this.root.appendChild(main);

    this.pointBar = document.createElement('div');
    this.pointBar.className = 'pattern-point-bar';
    this.pointBar.hidden = true;
    this.pointBar.innerHTML = `
      <span class="pattern-settings-title">Point</span>
      <label title="Keep handles opposite when dragging"><input type="checkbox" data-opt="parallel" /> Parallel handles</label>
      <label title="Zero-length handles — corner / straight segments"><input type="checkbox" data-opt="corner" /> Corner (zero handles)</label>
    `;
    this.parallelCheck = this.pointBar.querySelector('input[data-opt="parallel"]') as HTMLInputElement;
    this.cornerCheck = this.pointBar.querySelector('input[data-opt="corner"]') as HTMLInputElement;
    this.sealOverlay(this.pointBar);
    this.parallelCheck.addEventListener('change', () => this.onParallelToggle());
    this.cornerCheck.addEventListener('change', () => this.onCornerToggle());

    this.viewport = document.createElement('div');
    this.viewport.className = 'pattern-viewport';
    main.appendChild(this.viewport);
    // Floats over the canvas in the top-left slot — as a layout sibling above
    // the viewport it used to shove the whole canvas down whenever you clicked
    // a point.
    this.viewport.appendChild(this.pointBar);

    // Tool settings: the options the tool in hand needs, in the same top-left
    // slot as the point settings. The two are never up together — a tool with
    // settings of its own is not one you are picking points with.
    this.toolSettings = document.createElement('div');
    this.toolSettings.className = 'pattern-tool-settings';
    this.toolSettings.hidden = true;
    // One set per tool, so the ribbon carries whichever the tool in hand needs.
    // A tool with modes shows them here rather than in its rail menu: picking a
    // mode *is* the setting, and it belongs beside the canvas it changes — how
    // Cut cuts, what Add draws.
    this.toolSettings.innerHTML = `
      <div class="pattern-settings-set" data-settings-for="move" hidden>
        <span class="pattern-settings-title">Move</span>
        <div class="pattern-settings-group" role="group" aria-label="Move mode">
          ${MOVE_MODES.map(
            (entry) =>
              `<button type="button" data-move-mode="${entry.mode}" title="${entry.tip}">${entry.label}</button>`
          ).join('')}
        </div>
        <span class="pattern-orbit-hint" data-orbit-hint></span>
        <label class="pattern-settings-field" data-settings-extra="orbit" title="How far from the point it turns about the moving point may travel — Shift-drag the point to pull the tether in or out">
          <span>Radius</span>
          <input type="number" data-orbit-radius min="0" step="0.1" inputmode="decimal" aria-label="Orbit radius" />
          <span class="pattern-settings-unit" data-orbit-unit>cm</span>
        </label>
      </div>
      <div class="pattern-settings-set" data-settings-for="add" hidden>
        <span class="pattern-settings-title">Add</span>
        <div class="pattern-settings-group" role="group" aria-label="Add mode">
          ${ADD_MODES.filter((entry) => this.canPlaceObject(entry.mode))
            .map(
              (entry) =>
                `<button type="button" data-add-mode="${entry.mode}" title="${entry.tip}">${entry.label}</button>`
            )
            .join('')}
        </div>
        <div class="pattern-settings-menu">
          <button type="button" class="pattern-settings-open" data-menu-open="block" title="Draft a piece from the block library" aria-haspopup="true" aria-expanded="false">Block… <span aria-hidden="true">▾</span></button>
          <div class="pattern-settings-popover pattern-block-menu-host" data-menu-popover="block" hidden role="menu"></div>
        </div>
        <div class="pattern-settings-menu">
          <button type="button" class="pattern-settings-open" data-menu-open="svg" title="Bring an SVG in as pattern pieces" aria-haspopup="true" aria-expanded="false">SVG… <span aria-hidden="true">▾</span></button>
          <div class="pattern-settings-popover" data-menu-popover="svg" hidden role="menu">
            <button type="button" class="pattern-settings-row" data-add-import role="menuitem">
              <span class="pattern-settings-row-name">Import SVG…</span>
              <span class="pattern-settings-row-desc">Bring an SVG in as pattern pieces</span>
            </button>
          </div>
        </div>
      </div>
      <div class="pattern-settings-set" data-settings-for="modify" hidden>
        <span class="pattern-settings-title">Modify</span>
        <div class="pattern-settings-group" role="group" aria-label="Modify mode">
          ${MODIFY_MODES.map(
            (entry) =>
              `<button type="button" data-modify-mode="${entry.mode}" title="${entry.tip}">${entry.label}</button>`
          ).join('')}
        </div>
        <div class="pattern-settings-group" data-settings-extra="join" role="group" aria-label="Edges to pick">
          ${EDGE_PAIR_MODES.map(
            (entry) =>
              `<button type="button" data-join-mode="${entry.mode}" title="${entry.tip}">${entry.label}</button>`
          ).join('')}
        </div>
        <div class="pattern-settings-group" data-settings-extra="join" role="group" aria-label="How the moving piece is brought over">
          <button type="button" data-join-fit="match" title="Move, turn and scale the piece as it is: the edges match if they land within the tolerance, and what is left between them is filled in">Move &amp; scale</button>
          <button type="button" data-join-fit="warp" title="Bend, stretch and turn the piece until its edges lie exactly on the other's">Warp</button>
        </div>
        <label class="pattern-settings-field" data-settings-extra="join" title="Move & scale: how far apart the picked edges may sit and still count as matched">
          <span>Tolerance</span>
          <input type="number" data-join-tolerance min="0" max="100" step="0.1" value="0.5" aria-label="Join match tolerance" />
          <span class="pattern-settings-unit">cm</span>
        </label>
        <div class="pattern-settings-group" data-settings-extra="bridge" role="group" aria-label="Edges to pick">
          ${EDGE_PAIR_MODES.map(
            (entry) =>
              `<button type="button" data-bridge-mode="${entry.mode}" title="${entry.tip}">${entry.label}</button>`
          ).join('')}
        </div>
      </div>
      <div class="pattern-settings-set" data-settings-for="cut" hidden>
        <span class="pattern-settings-title">Cut</span>
        <div class="pattern-settings-group" role="group" aria-label="Cut mode">
          ${CUT_MODES.map(
            (entry) =>
              `<button type="button" data-cut-mode="${entry.mode}" title="${CUT_TIPS[entry.mode]}">${entry.label}</button>`
          ).join('')}
        </div>
      </div>
      <div class="pattern-settings-set" data-settings-for="ruler" hidden>
        <span class="pattern-settings-title">Ruler</span>
        <div class="pattern-settings-group" role="group" aria-label="Ruler mode">
          ${RULER_MODES.map(
            (entry) =>
              `<button type="button" data-ruler-mode="${entry.mode}" title="${entry.tip}">${entry.label}</button>`
          ).join('')}
        </div>
        <!-- What the rail's ruler popup used to hold: the library of body
             measurements a rule can be laid out at, so the tool that picks one
             is the one that shows them. -->
        <div class="pattern-settings-menu">
          <button type="button" class="pattern-settings-open" data-menu-open="measurement" title="Lay the rule out at a body measurement, or at a free length" aria-haspopup="true" aria-expanded="false">Measurement… <span aria-hidden="true">▾</span></button>
          <div class="pattern-settings-popover pattern-ruler-menu" data-menu-popover="measurement" hidden role="menu">
            <div class="pattern-ruler-menu-search">
              <input type="search" data-ruler-search autocomplete="off" spellcheck="false"
                placeholder="Search people or measurements…" aria-label="Search people and measurements" />
            </div>
            <div class="pattern-ruler-menu-tree" data-ruler-tree role="tree"></div>
          </div>
        </div>
      </div>
      <div class="pattern-settings-set" data-settings-for="sew" hidden>
        <span class="pattern-settings-title">Sew</span>
        <div class="pattern-settings-group" role="group" aria-label="Sew mode">
          ${EDGE_PAIR_MODES.map(
            (entry) =>
              `<button type="button" data-sew-mode="${entry.mode}" title="${entry.tip}">${entry.label}</button>`
          ).join('')}
        </div>
      </div>
    `;
    this.viewport.appendChild(this.toolSettings);

    // Seam allowance: the same top-left slot, showing the piece's allowance and
    // the picked edge's own. The two fields are in the canvas' display unit, so
    // half an inch reads as 0.5 in or 1.27 cm depending on the unit in use.
    this.allowanceBar = document.createElement('div');
    this.allowanceBar.className = 'pattern-allowance-bar';
    this.allowanceBar.hidden = true;
    this.allowanceBar.innerHTML = `
      <span class="pattern-settings-title">Seam allowance</span>
      <span class="pattern-allowance-edge" data-allowance-edge-label></span>
      <label class="pattern-settings-field" title="Every edge of this piece without a setting of its own">
        <span>Piece</span>
        <input type="number" data-allowance-piece min="0" max="10" step="0.05" inputmode="decimal"
          aria-label="Piece seam allowance" />
      </label>
      <label class="pattern-settings-field" title="Just the picked edge">
        <span>Edge</span>
        <input type="number" data-allowance-edge min="0" max="10" step="0.05" inputmode="decimal"
          aria-label="Edge seam allowance" />
      </label>
      <span class="pattern-allowance-unit" data-allowance-unit></span>
      <button type="button" data-allowance-act="all" title="Use this edge's allowance on every edge of the piece">All edges</button>
      <button type="button" data-allowance-act="reset" title="Drop this edge's own allowance and follow the piece">Use piece</button>
    `;
    this.viewport.appendChild(this.allowanceBar);
    this.allowanceEdgeLabel = this.allowanceBar.querySelector(
      '[data-allowance-edge-label]'
    ) as HTMLElement;
    this.allowanceUnitLabel = this.allowanceBar.querySelector(
      '[data-allowance-unit]'
    ) as HTMLElement;
    this.allowancePieceInput = this.allowanceBar.querySelector(
      'input[data-allowance-piece]'
    ) as HTMLInputElement;
    this.allowanceEdgeInput = this.allowanceBar.querySelector(
      'input[data-allowance-edge]'
    ) as HTMLInputElement;
    this.sealOverlay(this.allowanceBar);
    this.allowancePieceInput.addEventListener('input', () => {
      this.applyAllowanceInput(this.allowancePieceInput, (piece, cm) =>
        setPieceAllowance(piece, cm)
      );
    });
    this.allowanceEdgeInput.addEventListener('input', () => {
      this.applyAllowanceInput(this.allowanceEdgeInput, (piece, cm) => {
        const sel = this.allowanceEdge;
        if (sel) setEdgeAllowance(piece, sel.edgeIndex, cm);
      });
    });
    this.allowanceBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest(
        'button[data-allowance-act]'
      ) as HTMLButtonElement | null;
      const sel = this.allowanceEdge;
      if (!btn || !sel) return;
      const piece = this.pattern.pieces.find((entry) => entry.id === sel.pieceId);
      if (!piece) return;
      e.preventDefault();
      if (btn.dataset.allowanceAct === 'all') {
        const cm = this.allowanceValueOf(this.allowanceEdgeInput.value);
        this.markBeforeChange();
        if (cm == null) setEveryEdgeAllowance(piece, allowanceForEdge(piece, sel.edgeIndex));
        else setEveryEdgeAllowance(piece, cm);
      } else {
        this.markBeforeChange();
        setEdgeAllowance(piece, sel.edgeIndex, null);
      }
      this.endHistoryGesture();
      this.notifyReferenceChange();
      this.redraw();
    });
    this.sealOverlay(this.toolSettings);
    // The ruler's measurement picker is a dropdown of the ribbon, beside its two
    // tools: the library it lists is the one the tool is set to read.
    this.rulerSearchInput = this.toolSettings.querySelector(
      'input[data-ruler-search]'
    ) as HTMLInputElement;
    this.rulerTree = this.toolSettings.querySelector('[data-ruler-tree]') as HTMLElement;
    this.rulerSearchInput.addEventListener('input', () => this.renderRulerMenu());
    this.rulerTree.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest(
        'button[data-measure-id]'
      ) as HTMLButtonElement | null;
      if (!item || item.disabled) return;
      e.preventDefault();
      this.chooseRulerMeasurement(item.dataset.personId ?? '', item.dataset.measureId ?? '');
    });
    this.toolSettings.querySelectorAll('button[data-add-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', () => this.setAddMode(btn.dataset.addMode as AddMode));
    });
    this.toolSettings.querySelectorAll('button[data-modify-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', () => this.setModifyMode(btn.dataset.modifyMode as ModifyMode));
    });
    this.toolSettings.querySelectorAll('button[data-sew-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', () => this.setSewMode(btn.dataset.sewMode as SewMode));
    });
    this.toolSettings.querySelectorAll('button[data-ruler-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', () => this.setRulerMode(btn.dataset.rulerMode as RulerMode));
    });
    this.toolSettings.querySelectorAll('button[data-cut-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', () => this.setCutMode(btn.dataset.cutMode as CutMode));
    });
    // Every dropdown on the ribbon: Add's block library and SVG import beside
    // its shapes, the measurement library beside the ruler's two tools.
    this.toolSettings.querySelectorAll('button[data-menu-open]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleSettingsMenu(btn.dataset.menuOpen as SettingsMenuKey);
      });
    });
    this.toolSettings.querySelector('[data-add-import]')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.hideSettingsMenus();
      // A one-shot action rather than a mode: it hands over to the file picker
      // and leaves the shape in hand alone.
      this.svgFileInput.click();
    });
    this.bindSettingsMenuDismiss();
    this.toolSettings.querySelectorAll('button[data-join-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', () => this.setJoinMode(btn.dataset.joinMode as JoinMode));
    });
    this.toolSettings.querySelectorAll('button[data-bridge-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', () => this.setBridgeMode(btn.dataset.bridgeMode as JoinMode));
    });
    this.toolSettings.querySelectorAll('button[data-join-fit]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', () => this.setJoinFit(btn.dataset.joinFit as JoinFit));
    });
    const joinTolerance = this.toolSettings.querySelector(
      'input[data-join-tolerance]'
    ) as HTMLInputElement;
    joinTolerance.addEventListener('input', () => {
      const value = parseFloat(joinTolerance.value);
      this.setJoinTolerance(Number.isFinite(value) ? value : 0);
    });
    this.toolSettings.querySelectorAll('button[data-move-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.addEventListener('click', () => this.setMoveMode(btn.dataset.moveMode as MoveMode));
    });
    // The tether's length, typed: the ribbon's field and the guide on the canvas
    // are two views of the same number, so the field is only written to when the
    // hand is not in it.
    this.orbitRadiusInput = this.toolSettings.querySelector(
      'input[data-orbit-radius]'
    ) as HTMLInputElement;
    this.orbitRadiusInput.addEventListener('input', () => {
      const display = parseFloat(this.orbitRadiusInput.value);
      if (!Number.isFinite(display) || !this.orbit) return;
      // The ring and the point are one number: typing a radius puts the point on
      // the new tether, the way pulling it with Shift does.
      this.markBeforeChange();
      this.orbit.radius = Math.max(MIN_ORBIT_RADIUS_CM, displayToCm(display, this.unit));
      this.placeOrbitPoint();
      this.endHistoryGesture();
      this.cbs.onChange();
      this.redraw();
    });
    this.orbitRadiusInput.addEventListener('change', () => {
      // A value typed in is an edit like any other: the point is already there,
      // this only re-reads the field once the hand has left it.
      if (this.orbit) this.orbit.radius = Math.max(MIN_ORBIT_RADIUS_CM, this.orbit.radius);
      this.syncToolSettings();
      this.redraw();
    });

    // Ruler inspector — appears only while a reference ruler is selected.
    this.rulerBar = document.createElement('div');
    this.rulerBar.className = 'pattern-ruler-bar';
    this.rulerBar.hidden = true;
    this.rulerBar.innerHTML = `
      <span class="pattern-ruler-bar-label">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <g transform="rotate(-45 8 8)">
            <rect x="1.2" y="5.4" width="13.6" height="5.2" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.3"/>
            <path fill="none" stroke="currentColor" stroke-width="1.1" d="M4 5.4v2M6.6 5.4v1.3M9.2 5.4v2M11.8 5.4v1.3"/>
          </g>
        </svg>
        Ruler
      </span>
      <label class="pattern-ruler-field">
        <span>Person</span>
        <select data-ruler-person aria-label="Measurement person"></select>
      </label>
      <label class="pattern-ruler-field">
        <span>Measurement</span>
        <select data-ruler-measure aria-label="Body measurement"></select>
      </label>
      <div class="pattern-ruler-scale" role="group" aria-label="Ruler width">
        <button type="button" data-ruler-half="0">Full</button>
        <button type="button" data-ruler-half="1" title="Half the measurement — the usual fold line">Half</button>
      </div>
      <span class="pattern-ruler-readout" data-ruler-readout></span>
      <button type="button" class="pattern-ruler-delete" data-ruler-delete aria-label="Delete ruler">Delete</button>
    `;
    this.viewport.appendChild(this.rulerBar);
    this.rulerPersonSelect = this.rulerBar.querySelector(
      'select[data-ruler-person]'
    ) as HTMLSelectElement;
    this.rulerMeasureSelect = this.rulerBar.querySelector(
      'select[data-ruler-measure]'
    ) as HTMLSelectElement;
    this.rulerReadout = this.rulerBar.querySelector('[data-ruler-readout]') as HTMLElement;
    this.rulerScaleBtns = Array.from(
      this.rulerBar.querySelectorAll('button[data-ruler-half]')
    ) as HTMLButtonElement[];
    this.sealOverlay(this.rulerBar);
    this.rulerBar.addEventListener('click', (e) => {
      const halfBtn = (e.target as HTMLElement).closest(
        'button[data-ruler-half]'
      ) as HTMLButtonElement | null;
      if (halfBtn) {
        this.setSelectedRulerHalf(halfBtn.dataset.rulerHalf === '1');
        return;
      }
      const del = (e.target as HTMLElement).closest(
        'button[data-ruler-delete]'
      ) as HTMLButtonElement | null;
      if (del) this.deleteSelectedRuler();
    });
    this.rulerPersonSelect.addEventListener('change', () =>
      this.onRulerPersonChange(this.rulerPersonSelect.value)
    );
    this.rulerMeasureSelect.addEventListener('change', () =>
      this.onRulerMeasurementChange(this.rulerMeasureSelect.value)
    );

    // Block inspector — takes the same top-left slot as the point and ruler
    // ribbons; the three are mutually exclusive by selection.
    this.blockBar = document.createElement('div');
    this.blockBar.className = 'pattern-block-bar';
    this.blockBar.hidden = true;
    this.blockBar.innerHTML = `
      <div class="pattern-block-head">
        <span class="pattern-block-name" data-block-name></span>
        <label class="pattern-block-field">
          <span>Person</span>
          <select data-block-person aria-label="Measurement person"></select>
        </label>
        <button type="button" class="pattern-block-sew" data-block-sew
          title="Sew the side seams, and the waistband onto the waist">Sew</button>
        <button type="button" class="pattern-block-detach" data-block-detach
          title="Keep the pieces but stop tracking them as a block">Detach</button>
        <button type="button" class="pattern-block-delete" data-block-delete
          aria-label="Delete block">Delete</button>
      </div>
      <div class="pattern-block-vars" data-block-vars></div>
      <div class="pattern-block-source muted" data-block-source></div>
    `;
    this.viewport.appendChild(this.blockBar);
    this.blockPersonSelect = this.blockBar.querySelector(
      'select[data-block-person]'
    ) as HTMLSelectElement;
    this.blockVarsHost = this.blockBar.querySelector('[data-block-vars]') as HTMLElement;
    this.blockSourceNote = this.blockBar.querySelector('[data-block-source]') as HTMLElement;
    this.sealOverlay(this.blockBar);
    this.blockPersonSelect.addEventListener('change', () =>
      this.onBlockPersonChange(this.blockPersonSelect.value)
    );
    this.blockBar.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('button[data-block-sew]')) {
        this.sewSelectedBlock();
        return;
      }
      if (target.closest('button[data-block-detach]')) {
        this.detachSelectedBlock();
        return;
      }
      if (target.closest('button[data-block-delete]')) {
        this.deleteSelectedBlock();
        return;
      }
      const groupHead = target.closest<HTMLButtonElement>('button[data-block-group-toggle]');
      if (groupHead) {
        const group = groupHead.closest<HTMLElement>('.pattern-block-group');
        if (group?.dataset.blockGroup) this.toggleBlockGroup(group.dataset.blockGroup, group);
        return;
      }
      const mode = target.closest('button[data-block-mode]') as HTMLButtonElement | null;
      const div = target.closest('button[data-block-div]') as HTMLButtonElement | null;
      const varEl = target.closest('[data-var-id]') as HTMLElement | null;
      if (!varEl) return;
      const varId = varEl.dataset.varId!;
      if (mode) {
        this.setBlockVariableMode(varId, mode.dataset.blockMode as 'value' | 'measurement');
        return;
      }
      if (div) {
        const divisor = Number(div.dataset.blockDiv) as BlockDivisor;
        this.setBlockVariableDivisor(varId, divisor);
      }
    });
    this.blockBar.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      const varEl = target.closest('[data-var-id]') as HTMLElement | null;
      if (!varEl) return;
      const varId = varEl.dataset.varId!;
      // Typing is not a structural edit: the rows stay put so the caret survives
      // and the whole typed entry collapses into one undo step.
      if (target.matches('[data-block-value]')) {
        const cm = this.blockFieldCm(varId, target);
        if (cm != null) this.setBlockVariableValue(varId, cm, false);
        return;
      }
      if (target.matches('[data-block-offset]')) {
        const raw = Number.parseFloat(target.value);
        if (Number.isFinite(raw)) this.setBlockVariableOffset(varId, this.blockCm(raw), false);
      }
    });
    this.blockBar.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      const varEl = target.closest('[data-var-id]') as HTMLElement | null;
      if (!varEl) return;
      const varId = varEl.dataset.varId!;
      if (target.matches('[data-block-field]')) {
        this.setBlockVariableField(varId, (target as HTMLSelectElement).value);
        return;
      }
      // Past the select, everything left in this bar is a number field.
      const field = target as HTMLInputElement;
      // A field left empty, half-typed or out of range snaps back to the value
      // the block is really using, so the box never lies about the draft.
      if (target.matches('[data-block-value]')) {
        const cm = this.blockFieldCm(varId, field);
        if (cm != null) this.setBlockVariableValue(varId, cm, false);
      } else if (target.matches('[data-block-offset]')) {
        const raw = Number.parseFloat(field.value);
        if (Number.isFinite(raw)) this.setBlockVariableOffset(varId, this.blockCm(raw), false);
      }
      this.syncBlockField(varId, field);
      this.endHistoryGesture();
    });
    // Belt and braces: `change` already fires on blur, but an interrupted edit
    // must never leave the undo gesture open for the next unrelated action.
    this.blockBar.addEventListener('focusout', () => this.endHistoryGesture());

    // Hovering a variable lights up the outline it controls, so you can see what
    // "dart space" or "hip depth, side" actually moves before you touch it.
    this.blockVarsHost.addEventListener('pointerover', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-var-id]');
      this.setHoveredVar(row?.dataset.varId ?? null);
    });
    this.blockVarsHost.addEventListener('pointerleave', () => this.setHoveredVar(null));

    this.sewBar = document.createElement('div');
    this.sewBar.className = 'pattern-sew-bar';
    this.sewBar.hidden = true;
    this.sewBar.innerHTML = `
      <span class="pattern-sew-title">Sew</span>
      <span data-sew-instruction></span>
      <button type="button" data-sew-reverse title="Reverse the order of the edges selected for this side">Reverse order</button>
      <button type="button" data-sew-next></button>
      <button type="button" data-sew-cancel aria-label="Cancel many-to-many sewing">Cancel</button>
    `;
    this.viewport.appendChild(this.sewBar);
    this.sealOverlay(this.sewBar);
    this.sewBar.querySelector('[data-sew-next]')?.addEventListener('click', () => {
      this.advanceMultiSew();
    });
    this.sewBar.querySelector('[data-sew-reverse]')?.addEventListener('click', () => {
      this.reverseMultiSewSide();
    });
    this.sewBar.querySelector('[data-sew-cancel]')?.addEventListener('click', () => {
      this.clearMultiSew();
      this.redraw();
    });

    // Join bar: both ends of a fuse, the swap that decides which piece moves,
    // and the button that does it.
    this.joinBar = document.createElement('div');
    this.joinBar.className = 'pattern-join-bar';
    this.joinBar.hidden = true;
    this.joinBar.innerHTML = `
      <span class="pattern-join-title">Join</span>
      <span data-join-instruction></span>
      <button type="button" data-join-next>Confirm edges →</button>
      <button type="button" data-join-swap title="Fuse the other piece onto this one instead">Swap sides</button>
      <button type="button" data-join-commit>Fuse pieces</button>
      <button type="button" data-join-cancel aria-label="Cancel joining">Cancel</button>
    `;
    this.viewport.appendChild(this.joinBar);
    this.sealOverlay(this.joinBar);
    this.joinBar.querySelector('[data-join-commit]')?.addEventListener('click', () => {
      this.commitJoin();
    });
    this.joinBar.querySelector('[data-join-next]')?.addEventListener('click', () => {
      this.toggleJoinSide();
    });
    this.joinBar.querySelector('[data-join-swap]')?.addEventListener('click', () => {
      this.swapJoinSides();
    });
    this.joinBar.querySelector('[data-join-cancel]')?.addEventListener('click', () => {
      this.clearJoin();
      this.redraw();
    });

    // Bridge bar: the two runs a bridge spans, and the button that draws it.
    this.bridgeBar = document.createElement('div');
    this.bridgeBar.className = 'pattern-bridge-bar';
    this.bridgeBar.hidden = true;
    this.bridgeBar.innerHTML = `
      <span class="pattern-bridge-title">Bridge</span>
      <span data-bridge-instruction></span>
      <button type="button" data-bridge-next>Confirm edges →</button>
      <button type="button" data-bridge-commit>Bridge pieces</button>
      <button type="button" data-bridge-cancel aria-label="Cancel bridging">Cancel</button>
    `;
    this.viewport.appendChild(this.bridgeBar);
    this.sealOverlay(this.bridgeBar);
    this.bridgeBar.querySelector('[data-bridge-commit]')?.addEventListener('click', () => {
      this.commitBridge();
    });
    this.bridgeBar.querySelector('[data-bridge-next]')?.addEventListener('click', () => {
      this.toggleBridgeSide();
    });
    this.bridgeBar.querySelector('[data-bridge-cancel]')?.addEventListener('click', () => {
      this.clearBridge();
      this.redraw();
    });

    // Simplify bar: Reduce / Fit with a live preview, then Done or Cancel.
    this.simplifyBar = document.createElement('div');
    this.simplifyBar.className = 'pattern-simplify-bar';
    this.simplifyBar.hidden = true;
    this.simplifyBar.innerHTML = `
      <span class="pattern-simplify-title">Simplify points</span>
      <span class="pattern-simplify-count" data-simplify-count></span>
      <label class="pattern-simplify-field" title="How many points to drop, as a share of the picked ones">
        <span>Reduce</span>
        <input data-simplify-reduce type="range" min="0" max="100" step="1" value="0" aria-label="Reduce points by percent" />
        <span class="pattern-simplify-value" data-simplify-reduce-val>0%</span>
      </label>
      <label class="pattern-simplify-field" title="How the curve is fitted back through the points that remain">
        <span>Fit</span>
        <select data-simplify-fit aria-label="Curve fit">
          <option value="smooth">Smooth</option>
          <option value="corner">Corner</option>
        </select>
      </label>
      <button type="button" data-simplify-done>Done</button>
      <button type="button" data-simplify-cancel aria-label="Cancel simplifying">Cancel</button>
    `;
    this.viewport.appendChild(this.simplifyBar);
    this.sealOverlay(this.simplifyBar);
    const reduceInput = this.simplifyBar.querySelector(
      'input[data-simplify-reduce]'
    ) as HTMLInputElement;
    reduceInput.addEventListener('input', () => {
      const state = this.simplify;
      if (!state) return;
      state.reduce = Math.max(0, Math.min(100, parseFloat(reduceInput.value) || 0));
      this.applySimplify();
    });
    const fitInput = this.simplifyBar.querySelector('select[data-simplify-fit]') as HTMLSelectElement;
    fitInput.addEventListener('change', () => {
      const state = this.simplify;
      if (!state) return;
      state.fit = fitInput.value === 'corner' ? 'corner' : 'smooth';
      this.applySimplify();
    });
    this.simplifyBar.querySelector('[data-simplify-done]')?.addEventListener('click', () => {
      this.finishSimplify();
    });
    this.simplifyBar.querySelector('[data-simplify-cancel]')?.addEventListener('click', () => {
      this.cancelSimplify();
    });

    // Measure bar: the running value, and the two ways out of the session.
    this.measureBar = document.createElement('div');
    this.measureBar.className = 'pattern-measure-bar';
    this.measureBar.hidden = true;
    this.measureBar.innerHTML = `
      <span class="pattern-measure-title">Measure</span>
      <span class="pattern-measure-readout" data-measure-readout></span>
      <button type="button" data-measure-sum hidden>Sum</button>
      <button type="button" data-measure-clear class="danger" hidden>Delete</button>
      <button type="button" data-measure-done hidden>Done</button>
    `;
    this.viewport.appendChild(this.measureBar);
    this.sealOverlay(this.measureBar);
    this.measureBar.querySelector('[data-measure-sum]')?.addEventListener('click', () => {
      this.sumSelectedMeasures();
    });
    this.measureBar.querySelector('[data-measure-clear]')?.addEventListener('click', () => {
      this.clearMeasureDraft();
    });
    this.measureBar.querySelector('[data-measure-done]')?.addEventListener('click', () => {
      // The same button steps out of whichever session is running: the gathering
      // for a total, or the measurement being built.
      if (this.measureSelection.size > 0) this.clearMeasureSelection();
      else this.finishMeasureDraft();
      this.redraw();
    });

    // The cut bar: what the cut in hand is set to, along the bottom of the
    // viewport where the eye already is while dragging or clicking a cut out.
    // Every cut mode shares it, so the two things a cut can do with what it
    // separates — weld it back, or throw it away — are in the same place
    // whichever cut is in hand; the chain's own controls join them in Curve.
    this.cutBar = document.createElement('div');
    this.cutBar.className = 'pattern-cut-bar';
    this.cutBar.hidden = true;
    this.cutBar.innerHTML = `
      <span class="pattern-cut-title" data-cut-title></span>
      <span class="pattern-cut-count" data-cut-count></span>
      <span class="pattern-cut-status" data-cut-status></span>
      <label class="pattern-cut-field" data-cut-fit-field title="How the clicked points are joined up">
        <span>Fit</span>
        <select data-cut-fit aria-label="Chain fit">
          <option value="smooth">Smooth</option>
          <option value="straight">Straight</option>
        </select>
      </label>
      <span class="pattern-cut-readout" data-cut-readout></span>
      <label class="pattern-cut-toggle" data-cut-sew-field>
        <input type="checkbox" data-cut-sew /> <span data-cut-sew-label>Sew pieces</span>
      </label>
      <label class="pattern-cut-toggle" data-cut-hole-field>
        <input type="checkbox" data-cut-hole /> <span>Hole</span>
      </label>
      <button type="button" data-cut-done>Done</button>
      <button type="button" data-cut-cancel aria-label="Cancel the curve cut">Cancel</button>
    `;
    this.viewport.appendChild(this.cutBar);
    this.sealOverlay(this.cutBar);
    const cutFit = this.cutBar.querySelector('select[data-cut-fit]') as HTMLSelectElement;
    cutFit.addEventListener('change', () => {
      this.cutChainFit = cutFit.value === 'straight' ? 'straight' : 'smooth';
      this.redraw();
    });
    const cutSew = this.cutBar.querySelector('input[data-cut-sew]') as HTMLInputElement;
    cutSew.addEventListener('change', () => {
      this.cutSew = cutSew.checked;
      this.redraw();
    });
    const cutHole = this.cutBar.querySelector('input[data-cut-hole]') as HTMLInputElement;
    cutHole.addEventListener('change', () => {
      this.cutHole = cutHole.checked;
      // A hole and a piece sewn into it are the two things the same cut-out can
      // become, so picking one lets go of the other.
      if (this.cutHole && this.cutSew) {
        this.cutSew = false;
        this.syncCutBar();
      }
      this.redraw();
    });
    this.cutBar.querySelector('[data-cut-done]')?.addEventListener('click', () => {
      this.commitCutChain();
    });
    this.cutBar.querySelector('[data-cut-cancel]')?.addEventListener('click', () => {
      this.cancelCutChain();
    });

    this.xrayBar = document.createElement('div');
    this.xrayBar.className = 'pattern-xray-bar';
    this.xrayBar.hidden = true;
    this.xrayBar.innerHTML = `
      <span class="pattern-xray-bar-label">X-ray</span>
      <label class="pattern-xray-opacity" title="Pattern fill opacity">
        <span>Opacity</span>
        <input data-xray-opacity type="range" min="5" max="100" step="1" value="35" aria-label="Pattern opacity" />
        <span class="pattern-xray-opacity-val" data-xray-opacity-val>35%</span>
      </label>
    `;
    this.viewport.appendChild(this.xrayBar);
    this.xrayOpacityInput = this.xrayBar.querySelector(
      'input[data-xray-opacity]'
    ) as HTMLInputElement;
    this.sealOverlay(this.xrayBar);
    this.xrayOpacityInput.addEventListener('input', () => {
      const pct = Math.max(5, Math.min(100, parseFloat(this.xrayOpacityInput.value) || 35));
      this.xrayOpacity = pct / 100;
      this.applyXrayStyles();
    });

    this.avatarBar = document.createElement('div');
    this.avatarBar.className = 'pattern-avatar-bar';
    this.avatarBar.hidden = true;
    this.avatarBar.innerHTML = `
      <span class="pattern-avatar-bar-label">Avatar ref</span>
      <select data-avatar-view aria-label="Avatar view direction">
        ${AVATAR_OVERLAY_VIEWS.map(
          (v) => `<option value="${v.id}" ${v.id === 'front' ? 'selected' : ''}>${v.label}</option>`
        ).join('')}
      </select>
      <label class="pattern-avatar-offset" title="Horizontal offset in pattern cm">
        <span>X</span>
        <input data-avatar-ox type="number" step="0.5" value="0" aria-label="Avatar X offset (cm)" />
      </label>
      <label class="pattern-avatar-offset" title="Vertical offset in pattern cm (+ down)">
        <span>Y</span>
        <input data-avatar-oy type="number" step="0.5" value="0" aria-label="Avatar Y offset (cm)" />
      </label>
      <span class="pattern-avatar-bar-hint muted">15% · true scale (cm)</span>
    `;
    this.viewport.appendChild(this.avatarBar);
    this.avatarViewSelect = this.avatarBar.querySelector(
      'select[data-avatar-view]'
    ) as HTMLSelectElement;
    this.avatarOffsetXInput = this.avatarBar.querySelector(
      'input[data-avatar-ox]'
    ) as HTMLInputElement;
    this.avatarOffsetYInput = this.avatarBar.querySelector(
      'input[data-avatar-oy]'
    ) as HTMLInputElement;
    this.sealOverlay(this.avatarBar);
    this.avatarViewSelect.addEventListener('change', () => {
      this.avatarOverlayView = this.avatarViewSelect.value as AvatarOverlayView;
      void this.refreshAvatarOverlayPath();
    });
    const bindOffset = (input: HTMLInputElement, axis: 'x' | 'y') => {
      const apply = () => {
        const v = parseFloat(input.value);
        const n = Number.isFinite(v) ? v : 0;
        if (axis === 'x') this.avatarOffsetX = n;
        else this.avatarOffsetY = n;
        this.syncAvatarSvg();
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
    };
    bindOffset(this.avatarOffsetXInput, 'x');
    bindOffset(this.avatarOffsetYInput, 'y');

    this.avatarSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.avatarSvg.setAttribute('class', 'pattern-avatar-svg');
    this.avatarSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.avatarSvg.setAttribute('aria-hidden', 'true');
    this.viewport.appendChild(this.avatarSvg);

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'pattern-svg');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.viewport.appendChild(this.svg);

    this.contextMenu = document.createElement('div');
    this.contextMenu.className = 'pattern-context-menu';
    this.contextMenu.hidden = true;
    this.contextMenu.innerHTML = `
      <button type="button" data-act="duplicate">Duplicate</button>
      <button type="button" data-act="mirror-x">Mirror duplicate X</button>
      <button type="button" data-act="mirror-y">Mirror duplicate Y</button>
      <button type="button" data-act="simplify-points" hidden>Simplify points</button>
      <button type="button" data-act="new-container" hidden>Put selection in container</button>
      <button type="button" data-act="delete-piece" class="danger">Delete piece</button>
      <button type="button" data-act="reverse-seam" hidden>Reverse seam</button>
      <button type="button" data-act="reverse-seam-order" hidden>Reverse seam order here</button>
      <button type="button" data-act="remove-seam" class="danger" hidden>Remove seam</button>
      <button type="button" data-act="ruler-toggle-half" hidden>Toggle full / half width</button>
      <button type="button" data-act="ruler-delete" class="danger" hidden>Delete ruler</button>
    `;
    this.viewport.appendChild(this.contextMenu);
    this.sealOverlay(this.contextMenu);
    this.contextMenu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'duplicate') this.duplicateContextPiece();
      else if (act === 'mirror-x') this.mirrorDuplicateContextPiece('x');
      else if (act === 'mirror-y') this.mirrorDuplicateContextPiece('y');
      else if (act === 'delete-piece') this.deleteContextPiece();
      else if (act === 'simplify-points') this.startSimplifyPoints();
      else if (act === 'new-container') this.groupSelectionIntoContainer();
      else if (act === 'reverse-seam') this.reverseContextSeam();
      else if (act === 'reverse-seam-order') this.reverseContextSeamOrder();
      else if (act === 'remove-seam') this.removeContextSeam();
      else if (act === 'ruler-toggle-half') this.setSelectedRulerHalf(!this.selectedRuler()?.half);
      else if (act === 'ruler-delete') this.deleteSelectedRuler();
      this.hideContextMenu();
    });

    this.root.tabIndex = -1;
    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.svg.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.svg.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.svg.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    this.root.addEventListener('pointerdown', this.onRootPointerDown, true);
    document.addEventListener('keydown', this.onDocKeyDown, true);
    this.viewport.addEventListener(
      'wheel',
      (e) => {
        // A locked container is not zoomable, so the wheel belongs to whatever
        // holds it — on the canvas, that is the canvas itself.
        if (this.container?.locked) return;
        e.preventDefault();
        e.stopPropagation();
        this.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 0.89);
      },
      { passive: false }
    );

    this.selectedPieceId = pattern.pieces[0]?.id ?? null;
    this.fitView();
    this.setTool('move');
    this.syncRulerToolbar();
    this.redraw();
    this.bindViewportResize();
    // Constructor often runs before flex layout assigns svg size; redraw once laid out.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.relayoutChrome());
    });
  }

  /** Recompute screen-constant chrome after the viewport gets a real size. */
  relayoutChrome(): void {
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
    if (w < 2 || h < 2) return;
    if (w === this.lastChromeLayout.w && h === this.lastChromeLayout.h) return;
    this.lastChromeLayout = { w, h };
    this.redraw();
  }

  private bindViewportResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.relayoutChrome());
    this.resizeObserver.observe(this.viewport);
  }

  private onRootPointerDown = (e: PointerEvent): void => {
    if (this.contextMenu.hidden) return;
    if (this.contextMenu.contains(e.target as Node)) return;
    this.hideContextMenu();
  };

  private onDocKeyDown = (e: KeyboardEvent): void => {
    // Enter takes the curve cut's chain, the way it would take a dialog's
    // default — unless the pointer is in a control that wants the key itself.
    if (
      e.key === 'Enter' &&
      this.tool === 'cut' &&
      this.cutMode === 'curve' &&
      this.cutChain.length >= 2 &&
      !isTextEntry(e.target)
    ) {
      e.preventDefault();
      this.commitCutChain();
      return;
    }
    if (e.key === 'Escape') {
      if (this.importDialog) {
        this.closeSvgImportDialog();
        e.preventDefault();
        return;
      }
      if (!this.viewMenu.hidden) {
        // Swallow the key: the menu is what Escape is dismissing, not the
        // full-screen view it happens to be sitting in.
        this.closeViewMenu();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this.pendingSeam) {
        this.pendingSeam = null;
        this.hoverEdge = null;
        this.redraw();
      }
      // Typing into a note, or the note in hand: Escape lets that go first.
      if (this.textEditingId) {
        this.commitTextEditing();
        e.preventDefault();
        return;
      }
      if (this.selectedTextId) {
        this.selectedTextId = null;
        this.cbs.onTextSelectionChange?.();
        this.redraw();
        e.preventDefault();
        return;
      }
      // Then an image in hand, which is picked and let go the same way.
      if (this.selectedImageId) {
        this.setImageSelection(null);
        e.preventDefault();
        return;
      }
      // An orbit tether, or the point waiting for one, is the nearest thing in
      // hand: Escape lets it go before it steps further back.
      if (this.orbit || this.orbitPickId) {
        this.clearOrbit();
        this.syncToolSettings();
        this.redraw();
        e.preventDefault();
        return;
      }
      if (this.multiSewSource.length > 0 || this.multiSewTarget.length > 0) {
        this.clearMultiSew();
        this.hoverEdge = null;
        this.redraw();
      }
      if (this.joinMove.length > 0 || this.joinKeep.length > 0) {
        this.clearJoin();
        this.hoverEdge = null;
        this.redraw();
      }
      if (this.bridgeFirst.length > 0 || this.bridgeSecond.length > 0) {
        this.clearBridge();
        this.hoverEdge = null;
        this.redraw();
      }
      if (this.tool === 'cut' && this.cutChain.length > 0) {
        this.cancelCutChain();
      }
      if (this.simplify) {
        this.cancelSimplify();
        e.preventDefault();
        return;
      }
      if (this.allowanceEdge) {
        this.allowanceEdge = null;
        this.allowanceHover = null;
        this.redraw();
      }
      // Escape steps out of the measurement being built; what it made stays put.
      if (this.measureSelection.size > 0) {
        this.clearMeasureSelection();
        e.preventDefault();
        return;
      }
      if (this.measureDraftId || this.measureChainTail) {
        this.finishMeasureDraft();
        this.redraw();
      }
      this.setRulerSelection(null);
      this.setSelectedBlock(null);
      this.hideSettingsMenus();
      this.hideSettingsMenus();
      this.hideContextMenu();
      return;
    }
    if (e.key === 'Enter' && this.tool === 'sew' && this.sewMode === 'many') {
      e.preventDefault();
      this.advanceMultiSew();
      return;
    }
    if (e.key === 'Enter' && this.isModify('join') && !isTextEntry(e.target)) {
      e.preventDefault();
      // Many mode: Enter is the Confirm edges button, then the commit.
      if (this.joinMode === 'many' && this.joinPhase === 'move' && this.joinMove.length > 0) {
        this.toggleJoinSide();
      } else {
        this.commitJoin();
      }
      return;
    }
    if (e.key === 'Enter' && this.isModify('bridge') && !isTextEntry(e.target)) {
      e.preventDefault();
      if (this.bridgeMode === 'many' && this.bridgePhase === 'first' && this.bridgeFirst.length > 0) {
        this.toggleBridgeSide();
      } else {
        this.commitBridge();
      }
      return;
    }
    if (this.handleToolKey(e)) return;
    // A cooked document has nothing to delete: its contents are derived.
    if (this.readOnly) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;

    const ae = document.activeElement as HTMLElement | null;
    if (
      ae &&
      (ae.tagName === 'INPUT' ||
        ae.tagName === 'TEXTAREA' ||
        ae.tagName === 'SELECT' ||
        ae.isContentEditable)
    ) {
      return;
    }
    // Only when this pattern editor recently received focus / contains focus
    if (!this.root.isConnected) return;
    if (ae && ae !== this.root && !this.root.contains(ae) && ae !== document.body) return;

    e.preventDefault();
    e.stopPropagation();
    this.hideContextMenu();
    this.handleDeleteKey();
  };

  /**
   * Single-key tool shortcuts, the way a vector editor's rail works: **V** move,
   * **A** add, **M** modify, **C** cut, **S** sew, **R** measure.
   *
   * They belong to the editor the keyboard is in — the one holding focus — since
   * a board can have a page and any number of containers open at once, each with
   * its own tool in hand. A modified key is never a tool key, so ⌘/Ctrl+V, ⌘/Ctrl+S
   * and the rest still mean what they always meant.
   */
  private handleToolKey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return false;
    if (e.key.length !== 1) return false;
    const tool = TOOL_KEYS[e.key.toLowerCase()];
    if (!tool) return false;
    if (isTextEntry(e.target)) return false;
    const active = document.activeElement;
    if (!this.root.isConnected) return false;
    if (active !== this.root && !this.root.contains(active)) return false;
    e.preventDefault();
    e.stopPropagation();
    // Taking a tool up is walking back to the canvas: whatever popover was in
    // the way closes, the way Escape would close it.
    this.closeViewMenu();
    this.hideSettingsMenus();
    this.hideContextMenu();
    // Add, Modify, Cut and Ruler come up in whatever mode they are set to: the
    // mode is a setting, and the ribbon beside the canvas is where it is changed.
    if (tool === 'add') this.setAddMode(this.addMode);
    else if (tool === 'cut') this.setCutMode(this.cutMode);
    else if (tool === 'modify') this.setModifyMode(this.modifyMode);
    else if (tool === 'ruler') this.setRulerMode(this.rulerMode);
    else this.setTool(tool);
    return true;
  }

  setUnit(unit: UnitDisplay): void {
    this.unit = unit;
    // The ribbon reads in the unit in hand, so it is rewritten with it.
    this.syncToolSettings();
    this.redraw();
  }

  /**
   * Swap in a new pattern document.
   *
   * `preserveView` keeps the current zoom/pan instead of re-framing: the view is
   * state of the user's, not of the document, so restoring history through here
   * must not move it.
   */
  setPattern(
    pattern: PatternDocument,
    opts: { preserveView?: boolean; cooked?: boolean } = {}
  ): void {
    this.pattern = pattern;
    this.setReadOnly(!!opts.cooked);
    // A new document replaces the pieces a simplify preview was drawn into, so
    // the session cannot be finished — drop it (undo lands here).
    this.simplify = null;
    this.simplifyBar.hidden = true;
    // Block outlines are a cache of their variables, so rebuild them before
    // anything measures or draws: a document written by an older build, or one
    // whose variables were clamped on the way in, must not keep displaying the
    // shape it was saved with.
    normalizePattern(pattern, (id) => this.measurementSet(id));
    // A cooked document is the stack's output: cook it here, after the blocks
    // have expanded, so what is drawn is what the mesh will be built from.
    if (opts.cooked) this.cookIntoDocument();
    this.selectedRulerId = null;
    this.hoverRulerId = null;
    this.selectedBlockId = null;
    // A note being typed into belongs to the document that was on screen.
    this.selectedTextId = null;
    this.textEditingId = null;
    // So does an image in hand.
    this.selectedImageId = null;
    // A pick in flight belongs to the document that was on screen.
    this.clearJoin();
    this.clearBridge();
    this.clearMultiSew();
    this.pendingSeam = null;
    this.hoverEdge = null;
    this.syncRulerBar();
    this.syncBlockBar();
    this.selectedPieceId = pattern.pieces[0]?.id ?? null;
    this.clearSelection();
    if (!opts.preserveView) this.fitView();
    this.redraw();
  }

  /**
   * Show the cook of a modifier stack: the pattern's geometry as the stack leaves
   * it, drawn read-only.
   *
   * The host hands over a *copy*, so cooking can never write into the document
   * the stack reads — the pieces on screen are derived, and editing them would be
   * editing a result.
   */
  setCookedPattern(copy: PatternDocument): void {
    this.setPattern(copy, { preserveView: true, cooked: true });
  }

  /** Whether the editor is showing the stack's output rather than the document. */
  isCooked(): boolean {
    return this.readOnly;
  }

  private setReadOnly(on: boolean): void {
    this.readOnly = on;
    this.root.classList.toggle('is-readonly', on);
  }

  /**
   * Replace the document's geometry with the cooked stack.
   *
   * Only ever called on a copy: the stack itself, the notes, the images and the
   * rulers come along untouched — it is the pieces and the seams between them
   * that a cook rewrites.
   */
  private cookIntoDocument(): void {
    const result = cookPattern(this.pattern);
    // Point and piece ids may have changed under a cut, so nothing can stay picked.
    this.selectedPieceId = null;
    this.clearSelection();
    this.pattern.pieces = result.pieces;
    this.pattern.seams = result.seams;
  }

  /** The visible pattern-space rectangle (the editor's zoom/pan), for history. */
  getViewBox(): { x: number; y: number; w: number; h: number } {
    return { ...this.effectiveViewBox() };
  }

  /** Restore a saved visible rectangle verbatim — view state, not document. */
  setViewBox(box: { x: number; y: number; w: number; h: number }): void {
    // A locked container has no view of its own to restore: it shows the frame.
    if (this.container?.locked) return;
    this.viewBox = { ...box };
    this.redraw();
  }

  /** Put this pattern behind a container frame, or take it out of one. */
  setContainer(mode: PatternEditorContainer | null): void {
    // The host re-states the frame on every board pan, and almost every one of
    // those leaves it identical; redrawing for those would be the whole cost of
    // panning the canvas.
    if (sameContainerMode(this.container, mode)) return;
    this.container = mode;
    // `redraw` re-applies the clip, so the frame's own box is up to date too.
    this.redraw();
  }

  /**
   * Restate the frame for a host scale that is still moving, repainting only once
   * the difference would show.
   *
   * Zooming the canvas changes nothing about a container's drawing except the size
   * of its chrome: the geometry is centimetres, and the host's transform scales it
   * exactly. So a gesture that crosses fifty scales — the board zooms tenfold, and
   * a trackpad sends several events a frame — does not need fifty repaints of
   * every pattern on the page. It needs one at the end; until then the drawn
   * chrome is within `tolerance` of right, which at a quarter is a 2px stroke
   * drawn as 1.6px, or as 2.5px, while everything on the canvas is moving anyway.
   */
  restateContainer(mode: PatternEditorContainer | null, tolerance: number): void {
    const previous = this.container;
    if (sameContainerMode(previous, mode)) return;
    this.container = mode;
    // A different frame, or a different amount of it, is a different drawing.
    if (!sameContainerShape(previous, mode)) {
      this.redraw();
      return;
    }
    const drawn = this.drawnChromeScale;
    const now = this.chromeScale();
    const drift = now > drawn ? now / drawn : drawn / now;
    if (drift < tolerance) return;
    this.redraw();
  }

  /** Catch up chrome a `restateContainer` deliberately left trailing. */
  settleContainer(): void {
    if (this.drawnChromeScale === this.chromeScale()) return;
    this.redraw();
  }

  /**
   * The host's CSS scale, which the fixed-size chrome is divided by. See
   * `PatternEditorContainer.chromeScale`.
   */
  private chromeScale(): number {
    const scale = this.container?.chromeScale;
    return scale && scale > 0 ? scale : 1;
  }

  /**
   * What to draw right now. Any tool but the move tool is a reason to see
   * everything: a cut, a ruler, a pen and a sewing run all work from the
   * geometry and its marks, and a press with one of them in hand is meant to land
   * on the pattern — so picking one up brings the whole drawing back.
   */
  private detail(): PatternDetail {
    if (this.tool !== 'move') return 'full';
    return this.container?.detail ?? 'full';
  }

  /**
   * The box actually drawn. A locked container is its frame: the element's size
   * in centimetres, anchored at the container's view origin. Everything else —
   * including an expanded container — is the editor's own zoom and pan.
   */
  private effectiveViewBox(): { x: number; y: number; w: number; h: number } {
    const container = this.container;
    if (!container || !container.locked) return this.viewBox;
    const w = this.svg.clientWidth / container.cmScale;
    const h = this.svg.clientHeight / container.cmScale;
    // Layout may not have settled yet; a zero-width box would blank the drawing.
    if (!(w > 0) || !(h > 0)) return this.viewBox;
    return { x: container.viewX, y: container.viewY, w, h };
  }

  /**
   * Clipping. A container that clips hides whatever is outside its frame: the
   * element's own overflow covers the part that runs past the drawing area, and
   * when the view reaches beyond the frame (an expanded container) the frame's
   * rectangle is cut out of the viewport as well — leaving the ribbons alone.
   */
  private applyContainerClip(): void {
    const container = this.container;
    if (!container) {
      this.svg.style.overflow = '';
      this.viewport.style.clipPath = '';
      return;
    }
    this.svg.style.overflow = container.clip ? 'hidden' : 'visible';
    if (!container.clip || container.locked) {
      // Frame-sized view: the element *is* the frame, so there is nothing left
      // to cut out of it.
      this.viewport.style.clipPath = '';
      return;
    }
    const { x, y, w, h } = this.viewBox;
    const scale = Math.min(
      this.svg.clientWidth / w,
      this.svg.clientHeight / h
    );
    if (!(scale > 0) || !Number.isFinite(scale)) {
      this.viewport.style.clipPath = '';
      return;
    }
    // The SVG letterboxes, so the frame's rectangle is offset as well as scaled.
    const left = (container.viewX - x) * scale + (this.svg.clientWidth - w * scale) / 2;
    const top = (container.viewY - y) * scale + (this.svg.clientHeight - h * scale) / 2;
    const right = this.svg.clientWidth - (left + container.frameWidthCm * scale);
    const bottom = this.svg.clientHeight - (top + container.frameHeightCm * scale);
    this.viewport.style.clipPath = `inset(${Math.max(0, top)}px ${Math.max(
      0,
      right
    )}px ${Math.max(0, bottom)}px ${Math.max(0, left)}px)`;
  }

  /** The container's frame, drawn where it sits once the container is opened up. */
  private drawContainerFrame(): SVGGElement {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'pattern-container-frame');
    const container = this.container;
    if (!container || container.locked) return group;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(container.viewX));
    rect.setAttribute('y', String(container.viewY));
    rect.setAttribute('width', String(container.frameWidthCm));
    rect.setAttribute('height', String(container.frameHeightCm));
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke-width', String(this.px(1)));
    rect.setAttribute(
      'stroke-dasharray',
      `${this.px(6)} ${this.px(4)}`
    );
    group.appendChild(rect);
    return group;
  }

  /** Repaint without touching the pattern — the host moved or changed data. */
  refresh(): void {
    this.redraw();
  }

  /** The element this editor was mounted in — its host, not the drawing. */
  element(): HTMLElement {
    return this.root;
  }

  /**
   * Is a pointer gesture under way in this editor?
   *
   * A host that also watches the same press needs to know whether the editor took
   * it: on the canvas, the page sits under the frames, so a drag on empty space is
   * the page's marquee *unless* the tool in hand is doing something else.
   */
  isGestureActive(): boolean {
    return this.drag !== null;
  }

  /**
   * Where the pattern is drawn inside the host, in layout pixels. A host may
   * carry chrome (a rail) beside the drawing, and a locked container's view is
   * written against the drawing rather than against the host's own corner.
   */
  viewOriginInHost(): { x: number; y: number } {
    const view = this.svg.getBoundingClientRect();
    const root = this.root.getBoundingClientRect();
    return { x: view.left - root.left, y: view.top - root.top };
  }

  /**
   * Move and scale the drawing without redrawing it.
   *
   * A host that is zooming the board wants the drawing to follow the zoom, and
   * repainting it for every step of a gesture is work the next step throws away —
   * so it hands the whole move over as one transform instead. Only the two layers
   * that *are* the drawing are transformed; the rail, the ribbons and the popovers
   * are chrome pinned in screen pixels, and stay where they are.
   *
   * Read `viewOriginInHost()` before the first transform and hold on to it: it is
   * measured from layout, so it reports the transformed position once this is in
   * place. Pass `null` to put the drawing back, and read it again after that.
   */
  setGestureTransform(transform: string | null): void {
    for (const layer of [this.svg, this.avatarSvg]) {
      if (transform) {
        layer.style.transformOrigin = '0 0';
        layer.style.transform = transform;
      } else {
        layer.style.transform = '';
        layer.style.transformOrigin = '';
      }
    }
  }

  /** Reload avatar silhouette after the studio avatar mesh/prefs change. */
  reloadAvatarOverlay(): void {
    if (!this.avatarOverlayOn) return;
    void this.refreshAvatarOverlayPath();
  }

  /**
   * Called when the body-measurement library changes: rulers read their person
   * and measurement live, so their lengths and labels need a repaint.
   */
  reloadRulers(): void {
    this.syncRulerBar();
    this.redraw();
  }

  getPattern(): PatternDocument {
    return this.pattern;
  }

  setTool(tool: PatternTool): void {
    this.tool = tool;
    if (tool !== 'add') {
      this.penStrokeId = null;
      this.hideSettingsMenus();
    }
    if (tool !== 'sew') {
      this.pendingSeam = null;
      this.hoverEdge = null;
      this.clearMultiSew();
    }
    // Modify's three jobs each keep a draft of their own, and none of them
    // survives walking away from it.
    if (tool !== 'modify' || this.modifyMode !== 'extrude') this.extrudeHover = null;
    if (tool !== 'modify' || this.modifyMode !== 'join') {
      this.hoverEdge = null;
      this.clearJoin();
    }
    if (tool !== 'modify' || this.modifyMode !== 'bridge') {
      this.hoverEdge = null;
      this.clearBridge();
    }
    if (tool !== 'cut') {
      this.cutLoop = null;
      this.cutInset = null;
      this.clearCutDraft();
    }
    // Changing tools is walking away from anything in hand: a simplify preview
    // belongs to the tool it was started from.
    if (this.simplify) this.cancelSimplify();
    if (tool !== 'ruler') {
      this.hideSettingsMenus();
      // A measurement armed for the ruler is meaningless elsewhere.
      this.rulerArmed = null;
    }
    if (!this.isRuler('measure')) {
      // The measurement itself is document data and stays; this only drops the
      // session that was still adding to it.
      this.dropMeasureSession();
    }
    if (!this.measureInteractive()) this.measureHoverId = null;
    // A tether belongs to the Move tool in hand: walking away drops it.
    if (tool !== 'move') this.clearOrbit();
    this.syncRulerToolbar();
    this.syncMeasureBar();
    // Rulers and measurements are only interactive under the tools that work on
    // them; drop the inspector rather than leaving an invisible selection behind.
    if (tool !== 'ruler' && tool !== 'move') {
      this.selectedRulerId = null;
      this.hoverRulerId = null;
      this.syncRulerBar();
    }
    this.syncCutToolbar();
    this.syncSewToolbar();
    this.syncJoinToolbar();
    this.syncBridgeToolbar();
    for (const btn of Array.from(this.toolbar.querySelectorAll('button[data-tool]'))) {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === tool);
    }
    this.syncToolRail();
    this.applyCursor(null);
    this.redraw();
  }

  /** Cursor the active tool uses when nothing is under the pointer. */
  private baseCursor(): string {
    // Everything but Move works on the pattern rather than on what is already
    // picked, so it all reads as a crosshair.
    return this.tool === 'move' ? 'default' : 'crosshair';
  }

  /**
   * The one place the canvas cursor is decided, so hover feedback cannot fight
   * itself: a ruler in hand outranks the rotate zone, which outranks the tool's
   * own cursor.
   */
  private applyCursor(over: 'ruler' | 'rotate' | null): void {
    const next =
      over === 'rotate' ? ROTATE_CURSOR : over === 'ruler' ? 'move' : this.baseCursor();
    if (this.svg.style.cursor !== next) this.svg.style.cursor = next;
  }

  private setSewMode(mode: SewMode): void {
    // Choosing a mode puts away any dropdown opened from it.
    this.hideSettingsMenus();
    if (this.sewMode !== mode) {
      this.pendingSeam = null;
      this.clearMultiSew();
    }
    this.sewMode = mode;
    this.syncSewToolbar();
    this.redraw();
  }

  /** The ribbon carries the mode, so this keeps it, the bar and the rail current. */
  private syncSewToolbar(): void {
    this.syncSewBar();
    this.syncToolRail();
    this.syncToolSettings();
  }

  /**
   * The ribbon's dropdowns, beside the modes of the tool that owns them. One at
   * a time, closed by anything else being clicked or by the key that would take
   * another tool up.
   */
  private toggleSettingsMenu(which: SettingsMenuKey): void {
    const open = this.settingsMenuOpen === which ? null : which;
    this.hideSettingsMenus();
    if (!open) return;
    const popover = this.settingsPopover(open);
    if (!popover) return;
    if (open === 'block') {
      // Built fresh each time it opens: the library it lists is the one loaded
      // now.
      popover.innerHTML = '';
      this.renderBlockMenu(popover);
    }
    if (open === 'measurement') {
      this.renderRulerMenu();
      // Focus so you can type straight away; selecting means a new query
      // replaces the old one instead of appending to it.
      this.rulerSearchInput.focus();
      this.rulerSearchInput.select();
    }
    popover.hidden = false;
    this.settingsMenuOpen = open;
    this.settingsMenuBtn(open)?.setAttribute('aria-expanded', 'true');
    // Its popover floats over the panels below the ribbon, so the ribbon has to
    // come up over them while one is open — they share the same corner.
    this.toolSettings.classList.add('is-menu-open');
  }

  private hideSettingsMenus(): void {
    if (!this.settingsMenuOpen) return;
    this.settingsPopover(this.settingsMenuOpen)!.hidden = true;
    this.settingsMenuBtn(this.settingsMenuOpen)?.setAttribute('aria-expanded', 'false');
    this.settingsMenuOpen = null;
    this.toolSettings.classList.remove('is-menu-open');
  }

  private settingsPopover(which: SettingsMenuKey): HTMLElement | null {
    return this.toolSettings.querySelector(`[data-menu-popover="${which}"]`);
  }

  private settingsMenuBtn(which: SettingsMenuKey): HTMLButtonElement | null {
    return this.toolSettings.querySelector(`button[data-menu-open="${which}"]`);
  }

  /** A click anywhere else, or a keystroke that is not in the popover, closes it. */
  private bindSettingsMenuDismiss(): void {
    if (this.settingsMenuDocPointerDown) return;
    this.settingsMenuDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (this.toolSettings.contains(target)) return;
      this.hideSettingsMenus();
    };
    document.addEventListener('pointerdown', this.settingsMenuDocPointerDown, true);
  }

  /**
   * Free carries whatever is picked anywhere; Orbit tethers one point to another
   * and swings it. Picking Orbit clears any earlier tether: the picks belong to
   * the mode that made them.
   */
  private setMoveMode(mode: MoveMode): void {
    this.hideSettingsMenus();
    if (mode !== this.moveMode) this.clearOrbit();
    this.moveMode = mode;
    if (this.tool !== 'move') {
      this.setTool('move');
      return;
    }
    this.syncToolSettings();
    this.syncToolRail();
    this.redraw();
  }

  /** Drop the tether, and the point waiting for one. */
  private clearOrbit(): void {
    this.orbitPickId = null;
    this.orbit = null;
  }

  /**
   * Whether the Add tool can place this kind of object here.
   *
   * The shapes and the pen are the pattern's own work and are always on offer.
   * Text, images and sections are objects the *host* owns, so they need a host
   * that can take one — and one that can take *this* one, since a pattern opened
   * full screen has somewhere to put a note or a reference image but nowhere to
   * put a section.
   */
  private canPlaceObject(mode: AddMode): boolean {
    if (mode !== 'text' && mode !== 'section' && mode !== 'image') return true;
    if (!this.cbs.onAddObject) return false;
    return this.cbs.canPlaceObject ? this.cbs.canPlaceObject(mode) : true;
  }

  private setAddMode(mode: AddMode): void {
    // Choosing a mode puts away any dropdown opened from it.
    this.hideSettingsMenus();
    this.addMode = mode;
    // A pen stroke belongs to the mode that started it.
    this.penStrokeId = null;
    if (this.tool !== 'add') {
      this.setTool('add');
      return;
    }
    this.syncToolSettings();
    this.syncToolRail();
    this.redraw();
  }

  /**
   * Pick a mode of the Modify tool and take it up — Extrude, Join or Bridge —
   * the way Add and Cut work.
   */
  private setModifyMode(mode: ModifyMode): void {
    // Choosing a mode puts away any dropdown opened from it.
    this.hideSettingsMenus();
    if (mode !== this.modifyMode) {
      // A draft belongs to the mode that started it, hover included.
      this.hoverEdge = null;
      this.extrudeHover = null;
      this.clearJoin();
      this.clearBridge();
    }
    this.modifyMode = mode;
    if (this.tool !== 'modify') {
      this.setTool('modify');
      return;
    }
    this.syncModifyToolbar();
    this.redraw();
  }

  /** True while the Modify tool is the one in hand and it is on `mode`. */
  private isModify(mode: ModifyMode): boolean {
    return this.tool === 'modify' && this.modifyMode === mode;
  }

  /**
   * Pick a mode of the Ruler tool and take it up — the rule, or the measure
   * line — the way Add, Modify and Cut work.
   */
  private setRulerMode(mode: RulerMode): void {
    // The measurement picker belongs to the ruler it arms.
    this.hideSettingsMenus();
    if (mode !== this.rulerMode) {
      // A session belongs to the mode that started it: the measure line's draft
      // to the measure line, an armed body measurement to the ruler.
      if (this.rulerMode === 'measure') this.dropMeasureSession();
      else this.rulerArmed = null;
    }
    this.rulerMode = mode;
    if (this.tool !== 'ruler') {
      this.setTool('ruler');
      return;
    }
    this.syncRulerToolbar();
    this.syncMeasureBar();
    this.redraw();
  }

  /** True while the Ruler tool is the one in hand and it is on `mode`. */
  private isRuler(mode: RulerMode): boolean {
    return this.tool === 'ruler' && this.rulerMode === mode;
  }

  /** Drop the measurement being built — document data it made stays put. */
  private dropMeasureSession(): void {
    this.measureDraftId = null;
    this.measureChainTail = null;
    this.measureHoverId = null;
    this.measureSelection.clear();
  }

  /** The bar and the settings ribbon belong to the same hand. */
  private syncModifyToolbar(): void {
    this.syncJoinBar();
    this.syncBridgeBar();
    this.syncToolRail();
  }

  private setCutMode(mode: CutMode): void {
    // Choosing a mode puts away any dropdown opened from it.
    this.hideSettingsMenus();
    this.cutMode = mode;
    this.cutNotice = null;
    this.clearCutDraft();
    if (this.tool !== 'cut') {
      this.setTool('cut');
      return;
    }
    this.syncCutToolbar();
    this.redraw();
  }

  private clearCutDraft(): void {
    this.cutChain = [];
    this.cutChainHover = null;
    this.cutChainRefusal = null;
    this.cutInset = null;
  }

  /** The rail button carries the mode's name; the ribbon carries the mode. */
  private syncCutToolbar(): void {
    this.syncToolRail();
    this.syncToolSettings();
    const btn = this.cutBtn;
    if (btn) btn.dataset.tip = CUT_TIPS[this.cutMode];
  }

  private ensureTipEl(): HTMLDivElement {
    if (!this.tipEl) {
      const el = document.createElement('div');
      el.className = 'pattern-toolbar-tip';
      el.hidden = true;
      document.body.appendChild(el);
      this.tipEl = el;
    }
    return this.tipEl;
  }

  private hideToolbarTip(): void {
    if (this.tipEl) this.tipEl.hidden = true;
  }

  private showToolbarTip(anchor: HTMLElement): void {
    const text = anchor.dataset.tip ?? '';
    if (!text) return;
    const tip = this.ensureTipEl();
    tip.textContent = text;
    tip.hidden = false;
    tip.style.visibility = 'hidden';
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const r = anchor.getBoundingClientRect();
    const pad = 6;
    let left = r.right + pad;
    if (left + tw > window.innerWidth - pad) left = Math.max(pad, r.left - tw - pad);
    let top = r.top + r.height / 2 - th / 2;
    top = Math.max(pad, Math.min(top, window.innerHeight - th - pad));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = 'visible';
  }

  private bindToolbarTips(): void {
    // Every rail button, not only the ones with a tip written into the markup:
    // the tools' tips name the mode they are set to, so they are written by
    // `syncToolRail` as the mode changes. A button with no tip shows nothing.
    this.toolbar.querySelectorAll('button[data-tip], button[data-tool]').forEach((btn) => {
      const el = btn as HTMLElement;
      el.addEventListener('mouseenter', () => this.showToolbarTip(el));
      el.addEventListener('mouseleave', () => this.hideToolbarTip());
      el.addEventListener('focus', () => this.showToolbarTip(el));
      el.addEventListener('blur', () => this.hideToolbarTip());
    });
    this.toolbar.addEventListener('pointerdown', () => this.hideToolbarTip());
  }

  private clearSelection(): void {
    this.selectedIds.clear();
    this.selectedPointId = null;
    this.releaseBlockSelection();
  }

  private setSelection(ids: string[], primary?: string | null): void {
    this.selectedIds = new Set(ids);
    this.selectedPointId = primary ?? ids[ids.length - 1] ?? null;
    this.releaseBlockSelection();
  }

  private selectOnly(pointId: string, pieceId?: string): void {
    this.selectedIds = new Set([pointId]);
    this.selectedPointId = pointId;
    if (pieceId) this.selectedPieceId = pieceId;
    this.releaseBlockSelection();
  }

  /**
   * Ids of the pieces with at least one picked point, primary piece first.
   * This is what the split view mirrors onto the 3D selection.
   */
  getSelectedPieces(): string[] {
    const ids: string[] = [];
    for (const piece of this.pattern.pieces) {
      if (pieceRings(piece).some((ring) => ring.some((pt) => this.selectedIds.has(pt.id)))) {
        ids.push(piece.id);
      }
    }
    const primary = this.selectedPieceId;
    if (primary && ids.includes(primary) && ids[0] !== primary) {
      ids.splice(ids.indexOf(primary), 1);
      ids.unshift(primary);
    }
    return ids;
  }

  /** Select whole pieces by id — the 3D → 2D half of the split view's sync. */
  setSelectedPieces(pieceIds: readonly string[], primary?: string | null): void {
    const wanted = new Set(pieceIds);
    this.selectedIds = new Set(
      this.pattern.pieces
        .filter((piece) => wanted.has(piece.id))
        .flatMap((piece) => piece.points.map((pt) => pt.id))
    );
    this.selectedPointId = null;
    this.selectedPieceId = primary ?? pieceIds[0] ?? null;
    this.releaseBlockSelection();
    this.redraw();
  }

  /**
   * Drop the block selection once the pieces it describes are no longer picked.
   *
   * The block controls edit a block, and they have nothing to say about a
   * selection that has moved on to something else — a ribbon left up over a
   * piece you deselected reads as though the two are still connected. Run after
   * every change to the picked points rather than at each call site, so no path
   * can forget it.
   */
  private releaseBlockSelection(): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    const owned = new Set(instance.pieces.map((entry) => entry.pieceId));
    const stillPicked = this.pattern.pieces.some(
      (piece) =>
        owned.has(piece.id) &&
        pieceRings(piece).some((ring) => ring.some((pt) => this.selectedIds.has(pt.id)))
    );
    if (!stillPicked) this.setSelectedBlock(null);
  }

  private activePiece(): PatternPiece | null {
    return this.pattern.pieces.find((p) => p.id === this.selectedPieceId) ?? this.pattern.pieces[0] ?? null;
  }

  private fitView(): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let found = false;
    for (const piece of this.pattern.pieces) {
      if (piece.points.length === 0) continue;
      const poly = pieceToPolyline(piece.points, piece.closed);
      for (const p of poly) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
        found = true;
      }
    }
    if (!found) {
      this.viewBox = { x: -5, y: -5, w: 60, h: 70 };
      return;
    }
    const pad = 8;
    this.viewBox = {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(maxX - minX + pad * 2, 20),
      h: Math.max(maxY - minY + pad * 2, 20),
    };
  }

  private async beginSvgImport(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch {
      this.showSvgImportDialog({
        pieces: [],
        widthCm: 0,
        heightCm: 0,
        cmPerUserUnit: 1,
        warnings: [],
        error: `Could not read “${file.name}”`,
      });
      return;
    }
    const result = parseSvgToPieces(text, { scale: 1 });
    this.showSvgImportDialog(result, file.name);
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private closeSvgImportDialog(): void {
    this.pendingSvgImport = null;
    if (this.importDialog) {
      this.importDialog.remove();
      this.importDialog = null;
    }
  }

  private showSvgImportDialog(result: SvgImportResult, fileName = 'SVG'): void {
    this.closeSvgImportDialog();
    this.pendingSvgImport = result;

    const dlg = document.createElement('div');
    dlg.className = 'pattern-import-dialog-root';
    const canImport = result.pieces.length > 0 && !result.error;
    const warnHtml =
      result.warnings.length > 0
        ? `<ul class="pattern-import-warnings">${result.warnings
            .map((w) => `<li>${this.escapeHtml(w)}</li>`)
            .join('')}</ul>`
        : '';
    const errHtml = result.error
      ? `<p class="pattern-import-error">${this.escapeHtml(result.error)}</p>`
      : '';
    const sizeLabel =
      result.widthCm > 0 && result.heightCm > 0
        ? `${formatLength(result.widthCm, this.unit)} × ${formatLength(result.heightCm, this.unit)}`
        : '—';

    dlg.innerHTML = `
      <div class="pattern-import-backdrop" data-import-dismiss>
        <div class="pattern-import-dialog" role="dialog" aria-labelledby="patternImportTitle">
          <div class="pattern-import-header">
            <h3 id="patternImportTitle">Import SVG</h3>
            <button type="button" class="pattern-import-close" data-import-close aria-label="Close">×</button>
          </div>
          <p class="muted pattern-import-file">${this.escapeHtml(fileName)}</p>
          ${errHtml}
          <div class="pattern-import-meta">
            <div><span class="muted">Pieces</span><strong>${result.pieces.length}</strong></div>
            <div><span class="muted">Detected size</span><strong data-import-size>${this.escapeHtml(sizeLabel)}</strong></div>
          </div>
          <label class="pattern-import-scale">
            <span>Scale %</span>
            <input type="number" data-import-scale min="1" max="10000" step="1" value="100" ${canImport ? '' : 'disabled'} />
          </label>
          <p class="muted pattern-import-scale-hint">100% keeps the physical SVG size (width/height units, or px @ 96 DPI).</p>
          ${warnHtml}
          <div class="pattern-import-actions">
            <button type="button" data-import-cancel>Cancel</button>
            <button type="button" class="primary" data-import-confirm ${canImport ? '' : 'disabled'}>Import</button>
          </div>
        </div>
      </div>
    `;
    this.root.appendChild(dlg);
    this.importDialog = dlg;

    const scaleInput = dlg.querySelector('[data-import-scale]') as HTMLInputElement | null;
    const sizeEl = dlg.querySelector('[data-import-size]') as HTMLElement | null;
    const updateSizePreview = () => {
      if (!sizeEl || !(result.widthCm > 0)) return;
      const pct = Math.max(1, Number(scaleInput?.value) || 100);
      const f = pct / 100;
      sizeEl.textContent = `${formatLength(result.widthCm * f, this.unit)} × ${formatLength(result.heightCm * f, this.unit)}`;
    };
    scaleInput?.addEventListener('input', updateSizePreview);

    const dismiss = () => this.closeSvgImportDialog();
    const confirm = () => {
      if (!canImport) return;
      const pct = Math.max(1, Number(scaleInput?.value) || 100);
      this.commitSvgImport(pct / 100);
    };
    dlg.querySelector('[data-import-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) dismiss();
    });
    dlg.querySelector('[data-import-close]')?.addEventListener('click', dismiss);
    dlg.querySelector('[data-import-cancel]')?.addEventListener('click', dismiss);
    dlg.querySelector('[data-import-confirm]')?.addEventListener('click', confirm);
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && canImport) {
        e.preventDefault();
        confirm();
      }
    });
    scaleInput?.focus();
    scaleInput?.select();
  }

  private commitSvgImport(scaleFactor: number): void {
    const pending = this.pendingSvgImport;
    if (!pending || pending.pieces.length === 0) {
      this.closeSvgImportDialog();
      return;
    }
    const pieces =
      Math.abs(scaleFactor - 1) < 1e-9
        ? pending.pieces
        : scalePieces(pending.pieces, scaleFactor);
    this.closeSvgImportDialog();
    this.markBeforeChange();
    const ids: string[] = [];
    for (const piece of pieces) {
      this.pattern.pieces.push(piece);
      for (const pt of piece.points) ids.push(pt.id);
    }
    this.selectedPieceId = pieces[0]?.id ?? this.selectedPieceId;
    this.setSelection(ids);
    this.fitView();
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    // The lock is the last word on zoom: every path that moves the level comes
    // through here, so it only has to be checked once.
    if (this.zoomLocked) return;
    const before = this.svgPointFromClient(clientX, clientY);
    this.viewBox.w = Math.min(MAX_VIEW_WIDTH, Math.max(MIN_VIEW_WIDTH, this.viewBox.w * factor));
    this.viewBox.h = Math.min(MAX_VIEW_WIDTH, Math.max(MIN_VIEW_WIDTH, this.viewBox.h * factor));
    this.redraw();
    const after = this.svgPointFromClient(clientX, clientY);
    this.viewBox.x += before.x - after.x;
    this.viewBox.y += before.y - after.y;
    this.redraw();
  }

  /** The zoom the current view stands for, as a percent of the default framing. */
  private zoomPercent(): number {
    return Math.round((ZOOM_BASE_WIDTH / this.viewBox.w) * 100);
  }

  /** Zoom about the middle of the viewport, the way a typed value should feel. */
  private zoomByFactor(factor: number): void {
    if (Math.abs(factor - 1) < 1e-6) return;
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  /** Set the zoom to a percent of the default framing, keeping the view centred. */
  private setZoomPercent(percent: number): void {
    if (!Number.isFinite(percent)) return;
    const width = ZOOM_BASE_WIDTH * (100 / percent);
    const clamped = Math.min(MAX_VIEW_WIDTH, Math.max(MIN_VIEW_WIDTH, width));
    this.zoomByFactor(clamped / this.viewBox.w);
  }

  private setZoomLocked(on: boolean): void {
    this.zoomLocked = on;
    this.zoomLockBtn.classList.toggle('active', on);
    this.zoomLockBtn.setAttribute('aria-pressed', String(on));
    // Shut, the menu cannot show the lock, so the button that opens it does.
    this.viewBtn.classList.toggle('is-locked', on);
    this.viewBtn.title = on ? 'View settings · zoom locked' : 'View settings';
    this.zoomMenu.classList.toggle('is-locked', on);
    this.zoomInput.disabled = on;
    // The lock row itself stays live — it is the way back out.
    this.zoomMenu.querySelectorAll('button[data-zoom-act]').forEach((btn) => {
      const el = btn as HTMLButtonElement;
      if (el.dataset.zoomAct === 'lock') return;
      el.disabled = on;
    });
    this.hideToolbarTip();
    this.syncZoomControl();
  }

  private setHiconEnabled(on: boolean): void {
    this.hiconOn = on;
    this.hiconBtn.classList.toggle('active', on);
    this.hiconBtn.setAttribute('aria-pressed', String(on));
    this.root.classList.toggle('is-hicon', on);
    this.redraw();
  }

  /**
   * Show or hide the grainlines. The marks are in the document either way — this
   * is only whether the sheet carries them.
   */
  private setGrainEnabled(on: boolean): void {
    this.grainOn = on;
    this.grainBtn.classList.toggle('active', on);
    this.grainBtn.setAttribute('aria-pressed', String(on));
    this.redraw();
  }

  private bindZoomMenu(): void {
    this.zoomMenu.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button[data-zoom-act]')?.getAttribute(
        'data-zoom-act'
      );
      if (!act) return;
      e.preventDefault();
      this.onZoomAction(act);
    });
    this.zoomInput.addEventListener('change', () => {
      const value = Number.parseFloat(this.zoomInput.value);
      this.setZoomPercent(value);
      this.syncZoomControl();
    });
    this.zoomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.zoomInput.blur();
      }
    });
  }

  /**
   * The view menu in the rail's corner. It stays open while its toggles are
   * flipped — they are the kind of setting you try two of in a row — and closes
   * on a press outside, on Escape, or on the button again.
   */
  private bindViewMenu(): void {
    const btn = this.viewBtn;
    const menu = this.viewMenu;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideToolbarTip();
      this.setViewMenuOpen(menu.hidden);
    });
  }

  private setViewMenuOpen(open: boolean): void {
    this.viewMenu.hidden = !open;
    this.viewBtn.setAttribute('aria-expanded', String(open));
    this.viewBtn.classList.toggle('is-open', open);
    if (!open) {
      this.closeViewMenu();
      return;
    }
    this.syncZoomControl();
    if (this.viewMenuDocPointerDown) return;
    this.viewMenuDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (this.viewMenu.contains(target) || this.viewBtn.contains(target)) return;
      this.closeViewMenu();
    };
    document.addEventListener('pointerdown', this.viewMenuDocPointerDown, true);
  }

  private closeViewMenu(): void {
    this.viewMenu.hidden = true;
    this.viewBtn.setAttribute('aria-expanded', 'false');
    this.viewBtn.classList.remove('is-open');
    if (this.viewMenuDocPointerDown) {
      document.removeEventListener('pointerdown', this.viewMenuDocPointerDown, true);
      this.viewMenuDocPointerDown = null;
    }
  }

  private onZoomAction(act: string): void {
    if (act === 'lock') {
      this.setZoomLocked(!this.zoomLocked);
      return;
    }
    if (this.zoomLocked) return;
    if (act === 'in') this.setZoomPercent(this.zoomPercent() + 1);
    else if (act === 'out') this.setZoomPercent(this.zoomPercent() - 1);
    else if (act === 'fit') {
      this.fitView();
      this.redraw();
    }
    this.syncZoomControl();
  }

  /**
   * The zoom control's readout. `redraw` calls it, so panning, framing and a
   * resized viewport all keep it honest without threading a call through each.
   */
  private syncZoomControl(): void {
    const pct = this.zoomPercent();
    const sig = `${pct}|${this.zoomLocked}`;
    if (sig === this.lastZoomSig) return;
    this.lastZoomSig = sig;
    this.zoomInput.value = String(pct);
    this.zoomHint.textContent = this.zoomLocked ? 'Locked' : '';
  }

  private setXrayEnabled(on: boolean): void {
    this.xrayOn = on;
    this.xrayBtn.classList.toggle('active', on);
    this.xrayBtn.setAttribute('aria-pressed', String(on));
    this.xrayBar.hidden = !on;
    this.root.classList.toggle('is-xray', on);
    if (on) {
      this.xrayOpacityInput.value = String(Math.round(this.xrayOpacity * 100));
    }
    this.applyXrayStyles();
  }

  /**
   * Seam allowance on screen: every piece draws the line its allowance makes,
   * and the move tool picks edges so each one can be given its own value. Off is
   * exactly the old behaviour — no line, no picking.
   */
  private setSeamAllowanceEnabled(on: boolean): void {
    this.allowanceOn = on;
    this.allowanceBtn.classList.toggle('active', on);
    this.allowanceBtn.setAttribute('aria-pressed', String(on));
    this.root.classList.toggle('is-allowance', on);
    if (!on) {
      this.allowanceHover = null;
      this.allowanceEdge = null;
    }
    this.redraw();
  }

  /** The edge the allowance ribbon is showing, or null to put the ribbon away. */
  private setAllowanceEdge(next: { pieceId: string; edgeIndex: number } | null): void {
    if (
      this.allowanceEdge?.pieceId === next?.pieceId &&
      this.allowanceEdge?.edgeIndex === next?.edgeIndex
    ) {
      return;
    }
    this.allowanceEdge = next;
    this.redraw();
  }

  private allowancePiece(): PatternPiece | null {
    const sel = this.allowanceEdge;
    if (!sel) return null;
    return this.pattern.pieces.find((piece) => piece.id === sel.pieceId) ?? null;
  }

  /** A field value in the canvas' unit, as cm. Null when it is not a number. */
  private allowanceValueOf(raw: string): number | null {
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) return null;
    return displayToCm(value, this.unit);
  }

  private applyAllowanceInput(
    input: HTMLInputElement,
    apply: (piece: PatternPiece, cm: number) => void
  ): void {
    const piece = this.allowancePiece();
    const cm = this.allowanceValueOf(input.value);
    if (!piece || cm == null) return;
    this.markBeforeChange();
    apply(piece, cm);
    this.endHistoryGesture();
    // Not `onChange`: the allowance is a drafting reference like a ruler, and
    // must not invalidate the mesh the drape was built from.
    this.notifyReferenceChange();
    this.redraw();
  }

  private setSeamConnectorsEnabled(on: boolean): void {
    this.seamConnectorsOn = on;
    this.seamLinksBtn.classList.toggle('active', on);
    this.seamLinksBtn.setAttribute('aria-pressed', String(on));
    this.redraw();
  }

  private applyXrayStyles(): void {
    const pct = Math.round(this.xrayOpacity * 100);
    const valEl = this.xrayBar.querySelector('[data-xray-opacity-val]');
    if (valEl) valEl.textContent = `${pct}%`;
    this.root.style.setProperty('--pattern-xray-opacity', this.xrayOn ? String(this.xrayOpacity) : '1');
  }

  private async setAvatarOverlayEnabled(on: boolean): Promise<void> {
    this.avatarOverlayOn = on;
    this.avatarToggleBtn.classList.toggle('active', on);
    this.avatarToggleBtn.setAttribute('aria-pressed', String(on));
    this.avatarBar.hidden = !on;
    if (!on) {
      this.avatarOverlayPath = '';
      this.avatarOverlayError = null;
      this.syncAvatarSvg();
      return;
    }
    await this.refreshAvatarOverlayPath();
  }

  private async refreshAvatarOverlayPath(): Promise<void> {
    if (!this.avatarOverlayOn) return;
    this.avatarOverlayLoading = true;
    this.avatarOverlayError = null;
    this.syncAvatarBarHint();
    try {
      const source = await ensureAvatarOverlaySource();
      if (!this.avatarOverlayOn) return;
      this.avatarOverlayPath = buildAvatarOverlayPath(source, this.avatarOverlayView);
    } catch (err) {
      this.avatarOverlayPath = '';
      this.avatarOverlayError = err instanceof Error ? err.message : 'Failed to load avatar';
    } finally {
      this.avatarOverlayLoading = false;
      this.syncAvatarBarHint();
      this.syncAvatarSvg();
    }
  }

  private syncAvatarBarHint(): void {
    const hint = this.avatarBar.querySelector('.pattern-avatar-bar-hint');
    if (!hint) return;
    if (this.avatarOverlayLoading) hint.textContent = 'Loading…';
    else if (this.avatarOverlayError) hint.textContent = this.avatarOverlayError;
    else hint.textContent = '15% · true scale (cm)';
  }

  private syncAvatarSvg(): void {
    const { x, y, w, h } = this.effectiveViewBox();
    this.avatarSvg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.avatarSvg.innerHTML = '';
    if (!this.avatarOverlayOn || !this.avatarOverlayPath) return;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute(
      'transform',
      `translate(${this.avatarOffsetX} ${this.avatarOffsetY})`
    );
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', this.avatarOverlayPath);
    path.setAttribute('class', 'pattern-avatar-mesh');
    g.appendChild(path);
    this.avatarSvg.appendChild(g);
  }

  /**
   * Minor/major reference grid — see `buildGridGroup` for the letterbox overscan
   * and the zoom-out ladder.
   */
  private drawGrid(
    layoutW: number,
    layoutH: number,
    box: { x: number; y: number; w: number; h: number }
  ): SVGGElement {
    return buildGridGroup(box, this.unit, {
      width: layoutW,
      height: layoutH,
    });
  }

  /**
   * Report a changed piece selection once per redraw. Every selection path ends
   * in `redraw`, so this catches them all without threading a call through each.
   */
  private emitSelectionChange(): void {
    if (!this.cbs.onSelectionChange) return;
    const ids = this.getSelectedPieces();
    const sig = ids.join('\u0000');
    if (sig === this.lastSelectionSig) return;
    this.lastSelectionSig = sig;
    this.cbs.onSelectionChange(ids);
  }

  private redraw(): void {
    this.emitSelectionChange();
    this.drawnChromeScale = this.chromeScale();
    const view = this.effectiveViewBox();
    const { x, y, w, h } = view;
    // The single layout read for this redraw — see `viewScaleCache`. Taken before
    // anything is written so it cannot force a flush of its own.
    const layoutW = this.svg.clientWidth;
    const layoutH = this.svg.clientHeight;
    const sized = layoutW >= 2 && layoutH >= 2;
    this.viewScaleCache = sized
      ? (Math.min(layoutW / w, layoutH / h)) * this.chromeScale()
      : null;
    if (sized) this.lastChromeLayout = { w: layoutW, h: layoutH };

    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.avatarSvg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.svg.innerHTML = '';

    if (this.container?.drawsGrid !== false) {
      const grid = this.drawGrid(layoutW, layoutH, view);
      this.svg.appendChild(grid);
    }

    // An expanded container draws its own boundary: the work may run past it, and
    // which side of that line you are on is the whole point of the frame.
    const frame = this.drawContainerFrame();
    if (frame.childNodes.length > 0) this.svg.appendChild(frame);
    this.applyContainerClip();

    // A reference image is what the work is drafted *over*, so it goes down
    // before the pieces: the linework stays on top of the picture, which is the
    // whole reason to bring one onto the sheet.
    this.drawImages();

    // Zoomed far enough out that every mark would be a smear of chrome over the
    // work, there is less to draw — see `PatternDetail`. A frame on the canvas
    // hands the pointer over as well, so a press there moves the container.
    const detail = this.detail();
    this.svg.style.pointerEvents =
      detail === 'full' || this.container?.coarsePointer === 'editor' ? '' : 'none';
    if (detail !== 'full') {
      // Outlines are drawn at every level: the shape of the work is what a
      // zoomed-out canvas is *for*. What the coarser levels drop is the fill and
      // all the chrome.
      const mark = detail === 'preview' ? 'silhouette' : 'outline';
      for (const piece of this.pattern.pieces) this.drawPiece(piece, mark);
      // Notes are the draughtsperson's own words on the sheet: they stay at every
      // level, scaled down with the work.
      this.drawTexts();
      // The rectangle is the gesture in hand, not chrome: dropping it would make
      // a drag on a zoomed-out canvas look like it did nothing at all. It is the
      // only preview that can reach here, since every other tool draws at `full`.
      if (this.drag?.type === 'marquee') {
        this.drawMarquee(this.drag.start, this.drag.current, this.drag.panels);
      }
      // The tether is the gesture in hand too: the ring has to be there to swing
      // a point along, however far out the canvas is zoomed.
      this.drawOrbitGuide();
      return;
    }

    // Ownership has to be known before anything is drawn, and the group boxes go
    // down first so a piece stroke can never be painted over by one.
    this.blockOwnership = new Map();
    for (const instance of this.blocks()) {
      for (const entry of instance.pieces) this.blockOwnership.set(entry.pieceId, instance);
      this.drawBlockOutline(instance);
    }

    for (const piece of this.pattern.pieces) {
      this.drawPiece(piece);
    }

    this.drawSeamAllowances();

    // Above the pieces, below the seams and everything you can grab: the
    // highlight is an answer to "what does this number move?", not a handle.
    this.drawBlockHighlight();

    this.drawSeams();

    // Extrude tool: the edge in hand, and the tab it is pulling out.
    if (this.extrudeHover) this.drawExtrudeHover(this.extrudeHover);
    if (this.drag?.type === 'extrudeEdge') this.drawExtrudePreview(this.drag);

    // Rulers are laid *over* the work like a real ruler on the table, so the
    // line you are measuring against is always visible and grabbable. The
    // readings come back separately so a later ruler's graduations can never
    // cover an earlier ruler's numbers.
    for (const reading of this.drawRulers()) this.svg.appendChild(reading);

    // Measurements ride over the rulers: both are references, and the readout is
    // the smaller thing you need to be able to grab.
    this.drawMeasures();

    // Notes sit above the pattern and its drafting marks, below the points and
    // handles you grab.
    this.drawTexts();

    // The box round an image in hand rides above the work rather than with the
    // picture: the picture is drawn under the pieces (see the top of `redraw`),
    // and a grip buried under a panel is a grip nobody can take hold of.
    this.drawSelectedImageChrome();

    if (this.tool === 'move') {
      this.drawOrbitGuide();
      this.drawSelectionChrome();
    }

    if (this.snapGuides.length > 0) {
      this.drawSnapGuides();
    }

    if (this.drag?.type === 'marquee') {
      this.drawMarquee(this.drag.start, this.drag.current, this.drag.panels);
    }

    if (this.drag?.type === 'drawShape') {
      this.drawShapePreview(this.drag);
    }

    if (this.drag?.type === 'objectBox') {
      this.drawObjectBoxPreview(this.drag);
    }

    if (this.drag?.type === 'cutLine' || this.drag?.type === 'cutCircle') {
      this.drawCutPreview(this.drag);
    } else if (this.tool === 'cut' && this.cutMode === 'curve') {
      this.drawCutChainDraft();
    } else if (this.isLoopCut() && this.cutLoop) {
      this.drawLoopCut(this.cutLoop);
    } else if (this.cutMode === 'inset' && this.cutInset) {
      this.drawInsetLoop(this.cutInset);
    }

    if (this.isModify('join') && this.joinPreview.piece) {
      this.drawJoinPreview(this.joinPreview.piece);
    }

    if (this.isModify('bridge') && this.bridgePreview.piece) {
      this.drawBridgePreview(this.bridgePreview.piece);
    }

    this.updatePointBar();
    this.updateAllowanceBar();
    this.updateRulerReadout();
    this.updateBlockReadouts();
    this.syncCutBar();
    this.syncJoinBar();
    this.syncZoomControl();
    this.syncMeasureBar();
  }

  private selectedPoint(): BezierPoint | null {
    if (!this.selectedPointId || this.selectedIds.size !== 1) return null;
    for (const piece of this.pattern.pieces) {
      const pt = piecePointById(piece, this.selectedPointId);
      if (pt) return pt;
    }
    return null;
  }

  private isCornerPoint(pt: BezierPoint): boolean {
    const inZero =
      !pt.handleIn || (pt.handleIn.x === pt.anchor.x && pt.handleIn.y === pt.anchor.y);
    const outZero =
      !pt.handleOut || (pt.handleOut.x === pt.anchor.x && pt.handleOut.y === pt.anchor.y);
    return inZero && outZero;
  }

  /**
   * The seam allowance ribbon: what the picked edge and the piece are set to,
   * in the canvas' unit. It shares the top-left slot with the tool's ribbon, and
   * a picked edge wins — you are setting an edge, not choosing a tool.
   */
  private updateAllowanceBar(): void {
    const sel = this.allowanceEdge;
    const piece = this.allowancePiece();
    // The piece can go out from under the pick (deleted, or replaced by history).
    if (sel && !piece) this.allowanceEdge = null;
    const showing = this.allowanceOn && !!sel && !!piece;
    this.allowanceBar.hidden = !showing;
    if (!showing) {
      // The ribbon it shares the top-left corner with comes back when the edge
      // is let go. Only when it was actually taken: this runs on every redraw,
      // and laying the ribbon out again would cost a layout read each time.
      if (this.toolSettings.hidden) this.syncToolSettings();
      return;
    }
    this.toolSettings.hidden = true;

    this.allowanceEdgeLabel.textContent = `${piece.name} · edge ${sel.edgeIndex + 1} of ${
      piece.points.length
    }`;
    this.allowanceUnitLabel.textContent = this.unit;
    // Never overwrite the field being typed in: the caret would jump.
    if (document.activeElement !== this.allowancePieceInput) {
      this.allowancePieceInput.value = this.allowanceText(defaultSeamAllowanceCm(piece));
    }
    const own = edgeHasOwnAllowance(piece, sel.edgeIndex);
    if (document.activeElement !== this.allowanceEdgeInput) {
      this.allowanceEdgeInput.value = this.allowanceText(allowanceForEdge(piece, sel.edgeIndex));
    }
    this.allowanceEdgeInput.classList.toggle('is-inherited', !own);
    const reset = this.allowanceBar.querySelector(
      'button[data-allowance-act="reset"]'
    ) as HTMLButtonElement | null;
    if (reset) reset.disabled = !own;
    const all = this.allowanceBar.querySelector(
      'button[data-allowance-act="all"]'
    ) as HTMLButtonElement | null;
    if (all) all.disabled = !own;
  }

  /** A value ready for a number field: display units, no trailing zeroes. */
  private allowanceText(cm: number): string {
    const value = cmToDisplay(cm, this.unit);
    return String(Math.round(value * 1000) / 1000);
  }

  private updatePointBar(): void {
    const pt = this.selectedPoint();
    // The point's options have a ribbon of their own along the bottom, so they
    // can be up while the tool's ribbon is: a picked point is what the tool in
    // hand is about to move. An allowance edge takes the slot instead — that is
    // an edge being set, not a point being dragged — and only Move works points.
    if (!pt || this.tool !== 'move' || (this.allowanceOn && !!this.allowanceEdge)) {
      this.pointBar.hidden = true;
      return;
    }
    this.pointBar.hidden = false;
    const corner = this.isCornerPoint(pt);
    this.cornerCheck.checked = corner;
    this.parallelCheck.checked = !!pt.handlesParallel;
    this.parallelCheck.disabled = corner;
  }

  /** Snapshot host undo history once before the next mutation in this gesture. */
  private markBeforeChange(): void {
    if (this.historyArmed) return;
    this.historyArmed = true;
    this.cbs.onBeforeChange?.();
  }

  private endHistoryGesture(): void {
    this.historyArmed = false;
  }

  private onParallelToggle(): void {
    const pt = this.selectedPoint();
    if (!pt || this.isCornerPoint(pt)) {
      this.updatePointBar();
      return;
    }
    this.markBeforeChange();
    pt.handlesParallel = this.parallelCheck.checked;
    if (pt.handlesParallel) this.mirrorHandlesFromPrimary(pt);
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private onCornerToggle(): void {
    const piece = this.activePiece();
    const pt = this.selectedPoint();
    if (!piece || !pt) {
      this.updatePointBar();
      return;
    }
    this.toggleCornerPoint(piece, pt);
  }

  /**
   * Bézier point ↔ sharp corner: the two states the point ribbon's Corner box
   * switches between, on the point the hand is on. A corner drops its handles; a
   * Bézier point grows handles along its neighbours again.
   */
  private toggleCornerPoint(piece: PatternPiece, pt: BezierPoint): void {
    this.markBeforeChange();
    if (this.isCornerPoint(pt)) {
      this.createDefaultHandles(piece, pt);
      pt.handlesParallel = false;
    } else {
      pt.handleIn = null;
      pt.handleOut = null;
    }
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /** Make handleIn opposite handleOut (or vice versa if only in exists). */
  private mirrorHandlesFromPrimary(pt: BezierPoint): void {
    if (pt.handleOut) {
      const dx = pt.handleOut.x - pt.anchor.x;
      const dy = pt.handleOut.y - pt.anchor.y;
      pt.handleIn = { x: pt.anchor.x - dx, y: pt.anchor.y - dy };
    } else if (pt.handleIn) {
      const dx = pt.handleIn.x - pt.anchor.x;
      const dy = pt.handleIn.y - pt.anchor.y;
      pt.handleOut = { x: pt.anchor.x - dx, y: pt.anchor.y - dy };
    }
  }

  private selectionBBox(): BBox | null {
    if (this.selectedIds.size === 0) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let found = false;
    for (const piece of this.pattern.pieces) {
      for (const pt of pieceRings(piece).flat()) {
        if (!this.selectedIds.has(pt.id)) continue;
        found = true;
        minX = Math.min(minX, pt.anchor.x);
        minY = Math.min(minY, pt.anchor.y);
        maxX = Math.max(maxX, pt.anchor.x);
        maxY = Math.max(maxY, pt.anchor.y);
      }
    }
    if (!found) return null;
    // Degenerate (single point / colinear): give a tiny box so scale handles still work
    if (maxX - minX < 1e-6) {
      const pad = this.px(4);
      minX -= pad;
      maxX += pad;
    }
    if (maxY - minY < 1e-6) {
      const pad = this.px(4);
      minY -= pad;
      maxY += pad;
    }
    return { minX, minY, maxX, maxY };
  }

  /** Tell the host what rectangle is being drawn, or that the drag is over. */
  private reportMarquee(
    drag: { start: Vec2; current: Vec2; additive: boolean; panels: boolean } | null
  ): void {
    const report = this.cbs.onMarqueeRect;
    if (!report) return;
    if (!drag) {
      report(null, { additive: false, panels: false });
      return;
    }
    report(
      {
        x: Math.min(drag.start.x, drag.current.x),
        y: Math.min(drag.start.y, drag.current.y),
        w: Math.abs(drag.current.x - drag.start.x),
        h: Math.abs(drag.current.y - drag.start.y),
      },
      { additive: drag.additive, panels: drag.panels }
    );
  }

  private drawMarquee(a: Vec2, b: Vec2, panels: boolean): void {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    // Cmd/Ctrl reads as whole panels: solid and green, so the mode is legible
    // while the rectangle is being drawn.
    rect.setAttribute('class', panels ? 'pattern-marquee pattern-marquee-pieces' : 'pattern-marquee');
    rect.setAttribute('stroke-width', String(this.px(1.5)));
    rect.setAttribute(
      'stroke-dasharray',
      `${this.px(6)} ${this.px(4)}`
    );
    rect.setAttribute('pointer-events', 'none');
    this.svg.appendChild(rect);
  }

  private shapeBoxFromDrag(
    start: Vec2,
    current: Vec2,
    lockAspect: boolean
  ): { x: number; y: number; w: number; h: number } {
    const sx = current.x >= start.x ? 1 : -1;
    const sy = current.y >= start.y ? 1 : -1;
    let w = Math.abs(current.x - start.x);
    let h = Math.abs(current.y - start.y);
    if (lockAspect) {
      const s = Math.max(w, h);
      w = s;
      h = s;
    }
    return {
      x: sx > 0 ? start.x : start.x - w,
      y: sy > 0 ? start.y : start.y - h,
      w,
      h,
    };
  }

  /**
   * The text box being dragged out: the frame the host will fill, drawn to the
   * same measure as the draw preview it stands in for.
   */
  private drawObjectBoxPreview(drag: Extract<DragKind, { type: 'objectBox' }>): void {
    const box = this.shapeBoxFromDrag(drag.start, drag.current, false);
    if (box.w < 1e-6 && box.h < 1e-6) return;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(box.x));
    rect.setAttribute('y', String(box.y));
    rect.setAttribute('width', String(box.w));
    rect.setAttribute('height', String(box.h));
    rect.setAttribute('class', 'pattern-text-preview');
    rect.setAttribute('stroke-width', String(this.px(1.5)));
    rect.setAttribute('stroke-dasharray', `${this.px(5)} ${this.px(3)}`);
    rect.setAttribute('pointer-events', 'none');
    this.svg.appendChild(rect);
  }

  private drawShapePreview(drag: Extract<DragKind, { type: 'drawShape' }>): void {
    const lock = drag.shape === 'circle' || drag.lockAspect;
    const box = this.shapeBoxFromDrag(drag.start, drag.current, lock);
    if (box.w < 1e-6 && box.h < 1e-6) return;
    const sw = this.px(1.5);
    if (drag.shape === 'rect') {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(box.x));
      rect.setAttribute('y', String(box.y));
      rect.setAttribute('width', String(box.w));
      rect.setAttribute('height', String(box.h));
      rect.setAttribute('class', 'pattern-shape-preview');
      rect.setAttribute('stroke-width', String(sw));
      rect.setAttribute('pointer-events', 'none');
      this.svg.appendChild(rect);
    } else {
      const ell = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      ell.setAttribute('cx', String(box.x + box.w / 2));
      ell.setAttribute('cy', String(box.y + box.h / 2));
      ell.setAttribute('rx', String(box.w / 2));
      ell.setAttribute('ry', String(box.h / 2));
      ell.setAttribute('class', 'pattern-shape-preview');
      ell.setAttribute('stroke-width', String(sw));
      ell.setAttribute('pointer-events', 'none');
      this.svg.appendChild(ell);
    }
  }

  /**
   * Hand the box to the host. A press that did not move is a click, and a click
   * means "text that sizes itself", not "a box one pixel wide".
   */
  private finishObjectBox(drag: Extract<DragKind, { type: 'objectBox' }>): void {
    const report = this.cbs.onAddObject;
    if (!report) return;
    const moved = dist(drag.start, drag.current);
    if (moved < this.hitRadius() * 0.5) {
      report(drag.kind, { x: drag.start.x, y: drag.start.y, w: 0, h: 0 });
      return;
    }
    const box = this.shapeBoxFromDrag(drag.start, drag.current, false);
    report(drag.kind, { x: box.x, y: box.y, w: box.w, h: box.h });
  }

  private finishDrawShape(drag: Extract<DragKind, { type: 'drawShape' }>): void {
    const lock = drag.shape === 'circle' || drag.lockAspect;
    const box = this.shapeBoxFromDrag(drag.start, drag.current, lock);
    const minSize = Math.max(0.5, this.hitRadius() * 0.5);
    if (box.w < minSize || box.h < minSize) {
      this.endHistoryGesture();
      return;
    }
    this.markBeforeChange();
    const n = this.pattern.pieces.length + 1;
    const piece =
      drag.shape === 'rect'
        ? rectPiece(`Rect ${n}`, box.w, box.h, { x: box.x, y: box.y })
        : circlePiece(`Circle ${n}`, box.x + box.w / 2, box.y + box.h / 2, box.w / 2);
    this.pattern.pieces.push(piece);
    this.selectEntirePiece(piece);
    this.cbs.onChange();
    this.endHistoryGesture();
  }

  private cutterFromDrag(
    drag: Extract<DragKind, { type: 'cutLine' | 'cutCircle' }>
  ): CutterPath | null {
    if (drag.type === 'cutLine') {
      let b = drag.current;
      if (drag.shift) {
        const d = snapAngleDegrees(b.x - drag.start.x, b.y - drag.start.y, 30);
        b = { x: drag.start.x + d.x, y: drag.start.y + d.y };
      }
      if (dist(drag.start, b) < 0.2) return null;
      return { kind: 'line', a: drag.start, b };
    }
    // The drag is the radius about the press point; Shift quantises it to half a
    // centimetre. Too small to be a gesture is no cut at all.
    let r = drag.radius;
    if (drag.shift) r = Math.round(r * 2) / 2;
    if (r < 0.25) return null;
    return { kind: 'circle', center: drag.center, radius: r };
  }

  private drawCutPreview(
    drag: Extract<DragKind, { type: 'cutLine' | 'cutCircle' }>
  ): void {
    const cutter = this.cutterFromDrag(drag);
    if (!cutter) return;
    this.strokeCutter(cutter, true);
  }

  /**
   * The loop cut under the pointer: the cut itself, where it lands, and — in
   * follow mode — the two contours it is blended from, faintly, so it is clear
   * what it is following.
   */
  private drawLoopCut(hover: { cut: LoopCut }): void {
    const { cut } = hover;

    if (!cut.straight && cut.valid) {
      for (const rail of cut.rails) {
        if (rail.length < 2) continue;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute(
          'd',
          rail.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
        );
        path.setAttribute('class', 'pattern-cut-rail');
        path.setAttribute('stroke-width', String(this.px(1)));
        path.setAttribute('pointer-events', 'none');
        this.svg.appendChild(path);
      }
    }

    const samples = sampleLoopCutPath(cut, 48);
    if (samples.length >= 2) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        samples.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
      );
      path.setAttribute('class', 'pattern-cut-loop');
      path.setAttribute('stroke-width', String(this.px(1.75)));
      path.setAttribute('pointer-events', 'none');
      this.svg.appendChild(path);
    }

    for (const point of [cut.entry, cut.exit]) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(point.x));
      c.setAttribute('cy', String(point.y));
      c.setAttribute('r', String(this.px(3.5)));
      c.setAttribute(
        'class',
        cut.valid ? 'pattern-cut-hit-ok' : 'pattern-cut-hit'
      );
      c.setAttribute('pointer-events', 'none');
      this.svg.appendChild(c);
    }
  }

  /**
   * The inset loop under the pointer: the line the cut would run along, with the
   * patch it would cut out shaded in, because that is the piece that goes.
   */
  private drawInsetLoop(hover: { loop: BezierPoint[] }): void {
    const { loop } = hover;
    if (loop.length < 2) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = `M ${loop[0]!.anchor.x} ${loop[0]!.anchor.y}`;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      const { c0, c1 } = edgeHandles(a, b);
      if (edgeIsStraight(a, b)) d += ` L ${b.anchor.x} ${b.anchor.y}`;
      else d += ` C ${c0.x} ${c0.y}, ${c1.x} ${c1.y}, ${b.anchor.x} ${b.anchor.y}`;
    }
    path.setAttribute('d', `${d} Z`);
    path.setAttribute('class', 'pattern-cut-inset');
    path.setAttribute('fill', this.cutHole ? 'rgba(196,92,38,0.10)' : 'rgba(196,92,38,0.05)');
    path.setAttribute('stroke-width', String(this.px(1.75)));
    path.setAttribute('pointer-events', 'none');
    this.svg.appendChild(path);
    for (const pt of loop) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(pt.anchor.x));
      c.setAttribute('cy', String(pt.anchor.y));
      c.setAttribute('r', String(this.px(2.5)));
      c.setAttribute('class', 'pattern-cut-hit-ok');
      c.setAttribute('pointer-events', 'none');
      this.svg.appendChild(c);
    }
  }

  // ── Curve cut ──────────────────────────────────────────────────────────
  //
  // Click points down like the pen, and the chain through them is the cut: it is
  // carried out to the outline at both ends, so a cut started in the middle of a
  // panel still runs edge to edge. The bar at the bottom of the viewport holds
  // the options — the fit between the clicks, whether to sew the halves back
  // together — and Done or Cancel.

  /**
   * The chain as a cutter, with each end carried out to *this* piece's outline.
   *
   * A cut has to start and finish on the boundary, and a click is usually inside
   * the panel. The carry-on stops at the outline rather than running on by a
   * fixed distance: a line that sails past the panel it is cutting would sit over
   * whatever is behind it, and the cut would look like it belonged there.
   */
  private chainCutter(piece: PatternPiece): CutterPath | null {
    if (this.cutChain.length < 2) return null;
    const box = anchorsBounds(piece.points);
    const reach = Math.max(box.maxX - box.minX, box.maxY - box.minY) * 2 + 1;
    const poly = pieceToPolyline(piece.points, true);

    // The point that carries an end on out of the piece, or null when the end is
    // already outside it — there is nothing left to reach.
    const carried = (from: Vec2, towards: Vec2): Vec2 | null => {
      if (!pointInPolygon(from, poly)) return null;
      const dx = from.x - towards.x;
      const dy = from.y - towards.y;
      const length = Math.hypot(dx, dy) || 1;
      const dir = { x: dx / length, y: dy / length };
      const ray: CutterPath = {
        kind: 'line',
        a: from,
        b: { x: from.x + dir.x * reach, y: from.y + dir.y * reach },
      };
      const distances = findBoundaryHits(piece, ray)
        .filter((hit) => hit.along > 1e-3)
        .map((hit) => hit.along * reach);
      if (distances.length === 0) return null;
      const distance = Math.min(...distances) + 0.5;
      return { x: from.x + dir.x * distance, y: from.y + dir.y * distance };
    };

    const anchors = [...this.cutChain];
    const before = carried(anchors[0]!, anchors[1]!);
    const after = carried(anchors[anchors.length - 1]!, anchors[anchors.length - 2]!);
    if (before) anchors.unshift(before);
    if (after) anchors.push(after);
    return cutterPathThrough(anchors, this.cutChainFit);
  }

  /** The piece a chain cut is for: the one the chain is drawn through. */
  private pieceForChain(points: readonly Vec2[]): PatternPiece | null {
    const under = pieceUnderChain(this.pattern.pieces, points, this.cutChainFit);
    if (under) return under;
    const active = this.activePiece();
    return active?.closed && active.points.length >= 3 ? active : null;
  }

  /**
   * What Done would do right now: the cut, the piece it lands on, and the
   * crossings it makes. Drives both the preview and the bar's readout, so the
   * two can never disagree — and the commit takes the piece from here rather than
   * working it out again from the carried-on line.
   */
  private chainCut(): { cutter: CutterPath; piece: PatternPiece; hits: BoundaryHit[] } | null {
    if (this.cutChain.length < 2) return null;
    const piece = this.pieceForChain(this.cutChain);
    if (!piece) return null;
    const cutter = this.chainCutter(piece);
    if (!cutter) return null;
    return { cutter, piece, hits: findBoundaryHits(piece, cutter) };
  }

  /**
   * Whether the chain's crossings are a cut: two of them, with panel left on both
   * sides. One crossing, or a line that only clips a corner, leaves nothing to
   * separate.
   */
  private chainCutValid(cut: { cutter: CutterPath; piece: PatternPiece; hits: BoundaryHit[] }): boolean {
    return !!cutterCrossings(cut.piece, cut.cutter, cut.hits);
  }

  private drawCutChainDraft(): void {
    if (this.cutChain.length === 0) return;
    const cut = this.chainCut();

    // Faint first, under the drawn chain: where the cut carries on to the
    // outline at both ends, which is what lets a cut started inside the panel
    // finish edge to edge.
    if (cut) this.strokeSampledPath(cut.cutter, 'pattern-cut-extension');
    const drawn = cutterPathThrough(this.cutChain, this.cutChainFit);
    if (drawn) this.strokeSampledPath(drawn, 'pattern-cut-preview');

    for (const point of this.cutChain) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(point.x));
      c.setAttribute('cy', String(point.y));
      c.setAttribute('r', String(this.px(3.5)));
      c.setAttribute('class', 'pattern-cut-point');
      c.setAttribute('pointer-events', 'none');
      this.svg.appendChild(c);
    }

    // The rubber band: where the next click would carry the chain. Dashed, and
    // not part of the cut — what is drawn solid is what Done would do.
    if (this.cutChainHover) {
      const last = this.cutChain[this.cutChain.length - 1]!;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(last.x));
      line.setAttribute('y1', String(last.y));
      line.setAttribute('x2', String(this.cutChainHover.x));
      line.setAttribute('y2', String(this.cutChainHover.y));
      line.setAttribute('class', 'pattern-cut-rubber');
      line.setAttribute('stroke-width', String(this.px(1.25)));
      line.setAttribute('pointer-events', 'none');
      this.svg.appendChild(line);
    }

    if (!cut) return;
    const ok = this.chainCutValid(cut);
    for (const hit of cut.hits) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(hit.point.x));
      c.setAttribute('cy', String(hit.point.y));
      c.setAttribute('r', String(this.px(3.5)));
      c.setAttribute('class', ok ? 'pattern-cut-hit-ok' : 'pattern-cut-hit');
      c.setAttribute('pointer-events', 'none');
      this.svg.appendChild(c);
    }
  }

  /** A cutter's own line, sampled and stroked in the given class. */
  private strokeSampledPath(cutter: CutterPath, className: string): void {
    const points = sampleCutterPath(cutter);
    if (points.length < 2) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = `M ${points[0]!.x} ${points[0]!.y}`;
    for (let i = 1; i < points.length; i++) d += ` L ${points[i]!.x} ${points[i]!.y}`;
    path.setAttribute('d', d);
    path.setAttribute('class', className);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', String(this.px(1.75)));
    path.setAttribute('pointer-events', 'none');
    this.svg.appendChild(path);
  }

  /**
   * Bottom bar: what the cut in hand is set to, and what the cut in hand
   * would do. Every cut mode shares it — the chain's own controls (count, fit,
   * Done, Cancel) come and go with the mode, the toggles stay put — and it is
   * kept in step from `redraw`, so the status line never lags the preview.
   */
  private syncCutBar(): void {
    if (!this.cutBar) return;
    // One bar at the bottom of the viewport at a time: a simplify preview is the
    // more modal of the two, so it takes the slot while it is up.
    const cutModes: CutMode[] = ['linear', 'circle', 'curve', 'inset'];
    const active = this.tool === 'cut' && cutModes.includes(this.cutMode) && !this.simplify;
    this.cutBar.hidden = !active;
    if (!active) return;

    const chain = this.cutMode === 'curve';
    const cutOut = this.cutMode === 'inset' || this.cutMode === 'circle';
    const title = this.cutBar.querySelector('[data-cut-title]') as HTMLElement;
    title.textContent = CUT_BAR_TITLES[this.cutMode];

    const show = (selector: string, on: boolean): void => {
      const el = this.cutBar.querySelector(selector) as HTMLElement | null;
      if (el) el.hidden = !on;
    };
    show('[data-cut-fit-field]', chain);
    show('[data-cut-done]', chain);
    show('[data-cut-cancel]', chain);
    // A hole and a loose cut-out are the same cut; a cut that leaves two halves
    // has neither to offer.
    show('[data-cut-hole-field]', cutOut);

    const sewField = this.cutBar.querySelector('[data-cut-sew-field]') as HTMLElement;
    sewField.title = chain
      ? 'Weld the two halves back together along the cut'
      : cutOut
        ? 'Sew the piece that was cut out back into the opening it came from'
        : 'Sew the two halves back together along the cut';
    const holeField = this.cutBar.querySelector('[data-cut-hole-field]') as HTMLElement;
    holeField.title = 'Leave the opening as a hole: the piece cut out of it is dropped';

    // The inverse of the chain: the drag cutters say it in one line, and the
    // inset says how far in the loop sits.
    const readout = this.cutBar.querySelector('[data-cut-readout]') as HTMLElement;
    if (this.cutMode === 'inset') {
      readout.hidden = false;
      readout.textContent = this.cutInset
        ? `Inset ${Math.round(this.cutInset.scale * 100)}% · ${formatLength(this.cutInset.gap, this.unit, 1)} deep`
        : 'Move the pointer in from an edge';
      readout.title =
        'The copy is this much of the panel, and that far in from its edge at the tightest';
    } else {
      readout.hidden = true;
    }

    const count = this.cutBar.querySelector('[data-cut-count]') as HTMLElement;
    const status = this.cutBar.querySelector('[data-cut-status]') as HTMLElement;
    if (chain) {
      const count_ = this.cutChain.length;
      count.hidden = false;
      count.textContent = `${count_} ${count_ === 1 ? 'point' : 'points'}`;
      const cut = this.chainCut();
      const ok = !!cut && this.chainCutValid(cut);
      if (this.cutChainRefusal) {
        status.textContent = this.cutChainRefusal;
        status.title = this.cutChainRefusal;
      } else if (count_ < 2) {
        status.textContent = 'Click points along the cut';
        status.title = '';
      } else if (!cut) {
        status.textContent = 'No panel under the chain';
        status.title = '';
      } else if (!ok) {
        status.textContent = `The cut has to cross ${cut.piece.name} twice`;
        status.title = 'Two crossings, with panel left on both sides of the line';
      } else {
        status.textContent = `Cuts ${cut.piece.name} in two`;
        status.title = `The cut crosses ${cut.piece.name} twice`;
      }
      const done = this.cutBar.querySelector('[data-cut-done]') as HTMLButtonElement;
      done.disabled = !ok;
    } else if (cutOut) {
      count.hidden = true;
      const under = this.cutInset?.pieceId
        ? this.pattern.pieces.find((p) => p.id === this.cutInset!.pieceId)
        : null;
      if (this.cutMode === 'circle') {
        status.textContent = this.cutHole
          ? 'A circle inside the panel is cut out as a hole'
          : 'Drag: across the panel to cut it in two, or inside it to cut a hole';
        status.title = '';
      } else if (under && this.cutInset) {
        status.textContent = this.cutHole
          ? `Leaves a hole in ${under.name}`
          : this.cutSew
            ? `Cuts a loop out of ${under.name} and sews it back in`
            : `Cuts a loop out of ${under.name}, keeping the piece`;
        status.title = '';
      } else {
        status.textContent = this.cutNotice ?? 'Hover inside a panel to size the loop';
        status.title = '';
      }
    } else {
      count.hidden = true;
      status.textContent = this.cutNotice ?? (this.cutMode === 'linear' ? 'Drag a line across the panel to cut it' : '');
      status.title = '';
    }

    const fit = this.cutBar.querySelector('select[data-cut-fit]') as HTMLSelectElement;
    fit.value = this.cutChainFit;
    const sew = this.cutBar.querySelector('input[data-cut-sew]') as HTMLInputElement;
    sew.checked = this.cutSew;
    const hole = this.cutBar.querySelector('input[data-cut-hole]') as HTMLInputElement;
    hole.checked = this.cutHole;
  }

  /** Commit the chain as a cut, and stand the draft down. */
  private commitCutChain(): void {
    const cut = this.chainCut();
    if (!cut || !this.chainCutValid(cut)) return;
    const refusal = this.commitCut(cut.cutter, this.cutSew, cut.piece);
    if (refusal) {
      // The cut looked good in the preview but the slicer would not take it:
      // keep the chain, say why, and let the next click or Cancel decide.
      this.cutChainRefusal = refusal;
      this.syncCutBar();
      this.redraw();
      return;
    }
    this.clearCutDraft();
    this.syncCutBar();
    this.redraw();
  }

  /** Throw the draft away — Escape, Cancel, or the tool going out of hand. */
  private cancelCutChain(): void {
    if (this.cutChain.length === 0 && !this.cutChainHover) return;
    this.clearCutDraft();
    this.syncCutBar();
    this.redraw();
  }

  /**
   * Where a click lands: snapped to an outline point or edge it is close to, so a
   * cut can be started exactly on a corner or run out along an edge.
   */
  private snapCutPoint(p: Vec2): Vec2 {
    // A snap radius that shrinks with the zoom but never grows past a couple of
    // centimetres: a click meant for the middle of a panel must not be dragged
    // onto its outline just because the board is zoomed out.
    const r = Math.min(this.hitRadius(), 2);
    let best: { point: Vec2; dist: number } | null = null;
    // A point first, and on its own: a corner is on both the edges that meet
    // there, so any click near one is near an edge too, and the edges would
    // otherwise always claim it. A cut aimed at a corner starts on the corner.
    for (const piece of this.pattern.pieces) {
      for (const point of piece.points) {
        const d = dist(p, point.anchor);
        if (d <= r && (!best || d < best.dist)) best = { point: point.anchor, dist: d };
      }
    }
    if (best) return { ...best.point };
    for (const piece of this.pattern.pieces) {
      if (piece.points.length < 2) continue;
      const hit = findNearestEdge(piece.points, piece.closed, p);
      if (!hit || hit.dist > r) continue;
      if (!best || hit.dist < best.dist) best = { point: hit.point, dist: hit.dist };
    }
    return best ? { ...best.point } : { ...p };
  }

  private strokeCutter(cutter: CutterPath, showHits: boolean): void {
    const piece = showHits ? this.pieceForCut(cutter) : null;
    const hits = piece ? findBoundaryHits(piece, cutter) : [];

    // For linear cuts, draw through the hit span so opposite-side crossings are obvious.
    let pts = sampleCutterPath(cutter);
    if (cutter.kind === 'line' && hits.length >= 2) {
      const sorted = [...hits].sort((a, b) => a.along - b.along);
      const a = sorted[0]!.point;
      const b = sorted[sorted.length - 1]!.point;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const pad = Math.max(2, len * 0.08);
      pts = [
        { x: a.x - (dx / len) * pad, y: a.y - (dy / len) * pad },
        { x: b.x + (dx / len) * pad, y: b.y + (dy / len) * pad },
      ];
    }
    if (pts.length < 2) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x} ${pts[i]!.y}`;
    if (cutter.kind === 'circle') d += ' Z';
    path.setAttribute('d', d);
    path.setAttribute('class', 'pattern-cut-preview');
    path.setAttribute('fill', cutter.kind === 'circle' ? 'rgba(196,92,38,0.06)' : 'none');
    path.setAttribute('stroke-width', String(this.px(1.75)));
    path.setAttribute('pointer-events', 'none');
    this.svg.appendChild(path);

    if (!showHits || !piece) return;
    // The same rule the commit slices by, so the dots can never promise a cut
    // that is then refused.
    const validPair = !!cutterCrossings(piece, cutter, hits);
    for (const h of hits) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(h.point.x));
      c.setAttribute('cy', String(h.point.y));
      c.setAttribute('r', String(this.px(3.5)));
      c.setAttribute('class', validPair ? 'pattern-cut-hit-ok' : 'pattern-cut-hit');
      c.setAttribute('pointer-events', 'none');
      this.svg.appendChild(c);
    }
  }

  private pieceForCut(cutter: CutterPath): PatternPiece | null {
    const closed = this.pattern.pieces.filter((p) => p.closed && p.points.length >= 3);

    // A line is for the piece the drag itself runs through — the piece between
    // the press and the pointer — and for no other. Its crossings are worked out
    // on the infinite line through those two points, so a search that goes by
    // crossings alone hands the cut to whatever panel that line reaches *behind*
    // the press, which is a panel the draftsperson was not drawing on.
    if (cutter.kind === 'line') {
      const under = pieceUnderChain(closed, [cutter.a, cutter.b], 'straight');
      if (under) return under;
      // A drag can also cross a piece without spending any of its samples inside
      // it — a long drag across a narrow panel — so a piece the line crosses
      // *between* the two points still counts.
      const withinDrag = (hit: BoundaryHit) => hit.along >= 0 && hit.along <= 1;
      for (const piece of closed) {
        const hits = findBoundaryHits(piece, cutter).filter(withinDrag);
        if (cutterCrossings(piece, cutter, hits)) return piece;
      }
      return null;
    }

    // Prefer the piece the cut actually crosses. That covers a circle dragged in
    // from outside the panel and a chain that dips into one, without caring where
    // the gesture happened to start — or, for a circle, where its centre happens
    // to fall: a rim laid over an edge trims an arc out of it with its centre well
    // outside the panel.
    if (cutter.kind === 'path' || cutter.kind === 'circle') {
      for (const piece of closed) {
        if (cutterCrossings(piece, cutter)) return piece;
      }
    }

    // Otherwise go by where the cut sits. A chain has to be probed part way
    // along: its first point is a boundary hit, and a point on the outline is
    // inside no piece.
    const probe = this.cutProbePoint(cutter);
    for (const piece of closed) {
      if (pointInPiece(probe, piece)) return piece;
    }
    // Nothing claimed it: the active piece is the only remaining candidate, and
    // only if the cut is sitting over it at all.
    const fallback = this.activePiece();
    if (!fallback || !fallback.closed || fallback.points.length < 3) return null;
    return pointInPiece(probe, fallback) ? fallback : null;
  }

  /** A point on the cut which is meant to be inside the piece it cuts. */
  private cutProbePoint(cutter: CutterPath): Vec2 {
    if (cutter.kind === 'circle') return cutter.center;
    if (cutter.kind === 'path') {
      const samples = sampleCutterPath(cutter, 8);
      return samples[Math.floor(samples.length / 2)] ?? { x: 0, y: 0 };
    }
    return lerp(cutter.a, cutter.b, 0.5);
  }

  /**
   * Cut a closed loop out of a panel: an inset's contour, or a circle dropped
   * inside one. The panel keeps every point it had and gains the loop as a hole —
   * so its cloth really is the panel less what was cut out, and the loop's edges
   * are edges of it that a seam can be sewn to — and the piece that came out of
   * the hole is a piece of its own.
   *
   * The two toggles decide what becomes of that piece:
   * - **Hole** — it is dropped, and the opening is left as a hole.
   * - **Sew pieces** — it is sewn back into the opening it came from, all the way
   *   round the loop, so the cloth stays whole across the cut.
   * - Neither — it is left lying in the opening, a piece in its own right.
   */
  private commitLoopCut(piece: PatternPiece, loop: BezierPoint[], suffix: string): string | null {
    if (!piece.closed || piece.points.length < 3) return 'That panel is not a closed outline';
    if (!loopFitsOnCloth(piece, loop)) return 'The loop has to lie on the panel';
    const idx = this.pattern.pieces.findIndex((p) => p.id === piece.id);
    if (idx < 0) return 'That panel is no longer in the pattern';
    this.markBeforeChange();

    // The loop becomes a contour of the panel and the outline of the piece cut
    // out of it. Two copies, each with ids of its own: a cut leaves two things
    // that can be moved apart, and editing one must not drag the other with it.
    // Both copies read the loop the same way round, so the edges a seam pairs up
    // are the same edges.
    const holeRing = loop.map((pt) => cloneBezierPoint(pt, () => uid('pt')));
    const cutRing = loop.map((pt) => cloneBezierPoint(pt, () => uid('pt')));

    const outer: PatternPiece = {
      ...piece,
      holes: [...(piece.holes ?? []), holeRing],
    };
    const cutOut: PatternPiece = {
      id: uid('piece'),
      name: `${piece.name} ${suffix}`,
      closed: true,
      points: cutRing,
      // Anything already cut out of the panel *inside* the loop belongs to the
      // piece that came out of it now, not to the panel.
      holes: (piece.holes ?? [])
        .filter((ring) => pointInPolygon(ring[0]!.anchor, ringToPolyline(cutRing)))
        .map((ring) => ring.map((pt) => cloneBezierPoint(pt, () => uid('pt')))),
      grainline: grainlineInside(piece, cutRing),
    };
    if (cutOut.holes && cutOut.holes.length === 0) delete cutOut.holes;

    const seams: SeamBinding[] = [];
    if (this.cutSew && !this.cutHole) {
      const n = holeRing.length;
      for (let i = 0; i < n; i++) {
        seams.push({
          id: uid('seam'),
          a: {
            pieceId: outer.id,
            fromPointId: holeRing[i]!.id,
            toPointId: holeRing[(i + 1) % n]!.id,
            t0: 0,
            t1: 1,
          },
          b: {
            pieceId: cutOut.id,
            fromPointId: cutRing[i]!.id,
            toPointId: cutRing[(i + 1) % n]!.id,
            t0: 0,
            t1: 1,
          },
          restGapCm: DEFAULT_SEAM_GAP_CM,
        });
      }
    }

    this.pattern.pieces.splice(idx, 1, outer, ...(this.cutHole ? [] : [cutOut]));
    this.pattern.seams = [...this.pattern.seams, ...seams];
    this.pattern.pieceSuccessors = recordPieceSuccessors(
      this.pattern.pieceSuccessors,
      piece.id,
      this.cutHole ? [outer.id] : [outer.id, cutOut.id]
    );
    const selected = this.cutHole ? outer : cutOut;
    this.selectedPieceId = selected.id;
    this.selectEntirePiece(selected);
    this.clearCutDraft();
    this.syncCutToolbar();
    this.cbs.onChange();
    this.endHistoryGesture();
    return null;
  }

  /**
   * A dragged cut — a line, or a circle — and what it does to the panel it is
   * over. A circle that lies wholly inside a panel is cut *out* of it, the way an
   * inset is, rather than refused for not reaching the outline: that is the
   * gesture for a hole, and the toggles then decide what becomes of the piece
   * that comes out of it.
   */
  private commitDragCut(cutter: CutterPath): void {
    const piece = this.pieceForCut(cutter);
    if (!piece) {
      this.cutNotice = 'No panel under the cut';
      return;
    }
    if (piece.holes && piece.holes.length > 0) {
      this.cutNotice = 'Panels with a hole cannot be cut — cut the panel first, then punch the hole';
      return;
    }
    if (cutter.kind === 'circle') {
      const hits = findBoundaryHits(piece, cutter);
      const ring = ringFromCircle(cutter, () => uid('pt'));
      if (hits.length === 0 && loopFitsOnCloth(piece, ring)) {
        this.cutNotice = this.commitLoopCut(piece, ring, 'cut-out');
        return;
      }
      if (hits.length < 2) {
        this.cutNotice = 'A circle cuts a panel it crosses twice, or one it sits inside';
        return;
      }
    }
    this.cutNotice = this.commitCut(cutter, this.cutSew, piece);
  }

  private commitCut(
    cutter: CutterPath,
    sewSplit = false,
    piece: PatternPiece | null = this.pieceForCut(cutter)
  ): string | null {
    if (!piece) return 'No panel under the cut';
    // A ring is not something the slicer can split: it cuts closed outlines, and
    // a panel with a hole in it is an outline *and* a hole. Refused rather than
    // quietly handing back two halves with the hole dropped.
    if (piece.holes && piece.holes.length > 0) {
      return 'Panels with a hole cannot be cut — cut the panel first, then punch the hole';
    }
    this.markBeforeChange();
    const result = slicePiece(piece, cutter, () => uid('id'));
    if (!result.ok) {
      this.endHistoryGesture();
      return result.reason;
    }
    const [a, b] = result.pieces;
    const idx = this.pattern.pieces.findIndex((p) => p.id === piece.id);
    if (idx < 0) {
      this.endHistoryGesture();
      return 'That panel is no longer in the pattern';
    }
    // The two halves get fresh ids; record the lineage so downstream Transform 3D
    // nodes hand the original arrangement down instead of resetting to default.
    this.pattern.pieceSuccessors = recordPieceSuccessors(
      this.pattern.pieceSuccessors,
      piece.id,
      [a.id, b.id]
    );

    const children = [
      { piece: a, pointMap: result.pointIdMaps[0] },
      { piece: b, pointMap: result.pointIdMaps[1] },
    ] as const;
    const remapEdge = (ref: SeamEdgeRef): SeamEdgeRef | null => {
      if (ref.pieceId !== piece.id) return { ...ref };
      for (const child of children) {
        const fromPointId = child.pointMap.get(ref.fromPointId);
        const toPointId = child.pointMap.get(ref.toPointId);
        if (!fromPointId || !toPointId) continue;
        // An untouched outline edge remains adjacent on exactly one child.
        // A cut-crossed edge has a new cut point between its old endpoints,
        // so it intentionally fails this test and its seam is removed.
        if (edgeIndexForPointIds(child.piece, fromPointId, toPointId) === null) continue;
        return {
          ...ref,
          pieceId: child.piece.id,
          fromPointId,
          toPointId,
        };
      }
      return null;
    };
    const remappedSeams: SeamBinding[] = [];
    for (const seam of this.pattern.seams) {
      const seamA = remapEdge(seam.a);
      const seamB = remapEdge(seam.b);
      if (!seamA || !seamB) continue;
      remappedSeams.push({ ...seam, a: seamA, b: seamB });
    }

    this.pattern.pieces.splice(idx, 1, a, b);
    this.pattern.seams = sewSplit
      ? [
          ...remappedSeams,
          ...result.cutEdges.map(({ a: cutA, b: cutB }) => ({
            id: uid('seam'),
            a: cutA,
            b: cutB,
            restGapCm: DEFAULT_SEAM_GAP_CM,
          })),
        ]
      : remappedSeams;
    this.selectedPieceId = a.id;
    this.selectEntirePiece(a);
    this.clearCutDraft();
    this.syncCutToolbar();
    this.cbs.onChange();
    this.endHistoryGesture();
    return null;
  }

  private drawSnapGuides(): void {
    const sw = this.px(1.5);
    const dash = `${this.px(4)} ${this.px(3)}`;
    for (const g of this.snapGuides) {
      if (g.kind === 'mid') {
        const stubA = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        stubA.setAttribute('x1', String(g.a.x));
        stubA.setAttribute('y1', String(g.a.y));
        stubA.setAttribute('x2', String(g.at.x));
        stubA.setAttribute('y2', String(g.at.y));
        stubA.setAttribute('class', 'pattern-snap-guide pattern-snap-guide-mid');
        stubA.setAttribute('stroke-width', String(sw));
        stubA.setAttribute('stroke-dasharray', dash);
        stubA.setAttribute('pointer-events', 'none');
        this.svg.appendChild(stubA);

        const stubB = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        stubB.setAttribute('x1', String(g.b.x));
        stubB.setAttribute('y1', String(g.b.y));
        stubB.setAttribute('x2', String(g.at.x));
        stubB.setAttribute('y2', String(g.at.y));
        stubB.setAttribute('class', 'pattern-snap-guide pattern-snap-guide-mid');
        stubB.setAttribute('stroke-width', String(sw));
        stubB.setAttribute('stroke-dasharray', dash);
        stubB.setAttribute('pointer-events', 'none');
        this.svg.appendChild(stubB);

        const mark = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        mark.setAttribute('cx', String(g.at.x));
        mark.setAttribute('cy', String(g.at.y));
        mark.setAttribute('r', String(this.px(3.5)));
        mark.setAttribute('class', 'pattern-snap-mid-mark');
        mark.setAttribute('pointer-events', 'none');
        this.svg.appendChild(mark);
        continue;
      }

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      if (g.axis === 'x') {
        line.setAttribute('x1', String(g.at));
        line.setAttribute('x2', String(g.at));
        line.setAttribute('y1', String(Math.min(g.from, g.to)));
        line.setAttribute('y2', String(Math.max(g.from, g.to)));
      } else {
        line.setAttribute('y1', String(g.at));
        line.setAttribute('y2', String(g.at));
        line.setAttribute('x1', String(Math.min(g.from, g.to)));
        line.setAttribute('x2', String(Math.max(g.from, g.to)));
      }
      line.setAttribute('class', 'pattern-snap-guide');
      line.setAttribute('stroke-width', String(sw));
      line.setAttribute('pointer-events', 'none');
      this.svg.appendChild(line);
    }
  }

  /**
   * Midpoints of edges (t=0.5) and midpoints between every pair of
   * non-selected anchors — used as snap targets while dragging.
   */
  private collectSnapMidTargets(): SnapMidTarget[] {
    const mids: SnapMidTarget[] = [];
    const seen = new Set<string>();
    const pushMid = (a: Vec2, b: Vec2, at: Vec2) => {
      const key = `${at.x.toFixed(4)},${at.y.toFixed(4)}`;
      if (seen.has(key)) return;
      seen.add(key);
      mids.push({ at: { x: at.x, y: at.y }, a, b });
    };

    // Edge midpoints (parametric halfway — honors curves).
    for (const piece of this.pattern.pieces) {
      const pts = piece.points;
      const n = pts.length;
      if (n < 2) continue;
      const edgeCount = piece.closed ? n : n - 1;
      for (let i = 0; i < edgeCount; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        if (this.selectedIds.has(a.id) || this.selectedIds.has(b.id)) continue;
        const at = pointOnEdgeAtT(piece, a.id, b.id, 0.5);
        if (at) pushMid(a.anchor, b.anchor, at);
      }
    }

    // Chord midpoints between every pair of free anchors (incl. cross-piece).
    const free: Vec2[] = [];
    for (const piece of this.pattern.pieces) {
      for (const pt of pieceRings(piece).flat()) {
        if (!this.selectedIds.has(pt.id)) free.push(pt.anchor);
      }
    }
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i];
        const b = free[j];
        pushMid(a, b, { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
      }
    }

    return mids;
  }

  /**
   * Soft-snap a rigid selection translate toward other anchors' X/Y,
   * edge midpoints, and midpoints between point pairs.
   */
  private softSnapTranslate(
    snapshots: PointSnapshot[],
    rawDx: number,
    rawDy: number,
    enabled: boolean,
    /** The axis the drag is locked to (Shift): the other one cannot move. */
    constrainAxis: 'x' | 'y' | null = null
  ): { dx: number; dy: number; guides: SnapGuide[] } {
    // Lock first, so the snapping below can never creep along the held axis.
    if (constrainAxis === 'x') rawDy = 0;
    else if (constrainAxis === 'y') rawDx = 0;
    const allowX = constrainAxis !== 'y';
    const allowY = constrainAxis !== 'x';

    if (!enabled || snapshots.length === 0) {
      return { dx: rawDx, dy: rawDy, guides: [] };
    }

    const threshold = this.px(9);
    const midTargets = this.collectSnapMidTargets();

    const refs: Vec2[] = [];
    for (const piece of this.pattern.pieces) {
      for (const pt of pieceRings(piece).flat()) {
        if (this.selectedIds.has(pt.id)) continue;
        refs.push(pt.anchor);
      }
    }
    for (const m of midTargets) refs.push(m.at);

    if (refs.length === 0) {
      return { dx: rawDx, dy: rawDy, guides: [] };
    }

    // Prefer a full 2D snap onto a midpoint when close enough.
    let bestMidDist = threshold;
    let midAdjX = 0;
    let midAdjY = 0;
    let bestMid: SnapMidTarget | null = null;
    for (const s of snapshots) {
      const cx = s.anchor.x + rawDx;
      const cy = s.anchor.y + rawDy;
      for (const m of midTargets) {
        const d = Math.hypot(cx - m.at.x, cy - m.at.y);
        if (d < bestMidDist) {
          bestMidDist = d;
          midAdjX = m.at.x - cx;
          midAdjY = m.at.y - cy;
          bestMid = m;
        }
      }
    }

    // A midpoint snap pulls on both axes, so it is only offered when the drag is
    // free — under an axis lock it would break the constraint.
    if (bestMid && !constrainAxis) {
      const dx = rawDx + midAdjX;
      const dy = rawDy + midAdjY;
      return {
        dx,
        dy,
        guides: [{ kind: 'mid', at: bestMid.at, a: bestMid.a, b: bestMid.b }],
      };
    }

    let bestAbsDx = threshold;
    let snapAdjX = 0;
    let bestAbsDy = threshold;
    let snapAdjY = 0;

    for (const s of snapshots) {
      const cx = s.anchor.x + rawDx;
      const cy = s.anchor.y + rawDy;
      for (const ref of refs) {
        const adx = Math.abs(cx - ref.x);
        if (adx < bestAbsDx) {
          bestAbsDx = adx;
          snapAdjX = ref.x - cx;
        }
        const ady = Math.abs(cy - ref.y);
        if (ady < bestAbsDy) {
          bestAbsDy = ady;
          snapAdjY = ref.y - cy;
        }
      }
    }

    const dx = allowX ? rawDx + (bestAbsDx < threshold ? snapAdjX : 0) : 0;
    const dy = allowY ? rawDy + (bestAbsDy < threshold ? snapAdjY : 0) : 0;

    // Build guides for every alignment that holds after the snap
    const eps = Math.max(1e-4, threshold * 0.05);
    const guides: SnapGuide[] = [];
    const seenV = new Set<string>();
    const seenH = new Set<string>();

    for (const s of snapshots) {
      const mx = s.anchor.x + dx;
      const my = s.anchor.y + dy;
      for (const ref of refs) {
        if (allowX && Math.abs(mx - ref.x) <= eps) {
          const key = `v:${ref.x.toFixed(4)}:${Math.min(my, ref.y).toFixed(3)}:${Math.max(my, ref.y).toFixed(3)}`;
          if (!seenV.has(key)) {
            seenV.add(key);
            guides.push({ kind: 'axis', axis: 'x', at: ref.x, from: my, to: ref.y });
          }
        }
        if (allowY && Math.abs(my - ref.y) <= eps) {
          const key = `h:${ref.y.toFixed(4)}:${Math.min(mx, ref.x).toFixed(3)}:${Math.max(mx, ref.x).toFixed(3)}`;
          if (!seenH.has(key)) {
            seenH.add(key);
            guides.push({ kind: 'axis', axis: 'y', at: ref.y, from: mx, to: ref.x });
          }
        }
      }
    }

    return { dx, dy, guides };
  }

  /** Padded bbox used for selection chrome + scale handle math. */
  private selectionScaleBox(): BBox | null {
    const box = this.selectionBBox();
    if (!box) return null;
    const pad = this.px(6);
    return {
      minX: box.minX - pad,
      minY: box.minY - pad,
      maxX: box.maxX + pad,
      maxY: box.maxY + pad,
    };
  }

  /** True when the picked points sit on generated (block-owned) geometry. */
  private selectionIsGenerated(): boolean {
    for (const piece of this.pattern.pieces) {
      if (!this.blockOwnership.has(piece.id)) continue;
      if (piece.points.some((pt) => this.selectedIds.has(pt.id))) return true;
    }
    return false;
  }

  /**
   * The orbit's guide: a faint ring at the tether's length round the point it
   * turns about, and a hairline out to the point that moves, so the radius in
   * hand reads against the work. Drawn before the selection chrome, so the
   * points and handles that the drag takes hold of stay on top of it.
   */
  private drawOrbitGuide(): void {
    if (this.tool !== 'move' || this.moveMode !== 'orbit') return;
    const orbit = this.orbit;
    if (!orbit) return;
    const pivot = this.orbitPointById(orbit.centerPointId);
    const moving = this.orbitPointById(orbit.movingPointId);
    if (!pivot || !moving) return;
    const c = pivot.point.anchor;

    const ring = svgEl('circle');
    ring.setAttribute('cx', String(c.x));
    ring.setAttribute('cy', String(c.y));
    ring.setAttribute('r', String(orbit.radius));
    ring.setAttribute('class', 'pattern-orbit-ring');
    ring.setAttribute('stroke-width', String(this.px(1.25)));
    ring.setAttribute('stroke-dasharray', `${this.px(5)} ${this.px(4)}`);
    ring.setAttribute('pointer-events', 'none');
    this.svg.appendChild(ring);

    const spoke = svgEl('line');
    spoke.setAttribute('x1', String(c.x));
    spoke.setAttribute('y1', String(c.y));
    spoke.setAttribute('x2', String(moving.point.anchor.x));
    spoke.setAttribute('y2', String(moving.point.anchor.y));
    spoke.setAttribute('class', 'pattern-orbit-spoke');
    spoke.setAttribute('stroke-width', String(this.px(1)));
    spoke.setAttribute('pointer-events', 'none');
    this.svg.appendChild(spoke);

    const mark = svgEl('circle');
    mark.setAttribute('cx', String(c.x));
    mark.setAttribute('cy', String(c.y));
    mark.setAttribute('r', String(this.px(3)));
    mark.setAttribute('class', 'pattern-orbit-pivot');
    mark.setAttribute('stroke-width', String(this.px(1.5)));
    mark.setAttribute('pointer-events', 'none');
    this.svg.appendChild(mark);
  }

  private drawSelectionChrome(): void {
    if (this.selectedIds.size < 2) return;
    const box = this.selectionScaleBox();
    if (!box) return;
    // A selection over generated geometry is an indicator, not a set of handles.
    // A block moves as a unit and its points are rebuilt from its variables, so
    // scale grips on it would edit something that is about to be thrown away —
    // and a box that swallowed the click would rob the block of its own drag,
    // which is how it is meant to be moved.
    const generated = this.selectionIsGenerated();
    const x = box.minX;
    const y = box.minY;
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute(
      'class',
      `pattern-selection-box${generated ? ' is-indicator' : ''}`
    );
    rect.setAttribute('stroke-width', String(this.px(1.75)));
    rect.setAttribute('stroke-dasharray', `${this.px(7)} ${this.px(4)}`);
    rect.dataset.kind = 'selectionBox';
    this.svg.appendChild(rect);
    if (generated) return;

    const hs = this.px(8);
    const handleSw = this.px(1.5);
    const midX = x + w / 2;
    const midY = y + h / 2;
    const handles: Array<{ handle: ScaleHandle; cx: number; cy: number }> = [
      { handle: 'nw', cx: x, cy: y },
      { handle: 'ne', cx: x + w, cy: y },
      { handle: 'sw', cx: x, cy: y + h },
      { handle: 'se', cx: x + w, cy: y + h },
      { handle: 'n', cx: midX, cy: y },
      { handle: 's', cx: midX, cy: y + h },
      { handle: 'w', cx: x, cy: midY },
      { handle: 'e', cx: x + w, cy: midY },
    ];

    // A dashed ring outside each corner: the rotate zone, drawn where it can be
    // seen. The grip is a small exact target, so the gesture “just outside it”
    // needs to be visible or nobody finds it. Pointer-events stay off — the hit
    // test is distance-based, in `rotateZoneHandle`.
    for (const c of handles) {
      if (!CORNER_HANDLES.includes(c.handle)) continue;
      const ring = svgEl('circle');
      const inner = this.rotateZoneInner();
      const outer = this.rotateZoneOuter();
      ring.setAttribute('cx', String(c.cx));
      ring.setAttribute('cy', String(c.cy));
      ring.setAttribute('r', String((inner + outer) / 2 - (outer - inner) / 4));
      ring.setAttribute('class', `pattern-rotate-ring${this.hoverRotate === c.handle ? ' is-hot' : ''}`);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke-width', String(this.px(1.25)));
      ring.setAttribute('stroke-dasharray', `${this.px(3)} ${this.px(3)}`);
      ring.setAttribute('pointer-events', 'none');
      this.svg.appendChild(ring);
    }

    for (const c of handles) {
      const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      handle.setAttribute('x', String(c.cx - hs / 2));
      handle.setAttribute('y', String(c.cy - hs / 2));
      handle.setAttribute('width', String(hs));
      handle.setAttribute('height', String(hs));
      handle.setAttribute('class', 'pattern-scale-handle');
      handle.setAttribute('stroke-width', String(handleSw));
      handle.dataset.kind = 'scale';
      handle.dataset.handle = c.handle;
      // Keep legacy attr for any CSS that still keys off corner.
      if (c.handle.length === 2) handle.dataset.corner = c.handle;
      this.svg.appendChild(handle);
    }
  }

  /**
   * One piece: its outline and fill, then everything drawn *on* it — edge lengths,
   * the grainline, its points and handles.
   *
   * `mark` is what a zoomed-out canvas asks for. The outline is always drawn —
   * however far out you go, the shape of the work is the one thing worth showing —
   * and the marks that would be unreadable at that size are dropped: `silhouette`
   * keeps a faint fill as well, `outline` is the bare line.
   */
  private drawPiece(
    piece: PatternPiece,
    mark: 'full' | 'silhouette' | 'outline' = 'full'
  ): void {
    const n = piece.points.length;
    // Generated geometry reads as one family: lavender lines and points say
    // "this is drafted from variables" at a glance, and marks the pieces that
    // will be rebuilt the moment a variable moves.
    const block = this.blockOwnership.get(piece.id);
    const blockCls = block ? ' is-block' : '';
    if (n > 0) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', this.piecePathD(piece));
      path.setAttribute('class', `pattern-fill${blockCls}`);
      // Even-odd, so a hole in the piece is genuinely not cloth.
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('stroke-width', String(this.px(2)));
      if (mark === 'silhouette') {
        path.setAttribute('fill-opacity', String(SILHOUETTE_FILL_OPACITY));
      } else if (mark === 'outline') {
        path.setAttribute('fill', 'none');
      }
      path.dataset.pieceId = piece.id;
      this.svg.appendChild(path);
    }
    if (mark !== 'full') return;

    // Every edge carries its length while the points are on show: an unlabelled
    // edge is a measurement missing from the sheet, and the points are what you
    // are reading the numbers against. Longest edges are placed first, in the
    // middle of their edge, because those are the ones you actually measure. An
    // edge too short to hold its own text there — a dart leg, a notch, the ease
    // on a drafted block — is labelled just outside the piece instead, pushed
    // further out until it is clear of the labels already placed.
    //
    // A piece with hundreds of edges is not one you read numbers off: a
    // rasterised glyph is a staircase of one-pixel steps. Past that many edges
    // only the ones long enough to hold their text are marked, which is what
    // every piece used to do.
    const maxLabelledEdges = 80;
    const labelPx = 11;
    const fontSize = this.px(labelPx);
    const outset = this.px(labelPx * 0.55 + 6);
    type Candidate = {
      index: number;
      length: number;
      text: string;
      /** Where the label sits when it fits along the edge. */
      x: number;
      y: number;
      /** The middle of the edge itself, which the fallback steps out from. */
      mx: number;
      my: number;
      w: number;
      h: number;
      /** Unit normal pointing away from the cloth, for the fallback places. */
      nx: number;
      ny: number;
    };
    const candidates: Candidate[] = [];
    // Holes are labelled like the outline: their edges are measured, sewn and
    // allowed for like any other, so they read the same way.
    const rings = pieceRings(piece);
    const edgeTotal = rings.reduce((sum, _ring, r) => sum + ringEdgeCount(piece, r), 0);
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r]!;
      const lengths = segmentLengths(ring, r === 0 ? piece.closed : true);
      const edgeCount = ringEdgeCount(piece, r);
      for (let i = 0; i < edgeCount; i++) {
        const length = lengths[i] ?? 0;
        const text = formatLength(length, this.unit, 1);
        if (edgeTotal > maxLabelledEdges && this.px(text.length * labelPx * 0.62 + 8) > length) {
          continue;
        }
        const a = ring[i].anchor;
        const b = ring[(i + 1) % ring.length].anchor;
        let nx = -(b.y - a.y);
        let ny = b.x - a.x;
        const span = Math.hypot(nx, ny) || 1;
        nx /= span;
        ny /= span;
        // Which side of the edge is not cloth: outside an outline, inside a hole.
        const probe = this.px(2);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        if (pointInPiece({ x: midX + nx * probe, y: midY + ny * probe }, piece)) {
          nx = -nx;
          ny = -ny;
        }
        candidates.push({
          index: pieceEdgeNumber(piece, r, i),
          length,
          text,
          x: midX,
          y: midY - this.px(10),
          mx: midX,
          my: midY,
          // The text's box, in the pattern units the boxes are compared in —
          // it was measured in screen pixels, which made every label look four
          // times the size it is and turned most of them away as clashes.
          w: this.px(text.length * labelPx * 0.62),
          h: this.px(labelPx * 1.1),
          nx,
          ny,
        });
      }
    }
    candidates.sort((a, b) => b.length - a.length);
    const placed: Array<{ index: number; text: string; x: number; y: number }> = [];
    const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    const clear = (x: number, y: number, c: Candidate): boolean => {
      const box = { x0: x - c.w / 2, y0: y - c.h / 2, x1: x + c.w / 2, y1: y + c.h / 2 };
      return !boxes.some(
        (b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0
      );
    };
    const claim = (x: number, y: number, c: Candidate): void => {
      boxes.push({ x0: x - c.w / 2, y0: y - c.h / 2, x1: x + c.w / 2, y1: y + c.h / 2 });
      placed.push({ index: c.index, text: c.text, x, y });
    };
    for (const c of candidates) {
      // The middle of the edge first, then the same place stepped outwards.
      if (clear(c.x, c.y, c)) {
        claim(c.x, c.y, c);
        continue;
      }
      let placedAt: { x: number; y: number } | null = null;
      for (const step of [1, 1.9, 2.8, 3.7]) {
        const x = c.mx + c.nx * outset * step;
        const y = c.my + c.ny * outset * step;
        if (!clear(x, y, c)) continue;
        placedAt = { x, y };
        break;
      }
      // Even crowded, the edge keeps its number: further out is better than none.
      if (placedAt) claim(placedAt.x, placedAt.y, c);
      else claim(c.mx + c.nx * outset * 3.7, c.my + c.ny * outset * 3.7, c);
    }
    placed.sort((a, b) => a.index - b.index);
    for (const p of placed) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(p.x));
      label.setAttribute('y', String(p.y));
      label.setAttribute('class', 'pattern-length');
      label.setAttribute('font-size', String(fontSize));
      label.setAttribute('pointer-events', 'none');
      label.style.userSelect = 'none';
      label.textContent = p.text;
      this.svg.appendChild(label);
    }

    if (piece.grainline && this.grainOn) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      g.setAttribute('x1', String(piece.grainline.from.x));
      g.setAttribute('y1', String(piece.grainline.from.y));
      g.setAttribute('x2', String(piece.grainline.to.x));
      g.setAttribute('y2', String(piece.grainline.to.y));
      g.setAttribute('class', `pattern-grain${blockCls}`);
      // Every mark belonging to a piece has to advertise it: the editor resolves
      // "which piece was clicked" from the event target, so artwork without the
      // id swallows the gesture and the piece looks dead under the cursor.
      g.dataset.pieceId = piece.id;
      g.setAttribute('stroke-width', String(this.px(2)));
      g.setAttribute('stroke-dasharray', `${this.px(6)} ${this.px(4)}`);
      this.svg.appendChild(g);
    }

    const showHandles =
      (this.tool === 'add' && this.addMode === 'pen') ||
      (this.tool === 'move' && this.selectedIds.size === 1);

    const pointR = this.px(5);
    const pointSw = this.px(1.5);
    for (const pt of pieceRings(piece).flat()) {
      if (showHandles && (pt.handleIn || pt.handleOut || this.selectedIds.has(pt.id))) {
        this.drawHandles(piece, pt);
      }
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(pt.anchor.x));
      c.setAttribute('cy', String(pt.anchor.y));
      c.setAttribute('r', String(pointR));
      c.setAttribute('stroke-width', String(pointSw));
      c.setAttribute(
        'class',
        `${this.selectedIds.has(pt.id) ? 'pattern-point selected' : 'pattern-point'}${blockCls}`
      );
      c.dataset.pointId = pt.id;
      c.dataset.pieceId = piece.id;
      c.dataset.kind = 'anchor';
      this.svg.appendChild(c);
    }
  }

  private piecePathD(piece: PatternPiece): string {
    const pts = piece.points;
    if (pts.length === 0) return '';
    const subpath = (ring: BezierPoint[]): string => {
      let d = `M ${ring[0].anchor.x} ${ring[0].anchor.y}`;
      const n = ring.length;
      const edgeCount = piece.closed || ring !== pts ? n : Math.max(0, n - 1);
      for (let i = 0; i < edgeCount; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        const { c0, c1 } = edgeHandles(a, b);
        if (edgeIsStraight(a, b)) d += ` L ${b.anchor.x} ${b.anchor.y}`;
        else d += ` C ${c0.x} ${c0.y}, ${c1.x} ${c1.y}, ${b.anchor.x} ${b.anchor.y}`;
      }
      if (piece.closed || ring !== pts) d += ' Z';
      return d;
    };
    // Each hole is a subpath of the same path, and the path is filled even-odd, so
    // what the fill covers is the cloth: the outline less everything cut out of it.
    return pieceRings(piece).map(subpath).join(' ');
  }

  private drawHandles(piece: PatternPiece, pt: BezierPoint): void {
    const lineSw = this.px(1.25);
    const handleR = this.px(4);
    const handleSw = this.px(1.5);
    const drawOne = (h: Vec2, which: 'in' | 'out') => {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(pt.anchor.x));
      line.setAttribute('y1', String(pt.anchor.y));
      line.setAttribute('x2', String(h.x));
      line.setAttribute('y2', String(h.y));
      line.setAttribute('class', 'pattern-handle-line');
      line.setAttribute('stroke-width', String(lineSw));
      this.svg.appendChild(line);
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(h.x));
      c.setAttribute('cy', String(h.y));
      c.setAttribute('r', String(handleR));
      c.setAttribute('stroke-width', String(handleSw));
      c.setAttribute('class', 'pattern-handle');
      c.dataset.pointId = pt.id;
      c.dataset.pieceId = piece.id;
      c.dataset.kind = which === 'in' ? 'handleIn' : 'handleOut';
      this.svg.appendChild(c);
    };
    if (pt.handleIn) drawOne(pt.handleIn, 'in');
    if (pt.handleOut) drawOne(pt.handleOut, 'out');
  }

  private svgPointFromClient(clientX: number, clientY: number): Vec2 {
    // Board CSS scale breaks getScreenCTM(); map via getBoundingClientRect + viewBox (xMidYMid meet).
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { x: 0, y: 0 };
    // The box the SVG is actually drawing — which for a locked container is the
    // frame, not the editor's own pan/zoom behind it.
    const vb = this.effectiveViewBox();
    const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
    const mappedW = vb.w * scale;
    const mappedH = vb.h * scale;
    const ox = rect.left + (rect.width - mappedW) / 2;
    const oy = rect.top + (rect.height - mappedH) / 2;
    return {
      x: vb.x + (clientX - ox) / scale,
      y: vb.y + (clientY - oy) / scale,
    };
  }

  private svgPoint(e: PointerEvent): Vec2 {
    return this.svgPointFromClient(e.clientX, e.clientY);
  }

  /**
   * Pattern-space length equal to `cssPixels` inside the SVG element.
   * Uses clientWidth/Height (not getBoundingClientRect) so parent board CSS
   * zoom doesn't skew the viewBox→layout mapping used for chrome sizing.
   */
  private px(cssPixels: number): number {
    const s = this.viewScale();
    return cssPixels / s;
  }

  /** Layout CSS px per pattern unit (xMidYMid meet). */
  private viewScale(): number {
    if (this.viewScaleCache != null) return this.viewScaleCache;
    const box = this.effectiveViewBox();
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
    // Before flex layout settles, client size is 0 — assume a typical pattern
    // viewport so we don't bake 1px≈1cm chrome (huge labels/handles). Deliberately
    // not cached: it is a placeholder, and storing it would size the whole drawing
    // for a viewport that never existed.
    if (w < 2 || h < 2) {
      const assumed = 360;
      return (Math.min(assumed / box.w, assumed / box.h)) * this.chromeScale();
    }
    return (Math.min(w / box.w, h / box.h)) * this.chromeScale();
  }

  /**
   * Screen px per pattern unit — for pointer math and for anything that has to
   * judge a distance the way the eye sees it. The element's rendered box already
   * includes the host's CSS scale, and `effectiveViewBox` is what is actually
   * drawn, so this is the screen scale for a container as well as a free editor.
   */
  private screenToPatternScale(): number {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return 1;
    const box = this.effectiveViewBox();
    return Math.min(rect.width / box.w, rect.height / box.h);
  }

  private hitRadius(): number {
    return this.px(10);
  }

  private findPointNear(p: Vec2): { piece: PatternPiece; point: BezierPoint } | null {
    const r = this.hitRadius();
    for (const piece of this.pattern.pieces) {
      for (const pt of piece.points) {
        if (dist(p, pt.anchor) <= r) return { piece, point: pt };
      }
    }
    return null;
  }

  /**
   * The anchor under the pointer: the nearest one, holes included. What an orbit
   * pick and an Alt-click both take.
   */
  private anchorPointAt(p: Vec2): { piece: PatternPiece; point: BezierPoint } | null {
    let best: { piece: PatternPiece; point: BezierPoint } | null = null;
    let bestDistance = this.hitRadius();
    for (const piece of this.pattern.pieces) {
      for (const pt of pieceRings(piece).flat()) {
        const d = dist(p, pt.anchor);
        if (d <= bestDistance) {
          bestDistance = d;
          best = { piece, point: pt };
        }
      }
    }
    return best;
  }

  private orbitPointById(pointId: string): { piece: PatternPiece; point: BezierPoint } | null {
    for (const piece of this.pattern.pieces) {
      const point = piecePointById(piece, pointId);
      if (point) return { piece, point };
    }
    return null;
  }

  /**
   * The Orbit half of the Move tool: pick the point that moves, then the point
   * it turns about, and the tether between them is set to the distance they
   * already had. A drag on the moving point then swings it, and Shift-drag pulls
   * the tether in or out. Returns false when the press is not the tool's own, so
   * the canvas reads it the way it always does.
   */
  private onOrbitDown(e: PointerEvent, p: Vec2): boolean {
    const hit = this.anchorPointAt(p);
    if (this.orbit) {
      if (hit && hit.point.id === this.orbit.movingPointId) {
        this.beginOrbitDrag(e);
        return true;
      }
      // Another point starts a new tether; bare canvas lets the old one go.
      this.clearOrbit();
      this.syncToolSettings();
      this.redraw();
      if (!hit) return false;
    }
    if (!hit) return false;
    if (this.orbitPickId && this.orbitPickId !== hit.point.id) {
      const moving = this.orbitPointById(this.orbitPickId);
      if (moving) {
        this.orbit = {
          movingPointId: moving.point.id,
          centerPointId: hit.point.id,
          radius: Math.max(MIN_ORBIT_RADIUS_CM, dist(moving.point.anchor, hit.point.anchor)),
        };
        this.orbitPickId = null;
        // The point on the move stays the picked one: it is the one a drag takes.
        this.selectOnly(moving.point.id, moving.piece.id);
        this.syncToolSettings();
        this.redraw();
        return true;
      }
    }
    this.orbitPickId = hit.point.id;
    this.selectOnly(hit.point.id, hit.piece.id);
    this.syncToolSettings();
    this.redraw();
    return true;
  }

  private beginOrbitDrag(e: PointerEvent): void {
    const orbit = this.orbit;
    if (!orbit) return;
    const center = this.orbitPointById(orbit.centerPointId);
    const moving = this.orbitPointById(orbit.movingPointId);
    if (!center || !moving) {
      this.clearOrbit();
      this.syncToolSettings();
      this.redraw();
      return;
    }
    const c = { ...center.point.anchor };
    this.drag = {
      type: 'orbit',
      center: c,
      startRadius: orbit.radius,
      radius: orbit.radius,
      baseAngle: Math.atan2(moving.point.anchor.y - c.y, moving.point.anchor.x - c.x),
      angle: 0,
      snapshots: [
        {
          pieceId: moving.piece.id,
          pointId: moving.point.id,
          anchor: { ...moving.point.anchor },
          handleIn: moving.point.handleIn ? { ...moving.point.handleIn } : null,
          handleOut: moving.point.handleOut ? { ...moving.point.handleOut } : null,
        },
      ],
      moved: false,
    };
    this.selectOnly(moving.point.id, moving.piece.id);
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.redraw();
  }

  /**
   * Put the moving point on the tether as it stands: bearing kept, distance made
   * the radius. What typing a radius does, and what a Shift-drag leaves behind.
   */
  private placeOrbitPoint(): void {
    const orbit = this.orbit;
    if (!orbit) return;
    const pivot = this.orbitPointById(orbit.centerPointId);
    const moving = this.orbitPointById(orbit.movingPointId);
    if (!pivot || !moving) return;
    const c = pivot.point.anchor;
    const length = Math.hypot(moving.point.anchor.x - c.x, moving.point.anchor.y - c.y);
    // A point sitting on the pivot has no bearing to keep: it stays put.
    if (length <= 1e-6) return;
    const scale = orbit.radius / length;
    const about = (v: Vec2): Vec2 => ({
      x: c.x + (v.x - c.x) * scale,
      y: c.y + (v.y - c.y) * scale,
    });
    moving.point.anchor = about(moving.point.anchor);
    if (moving.point.handleIn) moving.point.handleIn = about(moving.point.handleIn);
    if (moving.point.handleOut) moving.point.handleOut = about(moving.point.handleOut);
  }

  /**
   * Put the moving point where the tether says: carried round the pivot by
   * `angle`, and held at the radius in force. Its handles come with it, so the
   * curve through the point keeps its shape.
   */
  private applyOrbitTransform(d: Extract<DragKind, { type: 'orbit' }>): void {
    const scale = d.startRadius > 0 ? d.radius / d.startRadius : 1;
    const cos = Math.cos(d.angle) * scale;
    const sin = Math.sin(d.angle) * scale;
    const about = (v: Vec2): Vec2 => {
      const x = v.x - d.center.x;
      const y = v.y - d.center.y;
      return { x: d.center.x + x * cos - y * sin, y: d.center.y + x * sin + y * cos };
    };
    for (const s of d.snapshots) {
      const piece = this.pattern.pieces.find((x) => x.id === s.pieceId);
      const pt = piece ? piecePointById(piece, s.pointId) : null;
      if (!pt) continue;
      pt.anchor = about(s.anchor);
      if (s.handleIn) pt.handleIn = about(s.handleIn);
      if (s.handleOut) pt.handleOut = about(s.handleOut);
    }
  }

  private snapshotSelection(): PointSnapshot[] {
    const out: PointSnapshot[] = [];
    for (const piece of this.pattern.pieces) {
      // Every ring, so a panel picked up whole takes the holes cut out of it
      // along with it instead of sliding off them.
      for (const pt of pieceRings(piece).flat()) {
        if (!this.selectedIds.has(pt.id)) continue;
        out.push({
          pieceId: piece.id,
          pointId: pt.id,
          anchor: { ...pt.anchor },
          handleIn: pt.handleIn ? { ...pt.handleIn } : null,
          handleOut: pt.handleOut ? { ...pt.handleOut } : null,
        });
      }
    }
    return out;
  }

  private applySnapshotsTranslated(snapshots: PointSnapshot[], dx: number, dy: number): void {
    for (const s of snapshots) {
      const piece = this.pattern.pieces.find((x) => x.id === s.pieceId);
      const pt = piece ? piecePointById(piece, s.pointId) : null;
      if (!pt) continue;
      pt.anchor = { x: s.anchor.x + dx, y: s.anchor.y + dy };
      if (s.handleIn) pt.handleIn = { x: s.handleIn.x + dx, y: s.handleIn.y + dy };
      if (s.handleOut) pt.handleOut = { x: s.handleOut.x + dx, y: s.handleOut.y + dy };
    }
  }

  private applySnapshotsScaled(
    snapshots: PointSnapshot[],
    fixed: Vec2,
    sx: number,
    sy: number
  ): void {
    const safeSx = Number.isFinite(sx) && Math.abs(sx) > 1e-6 ? sx : Math.sign(sx) || 1e-6;
    const safeSy = Number.isFinite(sy) && Math.abs(sy) > 1e-6 ? sy : Math.sign(sy) || 1e-6;
    const map = (v: Vec2): Vec2 => ({
      x: fixed.x + (v.x - fixed.x) * safeSx,
      y: fixed.y + (v.y - fixed.y) * safeSy,
    });
    this.mapSnapshots(snapshots, map);
  }

  /** Rotate the selection about a pivot. Anchors *and* handles turn together. */
  private applySnapshotsRotated(
    snapshots: PointSnapshot[],
    pivot: Vec2,
    angle: number
  ): void {
    this.mapSnapshots(snapshots, (v) => rotatePoint(v, pivot, angle));
  }

  private mapSnapshots(snapshots: PointSnapshot[], map: (v: Vec2) => Vec2): void {
    for (const s of snapshots) {
      const piece = this.pattern.pieces.find((x) => x.id === s.pieceId);
      const pt = piece ? piecePointById(piece, s.pointId) : null;
      if (!pt) continue;
      pt.anchor = map(s.anchor);
      if (s.handleIn) pt.handleIn = map(s.handleIn);
      if (s.handleOut) pt.handleOut = map(s.handleOut);
    }
  }

  private pointsInRect(a: Vec2, b: Vec2): string[] {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const ids: string[] = [];
    for (const piece of this.pattern.pieces) {
      for (const pt of piece.points) {
        if (
          pt.anchor.x >= minX &&
          pt.anchor.x <= maxX &&
          pt.anchor.y >= minY &&
          pt.anchor.y <= maxY
        ) {
          ids.push(pt.id);
          this.selectedPieceId = piece.id;
        }
      }
    }
    return ids;
  }

  /**
   * The pieces a rectangle touches, judged on the bounds of their outline: the
   * rectangle reaching any part of a panel means that panel, so a Cmd-drag
   * picks out whole pieces however it is drawn.
   */
  private piecesInRect(a: Vec2, b: Vec2): PatternPiece[] {
    const rect: BBox = {
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxY: Math.max(a.y, b.y),
    };
    const hits: PatternPiece[] = [];
    for (const piece of this.pattern.pieces) {
      if (piece.points.length === 0) continue;
      if (!boxesOverlap(anchorsBounds(piece.points), rect)) continue;
      hits.push(piece);
    }
    return hits;
  }

  /**
   * Cmd/Ctrl-drag over the canvas: everything the rectangle touches joins the
   * selection as whole pieces, so the panels come away with every point picked
   * rather than a scatter of the handles that happened to fall inside it.
   */
  private addPiecesInRect(a: Vec2, b: Vec2): void {
    const hits = this.piecesInRect(a, b);
    if (hits.length === 0) return;
    const ids = new Set(this.selectedIds);
    for (const piece of hits) for (const pt of piece.points) ids.add(pt.id);
    this.selectedPieceId = hits[hits.length - 1].id;
    this.setSelection([...ids], this.selectedPointId);
  }

  /**
   * Cmd/Ctrl-click on a panel takes the whole piece in or out of the selection,
   * never the single corner of it under the pointer — the piece is the unit
   * here, the way a point is the unit for Shift-click on a marker.
   */
  private toggleEntirePiece(piece: PatternPiece): void {
    const own = new Set(piece.points.map((pt) => pt.id));
    if (!this.isEntirePieceSelected(piece)) {
      for (const id of own) this.selectedIds.add(id);
      this.selectedPointId = null;
      this.selectedPieceId = piece.id;
      this.releaseBlockSelection();
      return;
    }

    for (const id of own) this.selectedIds.delete(id);
    if (this.selectedPointId && own.has(this.selectedPointId)) {
      this.selectedPointId = this.selectedIds.values().next().value ?? null;
    }
    // Hand the piece in hand over to one that is still picked, so a later edit
    // cannot land on the piece just dropped.
    if (this.selectedPieceId === piece.id) {
      const picked = this.pattern.pieces.find((entry) =>
        entry.points.some((pt) => this.selectedIds.has(pt.id))
      );
      if (picked) this.selectedPieceId = picked.id;
    }
    this.releaseBlockSelection();
  }

  private scaleFixedPoint(box: BBox, handle: ScaleHandle): Vec2 {
    const midX = (box.minX + box.maxX) / 2;
    const midY = (box.minY + box.maxY) / 2;
    switch (handle) {
      case 'nw':
        return { x: box.maxX, y: box.maxY };
      case 'ne':
        return { x: box.minX, y: box.maxY };
      case 'sw':
        return { x: box.maxX, y: box.minY };
      case 'se':
        return { x: box.minX, y: box.minY };
      case 'n':
        return { x: midX, y: box.maxY };
      case 's':
        return { x: midX, y: box.minY };
      case 'w':
        return { x: box.maxX, y: midY };
      case 'e':
        return { x: box.minX, y: midY };
    }
  }

  /** Inner edge of the rotate zone: just clear of the drawn grip. */
  private rotateZoneInner(): number {
    return this.px(7);
  }

  /** Outer edge of the rotate zone: how far out a drag still reads as rotate. */
  private rotateZoneOuter(): number {
    return this.px(20);
  }

  /**
   * The corner whose rotate zone the pointer is in, or null.
   *
   * Trimmed to *outside* the selection box: a drag that starts inside the box
   * means “move”, and for a small selection the zone would otherwise cover the
   * whole thing.
   */
  private rotateCornerAt(p: Vec2, box: BBox): ScaleHandle | null {
    return rotateZoneAt(p, box, this.rotateZoneInner(), this.rotateZoneOuter());
  }

  private scaleAxisForHandle(handle: ScaleHandle): 'both' | 'x' | 'y' {
    if (handle === 'n' || handle === 's') return 'y';
    if (handle === 'e' || handle === 'w') return 'x';
    return 'both';
  }

  private selectEntirePiece(piece: PatternPiece): void {
    this.selectedPieceId = piece.id;
    this.setSelection(pieceRings(piece).flat().map((pt) => pt.id));
  }

  private pieceFromPointId(pointId: string): PatternPiece | null {
    for (const piece of this.pattern.pieces) {
      if (pieceRings(piece).some((ring) => ring.some((pt) => pt.id === pointId))) return piece;
    }
    return null;
  }

  private resolveContextPiece(e: MouseEvent): PatternPiece | null {
    const target = e.target as SVGElement;
    const pieceId = target.dataset?.pieceId;
    if (pieceId) {
      return this.pattern.pieces.find((p) => p.id === pieceId) ?? null;
    }
    const pointId = target.dataset?.pointId;
    if (pointId) {
      return this.pieceFromPointId(pointId);
    }
    // Selection box / scale handle → active selection's piece
    if (this.selectedIds.size > 0) {
      const first = this.selectedIds.values().next().value as string | undefined;
      if (first) {
        const fromSel = this.pieceFromPointId(first);
        if (fromSel) return fromSel;
      }
    }
    // Click near an edge of the active piece
    const p = this.svgPointFromClient(e.clientX, e.clientY);
    const piece = this.activePiece();
    if (piece && piece.points.length >= 2) {
      const hit = findNearestPieceEdge(piece, p);
      if (hit && hit.dist <= this.hitRadius() * 2.5) return piece;
    }
    return null;
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    this.root.focus({ preventScroll: true });

    // A cut chain in progress owns the right-click: it throws it away rather
    // than opening a menu about whatever happens to be underneath.
    if (this.tool === 'cut' && this.cutMode === 'curve' && this.cutChain.length > 0) {
      e.stopPropagation();
      this.cancelCutChain();
      return;
    }

    // Cancel pending sew pick instead of opening the piece menu
    if (this.pendingSeam) {
      e.stopPropagation();
      this.pendingSeam = null;
      this.hoverEdge = null;
      this.hideContextMenu();
      this.redraw();
      return;
    }

    const p = this.svgPointFromClient(e.clientX, e.clientY);

    // Right-clicking a measurement's value throws the measurement away — the
    // readout is the handle, so the gesture lands on the thing it deletes. Undo
    // brings it back.
    const measureHit = this.findMeasureHit(p);
    if (measureHit) {
      e.stopPropagation();
      e.preventDefault();
      this.deleteMeasure(measureHit.id);
      this.redraw();
      return;
    }

    const rulerHit = this.findRulerHit(p);
    if (rulerHit) {
      e.stopPropagation();
      this.setRulerSelection(rulerHit.id);
      this.showContextMenu(e.clientX, e.clientY, 'ruler');
      this.redraw();
      return;
    }

    const seamHit = this.findSeamNearClick(p);
    if (seamHit) {
      e.stopPropagation();
      this.contextSeamId = seamHit.id;
      const near = this.findNearestEdgeAcrossPieces(p);
      this.contextSeamHit = near
        ? {
            pieceId: near.piece.id,
            fromPointId: near.fromPointId,
            toPointId: near.toPointId,
            t: near.t,
          }
        : null;
      this.contextPieceId = null;
      this.showContextMenu(e.clientX, e.clientY, 'seam');
      this.redraw();
      return;
    }

    const piece = this.resolveContextPiece(e);
    if (!piece || piece.points.length === 0) {
      // Nothing pattern-specific under the cursor: let the event carry on so
      // the node's own context menu (duplicate / delete) can take over.
      this.hideContextMenu();
      return;
    }
    e.stopPropagation();
    // Right-clicking picks the whole piece so the menu's duplicate/mirror acts
    // have something to work on — but not when the draftsperson has already
    // picked a run of this piece's points, which is a selection in its own right.
    if (this.pickedRuns(piece).length === 0) this.selectEntirePiece(piece);
    this.contextPieceId = piece.id;
    this.contextSeamId = null;
    this.showContextMenu(e.clientX, e.clientY, 'piece');
    this.redraw();
  }

  private showContextMenu(
    clientX: number,
    clientY: number,
    mode: 'piece' | 'seam' | 'ruler' = 'piece'
  ): void {
    const pieceActs = ['duplicate', 'mirror-x', 'mirror-y', 'delete-piece'];
    const seamActs = ['reverse-seam', 'reverse-seam-order', 'remove-seam'];
    const rulerActs = ['ruler-toggle-half', 'ruler-delete'];
    // Simplifying needs a run of picked points to work on — and a piece whose
    // points are its own: a block's points come from its variables, so reducing
    // them would be undone by the next regeneration.
    const simplifyPiece =
      mode === 'piece'
        ? this.pattern.pieces.find((p) => p.id === this.contextPieceId) ?? null
        : null;
    const simplifyRuns = simplifyPiece ? this.pickedRuns(simplifyPiece) : [];
    const simplifyCount = simplifyRuns.reduce((sum, run) => sum + run.length, 0);
    const simplifyOk =
      simplifyCount >= MIN_RUN && !this.blockForPiece(this.contextPieceId ?? undefined);
    const simplifyBtn = this.contextMenu.querySelector(
      'button[data-act="simplify-points"]'
    ) as HTMLButtonElement;
    simplifyBtn.textContent = `Simplify points (${simplifyCount})`;
    // Reordering only means something where a run of seams shares one edge.
    const canReorder =
      !!this.contextSeamHit &&
      reverseSeamsAcrossEdge(this.pattern.seams, this.contextSeamHit) !== null;
    for (const btn of Array.from(this.contextMenu.querySelectorAll('button[data-act]'))) {
      const act = (btn as HTMLElement).dataset.act!;
      // Putting work in a container is a canvas act: only the canvas has the
      // room for a new frame, and only there would it mean anything.
      const containerOk =
        !!this.cbs.onGroupIntoContainer && this.getSelectedPieces().length > 0;
      const show =
        act === 'new-container'
          ? containerOk
          : mode === 'piece'
            ? act === 'simplify-points'
              ? simplifyOk
              : pieceActs.includes(act)
            : mode === 'ruler'
              ? rulerActs.includes(act)
              : act === 'reverse-seam-order'
                ? canReorder
                : seamActs.includes(act);
      (btn as HTMLButtonElement).hidden = !show;
    }

    const rect = this.viewport.getBoundingClientRect();
    this.contextMenu.hidden = false;
    // Measure after showing so we can clamp inside the viewport
    const mw = this.contextMenu.offsetWidth || 160;
    const mh = this.contextMenu.offsetHeight || 100;
    let left = clientX - rect.left;
    let top = clientY - rect.top;
    left = Math.max(4, Math.min(left, rect.width - mw - 4));
    top = Math.max(4, Math.min(top, rect.height - mh - 4));
    this.contextMenu.style.left = `${left}px`;
    this.contextMenu.style.top = `${top}px`;
  }

  private hideContextMenu(): void {
    this.contextMenu.hidden = true;
    this.contextPieceId = null;
    this.contextSeamId = null;
    this.contextSeamHit = null;
  }

  // ── Simplify points ──────────────────────────────────────────────────────
  //
  // Pick a run of points on an outline — a dense hand-drawn curve, or every
  // point on a piece — and reduce it to the ones that carry the shape, then fit
  // the curve back through them. The bar at the bottom of the viewport previews
  // the result live: the outline really is rewritten as the slider moves, and
  // only Done commits it (Cancel, Escape or any fresh gesture on the canvas
  // puts the points back).

  /** Runs of picked points on a piece, in outline order. Empty for a single pick. */
  private pickedRuns(piece: PatternPiece): string[][] {
    return selectedPointRuns(piece.points, (id) => this.selectedIds.has(id), piece.closed);
  }

  /**
   * Point ids on this piece that a seam or dart ends on.
   *
   * A seam is stored as an *edge* — a pair of adjacent points — so dropping one
   * of its ends would leave the piece's stitching pointing at an outline that no
   * longer has that edge. These survive whatever reduction is asked for.
   */
  private seamPinnedPointIds(piece: PatternPiece): Set<string> {
    const ids = new Set<string>();
    for (const seam of this.pattern.seams) {
      for (const ref of [seam.a, seam.b]) {
        if (ref.pieceId !== piece.id) continue;
        ids.add(ref.fromPointId);
        ids.add(ref.toPointId);
      }
    }
    return ids;
  }

  private startSimplifyPoints(): void {
    const piece = this.pattern.pieces.find((p) => p.id === this.contextPieceId);
    if (!piece) return;
    const runs = this.pickedRuns(piece);
    if (runs.length === 0) return;
    const runIds = runs.flat();
    const picked = new Set(runIds);
    const byId = new Map(piece.points.map((pt) => [pt.id, pt]));
    const cornersOnly = runIds.every((id) => {
      const pt = byId.get(id);
      return !!pt && this.isCornerPoint(pt);
    });
    this.simplify = {
      pieceId: piece.id,
      runs,
      originalPoints: piece.points.map(clonePoint),
      runIds,
      otherPickedIds: [...this.selectedIds].filter((id) => !picked.has(id)),
      reduce: 0,
      // A run of corners is a run of straight-ish edges, so keep it that way;
      // anything with curve handles reads as a curve and stays smooth.
      fit: cornersOnly ? 'corner' : 'smooth',
    };
    this.hideContextMenu();
    this.syncSimplifyBar();
    this.applySimplify();
  }

  /**
   * Rewrite the piece from the outline it started with. Every preview is a fresh
   * pass over the original, so reduce and fit compose instead of compounding.
   */
  private applySimplify(): void {
    const state = this.simplify;
    if (!state) return;
    const piece = this.pattern.pieces.find((p) => p.id === state.pieceId);
    if (!piece) {
      this.cancelSimplify();
      return;
    }
    let points = state.originalPoints.map(clonePoint);
    const pinned = this.seamPinnedPointIds(piece);
    for (const run of state.runs) {
      const result = simplifyRun(
        points,
        run,
        keepCount(run.length, state.reduce),
        state.fit,
        piece.closed,
        pinned
      );
      if (!result) {
        // The outline has moved on: those picks are no longer one run of it, so
        // the preview cannot be trusted. Put the piece back.
        this.cancelSimplify();
        return;
      }
      points = result.points;
    }

    const alive = new Set(points.map((pt) => pt.id));
    const primary = this.selectedPointId;
    piece.points = points;
    this.selectedPieceId = piece.id;
    this.setSelection(
      [...state.otherPickedIds, ...state.runIds.filter((id) => alive.has(id))],
      primary && alive.has(primary) ? primary : null
    );
    this.syncSimplifyBar();
    this.redraw();
  }

  private syncSimplifyBar(): void {
    const state = this.simplify;
    this.simplifyBar.hidden = !state;
    if (!state) return;
    const piece = this.pattern.pieces.find((p) => p.id === state.pieceId);
    const picked = new Set(state.runIds);
    const kept = piece ? piece.points.filter((pt) => picked.has(pt.id)).length : 0;
    const total = state.runIds.length;
    const count = this.simplifyBar.querySelector('[data-simplify-count]') as HTMLElement;
    count.textContent = `${total} → ${kept} ${kept === 1 ? 'point' : 'points'}${
      state.runs.length > 1 ? ` · ${state.runs.length} runs` : ''
    }`;
    const reduce = this.simplifyBar.querySelector('input[data-simplify-reduce]') as HTMLInputElement;
    reduce.value = String(Math.round(state.reduce));
    const reduceVal = this.simplifyBar.querySelector('[data-simplify-reduce-val]') as HTMLElement;
    reduceVal.textContent = `${Math.round(state.reduce)}%`;
    const fit = this.simplifyBar.querySelector('select[data-simplify-fit]') as HTMLSelectElement;
    fit.value = state.fit;
  }

  /**
   * Accept the preview. History is armed *after* the piece is back as it was, so
   * undo steps over the whole session in one go rather than over each preview.
   */
  private finishSimplify(): void {
    const state = this.simplify;
    if (!state) return;
    const piece = this.pattern.pieces.find((p) => p.id === state.pieceId);
    const applied = piece ? piece.points : null;
    this.simplify = null;
    this.simplifyBar.hidden = true;
    if (!piece || !applied) {
      this.redraw();
      return;
    }
    piece.points = state.originalPoints.map(clonePoint);
    this.markBeforeChange();
    piece.points = applied;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /** Put the piece back and stand the bar down. Nothing was committed, so no history. */
  private cancelSimplify(): void {
    const state = this.simplify;
    this.simplify = null;
    this.simplifyBar.hidden = true;
    this.syncCutBar();
    if (!state) return;
    const piece = this.pattern.pieces.find((p) => p.id === state.pieceId);
    if (piece) {
      piece.points = state.originalPoints.map(clonePoint);
      this.setSelection(
        [...state.otherPickedIds, ...state.runIds],
        this.selectedPointId
      );
    }
    this.redraw();
  }

  /**
   * A floating ribbon is a UI island: gestures on it must never reach the canvas
   * underneath.
   *
   * The pointer guard stops a click on a ribbon from being read as a canvas
   * gesture. The wheel guard matters just as much — the viewport zooms on wheel
   * (see the constructor), so without it, Alt+scrolling an offset field would
   * nudge the value *and* zoom the pattern behind it.
   */
  private sealOverlay(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  // ── Rulers ───────────────────────────────────────────────────────────────
  //
  // A ruler is a physical reference line pinned over the pattern. It measures a
  // *person*: the length tracks a body measurement, so you can eyeball "this
  // panel is a half-bust wide" without re-reading the measurement chart.
  // Rulers are document data (`pattern.rulers`) so they round-trip with the
  // project, and they never touch geometry — hence `onRulerChange`, not
  // `onChange`, which would invalidate the mesh.

  private rulers(): PatternRuler[] {
    return this.pattern.rulers ?? [];
  }

  private ensureRulers(): PatternRuler[] {
    if (!this.pattern.rulers) this.pattern.rulers = [];
    return this.pattern.rulers;
  }

  private selectedRuler(): PatternRuler | null {
    if (!this.selectedRulerId) return null;
    return this.rulers().find((r) => r.id === this.selectedRulerId) ?? null;
  }

  /** The person a ruler points at; `null` asks for the active person. */
  private measurementSet(personId: string | null): MeasurementSet | null {
    const lib = this.cbs.getMeasurementLibrary?.() ?? null;
    if (!lib || lib.sets.length === 0) return null;
    if (!personId) {
      return lib.sets.find((s) => s.id === lib.activeId) ?? lib.sets[0] ?? null;
    }
    return lib.sets.find((s) => s.id === personId) ?? null;
  }

  private activeSet(): MeasurementSet | null {
    return this.measurementSet(null);
  }

  /**
   * Drawn length: a live measurement value when the person still has one, else
   * the number snapshotted on the ruler.
   */
  private rulerDrawnLength(ruler: PatternRuler): number {
    const live = measurementValueCm(this.measurementSet(ruler.personId), ruler.measurementId);
    const full = live ?? (Number.isFinite(ruler.lengthCm) ? Math.max(0, ruler.lengthCm) : 0);
    return ruler.half ? full / 2 : full;
  }

  /** Document data that is not geometry: saved, but no remesh behind it. */
  private notifyReferenceChange(): void {
    if (this.cbs.onRulerChange) this.cbs.onRulerChange();
    else this.cbs.onChange();
  }

  // ── Ruler / measure picker ───────────────────────────────────────────────
  //
  // The rail button leads with the two things it can put in hand — a real rule
  // laid over the work, or a measurement read off the pattern — and, under
  // those, a tree of everybody in the measurement library with a search box that
  // matches a person and a measurement together ("alex waist"). Picking a body
  // measurement either rebinds the selected ruler or arms the tool for the next
  // one you drag out.

  /** Wrap every literal occurrence of the query tokens in `<mark>`. */
  private highlightText(text: string, tokens: string[]): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (tokens.length === 0) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    const lower = text.toLowerCase();
    const hits: Array<[number, number]> = [];
    for (const token of tokens) {
      let from = 0;
      for (;;) {
        const at = lower.indexOf(token, from);
        if (at < 0) break;
        hits.push([at, at + token.length]);
        from = at + token.length;
      }
    }
    if (hits.length === 0) {
      // Fuzzy (subsequence) match — nothing literal to underline.
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    hits.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const hit of hits) {
      const last = merged[merged.length - 1];
      if (last && hit[0] <= last[1]) last[1] = Math.max(last[1], hit[1]);
      else merged.push([hit[0], hit[1]]);
    }
    let cursor = 0;
    for (const [from, to] of merged) {
      if (from > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, from)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(from, to);
      frag.appendChild(mark);
      cursor = to;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    return frag;
  }

  private renderRulerMenu(): void {
    const query = this.rulerSearchInput.value;
    const sets = this.cbs.getMeasurementLibrary?.()?.sets ?? [];
    const tokens = measurementSearchTokens(query);
    const sections = filterMeasurementMenu(buildMeasurementMenu(sets), query);
    this.rulerTree.innerHTML = '';

    const hint = (text: string): void => {
      const el = document.createElement('div');
      el.className = 'pattern-ruler-menu-empty';
      el.textContent = text;
      this.rulerTree.appendChild(el);
    };

    if (sets.length === 0) {
      hint('No people yet — add one from Measurements in the toolbar.');
      return;
    }

    // The escape hatch back to a plain, free-length ruler.
    if (tokens.length === 0) {
      const free = document.createElement('button');
      free.type = 'button';
      free.className = 'pattern-ruler-item is-free';
      free.dataset.personId = '';
      free.dataset.measureId = '';
      const label = document.createElement('span');
      label.className = 'pattern-ruler-item-label';
      label.textContent = 'No measurement';
      const value = document.createElement('span');
      value.className = 'pattern-ruler-item-value';
      value.textContent = 'free length';
      free.append(label, value);
      this.rulerTree.appendChild(free);
      const rule = document.createElement('div');
      rule.className = 'pattern-ruler-menu-divider';
      this.rulerTree.appendChild(rule);
    }

    if (sections.length === 0) {
      hint(`Nothing matches “${query.trim()}”.`);
      return;
    }

    for (const section of sections) {
      const head = document.createElement('div');
      head.className = 'pattern-ruler-person';
      head.appendChild(this.highlightText(section.personName, tokens));
      const unit = document.createElement('span');
      unit.className = 'pattern-ruler-person-unit';
      unit.textContent = section.unit;
      head.appendChild(unit);
      this.rulerTree.appendChild(head);

      for (const row of section.rows) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'pattern-ruler-item';
        item.dataset.personId = section.personId;
        item.dataset.measureId = row.fieldId;
        item.dataset.measureLabel = row.label;
        // An unmeasured field has no length to draw, so it stays visible (you
        // can see the gap in someone's chart) but not selectable.
        item.disabled = row.valueCm == null;

        const label = document.createElement('span');
        label.className = 'pattern-ruler-item-label';
        label.appendChild(this.highlightText(row.label, tokens));

        const value = document.createElement('span');
        value.className = 'pattern-ruler-item-value';
        value.textContent = row.valueCm == null ? 'not set' : formatLength(row.valueCm, this.unit, 1);

        item.append(label, value);
        this.rulerTree.appendChild(item);
      }
    }
  }

  /** Apply a picked measurement to the selected ruler, or arm the tool with it. */
  private chooseRulerMeasurement(personId: string, fieldId: string): void {
    this.hideSettingsMenus();
    this.setRulerMode('ruler');

    const ruler = this.selectedRuler();
    if (!personId || !fieldId) {
      this.rulerArmed = null;
      if (ruler) {
        this.markBeforeChange();
        ruler.measurementId = null;
        ruler.personId = null;
        ruler.personName = '';
        this.notifyReferenceChange();
        this.endHistoryGesture();
        this.syncRulerBar();
      } else {
        this.syncRulerToolbar();
      }
      this.redraw();
      return;
    }

    const set = this.measurementSet(personId);
    const value = measurementValueCm(set, fieldId);
    if (!set || value == null) return;

    if (ruler) {
      this.markBeforeChange();
      ruler.personId = set.id;
      ruler.personName = set.name;
      ruler.measurementId = fieldId;
      ruler.lengthCm = value;
      this.notifyReferenceChange();
      this.endHistoryGesture();
      this.syncRulerBar();
    } else {
      this.rulerArmed = {
        personId: set.id,
        personName: set.name,
        fieldId,
        lengthCm: value,
      };
      this.syncRulerToolbar();
    }
    this.redraw();
  }

  /** Tooltip + armed marker on the ruler button — it fronts both its tools. */
  private syncRulerToolbar(): void {
    const armed = this.rulerArmed;
    const field = armed ? measurementField(armed.fieldId) : null;
    const tip =
      this.isRuler('measure')
        ? 'Ruler · Measure line — click points and edges to add them, or drag a line across'
        : armed
          ? `Ruler · ${armed.personName} ${field?.label ?? armed.fieldId} — drag to place`
          : this.tool === 'ruler'
            ? 'Ruler · a real rule laid over the work'
            : 'Ruler · ruler or measure line';
    this.rulerBtn.dataset.tip = tip;
    this.rulerBtn.setAttribute('aria-label', tip);
    this.rulerBtn.classList.toggle('is-armed', !!armed);
  }

  private setRulerSelection(id: string | null): void {
    if (this.selectedRulerId === id) return;
    this.selectedRulerId = id;
    this.syncRulerBar();
  }

  // ── Measurements ─────────────────────────────────────────────────────────
  //
  // A measurement reads the *pattern*: the length of an edge, the gap between
  // two points, or a measure line's span between the places it crossed an
  // outline — summed into one value. It is drawn like a dimension on a technical
  // drawing, and its readout can be parked where you want it.
  //
  // Nothing here is a control point: a measure point is stored as a fraction
  // along an edge, so it rides the outline and the piece is untouched. That is
  // also why a measurement is a *reference* — it never leaves a mesh stale.

  private measures(): PatternMeasure[] {
    return this.pattern.measures ?? [];
  }

  private ensureMeasures(): PatternMeasure[] {
    if (!this.pattern.measures) this.pattern.measures = [];
    return this.pattern.measures;
  }

  private findMeasure(id: string | null): PatternMeasure | null {
    if (!id) return null;
    return this.measures().find((measure) => measure.id === id) ?? null;
  }

  /** Both the measure line and Move can carry, hover and delete a readout. */
  private measureInteractive(): boolean {
    return this.isRuler('measure') || this.tool === 'move';
  }

  /**
   * Where a fresh readout goes: above the middle of what it measures, which is
   * where a dimension line's number belongs. Nudged clear of the readouts
   * already up, since measuring several things on one panel otherwise stacks
   * their values on the same spot. Dragged from there.
   */
  private defaultMeasureLabel(items: readonly MeasureItem[]): Vec2 {
    const points: Vec2[] = [];
    for (const item of items) {
      const span = measureItemSpan(this.pattern.pieces, item);
      if (span) points.push(span.mid);
    }
    if (points.length === 0) {
      return { x: this.viewBox.x + this.viewBox.w / 2, y: this.viewBox.y + this.viewBox.h / 2 };
    }
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const at = { x: cx, y: cy - this.px(34) };
    const clear = this.px(26);
    const others = this.measures()
      .filter((measure) => measure.id !== this.measureDraftId)
      .map((measure) => measure.label);
    for (let tries = 0; tries < 8; tries++) {
      if (!others.some((other) => dist(other, at) < clear)) break;
      at.y -= this.px(24);
    }
    return at;
  }

  /**
   * The measurement in hand, made if this is the first pick. Picks land in the
   * document straight away so the readout is live, draggable and undoable; the
   * draft id is only the session that keeps adding to it.
   */
  private beginMeasure(items: MeasureItem[]): PatternMeasure {
    const draft = this.findMeasure(this.measureDraftId);
    if (draft) return draft;
    const measure: PatternMeasure = {
      id: uid('measure'),
      label: this.defaultMeasureLabel(items),
      items: [...items],
    };
    this.markBeforeChange();
    this.ensureMeasures().push(measure);
    this.endHistoryGesture();
    this.measureDraftId = measure.id;
    this.notifyReferenceChange();
    return measure;
  }

  private appendMeasure(items: MeasureItem[]): void {
    const draft = this.findMeasure(this.measureDraftId);
    if (!draft) {
      this.beginMeasure(items);
      this.redraw();
      return;
    }
    this.markBeforeChange();
    draft.items.push(...items);
    // A readout parked over the old geometry follows the new pick until it is
    // moved by hand — otherwise the number ends up nowhere near what it reads.
    draft.label = this.defaultMeasureLabel(draft.items);
    this.endHistoryGesture();
    this.notifyReferenceChange();
    this.redraw();
  }

  /** Drop the session that was still adding to a measurement; what it made stays. */
  private finishMeasureDraft(): void {
    this.measureDraftId = null;
    this.measureChainTail = null;
    this.syncMeasureBar();
  }

  /** Throw the measurement being built away, whole. Undo brings it back. */
  private clearMeasureDraft(): void {
    const draft = this.findMeasure(this.measureDraftId);
    if (draft) this.deleteMeasure(draft.id);
    else this.finishMeasureDraft();
    this.measureChainTail = null;
    this.redraw();
  }

  private deleteMeasure(id: string): void {
    const list = this.measures();
    const index = list.findIndex((measure) => measure.id === id);
    if (index < 0) return;
    this.markBeforeChange();
    list.splice(index, 1);
    this.endHistoryGesture();
    if (this.measureDraftId === id) this.measureDraftId = null;
    if (this.measureHoverId === id) this.measureHoverId = null;
    this.measureChainTail = null;
    this.notifyReferenceChange();
    this.syncMeasureBar();
  }

  /**
   * What is under the pointer: a readout's value, or one of the dimension lines
   * it draws. Reverse order so the topmost measurement wins.
   */
  private findMeasureHit(p: Vec2): { id: string; part: 'label' | 'item' } | null {
    if (!this.measureInteractive()) return null;
    const list = this.measures();
    for (let i = list.length - 1; i >= 0; i--) {
      const measure = list[i]!;
      if (dist(p, measure.label) <= this.px(16)) {
        return { id: measure.id, part: 'label' };
      }
      for (const item of measure.items) {
        const span = measureItemSpan(this.pattern.pieces, item);
        if (span && distanceToSegment(p, span.a, span.b) <= this.px(5)) {
          return { id: measure.id, part: 'item' };
        }
      }
    }
    return null;
  }

  private onMeasureDown(e: PointerEvent, p: Vec2): void {
    // The readout is the handle: it is what you carry, and what right-click
    // deletes. Everything else the tool does builds the measurement.
    const hit = this.findMeasureHit(p);
    if (hit) {
      // Shift gathers readouts up for a total instead of taking hold of one, so
      // several measurements can be summed without disturbing them. Only the
      // measure tool gathers: the bar that totals them belongs to it.
      if (e.shiftKey && this.isRuler('measure')) {
        this.toggleMeasureSelected(hit.id);
        e.preventDefault();
        return;
      }
      const measure = this.findMeasure(hit.id);
      if (measure) {
        this.measureDraftId = measure.id;
        this.markBeforeChange();
        this.drag = {
          type: 'measureMove',
          id: measure.id,
          start: p,
          origin: { ...measure.label },
        };
        this.svg.setPointerCapture(e.pointerId);
        e.preventDefault();
        this.syncMeasureBar();
        this.redraw();
        return;
      }
    }
    // Any other gesture on the canvas is done with the gathering.
    this.measureSelection.clear();

    const target = e.target as SVGElement;
    const kind = target.dataset?.kind;
    const pieceId = target.dataset?.pieceId;
    const pointId = target.dataset?.pointId;

    // A control point: the measurement reads that point itself, so it follows the
    // piece exactly and stays right when the point is dragged.
    if (kind === 'anchor' && pointId && pieceId) {
      const piece = this.pattern.pieces.find((entry) => entry.id === pieceId);
      if (piece && piece.points.some((pt) => pt.id === pointId)) {
        this.addMeasurePick({ kind: 'point', pieceId, pointId });
        e.preventDefault();
        return;
      }
    }

    // An edge: the whole edge is read, along its curve, so a run of edges sums
    // to the length you would measure with a tape laid on the seam line.
    const edge = this.findNearestEdgeAcrossPieces(p);
    if (edge) {
      this.addMeasurePick({
        kind: 'edge',
        pieceId: edge.piece.id,
        fromPointId: edge.fromPointId,
        toPointId: edge.toPointId,
      });
      e.preventDefault();
      return;
    }

    // Empty canvas: draw a measure line across the work.
    this.drag = { type: 'measureLine', start: p, current: p };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.redraw();
  }

  /**
   * Add one pick.
   *
   * Points chain in the order they are picked — two points give the distance
   * between them, a third continues the walk — and an edge adds its own arc
   * length, so a run of edges sums to the length a tape would show. The pick
   * waiting for a partner is session state, not document data: a measurement
   * never holds half a span.
   */
  private addMeasurePick(item: MeasureAnchor | Extract<MeasureItem, { kind: 'edge' }>): void {
    if (item.kind === 'edge') {
      this.appendMeasure([item]);
      return;
    }
    const tail = this.measureChainTail;
    if (!tail) {
      this.measureChainTail = item;
      this.syncMeasureBar();
      this.redraw();
      return;
    }
    if (samePoint(tail, item)) return;
    this.appendMeasure([{ kind: 'span', a: tail, b: item }]);
    this.measureChainTail = item;
    this.syncMeasureBar();
  }

  /** Turn a finished measure-line drag into the spans it measures. */
  private commitMeasureLine(drag: Extract<DragKind, { type: 'measureLine' }>): void {
    const items = measureLineSpans(this.pattern.pieces, drag.start, drag.current);
    if (items.length === 0) {
      // Nothing to read: a line that misses the work, or grazes one edge only.
      this.redraw();
      return;
    }
    // A measure line is a measurement of its own, so it does not extend whatever
    // the picks were building, and the pick waiting for a partner is dropped.
    this.finishMeasureDraft();
    this.beginMeasure(items);
    this.finishMeasureDraft();
    this.syncMeasureBar();
    this.notifyReferenceChange();
    this.redraw();
  }

  /** Hovering a readout lights up everything it reads. */
  private setMeasureHover(id: string | null): void {
    if (this.measureHoverId === id) return;
    this.measureHoverId = id;
    this.applyCursor(null);
    this.redraw();
  }

  /** Shift-clicking a readout gathers it up, or lets it go again. */
  private toggleMeasureSelected(id: string): void {
    if (this.measureSelection.has(id)) this.measureSelection.delete(id);
    else this.measureSelection.add(id);
    this.syncMeasureBar();
    this.redraw();
  }

  private clearMeasureSelection(): void {
    if (this.measureSelection.size === 0) return;
    this.measureSelection.clear();
    this.syncMeasureBar();
    this.redraw();
  }

  /**
   * Total the gathered measurements into one of their own.
   *
   * The new measurement copies their items rather than pointing at them: the
   * items name pieces and edges, not coordinates, so it still reads the pattern
   * live — and it can be moved and deleted without touching the measurements it
   * was made from, which are left exactly as they were.
   */
  private sumSelectedMeasures(): void {
    const sources = this.measures().filter((measure) => this.measureSelection.has(measure.id));
    const items = sources.flatMap((measure) => measure.items);
    if (sources.length < 2 || items.length === 0) {
      this.clearMeasureSelection();
      return;
    }
    // Its readout goes where any fresh one does — above the middle of what it
    // reads, nudged clear of the part readouts already up.
    const measure: PatternMeasure = {
      id: uid('measure'),
      label: this.defaultMeasureLabel(items),
      items,
      sumOf: sources.length,
    };
    this.markBeforeChange();
    this.ensureMeasures().push(measure);
    this.endHistoryGesture();
    this.measureSelection.clear();
    this.finishMeasureDraft();
    this.notifyReferenceChange();
    this.syncMeasureBar();
    this.redraw();
  }

  /** The measurement the measure bar is talking about, if the tool is in hand. */
  private syncMeasureBar(): void {
    if (!this.measureBar) return;
    const active = this.isRuler('measure');
    this.measureBar.hidden = !active;
    if (!active) return;
    const readout = this.measureBar.querySelector('[data-measure-readout]') as HTMLElement;
    const sum = this.measureBar.querySelector('[data-measure-sum]') as HTMLButtonElement;
    const clear = this.measureBar.querySelector('[data-measure-clear]') as HTMLButtonElement;
    const done = this.measureBar.querySelector('[data-measure-done]') as HTMLButtonElement;

    // A gathering for a total takes the bar over: it is what Shift is for.
    const gathered = [...this.measureSelection];
    if (gathered.length > 0) {
      const total = this.measures()
        .filter((measure) => this.measureSelection.has(measure.id))
        .reduce((sum, measure) => sum + measureReading(this.pattern.pieces, measure).totalCm, 0);
      readout.textContent = `${gathered.length} gathered · ${formatLength(total, this.unit, 1)} — ${
        gathered.length > 1 ? 'Sum them' : 'gather another'
      }`;
      sum.hidden = false;
      sum.disabled = gathered.length < 2;
      sum.textContent = `Sum ${gathered.length}`;
      clear.hidden = true;
      done.hidden = false;
      done.textContent = 'Clear picks';
      return;
    }
    done.textContent = 'Done';

    const draft = this.findMeasure(this.measureDraftId);
    if (!draft) {
      readout.textContent = this.measureChainTail
        ? 'First point picked — pick another to measure between them'
        : 'Click points and edges, or drag a line across the work';
      sum.hidden = true;
      clear.hidden = !this.measureChainTail;
      done.hidden = !this.measureChainTail;
      return;
    }
    const reading = measureReading(this.pattern.pieces, draft);
    const label = measureLabelText(reading, this.unit, draft);
    sum.hidden = true;
    readout.textContent = this.measureChainTail
      ? `${label.secondary} · ${label.primary} · chain open`
      : `${label.secondary} · ${label.primary}`;
    clear.hidden = false;
    done.hidden = false;
  }

  private findRulerHit(p: Vec2): RulerHit | null {
    const list = this.rulers();
    const grab = this.px(10);
    const along = this.px(7);
    // Reverse order so the most recently added ruler wins, matching paint order.
    for (let i = list.length - 1; i >= 0; i--) {
      const ruler = list[i]!;
      const { a, b } = rulerEndpoints(ruler, this.rulerDrawnLength(ruler));
      if (dist(p, a) <= grab) return { id: ruler.id, part: 'a' };
      if (dist(p, b) <= grab) return { id: ruler.id, part: 'b' };
      if (distanceToSegment(p, a, b) <= along) return { id: ruler.id, part: 'body' };
    }
    return null;
  }

  private onRulerDown(e: PointerEvent, p: Vec2, preset?: RulerHit | null): void {
    const hit = preset ?? this.findRulerHit(p);
    if (!hit) {
      // Empty canvas → draw a new ruler.
      this.setRulerSelection(null);
      this.clearSelection();
      this.drag = { type: 'rulerCreate', start: p, current: p, snap: e.shiftKey };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }
    const ruler = this.rulers().find((r) => r.id === hit.id);
    if (!ruler) return;
    this.setRulerSelection(ruler.id);
    // A point selection gives way to the ruler — they share the same handles.
    this.clearSelection();
    this.markBeforeChange();
    this.drag =
      hit.part === 'body'
        ? { type: 'rulerMove', id: ruler.id, start: p, origin: { ...ruler.center } }
        : { type: 'rulerTurn', id: ruler.id, which: hit.part };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.redraw();
  }

  /** Turn a finished create-drag into a ruler, snapping to a real measurement. */
  private commitRulerCreate(drag: Extract<DragKind, { type: 'rulerCreate' }>): void {
    const dx = drag.current.x - drag.start.x;
    const dy = drag.current.y - drag.start.y;
    const length = Math.hypot(dx, dy);
    if (!(length > 1)) return;

    const deg = rulerAngle(drag.start, drag.current, drag.snap);
    const th = (deg * Math.PI) / 180;
    const set = this.activeSet();
    // A measurement picked from the hold-open menu wins over auto-matching, so
    // you can lay out several rulers of the same body dimension in a row.
    const armed = this.rulerArmed;
    const fieldId = armed ? armed.fieldId : nearestMeasurementField(set, length);
    const live = armed ? armed.lengthCm : measurementValueCm(set, fieldId);

    const ruler: PatternRuler = {
      id: uid('ruler'),
      center: {
        x: drag.start.x + (Math.cos(th) * length) / 2,
        y: drag.start.y + (Math.sin(th) * length) / 2,
      },
      angle: deg,
      // A near-enough measurement snaps the line to its exact value.
      lengthCm: live ?? length,
      measurementId: fieldId,
      personId: armed ? armed.personId : (set?.id ?? null),
      personName: armed ? armed.personName : (set?.name ?? ''),
      half: false,
    };
    this.markBeforeChange();
    this.ensureRulers().push(ruler);
    this.selectedRulerId = ruler.id;
    this.syncRulerBar();
    this.notifyReferenceChange();
    this.endHistoryGesture();
  }

  private setSelectedRulerHalf(half: boolean): void {
    const ruler = this.selectedRuler();
    if (!ruler || ruler.half === half) return;
    this.markBeforeChange();
    ruler.half = half;
    this.notifyReferenceChange();
    this.endHistoryGesture();
    this.syncRulerBar();
    this.redraw();
  }

  private onRulerPersonChange(setId: string): void {
    const ruler = this.selectedRuler();
    const set = this.measurementSet(setId);
    if (!ruler || !set) return;
    this.markBeforeChange();
    ruler.personId = set.id;
    ruler.personName = set.name;
    // Keep the stored fallback truthful for the new person.
    const live = measurementValueCm(set, ruler.measurementId);
    if (live != null) ruler.lengthCm = live;
    this.notifyReferenceChange();
    this.endHistoryGesture();
    this.syncRulerBar();
    this.redraw();
  }

  private onRulerMeasurementChange(fieldId: string): void {
    const ruler = this.selectedRuler();
    if (!ruler) return;
    this.markBeforeChange();
    ruler.measurementId = fieldId || null;
    const live = measurementValueCm(this.measurementSet(ruler.personId), ruler.measurementId);
    if (live != null) ruler.lengthCm = live;
    // Binding a person is the point of the tool — do it when one is available.
    if (ruler.measurementId && !ruler.personId) {
      const set = this.activeSet();
      if (set) {
        ruler.personId = set.id;
        ruler.personName = set.name;
      }
    }
    this.notifyReferenceChange();
    this.endHistoryGesture();
    this.syncRulerBar();
    this.redraw();
  }

  private deleteSelectedRuler(): void {
    const ruler = this.selectedRuler();
    if (!ruler) return;
    this.markBeforeChange();
    this.pattern.rulers = this.rulers().filter((r) => r.id !== ruler.id);
    this.selectedRulerId = null;
    this.hoverRulerId = null;
    this.notifyReferenceChange();
    this.endHistoryGesture();
    this.syncRulerBar();
    this.redraw();
  }

  private fillOptions(
    select: HTMLSelectElement,
    entries: Array<{ value: string; label: string }>,
    selected: string
  ): void {
    select.innerHTML = '';
    for (const entry of entries) {
      const opt = document.createElement('option');
      opt.value = entry.value;
      opt.textContent = entry.label;
      select.appendChild(opt);
    }
    select.value = entries.some((e) => e.value === selected) ? selected : (entries[0]?.value ?? '');
  }

  /** Full rebuild — visibility, selects and readout. Not called per frame. */
  private syncRulerBar(): void {
    const ruler = this.selectedRuler();
    if (!ruler) {
      this.rulerBar.hidden = true;
      return;
    }
    this.rulerBar.hidden = false;

    const sets = this.cbs.getMeasurementLibrary?.()?.sets ?? [];
    this.fillOptions(
      this.rulerPersonSelect,
      sets.length > 0
        ? sets.map((s) => ({ value: s.id, label: s.name }))
        : [{ value: '', label: 'No people yet' }],
      ruler.personId ?? sets[0]?.id ?? ''
    );

    const set = this.measurementSet(ruler.personId) ?? sets[0] ?? null;
    const entries: Array<{ value: string; label: string }> = [
      { value: '', label: '— free length —' },
    ];
    if (set) {
      for (const field of MEASUREMENT_FIELDS) {
        const value = measurementValueCm(set, field.id);
        if (value == null) continue;
        entries.push({
          value: field.id,
          label: `${field.label} · ${formatLength(value, this.unit, 1)}`,
        });
      }
      // Never silently drop a reference the ruler already points at.
      if (ruler.measurementId && !entries.some((e) => e.value === ruler.measurementId)) {
        const field = measurementField(ruler.measurementId);
        entries.push({
          value: ruler.measurementId,
          label: `${field?.label ?? ruler.measurementId} · not measured`,
        });
      }
    }
    this.fillOptions(this.rulerMeasureSelect, entries, ruler.measurementId ?? '');
    this.updateRulerReadout();
  }

  /** Cheap per-frame refresh: the numbers change while a free ruler is sized. */
  private updateRulerReadout(): void {
    const ruler = this.selectedRuler();
    if (!ruler) return;
    for (const btn of this.rulerScaleBtns) {
      btn.classList.toggle('is-active', (btn.dataset.rulerHalf === '1') === ruler.half);
    }
    const length = this.rulerDrawnLength(ruler);
    const field = measurementField(ruler.measurementId);
    const parts = [formatLength(length, this.unit, 1)];
    if (ruler.half) parts.push('half width');
    if (!field) parts.push('free');
    this.rulerReadout.textContent = parts.join(' · ');
  }

  // ── Blocks ───────────────────────────────────────────────────────────────
  //
  // A block instance is a parametric component: it owns a set of generated
  // pieces and rebuilds them whenever one of its variables changes. Its pieces
  // are ordinary `PatternPiece`s, so nothing downstream needs to know blocks
  // exist — the only special case is that their points are read-only until you
  // Detach, because regeneration would otherwise silently discard your edits.

  private blocks(): BlockInstance[] {
    return this.pattern.blocks ?? [];
  }

  private blockDefinition(instance: BlockInstance): BlockDefinition | null {
    return getBlockDefinition(instance.definitionId);
  }

  /** The block that owns a piece, if any. */
  private blockForPiece(pieceId: string | undefined): BlockInstance | null {
    if (!pieceId) return null;
    return (
      this.blocks().find((instance) => instance.pieces.some((e) => e.pieceId === pieceId)) ?? null
    );
  }

  /**
   * A faint dotted box around every piece a block drafts.
   *
   * A component that produces several panels — back, front, waistband — is one
   * object on the canvas, and without a container you cannot tell at a glance
   * whether the panels sitting next to each other are parts of one block or
   * separate pieces you drew. A single-piece block gets no box: a rectangle
   * around one outline is just a second outline.
   */
  private drawBlockOutline(instance: BlockInstance): void {
    if (instance.pieces.length < 2) return;
    const owned = new Set(instance.pieces.map((entry) => entry.pieceId));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const piece of this.pattern.pieces) {
      if (!owned.has(piece.id)) continue;
      for (const pt of piece.points) {
        minX = Math.min(minX, pt.anchor.x);
        minY = Math.min(minY, pt.anchor.y);
        maxX = Math.max(maxX, pt.anchor.x);
        maxY = Math.max(maxY, pt.anchor.y);
      }
    }
    if (!Number.isFinite(minX)) return;

    // Stand the box off in pattern units so it hugs the draft at any zoom
    // instead of touching a seam allowance.
    const pad = 1.5;
    const rect = svgEl('rect');
    rect.setAttribute('x', String(minX - pad));
    rect.setAttribute('y', String(minY - pad));
    rect.setAttribute('width', String(maxX - minX + pad * 2));
    rect.setAttribute('height', String(maxY - minY + pad * 2));
    rect.setAttribute('class', `pattern-block-outline${instance.id === this.selectedBlockId ? ' is-selected' : ''}`);
    rect.setAttribute('rx', String(this.px(8)));
    rect.setAttribute('stroke-width', String(this.px(1.4)));
    rect.setAttribute('stroke-dasharray', `${this.px(3)} ${this.px(6)}`);
    this.svg.appendChild(rect);
  }

  private selectedBlock(): BlockInstance | null {
    if (!this.selectedBlockId) return null;
    return this.blocks().find((instance) => instance.id === this.selectedBlockId) ?? null;
  }

  private setSelectedBlock(id: string | null): void {
    if (id) {
      this.setRulerSelection(null);
      // Cleared inline rather than through clearSelection(), which would call
      // back into releaseBlockSelection() and unset the id being set here.
      this.selectedIds.clear();
      this.selectedPointId = null;
    }
    if (this.selectedBlockId === id) return;
    this.selectedBlockId = id;
    this.syncBlockBar();
  }

  // — Placement —

  /**
   * The rail buttons carry the tool in hand, and the tip that names what it is
   * set to. Only the two whose tip depends on their mode need it written here —
   * Add rests on nothing, and Cut's is written where its cutter is chosen.
   */
  private syncToolRail(): void {
    const move = this.toolbar.querySelector('button[data-tool="move"]') as HTMLButtonElement | null;
    if (move) {
      // The rail names the mode when the tool is in hand: Free and Orbit are two
      // different gestures under one button.
      const tip =
        this.tool === 'move' && this.moveMode === 'orbit'
          ? 'Move · Orbit'
          : 'Move · free — drag anything anywhere';
      move.dataset.tip = tip;
      move.setAttribute('aria-label', tip);
    }
    const modify = this.toolbar.querySelector('button[data-tool="modify"]') as HTMLButtonElement | null;
    if (modify) {
      const name = MODIFY_MODES.find((entry) => entry.mode === this.modifyMode)?.label ?? 'Extrude';
      let tip = 'Modify · extrude, join and bridge — pick the mode in the canvas ribbon';
      if (this.tool === 'modify') {
        if (this.modifyMode === 'extrude') tip = 'Modify · Extrude edge';
        else {
          // The fuse and the bridge read the run they are set to, since that is
          // the choice the ribbon is holding.
          const pair = this.modifyMode === 'join' ? this.joinMode : this.bridgeMode;
          tip = `Modify · ${name} · ${pair === 'many' ? 'Edge runs' : 'One edge each'}`;
        }
      }
      modify.dataset.tip = tip;
      modify.setAttribute('aria-label', tip);
    }

    const sew = this.toolbar.querySelector('button[data-tool="sew"]') as HTMLButtonElement | null;
    if (sew) {
      const tip =
        this.tool === 'sew'
          ? this.sewMode === 'many'
            ? 'Sew · Many-to-many'
            : 'Sew · Segment'
          : 'Sew · one edge each or many to many — pick the mode in the canvas ribbon';
      sew.dataset.tip = tip;
      sew.setAttribute('aria-label', tip);
    }
  }

  private renderBlockMenu(host: HTMLElement): void {
    const menu = document.createElement('div');
    menu.className = 'pattern-block-menu';
    host.appendChild(menu);
    if (BLOCK_DEFINITIONS.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pattern-block-menu-empty';
      empty.textContent = 'No blocks in the library yet.';
      menu.appendChild(empty);
      return;
    }
    const sets = this.cbs.getMeasurementLibrary?.()?.sets ?? [];
    const person = this.activeSet();
    void sets;
    const hint = document.createElement('div');
    hint.className = 'pattern-block-menu-hint';
    hint.textContent = person
      ? `Will be drafted for ${person.name}.`
      : 'No measurements yet — blocks start from the book’s default figures.';
    menu.appendChild(hint);

    for (const definition of BLOCK_DEFINITIONS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.role = 'menuitem';
      item.dataset.blockId = definition.id;
      const name = document.createElement('span');
      name.className = 'pattern-block-menu-name';
      name.textContent = definition.name;
      const desc = document.createElement('span');
      desc.className = 'pattern-block-menu-desc';
      desc.textContent = definition.description;
      item.append(name, desc);
      item.addEventListener('click', () => {
        this.hideSettingsMenus();
        this.addBlock(definition.id);
      });
      menu.appendChild(item);
    }
  }

  /** Drop a fresh block instance into this pattern. */
  addBlock(definitionId: string): boolean {
    const definition = getBlockDefinition(definitionId);
    if (!definition) return false;
    const set = this.activeSet();
    const fallback = {
      x: this.viewBox.x + this.viewBox.w * 0.25,
      y: this.viewBox.y + this.viewBox.h * 0.25,
    };
    const origin = nextBlockOrigin(this.pattern.pieces, fallback);
    const instance = createBlockInstance(
      definition,
      origin,
      set?.id ?? null,
      set?.name ?? '',
      set
    );
    this.markBeforeChange();
    if (!this.pattern.blocks) this.pattern.blocks = [];
    this.pattern.blocks.push(instance);
    const generated = generateBlockPieces(definition, instance, set);
    const { pieces, ownership } = spliceBlockPieces(this.pattern.pieces, instance, generated);
    this.pattern.pieces = pieces;
    instance.pieces = ownership;
    this.selectedBlockId = instance.id;
    // Inside the same edit as the pieces, so one undo takes the block and its
    // seams away together.
    this.sewBlock(instance);
    this.cbs.onChange();
    this.endHistoryGesture();
    this.syncBlockBar();
    this.fitView();
    this.redraw();
    return true;
  }

  /**
   * Add the seams a block wants, and drop the ones it claims but can no longer
   * make. Returns whether anything changed.
   *
   * Run when the block is placed, and from the ribbon for blocks that were
   * placed before it existed. Only seams with both pieces in the document can be
   * made, which is how a bodice front and back each declare the seam between
   * them: the one placed first has nothing to sew to yet and quietly does
   * nothing, and the one placed second makes the lot.
   */
  private sewBlock(instance: BlockInstance): boolean {
    const definition = this.blockDefinition(instance);
    if (!definition?.seams) return false;
    let changed = false;

    // Drop the block's own dead seams first. A reference that no longer resolves
    // on its own piece cannot be sewn and is drawn as a warning, so letting one
    // sit there only makes the next pass add a second copy of the same seam.
    const owned = new Set(instance.pieces.map((entry) => entry.pieceId));
    const kept = this.pattern.seams.filter((seam) => {
      const dead =
        !isSeamEdgeValid(this.pattern.pieces, seam.a) ||
        !isSeamEdgeValid(this.pattern.pieces, seam.b);
      if (dead && (owned.has(seam.a.pieceId) || owned.has(seam.b.pieceId))) {
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) this.pattern.seams = kept;

    const wanted = generateBlockSeams(
      definition,
      instance,
      this.measurementSet(instance.personId),
      // First block of that definition wins; two bodices on one canvas are not
      // told apart.
      (definitionId) => {
        const partner = this.blocks().find((b) => b.definitionId === definitionId);
        const partnerDefinition = partner ? this.blockDefinition(partner) : null;
        return partner && partnerDefinition
          ? { instance: partner, definition: partnerDefinition }
          : null;
      }
    );
    const present = new Set(this.pattern.pieces.map((piece) => piece.id));
    const additions = wanted.filter(
      ({ a, b }) =>
        present.has(a.pieceId) &&
        present.has(b.pieceId) &&
        !this.pattern.seams.some((seam) => sameSeamBindingPair(seam.a, seam.b, a, b))
    );
    if (additions.length > 0) {
      this.pattern.seams.push(
        ...additions.map(({ a, b }) => ({
          id: uid('seam'),
          a,
          b,
          restGapCm: DEFAULT_SEAM_GAP_CM,
        }))
      );
      changed = true;
    }
    return changed;
  }

  /** The ribbon's Sew button: sew up a block placed before this existed. */
  private sewSelectedBlock(): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    this.markBeforeChange();
    const changed = this.sewBlock(instance);
    if (!changed) {
      this.endHistoryGesture();
      return;
    }
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /**
   * Light up the geometry the hovered variable controls.
   *
   * Drawn over the pieces, as a wide translucent stroke with rings on the
   * points, so it reads as a lamp held against the outline rather than as yet
   * another outline competing with the lavender block tint.
   */
  private drawBlockHighlight(): void {
    const driven = this.hoverDriven;
    if (!driven || driven.size === 0) return;
    for (const piece of this.pattern.pieces) {
      const n = piece.points.length;
      if (n < 2) continue;
      // An edge counts as driven when *either* end moves: change the hip depth
      // and the centre line from the waist down is exactly what you moved.
      const hit = piece.points.map((pt) => driven.has(pt.id));
      if (!hit.some(Boolean)) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (!hit[i] && !hit[j]) continue;
        const a = piece.points[i]!;
        const b = piece.points[j]!;
        const { c0, c1 } = edgeHandles(a, b);
        const path = svgEl('path');
        path.setAttribute('class', 'pattern-block-driver');
        path.setAttribute(
          'd',
          `M ${a.anchor.x} ${a.anchor.y} C ${c0.x} ${c0.y}, ${c1.x} ${c1.y}, ${b.anchor.x} ${b.anchor.y}`
        );
        path.setAttribute('stroke-width', String(this.px(9)));
        this.svg.appendChild(path);
      }
      // Rings last, so no neighbouring edge can cover one.
      for (const pt of piece.points) {
        if (!driven.has(pt.id)) continue;
        const ring = svgEl('circle');
        ring.setAttribute('cx', String(pt.anchor.x));
        ring.setAttribute('cy', String(pt.anchor.y));
        ring.setAttribute('r', String(this.px(7)));
        ring.setAttribute('class', 'pattern-block-driver-point');
        ring.setAttribute('stroke-width', String(this.px(2)));
        this.svg.appendChild(ring);
      }
    }
  }

  /**
   * Fold an inspector section shut, or open again.
   *
   * Done by toggling a class rather than rebuilding the rows: a rebuild would
   * throw away any half-typed number in the section, and there is nothing to
   * recompute — the rows are all still there, just not painted.
   */
  private toggleBlockGroup(name: string, group: HTMLElement): void {
    const collapsed = !this.collapsedBlockGroups.has(name);
    if (collapsed) this.collapsedBlockGroups.add(name);
    else this.collapsedBlockGroups.delete(name);
    group.classList.toggle('is-collapsed', collapsed);
    group
      .querySelector<HTMLButtonElement>('[data-block-group-toggle]')
      ?.setAttribute('aria-expanded', String(!collapsed));
    // A row that is no longer on screen must not leave its outline lit on the
    // canvas — the pointer is still over the header, but nothing is hovered.
    if (collapsed && this.hoverVarId) {
      const row = group.querySelector<HTMLElement>(`[data-var-id="${this.hoverVarId}"]`);
      if (row) this.setHoveredVar(null);
    }
  }

  /** Hovered variable → the points it moves. Cheap enough to redo per row. */
  private setHoveredVar(varId: string | null): void {
    if (this.hoverVarId === varId) return;
    this.hoverVarId = varId;
    this.hoverDriven = null;
    if (varId) {
      const instance = this.selectedBlock();
      const definition = instance ? this.blockDefinition(instance) : null;
      if (instance && definition) {
        this.hoverDriven = drivenPointIds(
          definition,
          instance,
          this.measurementSet(instance.personId),
          varId
        );
      }
    }
    this.redraw();
  }

  /**
   * Rebuild a block's pieces from its current variables, in place.
   *
   * `structural` marks the edits that change the *shape of a row* — switching
   * Value/Measure, a divisor, a different measurement, a different person. Those
   * rebuild the inspector, which throws away the live input and closes the undo
   * gesture immediately. Typing is not structural: the rows are left alone so
   * the caret survives, and the gesture stays open so a whole typed entry
   * collapses into one undo step.
   */
  private commitBlockChange(instance: BlockInstance, structural = true): void {
    const definition = this.blockDefinition(instance);
    if (!definition) return;
    const generated = generateBlockPieces(
      definition,
      instance,
      this.measurementSet(instance.personId)
    );
    const { pieces, ownership } = spliceBlockPieces(this.pattern.pieces, instance, generated);
    this.pattern.pieces = pieces;
    instance.pieces = ownership;
    this.cbs.onChange();
    if (structural) {
      this.endHistoryGesture();
      this.syncBlockVars();
    }
    this.redraw();
  }

  // — Variable editing —

  private bindingFor(instance: BlockInstance, varId: string): BlockVariableBinding | undefined {
    return instance.bindings[varId];
  }

  private setBlockVariableValue(varId: string, cm: number, structural = true): void {
    const instance = this.selectedBlock();
    const variable = this.blockVariable(instance, varId);
    if (!instance || !variable) return;
    // A typo should not be able to throw the draft off the table.
    const clamped = clampToDeclared(variable, cm);
    const existing = instance.bindings[varId];
    if (existing?.mode === 'value' && existing.cm === clamped) return;
    this.markBeforeChange();
    instance.bindings[varId] = { mode: 'value', cm: clamped };
    this.commitBlockChange(instance, structural);
  }

  private setBlockVariableMode(varId: string, mode: 'value' | 'measurement'): void {
    const instance = this.selectedBlock();
    const definition = instance ? this.blockDefinition(instance) : null;
    if (!instance || !definition) return;
    const variable = definition.variables.find((v) => v.id === varId);
    if (!variable) return;
    const current = this.bindingFor(instance, varId);
    if (current?.mode === mode) return;
    const set = this.measurementSet(instance.personId);
    this.markBeforeChange();
    if (mode === 'value') {
      instance.bindings[varId] = {
        mode: 'value',
        cm: current ? bindingValueCm(current, set) : variable.defaultValueCm,
      };
    } else {
      // Start from the declaration's suggestion, else the first measurement this
      // person actually has, so the row is immediately meaningful.
      const suggested = variable.suggested ?? {
        fieldId: this.firstMeasuredField(set) ?? 'waist',
        divisor: 1 as const,
        offsetCm: 0,
      };
      const live = sourceValueCm(suggested, set);
      instance.bindings[varId] = {
        mode: 'measurement',
        ...suggested,
        fallbackCm: live ?? (current ? bindingValueCm(current, set) : variable.defaultValueCm),
      };
    }
    this.commitBlockChange(instance);
  }

  private firstMeasuredField(set: MeasurementSet | null): string | null {
    if (!set) return null;
    return MEASUREMENT_FIELDS.find((f) => measurementValueCm(set, f.id) != null)?.id ?? null;
  }

  private setBlockVariableDivisor(varId: string, divisor: BlockDivisor): void {
    const instance = this.selectedBlock();
    const binding = instance ? this.bindingFor(instance, varId) : null;
    if (!instance || binding?.mode !== 'measurement' || binding.divisor === divisor) return;
    this.markBeforeChange();
    binding.divisor = divisor;
    const live = sourceValueCm(binding, this.measurementSet(instance.personId));
    if (live != null) binding.fallbackCm = live;
    this.commitBlockChange(instance);
  }

  private setBlockVariableOffset(varId: string, offsetCm: number, structural = true): void {
    const instance = this.selectedBlock();
    const binding = instance ? this.bindingFor(instance, varId) : null;
    if (!instance || binding?.mode !== 'measurement' || binding.offsetCm === offsetCm) return;
    this.markBeforeChange();
    binding.offsetCm = offsetCm;
    const live = sourceValueCm(binding, this.measurementSet(instance.personId));
    if (live != null) binding.fallbackCm = live;
    this.commitBlockChange(instance, structural);
  }

  private setBlockVariableField(varId: string, fieldId: string): void {
    const instance = this.selectedBlock();
    const binding = instance ? this.bindingFor(instance, varId) : null;
    if (!instance || binding?.mode !== 'measurement') return;
    this.markBeforeChange();
    binding.fieldId = fieldId;
    const live = sourceValueCm(binding, this.measurementSet(instance.personId));
    if (live != null) binding.fallbackCm = live;
    this.commitBlockChange(instance);
  }

  private onBlockPersonChange(setId: string): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    const set = this.measurementSet(setId);
    this.markBeforeChange();
    instance.personId = set?.id ?? null;
    instance.personName = set?.name ?? '';
    // Refresh every snapshot against the new person, so the block still draws
    // correctly if that person is later removed.
    for (const variable of this.blockDefinition(instance)?.variables ?? []) {
      const binding = instance.bindings[variable.id];
      if (binding?.mode !== 'measurement') continue;
      const live = sourceValueCm(binding, set);
      if (live != null) binding.fallbackCm = live;
    }
    this.cbs.onChange();
    this.endHistoryGesture();
    this.syncBlockBar();
    this.redraw();
  }

  private detachSelectedBlock(): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    this.markBeforeChange();
    // The pieces stay exactly as they are — they just stop being generated.
    this.pattern.blocks = this.blocks().filter((b) => b.id !== instance.id);
    this.selectedBlockId = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.syncBlockBar();
    this.redraw();
  }

  private deleteSelectedBlock(): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    this.markBeforeChange();
    const owned = new Set(instance.pieces.map((e) => e.pieceId));
    this.pattern.pieces = this.pattern.pieces.filter((piece) => !owned.has(piece.id));
    this.pattern.blocks = this.blocks().filter((b) => b.id !== instance.id);
    this.selectedBlockId = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.syncBlockBar();
    this.redraw();
  }

  // — The inspector ribbon —

  private blockDisplay(cm: number): number {
    return Number(cmToDisplay(cm, this.unit).toFixed(3));
  }

  private blockCm(display: number): number {
    return displayToCm(display, this.unit);
  }

  /** Nudge size for a length field, in display units. Alt+wheel reads this too. */
  private blockStep(): number {
    return this.unit === 'in' ? 0.25 : 0.5;
  }

  private blockVariable(
    instance: BlockInstance | null,
    varId: string
  ): BlockVariableDecl | null {
    const definition = instance ? this.blockDefinition(instance) : null;
    return definition?.variables.find((v) => v.id === varId) ?? null;
  }

  /**
   * Read a numeric inspector field back into canonical units.
   *
   * The box holds *display* units, so an inches project would otherwise write
   * "30" straight in as 30 cm. Counts (dart counts) and factors (how square a
   * curve turns) are dimensionless and must never be converted — a factor of
   * 0.55 is 0.55 in either system.
   */
  private blockFieldCm(varId: string, input: HTMLInputElement): number | null {
    const variable = this.blockVariable(this.selectedBlock(), varId);
    if (!variable) return null;
    const raw = Number.parseFloat(input.value);
    if (!Number.isFinite(raw)) return null;
    if (variable.kind === 'count') return Math.round(raw);
    if (variable.kind === 'factor') return raw;
    return this.blockCm(raw);
  }

  /** Restore a field's text to the value the block is actually using. */
  private syncBlockField(varId: string, input: HTMLInputElement): void {
    const instance = this.selectedBlock();
    const variable = this.blockVariable(instance, varId);
    const binding = instance?.bindings[varId];
    if (!instance || !variable || !binding) return;
    const cm = clampToDeclared(
      variable,
      bindingValueCm(binding, this.measurementSet(instance.personId))
    );
    input.value = this.blockFieldText(variable, cm);
  }

  /** How one variable's number reads inside its input box. */
  private blockFieldText(variable: BlockVariableDecl, cm: number): string {
    if (variable.kind === 'count') return String(Math.round(cm));
    if (variable.kind === 'factor') return String(Number(cm.toFixed(2)));
    return String(this.blockDisplay(cm));
  }

  /** Nudge size for a factor, in its own 0–1 domain. */
  private blockFactorStep(): number {
    return 0.05;
  }

  private blockFieldLabel(fieldId: string): string {
    return MEASUREMENT_FIELDS.find((f) => f.id === fieldId)?.label ?? fieldId;
  }

  /** Full rebuild — visibility, person select and every variable row. */
  private syncBlockBar(): void {
    const instance = this.selectedBlock();
    const definition = instance ? this.blockDefinition(instance) : null;
    if (!instance || !definition) {
      this.blockBar.hidden = true;
      return;
    }
    this.blockBar.hidden = false;
    const nameEl = this.blockBar.querySelector('[data-block-name]') as HTMLElement;
    nameEl.textContent = definition.name;

    const sets = this.cbs.getMeasurementLibrary?.()?.sets ?? [];
    this.fillOptions(
      this.blockPersonSelect,
      sets.length > 0
        ? sets.map((s) => ({ value: s.id, label: s.name }))
        : [{ value: '', label: 'No people yet' }],
      instance.personId ?? sets[0]?.id ?? ''
    );

    this.blockSourceNote.textContent = definition.source ?? '';
    this.syncBlockVars();
  }

  /** Rebuild the variable rows. Cheap enough to redo on a mode change. */
  private syncBlockVars(): void {
    const instance = this.selectedBlock();
    const definition = instance ? this.blockDefinition(instance) : null;
    const host = this.blockVarsHost;
    host.innerHTML = '';
    // The rows that were hovered are gone, so the highlight has to go too.
    this.hoverVarId = null;
    this.hoverDriven = null;
    if (!instance || !definition) return;

    const set = this.measurementSet(instance.personId);
    let currentGroup = '';
    let groupBody: HTMLElement | null = null;
    for (const variable of definition.variables) {
      if (variable.group !== currentGroup) {
        currentGroup = variable.group;
        const collapsed = this.collapsedBlockGroups.has(currentGroup);
        const group = document.createElement('div');
        group.className = 'pattern-block-group';
        group.dataset.blockGroup = currentGroup;
        group.classList.toggle('is-collapsed', collapsed);

        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'pattern-block-group-head';
        head.dataset.blockGroupToggle = '';
        // A real disclosure button, so it is reachable by keyboard and reads
        // correctly to a screen reader rather than being a div that happens to
        // have a click handler on it.
        head.setAttribute('aria-expanded', String(!collapsed));
        const caret = document.createElement('span');
        caret.className = 'pattern-block-group-caret';
        caret.setAttribute('aria-hidden', 'true');
        const title = document.createElement('span');
        title.className = 'pattern-block-group-title';
        title.textContent = currentGroup;
        head.append(caret, title);

        groupBody = document.createElement('div');
        groupBody.className = 'pattern-block-group-body';
        group.append(head, groupBody);
        host.appendChild(group);
      }

      const binding = instance.bindings[variable.id];
      const isMeasurement = binding?.mode === 'measurement';
      const row = document.createElement('div');
      row.className = 'pattern-block-var';
      row.dataset.varId = variable.id;
      row.title = variable.note ?? '';

      const top = document.createElement('div');
      top.className = 'pattern-block-var-top';
      const label = document.createElement('span');
      label.className = 'pattern-block-var-label';
      label.textContent = variable.label;
      const readout = document.createElement('span');
      readout.className = 'pattern-block-var-readout';
      readout.dataset.blockReadout = variable.id;
      top.append(label, readout);
      row.appendChild(top);

      const controls = document.createElement('div');
      controls.className = 'pattern-block-var-controls';

      const mode = document.createElement('div');
      mode.className = 'pattern-block-mode';
      mode.setAttribute('role', 'group');
      for (const [id, text] of [
        ['value', 'Value'],
        ['measurement', 'Measure'],
      ] as const) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.blockMode = id;
        btn.textContent = text;
        btn.classList.toggle('is-active', (id === 'measurement') === isMeasurement);
        mode.appendChild(btn);
      }
      controls.appendChild(mode);

      if (!isMeasurement) {
        // Only lengths convert. A dart count and a curve factor are the same
        // number in any unit — converting a count through inches is how you end
        // up with a maximum of 1.181.
        const kind = variable.kind ?? 'length';
        const current = clampToDeclared(
          variable,
          bindingValueCm(
            binding ?? { mode: 'value', cm: variable.defaultValueCm },
            set
          )
        );
        const input = document.createElement('input');
        // Deliberately *not* type="number": Chromium gives it a spinbutton role
        // that cannot be selected or caret-edited (Ctrl+A is ignored entirely),
        // so retyping a value appends into the middle of the old one. A text
        // field with a numeric keyboard hint behaves, and the parse and clamp
        // are ours anyway.
        input.type = 'text';
        input.inputMode = kind === 'length' ? 'decimal' : 'numeric';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.className = 'pattern-block-input';
        input.dataset.blockValue = '';
        input.dataset.numberInput = '';
        input.step = String(
          kind === 'count' ? 1 : kind === 'factor' ? this.blockFactorStep() : this.blockStep()
        );
        input.min = String(kind === 'length' ? this.blockDisplay(variable.minCm) : variable.minCm);
        input.max = String(kind === 'length' ? this.blockDisplay(variable.maxCm) : variable.maxCm);
        input.value = this.blockFieldText(variable, current);
        input.setAttribute('aria-label', variable.label);
        controls.appendChild(input);
      } else {
        const select = document.createElement('select');
        select.className = 'pattern-block-select';
        select.dataset.blockField = '';
        select.setAttribute('aria-label', `${variable.label} measurement`);
        const entries = MEASUREMENT_FIELDS.map((field) => {
          const live = measurementValueCm(set, field.id);
          return {
            value: field.id,
            label:
              live == null
                ? `${field.label} · not measured`
                : `${field.label} · ${formatLength(live, this.unit, 1)}`,
          };
        });
        this.fillOptions(select, entries, binding.fieldId);
        controls.appendChild(select);

        const divisor = document.createElement('div');
        divisor.className = 'pattern-block-div';
        divisor.setAttribute('role', 'group');
        for (const [value, text] of [
          [0.5, '×2'],
          [1, '×1'],
          [2, '½'],
          [4, '¼'],
        ] as const) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.dataset.blockDiv = String(value);
          btn.textContent = text;
          btn.classList.toggle('is-active', binding.divisor === value);
          divisor.appendChild(btn);
        }
        controls.appendChild(divisor);

        const ease = document.createElement('label');
        ease.className = 'pattern-block-ease';
        ease.title = `Ease added after dividing, in ${this.unit === 'in' ? 'inches' : 'cm'}`;
        const sign = document.createElement('span');
        sign.textContent = '+';
        const offset = document.createElement('input');
        offset.type = 'text';
        offset.inputMode = 'decimal';
        offset.autocomplete = 'off';
        offset.spellcheck = false;
        offset.dataset.blockOffset = '';
        offset.dataset.numberInput = '';
        offset.step = String(this.blockStep());
        offset.value = String(this.blockDisplay(binding.offsetCm));
        offset.setAttribute('aria-label', `${variable.label} ease`);
        ease.append(sign, offset);
        controls.appendChild(ease);
      }

      row.appendChild(controls);
      groupBody!.appendChild(row);
    }
    this.updateBlockReadouts();
  }

  /** Cheap refresh — only the numbers change while typing. */
  private updateBlockReadouts(): void {
    const instance = this.selectedBlock();
    const definition = instance ? this.blockDefinition(instance) : null;
    if (!instance || !definition) return;
    const set = this.measurementSet(instance.personId);
    const values = resolveBlockValues(definition, instance, set);
    for (const variable of definition.variables) {
      const el = this.blockVarsHost.querySelector(
        `[data-block-readout="${variable.id}"]`
      ) as HTMLElement | null;
      if (!el) continue;
      const binding = instance.bindings[variable.id];
      const value = values[variable.id] ?? 0;
      if (variable.kind === 'count') {
        el.textContent = String(Math.round(value));
      } else if (variable.kind === 'factor') {
        // A shaping control reads as a percentage — "55%" says more about a
        // neckline than "0.55".
        el.textContent = `${Math.round(value * 100)}%`;
      } else {
        el.textContent = formatLength(value, this.unit, 1);
      }
      el.classList.toggle(
        'is-unmeasured',
        binding?.mode === 'measurement' && sourceValueCm(binding, set) == null
      );
    }
  }

  /** Clicking a generated piece selects its block rather than its points. */
  private onBlockPointerDown(
    e: PointerEvent,
    p: Vec2,
    instance: BlockInstance,
    pieceId: string | undefined
  ): void {
    this.setSelectedBlock(instance.id);
    // Pick the outline as well, so the piece reads as selected the way a
    // hand-drawn one does rather than only lighting up a panel on the far side
    // of the canvas. Its geometry is regenerated, so the selection is an
    // indicator here and carries no scale grips — see drawSelectionChrome.
    const piece = this.pattern.pieces.find((entry) => entry.id === pieceId);
    if (piece) this.selectEntirePiece(piece);
    this.drag = {
      type: 'blockMove',
      id: instance.id,
      start: p,
      origin: { ...instance.origin },
    };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.redraw();
  }

  /**
   * A small run of text that keeps its own upright orientation while its
   * position follows the (possibly upside-down) ruler.
   */
  private rulerText(text: string, x: number, y: number, cls: string, flip: boolean): SVGGElement {    const g = svgEl('g');
    g.setAttribute('transform', `translate(${x} ${y})${flip ? ' rotate(180)' : ''}`);
    const t = svgEl('text');
    t.setAttribute('class', cls);
    t.setAttribute('font-size', String(this.px(9)));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'middle');
    // Halo so the text stays legible over the grid and piece fills.
    t.setAttribute('stroke-width', String(this.px(3)));
    t.setAttribute('paint-order', 'stroke');
    t.textContent = text;
    g.appendChild(t);
    return g;
  }

  /**
   * Ruler scale marks. Returns the label / handle groups, which the caller
   * appends *after* the pattern so the readings stay legible on top of a piece
   * while the scale itself stays behind it.
   */
  /**
   * Reference images placed in the pattern.
   *
   * Each one is an `<image>` in the pattern's own user units, so it pans, scales
   * and clips with the work exactly like the pieces do and rides inside the
   * container's frame on the board. It is drawn under the pieces (see `redraw`):
   * a reference is something to draft over, not something to cover the drafting.
   */
  private drawImages(): void {
    const images = this.images();
    if (images.length === 0) return;
    for (const image of images) {
      const picked = this.selectedImageId === image.id;
      const el = document.createElementNS(SVG_NS, 'image');
      el.setAttribute('x', String(image.x));
      el.setAttribute('y', String(image.y));
      el.setAttribute('width', String(image.widthCm));
      el.setAttribute('height', String(image.heightCm));
      // The box is the truth: it is what the grip drags, and what the frame on
      // the board has to agree with.
      el.setAttribute('preserveAspectRatio', 'none');
      el.setAttribute('class', `pattern-image${picked ? ' is-selected' : ''}`);
      el.setAttribute('href', image.src);
      el.dataset.imageId = image.id;
      this.svg.appendChild(el);
    }
  }

  /** The box round the image in hand — drawn over the work (see `redraw`). */
  private drawSelectedImageChrome(): void {
    const image = this.findImage(this.selectedImageId);
    if (image) this.drawImageChrome(image);
  }

  /** The box and handle that say which image is in hand. */
  private drawImageChrome(image: PatternImage): void {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(image.x));
    rect.setAttribute('y', String(image.y));
    rect.setAttribute('width', String(image.widthCm));
    rect.setAttribute('height', String(image.heightCm));
    rect.setAttribute('class', 'pattern-image-frame');
    rect.setAttribute('stroke-width', String(this.px(1.25)));
    rect.setAttribute('stroke-dasharray', `${this.px(4)} ${this.px(3)}`);
    rect.setAttribute('pointer-events', 'none');
    this.svg.appendChild(rect);

    const handle = this.px(4);
    const grip = document.createElementNS(SVG_NS, 'rect');
    grip.setAttribute('x', String(image.x + image.widthCm - handle));
    grip.setAttribute('y', String(image.y + image.heightCm - handle));
    grip.setAttribute('width', String(handle));
    grip.setAttribute('height', String(handle));
    grip.setAttribute('class', 'pattern-image-grip');
    grip.setAttribute('stroke-width', String(this.px(1.2)));
    grip.dataset.imageGrip = image.id;
    // The grip is part of the image's own chrome, so a press on it has to find
    // the image it belongs to — that is what turns the press into a resize.
    grip.dataset.imageId = image.id;
    this.svg.appendChild(grip);
  }

  /**
   * Notes written over the pattern.
   *
   * Each one is a `<foreignObject>` in the pattern's own user units — a
   * centimetre is a user unit here — so the box pans, scales and clips with the
   * work without the editor having to lay anything out. The note being typed into
   * is a live contenteditable; every other is plain text that only the box takes
   * the pointer for.
   */
  private drawTexts(): void {
    const notes = this.texts();
    if (notes.length === 0) return;
    for (const note of notes) {
      const editing = this.textEditingId === note.id;
      const picked = this.selectedTextId === note.id;
      const box = document.createElementNS(SVG_NS, 'foreignObject');
      box.setAttribute('x', String(note.x));
      box.setAttribute('y', String(note.y));
      box.setAttribute('width', String(note.widthCm));
      box.setAttribute('height', String(note.heightCm));
      box.setAttribute('class', `pattern-text${picked ? ' is-selected' : ''}`);
      box.dataset.textId = note.id;

      const content = document.createElement('div');
      content.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      content.className = 'pattern-text-content';
      const css = patternTextCss(note);
      for (const [property, value] of Object.entries(css)) {
        content.style.setProperty(property, value);
      }
      content.textContent = note.text;
      content.dataset.textId = note.id;
      content.contentEditable = editing ? 'true' : 'false';
      content.spellcheck = false;
      box.appendChild(content);
      this.svg.appendChild(box);

      if (editing) this.bindTextEditing(note, content);
      if (picked) this.drawTextChrome(note);
    }
  }

  /** The box and handle that say which note is in hand. */
  private drawTextChrome(note: PatternText): void {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(note.x));
    rect.setAttribute('y', String(note.y));
    rect.setAttribute('width', String(note.widthCm));
    rect.setAttribute('height', String(note.heightCm));
    rect.setAttribute('class', 'pattern-text-frame');
    rect.setAttribute('stroke-width', String(this.px(1.25)));
    rect.setAttribute('stroke-dasharray', `${this.px(4)} ${this.px(3)}`);
    rect.setAttribute('pointer-events', 'none');
    this.svg.appendChild(rect);

    const handle = this.px(4);
    const grip = document.createElementNS(SVG_NS, 'rect');
    grip.setAttribute('x', String(note.x + note.widthCm - handle));
    grip.setAttribute('y', String(note.y + note.heightCm - handle));
    grip.setAttribute('width', String(handle));
    grip.setAttribute('height', String(handle));
    grip.setAttribute('class', 'pattern-text-grip');
    grip.setAttribute('stroke-width', String(this.px(1.2)));
    grip.dataset.textGrip = note.id;
    // The grip is part of the note's own chrome, so a press on it has to find the
    // note it belongs to — that is what turns the press into a resize rather than
    // a press on bare canvas.
    grip.dataset.textId = note.id;
    this.svg.appendChild(grip);
  }

  /** Typing into a note: write what is typed back, without redrawing under the caret. */
  private bindTextEditing(note: PatternText, content: HTMLElement): void {
    content.addEventListener('input', () => {
      note.text = content.innerText.replace(/\r/g, '');
      this.sizeTextToContent(note, content);
      this.notifyReferenceChange();
    });
    content.addEventListener('blur', () => {
      // A redraw takes the element out from under the caret, and the browser
      // fires one last blur as it goes: that is not a second commit, so only the
      // box that is still in the drawing is allowed to write back.
      if (!this.svg.contains(content)) return;
      this.finishTextEditing(note, content);
    });
    content.addEventListener('keydown', (e) => {
      // Enter breaks the line — the box wraps on its own — but
      // Escape is how you leave the note, the way it is anywhere else here.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.finishTextEditing(note, content);
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.finishTextEditing(note, content);
      }
    });
  }

  /** Take what is in the box, put the caret away, and repaint. */
  private finishTextEditing(note: PatternText, content: HTMLElement): void {
    if (this.textEditingId !== note.id) return;
    note.text = content.isConnected ? content.innerText.replace(/\r/g, '') : note.text;
    this.textEditingId = null;
    this.notifyReferenceChange();
    this.redraw();
  }

  /**
   * The same, from a press elsewhere: the note being typed into is only known by
   * id here, so the live box is looked up first.
   */
  private commitTextEditing(): void {
    const note = this.findText(this.textEditingId);
    if (!note) {
      this.textEditingId = null;
      return;
    }
    const content = this.svg.querySelector<HTMLElement>(
      `.pattern-text-content[data-text-id="${note.id}"]`
    );
    if (content) this.finishTextEditing(note, content);
    else this.textEditingId = null;
  }

  /**
   * An auto-width note is as wide as what was typed, and every note is as tall as
   * its lines: the box is re-measured from the live element rather than guessed
   * at, so the frame and the grip sit where the text ends.
   */
  private sizeTextToContent(note: PatternText, content: HTMLElement): void {
    const box = content.parentElement as SVGForeignObjectElement | null;
    if (!box) return;
    // A few units of slack, or the last glyph is clipped by its own box.
    const pad = this.px(1);
    const height = content.scrollHeight + pad;
    if (height > 0) note.heightCm = height;
    if (note.autoWidth) {
      const width = content.scrollWidth + pad;
      if (width > 0) note.widthCm = width;
    }
    box.setAttribute('width', String(note.widthCm));
    box.setAttribute('height', String(note.heightCm));
  }

  /** The note under the pointer, if any. */
  private textAt(p: Vec2): PatternText | null {
    const notes = this.texts();
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i];
      if (
        p.x >= note.x &&
        p.x <= note.x + note.widthCm &&
        p.y >= note.y &&
        p.y <= note.y + note.heightCm
      ) {
        return note;
      }
    }
    return null;
  }

  private texts(): PatternText[] {
    return this.pattern.texts ?? [];
  }

  private findText(id: string | null): PatternText | null {
    if (!id) return null;
    return this.texts().find((note) => note.id === id) ?? null;
  }

  private setTextSelection(id: string | null): void {
    if (this.selectedTextId === id) return;
    this.selectedTextId = id;
    this.cbs.onTextSelectionChange?.();
    this.redraw();
  }

  /** The note in hand, for the host's style bar. */
  getSelectedText(): PatternText | null {
    return this.findText(this.selectedTextId);
  }

  /**
   * Add a note for the box the Add tool drew, pick it, and put the caret in it:
   * a new note is empty until it says something, so selecting it alone would not
   * make that obvious.
   */
  createText(box: ObjectBoxPlace, defaults: { fontSizeCm?: number; paddingCm?: number } = {}): PatternText | null {
    const note = createPatternText(box, defaults);
    this.markBeforeChange();
    this.ensureTexts().push(note);
    this.clearSelection();
    this.selectedTextId = note.id;
    this.textEditingId = note.id;
    this.notifyReferenceChange();
    this.endHistoryGesture();
    this.cbs.onTextSelectionChange?.();
    this.redraw();
    // The press that asked for the note is still finishing its own repaint — take
    // the caret once the drawing has settled, or it lands in a box about to be
    // replaced.
    requestAnimationFrame(() => this.focusTextContent(note.id));
    return note;
  }

  /**
   * Put the caret in a note, with its text picked so typing replaces it.
   *
   * A box that has just been drawn has no layout yet, and a box with no layout
   * cannot take focus — so the attempt is repeated over the next few frames
   * rather than being lost on the first one.
   */
  private focusTextContent(id: string, attempt = 0): void {
    const content = this.svg.querySelector<HTMLElement>(
      `.pattern-text-content[data-text-id="${id}"]`
    );
    if (!content) return;
    content.focus({ preventScroll: true });
    if (document.activeElement !== content) {
      if (attempt < 5) requestAnimationFrame(() => this.focusTextContent(id, attempt + 1));
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(content);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private ensureTexts(): PatternText[] {
    if (!this.pattern.texts) this.pattern.texts = [];
    return this.pattern.texts;
  }

  private deleteText(id: string): void {
    const notes = this.ensureTexts();
    const index = notes.findIndex((note) => note.id === id);
    if (index < 0) return;
    this.markBeforeChange();
    notes.splice(index, 1);
    if (this.selectedTextId === id) this.selectedTextId = null;
    if (this.textEditingId === id) this.textEditingId = null;
    this.notifyReferenceChange();
    this.endHistoryGesture();
    this.cbs.onTextSelectionChange?.();
    this.redraw();
  }

  /**
   * A change from the style bar. The host works in canvas units (the numbers it
   * shows for a canvas text object), and hands the note's own centimetres over;
   * either way the box re-measures itself and the ribbon stays in step.
   */
  updateSelectedText(patch: Partial<PatternText>): void {
    const note = this.getSelectedText();
    if (!note) return;
    this.markBeforeChange();
    Object.assign(note, patch);
    this.notifyReferenceChange();
    this.endHistoryGesture();
    this.cbs.onTextSelectionChange?.();
    this.redraw();
  }

  /**
   * A press on a note. Picking it puts it in hand; a second press in the same
   * breath types into it; dragging carries it. The grip at its corner resizes it.
   */
  private onTextDown(e: PointerEvent, p: Vec2, noteId: string): void {
    const note = this.findText(noteId);
    if (!note) return;
    const grip = (e.target as Element | null)?.closest?.('[data-text-grip]');
    if (grip) {
      this.clearSelection();
      this.dropObjectSelections(note.id);
      this.selectedTextId = note.id;
      this.markBeforeChange();
      this.drag = { type: 'resizeText', id: note.id, start: p, width: note.widthCm, height: note.heightCm };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }
    // Already typing here? Then the press is the browser's — it places the caret.
    if (this.textEditingId === note.id) return;

    const now = performance.now();
    const again = now - this.lastTextPress < 450;
    this.lastTextPress = now;
    this.clearSelection();
    this.dropObjectSelections(note.id);
    this.selectedTextId = note.id;
    this.cbs.onTextSelectionChange?.();
    if (again) {
      this.textEditingId = note.id;
      this.markBeforeChange();
      this.redraw();
      this.focusTextContent(note.id);
      this.endHistoryGesture();
      e.preventDefault();
      return;
    }
    this.markBeforeChange();
    this.drag = { type: 'moveText', id: note.id, start: p, origin: { x: note.x, y: note.y } };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.redraw();
  }

  // ── Reference images ─────────────────────────────────────────────────────
  //
  // An image belongs to the pattern the way a note does: its box is in the
  // pattern's centimetres, it is drawn under the pieces, and it is picked,
  // carried and resized in place with the Move tool.

  private images(): PatternImage[] {
    return this.pattern.images ?? [];
  }

  private ensureImages(): PatternImage[] {
    if (!this.pattern.images) this.pattern.images = [];
    return this.pattern.images;
  }

  private findImage(id: string | null): PatternImage | null {
    if (!id) return null;
    return this.images().find((image) => image.id === id) ?? null;
  }

  /** The image in hand, for a host that wants to say what it is. */
  getSelectedImage(): PatternImage | null {
    return this.findImage(this.selectedImageId);
  }

  /** Only one object is in hand at a time: a note and an image never both are. */
  private setImageSelection(id: string | null): void {
    if (this.selectedImageId === id) return;
    this.selectedImageId = id;
    this.redraw();
  }

  /**
   * Put an image on the sheet for the box the Add tool drew — or at the point it
   * clicked — and leave it in hand, ready to be carried into place.
   *
   * The picture itself is the host's to load: the editor is handed a source that
   * the browser can draw, and knows nothing about files.
   */
  createImage(
    box: ObjectBoxPlace,
    source: { src: string; label?: string; naturalAspect?: number }
  ): PatternImage | null {
    if (!source?.src) return null;
    const image = createPatternImage(box, source);
    this.markBeforeChange();
    this.ensureImages().push(image);
    this.clearSelection();
    this.dropObjectSelections(image.id);
    this.selectedImageId = image.id;
    this.notifyReferenceChange();
    this.endHistoryGesture();
    this.redraw();
    return image;
  }

  /** A dropped or pasted image: placed where the pointer is, at a click's size. */
  placeImageAtClient(
    clientX: number,
    clientY: number,
    source: { src: string; label?: string; naturalAspect?: number }
  ): PatternImage | null {
    const p = this.svgPointFromClient(clientX, clientY);
    return this.createImage({ x: p.x, y: p.y, w: 0, h: 0 }, source);
  }

  /** Let go of whatever object was in hand, except the one just picked. */
  private dropObjectSelections(except: string | null): void {
    if (this.selectedTextId && this.selectedTextId !== except) {
      this.selectedTextId = null;
      this.textEditingId = null;
      this.cbs.onTextSelectionChange?.();
    }
    if (this.selectedImageId && this.selectedImageId !== except) this.selectedImageId = null;
  }

  private deleteImage(id: string): void {
    const images = this.ensureImages();
    const index = images.findIndex((image) => image.id === id);
    if (index < 0) return;
    this.markBeforeChange();
    images.splice(index, 1);
    if (this.selectedImageId === id) this.selectedImageId = null;
    this.notifyReferenceChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /**
   * A press on an image: the grip at its corner resizes it, anything else picks
   * it up and carries it. Shift holds its proportions, the way Shift does on the
   * canvas.
   */
  private onImageDown(e: PointerEvent, p: Vec2, imageId: string): void {
    const image = this.findImage(imageId);
    if (!image) return;
    this.clearSelection();
    this.dropObjectSelections(image.id);
    this.selectedImageId = image.id;
    this.markBeforeChange();
    const grip = (e.target as Element | null)?.closest?.('[data-image-grip]');
    if (grip) {
      this.drag = {
        type: 'resizeImage',
        id: image.id,
        start: p,
        width: image.widthCm,
        height: image.heightCm,
        aspect: patternImageAspect(image),
      };
    } else {
      this.drag = { type: 'moveImage', id: image.id, start: p, origin: { x: image.x, y: image.y } };
    }
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.redraw();
  }

  /**
   * The measurements, drawn like the dimensions on a technical drawing: a line
   * with a tick at each end for a span, the edge itself lit up when the item is
   * an edge, and a value that can be parked anywhere.
   *
   * Hovering a readout lights everything that measurement reads, which is the
   * whole point of summing several edges into one number: the value says how
   * much, the highlight says *of what*.
   */
  private drawMeasures(): void {
    const list = this.measures();
    const draft = this.drag?.type === 'measureLine' ? this.drag : null;
    for (const measure of list) {
      const hot = this.measureHoverId === measure.id || this.measureDraftId === measure.id;
      const gathered = this.measureSelection.has(measure.id);
      const reading = measureReading(this.pattern.pieces, measure);
      const group = svgEl('g');
      group.setAttribute(
        'class',
        `pattern-measure${hot ? ' is-hot' : ''}${reading.stale > 0 ? ' is-stale' : ''}${
          gathered ? ' is-gathered' : ''
        }${measure.sumOf && measure.sumOf > 1 ? ' is-sum' : ''}`
      );
      group.setAttribute('pointer-events', 'none');

      const refs = measureReferences(measure);
      // What it reads, lit up under the dimension lines. The whole edge is
      // shown rather than just the stretch between the stops, so hovering a
      // value answers "of what?" at a glance.
      for (const edge of refs.edges) {
        this.drawMeasureEdge(edge, hot);
      }

      for (const item of measure.items) {
        const span = measureItemSpan(this.pattern.pieces, item);
        if (!span) continue;
        group.appendChild(this.drawMeasureItem(item, span, hot));
      }

      const label = measureLabelText(reading, this.unit, measure);
      const anchor = measureAnchorPoints(this.pattern.pieces, measure);
      // The readout goes into the group last so it draws over its own dimension
      // lines, and travels with them in the DOM.
      group.appendChild(
        this.drawMeasureLabel(measure, label, hot, anchor, gathered || !!measure.sumOf)
      );
      this.svg.appendChild(group);
    }
    if (draft) this.drawMeasureLineDraft(draft);
    // The pick waiting for a partner, so the first click of a measurement is not
    // silent.
    const tail = this.isRuler('measure') ? this.measureChainTail : null;
    if (tail) {
      const at = resolveMeasureAnchor(this.pattern.pieces, tail);
      if (at) {
        const dot = svgEl('circle');
        dot.setAttribute('cx', String(at.x));
        dot.setAttribute('cy', String(at.y));
        dot.setAttribute('r', String(this.px(4.5)));
        dot.setAttribute('class', 'pattern-measure-ref-point is-hot');
        dot.setAttribute('pointer-events', 'none');
        dot.setAttribute('stroke-width', String(this.px(1.4)));
        this.svg.appendChild(dot);
      }
    }
  }

  /** One dimension line: span, or the edge's own curve with its length on it. */
  private drawMeasureItem(
    item: MeasureItem,
    span: { a: Vec2; b: Vec2; mid: Vec2; lengthCm: number },
    hot: boolean
  ): SVGGElement {
    const group = svgEl('g');
    if (item.kind === 'edge') {
      const piece = this.pattern.pieces.find((entry) => entry.id === item.pieceId);
      const samples = piece
        ? sampleEdgeByPointIds(piece, item.fromPointId, item.toPointId, 20)
        : null;
      if (samples && samples.length > 1) {
        let d = `M ${samples[0]!.x} ${samples[0]!.y}`;
        for (let i = 1; i < samples.length; i++) d += ` L ${samples[i]!.x} ${samples[i]!.y}`;
        const path = svgEl('path');
        path.setAttribute('d', d);
        path.setAttribute('class', 'pattern-measure-dim');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-width', String(this.px(hot ? 3 : 2)));
        group.appendChild(path);
      }
      group.appendChild(
        this.measureText(
          formatLength(span.lengthCm, this.unit, 1),
          span.mid.x,
          span.mid.y - this.px(9),
          'pattern-measure-value'
        )
      );
      // An edge item is measured between the piece's own points, so its stops
      // are control points, not measure points.
      this.drawMeasureStops(
        group,
        [
          { at: span.a, measurePoint: false },
          { at: span.b, measurePoint: false },
        ],
        hot
      );
      return group;
    }

    const line = svgLine(span.a.x, span.a.y, span.b.x, span.b.y, 'pattern-measure-span', this.px(1.3));
    group.appendChild(line);
    const tick = this.px(7);
    for (const end of [span.a, span.b]) {
      group.appendChild(
        this.drawMeasureTick(end, span.b.x - span.a.x, span.b.y - span.a.y, tick, hot)
      );
    }
    // The number sits off the line, on the side the drawing reads from.
    const nx = -(span.b.y - span.a.y);
    const ny = span.b.x - span.a.x;
    const len = Math.hypot(nx, ny) || 1;
    const off = this.px(11);
    group.appendChild(
      this.measureText(
        formatLength(span.lengthCm, this.unit, 1),
        span.mid.x + (nx / len) * off,
        span.mid.y + (ny / len) * off,
        'pattern-measure-value'
      )
    );
    this.drawMeasureStops(
      group,
      [
        { at: span.a, measurePoint: item.a.kind === 'edge' },
        { at: span.b, measurePoint: item.b.kind === 'edge' },
      ],
      hot
    );
    return group;
  }

  /**
   * A mark at each end of what is measured. A control point gets a filled dot; a
   * measure point — one the software placed on an edge, which is not a control
   * point of the piece — is ringed, so it is never mistaken for something you
   * can drag as geometry.
   */
  private drawMeasureStops(
    group: SVGGElement,
    stops: ReadonlyArray<{ at: Vec2; measurePoint: boolean }>,
    hot: boolean
  ): void {
    for (const stop of stops) {
      if (stop.measurePoint) {
        const ring = svgEl('circle');
        ring.setAttribute('cx', String(stop.at.x));
        ring.setAttribute('cy', String(stop.at.y));
        ring.setAttribute('r', String(this.px(hot ? 6 : 5)));
        ring.setAttribute('class', `pattern-measure-stop-ring${hot ? ' is-hot' : ''}`);
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke-width', String(this.px(1.2)));
        group.appendChild(ring);
      }
      const dot = svgEl('circle');
      dot.setAttribute('cx', String(stop.at.x));
      dot.setAttribute('cy', String(stop.at.y));
      dot.setAttribute('r', String(this.px(hot ? 3.2 : 2.6)));
      dot.setAttribute('class', `pattern-measure-stop${hot ? ' is-hot' : ''}`);
      dot.setAttribute('stroke-width', String(this.px(1)));
      group.appendChild(dot);
    }
  }

  /** The end tick of a dimension line, square to the span. */
  private drawMeasureTick(end: Vec2, dx: number, dy: number, half: number, hot: boolean): SVGLineElement {
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const line = svgLine(
      end.x - nx * half,
      end.y - ny * half,
      end.x + nx * half,
      end.y + ny * half,
      'pattern-measure-tick',
      this.px(hot ? 1.8 : 1.3)
    );
    return line;
  }

  /** The whole edge a measurement reads, lit under the dimension line. */
  private drawMeasureEdge(
    edge: { pieceId: string; fromPointId: string; toPointId: string },
    hot: boolean
  ): void {
    const piece = this.pattern.pieces.find((entry) => entry.id === edge.pieceId);
    if (!piece) return;
    const samples = sampleEdgeByPointIds(piece, edge.fromPointId, edge.toPointId, 20);
    if (!samples || samples.length < 2) return;
    let d = `M ${samples[0]!.x} ${samples[0]!.y}`;
    for (let i = 1; i < samples.length; i++) d += ` L ${samples[i]!.x} ${samples[i]!.y}`;
    const path = svgEl('path');
    path.setAttribute('d', d);
    path.setAttribute('class', `pattern-measure-ref${hot ? ' is-hot' : ''}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('pointer-events', 'none');
    path.setAttribute('stroke-width', String(this.px(hot ? 4.5 : 3)));
    this.svg.appendChild(path);
  }

  /**
   * The value itself: the one thing on a measurement you can take hold of. It is
   * drawn last so it sits over whatever it reads, and carries the frame when the
   * measurement is in hand or under the pointer.
   */
  private drawMeasureLabel(
    measure: PatternMeasure,
    label: { primary: string; secondary: string },
    hot: boolean,
    anchors: readonly Vec2[],
    emphasis: boolean
  ): SVGGElement {
    const group = svgEl('g');
    const at = measure.label;
    group.setAttribute('class', `pattern-measure-label${hot ? ' is-hot' : ''}`);
    group.setAttribute('pointer-events', 'none');

    // A leader back to what it reads, so a parked value still says what it is
    // about. Faint, and only when the readout has been moved off its geometry.
    if (anchors.length > 0) {
      const cx = anchors.reduce((sum, p) => sum + p.x, 0) / anchors.length;
      const cy = anchors.reduce((sum, p) => sum + p.y, 0) / anchors.length;
      if (Math.hypot(cx - at.x, cy - at.y) > this.px(26)) {
        const leader = svgLine(at.x, at.y, cx, cy, 'pattern-measure-leader', this.px(1));
        leader.setAttribute('stroke-dasharray', `${this.px(3)} ${this.px(3)}`);
        group.appendChild(leader);
      }
    }

    const chip = svgEl('rect');
    // Sized to the wider of the two lines: the secondary line names what the
    // value is made of and is usually the longer one.
    const fontPx = 11;
    const textPx = (text: string): number => text.length * fontPx * 0.62;
    const width = this.px(Math.max(56, Math.max(textPx(label.primary), textPx(label.secondary)) + 18));
    const height = this.px(32);
    chip.setAttribute('x', String(at.x - width / 2));
    chip.setAttribute('y', String(at.y - height / 2));
    chip.setAttribute('width', String(width));
    chip.setAttribute('height', String(height));
    chip.setAttribute('rx', String(this.px(5)));
    chip.setAttribute('class', 'pattern-measure-chip');
    // Emphasis is a width, so it goes through `px()`: a bare number in CSS would
    // be user units and come out several times too thick.
    chip.setAttribute('stroke-width', String(this.px(emphasis ? 2 : 1)));
    group.appendChild(chip);

    group.appendChild(
      this.measureText(label.primary, at.x, at.y - this.px(1), 'pattern-measure-total')
    );
    group.appendChild(
      this.measureText(label.secondary, at.x, at.y + this.px(12), 'pattern-measure-parts')
    );
    return group;
  }
  private measureText(text: string, x: number, y: number, cls: string): SVGTextElement {
    const el = svgEl('text');
    el.setAttribute('x', String(x));
    el.setAttribute('y', String(y));
    el.setAttribute('class', cls);
    el.setAttribute('text-anchor', 'middle');
    el.setAttribute('font-size', String(this.px(11)));
    el.setAttribute('pointer-events', 'none');
    el.style.userSelect = 'none';
    el.textContent = text;
    return el;
  }

  /** The line being drawn, and where it would put its measure points. */
  private drawMeasureLineDraft(drag: Extract<DragKind, { type: 'measureLine' }>): void {
    const line = svgLine(
      drag.start.x,
      drag.start.y,
      drag.current.x,
      drag.current.y,
      'pattern-measure-line-draft',
      this.px(1.4)
    );
    line.setAttribute('stroke-dasharray', `${this.px(5)} ${this.px(4)}`);
    line.setAttribute('pointer-events', 'none');
    this.svg.appendChild(line);

    if (dist(drag.start, drag.current) < this.px(6)) return;
    // The stops the drag would place: only the crossings that end up measured,
    // so the preview says exactly which stretches of the work will be read.
    const spans = measureLineSpans(this.pattern.pieces, drag.start, drag.current);
    for (const span of spans) {
      if (span.kind !== 'span') continue;
      for (const anchor of [span.a, span.b]) {
        const p = resolveMeasureAnchor(this.pattern.pieces, anchor);
        if (!p) continue;
        const dot = svgEl('circle');
        dot.setAttribute('cx', String(p.x));
        dot.setAttribute('cy', String(p.y));
        dot.setAttribute('r', String(this.px(4)));
        dot.setAttribute('class', 'pattern-measure-ref-point is-hot');
        dot.setAttribute('pointer-events', 'none');
        dot.setAttribute('stroke-width', String(this.px(1.4)));
        this.svg.appendChild(dot);
      }
    }
  }

  private drawRulers(): SVGGElement[] {
    const list = this.rulers();
    const draft = this.drag?.type === 'rulerCreate' ? this.drag : null;
    const overlay: SVGGElement[] = [];
    if (list.length === 0) {
      if (draft) this.drawRulerDraft(draft);
      return overlay;
    }

    const grad = rulerGraduations(this.unit, this.viewScale());
    const majorEvery = Math.max(1, Math.round(grad.majorCm / grad.minorCm));
    // Whole numbers once the labelled step reaches a whole unit (1 cm / 1 in).
    const majorDisplay = this.unit === 'in' ? grad.majorCm / 2.54 : grad.majorCm;
    const tickDigits = majorDisplay >= 1 ? 0 : 1;

    for (const ruler of list) {
      const length = this.rulerDrawnLength(ruler);
      if (!(length > 0.05)) continue;
      const selected = this.selectedRulerId === ruler.id;
      const hovered = this.hoverRulerId === ruler.id;
      const flip = rulerTextFlipped(ruler.angle);
      const { a } = rulerEndpoints(ruler, length);

      const group = svgEl('g');
      group.setAttribute(
        'class',
        `pattern-ruler${selected ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`
      );
      group.setAttribute('transform', `translate(${a.x} ${a.y}) rotate(${ruler.angle})`);
      // Hit-testing is analytic, so the artwork must never swallow pointer events.
      group.setAttribute('pointer-events', 'none');

      group.appendChild(svgLine(0, 0, length, 0, 'pattern-ruler-line', this.px(selected ? 2.2 : 1.6)));

      const cap = this.px(9);
      group.appendChild(svgLine(0, -cap / 2, 0, cap / 2, 'pattern-ruler-cap', this.px(1.4)));
      group.appendChild(svgLine(length, -cap / 2, length, cap / 2, 'pattern-ruler-cap', this.px(1.4)));

      // Graduations hang below the axis so the label above stays clear.
      const tickSw = this.px(selected ? 1.1 : 0.9);
      const ticks = Math.floor(length / grad.minorCm + 1e-6);
      for (let i = 0; i <= ticks; i++) {
        const v = i * grad.minorCm;
        const isMajor = i % majorEvery === 0;
        const h = isMajor ? this.px(7) : this.px(3.4);
        group.appendChild(
          svgLine(v, 0, v, h, isMajor ? 'pattern-ruler-tick-major' : 'pattern-ruler-tick', tickSw)
        );
        if (isMajor && selected) {
          // Only the selected ruler is worth numbering — otherwise it's noise.
          group.appendChild(
            this.rulerText(
              formatLength(v, this.unit, tickDigits),
              v,
              h + this.px(9),
              'pattern-ruler-number',
              flip
            )
          );
        }
      }
      this.svg.appendChild(group);

      // Readings and grab handles ride above the pattern.
      const top = svgEl('g');
      top.setAttribute(
        'class',
        `pattern-ruler-top${selected ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`
      );
      top.setAttribute('transform', `translate(${a.x} ${a.y}) rotate(${ruler.angle})`);
      top.setAttribute('pointer-events', 'none');

      const label = rulerLabel(
        ruler,
        this.unit,
        length,
        this.measurementSet(ruler.personId)?.name ?? ruler.personName
      );
      const midX = length / 2;
      top.appendChild(this.rulerText(label.primary, midX, -this.px(21), 'pattern-ruler-name', flip));
      top.appendChild(
        this.rulerText(label.secondary, midX, -this.px(10), 'pattern-ruler-value', flip)
      );

      if (selected) {
        for (const x of [0, length]) {
          const handle = svgEl('circle');
          handle.setAttribute('cx', String(x));
          handle.setAttribute('cy', '0');
          handle.setAttribute('r', String(this.px(4)));
          handle.setAttribute('class', 'pattern-ruler-handle');
          handle.setAttribute('stroke-width', String(this.px(1.4)));
          top.appendChild(handle);
        }
      }
      overlay.push(top);
    }

    if (draft) this.drawRulerDraft(draft);
    return overlay;
  }

  private drawRulerDraft(drag: Extract<DragKind, { type: 'rulerCreate' }>): void {
    const dx = drag.current.x - drag.start.x;
    const dy = drag.current.y - drag.start.y;
    const length = Math.hypot(dx, dy);
    if (!(length > 0.2)) return;
    const deg = rulerAngle(drag.start, drag.current, drag.snap);
    const th = (deg * Math.PI) / 180;
    const end = { x: drag.start.x + Math.cos(th) * length, y: drag.start.y + Math.sin(th) * length };
    const line = svgLine(
      drag.start.x,
      drag.start.y,
      end.x,
      end.y,
      'pattern-ruler-draft',
      this.px(1.6)
    );
    line.setAttribute('stroke-dasharray', `${this.px(6)} ${this.px(4)}`);
    line.setAttribute('pointer-events', 'none');
    this.svg.appendChild(line);

    const mid = { x: (drag.start.x + end.x) / 2, y: (drag.start.y + end.y) / 2 };
    const text = this.rulerText(
      formatLength(length, this.unit, 1),
      mid.x,
      mid.y - this.px(12),
      'pattern-ruler-value',
      false
    );
    text.setAttribute('pointer-events', 'none');
    this.svg.appendChild(text);
  }

  private makePieceId = (): string => uid('pt');

  /**
   * Hand the picked panels to the canvas to put in a new container. The pattern
   * data moves, so this is a document edit — but the pieces themselves are only
   * translated, so nothing changes shape or place on screen.
   */
  private groupSelectionIntoContainer(): void {
    const ids = this.getSelectedPieces();
    if (ids.length === 0) return;
    this.markBeforeChange();
    this.cbs.onGroupIntoContainer?.(ids);
    this.endHistoryGesture();
  }

  private afterPieceDuplicated(copy: PatternPiece): void {
    this.markBeforeChange();
    this.pattern.pieces.push(copy);
    this.selectEntirePiece(copy);
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private duplicateContextPiece(): void {
    const piece =
      this.pattern.pieces.find((p) => p.id === this.contextPieceId) ?? this.activePiece();
    if (!piece) return;
    const box = anchorsBounds(piece.points);
    const gap = 2;
    const copy = clonePatternPiece(piece, this.makePieceId, {
      x: (box.maxX - box.minX || 10) + gap,
      y: 0,
    });
    copy.id = uid('piece');
    this.afterPieceDuplicated(copy);
  }

  private mirrorDuplicateContextPiece(axis: 'x' | 'y'): void {
    const piece =
      this.pattern.pieces.find((p) => p.id === this.contextPieceId) ?? this.activePiece();
    if (!piece) return;
    const copy = mirrorClonePatternPiece(piece, axis, this.makePieceId);
    copy.id = uid('piece');
    this.afterPieceDuplicated(copy);
  }

  /**
   * Alt-drag on a panel: copy what is being dragged, then carry the copy. A
   * panel already picked as part of a set takes the whole set with it, the way
   * picking one up would.
   */
  private beginAltDuplicate(e: PointerEvent, p: Vec2, piece: PatternPiece): void {
    const picked = this.whollySelectedPieces();
    const ids = picked.includes(piece.id) ? picked : [piece.id];
    this.markBeforeChange();
    const copies: PatternPiece[] = [];
    for (const id of ids) {
      const source = this.pattern.pieces.find((entry) => entry.id === id);
      if (!source) continue;
      // In place, not stepped aside: the drag is what moves it away.
      const copy = clonePatternPiece(source, this.makePieceId, { x: 0, y: 0 });
      copy.id = uid('piece');
      this.pattern.pieces.push(copy);
      copies.push(copy);
    }
    if (copies.length === 0) {
      this.endHistoryGesture();
      return;
    }
    this.selectedIds = new Set(
      copies.flatMap((copy) => pieceRings(copy).flat().map((point) => point.id))
    );
    this.selectedPointId = null;
    this.selectedPieceId = copies[copies.length - 1].id;
    this.drag = {
      type: 'moveSelection',
      start: p,
      snapshots: this.snapshotSelection(),
      moved: false,
    };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.cbs.onChange();
    this.redraw();
  }

  private deleteContextPiece(): void {
    const id = this.contextPieceId ?? this.selectedPieceId;
    if (!id) return;
    this.deletePieces([id]);
  }

  /**
   * Remove whole pieces, and everything that refers to them.
   *
   * A block's pieces are not separately deletable. They are regenerated from the
   * block's variables, so a piece removed on its own comes straight back — with
   * the block's other pieces renumbered around it — on the next load. Any piece
   * of a block therefore takes the whole block, which is the same unit the
   * block's own Delete button works in. Detach is the button that exists for
   * breaking one up.
   */
  private deletePieces(pieceIds: readonly string[]): void {
    if (pieceIds.length === 0) return;
    const doomed = new Set(pieceIds);
    const doomedBlocks = new Set<string>();
    for (const instance of this.blocks()) {
      if (instance.pieces.some((entry) => doomed.has(entry.pieceId))) {
        doomedBlocks.add(instance.id);
        for (const entry of instance.pieces) doomed.add(entry.pieceId);
      }
    }

    this.markBeforeChange();
    this.pattern.pieces = this.pattern.pieces.filter((p) => !doomed.has(p.id));
    this.pattern.seams = this.pattern.seams.filter(
      (s) => !doomed.has(s.a.pieceId) && !doomed.has(s.b.pieceId)
    );
    if (doomedBlocks.size > 0) {
      this.pattern.blocks = this.blocks().filter((b) => !doomedBlocks.has(b.id));
      if (this.selectedBlockId && doomedBlocks.has(this.selectedBlockId)) {
        this.selectedBlockId = null;
      }
    }
    this.clearSelection();
    this.selectedPieceId = this.pattern.pieces[0]?.id ?? null;
    this.contextPieceId = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    if (doomedBlocks.size > 0) this.syncBlockBar();
    this.redraw();
  }

  /** True when every point of the piece is in the selection (whole shape selected). */
  private isEntirePieceSelected(piece: PatternPiece): boolean {
    return (
      piece.points.length > 0 &&
      pieceRings(piece)
        .flat()
        .every((pt) => this.selectedIds.has(pt.id))
    );
  }

  private deleteSelectedPoints(): void {
    const piece = this.activePiece();
    if (!piece || this.selectedIds.size === 0) return;
    this.markBeforeChange();

    const minPts = piece.closed ? 3 : 1;
    const remaining = piece.points.filter((pt) => !this.selectedIds.has(pt.id));
    if (remaining.length < minPts) {
      // Removing these points would invalidate the outline — delete the piece instead
      this.deletePieces([piece.id]);
      return;
    }

    piece.points = remaining;
    // A hole's points belong to the hole: taking them away takes away the part of
    // the ring they were on, and a ring with too few points left to enclose
    // anything is a hole that is gone — which is how a hole is filled back in.
    const holes = (piece.holes ?? [])
      .map((ring) => ring.filter((pt) => !this.selectedIds.has(pt.id)))
      .filter((ring) => ring.length >= 3);
    if (holes.length > 0) piece.holes = holes;
    else delete piece.holes;

    this.clearSelection();
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private handleDeleteKey(): void {
    // A note in hand is the nearest thing the key can be about.
    if (this.selectedTextId && this.selectedIds.size === 0) {
      this.deleteText(this.selectedTextId);
      return;
    }
    // An image in hand, likewise.
    if (this.selectedImageId && this.selectedIds.size === 0) {
      this.deleteImage(this.selectedImageId);
      return;
    }
    // A selected ruler is the only thing "in hand" — delete that first.
    if (this.selectedRulerId && this.selectedIds.size === 0) {
      this.deleteSelectedRuler();
      return;
    }

    // Whole pieces, and there may be several: a marquee dragged across the
    // layout selects every point of everything it covers, and that is how you
    // say "these panels" rather than "these handles".
    const whole = this.pattern.pieces.filter((piece) => this.isEntirePieceSelected(piece));
    if (whole.length > 0) {
      this.deletePieces(whole.map((piece) => piece.id));
      return;
    }

    // Anything less than a whole piece is a point edit on the piece in hand.
    if (this.selectedIds.size === 0) return;
    this.deleteSelectedPoints();
  }

  private onPointerDown(e: PointerEvent): void {
    this.root.focus({ preventScroll: true });
    if (e.button === 0) this.hideContextMenu();

    // Alt over a scale handle means "scale about the selection centre", so the
    // handle takes precedence over the Alt-pan gesture there. Alt on a point is
    // the other exception: it flips the point between a Bézier point and a sharp
    // corner, so the press is the toggle rather than the start of a pan. Alt on a
    // panel is a third: it duplicates the panel and carries the copy.
    const hitEl = e.target as SVGElement;
    const onScaleHandle =
      this.tool === 'move' && hitEl.dataset?.kind === 'scale' && !!hitEl.dataset.handle;
    const altPress = this.tool === 'move' && e.button === 0 && e.altKey && !onScaleHandle;
    const altAnchor = altPress ? this.anchorPointAt(this.svgPoint(e)) : null;
    const altPiece = altPress && !altAnchor ? this.pieceAt(hitEl, this.svgPoint(e)) : null;

    // Middle-mouse (or Alt-left) pans the pattern view. A locked frame has no
    // view of its own, so there the gesture belongs to the canvas behind it.
    const lockedFrame = !!this.container?.locked;
    const panGesture =
      e.button === 1 ||
      (e.button === 0 && e.altKey && !onScaleHandle && !altAnchor && !altPiece);
    if (lockedFrame && panGesture) return;
    if (panGesture) {
      this.drag = {
        type: 'pan',
        startClient: { x: e.clientX, y: e.clientY },
        startView: { x: this.viewBox.x, y: this.viewBox.y },
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.button !== 0) return;

    // The stack's output is something to look at, not to draw on: panning and
    // zooming still work (above), every other press says how to get back to the
    // editable copy.
    if (this.readOnly) {
      e.stopPropagation();
      e.preventDefault();
      this.cbs.onLockedPress?.();
      return;
    }
    e.stopPropagation();

    // A preview is not committed until Done: any fresh gesture on the canvas
    // (a new pick, a point drag) means the draftsperson has moved on, so put the
    // points back before the gesture is read against them.
    if (this.simplify) this.cancelSimplify();

    const target = e.target as SVGElement;
    const kind = target.dataset?.kind;
    const pointId = target.dataset?.pointId;
    const pieceId = target.dataset?.pieceId;
    const p = this.svgPoint(e);

    // Alt on a point flips it between a Bézier point and a sharp corner — the
    // point ribbon's Corner box, where the hand already is.
    if (altAnchor) {
      this.selectOnly(altAnchor.point.id, altAnchor.piece.id);
      this.toggleCornerPoint(altAnchor.piece, altAnchor.point);
      e.preventDefault();
      return;
    }

    // Alt on a panel duplicates it: the copy is what the drag carries, and the
    // original stays where it was. The same press without Alt picks the panel up.
    if (altPiece) {
      this.beginAltDuplicate(e, p, altPiece);
      return;
    }

    // A note takes its own presses: it is an object written over the pattern, not
    // a piece of it, and it is picked, carried and typed into in place.
    if (this.tool === 'move') {
      const noteEl = (e.target as Element | null)?.closest?.('[data-text-id]') as
        | HTMLElement
        | null;
      const noteId = noteEl?.dataset.textId ?? null;
      if (noteId) {
        this.onTextDown(e, p, noteId);
        return;
      }
      // An image takes its own presses the same way — but only where the
      // picture shows: it is drawn under the pieces, so pressing through a panel
      // still picks the panel.
      const imageEl = (e.target as Element | null)?.closest?.('[data-image-id]') as
        | HTMLElement
        | null;
      const imageId = imageEl?.dataset.imageId ?? null;
      if (imageId) {
        this.onImageDown(e, p, imageId);
        return;
      }
      // Any other press is done with the note being typed into, and lets go of
      // the one in hand: a note is picked one at a time, like a ruler.
      if (this.textEditingId) this.commitTextEditing();
      if (this.selectedTextId) {
        this.selectedTextId = null;
        this.cbs.onTextSelectionChange?.();
        this.redraw();
      }
      if (this.selectedImageId) this.setImageSelection(null);
    }

    // The Ruler tool has two hands: the rule laid over the work, and the measure
    // line that reads off what it crosses. Which one a press gets is the mode —
    // the mode test has to come first, since both are the same tool underneath.
    if (this.tool === 'ruler') {
      if (this.rulerMode === 'measure') this.onMeasureDown(e, p);
      else this.onRulerDown(e, p);
      return;
    }

    // The move tool can pick a ruler or a readout up off the canvas too — but
    // only when the click is not landing on a pattern point or handle, which
    // take precedence.
    if (this.tool === 'move' && !kind) {
      const measureHit = this.findMeasureHit(p);
      if (measureHit?.part === 'label') {
        this.onMeasureDown(e, p);
        return;
      }
      const rulerHit = this.findRulerHit(p);
      if (rulerHit) {
        this.onRulerDown(e, p, rulerHit);
        return;
      }
    }

    // Orbit: two picks set the tether — the point that moves, then the point it
    // turns about — and from then on the moving point only travels round the
    // second one. Read before the plain point-drag below, which is what Free is.
    if (this.tool === 'move' && this.moveMode === 'orbit' && this.onOrbitDown(e, p)) return;

    // ⌘/Ctrl-click with the move tool drops a new point on the edge under the
    // pointer, the pen's edge insert without leaving the tool. A press that
    // lands on a point or handle keeps its own meaning.
    if (this.tool === 'move' && (e.metaKey || e.ctrlKey) && kind !== 'anchor' && kind !== 'handleIn' && kind !== 'handleOut') {
      const edge = this.edgeNear(p, [this.pieceAt(e.target, p), ...this.pattern.pieces]);
      const pt = edge ? this.insertEdgePoint(edge.piece, edge.edgeIndex, edge.point) : null;
      if (pt && edge) {
        this.selectOnly(pt.id, edge.piece.id);
        this.drag = {
          type: 'moveSelection',
          start: p,
          snapshots: this.snapshotSelection(),
          moved: false,
        };
        this.svg.setPointerCapture(e.pointerId);
        e.preventDefault();
        this.cbs.onChange();
        this.redraw();
        return;
      }
    }

    // Seam allowance, with the allowance shown: a plain click picks the edge
    // under the pointer so the ribbon can set it. ⌘/Ctrl-click is left alone, so
    // the point insert above still works and the modifier keeps its own meaning.
    if (
      this.tool === 'move' &&
      this.allowanceOn &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      kind !== 'anchor' &&
      kind !== 'handleIn' &&
      kind !== 'handleOut'
    ) {
      const hit = this.edgesNear(p)[0] ?? null;
      if (hit) {
        this.setRulerSelection(null);
        const same =
          this.allowanceEdge?.pieceId === hit.piece.id &&
          this.allowanceEdge?.edgeIndex === hit.edgeIndex;
        this.setAllowanceEdge(same ? null : { pieceId: hit.piece.id, edgeIndex: hit.edgeIndex });
        e.preventDefault();
        return;
      }
      this.setAllowanceEdge(null);
    }

    // Cmd/Ctrl is the panel modifier: the press takes the panel under the pointer
    // in or out of the selection, and a drag from there is a rectangle over whole
    // panels. A press that lands on an edge still drops a point (just above), and
    // a generated block keeps its own intercept (just below).
    if (this.tool === 'move' && (e.metaKey || e.ctrlKey) && !this.blockForPiece(pieceId)) {
      const piece = this.pieceAt(e.target, p);
      this.drag = {
        type: 'marquee',
        start: p,
        current: p,
        additive: false,
        panels: true,
        togglePieceId: piece?.id,
      };
      this.reportMarquee(this.drag);
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }

    // The sew tool works on the *edges* of a piece, not on the shape inside it,
    // so it has to be offered the click before the block intercept below. A
    // block's outline is exactly what you sew its pieces together by; letting
    // the intercept take the click would make generated pieces unsewable.
    if (this.tool === 'sew') {
      this.setRulerSelection(null);
      this.onSewDown(p);
      return;
    }

    // Join works on edges too, and on whole ones: which half a click lands on
    // says nothing about a fuse, so the pick is the edge itself.
    if (this.isModify('join')) {
      this.setRulerSelection(null);
      this.onJoinDown(p);
      return;
    }

    // A bridge is picked the same way a fuse is, edge by whole edge.
    if (this.isModify('bridge')) {
      this.setRulerSelection(null);
      this.onBridgeDown(p);
      return;
    }

    // A generated block piece is edited through its variables, not its points:
    // clicking selects the block, dragging moves the whole draft. Regeneration
    // would otherwise discard whatever you did to an individual point.
    const block = this.blockForPiece(pieceId);
    if (block) {
      this.onBlockPointerDown(e, p, block, pieceId);
      return;
    }

    // Anything else gives the ruler up: a ruler is only "in hand" while nothing
    // else is being edited, so its settings ribbon must not linger.
    this.setRulerSelection(null);

    // A hit on a piece's own body — its fill or its grainline, neither of which
    // carries a `kind` — picks the whole piece. Without this a click inside a
    // piece fell through to the marquee and cleared the selection on release, so
    // the only way to pick up a panel was to catch one of its corners exactly.
    if (this.tool === 'move' && !kind && pieceId) {
      const piece = this.pattern.pieces.find((entry) => entry.id === pieceId);
      if (piece) {
        // Already part of a wider selection? Then this is a drag of the whole
        // thing rather than a re-pick of one piece out of it.
        if (!this.isEntirePieceSelected(piece)) this.selectEntirePiece(piece);
        this.drag = {
          type: 'moveSelection',
          start: p,
          snapshots: this.snapshotSelection(),
          moved: false,
        };
        this.svg.setPointerCapture(e.pointerId);
        e.preventDefault();
        this.redraw();
        return;
      }
    }

    if (this.tool === 'add') {
      // The pen draws a piece click by click; the shapes are dragged out.
      if (this.addMode === 'pen') {
        this.onPenDown(e, p);
        return;
      }
      // Text, images and sections are not pattern work: drag out the box and hand
      // it over, and let the host take the tool back afterwards.
      if (this.addMode === 'text' || this.addMode === 'section' || this.addMode === 'image') {
        this.drag = { type: 'objectBox', kind: this.addMode, start: p, current: p };
        this.svg.setPointerCapture(e.pointerId);
        e.preventDefault();
        this.redraw();
        return;
      }
      this.drag = {
        type: 'drawShape',
        shape: this.addMode,
        start: p,
        current: p,
        lockAspect: e.shiftKey,
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }

    if (this.isModify('extrude')) {
      this.onExtrudeDown(e, p);
      return;
    }

    if (this.tool === 'cut') {
      if (this.cutMode === 'dart') {
        this.onDartDown(p);
        return;
      }
      this.onCutDown(e, p);
      return;
    }

    if (this.tool === 'move' && kind === 'scale') {
      const handle = (target.dataset.handle ?? target.dataset.corner) as ScaleHandle | undefined;
      const box = this.selectionScaleBox();
      if (!handle || !box || this.selectedIds.size < 2) return;
      const fixed = this.scaleFixedPoint(box, handle);
      const center = {
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
      };
      const startHandle = handleCentre(box, handle);
      this.markBeforeChange();
      this.drag = {
        type: 'scaleSelection',
        handle,
        axis: this.scaleAxisForHandle(handle),
        start: p,
        fixed,
        center,
        startSize: {
          x: startHandle.x - fixed.x,
          y: startHandle.y - fixed.y,
        },
        centerSize: {
          x: startHandle.x - center.x,
          y: startHandle.y - center.y,
        },
        snapshots: this.snapshotSelection(),
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Outside every grip, and outside every element that carries its own
    // meaning: the rotate zone around a corner. A drag starting near a corner
    // turns the selection about its centre, and Shift snaps it to 15° steps.
    if (this.tool === 'move' && !kind && this.selectedIds.size >= 2) {
      const box = this.selectionScaleBox();
      const corner = box ? this.rotateCornerAt(p, box) : null;
      if (corner && box) {
        const center = {
          x: (box.minX + box.maxX) / 2,
          y: (box.minY + box.maxY) / 2,
        };
        this.markBeforeChange();
        this.drag = {
          type: 'rotateSelection',
          center,
          startAngle: angleAbout(p, center),
          snapshots: this.snapshotSelection(),
        };
        this.svg.setPointerCapture(e.pointerId);
        e.preventDefault();
        this.redraw();
        return;
      }
    }

    if (this.tool === 'move' && kind === 'selectionBox') {
      this.drag = {
        type: 'moveSelection',
        start: p,
        snapshots: this.snapshotSelection(),
        moved: false,
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (kind === 'handleIn' || kind === 'handleOut') {
      if (!pointId || !pieceId) return;
      this.selectOnly(pointId, pieceId);
      const piece = this.pattern.pieces.find((x) => x.id === pieceId)!;
      const pt = piecePointById(piece, pointId)!;
      this.markBeforeChange();
      this.drag = {
        type: 'handle',
        pieceId,
        pointId,
        which: kind === 'handleIn' ? 'in' : 'out',
        mirror: !!pt.handlesParallel && !e.altKey,
      };
      this.svg.setPointerCapture(e.pointerId);
      this.redraw();
      return;
    }

    if (kind === 'anchor' && pointId && pieceId) {
      if (this.tool === 'move') {
        if (e.shiftKey) {
          // Toggle in multi-selection
          if (this.selectedIds.has(pointId)) {
            this.selectedIds.delete(pointId);
            if (this.selectedPointId === pointId) {
              this.selectedPointId = this.selectedIds.values().next().value ?? null;
            }
          } else {
            this.selectedIds.add(pointId);
            this.selectedPointId = pointId;
            this.selectedPieceId = pieceId;
          }
          this.redraw();
          return;
        }

        if (!this.selectedIds.has(pointId)) {
          this.selectOnly(pointId, pieceId);
        } else {
          this.selectedPointId = pointId;
          this.selectedPieceId = pieceId;
        }

        this.drag = {
          type: 'moveSelection',
          start: p,
          snapshots: this.snapshotSelection(),
          moved: false,
        };
        this.svg.setPointerCapture(e.pointerId);
        this.redraw();
        return;
      }

      // Every other tool picks the one point and drags it.
      this.selectOnly(pointId, pieceId);
      this.markBeforeChange();
      this.markBeforeChange();
      this.drag = {
        type: 'moveSelection',
        start: p,
        snapshots: this.snapshotSelection(),
        moved: false,
      };
      this.svg.setPointerCapture(e.pointerId);
      this.redraw();
      return;
    }

    // Move tool: empty drag → marquee
    if (this.tool === 'move') {
      this.drag = {
        type: 'marquee',
        start: p,
        current: p,
        additive: e.shiftKey && !(e.metaKey || e.ctrlKey),
        panels: e.metaKey || e.ctrlKey,
      };
      this.reportMarquee(this.drag);
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
    }
  }

  private onDartDown(p: Vec2): void {
    const piece = this.activePiece();
    if (!piece) return;
    if (!piece.closed || piece.points.length < 3) return;
    this.markBeforeChange();
    const result = insertDartOnPiece(piece.points, piece.closed, p, () => uid('pt'));
    if (!result.ok) {
      this.endHistoryGesture();
      return;
    }
    this.selectOnly(result.apexId, piece.id);
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /**
   * Extrude an edge: drag away from it and the outline grows a copy of it, joined
   * back to the original endpoints by two new edges — the tab a 3D modeller gets
   * from extruding an edge. Like the shape tools nothing is written until the
   * drag is released, so a click without a drag leaves the piece alone.
   */
  private onExtrudeDown(e: PointerEvent, p: Vec2): void {
    const edge = this.extrudeEdgeAt(p);
    if (!edge) return;
    this.drag = {
      type: 'extrudeEdge',
      pieceId: edge.pieceId,
      fromPointId: edge.fromPointId,
      toPointId: edge.toPointId,
      start: p,
      current: p,
    };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.redraw();
  }

  /**
   * The edge under the pointer, across every piece. Generated (block) geometry is
   * skipped: it is rebuilt from its variables, so a new edge there would not
   * survive the next regeneration.
   */
  /** Loop cut modes cut from a hovered edge rather than from a drag. */
  private isLoopCut(): boolean {
    return this.tool === 'cut' && (this.cutMode === 'loop' || this.cutMode === 'loop-straight');
  }

  /**
   * The cut the pointer would make: on the nearest outline edge within reach,
   * square to it, across to the far side. Follow mode bends it with the piece's
   * contours — see `loopCutAt`.
   */
  private loopCutAtPointer(p: Vec2): {
    pieceId: string;
    edgeIndex: number;
    t: number;
    cut: LoopCut;
  } | null {
    const hit = this.findNearestEdgeAcrossPieces(p);
    if (!hit || this.isGeneratedPiece(hit.piece.id)) return null;
    const cut = loopCutAt(hit.piece, {
      edgeIndex: hit.edgeIndex,
      t: hit.t,
      follow: this.cutMode === 'loop',
    });
    if (!cut) return null;
    return { pieceId: hit.piece.id, edgeIndex: hit.edgeIndex, t: hit.t, cut };
  }

  /**
   * The inset the pointer is asking for: how far in from an edge it is, read as
   * the distance from the pointer to the nearest edge of the panel it is over —
   * so the loop runs *through* the pointer, and pushing the pointer about pushes
   * the line about with it. On a circle that is a smaller circle the pointer sits
   * on; on a panel it is the panel's own contour, carried in.
   *
   * Refused (null) when there is no room for the loop: too close to the edge to be
   * a cut, or so deep that the loop would cross itself or run off the cloth.
   */
  private insetAtPointer(
    p: Vec2,
    quantise: boolean
  ): { pieceId: string; loop: BezierPoint[]; scale: number; gap: number } | null {
    // The panel the pointer is standing on, topmost first: the one it is over, or
    // failing that the one whose edge it is nearest to.
    const covered = [...this.pattern.pieces]
      .reverse()
      .find(
        (piece) =>
          piece.closed &&
          piece.points.length >= 3 &&
          !this.isGeneratedPiece(piece.id) &&
          pointInPiece(p, piece)
      );
    const piece = covered ?? this.findNearestEdgeAcrossPieces(p)?.piece ?? null;
    if (!piece || !piece.closed || piece.points.length < 3) return null;
    const centre = polygonCentroid(pieceToPolyline(piece.points, true, 8));
    let scale = insetScaleThrough(piece.points, centre, p);
    if (scale === null) return null;
    // Shift quantises the size, so the same loop can be asked for twice.
    if (quantise) scale = Math.round(scale * 100) / 100;
    if (scale <= MIN_INSET_SCALE || scale >= 1) return null;
    const loop = scaleRing(piece.points, scale, centre);
    if (!loopFitsOnCloth(piece, loop)) return null;
    return { pieceId: piece.id, loop, scale, gap: insetGap(piece.points, loop) };
  }

  private extrudeEdgeAt(p: Vec2): PieceEdge | null {
    const hit = this.findNearestEdgeAcrossPieces(p);
    if (!hit || this.isGeneratedPiece(hit.piece.id)) return null;
    return {
      pieceId: hit.piece.id,
      fromPointId: hit.fromPointId,
      toPointId: hit.toPointId,
    };
  }

  /**
   * Resolve a live extrude drag against the current document: the edge's two
   * anchors and the offset the pointer has pulled them by. Ids are re-resolved
   * rather than remembered, so a drag can never splice into a stale index.
   */
  private extrudeEdgeRef(drag: Extract<DragKind, { type: 'extrudeEdge' }>): {
    piece: PatternPiece;
    edgeIndex: number;
    a: BezierPoint;
    b: BezierPoint;
    offset: Vec2;
  } | null {
    const piece = this.pattern.pieces.find((x) => x.id === drag.pieceId);
    if (!piece) return null;
    const edge = edgeRingForPointIds(piece, drag.fromPointId, drag.toPointId);
    if (!edge) return null;
    const a = edge.ring[edge.edgeIndex];
    const b = edge.ring[(edge.edgeIndex + 1) % edge.ring.length];
    if (!a || !b) return null;
    return {
      piece,
      edgeIndex: pieceEdgeNumber(piece, edge.ringIndex, edge.edgeIndex),
      a,
      b,
      offset: { x: drag.current.x - drag.start.x, y: drag.current.y - drag.start.y },
    };
  }

  private finishExtrudeEdge(drag: Extract<DragKind, { type: 'extrudeEdge' }>): void {
    const ref = this.extrudeEdgeRef(drag);
    if (!ref || Math.hypot(ref.offset.x, ref.offset.y) < this.hitRadius() * 0.5) {
      this.endHistoryGesture();
      return;
    }
    const { piece, edgeIndex, a, b, offset } = ref;
    // The copy carries the edge's own shape: handles travel with it, so a curved
    // edge extrudes as a parallel curve rather than as its chord.
    const carried = (handle: Vec2 | null): Vec2 | null =>
      handle ? { x: handle.x + offset.x, y: handle.y + offset.y } : null;
    const insertA: BezierPoint = {
      id: uid('pt'),
      anchor: { x: a.anchor.x + offset.x, y: a.anchor.y + offset.y },
      handleIn: null,
      handleOut: carried(a.handleOut),
      handlesParallel: false,
    };
    const insertB: BezierPoint = {
      id: uid('pt'),
      anchor: { x: b.anchor.x + offset.x, y: b.anchor.y + offset.y },
      handleIn: carried(b.handleIn),
      handleOut: null,
      handlesParallel: false,
    };
    // The edge number is the piece-wide one, so the tab goes onto the ring the
    // edge actually lives on — a hole's edge extrudes like any other.
    const on = pieceEdgeAt(piece, edgeIndex);
    if (!on) {
      this.endHistoryGesture();
      return;
    }
    this.markBeforeChange();
    // The two edges leading in and out of the tab are straight, so whatever
    // curvature the base edge had goes with the copy.
    a.handleOut = null;
    b.handleIn = null;
    on.ring.splice(on.edgeIndex + 1, 0, insertA, insertB);
    this.setSelection([insertA.id, insertB.id], insertB.id);
    this.selectedPieceId = piece.id;
    this.cbs.onChange();
    this.endHistoryGesture();
  }

  /** The edge a click would extrude, lit up under the pointer. */
  private drawExtrudeHover(hover: PieceEdge): void {
    // The seam tool's edge-stroking routine, asked for the whole edge (0 → 1).
    this.drawSeamEdgeStroke({ ...hover, t0: 0, t1: 1 }, 'pattern-extrude-hover', false);
  }

  /** The tab being pulled out: the raised copy of the edge and its connectors. */
  private drawExtrudePreview(drag: Extract<DragKind, { type: 'extrudeEdge' }>): void {
    const ref = this.extrudeEdgeRef(drag);
    if (!ref) return;
    const samples = sampleEdgeByPointIds(
      ref.piece,
      drag.fromPointId,
      drag.toPointId,
      EXTRUDE_PREVIEW_STEPS
    );
    if (!samples || samples.length < 2) return;
    const sw = this.px(1.5);
    const dash = `${this.px(5)} ${this.px(3.5)}`;

    const edge = svgEl('polyline');
    edge.setAttribute(
      'points',
      samples.map((pt) => `${pt.x + ref.offset.x},${pt.y + ref.offset.y}`).join(' ')
    );
    edge.setAttribute('class', 'pattern-extrude-preview');
    edge.setAttribute('stroke-width', String(sw));
    edge.setAttribute('stroke-dasharray', dash);
    edge.setAttribute('pointer-events', 'none');
    this.svg.appendChild(edge);

    for (const end of [ref.a, ref.b]) {
      const tip = { x: end.anchor.x + ref.offset.x, y: end.anchor.y + ref.offset.y };
      const connector = svgEl('line');
      connector.setAttribute('x1', String(end.anchor.x));
      connector.setAttribute('y1', String(end.anchor.y));
      connector.setAttribute('x2', String(tip.x));
      connector.setAttribute('y2', String(tip.y));
      connector.setAttribute('class', 'pattern-extrude-preview');
      connector.setAttribute('stroke-width', String(sw));
      connector.setAttribute('stroke-dasharray', dash);
      connector.setAttribute('pointer-events', 'none');
      this.svg.appendChild(connector);

      const dot = svgEl('circle');
      dot.setAttribute('cx', String(tip.x));
      dot.setAttribute('cy', String(tip.y));
      dot.setAttribute('r', String(this.px(3.5)));
      dot.setAttribute('class', 'pattern-extrude-point');
      dot.setAttribute('stroke-width', String(this.px(1.2)));
      dot.setAttribute('pointer-events', 'none');
      this.svg.appendChild(dot);
    }
  }

  /**
   * Every edge within a screen-space threshold of a point, nearest first.
   *
   * A list rather than one edge because edges can be *on top of each other*: two
   * pieces laid out along the same boundary — which is exactly how a piece split
   * in two for drafting is drawn — put two edges in the same place, and only the
   * caller knows which of them it means.
   */
  private edgesNear(p: Vec2): Array<{
    piece: PatternPiece;
    edgeIndex: number;
    fromPointId: string;
    toPointId: string;
    /** Where along that edge the point is, in the edge's own winding. */
    t: number;
    dist: number;
  }> {
    const threshold = Math.max(0.5, 12 / this.screenToPatternScale());
    const hits: Array<{
      piece: PatternPiece;
      edgeIndex: number;
      fromPointId: string;
      toPointId: string;
      t: number;
      dist: number;
    }> = [];
    for (const piece of this.pattern.pieces) {
      if (piece.points.length < 2) continue;
      const hit = findNearestPieceEdge(piece, p);
      if (!hit || hit.dist > threshold) continue;
      hits.push({
        piece,
        edgeIndex: hit.edgeNumber,
        fromPointId: hit.ring[hit.edgeIndex]!.id,
        toPointId: hit.ring[(hit.edgeIndex + 1) % hit.ring.length]!.id,
        t: hit.t,
        dist: hit.dist,
      });
    }
    hits.sort((a, b) => a.dist - b.dist);
    return hits;
  }

  /** Nearest edge across all pieces within a screen-space threshold. */
  private findNearestEdgeAcrossPieces(p: Vec2): {
    piece: PatternPiece;
    edgeIndex: number;
    fromPointId: string;
    toPointId: string;
    /** Where along that edge the point is, in the edge's own winding. */
    t: number;
    dist: number;
  } | null {
    return this.edgesNear(p)[0] ?? null;
  }

  private sameEdge(a: HoverEdge | SeamEdgeRef, b: HoverEdge | SeamEdgeRef): boolean {
    return sameSeamEdgeTopology(a, b);
  }

  /**
   * Whole-edge reference read from the half a point landed on (Marvelous
   * Designer-style): the half you click is the end the edge is read from, so the
   * sewing direction can be aimed directly. Shared with the 3D sew tool.
   */
  private refForHalf(
    pieceId: string,
    fromPointId: string,
    toPointId: string,
    t: number
  ): HoverEdge {
    return seamRefFromHalf(pieceId, fromPointId, toPointId, t);
  }

  /**
   * Is the place that was clicked already sewn?
   *
   * Not the same question as "does this edge carry a seam": a many-to-many sew
   * leaves several seams along one edge, and the free part of a half-sewn edge is
   * still there to be sewn. Asking by edge alone refuses work that is perfectly
   * possible, and says nothing about why.
   */
  private edgeSewnAt(edge: SeamEdgeRef, t: number): boolean {
    const hit = {
      pieceId: edge.pieceId,
      fromPointId: edge.fromPointId,
      toPointId: edge.toPointId,
      t,
    };
    return this.pattern.seams.some((seam) => seamCoversEdge(seam, hit));
  }

  private edgeUsedInExistingSeam(edge: SeamEdgeRef): boolean {
    return this.pattern.seams.some((seam) => this.sameEdge(seam.a, edge) || this.sameEdge(seam.b, edge));
  }

  private edgeIn(edges: SeamEdgeRef[], edge: SeamEdgeRef): number {
    return edges.findIndex((candidate) => this.sameEdge(candidate, edge));
  }

  private clearMultiSew(): void {
    this.multiSewPhase = 'source';
    this.multiSewSource = [];
    this.multiSewTarget = [];
    this.syncSewBar();
  }

  private syncSewBar(): void {
    // The settings popover belongs to the same hand as this bar, so the two are
    // kept current together — as they are for the fuse and the bridge.
    this.syncToolSettings();
    if (!this.sewBar) return;
    const active = this.tool === 'sew' && this.sewMode === 'many';
    this.sewBar.hidden = !active;
    if (!active) return;
    const instruction = this.sewBar.querySelector('[data-sew-instruction]') as HTMLElement;
    const reverse = this.sewBar.querySelector('[data-sew-reverse]') as HTMLButtonElement;
    const next = this.sewBar.querySelector('[data-sew-next]') as HTMLButtonElement;
    if (this.multiSewPhase === 'source') {
      instruction.textContent = `Side A (${this.multiSewSource.length}): ${this.describeSewEdges(this.multiSewSource)}`;
      instruction.title = instruction.textContent;
      reverse.disabled = this.multiSewSource.length < 2;
      next.textContent = 'Next side';
      next.disabled = this.multiSewSource.length === 0;
    } else {
      instruction.textContent = `Side B (${this.multiSewTarget.length}): ${this.describeSewEdges(this.multiSewTarget)}`;
      instruction.title = instruction.textContent;
      reverse.disabled = this.multiSewTarget.length < 2;
      next.textContent = 'Create seams';
      next.disabled = this.multiSewTarget.length === 0;
    }
  }

  /**
   * The selection *in order*, because the order is what the seams are paired in:
   * hand the two sides over backwards and every seam comes out crossed.
   */
  private describeSewEdges(edges: readonly SeamEdgeRef[]): string {
    if (edges.length === 0) return 'select edges';
    return edges
      .map((edge, i) => {
        const piece = this.pattern.pieces.find((p) => p.id === edge.pieceId);
        return `${i + 1} ${piece?.name ?? '?'}`;
      })
      .join(' \u2192 ');
  }

  private activeSewEdges(): SeamEdgeRef[] | null {
    if (this.multiSewPhase === 'source') return this.multiSewSource;
    return this.multiSewTarget;
  }

  /** Hand the current side over in the opposite order. */
  private reverseMultiSewSide(): void {
    const edges = this.activeSewEdges();
    if (!edges || edges.length < 2) return;
    edges.reverse();
    this.syncSewBar();
    this.redraw();
  }

  private advanceMultiSew(): void {
    if (this.tool !== 'sew' || this.sewMode !== 'many') return;
    if (this.multiSewPhase === 'source') {
      if (this.multiSewSource.length === 0) return;
      this.multiSewPhase = 'target';
      this.hoverEdge = null;
      this.syncSewBar();
      this.redraw();
      return;
    }
    if (this.multiSewTarget.length === 0) return;

    const candidates = buildManyToManySeams(
      this.multiSewSource,
      this.multiSewTarget,
      this.pattern.pieces
    );
    const additions = candidates.filter(
      (candidate) =>
        !this.pattern.seams.some((seam) =>
          sameSeamBindingPair(seam.a, seam.b, candidate.a, candidate.b)
        )
    );
    if (additions.length > 0) {
      this.markBeforeChange();
      this.pattern.seams.push(
        ...additions.map(({ a, b }) => ({
          id: uid('seam'),
          a,
          b,
          restGapCm: DEFAULT_SEAM_GAP_CM,
        }))
      );
      this.cbs.onChange();
      this.endHistoryGesture();
      this.clearMultiSew();
      this.hoverEdge = null;
      this.redraw();
      return;
    }

    const instruction = this.sewBar.querySelector('[data-sew-instruction]') as HTMLElement;
    instruction.textContent =
      candidates.length === 0
        ? 'Could not match selected edges'
        : 'All matched seams already exist';
    this.syncSewBar();
    this.redraw();
    return;
  }

  private onManySewDown(edge: SeamEdgeRef, pieceId: string): void {
    if (this.multiSewPhase === 'source') {
      const index = this.edgeIn(this.multiSewSource, edge);
      if (index >= 0) this.multiSewSource.splice(index, 1);
      else {
        if (this.edgeUsedInExistingSeam(edge)) return;
        this.multiSewSource.push(edge);
      }
    } else {
      // An edge cannot belong to both sides of one many-to-many operation.
      if (this.edgeIn(this.multiSewSource, edge) >= 0) return;
      const index = this.edgeIn(this.multiSewTarget, edge);
      if (index >= 0) this.multiSewTarget.splice(index, 1);
      else {
        if (this.edgeUsedInExistingSeam(edge)) return;
        this.multiSewTarget.push(edge);
      }
    }
    this.selectedPieceId = pieceId;
    this.syncSewBar();
    this.redraw();
  }

  private onSewDown(p: Vec2): void {
    const hit = this.findNearestEdgeAcrossPieces(p);
    if (!hit) return;

    // Many-to-many selects whole edges (its own ordering / reverse controls set
    // direction), so it stays forward; the segment flow takes direction from the
    // clicked half.
    const edge: SeamEdgeRef =
      this.sewMode === 'many'
        ? {
            pieceId: hit.piece.id,
            fromPointId: hit.fromPointId,
            toPointId: hit.toPointId,
            t0: 0,
            t1: 1,
          }
        : this.refForHalf(hit.piece.id, hit.fromPointId, hit.toPointId, hit.t);

    if (this.sewMode === 'many') {
      this.onManySewDown(edge, hit.piece.id);
      return;
    }

    if (!this.pendingSeam) {
      if (this.edgeSewnAt(edge, hit.t)) return;
      this.pendingSeam = edge;
      this.selectedPieceId = hit.piece.id;
      this.redraw();
      return;
    }

    if (this.sameEdge(this.pendingSeam, edge)) {
      // Same edge: clicking the same half takes the pick back, the other half
      // flips the direction it will be sewn in.
      const sameDirection =
        seamReadsFromSecondHalf(this.pendingSeam) === seamReadsFromSecondHalf(edge);
      this.pendingSeam = sameDirection ? null : edge;
      this.redraw();
      return;
    }

    // Reject duplicate of the same undirected edge pair with the same spans.
    const dup = this.pattern.seams.some((s) =>
      sameSeamBindingPair(s.a, s.b, this.pendingSeam!, edge)
    );
    if (dup) {
      this.pendingSeam = null;
      this.redraw();
      return;
    }

    const seam: SeamBinding = {
      id: uid('seam'),
      a: this.pendingSeam,
      b: edge,
      // Small positive gap — zero-rest welds destabilize the cloth solvers.
      restGapCm: DEFAULT_SEAM_GAP_CM,
    };
    this.markBeforeChange();
    this.pattern.seams.push(seam);
    this.pendingSeam = null;
    this.hoverEdge = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /**
   * The seam under a pattern-space point.
   *
   * Distance to the edge is not enough: a many-to-many sew leaves several seams
   * on one edge, side by side, so the position along the edge decides which one
   * is meant. Reverse and Remove both act on what this returns.
   */
  private findSeamNearClick(p: Vec2): SeamBinding | null {
    const threshold = Math.max(0.5, 12 / this.screenToPatternScale());
    return findSeamNearPoint(this.pattern.seams, this.pattern.pieces, p, threshold);
  }

  private reverseContextSeam(): void {
    const seam = this.pattern.seams.find((s) => s.id === this.contextSeamId);
    if (!seam) return;
    this.markBeforeChange();
    // Swap t0/t1 on side B to reverse sewing direction (MD-style)
    const t0 = seam.b.t0;
    seam.b.t0 = seam.b.t1;
    seam.b.t1 = t0;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /**
   * Hand the partners round among the seams sharing this edge.
   *
   * The other half of the fix for a many-to-many run that came out crossed: the
   * direction of each seam is fine, the order they were paired in is not.
   */
  private reverseContextSeamOrder(): void {
    const hit = this.contextSeamHit;
    if (!hit) return;
    const rewritten = reverseSeamsAcrossEdge(this.pattern.seams, hit);
    if (!rewritten) return;
    const byId = new Map(rewritten.map((seam) => [seam.id, seam]));
    this.markBeforeChange();
    this.pattern.seams = this.pattern.seams.map((seam) => byId.get(seam.id) ?? seam);
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private removeContextSeam(): void {
    if (!this.contextSeamId) return;
    this.markBeforeChange();
    this.pattern.seams = this.pattern.seams.filter((s) => s.id !== this.contextSeamId);
    this.contextSeamId = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  // ── Join ─────────────────────────────────────────────────────────────────
  // Fusing two pieces along picked edges, like welding two boundaries in a 3D
  // modeller: the first piece picked moves (and bends, and scales) until its
  // edge lies on the second piece's, and the two become one outline.

  private setJoinMode(mode: JoinMode): void {
    if (this.joinMode !== mode) this.clearJoin();
    this.joinMode = mode;
    this.syncJoinToolbar();
    this.redraw();
  }

  private setJoinFit(fit: JoinFit): void {
    if (this.joinFit === fit) return;
    this.joinFit = fit;
    this.joinSettingsChanged();
  }

  private setJoinTolerance(cm: number): void {
    const next = Math.max(0, Math.min(100, cm));
    if (next === this.joinTolerance) return;
    this.joinTolerance = next;
    this.joinSettingsChanged();
  }

  /**
   * A change of fit or tolerance re-reads the picks against it: the outline on
   * screen, and the reason a join is being refused, are both that answer.
   */
  private joinSettingsChanged(): void {
    this.syncJoinPreview();
    this.syncJoinToolbar();
    this.redraw();
  }

  /** True while the tool in hand has settings of its own, which own the popover. */
  private hasToolSettings(): boolean {
    return (
      this.tool === 'move' ||
      this.tool === 'modify' ||
      this.tool === 'sew' ||
      this.tool === 'cut' ||
      this.tool === 'ruler' ||
      this.tool === 'add'
    );
  }

  /**
   * Keep the settings ribbon up to date: it shows the set belonging to the tool
   * in hand — what the join is set to, which cut is in hand, or what Add draws.
   */
  private syncToolSettings(): void {
    if (!this.toolSettings) return;
    // The allowance ribbon is showing an edge: the slot is taken.
    const showing = this.hasToolSettings() && !(this.allowanceOn && !!this.allowanceEdge);
    this.toolSettings.hidden = !showing;
    // The block panel shares this corner, and it is the tall one: it starts
    // below the ribbon rather than painting over it, which is what used to bury
    // a tool's own controls as soon as a block was picked.
    this.root.style.setProperty(
      '--ribbon-height',
      `${showing ? this.toolSettings.offsetHeight + 8 : 0}px`
    );
    if (!showing) return;

    for (const set of Array.from(
      this.toolSettings.querySelectorAll<HTMLElement>('[data-settings-for]')
    )) {
      set.hidden = set.dataset.settingsFor !== this.tool;
    }
    // The settings that belong to one mode of the tool on screen — the fuse's
    // run, fit and tolerance, the bridge's pair, the orbit's radius — beside the
    // mode that spends them, so the ribbon never shows a control the tool will
    // not read.
    for (const extra of Array.from(
      this.toolSettings.querySelectorAll<HTMLElement>('[data-settings-extra]')
    )) {
      const which = extra.dataset.settingsExtra;
      extra.hidden = !(
        (this.tool === 'modify' && which === this.modifyMode) ||
        (this.tool === 'move' && which === this.moveMode)
      );
    }

    this.toolSettings.querySelectorAll('button[data-move-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.classList.toggle('is-active', btn.dataset.moveMode === this.moveMode);
    });

    this.toolSettings.querySelectorAll('button[data-add-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.classList.toggle('is-active', btn.dataset.addMode === this.addMode);
    });
    this.toolSettings.querySelectorAll('button[data-modify-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.classList.toggle('is-active', btn.dataset.modifyMode === this.modifyMode);
    });
    this.toolSettings.querySelectorAll('button[data-sew-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.classList.toggle('is-active', btn.dataset.sewMode === this.sewMode);
    });
    this.toolSettings.querySelectorAll('button[data-bridge-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.classList.toggle('is-active', btn.dataset.bridgeMode === this.bridgeMode);
    });
    this.toolSettings.querySelectorAll('button[data-cut-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.classList.toggle('is-active', btn.dataset.cutMode === this.cutMode);
    });
    this.toolSettings.querySelectorAll('button[data-ruler-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.classList.toggle('is-active', btn.dataset.rulerMode === this.rulerMode);
    });
    this.toolSettings.querySelectorAll('button[data-join-mode]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.classList.toggle('is-active', btn.dataset.joinMode === this.joinMode);
    });
    this.toolSettings.querySelectorAll('button[data-join-fit]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      btn.classList.toggle('is-active', btn.dataset.joinFit === this.joinFit);
    });
    const tolerance = this.toolSettings.querySelector(
      'input[data-join-tolerance]'
    ) as HTMLInputElement;
    // Left alone while it is being typed in, or the field would fight the hand.
    if (document.activeElement !== tolerance) tolerance.value = String(this.joinTolerance);
    const matching = this.joinFit === 'match';
    tolerance.disabled = !matching;
    tolerance.closest('label')?.classList.toggle('is-disabled', !matching);

    this.syncOrbitRibbon();
  }

  /** The orbit's half of the Move ribbon: where the picks have got to, and the tether's length. */
  private syncOrbitRibbon(): void {
    const hint = this.toolSettings.querySelector('[data-orbit-hint]') as HTMLElement | null;
    const unit = this.toolSettings.querySelector('[data-orbit-unit]') as HTMLElement | null;
    if (unit) unit.textContent = this.unit;
    const field = this.orbitRadiusInput;
    if (!field) return;
    const armed = !!this.orbit;
    field.disabled = !armed;
    field.closest('label')?.classList.toggle('is-disabled', !armed);
    if (armed && document.activeElement !== field) {
      field.value = String(Number(cmToDisplay(this.orbit!.radius, this.unit).toFixed(3)));
    }
    if (hint) {
      hint.textContent = armed
        ? 'Drag the point to swing it · Shift-drag to pull the tether'
        : this.orbitPickId
          ? 'Now pick the point it turns about'
          : this.moveMode === 'orbit'
            ? 'Pick the point that moves'
            : '';
    }
  }

  /** The Join job's own settings live in the ribbon, so this keeps bar, rail and ribbon current. */
  private syncJoinToolbar(): void {
    this.syncJoinBar();
    this.syncToolRail();
  }

  /** Throw the picks away — Cancel, Escape, undo, or the tool going out of hand. */
  private clearJoin(): void {
    this.joinMove = [];
    this.joinKeep = [];
    this.joinPhase = 'move';
    this.joinPreview = { piece: null, reason: null, gap: 0 };
    this.syncJoinBar();
  }

  /**
   * Which side a click lands on. The piece decides, not the order of clicks
   * after the first: one piece moves and the other stays, so edges of the first
   * piece picked are the moving side however they are clicked, and a piece
   * nobody has picked yet becomes the side that stays.
   */
  private joinSideFor(pieceId: string): 'move' | 'keep' | 'restart' {
    if (this.joinMove.length === 0) return 'move';
    if (this.joinMove[0].pieceId === pieceId) return 'move';
    if (this.joinKeep.length === 0) return 'keep';
    if (this.joinKeep[0].pieceId === pieceId) return 'keep';
    return 'restart';
  }

  private toggleJoinPick(edge: SeamEdgeRef): void {
    const onMove = this.edgeIn(this.joinMove, edge);
    if (onMove >= 0) {
      this.joinMove.splice(onMove, 1);
      // A fuse needs a side that moves, so the side left over becomes it.
      if (this.joinMove.length === 0) {
        this.joinMove = this.joinKeep;
        this.joinKeep = [];
        this.joinPhase = 'move';
      }
      return;
    }
    const onKeep = this.edgeIn(this.joinKeep, edge);
    if (onKeep >= 0) {
      this.joinKeep.splice(onKeep, 1);
      return;
    }
    switch (this.joinSideFor(edge.pieceId)) {
      case 'move':
        if (this.joinMode === 'many') this.joinMove.push(edge);
        else this.joinMove = [edge];
        this.joinPhase = 'move';
        break;
      case 'keep':
        if (this.joinMode === 'many') this.joinKeep.push(edge);
        else this.joinKeep = [edge];
        this.joinPhase = 'keep';
        break;
      default:
        // A third piece: start a new fuse rather than guess which pick to drop.
        this.joinMove = [edge];
        this.joinKeep = [];
        this.joinPhase = 'move';
        break;
    }
  }

  /**
   * Many mode: through with the side that moves, now pick what it fuses onto.
   * On a boundary the two pieces share there is no other way to say so.
   */
  /**
   * Confirm the side in hand and pick the other one — the many-to-many button.
   * It turns round once the picking has crossed over, so a run can be added to
   * either side without starting the pick again.
   */
  private toggleJoinSide(): void {
    if (!this.isModify('join') || this.joinMode !== 'many') return;
    if (this.joinPhase === 'move') {
      if (this.joinMove.length === 0) return;
      this.joinPhase = 'keep';
    } else {
      this.joinPhase = 'move';
    }
    this.hoverEdge = null;
    this.syncJoinBar();
    this.redraw();
  }

  /** Fuse the other piece onto this one instead — which piece moves is the choice. */
  private swapJoinSides(): void {
    if (this.joinMove.length === 0 || this.joinKeep.length === 0) return;
    const move = this.joinMove;
    this.joinMove = this.joinKeep;
    this.joinKeep = move;
    this.syncJoinPreview();
    this.syncJoinBar();
    this.redraw();
  }

  private describeJoinSide(edges: readonly SeamEdgeRef[]): string {
    if (edges.length === 0) return 'nothing';
    const name = this.pattern.pieces.find((p) => p.id === edges[0].pieceId)?.name ?? '?';
    const count = edges.length === 1 ? '1 edge' : `${edges.length} edges`;
    return `${name} · ${count}`;
  }

  private syncJoinBar(): void {
    // The settings popover belongs to the same hand as this bar, so the two are
    // kept current together.
    this.syncToolSettings();
    if (!this.joinBar) return;
    const active = this.isModify('join');
    this.joinBar.hidden = !active;
    if (!active) return;
    const instruction = this.joinBar.querySelector('[data-join-instruction]') as HTMLElement;
    const next = this.joinBar.querySelector('[data-join-next]') as HTMLButtonElement;
    const swap = this.joinBar.querySelector('[data-join-swap]') as HTMLButtonElement;
    const commit = this.joinBar.querySelector('[data-join-commit]') as HTMLButtonElement;
    const cancel = this.joinBar.querySelector('[data-join-cancel]') as HTMLButtonElement;

    const many = this.joinMode === 'many';
    const bothPicked = this.joinMove.length > 0 && this.joinKeep.length > 0;
    // Many-to-many is picked a side at a time, so it keeps a button to confirm
    // the side in hand: one side picked, then the run it fuses onto. It stays in
    // the bar for the whole pick so the hand-over is there to be found, and
    // turns round afterwards to hand the picking back.
    const onMoveSide = this.joinPhase === 'move';
    const otherSidePicked = this.joinKeep.length > 0;
    next.hidden = !many;
    next.disabled = onMoveSide && this.joinMove.length === 0;
    if (onMoveSide) {
      next.textContent = otherSidePicked ? '→ Second side' : 'Confirm edges →';
      next.title = otherSidePicked
        ? 'Pick the run on the second piece again'
        : 'Confirm the edges that move, then pick the run they fuse onto';
    } else {
      next.textContent = '← First side';
      next.title = 'Pick more edges on the piece that moves — nothing is committed yet';
    }
    swap.disabled = !bothPicked;
    commit.disabled = !bothPicked || !this.joinPreview.piece;
    // Nothing picked is nothing to cancel, so the button stays out of reach
    // until there is something to throw away.
    cancel.disabled = !bothPicked && this.joinMove.length === 0 && this.joinKeep.length === 0;

    if (!bothPicked) {
      if (this.joinMove.length === 0) {
        instruction.textContent = many
          ? 'Click the edges that move, then Confirm edges for the run they fuse onto.'
          : 'Click an edge on each piece. The first piece picked moves.';
      } else if (this.joinPhase === 'move' && many) {
        instruction.textContent = `Moves: ${this.describeJoinSide(this.joinMove)} — more edges, or Confirm edges`;
      } else if (this.joinPhase === 'move') {
        instruction.textContent = `Moves: ${this.describeJoinSide(this.joinMove)} — now click an edge on the other piece`;
      } else {
        instruction.textContent = `Moves ${this.describeJoinSide(this.joinMove)} — now click the edges it fuses onto`;
      }
    } else if (!this.joinPreview.piece) {
      instruction.textContent = this.joinPreview.reason ?? 'Those edges cannot be fused';
    } else {
      const onto = `Moves ${this.describeJoinSide(this.joinMove)} onto ${this.describeJoinSide(this.joinKeep)}`;
      // Say what the fuse is doing to the piece: bent onto the edges, or moved
      // and scaled into place with whatever is left between the edges filled in.
      const gap = this.joinPreview.gap;
      if (this.joinFit === 'warp') {
        instruction.textContent = onto;
      } else if (gap >= 0.005) {
        instruction.textContent = `${onto} · matched, filling ${formatLength(gap, this.unit, 2)}`;
      } else {
        instruction.textContent = `${onto} · matched`;
      }
    }
    instruction.title = instruction.textContent;
    instruction.classList.toggle('is-refused', bothPicked && !this.joinPreview.piece);
  }

  /** Work the fuse out ahead of committing, so the outline can be shown and said. */
  private syncJoinPreview(): void {
    if (this.joinMove.length === 0 || this.joinKeep.length === 0) {
      this.joinPreview = { piece: null, reason: null, gap: 0 };
      return;
    }
    const move = this.pattern.pieces.find((p) => p.id === this.joinMove[0].pieceId);
    const keep = this.pattern.pieces.find((p) => p.id === this.joinKeep[0].pieceId);
    if (!move || !keep) {
      this.joinPreview = { piece: null, reason: 'Those pieces are no longer in the pattern', gap: 0 };
      return;
    }
    const result = this.runJoin(move, keep);
    this.joinPreview = result.ok
      ? { piece: result.piece, reason: null, gap: result.gap }
      : { piece: null, reason: this.joinRefusal(result), gap: 0 };
  }

  /** The fuse the picks and the settings in hand would make. */
  private runJoin(move: PatternPiece, keep: PatternPiece): JoinResult {
    // A fuse and a bridge both work from a piece's outline: a panel with a hole
    // has one *and* a hole, and handing that over would quietly lose the hole.
    const holed = [move, keep].find((piece) => (piece.holes?.length ?? 0) > 0);
    if (holed) {
      return { ok: false, reason: `A panel with a hole cannot be fused — ${holed.name} has one` };
    }
    return joinPieces(move, this.joinMove, keep, this.joinKeep, {
      fit: this.joinFit,
      tolerance: this.joinTolerance,
    });
  }

  /**
   * Why the fuse was refused, in the units the readouts use. A matched join that
   * missed its tolerance is the one refusal worth putting numbers to, and those
   * numbers are distances like any other.
   */
  private joinRefusal(result: Extract<JoinResult, { ok: false }>): string {
    if (result.gap === undefined) return result.reason;
    const gap = formatLength(result.gap, this.unit, 1);
    const limit = formatLength(this.joinTolerance, this.unit, 1);
    return `The edges would sit ${gap} apart — Move & scale matches within ${limit}. Raise the tolerance, or switch to Warp`;
  }

  /**
   * The edge a join click means. Where two pieces share a boundary their edges
   * are stacked, so the pick cannot just take the nearest: while the fusing side
   * is still waiting for a partner, a click that lands on both means the other
   * piece, and once both sides have something it means the side being worked on
   * — otherwise a run of edges could never be picked along a shared boundary.
   */
  private joinEdgeAt(p: Vec2): {
    piece: PatternPiece;
    fromPointId: string;
    toPointId: string;
  } | null {
    const hits = this.edgesNear(p);
    const best = hits[0];
    if (!best) return null;
    const tied = hits.filter((hit) => hit.dist <= best.dist + 0.05);
    // One edge each has no hand-over step, so a tie after the first pick has to
    // mean the other piece. Edge runs do have one (Confirm edges), and there the
    // tie belongs to the side still being worked on — otherwise a run along a
    // shared boundary could never be picked past its first edge.
    if (this.joinMode !== 'many' && this.joinMove.length > 0 && this.joinKeep.length === 0) {
      const partner = tied.find((hit) => hit.piece.id !== this.joinMove[0].pieceId);
      if (partner) return partner;
    }
    const onPhase = tied.filter((hit) => this.joinSideFor(hit.piece.id) === this.joinPhase);
    const side = onPhase.length > 0 ? onPhase : tied;
    // A piece already picked keeps the pick, so a click can take it back.
    return side.find((hit) => this.joinSideFor(hit.piece.id) !== 'restart') ?? side[0];
  }

  private onJoinDown(p: Vec2): void {
    const hit = this.joinEdgeAt(p);
    if (!hit) return;
    this.toggleJoinPick({
      pieceId: hit.piece.id,
      fromPointId: hit.fromPointId,
      toPointId: hit.toPointId,
      t0: 0,
      t1: 1,
    });
    this.selectedPieceId = hit.piece.id;
    this.syncJoinPreview();
    this.syncJoinBar();
    this.redraw();
  }

  private commitJoin(): void {
    if (this.joinMove.length === 0 || this.joinKeep.length === 0) {
      this.syncJoinBar();
      return;
    }
    const move = this.pattern.pieces.find((p) => p.id === this.joinMove[0].pieceId);
    const keep = this.pattern.pieces.find((p) => p.id === this.joinKeep[0].pieceId);
    if (!move || !keep) return;
    const result = this.runJoin(move, keep);
    if (!result.ok) {
      this.joinPreview = { piece: null, reason: this.joinRefusal(result), gap: 0 };
      this.syncJoinBar();
      this.redraw();
      return;
    }
    const keepIndex = this.pattern.pieces.findIndex((p) => p.id === keep.id);
    const moveIndex = this.pattern.pieces.findIndex((p) => p.id === move.id);
    if (keepIndex < 0 || moveIndex < 0) return;

    this.markBeforeChange();
    // The fused piece takes the second piece's place in the pattern; the first
    // piece is gone, its outline folded into the fused one.
    this.pattern.pieces[keepIndex] = result.piece;
    this.pattern.pieces.splice(moveIndex, 1);
    // Downstream Transform 3D nodes hand the first piece's arrangement on.
    this.pattern.pieceSuccessors = recordPieceSuccessors(
      this.pattern.pieceSuccessors,
      move.id,
      [keep.id]
    );

    // Seams follow the pieces across the fuse. A seam on the moving piece is a
    // seam on the fused piece; a seam whose end point was folded onto a
    // neighbour is read at the point it became. What is left was on one of the
    // two chains, which the fuse did away with.
    const remapSeamEdge = (ref: SeamEdgeRef): SeamEdgeRef | null => {
      let next: SeamEdgeRef = ref.pieceId === move.id ? { ...ref, pieceId: keep.id } : ref;
      const fromPointId = result.idAliases[next.fromPointId];
      const toPointId = result.idAliases[next.toPointId];
      if (fromPointId || toPointId) {
        next = {
          ...next,
          fromPointId: fromPointId ?? next.fromPointId,
          toPointId: toPointId ?? next.toPointId,
        };
      }
      return isSeamEdgeValid(this.pattern.pieces, next) ? next : null;
    };
    const seams: SeamBinding[] = [];
    for (const seam of this.pattern.seams) {
      const a = remapSeamEdge(seam.a);
      const b = remapSeamEdge(seam.b);
      if (!a || !b) continue;
      seams.push(a === seam.a && b === seam.b ? seam : { ...seam, a, b });
    }
    this.pattern.seams = seams;

    this.selectedPieceId = keep.id;
    this.selectEntirePiece(result.piece);
    this.clearJoin();
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /** Ghost of the outline the picks would fuse into, so a fuse is never a surprise. */
  private drawJoinPreview(piece: PatternPiece): void {
    const poly = pieceToPolyline(piece.points, piece.closed, 8);
    if (poly.length < 2) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = `M ${poly[0].x} ${poly[0].y}`;
    for (let i = 1; i < poly.length; i++) d += ` L ${poly[i].x} ${poly[i].y}`;
    path.setAttribute('d', `${d} Z`);
    path.setAttribute('class', 'pattern-join-preview');
    path.setAttribute('fill', 'none');
    path.setAttribute('pointer-events', 'none');
    path.setAttribute('stroke-width', String(this.px(2)));
    this.svg.appendChild(path);
  }


  // ── Bridge ───────────────────────────────────────────────────────────────
  // Closing the gap between two pieces with new edges, the way a modeller spans
  // two boundaries with a strip of faces. Unlike a fuse, nothing moves: both
  // outlines stay where they were drafted, and the two straight edges that
  // close the gap are what the bridged piece gains.

  private setBridgeMode(mode: JoinMode): void {
    if (this.bridgeMode !== mode) this.clearBridge();
    this.bridgeMode = mode;
    this.syncBridgeToolbar();
    this.redraw();
  }

  /** The Modify menu carries the mode, so this just keeps the bar and rail current. */
  private syncBridgeToolbar(): void {
    this.syncBridgeBar();
    this.syncToolRail();
  }

  /** Throw the picks away — Cancel, Escape, undo, or the tool going out of hand. */
  private clearBridge(): void {
    this.bridgeFirst = [];
    this.bridgeSecond = [];
    this.bridgePhase = 'first';
    this.bridgePreview = { piece: null, reason: null };
    this.syncBridgeBar();
  }

  /**
   * Which side a click lands on. With two pieces the piece decides: the first
   * one picked is the side that grows, and the other becomes the run it bridges
   * to. Both runs may also be on one piece — a bay bridged across itself — so
   * there the side being worked on decides instead, and in one-edge-each a
   * second click on the first piece is the far side of its bay.
   */
  private bridgeSideFor(pieceId: string): 'first' | 'second' | 'restart' {
    if (this.bridgeFirst.length === 0) return 'first';
    const firstPiece = this.bridgeFirst[0].pieceId;
    const secondPiece = this.bridgeSecond[0]?.pieceId ?? null;
    if (this.bridgePhase === 'second') {
      return !secondPiece || secondPiece === pieceId ? 'second' : 'restart';
    }
    if (pieceId !== firstPiece) {
      return !secondPiece || secondPiece === pieceId ? 'second' : 'restart';
    }
    // The first piece again: either the run in hand is still being built, or the
    // click is the far side of its own bay.
    if (secondPiece && secondPiece !== pieceId) return 'first';
    if (this.bridgeMode === 'many') return 'first';
    return 'second';
  }

  private toggleBridgePick(edge: SeamEdgeRef): void {
    const onFirst = this.edgeIn(this.bridgeFirst, edge);
    if (onFirst >= 0) {
      this.bridgeFirst.splice(onFirst, 1);
      // A bridge still needs the piece that grows, so the side left over is it.
      if (this.bridgeFirst.length === 0) {
        this.bridgeFirst = this.bridgeSecond;
        this.bridgeSecond = [];
        this.bridgePhase = 'first';
      }
      return;
    }
    const onSecond = this.edgeIn(this.bridgeSecond, edge);
    if (onSecond >= 0) {
      this.bridgeSecond.splice(onSecond, 1);
      return;
    }
    switch (this.bridgeSideFor(edge.pieceId)) {
      case 'first':
        if (this.bridgeMode === 'many') this.bridgeFirst.push(edge);
        else this.bridgeFirst = [edge];
        this.bridgePhase = 'first';
        break;
      case 'second':
        if (this.bridgeMode === 'many') this.bridgeSecond.push(edge);
        else this.bridgeSecond = [edge];
        this.bridgePhase = 'second';
        break;
      default:
        // A third piece: start a new bridge rather than guess which pick to drop.
        this.bridgeFirst = [edge];
        this.bridgeSecond = [];
        this.bridgePhase = 'first';
        break;
    }
  }

  /**
   * Confirm the side in hand and pick the other one, and back again: a run along
   * a shared boundary can only be picked if the side being worked on owns the
   * click, and the button is how the picking changes hands.
   */
  private toggleBridgeSide(): void {
    if (!this.isModify('bridge') || this.bridgeMode !== 'many') return;
    if (this.bridgePhase === 'first') {
      if (this.bridgeFirst.length === 0) return;
      this.bridgePhase = 'second';
    } else {
      this.bridgePhase = 'first';
    }
    this.hoverEdge = null;
    this.syncBridgeBar();
    this.redraw();
  }

  private describeBridgeSide(edges: readonly SeamEdgeRef[]): string {
    if (edges.length === 0) return 'nothing';
    const name = this.pattern.pieces.find((p) => p.id === edges[0].pieceId)?.name ?? '?';
    const count = edges.length === 1 ? '1 edge' : `${edges.length} edges`;
    return `${name} · ${count}`;
  }

  private syncBridgeBar(): void {
    // The settings popover belongs to the same hand as this bar, so the two are
    // kept current together — as they are for the fuse.
    this.syncToolSettings();
    if (!this.bridgeBar) return;
    const active = this.isModify('bridge');
    this.bridgeBar.hidden = !active;
    if (!active) return;
    const instruction = this.bridgeBar.querySelector('[data-bridge-instruction]') as HTMLElement;
    const next = this.bridgeBar.querySelector('[data-bridge-next]') as HTMLButtonElement;
    const commit = this.bridgeBar.querySelector('[data-bridge-commit]') as HTMLButtonElement;
    const cancel = this.bridgeBar.querySelector('[data-bridge-cancel]') as HTMLButtonElement;

    const many = this.bridgeMode === 'many';
    const bothPicked = this.bridgeFirst.length > 0 && this.bridgeSecond.length > 0;
    const onFirstSide = this.bridgePhase === 'first';
    const otherSidePicked = this.bridgeSecond.length > 0;
    next.hidden = !many;
    next.disabled = onFirstSide && this.bridgeFirst.length === 0;
    if (onFirstSide) {
      next.textContent = otherSidePicked ? '→ Second side' : 'Confirm edges →';
      next.title = otherSidePicked
        ? 'Pick the run on the second piece again'
        : 'Confirm the edges picked, then pick the run they bridge to';
    } else {
      next.textContent = '← First side';
      next.title = 'Pick more edges on the first piece — nothing is committed yet';
    }
    commit.disabled = !bothPicked || !this.bridgePreview.piece;
    // Nothing picked is nothing to cancel.
    cancel.disabled = this.bridgeFirst.length === 0 && this.bridgeSecond.length === 0;

    if (!bothPicked) {
      if (this.bridgeFirst.length === 0) {
        instruction.textContent = many
          ? 'Click a run, then Confirm edges for the run it bridges to.'
          : 'Click a run, then the run it bridges to.';
      } else if (this.bridgePhase === 'first' && many) {
        instruction.textContent = `Spans: ${this.describeBridgeSide(this.bridgeFirst)} — more edges, or Confirm edges`;
      } else if (this.bridgePhase === 'first') {
        instruction.textContent = `Spans: ${this.describeBridgeSide(this.bridgeFirst)} — click the run it bridges to`;
      } else {
        instruction.textContent = `Spans ${this.describeBridgeSide(this.bridgeFirst)} — now click the edges it bridges to`;
      }
    } else if (!this.bridgePreview.piece) {
      instruction.textContent = this.bridgePreview.reason ?? 'Those edges cannot be bridged';
    } else if (this.bridgeFirst[0].pieceId === this.bridgeSecond[0].pieceId) {
      const name =
        this.pattern.pieces.find((p) => p.id === this.bridgeFirst[0].pieceId)?.name ?? '?';
      const count = (edges: readonly SeamEdgeRef[]): string =>
        edges.length === 1 ? '1 edge' : `${edges.length} edges`;
      instruction.textContent = `Fills the bay in ${name}: ${count(this.bridgeFirst)} to ${count(this.bridgeSecond)}`;
    } else {
      instruction.textContent = `Bridge ${this.describeBridgeSide(this.bridgeFirst)} to ${this.describeBridgeSide(this.bridgeSecond)}`;
    }
    instruction.title = instruction.textContent;
    instruction.classList.toggle('is-refused', bothPicked && !this.bridgePreview.piece);
  }

  /** Work the bridge out ahead of committing, so the outline can be shown and said. */
  private syncBridgePreview(): void {
    if (this.bridgeFirst.length === 0 || this.bridgeSecond.length === 0) {
      this.bridgePreview = { piece: null, reason: null };
      return;
    }
    const first = this.pattern.pieces.find((p) => p.id === this.bridgeFirst[0].pieceId);
    const second = this.pattern.pieces.find((p) => p.id === this.bridgeSecond[0].pieceId);
    if (!first || !second) {
      this.bridgePreview = { piece: null, reason: 'Those pieces are no longer in the pattern' };
      return;
    }
    const holed = [first, second].find((piece) => (piece.holes?.length ?? 0) > 0);
    if (holed) {
      this.bridgePreview = { piece: null, reason: `A panel with a hole cannot be bridged — ${holed.name} has one` };
      return;
    }
    const holedSecond = [first, second].find((piece) => (piece.holes?.length ?? 0) > 0);
    if (holedSecond) {
      this.bridgePreview = { piece: null, reason: `A panel with a hole cannot be bridged — ${holedSecond.name} has one` };
      return;
    }
    const result = bridgePieces(first, this.bridgeFirst, second, this.bridgeSecond);
    this.bridgePreview = result.ok
      ? { piece: result.piece, reason: null }
      : { piece: null, reason: result.reason };
  }

  /**
   * The edge a bridge click means. Two pieces laid along the same boundary stack
   * their edges, so while a partner is still wanted a click that lands on both
   * means the other piece, and once both sides have something it means the side
   * being worked on — otherwise a run along a shared boundary could not be picked
   * past its first edge.
   */
  private bridgeEdgeAt(p: Vec2): {
    piece: PatternPiece;
    fromPointId: string;
    toPointId: string;
  } | null {
    const hits = this.edgesNear(p);
    const best = hits[0];
    if (!best) return null;
    const tied = hits.filter((hit) => hit.dist <= best.dist + 0.05);
    if (this.bridgeMode !== 'many' && this.bridgeFirst.length > 0 && this.bridgeSecond.length === 0) {
      const partner = tied.find((hit) => hit.piece.id !== this.bridgeFirst[0].pieceId);
      if (partner) return partner;
    }
    const onPhase = tied.filter((hit) => this.bridgeSideFor(hit.piece.id) === this.bridgePhase);
    const side = onPhase.length > 0 ? onPhase : tied;
    // A piece already picked keeps the pick, so a click can take it back.
    return side.find((hit) => this.bridgeSideFor(hit.piece.id) !== 'restart') ?? side[0];
  }

  private onBridgeDown(p: Vec2): void {
    const hit = this.bridgeEdgeAt(p);
    if (!hit) return;
    this.toggleBridgePick({
      pieceId: hit.piece.id,
      fromPointId: hit.fromPointId,
      toPointId: hit.toPointId,
      t0: 0,
      t1: 1,
    });
    this.selectedPieceId = hit.piece.id;
    this.syncBridgePreview();
    this.syncBridgeBar();
    this.redraw();
  }

  private commitBridge(): void {
    if (this.bridgeFirst.length === 0 || this.bridgeSecond.length === 0) {
      this.syncBridgeBar();
      return;
    }
    const first = this.pattern.pieces.find((p) => p.id === this.bridgeFirst[0].pieceId);
    const second = this.pattern.pieces.find((p) => p.id === this.bridgeSecond[0].pieceId);
    if (!first || !second) return;
    const result = bridgePieces(first, this.bridgeFirst, second, this.bridgeSecond);
    if (!result.ok) {
      this.bridgePreview = { piece: null, reason: result.reason };
      this.syncBridgeBar();
      this.redraw();
      return;
    }
    const secondIndex = this.pattern.pieces.findIndex((p) => p.id === second.id);
    const firstIndex = this.pattern.pieces.findIndex((p) => p.id === first.id);
    const foldingIn = result.bridgedPieceId !== null;
    if (secondIndex < 0 || (foldingIn && firstIndex < 0)) return;

    this.markBeforeChange();
    // The bridged piece takes the second piece's place; when the two runs were
    // on separate pieces the first one's outline is part of it now, at the size
    // and place it was drafted at.
    this.pattern.pieces[secondIndex] = result.piece;
    if (foldingIn) {
      this.pattern.pieces.splice(firstIndex, 1);
      // Downstream Transform 3D nodes hand the first piece's arrangement on.
      this.pattern.pieceSuccessors = recordPieceSuccessors(
        this.pattern.pieceSuccessors,
        first.id,
        [second.id]
      );
    }

    // Seams follow the pieces across the bridge: both outlines are still there,
    // point for point. Only the runs are gone — those edges are interior now.
    const remapSeamEdge = (ref: SeamEdgeRef): SeamEdgeRef | null => {
      let next: SeamEdgeRef = ref.pieceId === first.id ? { ...ref, pieceId: second.id } : ref;
      const fromPointId = result.idAliases[next.fromPointId];
      const toPointId = result.idAliases[next.toPointId];
      if (fromPointId || toPointId) {
        next = {
          ...next,
          fromPointId: fromPointId ?? next.fromPointId,
          toPointId: toPointId ?? next.toPointId,
        };
      }
      return isSeamEdgeValid(this.pattern.pieces, next) ? next : null;
    };
    const seams: SeamBinding[] = [];
    for (const seam of this.pattern.seams) {
      const a = remapSeamEdge(seam.a);
      const b = remapSeamEdge(seam.b);
      if (!a || !b) continue;
      seams.push(a === seam.a && b === seam.b ? seam : { ...seam, a, b });
    }
    this.pattern.seams = seams;

    this.selectedPieceId = second.id;
    this.selectEntirePiece(result.piece);
    this.clearBridge();
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /** Ghost of the outline the picks would bridge into, so a bridge is never a surprise. */
  private drawBridgePreview(piece: PatternPiece): void {
    const poly = pieceToPolyline(piece.points, piece.closed, 8);
    if (poly.length < 2) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = `M ${poly[0].x} ${poly[0].y}`;
    for (let i = 1; i < poly.length; i++) d += ` L ${poly[i].x} ${poly[i].y}`;
    path.setAttribute('d', `${d} Z`);
    path.setAttribute('class', 'pattern-bridge-preview');
    path.setAttribute('fill', 'none');
    path.setAttribute('pointer-events', 'none');
    path.setAttribute('stroke-width', String(this.px(2)));
    this.svg.appendChild(path);
  }

  /**
   * Every piece's allowance line, then the edge in hand lit up against it. The
   * line is dashed the way a cutter reads one: the seam line is the piece, this
   * is what is left outside it.
   */
  private drawSeamAllowances(): void {
    // Hicon shows the allowance whether or not the allowance tool is in hand:
    // it is one of the three things that mode draws. The picking that the tool
    // adds stays behind `allowanceOn` — a projection is not a drafting session.
    if (!this.allowanceOn && !this.hiconOn) return;
    for (const piece of this.pattern.pieces) {
      const d = seamAllowanceRings(piece).map((ring) => allowanceRingPath(ring)).join(' ');
      if (!d) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute(
        'class',
        `pattern-allowance${this.blockOwnership.has(piece.id) ? ' is-block' : ''}`
      );
      path.setAttribute('fill', 'none');
      path.setAttribute('pointer-events', 'none');
      path.setAttribute('stroke-width', String(this.px(1.4)));
      path.setAttribute('stroke-dasharray', `${this.px(6)} ${this.px(4)}`);
      path.dataset.pieceId = piece.id;
      this.svg.appendChild(path);
    }

    this.drawAllowanceEdgeMark(this.allowanceHover, 'is-hover');
    this.drawAllowanceEdgeMark(this.allowanceEdge, 'is-picked');
  }

  /** One edge, and the allowance line that belongs to it. */
  private drawAllowanceEdgeMark(
    sel: { pieceId: string; edgeIndex: number } | null,
    state: 'is-hover' | 'is-picked'
  ): void {
    if (!sel) return;
    const piece = this.pattern.pieces.find((entry) => entry.id === sel.pieceId);
    if (!piece) return;
    const edge = pieceEdgeAt(piece, sel.edgeIndex);
    if (!edge) return;
    const from = edge.from;
    const to = edge.to;
    this.drawSeamEdgeStroke(
      { pieceId: piece.id, fromPointId: from.id, toPointId: to.id, t0: 0, t1: 1 },
      `pattern-allowance-edge ${state}`,
      false
    );
    const span = allowanceSpanForEdge(piece, sel.edgeIndex);
    if (span.length < 2) return;
    let d = `M ${span[0].x} ${span[0].y}`;
    for (let i = 1; i < span.length; i++) d += ` L ${span[i].x} ${span[i].y}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', `pattern-allowance-span ${state}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('pointer-events', 'none');
    path.setAttribute('stroke-width', String(this.px(state === 'is-picked' ? 3 : 2.25)));
    this.svg.appendChild(path);
  }

  private drawSeams(): void {
    // The sew tool exists to answer "what is already stitched to what?", so the
    // links between sewn edges come on with it; the view toggle is for every
    // other tool, where they are only worth seeing on request.
    if (this.seamConnectorsOn || this.tool === 'sew') {
      drawMeshSeamConnectors(this.svg, this.pattern, {
        className: 'pattern-seam-connector',
        strokeWidth: this.px(1.2),
      });
    }

    // Hover / pending previews
    if (this.hoverEdge) {
      this.drawSeamEdgeStroke(this.hoverEdge, 'pattern-seam-hover', true);
    }
    if (this.pendingSeam) {
      this.drawSeamEdgeStroke(this.pendingSeam, 'pattern-seam-pending', true);
      // With one edge picked, hovering a partner previews the stitches a click
      // would make, so a crossing (wrong-direction) run is visible before it is
      // committed.
      if (this.hoverEdge && !this.sameEdge(this.pendingSeam, this.hoverEdge)) {
        this.drawStitchPreview(this.pendingSeam, this.hoverEdge);
      }
    }
    for (const edge of this.multiSewSource) {
      this.drawSeamEdgeStroke(edge, 'pattern-seam-pending pattern-seam-multi-source', true);
    }
    for (const edge of this.multiSewTarget) {
      this.drawSeamEdgeStroke(edge, 'pattern-seam-pending pattern-seam-multi-target', true);
    }
    for (const edge of this.joinMove) {
      this.drawSeamEdgeStroke(edge, 'pattern-seam-pending pattern-seam-multi-source', true);
    }
    for (const edge of this.joinKeep) {
      this.drawSeamEdgeStroke(edge, 'pattern-seam-pending pattern-seam-multi-target', true);
    }
    for (const edge of this.bridgeFirst) {
      this.drawSeamEdgeStroke(edge, 'pattern-seam-pending pattern-seam-multi-source', true);
    }
    for (const edge of this.bridgeSecond) {
      this.drawSeamEdgeStroke(edge, 'pattern-seam-pending pattern-seam-multi-target', true);
    }

    for (const seam of this.pattern.seams) {
      const aValid = isSeamEdgeValid(this.pattern.pieces, seam.a);
      const bValid = isSeamEdgeValid(this.pattern.pieces, seam.b);
      const stale = !aValid || !bValid;
      const cls = stale ? 'pattern-seam-edge pattern-seam-stale' : 'pattern-seam-edge';
      if (aValid) this.drawSeamEdgeStroke(seam.a, cls, true);
      if (bValid) this.drawSeamEdgeStroke(seam.b, cls, true);
      if (stale) {
        // Midpoint warning on whichever side we can still resolve
        const ref = aValid ? seam.a : bValid ? seam.b : null;
        if (ref) {
          const piece = this.pattern.pieces.find((x) => x.id === ref.pieceId);
          const samples = piece
            ? sampleEdgeByPointIds(piece, ref.fromPointId, ref.toPointId)
            : null;
          if (samples && samples.length > 0) {
            const mid = samples[Math.floor(samples.length / 2)];
            const mark = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            mark.setAttribute('x', String(mid.x));
            mark.setAttribute('y', String(mid.y - this.px(12)));
            mark.setAttribute('class', 'pattern-seam-warning');
            mark.setAttribute('font-size', String(this.px(14)));
            mark.setAttribute('pointer-events', 'none');
            mark.textContent = '!';
            this.svg.appendChild(mark);
          }
        }
      }
    }
  }

  /**
   * Stitches that sewing `pending` to `hovered` would create, drawn as dashed
   * lines at matched arc-length samples. Where they cross, the direction is
   * wrong — the same read as the pattern editor's own seam connectors.
   */
  private drawStitchPreview(pending: SeamEdgeRef, hovered: HoverEdge): void {
    const pieceA = this.pattern.pieces.find((p) => p.id === pending.pieceId);
    const pieceB = this.pattern.pieces.find((p) => p.id === hovered.pieceId);
    if (!pieceA || !pieceB) return;
    // `pending` carries the pick's direction and `hovered` the half's, so the
    // preview is exactly what committing would sew.
    const pairs = buildSeamConnectorPointPairs(pieceA, pending, pieceB, hovered);
    drawSeamConnectorPairs(this.svg, pairs, {
      className: 'pattern-seam-preview-connector',
      strokeWidth: this.px(1.4),
      opacity: 0.9,
    });
  }

  private drawSeamEdgeStroke(
    ref: HoverEdge | SeamEdgeRef,
    className: string,
    withNotch: boolean
  ): void {
    const piece = this.pattern.pieces.find((x) => x.id === ref.pieceId);
    if (!piece) return;
    let samples: Vec2[] | null = null;
    if ('t0' in ref && 't1' in ref) {
      const span = ref as SeamEdgeRef;
      const isPartial =
        Math.abs(span.t0 - span.t1) > 1e-5 && !(span.t0 === 0 && span.t1 === 1);
      if (isPartial) {
        samples = sampleEdgeSpanByPointIds(
          piece,
          ref.fromPointId,
          ref.toPointId,
          span.t0,
          span.t1,
          20
        );
      }
    }
    samples ??= sampleEdgeByPointIds(piece, ref.fromPointId, ref.toPointId, 20);
    if (!samples || samples.length < 2) return;

    // Direction from t0→t1 when present (SeamEdgeRef); default forward
    const reversed =
      't0' in ref && 't1' in ref && (ref as SeamEdgeRef).t0 > (ref as SeamEdgeRef).t1;
    const pts = reversed ? [...samples].reverse() : samples;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
    path.setAttribute('d', d);
    path.setAttribute('class', className);
    path.setAttribute('fill', 'none');
    path.setAttribute('pointer-events', 'none');
    const isHover = className.includes('hover');
    const isPending = className.includes('pending');
    const isStale = className.includes('stale');
    const sw = isPending ? 3.5 : isHover ? 3.25 : isStale ? 2.25 : 3;
    path.setAttribute('stroke-width', String(this.px(sw)));
    if (isStale) {
      path.setAttribute('stroke-dasharray', `${this.px(6)} ${this.px(4)}`);
    }
    this.svg.appendChild(path);

    if (withNotch) {
      // Directional notch ticks like MD sewing notches (perpendicular, mid-edge)
      const midIdx = Math.floor(pts.length / 2);
      const a = pts[Math.max(0, midIdx - 1)];
      const b = pts[Math.min(pts.length - 1, midIdx + 1)];
      const tx = b.x - a.x;
      const ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1;
      const ux = tx / len;
      const uy = ty / len;
      // Perpendicular (left of direction)
      const nx = -uy;
      const ny = ux;
      const mid = pts[midIdx];
      const notchLen = this.px(10);
      const notchSw = this.px(2);
      const notch = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      notch.setAttribute('x1', String(mid.x));
      notch.setAttribute('y1', String(mid.y));
      notch.setAttribute('x2', String(mid.x + nx * notchLen));
      notch.setAttribute('y2', String(mid.y + ny * notchLen));
      notch.setAttribute('class', 'pattern-seam-notch');
      notch.setAttribute('stroke-width', String(notchSw));
      notch.setAttribute('pointer-events', 'none');
      this.svg.appendChild(notch);

      // Small arrowhead along the edge direction
      const ah = this.px(6);
      const tipPt = {
        x: mid.x + ux * ah,
        y: mid.y + uy * ah,
      };
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      arrow.setAttribute(
        'points',
        `${mid.x - ux * ah * 0.3 + nx * ah * 0.45},${mid.y - uy * ah * 0.3 + ny * ah * 0.45} ${tipPt.x},${tipPt.y} ${mid.x - ux * ah * 0.3 - nx * ah * 0.45},${mid.y - uy * ah * 0.3 - ny * ah * 0.45}`
      );
      arrow.setAttribute('class', 'pattern-seam-notch');
      arrow.setAttribute('fill', 'none');
      arrow.setAttribute('stroke-width', String(notchSw));
      arrow.setAttribute('pointer-events', 'none');
      this.svg.appendChild(arrow);
    }
  }

  /**
   * The pen acts on the piece the click lands on, not on whichever panel happens
   * to be selected: that was how a point aimed at one piece used to land on
   * another (or, when the selected ring was closed, vanish entirely).
   *
   * Alt is the pan gesture and never reaches here — see `onPointerDown`. Points
   * come off with Delete / Backspace, like any other selection.
   */
  private onPenDown(e: PointerEvent, p: Vec2): void {
    // Clicking an existing anchor selects it (don't add a duplicate)
    const nearAnchor = this.findPointNear(p);
    if (nearAnchor) {
      const { piece, point } = nearAnchor;
      // Close open path by clicking first point
      if (!piece.closed && piece.points.length >= 3 && point.id === piece.points[0].id) {
        this.markBeforeChange();
        piece.closed = true;
        this.penStrokeId = null;
        this.selectOnly(point.id, piece.id);
        this.cbs.onChange();
        this.endHistoryGesture();
        this.redraw();
        return;
      }
      this.selectOnly(point.id, piece.id);
      this.redraw();
      return;
    }

    const under = this.pieceAt(e.target, p);

    // Figma: click on a segment → insert a point ON that segment. Any piece's
    // outline will take it, so a panel you never selected is still editable.
    const edge = this.edgeNear(p, [this.penStrokePiece(), under, ...this.pattern.pieces]);
    if (edge) {
      this.insertPenPoint(e, edge.piece, edge.edgeIndex, edge.point);
      return;
    }

    if (under) {
      // An open path has an end to append to; a closed ring does not, so the new
      // point goes onto its outline instead (a point dropped inside the fill has
      // nowhere else to belong).
      if (!under.closed) {
        this.appendPenPoint(e, under, p);
        return;
      }
      const own = findNearestPieceEdge(under, p);
      if (own) this.insertPenPoint(e, under, own.edgeNumber, own.point);
      return;
    }

    // Empty canvas: carry on with the path in hand, or start a new one.
    let piece = this.penStrokePiece();
    if (!piece) {
      this.markBeforeChange();
      piece = {
        id: uid('piece'),
        name: 'Piece',
        closed: false,
        points: [],
      };
      this.pattern.pieces.push(piece);
      this.selectedPieceId = piece.id;
    }
    this.appendPenPoint(e, piece, p);
  }

  /**
   * The open path the pen has in hand: the stroke it is drawing (which survives a
   * detour onto another piece's edge), or else the selected piece while that is
   * still open. Unlike the other tools the pen never falls back to `pieces[0]` —
   * clicking empty canvas should start a panel, not grow a stranger's outline.
   */
  private penStrokePiece(): PatternPiece | null {
    const open = (id: string | null) => {
      const piece = this.pattern.pieces.find((entry) => entry.id === id);
      return piece && !piece.closed ? piece : null;
    };
    return open(this.penStrokeId) ?? open(this.selectedPieceId);
  }

  /**
   * The piece a click landed on: the artwork the event hit, or — for clicks
   * that reach the grid because what was under them is `pointer-events: none`
   * (seams, length labels, rulers) — the topmost fill containing the point.
   */
  private pieceAt(target: EventTarget | null, p: Vec2): PatternPiece | null {
    const el = target instanceof Element ? target.closest('[data-piece-id]') : null;
    const id = el ? (el as SVGElement).dataset.pieceId : undefined;
    if (id) {
      const piece = this.pattern.pieces.find((entry) => entry.id === id);
      if (piece && !this.isGeneratedPiece(piece.id)) return piece;
    }
    for (let i = this.pattern.pieces.length - 1; i >= 0; i--) {
      const piece = this.pattern.pieces[i];
      if (piece.points.length < 3 || this.isGeneratedPiece(piece.id)) continue;
      if (pointInPiece(p, piece)) return piece;
    }
    return null;
  }

  /**
   * True for a piece drafted by a block. Its geometry is regenerated from the
   * block's variables, so a hand-added point would not survive — the whole tool
   * layer leaves these pieces to their block (see the intercept in
   * `onPointerDown`).
   */
  private isGeneratedPiece(pieceId: string): boolean {
    return this.blockOwnership.has(pieceId);
  }

  /**
   * The segment a pen click splits, searched across every piece. Nearest wins;
   * ties go to the path being drawn (so drafting a panel along a neighbour's
   * outline keeps extending your own), then to the piece actually clicked.
   */
  private edgeNear(
    p: Vec2,
    candidates: Array<PatternPiece | null>
  ): { piece: PatternPiece; edgeIndex: number; point: Vec2 } | null {
    const threshold = this.hitRadius() * 2.5;
    const order: PatternPiece[] = [];
    for (const piece of candidates) {
      if (piece && !order.includes(piece)) order.push(piece);
    }
    let best: { piece: PatternPiece; edgeIndex: number; point: Vec2; dist: number } | null = null;
    for (const piece of order) {
      if (piece.points.length < 2 || this.isGeneratedPiece(piece.id)) continue;
      const hit = findNearestPieceEdge(piece, p);
      if (!hit || hit.dist > threshold) continue;
      if (!best || hit.dist < best.dist) {
        best = { piece, edgeIndex: hit.edgeNumber, point: hit.point, dist: hit.dist };
      }
    }
    if (!best) return null;
    return { piece: best.piece, edgeIndex: best.edgeIndex, point: best.point };
  }

  /**
   * Split `piece`'s edge with a new anchor at `at`, as one undo step. Refused
   * (null) when the spot sits almost on top of an existing endpoint, where a
   * second point would only read as noise.
   */
  private insertEdgePoint(piece: PatternPiece, edgeIndex: number, at: Vec2): BezierPoint | null {
    const edge = pieceEdgeAt(piece, edgeIndex);
    if (!edge) return null;
    const { ring, edgeIndex: local } = edge;
    const a = edge.from;
    const b = edge.to;
    if (dist(at, a.anchor) < this.hitRadius() || dist(at, b.anchor) < this.hitRadius()) return null;
    const pt: BezierPoint = {
      id: uid('pt'),
      anchor: { x: at.x, y: at.y },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    };
    this.markBeforeChange();
    // Split the edge: the handles that spanned it no longer apply.
    a.handleOut = null;
    b.handleIn = null;
    ring.splice(local + 1, 0, pt);
    return pt;
  }

  /** The pen's version of the edge insert: the new point is dragged into a curve. */
  private insertPenPoint(
    e: PointerEvent,
    piece: PatternPiece,
    edgeIndex: number,
    at: Vec2
  ): void {
    const pt = this.insertEdgePoint(piece, edgeIndex, at);
    if (!pt) return;
    this.selectOnly(pt.id, piece.id);
    this.drag = { type: 'penCurve', pieceId: piece.id, pointId: pt.id };
    this.svg.setPointerCapture(e.pointerId);
    this.cbs.onChange();
    this.redraw();
  }

  /** Add an anchor to the end of an open path — the "keep clicking to draw" step. */
  private appendPenPoint(e: PointerEvent, piece: PatternPiece, at: Vec2): void {
    const pt: BezierPoint = {
      id: uid('pt'),
      anchor: { x: at.x, y: at.y },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    };
    this.markBeforeChange();
    piece.points.push(pt);
    piece.closed = false;
    this.penStrokeId = piece.id;
    this.selectOnly(pt.id, piece.id);
    this.drag = { type: 'penCurve', pieceId: piece.id, pointId: pt.id };
    this.svg.setPointerCapture(e.pointerId);
    this.cbs.onChange();
    this.redraw();
  }

  private createDefaultHandles(piece: PatternPiece, pt: BezierPoint): void {
    const ring = pieceRingForPoint(piece, pt.id);
    if (!ring) return;
    const idx = ring.findIndex((p) => p.id === pt.id);
    if (idx < 0) return;
    const n = ring.length;
    const prev = ring[(idx - 1 + n) % n];
    const next = ring[(idx + 1) % n];
    const toPrev = { x: prev.anchor.x - pt.anchor.x, y: prev.anchor.y - pt.anchor.y };
    const toNext = { x: next.anchor.x - pt.anchor.x, y: next.anchor.y - pt.anchor.y };
    const lenPrev = Math.hypot(toPrev.x, toPrev.y) || 1;
    const lenNext = Math.hypot(toNext.x, toNext.y) || 1;
    const scale = 0.33;
    pt.handleIn = {
      x: pt.anchor.x + (toPrev.x / lenPrev) * lenPrev * scale,
      y: pt.anchor.y + (toPrev.y / lenPrev) * lenPrev * scale,
    };
    pt.handleOut = {
      x: pt.anchor.x + (toNext.x / lenNext) * lenNext * scale,
      y: pt.anchor.y + (toNext.y / lenNext) * lenNext * scale,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    // Hovering a readout lights everything it reads, under either of the tools
    // that can take hold of one.
    if (!this.drag && this.measureInteractive()) {
      const hit = this.findMeasureHit(this.svgPoint(e));
      this.setMeasureHover(hit ? hit.id : null);
    }

    // Sew tool: hover highlight edges even when not dragging
    if ((this.tool === 'sew' || this.isModify('join') || this.isModify('bridge')) && !this.drag) {
      const p = this.svgPoint(e);
      const hit = this.findNearestEdgeAcrossPieces(p);
      const next: HoverEdge | null = hit
        ? this.tool !== 'sew'
          ? {
              pieceId: hit.piece.id,
              fromPointId: hit.fromPointId,
              toPointId: hit.toPointId,
              t0: 0,
              t1: 1,
            }
          : this.refForHalf(hit.piece.id, hit.fromPointId, hit.toPointId, hit.t)
        : null;
      // Crossing the midpoint changes the direction the stroke previews, so it
      // has to redraw even though the edge itself is unchanged.
      const changed =
        (!!next !== !!this.hoverEdge) ||
        (next &&
          this.hoverEdge &&
          (!this.sameEdge(next, this.hoverEdge) ||
            seamReadsFromSecondHalf(next) !== seamReadsFromSecondHalf(this.hoverEdge)));
      if (changed) {
        this.hoverEdge = next;
        this.redraw();
      }
      return;
    }

    // Inset: the loop the pointer is asking for is worked out from how far in
    // from an edge it is, so every move redraws it.
    if (this.tool === 'cut' && this.cutMode === 'inset' && !this.drag) {
      const next = this.insetAtPointer(this.svgPoint(e), e.shiftKey);
      const changed =
        !!next !== !!this.cutInset ||
        (!!next &&
          !!this.cutInset &&
          (next.pieceId !== this.cutInset!.pieceId ||
            Math.abs(next.scale - this.cutInset!.scale) > 1e-4));
      if (changed) {
        this.cutInset = next;
        this.redraw();
      }
      return;
    }

    // Loop cut: the cut is worked out from where the pointer is on the
    // outline, so every move redraws it.
    if (this.isLoopCut() && !this.drag) {
      const next = this.loopCutAtPointer(this.svgPoint(e));
      const changed =
        !!next !== !!this.cutLoop ||
        (!!next &&
          !!this.cutLoop &&
          (next.edgeIndex !== this.cutLoop.edgeIndex ||
            next.pieceId !== this.cutLoop.pieceId ||
            Math.abs(next.t - this.cutLoop.t) > 1e-4));
      if (changed) {
        this.cutLoop = next;
        this.redraw();
      }
      return;
    }

    // Curve cut: the rubber band follows the pointer, so the next click's
    // segment can be aimed.
    if (this.tool === 'cut' && this.cutMode === 'curve' && !this.drag) {
      const p = this.svgPoint(e);
      const last = this.cutChainHover;
      if (!last || dist(last, p) > 1e-4) {
        this.cutChainHover = this.cutChain.length > 0 ? p : null;
        this.redraw();
      }
      return;
    }

    // Extrude tool: light up the edge a click would duplicate, so it is clear
    // which outline is about to grow a tab.
    if (this.isModify('extrude') && !this.drag) {
      const next = this.extrudeEdgeAt(this.svgPoint(e));
      const changed =
        !!next !== !!this.extrudeHover ||
        (!!next &&
          !!this.extrudeHover &&
          (next.pieceId !== this.extrudeHover.pieceId ||
            next.fromPointId !== this.extrudeHover.fromPointId ||
            next.toPointId !== this.extrudeHover.toPointId));
      if (changed) {
        this.extrudeHover = next;
        this.redraw();
      }
      return;
    }

    // Seam allowance: while it is shown, the move tool lights the edge a click
    // would give its own allowance to.
    if (this.tool === 'move' && this.allowanceOn && !this.drag) {
      const hit = this.edgesNear(this.svgPoint(e))[0] ?? null;
      const next = hit ? { pieceId: hit.piece.id, edgeIndex: hit.edgeIndex } : null;
      const changed =
        !!next !== !!this.allowanceHover ||
        (!!next &&
          !!this.allowanceHover &&
          (next.pieceId !== this.allowanceHover.pieceId ||
            next.edgeIndex !== this.allowanceHover.edgeIndex));
      if (changed) {
        this.allowanceHover = next;
        this.redraw();
      }
    }

    // Hover feedback for rulers, and for the rotate zones beside a selection's
    // corner grips (ruler + move tools only).
    if (!this.drag && (this.isRuler('ruler') || this.tool === 'move')) {
      const point = this.svgPoint(e);
      const hit = this.findRulerHit(point);
      const next = hit?.id ?? null;
      let redraw = false;
      if (next !== this.hoverRulerId) {
        this.hoverRulerId = next;
        redraw = true;
      }

      // The rotate zone sits beside the corner rather than on it, so it has no
      // element of its own to hover: it is measured from the pointer, and only
      // where nothing else already owns the pixel — a point, a grip, or the box
      // itself.
      const free = this.tool === 'move' && !(e.target as SVGElement).dataset?.kind;
      const box = free && this.selectedIds.size >= 2 ? this.selectionScaleBox() : null;
      const zone = box ? this.rotateCornerAt(point, box) : null;
      if (zone !== this.hoverRotate) {
        this.hoverRotate = zone;
        redraw = true;
      }
      if (redraw) this.redraw();
      this.applyCursor(hit ? 'ruler' : zone ? 'rotate' : null);
    }

    if (!this.drag) return;
    const p = this.svgPoint(e);

    if (this.drag.type === 'pan') {
      const scale = this.screenToPatternScale();
      this.viewBox.x = this.drag.startView.x - (e.clientX - this.drag.startClient.x) / scale;
      this.viewBox.y = this.drag.startView.y - (e.clientY - this.drag.startClient.y) / scale;
      this.redraw();
      return;
    }

    if (this.drag.type === 'blockMove') {
      const d = this.drag;
      const instance = this.blocks().find((b) => b.id === d.id);
      if (!instance) return;
      // Armed here, on the first movement, rather than on pointerdown: a click
      // that never moves is a selection, and it should not cost an undo step.
      this.markBeforeChange();
      instance.origin = {
        x: d.origin.x + (p.x - d.start.x),
        y: d.origin.y + (p.y - d.start.y),
      };
      const definition = this.blockDefinition(instance);
      if (definition) {
        const generated = generateBlockPieces(
          definition,
          instance,
          this.measurementSet(instance.personId)
        );
        const { pieces, ownership } = spliceBlockPieces(
          this.pattern.pieces,
          instance,
          generated
        );
        this.pattern.pieces = pieces;
        instance.pieces = ownership;
      }
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'measureLine') {
      this.drag.current = p;
      this.redraw();
      return;
    }

    if (this.drag.type === 'measureMove') {
      const d = this.drag;
      const measure = this.findMeasure(d.id);
      if (!measure) return;
      measure.label = {
        x: d.origin.x + (p.x - d.start.x),
        y: d.origin.y + (p.y - d.start.y),
      };
      this.redraw();
      this.notifyReferenceChange();
      return;
    }

    if (this.drag.type === 'rulerCreate') {
      this.drag.current = p;
      this.drag.snap = e.shiftKey;
      this.redraw();
      return;
    }

    if (this.drag.type === 'rulerMove') {
      const d = this.drag;
      const ruler = this.rulers().find((r) => r.id === d.id);
      if (!ruler) return;
      ruler.center = { x: d.origin.x + (p.x - d.start.x), y: d.origin.y + (p.y - d.start.y) };
      this.redraw();
      this.notifyReferenceChange();
      return;
    }

    if (this.drag.type === 'moveText') {
      const d = this.drag;
      const note = this.findText(d.id);
      if (!note) return;
      note.x = d.origin.x + (p.x - d.start.x);
      note.y = d.origin.y + (p.y - d.start.y);
      this.redraw();
      this.notifyReferenceChange();
      return;
    }

    if (this.drag.type === 'resizeText') {
      const d = this.drag;
      const note = this.findText(d.id);
      if (!note) return;
      note.widthCm = Math.max(PATTERN_TEXT_MIN_CM, d.width + (p.x - d.start.x));
      note.heightCm = Math.max(PATTERN_TEXT_MIN_CM, d.height + (p.y - d.start.y));
      // Dragged out by hand, the box has a width of its own from now on.
      note.autoWidth = false;
      this.redraw();
      this.notifyReferenceChange();
      return;
    }

    if (this.drag.type === 'moveImage') {
      const d = this.drag;
      const image = this.findImage(d.id);
      if (!image) return;
      image.x = d.origin.x + (p.x - d.start.x);
      image.y = d.origin.y + (p.y - d.start.y);
      this.redraw();
      this.notifyReferenceChange();
      return;
    }

    if (this.drag.type === 'resizeImage') {
      const d = this.drag;
      const image = this.findImage(d.id);
      if (!image) return;
      const size = patternImageSize(image, {
        width: d.width + (p.x - d.start.x),
        height: d.height + (p.y - d.start.y),
        aspect: d.aspect,
        lockAspect: e.shiftKey,
      });
      image.widthCm = Math.max(PATTERN_IMAGE_MIN_CM, size.widthCm);
      image.heightCm = Math.max(PATTERN_IMAGE_MIN_CM, size.heightCm);
      this.redraw();
      this.notifyReferenceChange();
      return;
    }

    if (this.drag.type === 'rulerTurn') {
      const d = this.drag;
      const ruler = this.rulers().find((r) => r.id === d.id);
      if (!ruler) return;
      const dx = p.x - ruler.center.x;
      const dy = p.y - ruler.center.y;
      // Dragging tip A aims the ruler's +x axis back through the centre, so the
      // tip stays under the cursor instead of jumping to the far end.
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI + (d.which === 'a' ? 180 : 0);
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      ruler.angle = deg;
      // Freed of a measurement, the ruler can also be sized by its tip.
      if (ruler.measurementId === null) {
        setRulerDrawnLength(ruler, Math.max(1, Math.hypot(dx, dy) * 2));
      }
      this.redraw();
      this.notifyReferenceChange();
      return;
    }

    if (this.drag.type === 'marquee') {
      this.drag.current = p;
      // Shift and Cmd can be pressed or let go mid-drag; the rectangle follows
      // them, Cmd winning when both are held.
      this.drag.panels = e.metaKey || e.ctrlKey;
      this.drag.additive = !this.drag.panels && e.shiftKey;
      this.reportMarquee(this.drag);
      this.redraw();
      return;
    }

    if (this.drag.type === 'drawShape') {
      this.drag.current = p;
      this.drag.lockAspect = e.shiftKey;
      this.redraw();
      return;
    }

    if (this.drag.type === 'objectBox') {
      this.drag.current = p;
      this.redraw();
      return;
    }

    if (this.drag.type === 'extrudeEdge') {
      const lock = axisLockFromDelta(p.x - this.drag.start.x, p.y - this.drag.start.y, e.shiftKey);
      this.drag.current = {
        x: lock === 'y' ? this.drag.start.x : p.x,
        y: lock === 'x' ? this.drag.start.y : p.y,
      };
      this.redraw();
      return;
    }

    if (this.drag.type === 'cutLine') {
      // The far end snaps to a point or edge too, so a cut can be run from one
      // corner to another. Shift is an instruction about the angle rather than
      // the place, so it keeps the end where the pointer is and the preview
      // shows the locked line instead.
      this.drag.current = e.shiftKey ? p : this.snapCutPoint(p);
      this.drag.shift = e.shiftKey;
      this.redraw();
      return;
    }

    if (this.drag.type === 'cutCircle') {
      // The drag is the radius, measured from the press, and never moves the
      // centre — so the circle grows under the pointer instead of following it.
      // Shift quantises the radius (see cutterFromDrag).
      this.drag.radius = dist(this.drag.center, p);
      this.drag.shift = e.shiftKey;
      this.redraw();
      return;
    }

    if (this.drag.type === 'orbit') {
      const d = this.drag;
      // Undo is armed on the first movement, not the press: taking hold of the
      // point and letting go again is a pick, not an edit.
      if (!d.moved) {
        this.markBeforeChange();
        d.moved = true;
      }
      const reach = Math.hypot(p.x - d.center.x, p.y - d.center.y);
      if (e.shiftKey) {
        // Shift grips the tether rather than the point: the angle it is held at
        // stays, and the radius follows the pointer in or out.
        d.radius = Math.max(MIN_ORBIT_RADIUS_CM, reach);
      } else {
        d.angle = Math.atan2(p.y - d.center.y, p.x - d.center.x) - d.baseAngle;
      }
      this.applyOrbitTransform(d);
      if (this.orbit) this.orbit.radius = d.radius;
      this.syncToolSettings();
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'moveSelection') {
      const d = this.drag;
      const rawDx = p.x - d.start.x;
      const rawDy = p.y - d.start.y;
      // Armed here, on the first movement, rather than on pointerdown: picking a
      // piece up and letting go without dragging it is a selection, and it
      // should not leave an empty step on the undo stack.
      if (rawDx !== 0 || rawDy !== 0) {
        this.markBeforeChange();
        d.moved = true;
      }
      // Shift locks the drag to the axis it is already moving along, so a point
      // can be moved purely horizontally or vertically.
      const constrainAxis = axisLockFromDelta(rawDx, rawDy, e.shiftKey);
      // Figma: Ctrl temporarily disables Snap to geometry
      const snapOn = this.softSnap && !e.ctrlKey;
      const { dx, dy, guides } = this.softSnapTranslate(
        d.snapshots,
        rawDx,
        rawDy,
        snapOn,
        constrainAxis
      );
      this.snapGuides = guides;
      this.applySnapshotsTranslated(d.snapshots, dx, dy);
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'scaleSelection') {
      const d = this.drag;
      // Alt scales about the centre of the selection — symmetric growth —
      // instead of about the opposite corner / edge.
      const fromCenter = e.altKey;
      const pivot = fromCenter ? d.center : d.fixed;
      const size = fromCenter ? d.centerSize : d.startSize;
      let sx = size.x === 0 ? 1 : (p.x - pivot.x) / size.x;
      let sy = size.y === 0 ? 1 : (p.y - pivot.y) / size.y;
      if (d.axis === 'x') sy = 1;
      else if (d.axis === 'y') sx = 1;
      else if (e.shiftKey) {
        // Proportional: lock aspect — use the dominant axis scale for both.
        const s = Math.abs(sx) >= Math.abs(sy) ? sx : sy;
        sx = s;
        sy = s;
      }
      this.applySnapshotsScaled(d.snapshots, pivot, sx, sy);
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'rotateSelection') {
      const d = this.drag;
      let delta = angleAbout(p, d.center) - d.startAngle;
      // Shift snaps the *amount turned*, so a piece can be rotated in exact
      // steps (15° here, the same step the ruler's own turn gesture uses).
      if (e.shiftKey) delta = snapAngle(delta, Math.PI / 12);
      this.applySnapshotsRotated(d.snapshots, d.center, delta);
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'handle') {
      const d = this.drag;
      const piece = this.pattern.pieces.find((x) => x.id === d.pieceId)!;
      const pt = piecePointById(piece, d.pointId)!;
      if (d.which === 'out') {
        pt.handleOut = { ...p };
        if (d.mirror) {
          pt.handleIn = {
            x: pt.anchor.x - (p.x - pt.anchor.x),
            y: pt.anchor.y - (p.y - pt.anchor.y),
          };
        }
      } else {
        pt.handleIn = { ...p };
        if (d.mirror) {
          pt.handleOut = {
            x: pt.anchor.x - (p.x - pt.anchor.x),
            y: pt.anchor.y - (p.y - pt.anchor.y),
          };
        }
      }
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'penCurve') {
      const d = this.drag;
      const piece = this.pattern.pieces.find((x) => x.id === d.pieceId)!;
      const pt = piecePointById(piece, d.pointId)!;
      const dx = p.x - pt.anchor.x;
      const dy = p.y - pt.anchor.y;
      if (Math.hypot(dx, dy) > 0.3) {
        // Initial pen drag seeds opposite handles; they stay independently editable unless Parallel is on.
        pt.handleOut = { x: pt.anchor.x + dx, y: pt.anchor.y + dy };
        pt.handleIn = { x: pt.anchor.x - dx, y: pt.anchor.y - dy };
        pt.handlesParallel = false;
        this.redraw();
        this.cbs.onChange();
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag) {
      this.endHistoryGesture();
      return;
    }
    const finished = this.drag;
    try {
      this.svg.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.drag = null;
    this.snapGuides = [];
    // Keep history armed through finish handlers; clear at end of up.
    if (finished.type === 'marquee') {
      this.reportMarquee(null);
      const moved = dist(finished.start, finished.current);
      if (moved < this.hitRadius() * 0.35) {
        // Drawn no further than a click. Cmd/Ctrl on a piece means that one
        // piece joins or leaves the selection; Shift means points, and on bare
        // canvas alone keeps the selection as it stands.
        const toggled = finished.togglePieceId
          ? this.pattern.pieces.find((entry) => entry.id === finished.togglePieceId)
          : null;
        if (toggled) this.toggleEntirePiece(toggled);
        else if (!finished.additive) this.clearSelection();
      } else if (finished.panels) {
        this.addPiecesInRect(finished.start, finished.current);
        // The same rectangle picks up the frames it crossed: on the canvas these
        // are the containers, and a marquee over the page should take both.
        this.cbs.onPanelMarquee?.({
          x: Math.min(finished.start.x, finished.current.x),
          y: Math.min(finished.start.y, finished.current.y),
          w: Math.abs(finished.current.x - finished.start.x),
          h: Math.abs(finished.current.y - finished.start.y),
        });
      } else if (finished.additive) {
        const hit = this.pointsInRect(finished.start, finished.current);
        const merged = new Set(this.selectedIds);
        for (const id of hit) merged.add(id);
        this.setSelection([...merged]);
      } else {
        this.setSelection(this.pointsInRect(finished.start, finished.current));
      }
      this.endHistoryGesture();
      this.redraw();
      return;
    }

    if (finished.type === 'objectBox') {
      this.finishObjectBox(finished);
      this.redraw();
      return;
    }

    if (finished.type === 'drawShape') {
      this.finishDrawShape(finished);
      this.redraw();
      return;
    }

    if (finished.type === 'extrudeEdge') {
      this.finishExtrudeEdge(finished);
      this.redraw();
      return;
    }

    if (finished.type === 'moveText' || finished.type === 'resizeText') {
      // The drag has been writing to the note all along; letting go only closes
      // the undo step.
      this.endHistoryGesture();
      this.redraw();
      return;
    }

    if (finished.type === 'moveImage' || finished.type === 'resizeImage') {
      // The same for an image: the drag wrote to it, letting go closes the step.
      this.endHistoryGesture();
      this.redraw();
      return;
    }

    if (finished.type === 'rulerCreate') {
      this.commitRulerCreate(finished);
      this.endHistoryGesture();
      this.redraw();
      return;
    }

    if (finished.type === 'measureLine') {
      this.commitMeasureLine(finished);
      this.endHistoryGesture();
      this.redraw();
      return;
    }

    if (finished.type === 'cutLine' || finished.type === 'cutCircle') {
      const cutter = this.cutterFromDrag(finished);
      if (cutter) this.commitDragCut(cutter);
      this.syncCutBar();
      this.redraw();
      return;
    }

    if (finished.type === 'orbit') {
      // The tether stays armed at the length the drag left it: the next drag
      // swings at that radius until it is pulled again.
      if (this.orbit) this.orbit.radius = finished.radius;
      this.syncToolSettings();
      this.endHistoryGesture();
      this.redraw();
      return;
    }

    if (finished.type === 'moveSelection' && finished.moved) {
      this.reportDroppedPieces(e.clientX, e.clientY);
    }

    this.endHistoryGesture();
    this.redraw();
  }

  /**
   * Tell the host where a finished drag put what it was carrying, so whole
   * panels can be handed over to the container they were dropped in, or back to
   * the canvas they were dragged out of.
   *
   * Only whole pieces are offered — a drag that moved part of a panel (a point,
   * a curve handle) edits that panel and leaves it where it is.
   */
  private reportDroppedPieces(clientX: number, clientY: number): void {
    if (!this.cbs.onPiecesDropped) return;
    const pieceIds = this.whollySelectedPieces();
    if (pieceIds.length === 0) return;
    this.cbs.onPiecesDropped({ clientX, clientY, pieceIds });
  }

  /** The pieces picked in full — empty when a pick is only part of a piece. */
  private whollySelectedPieces(): string[] {
    const ids: string[] = [];
    for (const piece of this.pattern.pieces) {
      const points = pieceRings(piece).flat();
      if (!points.some((pt) => this.selectedIds.has(pt.id))) continue;
      if (points.some((pt) => !this.selectedIds.has(pt.id))) return [];
      ids.push(piece.id);
    }
    return ids;
  }

  private onCutDown(e: PointerEvent, p: Vec2): void {
    if (this.isLoopCut()) {
      // Hover already decided the cut; a click commits it. An invalid cut (one
      // that would leave the piece, or a sliver) simply does not commit.
      const hover = this.cutLoop ?? this.loopCutAtPointer(p);
      if (hover?.cut.valid) {
        const cut = loopCutCutter(hover.cut);
        const piece =
          this.pattern.pieces.find((entry) => entry.id === hover.pieceId) ??
          this.pieceForCut(cut);
        this.commitCut(cut, false, piece);
      }
      this.cutLoop = null;
      this.redraw();
      return;
    }

    if (this.cutMode === 'inset') {
      // The hover has already decided the loop: a click cuts it out.
      const hover = this.cutInset ?? this.insetAtPointer(p, e.shiftKey);
      const piece = hover ? this.pattern.pieces.find((entry) => entry.id === hover.pieceId) : null;
      if (hover && piece) {
        this.cutNotice = this.commitLoopCut(piece, hover.loop, 'inset');
      } else {
        this.cutNotice = 'Hover inside a panel to size the loop';
      }
      this.cutInset = null;
      this.syncCutBar();
      this.redraw();
      return;
    }

    if (this.cutMode === 'linear') {
      this.drag = {
        type: 'cutLine',
        // The cut starts where the press landed, snapped to a point or edge the
        // way every other cut click is: a cut aimed at a corner starts *on*
        // the corner rather than a few pixels from it.
        start: this.snapCutPoint(p),
        current: this.snapCutPoint(p),
        shift: e.shiftKey,
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }

    if (this.cutMode === 'circle') {
      // Press sets the centre and the drag sets the radius: the circle is not
      // dragged around by its rim, so it lands centred on the spot it was aimed
      // at however far it is dragged out.
      this.drag = {
        type: 'cutCircle',
        center: p,
        radius: 0,
        shift: e.shiftKey,
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }

    // Curve: click points down, like the pen. The chain is the cut; the bar
    // commits or cancels it.
    this.cutChain.push(this.snapCutPoint(p));
    this.cutChainHover = null;
    this.cutChainRefusal = null;
    this.syncCutBar();
    this.redraw();
  }

  addPointOnEdge(): void {
    const piece = this.activePiece();
    if (!piece || piece.points.length < 2) return;
    this.markBeforeChange();
    const n = piece.points.length;
    const a = piece.points[n - 1].anchor;
    const b = piece.points[0].anchor;
    piece.points.push({
      id: uid('pt'),
      anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    });
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }
}
