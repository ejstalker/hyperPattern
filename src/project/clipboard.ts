import type {
  CanvasNode,
  MeshDocument,
  MeshSimAssignment,
  MeshTransformAssignment,
  PatternDocument,
  PatternPiece,
  PieceTransform3d,
  ProjectDocument,
  SeamBinding,
  SimInstance,
  Transform3dInstance,
  TransformSimAssignment
} from './types';
import { planNodeDuplicates, simChainIds } from './nodeDuplicates';
import { piecesBoundsCm } from './containers';

/**
 * Copy and paste for the things a document is made of: the nodes on its board
 * (containers, image references, notes, and the mesh / transform / drape stages)
 * and the pieces inside a pattern.
 *
 * A clipboard payload has to stand on its own. It cannot point at a pattern or a
 * mesh by id, because the document it is pasted into is a different document —
 * or the same one, where a second paste has to make a second copy rather than
 * take the first over. So ids travel as they were and are re-minted on the way
 * in, exactly as a duplicate re-mints them.
 */
export const CLIPBOARD_KIND = 'hyperpattern/clipboard';
export const CLIPBOARD_VERSION = 1;

/** Documents a node copy drags along so it still works where it lands. */
export type ClipboardDocuments = {
  patterns: PatternDocument[];
  meshes: MeshDocument[];
  transforms: Transform3dInstance[];
  sims: SimInstance[];
  meshSim: MeshSimAssignment[];
  meshTransform: MeshTransformAssignment[];
  transformSim: TransformSimAssignment[];
};

export type NodeClipboard = ClipboardDocuments & {
  type: 'nodes';
  /** The copied nodes, moved so the group's top-left corner is at (0, 0). */
  nodes: CanvasNode[];
  /** Where that corner sat in the document they came from. */
  origin: { x: number; y: number };
};

export type PieceClipboard = {
  type: 'pieces';
  pieces: PatternPiece[];
  /** Seams with both ends on copied pieces. */
  seams: SeamBinding[];
  /** Centre of the copied work, so a paste can land it somewhere sensible. */
  origin: { x: number; y: number };
  patternName: string;
};

export type ClipboardPayload = NodeClipboard | PieceClipboard;

export type ClipboardEnvelope = {
  kind: typeof CLIPBOARD_KIND;
  version: number;
  payload: ClipboardPayload;
};

/** What the last copy put on the clipboard, and how many times it has been pasted. */
let clipboard: { payload: ClipboardPayload; pastes: number } | null = null;

export function setClipboard(payload: ClipboardPayload): void {
  clipboard = { payload, pastes: 0 };
}

export function getClipboard(): ClipboardPayload | null {
  return clipboard?.payload ?? null;
}

/** How far the next paste of this payload should be nudged from the last one. */
export function clipboardPasteCount(): number {
  return clipboard?.pastes ?? 0;
}

export function noteClipboardPaste(): void {
  if (clipboard) clipboard.pastes += 1;
}

export function describeClipboard(payload: ClipboardPayload): string {
  if (payload.type === 'pieces') {
    return payload.pieces.length === 1
      ? `Copied “${payload.pieces[0].name}”`
      : `Copied ${payload.pieces.length} pieces`;
  }
  const count = payload.nodes.length;
  return count === 1 ? 'Copied 1 node' : `Copied ${count} nodes`;
}

export function serializeClipboard(payload: ClipboardPayload): string {
  const envelope: ClipboardEnvelope = {
    kind: CLIPBOARD_KIND,
    version: CLIPBOARD_VERSION,
    payload,
  };
  return JSON.stringify(envelope);
}

/** Read a payload back, rejecting anything that is not one of ours. */
export function parseClipboardPayload(text: string | null | undefined): ClipboardPayload | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const envelope = parsed as Partial<ClipboardEnvelope>;
  if (envelope.kind !== CLIPBOARD_KIND || typeof envelope.version !== 'number') return null;
  const payload = envelope.payload as ClipboardPayload | undefined;
  if (!payload) return null;
  if (payload.type === 'pieces' && Array.isArray(payload.pieces)) return payload;
  if (payload.type === 'nodes' && Array.isArray(payload.nodes)) return payload;
  return null;
}

/**
 * Everything the given nodes need in order to work where they are pasted: their
 * own documents, and the documents those documents lean on.
 *
 * A mesh is useless without the pattern its boundaries are tagged from, and a
 * drape without the mesh and transform driving it, so the copy carries them —
 * the same closure a group duplicate keeps, extended to single nodes so that a
 * copy into another document is not born broken.
 */
