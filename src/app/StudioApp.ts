import {
  createDefaultProject,
  uid,
  DEFAULT_SIM_PARAMS,
  rectPiece,
  createMeshDocument,
  createTransform3dDocument,
  remeshDocument,
  normalizeProject,
  DEFAULT_MESH_FRAME_WIDTH,
  DEFAULT_MESH_FRAME_HEIGHT,
  DEFAULT_MAX_SPEED,
  DEFAULT_DRAPE_ENGINE,
  DEFAULT_BEND_SPRING_SCALE,
  GRAVITY_MIN,
  GRAVITY_MAX,
  MAX_SPEED_MIN,
  MAX_SPEED_MAX,
  clampGravity,
  clampMaxSpeed,
  formatMaxSpeed,
} from '../project/createDefault';
import {
  cloneSimCamera,
  getDefaultSimCamera,
  migrateLegacySimCamera,
  setDefaultSimCamera,
  syncDefaultCameraFromDrapeA,
} from '../sim/cameraDefaults';
import { upgradeLegacyFabrics } from '../sim/clothDefaults';
import type {
  BlockInstance,
  CanvasNode,
  ImageNode,
  MeshDocument,
  MeshFrameNode,
  PatternDocument,
  PatternFrameNode,
  PatternPiece,
  PieceTransform3d,
  ProjectDocument,
  SeamEdgeRef,
  SimInstance,
  SectionNode,
  SimViewportNode,
  TextAnnotationNode,
  Transform3dNode,
  Transform3dInstance,
  MeshAlgorithm,
  SimCameraState,
} from '../project/types';
import {
  PatternEditor,
  type PatternDetail,
  type PatternEditorContainer,
} from '../pattern/PatternEditor';
import {
  DEFAULT_TEXT_BACKGROUND,
  DEFAULT_TEXT_COLOR,
  TEXT_FONT_FAMILIES,
  TEXT_WEIGHTS,
  cssFont,
  layoutTextLines,
  renderTextMask,
  textMaskToPieces,
  textStyleOf,
  type TextStyle,
} from './textObject';
import {
  isSection,
  sectionChildren,
  sectionsForNode,
  withSectionContents,
} from '../project/sections';
import {
  clipboardPasteCount,
  copyNodes,
  copyPieces,
  describeClipboard,
  getClipboard,
  noteClipboardPaste,
  pasteNodes,
  pastePieces,
  parseClipboardPayload,
  serializeClipboard,
  setClipboard,
  type ClipboardPayload,
  type NodeClipboard,
  type PieceClipboard,
} from '../project/clipboard';
import { remapSeamAllowance, sameSeamBindingPair } from '../pattern/geometry';
import { DEFAULT_SEAM_GAP_CM, resolveSeamParticlePairs } from '../mesh/triangulate';
import { generateBlockPieces } from '../pattern/blocks/generate';
import { getBlockDefinition } from '../pattern/blocks/registry';
import {
  AvatarModal,
  type AvatarGenerationOptions,
  type AvatarPreviewElements,
  type AvatarReport,
} from './AvatarModal';
import { AvatarPreview } from '../avatar/AvatarPreview';
import { buildMeasurementRulers } from '../avatar/rulerOverlay';
import { cachedMeasurementLibrary, loadMeasurementLibrary } from '../persistence/measurementLibrary';
import {
  isEmbeddedStage,
  nodesInBoardRect,
  planNodeDuplicates,
  simChainIds,
  type DuplicateLinks,
} from '../project/nodeDuplicates';
import {
  CONTAINER_PADDING_CM,
  canvasAtCm,
  canvasCmScale,
  containerClips,
  containerView,
  groupIntoContainer,
  movePiecesBetweenSpaces,
  patternForSpace,
  piecesBoundsCm,
  containerViewShifted,
  rootPattern,
  topNodeZ,
  type ContainerView,
} from '../project/containers';
import { MeshPreview } from '../mesh/MeshPreview';
import { quat, vec3 } from 'gl-matrix';
import { createSharedGpu, SimViewportRuntime } from '../sim/SimViewportRuntime';
import { buildObj, downloadFile, downloadTextFile, objFileName, type ObjPart } from '../export/objExport';
import { buildBlenderPack, blenderPackFileName, type BlenderPackSeam } from '../export/blenderPack';
import { SimExportControl } from './SimExportControl';
import type { PlacementCommit } from '../sim/placementGesture';
import { quatToEulerDeg, resolvePieceQuat } from '../sim/pieceTransforms';
import { Environment, loadEnvironmentSettings } from '../render/environment';
import { MaterialLibrary } from '../render/materials';
import { Transform3dRuntime } from '../sim/Transform3dRuntime';
import { DEFAULT_TRANSFORM_PIECE_ROTATION_DEG } from '../sim/transformDefaults';

type Rect = { x: number; y: number; w: number; h: number };

/** What a drape is doing: running, holding a simulated pose, or showing a layout. */
type SimPlayState = 'live' | 'paused' | 'ready';

type SimTransport = {
  play: HTMLButtonElement;
  /** The state the button was last drawn in, so a no-change sync costs nothing. */
  state: SimPlayState | null;
};

/** Does a node's box on the canvas meet `rect`? Both are in canvas units. */
function nodeBoxIntersects(
  node: { x: number; y: number; width: number; height: number },
  rect: Rect
): boolean {
  return (
    node.x < rect.x + rect.w &&
    node.x + node.width > rect.x &&
    node.y < rect.y + rect.h &&
    node.y + node.height > rect.y
  );
}

/** The board's zoom range — it is the whole page's scale, so it reaches far out. */
const MIN_BOARD_ZOOM = 0.04;
const MAX_BOARD_ZOOM = 4;

/**
 * How far a container's chrome may trail a moving board zoom before it repaints,
 * and how still the board has to be before the rest catches up. Zooming a frame
 * only changes the size of its chrome — see `PatternEditor.restateContainer` — so
 * paying for every frame of a gesture is the difference between a canvas with a
 * few containers and one with a dozen.
 */
const CONTAINER_CHROME_TOLERANCE = 1.25;
const CONTAINER_CHROME_SETTLE_MS = 140;

/**
 * How long a zoom has to be still before the board is drawn again.
 *
 * A gesture freezes the drawing and scales it — see `BoardZoomGesture` — so this
 * is the delay after the last zoom step before the page, the wires and every
 * frame's chrome are rebuilt at the zoom it landed on. Long enough that a
 * trackpad's gaps between events do not end the gesture, short enough that
 * letting go feels like it snaps into focus.
 */
const ZOOM_GESTURE_SETTLE_MS = 140;

/**
 * How long the "+ 3d container" prompt waits after the pointer leaves the terminal
 * it belongs to. Long enough to cross the gap — the prompt sits beside the port,
 * not on it — short enough that moving on feels like it dismissed itself.
 */
const DRAPE_OFFER_LINGER_MS = 220;

/** How many other projects the file menu offers to jump back to. */
const DOC_MENU_RECENT = 6;

/**
 * A CSS colour as the `#rrggbb` a colour input insists on.
 *
 * The bar's swatches are native colour pickers, and one cannot show `transparent`
 * or a named colour; the text object still stores whatever CSS says, so the input
 * gets a nearest approximation of it and the value is only written back when the
 * picker is actually used.
 */
function toHexColor(value: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (typeof document === 'undefined') return fallback;
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return fallback;
  probe.fillStyle = fallback;
  probe.fillStyle = value;
  const parsed = String(probe.fillStyle);
  return /^#[0-9a-f]{6}$/i.test(parsed) ? parsed : fallback;
}

/** "Oct 20" — enough to tell one recent project from another in a menu row. */
function shortProjectDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * How much of a pattern to draw, measured by how big a centimetre is on screen:
 * full detail above 2 px, silhouettes down to 0.9 px, and nothing but the frame's
 * own ground below that. At the canvas's own drafting scale (6.5 canvas units per
 * centimetre) those land at board zooms of about 31% and 14%.
 */
const CONTAINER_DETAIL_FULL_PX_PER_CM = 2;
const CONTAINER_DETAIL_PREVIEW_PX_PER_CM = 0.9;

/** How far outside the board a frame still counts as visible, in screen px. */
const CONTAINER_CULL_MARGIN_PX = 256;
import {
  createIcons,
  Menu,
  Redo2,
  Undo2,
} from 'lucide';
import {
  DEFAULT_AUTOSAVE_MINUTES,
  deleteProjectFromLibrary,
  exportProjectFile,
  formatProjectDate,
  getActiveProjectId,
  getAutosaveIntervalMinutes,
  getSavedProject,
  getStorageEstimate,
  importProjectFile,
  initializeProjectLibrary,
  listSavedProjects,
  saveProjectToLibrary,
  setActiveProjectId,
  setAutosaveIntervalMinutes,
} from '../project/projectLibrary';
import { HistoryManager } from '../project/history/HistoryManager';
import { attachDrapeAnchor, canAttach3dContainer, DRAPE_NODE_HEIGHT, DRAPE_NODE_WIDTH } from './attachDrape';
import {
  BoardZoomGesture,
  formatLayerTransform,
  type BoardView,
} from './zoomGesture';
import { resetAvatarOverlayCache } from '../pattern/avatarPatternOverlay';
import {
  avatarCacheKeyFor,
  buildAvatarMeshes,
  collisionSummaryText,
  createAvatarBodyFromAvatar,
} from '../avatar/avatarService';
import { loadAvatarLibrary, updateAvatar } from '../persistence/avatarLibrary';
import type { Avatar } from '../project/avatars';
import type { AvatarBody } from '../mesh/AvatarBody';

const WORLD_TO_CM = 10;

type WireSource = {
  kind: 'pattern' | 'mesh' | 'transform';
  id: string;
  nodeId: string;
};

type WireDrag = WireSource & {
  pointerId: number;
  x: number;
  y: number;
};

/** Visible pattern-space rectangle of a 2D editor (its zoom / pan). */
type PatternViewBox = { x: number; y: number; w: number; h: number };

/**
 * Live view states captured so undo/redo can preserve the current view. Pan and
 * zoom are the user's, not the document's: restoring history must never move a
 * viewport — the 3D cameras, the 2D editors, or the board itself.
 */
type CameraSnapshot = {
  transforms: Map<string, SimCameraState>;
  sims: Map<string, SimCameraState>;
  /** Board pan/zoom, kept across undo so the studio canvas stays put. */
  board: { panX: number; panY: number; zoom: number };
  /** Per pattern-frame node id: the editor's visible rectangle. */
  patterns: Map<string, PatternViewBox>;
};

function ensureVisibleConnections(project: ProjectDocument): ProjectDocument {
  const p = normalizeProject(project);
  const fallbackMesh = p.meshes[0];
  if (!fallbackMesh) return p;

  for (const transform of p.transforms) {
    if (!transform.meshId) transform.meshId = fallbackMesh.id;
    if (!p.meshTransformAssignments.some((assignment) => assignment.transformId === transform.id)) {
      p.meshTransformAssignments.push({
        id: uid('assign'),
        meshId: transform.meshId,
        transformId: transform.id,
      });
    }
  }

  for (const sim of p.sims) {
    if (p.transformSimAssignments.some((assignment) => assignment.simId === sim.id)) continue;
    if (!p.assignments.some((assignment) => assignment.simId === sim.id)) {
      p.assignments.push({
        id: uid('assign'),
        meshId: fallbackMesh.id,
        simId: sim.id,
      });
    }
  }
  return p;
}

export class StudioApp {
  private project: ProjectDocument;
  private board: HTMLElement;
  private wiresSvg: SVGSVGElement;
  private toolbar: HTMLElement;
  private studioBody: HTMLElement;
  private inspector: HTMLElement;
  private toastEl: HTMLElement;
  /** Folded to a rail? Kept across re-renders and node selections. */
  private inspectorCollapsed = false;
  private toastTimer = 0;
  private editors = new Map<string, PatternEditor>();
  /** The page itself: a pattern editor under the frames (see `mountCanvasSurface`). */
  private canvasEditor: PatternEditor | null = null;
  private canvasSurface: HTMLElement | null = null;
  private meshPreviews = new Map<string, MeshPreview>();
  private simRuntimes = new Map<string, SimViewportRuntime>();
  private transformRuntimes = new Map<string, Transform3dRuntime>();
  /** The play/pause button per drape, and the state it was last drawn in. */
  private simTransports = new Map<string, SimTransport>();
  /** The export split button per drape; it owns a document listener to dispose. */
  private simExports = new Map<string, SimExportControl>();
  private transformInspectorPieceId: string | null = null;
  private device: GPUDevice | null = null;
  /**
   * HDRI background + light probe. One per device, shared by every 3D viewport,
   * so switching the environment moves them all together.
   */
  private environment: Environment | null = null;
  /** Scene materials, shared by every 3D viewport like the environment. */
  private materials = new MaterialLibrary();
  private selectedNodeId: string | null = null;
  /** Every selected node, in the order they were picked; `selectedNodeId` is the
   *  primary one (the last picked), which the inspector shows. */
  private selectedNodeIds: string[] = [];
  /** True while the node board is the surface the pointer last touched, so
   *  Backspace / Delete belong to the nodes rather than to a pattern editor
   *  sitting on the same board. */
  private boardSurfaceActive = true;
  /** Fixed-position tip host (escapes inspector overflow clipping). */
  private inspectorTipEl: HTMLDivElement | null = null;
  /** Avatar editor dialog, when open. */
  private avatarModal: AvatarModal | null = null;
  private avatarPreview: AvatarPreview | null = null;
  private avatarPreviewCanvas: HTMLCanvasElement | null = null;
  private avatarRulersVisible = true;
  private panning = false;
  private panLast = { x: 0, y: 0 };
  /** Nodes in flight, with the grab offset each one started from. */
  private draggingNodes: { id: string; ox: number; oy: number }[] | null = null;
  /**
   * Nodes picked on empty board space, in flight. `base` is the selection the
   * drag started from, so shrinking the rectangle drops nodes again.
   */
  private nodeMarquee: {
    el: HTMLElement;
    startX: number;
    startY: number;
    x: number;
    y: number;
    base: string[];
    moved: boolean;
  } | null = null;
  /**
   * The page's marquee, while it is drawing, as the node ids it started from.
   *
   * The page's editor owns the rectangle (it is the surface the drag is on), and
   * the board answers it here by also taking the frames the rectangle crosses —
   * one drag over the canvas picks up work *and* the nodes it sits in.
   */
  private pageMarqueeBase: string[] | null = null;
  private wireDrag: WireDrag | null = null;
  private resizingNode: {
    id: string;
    corner: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'e' | 's' | 'w';
    startBoardX: number;
    startBoardY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    /** A container's view at the start of the resize — see `containerViewShifted`. */
    origView?: ContainerView;
  } | null = null;
  private raf = 0;
  /** Wheel events gathered for the next frame, and the frame that will apply them. */
  private pendingZoom: { factor: number; clientX: number; clientY: number } | null = null;
  private zoomRaf = 0;
  /** The board zoom the containers were last told about — see `applyBoardTransform`. */
  private chromeZoomSynced: number | null = null;
  private chromeSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The zoom in flight, if the drawing is currently being scaled rather than drawn. */
  private zoomGesture = new BoardZoomGesture();
  private zoomGestureTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where the page's drawing sits in the board wrap, read before the first freeze. */
  private frozenPageOrigin: { x: number; y: number } | null = null;
  /** When the last zoom step was applied, for telling a run of them from one. */
  private lastZoomFlushAt = Number.NEGATIVE_INFINITY;
  /** The "+ 3d container" prompt for a container's free output, and its target. */
  private drapeOffer: { button: HTMLButtonElement; nodeId: string; patternId: string } | null = null;
  /** The prompt element itself, made once and reused — see `drapeOfferButton`. */
  private drapeOfferButtonEl: HTMLButtonElement | null = null;
  private drapeOfferTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per node, the chrome that has to be told the board's zoom — see `cacheBoardZoomChrome`. */
  private boardChrome = new Map<string, HTMLElement[]>();
  /** Section labels, which sit beside their frames rather than inside them. */
  private sectionLabels = new Map<string, HTMLElement>();
  /** The zoom those elements were last given, so a pan does not rewrite it. */
  private chromeVarZoom: number | null = null;
  /** Frames that were off the canvas when the board last moved — see `syncContainerDetail`. */
  private culledContainers = new Set<string>();
  /** Bumped on each board remount so in-flight initGpuAndSims cannot register stale runtimes. */
  private gpuInitGeneration = 0;
  private modalRoot: HTMLElement;
  private importFileInput: HTMLInputElement;
  private undoStack = new HistoryManager();
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight = false;
  private saveQueued = false;
  private restoringUndo = false;
  /** Body restored from the avatar library, so a rebuilt runtime can be re-aimed at it. */
  private restoredAvatar: { key: string; body: AvatarBody } | null = null;
  private expandedNodeId: string | null = null;
  private expandPlaceholder: HTMLElement | null = null;
  private expandOverlay: HTMLElement | null = null;
  private expandEscHandler: ((e: KeyboardEvent) => void) | null = null;
  /**
   * Split fullscreen: the 2D pattern on the left and one 3D stage on the right,
   * shown at once. Null when the normal single-node fullscreen is in use.
   */
  private splitView: {
    patternNodeId: string;
    stageNodeId: string;
    patternPlaceholder: HTMLElement;
    stagePlaceholder: HTMLElement;
    /** The expanded node's own chrome, hoisted to the top of the overlay. */
    chrome: HTMLElement;
    body: HTMLElement;
    /** The 3D pane; carries the stale tint and the banner over its action bar. */
    stagePane: HTMLElement;
    banner: HTMLElement;
  } | null = null;
  /** Guard so mirrored 2D ↔ 3D selection does not feed back on itself. */
  private splitSelectionSyncing = false;
  private imageFileInput: HTMLInputElement;
  /** The Figma-style bar that styles the text object in hand, bottom centre. */
  private textBar: HTMLElement;
  private resizeShiftKey = false;

  private constructor(root: HTMLElement) {
    this.project = ensureVisibleConnections(createDefaultProject());
    root.innerHTML = `
      <div class="studio">
        <div class="studio-scrim" aria-hidden="true"></div>
        <header class="studio-toolbar" id="toolbar"></header>
        <div class="studio-body">
          <div class="studio-board-wrap" id="boardWrap">
            <svg class="studio-wires" id="wires"></svg>
            <div class="studio-board" id="board"></div>
          </div>
          <aside class="studio-inspector" id="inspector"></aside>
        </div>
        <div class="text-style-bar" id="textStyleBar" role="toolbar" aria-label="Text style" hidden></div>
        <div class="studio-toast" id="toast" role="status" aria-live="polite" hidden></div>
        <div class="studio-modal-root" id="modalRoot" hidden></div>
        <input type="file" id="importFile" accept="application/json,.json,.patterncanvas,application/zip" hidden />
        <input type="file" id="imageFile" accept="image/*" multiple hidden />
      </div>
    `;
    this.toolbar = root.querySelector('#toolbar')!;
    this.studioBody = root.querySelector('.studio-body')!;
    this.board = root.querySelector('#board')!;
    this.wiresSvg = root.querySelector('#wires')!;
    this.inspector = root.querySelector('#inspector')!;
    this.toastEl = root.querySelector('#toast')!;
    this.textBar = root.querySelector('#textStyleBar')!;
    this.modalRoot = root.querySelector('#modalRoot')!;
    this.importFileInput = root.querySelector('#importFile')!;
    this.imageFileInput = root.querySelector('#imageFile')!;
    this.buildToolbar();
    this.trackToolbarHeight();
    this.bindImportFile();
    this.bindImageImport();
    this.bindBoardPan();
    this.bindNodeContextMenu();
    this.bindBoardHotkeys();
    this.bindUndoHotkey();
    this.bindFrameResizeModifier();
    this.bindImagePasteAndDrop();
    this.bindClipboardShortcuts();
    this.trackActiveEditorPress();
    this.buildTextStyleBar();
    window.addEventListener('resize', () => this.drawWires());
  }

  static async create(root: HTMLElement): Promise<StudioApp> {
    const app = new StudioApp(root);
    app.setStatus('Loading projects…');
    try {
      await initializeProjectLibrary();
      // Rulers read the body-measurement library for their labels, so warm the
      // cache before the first pattern editor mounts.
      void loadMeasurementLibrary().then(() => app.refreshRulerLibraries());
      app.project = app.prepareLoadedProject(await app.loadInitialProject());
      app.syncProjectChrome();
      app.restartAutosave();
      app.renderAll();
      void app.initGpuAndSims();
      void app.refreshStorageStatus();
    } catch (err) {
      console.warn('Project library init failed:', err);
      app.setStatus('Could not load saved projects — using new project');
      app.renderAll();
      void app.initGpuAndSims();
    }
    return app;
  }

  private async loadInitialProject(): Promise<ProjectDocument> {
    try {
      const activeId = await getActiveProjectId();
      if (activeId) {
        const project = await getSavedProject(activeId);
        if (project) return project;
      }
      const saved = await listSavedProjects();
      if (saved[0]) {
        await setActiveProjectId(saved[0].id);
        const project = await getSavedProject(saved[0].id);
        if (project) return project;
      }
    } catch {
      /* ignore */
    }
    const project = ensureVisibleConnections(createDefaultProject());
    const { write } = await saveProjectToLibrary(project);
    if (!write.ok) {
      console.warn('Initial project save failed:', write.error);
    }
    return project;
  }

  /**
   * Say so when a project came back with image bytes that are no longer in
   * storage. Reading the document rather than remembering a load-time set keeps
   * the warning honest: re-linking the image clears it.
   */
  private reportMissingImages(): void {
    const count = this.project.canvas.nodes.filter(
      (node) => node.type === 'image' && !node.src
    ).length;
    if (count === 0) return;
    const what = count === 1 ? 'An image reference has' : `${count} image references have`;
    this.setStatus(`${what} lost its stored data — use Re-link image… on the node to restore it`);
  }

  private async refreshStorageStatus(): Promise<void> {
    const est = await getStorageEstimate();
    if (est.usage != null && est.quota != null) {
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
      this.setStatus(`Ready · storage ${mb(est.usage)} / ${mb(est.quota)} MB`);
    }
  }

  /**
   * Something in the document changed. The save payload is derived from the
   * project itself, so there is no dirty-bit bookkeeping to keep in step — this
   * only debounces the write.
   */
  private markDirty(): void {
    this.scheduleDebouncedPersist();
  }

  private scheduleDebouncedPersist(): void {
    if (this.persistDebounceTimer) clearTimeout(this.persistDebounceTimer);
    this.persistDebounceTimer = setTimeout(() => {
      void this.persistLocal({ quiet: true });
    }, 750);
  }

  private prepareLoadedProject(project: ProjectDocument): ProjectDocument {
    syncDefaultCameraFromDrapeA(project);
    const defaults = getDefaultSimCamera(project);
    for (const sim of project.sims) {
      if (sim.name === 'Drape A') continue;
      migrateLegacySimCamera(sim.camera, defaults);
    }
    // Drapes saved before the fabric was re-calibrated hold their drafted shape
    // instead of falling. Bring them onto the current defaults, once — and write
    // it back, so the library and the viewport agree from the first frame.
    if (upgradeLegacyFabrics(project)) this.markDirty();
    return ensureVisibleConnections(project);
  }

  private async persistLocal(opts: { quiet?: boolean; label?: string } = {}): Promise<void> {
    if (this.saveInFlight) {
      this.saveQueued = true;
      return;
    }
    this.saveInFlight = true;
    this.persistSimStates();
    try {
      const { write } = await saveProjectToLibrary(this.project);
      const label = opts.label ?? 'Saved';
      if (!write.ok) {
        this.setStatus(write.error ?? 'Local save failed — export your project');
        return;
      }
      if (!opts.quiet) {
        this.setStatus(`${label} “${this.project.name}”`);
      }
    } finally {
      this.saveInFlight = false;
      if (this.saveQueued) {
        this.saveQueued = false;
        void this.persistLocal(opts);
      }
    }
  }

  /** Snapshot current project before a user edit (max 15 levels). */
  private pushUndo(): void {
    if (this.restoringUndo) return;
    this.persistSimStates();
    this.undoStack.push(this.project);
    this.updateHistoryButtons();
  }

  private performUndo(): void {
    if (!this.undoStack.canUndo) return;
    // Camera moves/zooms are view state, not document edits — keep them across undo.
    const cameras = this.captureLiveCameras();
    this.snapshotProjectForHistory();
    const prev = this.undoStack.undo(this.project);
    this.updateHistoryButtons();
    if (!prev) return;
    this.markDirty();
    void this.restoreHistoryProject(prev, `Undo (${this.undoStack.size} left)`, cameras);
  }

  private performRedo(): void {
    if (!this.undoStack.canRedo) return;
    const cameras = this.captureLiveCameras();
    this.snapshotProjectForHistory();
    const next = this.undoStack.redo(this.project);
    this.updateHistoryButtons();
    if (!next) return;
    this.markDirty();
    void this.restoreHistoryProject(next, `Redo (${this.undoStack.redoSize} left)`, cameras);
  }

  private async restoreHistoryProject(
    project: ProjectDocument,
    status: string,
    cameras?: CameraSnapshot
  ): Promise<void> {
    const expandedId = this.expandedNodeId;
    const prevSelectedNodeIds = this.selectedNodeIds.slice();
    const prevSelectedNodeId = this.selectedNodeId;
    const prevTransformPieceId = this.transformInspectorPieceId;
    const needsRemount =
      this.canvasRuntimeSignature(this.project) !== this.canvasRuntimeSignature(project);
    this.restoringUndo = true;
    try {
      this.project = this.prepareLoadedProject(project);
      // Overwrite the snapshot's cameras with the view the user is currently on
      // so undo/redo never moves or zooms the viewport.
      if (cameras) this.applyLiveCameras(cameras);
      void setActiveProjectId(this.project.id);
      const alive = new Set(this.project.canvas.nodes.map((n) => n.id));
      this.selectedNodeIds = prevSelectedNodeIds.filter((id) => alive.has(id));
      this.selectedNodeId =
        prevSelectedNodeId && alive.has(prevSelectedNodeId)
          ? prevSelectedNodeId
          : (this.selectedNodeIds[this.selectedNodeIds.length - 1] ?? null);
      this.transformInspectorPieceId = prevTransformPieceId;
      this.syncProjectChrome();

      if (needsRemount) {
        this.renderAll();
        if (
          expandedId &&
          this.project.canvas.nodes.some((n) => n.id === expandedId)
        ) {
          this.openNodeFullscreen(expandedId);
        }
        await this.initGpuAndSims();
      } else {
        await this.syncLiveRuntimesFromProject();
        if (this.hasMissingViewportRuntimes()) {
          await this.initGpuAndSims();
        }
      }

      // Re-assert the preserved view after runtimes synced: their load path runs
      // legacy camera migration which must not shift the user's current view.
      if (cameras) {
        this.applyLiveCameras(cameras);
        this.applyLiveCamerasToRuntimes(cameras);
      }

      this.restoreTransformInspectorSelection();
      this.renderInspector();
      this.setStatus(status);
    } finally {
      this.restoringUndo = false;
    }
  }

  /** True when undo/redo can update live viewports without remounting the canvas board. */
  private canvasRuntimeSignature(project: ProjectDocument): string {
    const nodes = [...project.canvas.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => {
        switch (n.type) {
          case 'patternFrame':
            return `${n.id}:pattern:${n.patternId}`;
          case 'meshFrame':
            return `${n.id}:mesh:${n.meshId}`;
          case 'transform3d':
            return `${n.id}:transform:${n.transformId}`;
          case 'simViewport':
            return `${n.id}:sim:${n.simId}`;
          case 'image':
            return `${n.id}:image:${n.assetId ?? ''}`;
          case 'text':
            return `${n.id}:text`;
        }
      })
      .join('|');
    return [
      nodes,
      project.patterns.map((p) => p.id).sort().join(','),
      project.meshes.map((m) => m.id).sort().join(','),
      project.transforms.map((t) => t.id).sort().join(','),
      project.sims.map((s) => s.id).sort().join(','),
    ].join(';;');
  }

  private async syncLiveRuntimesFromProject(): Promise<void> {
    // The page's editor is not a node, so it is not re-pointed by the loop below:
    // without this it would go on drawing the document the undo replaced. Its view
    // is the board's, restated every frame, so it is not fitted either.
    this.canvasEditor?.setPattern(rootPattern(this.project), { preserveView: true });
    for (const node of this.project.canvas.nodes) {
      if (node.type === 'patternFrame') {
        const pattern = this.project.patterns.find((p) => p.id === node.patternId);
        const editor = this.editors.get(node.id);
        // Restoring history: keep the zoom/pan the user is looking through.
        if (pattern && editor) editor.setPattern(pattern, { preserveView: true });
        continue;
      }
      if (node.type === 'meshFrame') {
        const mesh = this.project.meshes.find((m) => m.id === node.meshId);
        const preview = this.meshPreviews.get(node.id);
        if (mesh && preview) {
          preview.setMesh(mesh, this.project.patterns.find((p) => p.id === mesh.patternId) ?? null);
        }
        continue;
      }
      if (node.type === 'image') {
        const el = this.findNodeEl(node.id);
        const img = el?.querySelector('img') as HTMLImageElement | null;
        if (img && node.src && img.src !== node.src) this.refreshImageElement(node);
        continue;
      }
      if (node.type === 'text') {
        const el = this.findNodeEl(node.id);
        const content = el?.querySelector<HTMLElement>('.node-text-content');
        if (content && content.textContent !== node.text) content.textContent = node.text;
      }
    }

    for (const transform of this.project.transforms) {
      const rt = this.transformRuntimes.get(transform.id);
      if (!rt) continue;
      rt.syncFromDocument(transform);
      rt.applyCamera(transform);
      rt.rebuildCloth(
        this.meshGeometryForTransform(transform.id),
        transform.pose,
        transform.pieceTransforms,
        this.patternForTransform(transform.id)
      );
    }

    syncDefaultCameraFromDrapeA(this.project);
    const defaults = getDefaultSimCamera(this.project);
    for (const sim of this.project.sims) {
      const rt = this.simRuntimes.get(sim.id);
      if (!rt) continue;
      rt.syncFromDocument(sim);
      rt.setDefaultCamera(defaults);
      rt.applyCamera(sim);
      this.rebuildConnectedSim(sim.id, false);
    }

    this.ensureRenderLoop();
    this.layoutNodes();
    this.drawWires();
    if (this.expandedNodeId) {
      this.notifyNodeViewportResize(this.expandedNodeId);
    }
  }

  private hasMissingViewportRuntimes(): boolean {
    for (const node of this.project.canvas.nodes) {
      if (node.type === 'transform3d') {
        if (!this.transformRuntimes.has(node.transformId)) return true;
      } else if (node.type === 'simViewport') {
        if (!this.simRuntimes.has(node.simId)) return true;
      }
    }
    return false;
  }

