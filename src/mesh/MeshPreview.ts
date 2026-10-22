import type { MeshDocument, MeshGeometry, PatternDocument, UnitDisplay, Vec2 } from '../project/types';
import { boundsOf } from '../pattern/geometry';
import { buildGridGroup, viewScaleFor, type GridBox } from '../pattern/grid';
import { meshEdgePath, meshSurfacePath, meshViewScale } from './meshPaint';
import { buildPatternPointMarkers } from '../sim/patternPointMarkers';
import {
  drawMeshSeamBindings,
  drawMeshSeamConnectors,
  drawMeshSeamLines,
  seamRefsFromPattern,
} from './meshSeamDraw';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Zoom limits for the viewBox, in pattern units. */
const MIN_VIEW = 4;
const MAX_VIEW = 600;

/** Half the diameter of a pattern-point marker, matching the drape viewport. */
const MARKER_RADIUS_PX = 6.5;
const MARKER_STROKE_PX = 1.5;

/** The mesh's flat colours, matching what the SVG classes used to paint. */
const MESH_SURFACE_FILL = '#35302a';
const MESH_EDGE_STROKE = '#c2b9aa';
/** The wireframe's line weight, in pattern units — it scales with the view, as the
 *  SVG stroke did. At the fit view this is a twentieth of a pixel, which is the
 *  other half of why most of the wireframe is not drawn at all. */
const MESH_EDGE_WIDTH = 0.18;

/** A preview is a preview: past this much board zoom it is not re-rastered larger. */
const MAX_SHOWN_SCALE = 2;
/** Backing-store cap, so a preview left at 400% does not hold a huge texture. */
const MAX_CANVAS_RATIO = 4;

/**
 * Top-down 2D preview of a triangulated fabric mesh. Pans and zooms like the 2D
 * pattern editor, and marks the mesh vertices that carry each pattern anchor.
 *
 * The surface and its wireframe are painted into a canvas, not built as SVG. A
 * garment mesh is tens of thousands of triangles and twice as many edges — 113,000
 * elements on this project's cloth, which took 865 ms to build and cost the board
 * a style recalculation over every one of them whenever it was told anything. As
 * two compiled paths they are one `fill` and one `stroke`, the wireframe is culled
 * to what is actually visible, and a pan repaints the canvas instead of rebuilding
 * the scene.
 *
 * The SVG stays for the things that are *not* geometry — the grid, the seams and
 * the pattern-point markers — because they are a few hundred elements and because
 * its viewBox makes them follow a pan or a zoom for free, at their own crispness
 * and without any JavaScript at all.
 */
export class MeshPreview {
  private root: HTMLElement;
  private svg: SVGSVGElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  /** The compiled surface path, and the geometry it was compiled from. */
  private surface: { geom: MeshGeometry; path: Path2D } | null = null;
  /** The layout size and pixel ratio the canvas was last sized for. */
  private canvasSize = { width: 0, height: 0, ratio: 0 };
  private resizeObserver: ResizeObserver | null = null;
  private mesh: MeshDocument;
  private pattern: PatternDocument | null;
  private unit: UnitDisplay;
  /** Visible region in mesh/pattern units — the SVG viewBox. */
  private view: GridBox = { x: 0, y: 0, w: 40, h: 40 };
  private pan:
    | { pointerId: number; clientX: number; clientY: number; viewX: number; viewY: number }
    | null = null;

