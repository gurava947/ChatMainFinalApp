/**
 * Slicing and hashing for outbound files, off the main thread.
 *
 * Reading a 100 MB file and running SHA-256 over it takes long enough to drop
 * frames and delay input on a phone, and it is exactly the work that can happen
 * while the guest is still watching a progress bar. The worker owns the file
 * handle, slices one chunk at a time on request, and transfers each slice's
 * ArrayBuffer instead of copying it - so the main thread receives bytes it can
 * hand to the data channel without ever having read the file itself.
 *
 * The per-chunk digest is what lets the receiver ack a slice truthfully: a slice
 * whose digest does not match was corrupted in flight and is simply requested
 * again. The manifest digest is SHA-256 over the chunk digests, which commits to
 * the same boundaries and lets a resume prove the two sides still hold the same
 * file without re-reading all of it.
 */

import { TRANSFER_CHUNK_BYTES, chunkRange } from '../transferProtocol.js'

/** A phone that opened dozens of files would pin every one of them in memory.
 * Four is enough for the send queue the UI actually builds. */
const MAX_OPEN_TRANSFERS = 4

const transfers = new Map()

self.onmessage = (event) => {
  const message = event.data || {}
  handle(message).catch((error) => {
    self.postMessage({
      type: 'error',
      id: message.id || null,
      request: message.type || null,
      message: (error && error.message) || 'the transfer worker failed',
    })
  })
}

async function handle(message) {
  switch (message.type) {
    case 'open':
      return open(message)
    case 'manifest':
      return manifest(message)
    case 'pull':
      return pull(message)
    case 'abort':
      return abort(message)
    case 'close':
      return abort(message)
    default:
      return self.postMessage({ type: 'error', id: message.id || null, message: 'unknown transfer request' })
  }
}

function open(message) {
  const { id, file } = message
  if (!id || !file) throw new Error('a transfer needs an id and a file')
  const size = Number(file.size) || 0
  const chunks = Math.ceil(size / TRANSFER_CHUNK_BYTES)
  evictIfFull()
  transfers.set(id, {
    file,
    size,
    chunks,
    chunkBytes: TRANSFER_CHUNK_BYTES,
    digests: new Array(chunks).fill(null),
  })
  self.postMessage({ type: 'opened', id, size, chunks, chunkBytes: TRANSFER_CHUNK_BYTES })
}

async function manifest(message) {
  const entry = requireEntry(message.id)
  const digests = new Array(entry.chunks)
  for (let index = 0; index < entry.chunks; index += 1) {
    digests[index] = entry.digests[index] || (entry.digests[index] = await digestOf(entry, index))
  }
  const joined = new Uint8Array(digests.length * 32)
  digests.forEach((digest, index) => joined.set(digest, index * 32))
  const digest = hexOf(await sha256(joined))
  self.postMessage({
    type: 'manifest',
    id: message.id,
    digest,
    size: entry.size,
    chunks: entry.chunks,
    chunkBytes: entry.chunkBytes,
  })
}

async function pull(message) {
  const entry = requireEntry(message.id)
  const index = Number(message.index)
  const range = chunkRange(entry.size, index)
  if (!range) throw new Error('that chunk is outside the file')
  const buffer = await entry.file.slice(range.offset, range.offset + range.length).arrayBuffer()
  const digest = entry.digests[index] || (entry.digests[index] = await sha256(buffer))
  self.postMessage(
    { type: 'chunk', id: message.id, index, offset: range.offset, length: range.length, buffer, digest: hexOf(digest) },
    [buffer],
  )
}

function abort(message) {
  transfers.delete(message.id)
  self.postMessage({ type: 'aborted', id: message.id || null })
}

function requireEntry(id) {
  const entry = transfers.get(id)
  if (!entry) throw new Error('that transfer was not opened in this worker')
  // Touching an entry is what keeps it out of the eviction queue.
  transfers.delete(id)
  transfers.set(id, entry)
  return entry
}

function evictIfFull() {
  if (transfers.size < MAX_OPEN_TRANSFERS) return
  transfers.delete(transfers.keys().next().value)
}

async function digestOf(entry, index) {
  const range = chunkRange(entry.size, index)
  if (!range) throw new Error('that chunk is outside the file')
  return sha256(await entry.file.slice(range.offset, range.offset + range.length).arrayBuffer())
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

function hexOf(bytes) {
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) {
    out += bytes[index].toString(16).padStart(2, '0')
  }
  return out
}
