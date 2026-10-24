import type {
  BezierPoint,
  DrapeEngineKind,
  MeshDocument,
  PatternDocument,
  PatternPiece,
  ProjectDocument,
  SimInstance,
  SimParams,
  Transform3dInstance,
  Vec2,
} from './types';
import { DEFAULT_DISPLAY_UNIT } from './types';
import {
  DEFAULT_CANVAS_CM_SCALE,
  CONTAINER_PADDING_CM,
  piecesBoundsCm,
} from './containers';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';
import { getDefaultSimCamera, syncDefaultCameraFromDrapeA } from '../sim/cameraDefaults';

let _seq = 0;
export function uid(prefix = 'id'): string {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/**
 * Bounds of the Max speed control, in world units per second.
 *
 * The clamp does real work at both ends: it is what stops a bad step throwing
 * the cloth across the room, and — because a closed seam may only move a pair
 * as far as the substep's travel budget — what limits how far one substep can
 * take a stitch. Below about 0.5 the cloth crawls; the old ceiling of 10 sat
 * below the speed a falling panel actually reaches (a 30 cm fall at the default
 * gravity passes 10 u/s), so the clamp was doing the fabric's falling for it.
 */
export const MAX_SPEED_MIN = 0.5;
export const MAX_SPEED_MAX = 30;
/**
 * Where the control starts.
 *
 * Deliberately low. The clamp is the one knob that turns a violent substep into
 * a calm one, and a settled drape that is free to reach 8–12 u/s keeps ringing
 * long after it should be still. Two keeps a hem coming down while capping the
 * speeds that read as crawl; raise it when a drape feels sluggish.
 */
export const DEFAULT_MAX_SPEED = 2;

/**
 * The backend a new drape starts on.
 *
 * GPU unless the driver cannot run it — the CPU mass-spring engine is the
 * fallback for driver trouble, and is too slow for a garment of any size.
 */
export const DEFAULT_DRAPE_ENGINE: DrapeEngineKind = 'gpu-xpbd';

/** Bounds of the Gravity control, in world units per second squared (10 = 1 m/s²). */
export const GRAVITY_MIN = 0;
export const GRAVITY_MAX = 30;

/** Bring a stored gravity inside the control's range. */
export function clampGravity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_GRAVITY;
  return Math.min(GRAVITY_MAX, Math.max(GRAVITY_MIN, value));
}

/**
 * Bring a stored `maxSpeed` inside the control's range.
 *
 * Projects saved while the clamp ran to 40 keep their value until something
 * changes it, and a slider whose thumb sits at 10 while the readout says 30 is
 * a lie about what the engine is using.
 */
export function clampMaxSpeed(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_SPEED;
  return Math.min(MAX_SPEED_MAX, Math.max(MAX_SPEED_MIN, value));
}

/**
 * Where gravity starts, in world units per second squared.
 *
 * One world unit is 10 cm (`CM_TO_WORLD`), so this is 0.4 m/s² — light, but it
 * is what the model can carry: nothing pins the garment to the avatar except
 * contact friction, and past about 20 u/s² a sewn dress falls off the body
 * instead of hanging on it. At 0.8 (the old default, 0.08 m/s²) the fabric was
 * a hundred times too light: bending resistance held the panels in their drafted
 * shape and the drape never fell, which read as stiff shirting.
 */
export const DEFAULT_GRAVITY = 4;

/**
 * Bending is a *regulariser*, not a fabric property.
 *
 * Both engines bend the sheet with a distance constraint across each fold, and
 * at the old default (20 % of the stretch spring) that constraint pushed with
 * roughly a thousand times the weight of a particle — the fabric behaved like
 * card: panels stayed flat, gathers ballooned, hems flared instead of falling.
 * Real shirting bends at almost no cost against its own weight, so the default
 * is now soft enough to let folds form and only stops the mesh degenerating.
 */
export const DEFAULT_BEND_SPRING_SCALE = 0.04;
/** XPBD compliance for the same bending (higher = floppier). */
export const DEFAULT_BEND_COMPLIANCE = 0.02;

