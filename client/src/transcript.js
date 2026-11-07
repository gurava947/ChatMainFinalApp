/**
 * The rules that turn a pile of message rows into one transcript.
 *
 * These are the decisions a guest sees the results of: what order the room is in,
 * whether a reconnect loses the older half of a conversation, and which rows are
 * worth writing to IndexedDB. They live here rather than inside the component
 * because this file has no imports and no JSX, so the test suite loads *this*
 * source - the same text the browser bundles - and exercises it directly.
 *
 * Nothing here touches storage or the network: rows come in, rows come out.
 */

/**
 * Ordered by the sequence the store minted, falling back to the timestamp for
 * rows this device has not had accepted yet. Sorting by `ts` alone reordered a
 * room whenever two replicas wrote in the same millisecond.
 */
export function byArrival(a, b) {
  const aSeq = Number.isFinite(a.seq) ? a.seq : null
  const bSeq = Number.isFinite(b.seq) ? b.seq : null
  const aKnown = aSeq !== null
  const bKnown = bSeq !== null
  if (aKnown && bKnown) return aSeq - bSeq || a.ts - b.ts
  if (aKnown !== bKnown) return aKnown ? -1 : 1
  return a.ts - b.ts
}

/**
 * One row into the list: appended in order, or folded into the row this device
 * already has under the same id - or under the `clientId` it invented for a send
 * that has not been acknowledged yet, which is how an optimistic bubble becomes
 * the real one instead of a duplicate.
 */
export function mergeMessage(list, incoming) {
  const index = list.findIndex((item) => item.id === incoming.id || (incoming.clientId && item.clientId === incoming.clientId))
  if (index < 0) return [...list, incoming].sort(byArrival)
  const next = [...list]
  next[index] = { ...next[index], ...incoming, pending: false, failed: false }
  return next.sort(byArrival)
}

/**
 * Adds an older page without losing the local state (pending, failed) the
 * current rows already carry. The same reference comes back when the page held
 * nothing new, so the transcript does not repaint for an empty fetch.
 */
export function mergePage(list, older) {
  const known = new Set((list || []).map((message) => message.id))
  const fresh = (older || []).filter((message) => !known.has(message.id))
  return fresh.length ? [...fresh, ...(list || [])].sort(byArrival) : list
}

/**
 * Fold a server page into what this device already holds.
 *
 * A page is the room's newest window, not the device's whole copy. Replacing the
 * transcript with it used to be harmless - there was nothing else - and became
 * wrong the moment the room had a local store: a reconnect would drop every row
 * below that window, and a device that had read its own history first would watch
 * it disappear. The page still wins for the rows it covers, because that is the
 * server's truth about them, and unsent rows ride through untouched.
 */
export function mergeServerPage(list, page) {
  const served = new Set((page || []).map((message) => message.id))
  const held = (list || []).filter((message) => !served.has(message.id) || message.pending || message.failed)
  return (page || []).reduce(mergeMessage, held)
}

/**
 * Where "load older" should page from next: the lower of the two edges.
 *
 * The server's page starts at its own window; the local store usually reaches
 * further back. Taking the newer edge would make the rows underneath it, which
 * are on this device, unreachable from the UI that is supposed to reveal them.
 */
export function olderCursor(current, incoming) {
  // `Number(null)` is 0 and 0 is a legal sequence, so an unknown edge has to be
  // dropped before it is coerced - otherwise a device that knows one edge and not
  // the other pages from the very bottom of the room and is told there is nothing
  // older, which looks exactly like a room that has no history.
  const edges = [current, incoming]
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter((value) => Number.isFinite(value))
  return edges.length ? Math.min(...edges) : null
}

/**
 * The rows this device has not put in its local store yet, or has since changed.
 *
 * Two things keep a row out of the write set, and both matter. A row the server
 * has not numbered is not storable: it has no place to be read back in order, and
 * an unsent message is the outbox's business, not the transcript's. And a row the
 * store already holds is only rewritten when something about it moved - a receipt
 * arriving, a poll tally changing - because writing the whole room on every tick
 * is how a low-end phone spends its battery and its quota for nothing.
 */
export function rowsToPersist(rows, persisted, dirty) {
  const held = persisted || new Set()
  const changed = dirty || new Set()
  return (rows || []).filter((message) => message?.id
    && Number.isFinite(message.seq)
    && (!held.has(message.id) || changed.has(message.id)))
}

/** Which attachments belong to the rows being written, and to which message. */
export function attachmentRows(rows) {
  return (rows || []).flatMap((message) => (message.attachments || []).map((file) => ({ ...file, messageId: message.id })))
}

/** Rows drawn while the local read is still in flight: enough to look like a page. */
export const SKELETON_ROWS = 5

/**
 * What the middle of a conversation shows while its first page is assembled from
 * three sources at once - this device's IndexedDB copy, the socket's history, and
 * the connection. Kept together because the markup used to get it wrong where
 * anyone could see it: a read that failed looked exactly like a room nobody had
 * spoken in, so the app invited the guest to "say hello" over a transcript it had
 * just failed to open. `failure` outranks `hydrating` so a read that has given up
 * can never be covered by a shimmer that claims it is still working.
 */
export function transcriptPhase({ hydrating = false, failure = '', messages = 0, connected = false } = {}) {
  if (messages > 0) return 'transcript'
  if (failure) return 'failure'
  if (hydrating) return 'skeleton'
  if (connected) return 'empty'
  return 'connecting'
}

/**
 * A failed local read is not a failed connection, and the wording has to say
 * which one the reader is looking at. The underlying message is kept because
 * "storage is full" and "this browser blocks IndexedDB" are fixed differently.
 */
export function localReadFailure(reason) {
  const detail = reason?.message || (typeof reason === 'string' ? reason : '')
  return detail
    ? `This device could not open its own copy of this chat: ${detail}`
    : 'This device could not open its own copy of this chat.'
}
