'use strict';

/**
 * The composer's emoji picker. Two things go wrong with a hand-written glyph
 * list and both are invisible in a screenshot: a character that does not survive
 * the editor becomes a blank button, and a duplicated code point makes the same
 * face appear twice in one row. The caret arithmetic is the other half, because
 * "insert at the cursor" is the only behaviour that does not destroy a message
 * somebody is halfway through typing.
 */

const { loadEmoji } = require('../helpers/load-client-module');

let emoji;

beforeEach(() => {
  emoji = loadEmoji();
});

describe('the list a picker is built from', () => {
  it('labels every group and gives each one something to show', () => {
    expect(emoji.EMOJI_GROUPS.length).toBeGreaterThan(1);
    emoji.EMOJI_GROUPS.forEach((group) => {
      expect(typeof group.label).toBe('string');
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.items.length).toBeGreaterThanOrEqual(8);
    });
  });

  it('carries a real glyph in every slot, because a dropped character renders as nothing', () => {
    emoji.EMOJI_GROUPS.flatMap((group) => group.items).forEach((glyph) => {
      expect(typeof glyph).toBe('string');
      expect(glyph.length).toBeGreaterThan(0);
      // A code point that failed to decode lands on the replacement character.
      expect(glyph).not.toContain('\uFFFD');
      expect(glyph).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(Number.isNaN(glyph.codePointAt(0))).toBe(false);
    });
  });

  it('never shows the same glyph twice', () => {
    const flat = emoji.EMOJI_GROUPS.flatMap((group) => group.items);
    expect(new Set(flat).size).toBe(flat.length);
  });
});

describe('inserting at the caret', () => {
  const GRIN = String.fromCodePoint(0x1f600);

  it('drops the glyph where the cursor is, not at the end', () => {
    expect(emoji.insertAtCaret('ab', 1, 1, GRIN)).toEqual({ value: `a${GRIN}b`, caret: 3 });
  });

  it('replaces what was selected', () => {
    expect(emoji.insertAtCaret('hello', 0, 5, GRIN)).toEqual({ value: `${GRIN}`, caret: GRIN.length });
  });

  it('appends when the field never reported a selection', () => {
    expect(emoji.insertAtCaret('hi', undefined, undefined, 'x')).toEqual({ value: 'hix', caret: 3 });
  });

  it('clamps a selection that arrives backwards or off the end', () => {
    expect(emoji.insertAtCaret('hi', 5, 2, 'x')).toEqual({ value: 'hix', caret: 3 });
    expect(emoji.insertAtCaret('hi', -3, -1, 'x')).toEqual({ value: 'xhi', caret: 1 });
  });

  it('leaves an empty draft usable', () => {
    expect(emoji.insertAtCaret('', 0, 0, GRIN)).toEqual({ value: GRIN, caret: GRIN.length });
  });
});
