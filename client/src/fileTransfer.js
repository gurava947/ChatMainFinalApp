/**
 * Files over the call's data channel, browser to browser.
 *
 * The channel is the fast path; the existing HTTP upload remains the guarantee.
 * That split is deliberate: a message's attachments are validated against
 * server-side media records, so a transfer here is an *acceleration* - the peer
 * receives the bytes while the upload is still running, and the message still
 * names the upload. Everything in this module is designed to fail back to the
 * upload without the guest noticing.
 *
 * One ordered, reliable channel named `files` multiplexes every transfer by a
 * numeric slot. Bytes are framed `[slot:4][index:4][payload]` so a chunk is a
 * single message and never needs pairing. Control frames are JSON. The sender
 * keeps a 64-chunk window and waits on `bufferedAmount`, because SCTP will
 * happily buffer enough to stall a phone if nobody applies backpressure.
 *
 * The chunk protocol itself is injected rather than imported: the same module
 * runs on the main thread, inside the test harness, and beside the worker, and
 * keeping it dependency-free is what makes that possible.
 */

export const FILE_CHANNEL_LABEL = 'files'
export const FILE_CHUNK_WINDOW = 64
export const FILE_ACK_EVERY = 32
export const FILE_HIGH_WATER = 1024 * 1024
export const FILE_LOW_WATER = 256 * 1024
export const FILE_CHANNEL_TIMEOUT_MS = 2000
export const FILE_HEADER_BYTES = 8
export const FILE_RESUME_TIMEOUT_MS = 600

const MANIFEST = 'file:manifest'
const CHUNK_ACK = 'file:ack'
const RESUME = 'file:resume'
const COMPLETE = 'file:complete'
const ABORT = 'file:abort'
const BOUND = 'file:bound'

/** A stable cache key for "the same file" when an attachment id is not known yet. */
export function directFileKey(name, size, mime) {
  return `${name || ''}|${Number(size) || 0}|${mime || ''}`
}

/** `[slot:4][index:4][bytes]` as one ArrayBuffer, which is one channel message. */
export function encodeChunkFrame(slot, index, buffer) {
  const payload = new Uint8Array(buffer)
  const frame = new Uint8Array(FILE_HEADER_BYTES + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, Number(slot) >>> 0)
  view.setUint32(4, Number(index) >>> 0)
  frame.set(payload, FILE_HEADER_BYTES)
  return frame.buffer
}

export function decodeChunkFrame(data) {
  let buffer = null
  if (data instanceof ArrayBuffer) buffer = data
  else if (ArrayBuffer.isView(data)) buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  if (!buffer || buffer.byteLength < FILE_HEADER_BYTES) return null
  const view = new DataView(buffer)
  return {
    slot: view.getUint32(0),
    index: view.getUint32(4),
    // A copy, because the caller keeps this slice after the message is gone.
    bytes: buffer.slice(FILE_HEADER_BYTES),
  }
}

export function controlFrame(type, payload = {}) {
  return JSON.stringify({ t: type, ...payload })
}

export function parseControlFrame(data) {
  if (typeof data !== 'string') return null
  try {
    const value = JSON.parse(data)
    return value && typeof value.t === 'string' ? value : null
  } catch {
    return null
  }
}

/**
 * Bitmaps travel as plain byte arrays inside JSON control frames. The largest
 * possible bitmap is 800 bytes, so the convenience is worth more than the
 * handful of kilobytes a base64 string would save.
 */
export function bitmapToArray(bitmap) {
  return bitmap ? Array.from(bitmap) : []
}

export function bitmapFromArray(values, chunkCount) {
  const size = Math.ceil(Math.max(0, Number(chunkCount) || 0) / 8)
  const bitmap = new Uint8Array(size)
  if (!Array.isArray(values)) return bitmap
  values.forEach((value, index) => {
    if (index < size) bitmap[index] = Number(value) & 0xff
  })
  return bitmap
}

/**
 * Waits until the channel has drained below the high-water mark.
 *
 * The event is the normal path; the poll is only for engines and fakes that do
 * not fire it, and the timeout is the last line of defence - a send that waits
 * forever looks identical to a hung call to the person holding the phone.
 */
export function waitForDrain(target, highWater = FILE_HIGH_WATER, lowWater = FILE_LOW_WATER) {
  if (!target || typeof target.send !== 'function') return Promise.resolve()
  if ((Number(target.bufferedAmount) || 0) <= highWater) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    let timer = 0
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      target.removeEventListener?.('bufferedamountlow', finish)
      resolve()
    }
    try { target.bufferedAmountLowThreshold = lowWater } catch { /* a read-only fake still polls */ }
    target.addEventListener?.('bufferedamountlow', finish)
    const started = Date.now()
    const poll = () => {
      if (settled) return
      if ((Number(target.bufferedAmount) || 0) <= highWater) return finish()
      if (Date.now() - started > 30000) return finish()
      timer = window.setTimeout(poll, 25)
    }
    timer = window.setTimeout(poll, 25)
  })
}

