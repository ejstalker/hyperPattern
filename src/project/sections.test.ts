import { describe, expect, it } from 'vitest';
import { rectContains, sectionChildren, sectionsForNode, withSectionContents } from './sections';
import type { CanvasNode, SectionNode } from './types';

function section(id: string, x: number, y: number, width: number, height: number): SectionNode {
  return { type: 'section', id, label: id, x, y, width, height, zIndex: 0 };
}

function frame(id: string, x: number, y: number, width: number, height: number): CanvasNode {
  return { type: 'patternFrame', id, patternId: 'p', x, y, width, height, zIndex: 5 };
}

describe('rectContains', () => {
  it('takes an inner rectangle, edges and all', () => {
    const outer = { x: 0, y: 0, width: 100, height: 100 };
    expect(rectContains(outer, { x: 10, y: 10, width: 50, height: 50 })).toBe(true);
    expect(rectContains(outer, { x: 0, y: 0, width: 100, height: 100 })).toBe(true);
    expect(rectContains(outer, { x: 60, y: 60, width: 50, height: 50 })).toBe(false);
    expect(rectContains(outer, { x: -5, y: 10, width: 20, height: 20 })).toBe(false);
  });
});

describe('section membership', () => {
  it('holds the objects lying wholly inside it and nothing else', () => {
    const big = section('s1', 0, 0, 400, 300);
    const nodes: CanvasNode[] = [
      big,
      frame('in', 50, 50, 100, 100),
      frame('straddling', 350, 250, 100, 100),
    ];
    expect(sectionChildren(nodes, big).map((n) => n.id)).toEqual(['in']);
  });

  it('leaves sections out of each other', () => {
    const outer = section('outer', 0, 0, 400, 300);
    const inner = section('inner', 50, 50, 100, 100);
    const nodes: CanvasNode[] = [outer, inner, frame('in', 60, 60, 40, 40)];
    // A section is never one of another section's objects, and an object inside
    // the inner one belongs to the inner one — a section does not hoard its
    // neighbour's things.
    expect(sectionChildren(nodes, outer)).toHaveLength(0);
    expect(sectionChildren(nodes, inner).map((n) => n.id)).toEqual(['in']);
  });

  it('gives an object in two sections to the tighter one', () => {
    const wide = section('wide', 0, 0, 800, 600);
    const tight = section('tight', 100, 100, 200, 200);
    const nodes: CanvasNode[] = [wide, tight, frame('shared', 120, 120, 50, 50)];
    expect(sectionChildren(nodes, tight).map((n) => n.id)).toEqual(['shared']);
    expect(sectionChildren(nodes, wide)).toHaveLength(0);
    expect(sectionsForNode(nodes, nodes[2]).map((s) => s.id)).toEqual(['tight', 'wide']);
  });

  it('is a question about where things are, not what they were told', () => {
    const sec = section('s', 0, 0, 400, 300);
    const moving = frame('a', 50, 50, 100, 100);
    const nodes: CanvasNode[] = [sec, moving];
    expect(sectionChildren(nodes, sec)).toHaveLength(1);
    // Dragged out of the section: it simply is not in it any more.
    moving.x = 500;
    expect(sectionChildren(nodes, sec)).toHaveLength(0);
  });
});

describe('withSectionContents', () => {
  it('adds what a selected section holds, so one gesture moves the group', () => {
    const sec = section('s', 0, 0, 400, 300);
    const nodes: CanvasNode[] = [sec, frame('a', 10, 10, 50, 50), frame('b', 100, 100, 50, 50)];
    expect(withSectionContents(nodes, ['s']).sort()).toEqual(['a', 'b', 's']);
    expect(withSectionContents(nodes, ['a'])).toEqual(['a']);
    // Ids that are not on the board are dropped rather than carried.
    expect(withSectionContents(nodes, ['nope'])).toEqual(['nope']);
  });
});
