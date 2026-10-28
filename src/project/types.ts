/** hyperPattern project document model (canonical cm). */

export type UnitDisplay = 'cm' | 'in';

/**
 * The unit a project opens in.
 *
 * Storage is always canonical centimetres — this only decides how numbers are
 * *shown*, and every project records its own choice, so changing this affects
 * new projects only and never rewrites an existing one.
 */
export const DEFAULT_DISPLAY_UNIT: UnitDisplay = 'in';

export type Vec2 = { x: number; y: number };

/** Cubic bezier segment in pattern space (cm). */
export type BezierPoint = {
  id: string;
  anchor: Vec2;
  handleIn: Vec2 | null;
  handleOut: Vec2 | null;
  /**
   * When true, dragging one handle mirrors the other (smooth/parallel).
   * Default false — handles edit independently.
   */
  handlesParallel?: boolean;
};

/**
 * Seam allowance: the fabric left outside the seam line. `defaultCm` covers every
 * edge that has no entry of its own in `edges`, which is keyed by the id of the
 * point an edge starts at (it runs to the next point in winding order).
 * Absent altogether means the standard allowance (half an inch) — see
 * `src/pattern/seamAllowance.ts`.
 */
export type SeamAllowance = {
  defaultCm: number;
  edges?: Record<string, number>;
};

export type PatternPiece = {
  id: string;
  name: string;
  closed: boolean;
  points: BezierPoint[];
  /**
   * Inner contours cut out of the piece — one ring of points each. The cloth is
   * what lies inside `points` and *outside* every one of these, so a hole is a
   * hole whichever way round its ring happens to be wound. Holes are named apart
   * from the outline only in this one place: anywhere a point or an edge is
   * referred to — a seam, a seam allowance override, a measurement — it is named
   * by its point IDs, which are unique across the whole piece, so nothing else
   * has to know which ring it lives on.
   */
  holes?: BezierPoint[][];
  grainline?: { from: Vec2; to: Vec2 };
  seamAllowance?: SeamAllowance;
};

/**
 * Reference to a pattern edge by durable point IDs (survives inserts elsewhere
 * on the piece). Edge runs fromPointId → toPointId in piece winding order.
 * t0>t1 encodes a reversed sewing direction (like MD sewing notches).
 */
export type SeamEdgeRef = {
  pieceId: string;
  fromPointId: string;
  toPointId: string;
  /** Start fraction along the edge (0..1). */
  t0: number;
  /** End fraction along the edge (0..1). */
  t1: number;
};

export type SeamBinding = {
  id: string;
  a: SeamEdgeRef;
  b: SeamEdgeRef;
  restGapCm: number;
};

/** Tag linking a mesh boundary vertex back to a pattern edge. */
export type SeamVertexTag = {
  pieceId: string;
  fromPointId: string;
  toPointId: string;
  /** Parametric position along the edge (0..1). */
  t: number;
};

/**
 * A linear reference line laid over a pattern — a physical ruler you can park
 * next to the piece while drafting.
 *
 * It measures a *person*, not the pattern: `measurementId` points at one of the
 * body measurements from `MEASUREMENT_FIELDS` and the drawn length tracks that
 * person's live value. `lengthCm` is the last known value, kept so the ruler
 * still draws when the library (or that person) is not available.
 */
export type PatternRuler = {
  id: string;
  /** Centre of the ruler in pattern space (cm). */
  center: Vec2;
  /** Rotation in degrees; 0 lies along +x (reads left to right). */
  angle: number;
  /** Length of the *full* measurement in cm (ignored when `measurementId` is null). */
  lengthCm: number;
  /** Body-measurement field id, or null for a free-standing ruler. */
  measurementId: string | null;
  /** Measurement set ("person") this references, or null. */
  personId: string | null;
  /** Person name snapshot, so the label survives a renamed / missing set. */
  personName: string;
  /** Draw at half the measurement — the usual fold / half-scale drafting length. */
  half: boolean;
};

