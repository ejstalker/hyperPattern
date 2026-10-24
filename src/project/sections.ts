import type { CanvasNode, SectionNode } from './types';

/**
 * Sections: the big visual groups an arrangement is read by.
 *
 * A section owns nothing — membership is worked out from where the objects are,
 * not stored on either side. That is what makes the grouping self-healing: drag
 * something into a section and it is in it, drag it out and it is not, and a
 * copied or undone board can never end up with a section pointing at objects
 * that are no longer where they were. What the membership *means* is decided by
 * the host: a section moves its contents, copies them and deletes them.
 */

/** The rectangle a node occupies on the board. */
export function nodeRect(node: CanvasNode): { x: number; y: number; width: number; height: number } {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

/** Is `inner` wholly inside `outer`? Touching an edge counts as inside. */
export function rectContains(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number }
): boolean {
  const slack = 0.5;
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

export function isSection(node: CanvasNode): node is SectionNode {
  return node.type === 'section';
}

/**
 * The objects a section holds: everything lying entirely inside it, in board
 * order, leaving out sections themselves — a section is a group of *objects*, and
 * nesting one inside another would make "what does this move?" ambiguous.
 *
 * Where two sections overlap, the smaller one wins: an object in the tighter
 * frame belongs to the more specific group.
 */
export function sectionChildren(
  nodes: readonly CanvasNode[],
  section: SectionNode,
  /** Nodes with no presence on the board — a stage hidden inside a drape — are
   *  not something a section can be seen to hold. */
  skip?: (node: CanvasNode) => boolean
): CanvasNode[] {
  const mine = nodeRect(section);
  return nodes.filter((node) => {
    if (node.id === section.id || isSection(node)) return false;
    if (skip?.(node)) return false;
    if (!rectContains(mine, nodeRect(node))) return false;
    return !nodes.some(
      (other) =>
        other.id !== section.id &&
        other.id !== node.id &&
        isSection(other) &&
        rectContains(nodeRect(other), nodeRect(node)) &&
        other.width * other.height < section.width * section.height
    );
  });
}

/** The sections a node belongs to, innermost first. */
export function sectionsForNode(
  nodes: readonly CanvasNode[],
  node: CanvasNode
): SectionNode[] {
  if (isSection(node)) return [];
  return nodes
    .filter((entry): entry is SectionNode => isSection(entry) && entry.id !== node.id)
    .filter((section) => rectContains(nodeRect(section), nodeRect(node)))
    .sort((a, b) => a.width * a.height - b.width * b.height);
}

/**
 * The ids to act on for a selection: the nodes themselves, plus the contents of
 * any section in it. Used by move, copy and delete, so all three agree on what
 * "the section" is.
 */
export function withSectionContents(
  nodes: readonly CanvasNode[],
  nodeIds: readonly string[],
  skip?: (node: CanvasNode) => boolean
): string[] {
  const out = new Set<string>(nodeIds);
  for (const id of nodeIds) {
    const node = nodes.find((entry) => entry.id === id);
    if (!node || !isSection(node)) continue;
    for (const child of sectionChildren(nodes, node, skip)) out.add(child.id);
  }
  return [...out];
}
