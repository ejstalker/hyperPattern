import type { CanvasNode, ProjectDocument } from './types';

/** The document a canvas node stands for. Notes and image references carry their
 *  own content, so they have nothing to link to. */
export type DuplicateKind = 'pattern' | 'mesh' | 'transform' | 'sim';

/** Old entity id → the id its copy is given, per kind, for one duplicate gesture. */
export type DuplicateLinks = Record<DuplicateKind, Map<string, string>>;

export type NodeDuplicatePlan = {
  /** The clonable nodes of the selection, back to front. */
  sources: CanvasNode[];
  /** Fresh ids for everything the copies will need, resolved before any cloning. */
  links: DuplicateLinks;
};

export function emptyDuplicateLinks(): DuplicateLinks {
  return {
    pattern: new Map(),
    mesh: new Map(),
    transform: new Map(),
    sim: new Map()
  };
}

export function nodeEntity(node: CanvasNode): { kind: DuplicateKind; id: string } | null {
  switch (node.type) {
    case 'patternFrame':
      return { kind: 'pattern', id: node.patternId };
    case 'meshFrame':
      return { kind: 'mesh', id: node.meshId };
    case 'transform3d':
      return { kind: 'transform', id: node.transformId };
    case 'simViewport':
      return { kind: 'sim', id: node.simId };
    default:
      return null;
  }
}

/** Is the document behind this node still in the project? A node whose document
 *  went missing has nothing to copy, and must not claim a link either. */
function hasDocument(
  project: ProjectDocument,
  entity: { kind: DuplicateKind; id: string }
): boolean {
  switch (entity.kind) {
    case 'pattern':
      return project.patterns.some((p) => p.id === entity.id);
    case 'mesh':
      return project.meshes.some((m) => m.id === entity.id);
    case 'transform':
      return project.transforms.some((t) => t.id === entity.id);
    case 'sim':
      return project.sims.some((s) => s.id === entity.id);
  }
}

/**
 * The transform and mesh a drape is driven by, straight from the wiring. The
 * transform comes first (a drape driven through one reads the mesh that
 * transform is arranged on), and a drape wired straight to a mesh has no
 * transform at all.
 */
export function simChainIds(
  project: ProjectDocument,
  simId: string
): { meshId: string | null; transformId: string | null } {
  const link = project.transformSimAssignments.find((a) => a.simId === simId);
  const transform = link ? project.transforms.find((t) => t.id === link.transformId) : undefined;
  let mesh = transform
    ? (project.meshes.find((m) => m.id === transform.meshId) ??
      project.meshes.find((m) =>
        project.meshTransformAssignments.some(
          (a) => a.transformId === transform.id && a.meshId === m.id
        )
      ))
    : undefined;
  if (!mesh) {
    const direct = project.assignments.find((a) => a.simId === simId);
    mesh = direct ? project.meshes.find((m) => m.id === direct.meshId) : undefined;
  }
  return { meshId: mesh?.id ?? null, transformId: transform?.id ?? null };
}

/** The stage documents hidden inside a drape, keyed `mesh:<id>` / `transform:<id>`. */
export function embeddedStageKeys(project: ProjectDocument): Set<string> {
  const keys = new Set<string>();
  for (const sim of project.sims) {
    const { meshId, transformId } = simChainIds(project, sim.id);
    if (meshId) keys.add(`mesh:${meshId}`);
    if (transformId) keys.add(`transform:${transformId}`);
  }
  return keys;
}

/**
 * A remesh / transform stage with no board presence of its own: it belongs to a
 * drape, which carries it in its fullscreen tabs rather than on the board.
 */
export function isEmbeddedStage(project: ProjectDocument, node: CanvasNode): boolean {
  if (node.type === 'meshFrame') return embeddedStageKeys(project).has(`mesh:${node.meshId}`);
  if (node.type === 'transform3d') {
    return embeddedStageKeys(project).has(`transform:${node.transformId}`);
  }
  return false;
}

/** The hidden chain a duplicated drape has to bring along to stay independent. */
function embeddedChainNodes(project: ProjectDocument, node: CanvasNode): CanvasNode[] {
  if (node.type !== 'simViewport') return [];
  const { meshId, transformId } = simChainIds(project, node.simId);
  const embedded = embeddedStageKeys(project);
  return project.canvas.nodes.filter((candidate) => {
    if (candidate.type === 'meshFrame') {
      return !!meshId && candidate.meshId === meshId && embedded.has(`mesh:${meshId}`);
    }
    if (candidate.type === 'transform3d') {
      return (
        !!transformId &&
        candidate.transformId === transformId &&
        embedded.has(`transform:${transformId}`)
      );
    }
    return false;
  });
}

/**
 * Work out what duplicating `nodeIds` will copy, allocating every id up front.
 * Resolving the ids before anything is cloned is what keeps a group duplicate
 * self-contained: a drape copied along with its transform, mesh and pattern links
 * to the *copies* of all three, whichever order the nodes happen to be cloned in
 * (the wiring is only written once the copies exist).
 *
 * A drape also brings the remesh / transform it hides (see `embeddedStageKeys`),
 * so a duplicated drape is driven by its own chain rather than sharing the
 * original's — those stages have no board presence to select.
 *
 * At most one node per document: a second node on the same pattern / mesh / …
 * would need a second copy that the group's single link could not point at, and
 * the board only ever wires one node per document anyway.
 */
export function planNodeDuplicates(
  project: ProjectDocument,
  nodeIds: readonly string[],
  newId: (prefix: DuplicateKind) => string
): NodeDuplicatePlan {
  const links = emptyDuplicateLinks();
  const sources: CanvasNode[] = [];
  const seenNodes = new Set<string>();
  const seenEntities = new Set<string>();

  for (const id of nodeIds) {
    if (seenNodes.has(id)) continue;
    seenNodes.add(id);
    const node = project.canvas.nodes.find((n) => n.id === id);
    if (!node) continue;
    // The hidden chain first, so its ids read in pipeline order.
    for (const stage of embeddedChainNodes(project, node)) {
      seenNodes.add(stage.id);
      sources.push(stage);
    }
    sources.push(node);
  }

  // Back to front, so the copies stack in the same order as the originals and
  // the ids they are handed read in that order too.
  sources.sort((a, b) => a.zIndex - b.zIndex);
  const usable: CanvasNode[] = [];
  for (const node of sources) {
    const entity = nodeEntity(node);
    if (entity) {
      if (!hasDocument(project, entity)) continue;
      const key = `${entity.kind}:${entity.id}`;
      if (seenEntities.has(key)) continue;
      seenEntities.add(key);
    }
    usable.push(node);
  }
  for (const node of usable) {
    const entity = nodeEntity(node);
    if (entity) links[entity.kind].set(entity.id, newId(entity.kind));
  }
  return { sources: usable, links };
}

/** Nodes whose board rectangle overlaps `rect` (board coordinates). */
export function nodesInBoardRect(
  nodes: readonly CanvasNode[],
  rect: { x: number; y: number; width: number; height: number },
  skip?: (node: CanvasNode) => boolean
): CanvasNode[] {
  return nodes.filter((node) => {
    if (skip?.(node)) return false;
    return (
      node.x < rect.x + rect.width &&
      node.x + node.width > rect.x &&
      node.y < rect.y + rect.height &&
      node.y + node.height > rect.y
    );
  });
}
