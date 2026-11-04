import { io } from 'socket.io-client'

const GUEST_KEY = 'inchat:guest'
const ROOMS_KEY = 'inchat:rooms'
const LEGACY_USER_KEY = 'chat:userId'
const LEGACY_NAME_KEY = 'chat:displayName'
const LEGACY_ROOM_KEY = 'chat:room'

export function readGuest() {
  try {
    const saved = JSON.parse(localStorage.getItem(GUEST_KEY) || 'null')
    if (saved?.userId && saved?.displayName) return saved
  } catch {
    localStorage.removeItem(GUEST_KEY)
  }
  const userId = localStorage.getItem(LEGACY_USER_KEY)
  const displayName = localStorage.getItem(LEGACY_NAME_KEY)
  return userId && displayName ? { userId, displayName } : null
}

export function readRooms() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROOMS_KEY) || '[]')
    if (Array.isArray(saved)) return saved.filter((room) => typeof room?.id === 'string' && typeof room?.name === 'string')
  } catch {
    localStorage.removeItem(ROOMS_KEY)
  }
  const oldRoom = localStorage.getItem(LEGACY_ROOM_KEY)
  return oldRoom ? [roomSummary(oldRoom)] : []
}

export function saveGuest(session) {
  localStorage.setItem(GUEST_KEY, JSON.stringify(session))
  localStorage.setItem(LEGACY_USER_KEY, session.userId)
  localStorage.setItem(LEGACY_NAME_KEY, session.displayName)
}

export function sessionHeaders(session) {
  return {
    'X-Session-Id': session.userId,
    'X-Session-Token': session.sessionToken
  }
}

export function saveRooms(rooms) {
  localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms))
}

/** Forgets the guest identity on this device. Rooms stay so the list is not lost. */
export function clearGuest() {
  localStorage.removeItem(GUEST_KEY)
  localStorage.removeItem(LEGACY_USER_KEY)
  localStorage.removeItem(LEGACY_NAME_KEY)
}

/** Drops one room from this device's list; the room itself keeps existing. */
export function forgetRoom(roomId) {
  const next = readRooms().filter((room) => room.id !== roomId)
  saveRooms(next)
  if (localStorage.getItem(LEGACY_ROOM_KEY) === roomId) localStorage.removeItem(LEGACY_ROOM_KEY)
  return next
}

export async function saveNote(session, text) {
  const response = await fetch('/api/me/note', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...sessionHeaders(session) },
    body: JSON.stringify({ text })
  })
  if (response.status === 401) throw new Error('Your session expired. Join a room again to refresh it.')
  if (!response.ok) {
    const result = await response.json().catch(() => ({}))
    // The API puts the rejection reason in `error` for 4xx responses.
    if (typeof result.error === 'string' && result.error !== 'internal_error') throw new Error(result.error)
    throw new Error('Could not save your about note.')
  }
  const result = await response.json().catch(() => ({}))
  return { text: result.note?.text || text, updatedAt: result.note?.updatedAt || Date.now() }
}

export function normalizeRoomName(value) {
  const room = value.trim().replace(/\s+/g, '-').toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(room)) {
    throw new Error('Use 1–64 letters, numbers, dots, dashes or underscores. Spaces become dashes.')
  }
  return room
}

export function roomSummary(roomId) {
  const normalized = normalizeRoomName(roomId)
  const name = normalized.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
  return {
    id: normalized,
    room: normalized,
    name,
    username: `#${normalized}`,
    initials: initials || '#',
    color: 'teal',
    message: 'Room is ready — say hello.',
    time: 'Now',
    unread: 0,
    online: false,
    group: true
  }
}

