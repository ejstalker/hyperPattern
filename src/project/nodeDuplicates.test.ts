import { describe, expect, it } from 'vitest';
import { createDefaultProject, uid } from './createDefault';
import {
  embeddedStageKeys,
  isEmbeddedStage,
  nodeEntity,
  nodesInBoardRect,
  planNodeDuplicates,
  simChainIds,
  type DuplicateKind
} from './nodeDuplicates';
import type { CanvasNode, ProjectDocument } from './types';

/** The default project's chain: pattern → mesh → transform 3D → drape. */
function defaultProject(): ProjectDocument {
  return createDefaultProject();
}

function nodeOf(project: ProjectDocument, type: CanvasNode['type']): CanvasNode {
  const node = project.canvas.nodes.find((n) => n.type === type);
  if (!node) throw new Error(`no ${type} node`);
  return node;
}

function idGen(): (prefix: DuplicateKind) => string {
  let n = 0;
  return (prefix) => `${prefix}-copy-${++n}`;
}

describe('planNodeDuplicates', () => {
  it('copies the whole chain, linking each copy to the next', () => {
    const project = defaultProject();
    const [pattern, mesh, transform, drape] = [
      nodeOf(project, 'patternFrame'),
      nodeOf(project, 'meshFrame'),
      nodeOf(project, 'transform3d'),
      nodeOf(project, 'simViewport')
    ];
    const plan = planNodeDuplicates(
      project,
      [drape.id, mesh.id, pattern.id, transform.id],
      idGen()
    );

    expect(plan.sources.map((n) => n.type)).toEqual([
      'patternFrame',
      'meshFrame',
      'transform3d',
      'simViewport'
    ]);
    const entity = (node: CanvasNode) => nodeEntity(node)!;
    expect(plan.links.pattern.get(entity(pattern).id)).toBe('pattern-copy-1');
    expect(plan.links.mesh.get(entity(mesh).id)).toBe('mesh-copy-2');
    expect(plan.links.transform.get(entity(transform).id)).toBe('transform-copy-3');
    expect(plan.links.sim.get(entity(drape).id)).toBe('sim-copy-4');
  });

  it('leaves the documents of unselected nodes out of the plan', () => {
    const project = defaultProject();
    const transform = nodeOf(project, 'transform3d');
    const mesh = nodeOf(project, 'meshFrame');
    const plan = planNodeDuplicates(project, [transform.id], idGen());

    expect(plan.sources.map((n) => n.id)).toEqual([transform.id]);
    expect(plan.links.transform.size).toBe(1);
    // The mesh it points at is not being copied, so copies must keep pointing at
    // the original one.
    expect(plan.links.mesh.size).toBe(0);
  });

  it('orders the copies back to front whatever order they were selected in', () => {
    const project = defaultProject();
    const drape = nodeOf(project, 'simViewport');
    const pattern = nodeOf(project, 'patternFrame');
    const plan = planNodeDuplicates(project, [drape.id, pattern.id], idGen());
    // The drape's hidden remesh and transform come along, in pipeline order.
    expect(plan.sources.map((n) => n.type)).toEqual([
      'patternFrame',
      'meshFrame',
      'transform3d',
      'simViewport'
    ]);
    expect(plan.sources.map((n) => n.zIndex)).toEqual([1, 2, 3, 4]);
  });

  it("brings a drape's hidden chain but not the pattern it was built from", () => {
    const project = defaultProject();
    const drape = nodeOf(project, 'simViewport');
    const plan = planNodeDuplicates(project, [drape.id], idGen());

    expect(plan.sources.map((n) => n.type)).toEqual(['meshFrame', 'transform3d', 'simViewport']);
    // The pattern is a board node of its own: left alone, the copy keeps reading it.
    expect(plan.links.pattern.size).toBe(0);
    expect([...plan.links.mesh.values()]).toEqual(['mesh-copy-1']);
    expect([...plan.links.transform.values()]).toEqual(['transform-copy-2']);
    expect([...plan.links.sim.values()]).toEqual(['sim-copy-3']);
  });

  it('drops unknown ids, duplicates of the same id, and nodes with no document', () => {
    const project = defaultProject();
    const pattern = nodeOf(project, 'patternFrame');
    const note: CanvasNode = {
      type: 'text',
      id: 'note-1',
      text: 'hello',
      fontSize: 14,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      zIndex: 9
    };
    project.canvas.nodes.push(note);
    const plan = planNodeDuplicates(
      project,
      ['missing-node', pattern.id, pattern.id, note.id],
      idGen()
    );
    expect(plan.sources.map((n) => n.id)).toEqual([pattern.id, note.id]);
    expect(plan.links.pattern.size).toBe(1);
  });

  it('skips a node whose pattern was deleted, and claims no link for it', () => {
    const project = defaultProject();
    const pattern = nodeOf(project, 'patternFrame');
    project.patterns = [];
    const plan = planNodeDuplicates(project, [pattern.id], idGen());
    expect(plan.sources).toEqual([]);
    expect(plan.links.pattern.size).toBe(0);
  });

  it('keeps one copy per document when two nodes share it', () => {
    const project = defaultProject();
    const mesh = nodeOf(project, 'meshFrame');
    const twin = { ...mesh, id: uid('node'), zIndex: mesh.zIndex + 1 };
    project.canvas.nodes.push(twin);
    const plan = planNodeDuplicates(project, [mesh.id, twin.id], idGen());
    expect(plan.sources.map((n) => n.id)).toEqual([mesh.id]);
    expect(plan.links.mesh.size).toBe(1);
  });
});

