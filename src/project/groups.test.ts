import { describe, expect, it } from 'vitest';
import { rectContains, groupChildren, groupsForNode, withGroupContents } from './groups';
import type { CanvasNode, GroupNode } from './types';

function group(id: string, x: number, y: number, width: number, height: number): GroupNode {
  return { type: 'group', id, label: id, x, y, width, height, zIndex: 0 };
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

describe('group membership', () => {
  it('holds the objects lying wholly inside it and nothing else', () => {
    const big = group('s1', 0, 0, 400, 300);
    const nodes: CanvasNode[] = [
      big,
      frame('in', 50, 50, 100, 100),
      frame('straddling', 350, 250, 100, 100),
    ];
    expect(groupChildren(nodes, big).map((n) => n.id)).toEqual(['in']);
  });

  it('leaves groups out of each other', () => {
    const outer = group('outer', 0, 0, 400, 300);
    const inner = group('inner', 50, 50, 100, 100);
    const nodes: CanvasNode[] = [outer, inner, frame('in', 60, 60, 40, 40)];
    // A group is never one of another group's objects, and an object inside
    // the inner one belongs to the inner one — a group does not hoard its
    // neighbour's things.
    expect(groupChildren(nodes, outer)).toHaveLength(0);
    expect(groupChildren(nodes, inner).map((n) => n.id)).toEqual(['in']);
  });

  it('gives an object in two groups to the tighter one', () => {
    const wide = group('wide', 0, 0, 800, 600);
    const tight = group('tight', 100, 100, 200, 200);
    const nodes: CanvasNode[] = [wide, tight, frame('shared', 120, 120, 50, 50)];
    expect(groupChildren(nodes, tight).map((n) => n.id)).toEqual(['shared']);
    expect(groupChildren(nodes, wide)).toHaveLength(0);
    expect(groupsForNode(nodes, nodes[2]).map((s) => s.id)).toEqual(['tight', 'wide']);
  });

  it('is a question about where things are, not what they were told', () => {
    const sec = group('s', 0, 0, 400, 300);
    const moving = frame('a', 50, 50, 100, 100);
    const nodes: CanvasNode[] = [sec, moving];
    expect(groupChildren(nodes, sec)).toHaveLength(1);
    // Dragged out of the group: it simply is not in it any more.
    moving.x = 500;
    expect(groupChildren(nodes, sec)).toHaveLength(0);
  });
});

describe('withGroupContents', () => {
  it('adds what a selected group holds, so one gesture moves the group', () => {
    const sec = group('s', 0, 0, 400, 300);
    const nodes: CanvasNode[] = [sec, frame('a', 10, 10, 50, 50), frame('b', 100, 100, 50, 50)];
    expect(withGroupContents(nodes, ['s']).sort()).toEqual(['a', 'b', 's']);
    expect(withGroupContents(nodes, ['a'])).toEqual(['a']);
    // Ids that are not on the board are dropped rather than carried.
    expect(withGroupContents(nodes, ['nope'])).toEqual(['nope']);
  });
});