  constructor(
    host: HTMLElement,
    mesh: MeshDocument,
    unit: UnitDisplay,
    pattern: PatternDocument | null = null
  ) {
    this.mesh = mesh;
    this.pattern = pattern;
    this.unit = unit;
    this.root = host;
    this.root.classList.add('mesh-preview');
    this.root.innerHTML = '';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mesh-canvas';
    // The painting goes under the SVG, which keeps the pointer and the things the
    // SVG is good at; the canvas is what actually holds the mesh.
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'mesh-svg');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.root.appendChild(this.svg);
    this.bindInteraction();
    this.fitView();
    this.redraw();
    // A preview is built before its node is on the board, so the first redraw
    // happens with no layout to paint into; and a node can be resized afterwards.
    // Watching the box covers both, and keeps the canvas rasterised at the size it
    // is actually shown.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        const { width, height } = this.svgSize();
        if (width === this.canvasSize.width && height === this.canvasSize.height) return;
        this.redraw();
      });
      this.resizeObserver.observe(this.svg);
    }
  }

  /**
   * Re-rasterise if the node's size on screen has changed without its layout
   * changing — which is what the board's zoom does. Cheap when nothing changed,
   * so the board can call it every time it settles.
   */
  refreshResolution(): void {
    const { width, height, ratio } = this.canvasSize;
    this.prepareCanvas();
    const changed =
      width !== this.canvasSize.width ||
      height !== this.canvasSize.height ||
      ratio !== this.canvasSize.ratio;
    const geom = this.mesh.geometry;
    if (changed && geom) this.drawGeometry(geom);
    else if (changed) this.clearCanvas();
  }

  /** Stop watching the layout. The host is throwing this preview away. */
  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.pan = null;
  }

  setUnit(unit: UnitDisplay): void {
    this.unit = unit;
    this.redraw();
  }

  setMesh(mesh: MeshDocument, pattern?: PatternDocument | null): void {
    if (mesh.geometry !== this.mesh.geometry) this.surface = null;
    this.mesh = mesh;
    if (pattern !== undefined) this.pattern = pattern;
    // New geometry: reset to a fit rather than keeping a stale view.
    this.fitView();
    this.redraw();
  }

  setPattern(pattern: PatternDocument | null): void {
    this.pattern = pattern;
    this.redraw();
  }

  /** Frame the whole mesh. */
  fitView(): void {
    const geom = this.mesh.geometry;
    if (!geom || geom.vertices.length === 0) {
      this.view = { x: 0, y: 0, w: 40, h: 40 };
      return;
    }
    const { min, max } = boundsOf(geom.vertices);
    const pad = 4;
    this.view = {
      x: min.x - pad,
      y: min.y - pad,
      w: Math.max(max.x - min.x, 1) + pad * 2,
      h: Math.max(max.y - min.y, 1) + pad * 2,
    };
  }

  /** Layout CSS px per pattern unit. */
  private viewScale(): number {
    return viewScaleFor(this.view, {
      width: this.svg.clientWidth,
      height: this.svg.clientHeight,
    });
  }

  /** Screen px per pattern unit, including any CSS scale on the board. */
  private screenScale(): number {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return 1;
    return Math.min(rect.width / this.view.w, rect.height / this.view.h);
  }

  /**
   * Map a client point into pattern space. The board applies a CSS scale, so
   * `getScreenCTM()` can't be trusted — map via the layout box + viewBox
   * (xMidYMid meet), same as the pattern editor.
   */
  private clientToPattern(clientX: number, clientY: number): Vec2 {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { x: this.view.x, y: this.view.y };
    const s = Math.min(rect.width / this.view.w, rect.height / this.view.h);
    const mappedW = this.view.w * s;
    const mappedH = this.view.h * s;
    const ox = rect.left + (rect.width - mappedW) / 2;
    const oy = rect.top + (rect.height - mappedH) / 2;
    return { x: this.view.x + (clientX - ox) / s, y: this.view.y + (clientY - oy) / s };
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const before = this.clientToPattern(clientX, clientY);
    const scale = this.viewScale();
    const nextW = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.view.w * factor));
    const nextH = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.view.h * factor));
    if (nextW === this.view.w && nextH === this.view.h) return;
    this.view.w = nextW;
    this.view.h = nextH;
    // Keep the point under the cursor pinned.
    const after = this.clientToPattern(clientX, clientY);
    this.view.x += before.x - after.x;
    this.view.y += before.y - after.y;
    this.redrawView(scale);
  }

  private bindInteraction(): void {
    this.svg.addEventListener('pointerdown', (e) => {
      // Left, middle, or Alt+left all pan — there is nothing else to click here.
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      this.pan = {
        pointerId: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        viewX: this.view.x,
        viewY: this.view.y,
      };
      try {
        this.svg.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      this.root.classList.add('is-panning');
      this.svg.style.cursor = 'grabbing';
    });
    this.svg.addEventListener('pointermove', (e) => {
      const pan = this.pan;
      if (!pan || e.pointerId !== pan.pointerId) return;
      const s = this.screenScale();
      const scale = this.viewScale();
      this.view.x = pan.viewX - (e.clientX - pan.clientX) / s;
      this.view.y = pan.viewY - (e.clientY - pan.clientY) / s;
      // A pan moves what is drawn; it does not change what is drawn.
      this.redrawView(scale);
    });
    const end = (e: PointerEvent): void => {
      if (!this.pan || e.pointerId !== this.pan.pointerId) return;
      this.pan = null;
      this.root.classList.remove('is-panning');
      this.svg.style.cursor = '';
      try {
        this.svg.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
    this.svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 1 / 1.12);
      },
      { passive: false }
    );
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Draw everything: the mesh, and the marks that are explained by it. */
  redraw(): void {
    const geom = this.mesh.geometry;
    this.svg.innerHTML = '';
    if (!geom || geom.vertices.length === 0) {
      this.view = { x: 0, y: 0, w: 40, h: 40 };
      this.svg.setAttribute('viewBox', '0 0 40 40');
      this.clearCanvas();
      return;
    }

    this.applyViewBox();
    this.drawGeometry(geom);
    this.drawGrid();
    this.drawSeams(geom);
    this.drawPatternPoints(geom);
  }

  /**
   * Redraw for a view change only — a pan or a zoom.
   *
   * The seams and the markers are drawn in pattern units, so the viewBox moves
   * them without any work here; only the grid has to be restated (its spacing
   * ladder depends on the scale) and the canvas repainted. Markers are sized in
   * screen pixels, so they are re-drawn when the scale changes.
   */
  private redrawView(previousScale: number): void {
    const geom = this.mesh.geometry;
    this.applyViewBox();
    if (!geom || geom.vertices.length === 0) {
      this.clearCanvas();
      return;
    }
    this.drawGeometry(geom);
    this.svg.querySelector('.pattern-grid')?.remove();
    this.drawGrid();
    if (this.viewScale() !== previousScale) {
      this.svg.querySelector('.mesh-points')?.remove();
      this.drawPatternPoints(geom);
    }
  }

  private applyViewBox(): void {
    const { x, y, w, h } = this.view;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }

  private drawGrid(): void {
    // The grid is inserted first, so it stays behind anything drawn after it.
    this.svg.insertBefore(
      buildGridGroup(this.view, this.unit, {
        width: this.svg.clientWidth,
        height: this.svg.clientHeight,
      }),
      this.svg.firstChild
    );
  }

  /**
   * Mark the mesh vertex each pattern anchor lands on, styled like the drape
   * viewport's "Draw pattern points" tool.
   */
  private drawPatternPoints(geom: MeshGeometry): void {
    if (!this.pattern) return;
    const markers = buildPatternPointMarkers(geom, this.pattern);
    if (markers.length === 0) return;
    const scale = this.viewScale();
    if (!(scale > 0)) return;
    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('class', 'mesh-points');
    for (const marker of markers) {
      const v = geom.vertices[marker.vertexIndex];
      if (!v) continue;
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(v.x));
      dot.setAttribute('cy', String(v.y));
      dot.setAttribute('r', String(MARKER_RADIUS_PX / scale));
      dot.setAttribute('stroke-width', String(MARKER_STROKE_PX / scale));
      dot.setAttribute('class', 'mesh-point-marker');
      layer.appendChild(dot);
    }
    this.svg.appendChild(layer);
  }

  /** Paint the surface and the wireframe into the canvas, in pattern units. */
  private drawGeometry(geom: MeshGeometry): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width, height } = this.prepareCanvas();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!(width > 0) || !(height > 0)) return;

    const view = this.view;
    const scale = meshViewScale(view, { width, height });
    const ratio = this.canvasSize.ratio;
    const offsetX = (width - view.w * scale) / 2;
    const offsetY = (height - view.h * scale) / 2;
    // Pattern units straight onto the canvas: the camera is the transform, so the
    // surface path never has to be rebuilt for a pan or a zoom.
    ctx.setTransform(
      scale * ratio,
      0,
      0,
      scale * ratio,
      (offsetX - view.x * scale) * ratio,
      (offsetY - view.y * scale) * ratio
    );

    const surface = this.surfacePath(geom);
    if (surface) {
      ctx.fillStyle = MESH_SURFACE_FILL;
      ctx.fill(surface);
    }

    const edges = meshEdgePath(geom, view, { width, height });
    if (edges.count > 0) {
      ctx.strokeStyle = MESH_EDGE_STROKE;
      ctx.lineWidth = MESH_EDGE_WIDTH;
      ctx.stroke(new Path2D(edges.path));
    }
  }

  /**
   * The compiled surface path for this geometry, built once and reused.
   *
   * Compiling it is the one expensive step (a garment mesh is a five-megabyte path
   * string, parsed in tens of milliseconds), and it does not depend on the view —
   * so it is kept until the mesh changes, and a pan or a zoom reuses it.
   */
  private surfacePath(geom: MeshGeometry): Path2D | null {
    if (this.surface?.geom === geom) return this.surface.path;
    const path = meshSurfacePath(geom);
    if (!path) {
      this.surface = { geom, path: new Path2D() };
      return null;
    }
    const compiled = new Path2D(path);
    this.surface = { geom, path: compiled };
    return compiled;
  }

  /**
   * Size the backing store to the element as it is actually shown.
   *
   * The board scales a node with a CSS transform, so the layout box is not the
   * size on screen: rasterising at the displayed ratio is what keeps the mesh as
   * crisp as the SVG it replaced, and it is capped because a preview blown up over
   * the whole screen does not need to be re-rastered at its full size.
   */
  private svgSize(): { width: number; height: number } {
    return { width: this.svg.clientWidth, height: this.svg.clientHeight };
  }

  private prepareCanvas(): { width: number; height: number } {
    const { width, height } = this.svgSize();
    if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
    const rect = this.svg.getBoundingClientRect();
    const shown = rect.width / width;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const ratio = Math.min(MAX_CANVAS_RATIO, Math.max(1, dpr * Math.min(shown, MAX_SHOWN_SCALE)));
    if (
      width !== this.canvasSize.width ||
      height !== this.canvasSize.height ||
      ratio !== this.canvasSize.ratio
    ) {
      this.canvasSize = { width, height, ratio };
      this.canvas.width = Math.max(1, Math.round(width * ratio));
      this.canvas.height = Math.max(1, Math.round(height * ratio));
    }
    return { width, height };
  }

  private clearCanvas(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawSeams(geom: MeshGeometry): void {
    if (!this.pattern || this.pattern.seams.length === 0) return;
    const seamRefs = seamRefsFromPattern(this.pattern);
    drawMeshSeamLines(this.svg, geom, seamRefs);
    drawMeshSeamConnectors(this.svg, this.pattern);
    drawMeshSeamBindings(this.svg, this.pattern);
  }
}
