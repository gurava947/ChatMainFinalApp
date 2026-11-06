/**
 * The browser's own copy of this device's chat.
 *
 * IndexedDB is the primary store here, not a cache in front of nothing: it is
 * what a reload, a phone that reclaimed the tab, or an hour in a tunnel leaves
 * you with. Everything in it is a *copy* of state the server also holds or would
 * happily resend, so a wipe costs comfort and history, never the conversation.
 * The one exception is the outbox - a message that has not been accepted exists
 * nowhere else on earth, and it is the last thing any path here removes.
 *
 * LocalStorage is deliberately not used for any of it. It is synchronous,
 * string-only, capped near 5 MB by every browser, and a write of it blocks the
 * frame it happens in. The small identity and preference keys that do live there
 * stay in `roomChat.js`.
 */

export const DB_NAME = 'inchat-local'
/** Every bump needs a matching branch in `upgrade`, and every branch only adds. */
export const DB_VERSION = 1

export const STORE_MESSAGES = 'messages'
export const STORE_ROOMS = 'rooms'
export const STORE_PROFILES = 'profiles'
export const STORE_CALLS = 'calls'
export const STORE_OUTBOX = 'outbox'
export const STORE_MEDIA = 'media'
export const STORE_META = 'meta'

const SEQ_INDEX = 'byRoomSeq'
const CLIENT_INDEX = 'byRoomClient'
const MEDIA_TIME_INDEX = 'byStoredAt'

/**
 * Sequences the store mints start at 1 and never exceed what a JS integer can
 * count safely, so these two end a range without inventing a sentinel that could
 * collide with a real row. `Infinity` is a legal IndexedDB key in Chrome and
 * Firefox and has no business being persisted, which is why it is not used.
 */
export const MIN_SEQ = 1
export const MAX_SEQ = Number.MAX_SAFE_INTEGER

/**
 * The newest rows of a room that cleanup may never touch. Retention is allowed
 * to reclaim a boring old tail; it is not allowed to be the reason the last
 * screen of a conversation vanished.
 */
export const PINNED_PER_ROOM = 60

/** Roughly one month of attachments, three months of transcript. */
export const DEFAULT_MEDIA_TTL_MS = 30 * 24 * 3600 * 1000
export const DEFAULT_MESSAGE_TTL_MS = 90 * 24 * 3600 * 1000

let dbPromise = null
let lastError = null

export function supportsLocalStore() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

/** Indexed for the same reason a console is: a null return says only "no". */
export function localStoreError() {
  return lastError
}

/**
 * Opens the database once per page and hands every caller the same handle.
 *
 * A failure is remembered and then cleared so the next call may try again: a
 * database blocked by another tab becomes available the moment that tab closes,
 * and the app must not spend the rest of the session believing otherwise. Every
 * public call here resolves to an empty result rather than rejecting when there
 * is no store, because a browser that refuses IndexedDB - Safari in private mode,
 * Firefox with disk space disabled - still has to be able to chat.
 */
export function openLocalStore() {
  if (!supportsLocalStore()) return Promise.resolve(null)
  if (!dbPromise) {
    dbPromise = openDatabase().catch((error) => {
      dbPromise = null
      lastError = error
      return null
    })
  }
  return dbPromise
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      upgrade(event.target.result, event.oldVersion)
    }
    request.onsuccess = () => {
      const db = request.result
      // Another tab opening a newer build closes this handle. A transaction on a
      // closed handle throws for every later write, so the cache has to drop it.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      db.onclose = () => {
        dbPromise = null
      }
      lastError = null
      resolve(db)
    }
    request.onerror = () => reject(request.error || new Error('the local store could not be opened'))
    request.onblocked = () => reject(new Error('the local store is being upgraded in another tab'))
  })
}

