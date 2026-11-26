/**
 * The fabric palette shared by the 2D ribbon and the two 3D viewports.
 *
 * It lists every type with its variants as colour chips, and — when more than
 * one piece is picked — a row per piece so each one can be given its own fabric.
 * Selecting a chip applies it to the whole selection; the rows are for when the
 * selection should not all be the same.
 */
import type { FabricLibrary, FabricVariant } from './library';

export type FabricPalettePiece = {
  id: string;
  name: string;
  fabricId?: string | null;
};

export type FabricPaletteOptions = {
  pieces: readonly FabricPalettePiece[];
  /** Apply one fabric to the whole selection (null clears it). */
  onAssign: (pieceIds: string[], fabricId: string | null) => void;
  /** Apply a fabric to one piece, from its row. */
  onAssignOne?: (pieceId: string, fabricId: string | null) => void;
  /** Shown when nothing is picked. */
  emptyLabel?: string;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function swatch(color: [number, number, number]): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) ** (1 / 2.2) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

function optionLabel(variant: FabricVariant, library: FabricLibrary): string {
  const type = library.typeById(variant.typeId);
  return `${type?.name ?? 'Fabric'} · ${variant.name}`;
}

/**
 * Paint the palette into `container` and bind it. Calling it again after the
 * selection or the library changed is how every ribbon stays current.
 */
export function renderFabricPalette(
  container: HTMLElement,
  library: FabricLibrary | null,
  options: FabricPaletteOptions
): void {
  const pieces = options.pieces;
  const selectedIds = pieces.map((piece) => piece.id);
  const selectedFabric =
    pieces.length > 0 && pieces.every((piece) => (piece.fabricId ?? null) === (pieces[0]!.fabricId ?? null))
      ? pieces[0]!.fabricId ?? null
      : undefined;
  const countLabel =
    pieces.length === 0
      ? options.emptyLabel ?? 'Pick a piece'
      : `${pieces.length} piece${pieces.length === 1 ? '' : 's'}`;
  if (!library) {
    container.innerHTML = `<div class="fabric-palette-empty">No fabric library</div>`;
    return;
  }
  const types = library.types
    .map((type) => {
      const variants = library.variantsOf(type.id);
      if (variants.length === 0) return '';
      return `
        <div class="fabric-palette-group">
          <span class="fabric-palette-type">${escapeHtml(type.name)}</span>
          <div class="fabric-palette-chips" role="group" aria-label="${escapeHtml(type.name)}">
            ${variants
              .map(
                (variant) => `
              <button type="button" class="fabric-chip${
                selectedFabric === variant.id ? ' is-active' : ''
              }" data-fabric-id="${escapeHtml(variant.id)}" title="${escapeHtml(
                `${optionLabel(variant, library)} — ${type.physics.weight.toFixed(
                  2
                )}× weight, ${type.physics.stiffness.toFixed(2)}× stretch, ${type.physics.bend.toFixed(
                  2
                )}× bend`
              )}" ${pieces.length === 0 ? 'disabled' : ''}>
                <span class="fabric-chip-swatch" style="background:${swatch(variant.color)}"></span>
                <span class="fabric-chip-name">${escapeHtml(variant.name)}</span>
                ${variant.albedoImage ? '<span class="fabric-chip-tex" aria-hidden="true">▦</span>' : ''}
              </button>`
              )
              .join('')}
          </div>
        </div>`;
    })
    .join('');
  const perPiece =
    pieces.length > 1 && options.onAssignOne
      ? `<div class="fabric-palette-pieces">
          <span class="fabric-palette-pieces-label">Each piece</span>
          ${pieces
            .map(
              (piece) => `
            <label class="fabric-palette-piece">
              <span>${escapeHtml(piece.name || 'Piece')}</span>
              <select data-fabric-piece="${escapeHtml(piece.id)}" aria-label="${escapeHtml(
                `Fabric for ${piece.name || 'piece'}`
              )}">
                <option value="">No fabric</option>
                ${library.variants
                  .map(
                    (variant) =>
                      `<option value="${escapeHtml(variant.id)}"${
                        (piece.fabricId ?? '') === variant.id ? ' selected' : ''
                      }>${escapeHtml(optionLabel(variant, library))}</option>`
                  )
                  .join('')}
              </select>
            </label>`
            )
            .join('')}
        </div>`
      : '';
  container.innerHTML = `
    <div class="fabric-palette-head">
      <span class="fabric-palette-title">Fabric</span>
      <span class="fabric-palette-count">${escapeHtml(countLabel)}</span>
      <button type="button" class="fabric-chip fabric-chip-none${
        selectedFabric === null && pieces.length > 0 ? ' is-active' : ''
      }" data-fabric-id="" ${pieces.length === 0 ? 'disabled' : ''}>None</button>
    </div>
    <div class="fabric-palette-groups">${types}</div>
    ${perPiece}
  `;
  container.querySelectorAll<HTMLButtonElement>('button[data-fabric-id]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (selectedIds.length === 0) return;
      const id = button.dataset.fabricId ?? '';
      options.onAssign(selectedIds, id || null);
    });
  });
  container.querySelectorAll<HTMLSelectElement>('select[data-fabric-piece]').forEach((select) => {
    select.addEventListener('change', () => {
      const pieceId = select.dataset.fabricPiece;
      if (!pieceId) return;
      options.onAssignOne?.(pieceId, select.value || null);
    });
  });
}
