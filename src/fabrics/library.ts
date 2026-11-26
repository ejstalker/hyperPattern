/**
 * The global fabric library.
 *
 * A fabric type is the physics — how heavy it is, how hard it is to stretch and
 * how much it resists folding. Its variants are the looks: a colour, PBR
 * roughness/metallic and an optional albedo texture. Pieces carry a variant id,
 * so two pieces can share the wool type while one is charcoal and the other
 * camel, and every piece made of wool still drapes like wool.
 *
 * The library lives in localStorage beside the scene materials: it belongs to
 * the studio, not to one project, so a fabric defined once is available in every
 * pattern opened afterwards.
 */
import { clamp01, clampColor, hexToLinear, type MaterialParams } from '../render/materials';
import { uid } from '../project/createDefault';

export type FabricPhysics = {
  /** Particle mass multiplier: 1 is the drape's own mass. */
  weight: number;
  /** Stretch spring multiplier. */
  stiffness: number;
  /** Fold / bend resistance multiplier. */
  bend: number;
};

export type FabricType = {
  id: string;
  name: string;
  physics: FabricPhysics;
};

export type FabricVariant = {
  id: string;
  /** The type this variant belongs to. */
  typeId: string;
  name: string;
  /** Linear RGB, 0..1 — the same space the PBR shader works in. */
  color: [number, number, number];
  roughness: number;
  metallic: number;
  /** Albedo image as a data URL, and the file name for the library UI. */
  albedoImage?: string;
  albedoImageName?: string;
};

export type FabricLibraryData = {
  types: FabricType[];
  variants: FabricVariant[];
};

const SETTINGS_KEY = 'patternCanvas.fabrics';
/** Multipliers outside this range stop reading as cloth. */
const MIN_MULTIPLIER = 0.05;
const MAX_MULTIPLIER = 20;

function multiplier(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, value));
}

function normalizePhysics(
  value: Partial<FabricPhysics> | undefined,
  fallback?: FabricPhysics
): FabricPhysics {
  const base = fallback ?? { weight: 1, stiffness: 1, bend: 1 };
  return {
    weight: multiplier(value?.weight, base.weight),
    stiffness: multiplier(value?.stiffness, base.stiffness),
    bend: multiplier(value?.bend, base.bend),
  };
}

function clonePhysics(physics: FabricPhysics): FabricPhysics {
  return {
    weight: multiplier(physics.weight, 1),
    stiffness: multiplier(physics.stiffness, 1),
    bend: multiplier(physics.bend, 1),
  };
}

/** sRGB hex for a picker, from the linear colour the shader uses. */
export function fabricColorHex(color: [number, number, number]): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) ** (1 / 2.2) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

export function fabricColorFromHex(hex: string): [number, number, number] {
  return hexToLinear(hex);
}

/** The six looks the studio opens with, three types with two children each. */
export const DEFAULT_FABRIC_LIBRARY: FabricLibraryData = {
  types: [
    { id: 'silk', name: 'Silk', physics: { weight: 0.45, stiffness: 0.7, bend: 0.35 } },
    { id: 'linen', name: 'Linen', physics: { weight: 0.9, stiffness: 1.15, bend: 1.1 } },
    { id: 'wool', name: 'Wool', physics: { weight: 1.45, stiffness: 1.05, bend: 1.6 } },
  ],
  variants: [
    {
      id: 'silk-ivory',
      typeId: 'silk',
      name: 'Ivory silk',
      color: hexToLinear('#f2e9d8'),
      roughness: 0.28,
      metallic: 0,
    },
    {
      id: 'silk-midnight',
      typeId: 'silk',
      name: 'Midnight silk',
      color: hexToLinear('#1d2542'),
      roughness: 0.22,
      metallic: 0,
    },
    {
      id: 'linen-natural',
      typeId: 'linen',
      name: 'Natural linen',
      color: hexToLinear('#c9b795'),
      roughness: 0.85,
      metallic: 0,
    },
    {
      id: 'linen-slate',
      typeId: 'linen',
      name: 'Slate linen',
      color: hexToLinear('#6e7480'),
      roughness: 0.82,
      metallic: 0,
    },
    {
      id: 'wool-charcoal',
      typeId: 'wool',
      name: 'Charcoal wool',
      color: hexToLinear('#3b3a3f'),
      roughness: 0.95,
      metallic: 0,
    },
    {
      id: 'wool-camel',
      typeId: 'wool',
      name: 'Camel wool',
      color: hexToLinear('#b3855a'),
      roughness: 0.92,
      metallic: 0,
    },
  ],
};

