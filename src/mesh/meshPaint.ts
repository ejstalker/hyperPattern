import type { MeshGeometry } from '../project/types';

/** The visible region of a mesh preview, in pattern units — its SVG viewBox. */
export type MeshView = { x: number; y: number; w: number; h: number };
/** The preview's layout box, in CSS pixels. */
export type MeshLayout = { width: number; height: number };

/**
 * An edge shorter than this on screen is dropped.
 *
 * The wireframe is the whole triangulation — tens of thousands of edges on a
 * garment — and at the preview's own scale most of them are a fraction of a pixel
 * long. Drawing them costs the rasteriser a segment each and produces a grey wash;
 * leaving them out costs nothing and shows the mesh's shape instead of its noise.
 */
export const MIN_EDGE_PX = 0.75;

/** Pattern units rounded to two decimals: sub-pixel at every zoom the preview allows. */
const coord = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * The surface as one path: every triangle as its own subpath.
 *
 * A path *string* rather than `moveTo`/`lineTo` calls because the browser's path
 * API is the expensive part — building this by hand takes seconds on a garment
 * mesh, while `new Path2D(<one big string>)` parses the same geometry in
 * milliseconds. The caller compiles it once and reuses the result, since the
 * camera is a transform on the context rather than a change to the geometry.
 */
export function meshSurfacePath(geom: MeshGeometry | null | undefined): string {
  if (!geom) return '';
  const { vertices, triangles } = geom;
  if (vertices.length === 0 || triangles.length < 3) return '';
  const parts: string[] = new Array(Math.floor(triangles.length / 3));
  let n = 0;
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = vertices[triangles[i]];
    const b = vertices[triangles[i + 1]];
    const c = vertices[triangles[i + 2]];
    if (!a || !b || !c) continue;
    parts[n++] = `M${coord(a.x)} ${coord(a.y)}L${coord(b.x)} ${coord(b.y)}L${coord(c.x)} ${coord(c.y)}Z`;
  }
  parts.length = n;
  return parts.join('');
}

/** CSS px per pattern unit for an `xMidYMid meet` viewBox. */
export function meshViewScale(view: MeshView, layout: MeshLayout): number {
  if (!(view.w > 0) || !(view.h > 0)) return 1;
  if (!(layout.width > 0) || !(layout.height > 0)) return 1;
  return Math.min(layout.width / view.w, layout.height / view.h);
}

/**
 * The part of the wireframe worth drawing at this view: as one path string, plus
 * how many edges it holds.
 *
 * Two culls, both in screen space, because that is where the cost is: an edge
 * shorter than `minPx` would be a grey smudge rather than a line, and an edge
 * whose whole span lies outside the view cannot be seen at all. Together they keep
 * the work proportional to what is on screen — none of it at a fit view, a
 * thousand or so when zoomed into a seam — instead of to the size of the garment.
 */
export function meshEdgePath(
  geom: MeshGeometry | null | undefined,
  view: MeshView,
  layout: MeshLayout,
  minPx = MIN_EDGE_PX
): { path: string; count: number } {
  if (!geom?.edges?.length) return { path: '', count: 0 };
  const { vertices, edges } = geom;
  const scale = meshViewScale(view, layout);
  const minLength = minPx / scale;
  const minSq = minLength * minLength;
  // Bounds, so an edge is kept when its span crosses the view even if both its
  // ends sit outside it.
  const left = view.x;
  const top = view.y;
  const right = view.x + view.w;
  const bottom = view.y + view.h;
  const parts: string[] = [];
  let count = 0;
  for (const [i, j] of edges) {
    const a = vertices[i];
    const b = vertices[j];
    if (!a || !b) continue;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    if (dx * dx + dy * dy < minSq) continue;
    if (Math.max(a.x, b.x) < left || Math.min(a.x, b.x) > right) continue;
    if (Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) continue;
    parts.push(`M${coord(a.x)} ${coord(a.y)}L${coord(b.x)} ${coord(b.y)}`);
    count++;
  }
  return { path: parts.join(''), count };
}