function upgrade(db, oldVersion) {
  if (oldVersion >= 1) return
  const messages = db.createObjectStore(STORE_MESSAGES, { keyPath: ['room', 'id'] })
  messages.createIndex(SEQ_INDEX, ['room', 'seq'])
  messages.createIndex(CLIENT_INDEX, ['room', 'clientId'])
  db.createObjectStore(STORE_ROOMS, { keyPath: 'room' })
  db.createObjectStore(STORE_PROFILES, { keyPath: 'userId' })
  db.createObjectStore(STORE_CALLS, { keyPath: 'id' })
  db.createObjectStore(STORE_OUTBOX, { keyPath: 'clientId' })
  db.createObjectStore(STORE_MEDIA, { keyPath: 'id' }).createIndex(MEDIA_TIME_INDEX, 'storedAt')
  db.createObjectStore(STORE_META, { keyPath: 'key' })
}

/** Releases the handle. A sign-out or a test is the only thing that needs it. */
export function closeLocalStore() {
  const pending = dbPromise
  dbPromise = null
  if (!pending) return Promise.resolve()
  return pending.then((db) => {
    if (db) db.close()
  })
}

/**
 * Drops every record this page wrote.
 *
 * When the device stops being yours the identity goes from localStorage, and a
 * transcript left behind under it is readable by whoever signs in next. The only
 * way to be sure it is gone is to delete the database, not to walk it.
 */
export function wipeLocalStore() {
  return closeLocalStore().then(() => new Promise((resolve) => {
    if (!supportsLocalStore()) {
      resolve()
      return
    }
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    // Blocked means an older tab still holds it; the deletion lands when that
    // handle closes, which is the same outcome the caller wants.
    request.onblocked = () => resolve()
  }))
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('the local store rejected that request'))
  })
}

/**
 * A sequence, or null.
 *
 * `Number(null)` is 0 and 0 is a legal sequence, so a plain coercion would let an
 * un-acknowledged row into the store under a number it never had - invisible to
 * every read, and unreclaimable by anything that looks for a real sequence.
 */