/**
 * A point a measurement reads from.
 *
 * Neither kind is a control point of the piece, so measuring never changes what
 * is being measured. An `edge` anchor is a *measure point*: the software drops
 * it where a measure line crossed an edge, and it stores only a fraction along
 * that edge — so a point halfway along an edge stays halfway when the outline is
 * dragged, bent or resized, and deleting the measurement leaves the piece
 * untouched.
 */
export type MeasureAnchor =
  | { kind: 'point'; pieceId: string; pointId: string }
  | {
      kind: 'edge';
      pieceId: string;
      /** The edge it sits on, keyed the way every per-edge record in a document is. */
      fromPointId: string;
      toPointId: string;
      /** Where along that edge, 0..1 of the edge's own parametrisation. */
      t: number;
    };

/**
 * One thing a measurement reads: a whole edge (its arc length), or the straight
 * gap between two anchors. A measurement's value is the sum of its items.
 */
export type MeasureItem =
  | { kind: 'edge'; pieceId: string; fromPointId: string; toPointId: string }
  | { kind: 'span'; a: MeasureAnchor; b: MeasureAnchor };

/**
 * A measurement laid over the pattern, in a ruler-like drawing.
 *
 * It is the counterpart to a `PatternRuler`: a ruler is a physical rule whose
 * length is a *person's* number, while a measurement reads the pattern itself
 * and follows it live. Like a ruler it is a drafting reference, so editing one
 * never leaves a mesh stale.
 */
export type PatternMeasure = {
  id: string;
  /** Where the readout sits in pattern space — dragged wherever you want it. */
  label: Vec2;
  items: MeasureItem[];
  /**
   * How many measurements this one totals, when it was made by summing others.
   * Its `items` are copies of theirs, so it reads the same geometry live; the
   * count is kept so the readout can say what it is.
   */
  sumOf?: number;
};

export type PatternDocument = {
  id: string;
  name: string;
  pieces: PatternPiece[];
  seams: SeamBinding[];
  /** Drafting reference rulers (see `PatternRuler`). */
  rulers?: PatternRuler[];
  /**
   * Measurements taken off the pattern itself (see `PatternMeasure`). References
   * only, like rulers — they record what was measured where, never geometry.
   */
  measures?: PatternMeasure[];
  /**
   * Notes written over the pattern (see `PatternText`). They belong to the
   * pattern rather than to the canvas: a note drawn inside a container travels
   * with the frame, scales with it, and never reaches a mesh.
   */
  texts?: PatternText[];
  /**
   * Reference images drafted over (see `PatternImage`). Like the notes, they
   * belong to the pattern: an image placed inside a container travels with the
   * frame, scales with it, and never reaches a mesh.
   */
  images?: PatternImage[];
  /**
   * Parametric block instances (see `BlockInstance`). Their pieces live in
   * `pieces` like any other, so meshing, seams and export need no special case.
   */
  blocks?: BlockInstance[];
  /**
   * Lineage for pieces that were replaced by new ids (e.g. a knife cut):
   * removed piece id → the ids that took its place. Downstream Transform 3D
   * nodes use this to carry the piece's arrangement onto its successors instead
   * of resetting them. Optional — older documents simply have no lineage.
   */
  pieceSuccessors?: Record<string, string[]>;
  /**
   * The procedural stack this container will run over its pieces (the Blender
   * geometry-nodes / Houdini VOPs half of a container). Not implemented yet:
   * nothing reads this, and an empty or absent list means "plain pieces".
   */
  modifiers?: PatternModifier[];
};

/**
 * A note written over the pattern.
 *
 * Held in the pattern's own centimetres, so it belongs to the pattern rather than
 * to the canvas: on the board it rides inside the container's frame, moving and
 * scaling with the work, and it is never pattern geometry — nothing about it
 * reaches a mesh. The styling fields mirror a canvas text object's, measured in
 * centimetres where a canvas object counts canvas units, which is what makes a
 * note the same size in either place.
 */
