import { strToU8, zipSync } from 'fflate';
import { BLENDER_IMPORT_PY } from './blenderImportPy';
import { buildObj, OBJ_METRES_PER_WORLD, type ObjPart } from './objExport';
import { buildBlenderAgentsMd, type PackAgentsFacts } from './packAgentsMd';

/**
 * The Blender pack: everything needed to drape the garment in Blender, in one
 * zip.
 *
 * A `.blend` written from here would be a memory image of a Blender session —
 * binary DNA, version-specific and impossible to keep working. A small zip of
 * plain data plus a `bpy` script does the same job through Blender's own API,
 * and can be read, diffed and fixed by hand when something is off.
 *
 * The pack uses the *rest* layout rather than the pose on screen: Blender takes
 * the first frame as the fabric's rest shape, so it wants the garment laid out
 * flat with the seams waiting to close, exactly like the drape's rebuilt state.
 */

/** How many metres a studio world unit is (1 unit = 10 cm). */
const METRES_PER_WORLD = OBJ_METRES_PER_WORLD;

/** Mid-weight cotton, in kg per square metre — the pack's assumed fabric. */
const FABRIC_KG_PER_M2 = 0.25;
/** The studio's `mass` parameter reads as "100 = the reference drape". */
const REFERENCE_MASS = 100;

export type BlenderPackSeam = {
  /** Cloth vertex indices, 0-based, as they appear in the pack. */
  i: number;
  j: number;
  /** Target distance the stitch wants between the two rows, in metres. */
  restMetres: number;
  /**
   * Share of its rest length the row through `i` may compress to — the studio's
   * crowd floor for the gathered side. Absent means the row is inextensible.
   */
  gatherI?: number;
  gatherJ?: number;
};

export type BlenderPackInput = {
  projectName: string;
  drapeName: string;
  patternName: string;
  meshName: string;
  /** Cloth mesh in the flat layout, world units. */
  cloth: {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
    /** Parallel to `positions`: owning piece id per vertex. */
    pieceIds: readonly string[];
  };
  /** Body mesh; absent when the drape has no avatar loaded yet. */
  avatar: { positions: ArrayLike<number>; indices: ArrayLike<number> } | null;
  seams: readonly BlenderPackSeam[];
  /** Frozen pieces are pinned: they hold while the rest drapes. */
  pins: readonly number[];
  pieceNames: Record<string, string>;
  /** Pieces taken out of the sim: their vertices are left out of the pack. */
  excludePieces?: readonly string[];
  sim: {
    substeps: number;
    constraintIterations?: number;
    mass: number;
    contactFriction?: number;
    gravity?: number;
    maxSpeed?: number;
    engine?: string;
  };
};

export type BlenderPack = {
  /** The zip itself, ready to hand to the browser. */
  zip: Uint8Array;
  files: Record<string, Uint8Array>;
  /** What the zip ended up with, for the status line. */
  summary: { vertices: number; triangles: number; seams: number; pins: number; bytes: number };
};
/** File names inside the pack. */
const CLOTH_OBJ = 'cloth.obj';
const AVATAR_OBJ = 'avatar.obj';
const SEAMS_JSON = 'seams.json';
const IMPORT_PY = 'import_hyperpattern.py';
const README = 'README.txt';
const AGENTS = 'AGENTS.md';

/** Cloth mesh with the ghosted pieces dropped and every index remapped. */
function filterCloth(cloth: BlenderPackInput['cloth'], exclude: readonly string[]) {
  const count = Math.floor(cloth.positions.length / 3);
  const dropped = new Set(exclude);
  const remap = new Int32Array(count).fill(-1);
  const kept: number[] = [];
  for (let i = 0; i < count; i++) {
    if (dropped.has(cloth.pieceIds[i] ?? '')) continue;
    remap[i] = kept.length;
    kept.push(i);
  }
  const positions = new Float32Array(kept.length * 3);
  for (let n = 0; n < kept.length; n++) {
    const from = kept[n]!;
    positions[n * 3] = cloth.positions[from * 3]!;
    positions[n * 3 + 1] = cloth.positions[from * 3 + 1]!;
    positions[n * 3 + 2] = cloth.positions[from * 3 + 2]!;
  }
  const indices: number[] = [];
  for (let t = 0; t + 2 < cloth.indices.length; t += 3) {
    const a = remap[cloth.indices[t]!]!;
    const b = remap[cloth.indices[t + 1]!]!;
    const c = remap[cloth.indices[t + 2]!]!;
    if (a < 0 || b < 0 || c < 0) continue;
    indices.push(a, b, c);
  }
  const pieceIds = kept.map((i) => cloth.pieceIds[i] ?? 'piece');
  const remapSeam = (index: number): number => (index < count ? remap[index]! : -1);
  return { positions, indices, pieceIds, remapSeam };
}