/**
 * The digest the sender commits to: SHA-256 over the concatenated per-chunk
 * digests. The Phase 3 worker computes exactly this while it hashes, and the
 * receiver recomputes it from the slices it assembled before it claims success.
 */
async function manifestDigestHex(parts) {
  if (!globalThis.crypto?.subtle) return null
  const joined = new Uint8Array(parts.length * 32)
  for (let index = 0; index < parts.length; index += 1) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', parts[index])
    joined.set(new Uint8Array(digest), index * 32)
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', joined)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * One controller per call, attached to whichever data channel currently exists.
 *
 * It outlives the peer connection on purpose: a rebuild during ICE recovery
 * swaps the channel underneath an in-flight transfer, and the whole point of the
 * bitmap is that the transfer resumes instead of restarting. Bits live on both
 * sides - the sender remembers what was acknowledged, the receiver what it
 * actually assembled - and after a reconnect the receiver's bitmap wins.
 */
export function createFileTransferController(options = {}) {
  const protocol = options.protocol
  if (!protocol) throw new Error('the file transfer controller needs the chunk protocol')
  const store = options.store || {}
  const now = options.now || Date.now
  const newId = options.newId || (() => (globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(16).slice(2)}`))
  const onReceived = options.onReceived || (() => {})
  const onBound = options.onBound || (() => {})
  const onStateChange = options.onStateChange || (() => {})

  let channel = null
  let channelOpen = false
  let announcedOn = null
  let slotSeq = 0
  const waiters = []
  const outbound = new Map()
  const inbound = new Map()

  const isOpen = () => Boolean(channel && channel.readyState === 'open')

  const setOpen = (next) => {
    if (channelOpen === next) return
    channelOpen = next
    onStateChange(next)
  }

  const settleWaiters = (open) => {
    waiters.splice(0).forEach((waiter) => waiter.finish(open))
  }

  const whenOpen = (timeoutMs = FILE_CHANNEL_TIMEOUT_MS) => {
    if (isOpen()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter = { finish: null, timer: 0 }
      waiter.finish = (value) => {
        window.clearTimeout(waiter.timer)
        resolve(value)
      }
      waiter.timer = window.setTimeout(() => waiter.finish(false), Math.max(0, timeoutMs))
      waiters.push(waiter)
    })
  }

  const sendControl = (type, payload) => {
    if (!isOpen()) return false
    try {
      channel.send(controlFrame(type, payload))
      return true
    } catch {
      return false
    }
  }

  const persist = (record) => {
    if (!store.saveRecord) return Promise.resolve(null)
    return Promise.resolve(store.saveRecord(record)).catch(() => null)
  }

  const report = (state) => {
    if (!state.onProgress) return
    const progress = protocol.transferProgress({ bitmap: state.acked, chunks: state.chunks })
    state.onProgress({ transferId: state.id, ...progress })
  }

  const releaseWindow = (state) => {
    state.windowWaiters.splice(0).forEach((resolve) => resolve())
  }

  const waitForWindow = (state) => {
    if (state.aborted) return Promise.resolve()
    const outstanding = protocol.receivedCount(state.sent, state.chunks) - protocol.receivedCount(state.acked, state.chunks)
    if (outstanding < FILE_CHUNK_WINDOW) return Promise.resolve()
    return new Promise((resolve) => state.windowWaiters.push(resolve))
  }

  /**
   * A reconnect opens a fresh ordered channel, so anything that was in flight is
   * gone. The receiver answers with its bitmap and the sender rewinds to it;
   * until that answer lands the sender holds, because resending chunks the
   * receiver already has is exactly the duplicate the resume exists to avoid.
   */
  const holdForResume = (state) => {
    // A second rebuild before the first answer must not orphan the waiters
    // already parked on the previous promise.
    if (state.resumePending) return
    state.resumePending = true
    state.resumeWait = new Promise((resolve) => {
      state.resumeResolve = resolve
    })
  }

  const releaseResume = (state) => {
    if (!state.resumePending) return
    state.resumePending = false
    state.resumeResolve?.()
    state.resumeResolve = null
  }

  const waitForResume = (state) => {
    if (!state.resumePending || state.aborted) return Promise.resolve()
    return state.resumeWait.then(() => {
      if (state.resumePending) releaseResume(state)
    })
  }

  const sendChunk = async (state, index) => {
    const range = protocol.chunkRange(state.file.size, index)
    if (!range) throw new Error('the transfer lost its slice')
    const buffer = await state.file.slice(range.offset, range.offset + range.length).arrayBuffer()
    // A rebuild swaps the channel underneath this transfer; wait for the
    // replacement and retry the same slice rather than failing the guest.
    while (!state.aborted) {
      // The resume that lands during that wait may prove the peer already has
      // this slice; sending it again would be the duplicate resume exists to
      // prevent, so the rewritten bitmap wins over this in-flight attempt.
      if (protocol.hasChunk(state.sent, index)) return
      if (!isOpen()) {
        const open = await whenOpen(30000)
        if (!open) throw new Error('the direct path closed')
        await waitForResume(state)
        continue
      }
      try {
        await waitForDrain(channel, FILE_HIGH_WATER)
        if (state.aborted || protocol.hasChunk(state.sent, index)) return
        // A rebuild can land while this slice was being read or drained; the
        // rewind would discard this frame's mark and send it twice, so hold
        // until the receiver's bitmap settles before the write.
        if (state.resumePending) {
          await waitForResume(state)
          continue
        }
        if (!isOpen()) continue
        channel.send(encodeChunkFrame(state.slot, index, buffer))
        return
      } catch {
        // SCTP refused the write or the channel closed mid-call; both are
        // recoverable by waiting for the next channel.
      }
    }
    throw new Error('the transfer was cancelled')
  }

  const failOutbound = (state, error) => {
    if (state.settled) return
    state.settled = true
    state.aborted = true
    releaseWindow(state)
    releaseResume(state)
    const record = { ...state.record, status: 'failed', error: (error && error.message) || 'the transfer stopped', updatedAt: now() }
    persist(record)
    state.reject(error instanceof Error ? error : new Error(String(error || 'the transfer stopped')))
  }

  const finishOutbound = (state, message) => {
    if (state.settled) return
    if (state.digest && message.digest && message.digest !== state.digest) {
      failOutbound(state, new Error('the peer assembled a different file'))
      return
    }
    state.settled = true
    const record = {
      ...state.record,
      bitmap: state.acked.slice(),
      received: protocol.receivedCount(state.acked, state.chunks),
      status: 'complete',
      completedAt: now(),
      updatedAt: now(),
    }
    persist(record)
    state.onProgress?.({ transferId: state.id, received: state.chunks, chunks: state.chunks, percent: 100, complete: true })
    state.resolve({ transferId: state.id, name: state.record.name, mime: state.record.mime, size: state.record.size, digest: state.digest || message.digest || null })
  }

  const pump = async (state) => {
    if (state.pumping || state.settled) return
    state.pumping = true
    try {
      let index = protocol.firstMissingChunk(state.sent, state.chunks)
      while (index !== -1) {
        if (state.aborted) throw new Error('the transfer was cancelled')
        await waitForResume(state)
        await waitForWindow(state)
        await sendChunk(state, index)
        if (state.aborted) throw new Error('the transfer was cancelled')
        protocol.markChunk(state.sent, index)
        // A resume can rewind `sent` while this loop runs; the next first-hole
        // lookup is what makes that safe.
        index = protocol.firstMissingChunk(state.sent, state.chunks)
      }
    } catch (error) {
      failOutbound(state, error)
    } finally {
      state.pumping = false
    }
  }

  const onAck = (message) => {
    const state = outbound.get(message.id)
    if (!state || state.settled) return
    const bitmap = bitmapFromArray(message.bitmap, state.chunks)
    state.acked = bitmap
    const record = {
      ...state.record,
      bitmap: bitmap.slice(),
      received: protocol.receivedCount(bitmap, state.chunks),
      status: 'sending',
      updatedAt: now(),
    }
    state.record = { ...state.record, ...record }
    persist(record)
    releaseWindow(state)
    report(state)
  }

  const onResume = (message) => {
    const state = outbound.get(message.id)
    if (!state || state.settled) return
    state.acked = bitmapFromArray(message.bitmap, state.chunks)
    state.sent = state.acked.slice()
    releaseResume(state)
    releaseWindow(state)
    report(state)
    // The resume can land after the first pass already handed every slice to
    // the dead channel; rewinding `sent` only helps if something walks it again.
    pump(state)
  }

  const persistInbound = (state, status = 'receiving') => {
    const record = {
      ...state.record,
      bitmap: state.bitmap.slice(),
      received: state.received,
      status,
      updatedAt: now(),
    }
    state.record = { ...state.record, ...record }
    return persist(record)
  }

  const ackInbound = (state) => {
    // The bitmap is durable before it is promised, so a resume after a reload
    // cannot claim more than this device actually assembled.
    return persistInbound(state).finally(() => {
      sendControl(CHUNK_ACK, { id: state.id, bitmap: bitmapToArray(state.bitmap), received: state.received })
    })
  }

  const finishInbound = async (state) => {
    if (state.finishing) return
    state.finishing = true
    try {
      const blob = new Blob(state.parts, { type: state.mime || 'application/octet-stream' })
      const actual = await manifestDigestHex(state.parts)
      const ok = !state.digest || !actual || actual === state.digest
      state.actualDigest = actual
      await persistInbound(state, ok ? 'complete' : 'failed')
      sendControl(CHUNK_ACK, { id: state.id, bitmap: bitmapToArray(state.bitmap), received: state.received })
      sendControl(COMPLETE, { id: state.id, digest: actual, ok })
      if (!ok) {
        sendControl(ABORT, { id: state.id, reason: 'digest' })
        inbound.delete(state.slot)
        return
      }
      onReceived({
        transferId: state.id,
        name: state.name,
        mime: state.mime,
        size: state.size,
        digest: actual,
        blob,
      })
    } catch (error) {
      sendControl(ABORT, { id: state.id, reason: (error && error.message) || 'receive' })
      inbound.delete(state.slot)
    }
  }

  const receiveChunk = (state, frame) => {
    if (state.finishing || frame.index >= state.chunks) return
    if (protocol.hasChunk(state.bitmap, frame.index)) return
    state.parts[frame.index] = frame.bytes
    protocol.markChunk(state.bitmap, frame.index)
    state.received += 1
    if (state.received === state.chunks) {
      finishInbound(state)
      return
    }
    if (state.received % FILE_ACK_EVERY === 0) ackInbound(state)
  }

  const openInbound = (message) => {
    const size = Number(message.size) || 0
    const chunks = Number(message.chunks) || 0
    const maxChunks = Math.ceil(protocol.TRANSFER_MAX_BYTES / protocol.TRANSFER_CHUNK_BYTES)
    if (!Number.isInteger(message.slot) || message.slot <= 0) return null
    if (size < 0 || size > protocol.TRANSFER_MAX_BYTES || chunks > maxChunks) {
      sendControl(ABORT, { id: message.id, reason: 'too-large' })
      return null
    }
    const existing = inbound.get(message.slot)
    if (existing && existing.id === message.id) {
      if (existing.received > 0) {
        sendControl(RESUME, { id: existing.id, bitmap: bitmapToArray(existing.bitmap) })
      }
      return existing
    }
    const state = {
      id: message.id,
      slot: message.slot,
      name: message.name || '',
      mime: message.mime || '',
      size,
      chunks,
      digest: message.digest || null,
      parts: new Array(chunks),
      bitmap: protocol.createBitmap(chunks),
      received: 0,
      finishing: false,
      record: {
        ...protocol.createTransferRecord({
          id: message.id,
          name: message.name || '',
          mime: message.mime || '',
          size,
          now: now(),
        }),
        direction: 'in',
        digest: message.digest || null,
        status: 'receiving',
      },
    }
    inbound.set(message.slot, state)
    persistInbound(state)
    if (chunks === 0) finishInbound(state)
    return state
  }

  const handleControl = (message) => {
    switch (message.t) {
      case MANIFEST:
        openInbound(message)
        return
      case CHUNK_ACK:
        onAck(message)
        return
      case RESUME:
        onResume(message)
        return
      case COMPLETE:
        if (message.id) {
          const state = outbound.get(message.id)
          if (state) finishOutbound(state, message)
        }
        return
      case ABORT: {
        const out = outbound.get(message.id)
        if (out) failOutbound(out, new Error(message.reason === 'digest' ? 'the peer rejected the file' : 'the peer stopped the transfer'))
        Array.from(inbound.entries()).forEach(([slot, state]) => {
          if (state.id === message.id) inbound.delete(slot)
        })
        return
      }
      case BOUND:
        onBound({ transferId: message.id, mediaId: message.mediaId })
        return
      default:
    }
  }

  const onFrame = (source, data) => {
    if (channel !== source) return
    const control = parseControlFrame(data)
    if (control) {
      handleControl(control)
      return
    }
    const frame = decodeChunkFrame(data)
    if (!frame) return
    const state = inbound.get(frame.slot)
    if (state) receiveChunk(state, frame)
  }

  /**
   * Tells the peer which server media id these bytes belong to, so the receiver
   * can bind the file it already holds to the attachment it is about to see.
   * Retried on every reconnect until it is no longer needed.
   */
  const bind = (transferId, mediaId) => {
    const state = outbound.get(transferId)
    if (!state || !mediaId) return false
    state.mediaId = mediaId
    return sendControl(BOUND, { id: transferId, mediaId })
  }

  const announce = () => {
    inbound.forEach((state) => {
      if (state.received > 0 && state.received < state.chunks) {
        sendControl(RESUME, { id: state.id, bitmap: bitmapToArray(state.bitmap) })
      } else if (state.received === state.chunks && state.actualDigest) {
        // The completion frame may have been lost with the old channel.
        sendControl(COMPLETE, { id: state.id, digest: state.actualDigest, ok: true })
      }
    })
    outbound.forEach((state) => {
      if (state.mediaId && !state.settled) sendControl(BOUND, { id: state.id, mediaId: state.mediaId })
    })
  }

  const attach = (next) => {
    if (!next) return
    detach()
    channel = next
    try { next.binaryType = 'arraybuffer' } catch { /* a fake channel may not allow it */ }
    try { next.bufferedAmountLowThreshold = FILE_LOW_WATER } catch { /* set by waitForDrain too */ }
    next.onmessage = (event) => onFrame(next, event.data)
    next.onclose = () => {
      if (channel === next) {
        channel = null
        setOpen(false)
      }
    }
    next.onerror = () => {
      if (channel === next) setOpen(false)
    }
    outbound.forEach((state) => {
      if (!state.settled && protocol.receivedCount(state.sent, state.chunks) > 0) holdForResume(state)
    })
    const ready = () => {
      if (channel !== next || announcedOn === next) return
      announcedOn = next
      setOpen(true)
      settleWaiters(true)
      // If nobody answers, the transfer still has to make progress; the
      // sender's own acknowledged bitmap is the honest floor.
      outbound.forEach((state) => window.setTimeout(() => releaseResume(state), FILE_RESUME_TIMEOUT_MS))
      announce()
    }
    next.onopen = ready
    // `ondatachannel` can hand over a channel that opened before the handler ran.
    if (next.readyState === 'open') ready()
  }

  const detach = () => {
    const previous = channel
    channel = null
    announcedOn = null
    if (previous) {
      previous.onmessage = null
      previous.onclose = null
      previous.onerror = null
      previous.onopen = null
    }
    setOpen(false)
  }

  /**
   * Returns immediately with the transfer id so the caller can bind the message
   * as soon as the upload lands; `done` settles when the peer has verified the
   * whole file.
   */
  const send = (file, sendOptions = {}) => {
    if (!isOpen() || !file) return null
    const id = sendOptions.id || newId()
    const size = Number(file.size) || 0
    const chunks = protocol.chunkCountFor(size)
    let resolve = () => {}
    let reject = () => {}
    const done = new Promise((settle, fail) => {
      resolve = settle
      reject = fail
    })
    // A caller that only binds the id must not produce an unhandled rejection;
    // it can still await `done` and see the failure.
    done.catch(() => {})
    const record = {
      ...protocol.createTransferRecord({
        id,
        name: file.name || '',
        mime: file.type || '',
        size,
        now: now(),
      }),
      direction: 'out',
      digest: sendOptions.digest || null,
      status: 'sending',
    }
    const state = {
      id,
      slot: (slotSeq += 1),
      file,
      chunks,
      record,
      digest: sendOptions.digest || null,
      sent: protocol.createBitmap(chunks),
      acked: protocol.createBitmap(chunks),
      windowWaiters: [],
      resumePending: false,
      resumeResolve: null,
      resumeWait: null,
      onProgress: sendOptions.onProgress || null,
      aborted: false,
      settled: false,
      pumping: false,
      resolve,
      reject,
      mediaId: null,
    }
    outbound.set(id, state)
    persist(state.record)
    report(state)
    const manifestSent = sendControl(MANIFEST, {
      id,
      slot: state.slot,
      name: record.name,
      mime: record.mime,
      size,
      chunks,
      chunkBytes: protocol.TRANSFER_CHUNK_BYTES,
      digest: state.digest,
    })
    if (!manifestSent) {
      outbound.delete(id)
      reject(new Error('the direct path closed'))
      return { transferId: id, done }
    }
    pump(state)
    return { transferId: id, done }
  }

  const abortAll = () => {
    settleWaiters(false)
    outbound.forEach((state) => failOutbound(state, new Error('the transfer was cancelled')))
    outbound.clear()
    inbound.clear()
    detach()
  }

  return {
    attach,
    detach,
    isOpen,
    whenOpen,
    send,
    bind,
    abortAll,
  }
}