function collectDocuments(
  project: ProjectDocument,
  nodes: readonly CanvasNode[]
): ClipboardDocuments {
  const patterns = new Map<string, PatternDocument>();
  const meshes = new Map<string, MeshDocument>();
  const transforms = new Map<string, Transform3dInstance>();
  const sims = new Map<string, SimInstance>();

  const wantPattern = (id: string): void => {
    if (patterns.has(id)) return;
    const pattern = project.patterns.find((p) => p.id === id);
    if (pattern) patterns.set(id, pattern);
  };
  const wantMesh = (id: string): void => {
    if (meshes.has(id)) return;
    const mesh = project.meshes.find((m) => m.id === id);
    if (!mesh) return;
    meshes.set(id, mesh);
    wantPattern(mesh.patternId);
  };
  const wantTransform = (id: string): void => {
    if (transforms.has(id)) return;
    const transform = project.transforms.find((t) => t.id === id);
    if (!transform) return;
    transforms.set(id, transform);
    wantMesh(transform.meshId);
  };
  const wantSim = (id: string): void => {
    if (sims.has(id)) return;
    const sim = project.sims.find((s) => s.id === id);
    if (!sim) return;
    sims.set(id, sim);
    const chain = simChainIds(project, id);
    if (chain.transformId) wantTransform(chain.transformId);
    if (chain.meshId) wantMesh(chain.meshId);
  };

  for (const node of nodes) {
    switch (node.type) {
      case 'patternFrame':
        wantPattern(node.patternId);
        break;
      case 'meshFrame':
        wantMesh(node.meshId);
        break;
      case 'transform3d':
        wantTransform(node.transformId);
        break;
      case 'simViewport':
        wantSim(node.simId);
        break;
      default:
        break;
    }
  }

  // Only the wiring that holds the copied documents together: an assignment
  // reaching out to a document left behind would be a thread to nothing.
  return {
    patterns: [...patterns.values()],
    meshes: [...meshes.values()],
    transforms: [...transforms.values()],
    sims: [...sims.values()],
    meshSim: project.assignments.filter((a) => meshes.has(a.meshId) && sims.has(a.simId)),
    meshTransform: project.meshTransformAssignments.filter(
      (a) => meshes.has(a.meshId) && transforms.has(a.transformId),
    ),
    transformSim: project.transformSimAssignments.filter(
      (a) => transforms.has(a.transformId) && sims.has(a.simId),
    ),
  };
}

/**
 * Copy the given board nodes, with everything they depend on.
 *
 * A drape also takes the remesh and transform it hides: those stages have no
 * presence on the board, but they are where its tabs come from, and a pasted
 * drape without them opens with nothing to switch to.
 */
export function copyNodes(
  project: ProjectDocument,
  nodeIds: readonly string[]
): NodeClipboard | null {
  const picked = project.canvas.nodes.filter((node) => nodeIds.includes(node.id));
  if (picked.length === 0) return null;
  // Ids are re-minted on paste, so the planner's allocation is only used for the
  // node list it resolves.
  const sources = planNodeDuplicates(project, nodeIds, (prefix) => prefix).sources;
  if (sources.length === 0) return null;
  const originX = Math.min(...picked.map((node) => node.x));
  const originY = Math.min(...picked.map((node) => node.y));
  const docs = collectDocuments(project, picked);
  return {
    type: 'nodes',
    nodes: sources.map((node) => ({
      ...structuredClone(node),
      x: node.x - originX,
      y: node.y - originY,
    })),
    origin: { x: originX, y: originY },
    patterns: structuredClone(docs.patterns),
    meshes: structuredClone(docs.meshes),
    transforms: structuredClone(docs.transforms),
    sims: structuredClone(docs.sims),
    meshSim: structuredClone(docs.meshSim),
    meshTransform: structuredClone(docs.meshTransform),
    transformSim: structuredClone(docs.transformSim),
  };
}

/**
 * Documents this payload's nodes are *about*, as opposed to the ones they merely
 * need in order to work.
 *
 * The distinction decides how a paste treats each document. A copied container is
 * a second window, and a window onto the same work is not a copy — so its pattern
 * is always duplicated. A mesh's source pattern, or a drape's mesh, is a
 * dependency: inside the document those still *are* the same work and are kept by
 * reference, which is also what keeps a pasted drape's Pattern tab pointing at the
 * container it came from. Outside it they are missing, and get duplicated.
 */
