/**
 * The drape's export control, bottom-right of the viewport: a split button.
 *
 * The main half downloads an OBJ of what is on screen — the avatar and the cloth
 * as it stands. The caret opens a one-item popover for the Blender pack, which is
 * a different kind of thing (a zip of two meshes, a seam map and an import
 * script) and so is worth putting behind a deliberate second click rather than
 * giving the viewport two equally loud buttons.
 */
export type SimExportHandlers = {
  /** Download the scene as an OBJ. */
  onExportObj: () => void;
  /** Download the Blender pack zip. */
  onExportPack: () => void;
};

const DOWNLOAD_ICON = `
  <svg class="sim-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"
          d="M8 2.4v6.9M5.1 6.6 8 9.6l2.9-3M2.9 10.6v1.9c0 .7.6 1.3 1.3 1.3h7.6c.7 0 1.3-.6 1.3-1.3v-1.9"/>
  </svg>
`;

export class SimExportControl {
  readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly caret: HTMLButtonElement;
  private open = false;
  private readonly handlers: SimExportHandlers;
  private readonly onDocumentPointerDown = (e: PointerEvent): void => {
    if (!this.open) return;
    // The control can outlive its own removal (a node deleted or a project
    // loaded while the popover is open), so it takes itself off the document.
    if (!this.root.isConnected) {
      this.dispose();
      return;
    }
    if (e.target instanceof Node && this.root.contains(e.target)) return;
    this.close();
  };

  constructor(host: HTMLElement, handlers: SimExportHandlers) {
    this.handlers = handlers;

    this.root = document.createElement('div');
    this.root.className = 'sim-export';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'sim-export-main';
    main.title = 'Export an OBJ of this drape — the avatar and all of the cloth';
    main.setAttribute('aria-label', 'Export the drape as an OBJ');
    main.innerHTML = DOWNLOAD_ICON;
    main.addEventListener('pointerdown', (e) => e.stopPropagation());
    main.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      this.handlers.onExportObj();
    });

    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'sim-export-caret';
    caret.title = 'More export options';
    caret.setAttribute('aria-label', 'More export options');
    caret.setAttribute('aria-haspopup', 'menu');
    caret.setAttribute('aria-expanded', 'false');
    caret.innerHTML = `<svg viewBox="0 0 8 16" aria-hidden="true"><path fill="currentColor" d="M1.6 6.2 4 8.9l2.4-2.7z"/></svg>`;
    caret.addEventListener('pointerdown', (e) => e.stopPropagation());
    caret.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });
    this.caret = caret;

    this.panel = document.createElement('div');
    this.panel.className = 'sim-export-menu';
    this.panel.setAttribute('role', 'menu');
    this.panel.hidden = true;
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const pack = document.createElement('button');
    pack.type = 'button';
    pack.className = 'sim-export-item';
    pack.setAttribute('role', 'menuitem');
    pack.innerHTML = `
      <span class="sim-export-item-title">Download Blender pack…</span>
      <span class="sim-export-item-note">cloth + avatar OBJ, seam map, import script</span>
    `;
    pack.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      this.handlers.onExportPack();
    });
    this.panel.appendChild(pack);

    this.root.append(main, caret, this.panel);
    host.appendChild(this.root);
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    // Capture, so a viewport that swallows keys cannot hide the Escape that
    // dismisses this popover.
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  dispose(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.root.remove();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.open) {
      e.stopPropagation();
      this.close();
    }
  };

  private toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  private show(): void {
    this.open = true;
    this.panel.hidden = false;
    this.caret.setAttribute('aria-expanded', 'true');
    this.caret.classList.add('is-open');
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    this.panel.hidden = true;
    this.caret.setAttribute('aria-expanded', 'false');
    this.caret.classList.remove('is-open');
  }
}