function sequenceOf(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function roomSeqRange(room, from = MIN_SEQ, to = MAX_SEQ) {
  return IDBKeyRange.bound([room, from], [room, to])
}

/**
 * Runs one transaction and resolves when it has *committed*.
 *
 * The commit event is the point, not the request's own success: a `put` can
 * report itself fine and the transaction still abort afterwards, and that is
 * exactly how a `QuotaExceededError` presents - the write that tips the device
 * over its limit is rarely the one that fails. Anything that has to know whether
 * a row really survived waits here.
 */
function transact(storeNames, mode, work) {
  return openLocalStore().then((db) => {
    if (!db) return null
    const names = Array.isArray(storeNames) ? storeNames : [storeNames]
    return new Promise((resolve, reject) => {
      let tx
      try {
        tx = db.transaction(names, mode)
      } catch (error) {
        reject(error)
        return
      }
      let outcome
      try {
        outcome = work(names.length === 1 ? tx.objectStore(names[0]) : tx)
      } catch (error) {
        reject(error)
        return
      }
      /**
       * A write that fails outright - a value the database cannot clone, which is
       * how an oversized or non-serialisable record shows up - throws before the
       * commit event ever arrives. Observing it here keeps that failure from being
       * reported as an unhandled rejection; `resolve(outcome)` below still turns it
       * into the rejection the caller sees.
       */
      if (outcome && typeof outcome.then === 'function') outcome.catch(() => {})
      tx.oncomplete = () => resolve(outcome)
      tx.onabort = () => reject(tx.error || new Error('the local store transaction was aborted'))
      tx.onerror = () => reject(tx.error || new Error('the local store transaction failed'))
    })
  })
}

/**
 * Names the one storage failure this app can act on.
 *
 * Engines disagree about the exception type - `QuotaExceededError` in Chrome,
 * `NS_ERROR_DOM_QUOTA_REACHED` surfaced as an `UnknownError` in Firefox - so the
 * message is read as well as the name. Anything else stays an ordinary error
 * instead of being relabelled as disk pressure.
 */
export function isQuotaError(error) {
  if (!error) return false
  const name = String(error.name || '')
  const message = String(error.message || '')
  return /quota/i.test(name) || /quota/i.test(message)
}

export function storageAvailable() {
  return supportsLocalStore()
}

/* ------------------------------------------------------------------- messages */

export function messageRecord(room, message, storedAt) {
  return {
    room,
    id: message.id,
    clientId: message.clientId || null,
    seq: sequenceOf(message.seq),
    text: message.text || '',
    time: message.time,
    ts: Number(message.ts) || storedAt,
    userId: message.userId,
    sender: message.sender,
    author: message.author,
    content: message.content || null,
    results: message.results || null,
    seenBy: Array.isArray(message.seenBy) ? message.seenBy : [],
    deliveredTo: Array.isArray(message.deliveredTo) ? message.deliveredTo : [],
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    pending: Boolean(message.pending),
    failed: Boolean(message.failed),
    storedAt,
  }
}

/**
 * The rows that earn a place in the transcript.
 *
 * A message is stored once the server has given it a sequence, because that is
 * what makes it re-readable in order and what lets an older page be stitched
 * underneath it. An unsent or rejected row is the outbox's job, and reading only
 * sequenced rows is what keeps a page fetch a straight index walk instead of a
 * filter over two shapes of record.
 */
export function storableRows(rows) {
  return (rows || []).filter((row) => row && row.id && sequenceOf(row.seq) !== null)
}

export function mergeRecord(existing, record) {
  if (!existing) return record
  return {
    ...existing,
    ...record,
    // Whichever shape arrives second keeps what the first proved. The server's
    // echo of your own send carries no receipts yet; the stored row may.
    seq: sequenceOf(record.seq) === null ? existing.seq : record.seq,
    seenBy: record.seenBy.length ? record.seenBy : existing.seenBy,
    deliveredTo: record.deliveredTo.length ? record.deliveredTo : existing.deliveredTo,
    storedAt: existing.storedAt || record.storedAt,
  }
}

/**
 * Writes a page, a live message or an ack patch - all one shape - and reports the
 * counts.
 *
 * Two kinds of duplicate are handled. The easy one is the same row twice, which
 * the compound key turns into an overwrite. The one that actually shows up is
 * your own message: it enters the transcript under a `clientId` this device made
 * up and comes back under the id the server chose, so the earlier key is removed
 * as the later one lands. Without that, a reload shows the message twice,
 * forever.
 */
export function storeMessages(room, rows) {
  const incoming = storableRows(rows)
  const skipped = (rows || []).length - incoming.length
  if (!incoming.length) return Promise.resolve({ written: 0, skipped })
  const storedAt = Date.now()
  return transact(STORE_MESSAGES, 'readwrite', (store) => {
    const records = incoming.map((row) => messageRecord(room, row, storedAt))
    return Promise.all([
      Promise.all(records.map((record) => requestResult(store.get([room, record.id])))),
      Promise.all(records.map((record) => (
        record.clientId && record.clientId !== record.id
          ? requestResult(store.get([room, record.clientId]))
          : Promise.resolve(null)
      ))),
    ]).then(([byId, byClient]) => {
      records.forEach((record, index) => {
        const stale = byClient[index]
        if (stale && stale.id !== record.id) store.delete([room, stale.id])
        store.put(mergeRecord(byId[index], record))
      })
      return { written: records.length, skipped }
    })
  }).then((result) => result || { written: 0, skipped })
}

function collectBySeq(store, range, direction, limit) {
  return new Promise((resolve, reject) => {
    const rows = []
    const request = store.index(SEQ_INDEX).openCursor(range, direction)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || rows.length >= limit) {
        resolve(direction === 'prev' ? rows.reverse() : rows)
        return
      }
      rows.push(cursor.value)
      cursor.continue()
    }
    request.onerror = () => reject(request.error || new Error('the local store could not read that page'))
  })
}

/**
 * The newest `limit` rows for a room, oldest first.
 *
 * The walk starts at the top of the index and stops when the page is full, so a
 * room that has spent most of the budget still answers in one page of work
 * rather than by reading everything and slicing.
 */
export function readMessagePage(room, options = {}) {
  const limit = Math.max(1, Number(options.limit) || 50)
  return transact(STORE_MESSAGES, 'readonly', (store) => collectBySeq(store, roomSeqRange(room), 'prev', limit))
    .then((rows) => rows || [])
}