function ownedEntities(nodes: readonly CanvasNode[]): Set<string> {
  const owned = new Set<string>();
  for (const node of nodes) {
    switch (node.type) {
      case 'patternFrame':
        owned.add(`pattern:${node.patternId}`);
        break;
      case 'meshFrame':
        owned.add(`mesh:${node.meshId}`);
        break;
      case 'transform3d':
        owned.add(`transform:${node.transformId}`);
        break;
      case 'simViewport':
        owned.add(`sim:${node.simId}`);
        break;
      default:
        break;
    }
  }
  return owned;
}

/**
 * Paste a node payload into `project`.
 *
 * Everything the document does not already have is minted fresh, so the same
 * clipboard can be pasted twice — or into another document — without the copies
 * sharing anything they should not.
 */
export function pasteNodes(
  project: ProjectDocument,
  payload: NodeClipboard,
  opts: {
    x: number;
    y: number;
    zIndex: number;
    newId: (prefix: string) => string;
  }
): string[] {
  const owned = ownedEntities(payload.nodes);
  /** Keep the document's own copy when it is only a dependency, else re-mint. */
  const resolve = (
    kind: 'pattern' | 'mesh' | 'transform' | 'sim',
    id: string,
    exists: boolean
  ): string => {
    if (exists && !owned.has(`${kind}:${id}`)) return id;
    return opts.newId(kind);
  };

  const patternIds = new Map(
    payload.patterns.map((p) => [
      p.id,
      resolve('pattern', p.id, project.patterns.some((x) => x.id === p.id)),
    ])
  );
  const meshIds = new Map(
    payload.meshes.map((m) => [
      m.id,
      resolve('mesh', m.id, project.meshes.some((x) => x.id === m.id)),
    ])
  );
  const transformIds = new Map(
    payload.transforms.map((t) => [
      t.id,
      resolve('transform', t.id, project.transforms.some((x) => x.id === t.id)),
    ])
  );
  const simIds = new Map(
    payload.sims.map((s) => [s.id, resolve('sim', s.id, project.sims.some((x) => x.id === s.id))])
  );
  const pieceIds = new Map<string, string>();
  const pointIds = new Map<string, string>();

  for (const pattern of payload.patterns) {
    const id = patternIds.get(pattern.id);
    // A pattern kept by reference already holds its pieces: nothing to re-mint.
    if (!id || id === pattern.id) continue;
    project.patterns.push(remapPatternDom(pattern, id, opts.newId, pieceIds, pointIds));
  }
  for (const mesh of payload.meshes) {
    const id = meshIds.get(mesh.id);
    if (!id || id === mesh.id) continue;
    project.meshes.push({
      ...structuredClone(mesh),
      id,
      patternId: patternIds.get(mesh.patternId) ?? mesh.patternId,
      geometry: mesh.geometry ? remapGeometryPieces(mesh.geometry, pieceIds, pointIds) : null,
    });
  }
  for (const transform of payload.transforms) {
    const id = transformIds.get(transform.id);
    if (!id || id === transform.id) continue;
    const copy = structuredClone(transform);
    copy.id = id;
    copy.meshId = meshIds.get(transform.meshId) ?? transform.meshId;
    copy.pieceTransforms = remapPieceTransforms(transform.pieceTransforms, pieceIds);
    project.transforms.push(copy);
  }
  for (const sim of payload.sims) {
    const id = simIds.get(sim.id);
    if (!id || id === sim.id) continue;
    const copy = structuredClone(sim);
    copy.id = id;
    project.sims.push(copy);
  }
  for (const link of payload.meshSim) {
    project.assignments.push({
      id: opts.newId('assign'),
      meshId: meshIds.get(link.meshId) ?? link.meshId,
      simId: simIds.get(link.simId) ?? link.simId,
    });
  }
  for (const link of payload.meshTransform) {
    project.meshTransformAssignments.push({
      id: opts.newId('assign'),
      meshId: meshIds.get(link.meshId) ?? link.meshId,
      transformId: transformIds.get(link.transformId) ?? link.transformId,
    });
  }
  for (const link of payload.transformSim) {
    project.transformSimAssignments.push({
      id: opts.newId('assign'),
      transformId: transformIds.get(link.transformId) ?? link.transformId,
      simId: simIds.get(link.simId) ?? link.simId,
    });
  }

  const created: string[] = [];
  payload.nodes.forEach((node, index) => {
    const copy = structuredClone(node) as CanvasNode;
    copy.id = opts.newId('node');
    copy.x = node.x + opts.x;
    copy.y = node.y + opts.y;
    copy.zIndex = opts.zIndex + index;
    switch (copy.type) {
      case 'patternFrame':
        copy.patternId = patternIds.get(copy.patternId) ?? copy.patternId;
        break;
      case 'meshFrame':
        copy.meshId = meshIds.get(copy.meshId) ?? copy.meshId;
        break;
      case 'transform3d':
        copy.transformId = transformIds.get(copy.transformId) ?? copy.transformId;
        break;
      case 'simViewport':
        copy.simId = simIds.get(copy.simId) ?? copy.simId;
        break;
      default:
        break;
    }
    // A pasted frame must not sit on a layer of its own making: it goes on top.
    project.canvas.nodes.push(copy);
    created.push(copy.id);
  });
  return created;
}

