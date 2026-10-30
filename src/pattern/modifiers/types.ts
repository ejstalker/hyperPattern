import type { Vec2 } from '../../project/types';
import { NOISE_DEFAULTS, type NoiseParams } from './noise';

/**
 * The modifier stack: a small node network that cooks a pattern the way a SOP
 * chain cooks geometry.
 *
 * A node is a step. It runs over a *domain* — Houdini's "Run Over": whole pieces,
 * points, or edges — and only over the elements a *group* lets through. The
 * engine walks the stack in order, and each step sees what the one before it
 * made, so Cut → Subdivide → Displace → Noise composes the way it would in
 * Houdini or Blender's geometry nodes.
 */

/** What a node iterates over. */
export type ModifierDomain = 'piece' | 'point' | 'edge';

/**
 * One mask over a node's work.
 *
 * A mask is a test with a range: an element runs when it falls inside `[min, max]`
 * of whatever the mask reads. `point` masks read a point's order, `piece` masks a
 * piece's number (1 for the first piece in the pattern), and `attribute` masks a
 * named attribute — the value written by an Attribute or Noise node, typically.
 *
 * A node carries a list of them and an element has to pass **every** one, so
 * masks compose: "the points between 8 and 16" *and* "where gather is over 0.5".
 * No masks at all means the whole domain, which is what a fresh node does.
 */
export type ModifierMask =
  | {
      kind: 'point';
      /** Lowest point order that runs at full strength (a point's index round the piece). */
      min: number;
      /** Highest point order that runs at full strength, inclusive. */
      max: number;
      /**
       * How far outside the range the mask fades out, in the same units as the
       * range: `falloff: 2` on an order range of 4–8 runs at full strength on
       * orders 4 to 8, ramps from nothing at order 2 up to full at 4, and back
       * down to nothing at 10. A node uses that density to attenuate.
       */
      falloff?: number;
    }
  | {
      kind: 'piece';
      /** Lowest piece number that runs at full strength — 1 is the first piece. */
      min: number;
      max: number;
      /** As for point masks: how many pieces the fade is spread over. */
      falloff?: number;
    }
  | {
      kind: 'attribute';
      /** Which elements the named attribute is read from. */
      attributeClass: 'point' | 'edge' | 'piece';
      name: string;
      /** The value range that counts as true, inclusive. */
      min: number;
      max: number;
    };

/** What a fresh mask of each kind looks like: a range wide enough to pass everything. */
export function createModifierMask(kind: ModifierMask['kind']): ModifierMask {
  switch (kind) {
    case 'piece':
      return { kind, min: 1, max: 999, falloff: 0 };
    case 'attribute':
      return { kind, attributeClass: 'point', name: '', min: 0, max: 1 };
    case 'point':
    default:
      return { kind: 'point', min: 0, max: 999, falloff: 0 };
  }
}

export type ModifierNodeType =
  | 'cut'
  | 'transform'
  | 'subdivide'
  | 'displace'
  | 'noise'
  | 'create'
  | 'attribute'
  | 'anchor';

/** What every node carries, whatever it does. */
export type ModifierCommon = {
  id: string;
  /** Shown in the stack; the type is shown when this is empty. */
  name?: string;
  /** A bypassed node is skipped but stays in the stack. */
  enabled?: boolean;
  /** Run Over — which element the node's body is applied to. */
  domain?: ModifierDomain;
  /**
   * Which of those elements run. Every mask has to pass; none means all of them.
   */
  masks?: ModifierMask[];
  /**
   * Run the whole node this many times, like a for-each loop folded into the
   * node: Displace twice at 2 cm is displacement of 4 cm along a curving normal.
   */
  iterations?: number;
};

/** Split every matching piece along a line (or a polyline of cuts). */
export type CutNode = ModifierCommon & {
  type: 'cut';
  mode: 'line' | 'polyline';
  /** Line mode: two points on the infinite cutting line. */
  a: Vec2;
  b: Vec2;
  /** Polyline mode: the cutter's points, end to end. */
  points: Vec2[];
  /** Cut and keep both halves (the SOP default), or keep one side only. */
  keep: 'both' | 'a' | 'b';
};