export type PatternText = {
  id: string;
  /** Top-left of the box, in pattern centimetres. */
  x: number;
  y: number;
  /** The box, in centimetres. An `autoWidth` note grows with what is typed. */
  widthCm: number;
  heightCm: number;
  text: string;
  /** Type size in centimetres. */
  fontSizeCm: number;
  /** Font family as a CSS name; the studio's own families are offered first. */
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  /** Multiplier of the font size. */
  lineHeight?: number;
  /** Centimetres between characters. */
  letterSpacingCm?: number;
  align?: TextAlign;
  /** Text colour, as a CSS colour. */
  color?: string;
  /** Fill behind the text; `'transparent'` for none. */
  background?: string;
  /** Inset between the box and the text, centimetres on every side. */
  paddingCm?: number;
  /**
   * The box is as wide as the text: a click-placed note grows and shrinks with
   * what is typed into it. A dragged-out box has a width of its own and wraps.
   */
  autoWidth?: boolean;
};

/**
 * A reference image placed in a pattern.
 *
 * Held in the pattern's own centimetres, so it belongs to the pattern rather than
 * to the canvas: on the board it rides inside the container's frame, moving and
 * scaling with the work, and it is drawn *under* the pieces so a photograph or a
 * diagram can be drafted over. Nothing about it is pattern geometry — it is never
 * sewn and never reaches a mesh.
 */
export type PatternImage = {
  id: string;
  /** Top-left of the box, in pattern centimetres. */
  x: number;
  y: number;
  /** The box the picture fills, in centimetres. */
  widthCm: number;
  heightCm: number;
  /** Data URL, blob URL, or other browser-loadable source. */
  src: string;
  /** What the image is, for the host to name in messages. */
  label?: string;
  /** Natural pixel aspect (width/height), for the resize that keeps proportions. */
  naturalAspect?: number;
};

/**
 * One entry in a container's modifier stack. Deliberately opaque for now — the
 * stack exists in the data model so containers can be designed around it, and
 * the operations themselves are still to come.
 */
export type PatternModifier = {
  id: string;
  /** Operation name, e.g. `offset-edges`, `pleat`. */
  type: string;
  enabled?: boolean;
  /** Operation parameters, owned by whichever operation `type` names. */
  params?: Record<string, unknown>;
};

/**
 * How a measurement is scaled before the ease is added.
 *
 * Expressed as a divisor because that is what the drafts use — a bodice width is
 * a *quarter* bust arc — but it is really a scale factor, and some fields need
 * the other direction: a derived `sideLength` is half the underarm seam and
 * doubles to reach the block's number.
 */
export type BlockDivisor = 0.5 | 1 | 2 | 4;

/**
 * A block variable either sits at a fixed number or follows one of a person's
 * measurements, scaled and offset. The scale is not decoration: a bodice width
 * is a quarter bust plus ease, and a skirt panel is a quarter hip.
 */
export type BlockMeasurementSource = {
  /** A `MEASUREMENT_FIELDS` id. */
  fieldId: string;
  /** 1 = the measurement itself, 2 = half, 4 = quarter, 0.5 = double. */
  divisor: BlockDivisor;
  /** Ease added after scaling, in cm. */
  offsetCm: number;
};

export type BlockVariableBinding =
  | { mode: 'value'; cm: number }
  | (BlockMeasurementSource & {
      mode: 'measurement';
      /** Snapshot so the block still draws when the library is missing. */
      fallbackCm: number;
    });

/** One editable number a block definition exposes. */
export type BlockVariableDecl = {
  id: string;
  label: string;
  /** Display grouping, e.g. 'Widths' / 'Lengths' / 'Darts'. */
  group: string;
  /**
   * Most variables are lengths in cm and follow the project's display unit.
   * `count` is a number of things (dart count) and `factor` is a 0–1 shaping
   * control (how square a curve turns) — both dimensionless, so neither is ever
   * converted to inches.
   */
  kind?: 'length' | 'count' | 'factor';
  /** Bound automatically when the block is first placed on a person. */
  suggested?: BlockMeasurementSource;
  /** Used when the variable is a plain number. Always in cm. */
  defaultValueCm: number;
  minCm: number;
  maxCm: number;
  /** Why this number is what it is — the draft formula it came from. */
  note?: string;
};

/**
 * A placed block. Its geometry is regenerated from `bindings` whenever a
 * variable changes, so the generated pieces are read-only until detached.
 */
