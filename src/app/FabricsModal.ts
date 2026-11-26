/**
 * The studio's fabric library, in a modal off the hamburger menu.
 *
 * Left: the fabric types — the physics. Right: the type's weight/stretch/bend,
 * then its variants — the colours, PBR settings and textures. A piece picks a
 * variant, so wool pieces can differ in colour while draping alike.
 */
import {
  FabricLibrary,
  fabricColorFromHex,
  fabricColorHex,
  loadFabricLibrary,
  type FabricType,
  type FabricVariant,
} from '../fabrics/library';
import { imageFileToDataUrl } from '../render/imageDataUrl';

export type FabricsModalCallbacks = {
  onClose: () => void;
  /** Fired after any library change, so open viewports can repaint. */
  onChange?: (library: FabricLibrary) => void;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class FabricsModal {
  private readonly root: HTMLElement;
  private readonly callbacks: FabricsModalCallbacks;
  private library: FabricLibrary | null = null;
  private activeTypeId: string | null = null;
  private activeVariantId: string | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLElement, callbacks: FabricsModalCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
  }

  /**
   * Open on the studio's own library when it has one. Editing a fresh copy
   * would leave every open viewport pointing at the old object, so the modal
   * mutates the shared library in place.
   */
  open(library?: FabricLibrary): void {
    this.library = library ?? loadFabricLibrary();
    this.activeTypeId = this.library.types[0]?.id ?? null;
    this.activeVariantId = this.library.variantsOf(this.activeTypeId ?? '')[0]?.id ?? null;
    this.render();
  }

  close(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
      if (this.library) this.callbacks.onChange?.(this.library);
    }
    this.root.hidden = true;
    this.root.innerHTML = '';
    this.callbacks.onClose();
  }

  private get activeType(): FabricType | null {
    return this.library?.typeById(this.activeTypeId) ?? null;
  }

  private get activeVariant(): FabricVariant | null {
    return this.library?.variantById(this.activeVariantId) ?? null;
  }

  private notify(): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    const library = this.library;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (library) this.callbacks.onChange?.(library);
    }, 80);
  }

  private render(): void {
    const library = this.library;
    const type = this.activeType;
    if (!library || !type) return;
    const variants = library.variantsOf(type.id);
    const variant = this.activeVariant;
    this.root.hidden = false;
    this.root.innerHTML = `
      <div class="studio-modal-backdrop" data-modal-dismiss>
        <div class="studio-modal measure-modal fabric-modal" role="dialog" aria-labelledby="fabricTitle">
          <div class="studio-modal-header">
            <h2 id="fabricTitle">Fabrics</h2>
            <button type="button" class="studio-modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <div class="fabric-layout">
            <aside class="fabric-types">
              <div class="fabric-list-head">
                <span>Types</span>
                <div class="fabric-list-buttons">
                  <button type="button" data-type-act="add" title="Add a fabric type" aria-label="Add a fabric type">+</button>
                  <button type="button" data-type-act="duplicate" title="Duplicate this type and its colours" aria-label="Duplicate type">⧉</button>
                  <button type="button" data-type-act="remove" class="is-danger" title="Delete this type" aria-label="Delete type" ${
                    library.types.length <= 1 ? 'disabled' : ''
                  }>−</button>
                </div>
              </div>
              <div class="fabric-type-list" role="tablist" aria-label="Fabric types">
                ${library.types
                  .map(
                    (entry) => `
                  <button type="button" role="tab" class="fabric-type-tab${
                    entry.id === type.id ? ' is-active' : ''
                  }" data-type-id="${entry.id}" aria-selected="${entry.id === type.id}">
                    <span class="fabric-type-name">${escapeHtml(entry.name)}</span>
                    <span class="fabric-type-meta">${entry.physics.weight.toFixed(
                      2
                    )}× weight · ${library.variantsOf(entry.id).length} colour${
                      library.variantsOf(entry.id).length === 1 ? '' : 's'
                    }</span>
                  </button>`
                  )
                  .join('')}
              </div>
            </aside>
            <section class="fabric-body">
              <div class="fabric-section">
                <label class="fabric-name">
                  <span>Type</span>
                  <input type="text" data-type-name value="${escapeHtml(type.name)}" />
                </label>
                <p class="fabric-note">Physics multipliers, against the drape's own fabric. Pieces assigned to this type share these; colours and textures live on the variants below.</p>
                <div class="fabric-physics">
                  ${this.physicsField('weight', 'Weight', type.physics.weight, 0.05, 3, 0.05, 'Heavier fabric hangs and pulls harder')}
                  ${this.physicsField('stiffness', 'Stretch resistance', type.physics.stiffness, 0.05, 3, 0.05, 'Higher resists stretching')}
                  ${this.physicsField('bend', 'Fold resistance', type.physics.bend, 0.05, 4, 0.05, 'Higher resists folding and creasing')}
                </div>
              </div>
              <div class="fabric-section">
                <div class="fabric-list-head">
                  <span>Variants</span>
                  <div class="fabric-list-buttons">
                    <button type="button" data-variant-act="add" title="Add a colour or texture to this type" aria-label="Add variant">+</button>
                    <button type="button" data-variant-act="duplicate" title="Duplicate this variant" aria-label="Duplicate variant" ${
                      variant ? '' : 'disabled'
                    }>⧉</button>
                    <button type="button" data-variant-act="remove" class="is-danger" title="Delete this variant" aria-label="Delete variant" ${
                      variant ? '' : 'disabled'
                    }>−</button>
                  </div>
                </div>
                <div class="fabric-variant-list" role="tablist" aria-label="Fabric variants">
                  ${
                    variants.length === 0
                      ? '<p class="fabric-note">No variants yet — add one to give this fabric a colour.</p>'
                      : variants
                          .map(
                            (entry) => `
                    <button type="button" role="tab" class="fabric-variant-tab${
                      entry.id === variant?.id ? ' is-active' : ''
                    }" data-variant-id="${entry.id}" aria-selected="${entry.id === variant?.id}">
                      <span class="fabric-swatch" style="background:${fabricColorHex(entry.color)}"></span>
                      <span class="fabric-variant-name">${escapeHtml(entry.name)}</span>
                      ${entry.albedoImage ? '<span class="fabric-variant-tex">texture</span>' : ''}
                    </button>`
                          )
                          .join('')
                  }
                </div>
              </div>
              ${
                variant
                  ? `
              <div class="fabric-section fabric-variant-editor">
                <label class="fabric-name">
                  <span>Name</span>
                  <input type="text" data-variant-name value="${escapeHtml(variant.name)}" />
                </label>
                <div class="fabric-look">
                  <label class="fabric-color">
                    <span>Colour</span>
                    <input type="color" data-variant-color value="${fabricColorHex(variant.color)}" />
                  </label>
                  ${this.variantSlider('roughness', 'Roughness', variant.roughness)}
                  ${this.variantSlider('metallic', 'Metallic', variant.metallic)}
                </div>
                <div class="fabric-texture">
                  <span class="fabric-texture-label">Texture</span>
                  ${
                    variant.albedoImage
                      ? `<img class="fabric-texture-thumb" src="${escapeHtml(
                          variant.albedoImage
                        )}" alt="" />`
                      : '<span class="fabric-texture-none">No image — the colour above is used</span>'
                  }
                  <button type="button" data-variant-act="texture">${
                    variant.albedoImage ? 'Replace…' : 'Load image…'
                  }</button>
                  ${
                    variant.albedoImage
                      ? '<button type="button" data-variant-act="clear-texture">Clear</button>'
                      : ''
                  }
                  <span class="fabric-texture-name">${escapeHtml(
                    variant.albedoImageName ?? ''
                  )}</span>
                </div>
              </div>`
                  : ''
              }
            </section>
          </div>
        </div>
      </div>
    `;
    this.bind();
  }

  private physicsField(
    field: 'weight' | 'stiffness' | 'bend',
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    tip: string
  ): string {
    return `
      <label class="fabric-slider" title="${tip}">
        <span class="fabric-slider-label">${label}</span>
        <input type="range" data-physics="${field}" min="${min}" max="${max}" step="${step}" value="${value}" />
        <input type="number" data-physics-number="${field}" min="${min}" max="${max}" step="${step}" value="${value.toFixed(
          2
        )}" />
      </label>`;
  }

  private variantSlider(field: 'roughness' | 'metallic', label: string, value: number): string {
    return `
      <label class="fabric-slider">
        <span class="fabric-slider-label">${label}</span>
        <input type="range" data-variant-slider="${field}" min="0" max="1" step="0.01" value="${value}" />
        <span class="fabric-slider-value">${value.toFixed(2)}</span>
      </label>`;
  }

  private bind(): void {
    const library = this.library;
    const type = this.activeType;
    if (!library || !type) return;

    this.root.querySelector('[data-modal-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.close();
    });
    this.root.querySelector('[data-modal-close]')?.addEventListener('click', () => this.close());

    this.root.querySelectorAll<HTMLButtonElement>('[data-type-id]').forEach((button) => {
      button.addEventListener('click', () => {
        this.activeTypeId = button.dataset.typeId ?? null;
        this.activeVariantId =
          library.variantsOf(this.activeTypeId ?? '')[0]?.id ?? null;
        this.render();
      });
    });

    this.root.querySelector('[data-type-act="add"]')?.addEventListener('click', () => {
      const created = library.addType();
      this.activeTypeId = created.id;
      this.activeVariantId = null;
      this.notify();
      this.render();
    });
    this.root.querySelector('[data-type-act="duplicate"]')?.addEventListener('click', () => {
      const copy = library.duplicateType(type.id);
      if (!copy) return;
      this.activeTypeId = copy.id;
      this.activeVariantId = library.variantsOf(copy.id)[0]?.id ?? null;
      this.notify();
      this.render();
    });
    this.root.querySelector('[data-type-act="remove"]')?.addEventListener('click', () => {
      if (!confirm(`Delete “${type.name}” and all of its variants?`)) return;
      const index = library.types.findIndex((entry) => entry.id === type.id);
      if (!library.removeType(type.id)) return;
      this.activeTypeId =
        library.types[Math.max(0, Math.min(index, library.types.length - 1))]?.id ?? null;
      this.activeVariantId = library.variantsOf(this.activeTypeId ?? '')[0]?.id ?? null;
      this.notify();
      this.render();
    });

    const nameInput = this.root.querySelector<HTMLInputElement>('[data-type-name]');
    nameInput?.addEventListener('change', () => {
      library.updateType(type.id, { name: nameInput.value });
      this.notify();
      this.render();
    });

    const syncPhysics = (field: 'weight' | 'stiffness' | 'bend', raw: string): void => {
      const value = Number(raw);
      if (!Number.isFinite(value)) return;
      library.updateType(type.id, { physics: { ...type.physics, [field]: value } });
      this.notify();
    };
    this.root.querySelectorAll<HTMLInputElement>('[data-physics]').forEach((input) => {
      const field = input.dataset.physics as 'weight' | 'stiffness' | 'bend';
      input.addEventListener('input', () => {
        syncPhysics(field, input.value);
        const number = this.root.querySelector<HTMLInputElement>(
          `[data-physics-number="${field}"]`
        );
        if (number) number.value = Number(input.value).toFixed(2);
      });
    });
    this.root.querySelectorAll<HTMLInputElement>('[data-physics-number]').forEach((input) => {
      const field = input.dataset.physicsNumber as 'weight' | 'stiffness' | 'bend';
      input.addEventListener('change', () => {
        syncPhysics(field, input.value);
        this.render();
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-variant-id]').forEach((button) => {
      button.addEventListener('click', () => {
        this.activeVariantId = button.dataset.variantId ?? null;
        this.render();
      });
    });

    this.root.querySelector('[data-variant-act="add"]')?.addEventListener('click', () => {
      const created = library.addVariant(type.id);
      if (!created) return;
      this.activeVariantId = created.id;
      this.notify();
      this.render();
    });
    this.root.querySelector('[data-variant-act="duplicate"]')?.addEventListener('click', () => {
      const variant = this.activeVariant;
      if (!variant) return;
      const copy = library.duplicateVariant(variant.id);
      if (!copy) return;
      this.activeVariantId = copy.id;
      this.notify();
      this.render();
    });
    this.root.querySelector('[data-variant-act="remove"]')?.addEventListener('click', () => {
      const variant = this.activeVariant;
      if (!variant) return;
      if (!confirm(`Delete “${variant.name}”?`)) return;
      const index = library.variantsOf(type.id).findIndex((entry) => entry.id === variant.id);
      if (!library.removeVariant(variant.id)) return;
      const remaining = library.variantsOf(type.id);
      this.activeVariantId = remaining[Math.max(0, Math.min(index, remaining.length - 1))]?.id ?? null;
      this.notify();
      this.render();
    });

    const variant = this.activeVariant;
    if (!variant) return;
    const variantName = this.root.querySelector<HTMLInputElement>('[data-variant-name]');
    variantName?.addEventListener('change', () => {
      library.updateVariant(variant.id, { name: variantName.value });
      this.notify();
      this.render();
    });
    const color = this.root.querySelector<HTMLInputElement>('[data-variant-color]');
    color?.addEventListener('input', () => {
      library.updateVariant(variant.id, { color: fabricColorFromHex(color.value) });
      const swatch = this.root.querySelector<HTMLElement>(
        '.fabric-variant-tab.is-active .fabric-swatch'
      );
      if (swatch) swatch.style.background = color.value;
      this.notify();
    });
    this.root.querySelectorAll<HTMLInputElement>('[data-variant-slider]').forEach((input) => {
      const field = input.dataset.variantSlider as 'roughness' | 'metallic';
      input.addEventListener('input', () => {
        library.updateVariant(variant.id, { [field]: Number(input.value) });
        const label = input.parentElement?.querySelector('.fabric-slider-value');
        if (label) label.textContent = Number(input.value).toFixed(2);
        this.notify();
      });
    });

    this.root.querySelector('[data-variant-act="texture"]')?.addEventListener('click', () => {
      const file = document.createElement('input');
      file.type = 'file';
      file.accept = 'image/*';
      file.hidden = true;
      document.body.appendChild(file);
      file.addEventListener('cancel', () => file.remove());
      file.addEventListener('change', () => {
        const chosen = file.files?.[0];
        file.remove();
        if (!chosen) return;
        void imageFileToDataUrl(chosen)
          .then((url) => {
            library.updateVariant(variant.id, {
              albedoImage: url,
              albedoImageName: chosen.name,
            });
            this.notify();
            this.render();
          })
          .catch(() => {
            const label = this.root.querySelector('.fabric-texture-name');
            if (label) label.textContent = 'Could not read that image';
          });
      });
      file.click();
    });
    this.root.querySelector('[data-variant-act="clear-texture"]')?.addEventListener('click', () => {
      library.updateVariant(variant.id, {
        albedoImage: '',
        albedoImageName: '',
      });
      this.notify();
      this.render();
    });
  }
}
