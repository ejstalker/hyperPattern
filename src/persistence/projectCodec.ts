import type { MeshDocument, ProjectDocument } from '../project/types';
import { DEFAULT_DISPLAY_UNIT } from '../project/types';
import { clampMaxSpeed, createMeshDocument, uid } from '../project/createDefault';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';
import { DEFAULT_CANVAS_CM_SCALE, fitContainerView } from '../project/containers';
/**
 * The container fields are the whole of what v3 adds, and every one of them is
 * optional, so a v2 document is a v3 document that simply has not been asked yet.
 */
export function migrateProjectV2ToV3(raw: ProjectDocument): ProjectDocument {
  const project: ProjectDocument = {
    ...raw,
    version: 3,
    canvas: { ...raw.canvas },
  };

  const scales: number[] = [];
  for (const node of project.canvas.nodes) {
    if (node.type !== 'patternFrame') continue;
    const pattern = project.patterns.find((p) => p.id === node.patternId);
    // The frame keeps the view it had: a pattern node used to fit its pattern to
    // the node, letterboxed and padded, and this is that same box expressed as
    // centimetres instead of as a zoom.
    const view = fitContainerView(pattern?.pieces ?? [], node.width, node.height);
    node.cmScale = view.cmScale;
    node.viewX = view.viewX;
    node.viewY = view.viewY;
    node.clip = true;
    if (pattern?.pieces.length) scales.push(view.cmScale);
  }

  if (!project.canvas.draftScale) {
    project.canvas.draftScale = scales.length
      ? median(scales)
      : DEFAULT_CANVAS_CM_SCALE;
  }
  if (!project.canvas.rootPatternId) {
    const canvasPattern = {
      id: uid('pattern'),
      name: 'Canvas',
      pieces: [],
      seams: [],
    };
    project.patterns = [...project.patterns, canvasPattern];
    project.canvas.rootPatternId = canvasPattern.id;
  }
  return project;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function normalizeProject(project: ProjectDocument): ProjectDocument {
  const normalized: ProjectDocument = {
    ...project,
    // A hand-edited or truncated file must not leave the UI showing
    // "Units: undefined" — fall back to the default rather than trust it.
    displayUnit: project.displayUnit === 'in' || project.displayUnit === 'cm'
      ? project.displayUnit
      : DEFAULT_DISPLAY_UNIT,
    transforms: project.transforms ?? [],
    meshTransformAssignments: project.meshTransformAssignments ?? [],
    transformSimAssignments: project.transformSimAssignments ?? [],
  };

  // Every document has a canvas pattern to draw on: the canvas is a surface in
  // its own right, so it can never be "the one without a pattern".
  const rootId = normalized.canvas.rootPatternId;
  if (!rootId || !normalized.patterns.some((p) => p.id === rootId)) {
    const canvasPattern = {
      id: uid('pattern'),
      name: 'Canvas',
      pieces: [],
      seams: [],
    };
    normalized.patterns = [...normalized.patterns, canvasPattern];
    normalized.canvas = { ...normalized.canvas, rootPatternId: canvasPattern.id };
  }
  if (!normalized.canvas.draftScale || normalized.canvas.draftScale <= 0) {
    normalized.canvas = {
      ...normalized.canvas,
      draftScale: DEFAULT_CANVAS_CM_SCALE,
    };
  }

  for (const transform of normalized.transforms) {
    if (!transform.pieceTransforms) transform.pieceTransforms = {};
  }

  const transformIds = new Set(normalized.transforms.map((transform) => transform.id));
  const claimedIds = new Set<string>();
  for (const node of normalized.canvas.nodes) {
    if (node.type !== 'transform3d') continue;
    if (transformIds.has(node.transformId)) {
      claimedIds.add(node.transformId);
      continue;
    }

    const staleId = node.transformId;
    const replacement = normalized.transforms.find(
      (transform) => !claimedIds.has(transform.id)
    );
    if (!replacement) continue;

    node.transformId = replacement.id;
    claimedIds.add(replacement.id);
    for (const assignment of normalized.meshTransformAssignments) {
      if (assignment.transformId === staleId) {
        assignment.transformId = replacement.id;
      }
    }
    for (const assignment of normalized.transformSimAssignments) {
      if (assignment.transformId === staleId) {
        assignment.transformId = replacement.id;
      }
    }
  }

  // Max speed's control used to run to 40 with a default of 30. A stored value
  // outside the new range would leave the inspector's thumb disagreeing with the
  // number next to it, and the engine still clamping at the old value.
  for (const sim of normalized.sims) {
    if (sim.params && sim.params.maxSpeed !== undefined) {
      sim.params.maxSpeed = clampMaxSpeed(sim.params.maxSpeed);
    }
  }

  const seenTransformLinks = new Set<string>();
  normalized.meshTransformAssignments = normalized.meshTransformAssignments.filter((assignment) => {
    if (!transformIds.has(assignment.transformId)) return false;
    if (seenTransformLinks.has(assignment.transformId)) return false;
    seenTransformLinks.add(assignment.transformId);
    return true;
  });

  return normalized;
}

export function serializeProject(project: ProjectDocument): string {
  return JSON.stringify(project);
}

export function parseProject(json: string): ProjectDocument {
  const raw = JSON.parse(json) as {
    version: number;
    id: string;
    name: string;
    displayUnit: ProjectDocument['displayUnit'];
    canvas?: ProjectDocument['canvas'];
    patterns?: ProjectDocument['patterns'];
    meshes?: MeshDocument[];
    sims?: ProjectDocument['sims'];
    assignments?: Array<{ id: string; patternId?: string; meshId?: string; simId: string }>;
    activeSimId?: string | null;
  };

  if (raw.version === 3) {
    return normalizeProject(raw as unknown as ProjectDocument);
  }

  if (raw.version === 2 && Array.isArray(raw.meshes)) {
    return normalizeProject(migrateProjectV2ToV3(raw as unknown as ProjectDocument));
  }

  if (raw.version === 1) {
    const patterns = raw.patterns ?? [];
    const sims = raw.sims ?? [];
    const meshes: MeshDocument[] = [];
    const assignments: ProjectDocument['assignments'] = [];
    const nodes = [...(raw.canvas?.nodes ?? [])];

    const oldAssigns = (raw.assignments ?? []).filter((a) => a.patternId && a.simId);
    const patternIds = new Set(oldAssigns.map((a) => a.patternId!));
    if (patternIds.size === 0 && patterns[0]) patternIds.add(patterns[0].id);

    let meshOffset = 0;
    for (const patternId of patternIds) {
      const pattern = patterns.find((p) => p.id === patternId);
      const mesh = createMeshDocument(patternId, `Mesh · ${pattern?.name ?? 'panel'}`);
      mesh.geometry = triangulatePattern(pattern, mesh.settings ?? { ...DEFAULT_MESH_SETTINGS });
      meshes.push(mesh);
      nodes.push({
        type: 'meshFrame',
        id: uid('node'),
        meshId: mesh.id,
        x: 420,
        y: 100 + meshOffset * 40,
        width: 136,
        height: 160,
        zIndex: 50 + meshOffset,
      });
      meshOffset += 1;
      for (const a of oldAssigns.filter((x) => x.patternId === patternId)) {
        assignments.push({ id: uid('assign'), meshId: mesh.id, simId: a.simId });
      }
    }

    return normalizeProject(
      migrateProjectV2ToV3({
        version: 2,
        id: raw.id,
        name: raw.name,
        displayUnit: raw.displayUnit,
        canvas: {
          panX: raw.canvas?.panX ?? 0,
          panY: raw.canvas?.panY ?? 0,
          zoom: raw.canvas?.zoom ?? 1,
          nodes,
        },
        patterns,
        meshes,
        transforms: [],
        sims,
        assignments,
        meshTransformAssignments: [],
        transformSimAssignments: [],
        activeSimId: raw.activeSimId ?? null,
      } as unknown as ProjectDocument)
    );
  }

  throw new Error(`Unsupported project version: ${raw.version}`);
}