/** The page underneath `beforeSeq`, oldest first - what "load older" asks for. */
export function readOlderMessages(room, beforeSeq, options = {}) {
  const boundary = Number(beforeSeq)
  if (!Number.isFinite(boundary) || boundary <= MIN_SEQ) return Promise.resolve([])
  const limit = Math.max(1, Number(options.limit) || 50)
  return transact(STORE_MESSAGES, 'readonly', (store) => collectBySeq(
    store,
    IDBKeyRange.bound([room, MIN_SEQ], [room, boundary], false, true),
    'prev',
    limit,
  )).then((rows) => rows || [])
}

/**
 * Everything above `sinceSeq` - the hole a dropped socket left behind.
 *
 * Capped, because a device asleep for a week should get the recent tail plus a
 * server round, not every row it happens to hold.
 */
export function readNewerMessages(room, sinceSeq, options = {}) {
  const boundary = Number(sinceSeq)
  const from = Math.max(Number.isFinite(boundary) ? boundary + 1 : MIN_SEQ, MIN_SEQ)
  if (from > MAX_SEQ) return Promise.resolve([])
  const limit = Math.max(1, Number(options.limit) || 200)
  return transact(STORE_MESSAGES, 'readonly', (store) => collectBySeq(
    store,
    IDBKeyRange.bound([room, from], [room, MAX_SEQ]),
    'next',
    limit,
  )).then((rows) => rows || [])
}

export function findMessageByClientId(room, clientId) {
  if (!clientId) return Promise.resolve(null)
  return transact(STORE_MESSAGES, 'readonly', (store) => requestResult(store.index(CLIENT_INDEX).get([room, clientId])))
    .then((row) => row || null)
}

/** "Delete message for me". The room's other seat keeps their copy. */
export function deleteMessages(room, ids) {
  const list = (ids || []).filter(Boolean)
  if (!list.length) return Promise.resolve(0)
  return transact(STORE_MESSAGES, 'readwrite', (store) => {
    list.forEach((id) => store.delete([room, id]))
    return list.length
  }).then((count) => count || 0)
}

/** "Clear chat for me": the rows go, the seat stays. */
export function deleteRoomMessages(room) {
  // The primary key is `[room, id]`, so a `[room, seq]` range would name no row
  // at all and this would silently "succeed" while clearing nothing. The index
  // is the only thing keyed by sequence; its keys are the primary keys to delete.
  return transact(STORE_MESSAGES, 'readwrite', (store) => requestResult(
    store.index(SEQ_INDEX).getAllKeys(roomSeqRange(room)),
  ).then((keys) => {
    keys.forEach((key) => store.delete(key))
    return keys.length
  })).then((count) => count || 0)
}

/* ---------------------------------------------------------------------- rooms */

export function readRoomState(room) {
  return transact(STORE_ROOMS, 'readonly', (store) => requestResult(store.get(room))).then((row) => row || null)
}

/**
 * The first and last sequence in a list of rows.
 *
 * A loop, not `Math.max(...rows.map(...))`: a transcript long enough to spread
 * over the argument list is exactly the transcript this store is built to hold,
 * and a row the server has not numbered yet contributes nothing to either end.
 */
export function seqSpan(rows) {
  let oldest = null
  let latest = null
  for (const row of rows || []) {
    const value = sequenceOf(row && row.seq)
    if (value === null) continue
    if (oldest === null || value < oldest) oldest = value
    if (latest === null || value > latest) latest = value
  }
  return { oldest, latest }
}

/**
 * Remembers how far this device's copy of a room reaches.
 *
 * `latestSeq` is what a reconnect compares against the server to find what it
 * missed; `oldestSeq` is what "load older" pages from. Both surviving a reload is
 * the point - a transcript is worth exactly as much as the cursor that says where
 * it starts and stops.
 */
export function saveRoomState(room, patch = {}) {
  return transact(STORE_ROOMS, 'readwrite', (store) => requestResult(store.get(room)).then((existing) => {
    const next = {
      room,
      latestSeq: pickNumber(patch.latestSeq, existing ? existing.latestSeq : null),
      oldestSeq: pickNumber(patch.oldestSeq, existing ? existing.oldestSeq : null),
      hydratedAt: pickNumber(patch.hydratedAt, existing ? existing.hydratedAt : null),
      updatedAt: Date.now(),
    }
    store.put(next)
    return next
  }))
}

function pickNumber(value, fallback) {
  const picked = sequenceOf(value)
  return picked === null ? sequenceOf(fallback) : picked
}