export function normalizeFabricType(
  value: Partial<FabricType> | undefined,
  fallback?: FabricType
): FabricType {
  return {
    id: typeof value?.id === 'string' && value.id ? value.id : fallback?.id ?? uid('fabric'),
    name:
      typeof value?.name === 'string' && value.name.trim()
        ? value.name
        : fallback?.name ?? 'Fabric',
    physics: normalizePhysics(value?.physics, fallback?.physics),
  };
}

export function normalizeFabricVariant(
  value: Partial<FabricVariant> | undefined,
  fallback?: FabricVariant
): FabricVariant {
  const variant: FabricVariant = {
    id: typeof value?.id === 'string' && value.id ? value.id : fallback?.id ?? uid('fabric-variant'),
    typeId:
      typeof value?.typeId === 'string' && value.typeId
        ? value.typeId
        : fallback?.typeId ?? 'silk',
    name:
      typeof value?.name === 'string' && value.name.trim()
        ? value.name
        : fallback?.name ?? 'Fabric',
    color: clampColor(value?.color, fallback?.color ?? [0.8, 0.8, 0.8]),
    roughness: clamp01(value?.roughness as number, fallback?.roughness ?? 0.8),
    metallic: clamp01(value?.metallic as number, fallback?.metallic ?? 0),
  };
  if (typeof value?.albedoImage === 'string' && value.albedoImage.length > 0) {
    variant.albedoImage = value.albedoImage;
    if (typeof value.albedoImageName === 'string' && value.albedoImageName.length > 0) {
      variant.albedoImageName = value.albedoImageName;
    }
  }
  return variant;
}

export function normalizeFabricLibrary(
  value: Partial<FabricLibraryData> | undefined
): FabricLibraryData {
  const rawTypes = Array.isArray(value?.types) ? value.types : [];
  const types = rawTypes
    .filter((entry): entry is FabricType => !!entry && typeof entry === 'object')
    .map((entry) => normalizeFabricType(entry));
  if (types.length === 0) {
    for (const entry of DEFAULT_FABRIC_LIBRARY.types) types.push(normalizeFabricType(entry));
  }
  const typeIds = new Set(types.map((type) => type.id));
  const rawVariants = Array.isArray(value?.variants) ? value.variants : [];
  const variants = rawVariants
    .filter((entry): entry is FabricVariant => !!entry && typeof entry === 'object')
    .map((entry) => normalizeFabricVariant(entry))
    .filter((variant) => typeIds.has(variant.typeId));
  return { types, variants };
}

/** The material settings a variant hands the renderer. */
export function materialForVariant(variant: FabricVariant): MaterialParams {
  return {
    color: [...variant.color],
    roughness: variant.roughness,
    metallic: variant.metallic,
    albedoImage: variant.albedoImage,
    albedoImageName: variant.albedoImageName,
  };
}

/**
 * One library, shared by the editors, the viewports and the renderer.
 *
 * Editing it saves the studio's fabrics immediately; `revision` lets a viewport
 * know the look changed without diffing the whole library every frame.
 */
export class FabricLibrary {
  types: FabricType[] = [];
  variants: FabricVariant[] = [];
  /** Bumped when a type's physics changed, so cloths need re-baking. */
  physicsRevision = 0;

  constructor(data?: Partial<FabricLibraryData>) {
    this.replace(data ?? DEFAULT_FABRIC_LIBRARY);
  }

  private replace(data: Partial<FabricLibraryData>): void {
    const normalized = normalizeFabricLibrary(data);
    this.types = normalized.types;
    this.variants = normalized.variants;
  }

  toJSON(): FabricLibraryData {
    return { types: this.types, variants: this.variants };
  }

  typeById(id: string | null | undefined): FabricType | null {
    if (!id) return null;
    return this.types.find((type) => type.id === id) ?? null;
  }

  variantsOf(typeId: string): FabricVariant[] {
    return this.variants.filter((variant) => variant.typeId === typeId);
  }

  variantById(id: string | null | undefined): FabricVariant | null {
    if (!id) return null;
    return this.variants.find((variant) => variant.id === id) ?? null;
  }

  physicsForVariant(id: string | null | undefined): FabricPhysics | null {
    const variant = this.variantById(id);
    if (!variant) return null;
    const type = this.typeById(variant.typeId);
    return type ? clonePhysics(type.physics) : null;
  }

  physicsForPiece(piece: { fabricId?: string | null } | null | undefined): FabricPhysics | null {
    return piece ? this.physicsForVariant(piece.fabricId) : null;
  }