/** Move, turn and scale geometry about a pivot. */
export type TransformNode = ModifierCommon & {
  type: 'transform';
  translate: Vec2;
  rotateDeg: number;
  scale: Vec2;
  /** `centroid` is the middle of everything the node matches. */
  pivot: 'origin' | 'centroid' | 'world' | 'anchor';
  /** Used by `world`. */
  pivotAt: Vec2;
  /** Used by `anchor`: the name an Anchor node tagged a point with. */
  anchor: string;
};

/** Insert points along edges — the drafting subdivision primitive. */
export type SubdivideNode = ModifierCommon & {
  type: 'subdivide';
  /** Extra points per edge. */
  cuts: number;
  /** Run on every Nth edge of each ring (1 = every edge). */
  every: number;
  /** Cut long edges so no piece of edge is longer than this (0 = ignore). */
  maxLengthCm: number;
  /** Copy the edge's starting point's attributes onto the new points. */
  carryAttributes: boolean;
};

/** Push points off the outline — the base of every gather and puff. */
export type DisplaceNode = ModifierCommon & {
  type: 'displace';
  /** `normal` pushes away from the piece's outline, `angle` in a fixed direction. */
  direction: 'normal' | 'angle' | 'radial';
  angleDeg: number;
  /** Centimetres per unit of whatever drives the push. */
  amount: number;
  /** Multiply the push by this point attribute's value (empty: constant push). */
  amountAttribute: string;
  /** Multiply the push by a noise field, sampled at each point. */
  useNoise: boolean;
  noise: NoiseParams;
};

/** Houdini's Unified Noise as a node: writes a scalar attribute per point. */
export type NoiseNode = ModifierCommon & {
  type: 'noise';
  /** Where the sampled value goes, e.g. `noise` or `gather`. */
  attribute: string;
  noise: NoiseParams;
};

/** Make geometry from nothing: a line, a rectangle, a circle or a polygon. */
export type CreateNode = ModifierCommon & {
  type: 'create';
  shape: 'line' | 'rect' | 'circle' | 'polygon';
  /** Top-left of the box (a line's start; a circle's centre minus its radius). */
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  sides: number;
  /** How many copies, stepped by `spacing` along x. */
  count: number;
  spacing: number;
  closed: boolean;
  name: string;
};

/** Write a named attribute onto every element the node runs over. */
export type AttributeNode = ModifierCommon & {
  type: 'attribute';
  /** The attribute's name, e.g. `zone`, `gather`, `stiffness`. */
  attribute: string;
  /** What to write. A value that reads as a number is stored as one. */
  value: string;
  /** Remove the attribute instead of setting it. */
  remove: boolean;
};

/** Tag a point as a named anchor, and optionally move it. */
export type AnchorNode = ModifierCommon & {
  type: 'anchor';
  /** The attribute value transforms look up. */
  anchor: string;
  at: Vec2;
  /** Move the point to `at`, or only tag it where it stands. */
  move: boolean;
  /** How far away a point may be and still be chosen; 0 ignores the distance. */
  maxDistanceCm: number;
};

export type ModifierNode =
  | CutNode
  | TransformNode
  | SubdivideNode
  | DisplaceNode
  | NoiseNode
  | CreateNode
  | AttributeNode
  | AnchorNode;

export const MODIFIER_LABELS: Record<ModifierNodeType, string> = {
  cut: 'Cut',
  transform: 'Transform',
  subdivide: 'Subdivide',
  displace: 'Displace',
  noise: 'Noise',
  create: 'Create',
  attribute: 'Attribute',
  anchor: 'Anchor',
};

/**
 * A new node of a kind, with defaults that do something visible.
 *
 * `bounds` is the middle of the work the stack is cooking: a cut line through it
 * and a shape drawn at it are useful straight away, where a line through the
 * origin usually is not.
 */