export function listRoomStates() {
  return transact(STORE_ROOMS, 'readonly', (store) => requestResult(store.getAll())).then((rows) => rows || [])
}

export function forgetRoomState(room) {
  return transact(STORE_ROOMS, 'readwrite', (store) => {
    store.delete(room)
    return true
  }).then((done) => Boolean(done))
}

/* ------------------------------------------------------------------- profiles */

/**
 * Who the author pictures and about-lines belong to.
 *
 * Every room open re-asks for the same two profiles today. Caching them means the
 * transcript paints with faces on it immediately, and it is the one store here
 * that a logout cannot leak: it is wiped with everything else.
 */
export function storeProfiles(profiles) {
  const rows = (profiles || []).filter((row) => row && row.userId)
  if (!rows.length) return Promise.resolve(0)
  const seenAt = Date.now()
  return transact(STORE_PROFILES, 'readwrite', (store) => {
    rows.forEach((row) => store.put({ ...row, seenAt }))
    return rows.length
  }).then((count) => count || 0)
}

export function readProfile(userId) {
  return transact(STORE_PROFILES, 'readonly', (store) => requestResult(store.get(userId))).then((row) => row || null)
}

export function readProfiles(userIds) {
  const list = (userIds || []).filter(Boolean)
  if (!list.length) return Promise.resolve([])
  return transact(STORE_PROFILES, 'readonly', (store) => Promise.all(
    list.map((userId) => requestResult(store.get(userId))),
  )).then((rows) => (rows || []).filter(Boolean))
}

/* ---------------------------------------------------------------------- calls */

/**
 * The call log, kept locally as well as on the server.
 *
 * The server's copy is the authority across devices; this one is what lets the
 * Calls tab paint before the first fetch returns. Entries are keyed by the id
 * both sides already carry, so a refresh updates a call instead of doubling it.
 */
export function storeCalls(calls) {
  const rows = (calls || []).filter((row) => row && row.id)
  if (!rows.length) return Promise.resolve(0)
  const storedAt = Date.now()
  return transact(STORE_CALLS, 'readwrite', (store) => {
    rows.forEach((row) => store.put({ ...row, storedAt }))
    return rows.length
  }).then((count) => count || 0)
}

export function readCalls(options = {}) {
  const limit = Math.max(1, Number(options.limit) || 100)
  return transact(STORE_CALLS, 'readonly', (store) => requestResult(store.getAll())).then((rows) => (rows || [])
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
    .slice(0, limit))
}

export function clearCalls() {
  return transact(STORE_CALLS, 'readwrite', (store) => {
    store.clear()
    return true
  }).then((done) => Boolean(done))
}

/* --------------------------------------------------------------------- outbox */

/**
 * Queues a send the network has not accepted yet.
 *
 * This is the only place in the app where a message can exist once and never
 * again, so re-queueing keeps the original attempt count and timestamp: a retry
 * that overwrote them would look, from every angle, like a message that had
 * never failed at all.
 */
export function queueOutbox(entry) {
  if (!entry || !entry.clientId || !entry.room) return Promise.resolve(null)
  const now = Date.now()
  const record = {
    room: entry.room,
    clientId: entry.clientId,
    payload: entry.payload || null,
    text: entry.text || '',
    preview: entry.preview || '',
    tries: Number(entry.tries) || 0,
    queuedAt: Number(entry.queuedAt) || now,
    updatedAt: now,
    error: entry.error || null,
  }
  return transact(STORE_OUTBOX, 'readwrite', (store) => requestResult(store.get(record.clientId)).then((existing) => {
    if (!existing) {
      store.put(record)
      return record
    }
    // An existing entry keeps its own history; only the content is refreshed. A
    // re-queue that carries no new reason must not erase the one on record.
    const merged = {
      ...existing,
      ...record,
      tries: existing.tries,
      queuedAt: existing.queuedAt,
      error: record.error || existing.error,
    }
    store.put(merged)
    return merged
  }))
}

export function readOutbox(room) {
  return transact(STORE_OUTBOX, 'readonly', (store) => requestResult(store.getAll())).then((rows) => (rows || [])
    .filter((row) => !room || row.room === room)
    .sort((a, b) => (Number(a.queuedAt) || 0) - (Number(b.queuedAt) || 0)))
}