/** Contiguous runs of vertices per piece, for named vertex groups in Blender. */
function pieceRuns(pieceIds: readonly string[]): Array<{ id: string; start: number; count: number }> {
  const runs: Array<{ id: string; start: number; count: number }> = [];
  for (let i = 0; i < pieceIds.length; i++) {
    const id = pieceIds[i]!;
    const last = runs[runs.length - 1];
    if (last && last.id === id && last.start + last.count === i) last.count += 1;
    else runs.push({ id, start: i, count: 1 });
  }
  return runs;
}

/** Surface area of the filtered mesh, in square metres. */
function surfaceAreaM2(positions: Float32Array, indices: readonly number[]): number {
  let area = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    area += Math.hypot(cx, cy, cz) * 0.5 * METRES_PER_WORLD * METRES_PER_WORLD;
  }
  return area;
}

/**
 * The seam map the import script reads.
 *
 * Everything is in metres and 0-based against `cloth.obj`, which is stated in
 * the file so a hand-written importer cannot get it wrong.
 */
export function buildBlenderSeams(input: BlenderPackInput): Record<string, unknown> {
  const { positions, indices, pieceIds, remapSeam } = filterCloth(
    input.cloth,
    input.excludePieces ?? []
  );
  const seams: Array<Record<string, unknown>> = [];
  for (const seam of input.seams) {
    const i = remapSeam(seam.i);
    const j = remapSeam(seam.j);
    if (i < 0 || j < 0) continue;
    const entry: Record<string, unknown> = {
      i,
      j,
      // Already metres by the input's contract; the mesh alone is in world units.
      restGapMetres: round(seam.restMetres, 6),
    };
    if (seam.gatherI !== undefined) entry.gatherI = round(seam.gatherI, 4);
    if (seam.gatherJ !== undefined) entry.gatherJ = round(seam.gatherJ, 4);
    seams.push(entry);
  }

  const pins: number[] = [];
  for (const pin of input.pins) {
    const mapped = remapSeam(pin);
    if (mapped >= 0) pins.push(mapped);
  }

  const runs = pieceRuns(pieceIds);
  const area = surfaceAreaM2(positions, indices);
  const vertexCount = Math.max(1, Math.floor(positions.length / 3));
  const massScale = Math.max(0.05, input.sim.mass / REFERENCE_MASS);
  const totalKg = Math.max(0.01, area * FABRIC_KG_PER_M2 * massScale);

  const edgeWorld = meanEdgeLength(positions, indices);
  const colliderDistance = Math.max(0.004, 0.5 * edgeWorld * METRES_PER_WORLD);
  const selfDistance = Math.max(0.003, 0.5 * edgeWorld * METRES_PER_WORLD);

  return {
    format: 'hyperpattern.blender-pack',
    version: 1,
    units: 'metres',
    indexBase: 0,
    scene: {
      project: input.projectName,
      drape: input.drapeName,
      pattern: input.patternName,
      mesh: input.meshName,
    },
    cloth: {
      object: CLOTH_OBJ,
      vertices: vertexCount,
      triangles: Math.floor(indices.length / 3),
      pose: 'flat layout — the drape has not been simulated',
      surfaceAreaM2: round(area, 4),
    },
    collider: {
      object: input.avatar ? AVATAR_OBJ : null,
      triangles: input.avatar ? Math.floor(input.avatar.indices.length / 3) : 0,
      distanceMetres: round(colliderDistance, 5),
      selfDistanceMetres: round(selfDistance, 5),
    },
    fabric: {
      vertexMassKg: round(totalKg / vertexCount, 6),
      totalMassKg: round(totalKg, 4),
      quality: Math.max(1, Math.min(20, Math.round(input.sim.substeps))),
      // Starting points, not a port: Blender's cloth is a different model.
      tensionStiffness: 40,
      compressionStiffness: 40,
      shearStiffness: 10,
      bendingStiffness: 2,
      airDamping: 1,
      sewingForceMax: 1000,
      friction: round(clamp01(input.sim.contactFriction ?? 0.45), 3),
    },
    seams,
    pins,
    pieces: runs.map((run) => ({
      name: input.pieceNames[run.id] ?? run.id,
      id: run.id,
      vertices: [run.start, run.count],
    })),
    sim: { ...input.sim },
    notes: [
      'Seam rows must stay separate: Blender sews open edges, so do not merge by distance.',
      'Press Play to drape, then Bake in the Cloth cache panel to keep the result.',
      'The studio solves XPBD with a velocity clamp; Blender does not, so motion will differ.',
    ],
  };
}

