/**
 * Notifications are a device decision, not a room one: what lands in someone
 * else's inbox must not change what this browser does. The rules therefore live
 * here, in plain functions over plain data, so the socket handler can stay
 * short and the decisions can be tested without a DOM.
 *
 * `filter` is deliberately conservative — a silent default beats surprising a
 * guest who never asked to be pinged.
 */

const PREFS_KEY = 'inchat:notify'

const DEFAULT_PREFS = { enabled: false, sound: false, preview: true, mentionsOnly: false }

export function readNotifyPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return { ...DEFAULT_PREFS, ...saved, enabled: Boolean(saved.enabled), sound: Boolean(saved.sound), preview: saved.preview !== false, mentionsOnly: Boolean(saved.mentionsOnly) }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function saveNotifyPrefs(prefs) {
  const next = { ...DEFAULT_PREFS, ...prefs, enabled: Boolean(prefs.enabled), sound: Boolean(prefs.sound), preview: prefs.preview !== false, mentionsOnly: Boolean(prefs.mentionsOnly) }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
  } catch {
    // A device with no storage simply keeps the in-memory choice for this session.
  }
  return next
}

/**
 * Only granted or denied states are meaningful; a browser that has never been
 * asked cannot raise a notification.
 */
export function canNotify() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

export async function requestNotifyPermission() {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

export function unreadFor(messages, lastReadAt, ownUserId = null) {
  return messages.filter((message) => message.userId !== ownUserId && Number(message.ts) > Number(lastReadAt || 0)).length
}

/**
 * A message earns attention when it is not my own, it is not in the room I am
 * reading, and it passes the device filter. Blocked senders never reach here —
 * the socket layer drops them before this is called.
 */
export function shouldNotify(message, { prefs = DEFAULT_PREFS, activeRoomId = null, ownUserId = null } = {}) {
  if (!prefs.enabled || !message) return false
  if (message.userId === ownUserId) return false
  if (activeRoomId && message.room === activeRoomId) return false
  if (prefs.mentionsOnly) {
    const name = String(message.displayName || message.author || '').toLowerCase()
    const text = String(message.text || '').toLowerCase()
    if (!text.includes('@') || !name) return false
    const mentioned = text.split('@').slice(1).some((part) => part.trimStart().startsWith(name))
    if (!mentioned) return false
  }
  return true
}

export function notificationTitle(message, roomName) {
  return roomName || message.room || 'New message'
}

export function notificationBody(message, prefs) {
  if (!prefs.preview) return 'New message'
  const text = String(message.text || '').replace(/\s+/g, ' ').trim()
  // The room hands over its own view model, where the sender lives on `author`.
  const who = String(message.displayName || message.author || 'Someone')
  if (message.attachments?.length && !text) return `${who} sent ${message.attachments.length === 1 ? 'a file' : `${message.attachments.length} files`}`
  if (message.content?.type === 'poll') return `${who} started a poll: ${message.content.question}`
  if (message.content?.type === 'voice') return `${who} sent a voice message`
  return text ? `${who}: ${text.slice(0, 120)}` : `${who} sent a message`
}

export function openNotification(message, { onOpenRoom } = {}) {
  const handle = new Notification(notificationTitle(message), {
    body: notificationBody(message, readNotifyPrefs()),
    tag: message.id || message.clientId || undefined,
    icon: '/inchat-logo.png',
    silent: true
  })
  handle.addEventListener('click', () => {
    window.focus()
    if (typeof onOpenRoom === 'function' && message.room) onOpenRoom(message.room)
    handle.close()
  })
  return handle
}

let chimeContext = null

/** Two short tones: attention without a sound file to ship or fetch. */
export function playChime() {
  const AudioCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioCtor) return false
  try {
    chimeContext ||= new AudioCtor()
    if (chimeContext.state === 'suspended') chimeContext.resume?.()
    const now = chimeContext.currentTime
    ;[{ freq: 660, at: 0 }, { freq: 880, at: 0.12 }].forEach(({ freq, at }) => {
      const osc = chimeContext.createOscillator()
      const gain = chimeContext.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + at)
      gain.gain.exponentialRampToValueAtTime(0.035, now + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.16)
      osc.connect(gain).connect(chimeContext.destination)
      osc.start(now + at)
      osc.stop(now + at + 0.18)
    })
    return true
  } catch {
    return false
  }
}