  private ensureRenderLoop(): void {
    if (this.raf) return;
    const loop = () => {
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private restoreTransformInspectorSelection(): void {
    if (!this.transformInspectorPieceId) return;
    const node = this.project.canvas.nodes.find((n) => n.id === this.selectedNodeId);
    if (node?.type !== 'transform3d') return;
    const rt = this.transformRuntimes.get(node.transformId);
    if (!rt) return;
    const pieceIds = rt.getPieceIds();
    if (!pieceIds.includes(this.transformInspectorPieceId)) {
      this.transformInspectorPieceId = null;
      return;
    }
    rt.setSelectedPieceId(this.transformInspectorPieceId);
    this.renderInspector();
  }

  private updateHistoryButtons(): void {
    const undoBtn = this.toolbar.querySelector('[data-act="undo"]') as HTMLButtonElement | null;
    if (undoBtn) {
      undoBtn.disabled = !this.undoStack.canUndo;
      undoBtn.title = this.undoStack.canUndo
        ? `Undo last change (${this.undoStack.size} in history) · ⌘/Ctrl+Z`
        : 'Nothing to undo';
    }
    const redoBtn = this.toolbar.querySelector('[data-act="redo"]') as HTMLButtonElement | null;
    if (redoBtn) {
      redoBtn.disabled = !this.undoStack.canRedo;
      redoBtn.title = this.undoStack.canRedo
        ? `Redo (${this.undoStack.redoSize} in history) · ⌘/Ctrl+Shift+Z`
        : 'Nothing to redo';
    }
  }

  /**
   * Backspace / Delete on the node board, and Escape to drop the selection.
   *
   * Registered in the capture phase while the constructor runs — before any node
   * (and so any pattern editor, which also listens on document in the capture
   * phase) is mounted — so the board gets first refusal. When the board is the
   * surface the pointer last touched, a delete is consumed here and a pattern
   * editor sitting on the board never sees it.
   */
  private bindBoardHotkeys(): void {
    document.addEventListener('keydown', this.onBoardKeyDown, true);
    // Which surface owns the keyboard is decided by the press, not by focus: node
    // and board presses all `preventDefault`, so focus stays wherever it was.
    document.addEventListener(
      'pointerdown',
      (e) => {
        const target = e.target as HTMLElement | null;
        const wrap = document.getElementById('boardWrap');
        this.boardSurfaceActive = !!(
          target &&
          wrap?.contains(target) &&
          !target.closest(
            'button, input, textarea, select, [contenteditable="true"], .pattern-editor, canvas'
          )
        );
      },
      true
    );
  }

  private onBoardKeyDown = (e: KeyboardEvent): void => {
    // The node menu owns Escape, and a delete underneath an open menu would
    // leave it pointing at a node that is gone.
    if (this.expandedNodeId || this.isStudioModalOpen() || this.nodeMenu) return;
    if (!this.boardSurfaceActive) return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this.selectedNodeIds.length === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.deleteSelectedNodes();
      return;
    }
    if (e.key === 'Escape' && this.selectedNodeIds.length > 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.clearNodeSelection();
    }
  };

  private bindUndoHotkey(): void {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') this.resizeShiftKey = true;
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const isZ = key === 'z';
      const isY = key === 'y';
      const isD = key === 'd';
      const isS = key === 's';
      if (!isZ && !isY && !isD && !isS) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Save: ⌘/Ctrl+S — takes over the browser's "save this page".
      if (isS && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void this.persistLocal({ label: 'Saved' });
        return;
      }
      // Duplicate selected node: ⌘/Ctrl+D
      if (isD && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.duplicateSelectedNode();
        return;
      }
      // Redo: ⌘/Ctrl+Shift+Z, or Ctrl+Y (Windows/Linux)
      if ((isZ && e.shiftKey) || (isY && !e.shiftKey && e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        this.performRedo();
        return;
      }
      if (isZ && !e.shiftKey) {
        e.preventDefault();
        this.performUndo();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.resizeShiftKey = false;
    });
  }

  /**
   * Arm the frame edges. Holding ⌘/Ctrl is what asks for "the frame, not the work
   * inside it", so the border bands only take the pointer while it is down.
   */
  private bindFrameResizeModifier(): void {
    const watch = (e: KeyboardEvent, armed: boolean): void => {
      if (e.key === 'Meta' || e.key === 'Control') this.setFrameResizeArmed(armed);
    };
    window.addEventListener('keydown', (e) => watch(e, true));
    window.addEventListener('keyup', (e) => watch(e, false));
    // A modifier held while the window loses focus never reports its keyup.
    window.addEventListener('blur', () => this.setFrameResizeArmed(false));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.setFrameResizeArmed(false);
    });
  }

  private setFrameResizeArmed(armed: boolean): void {
    const wrap = document.getElementById('boardWrap');
    if (!wrap || wrap.classList.contains('is-frame-resize') === armed) return;
    wrap.classList.toggle('is-frame-resize', armed);
  }

  private bindImageImport(): void {
    this.imageFileInput.addEventListener('change', () => {
      const files = Array.from(this.imageFileInput.files ?? []);
      this.imageFileInput.value = '';
      if (files.length === 0) return;
      void this.addImagesFromFiles(files);
    });
  }

  private bindImagePasteAndDrop(): void {
    window.addEventListener('paste', (e) => {
      if (this.isTextEditingTarget(e.target)) return;
      // A pattern copied out of this app is not an image file and lands as nodes
      // or pieces — see `bindClipboardShortcuts`. This listener is only the bytes.
      const files = this.imageFilesFromClipboard(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      void this.addImagesFromFiles(files);
    });

    const wrap = document.getElementById('boardWrap');
    if (!wrap) return;
    wrap.addEventListener('dragover', (e) => {
      if (!this.dataTransferHasImage(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      wrap.classList.add('is-image-drop');
    });
    wrap.addEventListener('dragleave', (e) => {
      if (e.target === wrap) wrap.classList.remove('is-image-drop');
    });
    wrap.addEventListener('drop', (e) => {
      wrap.classList.remove('is-image-drop');
      if (!this.dataTransferHasImage(e.dataTransfer)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return;
      void this.addImagesFromFiles(files, {
        clientX: e.clientX,
        clientY: e.clientY,
      });
    });
  }

  private isTextEditingTarget(target: EventTarget | null): boolean {
    const t = target as HTMLElement | null;
    if (!t) return false;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
    return Boolean(t.closest('input, textarea, [contenteditable="true"]'));
  }

  private dataTransferHasImage(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    return Array.from(dt.items).some((item) => item.kind === 'file' && item.type.startsWith('image/'));
  }

  private imageFilesFromClipboard(dt: DataTransfer | null): File[] {
    if (!dt) return [];
    const files: File[] = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });
  }

  private loadImageNaturalSize(src: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () =>
        resolve({
          w: Math.max(1, img.naturalWidth || img.width),
          h: Math.max(1, img.naturalHeight || img.height),
        });
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = src;
    });
  }

  /** Board coords under a screen point (or viewport center when omitted). */
  private boardPointFromClient(clientX?: number, clientY?: number): { x: number; y: number } {
    const wrap = document.getElementById('boardWrap');
    const rect = wrap?.getBoundingClientRect();
    const { panX, panY, zoom } = this.project.canvas;
    const mx = clientX != null && rect ? clientX - rect.left : (rect?.width ?? 800) * 0.5;
    const my = clientY != null && rect ? clientY - rect.top : (rect?.height ?? 600) * 0.5;
    return {
      x: (mx - panX) / zoom,
      y: (my - panY) / zoom,
    };
  }

  /** Ask for a file to point `node` at. Used to add a replacement or re-link. */
  private pickImageFile(node: ImageNode): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.applyImageFile(node, file);
    });
    input.click();
  }

  /** Point `node` at a new image's bytes and make sure they reach storage. */
  private async applyImageFile(node: ImageNode, file: File): Promise<void> {
    try {
      this.pushUndo();
      const src = await this.readFileAsDataUrl(file);
      const { w, h } = await this.loadImageNaturalSize(src);
      const wasMissing = !node.src;
      node.src = src;
      node.naturalAspect = w / h;
      node.label = file.name.replace(/\.[^.]+$/, '') || node.label || 'Image';
      this.refreshImageElement(node);
      this.renderInspector();
      // Re-linking an image whose bytes were lost is the point of this path, so
      // the new bytes have to actually land in storage before we claim success.
      await this.persistLocal();
      this.setStatus(wasMissing ? 'Image re-linked' : 'Image replaced');
    } catch {
      this.setStatus('Could not read that image');
    }
  }

  /** Swap the missing-note for the real image once the node has a src again. */
  private refreshImageElement(node: ImageNode): void {
    const el = this.board.querySelector(`.canvas-node[data-node-id="${node.id}"]`);
    const img = el?.querySelector('img') as HTMLImageElement | null;
    if (!img) return;
    img.alt = node.label || 'image reference';
    if (!node.src) return;
    img.hidden = false;
    img.src = node.src;
    el?.querySelector('.image-missing')?.remove();
  }

  private async addImagesFromFiles(
    files: File[],
    at?: { clientX?: number; clientY?: number }
  ): Promise<void> {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    this.pushUndo();
    const anchor = this.boardPointFromClient(at?.clientX, at?.clientY);
    const added: string[] = [];
    let offset = 0;
    for (const file of images) {
      try {
        const src = await this.readFileAsDataUrl(file);
        if (!src) continue;
        const { w: nw, h: nh } = await this.loadImageNaturalSize(src);
        const maxEdge = 420;
        const scale = Math.min(1, maxEdge / Math.max(nw, nh));
        const width = Math.max(120, Math.round(nw * scale));
        const height = Math.max(90, Math.round(nh * scale));
        const label = file.name?.replace(/\.[^.]+$/, '') || 'Reference';
        const node: ImageNode = {
          type: 'image',
          id: uid('node'),
          x: anchor.x - width / 2 + offset,
          y: anchor.y - height / 2 + offset,
          width,
          height,
          zIndex: 40 + this.project.canvas.nodes.length,
          src,
          label,
          naturalAspect: nw / nh,
        };
        this.project.canvas.nodes.push(node);
        this.mountNode(node);
        added.push(node.id);
        offset += 24;
      } catch {
        this.setStatus(`Could not load image “${file.name}”`);
      }
    }
    if (added.length > 0) this.selectNodes(added);
    this.layoutNodes();
    this.drawWires();
    this.renderInspector();
    this.markDirty();
    void this.persistLocal();
    this.setStatus(
      images.length === 1 ? 'Image reference placed on canvas' : `${images.length} image references placed`
    );
  }

  private restartAutosave(): void {
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    const minutes = getAutosaveIntervalMinutes();
    if (minutes <= 0) return;
    this.autosaveTimer = setInterval(
      () => this.persistLocal({ label: 'Auto-saved' }),
      minutes * 60 * 1000
    );
  }

  private switchToProject(project: ProjectDocument, opts: { resetUndo?: boolean } = {}): void {
    this.project = this.prepareLoadedProject(project);
    void setActiveProjectId(project.id);
    this.markDirty();
    this.selectedNodeIds = [];
    this.selectedNodeId = null;
    this.transformInspectorPieceId = null;
    if (opts.resetUndo !== false) {
      this.undoStack.clear();
      this.updateHistoryButtons();
    }
    this.teardownSims();
    this.syncProjectChrome();
    this.renderAll();
    void this.initGpuAndSims();
  }

  /**
   * Point the toolbar's document-mirroring chrome at the current project.
   *
   * Called on every project switch, not just at build time: the toolbar is
   * built against a placeholder project *before* the saved one loads, so a
   * one-shot sync would leave the units label showing the placeholder's unit.
   */
  private syncProjectChrome(): void {
    const name = this.toolbar.querySelector('#activeName');
    if (name) name.textContent = this.project.name;
    this.updateUnitRows();
  }

  private bindImportFile(): void {
    this.importFileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const project = await importProjectFile(file);
          const { write } = await saveProjectToLibrary(project);
          this.switchToProject(project);
          if (!write.ok) {
            this.setStatus(write.error ?? 'Import loaded, but local save failed');
          } else {
            this.setStatus(`Imported “${project.name}”`);
          }
          this.closeModal();
        } catch (err) {
          alert(`Import failed: ${err}`);
        }
      })();
      (e.target as HTMLInputElement).value = '';
    });
  }

  private closeModal(): void {
    // Undo/redo remounts the canvas; don't dismiss an open dialog as a side effect.
    if (this.restoringUndo) return;
    // Flushes any pending write before the dialog is torn down.
    this.avatarModal?.close();
    this.avatarModal = null;
    this.avatarPreview?.destroy();
    this.avatarPreview = null;
    this.avatarPreviewCanvas = null;
    this.modalRoot.hidden = true;
    this.modalRoot.innerHTML = '';
  }

  private openAvatarEditor(): void {
    this.modalRoot.hidden = false;
    const modal = new AvatarModal(this.modalRoot, {
      onClose: () => this.closeModal(),
      onChange: (library) => {
        const active = library.sets.find((s) => s.id === library.activeId) ?? library.sets[0];
        this.setStatus(
          active
            ? `Avatars · ${active.name} (${library.sets.length} ${library.sets.length === 1 ? 'avatar' : 'avatars'})`
            : 'Avatars updated'
        );
        // Rulers are sized and labelled from these numbers — repaint them.
        this.refreshRulerLibraries();
      },
      onGenerate: (avatar, setStatus, options) => this.generateAvatarFor(avatar, setStatus, options),
      onPreview: (avatar, elements, setStatus) => this.previewAvatarFor(avatar, elements, setStatus),
      onPreviewDispose: (canvas) => this.disposeAvatarPreview(canvas),
      onShowRulers: (show) => {
        this.avatarRulersVisible = show;
        this.avatarPreview?.setShowRulers(show);
      },
      onHighlightField: (field) => this.avatarPreview?.setHighlightField(field),
    });
    this.avatarModal = modal;
    void modal.open();
  }

  private disposeAvatarPreview(canvas: HTMLCanvasElement): void {
    if (this.avatarPreviewCanvas !== canvas) return;
    this.avatarPreview?.destroy();
    this.avatarPreview = null;
    this.avatarPreviewCanvas = null;
  }

  /** Render the 3D preview + measurement rulers (no sim changes). */
  private async previewAvatarFor(
    avatar: Avatar,
    elements: AvatarPreviewElements,
    setStatus: (text: string) => void
  ): Promise<AvatarReport | null> {
    try {
      if (!this.device) {
        setStatus('Starting WebGPU…');
        const gpu = await createSharedGpu();
        this.device = gpu.device;
      }
      if (this.avatarPreviewCanvas !== elements.canvas || !this.avatarPreview) {
        this.avatarPreview?.destroy();
        this.avatarPreview = new AvatarPreview(elements.canvas, elements.overlay, this.device);
        this.avatarPreviewCanvas = elements.canvas;
        this.avatarPreview.setShowRulers(this.avatarRulersVisible);
      }
      setStatus('');
      const mesh = await buildAvatarMeshes(avatar);
      this.avatarPreview.setMesh(mesh.render.positions, mesh.render.indices);
      this.avatarPreview.setRulers(
        buildMeasurementRulers(
          mesh.positions,
          mesh.measured,
          new Set(mesh.driven),
          avatar.unit,
          mesh.rulerPolylines
        )
      );
      return {
        heightCm: mesh.heightCm,
        measured: mesh.measured,
        saturated: mesh.saturated,
        driven: mesh.driven,
      };
    } catch (err) {
      setStatus(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Put the project's generated body back under the cloth.
   *
   * Which body the cloth collides against lives in the avatar body instance, not
   * in the project file, and a reload used to start every viewport on the
   * bundled reference body: a garment was sewn and fitted against the generated
   * avatar, and nothing told the sim which one that was. The avatar a project
   * was built against *is* stored — the library keeps the generated model key
   * and the collision resolution it was generated with — so load it back the way
   * the Avatars editor applies one, and re-apply the same body to any runtime
   * rebuilt later (a board remount, undo, a project switch).
   */
  private async restoreStoredAvatar(): Promise<void> {
    if (!this.device) return;
    const library = await loadAvatarLibrary();
    const active = library.sets.find((s) => s.id === library.activeId) ?? library.sets[0];
    // A 2D avatar has no generated model to restore, so the bundled body stands.
    if (!active || active.kind !== '3d') return;

    const key = `${avatarCacheKeyFor(active)}|${active.sdfResolution ?? 'triangle'}`;
    if (this.restoredAvatar?.key === key) {
      this.applyAvatarBody(this.restoredAvatar.body);
      return;
    }

    const { body, collision } = await createAvatarBodyFromAvatar(this.device, active, {
      sdfResolution: active.sdfResolution || undefined,
    });
    this.restoredAvatar = { key, body };
    this.applyAvatarBody(body);
    this.setStatus(`Avatar “${active.name}” restored — ${collisionSummaryText(collision)}`);
  }

  /** Aim every sim and transform viewport at `body`, and refresh their overlays. */
  private applyAvatarBody(body: AvatarBody): void {
    for (const rt of this.simRuntimes.values()) rt.setAvatarBody(body);
    for (const rt of this.transformRuntimes.values()) rt.setAvatarBody(body);
    resetAvatarOverlayCache();
    for (const ed of this.editors.values()) ed.reloadAvatarOverlay();
  }

  /**
   * Generate a 3D body for `avatar` from its measurements and push it into every
   * sim / transform viewport. Returns a report for the editor.
   */
  private async generateAvatarFor(
    avatar: Avatar,
    setStatus: (text: string) => void,
    options: AvatarGenerationOptions
  ): Promise<AvatarReport | null> {
    try {
      if (!this.device) {
        setStatus('Starting WebGPU…');
        const gpu = await createSharedGpu();
        this.device = gpu.device;
      }

      const say = (text: string) => {
        setStatus(text);
        this.setStatus(text);
      };
      say('Generating body…');
      const { body, mesh, collision } = await createAvatarBodyFromAvatar(this.device, avatar, {
        sdfResolution: options.sdfResolution,
        // Both lines, seconds included: a bake that stalls shows a rising clock
        // instead of a frozen "generating body".
        onProgress: (value, elapsedMs) =>
          say(
            `Baking collision SDF… ${Math.round(value * 100)}% · ${Math.max(0, elapsedMs / 1000).toFixed(0)} s`
          ),
      });

      this.applyAvatarBody(body);

      await updateAvatar(avatar.id, {
        kind: '3d',
        model: {
          cacheKey: mesh.cacheKey,
          ...(options.sdfResolution ? { sdfResolution: options.sdfResolution } : {}),
        },
        ...(options.sdfResolution ? { sdfResolution: options.sdfResolution } : {}),
      });

      // Say what the drape is now colliding against, and whether it had to be
      // built from scratch (which is where the seconds go).
      const collisionText = collisionSummaryText(collision);
      const reused = collision.meshFromCache ? ' · mesh reused' : ` · ${(collision.totalMs / 1000).toFixed(1)} s`;
      this.setStatus(
        `Generated avatar “${avatar.name}” — ${mesh.heightCm.toFixed(0)} cm · ${collisionText}${reused}`
      );
      return {
        heightCm: mesh.heightCm,
        measured: mesh.measured,
        saturated: mesh.saturated,
        driven: mesh.driven,
        applied: true,
        collision,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Generation failed: ${message}`);
      this.setStatus(`Avatar generation failed: ${message}`);
      return null;
    }
  }

  /** Re-label every open pattern editor after the measurement library changes. */
  private refreshRulerLibraries(): void {
    for (const editor of this.editors.values()) editor.reloadRulers();
  }

  private openNewProjectPrompt(): void {
    this.modalRoot.hidden = false;
    this.modalRoot.innerHTML = `
      <div class="studio-modal-backdrop" data-modal-dismiss>
        <div class="studio-modal studio-modal-sm" role="dialog" aria-labelledby="newProjectTitle">
          <h2 id="newProjectTitle">Start new project?</h2>
          <p class="muted">Save “${this.escapeHtml(this.project.name)}” before discarding it?</p>
          <div class="studio-modal-actions">
            <button type="button" class="primary" data-new-act="save">Save &amp; start new</button>
            <button type="button" data-new-act="discard">Discard</button>
            <button type="button" data-new-act="cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    this.modalRoot.querySelector('[data-modal-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closeModal();
    });
    this.modalRoot.querySelector('[data-new-act="save"]')?.addEventListener('click', () => {
      this.persistLocal();
      this.startNewProject();
      this.closeModal();
    });
    this.modalRoot.querySelector('[data-new-act="discard"]')?.addEventListener('click', () => {
      this.startNewProject();
      this.closeModal();
    });
    this.modalRoot.querySelector('[data-new-act="cancel"]')?.addEventListener('click', () => {
      this.closeModal();
    });
  }

  private startNewProject(): void {
    void (async () => {
      const project = ensureVisibleConnections(createDefaultProject());
      const { write } = await saveProjectToLibrary(project);
      this.switchToProject(project);
      if (!write.ok) {
        this.setStatus(write.error ?? 'New project started, but local save failed');
      } else {
        this.setStatus('New project started');
      }
    })();
  }

  private openProjectsModal(): void {
    this.modalRoot.hidden = false;
    void this.renderProjectsModal();
  }

  private async renderProjectsModal(): Promise<void> {
    const projects = await listSavedProjects();
    const est = await getStorageEstimate();
    const storageHint =
      est.usage != null && est.quota != null
        ? ` · ${(est.usage / (1024 * 1024)).toFixed(1)} / ${(est.quota / (1024 * 1024)).toFixed(1)} MB used`
        : '';
    const rows =
      projects.length === 0
        ? `<p class="muted studio-modal-empty">No saved projects yet.</p>`
        : projects
            .map((record) => {
              const isActive = record.id === this.project.id;
              return `
                <li class="project-row ${isActive ? 'is-active' : ''}" data-project-id="${record.id}">
                  <div class="project-row-main">
                    <strong>${this.escapeHtml(record.name)}</strong>
                    <span class="muted">${formatProjectDate(record.updatedAt)}${isActive ? ' · current' : ''}</span>
                  </div>
                  <div class="project-row-actions">
                    <button type="button" data-project-act="load" ${isActive ? 'disabled' : ''}>Load</button>
                    <button type="button" data-project-act="export">Export</button>
                    <button type="button" class="danger" data-project-act="delete">Delete</button>
                  </div>
                </li>
              `;
            })
            .join('');

    this.modalRoot.innerHTML = `
      <div class="studio-modal-backdrop" data-modal-dismiss>
        <div class="studio-modal studio-modal-lg" role="dialog" aria-labelledby="projectsTitle">
          <div class="studio-modal-header">
            <h2 id="projectsTitle">Projects</h2>
            <button type="button" class="studio-modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <p class="muted">Current: <strong>${this.escapeHtml(this.project.name)}</strong>${storageHint}</p>
          <div class="studio-modal-toolbar">
            <button type="button" class="primary" data-projects-act="save">Save current</button>
            <button type="button" data-projects-act="import">Import</button>
            <button type="button" data-projects-act="export-archive">Export archive</button>
            <label class="autosave-field">
              Auto-save every
              <input type="number" id="autosaveMinutes" min="0" max="120" step="1" value="${getAutosaveIntervalMinutes()}" />
              min
            </label>
            <span class="muted autosave-hint">0 disables · default ${DEFAULT_AUTOSAVE_MINUTES}</span>
          </div>
          <ul class="project-list">${rows}</ul>
        </div>
      </div>
    `;

    this.modalRoot.querySelector('[data-modal-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closeModal();
    });
    this.modalRoot.querySelector('[data-modal-close]')?.addEventListener('click', () => {
      this.closeModal();
    });
    this.modalRoot.querySelector('[data-projects-act="save"]')?.addEventListener('click', () => {
      void this.persistLocal().then(() => this.renderProjectsModal());
    });
    this.modalRoot.querySelector('[data-projects-act="import"]')?.addEventListener('click', () => {
      this.importFileInput.click();
    });
    this.modalRoot.querySelector('[data-projects-act="export-archive"]')?.addEventListener('click', () => {
      this.persistSimStates();
      void exportProjectFile(this.project, true);
    });
    this.modalRoot.querySelector('#autosaveMinutes')?.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const minutes = parseFloat(input.value);
      const next = Number.isFinite(minutes) ? minutes : DEFAULT_AUTOSAVE_MINUTES;
      setAutosaveIntervalMinutes(next);
      input.value = String(getAutosaveIntervalMinutes());
      this.restartAutosave();
      const m = getAutosaveIntervalMinutes();
      this.setStatus(
        m <= 0 ? 'Auto-save disabled' : `Auto-save every ${m} min`
      );
    });

    this.modalRoot.querySelectorAll('.project-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-project-act]');
        if (!btn || btn.disabled) return;
        e.stopPropagation();
        const id = (row as HTMLElement).dataset.projectId!;
        const act = btn.dataset.projectAct!;
        void (async () => {
          if (act === 'load') {
            const project = await getSavedProject(id);
            if (project) {
              this.switchToProject(project);
              this.setStatus(`Loaded “${project.name}”`);
              this.closeModal();
            }
          } else if (act === 'export') {
            const record = projects.find((p) => p.id === id);
            if (!record) return;
            if (id === this.project.id) this.persistSimStates();
            if (id === this.project.id) {
              await exportProjectFile(this.project, true);
            } else {
              const loaded = await getSavedProject(id);
              if (loaded) await exportProjectFile(loaded, true);
            }
          } else if (act === 'delete') {
            const record = projects.find((p) => p.id === id);
            if (!record) return;
            if (!confirm(`Delete “${record.name}”? This cannot be undone.`)) return;
            const wasActive = id === this.project.id;
            await deleteProjectFromLibrary(id);
            if (wasActive) {
              const nextId = await getActiveProjectId();
              const next =
                (nextId ? await getSavedProject(nextId) : null) ??
                ensureVisibleConnections(createDefaultProject());
              if (!(await getSavedProject(next.id))) {
                await saveProjectToLibrary(next);
              }
              this.switchToProject(next);
              this.setStatus(`Deleted “${record.name}”`);
              this.closeModal();
            } else {
              void this.renderProjectsModal();
              this.setStatus(`Deleted “${record.name}”`);
            }
          }
        })();
      });
    });
  }

  private downloadJson(json: string, filename: string): void {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Label row: name + ⓘ on the left, numeric readout flush right.
   * Pass `valueId` so sliders can update `#${valueId}` live.
   */
  private paramTip(name: string, tip: string, value = '', valueId?: string): string {
    const valueAttr = valueId ? ` id="${valueId}"` : '';
    return `<span class="inspector-label-row"><span class="inspector-label-left">${this.escapeHtml(name)}<button type="button" class="inspector-tip" aria-label="About ${this.escapeHtml(name)}" data-tip="${this.escapeHtml(tip)}">i</button></span><span class="inspector-param-value"${valueAttr}>${this.escapeHtml(value)}</span></span>`;
  }

  private ensureInspectorTipEl(): HTMLDivElement {
    if (!this.inspectorTipEl) {
      const el = document.createElement('div');
      el.className = 'inspector-floating-tip';
      el.hidden = true;
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
      this.inspectorTipEl = el;
      this.inspector.addEventListener('scroll', () => this.hideInspectorTip(), { passive: true });
    }
    return this.inspectorTipEl;
  }

  private hideInspectorTip(): void {
    if (this.inspectorTipEl) this.inspectorTipEl.hidden = true;
  }

  private showInspectorTip(anchor: HTMLElement): void {
    const text = anchor.dataset.tip ?? '';
    if (!text) return;
    const tip = this.ensureInspectorTipEl();
    tip.textContent = text;
    tip.hidden = false;
    tip.style.visibility = 'hidden';
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const r = anchor.getBoundingClientRect();
    const pad = 8;
    // Prefer left of the icon (inspector is on the right); flip if needed.
    let left = r.left - tw - pad;
    if (left < pad) left = Math.min(r.right + pad, window.innerWidth - tw - pad);
    let top = r.top + r.height / 2 - th / 2;
    top = Math.max(pad, Math.min(top, window.innerHeight - th - pad));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = 'visible';
  }

  /** Wire ⓘ buttons to a body-level floating tip (not clipped by overflow). */
  private bindInspectorTips(): void {
    this.hideInspectorTip();
    this.inspector.querySelectorAll('.inspector-tip').forEach((btn) => {
      const el = btn as HTMLElement;
      el.addEventListener('click', (e) => e.preventDefault());
      el.addEventListener('mouseenter', () => this.showInspectorTip(el));
      el.addEventListener('mouseleave', () => this.hideInspectorTip());
      el.addEventListener('focus', () => this.showInspectorTip(el));
      el.addEventListener('blur', () => this.hideInspectorTip());
    });
  }

  /**
   * Messages used to live in a permanent strip under the board. It cost 25px of
   * canvas at all times to say "Auto-saved" — so the strip is gone and a message
   * is a toast that appears, then gets out of the way.
   */
  private setStatus(msg: string): void {
    window.clearTimeout(this.toastTimer);
    if (!msg) {
      this.toastEl.hidden = true;
      this.toastEl.textContent = '';
      return;
    }
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.hidden = true;
    }, 4200);
  }

  /**
   * The toolbar floats over the board, so the rail and the canvas overlays have
   * to start below it — and its height changes when the buttons wrap. Publish
   * the height as a variable and let the stylesheet position against it, rather
   * than hard-coding a number that is wrong as soon as the window narrows.
   */
  private trackToolbarHeight(): void {
    const studio = this.toolbar.parentElement;
    if (!studio) return;
    const publish = (): void => {
      studio.style.setProperty('--toolbar-height', `${this.toolbar.getBoundingClientRect().height}px`);
    };
    publish();
    new ResizeObserver(publish).observe(this.toolbar);
  }

  /**
   * The page's own chrome: a menu button and the name of the file it is showing,
   * over a gradient rather than in a bar. Everything the bar used to carry is a
   * row in the menu, which is where "new project / save / units" belongs once you
   * are looking at the canvas rather than at the application.
   */
  private buildToolbar(): void {
    this.toolbar.innerHTML = `
      <button type="button" class="menu-toggle" data-act="menu" aria-label="Project menu" aria-haspopup="menu" aria-expanded="false" title="Project menu">
        <i data-lucide="menu" aria-hidden="true"></i>
      </button>
      <button type="button" class="active-file" id="activeNameBtn" title="Click to rename this project">
        <span class="active-file-name" id="activeName"></span>
      </button>
      <div class="doc-menu">
        <button type="button" class="doc-caret" data-doc-toggle aria-haspopup="menu" aria-expanded="false" aria-label="File menu" title="Save, rename, or open another project">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M3.6 6.2 8 10.4 12.4 6.2"/></svg>
        </button>
        <div class="doc-popover" hidden role="menu" aria-label="File"></div>
      </div>
      <div class="toolbar-popover app-menu" id="appMenu" hidden role="menu" aria-label="Application">
        <button type="button" data-act="undo" role="menuitem" disabled>Undo<span class="app-menu-key">⌘Z</span></button>
        <button type="button" data-act="redo" role="menuitem" disabled>Redo<span class="app-menu-key">⇧⌘Z</span></button>
        <div class="app-menu-sep"></div>
        <button type="button" data-act="avatars" role="menuitem">Avatars…</button>
        <div class="app-menu-sep"></div>
        <span class="app-menu-label">Display units</span>
        <button type="button" data-unit="cm" role="menuitemradio">Centimetres<span class="app-menu-key">cm</span></button>
        <button type="button" data-unit="in" role="menuitemradio">Inches<span class="app-menu-key">in</span></button>
      </div>
    `;
    this.syncProjectChrome();
    this.updateHistoryButtons();
    this.toolbar.addEventListener('click', (e) => {
      const unitChoice = (e.target as HTMLElement).closest(
        'button[data-unit]'
      ) as HTMLButtonElement | null;
      if (unitChoice) {
        this.setDisplayUnit(unitChoice.dataset.unit === 'in' ? 'in' : 'cm');
        return;
      }
      const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      void this.onToolbar(btn.dataset.act!);
    });
    this.bindAppMenu();
    this.bindDocMenu();
    this.bindDocMenuDismiss();
    this.bindTitleRename();
    this.updateUnitRows();
    // Swap every <i data-lucide="…"> for its inline SVG.
    createIcons({ icons: { Menu, Undo2, Redo2 } });
  }

  /** The menu closes on the things a menu is expected to close on. */
  private bindAppMenu(): void {
    const menu = this.appMenu();
    if (!menu) return;
    document.addEventListener('pointerdown', (e) => {
      if (menu.hidden) return;
      const target = e.target as Node;
      if (menu.contains(target) || this.toolbar.contains(target)) return;
      this.setAppMenuOpen(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) this.setAppMenuOpen(false);
    });
    window.addEventListener('resize', () => this.setAppMenuOpen(false));
  }

  private appMenu(): HTMLElement | null {
    return this.toolbar.querySelector('.app-menu') as HTMLElement | null;
  }

  private setAppMenuOpen(open: boolean): void {
    const menu = this.appMenu();
    const toggle = this.toolbar.querySelector('button[data-act="menu"]') as HTMLButtonElement | null;
    if (!menu || !toggle) return;
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('is-open', open);
  }

  /**
   * Both units spelled out on the menu's rows, with the live one marked — the
   * unit is a setting with two named values, so it reads better as a choice than
   * as a button that silently flips when pressed.
   */
  private updateUnitRows(): void {
    this.appMenu()
      ?.querySelectorAll('button[data-unit]')
      .forEach((row) => {
        const el = row as HTMLButtonElement;
        const mine = el.dataset.unit === this.project.displayUnit;
        el.classList.toggle('is-active', mine);
        el.setAttribute('aria-checked', String(mine));
      });
  }

  /** Display units are document data, so every canvas follows and the file records it. */
  private setDisplayUnit(unit: 'cm' | 'in'): void {
    this.setAppMenuOpen(false);
    if (this.project.displayUnit === unit) return;
    this.pushUndo();
    this.project.displayUnit = unit;
    this.updateUnitRows();
    this.editors.forEach((ed) => ed.setUnit(unit));
    this.meshPreviews.forEach((p) => p.setUnit(unit));
    this.markDirty();
  }

  private async onToolbar(act: string): Promise<void> {
    // Every row here acts on the document, so the menu gets out of the way
    // first — the toggle is the only one that is about the menu itself.
    if (act !== 'menu') this.setAppMenuOpen(false);
    switch (act) {
      case 'undo':
        this.performUndo();
        break;
      case 'redo':
        this.performRedo();
        break;
      case 'new':
        this.openNewProjectPrompt();
        break;
      case 'projects':
        this.openProjectsModal();
        break;
      case 'save':
        await this.persistLocal({ label: 'Saved' });
        break;
      case 'menu':
        this.setAppMenuOpen(this.appMenu()?.hidden ?? true);
        break;
      case 'measurements':
      case 'avatars':
        this.openAvatarEditor();
        break;
    }
  }

  private nodeMenu: HTMLElement | null = null;

  /**
   * Right-click on the board: a node gets its duplicate / delete popover, empty
   * canvas gets the Add menu that puts a new node under the pointer.
   */
  private bindNodeContextMenu(): void {
    const wrap = document.getElementById('boardWrap')!;
    wrap.addEventListener('contextmenu', (e) => {
      const el = (e.target as HTMLElement).closest('.canvas-node') as HTMLElement | null;
      const node = el
        ? this.project.canvas.nodes.find((n) => n.id === el.dataset.nodeId)
        : undefined;
      e.preventDefault();
      if (node) this.showNodeMenu(node, e.clientX, e.clientY);
      else this.showBoardMenu(e.clientX, e.clientY);
    });
    // Any press elsewhere, plus Esc / resize / pan / zoom, dismisses the popover.
    document.addEventListener('pointerdown', () => this.closeNodeMenu());
    window.addEventListener('resize', () => this.closeNodeMenu());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeNodeMenu();
    });
  }

  private showNodeMenu(node: CanvasNode, clientX: number, clientY: number): void {
    // Right-clicking inside a group keeps it: the menu then acts on all of it.
    if (this.isNodeSelected(node.id)) this.selectNodes(this.selectedNodeIds, node.id);
    else this.selectNodes([node.id]);
    this.openNodeMenu(node, clientX, clientY);
  }

  private openNodeMenu(node: CanvasNode, clientX: number, clientY: number): void {
    this.closeNodeMenu();
    const count = this.selectedNodeIds.length;
    const many = count > 1;
    const menu = document.createElement('div');
    menu.className = 'node-context-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <p class="node-context-title">${
        many ? this.escapeHtml(`${count} nodes selected`) : this.escapeHtml(this.nodeLabel(node))
      }</p>
      ${
        node.type === 'text'
          ? '<button type="button" role="menuitem" data-node-act="rasterize">Rasterize to pieces</button>'
          : ''
      }
      <button type="button" role="menuitem" data-node-act="copy">Copy<span class="app-menu-key">⌘C</span></button>
      <button type="button" role="menuitem" data-node-act="duplicate">Duplicate ${
        many ? `${count} nodes` : 'node'
      }</button>
      <button type="button" role="menuitem" data-node-act="delete" class="is-danger">Delete ${
        many ? `${count} nodes` : 'node'
      }</button>
    `;
    // Keep the press inside the popover from reaching the dismiss listener.
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest(
        'button[data-node-act]'
      ) as HTMLButtonElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.nodeAct;
      this.closeNodeMenu();
      if (act === 'rasterize' && node.type === 'text') {
        this.rasterizeTextNode(node);
      } else if (act === 'copy') {
        this.copySelection();
      } else if (act === 'duplicate') {
        this.duplicateNodeGroup(this.selectedNodeIds, { offsetX: 32, offsetY: 32 });
      } else if (act === 'delete') {
        this.deleteSelectedNodes();
      }
    });
    this.mountBoardPopover(menu, clientX, clientY);
  }

  /** The Add menu: a right-click on empty canvas drops a node where you clicked. */
  private showBoardMenu(clientX: number, clientY: number): void {
    this.closeNodeMenu();
    const menu = document.createElement('div');
    menu.className = 'node-context-menu board-context-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <p class="node-context-title">Add to canvas</p>
      <button type="button" role="menuitem" data-board-act="pattern">New pattern <span class="board-menu-kind">2D</span></button>
      <button type="button" role="menuitem" data-board-act="sim">New drape <span class="board-menu-kind">3D</span></button>
      <button type="button" role="menuitem" data-board-act="text">Text</button>
      <button type="button" role="menuitem" data-board-act="section">Section</button>
      <button type="button" role="menuitem" data-board-act="image">Image reference…</button>
      <div class="app-menu-sep"></div>
      <button type="button" role="menuitem" data-board-act="paste"${
        getClipboard() ? '' : ' disabled'
      }>Paste<span class="app-menu-key">⌘V</span></button>
    `;
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest(
        'button[data-board-act]'
      ) as HTMLButtonElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.boardAct;
      const at = { clientX, clientY };
      this.closeNodeMenu();
      if (act === 'pattern') {
        this.pushUndo();
        this.addPatternFrame(at);
      } else if (act === 'sim') {
        this.pushUndo();
        this.addSimViewport(at);
      } else if (act === 'section') {
        const point = this.boardPointFromClient(at.clientX, at.clientY);
        const cm = canvasCmScale(this.project);
        this.addSection({ x: point.x / cm, y: point.y / cm, w: 0, h: 0 });
      } else if (act === 'text') {
        // A click-placed text object: it sizes itself to what is typed.
        const point = this.boardPointFromClient(at.clientX, at.clientY);
        const cm = canvasCmScale(this.project);
        this.addTextObject({ x: point.x / cm, y: point.y / cm, w: 0, h: 0 });
      } else if (act === 'image') {
        // The picker writes into the same input paste and drop use.
        this.imageFileInput.click();
      } else if (act === 'paste') {
        this.pasteClipboard({ clientX, clientY });
      }
    });
    this.mountBoardPopover(menu, clientX, clientY);
  }

  /** Foot a board popover at the pointer, nudged to stay inside the window. */
  private mountBoardPopover(menu: HTMLElement, clientX: number, clientY: number): void {
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    document.body.appendChild(menu);
    this.nodeMenu = menu;

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
  }

  private closeNodeMenu(): void {
    this.nodeMenu?.remove();
    this.nodeMenu = null;
  }

  private bindBoardPan(): void {
    const wrap = document.getElementById('boardWrap')!;
    // A press means the drawing is about to be read or hit-tested, and a frozen
    // layer is scaled rather than drawn: what an editor measures against its own
    // layout would not be where the pointer is. End the gesture and let it be
    // exact. Capture phase, because a node stops its own presses on the way up.
    wrap.addEventListener('pointerdown', () => this.endZoomGesture(), true);
    // Any press elsewhere dismisses the prompt, including one that starts a drag
    // from the terminal itself. Capture phase, before the port reads the press.
    wrap.addEventListener(
      'pointerdown',
      (e) => {
        if (this.drapeOffer && e.target !== this.drapeOffer.button) this.hideDrapeOffer();
      },
      true
    );
    wrap.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.canvas-node')) return;
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        this.panning = true;
        this.panLast = { x: e.clientX, y: e.clientY };
        wrap.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      // A press on a control is a press on the control: the rail and the ribbons
      // stand over the page, and none of them is a place to start a selection.
      if (target.closest('button, input, textarea, select, label, [role="menu"]')) return;
      // The page's own editor reads the press first (it is nearer the pointer), so
      // if it has taken it — drawing, dragging a point, or drawing its own
      // rectangle — the press is the page's and this handler has nothing to add.
      if (this.canvasEditor?.isGestureActive()) return;
      // Otherwise an empty-canvas drag selects nodes, with or without ⌘/Ctrl: the
      // page's tools may have nothing to do here, and a drag on bare canvas
      // meaning "select" is the same gesture the 2D view already offers.
      this.beginNodeMarquee(e);
    });
    // Suppress browser middle-click autoscroll affordance on the board.
    wrap.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    wrap.addEventListener('pointermove', (e) => {
      if (this.nodeMarquee) {
        this.updateNodeMarquee(e);
        return;
      }
      if (this.wireDrag) {
        const rect = wrap.getBoundingClientRect();
        this.wireDrag.x = e.clientX - rect.left;
        this.wireDrag.y = e.clientY - rect.top;
        this.drawWires();
        this.highlightWireTarget(e.clientX, e.clientY);
        return;
      }
      if (this.panning) {
        const dx = e.clientX - this.panLast.x;
        const dy = e.clientY - this.panLast.y;
        this.panLast = { x: e.clientX, y: e.clientY };
        this.project.canvas.panX += dx;
        this.project.canvas.panY += dy;
        this.applyBoardTransform();
        this.drawWires();
        return;
      }
      if (this.resizingNode) {
        this.resizeShiftKey = e.shiftKey;
        this.applyNodeResize(e.clientX, e.clientY);
        return;
      }
      if (this.draggingNodes) {
        const zoom = this.project.canvas.zoom;
        for (const drag of this.draggingNodes) {
          const node = this.project.canvas.nodes.find((n) => n.id === drag.id);
          if (!node) continue;
          node.x = (e.clientX - this.project.canvas.panX) / zoom - drag.ox;
          node.y = (e.clientY - this.project.canvas.panY) / zoom - drag.oy;
        }
        this.layoutNodes();
        this.drawWires();
      }
    });
    wrap.addEventListener('pointerup', (e) => {
      if (this.nodeMarquee) {
        this.finishNodeMarquee();
        try {
          wrap.releasePointerCapture(e.pointerId);
        } catch {
          /* capture may already be released */
        }
      }
      if (this.wireDrag) {
        this.finishWireDrag(e.clientX, e.clientY);
        try {
          wrap.releasePointerCapture(e.pointerId);
        } catch {
          /* capture may already be released */
        }
      }
      // A move or a resize is a document edit: without this it would only reach
      // the file on the next autosave.
      if (this.draggingNodes || this.resizingNode) {
        this.markDirty();
        // A section holds what is inside it, so a drag or a resize can change what
        // it holds without touching the section at all — say so as it happens.
        this.refreshSectionTally();
      }
      this.panning = false;
      this.draggingNodes = null;
      this.resizingNode = null;
    });
    wrap.addEventListener('pointercancel', () => {
      this.cancelWireDrag();
      this.cancelNodeMarquee();
      this.panning = false;
      this.draggingNodes = null;
      this.resizingNode = null;
    });
    wrap.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // A trackpad sends several of these per frame, and each one would restate
        // the whole board — every container's chrome, the page's grid, the wires.
        // Gather a frame's worth and apply them together; the steps compose, so a
        // flick still travels exactly as far as it asked to.
        const step = e.deltaY > 0 ? 0.9 : 1.1;
        if (this.pendingZoom) {
          this.pendingZoom.factor *= step;
          this.pendingZoom.clientX = e.clientX;
          this.pendingZoom.clientY = e.clientY;
        } else {
          this.pendingZoom = { factor: step, clientX: e.clientX, clientY: e.clientY };
        }
        if (!this.zoomRaf) {
          this.zoomRaf = requestAnimationFrame(() => this.flushBoardZoom());
        }
      },
      { passive: false }
    );
  }

  /**
   * Bring the frames on screen into step with the board's zoom.
   *
   * Two things keep this cheap enough to run on a gesture. A frame that is not on
   * the canvas is skipped outright and remembered (`culledContainers`): it does not
   * need to follow a zoom nobody can see, and it is caught up the moment it comes
   * back into view — which is what `wasZoom` being false is for, since a pan is
   * when a culled frame usually returns. Everything else is restated through
   * `restateContainer`, which lets a moving zoom leave the chrome behind and
   * repaints at once for anything that changes the drawing itself.
   */
  private syncContainerDetail(zoomChanged: boolean): void {
    const culled = this.culledContainers;
    if (!zoomChanged && culled.size === 0) return;
    const view = this.boardViewportRect(CONTAINER_CULL_MARGIN_PX);
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame') continue;
      const editor = this.editors.get(node.id);
      if (!editor) continue;
      if (!zoomChanged && !culled.has(node.id)) continue;
      if (!nodeBoxIntersects(node, view)) {
        culled.add(node.id);
        continue;
      }
      culled.delete(node.id);
      editor.restateContainer(
        this.containerModeFor(node, this.expandedNodeId === node.id),
        CONTAINER_CHROME_TOLERANCE
      );
    }
    if (zoomChanged) this.scheduleChromeSettle();
  }

  /** The canvas-space rectangle the board is showing, grown by `marginPx`. */
  private boardViewportRect(marginPx: number): Rect {
    const wrap = document.getElementById('boardWrap');
    const { panX, panY, zoom } = this.project.canvas;
    const width = (wrap?.clientWidth ?? 0) / zoom;
    const height = (wrap?.clientHeight ?? 0) / zoom;
    const margin = marginPx / zoom;
    return {
      x: -panX / zoom - margin,
      y: -panY / zoom - margin,
      w: width + margin * 2,
      h: height + margin * 2,
    };
  }

  /** Apply the wheel events gathered since the last frame — once. */
  private flushBoardZoom(): void {
    this.zoomRaf = 0;
    const pending = this.pendingZoom;
    this.pendingZoom = null;
    const wrap = document.getElementById('boardWrap');
    if (!pending || !wrap) return;

    const { panX, panY, zoom: oldZoom } = this.project.canvas;
    const newZoom = Math.min(
      MAX_BOARD_ZOOM,
      Math.max(MIN_BOARD_ZOOM, oldZoom * pending.factor)
    );
    if (newZoom === oldZoom) return;

    // Zoom toward the cursor: keep the board point under the pointer fixed on
    // screen. Composing the steps and doing this once is the same as doing it per
    // step, as long as the anchor does not move — and the last event's anchor is
    // where the pointer actually is.
    const rect = wrap.getBoundingClientRect();
    const mx = pending.clientX - rect.left;
    const my = pending.clientY - rect.top;
    // A gesture is a *run* of steps. The first one is drawn the ordinary way —
    // one step is one repaint, and drawing it means a single notch of the wheel
    // stays sharp — and a step that follows it inside the settle window opens the
    // freeze instead, over the view the layers were drawn at.
    const previousFlush = this.lastZoomFlushAt;
    this.lastZoomFlushAt = performance.now();
    if (!this.zoomGesture.active && performance.now() - previousFlush <= ZOOM_GESTURE_SETTLE_MS) {
      this.beginZoomGesture({ zoom: oldZoom, panX, panY });
    }
    this.project.canvas.zoom = newZoom;
    this.project.canvas.panX = mx - ((mx - panX) / oldZoom) * newZoom;
    this.project.canvas.panY = my - ((my - panY) / oldZoom) * newZoom;
    this.applyBoardTransform();
    if (this.zoomGesture.active) this.scheduleZoomGestureEnd();
    // The page is redrawn by `applyBoardTransform`; the wires are drawn here. A
    // frozen step draws neither — the gesture records the view the layers are at,
    // and `drawWires` bails out mid-gesture anyway.
    else this.drawWires();
  }

  /**
   * Start scaling what is on screen instead of drawing it.
   *
   * The board's own transform is what zooms everything inside it, and the browser
   * is what scales those pixels — vector work it has already rasterised is not
   * re-rasterised just because the transform under it changed, which is the whole
   * reason a gesture can be cheaper than a repaint. The two layers drawn *outside*
   * the board (the page and the wires) are the ones that would otherwise be
   * rebuilt every frame, so they are frozen too and follow the zoom by transform,
   * from the view they were drawn at.
   */
  private beginZoomGesture(view: BoardView): void {
    this.zoomGesture.begin(view);
    const wrap = document.getElementById('boardWrap');
    const host = this.canvasSurface;
    this.frozenPageOrigin = null;
    if (host) {
      const wrapRect = wrap?.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      // Where the drawing starts inside the wrap: the rail it sits beside, plus
      // wherever the host itself sits. Read now — a transformed layout rect
      // reports the transform, not the layout.
      const rail = this.canvasEditor?.viewOriginInHost() ?? { x: 0, y: 0 };
      this.frozenPageOrigin = {
        x: rail.x + (wrapRect && hostRect ? hostRect.left - wrapRect.left : 0),
        y: rail.y + (wrapRect && hostRect ? hostRect.top - wrapRect.top : 0),
      };
    }
    this.scaleFrozenLayers();
  }

  /** Put the frozen layers where a repaint at the current view would have put them. */
  private scaleFrozenLayers(): void {
    const view = this.project.canvas;
    // Both layers are transformed about their own top-left corner: they are
    // pinned to the wrap by their layout, and `layerTransform` accounts for where
    // that corner sits. The default origin — the middle of the element — would
    // scale the layer about a point that moves with the wrap's size.
    const wires = this.zoomGesture.layerTransform(view);
    if (wires) {
      this.wiresSvg.style.transformOrigin = '0 0';
      this.wiresSvg.style.transform = formatLayerTransform(wires);
    }
    const page = this.zoomGesture.layerTransform(view, this.frozenPageOrigin ?? undefined);
    if (page) this.canvasEditor?.setGestureTransform(formatLayerTransform(page));
  }

  private scheduleZoomGestureEnd(): void {
    if (this.zoomGestureTimer !== null) clearTimeout(this.zoomGestureTimer);
    this.zoomGestureTimer = setTimeout(() => {
      this.zoomGestureTimer = null;
      this.endZoomGesture();
    }, ZOOM_GESTURE_SETTLE_MS);
  }

  /**
   * Drop the frozen state. True when there was one, and the layers are back at
   * their own layout rather than carrying a transform.
   */
  private unfreezeBoardView(): boolean {
    if (this.zoomGestureTimer !== null) {
      clearTimeout(this.zoomGestureTimer);
      this.zoomGestureTimer = null;
    }
    if (!this.zoomGesture.end()) return false;
    this.wiresSvg.style.transform = '';
    this.wiresSvg.style.transformOrigin = '';
    this.canvasEditor?.setGestureTransform(null);
    this.frozenPageOrigin = null;
    return true;
  }

  /**
   * Draw the board again at the zoom it stopped on.
   *
   * This is the render the gesture deferred: the page, the wires and every
   * frame's chrome, once, instead of once per step.
   */
  private endZoomGesture(): void {
    if (!this.unfreezeBoardView()) return;
    const zoom = this.project.canvas.zoom;
    // Nothing was told about the zoom the layers were frozen at, so everything
    // is out of date, not merely behind.
    this.chromeZoomSynced = null;
    this.syncContainerDetail(true);
    this.chromeZoomSynced = zoom;
    this.syncCanvasSurfaceView();
    this.drawWires();
    this.settleContainerChrome();
  }

  /** A redraw that is not the gesture's own: what is frozen no longer matches. */
  private endGestureBeforeRedraw(): void {
    if (this.zoomGesture.active) this.endZoomGesture();
  }

  private applyBoardTransform(): void {
    // The prompt is pinned to the terminal on screen, so anything that moves the
    // board moves the terminal out from under it.
    this.hideDrapeOffer();
    const { panX, panY, zoom } = this.project.canvas;
    this.board.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    this.applyBoardZoomChrome(zoom);
    // Mid-gesture the board is not redrawn at all: what is on screen is scaled,
    // and the drawing catches up when the board stops — see `beginZoomGesture`.
    if (this.zoomGesture.active) {
      this.scaleFrozenLayers();
      return;
    }
    // A frame on the board is scaled by that transform, so its editor needs to
    // know by how much before it draws its next stroke.
    this.syncContainerDetail(this.chromeZoomSynced !== zoom);
    this.chromeZoomSynced = zoom;
    // The page has no transform of its own; it is drawn in screen space and the
    // board's pan and zoom are folded into its view instead.
    this.syncCanvasSurfaceView();
  }

  /**
   * Tell the chrome that stays a constant size on screen how far the board is
   * scaled.
   *
   * The property is written on the handful of elements that *use* it — a node's
   * title bar, a frame's resize bands, a note's grab bands — rather than on the
   * board. Custom properties are inherited, so writing it on the board re-resolves
   * the style of every descendant: cheap for a board of a few nodes, and 82 ms a
   * frame for one with a mesh on it, because a cloth preview is a hundred thousand
   * SVG nodes and each of them counts. Writing it where it is read keeps a zoom
   * step to a handful of elements and no descendants at all.
   */
  private applyBoardZoomChrome(zoom: number): void {
    if (this.chromeVarZoom === zoom) return;
    this.chromeVarZoom = zoom;
    const value = String(zoom);
    for (const chrome of this.boardChrome.values()) {
      for (const element of chrome) element.style.setProperty('--board-zoom', value);
    }
  }

  private renderAll(): void {
    this.gpuInitGeneration++;
    // The board is being rebuilt underneath everything the gesture froze.
    this.unfreezeBoardView();
    this.settleContainerChrome();
    this.closeNodeFullscreen();
    this.teardownSims();
    this.board.innerHTML = '';
    this.sectionLabels.clear();
    this.editors.clear();
    for (const preview of this.meshPreviews.values()) preview.destroy();
    this.meshPreviews.clear();
    this.simTransports.clear();
    this.boardChrome.clear();
    this.chromeVarZoom = null;
    this.mountCanvasSurface();
    this.applyBoardTransform();
    const nodes = [...this.project.canvas.nodes].sort((a, b) => a.zIndex - b.zIndex);
    for (const node of nodes) {
      this.mountNode(node);
    }
    this.drawWires();
    this.renderInspector();
  }

  /**
   * The canvas itself, as a drawing surface.
   *
   * It is a 2D editor like any other — same rail, same tools — but its view is
   * the canvas's: the frames sit on top of it at the canvas's own scale, and work
   * drawn here is measured against the same centimetres they are. Panning and
   * zooming the board moves this view with it, so the page and its containers can
   * never drift apart.
   */
  private mountCanvasSurface(): void {
    const wrap = document.getElementById('boardWrap');
    if (!wrap) return;
    this.canvasSurface?.remove();
    const host = document.createElement('div');
    // Under `#board`, so every frame (and its chrome) stays on top of the page.
    host.className = 'canvas-surface pattern-host is-canvas-surface';
    wrap.insertBefore(host, this.board);
    const pattern = rootPattern(this.project);
    this.canvasEditor = new PatternEditor(host, pattern, this.project.displayUnit, {
      onBeforeChange: () => this.pushUndo(),
      onChange: () => {
        this.invalidateMeshesForPattern(pattern.id);
        this.markDirty();
      },
      onRulerChange: () => this.markDirty(),
      getMeasurementLibrary: () => cachedMeasurementLibrary(),
      onGroupIntoContainer: (pieceIds) => this.groupCanvasPiecesIntoContainer(pieceIds),
      onMarqueeRect: (box, info) => this.mirrorPageMarquee(box, info),
      onAddObject: (kind, box) =>
        kind === 'section' ? this.addSection(box) : this.addTextObject(box),
      onPiecesDropped: (drop) => this.handOverDroppedPieces(null, drop),
    });
    this.canvasSurface = host;
    this.syncCanvasSurfaceView();
  }

  /** Keep the canvas pattern's view locked to the board's pan and zoom. */
  private syncCanvasSurfaceView(): void {
    const editor = this.canvasEditor;
    if (!editor) return;
    // The page cannot be redrawn into a view it is only pretending to be at.
    this.endGestureBeforeRedraw();
    // Screen pixels per centimetre on the page: the drafting scale, zoomed. The
    // page is drawn in screen space, so this *is* the on-screen size of a
    // centimetre, and it is what the detail ladder is measured against.
    const cmScale = canvasCmScale(this.project) * this.project.canvas.zoom;
    if (!(cmScale > 0)) return;
    // The page's editor keeps its rail beside the drawing, so the view starts
    // where the drawing does rather than at the host's own corner.
    const origin = editor.viewOriginInHost();
    editor.setContainer({
      cmScale,
      viewX: (origin.x - this.project.canvas.panX) / cmScale,
      viewY: (origin.y - this.project.canvas.panY) / cmScale,
      frameWidthCm: 0,
      frameHeightCm: 0,
      clip: false,
      locked: true,
      drawsGrid: true,
      // The page is drawn in screen space and folds the board's zoom into its
      // centimetre scale instead, so nothing extra is scaling its chrome.
      chromeScale: 1,
      // The page's own work thins out with the board like a frame's, but the page
      // is the drawing surface: it keeps the pointer and its grid at every zoom.
      detail: this.detailForScale(cmScale),
      coarsePointer: 'editor',
    });
  }

  /** "Put selection in container", from the canvas editor's context menu. */
  private groupCanvasPiecesIntoContainer(pieceIds: string[]): void {
    const canvas = rootPattern(this.project);
    const chosen = canvas.pieces.filter((piece) => pieceIds.includes(piece.id));
    // Name the new frame after the work when there is one obvious answer.
    const name =
      chosen.length === 1
        ? chosen[0]!.name
        : `Pattern ${this.project.patterns.length + 1}`;
    const outcome = groupIntoContainer(this.project, pieceIds, name);
    if (!outcome.ok) {
      this.setStatus(outcome.reason);
      return;
    }
    this.mountNode(outcome.node);
    this.layoutNodes();
    this.drawWires();
    this.selectNodes([outcome.node.id]);
    // The pieces left the page for the new frame; the page has one less thing on it.
    this.canvasEditor?.refresh();
    this.renderInspector();
    this.markDirty();
    this.setStatus(
      `Moved ${outcome.pieceCount} piece${outcome.pieceCount === 1 ? '' : 's'} into a container`
    );
  }

  /**
   * A finished drag of whole pieces: if it let go somewhere else — over a
   * container while dragging on the page, or past the frame while dragging
   * inside one — the work changes hands and lands where it was dropped.
   *
   * `frame` is the container the drag started in, `null` on the page itself.
   * The pieces have already been moved by the drag, so a handover is one more
   * translation on top of it, in the same undo step.
   */
  private handOverDroppedPieces(
    frame: PatternFrameNode | null,
    drop: { clientX: number; clientY: number; pieceIds: string[] }
  ): void {
    // An expanded container is not on the board: it has no frame to be dragged
    // out of, and the point its own zoom puts the drop at means nothing to the
    // canvas behind it.
    if (frame && frame.id === this.expandedNodeId) return;
    const target = this.frameAtClient(drop.clientX, drop.clientY);
    if ((target?.id ?? null) === (frame?.id ?? null)) return;
    const hand = this.boardPointFromClient(drop.clientX, drop.clientY);
    const outcome = movePiecesBetweenSpaces(this.project, frame, target, drop.pieceIds, hand);
    if (!outcome.ok) {
      this.setStatus(outcome.reason);
      return;
    }
    // Both sides have to catch up: the work left one pattern and arrived in the
    // other, each drawn by its own editor and each read by its own meshes.
    for (const space of [frame, target]) {
      this.editorForSpace(space)?.refresh();
      const pattern = patternForSpace(this.project, space);
      if (pattern) this.invalidateMeshesForPattern(pattern.id);
    }
    this.markDirty();
    const count = outcome.pieceCount;
    const pieces = `${count} piece${count === 1 ? '' : 's'}`;
    this.setStatus(
      target
        ? `Moved ${pieces} into Container · ${this.containerName(target)}`
        : `Moved ${pieces} out to the canvas`
    );
  }

  /** The editor drawing a space — the page's own, or a frame's. */
  private editorForSpace(frame: PatternFrameNode | null): PatternEditor | undefined {
    return frame
      ? this.editors.get(frame.id)
      : (this.canvasEditor ?? undefined);
  }

  /** The container's name, as its own frame titles it. */
  private containerName(node: PatternFrameNode): string {
    return this.project.patterns.find((p) => p.id === node.patternId)?.name ?? 'Container';
  }

  /** The container frame under a screen point, top of the stack first. */
  private frameAtClient(clientX: number, clientY: number): PatternFrameNode | null {
    let best: PatternFrameNode | null = null;
    let bestZ = -Infinity;
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame') continue;
      // A node opened full screen has left the board for the overlay, where its
      // box is the whole window rather than anything the canvas knows about.
      if (node.id === this.expandedNodeId) continue;
      const el = this.findNodeEl(node.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right) continue;
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const z = this.nodeZIndex(node);
      if (z >= bestZ) {
        best = node;
        bestZ = z;
      }
    }
    return best;
  }

  /**
   * The page's marquee, turned into a node selection.
   *
   * On the canvas the page and the frames standing on it are one surface, so a
   * rectangle drawn on the page takes the nodes it crosses as well as the work
   * inside them: what the drag covers is what you get, whichever of the two it
   * started on. The rectangle itself is the editor's — it is drawn where the drag
   * is, at the pattern's own scale — so the board only answers it.
   */
  private mirrorPageMarquee(
    box: { x: number; y: number; w: number; h: number } | null,
    info: { additive: boolean; panels: boolean }
  ): void {
    if (!box) {
      if (this.pageMarqueeBase === null) return;
      this.pageMarqueeBase = null;
      this.renderInspector();
      this.setStatus(
        this.selectedNodeIds.length > 1 ? `${this.selectedNodeIds.length} nodes selected` : ''
      );
      return;
    }
    // Shift keeps what was already picked; anything else starts the selection over.
    if (!info.additive) this.pageMarqueeBase = [];
    else if (this.pageMarqueeBase === null) this.pageMarqueeBase = [...this.selectedNodeIds];
    const topLeft = canvasAtCm(this.project, box.x, box.y);
    const bottomRight = canvasAtCm(this.project, box.x + box.w, box.y + box.h);
    const hits = nodesInBoardRect(
      this.project.canvas.nodes,
      {
        x: Math.min(topLeft.x, bottomRight.x),
        y: Math.min(topLeft.y, bottomRight.y),
        width: Math.abs(bottomRight.x - topLeft.x),
        height: Math.abs(bottomRight.y - topLeft.y),
      },
      (node) => this.isEmbeddedNode(node)
    ).map((node) => node.id);
    this.applyNodeSelection([...this.pageMarqueeBase, ...hits]);
    this.layoutNodes();
    this.syncTextStyleBar();
  }

  private findNodeEl(nodeId: string): HTMLElement | null {
    // `.canvas-node` only: the placeholder a fullscreen node leaves behind
    // carries the same `data-node-id`, and matching it would move the
    // placeholder instead of the node.
    return (
      (this.board.querySelector(`.canvas-node[data-node-id="${nodeId}"]`) as HTMLElement | null) ||
      (this.expandOverlay?.querySelector(
        `.canvas-node[data-node-id="${nodeId}"]`
      ) as HTMLElement | null)
    );
  }

  private layoutNodes(): void {
    for (const node of this.project.canvas.nodes) {
      const expanded = this.expandedNodeId === node.id;
      if (this.expandPlaceholder && expanded) {
        this.expandPlaceholder.style.left = `${node.x}px`;
        this.expandPlaceholder.style.top = `${node.y}px`;
        this.expandPlaceholder.style.width = `${node.width}px`;
        this.expandPlaceholder.style.height = `${node.height}px`;
      }
      const el = this.findNodeEl(node.id);
      if (!el || expanded) continue;
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      el.style.width = `${node.width}px`;
      el.style.height = `${node.height}px`;
      el.classList.toggle('selected', this.isNodeSelected(node.id));
      if (isSection(node)) this.placeSectionLabel(node);
      el.classList.toggle(
        'sim-active',
        node.type === 'simViewport' && (node as SimViewportNode).simId === this.project.activeSimId
      );
      if (node.type === 'simViewport') this.syncSimTransport((node as SimViewportNode).simId);
    }
  }

  private openNodeFullscreen(nodeId: string): void {
    if (this.expandedNodeId === nodeId) {
      this.closeNodeFullscreen();
      return;
    }
    if (this.expandedNodeId) {
      // Already fullscreen — switch to another node in the pipeline
      if (this.pipelineNodesFor(this.expandedNodeId).some((n) => n.id === nodeId)) {
        this.switchFullscreenNode(nodeId);
        return;
      }
      this.closeNodeFullscreen();
    }
    // A transform / drape carries the remesh with it: catch it up on arrival.
    this.remeshIfStale(nodeId);
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    const el = this.findNodeEl(nodeId);
    if (!el || !node) return;

    const placeholder = document.createElement('div');
    placeholder.className = `canvas-node-placeholder${
      this.isEmbeddedNode(node) ? ' is-embedded' : ''
    }`;
    placeholder.dataset.nodeId = nodeId;
    placeholder.style.left = `${node.x}px`;
    placeholder.style.top = `${node.y}px`;
    placeholder.style.width = `${node.width}px`;
    placeholder.style.height = `${node.height}px`;
    placeholder.style.zIndex = String(node.zIndex);
    placeholder.title = 'Expanded on screen';
    el.parentElement?.insertBefore(placeholder, el);

    const overlay = document.createElement('div');
    overlay.className = 'node-fullscreen-overlay';
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) this.closeNodeFullscreen();
    });

    el.classList.add('is-expanded');
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
    el.style.zIndex = '';
    overlay.appendChild(el);
    document.body.appendChild(overlay);

    this.setExpandButtonMode(el, true);

    this.expandedNodeId = nodeId;
    this.expandPlaceholder = placeholder;
    this.expandOverlay = overlay;
    this.selectNodes([nodeId]);
    this.dockInspectorToFullscreen();
    this.syncFullscreenTabs(el, nodeId);
    this.layoutNodes();
    // Expanded, a container stops being a window and becomes a workspace: the
    // view frees up and the frame is drawn where it sits.
    if (node.type === 'patternFrame') this.syncContainer(node);
    this.renderInspector();
    this.drawWires();

    this.expandEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeNodeFullscreen();
      }
    };
    window.addEventListener('keydown', this.expandEscHandler);

    requestAnimationFrame(() => {
      this.notifyNodeViewportResize(nodeId);
      this.setStatus('Full screen — Esc or ✕ to close · tabs switch connected views');
    });
  }

  private closeNodeFullscreen(): void {
    if (!this.expandedNodeId || !this.expandPlaceholder || !this.expandOverlay) return;
    // Put the split's stage back on the board before the node elements move.
    if (this.splitView) this.exitSplitView();
    const nodeId = this.expandedNodeId;
    const el = this.expandOverlay.querySelector(
      `[data-node-id="${nodeId}"]`
    ) as HTMLElement | null;
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);

    // Pull inspector out before moving the node back onto the board.
    this.undockInspectorFromFullscreen();

    if (el && node) {
      el.classList.remove('is-expanded');
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      el.style.width = `${node.width}px`;
      el.style.height = `${node.height}px`;
      el.style.zIndex = String(this.nodeZIndex(node));
      this.setExpandButtonMode(el, false);
      this.clearFullscreenTabs(el);
      this.expandPlaceholder.replaceWith(el);
    } else {
      this.expandPlaceholder.remove();
    }

    this.expandOverlay.remove();
    if (this.expandEscHandler) {
      window.removeEventListener('keydown', this.expandEscHandler);
      this.expandEscHandler = null;
    }
    this.expandedNodeId = null;
    this.expandPlaceholder = null;
    this.expandOverlay = null;
    this.layoutNodes();
    if (node?.type === 'patternFrame') this.syncContainer(node);
    this.drawWires();
    requestAnimationFrame(() => this.notifyNodeViewportResize(nodeId));
  }

  /** Dock inspector inside the expanded modal, under chrome, beside the viewport. */
  private dockInspectorToFullscreen(): void {
    if (!this.expandOverlay || !this.expandedNodeId) return;
    // The 2D pattern stage is about drawing: the tool rail and the option bars
    // are the useful chrome there, so the inspector stays out of the way.
    const expanded = this.project.canvas.nodes.find((n) => n.id === this.expandedNodeId);
    if (expanded?.type === 'patternFrame') return;
    const nodeEl = this.expandOverlay.querySelector(
      `[data-node-id="${this.expandedNodeId}"]`
    ) as HTMLElement | null;
    if (!nodeEl) return;

    let main = nodeEl.querySelector(':scope > .node-expand-main') as HTMLElement | null;
    if (!main) {
      const body = nodeEl.querySelector(':scope > .node-body') as HTMLElement | null;
      if (!body) return;
      main = document.createElement('div');
      main.className = 'node-expand-main';
      body.replaceWith(main);
      main.appendChild(body);
    }

    this.inspector.classList.add('is-fullscreen-docked');
    main.appendChild(this.inspector);
  }

  /** Restore the inspector to the studio body and unwrap the expand layout. */
  private undockInspectorFromFullscreen(): void {
    this.inspector.classList.remove('is-fullscreen-docked');
    const main = this.inspector.parentElement;
    if (main?.classList.contains('node-expand-main')) {
      const nodeEl = main.parentElement;
      const body = main.querySelector(':scope > .node-body');
      if (nodeEl && body) {
        nodeEl.insertBefore(body, main);
        main.remove();
      }
    }
    if (this.inspector.parentElement !== this.studioBody) {
      this.studioBody.appendChild(this.inspector);
    }
  }

  private switchFullscreenNode(nextId: string): void {
    if (!this.expandOverlay || !this.expandPlaceholder || !this.expandedNodeId) return;
    if (nextId === this.expandedNodeId) return;
    // Collapse the split back to the pattern so the switch moves a plain overlay.
    if (this.splitView) this.exitSplitView('pattern');

    const prevId = this.expandedNodeId;
    const prevEl = this.expandOverlay.querySelector(
      `[data-node-id="${prevId}"]`
    ) as HTMLElement | null;
    const nextEl = this.findNodeEl(nextId);
    const prevNode = this.project.canvas.nodes.find((n) => n.id === prevId);
    const nextNode = this.project.canvas.nodes.find((n) => n.id === nextId);
    if (!prevEl || !nextEl || !prevNode || !nextNode) return;

    // Moving on to a later stage rebuilds the mesh first if the pattern moved on.
    this.remeshIfStale(nextId);

    this.undockInspectorFromFullscreen();

    // Restore previous node onto the board where the placeholder was
    prevEl.classList.remove('is-expanded');
    prevEl.style.left = `${prevNode.x}px`;
    prevEl.style.top = `${prevNode.y}px`;
    prevEl.style.width = `${prevNode.width}px`;
    prevEl.style.height = `${prevNode.height}px`;
    prevEl.style.zIndex = String(prevNode.zIndex);
    this.setExpandButtonMode(prevEl, false);
    this.clearFullscreenTabs(prevEl);
    this.expandPlaceholder.replaceWith(prevEl);

    // Placeholder for the node we're about to expand
    const placeholder = document.createElement('div');
    placeholder.className = `canvas-node-placeholder${
      this.isEmbeddedNode(nextNode) ? ' is-embedded' : ''
    }`;
    placeholder.dataset.nodeId = nextId;
    placeholder.style.left = `${nextNode.x}px`;
    placeholder.style.top = `${nextNode.y}px`;
    placeholder.style.width = `${nextNode.width}px`;
    placeholder.style.height = `${nextNode.height}px`;
    placeholder.style.zIndex = String(nextNode.zIndex);
    placeholder.title = 'Expanded on screen';
    nextEl.parentElement?.insertBefore(placeholder, nextEl);
    this.expandPlaceholder = placeholder;

    nextEl.classList.add('is-expanded');
    nextEl.style.left = '';
    nextEl.style.top = '';
    nextEl.style.width = '';
    nextEl.style.height = '';
    nextEl.style.zIndex = '';
    this.setExpandButtonMode(nextEl, true);
    this.expandOverlay.appendChild(nextEl);
    this.expandedNodeId = nextId;
    this.selectNodes([nextId]);
    this.dockInspectorToFullscreen();
    this.syncFullscreenTabs(nextEl, nextId);
    this.layoutNodes();
    if (prevNode.type === 'patternFrame') this.syncContainer(prevNode);
    if (nextNode.type === 'patternFrame') this.syncContainer(nextNode);
    this.renderInspector();
    this.drawWires();
    requestAnimationFrame(() => {
      this.notifyNodeViewportResize(prevId);
      this.notifyNodeViewportResize(nextId);
    });
  }

  /**
   * The mesh behind a downstream stage (transform / drape) when it still needs a
   * rebuild — `geometry` is nulled by `invalidateMeshesForPattern`.
   */
  private staleMeshForStage(nodeId: string): MeshDocument | undefined {
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    let mesh: MeshDocument | undefined;
    if (node.type === 'transform3d') {
      const transform = this.project.transforms.find((t) => t.id === node.transformId);
      mesh = transform
        ? this.project.meshes.find((m) => m.id === transform.meshId)
        : undefined;
    } else if (node.type === 'simViewport') {
      mesh = this.simChain(node.simId).mesh;
    } else {
      return undefined;
    }
    return mesh && !mesh.geometry ? mesh : undefined;
  }

  /** Downstream stages carry the remesh with them, so catch it up on arrival. */
  private remeshIfStale(nodeId: string): void {
    const mesh = this.staleMeshForStage(nodeId);
    if (!mesh) return;
    this.remesh(mesh.id, { recordUndo: false });
  }

  /** Re-paint the fullscreen pipeline strip (stale markers change live). */
  private refreshFullscreenTabs(): void {
    if (this.splitView) {
      this.renderSplitHeader();
      this.syncSplitBanner();
      return;
    }
    if (!this.expandedNodeId || !this.expandOverlay) return;
    const el = this.expandOverlay.querySelector(
      `[data-node-id="${this.expandedNodeId}"]`
    ) as HTMLElement | null;
    if (el) this.syncFullscreenTabs(el, this.expandedNodeId);
  }

  private setExpandButtonMode(el: HTMLElement, fullscreen: boolean): void {
    const expandBtn = el.querySelector('.node-expand-btn') as HTMLButtonElement | null;
    if (!expandBtn) return;
    if (fullscreen) {
      expandBtn.textContent = '✕';
      expandBtn.title = 'Exit full screen · Esc';
      expandBtn.setAttribute('aria-label', 'Exit full screen');
    } else {
      expandBtn.textContent = '⛶';
      expandBtn.title = 'Open full screen';
      expandBtn.setAttribute('aria-label', 'Open full screen');
    }
  }

  /** Resolve the drape a node ultimately feeds (a pattern may feed several). */
  private drapeNodeFor(nodeId: string): SimViewportNode | undefined {
    const simNode = (simId: string) =>
      this.project.canvas.nodes.find(
        (n): n is SimViewportNode => n.type === 'simViewport' && n.simId === simId
      );
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    if (node.type === 'simViewport') return node;

    if (node.type === 'transform3d') {
      const link = this.project.transformSimAssignments.find(
        (a) => a.transformId === node.transformId
      );
      return link ? simNode(link.simId) : undefined;
    }

    if (node.type === 'meshFrame') {
      const viaTransform = this.project.meshTransformAssignments.find(
        (a) => a.meshId === node.meshId
      );
      if (viaTransform) {
        const link = this.project.transformSimAssignments.find(
          (a) => a.transformId === viaTransform.transformId
        );
        if (link) return simNode(link.simId);
      }
      const direct = this.project.assignments.find((a) => a.meshId === node.meshId);
      return direct ? simNode(direct.simId) : undefined;
    }

    if (node.type === 'patternFrame') {
      for (const mesh of this.project.meshes) {
        if (mesh.patternId !== node.patternId) continue;
        const meshNode = this.project.canvas.nodes.find(
          (n) => n.type === 'meshFrame' && n.meshId === mesh.id
        );
        const drape = meshNode ? this.drapeNodeFor(meshNode.id) : undefined;
        if (drape) return drape;
      }
    }
    return undefined;
  }

  /**
   * The stages of the drape this node belongs to, in modifier order:
   * pattern → remesh → transform → drape. Scoped to that one drape, so a shared
   * pattern feeding several drapes does not merge them into one list.
   */
  private pipelineNodesFor(nodeId: string): CanvasNode[] {
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    const drape = this.drapeNodeFor(nodeId);
    if (!drape) return node ? [node] : [];

    const chain = this.simChain(drape.simId);
    const stage = <T extends CanvasNode['type']>(type: T): CanvasNode | undefined => {
      if (type === 'patternFrame') {
        return this.project.canvas.nodes.find(
          (n) => n.type === 'patternFrame' && n.patternId === chain.pattern?.id
        );
      }
      if (type === 'meshFrame') {
        return this.project.canvas.nodes.find(
          (n) => n.type === 'meshFrame' && n.meshId === chain.mesh?.id
        );
      }
      if (type === 'transform3d') {
        return this.project.canvas.nodes.find(
          (n) => n.type === 'transform3d' && n.transformId === chain.transform?.id
        );
      }
      return drape;
    };

    return [
      stage('patternFrame'),
      stage('meshFrame'),
      stage('transform3d'),
      drape,
    ].filter((n): n is CanvasNode => !!n);
  }

  /**
   * The stages a drape owns internally, walked backwards along the real wiring:
   * drape → transform → mesh → pattern.
   */
  private simChain(simId: string): {
    pattern?: PatternDocument;
    mesh?: MeshDocument;
    transform?: Transform3dInstance;
  } {
    const { meshId, transformId } = simChainIds(this.project, simId);
    const transform = transformId
      ? this.project.transforms.find((t) => t.id === transformId)
      : undefined;
    const mesh = meshId ? this.project.meshes.find((m) => m.id === meshId) : undefined;
    const pattern = mesh
      ? this.project.patterns.find((p) => p.id === mesh.patternId)
      : undefined;
    return { pattern, mesh, transform };
  }

  /**
   * True when a remesh / transform node is owned by a drape rather than being a
   * standalone stage on the board. Derived from the wiring, so it can never go
   * stale the way a persisted flag would.
   */
  private isEmbeddedNode(node: CanvasNode): boolean {
    return isEmbeddedStage(this.project, node);
  }

  /** Keep the `is-embedded` class in step with the current wiring. */
  private syncEmbeddedNodes(): void {
    for (const node of this.project.canvas.nodes) {
      const el = this.findNodeEl(node.id);
      if (!el) continue;
      el.classList.toggle('is-embedded', this.isEmbeddedNode(node));
    }
    this.drawWires();
  }

  /**
   * Wire a 2D pattern straight into a drape. Remesh and transform are part of
   * the drape, so they are created on demand and never shown on the board.
   * Returns true when a transform stage had to be added.
   */
  private connectPatternToSim(pattern: PatternDocument, sim: SimInstance): boolean {
    const chain = this.simChain(sim.id);
    const created: string[] = [];

    let mesh = chain.mesh;
    if (!mesh) {
      mesh = createMeshDocument(pattern.id, `Mesh ${this.project.meshes.length + 1}`);
      remeshDocument(mesh, pattern);
      this.project.meshes.push(mesh);
      const node: MeshFrameNode = {
        type: 'meshFrame',
        id: uid('node'),
        meshId: mesh.id,
        x: 40,
        y: 40,
        width: DEFAULT_MESH_FRAME_WIDTH,
        height: DEFAULT_MESH_FRAME_HEIGHT,
        zIndex: this.project.canvas.nodes.length + 1,
      };
      this.project.canvas.nodes.push(node);
      this.mountNode(node);
      created.push('remesh');
    }

    mesh.patternId = pattern.id;
    remeshDocument(mesh, pattern);
    for (const [nodeId, preview] of this.meshPreviews) {
      const node = this.project.canvas.nodes.find((c) => c.id === nodeId);
      if (node?.type === 'meshFrame' && node.meshId === mesh.id) preview.setMesh(mesh, pattern);
    }

    let transform = chain.transform;
    let addedTransform = false;
    if (!transform) {
      transform = createTransform3dDocument(
        mesh.id,
        `Transform ${this.project.transforms.length + 1}`
      );
      this.project.transforms.push(transform);
      const node: Transform3dNode = {
        type: 'transform3d',
        id: uid('node'),
        transformId: transform.id,
        x: 40,
        y: 40,
        width: 380,
        height: 320,
        zIndex: this.project.canvas.nodes.length + 1,
      };
      this.project.canvas.nodes.push(node);
      this.mountNode(node);
      created.push('transform');
      addedTransform = true;
    }
    transform.meshId = mesh.id;

    // A drape runs pattern → remesh → transform → drape, so a direct mesh→drape
    // link is replaced by the transform stage.
    this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
      (a) => a.transformId !== transform!.id
    );
    this.project.meshTransformAssignments.push({
      id: uid('assign'),
      meshId: mesh.id,
      transformId: transform.id,
    });
    this.project.assignments = this.project.assignments.filter((a) => a.simId !== sim.id);
    this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
      (a) => a.simId !== sim.id
    );
    this.project.transformSimAssignments.push({
      id: uid('assign'),
      transformId: transform.id,
      simId: sim.id,
    });

    this.rebuildConnectedTransform(transform.id);
    this.rebuildConnectedSim(sim.id, true);
    this.syncEmbeddedNodes();
    this.setStatus(
      created.length
        ? `Connected ${pattern.name} → ${sim.name} · added internal ${created.join(' + ')} stage${
            created.length === 1 ? '' : 's'
          }`
        : `Connected ${pattern.name} → ${sim.name}`
    );
    this.renderInspector();
    return addedTransform;
  }

  private pipelineTabLabel(node: CanvasNode): string {
    switch (node.type) {
      case 'patternFrame':
        return `Pattern · ${this.nodeLabel(node)}`;
      case 'meshFrame':
        return `Remesh · ${this.nodeLabel(node)}`;
      case 'transform3d':
        return `Transform · ${this.nodeLabel(node)}`;
      case 'simViewport':
        return `Drape · ${this.nodeLabel(node)}`;
      default:
        return this.nodeLabel(node);
    }
  }

  /**
   * The title is also the rename field: click it and it turns into one, in
   * place, with the old name selected so a click and a type is all a rename
   * takes. Enter or a click elsewhere keeps it, Escape puts the old name back.
   * The file menu's Rename field does the same job from a distance.
   */
  private bindTitleRename(): void {
    const btn = this.toolbar.querySelector('#activeNameBtn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.beginTitleRename(btn);
    });
  }

  private beginTitleRename(btn: HTMLButtonElement): void {
    if (this.toolbar.querySelector('.active-file-input')) return;
    const input = document.createElement('input');
    input.className = 'active-file-input';
    input.value = this.project.name;
    input.setAttribute('aria-label', 'Project name');
    input.spellcheck = false;
    // The field takes the button's width, so the row does not jump.
    input.style.width = `${Math.max(120, Math.round(btn.getBoundingClientRect().width))}px`;
    btn.hidden = true;
    btn.after(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value;
      input.remove();
      btn.hidden = false;
      if (commit) this.renameProject(name);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** One rename path: history, the document, and every mirror of its name. */
  private renameProject(raw: string): void {
    const name = raw.trim();
    if (!name || name === this.project.name) return;
    this.pushUndo();
    this.project.name = name;
    this.markDirty();
    this.syncProjectChrome();
  }

  /**
   * The file menu beside the fullscreen title.
   *
   * It sits there rather than in the hamburger because it acts on the document
   * in front of you: this is where the document is named, so it is where you
   * save it, rename it, or step back to one you were in a minute ago.
   */
  private bindDocMenu(): void {
    const menu = this.toolbar.querySelector('.doc-menu') as HTMLElement | null;
    const toggle = menu?.querySelector('[data-doc-toggle]') as HTMLButtonElement | null;
    const popover = menu?.querySelector('.doc-popover') as HTMLElement | null;
    if (!menu || !toggle || !popover) return;

    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.classList.contains('is-open')) this.closeDocMenu(menu);
      else void this.openDocMenu(menu);
    });
    popover.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest(
        'button[data-doc-act]'
      ) as HTMLButtonElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.docAct;
      const projectId = btn.dataset.projectId;
      this.closeDocMenu(menu);
      if (act === 'save') {
        void this.persistLocal({ label: 'Saved' });
      } else if (act === 'new') {
        this.openNewProjectPrompt();
      } else if (act === 'projects') {
        this.openProjectsModal();
      } else if (act === 'open' && projectId) {
        void (async () => {
          const project = await getSavedProject(projectId);
          if (!project) return;
          // The overlay belongs to a node of the project we are leaving.
          this.closeNodeFullscreen();
          this.switchToProject(project);
          this.setStatus(`Loaded “${project.name}”`);
        })();
      }
    });
    popover.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.matches('[data-doc-rename]')) return;
      const before = this.project.name;
      this.renameProject(input.value);
      if (this.project.name === before) input.value = before;
    });
    popover.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /** Fill the file menu for the document in hand, then show it. */
  private async openDocMenu(menu: HTMLElement): Promise<void> {
    const toggle = menu.querySelector('[data-doc-toggle]') as HTMLButtonElement | null;
    const popover = menu.querySelector('.doc-popover') as HTMLElement | null;
    if (!toggle || !popover) return;

    const saved = await listSavedProjects();
    const recent = saved
      .filter((project) => project.id !== this.project.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, DOC_MENU_RECENT);
    const recentRows = recent.length
      ? recent
          .map(
            (project) =>
              `<button type="button" role="menuitem" data-doc-act="open" data-project-id="${
                project.id
              }"><span class="doc-name">${this.escapeHtml(
                project.name
              )}</span><span class="app-menu-key">${shortProjectDate(
                project.updatedAt
              )}</span></button>`
          )
          .join('')
      : '<span class="doc-empty">No other saved projects yet</span>';

    popover.innerHTML = `
      <label class="app-menu-field">
        <span class="app-menu-field-label">Rename</span>
        <input class="project-name" data-doc-rename aria-label="Project name" value="${this.escapeHtml(
          this.project.name
        )}" />
      </label>
      <div class="app-menu-sep"></div>
      <button type="button" role="menuitem" data-doc-act="save">Save<span class="app-menu-key">⌘S</span></button>
      <button type="button" role="menuitem" data-doc-act="new">New project</button>
      <div class="app-menu-sep"></div>
      <span class="app-menu-label">Open recent</span>
      ${recentRows}
      <div class="app-menu-sep"></div>
      <button type="button" role="menuitem" data-doc-act="projects">Projects…</button>
    `;
    popover.hidden = false;
    menu.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  private closeDocMenu(menu: HTMLElement): void {
    menu.classList.remove('is-open');
    const popover = menu.querySelector('.doc-popover') as HTMLElement | null;
    if (popover) popover.hidden = true;
    menu.querySelector('[data-doc-toggle]')?.setAttribute('aria-expanded', 'false');
  }

  /** Outside press, Escape and a resize all put the file menu away. */
  private bindDocMenuDismiss(): void {
    const open = (): HTMLElement | null =>
      document.querySelector('.doc-menu.is-open') as HTMLElement | null;
    document.addEventListener('pointerdown', (e) => {
      const menu = open();
      if (!menu || menu.contains(e.target as Node)) return;
      this.closeDocMenu(menu);
    });
    // Capture, and immediate, so Escape closes the menu rather than the overlay
    // behind it: both listeners sit on `window`, and only this one may act.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        const menu = open();
        if (!menu) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.closeDocMenu(menu);
      },
      true
    );
    window.addEventListener('resize', () => {
      const menu = open();
      if (menu) this.closeDocMenu(menu);
    });
  }

  private syncFullscreenTabs(el: HTMLElement, activeId: string): void {
    const chrome = el.querySelector('.node-chrome');
    const title = el.querySelector('.node-title') as HTMLElement | null;
    const tabs = el.querySelector('.node-fullscreen-tabs') as HTMLElement | null;
    if (!chrome || !tabs) return;

    const pipeline = this.pipelineNodesFor(activeId);
    if (pipeline.length < 2) {
      tabs.hidden = true;
      tabs.innerHTML = '';
      if (title) title.hidden = false;
      return;
    }

    if (title) title.hidden = true;
    tabs.hidden = false;
    // Stroked chips joined by arrows so the chain reads as a run of sequential
    // modifiers: pattern → remesh → transform → drape. A remesh whose pattern
    // moved on since the last build is flagged red.
    tabs.innerHTML = pipeline
      .map((n, i) => {
        const stale =
          n.type === 'meshFrame' &&
          !this.project.meshes.find((m) => m.id === n.meshId)?.geometry;
        const chip = `<button type="button" role="tab" class="node-fullscreen-tab${
          n.id === activeId ? ' is-active' : ''
        }${stale ? ' is-stale' : ''}" data-fs-node="${n.id}" aria-selected="${
          n.id === activeId
        }"${stale ? ' title="Pattern changed since this mesh was built — it rebuilds when you open a later stage"' : ''}>${this.escapeHtml(
          this.pipelineTabLabel(n)
        )}</button>`;
        if (i >= pipeline.length - 1) return chip;
        const link = this.splitLinkHtml();
        // The 2D + 3D split toggle sits where the run leaves the pattern, before
        // the remesh.
        const splitBtn =
          i === 0 && pipeline[0].type === 'patternFrame'
            ? this.splitToggleButtonHtml() + link
            : link;
        return chip + splitBtn;
      })
      .join('');

    tabs.querySelectorAll('button[data-fs-node]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = (btn as HTMLButtonElement).dataset.fsNode;
        if (id) this.switchFullscreenNode(id);
      });
    });
    tabs.querySelector('button[data-fs-split]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleSplitView();
    });

    // The strip scrolls horizontally; make sure the stage you are looking at is
    // the one in view (and that a stage is never clipped out of reach).
    tabs.querySelector('.node-fullscreen-tab.is-active')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }

  private clearFullscreenTabs(el: HTMLElement): void {
    const title = el.querySelector('.node-title') as HTMLElement | null;
    const tabs = el.querySelector('.node-fullscreen-tabs') as HTMLElement | null;
    if (title) title.hidden = false;
    if (tabs) {
      tabs.hidden = true;
      tabs.innerHTML = '';
    }
  }

  // ---------------------------------------------------------------------------
  // Split view: the 2D pattern and one 3D stage side by side.
  // ---------------------------------------------------------------------------

  /** Icon-only toggle that splits the fullscreen into 2D + 3D. */
  private splitToggleButtonHtml(): string {
    const active = this.splitView !== null;
    return `<button type="button" class="node-fullscreen-split-btn${
      active ? ' is-active' : ''
    }" data-fs-split aria-pressed="${active}" title="Split view — 2D pattern beside the 3D stage" aria-label="Toggle split 2D and 3D view"><svg viewBox="0 0 16 14" width="15" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.4" y="1.4" width="13.2" height="11.2" rx="1.4"/><path d="M8 1.4 V 12.6"/></svg></button>`;
  }

  /** The 3D stages of the pipeline, in run order (remesh → transform → drape). */
  private splitStageNodes(pipeline: CanvasNode[]): CanvasNode[] {
    return pipeline.filter(
      (n) => n.type === 'meshFrame' || n.type === 'transform3d' || n.type === 'simViewport'
    );
  }

  private toggleSplitView(): void {
    if (this.splitView) {
      this.exitSplitView();
      return;
    }
    const expandedId = this.expandedNodeId;
    if (!expandedId) return;
    const pipeline = this.pipelineNodesFor(expandedId);
    const pattern = pipeline.find((n) => n.type === 'patternFrame');
    const stages = this.splitStageNodes(pipeline);
    // Splitting from a 3D view keeps that view on the right; the pattern (or a
    // pipeline with no stage to inherit) falls back to the run's first stage.
    const stage = stages.find((n) => n.id === expandedId) ?? stages[0];
    if (!pattern || !stage) return;
    this.enterSplitView(pattern.id, stage.id);
  }

  /**
   * Show the pattern and a 3D stage at once. The pattern stays in the overlay as
   * the active node; the stage is adopted off the board into the right pane. The
   * pattern's own chrome is hoisted to the top of the existing overlay and its
   * chips pick which stage fills the right pane.
   */
  private enterSplitView(patternNodeId: string, stageNodeId: string): void {
    const overlay = this.expandOverlay;
    if (!overlay || this.splitView) return;
    const patternNode = this.canvasNode(patternNodeId);
    const stageNode = this.canvasNode(stageNodeId);
    if (!patternNode || !stageNode) return;

    const patternEl = this.findNodeEl(patternNodeId);
    const stageEl = this.findNodeEl(stageNodeId);
    // The split reuses the expanded node's own chrome as its title bar, so this is
    // the current overlay with its header kept at the top — not a second overlay.
    const chrome = patternEl?.querySelector(':scope > .node-chrome') as HTMLElement | null;
    const stageStack = this.viewportActionStack(stageEl);
    // Everything that can bail out is checked before the first DOM move, so a
    // refusal never leaves the overlay half-built.
    if (!patternEl || !stageEl || !chrome || !stageStack) return;

    this.remeshIfStale(stageNodeId);
    // Whatever was fullscreen goes back on the board first, so both elements we
    // are about to adopt still have their board parents.
    this.restoreExpandedNodeToBoard();

    const banner = document.createElement('div');
    banner.className = 'node-split-banner';
    banner.hidden = true;

    const body = document.createElement('div');
    body.className = 'node-split-body';
    const left = document.createElement('div');
    left.className = 'node-split-pane is-2d';
    const right = document.createElement('div');
    right.className = 'node-split-pane is-3d';

    const patternPlaceholder = this.detachIntoPane(patternEl, patternNode, left);
    const stagePlaceholder = this.detachIntoPane(stageEl, stageNode, right);

    // The warning belongs in the 3D viewport it is talking about, riding above
    // that viewport's floating action bar.
    stageStack.insertBefore(banner, stageStack.firstElementChild);

    body.append(left, right);
    overlay.classList.add('is-split');
    overlay.append(chrome, body);
    this.setExpandButtonMode(chrome, true);

    // The pattern owns the fullscreen lifecycle while split; the stage rides along.
    this.expandedNodeId = patternNodeId;
    this.expandPlaceholder = patternPlaceholder;
    this.splitView = {
      patternNodeId,
      stageNodeId,
      patternPlaceholder,
      stagePlaceholder,
      chrome,
      body,
      stagePane: right,
      banner,
    };
    this.renderSplitHeader();
    this.syncSplitBanner();
    // Seed the 3D selection from whatever is picked in 2D.
    this.syncSplitSelectionFrom2d(this.editors.get(patternNodeId)?.getSelectedPieces() ?? []);
    this.layoutNodes();
    requestAnimationFrame(() => {
      this.notifyNodeViewportResize(patternNodeId);
      this.notifyNodeViewportResize(stageNodeId);
    });
  }

  /** Put the node that is currently fullscreen back on the board. */
  private restoreExpandedNodeToBoard(): void {
    const id = this.expandedNodeId;
    if (id && this.expandPlaceholder) {
      const el = this.findNodeEl(id);
      const node = this.canvasNode(id);
      if (el && node) this.restoreFromPane(el, node, this.expandPlaceholder);
    }
    this.expandedNodeId = null;
    this.expandPlaceholder = null;
  }

  /** Take a node off the board into `pane`, leaving a placeholder behind. */
  private detachIntoPane(
    el: HTMLElement,
    node: CanvasNode,
    pane: HTMLElement
  ): HTMLElement {
    const placeholder = document.createElement('div');
    placeholder.className = `canvas-node-placeholder${
      this.isEmbeddedNode(node) ? ' is-embedded' : ''
    }`;
    placeholder.dataset.nodeId = node.id;
    placeholder.style.left = `${node.x}px`;
    placeholder.style.top = `${node.y}px`;
    placeholder.style.width = `${node.width}px`;
    placeholder.style.height = `${node.height}px`;
    placeholder.style.zIndex = String(node.zIndex);
    el.parentElement?.insertBefore(placeholder, el);

    el.classList.add('is-expanded');
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
    el.style.zIndex = '';
    pane.appendChild(el);
    return placeholder;
  }

  /** Put a node back on the board where its placeholder sits. */
  private restoreFromPane(el: HTMLElement, node: CanvasNode, placeholder: HTMLElement): void {
    el.classList.remove('is-expanded');
    // A boarded node carries no fullscreen chrome of its own.
    this.setExpandButtonMode(el, false);
    this.clearFullscreenTabs(el);
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.width}px`;
    el.style.height = `${node.height}px`;
    el.style.zIndex = String(this.nodeZIndex(node));
    placeholder.replaceWith(el);
  }

  /**
   * Leave split mode. The pane you keep becomes the single fullscreen node (the
   * stage by default, so exiting lands you back in 3D); the other returns to the
   * board.
   */
  private exitSplitView(focus: 'stage' | 'pattern' = 'stage'): void {
    const split = this.splitView;
    if (!split || !this.expandOverlay) return;
    const overlay = this.expandOverlay;
    const patternEl = this.findNodeEl(split.patternNodeId);
    const patternNode = this.canvasNode(split.patternNodeId);
    const stageEl = this.findNodeEl(split.stageNodeId);
    const stageNode = this.canvasNode(split.stageNodeId);

    const keepPattern = focus === 'pattern';
    const keepEl = keepPattern ? patternEl : stageEl;
    const keepNode = keepPattern ? patternNode : stageNode;
    const keepId = keepPattern ? split.patternNodeId : split.stageNodeId;
    const keepPlaceholder = keepPattern ? split.patternPlaceholder : split.stagePlaceholder;
    const dropEl = keepPattern ? stageEl : patternEl;
    const dropNode = keepPattern ? stageNode : patternNode;
    const dropPlaceholder = keepPattern ? split.stagePlaceholder : split.patternPlaceholder;

    if (dropEl && dropNode) this.restoreFromPane(dropEl, dropNode, dropPlaceholder);
    else dropPlaceholder.remove();

    // Hand the hoisted title bar back to the pattern it belongs to. Its close
    // button only belongs in fullscreen mode when the pattern is the one kept.
    this.clearFullscreenTabs(split.chrome);
    this.setExpandButtonMode(split.chrome, keepPattern);
    if (patternEl && split.chrome.parentElement !== patternEl) {
      patternEl.insertBefore(split.chrome, patternEl.firstChild);
    }
    split.banner.remove();
    split.body.remove();
    overlay.classList.remove('is-split');

    this.splitView = null;
    if (keepEl && keepNode && keepId) {
      overlay.appendChild(keepEl);
      keepEl.classList.add('is-expanded');
      this.setExpandButtonMode(keepEl, true);
      keepEl.style.left = '';
      keepEl.style.top = '';
      keepEl.style.width = '';
      keepEl.style.height = '';
      keepEl.style.zIndex = '';
      this.expandedNodeId = keepId;
      this.expandPlaceholder = keepPlaceholder;
      this.dockInspectorToFullscreen();
      this.syncFullscreenTabs(keepEl, keepId);
    } else {
      this.expandedNodeId = null;
      this.expandPlaceholder = null;
    }
    this.renderInspector();
    this.layoutNodes();
    requestAnimationFrame(() => {
      this.notifyNodeViewportResize(split.patternNodeId);
      this.notifyNodeViewportResize(split.stageNodeId);
    });
  }

  /** Swap which 3D stage fills the right pane, keeping the pattern in place. */
  private switchSplitStage(nextStageNodeId: string): void {
    const split = this.splitView;
    if (!split || split.stageNodeId === nextStageNodeId) return;
    const prevEl = this.findNodeEl(split.stageNodeId);
    const prevNode = this.canvasNode(split.stageNodeId);
    const nextEl = this.findNodeEl(nextStageNodeId);
    const nextNode = this.canvasNode(nextStageNodeId);
    if (!nextEl || !nextNode) return;

    // The 3D pane outlives the stage it shows, but the warning travels with the
    // action stack of whichever viewport is now on the right.
    const nextStack = this.viewportActionStack(nextEl);
    if (!nextStack) return;

    this.remeshIfStale(nextStageNodeId);
    if (prevEl && prevNode) this.restoreFromPane(prevEl, prevNode, split.stagePlaceholder);
    else split.stagePlaceholder.remove();

    split.stagePlaceholder = this.detachIntoPane(nextEl, nextNode, split.stagePane);
    nextStack.insertBefore(split.banner, nextStack.firstElementChild);
    split.stageNodeId = nextStageNodeId;
    this.renderSplitHeader();
    this.syncSplitBanner();
    this.syncSplitSelectionFrom2d(this.editors.get(split.patternNodeId)?.getSelectedPieces() ?? []);
    this.layoutNodes();
    requestAnimationFrame(() => this.notifyNodeViewportResize(nextStageNodeId));
  }

  /**
   * The run the split's chips describe. A pattern can feed more than one 3D
   * chain, so follow the chain the right pane is actually showing whenever the
   * pattern's default chain does not contain it.
   */
  private splitPipeline(): CanvasNode[] {
    const split = this.splitView;
    if (!split) return [];
    const fromPattern = this.pipelineNodesFor(split.patternNodeId);
    if (fromPattern.some((n) => n.id === split.stageNodeId)) return fromPattern;
    const fromStage = this.pipelineNodesFor(split.stageNodeId);
    return fromStage.some((n) => n.type === 'patternFrame') ? fromStage : fromPattern;
  }

  /** The hoisted title bar's chips: the run's stages, the stage picking the 3D pane. */
  private renderSplitHeader(): void {
    const split = this.splitView;
    if (!split) return;
    const tabs = split.chrome.querySelector('.node-fullscreen-tabs') as HTMLElement | null;
    if (!tabs) return;
    const title = split.chrome.querySelector('.node-title') as HTMLElement | null;
    if (title) title.hidden = true;
    tabs.hidden = false;
    const pipeline = this.splitPipeline();
    tabs.innerHTML = pipeline
      .map((n, i) => {
        const isStage = this.splitStageNodes([n]).length > 0;
        const active = isStage && n.id === split.stageNodeId;
        const stale =
          n.type === 'meshFrame' &&
          !this.project.meshes.find((m) => m.id === n.meshId)?.geometry;
        const chip = `<button type="button" role="tab" class="node-fullscreen-tab${
          active ? ' is-active' : ''
        }${stale ? ' is-stale' : ''}${isStage ? '' : ' is-fixed'}" data-split-node="${n.id}" aria-selected="${active}">${this.escapeHtml(
          this.pipelineTabLabel(n)
        )}</button>`;
        if (i >= pipeline.length - 1) return chip;
        if (n.type === 'patternFrame') {
          return chip + this.splitToggleButtonHtml() + this.splitLinkHtml();
        }
        return chip + this.splitLinkHtml();
      })
      .join('');
    tabs.querySelectorAll('button[data-split-node]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = (btn as HTMLButtonElement).dataset.splitNode;
        if (!id) return;
        const node = this.canvasNode(id);
        if (node && this.splitStageNodes([node]).length > 0) this.switchSplitStage(id);
        else this.exitSplitView();
      });
    });
    tabs.querySelector('button[data-fs-split]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.exitSplitView();
    });
  }

  private splitLinkHtml(): string {
    return `<span class="node-fullscreen-link" aria-hidden="true"><svg viewBox="0 0 26 10" width="26" height="10" fill="none"><path class="node-fullscreen-link-line" d="M0 5 H 17" /><path class="node-fullscreen-link-head" d="M16 2 L 21 5 L 16 8" /></svg></span>`;
  }

  private canvasNode(nodeId: string): CanvasNode | undefined {
    return this.project.canvas.nodes.find((n) => n.id === nodeId);
  }

  /** The mesh behind the split's pattern that still needs a rebuild, if any. */
  private staleMeshForSplit(): MeshDocument | undefined {
    const split = this.splitView;
    if (!split) return undefined;
    const node = this.canvasNode(split.patternNodeId);
    if (node?.type !== 'patternFrame') return undefined;
    return this.project.meshes.find(
      (m) => m.patternId === node.patternId && !m.geometry
    );
  }

  /** Warn, over the split's 3D viewport, that the build behind it is out of date. */
  private syncSplitBanner(): void {
    const split = this.splitView;
    if (!split) return;
    const stale = this.staleMeshForSplit();
    split.banner.hidden = !stale;
    split.stagePane.classList.toggle('is-stale', !!stale);
    if (!stale) {
      split.banner.innerHTML = '';
      return;
    }
    split.banner.innerHTML = `
      <span class="node-split-banner-text">Pattern changed — the 3D build is out of date.</span>
      <button type="button" class="node-split-resync" data-split-resync>Resync 3D</button>
    `;
    split.banner
      .querySelector('button[data-split-resync]')
      ?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.resyncSplit();
      });
  }

  /** Remesh and rebuild every stale mesh behind the split's pattern. */
  private resyncSplit(): void {
    const split = this.splitView;
    if (!split) return;
    const node = this.canvasNode(split.patternNodeId);
    if (node?.type !== 'patternFrame') return;
    this.pushUndo();
    const meshes = this.project.meshes.filter(
      (m) => m.patternId === node.patternId && !m.geometry
    );
    for (const mesh of meshes) this.remesh(mesh.id, { recordUndo: false });
    this.syncSplitBanner();
    this.renderSplitHeader();
    this.renderInspector();
    this.setStatus(
      meshes.length
        ? `Resynced ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'} from the pattern`
        : 'Resynced'
    );
  }

  /** 2D → 3D: mirror the pattern editor's picked pieces onto the 3D stage. */
  private syncSplitSelectionFrom2d(pieceIds: readonly string[]): void {
    const split = this.splitView;
    if (!split || this.splitSelectionSyncing) return;
    const stage = this.canvasNode(split.stageNodeId);
    if (!stage) return;
    this.splitSelectionSyncing = true;
    try {
      if (stage.type === 'simViewport') {
        this.simRuntimes.get(stage.simId)?.setSelectedPieces(pieceIds);
      } else if (stage.type === 'transform3d') {
        this.transformRuntimes.get(stage.transformId)?.setSelectedPieces(pieceIds);
      }
    } finally {
      this.splitSelectionSyncing = false;
    }
  }

  /** 3D → 2D: mirror the stage's piece selection onto the pattern editor. */
  private syncSplitSelectionFrom3d(
    kind: 'simViewport' | 'transform3d',
    entityId: string,
    pieceIds: readonly string[]
  ): void {
    const split = this.splitView;
    if (!split || this.splitSelectionSyncing) return;
    const stage = this.canvasNode(split.stageNodeId);
    // Only the stage that is actually on screen in the split drives the 2D side.
    const matches =
      (kind === 'simViewport' && stage?.type === 'simViewport' && stage.simId === entityId) ||
      (kind === 'transform3d' && stage?.type === 'transform3d' && stage.transformId === entityId);
    if (!matches) return;
    this.splitSelectionSyncing = true;
    try {
      this.editors.get(split.patternNodeId)?.setSelectedPieces(pieceIds);
    } finally {
      this.splitSelectionSyncing = false;
    }
  }

  private notifyNodeViewportResize(nodeId: string): void {
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (node.type === 'simViewport') {
      const rt = this.simRuntimes.get(node.simId);
      // Paused viewports render on demand, so a resize has to ask for a redraw.
      rt?.invalidate();
      rt?.resize();
    } else if (node.type === 'transform3d') {
      const rt = this.transformRuntimes.get(node.transformId);
      rt?.invalidate();
      rt?.resize();
    } else if (node.type === 'patternFrame') {
      this.editors.get(node.id)?.relayoutChrome();
    }
  }

  private isNodeSelected(nodeId: string): boolean {
    return this.selectedNodeIds.includes(nodeId);
  }

  /**
   * How a 2D container fronts its pattern. Locked is the frame on the canvas: the
   * box the node occupies *is* the view, so the work is the canvas's own size and
   * nothing inside it zooms. Expanded drops the lock and lets the view run past
   * the frame, which is what makes working beyond the border possible.
   */
  private containerModeFor(
    node: PatternFrameNode,
    expanded: boolean
  ): PatternEditorContainer {
    const view = containerView(node);
    const zoom = expanded ? 1 : this.project.canvas.zoom;
    return {
      cmScale: view.cmScale,
      viewX: view.viewX,
      viewY: view.viewY,
      frameWidthCm: node.width / view.cmScale,
      frameHeightCm: node.height / view.cmScale,
      // Clipping is a property of the container as it sits on the board: it is
      // how a window onto a pattern behaves next to its neighbours. Opened up,
      // the container *is* the workspace, so its frame must not cut the view.
      clip: expanded ? false : containerClips(node),
      locked: !expanded,
      // On the board the page's grid is behind the frame and shows through it, so
      // the frame must not draw a second one; opened up, it has to draw its own.
      drawsGrid: expanded,
      // On the board the whole node is scaled by the board's zoom, so the frame's
      // strokes, labels and handles have to be told how far — otherwise zooming
      // the canvas turns them into hairlines. Full screen is drawn 1:1, which is
      // the look this is matching.
      chromeScale: zoom,
      // A frame on the canvas thins out as the board zooms away from it; opened up
      // it draws the whole pattern, because at that point zooming out is a way of
      // looking at the work rather than a way of looking at the canvas.
      detail: expanded ? 'full' : this.detailForScale(view.cmScale * zoom),
      coarsePointer: expanded ? 'editor' : 'frame',
    };
  }

  /** How much of a pattern to draw, from how big a centimetre is on screen. */
  private detailForScale(screenPxPerCm: number): PatternDetail {
    if (screenPxPerCm >= CONTAINER_DETAIL_FULL_PX_PER_CM) return 'full';
    if (screenPxPerCm >= CONTAINER_DETAIL_PREVIEW_PX_PER_CM) return 'preview';
    return 'frame';
  }

  /**
   * A container that does not clip is allowed to draw outside itself, so it
   * paints above the frames it spills onto — otherwise its work would vanish
   * under whichever neighbour happened to be stacked next.
   */
  private nodeZIndex(node: CanvasNode): number {
    // A section is the ground the board stands on: it always paints behind every
    // other node, however its own layer number reads, and its own order among
    // sections is all its z-index is used for.
    if (isSection(node)) return node.zIndex - 1000;
    return node.type === 'patternFrame' && !containerClips(node)
      ? node.zIndex + 1000
      : node.zIndex;
  }

  /** Push a container's frame settings at its editor and the node element. */
  private syncContainer(node: PatternFrameNode, hostEl?: HTMLElement | null): void {
    // A node being mounted is not in the board yet, so the caller can hand over
    // the element it just built rather than have us look for it.
    const el = hostEl ?? this.findNodeEl(node.id);
    el?.classList.toggle('is-unclipped', !containerClips(node));
    const clipBtn = el?.querySelector('.node-clip-btn') as HTMLButtonElement | null;
    if (clipBtn) {
      const on = containerClips(node);
      clipBtn.classList.toggle('is-active', on);
      clipBtn.setAttribute('aria-pressed', String(on));
      clipBtn.title = on
        ? 'Clip contents to the frame (work outside is hidden)'
        : 'Contents spill past the frame';
    }
    this.editors
      .get(node.id)
      ?.setContainer(this.containerModeFor(node, this.expandedNodeId === node.id));
  }

  /**
   * Replace the node selection. `primary` is the node whose inspector is shown —
   * the one just clicked — and defaults to the last of `ids`.
   */
  private selectNodes(ids: readonly string[], primary?: string | null): void {
    this.applyNodeSelection(ids, primary);
    this.layoutNodes();
    this.renderInspector();
  }

  /** The selection without the inspector pass: for live marquee updates. */
  private applyNodeSelection(ids: readonly string[], primary?: string | null): void {
    this.selectedNodeIds = [...new Set(ids)].filter((id) =>
      this.project.canvas.nodes.some((n) => n.id === id)
    );
    this.selectedNodeId =
      primary && this.selectedNodeIds.includes(primary)
        ? primary
        : (this.selectedNodeIds[this.selectedNodeIds.length - 1] ?? null);
  }

  private clearNodeSelection(): void {
    if (this.selectedNodeIds.length === 0 && !this.selectedNodeId) return;
    this.applyNodeSelection([]);
    this.layoutNodes();
    this.renderInspector();
    // "3 nodes selected" must not outlive the selection it was about.
    this.setStatus('');
  }

  /** Add the node to the selection, or take it out when it is already picked. */
  private toggleNodeSelection(nodeId: string): void {
    const ids = this.selectedNodeIds.filter((id) => id !== nodeId);
    if (ids.length === this.selectedNodeIds.length) ids.push(nodeId);
    this.selectNodes(ids, nodeId);
    this.setStatus(
      this.selectedNodeIds.length > 1 ? `${this.selectedNodeIds.length} nodes selected` : ''
    );
  }

  /** Board coordinates from a point measured from the board wrap's top-left. */
  private boardFromWrap(x: number, y: number): { x: number; y: number } {
    const { panX, panY, zoom } = this.project.canvas;
    return { x: (x - panX) / zoom, y: (y - panY) / zoom };
  }

  /** ⌘/Ctrl-drag on empty board: rectangle-select whole nodes. */
  private beginNodeMarquee(e: PointerEvent): void {
    const wrap = document.getElementById('boardWrap')!;
    const rect = wrap.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'board-marquee';
    wrap.appendChild(el);
    const additive = e.shiftKey;
    this.nodeMarquee = {
      el,
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      base: additive ? [...this.selectedNodeIds] : [],
      moved: false,
    };
    this.placeNodeMarquee();
    wrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private updateNodeMarquee(e: PointerEvent): void {
    const marquee = this.nodeMarquee;
    if (!marquee) return;
    const rect = document.getElementById('boardWrap')!.getBoundingClientRect();
    marquee.x = e.clientX - rect.left;
    marquee.y = e.clientY - rect.top;
    if (Math.hypot(marquee.x - marquee.startX, marquee.y - marquee.startY) > 2) {
      marquee.moved = true;
    }
    this.placeNodeMarquee();
    // The rectangle is drawn in wrap-relative screen space; the nodes are hit in
    // board space.
    const a = this.boardFromWrap(marquee.startX, marquee.startY);
    const b = this.boardFromWrap(marquee.x, marquee.y);
    const hits = nodesInBoardRect(
      this.project.canvas.nodes,
      {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
      },
      (node) => this.isEmbeddedNode(node)
    ).map((node) => node.id);
    this.applyNodeSelection([...marquee.base, ...hits]);
    this.layoutNodes();
  }

  private placeNodeMarquee(): void {
    const marquee = this.nodeMarquee;
    if (!marquee) return;
    marquee.el.style.left = `${Math.min(marquee.startX, marquee.x)}px`;
    marquee.el.style.top = `${Math.min(marquee.startY, marquee.y)}px`;
    marquee.el.style.width = `${Math.abs(marquee.x - marquee.startX)}px`;
    marquee.el.style.height = `${Math.abs(marquee.y - marquee.startY)}px`;
  }

  private finishNodeMarquee(): void {
    const marquee = this.nodeMarquee;
    if (!marquee) return;
    this.nodeMarquee = null;
    marquee.el.remove();
    // A click rather than a drag: ⌘/Ctrl-click on empty board clears the way a
    // plain click does, so the modifier is not a trap.
    if (!marquee.moved && marquee.base.length === 0) {
      this.clearNodeSelection();
      return;
    }
    this.renderInspector();
    this.setStatus(
      this.selectedNodeIds.length > 1 ? `${this.selectedNodeIds.length} nodes selected` : ''
    );
  }

  private cancelNodeMarquee(): void {
    const marquee = this.nodeMarquee;
    if (!marquee) return;
    this.nodeMarquee = null;
    marquee.el.remove();
    this.selectNodes(marquee.base);
  }

  private beginNodeDrag(node: CanvasNode, e: PointerEvent): void {
    // Secondary buttons belong to the context menu, not to dragging.
    if (e.button !== 0) return;
    if (this.expandedNodeId === node.id) return;
    // Shift or ⌘/Ctrl adds the node to the selection (or drops it), so a drag
    // moves a group. Without a modifier the click picks just this node.
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive && !e.altKey) {
      this.toggleNodeSelection(node.id);
      if (!this.isNodeSelected(node.id)) return;
    } else if (!this.isNodeSelected(node.id)) {
      this.selectNodes([node.id]);
    } else {
      // Already part of the selection: keep the group, make this the primary.
      this.selectNodes(this.selectedNodeIds, node.id);
    }
    this.pushUndo();

    // A section is moved by moving everything inside it: the objects belong to it
    // by virtue of where they are, so they travel with it and stay in it.
    let targets = withSectionContents(
      this.project.canvas.nodes,
      this.selectedNodeIds,
      (entry) => this.isEmbeddedNode(entry)
    );
    // Option/Alt-drag: leave the originals in place and drag duplicates.
    if (e.altKey) {
      const copies = this.duplicateNodeGroup(targets, {
        offsetX: 0,
        offsetY: 0,
        recordUndo: false,
        select: false,
        announce: false,
      });
      if (copies.length > 0) {
        targets = copies.map((copy) => copy.id);
        this.selectNodes(targets, targets[targets.length - 1]);
      }
    }

    const zoom = this.project.canvas.zoom;
    this.draggingNodes = targets
      .map((id) => this.project.canvas.nodes.find((n) => n.id === id))
      .filter((n): n is CanvasNode => !!n)
      .map((n) => ({
        id: n.id,
        ox: (e.clientX - this.project.canvas.panX) / zoom - n.x,
        oy: (e.clientY - this.project.canvas.panY) / zoom - n.y,
      }));
    this.layoutNodes();
    e.preventDefault();
  }

  /**
   * Start a resize off a corner handle or, on a container, a frame edge. The
   * edges answer to the same letters as the corners, so `w` widens leftwards and
   * `n` grows upwards by the same code path.
   */
  private beginNodeResize(
    node: CanvasNode,
    corner: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'e' | 's' | 'w',
    e: PointerEvent
  ): void {
    if (!this.isNodeSelected(node.id)) this.selectNodes([node.id]);
    else this.selectNodes(this.selectedNodeIds, node.id);
    this.pushUndo();
    this.draggingNodes = null;
    const zoom = this.project.canvas.zoom;
    this.resizingNode = {
      id: node.id,
      corner,
      startBoardX: (e.clientX - this.project.canvas.panX) / zoom,
      startBoardY: (e.clientY - this.project.canvas.panY) / zoom,
      origX: node.x,
      origY: node.y,
      origW: node.width,
      origH: node.height,
      origView: node.type === 'patternFrame' ? containerView(node) : undefined,
    };
    this.layoutNodes();
    this.renderInspector();
    document.getElementById('boardWrap')?.setPointerCapture(e.pointerId);
  }

  /**
   * The floating action bar at the bottom middle of a viewport. Created on
   * demand and returned as the `.node-actions` element, so the existing button
   * styling and click handlers still apply.
   */
  private viewportActions(body: HTMLElement): HTMLElement {
    let wrap = body.querySelector(':scope > .node-viewport-actions') as HTMLElement | null;
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'node-viewport-actions';
      const actions = document.createElement('div');
      actions.className = 'node-actions';
      wrap.appendChild(actions);
      body.appendChild(wrap);
    }
    return wrap.querySelector('.node-actions') as HTMLElement;
  }

  /**
   * The bottom-centre action stack of a viewport node. It is a column, so
   * anything added above the bar (the split's stale warning) rides with it.
   */
  private viewportActionStack(nodeEl: HTMLElement | null): HTMLElement | null {
    // A docked inspector wraps the body in `.node-expand-main`.
    const body = nodeEl?.querySelector(
      ':scope > .node-body, :scope > .node-expand-main > .node-body'
    ) as HTMLElement | null;
    if (!body) return null;
    return this.viewportActions(body).parentElement;
  }

  private mountNode(node: CanvasNode): void {
    const el = document.createElement('div');
    // Remesh / transform stages owned by a drape live inside it: they keep their
    // DOM (so the fullscreen tabs can adopt them) but stay off the board.
    el.className = `canvas-node node-${node.type}${
      this.isEmbeddedNode(node) ? ' is-embedded' : ''
    }`;
    el.dataset.nodeId = node.id;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.width}px`;
    el.style.height = `${node.height}px`;
    el.style.zIndex = String(this.nodeZIndex(node));

    const body = document.createElement('div');
    body.className = 'node-body';
    let chrome: HTMLElement | null = null;

    // Image refs are chrome-less: drag the image itself (no title / fullscreen).
    // Sections are too — a section has no view to open and its name is its own
    // element on the board (see `mountSectionLabel`), so a header would only be a
    // second title bar with a full-screen button that has nothing to show.
    if (node.type !== 'image' && node.type !== 'section') {
      chrome = document.createElement('div');
      chrome.className = 'node-chrome';
      // Only the close / fullscreen button lives in the header; the node's own
      // actions float at the bottom middle of the viewport (see
      // `viewportActions`) so the top-right stays a single X.
      chrome.innerHTML = `
        <span class="node-title"></span>
        <div class="node-fullscreen-tabs" hidden role="tablist"></div>
        <div class="node-chrome-right">
          <button type="button" class="node-expand-btn" title="Open full screen" aria-label="Open full screen">⛶</button>
        </div>
      `;
      el.appendChild(chrome);
      chrome.querySelector('.node-expand-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openNodeFullscreen(node.id);
      });
      chrome.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        this.beginNodeDrag(node, e);
      });
      // The header always offers the node's own menu, whatever the body does
      // with right-clicks (the pattern editor uses them for piece actions).
      chrome.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showNodeMenu(node, e.clientX, e.clientY);
      });
    } else {
      body.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('.resize-handle')) return;
        this.beginNodeDrag(node, e);
      });
    }

    // A pattern frame drags by its body too, which is the whole frame when its
    // editor has handed the pointer over — at the canvas's coarser detail levels a
    // press there is meant to move the container. While the editor is drawing it
    // takes the press first and stops it here, so this costs an active frame
    // nothing.
    if (node.type === 'patternFrame') {
      body.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('.resize-handle')) return;
        this.beginNodeDrag(node, e);
      });
    }

    el.appendChild(body);

    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      const handle = document.createElement('div');
      handle.className = `resize-handle resize-${corner}`;
      handle.dataset.corner = corner;
      handle.title = 'Drag to resize';
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.beginNodeResize(node, corner, e);
      });
      el.appendChild(handle);
    }

    // A frame can be resized by its edges as well as its corners: hold ⌘/Ctrl and
    // drag any border. Plain drags along the border stay the editor's — the band
    // only takes the pointer while the modifier is down.
    if (node.type === 'patternFrame') {
      const edges = document.createElement('div');
      edges.className = 'node-frame-edges';
      for (const edge of ['n', 'e', 's', 'w'] as const) {
        const band = document.createElement('div');
        band.className = `node-frame-edge node-frame-edge-${edge}`;
        band.dataset.corner = edge;
        band.title = '⌘/Ctrl-drag to resize the frame';
        band.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.beginNodeResize(node, edge, e);
        });
        edges.appendChild(band);
      }
      el.appendChild(edges);
    }

    if (node.type === 'patternFrame') {
      const pattern = this.project.patterns.find((p) => p.id === node.patternId)!;
      chrome!.querySelector('.node-title')!.textContent = `Container · ${pattern.name}`;
      // The frame is the container's own chrome, so the clip toggle lives on it.
      const clipBtn = document.createElement('button');
      clipBtn.type = 'button';
      clipBtn.className = 'node-clip-btn';
      clipBtn.setAttribute('aria-label', 'Clip contents to frame');
      clipBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5.5 2.5h-3v3"/><path d="M10.5 13.5h3v-3"/><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke-dasharray="3 2.5"/></svg>`;
      clipBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.pushUndo();
        node.clip = !containerClips(node);
        this.syncContainer(node);
        this.layoutNodes();
        this.markDirty();
        this.setStatus(
          node.clip
            ? 'Clipping contents to the frame — nothing outside it is drawn'
            : 'Contents spill past the frame — the frame is unchanged'
        );
      });
      chrome!.querySelector('.node-chrome-right')?.prepend(clipBtn);
      const editorHost = document.createElement('div');
      editorHost.className = 'pattern-host';
      body.appendChild(editorHost);
      const editor = new PatternEditor(editorHost, pattern, this.project.displayUnit, {
        onBeforeChange: () => this.pushUndo(),
        onChange: () => {
          this.setStatus('Pattern edited — remesh to update');
          this.invalidateMeshesForPattern(pattern.id);
          // Flag the remesh chip immediately when editing inside fullscreen.
          this.refreshFullscreenTabs();
          // Pattern edits are document data — make sure they reach the file.
          this.markDirty();
        },
        // Rulers are drafting references: they repaint, but never invalidate.
        onRulerChange: () => this.markDirty(),
        getMeasurementLibrary: () => cachedMeasurementLibrary(),
        // Picked pieces drive the split view's 3D half.
        onSelectionChange: (pieceIds) => this.syncSplitSelectionFrom2d(pieceIds),
        // Dragged out past the frame, the work belongs to the canvas again.
        onPiecesDropped: (drop) => this.handOverDroppedPieces(node, drop),
      });
      this.editors.set(node.id, editor);
      this.syncContainer(node, el);
    } else if (node.type === 'meshFrame') {
      const mesh = this.project.meshes.find((m) => m.id === node.meshId)!;
      chrome!.querySelector('.node-title')!.textContent = `Mesh · ${mesh.name}`;
      const actions = this.viewportActions(body);
      actions.innerHTML = `<button type="button" data-mesh="remesh">Remesh</button>`;
      actions.addEventListener('click', () => this.remesh(mesh.id));
      const previewHost = document.createElement('div');
      previewHost.className = 'mesh-host';
      body.appendChild(previewHost);
      const pattern = this.project.patterns.find((p) => p.id === mesh.patternId);
      if (!mesh.geometry) remeshDocument(mesh, pattern);
      const preview = new MeshPreview(previewHost, mesh, this.project.displayUnit, pattern ?? null);
      this.meshPreviews.set(node.id, preview);
    } else if (node.type === 'simViewport') {
      const sim = this.project.sims.find((s) => s.id === node.simId)!;
      chrome!.querySelector('.node-title')!.textContent = `Sim · ${sim.name}`;
      const actions = this.viewportActions(body);
      const strainOn = this.simRuntimes.get(sim.id)?.isStrainMapEnabled() ?? false;
      actions.innerHTML = `
        <button type="button" data-sim="snap">Snapshot</button>
        <button type="button" data-sim="strain" class="sim-strain-btn${strainOn ? ' is-on' : ''}" title="Toggle fabric strain map (blue=compress, green=rest, red=stretch)" aria-pressed="${strainOn}">Strain</button>
      `;
      actions.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button[data-sim]') as HTMLButtonElement | null;
        if (!b) return;
        void this.onSimAction(node.simId, b.dataset.sim!);
      });
      const canvas = document.createElement('canvas');
      canvas.className = 'sim-canvas';
      body.classList.add('sim-body');
      body.appendChild(canvas);
      this.mountSimTransport(node.simId, body);
      this.mountSimExport(node.simId, body);
      // runtime attached after GPU init
      (el as HTMLElement & { _simCanvas?: HTMLCanvasElement; _simHost?: HTMLElement })._simCanvas =
        canvas;
      (el as HTMLElement & { _simHost?: HTMLElement })._simHost = body;
    } else if (node.type === 'transform3d') {
      const transform = this.project.transforms.find((t) => t.id === node.transformId)!;
      chrome!.querySelector('.node-title')!.textContent = `Transform 3D · ${transform.name}`;
      const actions = this.viewportActions(body);
      actions.innerHTML = `
        <button type="button" data-transform="reset">Reset layout</button>
        <button type="button" data-transform="rebuild">Rebuild</button>
      `;
      actions.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button[data-transform]') as HTMLButtonElement | null;
        if (!b) return;
        void this.onTransformAction(node.transformId, b.dataset.transform!);
      });
      const canvas = document.createElement('canvas');
      canvas.className = 'sim-canvas';
      body.classList.add('sim-body');
      body.appendChild(canvas);
      (el as HTMLElement & { _transformCanvas?: HTMLCanvasElement; _transformHost?: HTMLElement })._transformCanvas =
        canvas;
      (el as HTMLElement & { _transformHost?: HTMLElement })._transformHost = body;
    } else if (node.type === 'image') {
      const img = document.createElement('img');
      img.alt = node.label || 'image reference';
      img.draggable = false;
      if (node.src) {
        img.src = node.src;
      } else {
        // Never leave a bare `<img>` with no source: the browser paints nothing,
        // so a reference whose bytes went missing read as a dead node. The board
        // inspector is only shown in fullscreen, so the note carries its own way
        // back rather than pointing at a panel that is not there.
        img.hidden = true;
        const note = document.createElement('div');
        note.className = 'image-missing';
        note.innerHTML =
          '<strong>Image data missing</strong>' +
          '<span>The stored copy of this reference was lost.</span>' +
          '<button type="button" class="image-missing-relink">Re-link image…</button>';
        body.appendChild(note);
        const relink = note.querySelector('.image-missing-relink') as HTMLButtonElement;
        // The node body starts a drag on pointerdown; the button is not a drag.
        relink.addEventListener('pointerdown', (e) => e.stopPropagation());
        relink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.pickImageFile(node);
        });
      }
      body.appendChild(img);
      // Fill in aspect from the decoded image when missing (older snapshots).
      if (node.naturalAspect == null || !(node.naturalAspect > 0)) {
        img.addEventListener(
          'load',
          () => {
            const nw = img.naturalWidth;
            const nh = img.naturalHeight;
            if (nw > 0 && nh > 0) node.naturalAspect = nw / nh;
          },
          { once: true }
        );
      }
    } else if (node.type === 'section') {
      // A section is nothing but a frame: its label is mounted beside it on the
      // board (see `mountSectionLabel`), because the frame has to paint behind
      // every node and its label has to paint over every node.
    } else if (node.type === 'text') {
      chrome!.querySelector('.node-title')!.textContent = this.textNodeLabel(node);
      const content = document.createElement('div');
      content.className = 'node-text-content';
      content.contentEditable = 'true';
      content.spellcheck = false;
      content.setAttribute('role', 'textbox');
      content.setAttribute('aria-multiline', 'true');
      content.textContent = node.text;
      this.applyTextNodeStyle(node, content);
      content.addEventListener('input', () => {
        node.text = content.textContent ?? '';
        this.fitTextNode(node, content);
        chrome!.querySelector('.node-title')!.textContent = this.textNodeLabel(node);
        this.syncTextStyleBar();
        this.markDirty();
      });
      // Typing is the point of the object, so the editor keeps its own presses.
      content.addEventListener('pointerdown', (e) => e.stopPropagation());
      body.appendChild(content);
      // The box is a function of the text from the first paint: an auto-width
      // object is only as wide as what it says.
      queueMicrotask(() => this.fitTextNode(node, content));
      // A note is dragged by the border around its text rather than by a bar: the
      // band is invisible and only 12px thick, so the middle of the note stays a
      // place to type. Four strips rather than one ring, so each carries the move
      // cursor and the caret's own cursor survives inside.
      const grab = document.createElement('div');
      grab.className = 'node-text-grab';
      for (const edge of ['n', 'e', 's', 'w'] as const) {
        const band = document.createElement('div');
        band.className = `node-text-grab-band node-text-grab-band-${edge}`;
        band.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.beginNodeDrag(node, e);
        });
        grab.appendChild(band);
      }
      body.appendChild(grab);
    }

    this.mountNodePorts(el, node);
    this.board.appendChild(el);
    if (isSection(node)) this.mountSectionLabel(node);
    this.cacheBoardZoomChrome(node.id, el);
  }

  /**
   * Find the elements whose chrome is measured in screen pixels, once, as the node
   * is mounted.
   *
   * They are looked up here rather than on every zoom because a node's body can be
   * enormous — a cloth preview is a hundred thousand SVG nodes — and a board that
   * walked them all would spend more time searching for the chrome than drawing
   * it. There are a handful of them per node: the title bar, a frame's resize
   * bands, a note's grab bands.
   */
  private cacheBoardZoomChrome(nodeId: string, el: HTMLElement): void {
    const chrome = Array.from(
      el.querySelectorAll<HTMLElement>('.node-chrome, .node-frame-edge, .node-text-grab-band')
    );
    if (chrome.length === 0) {
      this.boardChrome.delete(nodeId);
      return;
    }
    this.boardChrome.set(nodeId, chrome);
    const value = String(this.project.canvas.zoom);
    for (const element of chrome) element.style.setProperty('--board-zoom', value);
    this.chromeVarZoom = this.project.canvas.zoom;
  }

  /**
   * A section's name, as its own element beside the frame.
   *
   * It cannot live inside the section: the frame has to paint behind every node
   * (so the canvas stays canvas), and anything inside it would be behind them
   * too — including the label, which has to be the one thing you can always
   * click. So it is a sibling, pinned to the frame's top-left corner and layered
   * over the board.
   */
  private mountSectionLabel(node: SectionNode): void {
    const label = document.createElement('div');
    label.className = 'node-section-label';
    label.dataset.sectionId = node.id;
    label.textContent = node.label;
    label.title = 'Double-click to rename · drag to move the section and everything in it';
    // A press drags the section; a second press in the same breath renames it.
    // Counted here rather than left to `dblclick`, which never arrives: a press
    // on a draggable thing has its default taken away, and the click that a
    // double-click is built from goes with it.
    let lastPress = 0;
    label.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).isContentEditable) return;
      const now = performance.now();
      if (e.button === 0 && now - lastPress < 450) {
        lastPress = 0;
        e.preventDefault();
        e.stopPropagation();
        this.renameSection(node, label);
        return;
      }
      lastPress = now;
      this.beginNodeDrag(node, e);
      // The label is a sibling of the frame, not inside it, so the board would
      // otherwise read this press as "empty canvas" and start a marquee over the
      // drag that is already under way.
      e.stopPropagation();
    });
    // The frame itself is see-through, so its label is also where the section is
    // right-clicked for its menu.
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showNodeMenu(node, e.clientX, e.clientY);
    });
    this.board.appendChild(label);
    this.sectionLabels.set(node.id, label);
    this.placeSectionLabel(node);
  }

  /** Pin a section's label to its frame's top-left corner. */
  private placeSectionLabel(node: SectionNode): void {
    const label = this.sectionLabels.get(node.id);
    if (!label) return;
    label.style.left = `${node.x}px`;
    label.style.top = `${node.y}px`;
    label.style.setProperty('--board-zoom', String(this.project.canvas.zoom));
    label.classList.toggle('selected', this.isNodeSelected(node.id));
  }

  private mountNodePorts(el: HTMLElement, node: CanvasNode): void {
    const addPort = (
      direction: 'in' | 'out',
      kind: 'pattern' | 'mesh' | 'transform' | 'sim',
      entityId: string
    ) => {
      const port = document.createElement('button');
      port.type = 'button';
      port.className = `node-port node-port-${direction}`;
      port.dataset.portDirection = direction;
      port.dataset.portKind = kind;
      port.dataset.entityId = entityId;
      port.dataset.nodeId = node.id;
      port.title =
        direction === 'out'
          ? `Drag ${kind} output to a compatible input`
          : `Drop a compatible connection on this ${kind} input`;
      port.setAttribute('aria-label', `${kind} ${direction === 'out' ? 'output' : 'input'} port`);

      if (direction === 'out' && kind !== 'sim') {
        port.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          this.beginWireDrag(
            { kind, id: entityId, nodeId: node.id },
            e.pointerId
          );
        });
      }
      el.appendChild(port);
    };

    if (node.type === 'patternFrame') {
      addPort('out', 'pattern', node.patternId);
      const out = el.querySelector(':scope > .node-port-out');
      out?.addEventListener('pointerenter', () => this.offerDrapeAttachment(node));
      out?.addEventListener('pointerleave', () => this.scheduleDrapeOfferHide());
    } else if (node.type === 'meshFrame') {
      addPort('in', 'mesh', node.meshId);
      addPort('out', 'mesh', node.meshId);
    } else if (node.type === 'transform3d') {
      addPort('in', 'mesh', node.transformId);
      addPort('out', 'transform', node.transformId);
    } else if (node.type === 'simViewport') {
      addPort('in', 'sim', node.simId);
      const port = el.querySelector('.node-port-in') as HTMLElement | null;
      if (port) {
        port.title =
          'Drop a pattern (or a mesh / transform) here — the remesh and transform stages live inside this drape';
      }
    }
  }

  private async initGpuAndSims(): Promise<void> {
    const generation = this.gpuInitGeneration;
    const stillCurrent = (): boolean => generation === this.gpuInitGeneration;

    try {
      if (!this.device) {
        const gpu = await createSharedGpu();
        if (!stillCurrent()) return;
        this.device = gpu.device;
      }
      if (!this.environment) {
        // The constructor already starts the saved HDRI (or the neutral studio
        // probe); this only reports a failure to load it.
        this.environment = new Environment(this.device, navigator.gpu.getPreferredCanvasFormat());
        const settings = loadEnvironmentSettings();
        if (settings.hdri) {
          void this.environment.whenIdle().catch((error: unknown) => {
            this.setStatus(
              `Could not load HDRI “${settings.hdri}”${error instanceof Error ? `: ${error.message}` : ''}`
            );
          });
        }
      }
    } catch (err) {
      if (!stillCurrent()) return;
      this.setStatus(`WebGPU unavailable: ${err}`);
      return;
    }

    for (const node of this.project.canvas.nodes) {
      if (!stillCurrent()) return;
      if (node.type !== 'simViewport') continue;
      const el = this.findNodeEl(node.id) as (HTMLElement & {
        _simCanvas?: HTMLCanvasElement;
        _simHost?: HTMLElement;
      }) | null;
      const canvas = el?._simCanvas;
      const host = el?._simHost ?? el ?? null;
      const sim = this.project.sims.find((s) => s.id === node.simId);
      if (!el || !canvas || !host || !sim) continue;

      const existingSim = this.simRuntimes.get(sim.id);
      if (existingSim) {
        existingSim.dispose();
        this.simRuntimes.delete(sim.id);
      }

      const runtime = new SimViewportRuntime(
        sim.id,
        canvas,
        host,
        this.device,
        sim,
        getDefaultSimCamera(this.project),
        {
          onApplyPatternEdit: (patternId, edited) =>
            this.applyPatternPointEdit(patternId, edited),
          onSelectionChange: (pieceIds) =>
            this.syncSplitSelectionFrom3d('simViewport', sim.id, pieceIds),
          environment: this.environment,
          materials: this.materials,
          onSewEdges: (a, b) => this.sewEdgesFromView(this.patternForSim(sim.id), a, b),
          onReverseSeam: (seamId) => this.reverseSeamFromView(this.patternForSim(sim.id), seamId),
          onDeleteSeam: (seamId) => this.deleteSeamFromView(this.patternForSim(sim.id), seamId),
          onArrangementCommit: (commit) => this.commitDrapeArrangement(sim.id, commit),
          onBeforeFreezeChange: () => this.pushUndo(),
          onFreezeChange: (pieceId, frozen) => {
            this.markDirty();
            const name = this.patternForSim(sim.id)?.pieces.find(
              (p) => p.id === pieceId
            )?.name;
            const label = name?.trim() || 'piece';
            this.setStatus(
              frozen
                ? `Froze ${label} — it holds its shape while the rest drapes`
                : `Unfroze ${label}`
            );
          },
          onGhostChange: (pieceId, ghosted) => {
            this.markDirty();
            const name = this.patternForSim(sim.id)?.pieces.find(
              (p) => p.id === pieceId
            )?.name;
            const label = name?.trim() || 'piece';
            this.setStatus(
              ghosted
                ? `Ghosted ${label} — it is out of the simulation until you un-ghost it`
                : `Un-ghosted ${label} — it is back in the simulation`
            );
          },
        }
      );
      await runtime.initRenderer();
      if (!stillCurrent()) {
        runtime.dispose();
        return;
      }
      runtime.rebuildCloth(
        this.meshGeometryForSim(sim.id),
        sim.params,
        this.poseForSim(sim.id),
        this.patternForSim(sim.id)
      );
      this.simRuntimes.set(sim.id, runtime);
    }

    for (const node of this.project.canvas.nodes) {
      if (!stillCurrent()) return;
      if (node.type !== 'transform3d') continue;
      const el = this.findNodeEl(node.id) as (HTMLElement & {
        _transformCanvas?: HTMLCanvasElement;
        _transformHost?: HTMLElement;
      }) | null;
      const canvas = el?._transformCanvas;
      const host = el?._transformHost ?? el ?? null;
      const transform = this.project.transforms.find((t) => t.id === node.transformId);
      if (!el || !canvas || !host || !transform) continue;

      const existingTransform = this.transformRuntimes.get(transform.id);
      if (existingTransform) {
        existingTransform.dispose();
        this.transformRuntimes.delete(transform.id);
      }

      const runtime = new Transform3dRuntime(
        transform.id,
        canvas,
        host,
        this.device,
        transform,
        getDefaultSimCamera(this.project),
        {
          onBeforePoseChange: () => this.pushUndo(),
          onPoseChange: () => {
            // Ignore the write-back that `persistSimStates()` performs.
            if (this.restoringUndo || this.capturingState) return;
            this.rebuildSimsFromTransform(transform.id);
            if (this.selectedNodeId === node.id) this.renderInspector();
            // Transform settings are document data — make sure they reach the file.
            this.markDirty();
          },
          onSelectionChange: (pieceIds, primary) => {
            this.transformInspectorPieceId = primary;
            this.syncSplitSelectionFrom3d('transform3d', transform.id, pieceIds);
            if (this.selectedNodeId === node.id) this.renderInspector();
          },
          environment: this.environment,
          materials: this.materials,
          onSewEdges: (a, b) => this.sewEdgesFromView(this.patternForTransform(transform.id), a, b),
          onReverseSeam: (seamId) =>
            this.reverseSeamFromView(this.patternForTransform(transform.id), seamId),
          onDeleteSeam: (seamId) =>
            this.deleteSeamFromView(this.patternForTransform(transform.id), seamId),
        }
      );
      await runtime.initRenderer();
      if (!stillCurrent()) {
        runtime.dispose();
        return;
      }
      runtime.rebuildCloth(
        this.meshGeometryForTransform(transform.id),
        transform.pose,
        transform.pieceTransforms,
        this.patternForTransform(transform.id)
      );
      this.transformRuntimes.set(transform.id, runtime);
    }

    if (!stillCurrent()) return;

    cancelAnimationFrame(this.raf);
    const loop = () => {
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.layoutNodes();
    // Now that the runtimes exist they can say whether each drape has been
    // simulated, which is what the transport buttons show.
    this.syncSimTransports();
    this.setStatus('Ready — Pattern → Mesh → Transform 3D → Sim');
    // Every viewport was just built on the bundled body; put the project's own
    // avatar back under the cloth (and under the transform stages) before the
    // user can drape anything.
    void this.restoreStoredAvatar();
    // Re-asserted here because the pipeline line above is rewritten whenever the
    // board redraws, and lost image bytes are not something to let scroll away.
    this.reportMissingImages();
  }

  private teardownSims(): void {
    cancelAnimationFrame(this.raf);
    // Full dispose rather than just dropping the cloth: the runtimes listen on
    // the window for their 3D keys, and the board is about to be cleared, so a
    // listener left behind would outlive the viewport it belongs to.
    for (const rt of this.simRuntimes.values()) {
      rt.dispose();
    }
    for (const rt of this.transformRuntimes.values()) {
      rt.dispose();
    }
    this.simRuntimes.clear();
    this.transformRuntimes.clear();
  }

  private transformForSim(simId: string) {
    const link = this.project.transformSimAssignments.find((a) => a.simId === simId);
    if (!link) return undefined;
    return this.project.transforms.find((t) => t.id === link.transformId);
  }

  private meshForTransform(transformId: string): MeshDocument | undefined {
    const transform = this.project.transforms.find((t) => t.id === transformId);
    if (!transform) return undefined;
    const link = this.project.meshTransformAssignments.find((a) => a.transformId === transformId);
    const meshId = link?.meshId ?? transform.meshId;
    return this.project.meshes.find((m) => m.id === meshId);
  }

  private patternForTransform(transformId: string): PatternDocument | undefined {
    const mesh = this.meshForTransform(transformId);
    if (!mesh) return this.project.patterns[0];
    return this.project.patterns.find((p) => p.id === mesh.patternId);
  }

  private meshGeometryForTransform(transformId: string) {
    const mesh = this.meshForTransform(transformId);
    if (!mesh) return null;
    const pattern = this.project.patterns.find((p) => p.id === mesh.patternId);
    if (
      !mesh.geometry ||
      mesh.geometry.vertexPieceIds?.length !== mesh.geometry.vertices.length
    ) {
      remeshDocument(mesh, pattern);
    }
    return mesh.geometry;
  }

  private poseForSim(simId: string) {
    const transform = this.transformForSim(simId);
    if (transform?.pose) return transform.pose;
    const sim = this.project.sims.find((s) => s.id === simId);
    return sim?.pose ?? null;
  }

  private rebuildSimsFromTransform(transformId: string): void {
    for (const link of this.project.transformSimAssignments.filter(
      (a) => a.transformId === transformId
    )) {
      this.rebuildConnectedSim(link.simId, false);
    }
  }

  private onTransformAction(transformId: string, action: string): void {
    const transform = this.project.transforms.find((t) => t.id === transformId);
    const rt = this.transformRuntimes.get(transformId);
    if (!transform || !rt) return;

    switch (action) {
      case 'reset':
        // resetLayout snapshots undo via onBeforePoseChange
        rt.resetLayout();
        this.rebuildSimsFromTransform(transformId);
        this.setStatus('Transform layout reset to default arrangement (-90° X)');
        break;
      case 'rebuild':
        this.pushUndo();
        rt.rebuildCloth(
          this.meshGeometryForTransform(transformId),
          transform.pose,
          transform.pieceTransforms,
          this.patternForTransform(transformId)
        );
        this.rebuildSimsFromTransform(transformId);
        this.setStatus('Transform viewport rebuilt from mesh');
        break;
    }
    this.renderInspector();
  }

  private rebuildConnectedTransform(transformId: string): void {
    const transform = this.project.transforms.find((t) => t.id === transformId);
    if (!transform) return;
    if (!transform.pieceTransforms) transform.pieceTransforms = {};
    const runtime = this.transformRuntimes.get(transformId);
    // Vertex pose cannot transfer across remesh; pieceTransforms can.
    // Snapshot before rebuild so a second linked rebuild can't persist a
    // already-reset layout (duplicate mesh→transform assignments).
    if (runtime) {
      runtime.persistArrangement();
    }
    const savedPieceTransforms = structuredClone(transform.pieceTransforms);
    transform.pose = null;
    if (!runtime) {
      transform.pieceTransforms = savedPieceTransforms;
      return;
    }
    runtime.rebuildCloth(
      this.meshGeometryForTransform(transformId),
      null,
      savedPieceTransforms,
      this.patternForTransform(transformId)
    );
    this.rebuildSimsFromTransform(transformId);
  }

  private meshForSim(simId: string): MeshDocument | undefined {
    const transform = this.transformForSim(simId);
    if (transform) {
      return this.meshForTransform(transform.id);
    }
    const a = this.project.assignments.find((x) => x.simId === simId);
    if (!a) return this.project.meshes[0];
    return this.project.meshes.find((m) => m.id === a.meshId);
  }

  private patternForSim(simId: string): PatternDocument | undefined {
    const mesh = this.meshForSim(simId);
    if (!mesh) return this.project.patterns[0];
    return this.project.patterns.find((p) => p.id === mesh.patternId);
  }

  private meshGeometryForSim(simId: string) {
    const mesh = this.meshForSim(simId);
    if (!mesh) return null;
    const pattern = this.project.patterns.find((p) => p.id === mesh.patternId);
    // Older saved/generated meshes predate per-vertex piece ownership. Rebuild
    // them automatically so individual panel picking works immediately.
    if (
      !mesh.geometry ||
      mesh.geometry.vertexPieceIds?.length !== mesh.geometry.vertices.length
    ) {
      remeshDocument(mesh, pattern);
    }
    return mesh.geometry;
  }

  private remesh(meshId: string, opts: { recordUndo?: boolean } = {}): void {
    const mesh = this.project.meshes.find((m) => m.id === meshId);
    if (!mesh) return;
    if (opts.recordUndo !== false) this.pushUndo();
    const pattern = this.project.patterns.find((p) => p.id === mesh.patternId);
    remeshDocument(mesh, pattern);
    for (const [nodeId, preview] of this.meshPreviews) {
      const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
      if (node?.type === 'meshFrame' && node.meshId === meshId) {
        preview.setMesh(mesh, pattern ?? null);
      }
    }
    this.setStatus(`Remeshed ${mesh.name}`);
    // Dedupe: duplicate mesh→transform links used to rebuild twice and lock in a reset.
    const transformIds = new Set<string>();
    for (const link of this.project.meshTransformAssignments) {
      if (link.meshId === meshId) transformIds.add(link.transformId);
    }
    for (const transform of this.project.transforms) {
      if (transform.meshId === meshId) transformIds.add(transform.id);
    }
    for (const transformId of transformIds) {
      this.rebuildConnectedTransform(transformId);
    }
    for (const a of this.project.assignments.filter((x) => x.meshId === meshId)) {
      this.rebuildConnectedSim(a.simId, true);
    }
    this.renderInspector();
  }

  /**
   * Commit a point edit made in the drape viewport's overlay: snapshot for undo,
   * swap in the edited pieces (point IDs are preserved so seams stay valid), then
   * remesh every dependent mesh — which rebuilds the transforms and the drape.
   */
  private applyPatternPointEdit(patternId: string, edited: PatternDocument): void {
    const target = this.project.patterns.find((p) => p.id === patternId);
    if (!target) return;
    this.pushUndo();
    target.pieces = edited.pieces;
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame' || node.patternId !== patternId) continue;
      this.editors.get(node.id)?.setPattern(target);
    }
    const meshes = this.project.meshes.filter((m) => m.patternId === patternId);
    for (const mesh of meshes) {
      this.remesh(mesh.id, { recordUndo: false });
    }
    this.setStatus(
      meshes.length
        ? `Pattern point edit applied — remeshed ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'}`
        : 'Pattern point edit applied'
    );
  }

  /**
   * Sew two cloth edges picked in a 3D viewport.
   *
   * The viewport knows ids and spans; the document, the undo snapshot and the
   * remesh belong to the app. Seams are not decoration — the mesher forces a
   * shared sample count along a sewn edge so stitch pairing is exact, so the
   * mesh has to be rebuilt for the seam to appear at all. The layout survives
   * that: a remesh keeps `pieceTransforms` and only drops the vertex pose.
   */
  private sewEdgesFromView(
    pattern: PatternDocument | null | undefined,
    a: SeamEdgeRef,
    b: SeamEdgeRef
  ): void {
    if (!pattern) return;
    if (pattern.seams.some((seam) => sameSeamBindingPair(seam.a, seam.b, a, b))) return;
    this.pushUndo();
    pattern.seams.push({ id: uid('seam'), a, b, restGapCm: DEFAULT_SEAM_GAP_CM });
    this.commitSeamEdit(pattern, 'Sewed two cloth edges');
  }

  /**
   * Turn a seam end for end, so its two sides are read the same way round.
   *
   * Which end of an edge meets which is decided by direction, and on a mirrored
   * piece "the same way" is not the way it looks — this is the correction. Same
   * operation as the pattern editor's seam menu, reached from the cloth instead.
   */
  private reverseSeamFromView(
    pattern: PatternDocument | null | undefined,
    seamId: string
  ): void {
    const seam = pattern?.seams.find((s) => s.id === seamId);
    if (!pattern || !seam) return;
    this.pushUndo();
    const t0 = seam.b.t0;
    seam.b.t0 = seam.b.t1;
    seam.b.t1 = t0;
    this.commitSeamEdit(pattern, 'Reversed the seam direction');
  }

  /** Drop a seam chosen from a 3D viewport's edge popover, then remesh. */
  private deleteSeamFromView(
    pattern: PatternDocument | null | undefined,
    seamId: string
  ): void {
    if (!pattern) return;
    const index = pattern.seams.findIndex((seam) => seam.id === seamId);
    if (index < 0) return;
    this.pushUndo();
    pattern.seams.splice(index, 1);
    this.commitSeamEdit(pattern, 'Deleted the seam');
  }

  private commitSeamEdit(pattern: PatternDocument, status: string): void {
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame' || node.patternId !== pattern.id) continue;
      this.editors.get(node.id)?.setPattern(pattern);
    }
    const meshes = this.project.meshes.filter((m) => m.patternId === pattern.id);
    for (const mesh of meshes) {
      this.remesh(mesh.id, { recordUndo: false });
    }
    this.markDirty();
    this.setStatus(
      meshes.length
        ? `${status} — remeshed ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'}`
        : `${status} — remesh to update the drape`
    );
    this.renderInspector();
  }

  private invalidateMeshesForPattern(patternId: string): void {
    const pattern = this.project.patterns.find((p) => p.id === patternId);
    for (const mesh of this.project.meshes) {
      if (mesh.patternId === patternId) mesh.geometry = null;
    }
    for (const [nodeId, preview] of this.meshPreviews) {
      const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
      if (node?.type !== 'meshFrame') continue;
      const mesh = this.project.meshes.find((m) => m.id === node.meshId);
      if (mesh?.patternId === patternId) preview.setMesh(mesh, pattern ?? null);
    }
  }

  private tick(): void {
    const active = this.project.activeSimId;
    for (const [simId, rt] of this.simRuntimes) {
      rt.frame(simId === active, this.viewportIsVisible('simViewport', simId));
    }
    for (const [transformId, rt] of this.transformRuntimes) {
      rt.frame(this.viewportIsVisible('transform3d', transformId));
    }
  }

  /**
   * Whether a viewport is on screen. A fullscreen stage covers the board, so the
   * stages behind it must not keep rendering — that is continuous GPU work for
   * something nobody can see, and it is what made interaction feel sluggish on
   * slower compositors. The split view shows its two panes only.
   */
  private viewportIsVisible(
    type: 'simViewport' | 'transform3d',
    id: string
  ): boolean {
    const expanded = this.expandedNodeId;
    if (!expanded && !this.splitView) return true;
    const visibleId = (nodeId: string): boolean => {
      if (this.splitView) {
        return nodeId === this.splitView.patternNodeId || nodeId === this.splitView.stageNodeId;
      }
      return nodeId === expanded;
    };
    const node = this.project.canvas.nodes.find((n) =>
      type === 'simViewport'
        ? n.type === 'simViewport' && n.simId === id
        : n.type === 'transform3d' && n.transformId === id
    );
    // A runtime with no node of its own cannot be judged — keep drawing it.
    return node ? visibleId(node.id) : true;
  }

  private persistTransformStates(): void {
    for (const transform of this.project.transforms) {
      const rt = this.transformRuntimes.get(transform.id);
      if (!rt?.cloth) continue;
      rt.captureCamera(transform);
      rt.persistArrangement();
    }
  }

  /** Sync live sim/transform state into the project before recording undo/redo. */
  private snapshotProjectForHistory(): void {
    this.persistTransformStates();
    for (const sim of this.project.sims) {
      const rt = this.simRuntimes.get(sim.id);
      if (!rt?.cloth) continue;
      rt.captureCamera(sim);
      sim.pose = rt.cloth.exportPose();
      sim.dropped = true;
    }
    syncDefaultCameraFromDrapeA(this.project);
  }

  /**
   * Capture the current live camera for every mounted viewport. Camera moves and
   * zooms are view state, so this is used to keep the user's view fixed while
   * undo/redo restores the document.
   */
  private captureLiveCameras(): CameraSnapshot {
    const transforms = new Map<string, SimCameraState>();
    const sims = new Map<string, SimCameraState>();
    for (const transform of this.project.transforms) {
      const rt = this.transformRuntimes.get(transform.id);
      if (!rt?.cloth) continue;
      rt.captureCamera(transform);
      transforms.set(transform.id, cloneSimCamera(transform.camera));
    }
    for (const sim of this.project.sims) {
      const rt = this.simRuntimes.get(sim.id);
      if (!rt?.cloth) continue;
      rt.captureCamera(sim);
      sims.set(sim.id, cloneSimCamera(sim.camera));
    }
    const board = {
      panX: this.project.canvas.panX,
      panY: this.project.canvas.panY,
      zoom: this.project.canvas.zoom,
    };
    const patterns = new Map<string, PatternViewBox>();
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame') continue;
      const editor = this.editors.get(node.id);
      if (editor) patterns.set(node.id, editor.getViewBox());
    }
    return { transforms, sims, board, patterns };
  }

  /** Restore the captured cameras onto a freshly loaded history snapshot. */
  private applyLiveCameras(snapshot: CameraSnapshot): void {
    for (const transform of this.project.transforms) {
      const cam = snapshot.transforms.get(transform.id);
      if (cam) transform.camera = cloneSimCamera(cam);
    }
    for (const sim of this.project.sims) {
      const cam = snapshot.sims.get(sim.id);
      if (cam) sim.camera = cloneSimCamera(cam);
    }
    // The board's pan/zoom rides in the document, so the freshly loaded snapshot
    // would otherwise snap the canvas back to where it was at that edit.
    this.project.canvas.panX = snapshot.board.panX;
    this.project.canvas.panY = snapshot.board.panY;
    this.project.canvas.zoom = snapshot.board.zoom;
    this.applyBoardTransform();
  }

  /** Push the preserved cameras onto live runtimes verbatim (no migration). */
  private applyLiveCamerasToRuntimes(snapshot: CameraSnapshot): void {
    for (const transform of this.project.transforms) {
      const cam = snapshot.transforms.get(transform.id);
      if (cam) this.transformRuntimes.get(transform.id)?.setCameraState(cam);
    }
    for (const sim of this.project.sims) {
      const cam = snapshot.sims.get(sim.id);
      if (cam) this.simRuntimes.get(sim.id)?.setCameraState(cam);
    }
    // Pattern editors are recreated (and re-framed) on a remount, so re-assert
    // each one's captured zoom/pan after the runtimes have been rebuilt.
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame') continue;
      const box = snapshot.patterns.get(node.id);
      if (box) this.editors.get(node.id)?.setViewBox(box);
    }
  }

  /**
   * True while live viewport state is being copied into the document. The
   * runtimes report those copies as pose changes, and re-acting to them would
   * rebuild sims mid-save and re-schedule the save we are already running.
   */
  private capturingState = false;

  private persistSimStates(): void {
    const previous = this.capturingState;
    this.capturingState = true;
    try {
      this.persistTransformStates();
      for (const sim of this.project.sims) {
        const rt = this.simRuntimes.get(sim.id);
        if (!rt?.cloth) continue;
        rt.captureCamera(sim);
        sim.pose = rt.cloth.exportPose();
        sim.dropped = true;
      }
      syncDefaultCameraFromDrapeA(this.project);
      const defaults = getDefaultSimCamera(this.project);
      for (const rt of this.simRuntimes.values()) {
        rt.setDefaultCamera(defaults);
      }
    } finally {
      this.capturingState = previous;
    }
  }

  /**
   * The drape's transport, bottom-left: play/pause and a rewind that rebuilds.
   *
   * Play/pause carries the state of the drape. Live, it shows a pause glyph and
   * reads as the running drape it is; paused, a play glyph; and a drape that has
   * only been *rebuilt* — laid out from its Transform 3D node but never simulated
   * — is dimmed and dashed, because what is on screen is a layout, not a drape.
   */
  private mountSimTransport(simId: string, body: HTMLElement): void {
    const bar = document.createElement('div');
    bar.className = 'sim-transport';
    bar.innerHTML = `
      <button type="button" class="sim-transport-btn sim-play-btn" data-sim="activate">
        <svg class="sim-icon sim-icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>
        <svg class="sim-icon sim-icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5h3.5v14H7.5zM13 5h3.5v14H13z"/></svg>
      </button>
      <button type="button" class="sim-transport-btn sim-rewind-btn" data-sim="rebuild" title="Rewind — drop the drape and lay the pieces out from the Transform 3D node again">
        <svg class="sim-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 12l8.5-5.5v11zM2.5 12L11 6.5v11z"/></svg>
      </button>
    `;
    bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-sim]') as HTMLButtonElement | null;
      if (!b) return;
      void this.onSimAction(simId, b.dataset.sim!);
    });
    body.appendChild(bar);
    const play = bar.querySelector('.sim-play-btn') as HTMLButtonElement;
    this.simTransports.set(simId, { play, state: null });
    this.syncSimTransport(simId);
  }

  /**
   * Export the drape as an OBJ, bottom-right of the viewport.
   *
   * One file, two objects: the avatar it is draped on and the cloth as it stands
   * right now, so the shape can leave the studio and be looked at — or printed,
   * or measured — elsewhere. Positions come from the same CPU mirror the
   * viewport draws from, so what you export is what you see, mid-drag included.
   */
  private mountSimExport(simId: string, body: HTMLElement): void {
    this.simExports.set(
      simId,
      new SimExportControl(body, {
        onExportObj: () => this.exportDrapeObj(simId),
        onExportPack: () => this.exportBlenderPack(simId),
      })
    );
  }

  /** Everything an OBJ export needs, in the units the exporter writes. */
  private drapeExportParts(simId: string): { sim: SimInstance | undefined; parts: ObjPart[] } {
    const runtime = this.simRuntimes.get(simId);
    const sim = this.project.sims.find((s) => s.id === simId);
    const parts: ObjPart[] = [];

    const avatar = runtime?.getAvatarBody() ?? null;
    if (avatar) {
      const bake = avatar.getCollisionBakeData();
      parts.push({ name: 'avatar', positions: bake.positions, indices: bake.indices });
    }
    const cloth = runtime?.getCloth() ?? null;
    const positions = cloth?.getPositionsSnapshot?.() ?? null;
    const indices = cloth?.getTriangleIndices?.() ?? null;
    if (positions && indices) {
      parts.push({ name: `cloth_${sim?.name ?? 'drape'}`, positions, indices });
    }
    return { sim, parts };
  }

  private exportDrapeObj(simId: string): void {
    const { sim, parts } = this.drapeExportParts(simId);
    if (parts.length === 0) {
      this.setStatus('Nothing to export from this drape yet');
      return;
    }
    const fileName = objFileName(sim?.name ?? 'drape');
    downloadTextFile(buildObj(parts), fileName);
    const triangles = parts.reduce((sum, part) => sum + Math.floor(part.indices.length / 3), 0);
    this.setStatus(
      `Exported ${fileName} — ${parts.length === 2 ? 'avatar and cloth' : 'cloth'}, ${triangles.toLocaleString()} triangles in metres`
    );
  }

  /**
   * The Blender pack: the garment at its layout pose, the body, the seam map and
   * a `bpy` script that builds a Cloth setup from them.
   *
   * The layout pose is the point — Blender reads frame 1 as the fabric's rest
   * shape, so a pack of the draped pose would ask Blender to start from a
   * crumple. This is the same split the studio itself makes between a rebuilt
   * drape and a simulated one.
   */
  private exportBlenderPack(simId: string): void {
    const runtime = this.simRuntimes.get(simId);
    const cloth = runtime?.getCloth() ?? null;
    const rest = cloth?.getRestPositionsSnapshot?.() ?? null;
    const indices = cloth?.getTriangleIndices?.() ?? null;
    if (!cloth || !rest || !indices) {
      this.setStatus('Nothing to export from this drape yet');
      return;
    }

    const sim = this.project.sims.find((s) => s.id === simId);
    const mesh = this.meshForSim(simId);
    const pattern = this.patternForSim(simId);
    const avatar = runtime?.getAvatarBody() ?? null;
    const bake = avatar?.getCollisionBakeData() ?? null;

    // Seam pairs with the gathered side's crowd floor, recomputed from the
    // pattern and the mesh the cloth was built from — the same call the solver
    // makes, so the pack cannot drift from what the viewport is doing.
    const pairs = mesh?.geometry && pattern ? resolveSeamParticlePairs(pattern, mesh.geometry) : [];
    const seams: BlenderPackSeam[] = pairs.map((pair) => ({
      i: pair.a,
      j: pair.b,
      restMetres: pair.restCm * 0.01,
      gatherI: pair.crowdA,
      gatherJ: pair.crowdB,
    }));

    const pieceIds = cloth.getVertexPieceIds();
    const ghosted = new Set(cloth.getGhostedPieceIds?.() ?? []);
    const frozen = new Set(cloth.getFrozenPieceIds());
    const pins: number[] = [];
    for (let i = 0; i < pieceIds.length; i++) {
      if (frozen.has(pieceIds[i]!)) pins.push(i);
    }
    const pieceNames: Record<string, string> = {};
    for (const piece of pattern?.pieces ?? []) pieceNames[piece.id] = piece.name;

    const pack = buildBlenderPack({
      projectName: this.project.name,
      drapeName: sim?.name ?? 'Drape',
      patternName: pattern?.name ?? 'Pattern',
      meshName: mesh?.name ?? 'Mesh',
      cloth: { positions: rest, indices, pieceIds },
      avatar: bake ? { positions: bake.positions, indices: bake.indices } : null,
      seams,
      pins,
      pieceNames,
      excludePieces: [...ghosted],
      sim: {
        substeps: sim?.params.substeps ?? 8,
        constraintIterations: sim?.params.constraintIterations,
        mass: sim?.params.mass ?? 100,
        contactFriction: sim?.params.contactFriction,
        gravity: sim?.params.gravity,
        maxSpeed: sim?.params.maxSpeed,
        engine: sim?.params.engine,
      },
    });

    const fileName = blenderPackFileName(sim?.name ?? 'drape');
    downloadFile(new Blob([pack.zip.slice()]), fileName, 'application/zip');
    this.setStatus(
      `Exported ${fileName} — ${pack.summary.vertices.toLocaleString()} vertices, ` +
        `${pack.summary.seams.toLocaleString()} seam pairs, ${Math.round(pack.summary.bytes / 1024)} kB`
    );
  }

  /**
   * Which of the three things a drape can be doing right now.
   *
   * There is no `running` flag to read: a sim is live exactly when it is the
   * project's active sim, and "rebuilt but not yet simulated" is the difference
   * between a drape that has been played and one that is still showing the
   * layout its upstream node produced.
   */
  private simPlayState(simId: string): SimPlayState {
    if (this.project.activeSimId === simId) return 'live';
    // The live runtime knows whether the fabric has actually been stepped, which
    // is the honest answer: a cloth rebuilt from its upstream layout shows the
    // layout however the document was last saved.
    const rt = this.simRuntimes.get(simId);
    if (rt) return rt.hasSteppedSimulation() ? 'paused' : 'ready';
    // Nothing mounted yet (a node being mounted, or one that is off board): the
    // document's own record of the last run is all there is to go on.
    const sim = this.project.sims.find((s) => s.id === simId);
    return sim?.simulated === false ? 'ready' : 'paused';
  }

  private syncSimTransport(simId: string): void {
    const entry = this.simTransports.get(simId);
    if (!entry) return;
    const state = this.simPlayState(simId);
    if (entry.state === state) return;
    entry.state = state;
    const live = state === 'live';
    // One button, two verbs: what a click means is what the glyph shows.
    entry.play.dataset.sim = live ? 'pause' : 'activate';
    entry.play.classList.toggle('is-live', live);
    entry.play.classList.toggle('is-ready', state === 'ready');
    entry.play.setAttribute('aria-pressed', String(live));
    entry.play.setAttribute('aria-label', live ? 'Pause the drape' : 'Play the drape');
    entry.play.title =
      state === 'live'
        ? 'Running — click to pause'
        : state === 'ready'
          ? 'Rebuilt, not draped yet — click to run the simulation'
          : 'Paused — click to keep simulating';
  }

  private syncSimTransports(): void {
    for (const simId of this.simTransports.keys()) this.syncSimTransport(simId);
  }

  /**
   * A drag in a drape that has not been simulated yet is *placement*, not a nudge
   * to a simulation: the pieces still lie where the upstream Transform 3D node
   * put them, so the move belongs to that node. Writing it back as per-piece
   * positions and orientations (and the layout pose) is what keeps it — the next
   * rebuild re-lays the cloth out from the transform node, and a move that only
   * lived in the drape's cloth would be lost there.
   *
   * Once the drape has been played the pieces have a simulation of their own and
   * the drag is a nudge; overwriting the upstream layout with a draped shape
   * would be wrong, so that case is left alone.
   */
  private commitDrapeArrangement(simId: string, commit: PlacementCommit): void {
    if (this.simPlayState(simId) !== 'ready') return;
    const transform = this.transformForSim(simId);
    const sim = this.project.sims.find((s) => s.id === simId);
    const cloth = this.simRuntimes.get(simId)?.cloth ?? null;
    if (!transform || !sim || !cloth) return;
    this.pushUndo();
    for (const pieceId of commit.pieceIds) {
      const stored = transform.pieceTransforms[pieceId] ?? {
        position: cloth.getPieceCentroidTuple(pieceId),
        rotationDeg: [0, 0, 0] as [number, number, number],
      };
      const orientation = quat.fromValues(...resolvePieceQuat(stored));
      // Same accumulation the transform stage does for its own drags: each turn
      // goes on the world axes, on top of the orientation the piece already had.
      for (const turn of commit.turns) {
        const delta = quat.create();
        quat.setAxisAngle(delta, vec3.fromValues(...turn.axis), turn.radians);
        quat.multiply(orientation, delta, orientation);
        quat.normalize(orientation, orientation);
      }
      const rotationQuat: [number, number, number, number] = [
        orientation[0],
        orientation[1],
        orientation[2],
        orientation[3],
      ];
      transform.pieceTransforms[pieceId] = {
        position: cloth.getPieceCentroidTuple(pieceId),
        rotationDeg: quatToEulerDeg(rotationQuat),
        rotationQuat,
      };
    }
    // The transform viewport shows the same layout, so it has to catch up with it.
    const transformRuntime = this.transformRuntimes.get(transform.id);
    if (transformRuntime) transformRuntime.applyStoredArrangement();
    if (transform.pose) sim.pose = transform.pose;
    this.markDirty();
    if (this.selectedNodeId) this.renderInspector();
    const count = commit.pieceIds.length;
    this.setStatus(
      `Placed ${count === 1 ? 'piece' : `${count} pieces`} — the Transform 3D layout they came from now holds this arrangement`
    );
  }

  private async onSimAction(simId: string, action: string): Promise<void> {
    const sim = this.project.sims.find((s) => s.id === simId);
    const rt = this.simRuntimes.get(simId);
    if (!sim || !rt) return;

    switch (action) {
      case 'activate':
        if (this.project.activeSimId && this.project.activeSimId !== simId) {
          this.pauseSim(this.project.activeSimId);
        }
        this.project.activeSimId = simId;
        sim.dropped = true;
        sim.simulated = true;
        this.setStatus(`Active: ${sim.name} — drag fabric to move · empty drag to orbit`);
        break;
      case 'pause':
        this.pauseSim(simId);
        if (this.project.activeSimId === simId) this.project.activeSimId = null;
        this.setStatus(`Paused: ${sim.name}`);
        break;
      case 'reset':
        rt.cloth?.resetToInitialState();
        sim.pose = null;
        // Reset returns every piece to its rest layout, so nothing stays held.
        delete sim.frozenPieces;
        delete sim.ghostedPieces;
        sim.simulated = false;
        this.setStatus(`Reset: ${sim.name}`);
        break;
      case 'rebuild':
        this.persistSimStates();
        const initialPose = this.poseForSim(simId);
        sim.pose = initialPose;
        sim.dropped = true;
        // Laid out afresh: nothing has been simulated since.
        sim.simulated = false;
        rt.rebuildCloth(
          this.meshGeometryForSim(simId),
          sim.params,
          initialPose,
          this.patternForSim(simId)
        );
        this.setStatus(
          initialPose ? 'Drape rebuilt from Transform 3D layout' : 'Drape rebuilt from mesh node'
        );
        break;
      case 'snap':
        await this.snapshotSim(simId);
        break;
      case 'strain': {
        const next = !rt.isStrainMapEnabled();
        rt.setStrainMapEnabled(next);
        const node = this.project.canvas.nodes.find(
          (n) => n.type === 'simViewport' && n.simId === simId
        );
        if (node) {
          const strainBtn = this.findNodeEl(node.id)?.querySelector(
            'button[data-sim="strain"]'
          ) as HTMLButtonElement | null;
          if (strainBtn) {
            strainBtn.classList.toggle('is-on', next);
            strainBtn.setAttribute('aria-pressed', String(next));
          }
        }
        this.setStatus(
          next
            ? 'Strain map on — blue compress · green rest · red stretch'
            : 'Strain map off'
        );
        break;
      }
    }
    this.layoutNodes();
    this.syncSimTransports();
    this.renderInspector();
  }

  private pauseSim(simId: string): void {
    const sim = this.project.sims.find((s) => s.id === simId);
    const rt = this.simRuntimes.get(simId);
    if (!sim || !rt?.cloth) return;
    rt.captureCamera(sim);
    sim.pose = rt.cloth.exportPose();
    sim.dropped = true;
  }

  private async snapshotSim(simId: string): Promise<void> {
    const rt = this.simRuntimes.get(simId);
    const sim = this.project.sims.find((s) => s.id === simId);
    if (!rt || !sim) return;
    const src = await rt.snapshotDataUrl();
    const node: ImageNode = {
      type: 'image',
      id: uid('node'),
      x: 980,
      y: 80 + this.project.canvas.nodes.filter((n) => n.type === 'image').length * 40,
      width: 280,
      height: 200,
      zIndex: 50 + this.project.canvas.nodes.length,
      src,
      label: `Snapshot · ${sim.name}`,
      naturalAspect: 280 / 200,
    };
    void this.loadImageNaturalSize(src)
      .then(({ w, h }) => {
        node.naturalAspect = w / h;
      })
      .catch(() => {
        /* keep fallback aspect */
      });
    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    this.drawWires();
    this.setStatus('Snapshot placed on canvas');
  }

  private nodePortPoint(
    node: { x: number; y: number; width: number; height: number },
    direction: 'in' | 'out'
  ): { x: number; y: number } {
    const { panX, panY, zoom } = this.project.canvas;
    return {
      x: panX + (node.x + (direction === 'out' ? node.width : 0)) * zoom,
      y: panY + (node.y + node.height / 2) * zoom,
    };
  }

  private appendWirePath(
    from: { x: number; y: number },
    to: { x: number; y: number },
    className: string
  ): void {
    const pull = Math.max(48, Math.abs(to.x - from.x) * 0.5);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      `M ${from.x} ${from.y} C ${from.x + pull} ${from.y}, ${to.x - pull} ${to.y}, ${to.x} ${to.y}`
    );
    path.setAttribute('class', className);
    this.wiresSvg.appendChild(path);
  }

  private beginWireDrag(source: WireSource, pointerId: number): void {
    const node = this.project.canvas.nodes.find((candidate) => candidate.id === source.nodeId);
    if (!node) return;
    const start = this.nodePortPoint(node, 'out');
    this.wireDrag = { ...source, pointerId, x: start.x, y: start.y };
    const wrap = document.getElementById('boardWrap');
    wrap?.setPointerCapture(pointerId);
    wrap?.classList.add('is-wiring');
    this.drawWires();
  }

  private isMeshFrameInput(target: HTMLElement): boolean {
    const node = this.project.canvas.nodes.find((n) => n.id === target.dataset.nodeId);
    return node?.type === 'meshFrame';
  }

  private isTransformInput(target: HTMLElement): boolean {
    const node = this.project.canvas.nodes.find((n) => n.id === target.dataset.nodeId);
    return node?.type === 'transform3d';
  }

  private isValidWireTarget(target: HTMLElement | null): boolean {
    if (!target || !this.wireDrag) return false;
    const kind = target.dataset.portKind;
    return (
      target.dataset.portDirection === 'in' &&
      ((this.wireDrag.kind === 'pattern' &&
        ((kind === 'mesh' && this.isMeshFrameInput(target)) || kind === 'sim')) ||
        (this.wireDrag.kind === 'mesh' &&
          ((kind === 'mesh' && this.isTransformInput(target)) || kind === 'sim')) ||
        (this.wireDrag.kind === 'transform' && kind === 'sim'))
    );
  }

  private highlightWireTarget(clientX: number, clientY: number): void {
    this.board.querySelectorAll('.node-port.is-drop-target').forEach((port) => {
      port.classList.remove('is-drop-target');
    });
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('.node-port-in');
    if (this.isValidWireTarget(target ?? null)) target?.classList.add('is-drop-target');
  }

  private finishWireDrag(clientX: number, clientY: number): void {
    const source = this.wireDrag;
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('.node-port-in');

    if (source && this.isValidWireTarget(target ?? null)) {
      this.pushUndo();
      const targetId = target!.dataset.entityId!;
      if (source.kind === 'pattern') {
        const pattern = this.project.patterns.find((candidate) => candidate.id === source.id);
        if (pattern && target!.dataset.portKind === 'sim') {
          // Pattern dropped straight on a drape: remesh + transform are created
          // inside it, so no mesh/transform nodes are needed on the board.
          const sim = this.project.sims.find((candidate) => candidate.id === targetId);
          if (sim) {
            const addedTransform = this.connectPatternToSim(pattern, sim);
            if (addedTransform) void this.initGpuAndSims();
          }
        } else {
          const mesh = this.project.meshes.find((candidate) => candidate.id === targetId);
          if (mesh && pattern) {
            mesh.patternId = pattern.id;
            remeshDocument(mesh, pattern);
            for (const [nodeId, preview] of this.meshPreviews) {
              const node = this.project.canvas.nodes.find((candidate) => candidate.id === nodeId);
              if (node?.type === 'meshFrame' && node.meshId === mesh.id) {
                preview.setMesh(mesh, pattern);
              }
            }
            for (const assignment of this.project.assignments) {
              if (assignment.meshId === mesh.id) this.rebuildConnectedSim(assignment.simId, true);
            }
            for (const link of this.project.meshTransformAssignments.filter(
              (assignment) => assignment.meshId === mesh.id
            )) {
              this.rebuildConnectedTransform(link.transformId);
            }
            this.setStatus(`Connected ${pattern.name} → ${mesh.name}`);
          }
        }
      } else if (source.kind === 'transform') {
        const transform = this.project.transforms.find((candidate) => candidate.id === source.id);
        const sim = this.project.sims.find((candidate) => candidate.id === target!.dataset.entityId);
        if (transform && sim) {
          this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
            (assignment) => assignment.simId !== sim.id
          );
          this.project.transformSimAssignments.push({
            id: uid('assign'),
            transformId: transform.id,
            simId: sim.id,
          });
          this.project.assignments = this.project.assignments.filter(
            (assignment) => assignment.simId !== sim.id
          );
          this.rebuildConnectedSim(sim.id, false);
          this.setStatus(`Connected ${transform.name} → ${sim.name}`);
        }
      } else {
        const mesh = this.project.meshes.find((candidate) => candidate.id === source.id);
        const targetKind = target!.dataset.portKind;
        const targetId = target!.dataset.entityId!;
        if (targetKind === 'mesh') {
          const transform = this.project.transforms.find((candidate) => candidate.id === targetId);
          if (mesh && transform) {
            transform.meshId = mesh.id;
            this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
              (assignment) => assignment.transformId !== transform.id
            );
            this.project.meshTransformAssignments.push({
              id: uid('assign'),
              meshId: mesh.id,
              transformId: transform.id,
            });
            this.rebuildConnectedTransform(transform.id);
            this.setStatus(`Connected ${mesh.name} → ${transform.name}`);
          }
        } else if (targetKind === 'sim') {
          const sim = this.project.sims.find((candidate) => candidate.id === targetId);
          if (mesh && sim) {
            this.project.assignments = this.project.assignments.filter(
              (assignment) => assignment.simId !== sim.id
            );
            this.project.assignments.push({
              id: uid('assign'),
              meshId: mesh.id,
              simId: sim.id,
            });
            this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
              (assignment) => assignment.simId !== sim.id
            );
            this.rebuildConnectedSim(sim.id, true);
            this.setStatus(`Connected ${mesh.name} → ${sim.name}`);
          }
        }
      }
      this.renderInspector();
    }
    this.cancelWireDrag();
  }

  private rebuildConnectedSim(simId: string, clearPose = true): void {
    const runtime = this.simRuntimes.get(simId);
    const sim = this.project.sims.find((candidate) => candidate.id === simId);
    if (!runtime || !sim) return;
    const viaTransform = this.transformForSim(simId);
    const pose = viaTransform ? this.poseForSim(simId) : clearPose ? null : sim.pose;
    if (!viaTransform && clearPose) sim.pose = null;
    // Rebuilding lays the cloth out again, so nothing has been simulated since.
    sim.simulated = false;
    runtime.rebuildCloth(
      this.meshGeometryForSim(simId),
      sim.params,
      pose,
      this.patternForSim(simId)
    );
  }

  private cancelWireDrag(): void {
    this.wireDrag = null;
    document.getElementById('boardWrap')?.classList.remove('is-wiring');
    this.board.querySelectorAll('.node-port.is-drop-target').forEach((port) => {
      port.classList.remove('is-drop-target');
    });
    this.drawWires();
  }

  /**
   * Bring every frame's chrome up to date once the board stops moving. Restating
   * a frame is also what a *finished* gesture wants, so anything that ends a zoom
   * — the wheel, a project load — lands here.
   */
  private scheduleChromeSettle(): void {
    if (this.chromeSettleTimer !== null) clearTimeout(this.chromeSettleTimer);
    this.chromeSettleTimer = setTimeout(() => {
      this.chromeSettleTimer = null;
      this.settleContainerChrome();
    }, CONTAINER_CHROME_SETTLE_MS);
  }

  private settleContainerChrome(): void {
    if (this.chromeSettleTimer !== null) {
      clearTimeout(this.chromeSettleTimer);
      this.chromeSettleTimer = null;
    }
    // The gesture repaints every frame when it ends; catching up before that is
    // the per-frame repaint it exists to avoid.
    if (this.zoomGesture.active) return;
    for (const editor of this.editors.values()) editor.settleContainer();
    // A mesh preview paints into a canvas, so how big the board draws it is a
    // reason to re-rasterise it too.
    for (const preview of this.meshPreviews.values()) preview.refreshResolution();
  }

  private drawWires(): void {
    // The prompt is about a terminal's state, and that is what the wires say.
    this.hideDrapeOffer();
    // Anything that redraws the wires is a change to the board, and a frozen view
    // cannot describe a board that has moved on: end the gesture first. The
    // gesture's own end draws them itself, so this is a second pass over the same
    // list, which is cheap and rare.
    this.endGestureBeforeRedraw();
    const wrap = document.getElementById('boardWrap')!;
    const rect = wrap.getBoundingClientRect();
    this.wiresSvg.setAttribute('width', String(rect.width));
    this.wiresSvg.setAttribute('height', String(rect.height));
    this.wiresSvg.innerHTML = '';
    this.board.querySelectorAll('.node-port.is-connected').forEach((port) => {
      port.classList.remove('is-connected');
    });

    const wiredIn = new Set<string>();
    const wire = (
      a: CanvasNode,
      b: CanvasNode,
      cls: string
    ) => {
      // Stages embedded in a drape have no board presence, so no board wire.
      if (this.isEmbeddedNode(a) || this.isEmbeddedNode(b)) return;
      this.appendWirePath(this.nodePortPoint(a, 'out'), this.nodePortPoint(b, 'in'), cls);
      wiredIn.add(b.id);
      this.board
        .querySelector(`[data-node-id="${a.id}"] > .node-port-out`)
        ?.classList.add('is-connected');
      this.board
        .querySelector(`[data-node-id="${b.id}"] > .node-port-in`)
        ?.classList.add('is-connected');
    };

    // Pattern → Mesh (via mesh.patternId)
    for (const mesh of this.project.meshes) {
      const patNode = this.project.canvas.nodes.find(
        (n) => n.type === 'patternFrame' && n.patternId === mesh.patternId
      );
      const meshNode = this.project.canvas.nodes.find(
        (n) => n.type === 'meshFrame' && n.meshId === mesh.id
      );
      if (patNode && meshNode) wire(patNode, meshNode, 'assign-wire wire-pattern-mesh');
    }

    // Mesh → Sim (direct)
    for (const a of this.project.assignments) {
      const meshNode = this.project.canvas.nodes.find(
        (n) => n.type === 'meshFrame' && n.meshId === a.meshId
      );
      const simNode = this.project.canvas.nodes.find(
        (n) => n.type === 'simViewport' && n.simId === a.simId
      );
      if (meshNode && simNode) wire(meshNode, simNode, 'assign-wire wire-mesh-sim');
    }

    // Mesh → Transform 3D
    for (const a of this.project.meshTransformAssignments) {
      const meshNode = this.project.canvas.nodes.find(
        (n) => n.type === 'meshFrame' && n.meshId === a.meshId
      );
      const transformNode = this.project.canvas.nodes.find(
        (n) => n.type === 'transform3d' && n.transformId === a.transformId
      );
      if (meshNode && transformNode) {
        wire(meshNode, transformNode, 'assign-wire wire-mesh-transform');
      }
    }

    // Transform 3D → Sim
    for (const a of this.project.transformSimAssignments) {
      const transformNode = this.project.canvas.nodes.find(
        (n) => n.type === 'transform3d' && n.transformId === a.transformId
      );
      const simNode = this.project.canvas.nodes.find(
        (n) => n.type === 'simViewport' && n.simId === a.simId
      );
      if (transformNode && simNode) {
        wire(transformNode, simNode, 'assign-wire wire-transform-sim');
      }
    }

    // A drape whose stages are embedded still reads as one connection: draw it
    // from the first visible upstream stage (usually the pattern).
    for (const sim of this.project.sims) {
      const simNode = this.project.canvas.nodes.find(
        (n) => n.type === 'simViewport' && n.simId === sim.id
      );
      if (!simNode || wiredIn.has(simNode.id)) continue;
      const chain = this.simChain(sim.id);
      const upstream =
        (chain.pattern &&
          this.project.canvas.nodes.find(
            (n) => n.type === 'patternFrame' && n.patternId === chain.pattern!.id
          )) ||
        (chain.mesh &&
          this.project.canvas.nodes.find(
            (n) => n.type === 'meshFrame' && n.meshId === chain.mesh!.id
          ));
      if (upstream) wire(upstream, simNode, 'assign-wire wire-pattern-mesh');
    }

    if (this.wireDrag) {
      const sourceNode = this.project.canvas.nodes.find(
        (candidate) => candidate.id === this.wireDrag!.nodeId
      );
      if (sourceNode) {
        const previewClass =
          this.wireDrag.kind === 'pattern'
            ? 'pattern-mesh'
            : this.wireDrag.kind === 'transform'
              ? 'transform-sim'
              : 'mesh-transform';
        this.appendWirePath(
          this.nodePortPoint(sourceNode, 'out'),
          { x: this.wireDrag.x, y: this.wireDrag.y },
          `assign-wire wire-preview wire-${previewClass}`
        );
      }
    }
  }

  private renderInspector(): void {
    this.hideInspectorTip();
    this.syncTextStyleBar();
    const node = this.project.canvas.nodes.find((n) => n.id === this.selectedNodeId);
    if (!node) {
      this.inspector.innerHTML = `<h3>Inspector</h3><p class="muted">Drag an output port to a compatible input to reconnect nodes. Middle-drag (or Alt-drag) board to pan · scroll wheel to zoom. Shift- or ⌘/Ctrl-click a node, or ⌘/Ctrl-drag the board, to select several at once, then ⌘/Ctrl+D to duplicate the whole set — links between the copies stay between the copies. ⌫ / Delete removes the selection.<br/>Transform 3D: arrange pieces before draping — no simulation. Drag fabric to move · Shift-click pieces to multi-select (drag or rotate the group around their shared pivot) · empty drag to orbit · Shift-drag empty space to raise/lower orbit · Move/Rotate toggle · R = 90° local X · Snap to quadrant reveals the two 2 × 8 grids: click a piece, then click a cell to centre it there · wheel zoom.<br/>Sim: drag fabric to move · Shift-click to multi-select · Play to simulate drape · Draw pattern points shows the pattern's anchor points on the fabric — click one to edit it in a small overlay (Cancel/Apply above it; Apply remeshes and rebuilds the drape).</p>`;
      this.decorateInspector();
      return;
    }
    this.renderNodeInspector(node);
    this.prependSelectionNotice();
    this.decorateInspector();
  }

  /**
   * Put a collapse control beside the panel's title.
   *
   * The docked inspector is a full-height column in the expanded node, so folding
   * it is the only way to give that width back to the viewport without leaving
   * the node. Done here rather than in every `renderNodeInspector` branch: each
   * branch writes its own `<h3>`, and this wraps whichever one arrived.
   */
  private decorateInspector(): void {
    const title = this.inspector.querySelector(':scope > h3');
    if (!title) return;
    const header = document.createElement('div');
    header.className = 'inspector-header';
    title.replaceWith(header);
    header.appendChild(title);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'inspector-collapse';
    toggle.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M10 3.5 5.5 8 10 12.5"/></svg>';
    toggle.addEventListener('click', () => this.setInspectorCollapsed(!this.inspectorCollapsed));
    header.appendChild(toggle);
    this.inspector.classList.toggle('is-collapsed', this.inspectorCollapsed);
    this.syncInspectorCollapseLabel(toggle);
  }

  /** Fold the panel to a rail, or open it again. */
  private setInspectorCollapsed(collapsed: boolean): void {
    this.inspectorCollapsed = collapsed;
    this.inspector.classList.toggle('is-collapsed', collapsed);
    const toggle = this.inspector.querySelector<HTMLButtonElement>('.inspector-collapse');
    if (toggle) this.syncInspectorCollapseLabel(toggle);
  }

  private syncInspectorCollapseLabel(toggle: HTMLButtonElement): void {
    const collapsed = this.inspectorCollapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand the panel' : 'Collapse the panel');
    toggle.title = collapsed ? 'Expand panel' : 'Collapse panel';
  }

  /** A group selection: name the set and offer the two group actions. */
  private prependSelectionNotice(): void {
    const ids = this.selectedNodeIds;
    if (ids.length < 2) return;
    const notice = document.createElement('div');
    notice.className = 'node-selection-notice';
    const names = ids
      .map((id) => {
        const selected = this.project.canvas.nodes.find((n) => n.id === id);
        return selected ? `<li>${this.escapeHtml(this.nodeLabel(selected))}</li>` : '';
      })
      .join('');
    notice.innerHTML = `
      <p class="muted">${ids.length} nodes selected · ⌘/Ctrl+D duplicates the set · ⌫ deletes it · Esc clears it</p>
      <ul>${names}</ul>
      <div class="node-selection-actions">
        <button type="button" data-selection-act="duplicate">Duplicate ${ids.length} nodes</button>
        <button type="button" data-selection-act="delete" class="danger">Delete ${ids.length} nodes</button>
      </div>
    `;
    notice.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest(
        'button[data-selection-act]'
      ) as HTMLButtonElement | null;
      if (!btn) return;
      if (btn.dataset.selectionAct === 'duplicate') this.duplicateSelectedNode();
      else this.deleteSelectedNodes();
    });
    this.inspector.prepend(notice);
  }

  private renderNodeInspector(node: CanvasNode): void {
    if (node.type === 'transform3d') {
      const transform = this.project.transforms.find((t) => t.id === node.transformId)!;
      const rt = this.transformRuntimes.get(transform.id);
      const mesh = this.meshForTransform(transform.id);
      const pattern = this.patternForTransform(transform.id);
      const pieceIds =
        rt?.getPieceIds() ??
        Object.keys(transform.pieceTransforms ?? {});
      const selectedPiece =
        this.transformInspectorPieceId ??
        rt?.getSelectedPieceId() ??
        pieceIds[0] ??
        null;
      const pieceOptions = pieceIds
        .map((pieceId) => {
          const piece = pattern?.pieces.find((p) => p.id === pieceId);
          const label = piece?.name ?? pieceId.slice(0, 8);
          return `<option value="${pieceId}" ${pieceId === selectedPiece ? 'selected' : ''}>${label}</option>`;
        })
        .join('');
      const stored: PieceTransform3d = selectedPiece
        ? (transform.pieceTransforms[selectedPiece] ??
          (rt?.cloth
            ? {
                position: rt.cloth.getPieceCentroidTuple(selectedPiece),
                rotationDeg: [...DEFAULT_TRANSFORM_PIECE_ROTATION_DEG],
              }
            : {
                position: [0, 0, 0],
                rotationDeg: [...DEFAULT_TRANSFORM_PIECE_ROTATION_DEG],
              }))
        : {
            position: [0, 0, 0],
            rotationDeg: [...DEFAULT_TRANSFORM_PIECE_ROTATION_DEG],
          };
      const posCm = stored.position.map((v) => (v * WORLD_TO_CM).toFixed(2));
      const rot = stored.rotationDeg.map((v) => v.toFixed(1));
      this.inspector.innerHTML = `
        <h3>${transform.name}</h3>
        <label>Name <input id="transformName" value="${transform.name}" /></label>
        <p class="muted">Mesh source: <strong>${mesh?.name ?? 'none'}</strong> · arrangement only (no simulation)</p>
        <label>Piece
          <select id="transformPiece">${pieceOptions || '<option value="">—</option>'}</select>
        </label>
        <fieldset class="inspector-fieldset">
          <legend>Initial position (cm)</legend>
          <label>X <input id="transformPosX" type="number" step="0.1" value="${posCm[0]}" /></label>
          <label>Y <input id="transformPosY" type="number" step="0.1" value="${posCm[1]}" /></label>
          <label>Z <input id="transformPosZ" type="number" step="0.1" value="${posCm[2]}" /></label>
        </fieldset>
        <fieldset class="inspector-fieldset">
          <legend>Initial rotation (deg)</legend>
          <label>X <input id="transformRotX" type="number" step="1" value="${rot[0]}" /></label>
          <label>Y <input id="transformRotY" type="number" step="1" value="${rot[1]}" /></label>
          <label>Z <input id="transformRotZ" type="number" step="1" value="${rot[2]}" /></label>
        </fieldset>
        <p class="muted">Pose ${transform.pose ? 'saved' : 'default (-90° X)'} · edits apply to selected piece</p>
        ${this.deleteButtonHtml()}
      `;
      this.inspector.querySelector('#transformName')?.addEventListener('change', (e) => {
        this.pushUndo();
        transform.name = (e.target as HTMLInputElement).value;
        this.markDirty();
        this.renderAll();
        void this.initGpuAndSims();
      });
      this.inspector.querySelector('#transformPiece')?.addEventListener('change', (e) => {
        this.transformInspectorPieceId = (e.target as HTMLSelectElement).value || null;
        rt?.setSelectedPieceId(this.transformInspectorPieceId);
        this.renderInspector();
      });
      const applyPieceTransform = () => {
        if (!selectedPiece || !rt) return;
        const position: [number, number, number] = [
          parseFloat((this.inspector.querySelector('#transformPosX') as HTMLInputElement).value) /
            WORLD_TO_CM,
          parseFloat((this.inspector.querySelector('#transformPosY') as HTMLInputElement).value) /
            WORLD_TO_CM,
          parseFloat((this.inspector.querySelector('#transformPosZ') as HTMLInputElement).value) /
            WORLD_TO_CM,
        ];
        const rotationDeg: [number, number, number] = [
          parseFloat((this.inspector.querySelector('#transformRotX') as HTMLInputElement).value),
          parseFloat((this.inspector.querySelector('#transformRotY') as HTMLInputElement).value),
          parseFloat((this.inspector.querySelector('#transformRotZ') as HTMLInputElement).value),
        ];
        rt.applyPieceTransform(selectedPiece, position, rotationDeg);
      };
      for (const id of [
        'transformPosX',
        'transformPosY',
        'transformPosZ',
        'transformRotX',
        'transformRotY',
        'transformRotZ',
      ]) {
        this.inspector.querySelector(`#${id}`)?.addEventListener('change', applyPieceTransform);
      }
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'simViewport') {
      const sim = this.project.sims.find((s) => s.id === node.simId)!;
      const p = sim.params;
      const mesh = this.meshForSim(sim.id);
      const engine = p.engine ?? DEFAULT_DRAPE_ENGINE;
      const isGpu = engine === 'gpu-xpbd';
      const tip = (name: string, text: string, value: string, valueId: string) =>
        this.paramTip(name, text, value, valueId);
      const stretchPct = (((p.maxStretch ?? 1.12) * 100) - 100).toFixed(0);
      const bendPct = ((p.bendSpringScale ?? DEFAULT_BEND_SPRING_SCALE) * 100).toFixed(0);
      this.inspector.innerHTML = `
        <h3>${sim.name}</h3>
        <label>Name <input id="simName" value="${sim.name}" /></label>
        <p class="muted">Mesh source: <strong>${mesh?.name ?? 'none'}</strong>${this.transformForSim(sim.id) ? ' · via Transform 3D' : ''} — density is set on the Mesh node.</p>
        <label>Engine
          <select id="pEngine">
            <option value="cpu-mass-spring" ${!isGpu ? 'selected' : ''}>CPU (mass-spring)</option>
            <option value="gpu-xpbd" ${isGpu ? 'selected' : ''}>GPU (XPBD)</option>
          </select>
        </label>
        <div id="cpuParams" style="${isGpu ? 'display:none' : ''}">
          <div class="inspector-section">
            <h4 class="inspector-section-title">Fabric</h4>
            <p class="muted inspector-section-hint">How the cloth feels — stretch, weight, folds, grip.</p>
            <label>${tip('Spring', 'Edge stretch stiffness. Lower = stretchier / silkier; higher = firmer woven cloth. Recommended: 800–1500 (default 1000).', String(Math.round(p.springConst)), 'vSpring')}
              <input id="pSpring" type="range" min="100" max="5000" value="${p.springConst}" /></label>
            <label>${tip('Damping', 'Spring energy loss. Higher settles faster with less jitter; too high feels sluggish. Recommended: 2–6 (default 3.5).', p.dampingConst.toFixed(1), 'vDamp')}
              <input id="pDamp" type="range" min="0" max="20" step="0.1" value="${p.dampingConst}" /></label>
            <label>${tip('Mass', 'Total garment mass (split across particles). Heavier = more inertia and drape; lighter reacts faster. Recommended: 50–150 (default 100).', String(Math.round(p.mass)), 'vMass')}
              <input id="pMass" type="range" min="10" max="300" value="${p.mass}" /></label>
            <label>${tip('Max stretch', 'Hard cap on how far fabric edges may elongate (Provot). Higher % = stretchier knit; lower = stable woven. Recommended: 5–15% (default 12%). Set near 0% only if you need almost inextensible cloth.', `${stretchPct}%`, 'vMaxStretch')}
              <input id="pMaxStretch" type="range" min="1" max="1.5" step="0.01" value="${p.maxStretch ?? 1.12}" /></label>
            <label>${tip('Bend springs', 'Resistance to folding, as a fraction of Spring. Real fabric folds almost for free, so keep this low: any real value locks panels flat, balloons gathers and flares hems instead of letting them fall. Recommended: 0–10% (default 4%).', `${bendPct}%`, 'vBendScale')}
              <input id="pBendScale" type="range" min="0" max="1" step="0.01" value="${p.bendSpringScale ?? DEFAULT_BEND_SPRING_SCALE}" /></label>
            <label>${tip('Contact grip', 'Friction against the avatar / ground. Higher sticks and resists sliding; lower lets cloth glide. Range 0–20 (default 0.45): up to 2 the contact only slows a slide, above that it starts holding the cloth where it touches, fully static by about 8.', (p.contactFriction ?? 0.45).toFixed(2), 'vFriction')}
              <input id="pFriction" type="range" min="0" max="20" step="0.05" value="${p.contactFriction ?? 0.45}" /></label>
            <label>${tip('Gravity', 'Downward acceleration, in world units per second squared (10 = 1 m/s²). Higher hangs heavier and falls faster; lower floats. Recommended: 3–8 (default 4). Past about 20 a garment with nothing but contact grip holding it starts to slide off the avatar.', p.gravity.toFixed(2), 'vGrav')}
              <input id="pGrav" type="range" min="${GRAVITY_MIN}" max="${GRAVITY_MAX}" step="0.05" value="${clampGravity(p.gravity)}" /></label>
          </div>
          <div class="inspector-section">
            <h4 class="inspector-section-title">Simulation</h4>
            <p class="muted inspector-section-hint">Stability &amp; cost — more steps usually beat cranking Spring alone.</p>
            <label>${tip('Substeps', 'Physics steps per frame (Macklin “small steps”). More = less stretch/jitter, higher CPU. Recommended: 16–32 (default 24). Raise before raising Spring if things explode.', String(p.substeps ?? 24), 'vCpuSubsteps')}
              <input id="pCpuSubsteps" type="range" min="4" max="64" value="${p.substeps ?? 24}" /></label>
            <label>${tip('Strain-limit iters', 'Provot stretch-limit passes per substep. Cuts rubber-band stretch after springs. Recommended: 4–10 (default 6). 0 disables limiting (uses Max stretch only via springs).', String(p.constraintIterations ?? 6), 'vStrainIters')}
              <input id="pStrainIters" type="range" min="0" max="20" value="${p.constraintIterations ?? 6}" /></label>
            <label>${tip('Velocity retain', 'Fraction of speed kept per frame (1 = none). Slightly below 1 damps high-frequency ringing without heavy Damping; it is spread across the substeps, so the feel does not change with Substeps. Recommended: 0.995–0.999 (default 0.998).', (p.velocityDamping ?? 0.998).toFixed(3), 'vVelDamp')}
              <input id="pVelDamp" type="range" min="0.95" max="1" step="0.001" value="${p.velocityDamping ?? 0.998}" /></label>
            <label>${tip('Max speed', `Clamp particle speed (world units/s) to stop explosions from bad steps. Range ${MAX_SPEED_MIN}–${MAX_SPEED_MAX} (default ${DEFAULT_MAX_SPEED}). Lower if the cloth still rockets; raise if motion feels capped.`, formatMaxSpeed(p.maxSpeed), 'vMaxSpeed')}
              <input id="pMaxSpeed" type="range" min="${MAX_SPEED_MIN}" max="${MAX_SPEED_MAX}" step="0.5" value="${clampMaxSpeed(p.maxSpeed)}" /></label>
          </div>
        </div>
        <div id="gpuParams" style="${isGpu ? '' : 'display:none'}">
          <div class="inspector-section">
            <h4 class="inspector-section-title">Fabric</h4>
            <p class="muted inspector-section-hint">How the cloth feels under XPBD constraints.</p>
            <label>${tip('Stretch', 'Edge stretch resistance (maps to XPBD stretch stiffness). Lower = stretchier / silkier; higher = firmer woven cloth. Recommended: 800–1500 (default 1000).', String(Math.round(p.springConst)), 'vSpringGpu')}
              <input id="pSpringGpu" type="range" min="100" max="5000" value="${p.springConst}" /></label>
            <label>${tip('Mass', 'Total garment mass (split across particles). Heavier = more inertia and drape; lighter reacts faster. Recommended: 50–150 (default 100).', String(Math.round(p.mass)), 'vMassGpu')}
              <input id="pMassGpu" type="range" min="10" max="300" value="${p.mass}" /></label>
            <label>${tip('Contact grip', 'Friction against the avatar / ground. Higher sticks and resists sliding; lower lets cloth glide. Range 0–20 (default 0.45): up to 2 the contact only slows a slide, above that it starts holding the cloth where it touches, fully static by about 8.', (p.contactFriction ?? 0.45).toFixed(2), 'vFrictionGpu')}
              <input id="pFrictionGpu" type="range" min="0" max="20" step="0.05" value="${p.contactFriction ?? 0.45}" /></label>
            <label>${tip('LRA stretchiness', 'Long-range attachment / sew slack multiplier. Higher = looser seams and attachments; lower pulls tighter. Recommended: 1.1–1.4 (default 1.2).', (p.longRangeStretchiness ?? 1.2).toFixed(2), 'vLra')}
              <input id="pLra" type="range" min="1" max="2" step="0.05" value="${p.longRangeStretchiness ?? 1.2}" /></label>
            <label>${tip('Gravity', 'Downward acceleration, in world units per second squared (10 = 1 m/s²). Higher hangs heavier and falls faster; lower floats. Recommended: 3–8 (default 4). Past about 20 a garment with nothing but contact grip holding it starts to slide off the avatar.', p.gravity.toFixed(2), 'vGravGpu')}
              <input id="pGravGpu" type="range" min="${GRAVITY_MIN}" max="${GRAVITY_MAX}" step="0.05" value="${clampGravity(p.gravity)}" /></label>
          </div>
          <div class="inspector-section">
            <h4 class="inspector-section-title">Simulation</h4>
            <p class="muted inspector-section-hint">Solver quality vs GPU cost.</p>
            <label>${tip('Substeps', 'XPBD steps per frame. More = stabler stretch and collisions, more GPU time. Recommended: 4–12 (default 8).', String(p.substeps ?? 8), 'vSubsteps')}
              <input id="pSubsteps" type="range" min="2" max="32" value="${p.substeps ?? 8}" /></label>
            <label>${tip('Iterations', 'Constraint solver passes per substep. More = harder stretch/seams, costlier. Recommended: 2–8 (default 4).', String(p.constraintIterations ?? 4), 'vIters')}
              <input id="pIters" type="range" min="1" max="16" value="${p.constraintIterations ?? 4}" /></label>
            <label>${tip('Max speed', `Clamp particle travel and speed each substep. Range ${MAX_SPEED_MIN}–${MAX_SPEED_MAX} (default ${DEFAULT_MAX_SPEED}). Lower reduces slam-through while seams wrap a piece over the body; raise if the drape feels sluggish. It also sets how far one substep may move a stitched pair, so a little headroom above the fabric's own speed is enough.`, formatMaxSpeed(p.maxSpeed), 'vMaxSpeedGpu')}
              <input id="pMaxSpeedGpu" type="range" min="${MAX_SPEED_MIN}" max="${MAX_SPEED_MAX}" step="0.5" value="${clampMaxSpeed(p.maxSpeed)}" /></label>
            <label class="inspector-check">${tip('Self-collision', 'Cloth–cloth contact via spatial hash. Prevents self-intersection; expensive. Leave off for simple drapes; on for layered or bunched garments.', p.enableSelfCollision ? 'On' : 'Off', 'vSelfCol')}
              <input id="pSelfCol" type="checkbox" ${p.enableSelfCollision ? 'checked' : ''} /></label>
          </div>
        </div>
        <p class="muted">${this.project.activeSimId === sim.id ? '● Active' : 'Paused'} · pose ${sim.pose ? 'saved' : 'none'}</p>
        ${this.deleteButtonHtml()}
      `;
      const setValue = (id: string, text: string) => {
        const el = this.inspector.querySelector(`#${id}`);
        if (el) el.textContent = text;
      };
      const syncParamValues = () => {
        setValue('vSpring', String(Math.round(p.springConst)));
        setValue('vSpringGpu', String(Math.round(p.springConst)));
        setValue('vDamp', p.dampingConst.toFixed(1));
        setValue('vMass', String(Math.round(p.mass)));
        setValue('vMassGpu', String(Math.round(p.mass)));
        setValue('vMaxStretch', `${(((p.maxStretch ?? 1.12) * 100) - 100).toFixed(0)}%`);
        setValue('vBendScale', `${(((p.bendSpringScale ?? DEFAULT_BEND_SPRING_SCALE) * 100)).toFixed(0)}%`);
        setValue('vFriction', (p.contactFriction ?? 0.45).toFixed(2));
        setValue('vFrictionGpu', (p.contactFriction ?? 0.45).toFixed(2));
        setValue('vGrav', p.gravity.toFixed(2));
        setValue('vGravGpu', p.gravity.toFixed(2));
        setValue('vCpuSubsteps', String(p.substeps ?? 24));
        setValue('vStrainIters', String(p.constraintIterations ?? 6));
        setValue('vVelDamp', (p.velocityDamping ?? 0.998).toFixed(3));
        setValue('vMaxSpeed', formatMaxSpeed(p.maxSpeed));
        setValue('vLra', (p.longRangeStretchiness ?? 1.2).toFixed(2));
        setValue('vSubsteps', String(p.substeps ?? 8));
        setValue('vIters', String(p.constraintIterations ?? 4));
        setValue('vMaxSpeedGpu', formatMaxSpeed(p.maxSpeed));
        setValue('vSelfCol', p.enableSelfCollision ? 'On' : 'Off');
      };
      const bind = (id: string, fn: (v: number) => void) => {
        const el = this.inspector.querySelector(`#${id}`) as HTMLInputElement | null;
        if (!el) return;
        let armed = false;
        el.addEventListener('pointerdown', () => {
          if (armed) return;
          armed = true;
          this.pushUndo();
        });
        el.addEventListener('change', () => {
          armed = false;
        });
        el.addEventListener('input', (e) => {
          fn(parseFloat((e.target as HTMLInputElement).value));
          syncParamValues();
          const rt = this.simRuntimes.get(sim.id);
          rt?.cloth?.applyParams(sim.params);
        });
      };
      this.inspector.querySelector('#simName')?.addEventListener('change', (e) => {
        this.pushUndo();
        sim.name = (e.target as HTMLInputElement).value;
        this.renderAll();
        void this.initGpuAndSims();
      });
      this.inspector.querySelector('#pEngine')?.addEventListener('change', (e) => {
        this.pushUndo();
        const next = (e.target as HTMLSelectElement).value as 'cpu-mass-spring' | 'gpu-xpbd';
        const rt = this.simRuntimes.get(sim.id);
        if (rt?.cloth) sim.pose = rt.cloth.exportPose();
        p.engine = next;
        // CPU and GPU share one params object but mean different things by
        // substeps/iterations. Switching must not leave GPU tuning on the CPU solver.
        if (next === 'cpu-mass-spring') {
          p.substeps = 24;
          p.constraintIterations = 6;
          if (!(p.gravity > 0)) p.gravity = DEFAULT_SIM_PARAMS.gravity;
          if (p.velocityDamping == null) p.velocityDamping = DEFAULT_SIM_PARAMS.velocityDamping;
        } else {
          p.substeps = 8;
          p.constraintIterations = 4;
        }
        const geom = this.meshGeometryForSim(sim.id);
        const pattern = this.patternForSim(sim.id);
        rt?.rebuildCloth(geom, sim.params, sim.pose, pattern);
        this.renderInspector();
        this.persistLocal();
      });
      bind('pSpring', (v) => {
        p.springConst = v;
      });
      bind('pSpringGpu', (v) => {
        p.springConst = v;
      });
      bind('pDamp', (v) => {
        p.dampingConst = v;
      });
      bind('pGrav', (v) => {
        p.gravity = v;
      });
      bind('pGravGpu', (v) => {
        p.gravity = v;
      });
      bind('pMass', (v) => {
        p.mass = v;
      });
      bind('pMassGpu', (v) => {
        p.mass = v;
      });
      bind('pCpuSubsteps', (v) => {
        p.substeps = Math.round(v);
      });
      bind('pStrainIters', (v) => {
        p.constraintIterations = Math.round(v);
      });
      bind('pMaxStretch', (v) => {
        p.maxStretch = v;
      });
      bind('pBendScale', (v) => {
        p.bendSpringScale = v;
      });
      bind('pVelDamp', (v) => {
        p.velocityDamping = v;
      });
      bind('pMaxSpeed', (v) => {
        p.maxSpeed = v;
      });
      bind('pMaxSpeedGpu', (v) => {
        p.maxSpeed = v;
      });
      bind('pFriction', (v) => {
        p.contactFriction = v;
      });
      bind('pFrictionGpu', (v) => {
        p.contactFriction = v;
      });
      bind('pSubsteps', (v) => {
        p.substeps = Math.round(v);
      });
      bind('pIters', (v) => {
        p.constraintIterations = Math.round(v);
      });
      bind('pLra', (v) => {
        p.longRangeStretchiness = v;
      });
      this.inspector.querySelector('#pSelfCol')?.addEventListener('change', (e) => {
        p.enableSelfCollision = (e.target as HTMLInputElement).checked;
        syncParamValues();
        const rt = this.simRuntimes.get(sim.id);
        rt?.cloth?.applyParams(sim.params);
      });
      this.bindInspectorTips();
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'meshFrame') {
      const mesh = this.project.meshes.find((m) => m.id === node.meshId)!;
      const s = mesh.settings;
      const patterns = this.project.patterns
        .map((p) => `<option value="${p.id}" ${p.id === mesh.patternId ? 'selected' : ''}>${p.name}</option>`)
        .join('');
      this.inspector.innerHTML = `
        <h3>${mesh.name}</h3>
        <label>Name <input id="meshName" value="${mesh.name}" /></label>
        <label>Source pattern
          <select id="meshPattern">${patterns}</select>
        </label>
        <label>Algorithm
          <select id="meshAlgo">
            <option value="delaunay" ${s.algorithm === 'delaunay' ? 'selected' : ''}>Delaunay (boundary + interior)</option>
            <option value="centroidal" ${s.algorithm === 'centroidal' ? 'selected' : ''}>Centroidal (Lloyd-smoothed)</option>
            <option value="structuredGrid" ${s.algorithm === 'structuredGrid' ? 'selected' : ''}>Structured grid</option>
          </select>
        </label>
        <label>Target edge (cm)
          <input id="meshEdge" type="range" min="1" max="12" step="0.25" value="${s.targetEdgeCm}" />
          <span id="meshEdgeVal">${s.targetEdgeCm.toFixed(2)} cm</span>
        </label>
        <label>Boundary spacing (cm)
          <input id="meshBound" type="range" min="0.5" max="8" step="0.25" value="${s.boundarySpacingCm}" />
          <span id="meshBoundVal">${s.boundarySpacingCm.toFixed(2)}</span>
        </label>
        <label>Lloyd iterations
          <input id="meshLloyd" type="range" min="0" max="8" step="1" value="${s.lloydIterations}" ${s.algorithm !== 'centroidal' ? 'disabled' : ''} />
          <span id="meshLloydVal">${s.lloydIterations}</span>
        </label>
        <button type="button" id="meshRemesh">Remesh</button>
        <p class="muted">Top-down preview. Remesh after changing settings, then Rebuild on the sim.</p>
        ${this.deleteButtonHtml()}
      `;
      const syncLabels = () => {
        (this.inspector.querySelector('#meshEdgeVal') as HTMLElement).textContent =
          `${s.targetEdgeCm.toFixed(2)} cm`;
        (this.inspector.querySelector('#meshBoundVal') as HTMLElement).textContent =
          s.boundarySpacingCm.toFixed(2);
        (this.inspector.querySelector('#meshLloydVal') as HTMLElement).textContent = String(
          s.lloydIterations
        );
      };
      this.inspector.querySelector('#meshName')?.addEventListener('change', (e) => {
        this.pushUndo();
        mesh.name = (e.target as HTMLInputElement).value;
        this.renderAll();
        void this.initGpuAndSims();
      });
      this.inspector.querySelector('#meshPattern')?.addEventListener('change', (e) => {
        this.pushUndo();
        mesh.patternId = (e.target as HTMLSelectElement).value;
        this.remesh(mesh.id, { recordUndo: false });
        this.drawWires();
      });
      this.inspector.querySelector('#meshAlgo')?.addEventListener('change', (e) => {
        this.pushUndo();
        s.algorithm = (e.target as HTMLSelectElement).value as MeshAlgorithm;
        const lloyd = this.inspector.querySelector('#meshLloyd') as HTMLInputElement;
        lloyd.disabled = s.algorithm !== 'centroidal';
        this.remesh(mesh.id, { recordUndo: false });
      });
      for (const id of ['meshEdge', 'meshBound', 'meshLloyd']) {
        this.inspector.querySelector(`#${id}`)?.addEventListener('pointerdown', () => {
          this.pushUndo();
        });
      }
      this.inspector.querySelector('#meshEdge')?.addEventListener('input', (e) => {
        s.targetEdgeCm = parseFloat((e.target as HTMLInputElement).value);
        syncLabels();
      });
      this.inspector.querySelector('#meshEdge')?.addEventListener('change', () =>
        this.remesh(mesh.id, { recordUndo: false })
      );
      this.inspector.querySelector('#meshBound')?.addEventListener('input', (e) => {
        s.boundarySpacingCm = parseFloat((e.target as HTMLInputElement).value);
        syncLabels();
      });
      this.inspector.querySelector('#meshBound')?.addEventListener('change', () =>
        this.remesh(mesh.id, { recordUndo: false })
      );
      this.inspector.querySelector('#meshLloyd')?.addEventListener('input', (e) => {
        s.lloydIterations = Math.round(parseFloat((e.target as HTMLInputElement).value));
        syncLabels();
      });
      this.inspector.querySelector('#meshLloyd')?.addEventListener('change', () =>
        this.remesh(mesh.id, { recordUndo: false })
      );
      this.inspector.querySelector('#meshRemesh')?.addEventListener('click', () => this.remesh(mesh.id));
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'patternFrame') {
      const pattern = this.project.patterns.find((p) => p.id === node.patternId)!;
      this.inspector.innerHTML = `
        <h3>${pattern.name}</h3>
        <label>Name <input id="patName" value="${pattern.name}" /></label>
        <button type="button" id="addPt">Add point</button>
        <p class="muted">Tools: <b>V</b> Move · <b>A</b> Add (pen, rectangle, circle, block, SVG) · <b>M</b> Modify (extrude, join, bridge) · <b>C</b> Cut (line, circle, inset, curve, loop, dart) · <b>S</b> Sew (1:1, many : many) · <b>R</b> Ruler (ruler, measure line). Middle-drag pan · scroll wheel zoom. Shift-drag a scale handle locks the aspect · Alt-drag one scales about the centre of the selection.</p>
        ${this.deleteButtonHtml()}
      `;
      this.inspector.querySelector('#patName')?.addEventListener('change', (e) => {
        pattern.name = (e.target as HTMLInputElement).value;
        this.renderAll();
        void this.initGpuAndSims();
      });
      this.inspector.querySelector('#addPt')?.addEventListener('click', () => {
        this.editors.get(node.id)?.addPointOnEdge();
      });
      this.bindDeleteButton(node.id);
      return;
    }

    if (isSection(node)) {
      const held = sectionChildren(
        this.project.canvas.nodes,
        node,
        (entry) => this.isEmbeddedNode(entry)
      );
      const names = held.map((child) => this.nodeLabel(child)).slice(0, 8);
      this.inspector.innerHTML = `
        <h3>${this.escapeHtml(node.label || 'Section')}</h3>
        <p class="muted">A section is a visual group. Anything dragged inside it joins it, and moving, copying or deleting the section takes it along.</p>
        <label>Label <input id="sectionLabel" value="${this.escapeHtml(node.label)}" /></label>
        <p class="muted">${
          held.length === 0
            ? 'Nothing inside it yet.'
            : `${held.length} object${held.length === 1 ? '' : 's'}: ${this.escapeHtml(
                names.join(', ')
              )}${held.length > names.length ? '…' : ''}`
        }</p>
        ${this.deleteButtonHtml()}
      `;
      this.inspector.querySelector('#sectionLabel')?.addEventListener('change', (e) => {
        const value = (e.target as HTMLInputElement).value.trim();
        if (!value || value === node.label) return;
        this.pushUndo();
        node.label = value;
        const label = this.findNodeEl(node.id)?.querySelector('.node-section-label');
        if (label) label.textContent = value;
        this.markDirty();
        this.renderInspector();
      });
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'text') {
      this.inspector.innerHTML = `
        <h3>Text</h3>
        <p class="muted">Type directly on the canvas. Style it, its fill and its padding from the bar at the bottom of the window.</p>
        <p class="muted">A text object is not pattern work — nothing can be sewn or meshed from it. Rasterize it into pieces to make it one, with a piece per character.</p>
        <button type="button" id="textRasterize">Rasterize to pieces</button>
        ${this.deleteButtonHtml()}
      `;
      this.inspector.querySelector('#textRasterize')?.addEventListener('click', () => {
        this.rasterizeTextNode(node);
      });
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'image') {
      this.inspector.innerHTML = `
        <h3>${this.escapeHtml(node.label || 'Image')}</h3>
        <p class="muted">Reference image — drag to move, corner handles to resize. Hold Shift to lock aspect.</p>
        ${node.src ? '' : '<p class="muted is-alert">Its image data is no longer in storage. Use Replace image… to re-link it.</p>'}
        <label>Label <input id="imgLabel" value="${this.escapeHtml(node.label || '')}" /></label>
        <label>Width
          <input id="imgW" type="number" min="80" step="1" value="${Math.round(node.width)}" />
        </label>
        <label>Height
          <input id="imgH" type="number" min="60" step="1" value="${Math.round(node.height)}" />
        </label>
        <button type="button" id="imgReplace">Replace image…</button>
        ${this.deleteButtonHtml()}
      `;
      this.inspector.querySelector('#imgLabel')?.addEventListener('change', (e) => {
        this.pushUndo();
        node.label = (e.target as HTMLInputElement).value.trim() || 'Image';
        const imgEl = this.board.querySelector(
          `[data-node-id="${node.id}"] img`
        ) as HTMLImageElement | null;
        if (imgEl) imgEl.alt = node.label;
        this.renderInspector();
      });
      const bindDim = (id: string, apply: (v: number) => void) => {
        this.inspector.querySelector(`#${id}`)?.addEventListener('change', (e) => {
          const v = parseFloat((e.target as HTMLInputElement).value);
          if (!Number.isFinite(v)) return;
          this.pushUndo();
          apply(v);
          this.layoutNodes();
          this.drawWires();
          this.renderInspector();
        });
      };
      bindDim('imgW', (v) => {
        node.width = Math.max(80, v);
      });
      bindDim('imgH', (v) => {
        node.height = Math.max(60, v);
      });
      this.inspector.querySelector('#imgReplace')?.addEventListener('click', () => {
        this.pickImageFile(node);
      });
      this.bindDeleteButton(node.id);
    }
  }

  private deleteButtonHtml(): string {
    return `<button type="button" id="deleteNode" class="danger">Delete node</button>`;
  }

  private bindDeleteButton(nodeId: string): void {
    this.inspector.querySelector('#deleteNode')?.addEventListener('click', () => {
      // The inspector belongs to the whole selection, so this drops all of it.
      if (this.isNodeSelected(nodeId)) this.deleteSelectedNodes();
      else this.deleteNode(nodeId);
    });
  }

  /**
   * Drop the stages a deleted drape owned. Without this they would fall out of
   * every sim's chain and reappear on the board as orphan nodes.
   */
  private dropEmbeddedChain(chain: {
    mesh?: MeshDocument;
    transform?: Transform3dInstance;
  }): void {
    const transformId = chain.transform?.id;
    const meshId = chain.mesh?.id;

    if (transformId) {
      // Another drape may still drive this transform — leave it alone then.
      if (this.project.transformSimAssignments.some((a) => a.transformId === transformId)) return;
      this.transformRuntimes.get(transformId)?.cloth?.destroy();
      this.transformRuntimes.delete(transformId);
      this.project.transforms = this.project.transforms.filter((t) => t.id !== transformId);
      this.project.canvas.nodes = this.project.canvas.nodes.filter(
        (n) => !(n.type === 'transform3d' && n.transformId === transformId)
      );
      this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
        (a) => a.transformId !== transformId
      );
      this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
        (a) => a.transformId !== transformId
      );
    }

    if (!meshId) return;
    const meshStillUsed =
      this.project.assignments.some((a) => a.meshId === meshId) ||
      this.project.meshTransformAssignments.some((a) => a.meshId === meshId);
    if (meshStillUsed) return;
    this.project.meshes = this.project.meshes.filter((m) => m.id !== meshId);
    this.project.canvas.nodes = this.project.canvas.nodes.filter(
      (n) => !(n.type === 'meshFrame' && n.meshId === meshId)
    );
    this.project.assignments = this.project.assignments.filter((a) => a.meshId !== meshId);
  }

  /**
   * Remove nodes from the board. Undo covers this, so there is no confirmation —
   * the document behind a node is only dropped once the last node using it goes.
   */
  private deleteNodes(nodeIds: readonly string[]): void {
    // A section is the group, so deleting it deletes what it holds — the same
    // reading of "the section" that copy and move use.
    const nodes = withSectionContents(
      this.project.canvas.nodes,
      nodeIds,
      (entry) => this.isEmbeddedNode(entry)
    )
      .map((id) => this.project.canvas.nodes.find((n) => n.id === id))
      .filter((n): n is CanvasNode => !!n);
    if (nodes.length === 0) return;
    this.pushUndo();

    const gone = new Set(nodes.map((n) => n.id));
    this.project.canvas.nodes = this.project.canvas.nodes.filter((n) => !gone.has(n.id));
    for (const id of gone) {
      this.boardChrome.delete(id);
      this.meshPreviews.get(id)?.destroy();
      this.meshPreviews.delete(id);
    }

    for (const node of nodes) {
      if (node.type === 'simViewport') {
        const simId = node.simId;
        // Capture the internal chain before the wiring is torn down.
        const chain = this.simChain(simId);
        const stillUsed = this.project.canvas.nodes.some(
          (n) => n.type === 'simViewport' && n.simId === simId
        );
        if (!stillUsed) {
          const rt = this.simRuntimes.get(simId);
          rt?.cloth?.destroy();
          this.simRuntimes.delete(simId);
          this.simTransports.delete(simId);
          this.simExports.get(simId)?.dispose();
          this.simExports.delete(simId);
          this.project.sims = this.project.sims.filter((s) => s.id !== simId);
          this.project.assignments = this.project.assignments.filter((a) => a.simId !== simId);
          this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
            (a) => a.simId !== simId
          );
          this.dropEmbeddedChain(chain);
          if (this.project.activeSimId === simId) this.project.activeSimId = null;
        }
      } else if (node.type === 'meshFrame') {
        const meshId = node.meshId;
        const stillUsed = this.project.canvas.nodes.some(
          (n) => n.type === 'meshFrame' && n.meshId === meshId
        );
        if (!stillUsed) {
          this.project.meshes = this.project.meshes.filter((m) => m.id !== meshId);
          this.project.assignments = this.project.assignments.filter((a) => a.meshId !== meshId);
          this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
            (a) => a.meshId !== meshId
          );
        }
      } else if (node.type === 'transform3d') {
        const transformId = node.transformId;
        const stillUsed = this.project.canvas.nodes.some(
          (n) => n.type === 'transform3d' && n.transformId === transformId
        );
        if (!stillUsed) {
          const rt = this.transformRuntimes.get(transformId);
          rt?.cloth?.destroy();
          this.transformRuntimes.delete(transformId);
          this.project.transforms = this.project.transforms.filter((t) => t.id !== transformId);
          this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
            (a) => a.transformId !== transformId
          );
          this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
            (a) => a.transformId !== transformId
          );
        }
      } else if (node.type === 'patternFrame') {
        const patternId = node.patternId;
        const stillUsed = this.project.canvas.nodes.some(
          (n) => n.type === 'patternFrame' && n.patternId === patternId
        );
        if (!stillUsed) {
          this.project.patterns = this.project.patterns.filter((p) => p.id !== patternId);
          // Orphan meshes that pointed at this pattern keep the id until user reassigns;
          // clear geometry so remesh fails loudly until a new pattern is chosen.
          for (const mesh of this.project.meshes) {
            if (mesh.patternId === patternId) mesh.geometry = null;
          }
        }
      }
    }

    this.selectedNodeIds = [];
    this.selectedNodeId = null;
    this.renderAll();
    this.markDirty();
    const message = nodes.length === 1 ? 'Node deleted' : `${nodes.length} nodes deleted`;
    void this.initGpuAndSims().then(() => this.setStatus(message));
  }

  private deleteNode(nodeId: string): void {
    this.deleteNodes([nodeId]);
  }

  private deleteSelectedNodes(): void {
    this.deleteNodes(this.selectedNodeIds);
  }

  private applyNodeResize(clientX: number, clientY: number): void {
    const r = this.resizingNode;
    if (!r) return;
    const node = this.project.canvas.nodes.find((n) => n.id === r.id);
    if (!node) return;

    const zoom = this.project.canvas.zoom;
    const boardX = (clientX - this.project.canvas.panX) / zoom;
    const boardY = (clientY - this.project.canvas.panY) / zoom;
    const dx = boardX - r.startBoardX;
    const dy = boardY - r.startBoardY;

    const minW = node.type === 'text' ? 120 : node.type === 'image' ? 80 : 200;
    const minH = node.type === 'text' ? 40 : node.type === 'image' ? 60 : 160;

    let x = r.origX;
    let y = r.origY;
    let w = r.origW;
    let h = r.origH;

    if (r.corner.includes('e')) w = r.origW + dx;
    if (r.corner.includes('s')) h = r.origH + dy;
    if (r.corner.includes('w')) {
      w = r.origW - dx;
      x = r.origX + dx;
    }
    if (r.corner.includes('n')) {
      h = r.origH - dy;
      y = r.origY + dy;
    }

    if (w < minW) {
      if (r.corner.includes('w')) x = r.origX + r.origW - minW;
      w = minW;
    }
    if (h < minH) {
      if (r.corner.includes('n')) y = r.origY + r.origH - minH;
      h = minH;
    }

    // Image refs: hold Shift to lock natural (or current) aspect ratio.
    if (node.type === 'image' && this.resizeShiftKey) {
      const aspect =
        node.naturalAspect && node.naturalAspect > 0 ? node.naturalAspect : r.origW / Math.max(1, r.origH);
      const fromWidth = Math.abs(dx) >= Math.abs(dy);
      if (fromWidth) {
        h = Math.max(minH, w / aspect);
        if (r.corner.includes('n')) y = r.origY + r.origH - h;
        if (r.corner.includes('w')) x = r.origX + r.origW - w;
      } else {
        w = Math.max(minW, h * aspect);
        if (r.corner.includes('w')) x = r.origX + r.origW - w;
        if (r.corner.includes('n')) y = r.origY + r.origH - h;
      }
    }

    node.x = x;
    node.y = y;
    node.width = w;
    node.height = h;
    if (node.type === 'patternFrame') {
      // A frame is a window onto its pattern: resizing it by the top or left edge
      // moves the frame over the work rather than dragging the work along.
      if (r.origView && (x !== r.origX || y !== r.origY)) {
        const view = containerViewShifted(r.origView, x - r.origX, y - r.origY);
        node.viewX = view.viewX;
        node.viewY = view.viewY;
      }
      this.syncContainer(node);
    }
    this.layoutNodes();
    this.drawWires();
  }

  /**
   * Which pattern editor was worked in last: `'canvas'`, a node id, or `null`
   * once a press lands anywhere else. ⌘C reads the selection of the surface you
   * last touched, which is the only thing "what is selected" can mean when the
   * page, a container and the board are all on screen at once.
   */
  private activeEditorKey: string | null = null;

  private trackActiveEditorPress(): void {
    document.addEventListener(
      'pointerdown',
      (e) => {
        const el = (e.target as Element | null)?.closest?.('.pattern-editor') as HTMLElement | null;
        this.activeEditorKey = el ? this.editorKeyForElement(el) : null;
      },
      true
    );
  }

  private editorKeyForElement(el: HTMLElement): string | null {
    if (this.canvasEditor?.element() === el) return 'canvas';
    for (const [key, editor] of this.editors) {
      if (editor.element() === el) return key;
    }
    return null;
  }

  /** The editor ⌘C / ⌘V act on: the last one worked in, else the board's page. */
  private activeEditor(): PatternEditor | null {
    if (this.activeEditorKey === 'canvas') return this.canvasEditor;
    if (this.activeEditorKey) return this.editors.get(this.activeEditorKey) ?? this.canvasEditor;
    return this.canvasEditor;
  }

  /**
   * What copy takes.
   *
   * Working inside a container — opened full screen, or a frame on the board — is
   * working on that pattern, so the picked pieces are the selection. Anywhere
   * else the board's nodes are, and the page's own points are the fallback when
   * nothing on the board is picked. That also settles the one gesture that picks
   * both: a rectangle dragged across the canvas takes the frames it crossed and
   * the page's work, and copying it copies the frames.
   */
  private selectionForCopy(): ClipboardPayload | null {
    const editor = this.activeEditor();
    const pattern = editor?.getPattern() ?? null;
    const pieceIds = editor?.getSelectedPieces() ?? [];
    const inContainer = this.activeEditorKey !== null && this.activeEditorKey !== 'canvas';
    if (inContainer && pattern && pieceIds.length > 0) return copyPieces(pattern, pieceIds);
    if (this.selectedNodeIds.length > 0) {
      const ids = withSectionContents(
        this.project.canvas.nodes,
        this.selectedNodeIds,
        (node) => this.isEmbeddedNode(node)
      );
      return copyNodes(this.project, ids);
    }
    if (pattern && pieceIds.length > 0) return copyPieces(pattern, pieceIds);
    return null;
  }

  /** Put the current selection on the clipboard. Returns it, or null for none. */
  private copySelection(announce = true): ClipboardPayload | null {
    const payload = this.selectionForCopy();
    if (!payload) {
      if (announce) this.setStatus('Nothing selected to copy');
      return null;
    }
    setClipboard(payload);
    if (announce) this.setStatus(describeClipboard(payload));
    return payload;
  }

  /** Paste whatever the clipboard holds into the document in front of you. */
  private pasteClipboard(at?: { clientX?: number; clientY?: number }): void {
    const payload = getClipboard();
    if (!payload) {
      this.setStatus('Nothing on the clipboard');
      return;
    }
    if (payload.type === 'pieces') this.pastePiecesInto(payload);
    else this.pasteNodesInto(payload, at);
  }

  /**
   * Paste copied nodes onto the board, at the pointer (or the middle of the
   * view), stepped by how many times this clipboard has been pasted so a run of
   * pastes does not stack into one pile.
   */
  private pasteNodesInto(
    payload: NodeClipboard,
    at?: { clientX?: number; clientY?: number }
  ): void {
    const point = this.boardPointFromClient(at?.clientX, at?.clientY);
    const nudge = 24 * clipboardPasteCount();
    const zIndex =
      this.project.canvas.nodes.reduce((top, node) => Math.max(top, node.zIndex), 0) + 1;
    this.closeNodeMenu();
    this.pushUndo();
    const ids = pasteNodes(this.project, payload, {
      x: point.x + nudge,
      y: point.y + nudge,
      zIndex,
      newId: (prefix) => uid(prefix),
    });
    if (ids.length === 0) {
      this.setStatus('Nothing to paste');
      return;
    }
    noteClipboardPaste();
    for (const id of ids) {
      const node = this.project.canvas.nodes.find((n) => n.id === id);
      if (node) this.mountNode(node);
    }
    this.selectNodes(ids, ids[ids.length - 1]);
    this.layoutNodes();
    this.syncEmbeddedNodes();
    this.drawWires();
    this.markDirty();
    const message = ids.length === 1 ? 'Pasted 1 node' : `Pasted ${ids.length} nodes`;
    // A pasted drape or transform needs its GPU pass before it can be trusted.
    void this.initGpuAndSims().then(() => this.setStatus(message));
  }

  /** Paste copied pieces into the pattern in front of you, nudged clear of the original. */
  private pastePiecesInto(payload: PieceClipboard): void {
    const editor = this.activeEditor();
    const pattern = editor?.getPattern();
    if (!editor || !pattern) {
      this.setStatus('Open a pattern to paste pieces into');
      return;
    }
    this.pushUndo();
    const step = 8 * (clipboardPasteCount() + 1);
    const ids = pastePieces(pattern, payload, {
      dx: step,
      dy: step,
      newId: (prefix) => uid(prefix),
    });
    if (ids.length === 0) {
      this.setStatus('Nothing to paste');
      return;
    }
    noteClipboardPaste();
    // The editor holds this document by reference, so the new pieces are already
    // in it — it only has to be told to draw them, then to pick them up.
    editor.setSelectedPieces(ids, ids[ids.length - 1]);
    editor.refresh();
    this.invalidateMeshesForPattern(pattern.id);
    this.markDirty();
    this.setStatus(ids.length === 1 ? 'Pasted 1 piece' : `Pasted ${ids.length} pieces`);
  }

  /**
   * ⌘C / ⌘V, and the system clipboard underneath them.
   *
   * The payload travels as text in the clipboard, so a copy survives a reload and
   * can be pasted into another window; the module-level clipboard is there so an
   * ordinary copy-and-paste inside this window never depends on a permission.
   */
  private bindClipboardShortcuts(): void {
    const customType = 'application/x-hyperpattern+json';
    window.addEventListener('copy', (e) => {
      if (this.isTextEditingTarget(e.target)) return;
      const payload = this.copySelection();
      if (!payload || !e.clipboardData) return;
      const text = serializeClipboard(payload);
      e.clipboardData.setData('text/plain', text);
      try {
        e.clipboardData.setData(customType, text);
      } catch {
        /* custom types are a nicety; text/plain is the contract */
      }
      e.preventDefault();
    });
    window.addEventListener('paste', (e) => {
      if (this.isTextEditingTarget(e.target)) return;
      const payload =
        parseClipboardPayload(e.clipboardData?.getData(customType)) ??
        parseClipboardPayload(e.clipboardData?.getData('text/plain'));
      if (!payload) return;
      e.preventDefault();
      // The text may have come from another window, so the two stay in step.
      setClipboard(payload);
      this.pasteClipboard();
    });
  }

  private duplicateSelectedNode(): void {
    if (this.selectedNodeIds.length === 0) {
      this.setStatus('Select a node to duplicate');
      return;
    }
    if (this.isStudioModalOpen()) return;
    this.duplicateNodeGroup(this.selectedNodeIds, { offsetX: 32, offsetY: 32 });
  }

  /**
   * Duplicate a whole selection in one gesture. Links between two copies stay
   * between the copies — pattern → mesh → transform 3D → drape — instead of
   * pointing back at the originals, so a duplicated chain is a chain of its own.
   */
  private duplicateNodeGroup(
    nodeIds: readonly string[],
    opts: {
      offsetX?: number;
      offsetY?: number;
      recordUndo?: boolean;
      select?: boolean;
      /** Say what was copied once the board has settled. Off while dragging. */
      announce?: boolean;
    } = {}
  ): CanvasNode[] {
    // The section and its contents travel together, and the copies land inside the
    // copy, because where an object is *is* the membership.
    const plan = planNodeDuplicates(
      this.project,
      withSectionContents(this.project.canvas.nodes, nodeIds, (n) => this.isEmbeddedNode(n)),
      uid
    );
    if (plan.sources.length === 0) return [];
    if (opts.recordUndo !== false) this.pushUndo();
    const copies: CanvasNode[] = [];
    for (const source of plan.sources) {
      const copy = this.duplicateNode(source.id, {
        offsetX: opts.offsetX ?? 32,
        offsetY: opts.offsetY ?? 32,
        recordUndo: false,
        select: false,
        links: plan.links,
      });
      if (copy) copies.push(copy);
    }
    if (copies.length === 0) return [];
    // The copies become the selection, the way a single duplicate does.
    if (opts.select !== false) {
      this.selectNodes(copies.map((copy) => copy.id), copies[copies.length - 1].id);
    }
    this.layoutNodes();
    // A copy's hidden chain is only wired once every copy exists, so the classes
    // that hide it are settled here rather than as each node mounts.
    this.syncEmbeddedNodes();
    this.drawWires();
    this.markDirty();
    // Every copy is on the board: one init covers the lot. The rebuild writes
    // its own status, so the line about what was copied waits for it.
    const done = this.initGpuAndSims();
    if (opts.announce === false) void done;
    else {
      const message =
        copies.length === 1
          ? `Duplicated · ${this.nodeLabel(copies[0])}`
          : `Duplicated ${copies.length} nodes`;
      void done.then(() => this.setStatus(message));
    }
    return copies;
  }

  private isStudioModalOpen(): boolean {
    return !this.modalRoot.hidden;
  }

  private nodeLabel(node: CanvasNode): string {
    switch (node.type) {
      case 'patternFrame': {
        const p = this.project.patterns.find((x) => x.id === node.patternId);
        return p?.name ?? 'Pattern';
      }
      case 'meshFrame': {
        const m = this.project.meshes.find((x) => x.id === node.meshId);
        return m?.name ?? 'Mesh';
      }
      case 'transform3d': {
        const t = this.project.transforms.find((x) => x.id === node.transformId);
        return t?.name ?? 'Transform 3D';
      }
      case 'simViewport': {
        const s = this.project.sims.find((x) => x.id === node.simId);
        return s?.name ?? 'Sim';
      }
      case 'image':
        return node.label ?? 'Image';
      case 'text':
        return this.textNodeLabel(node);
      case 'section':
        return node.label || 'Section';
    }
  }

  /**
   * Clone a canvas node and its backing document (pattern/mesh/transform/sim),
   * preserving settings, geometry, pose, camera, and graph connections where applicable.
   *
   * `links` carries the ids a *group* duplicate has already reserved: a copy whose
   * pattern/mesh/... is being copied too points at that copy rather than at the
   * original. Left out for a single node, which then copies whatever it points at
   * by reference (a duplicated transform still reads the original mesh).
   */
  private duplicateNode(
    nodeId: string,
    opts: {
      offsetX?: number;
      offsetY?: number;
      recordUndo?: boolean;
      select?: boolean;
      links?: DuplicateLinks;
    } = {}
  ): CanvasNode | null {
    const src = this.project.canvas.nodes.find((n) => n.id === nodeId);
    if (!src) return null;

    if (opts.recordUndo !== false) this.pushUndo();

    const ox = opts.offsetX ?? 32;
    const oy = opts.offsetY ?? 32;
    const zIndex = this.project.canvas.nodes.length + 1;
    const linked = (kind: 'pattern' | 'mesh' | 'transform' | 'sim', id: string) =>
      opts.links?.[kind].get(id) ?? id;
    let needsGpu = false;
    let node: CanvasNode;

    switch (src.type) {
      case 'patternFrame': {
        const pattern = this.project.patterns.find((p) => p.id === src.patternId);
        if (!pattern) return null;
        const cloned = this.clonePatternDocument(
          pattern,
          linked('pattern', pattern.id)
        );
        this.project.patterns.push(cloned);
        node = {
          type: 'patternFrame',
          id: uid('node'),
          patternId: cloned.id,
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
        };
        break;
      }
      case 'meshFrame': {
        const mesh = this.project.meshes.find((m) => m.id === src.meshId);
        if (!mesh) return null;
        const cloned: MeshDocument = {
          id: linked('mesh', mesh.id),
          name: `${mesh.name} copy`,
          patternId: linked('pattern', mesh.patternId),
          settings: { ...mesh.settings },
          geometry: mesh.geometry ? structuredClone(mesh.geometry) : null,
        };
        this.project.meshes.push(cloned);
        node = {
          type: 'meshFrame',
          id: uid('node'),
          meshId: cloned.id,
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
        };
        break;
      }
      case 'transform3d': {
        const transform = this.project.transforms.find((t) => t.id === src.transformId);
        if (!transform) return null;
        const cloned = {
          id: linked('transform', transform.id),
          name: `${transform.name} copy`,
          meshId: linked('mesh', transform.meshId),
          camera: structuredClone(transform.camera),
          pose: transform.pose ? structuredClone(transform.pose) : null,
          pieceTransforms: structuredClone(transform.pieceTransforms),
        };
        this.project.transforms.push(cloned);
        this.project.meshTransformAssignments.push({
          id: uid('assign'),
          meshId: cloned.meshId,
          transformId: cloned.id,
        });
        node = {
          type: 'transform3d',
          id: uid('node'),
          transformId: cloned.id,
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
        };
        needsGpu = true;
        break;
      }
      case 'simViewport': {
        const sim = this.project.sims.find((s) => s.id === src.simId);
        if (!sim) return null;
        // Capture live pose/camera before cloning
        this.persistSimStates();
        const live = this.project.sims.find((s) => s.id === src.simId)!;
        const cloned: SimInstance = {
          id: linked('sim', live.id),
          name: `${live.name} copy`,
          params: {
            ...live.params,
            wind: [...live.params.wind] as [number, number, number],
          },
          pose: live.pose ? structuredClone(live.pose) : null,
          camera: structuredClone(live.camera),
          dropped: live.dropped,
        };
        this.project.sims.push(cloned);
        for (const a of this.project.assignments.filter((x) => x.simId === src.simId)) {
          this.project.assignments.push({
            id: uid('assign'),
            meshId: linked('mesh', a.meshId),
            simId: cloned.id,
          });
        }
        for (const a of this.project.transformSimAssignments.filter(
          (x) => x.simId === src.simId
        )) {
          this.project.transformSimAssignments.push({
            id: uid('assign'),
            transformId: linked('transform', a.transformId),
            simId: cloned.id,
          });
        }
        node = {
          type: 'simViewport',
          id: uid('node'),
          simId: cloned.id,
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
        };
        needsGpu = true;
        break;
      }
      case 'image': {
        node = {
          type: 'image',
          id: uid('node'),
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
          src: src.src,
          label: src.label ? `${src.label} copy` : undefined,
          naturalAspect: src.naturalAspect,
        };
        break;
      }
      case 'text': {
        node = {
          ...structuredClone(src),
          id: uid('node'),
          x: src.x + ox,
          y: src.y + oy,
          zIndex,
        };
        break;
      }
      case 'section': {
        node = {
          type: 'section',
          id: uid('node'),
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
          label: src.label,
        };
        break;
      }
    }

    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    if (opts.select !== false) {
      this.selectNodes([node.id]);
    }
    this.layoutNodes();
    this.drawWires();
    // A group duplicate does the GPU pass once, after every copy is in place.
    if (needsGpu && !opts.links) void this.initGpuAndSims();
    return node;
  }

  private clonePatternDocument(src: PatternDocument, id = uid('pattern')): PatternDocument {
    const pieceIdMap = new Map<string, string>();
    const pointIdMap = new Map<string, string>();

    // Blocks are *regenerated* rather than copied. Their piece and point ids are
    // derived from the instance id, so handing the clone a fresh instance id
    // means the outlines have to be rebuilt to match — otherwise the first
    // regeneration afterwards would silently orphan every seam on the block.
    const library = cachedMeasurementLibrary();
    const sourceBlocks = src.blocks ?? [];
    const ownedPieceIds = new Set(
      sourceBlocks.flatMap((instance) => instance.pieces.map((entry) => entry.pieceId))
    );
    const blocks: BlockInstance[] = [];
    const generatedPieces: PatternPiece[] = [];

    for (const instance of sourceBlocks) {
      const definition = getBlockDefinition(instance.definitionId);
      if (!definition) continue;
      const copy: BlockInstance = {
        ...instance,
        id: uid('blk'),
        origin: { ...instance.origin },
        bindings: structuredClone(instance.bindings),
        pieces: [],
      };
      const set =
        library?.sets.find((s) => s.id === instance.personId) ??
        (instance.personId ? null : (library?.sets.find((s) => s.id === library.activeId) ?? null));
      const generated = generateBlockPieces(definition, copy, set);

      // Carry the old ids across so any seam pointing at the original still does.
      for (const entry of generated) {
        const original = instance.pieces.find((e) => e.role === entry.role);
        if (!original) continue;
        pieceIdMap.set(original.pieceId, entry.piece.id);
        const from = src.pieces.find((p) => p.id === original.pieceId);
        if (!from) continue;
        for (const [index, point] of from.points.entries()) {
          const to = entry.piece.points[index];
          if (to) pointIdMap.set(point.id, to.id);
        }
        entry.piece.seamAllowance = remapSeamAllowance(from.seamAllowance, pointIdMap);
      }

      copy.pieces = generated.map((entry) => ({ role: entry.role, pieceId: entry.piece.id }));
      blocks.push(copy);
      generatedPieces.push(...generated.map((entry) => entry.piece));
    }

    const pieces = src.pieces
      .filter((piece) => !ownedPieceIds.has(piece.id))
      .map((piece) => {
      const newPieceId = uid('piece');
      pieceIdMap.set(piece.id, newPieceId);
      const points = piece.points.map((pt) => {
        const newPtId = uid('pt');
        pointIdMap.set(pt.id, newPtId);
        return {
          id: newPtId,
          anchor: { ...pt.anchor },
          handleIn: pt.handleIn ? { ...pt.handleIn } : null,
          handleOut: pt.handleOut ? { ...pt.handleOut } : null,
          handlesParallel: pt.handlesParallel,
        };
      });
      return {
        id: newPieceId,
        name: piece.name,
        closed: piece.closed,
        points,
        grainline: piece.grainline
          ? {
              from: { ...piece.grainline.from },
              to: { ...piece.grainline.to },
            }
          : undefined,
        seamAllowance: remapSeamAllowance(piece.seamAllowance, pointIdMap),
      };
    });
    const remapEdge = (edge: PatternDocument['seams'][number]['a']) => ({
      pieceId: pieceIdMap.get(edge.pieceId) ?? edge.pieceId,
      fromPointId: pointIdMap.get(edge.fromPointId) ?? edge.fromPointId,
      toPointId: pointIdMap.get(edge.toPointId) ?? edge.toPointId,
      t0: edge.t0,
      t1: edge.t1,
    });
    return {
      id,
      name: `${src.name} copy`,
      pieces: [...pieces, ...generatedPieces],
      seams: src.seams.map((seam) => ({
        id: uid('seam'),
        a: remapEdge(seam.a),
        b: remapEdge(seam.b),
        restGapCm: seam.restGapCm,
      })),
      rulers: src.rulers ? structuredClone(src.rulers) : undefined,
      blocks: blocks.length > 0 ? blocks : undefined,
      pieceSuccessors: src.pieceSuccessors ? structuredClone(src.pieceSuccessors) : undefined,
    };
  }

  /** Drop a 2D pattern on the board, centred on the point it was asked for. */
  private addPatternFrame(at?: { clientX: number; clientY: number }): void {
    const patternId = uid('pattern');
    const piece = rectPiece('Panel', 40, 50, { x: 5, y: 5 });
    const pattern: PatternDocument = {
      id: patternId,
      name: `Pattern ${this.project.patterns.length + 1}`,
      pieces: [piece],
      seams: [],
    };
    this.project.patterns.push(pattern);

    // A new frame sits at the canvas's drafting scale and is fitted around the
    // panel it was made with, so the panel is the size it would be on the page.
    const scale = canvasCmScale(this.project);
    const bounds = piecesBoundsCm([piece])!;
    const width = (bounds.max.x - bounds.min.x + CONTAINER_PADDING_CM * 2) * scale;
    const height = (bounds.max.y - bounds.min.y + CONTAINER_PADDING_CM * 2) * scale;
    const anchor = this.boardPointFromClient(at?.clientX, at?.clientY);
    const node: PatternFrameNode = {
      type: 'patternFrame',
      id: uid('node'),
      patternId,
      x: Math.round(anchor.x - width / 2),
      y: Math.round(anchor.y - height / 2),
      width,
      height,
      zIndex: topNodeZ(this.project.canvas.nodes) + 1,
      cmScale: scale,
      // The frame's corner sits one padding outside the panel, so the panel opens
      // with the same breathing room on every side.
      viewX: bounds.min.x - CONTAINER_PADDING_CM,
      viewY: bounds.min.y - CONTAINER_PADDING_CM,
      clip: true,
    };
    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    this.selectNodes([node.id]);
    this.drawWires();
  }

  /** Drop a 3D drape viewport on the board, centred on the point it was asked for. */
  /**
   * Offer to grow a 3D container from a container's free output terminal.
   *
   * Hovering the terminal is the whole gesture: a 2D container is the root of a
   * chain, and a drape is the one thing you would want next — the same thing
   * dragging that terminal onto a drape does, without the drag. Nothing is offered
   * once the output feeds something, since it already has its chain.
   */
  private offerDrapeAttachment(node: CanvasNode): void {
    const el = this.findNodeEl(node.id);
    const port = el?.querySelector<HTMLElement>(':scope > .node-port-out') ?? null;
    if (!port) return;
    const canOffer = canAttach3dContainer({
      nodeType: node.type,
      direction: port.dataset.portDirection ?? '',
      kind: port.dataset.portKind ?? '',
      connected: port.classList.contains('is-connected'),
      wiring: this.wireDrag !== null,
      embedded: this.isEmbeddedNode(node),
    });
    if (!canOffer) {
      this.hideDrapeOffer();
      return;
    }
    const patternId = node.type === 'patternFrame' ? node.patternId : null;
    if (!patternId) return;

    this.cancelDrapeOfferHide();
    const button = this.drapeOfferButton();
    this.drapeOffer = { button, nodeId: node.id, patternId };
    const wrap = document.getElementById('boardWrap');
    const wrapRect = wrap?.getBoundingClientRect();
    const portRect = port.getBoundingClientRect();
    if (!wrapRect) return;
    button.style.left = `${Math.round(portRect.right - wrapRect.left + 10)}px`;
    button.style.top = `${Math.round(portRect.top - wrapRect.top + portRect.height / 2)}px`;
    button.hidden = false;
    button.setAttribute(
      'aria-label',
      `Add a 3D container wired to ${
        this.project.patterns.find((p) => p.id === patternId)?.name ?? 'this container'
      }`
    );
  }

  private drapeOfferButton(): HTMLButtonElement {
    if (this.drapeOfferButtonEl?.isConnected) return this.drapeOfferButtonEl;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'drape-offer';
    button.hidden = true;
    button.textContent = '+ 3d container';
    button.title = 'Add a 3D container here, wired to this container';
    // A press on the prompt is not a press on the board: it must not start a wire
    // drag, a pan, or a marquee.
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener('pointerenter', () => this.cancelDrapeOfferHide());
    button.addEventListener('pointerleave', () => this.scheduleDrapeOfferHide());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.attachDrapeOffer();
    });
    this.boardWrap().appendChild(button);
    this.drapeOfferButtonEl = button;
    return button;
  }

  private boardWrap(): HTMLElement {
    return document.getElementById('boardWrap') as HTMLElement;
  }

  /** The pointer left the terminal on its way to the prompt, or the other way. */
  private scheduleDrapeOfferHide(): void {
    this.cancelDrapeOfferHide();
    this.drapeOfferTimer = setTimeout(() => {
      this.drapeOfferTimer = null;
      this.hideDrapeOffer();
    }, DRAPE_OFFER_LINGER_MS);
  }

  private cancelDrapeOfferHide(): void {
    if (this.drapeOfferTimer === null) return;
    clearTimeout(this.drapeOfferTimer);
    this.drapeOfferTimer = null;
  }

  private hideDrapeOffer(): void {
    this.cancelDrapeOfferHide();
    const offer = this.drapeOffer;
    this.drapeOffer = null;
    if (offer) offer.button.hidden = true;
  }

  /** The prompt was clicked: make the drape, wired to the container it came from. */
  private attachDrapeOffer(): void {
    const offer = this.drapeOffer;
    this.hideDrapeOffer();
    if (!offer) return;
    const node = this.project.canvas.nodes.find((candidate) => candidate.id === offer.nodeId);
    const el = this.findNodeEl(offer.nodeId);
    const port = el?.querySelector<HTMLElement>(':scope > .node-port-out') ?? null;
    if (!node || !port) return;
    const wrapRect = this.boardWrap().getBoundingClientRect();
    const portRect = port.getBoundingClientRect();
    if (!wrapRect) return;
    const anchor = attachDrapeAnchor(
      { right: portRect.right, top: portRect.top, height: portRect.height },
      this.project.canvas.zoom,
      { width: DRAPE_NODE_WIDTH, height: DRAPE_NODE_HEIGHT },
      { left: wrapRect.left, top: wrapRect.top, right: wrapRect.right, bottom: wrapRect.bottom }
    );
    this.pushUndo();
    this.addSimViewport(anchor, { patternId: offer.patternId });
    const name = this.project.patterns.find((p) => p.id === offer.patternId)?.name;
    this.setStatus(
      name
        ? `3D container attached to ${name} — it carries its own remesh and transform stages`
        : '3D container attached'
    );
  }

  private addSimViewport(
    at?: { clientX: number; clientY: number },
    options: { patternId?: string } = {}
  ): void {
    const simId = uid('sim');
    const sim: SimInstance = {
      id: simId,
      name: `Drape ${this.project.sims.length + 1}`,
      params: { ...DEFAULT_SIM_PARAMS },
      pose: null,
      camera: getDefaultSimCamera(this.project),
      dropped: false,
    };
    this.project.sims.push(sim);
    const width = DRAPE_NODE_WIDTH;
    const height = DRAPE_NODE_HEIGHT;
    const anchor = this.boardPointFromClient(at?.clientX, at?.clientY);
    const node: SimViewportNode = {
      type: 'simViewport',
      id: uid('node'),
      simId,
      x: Math.round(anchor.x - width / 2),
      y: Math.round(anchor.y - height / 2),
      width,
      height,
      zIndex: this.project.canvas.nodes.length + 1,
    };
    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    this.selectNodes([node.id]);
    // A drape carries its own remesh + transform stages; wire in a pattern so the
    // fullscreen tab strip is complete straight away — the one it was asked for,
    // or the page's for a drape dropped from the Add menu.
    const pattern = options.patternId
      ? this.project.patterns.find((candidate) => candidate.id === options.patternId)
      : this.project.patterns[0];
    if (pattern) {
      this.connectPatternToSim(pattern, sim);
    } else {
      this.syncEmbeddedNodes();
    }
    void this.initGpuAndSims();
    this.drawWires();
  }

  /**
   * A text object where the Add tool asked for one: a dragged box wraps and a
   * click sizes itself to what is typed. Both are geometry in canvas units —
   * the box the drag drew, or a default paragraph — and the tool goes back to
   * Move, because typing into what you just made is the next thing you do.
   */
  private addTextObject(box: { x: number; y: number; w: number; h: number }): void {
    const topLeft = canvasAtCm(this.project, box.x, box.y);
    const dragged = box.w > 0.5 && box.h > 0.5;
    const width = dragged ? box.w * canvasCmScale(this.project) : 260;
    const height = dragged ? box.h * canvasCmScale(this.project) : 44;
    const node: TextAnnotationNode = {
      type: 'text',
      id: uid('node'),
      x: Math.round(topLeft.x),
      y: Math.round(topLeft.y),
      width: Math.round(width),
      height: Math.round(height),
      zIndex: this.project.canvas.nodes.length + 1,
      text: 'Text',
      fontSize: 28,
      fontFamily: TEXT_FONT_FAMILIES[0],
      fontWeight: 400,
      lineHeight: 1.3,
      align: 'left',
      color: DEFAULT_TEXT_COLOR,
      background: DEFAULT_TEXT_BACKGROUND,
      padding: 8,
      autoWidth: !dragged,
    };
    this.pushUndo();
    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    this.selectNodes([node.id]);
    this.canvasEditor?.setTool('move');
    // Put the caret in the new object: it is a placeholder until it says
    // something, and selecting it alone would not make that obvious.
    const content = this.findNodeEl(node.id)?.querySelector<HTMLElement>('.node-text-content');
    if (content) {
      content.focus();
      const range = document.createRange();
      range.selectNodeContents(content);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    this.markDirty();
    this.setStatus('Text — style it from the bar below');
  }

  /**
   * A section where the Add tool asked for one.
   *
   * Nothing is "put into" it: a section holds whatever lies inside it, worked out
   * from the board every time it matters (see `sections.ts`). So the drag that
   * makes it is also the gesture that gathers what it lands on — if the objects
   * were already there, they are in it the moment the rectangle closes round them.
   */
  private addSection(box: { x: number; y: number; w: number; h: number }): void {
    const topLeft = canvasAtCm(this.project, box.x, box.y);
    const dragged = box.w > 0.5 && box.h > 0.5;
    const scale = canvasCmScale(this.project);
    const width = Math.round(dragged ? box.w * scale : 480);
    const height = Math.round(dragged ? box.h * scale : 320);
    const node: SectionNode = {
      type: 'section',
      id: uid('node'),
      x: Math.round(topLeft.x),
      y: Math.round(topLeft.y),
      width,
      height,
      // Behind everything: a section is the ground its objects stand on.
      zIndex: this.project.canvas.nodes.reduce((low, entry) => Math.min(low, entry.zIndex), 0) - 1,
      label: `Section ${this.project.canvas.nodes.filter(isSection).length + 1}`,
    };
    this.pushUndo();
    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    this.selectNodes([node.id]);
    this.canvasEditor?.setTool('move');
    this.markDirty();
    const held = sectionChildren(
      this.project.canvas.nodes,
      node,
      (entry) => this.isEmbeddedNode(entry)
    ).length;
    this.setStatus(
      held > 0
        ? `Section — holding ${held} object${held === 1 ? '' : 's'}`
        : 'Section — drag objects into it and they join it'
    );
  }

  /**
   * Rename a section in place, the way a Figma section renames: the label becomes
   * a field, Enter or a click elsewhere keeps it, Escape puts the old one back.
   */
  private renameSection(node: SectionNode, label: HTMLElement): void {
    if (label.isContentEditable) return;
    const before = node.label;
    label.contentEditable = 'true';
    label.spellcheck = false;
    label.focus();
    const range = document.createRange();
    range.selectNodeContents(label);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      label.contentEditable = 'false';
      const next = (label.textContent ?? '').trim();
      if (commit && next && next !== before) {
        this.pushUndo();
        node.label = next;
        this.markDirty();
        this.renderInspector();
      } else {
        label.textContent = before;
      }
      label.blur();
    };
    label.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    label.addEventListener('blur', () => finish(true), { once: true });
  }

  /**
   * Bring the section the board is working in up to date.
   *
   * Membership is geometry, so it changes when *other* things move. Anything that
   * shifts a node calls this: the selected section's panel is re-rendered and the
   * status line carries its tally, which is the answer to "did that land inside?".
   */
  private refreshSectionTally(): void {
    const section = this.project.canvas.nodes.find(
      (node): node is SectionNode => isSection(node) && this.isNodeSelected(node.id)
    );
    if (!section) {
      if (this.project.canvas.nodes.some(isSection)) this.renderInspector();
      return;
    }
    const held = sectionChildren(
      this.project.canvas.nodes,
      section,
      (entry) => this.isEmbeddedNode(entry)
    ).length;
    this.renderInspector();
    this.setStatus(
      held === 0
        ? `${section.label} — nothing inside it yet`
        : `${section.label} — holding ${held} object${held === 1 ? '' : 's'}`
    );
  }

  /** The node's own styling, written onto the element that draws it. */
  private applyTextNodeStyle(node: TextAnnotationNode, el: HTMLElement): void {
    const style = textStyleOf(node);
    el.style.fontFamily = `"${style.fontFamily}", sans-serif`;
    el.style.fontSize = `${style.fontSize}px`;
    el.style.fontWeight = String(style.fontWeight);
    el.style.fontStyle = style.fontStyle;
    el.style.lineHeight = String(style.lineHeight);
    el.style.letterSpacing = `${style.letterSpacing}px`;
    el.style.textAlign = style.align;
    el.style.color = style.color;
    el.style.background = style.background;
    el.style.padding = `${style.padding}px`;
    el.style.width = style.autoWidth ? 'max-content' : '100%';
    el.style.whiteSpace = style.autoWidth ? 'pre' : 'pre-wrap';
  }

  /**
   * A text object's box is what its text needs: an auto-width object grows with
   * its longest line, and every object grows downwards as lines are added.
   */
  private fitTextNode(node: TextAnnotationNode, el?: HTMLElement | null): void {
    const content =
      el ?? this.findNodeEl(node.id)?.querySelector<HTMLElement>('.node-text-content');
    if (!content) return;
    const style = textStyleOf(node);
    // `scrollWidth` is layout size, so the board's zoom does not enter into it.
    const width = style.autoWidth
      ? Math.ceil(content.scrollWidth + 2)
      : Math.max(40, Math.round(node.width));
    const height = Math.ceil(content.scrollHeight + 2);
    if (width === Math.round(node.width) && height === Math.round(node.height)) return;
    node.width = width;
    node.height = height;
    this.layoutNodes();
  }

  /**
   * Turn a text object into pattern work: one piece per character.
   *
   * The glyph outlines belong to the font, not to the document, so they are read
   * off a rasterized copy of the laid-out text and traced — see `textObject.ts`.
   * The pieces land in the page's own pattern, exactly where the text stood, so
   * the drawing does not move when the object becomes editable geometry; the text
   * node goes away, because it is now that geometry.
   *
   * A rectangle of text (a dragged box that wraps) comes back as pieces, not as a
   * paragraph: each character is its own outline, and the line breaks are gone
   * with the object. That is the same trade a rasterizing pass makes anywhere.
   */
  private rasterizeTextNode(node: TextAnnotationNode): void {
    if (node.type !== 'text') return;
    // Twelve pixels per canvas unit: fine enough that the traced outline is the
    // glyph's own shape rather than a staircase at its edge.
    const mask = renderTextMask(node, { scale: 12 });
    if (!mask) {
      this.setStatus('Could not read the text to rasterize it');
      return;
    }
    const pattern = rootPattern(this.project);
    const pieces = textMaskToPieces(
      mask,
      { x: node.x, y: node.y, cmScale: canvasCmScale(this.project) },
      { name: node.text.trim().slice(0, 12) || 'Text' }
    );
    if (pieces.length === 0) {
      this.setStatus('Nothing to rasterize — the text is empty');
      return;
    }
    this.pushUndo();
    pattern.pieces.push(...pieces);
    this.project.canvas.nodes = this.project.canvas.nodes.filter((entry) => entry.id !== node.id);
    this.removeNodeEl(node.id);
    this.editors.delete(node.id);
    this.applyNodeSelection([]);
    this.invalidateMeshesForPattern(pattern.id);
    this.drawWires();
    this.renderInspector();
    this.markDirty();
    void this.persistLocal({ quiet: true });
    // The pieces are page work now: pick them up in the page's own editor so the
    // next thing typed or dragged is about them.
    this.canvasEditor?.setSelectedPieces(pieces.map((piece) => piece.id));
    this.canvasEditor?.refresh();
    const name = this.textNodeLabel(node);
    this.setStatus(
      `Rasterized “${name}” into ${pieces.length} piece${pieces.length === 1 ? '' : 's'}`
    );
  }

  /** Take one node's element off the board, chrome and all. */
  private removeNodeEl(nodeId: string): void {
    this.findNodeEl(nodeId)?.remove();
    this.sectionLabels.get(nodeId)?.remove();
    this.sectionLabels.delete(nodeId);
    this.boardChrome.delete(nodeId);
  }

  /**
   * The text style bar: Figma's bottom-of-the-window strip, for the one text
   * object in hand.
   *
   * It is built once and reused — the controls keep their focus while you drag a
   * colour picker, which a bar rebuilt per keystroke would not — and it is only
   * on screen while a single text node is selected. Every control writes to the
   * node and then re-applies the style, so what is on screen and what is stored
   * cannot drift apart.
   */
  private buildTextStyleBar(): void {
    const fontOptions = TEXT_FONT_FAMILIES.map(
      (family) => `<option value="${family}">${family}</option>`
    ).join('');
    const weightOptions = TEXT_WEIGHTS.map(
      (weight) => `<option value="${weight.value}">${weight.label}</option>`
    ).join('');
    const alignButton = (align: string, label: string, icon: string) =>
      `<button type="button" data-text-align="${align}" title="${label}" aria-label="${label}">${icon}</button>`;
    this.textBar.innerHTML = `
      <label class="text-style-field" title="Font">
        <span class="text-style-label">Font</span>
        <select data-text-field="fontFamily">${fontOptions}</select>
      </label>
      <label class="text-style-field text-style-size" title="Size">
        <span class="text-style-label">Size</span>
        <input type="number" data-text-field="fontSize" min="4" max="400" step="1" />
      </label>
      <label class="text-style-field" title="Weight">
        <span class="text-style-label">Weight</span>
        <select data-text-field="fontWeight">${weightOptions}</select>
      </label>
      <button type="button" class="text-style-toggle" data-text-toggle="italic" title="Italic" aria-label="Italic"><span class="text-style-italic">I</span></button>
      <div class="text-style-group" role="group" aria-label="Paragraph alignment">
        ${alignButton('left', 'Align left', '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2.5 3.5h11M2.5 8h7M2.5 12.5h11"/></svg>')}
        ${alignButton('center', 'Align centre', '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2.5 3.5h11M4.5 8h7M2.5 12.5h11"/></svg>')}
        ${alignButton('right', 'Align right', '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2.5 3.5h11M6.5 8h7M2.5 12.5h11"/></svg>')}
        ${alignButton('justify', 'Justify', '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11"/></svg>')}
      </div>
      <label class="text-style-field text-style-narrow" title="Line height">
        <span class="text-style-label">Line</span>
        <input type="number" data-text-field="lineHeight" min="0.6" max="4" step="0.05" />
      </label>
      <label class="text-style-field text-style-narrow" title="Letter spacing">
        <span class="text-style-label">Space</span>
        <input type="number" data-text-field="letterSpacing" min="-20" max="80" step="0.5" />
      </label>
      <label class="text-style-field text-style-narrow" title="Padding">
        <span class="text-style-label">Pad</span>
        <input type="number" data-text-field="padding" min="0" max="200" step="1" />
      </label>
      <label class="text-style-field text-style-swatch" title="Text colour">
        <span class="text-style-label">Text</span>
        <input type="color" data-text-field="color" />
      </label>
      <label class="text-style-field text-style-swatch" title="Background colour">
        <span class="text-style-label">Fill</span>
        <input type="color" data-text-field="background" />
      </label>
      <button type="button" class="text-style-toggle" data-text-bg="none" title="No background" aria-label="No background">None</button>
    `;
    this.textBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.textBar.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (target.matches('input[data-text-field], select[data-text-field]')) {
        this.applyTextBarField(target.dataset.textField!, target.value);
      } else if (target.matches('input[data-text-bg]')) {
        this.applyTextBarField('background', target.value);
      }
    });
    this.textBar.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (target.matches('input[data-text-field], select[data-text-field]')) {
        this.applyTextBarField(target.dataset.textField!, target.value, true);
      }
    });
    this.textBar.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const align = target.closest('button[data-text-align]') as HTMLButtonElement | null;
      if (align) {
        this.applyTextBarField('align', align.dataset.textAlign!);
        return;
      }
      const toggle = target.closest('button[data-text-toggle]') as HTMLButtonElement | null;
      if (toggle) {
        const node = this.selectedTextNode();
        if (!node) return;
        this.applyTextBarField('fontStyle', node.fontStyle === 'italic' ? 'normal' : 'italic');
        return;
      }
      const none = target.closest('button[data-text-bg]') as HTMLButtonElement | null;
      if (none) this.applyTextBarField('background', DEFAULT_TEXT_BACKGROUND);
    });
  }

  /** The one text object the bar is for, or null when the selection is anything else. */
  private selectedTextNode(): TextAnnotationNode | null {
    if (this.selectedNodeIds.length !== 1) return null;
    const node = this.project.canvas.nodes.find((entry) => entry.id === this.selectedNodeIds[0]);
    return node && node.type === 'text' ? node : null;
  }

  /** Show the bar for that text object, or put it away. */
  private syncTextStyleBar(): void {
    const node = this.selectedTextNode();
    if (!node) {
      if (!this.textBar.hidden) this.textBar.hidden = true;
      return;
    }
    if (this.textBar.hidden) this.textBar.hidden = false;
    const style = textStyleOf(node);
    const set = (field: string, value: string) => {
      const el = this.textBar.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[data-text-field="${field}"]`
      );
      if (el && el.value !== value) el.value = value;
    };
    set('fontFamily', style.fontFamily);
    set('fontSize', String(style.fontSize));
    set('fontWeight', String(style.fontWeight));
    set('lineHeight', String(style.lineHeight));
    set('letterSpacing', String(style.letterSpacing));
    set('padding', String(style.padding));
    set('color', toHexColor(style.color, DEFAULT_TEXT_COLOR));
    set('background', toHexColor(style.background, '#000000'));
    this.textBar
      .querySelectorAll<HTMLButtonElement>('[data-text-align]')
      .forEach((button) =>
        button.classList.toggle('is-active', button.dataset.textAlign === style.align)
      );
    this.textBar
      .querySelector('[data-text-toggle="italic"]')
      ?.classList.toggle('is-active', style.fontStyle === 'italic');
    this.textBar
      .querySelector('[data-text-bg="none"]')
      ?.classList.toggle('is-active', style.background === 'transparent');
  }

  /**
   * One control changed: write it to the node, re-apply its style, and let the
   * box re-measure itself. `commit` is for the events that end a gesture — the
   * history snapshot is taken once per edit rather than once per pixel of a
   * colour drag.
   */
  private applyTextBarField(field: string, raw: string, commit = false): void {
    const node = this.selectedTextNode();
    if (!node) return;
    if (commit) this.pushUndo();
    const number = Number.parseFloat(raw);
    switch (field) {
      case 'fontFamily':
        node.fontFamily = raw;
        break;
      case 'fontSize':
        if (Number.isFinite(number)) node.fontSize = Math.max(4, Math.min(400, number));
        break;
      case 'fontWeight':
        if (Number.isFinite(number)) node.fontWeight = number;
        break;
      case 'fontStyle':
        node.fontStyle = raw === 'italic' ? 'italic' : 'normal';
        break;
      case 'lineHeight':
        if (Number.isFinite(number)) node.lineHeight = Math.max(0.6, Math.min(4, number));
        break;
      case 'letterSpacing':
        if (Number.isFinite(number)) node.letterSpacing = Math.max(-20, Math.min(80, number));
        break;
      case 'padding':
        if (Number.isFinite(number)) node.padding = Math.max(0, Math.min(200, number));
        break;
      case 'align':
        node.align = raw === 'center' || raw === 'right' || raw === 'justify' ? raw : 'left';
        break;
      case 'color':
        node.color = raw;
        break;
      case 'background':
        node.background = raw;
        break;
      default:
        return;
    }
    const content = this.findNodeEl(node.id)?.querySelector<HTMLElement>('.node-text-content');
    if (content) {
      this.applyTextNodeStyle(node, content);
      this.fitTextNode(node, content);
    }
    this.syncTextStyleBar();
    this.markDirty();
  }

  /** What the node's chip says: its first line, short enough to read. */
  private textNodeLabel(node: TextAnnotationNode): string {
    const first = node.text.split('\n').find((line) => line.trim()) ?? '';
    const trimmed = first.trim();
    if (!trimmed) return 'Text';
    return trimmed.length > 28 ? `${trimmed.slice(0, 27)}…` : trimmed;
  }
}
