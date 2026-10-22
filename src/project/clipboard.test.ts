import { describe, expect, it } from 'vitest';
import {
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
} from './clipboard';
import { createSmallFixture } from '../persistence/fixtures';
import { rectPiece, uid } from './createDefault';
import type { CanvasNode, PatternFrameNode, ProjectDocument } from './types';

function withFrame(project: ProjectDocument, patternId: string): PatternFrameNode {
  const frame: PatternFrameNode = {
    type: 'patternFrame',
    id: uid('node'),
    patternId,
    x: 100,
    y: 40,
    width: 300,
    height: 400,
    zIndex: 1,
  };
  project.canvas.nodes.push(frame);
  return frame;
}

describe('clipboard: nodes', () => {
  it('copies a container with its pattern', () => {
    const project = createSmallFixture();
    const frame = withFrame(project, project.patterns[1].id);
    const clip = copyNodes(project, [frame.id]);
    expect(clip).not.toBeNull();
    expect(clip!.nodes).toHaveLength(1);
    expect(clip!.patterns.map((p) => p.id)).toContain(project.patterns[1].id);
    // Positions travel relative to the group's corner, so a paste can land them anywhere.
    expect(clip!.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(clip!.origin).toEqual({ x: 100, y: 40 });
  });

  it('carries the pattern a mesh was triangulated from', () => {
    const project = createSmallFixture();
    const mesh = project.meshes[0];
    project.canvas.nodes.push({
      type: 'meshFrame',
      id: 'node_mesh',
      meshId: mesh.id,
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      zIndex: 2,
    });
    // Copying the mesh node alone still brings its source pattern: without it the
    // geometry's piece tags point at nothing in the document it lands in.
    const clip = copyNodes(project, ['node_mesh'])!;
    expect(clip.meshes.map((m) => m.id)).toContain(mesh.id);
    expect(clip.patterns.map((p) => p.id)).toContain(mesh.patternId);
  });

  it('pastes into another document with fresh ids and no shared documents', () => {
    const source = createSmallFixture();
    const frame = withFrame(source, source.patterns[1].id);
    const clip = copyNodes(source, [frame.id])!;

    const target = createSmallFixture();
    target.patterns = [];
    target.meshes = [];
    target.transforms = [];
    target.sims = [];
    target.canvas.nodes = [];
    const ids = pasteNodes(target, clip!, {
      x: 500,
      y: 200,
      zIndex: 10,
      newId: (prefix) => uid(prefix),
    });
    expect(ids).toHaveLength(1);
    const pasted = target.canvas.nodes.find((n) => n.id === ids[0])!;
    expect(pasted).toMatchObject({ x: 500, y: 200, zIndex: 10 });
    if (pasted.type !== 'patternFrame') throw new Error('expected a container');
    expect(pasted.patternId).not.toBe(frame.patternId);
    const pattern = target.patterns.find((p) => p.id === pasted.patternId)!;
    expect(pattern.pieces).toHaveLength(1);
    // New piece and point ids: the copy is its own work, not a second view of it.
    expect(pattern.pieces[0].id).not.toBe(source.patterns[1].pieces[0].id);
    expect(pattern.pieces[0].points[0].id).not.toBe(source.patterns[1].pieces[0].points[0].id);
  });

  it('gives a pasted container its own pattern, and a pasted drape the document’s', () => {
    const project = createSmallFixture();
    const frame = withFrame(project, project.patterns[1].id);
    project.canvas.nodes.push({
      type: 'simViewport',
      id: 'node_sim',
      simId: project.sims[0].id,
      x: 0,
      y: 0,
      width: 300,
      height: 300,
      zIndex: 3,
    });
    project.transformSimAssignments.push({
      id: uid('assign'),
      transformId: project.transforms[0].id,
      simId: project.sims[0].id,
    });
    const newId = (prefix: string) => uid(prefix);

    const frames = copyNodes(project, [frame.id])!;
    const [frameCopyId] = pasteNodes(project, frames, { x: 0, y: 0, zIndex: 50, newId });
    const frameCopy = project.canvas.nodes.find((n) => n.id === frameCopyId)!;
    if (frameCopy.type !== 'patternFrame') throw new Error('expected a container');
    // A second window needs its own work to look at.
    expect(frameCopy.patternId).not.toBe(frame.patternId);

    const drape = copyNodes(project, ['node_sim'])!;
    const [simCopyId] = pasteNodes(project, drape, { x: 0, y: 0, zIndex: 80, newId });
    const simCopy = project.canvas.nodes.find((n) => n.id === simCopyId)!;
    if (simCopy.type !== 'simViewport') throw new Error('expected a drape');
    // The drape's own chain is copied, but the pattern it was cut from is the
    // document's — pasting a drape is not an invitation to fork the pattern.
    expect(simCopy.simId).not.toBe(project.sims[0].id);
    const link = project.transformSimAssignments.find((a) => a.simId === simCopy.simId)!;
    const transform = project.transforms.find((t) => t.id === link.transformId)!;
    const mesh = project.meshes.find((m) => m.id === transform.meshId)!;
    expect(mesh.patternId).toBe(project.patterns[1].id);
  });

  it('pastes the same payload twice without the copies sharing a document', () => {
    const source = createSmallFixture();
    const frame = withFrame(source, source.patterns[1].id);
    const clip = copyNodes(source, [frame.id])!;
    const target = createSmallFixture();
    const newId = (prefix: string) => uid(prefix);
    const first = pasteNodes(target, clip, { x: 0, y: 0, zIndex: 0, newId });
    const second = pasteNodes(target, clip, { x: 40, y: 40, zIndex: 4, newId });
    const ids = target.canvas.nodes
      .filter((n) => n.type === 'patternFrame')
      .map((n) => (n as Extract<CanvasNode, { type: 'patternFrame' }>).patternId);
    expect(first[0]).not.toBe(second[0]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('brings a drape’s wiring with it', () => {
    const source = createSmallFixture();
    source.transformSimAssignments.push({
      id: uid('assign'),
      transformId: source.transforms[0].id,
      simId: source.sims[0].id,
    });
    source.canvas.nodes.push({
      type: 'simViewport',
      id: 'node_sim',
      simId: source.sims[0].id,
      x: 0,
      y: 0,
      width: 300,
      height: 300,
      zIndex: 3,
    });
    const clip = copyNodes(source, ['node_sim'])!;
    // The hidden remesh / transform stages come with it: they are the drape's tabs.
    expect(clip.nodes.filter((n) => n.type === 'meshFrame' || n.type === 'transform3d')).toHaveLength(
      source.canvas.nodes.filter(
        (n) => n.type === 'meshFrame' || n.type === 'transform3d'
      ).length
    );
    expect(clip.sims).toHaveLength(1);
    expect(clip.transforms).toHaveLength(1);
    expect(clip.meshes).toHaveLength(1);
    expect(clip.transformSim).toHaveLength(1);

    const target = createSmallFixture();
    const ids = pasteNodes(target, clip, {
      x: 0,
      y: 0,
      zIndex: 0,
      newId: (prefix) => uid(prefix),
    });
    const pasted = target.canvas.nodes.find((n) => n.id === ids[0])!;
    if (pasted.type !== 'simViewport') throw new Error('expected a drape');
    const link = target.transformSimAssignments.find((a) => a.simId === pasted.simId);
    expect(link).toBeDefined();
    expect(target.transforms.some((t) => t.id === link!.transformId)).toBe(true);
    expect(target.sims.find((s) => s.id === pasted.simId)).toBeDefined();
  });
});

describe('clipboard: pieces', () => {
  it('copies pieces and only the seams between them', () => {
    const project = createSmallFixture();
    const pattern = project.patterns[1];
    const other = rectPiece('Other', 20, 20, { x: 100, y: 0 });
    pattern.pieces.push(other);
    const [first, second] = pattern.pieces;
    pattern.seams.push(
      {
        id: uid('seam'),
        a: {
          pieceId: first.id,
          fromPointId: first.points[0].id,
          toPointId: first.points[1].id,
          t0: 0,
          t1: 1,
        },
        b: {
          pieceId: second.id,
          fromPointId: second.points[0].id,
          toPointId: second.points[1].id,
          t0: 0,
          t1: 1,
        },
        restGapCm: 0.4,
      },
      {
        id: uid('seam'),
        a: {
          pieceId: second.id,
          fromPointId: second.points[0].id,
          toPointId: second.points[1].id,
          t0: 0,
          t1: 1,
        },
        b: {
          pieceId: other.id,
          fromPointId: other.points[0].id,
          toPointId: other.points[1].id,
          t0: 0,
          t1: 1,
        },
        restGapCm: 0.4,
      }
    );

    const clip = copyPieces(pattern, [first.id])!;
    expect(clip.pieces).toHaveLength(1);
    // A seam to a piece that stayed behind has no second end to sew to.
    expect(clip.seams).toHaveLength(0);
  });

  it('pastes pieces with new ids and re-links their seams', () => {
    const project = createSmallFixture();
    const pattern = project.patterns[1];
    const second = rectPiece('Second', 10, 10, { x: 60, y: 0 });
    pattern.pieces.push(second);
    const [first] = pattern.pieces;
    pattern.seams.push({
      id: uid('seam'),
      a: {
        pieceId: first.id,
        fromPointId: first.points[1].id,
        toPointId: first.points[2].id,
        t0: 0,
        t1: 1,
      },
      b: {
        pieceId: second.id,
        fromPointId: second.points[1].id,
        toPointId: second.points[2].id,
        t0: 0,
        t1: 1,
      },
      restGapCm: 0.4,
    });

    const clip = copyPieces(pattern, [first.id, second.id])!;
    expect(clip.seams).toHaveLength(1);
    const created = pastePieces(pattern, clip, {
      dx: 20,
      dy: 15,
      newId: (prefix) => uid(prefix),
    });
    expect(created).toHaveLength(2);
    expect(pattern.pieces).toHaveLength(4);

    const pastedFirst = pattern.pieces.find((p) => p.id === created[0])!;
    expect(pastedFirst.points[0].anchor).toEqual({
      x: first.points[0].anchor.x + 20,
      y: first.points[0].anchor.y + 15,
    });

    // The copied seam joins the two new pieces, and is not the original.
    const newSeam = pattern.seams.find((seam) => created.includes(seam.a.pieceId))!;
    expect(newSeam).toBeDefined();
    expect(created).toContain(newSeam.b.pieceId);
    expect(newSeam.a.fromPointId).toBe(pastedFirst.points[1].id);
  });
});

describe('clipboard: payloads', () => {
  it('round-trips through text', () => {
    const project = createSmallFixture();
    const pattern = project.patterns[1];
    const clip = copyPieces(pattern, [pattern.pieces[0].id])!;
    const text = serializeClipboard(clip);
    const back = parseClipboardPayload(text);
    expect(back).toEqual(clip);
  });

  it('ignores text that is not ours', () => {
    expect(parseClipboardPayload('hello')).toBeNull();
    expect(parseClipboardPayload('{"kind":"something-else"}')).toBeNull();
    expect(parseClipboardPayload(null)).toBeNull();
  });

  it('remembers the payload and how often it has been pasted', () => {
    const project = createSmallFixture();
    const frame = withFrame(project, project.patterns[1].id);
    const clip = copyNodes(project, [frame.id])!;
    setClipboard(clip);
    expect(getClipboard()).toEqual(clip);
    noteClipboardPaste();
    noteClipboardPaste();
    expect(describeClipboard(getClipboard()!)).toBe('Copied 1 node');
  });
});