/** `4`, not `4.0` — but the half-unit steps still read as `0.5`. */
export function formatMaxSpeed(value: number | undefined): string {
  return String(Number(clampMaxSpeed(value).toFixed(2)));
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  particleResolution: 15,
  mass: 100,
  springConst: 1000,
  dampingConst: 3.5,
  gravity: DEFAULT_GRAVITY,
  wind: [0, 0, 0],
  fluidDensity: 1.225,
  dragCoeff: 1.0,
  engine: DEFAULT_DRAPE_ENGINE,
  /**
   * XPBD steps and iterations per frame. The CPU engine wants far more of both
   * (24 / 6) to hold a drape together, which is why it is only the fallback.
   */
  substeps: 8,
  constraintIterations: 4,
  stretchCompliance: 0,
  bendCompliance: DEFAULT_BEND_COMPLIANCE,
  bendSpringScale: DEFAULT_BEND_SPRING_SCALE,
  maxStretch: 1.12,
  velocityDamping: 0.998,
  longRangeStretchiness: 1.2,
  particleDiameterScalar: 1.5,
  contactFriction: 0.45,
  enableSelfCollision: false,
  interleavedHash: 3,
  maxSpeed: DEFAULT_MAX_SPEED,
};


/** Default mesh preview frame size (40% of original 340×400). */
export const DEFAULT_MESH_FRAME_WIDTH = 136;
export const DEFAULT_MESH_FRAME_HEIGHT = 160;

export function rectPiece(
  name: string,
  widthCm: number,
  heightCm: number,
  origin: Vec2 = { x: 0, y: 0 }
): PatternPiece {
  const pts: BezierPoint[] = [
    {
      id: uid('pt'),
      anchor: { x: origin.x, y: origin.y },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    },
    {
      id: uid('pt'),
      anchor: { x: origin.x + widthCm, y: origin.y },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    },
    {
      id: uid('pt'),
      anchor: { x: origin.x + widthCm, y: origin.y + heightCm },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    },
    {
      id: uid('pt'),
      anchor: { x: origin.x, y: origin.y + heightCm },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    },
  ];
  return {
    id: uid('piece'),
    name,
    closed: true,
    points: pts,
    grainline: {
      from: { x: origin.x + widthCm * 0.5, y: origin.y + heightCm * 0.2 },
      to: { x: origin.x + widthCm * 0.5, y: origin.y + heightCm * 0.8 },
    },
  };
}

/** Cubic Bézier kappa for a quarter-circle approximation. */
const BEZIER_CIRCLE_K = 0.5522847498;

/** Closed elliptical (or circular) piece approximated with 4 cubic Bézier corners. */
export function ellipsePiece(
  name: string,
  cx: number,
  cy: number,
  rx: number,
  ry: number
): PatternPiece {
  const ox = rx * BEZIER_CIRCLE_K;
  const oy = ry * BEZIER_CIRCLE_K;
  const pts: BezierPoint[] = [
    {
      id: uid('pt'),
      anchor: { x: cx + rx, y: cy },
      handleIn: { x: cx + rx, y: cy - oy },
      handleOut: { x: cx + rx, y: cy + oy },
      handlesParallel: true,
    },
    {
      id: uid('pt'),
      anchor: { x: cx, y: cy + ry },
      handleIn: { x: cx + ox, y: cy + ry },
      handleOut: { x: cx - ox, y: cy + ry },
      handlesParallel: true,
    },
    {
      id: uid('pt'),
      anchor: { x: cx - rx, y: cy },
      handleIn: { x: cx - rx, y: cy + oy },
      handleOut: { x: cx - rx, y: cy - oy },
      handlesParallel: true,
    },
    {
      id: uid('pt'),
      anchor: { x: cx, y: cy - ry },
      handleIn: { x: cx - ox, y: cy - ry },
      handleOut: { x: cx + ox, y: cy - ry },
      handlesParallel: true,
    },
  ];
  return {
    id: uid('piece'),
    name,
    closed: true,
    points: pts,
    grainline: {
      from: { x: cx, y: cy - ry * 0.6 },
      to: { x: cx, y: cy + ry * 0.6 },
    },
  };
}

export function circlePiece(name: string, cx: number, cy: number, radiusCm: number): PatternPiece {
  return ellipsePiece(name, cx, cy, radiusCm, radiusCm);
}

export function createMeshDocument(patternId: string, name = 'Mesh'): MeshDocument {
  const doc: MeshDocument = {
    id: uid('mesh'),
    name,
    patternId,
    settings: { ...DEFAULT_MESH_SETTINGS },
    geometry: null,
  };
  return doc;
}

