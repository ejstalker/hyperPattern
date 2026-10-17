/** True when a key event is aimed at a text field rather than a viewport. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { tagName?: string }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'SELECT' ||
    el.tagName === 'TEXTAREA' ||
    // `isContentEditable` is the authoritative flag in a browser; the attribute
    // covers an element an environment reports it for inconsistently.
    el.isContentEditable === true ||
    el.getAttribute?.('contenteditable') === 'true'
  );
}

export type ViewportKeyContext = {
  /** The pointer is resting on this viewport's canvas. */
  hovered: boolean;
  /** The viewport's host element, which contains its canvas and its buttons. */
  host: HTMLElement | null;
  /** The key event's target. */
  target: EventTarget | null;
  /** `document.activeElement`. */
  activeElement: Element | null;
};

/**
 * Whether a keyboard shortcut belongs to a 3D viewport.
 *
 * A board can hold several 3D viewports — a drape and the transform stage it was
 * built from — alongside pattern editors that claim single-key tool shortcuts in
 * the *document's* capture phase. Node viewports never take focus: a press on one
 * calls `preventDefault` so the drag does not begin a text selection, which also
 * cancels the focus that would have followed. Focus therefore cannot be the
 * signal and hover is: the shortcut goes to the viewport the pointer rests on.
 * That is also why listeners asking this question are registered in the window's
 * capture phase, ahead of the editors' document listener.
 *
 * A typing target never belongs to a viewport, hovered or not.
 */
export function viewportOwnsKey(ctx: ViewportKeyContext): boolean {
  if (isTypingTarget(ctx.target)) return false;
  if (ctx.hovered) return true;
  const active = ctx.activeElement;
  return !!ctx.host && !!active && ctx.host.contains(active);
}
