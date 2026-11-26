import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_FABRIC_LIBRARY,
  FabricLibrary,
  fabricColorHex,
  materialForVariant,
  normalizeFabricLibrary,
} from './library';

describe('fabric library', () => {
  beforeEach(() => localStorage.clear());

  it('opens with silk, linen and wool, each with variants', () => {
    const library = new FabricLibrary(DEFAULT_FABRIC_LIBRARY);
    expect(library.types.map((type) => type.name)).toEqual(['Silk', 'Linen', 'Wool']);
    for (const type of library.types) {
      expect(library.variantsOf(type.id).length).toBeGreaterThan(0);
    }
    expect(library.variants.every((variant) => library.typeById(variant.typeId))).toBe(true);
  });

  it('takes physics from the type and looks from the variant', () => {
    const library = new FabricLibrary(DEFAULT_FABRIC_LIBRARY);
    const silk = library.types.find((type) => type.id === 'silk')!;
    const piece = { fabricId: 'silk-ivory' };
    expect(library.physicsForPiece(piece)).toEqual(silk.physics);
    const material = library.materialForPiece(piece)!;
    expect(material.roughness).toBe(0.28);
    expect(material.metallic).toBe(0);
    expect(library.physicsForPiece({ fabricId: 'missing' })).toBeNull();
  });

  it('clamps unreadable multipliers and drops orphaned variants', () => {
    const library = normalizeFabricLibrary({
      types: [
        {
          id: 'a',
          name: 'A',
          physics: { weight: -4, stiffness: 9999, bend: Number.NaN },
        },
      ],
      variants: [
        { id: 'v1', typeId: 'a', name: 'One', color: [2, -1, 0.5], roughness: 4, metallic: -2 },
        {
          id: 'v2',
          typeId: 'gone',
          name: 'Two',
          color: [0, 0, 0],
          roughness: 0.5,
          metallic: 0,
        },
      ],
    });
    expect(library.types[0]!.physics.weight).toBe(0.05);
    expect(library.types[0]!.physics.stiffness).toBe(20);
    expect(library.types[0]!.physics.bend).toBe(1);
    expect(library.variants.map((variant) => variant.id)).toEqual(['v1']);
    expect(library.variants[0]!.color).toEqual([1, 0, 0.5]);
    expect(library.variants[0]!.roughness).toBe(1);
    expect(library.variants[0]!.metallic).toBe(0);
  });

  it('duplicates a type with its variants and removes both together', () => {
    const library = new FabricLibrary(DEFAULT_FABRIC_LIBRARY);
    const copy = library.duplicateType('silk')!;
    expect(library.variantsOf(copy.id)).toHaveLength(2);
    expect(library.variantsOf(copy.id).every((variant) => variant.typeId === copy.id)).toBe(true);
    expect(library.removeType(copy.id)).toBe(true);
    expect(library.variants.some((variant) => variant.typeId === copy.id)).toBe(false);
  });

  it('does not invent orphans when a custom type has no variants yet', () => {
    const library = normalizeFabricLibrary({
      types: [{ id: 'custom', name: 'Custom', physics: { weight: 1, stiffness: 1, bend: 1 } }],
      variants: [],
    });
    expect(library.variants).toEqual([]);
  });

  it('keeps the last type, so pieces always have somewhere to point', () => {
    const library = new FabricLibrary({ types: [DEFAULT_FABRIC_LIBRARY.types[0]!], variants: [] });
    expect(library.removeType('silk')).toBe(false);
  });

  it('stores variants and their image through updateVariant', () => {
    const library = new FabricLibrary(DEFAULT_FABRIC_LIBRARY);
    library.updateVariant('wool-camel', {
      name: 'Camel 2',
      albedoImage: 'data:image/png;base64,AAAA',
      albedoImageName: 'camel.png',
    });
    const variant = library.variantById('wool-camel')!;
    expect(variant.name).toBe('Camel 2');
    expect(variant.albedoImageName).toBe('camel.png');
    expect(materialForVariant(variant).albedoImage).toContain('data:image/png');
    library.updateVariant('wool-camel', { albedoImage: '', albedoImageName: '' });
    expect(library.variantById('wool-camel')!.albedoImage).toBeUndefined();
  });

  it('marks only physics edits for a cloth re-bake', () => {
    const library = new FabricLibrary(DEFAULT_FABRIC_LIBRARY);
    const before = library.physicsRevision;
    library.updateVariant('silk-ivory', { color: [0.1, 0.2, 0.3] });
    expect(library.physicsRevision).toBe(before);
    library.updateType('silk', { physics: { weight: 1.2, stiffness: 1, bend: 1 } });
    expect(library.physicsRevision).toBe(before + 1);
    library.removeVariant('silk-ivory');
    expect(library.physicsRevision).toBe(before + 2);
  });

  it('round-trips colour through the picker hex', () => {
    const hex = fabricColorHex([0.9, 0.01, 0.01]);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    const library = new FabricLibrary(DEFAULT_FABRIC_LIBRARY);
    library.updateVariant('silk-ivory', { color: [0.9, 0.01, 0.01] });
    expect(fabricColorHex(library.variantById('silk-ivory')!.color)).toBe(hex);
  });
});
