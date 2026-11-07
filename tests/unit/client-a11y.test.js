/** @jest-environment jsdom */

'use strict';

const { loadA11y } = require('../helpers/load-client-module');

const a11y = loadA11y();

const make = (tagName, attrs = {}) => {
  const el = document.createElement(tagName);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === null) el.removeAttribute(key);
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, String(value));
  });
  return el;
};

/** jsdom reports every box as 0×0, so visibility has to be faked to be asserted. */
const visible = (el) => {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: 24 });
  return el;
};

describe('focus trap arithmetic', () => {
  it('walks forward and wraps from the last control to the first', () => {
    expect(a11y.trapTarget({ count: 3, from: 0 })).toBe(1);
    expect(a11y.trapTarget({ count: 3, from: 1 })).toBe(2);
    expect(a11y.trapTarget({ count: 3, from: 2 })).toBe(0);
  });

  it('walks backward and wraps from the first control to the last', () => {
    expect(a11y.trapTarget({ count: 3, from: 2, shift: true })).toBe(1);
    expect(a11y.trapTarget({ count: 3, from: 1, shift: true })).toBe(0);
    expect(a11y.trapTarget({ count: 3, from: 0, shift: true })).toBe(2);
  });

  it('lands inside the dialog when focus is somewhere the trap cannot see', () => {
    // body still has focus, or focus sat on a control that has since closed
    expect(a11y.trapTarget({ count: 4, from: -1 })).toBe(0);
    expect(a11y.trapTarget({ count: 4, from: -1, shift: true })).toBe(3);
    expect(a11y.trapTarget({ count: 4, from: 9 })).toBe(0);
    expect(a11y.trapTarget({ count: 4, from: undefined })).toBe(0);
  });

  it('has nowhere to go in a dialog with no controls', () => {
    expect(a11y.trapTarget({ count: 0, from: 0 })).toBeNull();
    expect(a11y.trapTarget({ count: null, from: 0 })).toBeNull();
  });
});

describe('menu roving focus', () => {
  it('moves one item per arrow and wraps at both ends', () => {
    expect(a11y.menuTarget({ count: 4, from: 0, key: 'ArrowDown' })).toBe(1);
    expect(a11y.menuTarget({ count: 4, from: 3, key: 'ArrowDown' })).toBe(0);
    expect(a11y.menuTarget({ count: 4, from: 0, key: 'ArrowUp' })).toBe(3);
    expect(a11y.menuTarget({ count: 4, from: 2, key: 'ArrowUp' })).toBe(1);
  });

  it('jumps to the ends on Home and End', () => {
    expect(a11y.menuTarget({ count: 4, from: 2, key: 'Home' })).toBe(0);
    expect(a11y.menuTarget({ count: 4, from: 2, key: 'End' })).toBe(3);
  });

  it('treats an unfocused menu as sitting before the first item', () => {
    expect(a11y.menuTarget({ count: 3, from: -1, key: 'ArrowDown' })).toBe(0);
    expect(a11y.menuTarget({ count: 3, from: -1, key: 'ArrowUp' })).toBe(2);
    expect(a11y.menuTarget({ count: 3, from: 7, key: 'ArrowDown' })).toBe(0);
  });

  it('leaves every other key to the browser', () => {
    ['Enter', ' ', 'Tab', 'ArrowLeft', 'a', 'PageDown'].forEach((key) => {
      expect(a11y.menuTarget({ count: 3, from: 1, key })).toBeNull();
    });
    expect(a11y.menuTarget({ count: 0, from: 0, key: 'ArrowDown' })).toBeNull();
  });
});

describe('what a dialog takes focus to when it opens', () => {
  it('prefers the field the dialog was opened for', () => {
    const list = [
      visible(make('button', { 'aria-label': 'Close' })),
      visible(make('input', { type: 'text' })),
      visible(make('button', { text: 'Save' })),
    ];
    expect(a11y.preferredFocus(list)).toBe(1);
  });

  it('counts every text-entry type, and an input with no type at all', () => {
    [undefined, 'text', 'search', 'email', 'tel', 'url', 'password'].forEach((type) => {
      const list = [visible(make('button', { text: 'Close' })), visible(make('input', type ? { type } : {}))];
      expect(a11y.preferredFocus(list)).toBe(1);
    });
  });

  it('does not mistake a toggle for a field', () => {
    // The settings sheet is mostly switches; opening it on one would be useless.
    const list = [
      visible(make('button', { 'aria-label': 'Close' })),
      visible(make('input', { type: 'checkbox', role: 'switch' })),
      visible(make('input', { type: 'file' })),
      visible(make('input', { type: 'radio' })),
      visible(make('textarea')),
    ];
    expect(a11y.preferredFocus(list)).toBe(4);
  });

  it('falls back to the first control when there is nothing to type into', () => {
    const list = [visible(make('button', { text: 'Close' })), visible(make('a', { href: '#' }))];
    expect(a11y.preferredFocus(list)).toBe(0);
  });

  it('gives up on an empty or malformed list instead of guessing', () => {
    expect(a11y.preferredFocus([])).toBeNull();
    expect(a11y.preferredFocus(undefined)).toBeNull();
    expect(a11y.preferredFocus([null])).toBe(0);
  });
});

describe('which controls count as focusable', () => {
  it('offers a selector that skips disabled and script-only stops', () => {
    const host = document.createElement('div');
    [
      visible(make('button', { text: 'on' })),
      visible(make('button', { disabled: true })),
      visible(make('a', { href: '/calls', text: 'link' })),
      visible(make('input', { type: 'text' })),
      visible(make('input', { type: 'text', disabled: true })),
      visible(make('div', { tabindex: -1 })),
      visible(make('div', { tabindex: 0 })),
    ].forEach((el) => host.appendChild(el));

    const found = [...host.querySelectorAll(a11y.FOCUSABLE_SELECTOR)];
    expect(found).toHaveLength(4);
    expect(found.some((el) => el.disabled)).toBe(false);
  });

  it('rejects disabled, hidden and zero-box controls', () => {
    expect(a11y.isUsable(visible(make('button')))).toBe(true);
    expect(a11y.isUsable(visible(make('button', { disabled: true })))).toBe(false);
    expect(a11y.isUsable(visible(make('button', { 'aria-hidden': true })))).toBe(false);
    expect(a11y.isUsable(make('button'))).toBe(false);
    expect(a11y.isUsable(null)).toBe(false);
  });
});