describe('nodesInBoardRect', () => {
  const rectA: CanvasNode = {
    type: 'text',
    id: 'a',
    text: '',
    fontSize: 14,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    zIndex: 1
  };
  const rectB: CanvasNode = { ...rectA, id: 'b', x: 200, y: 0 };

  it('takes nodes the rectangle touches and leaves the rest', () => {
    expect(
      nodesInBoardRect([rectA, rectB], {
        x: -10,
        y: -10,
        width: 120,
        height: 70
      })
    ).toEqual([rectA]);
    // Touching edges count: the marquee only has to overlap, not engulf.
    expect(
      nodesInBoardRect([rectA, rectB], {
        x: 90,
        y: 20,
        width: 200,
        height: 10
      })
    ).toEqual([rectA, rectB]);
  });

  it('honours the skip test', () => {
    expect(
      nodesInBoardRect(
        [rectA, rectB],
        { x: -10, y: -10, width: 400, height: 200 },
        (n) => n.id === 'a'
      )
    ).toEqual([rectB]);
  });
});

describe('simChainIds', () => {
  it('walks transform → mesh for a drape driven through a transform', () => {
    const project = defaultProject();
    const drape = nodeOf(project, 'simViewport');
    const transform = nodeOf(project, 'transform3d');
    const mesh = nodeOf(project, 'meshFrame');
    expect(simChainIds(project, (drape as { simId: string }).simId)).toEqual({
      meshId: (mesh as { meshId: string }).meshId,
      transformId: (transform as { transformId: string }).transformId
    });
  });

  it('follows a drape wired straight to a mesh, with no transform', () => {
    const project = defaultProject();
    const drape = nodeOf(project, 'simViewport');
    const mesh = nodeOf(project, 'meshFrame');
    const simId = (drape as { simId: string }).simId;
    project.transformSimAssignments = [];
    project.assignments = [
      {
        id: 'assign-direct',
        meshId: (mesh as { meshId: string }).meshId,
        simId
      }
    ];
    expect(simChainIds(project, simId)).toEqual({
      meshId: (mesh as { meshId: string }).meshId,
      transformId: null
    });
  });
});

describe('embedded stages', () => {
  it('hides the remesh and transform a drape owns, and nothing else', () => {
    const project = defaultProject();
    const mesh = nodeOf(project, 'meshFrame');
    const transform = nodeOf(project, 'transform3d');
    const pattern = nodeOf(project, 'patternFrame');
    const keys = embeddedStageKeys(project);
    expect(keys.has(`mesh:${(mesh as { meshId: string }).meshId}`)).toBe(true);
    expect(keys.has(`transform:${(transform as { transformId: string }).transformId}`)).toBe(true);
    expect(isEmbeddedStage(project, mesh)).toBe(true);
    expect(isEmbeddedStage(project, transform)).toBe(true);
    expect(isEmbeddedStage(project, pattern)).toBe(false);
  });

  it('lets a stage out onto the board when nothing drives a drape through it', () => {
    const project = defaultProject();
    const transform = nodeOf(project, 'transform3d');
    project.transformSimAssignments = [];
    expect(isEmbeddedStage(project, transform)).toBe(false);
  });
});