/**
 * A pattern document with every piece, point and seam re-minted. The maps are
 * shared so a mesh's geometry — which is built from the same piece and point ids
 * — can be carried over to the copies.
 */
function remapPatternDom(
  pattern: PatternDocument,
  id: string,
  newId: (prefix: string) => string,
  pieceIds: Map<string, string>,
  pointIds: Map<string, string>
): PatternDocument {
  const copy = structuredClone(pattern);
  copy.id = id;
  for (const piece of copy.pieces) {
    pieceIds.set(piece.id, newId('piece'));
    for (const ring of [piece.points, ...(piece.holes ?? [])]) {
      for (const pt of ring) pointIds.set(pt.id, newId('pt'));
    }
  }
  copy.pieces = copy.pieces.map((piece) => remapPiece(piece, pieceIds, pointIds, newId));
  copy.seams = copy.seams
    .map((seam) => remapSeam(seam, pieceIds, pointIds, newId))
    .filter((seam): seam is SeamBinding => seam !== null);
  if (copy.blocks) {
    copy.blocks = copy.blocks.map((instance) => ({
      ...instance,
      id: newId('blk'),
      pieces: instance.pieces.map((entry) => ({
        role: entry.role,
        pieceId: pieceIds.get(entry.pieceId) ?? entry.pieceId,
      })),
    }));
  }
  return copy;
}

function remapPiece(
  piece: PatternPiece,
  pieceIds: Map<string, string>,
  pointIds: Map<string, string>,
  newId: (prefix: string) => string
): PatternPiece {
  const mapPoint = (pt: PatternPiece['points'][number]) => ({
    ...pt,
    id: pointIds.get(pt.id) ?? newId('pt'),
  });
  return {
    ...piece,
    id: pieceIds.get(piece.id) ?? newId('piece'),
    points: piece.points.map(mapPoint),
    holes: piece.holes?.map((ring) => ring.map(mapPoint)),
    seamAllowance: piece.seamAllowance
      ? {
          defaultCm: piece.seamAllowance.defaultCm,
          edges: piece.seamAllowance.edges
            ? Object.fromEntries(
                Object.entries(piece.seamAllowance.edges).map(([pointId, cm]) => [
                  pointIds.get(pointId) ?? pointId,
                  cm,
                ]),
              )
            : undefined,
        }
      : undefined,
  };
}

function remapSeam(
  seam: SeamBinding,
  pieceIds: Map<string, string>,
  pointIds: Map<string, string>,
  newId: (prefix: string) => string
): SeamBinding | null {
  const a = pieceIds.get(seam.a.pieceId);
  const b = pieceIds.get(seam.b.pieceId);
  if (!a || !b) return null;
  return {
    id: newId('seam'),
    a: {
      ...seam.a,
      pieceId: a,
      fromPointId: pointIds.get(seam.a.fromPointId) ?? seam.a.fromPointId,
      toPointId: pointIds.get(seam.a.toPointId) ?? seam.a.toPointId,
    },
    b: {
      ...seam.b,
      pieceId: b,
      fromPointId: pointIds.get(seam.b.fromPointId) ?? seam.b.fromPointId,
      toPointId: pointIds.get(seam.b.toPointId) ?? seam.b.toPointId,
    },
    restGapCm: seam.restGapCm,
  };
}