export function createTransform3dDocument(meshId: string, name = 'Transform 3D'): Transform3dInstance {
  return {
    id: uid('transform'),
    name,
    meshId,
    camera: getDefaultSimCamera(),
    pose: null,
    pieceTransforms: {},
  };
}

export { normalizeProject, serializeProject, parseProject } from '../persistence/projectCodec';

export function remeshDocument(mesh: MeshDocument, pattern: PatternDocument | undefined): void {
  mesh.geometry = triangulatePattern(pattern, mesh.settings);
}

export function createDefaultProject(): ProjectDocument {
  const patternId = uid('pattern');
  const meshId = uid('mesh');
  const simId = uid('sim');
  const piece = rectPiece('Front panel', 40, 50, { x: 5, y: 5 });

  const pattern: PatternDocument = {
    id: patternId,
    name: 'Study A',
    pieces: [piece],
    seams: [],
  };

  // The canvas itself draws too — a page with its own centimetre space, which is
  // also the scale every new container opens at.
  const canvasPattern: PatternDocument = {
    id: uid('pattern'),
    name: 'Canvas',
    pieces: [],
    seams: [],
  };

  // The study's frame is fitted around its work at the canvas scale, so the
  // pattern is the same size inside the container as it would be on the page.
  const studyBounds = piecesBoundsCm(pattern.pieces)!;
  const canvasContainer = {
    type: 'patternFrame' as const,
    patternId,
    x: (studyBounds.min.x - CONTAINER_PADDING_CM) * DEFAULT_CANVAS_CM_SCALE,
    y: (studyBounds.min.y - CONTAINER_PADDING_CM) * DEFAULT_CANVAS_CM_SCALE,
    width: (studyBounds.max.x - studyBounds.min.x + CONTAINER_PADDING_CM * 2) *
      DEFAULT_CANVAS_CM_SCALE,
    height: (studyBounds.max.y - studyBounds.min.y + CONTAINER_PADDING_CM * 2) *
      DEFAULT_CANVAS_CM_SCALE,
    zIndex: 1,
    cmScale: DEFAULT_CANVAS_CM_SCALE,
    viewX: 0,
    viewY: 0,
    clip: true,
  };

  const mesh: MeshDocument = {
    id: meshId,
    name: 'Panel mesh',
    patternId,
    settings: { ...DEFAULT_MESH_SETTINGS },
    geometry: null,
  };
  remeshDocument(mesh, pattern);

  const transform = createTransform3dDocument(meshId, 'Transform 3D');
  const transformId = transform.id;

  const makeSim = (id: string, name: string): SimInstance => ({
    id,
    name,
    params: { ...DEFAULT_SIM_PARAMS },
    pose: null,
    camera: getDefaultSimCamera(),
    dropped: false,
  });

  const project: ProjectDocument = {
    version: 3,
    id: uid('project'),
    name: 'Untitled project',
    displayUnit: DEFAULT_DISPLAY_UNIT,
    canvas: {
      panX: 40,
      panY: 40,
      zoom: 1,
      draftScale: DEFAULT_CANVAS_CM_SCALE,
      rootPatternId: canvasPattern.id,
      nodes: [
        {
          ...canvasContainer,
          id: uid('node'),
        },
        {
          type: 'meshFrame',
          id: uid('node'),
          meshId,
          x: 420,
          y: 100,
          width: DEFAULT_MESH_FRAME_WIDTH,
          height: DEFAULT_MESH_FRAME_HEIGHT,
          zIndex: 2,
        },
        {
          type: 'transform3d',
          id: uid('node'),
          transformId,
          x: 580,
          y: 60,
          width: 380,
          height: 320,
          zIndex: 3,
        },
        {
          type: 'simViewport',
          id: uid('node'),
          simId,
          x: 980,
          y: 40,
          width: 420,
          height: 340,
          zIndex: 4,
        },
      ],
    },
    patterns: [canvasPattern, pattern],
    meshes: [mesh],
    transforms: [transform],
    sims: [makeSim(simId, 'Drape A')],
    assignments: [],
    meshTransformAssignments: [{ id: uid('assign'), meshId, transformId }],
    transformSimAssignments: [{ id: uid('assign'), transformId, simId }],
    activeSimId: null,
  };
  syncDefaultCameraFromDrapeA(project);
  return project;
}

export function downloadProject(project: ProjectDocument): void {
  const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.replace(/\s+/g, '_') || 'project'}.patterncanvas.json`;
  a.click();
  URL.revokeObjectURL(url);
}
