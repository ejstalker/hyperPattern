import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { blenderPackFileName, buildBlenderPack, buildBlenderSeams, type BlenderPackInput } from './blenderPack';
import { BLENDER_IMPORT_PY } from './blenderImportPy';

/**
 * A 2×1 quad split into two pieces: vertices 0,1 belong to `front`, 2,3 to
 * `back`. World units, y up, laid out flat in XZ like the studio's layout.
 */
function input(overrides: Partial<BlenderPackInput> = {}): BlenderPackInput {
  return {
    projectName: 'Test project',
    drapeName: 'Drape 6',
    patternName: 'Pattern',
    meshName: 'Mesh 1',
    cloth: {
      positions: [0, 4, 0, 1, 4, 0, 2, 4, 0, 3, 4, 0],
      indices: [0, 1, 3, 0, 3, 2],
      pieceIds: ['front', 'front', 'back', 'back'],
    },
    avatar: {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    },
    seams: [{ i: 1, j: 2, restMetres: 0.0015, gatherI: 0.7 }],
    pins: [0, 1],
    pieceNames: { front: 'Front', back: 'Back' },
    sim: { substeps: 8, mass: 100, contactFriction: 0.45 },
    ...overrides,
  };
}

describe('buildBlenderSeams', () => {
  it('describes the pack: metres, 0-based indices, fabric and easing', () => {
    const json = buildBlenderSeams(input()) as Record<string, never> & {
      format: string;
      indexBase: number;
      units: string;
      seams: Array<Record<string, number>>;
      pins: number[];
      pieces: Array<{ name: string; vertices: [number, number] }>;
      fabric: { vertexMassKg: number; quality: number };
      collider: { distanceMetres: number };
    };
    expect(json.format).toBe('hyperpattern.blender-pack');
    expect(json.indexBase).toBe(0);
    expect(json.units).toBe('metres');
    expect(json.seams[0]).toMatchObject({ i: 1, j: 2, gatherI: 0.7 });
    // 1.5 mm in, 1.5 mm out: the map is in metres.
    expect(json.seams[0]!.restGapMetres).toBeCloseTo(0.0015, 6);
    expect(json.pins).toEqual([0, 1]);
    expect(json.pieces).toEqual([
      { name: 'Front', id: 'front', vertices: [0, 2] },
      { name: 'Back', id: 'back', vertices: [2, 2] },
    ]);
    expect(json.fabric.quality).toBe(8);
    expect(json.fabric.vertexMassKg).toBeGreaterThan(0);
    expect(json.collider.distanceMetres).toBeGreaterThan(0);
  });

  it('drops ghosted pieces and remaps everything that pointed at them', () => {
    const json = buildBlenderSeams(input({ excludePieces: ['front'] })) as unknown as {
      seams: Array<{ i: number; j: number }>;
      pins: number[];
      cloth: { vertices: number };
    };
    // Both pins were on the dropped piece, so they go with it, and a seam with
    // one end gone cannot be sewn.
    expect(json.cloth.vertices).toBe(2);
    expect(json.seams).toHaveLength(0);
    expect(json.pins).toEqual([]);
  });

  it('remaps seam and pin indices onto the kept vertices', () => {
    const json = buildBlenderSeams(input({ excludePieces: ['back'] })) as unknown as {
      seams: Array<{ i: number; j: number }>;
      pins: number[];
    };
    expect(json.seams).toHaveLength(0);
    expect(json.pins).toEqual([0, 1]);
  });
});

describe('buildBlenderPack', () => {
  it('zips the meshes, the seam map, the agent notes, the script and a readme', () => {
    const pack = buildBlenderPack(input());
    const files = Object.keys(unzipSync(pack.zip)).sort();
    expect(files).toEqual([
      'AGENTS.md',
      'README.txt',
      'avatar.obj',
      'cloth.obj',
      'import_hyperpattern.py',
      'seams.json',
    ]);
    expect(pack.summary).toMatchObject({ vertices: 4, triangles: 2, seams: 1, pins: 2 });
    expect(strFromU8(unzipSync(pack.zip)['import_hyperpattern.py']!)).toBe(BLENDER_IMPORT_PY);
  });

  it('quotes the same counts in AGENTS.md that it wrote to the seam map', () => {
    const pack = buildBlenderPack(input());
    const json = JSON.parse(strFromU8(unzipSync(pack.zip)['seams.json']!));
    const md = strFromU8(unzipSync(pack.zip)['AGENTS.md']!);
    expect(md).toContain('# Building this garment in Blender');
    expect(md).toContain(`${json.cloth.vertices} vertices, ${json.cloth.triangles} triangles`);
    expect(md).toContain(`${json.seams.length} (1 of them gathered)`);
    expect(md).toContain(String(json.pins.length));
    expect(strFromU8(unzipSync(pack.zip)['README.txt']!)).toContain('AGENTS.md');
  });

  it('writes the cloth in metres, wound as the mesher wound it', () => {
    const pack = buildBlenderPack(input());
    const obj = strFromU8(unzipSync(pack.zip)['cloth.obj']!);
    expect(obj).toContain('v 0 0.4 0');
    expect(obj).toContain('f 1 2 4');
    expect(obj).toContain('f 1 4 3');
  });

  it('leaves the avatar out when the drape has none', () => {
    const pack = buildBlenderPack(input({ avatar: null }));
    expect(Object.keys(unzipSync(pack.zip))).not.toContain('avatar.obj');
    expect(strFromU8(unzipSync(pack.zip)['README.txt']!)).toContain('not included');
  });

  it('parses the seam map back out of the zip', () => {
    const pack = buildBlenderPack(input());
    const json = JSON.parse(strFromU8(unzipSync(pack.zip)['seams.json']!));
    expect(json.scene).toMatchObject({ project: 'Test project', drape: 'Drape 6' });
    expect(json.cloth).toMatchObject({ object: 'cloth.obj', vertices: 4, triangles: 2 });
    expect(json.seams).toHaveLength(1);
  });
});

describe('blenderPackFileName', () => {
  it('names the zip after the drape', () => {
    expect(blenderPackFileName('Drape 6')).toBe('Drape-6-blender.zip');
    expect(blenderPackFileName('  ')).toBe('drape-blender.zip');
  });
});