export type BlockInstance = {
  id: string;
  definitionId: string;
  /** The person this block is drafted for; null means the active person. */
  personId: string | null;
  personName: string;
  /** Where the draft's origin sits in pattern space (cm). */
  origin: Vec2;
  /** Variable id → binding. Anything missing falls back to the declaration. */
  bindings: Record<string, BlockVariableBinding>;
  /**
   * Generated pieces, keyed by the role the definition gave them, so
   * regeneration can keep piece and point ids stable and seams survive.
   */
  pieces: Array<{ role: string; pieceId: string }>;
};


export type MeshAlgorithm = 'structuredGrid' | 'delaunay' | 'centroidal';

export type MeshSettings = {
  algorithm: MeshAlgorithm;
  /** Target interior edge length in cm (smaller = denser). */
  targetEdgeCm: number;
  /** Spacing of forced boundary samples in cm. */
  boundarySpacingCm: number;
  /** Lloyd iterations for centroidal algorithm. */
  lloydIterations: number;
};

export type MeshGeometry = {
  vertices: Vec2[];
  /** Parallel to vertices: owning pattern piece for per-piece sim transforms. */
  vertexPieceIds?: Array<string | null>;
  /** Flat triangle indices (i0,i1,i2,...) */
  triangles: number[];
  /** Unique undirected edges [a,b] for springs */
  edges: Array<[number, number]>;
  /**
   * Parallel to vertices: seam/edge tag for boundary verts, null for interior.
   * Used to resolve sew constraints after triangulation.
   */
  boundary?: Array<SeamVertexTag | null>;
};

export type MeshDocument = {
  id: string;
  name: string;
  patternId: string;
  settings: MeshSettings;
  geometry: MeshGeometry | null;
};

export type DrapeEngineKind = 'cpu-mass-spring' | 'gpu-xpbd';

export type SimParams = {
  particleResolution: number;
  mass: number;
  springConst: number;
  dampingConst: number;
  /** Downward acceleration in world units/s² (one world unit = 10 cm, so 10 = 1 m/s²). */
  gravity: number;
  wind: [number, number, number];
  fluidDensity: number;
  dragCoeff: number;
  /** Drape backend; defaults to `DEFAULT_DRAPE_ENGINE` (GPU) when omitted. */
  engine?: DrapeEngineKind;
  /**
   * Integration substeps per frame (CPU mass-spring + GPU XPBD).
   * Macklin “small steps”: more substeps ≫ better stretch/stability than one big step.
   */
  substeps?: number;
  /**
   * CPU: Provot strain-limit passes per substep.
   * GPU: XPBD constraint iterations per substep.
   */
  constraintIterations?: number;
  /** Stretch compliance; 0 = hard PBD stretch (GPU). */
  stretchCompliance?: number;
  /** Bend compliance; high / omit to disable GPU bending. */
  bendCompliance?: number;
  /**
   * CPU: bend spring stiffness as a fraction of springConst (0 = off).
   * Typical 0.1–0.4 for fold resistance without locking the cloth.
   */
  bendSpringScale?: number;
  /**
   * CPU: Provot max edge length as a multiple of rest (e.g. 1.1 = 10% stretch).
   * ≤ 1 disables strain limiting. Classic Provot uses ~1.05–1.15.
   */
  maxStretch?: number;
  /**
   * CPU: multiplicative velocity retain per substep (0.95–1).
   * Slightly below 1 kills high-frequency spring ringing.
   */
  velocityDamping?: number;
  /** LRA slack multiplier (Velvet longRangeStretchiness). */
  longRangeStretchiness?: number;
  /** Self-collision / SDF particle radius = scalar × avg edge length. */
  particleDiameterScalar?: number;
  /**
   * Contact friction / grip (0–20).
   *
   * Up to 2 this is the historical model — tangential velocity retain ≈
   * max(0, 1 − friction × 0.95), which reaches zero around 1.05. Above 2 the
   * contact also holds back the tangential travel it just made, so the cloth
   * sticks where it touches (fully static by about 8).
   */
  contactFriction?: number;
  enableSelfCollision?: boolean;
  /** Rebuild spatial hash every N substeps. */
  interleavedHash?: number;
  /**
   * Clamp particle speed (world units/s) after each CPU substep / GPU finalize.
   * Bounds of the control are `MAX_SPEED_MIN`–`MAX_SPEED_MAX` (0.5–30) with a
   * default of `DEFAULT_MAX_SPEED` (2) in `createDefault`.
   */
  maxSpeed?: number;
};