export function bumpOutboxTries(clientId, error) {
  return transact(STORE_OUTBOX, 'readwrite', (store) => requestResult(store.get(clientId)).then((existing) => {
    if (!existing) return null
    const next = { ...existing, tries: (Number(existing.tries) || 0) + 1, updatedAt: Date.now(), error: error || existing.error }
    store.put(next)
    return next
  }))
}

/** The ack's job, and the only path here that removes a queued send. */
export function resolveOutbox(clientId) {
  return transact(STORE_OUTBOX, 'readwrite', (store) => {
    store.delete(clientId)
    return true
  }).then((done) => Boolean(done))
}

export function clearOutbox() {
  return transact(STORE_OUTBOX, 'readwrite', (store) => {
    store.clear()
    return true
  }).then((done) => Boolean(done))
}

/* ---------------------------------------------------------------------- media */

/**
 * Attachment metadata: what was shared, how big, which message carried it.
 *
 * The bytes are not duplicated here. A phone that kept every photo it had ever
 * streamed would spend its quota on cache rather than on chat, and the server
 * already answers `/media/:id` with an immutable `Cache-Control`, so the HTTP
 * cache holds the bytes and this holds the description of them - which is also
 * what lets a file's name and size stay on screen when the picture itself has
 * aged out of the browser's cache.
 */
export function storeMedia(room, rows) {
  const list = (rows || []).filter((row) => row && row.id)
  if (!list.length) return Promise.resolve(0)
  const storedAt = Date.now()
  return transact(STORE_MEDIA, 'readwrite', (store) => {
    list.forEach((row) => store.put({
      id: row.id,
      room: room || row.room || null,
      messageId: row.messageId || null,
      kind: row.kind || 'file',
      name: row.name || '',
      mime: row.mime || '',
      size: Number(row.size) || 0,
      expired: Boolean(row.expired),
      storedAt,
    }))
    return list.length
  }).then((count) => count || 0)
}

export function readMedia(id) {
  return transact(STORE_MEDIA, 'readonly', (store) => requestResult(store.get(id))).then((row) => row || null)
}

export function listMedia(options = {}) {
  const now = Number(options.now) || Date.now()
  const ttl = Number(options.olderThanMs)
  const limit = Math.max(1, Number(options.limit) || 500)
  return transact(STORE_MEDIA, 'readonly', (store) => (
    Number.isFinite(ttl)
      ? requestResult(store.index(MEDIA_TIME_INDEX).getAll(IDBKeyRange.upperBound(now - ttl)))
      : requestResult(store.getAll())
  )).then((rows) => (rows || []).slice(0, limit))
}

export function deleteMedia(ids) {
  const list = (ids || []).filter(Boolean)
  if (!list.length) return Promise.resolve(0)
  return transact(STORE_MEDIA, 'readwrite', (store) => {
    list.forEach((id) => store.delete(id))
    return list.length
  }).then((count) => count || 0)
}

/**
 * Every attachment a room described, dropped with the room.
 *
 * The bytes were never stored here, so this is bookkeeping - but bookkeeping is
 * what a guest who cleared or deleted a room expects to be gone, and it is the
 * only media row this device can name once the transcript itself has been
 * dropped. Media is keyed by the file, not the room, so there is no index to
 * walk: the store is metadata only and retention bounds how long it grows.
 */
export function deleteRoomMedia(room) {
  if (!room) return Promise.resolve(0)
  return transact(STORE_MEDIA, 'readwrite', (store) => requestResult(store.getAll()).then((rows) => {
    const mine = (rows || []).filter((row) => row && row.room === room)
    mine.forEach((row) => store.delete(row.id))
    return mine.length
  })).then((count) => count || 0)
}

/* ----------------------------------------------------------------------- meta */

export function readMeta(key) {
  return transact(STORE_META, 'readonly', (store) => requestResult(store.get(key))).then((row) => (row ? row.value : null))
}

export function writeMeta(key, value) {
  return transact(STORE_META, 'readwrite', (store) => {
    store.put({ key, value, updatedAt: Date.now() })
    return value
  })
}