export function createModifierNode(
  type: ModifierNodeType,
  id: string,
  centre: Vec2 = { x: 0, y: 0 }
): ModifierNode {
  const common: ModifierCommon = { id, enabled: true, iterations: 1, masks: [] };
  switch (type) {
    case 'cut':
      return {
        ...common,
        type,
        domain: 'piece',
        mode: 'line',
        a: { x: centre.x, y: centre.y - 50 },
        b: { x: centre.x, y: centre.y + 50 },
        points: [],
        keep: 'both',
      };
    case 'transform':
      return {
        ...common,
        type,
        domain: 'point',
        translate: { x: 0, y: 0 },
        rotateDeg: 0,
        scale: { x: 1, y: 1 },
        pivot: 'centroid',
        pivotAt: { ...centre },
        anchor: '',
      };
    case 'subdivide':
      return {
        ...common,
        type,
        domain: 'edge',
        cuts: 1,
        every: 1,
        maxLengthCm: 0,
        carryAttributes: false,
      };
    case 'displace':
      return {
        ...common,
        type,
        domain: 'point',
        direction: 'normal',
        angleDeg: 0,
        amount: 1,
        amountAttribute: '',
        useNoise: false,
        noise: { ...NOISE_DEFAULTS },
      };
    case 'noise':
      return {
        ...common,
        type,
        domain: 'point',
        attribute: 'noise',
        noise: { ...NOISE_DEFAULTS },
      };
    case 'create':
      return {
        ...common,
        type,
        domain: 'piece',
        shape: 'rect',
        x: centre.x - 15,
        y: centre.y - 15,
        width: 30,
        height: 30,
        radius: 15,
        sides: 6,
        count: 1,
        spacing: 5,
        closed: true,
        name: 'Created',
      };
    case 'attribute':
      return {
        ...common,
        type,
        domain: 'point',
        attribute: 'zone',
        value: '1',
        remove: false,
      };
    case 'anchor':
      return {
        ...common,
        type,
        domain: 'point',
        anchor: 'a',
        at: { ...centre },
        move: false,
        maxDistanceCm: 0,
      };
  }
}

/**
 * Make a loaded stack safe to cook.
 *
 * A node the build does not know is dropped with its neighbours left in order,
 * and every known node is filled out from its defaults so a document written by
 * an older build still cooks. Parameters themselves are clamped where they are
 * used — a node never trusts a number it did not check.
 */
export function normalizeModifiers(nodes: readonly ModifierNode[] | undefined): ModifierNode[] {
  const out: ModifierNode[] = [];
  for (const raw of nodes ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const type = (raw as { type?: unknown }).type;
    if (typeof type !== 'string' || !(type in MODIFIER_LABELS)) continue;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `mod_${out.length + 1}`;
    const defaults = createModifierNode(type as ModifierNodeType, id);
    const merged = { ...defaults, ...raw, id, type } as ModifierNode;
    merged.enabled = raw.enabled !== false;
    if (merged.masks) merged.masks = normalizeMasks(merged.masks);
    const iterations = Number((raw as { iterations?: unknown }).iterations);
    merged.iterations = Number.isFinite(iterations) ? Math.max(1, Math.min(24, Math.round(iterations))) : 1;
    out.push(merged);
  }
  return out;
}

/** Keep a loaded mask's numbers usable: finite, ordered, and not negative. */
export function normalizeMasks(masks: readonly ModifierMask[]): ModifierMask[] {
  const out: ModifierMask[] = [];
  const number = (value: unknown, fallback: number) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  for (const raw of masks ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.kind === 'attribute') {
      const attributeClass =
        raw.attributeClass === 'edge' || raw.attributeClass === 'piece'
          ? raw.attributeClass
          : 'point';
      out.push({
        kind: 'attribute',
        attributeClass,
        name: typeof raw.name === 'string' ? raw.name : '',
        min: number(raw.min, 0),
        max: number(raw.max, 1),
      });
      continue;
    }
    if (raw.kind === 'point' || raw.kind === 'piece') {
      const min = number(raw.min, raw.kind === 'piece' ? 1 : 0);
      const max = number(raw.max, 999);
      out.push({
        kind: raw.kind,
        min: Math.min(min, max),
        max: Math.max(min, max),
        falloff: Math.max(0, number(raw.falloff, 0)),
      });
    }
  }
  return out;
}
