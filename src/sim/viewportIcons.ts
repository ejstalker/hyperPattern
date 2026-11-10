/**
 * Icons for the tool buttons that float over a 3D viewport.
 *
 * One per button, drawn in `currentColor` so a button styles its own icon — the
 * active gold, the disabled grey — without a second copy of the artwork. The
 * viewport's tools live in a small column at the top-left, the way the pattern's
 * rail does, so the label always sits to the right of its mark.
 */

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';

/** Four arrows out of a centre: moving the selection. */
export const MOVE_ICON = `<svg class="sim-tool-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" ${stroke}><path d="M8 2.2v11.6M2.2 8h11.6"/><path d="M8 2.2 6.4 3.9M8 2.2l1.6 1.7M8 13.8l-1.6-1.7M8 13.8l1.6-1.7M2.2 8l1.7-1.6M2.2 8l1.7 1.6M13.8 8l-1.7-1.6M13.8 8l-1.7 1.6"/></svg>`;

/** A circular arrow about a dot: turning the selection. */
export const ROTATE_ICON = `<svg class="sim-tool-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" ${stroke}><path d="M13 8a5 5 0 1 1-2.1-4.1"/><path d="M13.4 2.4v3.2h-3.2"/><circle cx="8" cy="8" r="1.1"/></svg>`;

/** A control point with its two handles: the pattern's points, drawn on the cloth. */
export const POINTS_ICON = `<svg class="sim-tool-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" ${stroke}><circle cx="8" cy="8" r="2.2"/><path d="M2.5 8h3.3M10.2 8h3.3"/><circle cx="2" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="14" cy="8" r="1.3" fill="currentColor" stroke="none"/></svg>`;

/** Two edges drawn together, held by stitches between them: sewing. */
export const SEW_ICON = `<svg class="sim-tool-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" ${stroke}><path d="M5.2 2.4v11.2M10.8 2.4v11.2"/><path d="M5.2 6.3h5.6M5.2 9.7h5.6" stroke-dasharray="1.7 1.5"/></svg>`;

/** A quadrant grid with a cell picked: snapping a piece into place. */
export const SNAP_ICON = `<svg class="sim-tool-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" ${stroke}><rect x="2.3" y="2.3" width="11.4" height="11.4" rx="1.4"/><path d="M8 2.3v11.4M2.3 8h11.4"/><rect x="8" y="2.3" width="5.7" height="5.7" fill="currentColor" stroke="none" opacity="0.55"/></svg>`;