/** Carry a mesh's piece tags — and the point ids its seams resolve through —
 *  onto the copied pieces. */
function remapGeometryPieces(
  geometry: NonNullable<MeshDocument['geometry']>,
  pieceIds: Map<string, string>,
  pointIds: Map<string, string>
): NonNullable<MeshDocument['geometry']> {
  const copy = structuredClone(geometry);
  if (copy.vertexPieceIds) {
    copy.vertexPieceIds = copy.vertexPieceIds.map((id) =>
      id === null ? null : (pieceIds.get(id) ?? id),
    );
  }
  if (copy.boundary) {
    copy.boundary = copy.boundary.map((tag) =>
      tag
        ? {
            pieceId: pieceIds.get(tag.pieceId) ?? tag.pieceId,
            fromPointId: pointIds.get(tag.fromPointId) ?? tag.fromPointId,
            toPointId: pointIds.get(tag.toPointId) ?? tag.toPointId,
            t: tag.t,
          }
        : null,
    );
  }
  return copy;
}

function remapPieceTransforms(
  transforms: Record<string, PieceTransform3d>,
  pieceIds: Map<string, string>
): Record<string, PieceTransform3d> {
  const out: Record<string, PieceTransform3d> = {};
  for (const [pieceId, transform] of Object.entries(transforms)) {
    out[pieceIds.get(pieceId) ?? pieceId] = structuredClone(transform);
  }
  return out;
}

/** Copy the picked pieces of a pattern, with the seams that join them. */
export function copyPieces(
  pattern: PatternDocument,
  pieceIds: readonly string[]
): PieceClipboard | null {
  const wanted = new Set(pieceIds);
  const pieces = pattern.pieces.filter((piece) => wanted.has(piece.id));
  if (pieces.length === 0) return null;
  const kept = new Set(pieces.map((piece) => piece.id));
  const bounds = piecesBoundsCm(pieces);
  return {
    type: 'pieces',
    pieces: structuredClone(pieces),
    seams: structuredClone(
      pattern.seams.filter((seam) => kept.has(seam.a.pieceId) && kept.has(seam.b.pieceId)),
    ),
    origin: bounds
      ? {
          x: (bounds.min.x + bounds.max.x) / 2,
          y: (bounds.min.y + bounds.max.y) / 2,
        }
      : { x: 0, y: 0 },
    patternName: pattern.name,
  };
}

/**
 * Paste copied pieces into a pattern, nudged to (dx, dy) from where they were
 * copied. Returns the new piece ids, ready to be selected.
 */
export function pastePieces(
  pattern: PatternDocument,
  payload: PieceClipboard,
  opts: { dx: number; dy: number; newId: (prefix: string) => string }
): string[] {
  const pieceIds = new Map<string, string>();
  const pointIds = new Map<string, string>();
  for (const piece of payload.pieces) {
    pieceIds.set(piece.id, opts.newId('piece'));
    for (const ring of [piece.points, ...(piece.holes ?? [])]) {
      for (const pt of ring) pointIds.set(pt.id, opts.newId('pt'));
    }
  }
  const created = payload.pieces.map((piece) =>
    shiftPiece(remapPiece(piece, pieceIds, pointIds, opts.newId), opts.dx, opts.dy),
  );
  pattern.pieces.push(...created);
  for (const seam of payload.seams) {
    const copy = remapSeam(seam, pieceIds, pointIds, opts.newId);
    if (copy) pattern.seams.push(copy);
  }
  return created.map((piece) => piece.id);
}

function shiftPiece(piece: PatternPiece, dx: number, dy: number): PatternPiece {
  const shift = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
  return {
    ...piece,
    points: piece.points.map((pt) => ({
      ...pt,
      anchor: shift(pt.anchor),
      handleIn: pt.handleIn ? shift(pt.handleIn) : null,
      handleOut: pt.handleOut ? shift(pt.handleOut) : null,
    })),
    holes: piece.holes?.map((ring) =>
      ring.map((pt) => ({
        ...pt,
        anchor: shift(pt.anchor),
        handleIn: pt.handleIn ? shift(pt.handleIn) : null,
        handleOut: pt.handleOut ? shift(pt.handleOut) : null,
      })),
    ),
    grainline: piece.grainline
      ? { from: shift(piece.grainline.from), to: shift(piece.grainline.to) }
      : undefined,
  };
}
