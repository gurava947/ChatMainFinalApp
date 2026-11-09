/**
 * Appearance choices that are not the light/dark theme. They are applied to
 * <html> before the first paint (theme-boot.js reads the same keys), so a
 * returning guest never sees the default accent flash and then change.
 */

const ACCENT_KEY = 'inchat-accent'
const MOTION_KEY = 'inchat-motion'

/** Each accent carries its own dark-mode pair; a single hex would fail contrast. */
export const ACCENTS = [
  { id: 'teal', label: 'Teal', light: '#0d9488', deep: '#08766e' },
  { id: 'indigo', label: 'Indigo', light: '#4f46e5', deep: '#4338ca' },
  { id: 'rose', label: 'Rose', light: '#be123c', deep: '#9f1239' },
  { id: 'amber', label: 'Amber', light: '#b45309', deep: '#92400e' },
  { id: 'sky', label: 'Sky', light: '#0284c7', deep: '#075985' },
  { id: 'plum', label: 'Plum', light: '#9333ea', deep: '#6b21a8' },
]

const ACCENT_IDS = new Set(ACCENTS.map((entry) => entry.id))

function read(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A device without storage keeps the choice for this session only.
  }
}

export function readAccent() {
  const stored = read(ACCENT_KEY)
  return ACCENT_IDS.has(stored) ? stored : 'teal'
}

export function saveAccent(accent) {
  const next = ACCENT_IDS.has(accent) ? accent : 'teal'
  write(ACCENT_KEY, next)
  applyAccent(next)
  return next
}

export function applyAccent(accent) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.accent = ACCENT_IDS.has(accent) ? accent : 'teal'
}

/** "Reduced" means the guest asked for less motion, not the OS preference. */
export function readMotion() {
  return read(MOTION_KEY) === 'reduced'
}

export function saveMotion(reduced) {
  const next = Boolean(reduced)
  write(MOTION_KEY, next ? 'reduced' : 'full')
  applyMotion(next)
  return next
}

export function applyMotion(reduced) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.motion = reduced ? 'reduced' : 'full'
}

export function applyPreferences() {
  applyAccent(readAccent())
  applyMotion(readMotion())
}
