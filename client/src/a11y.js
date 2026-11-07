/**
 * The arithmetic behind two keyboard patterns the app had the markup for but
 * not the behaviour: a modal that keeps Tab inside itself, and a menu that
 * moves focus with the arrow keys. They are pure on purpose - the DOM walking
 * lives in App.jsx, so the interesting part (what index a key press lands on)
 * can be asserted without a browser.
 */

/**
 * Everything a keyboard user can land on. `tabindex="-1"` is excluded because
 * it means "focusable by script only", which is exactly what a trap must not
 * treat as a stop.
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Disabled controls and hidden ones are not stops, even when they match the selector. */
export function isUsable(element) {
  if (!element || element.disabled) return false
  if (element.getAttribute('aria-hidden') === 'true') return false
  return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
}

/**
 * Where Tab lands next inside a dialog. The list is the dialog's own focusable
 * controls, so leaving it is not an option: from the last item Tab wraps to the
 * first, and Shift+Tab from the first goes to the last.
 */
export function trapTarget({ count, from, shift }) {
  const total = Number.isInteger(count) ? count : 0
  if (total <= 0) return null
  if (!Number.isInteger(from) || from < 0 || from >= total) return shift ? total - 1 : 0
  return (from + (shift ? -1 : 1) + total) % total
}

/**
 * What a dialog should take focus to when it opens. The close button is usually
 * the first control in the markup, but the field the user came to fill in is
 * the reason the dialog is open, so a text-entry control wins when there is
 * one. Toggles are excluded: a settings sheet is full of switches, and parking
 * the cursor on one of them is not the same as handing over a field.
 */
const TEXT_ENTRY_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number'])

export function preferredFocus(elements) {
  if (!Array.isArray(elements) || !elements.length) return null
  const editable = elements.findIndex((element) => {
    const tag = String(element?.tagName || '').toLowerCase()
    if (tag === 'textarea' || tag === 'select') return true
    if (tag !== 'input') return false
    return TEXT_ENTRY_TYPES.has(String(element.type || 'text').toLowerCase())
  })
  return editable >= 0 ? editable : 0
}

/**
 * A menu moves focus with the arrows and stops at the ends of the list, which
 * is what makes it different from a page of tab stops. `from` is the index of
 * the focused item, or -1 when the menu has just opened and nothing is focused
 * yet - ArrowUp from there means "the last item", not an error.
 */
export function menuTarget({ count, from, key }) {
  const total = Number.isInteger(count) ? count : 0
  if (total <= 0) return null
  const current = Number.isInteger(from) && from >= 0 && from < total ? from : -1
  switch (key) {
    case 'ArrowDown': return current < 0 ? 0 : (current + 1) % total
    case 'ArrowUp': return current < 0 ? total - 1 : (current - 1 + total) % total
    case 'Home': return 0
    case 'End': return total - 1
    default: return null
  }
}
