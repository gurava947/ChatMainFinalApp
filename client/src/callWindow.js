/**
 * A call window has to stay usable while the chat underneath it keeps moving:
 * docked in the middle, floating over the messages, or shrunk to a bar so the
 * guest can keep typing during the call. All of that is pure geometry, so it
 * lives here where it can be reasoned about without a DOM — the component only
 * decides *when* to call these, never what the maths is.
 */

const PREFS_KEY = 'inchat:call-window'

export const WINDOW_MODES = ['docked', 'floating', 'minimized']

const GUTTER = 8
const MINIMIZED = { width: 260, height: 64 }
const MIN_SIZE = { width: 260, height: 200 }
const MAX_SIZE = { width: 900, height: 900 }

export function readWindowMode() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return WINDOW_MODES.includes(saved.mode) ? saved.mode : 'docked'
  } catch {
    return 'docked'
  }
}

export function saveWindowMode(mode) {
  const next = WINDOW_MODES.includes(mode) ? mode : 'docked'
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readStoredFrame(), mode: next }))
  } catch {
    // A device with no storage still gets a working window for this call.
  }
  return next
}

function readStoredFrame() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

export function readWindowFrame() {
  const stored = readStoredFrame()
  const frame = {}
  if (Number.isFinite(stored.width)) frame.width = clamp(stored.width, MIN_SIZE.width, MAX_SIZE.width)
  if (Number.isFinite(stored.height)) frame.height = clamp(stored.height, MIN_SIZE.height, MAX_SIZE.height)
  if (Number.isFinite(stored.left)) frame.left = stored.left
  if (Number.isFinite(stored.top)) frame.top = stored.top
  return frame
}

export function saveWindowFrame(frame) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readStoredFrame(), ...frame }))
  } catch {
    // Frame persistence is a convenience; losing it must not break the call.
  }
  return frame
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high)
}

export function defaultFrame(mode, viewport) {
  if (mode === 'minimized') return { ...MINIMIZED, left: Math.round((viewport.width - MINIMIZED.width) / 2), top: viewport.height - MINIMIZED.height - 24 }
  if (mode === 'floating') {
    const stored = readWindowFrame()
    const width = stored.width || 260
    const height = stored.height || 200
    return { width, height, left: viewport.width - width - 16, top: stored.top ?? 96 }
  }
  const stored = readWindowFrame()
  const width = stored.width || clamp(Math.round(viewport.width * 0.42), 300, 460)
  const height = stored.height || clamp(Math.round(viewport.height * 0.66), 360, 680)
  return { width, height, left: Math.round((viewport.width - width) / 2), top: Math.round((viewport.height - height) / 2) }
}

export function clampToViewport(frame, viewport) {
  const width = clamp(frame.width, MIN_SIZE.width, Math.min(MAX_SIZE.width, viewport.width - GUTTER * 2))
  const height = clamp(frame.height, MIN_SIZE.height, Math.min(MAX_SIZE.height, viewport.height - GUTTER * 2))
  return {
    width,
    height,
    left: clamp(frame.left, GUTTER, Math.max(GUTTER, viewport.width - width - GUTTER)),
    top: clamp(frame.top, GUTTER, Math.max(GUTTER, viewport.height - height - GUTTER)),
  }
}

/** Dragging keeps the pointer's grab offset, so the window never jumps under the cursor. */
export function movedFrame(frame, delta, viewport) {
  return clampToViewport({ ...frame, left: frame.left + delta.x, top: frame.top + delta.y }, viewport)
}

/** Resizing anchors the top-left corner, so the head the guest grabbed stays put. */
export function resizedFrame(frame, delta, viewport) {
  return clampToViewport({ ...frame, width: frame.width + delta.x, height: frame.height + delta.y }, viewport)
}

export function frameStyle(frame, mode) {
  if (mode === 'docked') return undefined
  return { left: `${Math.round(frame.left)}px`, top: `${Math.round(frame.top)}px`, width: `${Math.round(frame.width)}px`, height: `${Math.round(frame.height)}px` }
}

/** A call that has not connected yet has no duration to show. */
export function callDuration(startedAt, now = Date.now()) {
  if (!Number.isFinite(startedAt) || now < startedAt) return '0:00'
  const total = Math.floor((now - startedAt) / 1000)
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** Pointer events carry clientX/clientY; touch fallback keeps a phone dragging. */
export function pointerPoint(event) {
  const point = event.touches?.[0] || event.changedTouches?.[0] || event
  return { x: Number(point.clientX) || 0, y: Number(point.clientY) || 0 }
}

export function dragDelta(startPoint, currentPoint) {
  return { x: currentPoint.x - startPoint.x, y: currentPoint.y - startPoint.y }
}

export function viewportSize() {
  return { width: window.innerWidth || 1024, height: window.innerHeight || 768 }
}