export type SimPose = {
  positions: number[];
  velocities?: number[];
};

export type SimCameraState = {
  distance: number;
  azimuth: number;
  elevation: number;
  target: [number, number, number];
};

export type SimInstance = {
  id: string;
  name: string;
  params: SimParams;
  pose: SimPose | null;
  camera: SimCameraState;
  dropped: boolean;
  /**
   * Whether the fabric has actually been simulated since it was last laid out.
   *
   * It is what tells a *rebuilt* drape from a paused one: both hold a pose and
   * neither is running, but only the rebuilt one is still showing the upstream
   * layout, which is what makes moving a piece in it a placement of that piece
   * rather than a nudge to a simulation.
   */
  simulated?: boolean;
  /**
   * Pattern pieces pinned in place. A frozen piece holds its captured vertex
   * positions as the sim plays forward and across rebuilds, while the rest of
   * the cloth keeps draping and its seams stay live. Maps piece id → flat xyz.
   */
  frozenPieces?: Record<string, number[]>;
  /**
   * Pattern pieces taken out of the simulation, at the positions they held when
   * they were ghosted. A ghosted piece keeps its pose and touches nothing: no
   * constraints, no contact, no weight — the same shape as `frozenPieces`.
   */
  ghostedPieces?: Record<string, number[]>;
};

export type CanvasNodeBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
};

/**
 * A 2D container: a frame on the canvas showing a pattern's centimetre space.
 *
 * The pattern owns the work (pieces, seams, modifiers); the node is the frame
 * that looks at it. There is no inner zoom — the frame is a window, so a piece
 * is the same size inside a container as it is on the canvas itself. All four
 * fields are optional and default to "one canvas unit per centimetre, origin at
 * the frame's top-left corner, clipping on", which is what a container made by
 * hand or by drawing on the canvas gets.
 */
export type PatternFrameNode = CanvasNodeBase & {
  type: 'patternFrame';
  patternId: string;
  /** Canvas units per centimetre (see `CONTAINER_DEFAULT_CM_SCALE`). */
  cmScale?: number;
  /** Centimetre point shown at the frame's top-left corner. */
  viewX?: number;
  viewY?: number;
  /**
   * Figma-style "clip contents": hide whatever falls outside the frame without
   * changing the frame's extent. Off, the work spills over its neighbours.
   */
  clip?: boolean;
};

export type MeshFrameNode = CanvasNodeBase & {
  type: 'meshFrame';
  meshId: string;
};

export type SimViewportNode = CanvasNodeBase & {
  type: 'simViewport';
  simId: string;
};

/** Per-piece placement from the default flat layout (world units). */
export type PieceTransform3d = {
  /** World-space centroid after arrangement. */
  position: [number, number, number];
  /** Euler XYZ degrees (inspector / legacy). Used when rotationQuat is absent. */
  rotationDeg: [number, number, number];
  /** Orientation from rest pose (x,y,z,w). Preferred over euler when present. */
  rotationQuat?: [number, number, number, number];
};

/** Static 3D arrangement stage — sets initial sim pose without physics. */
export type Transform3dInstance = {
  id: string;
  name: string;
  meshId: string;
  camera: SimCameraState;
  /** Full vertex pose after arrangement; passed to connected sim nodes. */
  pose: SimPose | null;
  /** Inspector-friendly per-piece offsets from default flat layout. */
  pieceTransforms: Record<string, PieceTransform3d>;
};

export type Transform3dNode = CanvasNodeBase & {
  type: 'transform3d';
  transformId: string;
};