/* ---------------------------------------------------------------------- quota */

/**
 * What the browser says this origin has spent and may still spend.
 *
 * These are the browser's numbers, not ours: Chrome reports a share of free disk,
 * Safari a per-origin ceiling, and neither explains a change. Anything the UI
 * says about space is derived from here and worded as an estimate, because that
 * is all it can honestly be. A quota of zero means it would not say, not that the
 * device is full.
 */
export function readUsage() {
  const empty = { supported: false, usage: 0, quota: 0, percent: 0 }
  if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function') {
    return Promise.resolve(empty)
  }
  return navigator.storage.estimate().then((info) => {
    const usage = Number(info && info.usage) || 0
    const quota = Number(info && info.quota) || 0
    return { supported: true, usage, quota, percent: quota > 0 ? Math.round((usage / quota) * 1000) / 10 : 0 }
  }).catch(() => ({ ...empty, failed: true }))
}

/**
 * Asks the browser to keep this data when the device runs low. Without it the
 * whole store can be evicted under disk pressure, silently, which is the one
 * failure mode this feature has to be able to describe to a user. Chrome answers
 * `persist()` false until the site has been interacted with; Safari has no
 * prompt and grants it on its own.
 */
export function requestPersistence() {
  const none = { supported: false, persisted: false, asked: false }
  if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') {
    return Promise.resolve(none)
  }
  const already = typeof navigator.storage.persisted === 'function' ? navigator.storage.persisted() : Promise.resolve(false)
  return Promise.all([already, navigator.storage.persist()])
    .then(([granted, next]) => ({ supported: true, persisted: Boolean(next), asked: !granted }))
    .catch(() => ({ supported: true, persisted: false, asked: true }))
}

/**
 * Frees space in a defined order and reports what went.
 *
 * Attachment metadata older than its TTL first - it describes bytes that are
 * already gone from the server anyway. Then transcript rows older than theirs,
 * and only ever outside the newest `PINNED_PER_ROOM` of a room, so cleanup can
 * never be the reason the last screen of a conversation vanished. The outbox is
 * not a candidate at any age: an unsent message is the only unrecoverable row in
 * this database.
 *
 * Everything removed is counted and returned so the caller can say so out loud.
 * Quietly deleting somebody's chat history is the outcome this module exists to
 * make impossible.
 */
export function enforceRetention(options = {}) {
  const now = Number(options.now) || Date.now()
  const mediaTtl = Number(options.mediaTtlMs) || DEFAULT_MEDIA_TTL_MS
  const messageTtl = Number(options.messageTtlMs) || DEFAULT_MESSAGE_TTL_MS
  const messageThreshold = now - messageTtl
  const nothing = { media: 0, messages: 0, rooms: [], pinned: PINNED_PER_ROOM }
  return Promise.all([
    listMedia({ olderThanMs: mediaTtl, now }),
    listRoomStates(),
  ]).then(([stale, states]) => transact([STORE_MEDIA, STORE_MESSAGES], 'readwrite', (tx) => {
    const mediaStore = tx.objectStore(STORE_MEDIA)
    const messageStore = tx.objectStore(STORE_MESSAGES)
    const mediaIds = [...new Set((stale || []).map((row) => row.id))]
    mediaIds.forEach((id) => mediaStore.delete(id))
    return Promise.all((states || []).map((state) => (
      state && state.room
        ? requestResult(messageStore.index(SEQ_INDEX).getAll(roomSeqRange(state.room))).then((rows) => {
          const droppable = rows
            .slice(0, Math.max(0, rows.length - PINNED_PER_ROOM))
            .filter((row) => (Number(row.ts) || now) < messageThreshold)
          droppable.forEach((row) => messageStore.delete([row.room, row.id]))
          return { room: state.room, count: droppable.length }
        })
        : Promise.resolve({ room: null, count: 0 })
    ))).then((perRoom) => ({
      media: mediaIds.length,
      messages: perRoom.reduce((sum, entry) => sum + entry.count, 0),
      rooms: perRoom.filter((entry) => entry.count > 0),
      pinned: PINNED_PER_ROOM,
    }))
  })).then((result) => result || nothing)
}
