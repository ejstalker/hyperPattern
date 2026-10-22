import { describe, expect, it } from 'vitest';
import { buildObj, objFileName, OBJ_METRES_PER_WORLD } from './objExport';

describe('buildObj', () => {
  it('writes vertices and faces of one part', () => {
    const obj = buildObj([
      { name: 'cloth', positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] },
    ]);
    expect(obj).toContain('o cloth');
    expect(obj).toContain('v 0 0 0');
    expect(obj).toContain(`v ${10 * OBJ_METRES_PER_WORLD} 0 0`);
    expect(obj).toContain('f 1 2 3');
  });

  it('rebases each part’s indices onto the whole file and counts from one', () => {
    const obj = buildObj([
      { name: 'a', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
      { name: 'b', positions: [2, 0, 0, 3, 0, 0, 2, 1, 0], indices: [0, 1, 2] },
    ]);
    expect(obj).toContain('f 1 2 3');
    expect(obj).toContain('f 4 5 6');
  });

  it('scales coordinates by metres per world unit', () => {
    const obj = buildObj([{ name: 'm', positions: [16.6, 0, 0], indices: [] }], 0.1);
    expect(obj).toContain('v 1.66 0 0');
  });

  it('keeps whole numbers whole and never writes a negative zero', () => {
    const obj = buildObj([{ name: 'm', positions: [12, -0.0000001, -1], indices: [] }], 1);
    expect(obj).toContain('v 12 0 -1');
  });

  it('drops faces that point past their own vertices', () => {
    const obj = buildObj([
      { name: 'm', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2, 0, 1, 9] },
    ]);
    expect(obj.match(/^f /gm)).toHaveLength(1);
  });

  it('skips empty parts and names objects as single words', () => {
    const obj = buildObj([
      { name: 'cloth piece 1', positions: [0, 0, 0], indices: [] },
      { name: 'empty', positions: [], indices: [] },
    ]);
    expect(obj).toContain('o cloth_piece_1');
    expect(obj).not.toContain('empty');
  });
});

describe('objFileName', () => {
  it('builds a safe file name from the scene name', () => {
    expect(objFileName('Drape 6')).toBe('Drape-6.obj');
    expect(objFileName('a/b:c')).toBe('a-b-c.obj');
  });

  it('falls back to drape when there is nothing usable', () => {
    expect(objFileName('   ')).toBe('drape.obj');
    expect(objFileName('///')).toBe('drape.obj');
  });
});