export type ImageNode = CanvasNodeBase & {
  type: 'image';
  /** IndexedDB asset reference when persisted externally. */
  assetId?: string;
  /** Data URL, blob URL, or other browser-loadable image src (reference / snapshot). */
  src: string;
  label?: string;
  /** Natural pixel aspect (width/height) for Shift-resize locking. */
  naturalAspect?: number;
};

/**
 * A text object on the canvas.
 *
 * It is a *canvas* object, not a pattern one: nothing in the pattern knows about
 * it, and it cannot be sewn or meshed until it is rasterized into pieces (see
 * `rasterizeText`). Everything here is in canvas units — the same units the node's
 * box is measured in — so the text zooms with the board like any other work.
 */
/**
 * A section: a big visual group, the way Figma draws one.
 *
 * It is a label and a rectangle, nothing more. What it *holds* is worked out from
 * where the objects are (see `sections.ts`) rather than stored, so the grouping
 * can never disagree with the board: drag something in and it is in, drag it out
 * and it is not. A section paints behind everything, never clips and takes no
 * pointer but on its label and its corners, so the canvas it covers is still
 * canvas.
 */
export type SectionNode = CanvasNodeBase & {
  type: 'section';
  label: string;
};

export type TextAnnotationNode = CanvasNodeBase & {
  type: 'text';
  text: string;
  fontSize: number;
  /** Font family as a CSS name; the studio's own families are offered first. */
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  /** Multiplier of the font size. */
  lineHeight?: number;
  /** Canvas units between characters. */
  letterSpacing?: number;
  align?: TextAlign;
  /** Text colour, as a CSS colour. */
  color?: string;
  /** Fill behind the text; `'transparent'` for none. */
  background?: string;
  /** Inset between the box and the text, canvas units on every side. */
  padding?: number;
  /**
   * The box is as wide as the text: a click-placed object grows and shrinks with
   * what is typed into it. A dragged-out box has a width of its own and wraps.
   */
  autoWidth?: boolean;
};

export type TextAlign = 'left' | 'center' | 'right' | 'justify';

export type CanvasNode =
  | PatternFrameNode
  | MeshFrameNode
  | Transform3dNode
  | SimViewportNode
  | ImageNode
  | TextAnnotationNode
  | SectionNode;

export type MeshSimAssignment = {
  id: string;
  meshId: string;
  simId: string;
};

export type MeshTransformAssignment = {
  id: string;
  meshId: string;
  transformId: string;
};

export type TransformSimAssignment = {
  id: string;
  transformId: string;
  simId: string;
};

export type ProjectDocument = {
  version: 3;
  id: string;
  name: string;
  displayUnit: UnitDisplay;
  canvas: {
    panX: number;
    panY: number;
    zoom: number;
    nodes: CanvasNode[];
    /**
     * The canvas is a drawing surface in its own right — one of Figma's pages.
     * Its work lives in the pattern named here; pieces drawn on the canvas are
     * put into a container by moving them into that container's pattern.
     * Absent means "no canvas pattern yet", which `normalizeProject` fills in.
     */
    rootPatternId?: string;
    /**
     * Canvas units per centimetre for work drawn straight onto the canvas, and
     * the scale a new container opens at. Defaults to
     * `CONTAINER_DEFAULT_CM_SCALE` for documents that predate containers.
     */
    draftScale?: number;
  };
  patterns: PatternDocument[];
  meshes: MeshDocument[];
  transforms: Transform3dInstance[];
  sims: SimInstance[];
  assignments: MeshSimAssignment[];
  meshTransformAssignments: MeshTransformAssignment[];
  transformSimAssignments: TransformSimAssignment[];
  activeSimId: string | null;
};

export const CM_PER_INCH = 2.54;

export function cmToDisplay(cm: number, unit: UnitDisplay): number {
  return unit === 'in' ? cm / CM_PER_INCH : cm;
}

export function displayToCm(value: number, unit: UnitDisplay): number {
  return unit === 'in' ? value * CM_PER_INCH : value;
}

export function formatLength(cm: number, unit: UnitDisplay, digits = 2): string {
  const v = cmToDisplay(cm, unit);
  return `${v.toFixed(digits)} ${unit}`;
}