  materialForPiece(
    piece: { fabricId?: string | null } | null | undefined
  ): MaterialParams | null {
    const variant = this.variantById(piece?.fabricId);
    return variant ? materialForVariant(variant) : null;
  }

  hasVariant(id: string | null | undefined): boolean {
    return !!this.variantById(id);
  }

  addType(name = 'New fabric'): FabricType {
    const type: FabricType = {
      id: uid('fabric'),
      name,
      physics: { weight: 1, stiffness: 1, bend: 1 },
    };
    this.types.push(type);
    this.touch(true);
    return type;
  }

  duplicateType(id: string): FabricType | null {
    const source = this.typeById(id);
    if (!source) return null;
    const copy: FabricType = {
      id: uid('fabric'),
      name: `${source.name} copy`,
      physics: clonePhysics(source.physics),
    };
    this.types.splice(this.types.indexOf(source) + 1, 0, copy);
    for (const variant of this.variantsOf(source.id)) {
      this.variants.push({
        ...variant,
        id: uid('fabric-variant'),
        typeId: copy.id,
        name: variant.name,
        color: [...variant.color],
      });
    }
    this.touch(true);
    return copy;
  }

  removeType(id: string): boolean {
    if (this.types.length <= 1) return false;
    const index = this.types.findIndex((type) => type.id === id);
    if (index < 0) return false;
    this.types.splice(index, 1);
    this.variants = this.variants.filter((variant) => variant.typeId !== id);
    this.touch(true);
    return true;
  }

  updateType(id: string, patch: Partial<Omit<FabricType, 'id'>>): FabricType | null {
    const type = this.typeById(id);
    if (!type) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) type.name = patch.name;
    if (patch.physics) {
      type.physics = normalizePhysics(patch.physics, type.physics);
      this.touch(true);
    } else {
      this.touch();
    }
    return type;
  }

  addVariant(typeId: string, name = 'New colour'): FabricVariant | null {
    const type = this.typeById(typeId);
    if (!type) return null;
    const variant: FabricVariant = {
      id: uid('fabric-variant'),
      typeId,
      name,
      color: [0.78, 0.74, 0.68],
      roughness: 0.8,
      metallic: 0,
    };
    this.variants.push(variant);
    this.touch();
    return variant;
  }

  duplicateVariant(id: string): FabricVariant | null {
    const source = this.variantById(id);
    if (!source) return null;
    const copy: FabricVariant = {
      ...source,
      id: uid('fabric-variant'),
      name: `${source.name} copy`,
      color: [...source.color],
    };
    this.variants.splice(this.variants.indexOf(source) + 1, 0, copy);
    this.touch();
    return copy;
  }

  removeVariant(id: string): boolean {
    const index = this.variants.findIndex((variant) => variant.id === id);
    if (index < 0) return false;
    this.variants.splice(index, 1);
    // Pieces wearing it lose their fabric, so their physics change too.
    this.touch(true);
    return true;
  }

  updateVariant(
    id: string,
    patch: Partial<Omit<FabricVariant, 'id' | 'typeId'>>
  ): FabricVariant | null {
    const variant = this.variantById(id);
    if (!variant) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) variant.name = patch.name;
    if (patch.color) variant.color = clampColor(patch.color, variant.color);
    if (patch.roughness != null) {
      variant.roughness = clamp01(patch.roughness, variant.roughness);
    }
    if (patch.metallic != null) {
      variant.metallic = clamp01(patch.metallic, variant.metallic);
    }
    if (patch.albedoImage !== undefined) {
      if (patch.albedoImage) variant.albedoImage = patch.albedoImage;
      else delete variant.albedoImage;
    }
    if (patch.albedoImageName !== undefined) {
      if (patch.albedoImageName) variant.albedoImageName = patch.albedoImageName;
      else delete variant.albedoImageName;
    }
    this.touch();
    return variant;
  }

  save(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.toJSON()));
    } catch {
      /* private mode: the library just does not persist */
    }
  }

  private touch(physicsChanged = false): void {
    if (physicsChanged) this.physicsRevision++;
    this.save();
  }
}

export function loadFabricLibrary(): FabricLibrary {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return new FabricLibrary(DEFAULT_FABRIC_LIBRARY);
    return new FabricLibrary(JSON.parse(raw) as Partial<FabricLibraryData>);
  } catch {
    return new FabricLibrary(DEFAULT_FABRIC_LIBRARY);
  }
}
