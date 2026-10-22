/**
 * Wavefront OBJ for a set of triangle meshes sharing one scene.
 *
 * The studio works in world units where one unit is ten centimetres, and OBJ
 * carries no units at all — an importer is free to call a unit anything. Writing
 * metres is the choice that lands a 166 cm avatar at 1.66 in Blender and in most
 * other DCC tools without anyone touching an import scale, so every coordinate
 * goes out multiplied by {@link OBJ_METRES_PER_WORLD}.
 */

/** Metres per world unit — see the module comment. */
export const OBJ_METRES_PER_WORLD = 0.1;

export type ObjPart = {
  /** Object name; written as `o <name>`. */
  name: string;
  /** Interleaved xyz, in world units. */
  positions: ArrayLike<number>;
  /** Triangle vertex indices into `positions`. */
  indices: ArrayLike<number>;
};

/** `12` for 12, `0.12345` for a short decimal — no exponent gymnastics. */
function num(value: number, scale: number): string {
  const scaled = value * scale;
  // 5 decimals of a metre is 10 µm: far below anything the mesh resolves.
  const rounded = Math.round(scaled * 1e5) / 1e5;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** OBJ object names are whitespace-delimited, so a name has to be one word. */
function sanitiseName(name: string): string {
  const trimmed = name.trim().replace(/[^\w.-]+/g, '_');
  return trimmed.length ? trimmed : 'mesh';
}

/**
 * Serialise parts into one OBJ body.
 *
 * Vertex indices are rebased onto the whole file (OBJ counts from 1 across all
 * objects), and indices that fall outside their part are dropped rather than
 * emitted as a corrupt face.
 */
export function buildObj(parts: readonly ObjPart[], scale = OBJ_METRES_PER_WORLD): string {
  const lines: string[] = ['# hyperPattern drape export'];
  let vertexBase = 0;

  for (const part of parts) {
    const count = Math.floor(part.positions.length / 3);
    if (count === 0) continue;
    lines.push(`o ${sanitiseName(part.name)}`);
    for (let i = 0; i < count; i++) {
      lines.push(
        `v ${num(part.positions[i * 3]!, scale)} ${num(part.positions[i * 3 + 1]!, scale)} ${num(
          part.positions[i * 3 + 2]!,
          scale
        )}`
      );
    }
    const tris = Math.floor(part.indices.length / 3);
    for (let t = 0; t < tris; t++) {
      const a = part.indices[t * 3]!;
      const b = part.indices[t * 3 + 1]!;
      const c = part.indices[t * 3 + 2]!;
      if (a >= count || b >= count || c >= count) continue;
      lines.push(`f ${vertexBase + a + 1} ${vertexBase + b + 1} ${vertexBase + c + 1}`);
    }
    vertexBase += count;
  }

  return `${lines.join('\n')}\n`;
}

/** File name for a drape export, safe on every platform. */
export function objFileName(sceneName: string): string {
  const base = sceneName
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base.length ? base : 'drape'}.obj`;
}

/** Hand a blob to the browser as a download. */
export function downloadFile(data: BlobPart, fileName: string, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  // Neither the anchor nor the URL may go before the browser has taken the
  // download up — Safari in particular drops it if the anchor is detached in the
  // same task as the click.
  setTimeout(() => link.remove(), 1_000);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Hand the text to the browser as a text download. */
export function downloadTextFile(text: string, fileName: string, mime = 'model/obj'): void {
  downloadFile(text, fileName, `${mime};charset=utf-8`);
}
