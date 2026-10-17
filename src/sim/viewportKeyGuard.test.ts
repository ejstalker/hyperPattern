import { describe, expect, it } from 'vitest';
import { isTypingTarget, viewportOwnsKey } from './viewportKeyGuard';

function hostWithCanvas(): { host: HTMLElement; canvas: HTMLCanvasElement } {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  return { host, canvas };
}

describe('viewportOwnsKey', () => {
  it('takes the key when the pointer rests on the canvas', () => {
    const { host, canvas } = hostWithCanvas();
    expect(
      viewportOwnsKey({ hovered: true, host, target: canvas, activeElement: document.body })
    ).toBe(true);
  });

  it('leaves the key alone when the pointer is elsewhere and focus is outside', () => {
    const { host, canvas } = hostWithCanvas();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    expect(
      viewportOwnsKey({ hovered: false, host, target: elsewhere, activeElement: elsewhere })
    ).toBe(false);
  });

  it('takes the key when focus is inside the viewport, as after clicking its toolbar', () => {
    const { host } = hostWithCanvas();
    const toggle = document.createElement('button');
    host.appendChild(toggle);
    toggle.focus();
    expect(
      viewportOwnsKey({ hovered: false, host, target: toggle, activeElement: toggle })
    ).toBe(true);
  });

  it('never takes the key from a text field, even under the pointer', () => {
    const { host } = hostWithCanvas();
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(
      viewportOwnsKey({ hovered: true, host, target: input, activeElement: input })
    ).toBe(false);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    const editable = document.createElement('div');
    // Setting the attribute is how markup and templates do it; a browser reports
    // `isContentEditable` for both spellings.
    editable.setAttribute('contenteditable', 'true');
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});
