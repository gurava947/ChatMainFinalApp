/**
 * A picker needs a list, and this one is static on purpose: nothing here is
 * fetched, suggested, or claimed to learn from what you type.
 *
 * The faces are written as code points rather than literals because a glyph
 * pasted into a source file is a glyph a tool can quietly drop, and an empty
 * button in a picker is invisible until somebody taps it.
 */
const glyph = (...codePoints) => String.fromCodePoint(...codePoints)

export const EMOJI_GROUPS = [
  {
    label: 'Faces',
    items: [
      [0x1f600], [0x1f603], [0x1f604], [0x1f601], [0x1f606], [0x1f605], [0x1f602], [0x1f923],
      [0x1f642], [0x1f643], [0x1f609], [0x1f60a], [0x1f607], [0x1f970], [0x1f60d], [0x1f618],
      [0x1f60b], [0x1f61c], [0x1f92a], [0x1f929], [0x1f914], [0x1f92d], [0x1f610], [0x1f615],
      [0x1f622], [0x1f62d], [0x1f624], [0x1f621], [0x1f631], [0x1f628], [0x1f634], [0x1f60e],
      [0x1f92f], [0x1f644], [0x1f60f], [0x1f971]
    ].map((codePoints) => glyph(...codePoints))
  },
  {
    label: 'Hands & things',
    items: [
      [0x1f44d], [0x1f44e], [0x1f44c], [0x1f91e], [0x1f44f], [0x1f64f], [0x1f4aa], [0x1f91d],
      [0x1f44b], [0x1f64c], [0x2764, 0xfe0f], [0x1f9e1], [0x1f49b], [0x1f49a], [0x1f499], [0x1f49c],
      [0x1f4af], [0x1f525], [0x2728], [0x1f389], [0x1f388], [0x1f381], [0x2615], [0x1f355],
      [0x1f37e], [0x26bd], [0x1f680], [0x2708, 0xfe0f], [0x1f319], [0x2600, 0xfe0f], [0x2b50],
      [0x1f308], [0x1f338], [0x1f3c6]
    ].map((codePoints) => glyph(...codePoints))
  }
]

/**
 * Inserting at the caret rather than at the end is the whole point: a message
 * already half-typed gets the emoji where the cursor is, and the cursor lands
 * after it so the next character continues from there.
 */
export function insertAtCaret(text, start, end, inserted) {
  const length = text.length
  const from = Math.max(0, Math.min(Number.isFinite(start) ? start : length, length))
  const to = Math.max(from, Math.min(Number.isFinite(end) ? end : from, length))
  return { value: `${text.slice(0, from)}${inserted}${text.slice(to)}`, caret: from + inserted.length }
}
