/**
 * The vertical short-video feed. There is no separate store for shorts: a short
 * is a video a guest already sent to a room, read back from that room's history,
 * so everything here works on rows the server actually returned.
 */

/** A phone can hold a lot of clips; the feed caps the work it does per open. */
export const SHORTS_LIMIT = 60

/** History rows carry only the attachment id; the bytes live at /media/:id. */
export function clipUrl(attachment) {
  return attachment.url || (attachment.id ? `/media/${encodeURIComponent(attachment.id)}` : '')
}

/**
 * `batches[index]` holds the messages of `rooms[index]`, so the room a clip came
 * from travels with it. Clips already on the device are skipped by id, and the
 * newest clip of a room is the one a reader expects to see first.
 */
export function collectVideoClips(batches, rooms, limit = SHORTS_LIMIT) {
  const targets = Array.isArray(rooms) ? rooms : []
  const seen = new Set()
  const rows = []
  ;(Array.isArray(batches) ? batches : []).forEach((messages, index) => {
    const room = targets[index]
    if (!room) return
    for (const message of messages || []) {
      for (const attachment of message.attachments || []) {
        if (!String(attachment.mime || '').startsWith('video/')) continue
        if (seen.has(attachment.id)) continue
        seen.add(attachment.id)
        const url = clipUrl(attachment)
        if (!url) continue
        rows.push({
          id: attachment.id,
          url,
          name: attachment.name || 'Video',
          room: room.id,
          roomName: room.name || room.id,
          displayName: message.displayName || message.author || 'Guest',
          ts: Number(message.ts) || 0
        })
      }
    }
  })
  return rows.sort((a, b) => b.ts - a.ts).slice(0, Math.max(0, Number(limit) || 0))
}
