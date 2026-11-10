/**
 * ICE servers are fetched once at boot and reused, so starting a call never
 * waits on /api/rtc-config. TURN credentials live ten minutes; the cache stops
 * handing them out after eight and refreshes in the background before that.
 */
export const ICE_FALLBACK = [{ urls: 'stun:stun.l.google.com:19302' }]
export const ICE_REFRESH_AFTER_MS = 7 * 60 * 1000
export const ICE_USABLE_FOR_MS = 8 * 60 * 1000
const REQUEST_TIMEOUT_MS = 2500

let cached = null
let inflight = null

function usableList(value) {
  return Array.isArray(value) && value.length > 0
}

async function fetchIceServers(userId) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch('/api/rtc-config', {
      headers: { 'X-Session-Id': userId },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) return null
    const config = await response.json()
    return usableList(config?.iceServers) ? config.iceServers : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** The servers a call may use right now, or null when nothing usable is cached. */
export function readIceServers(session, now = Date.now()) {
  if (!session?.userId || !cached || cached.userId !== session.userId) return null
  if (now - cached.fetchedAt > ICE_USABLE_FOR_MS) return null
  return cached.iceServers
}

/**
 * Refreshes the cache when it is missing, old, or belongs to another guest.
 * Concurrent calls share one request; a failed request is retried next time.
 */
export function primeIceConfig(session, now = Date.now()) {
  if (!session?.userId) return Promise.resolve(null)
  const fresh = readIceServers(session, now)
  if (fresh && now - cached.fetchedAt < ICE_REFRESH_AFTER_MS) return Promise.resolve(fresh)
  if (inflight && inflight.userId === session.userId) return inflight.promise

  const userId = session.userId
  const promise = fetchIceServers(userId)
    .then((iceServers) => {
      if (iceServers) cached = { userId, iceServers, fetchedAt: Date.now() }
      return iceServers || fresh || ICE_FALLBACK
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
  inflight = { userId, promise }
  return promise
}

/** Test hook: a fresh guest/room must never inherit another guest's cache. */
export function resetIceCache() {
  cached = null
  inflight = null
}
