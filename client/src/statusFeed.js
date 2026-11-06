/**
 * The 24-hour status feed (P8). A status is one card that dies on its own: the
 * server already stamps `expiresAt`, so everything here reads that deadline
 * instead of starting a second clock the browser could drift away from.
 */

/** Same eight values the server will accept; anything else is rejected on POST. */
export const STATUS_PALETTE = Object.freeze([
  { hex: '#f2c94c', name: 'Amber' },
  { hex: '#f97316', name: 'Orange' },
  { hex: '#fb7185', name: 'Coral' },
  { hex: '#f472b6', name: 'Pink' },
  { hex: '#a78bfa', name: 'Violet' },
  { hex: '#60a5fa', name: 'Sky' },
  { hex: '#22d3ee', name: 'Cyan' },
  { hex: '#34d399', name: 'Mint' }
])

export const STATUS_TEXT_MAX = 200

const MINUTE_MS = 60000

/**
 * The countdown is deliberately coarse - people read "6h left", not a clock -
 * and it never counts down past zero into a negative number. Rounding to whole
 * minutes first is what stops 23h 59m 59s from reading as "23h 60m left".
 */
export function timeLeftLabel(remainingMs) {
  const left = Math.max(0, Number(remainingMs) || 0)
  if (left < MINUTE_MS) return 'Expires in under a minute'
  const totalMinutes = Math.round(left / MINUTE_MS)
  if (totalMinutes >= 24 * 60) return 'Less than a day left'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours}h ${minutes}m left` : `${minutes}m left`
}

export const isLive = (status, now = Date.now()) => Number(status?.expiresAt) > now

export const hasUnseen = (list, now = Date.now()) => (Array.isArray(list) ? list : [])
  .some((status) => !status.mine && !status.viewedByMe && isLive(status, now))

export function pickColor(hex) {
  const found = STATUS_PALETTE.find((entry) => entry.hex === hex)
  return found ? found.hex : STATUS_PALETTE[0].hex
}

/** A card whose author is me is managed separately from the feed. */
export function groupFeed(statuses, now = Date.now()) {
  const live = (Array.isArray(statuses) ? statuses : []).filter((status) => isLive(status, now))
  const byNewest = (a, b) => Number(b.createdAt) - Number(a.createdAt)
  const mine = live.filter((status) => status.mine).sort(byNewest)
  const others = live.filter((status) => !status.mine)
  const unseen = others.filter((status) => !status.viewedByMe).sort(byNewest)
  const seen = others.filter((status) => status.viewedByMe).sort(byNewest)
  return { mine, unseen, seen }
}

/** Text cards keep the author's line; media cards say what they hold. */
export function cardSummary(status) {
  if (status.kind === 'text') return status.text || ''
  if (status.kind === 'video') return status.media?.name || 'Video status'
  return status.media?.name || 'Photo status'
}

/**
 * The reader walks cards oldest first, so a card posted an hour ago is spent
 * before a fresh one - the same order the feed is listed in.
 */
export function playOrder(statuses, now = Date.now()) {
  return (Array.isArray(statuses) ? statuses : [])
    .filter((status) => isLive(status, now))
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
}

export function nextInPlay(ordered, id) {
  const at = ordered.findIndex((status) => status.id === id)
  return at === -1 ? null : (ordered[at + 1] || null)
}

export function viewersLabel(count) {
  const n = Number(count) || 0
  if (n === 0) return 'No one has seen this yet'
  return `Seen by ${n} ${n === 1 ? 'person' : 'people'}`
}

/** Only the author may open the viewer list, so nobody else gets the button. */
export function canReadViewers(status) {
  return Boolean(status && status.mine && Number(status.viewerCount) > 0)
}

/** The file a status may carry, decided from its type rather than its name. */
export function mediaKind(file) {
  const type = String(file?.type || '')
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  return null
}
