/**
 * The arithmetic behind a resumable file transfer.
 *
 * A transfer is described by a chunk count and a bitmap, never by the bytes: the
 * bytes live in the file handle the browser already has, and the record only has
 * to say which slices of it the other side has confirmed. That is what makes a
 * reload survivable - the bitmap is a few hundred bytes, so it can be persisted
 * on every ack without the write becoming the slow part of the transfer.
 *
 * Everything here is pure and import-free so the same functions run on the main
 * thread, inside the worker, and in the test harness without a module loader.
 */

/** SCTP-friendly slice size: large enough to amortise per-message cost, small
 * enough that one lost message never stalls progress for long. */
export const TRANSFER_CHUNK_BYTES = 16 * 1024

/** A ceiling the UI can enforce honestly instead of letting the browser fail an
 * allocation halfway through a file the guest waited on. */
export const TRANSFER_MAX_BYTES = 100 * 1024 * 1024

/**
 * How many slices a file of this size has.
 *
 * A zero-byte file is a legal transfer with no chunks, so it reports 0 rather
 * than 1; the caller treats that as already complete. Anything unreadable is 0
 * for the same reason a missing row reads as absent, never as a crash.
 */
export function chunkCountFor(size) {
  const total = Number(size)
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.ceil(total / TRANSFER_CHUNK_BYTES)
}

/**
 * The slice a chunk index names, as an offset and a length. The last chunk is
 * short by definition; returning `null` for an index past the end keeps a
 * corrupt bitmap from slicing outside the file.
 */
export function chunkRange(size, index) {
  const total = Number(size)
  const at = Number(index)
  if (!Number.isFinite(total) || total < 0) return null
  if (!Number.isInteger(at) || at < 0) return null
  const offset = at * TRANSFER_CHUNK_BYTES
  if (offset >= total) return null
  return { offset, length: Math.min(TRANSFER_CHUNK_BYTES, total - offset) }
}

/** One bit per chunk, packed into bytes, so 6400 chunks cost 800 bytes. */
export function createBitmap(chunkCount) {
  const count = Number(chunkCount)
  if (!Number.isFinite(count) || count <= 0) return new Uint8Array(0)
  return new Uint8Array(Math.ceil(count / 8))
}

/** Sets a bit and reports whether it was new, so a duplicate ack is cheap. */
export function markChunk(bitmap, index) {
  if (!bitmap || !Number.isInteger(index) || index < 0) return false
  const byte = Math.floor(index / 8)
  if (byte >= bitmap.length) return false
  const mask = 1 << (index % 8)
  if (bitmap[byte] & mask) return false
  bitmap[byte] |= mask
  return true
}

export function hasChunk(bitmap, index) {
  if (!bitmap || !Number.isInteger(index) || index < 0) return false
  const byte = Math.floor(index / 8)
  if (byte >= bitmap.length) return false
  return (bitmap[byte] & (1 << (index % 8))) !== 0
}

/**
 * The count walks the declared chunks rather than the bitmap, because a record
 * whose bitmap is longer than its chunk count must not report progress it cannot
 * send - and a zero-chunk record is complete, not empty progress.
 */
export function receivedCount(bitmap, chunkCount) {
  const count = Number(chunkCount)
  if (!Number.isFinite(count) || count <= 0) return 0
  let seen = 0
  for (let index = 0; index < count; index += 1) {
    if (hasChunk(bitmap, index)) seen += 1
  }
  return seen
}

/** The next slice to send, or -1 when nothing is left. */
export function firstMissingChunk(bitmap, chunkCount) {
  const count = Number(chunkCount)
  if (!Number.isFinite(count) || count <= 0) return -1
  for (let index = 0; index < count; index += 1) {
    if (!hasChunk(bitmap, index)) return index
  }
  return -1
}

export function isComplete(bitmap, chunkCount) {
  return firstMissingChunk(bitmap, chunkCount) === -1
}

/** The one progress shape the UI renders, with the empty transfer at 100%. */
export function transferProgress(record) {
  const chunks = Math.max(0, Number(record && record.chunks) || 0)
  const received = Math.min(chunks, receivedCount(record && record.bitmap, chunks))
  return {
    received,
    chunks,
    percent: chunks === 0 ? 100 : Math.round((received / chunks) * 1000) / 10,
    complete: received === chunks,
  }
}

/**
 * A fresh record for a file the guest picked.
 *
 * `id` is supplied by the caller so the record can be written before the first
 * slice is sent, which is what makes "resume after reload" a read rather than a
 * reconstruction. Oversized files are refused here instead of failing later.
 */
export function createTransferRecord(input = {}) {
  const size = Number(input.size)
  if (!Number.isFinite(size) || size < 0) throw new RangeError('a transfer needs a file size')
  if (size > TRANSFER_MAX_BYTES) throw new RangeError('the file is larger than this device will transfer')
  if (!input.id) throw new RangeError('a transfer needs an id')
  const now = Number(input.now) || Date.now()
  const chunks = chunkCountFor(size)
  return {
    id: input.id,
    room: input.room || null,
    messageId: input.messageId || null,
    name: input.name || '',
    mime: input.mime || '',
    size,
    chunkBytes: TRANSFER_CHUNK_BYTES,
    chunks,
    bitmap: createBitmap(chunks),
    received: 0,
    status: chunks === 0 ? 'complete' : 'pending',
    createdAt: now,
    updatedAt: now,
    completedAt: chunks === 0 ? now : null,
    error: null,
  }
}

/**
 * Records one confirmed slice.
 *
 * Returns a new record with a copied bitmap. Mutating in place would make the
 * caller's copy of a persisted row change under it, and the durable-write path
 * needs the exact shape it handed to IndexedDB to stay stable.
 */
export function ackChunk(record, index, now = Date.now()) {
  if (!record || !record.id) return null
  const chunks = Math.max(0, Number(record.chunks) || 0)
  if (!Number.isInteger(index) || index < 0 || index >= chunks) return record
  const bitmap = record.bitmap instanceof Uint8Array ? record.bitmap.slice() : createBitmap(chunks)
  if (!markChunk(bitmap, index)) return record
  const received = receivedCount(bitmap, chunks)
  const complete = received === chunks
  const at = Number(now) || Date.now()
  return {
    ...record,
    bitmap,
    received,
    status: complete ? 'complete' : 'sending',
    updatedAt: at,
    completedAt: complete ? (Number(record.completedAt) || at) : null,
    error: null,
  }
}

/**
 * Whether a stored record is still worth resuming.
 *
 * A failed record is not resumed automatically: it already cost the guest a
 * transfer, and retrying it must be their choice. Age is measured from the last
 * ack, because a transfer that was still making progress an hour ago is not
 * stale even if it started yesterday.
 */
export function canResume(record, options = {}) {
  if (!record || !record.id) return false
  if (record.status === 'failed') return false
  const ttl = Number(options.ttlMs)
  if (!Number.isFinite(ttl) || ttl <= 0) return true
  const now = Number(options.now) || Date.now()
  const touched = Number(record.updatedAt) || Number(record.createdAt) || 0
  return now - touched <= ttl
}

/** Marks a transfer as given up on, keeping its bitmap so a manual retry can
 * still ask for only the slices that are missing. */
export function failTransfer(record, message, now = Date.now()) {
  if (!record || !record.id) return null
  return {
    ...record,
    status: 'failed',
    error: message || 'the transfer stopped',
    updatedAt: Number(now) || Date.now(),
  }
}