export async function resolveGuest(displayName) {
  const name = displayName.trim()
  if (name.length < 2 || name.length > 32) throw new Error('Display name must be 2–32 characters.')
  const cached = readGuest()
  if (cached?.displayName === name && cached.sessionToken) {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(cached.userId)}`, {
        headers: sessionHeaders(cached)
      })
      if (response.ok) {
        const session = { ...(await response.json()), sessionToken: cached.sessionToken }
        saveGuest(session)
        return session
      }
    } catch {
      // A fresh session below is the safe recovery path for an expired cache.
    }
  }

  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: name })
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (result.error === 'rate_limited') throw new Error('Too many guest sessions were started. Wait a moment and try again.')
    throw new Error(result.message || 'Could not start a guest chat. Please try again.')
  }
  saveGuest(result)
  return result
}

export function connectRoom(session, room) {
  return io({
    auth: { userId: session.userId, sessionToken: session.sessionToken, room },
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000
  })
}

/**
 * The updates page is not a room, so it holds a socket with no room in the
 * handshake. The server only auto-joins when a room arrives with the packet,
 * which leaves a connection that hears the global broadcasts and nothing else.
 */
export function connectFeed(session) {
  return connectRoom(session, null)
}

/* ------------------------------------------------------------------ *
 * Chat settings (P2). Every value here belongs to the signed-in guest
 * only; the server keys them by session id, so one device can never
 * clear, delete or block away somebody else's conversation.
 * ------------------------------------------------------------------ */

export const CHAT_THEMES = [
  { id: 'default', label: 'Room default' },
  { id: 'forest', label: 'Forest' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'paper', label: 'Paper' }
]

async function settingsRequest(path, session, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { ...sessionHeaders(session), ...(init.body ? { 'Content-Type': 'application/json' } : {}) }
  })
  if (response.status === 401) throw new Error('Your session expired. Join a room again to refresh it.')
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const reason = typeof result.error === 'string' && result.error !== 'internal_error' ? result.error : null
    const messages = {
      password_required: 'Set a room password with at least 8 characters.',
      room_password_required: 'Enter the correct password for this room.',
      invalid_password: 'That room password does not match.',
      not_your_room: "You cannot enter another guest's private room."
    }
    throw new Error(messages[reason] || reason || 'Could not change your chat settings. Please try again.')
  }
  return result
}

const roomPath = (room, suffix = '') => `/api/rooms/${encodeURIComponent(room)}${suffix}`

export async function checkRoomAccess(session, room) {
  const result = await settingsRequest(roomPath(room, '/access'), session)
  return Boolean(result.authorized)
}

export async function authorizeRoom(session, room, password = '') {
  const result = await settingsRequest(roomPath(room, '/access'), session, {
    method: 'POST',
    body: JSON.stringify(password ? { password } : {})
  })
  return result
}

/** One round trip for everything the room needs to render this guest's view. */
export async function fetchChatSettings(session, room) {
  const [settings, blocks] = await Promise.all([
    settingsRequest(roomPath(room, '/settings'), session),
    settingsRequest('/api/me/blocks', session)
  ])
  return {
    blocked: blocks.blocked || [],
    clearedAt: Number(settings.clearedAt) || 0,
    theme: settings.theme || 'default',
    hidden: Array.isArray(settings.hidden) ? settings.hidden : []
  }
}

export async function blockGuest(session, target) {
  const result = await settingsRequest('/api/me/blocks', session, {
    method: 'POST',
    body: JSON.stringify({ userId: target.userId, displayName: target.displayName })
  })
  return result.blocked || []
}

export async function unblockGuest(session, userId) {
  const result = await settingsRequest(`/api/me/blocks/${encodeURIComponent(userId)}`, session, { method: 'DELETE' })
  return result.blocked || []
}

export async function saveRoomTheme(session, room, theme) {
  const result = await settingsRequest(roomPath(room, '/settings/theme'), session, {
    method: 'PUT',
    body: JSON.stringify({ theme })
  })
  return result.theme || theme
}

export async function clearChatForMe(session, room) {
  const result = await settingsRequest(roomPath(room, '/clear'), session, { method: 'POST' })
  return { clearedAt: Number(result.clearedAt) || Date.now(), hidden: result.hidden || [] }
}

export async function deleteMessagesForMe(session, room, ids) {
  const result = await settingsRequest(roomPath(room, '/messages/hide'), session, {
    method: 'POST',
    body: JSON.stringify({ ids })
  })
  return result.hidden || ids
}

/** Only a self room is emptied for everyone; a shared room loses this guest's view. */
export async function deleteChatForMe(session, room) {
  const result = await settingsRequest(roomPath(room), session, { method: 'DELETE' })
  return { selfRoomDeleted: Boolean(result.deleted), removed: Number(result.removed) || 0 }
}

/**
 * Re-reads the room after a setting changes. While an author was blocked the
 * server skipped this device on the wire, so those rows are missing locally;
 * reading history again brings them back.
 */
export async function fetchRoomMessages(session, room) {
  const result = await settingsRequest(roomPath(room, '/messages'), session)
  return Array.isArray(result.messages) ? result.messages : []
}

/* ------------------------------------------------------------------ *
 * Profile (P3): name, about note and one picture. The picture upload is
 * multipart, so it cannot reuse the JSON header helper - FormData must
 * set its own boundary.
 * ------------------------------------------------------------------ */

async function profileRequest(path, session, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { ...sessionHeaders(session), ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }
  })
  if (response.status === 401) throw new Error('Your session expired. Join a room again to refresh it.')
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const reason = typeof result.error === 'string' && result.error !== 'internal_error' ? result.error : null
    throw new Error(reason || 'Could not change your profile.')
  }
  return result
}

export async function fetchMyProfile(session) {
  const result = await profileRequest('/api/me/profile', session)
  return result.profile
}

export async function uploadAvatar(session, file) {
  const form = new FormData()
  form.append('files', file, file.name || 'profile-picture')
  const result = await profileRequest('/api/me/avatar', session, { method: 'PUT', body: form })
  return result.avatar
}

export async function removeAvatar(session) {
  return profileRequest('/api/me/avatar', session, { method: 'DELETE' })
}

/** Sender pictures for the guests this room mentions, in one capped batch. */
export async function fetchProfiles(session, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (!ids.length) return {}
  const result = await profileRequest(`/api/profiles?ids=${encodeURIComponent(ids.join(','))}`, session)
  const byId = {}
  for (const row of result.profiles || []) byId[row.userId] = row
  return byId
}

/* ------------------------------------------------------------------ *
 * Call history (P7) and statuses (P8). Both are the guest's own data, so
 * they ride the session header like every other personal route.
 * ------------------------------------------------------------------ */

async function feedRequest(path, session, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { ...sessionHeaders(session), ...(init.body ? { 'Content-Type': 'application/json' } : {}) }
  })
  if (response.status === 401) throw new Error('Your session expired. Join a room again to refresh it.')
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const reason = typeof result.error === 'string' && result.error !== 'internal_error' ? result.error : null
    throw new Error(reason || 'Could not reach your feed. Please try again.')
  }
  return result
}

export async function fetchCallHistory(session) {
  const result = await feedRequest('/api/calls', session)
  return Array.isArray(result.calls) ? result.calls : []
}

export async function clearCallHistory(session) {
  return feedRequest('/api/calls', session, { method: 'DELETE' })
}

export async function fetchStatuses(session) {
  const result = await feedRequest('/api/statuses', session)
  return Array.isArray(result.statuses) ? result.statuses : []
}

export async function postTextStatus(session, card) {
  return feedRequest('/api/statuses', session, { method: 'POST', body: JSON.stringify(card) })
}

export async function postMediaStatus(session, media) {
  return feedRequest('/api/statuses', session, {
    method: 'POST',
    body: JSON.stringify({ kind: media.kind, mediaId: media.id })
  })
}

export async function deleteStatus(session, id) {
  return feedRequest(`/api/statuses/${encodeURIComponent(id)}`, session, { method: 'DELETE' })
}

/** One call per card per device: the server ignores a guest viewing twice. */
export async function markStatusSeen(session, id) {
  return feedRequest(`/api/statuses/${encodeURIComponent(id)}/view`, session, { method: 'POST' })
}

export async function fetchStatusViewers(session, id) {
  const result = await feedRequest(`/api/statuses/${encodeURIComponent(id)}/viewers`, session)
  return Array.isArray(result.viewers) ? result.viewers : []
}

/**
 * Statuses carry a file through the same /api/media endpoint chat uses, so a
 * card reuses the upload path rather than inventing a second one.
 */
export async function uploadStatusMedia(session, file) {
  const form = new FormData()
  form.append('files', file, file.name || 'status')
  const response = await fetch('/api/media', { method: 'POST', headers: sessionHeaders(session), body: form })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !Array.isArray(result.media) || !result.media.length) {
    throw new Error(result.error === 'file_too_large' ? 'That file is larger than the upload limit.' : 'Could not upload that file.')
  }
  return result.media[0]
}