/** Human-readable guide to what is in the zip and how to use it. */
export function buildBlenderReadme(input: BlenderPackInput): string {
  return `hyperPattern — Blender pack
===========================

${input.drapeName} from project "${input.projectName}"

Files
-----
cloth.obj              the garment in its flat layout, in metres, wound outward
avatar.obj             ${input.avatar ? 'the body it drapes over, in metres' : 'not included: this drape has no avatar loaded'}
seams.json             seam pairs, gathered rows, pins and fabric settings
import_hyperpattern.py the script that builds the setup in Blender
AGENTS.md              the same pack written as instructions for an AI agent

How to use it
-------------
1. Unzip this folder anywhere.
2. In Blender: Scripting workspace > Open > import_hyperpattern.py > Run Script.
   (Blender 3.6 and 4.x are both handled; the script checks what it can set.)
3. Play the timeline to drape, then Bake in the Cloth cache panel.

AGENTS.md is for a coding agent driving Blender (for example over an MCP server):
it lists the counts to expect, the order to do things in, the checks that prove
the build worked, and the steps that would quietly ruin the garment. It only gets
read once this folder is unpacked and the agent is working inside it.

The cloth is exported in its *layout* pose, not the pose on screen: Blender takes
frame 1 as the fabric's rest shape, so it wants the garment laid out flat with
its seams still open. For an OBJ of what the viewport currently shows, use the
plain OBJ button in the studio.

What maps to what
-----------------
seam pairs            open boundary edges, sewn by proximity (sewing springs on)
gathered row          shrink vertex group + shrink range
frozen piece          pin vertex group
ghosted piece         left out of the pack entirely
body                  collision modifier, ${input.avatar ? 'distance set from the studio margin' : 'not applicable'}

The two solvers are not the same. The studio runs XPBD with per-substep contact
and a velocity clamp; Blender uses angular bending and impulse-clamped
collisions. Same garment, plausible drape, not the same numbers.

Generated by hyperPattern.
`;
}

/** The slice of the shipped seam map that AGENTS.md quotes. */
type PackSeamsJson = {
  cloth: { vertices: number; triangles: number };
  collider: { triangles: number; distanceMetres: number };
  fabric: { vertexMassKg: number; sewingForceMax: number; friction: number; quality: number };
  seams: Array<{ gatherI?: number; gatherJ?: number }>;
  pins: unknown[];
  pieces: unknown[];
};

/** The counts AGENTS.md quotes, straight out of the map that ships beside it. */
function agentsFacts(input: BlenderPackInput, raw: Record<string, unknown>): PackAgentsFacts {
  const seamsJson = raw as unknown as PackSeamsJson;
  return {
    scene: {
      project: input.projectName,
      drape: input.drapeName,
      pattern: input.patternName,
      mesh: input.meshName,
    },
    cloth: { vertices: seamsJson.cloth.vertices, triangles: seamsJson.cloth.triangles },
    bodyTriangles: seamsJson.collider.triangles,
    seams: {
      total: seamsJson.seams.length,
      gathered: seamsJson.seams.filter((seam) => seam.gatherI !== undefined || seam.gatherJ !== undefined)
        .length,
    },
    pins: seamsJson.pins.length,
    pieces: seamsJson.pieces.length,
    collider: { distanceMetres: seamsJson.collider.distanceMetres },
    fabric: {
      vertexMassKg: seamsJson.fabric.vertexMassKg,
      sewingForceMax: seamsJson.fabric.sewingForceMax,
      friction: seamsJson.fabric.friction,
      quality: seamsJson.fabric.quality,
    },
    substeps: input.sim.substeps,
  };
}

/** Assemble and zip the pack. */
export function buildBlenderPack(input: BlenderPackInput): BlenderPack {
  const { positions, indices } = filterCloth(input.cloth, input.excludePieces ?? []);
  const seamsJson = buildBlenderSeams(input);

  const clothPart: ObjPart = { name: 'cloth', positions, indices };
  const files: Record<string, Uint8Array> = {
    [CLOTH_OBJ]: strToU8(buildObj([clothPart])),
    [SEAMS_JSON]: strToU8(`${JSON.stringify(seamsJson, null, 2)}\n`),
    [IMPORT_PY]: strToU8(BLENDER_IMPORT_PY),
    [AGENTS]: strToU8(buildBlenderAgentsMd(agentsFacts(input, seamsJson))),
    [README]: strToU8(buildBlenderReadme(input)),
  };
  if (input.avatar) {
    files[AVATAR_OBJ] = strToU8(
      buildObj([{ name: 'avatar', positions: input.avatar.positions, indices: input.avatar.indices }])
    );
  }

  const zip = zipSync(files, { level: 6 });
  return {
    zip,
    files,
    summary: {
      vertices: Math.floor(positions.length / 3),
      triangles: Math.floor(indices.length / 3),
      seams: (seamsJson.seams as unknown[]).length,
      pins: (seamsJson.pins as unknown[]).length,
      bytes: zip.byteLength,
    },
  };
}

/** `Drape 6` → `Drape-6-blender.zip`. */
export function blenderPackFileName(sceneName: string): string {
  const base = sceneName
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base.length ? base : 'drape'}-blender.zip`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Mean edge length of the triangulation, in world units. */
function meanEdgeLength(positions: Float32Array, indices: readonly number[]): number {
  let total = 0;
  let count = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]! * 3;
      const b = indices[t + ((k + 1) % 3)]! * 3;
      total += Math.hypot(
        positions[b]! - positions[a]!,
        positions[b + 1]! - positions[a + 1]!,
        positions[b + 2]! - positions[a + 2]!
      );
      count += 1;
    }
  }
  return count > 0 ? total / count : 0.14;
}
