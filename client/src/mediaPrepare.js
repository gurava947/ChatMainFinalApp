/**
 * Images are the one attachment kind that is always too big: a phone camera
 * hands out 4-8 MB files for a chat bubble. With HD media off (the default) the
 * picture is downscaled and re-encoded on this device before it is uploaded, so
 * the room does not pay for bytes nobody will zoom into.
 *
 * Anything the browser cannot decode is sent untouched: a failed optimisation
 * must never turn into a failed message.
 */

const IMAGE_MAX_EDGE = 1600
const IMAGE_JPEG_QUALITY = 0.82
/** Below this the re-encode saves nothing a user would notice, so leave it alone. */
const RECOMPRESS_FROM_BYTES = 300 * 1024

const HD_KEY = 'inchat:hd-media'

/** Off by default: HD is opt-in because it costs the whole room. */
export function readHdPreference() {
  try {
    return localStorage.getItem(HD_KEY) === 'on'
  } catch {
    return false
  }
}

export function saveHdPreference(on) {
  try {
    localStorage.setItem(HD_KEY, on ? 'on' : 'off')
  } catch {
    // A device with no storage still gets the default behaviour.
  }
  return Boolean(on)
}

/**
 * Returns the recipe for this file, or null when it must be sent as it is.
 * GIF keeps its frames and SVG is vector art, so re-encoding either one destroys it.
 */
export function planImageFor(file, { hd = false } = {}) {
  if (hd) return null
  const mime = String(file?.type || '').split(';')[0].trim().toLowerCase()
  if (!mime.startsWith('image/')) return null
  if (mime === 'image/gif' || mime === 'image/svg+xml') return null
  return { mime: 'image/jpeg', quality: IMAGE_JPEG_QUALITY, maxEdge: IMAGE_MAX_EDGE }
}

export function scaledSize(width, height, maxEdge) {
  const longest = Math.max(Number(width) || 0, Number(height) || 0)
  if (!longest || longest <= maxEdge) return { width: Number(width) || 0, height: Number(height) || 0 }
  const factor = maxEdge / longest
  // Odd sub-pixel edges make some decoders show a fringed border.
  const round = (value) => Math.max(1, Math.round(value / 2) * 2)
  return { width: round(width * factor), height: round(height * factor) }
}

function toJpegFile(canvas, original) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve(null)
      const base = String(original.name || 'photo').replace(/\.[^.]+$/, '')
      resolve(new File([blob], `${base || 'photo'}.jpg`, { type: 'image/jpeg', lastModified: original.lastModified || Date.now() }))
    }, 'image/jpeg', IMAGE_JPEG_QUALITY)
  })
}

/** One file in, one file out — possibly smaller, never a different photo. */
export async function prepareFile(file, { hd = false } = {}) {
  const plan = planImageFor(file, { hd })
  if (!plan) return file
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
    const size = scaledSize(bitmap.width, bitmap.height, plan.maxEdge)
    const needsWork = size.width !== bitmap.width || size.height !== bitmap.height || file.size >= RECOMPRESS_FROM_BYTES
    if (!needsWork) return file
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return file
    // JPEG has no alpha, so a transparent PNG would otherwise come out on black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, size.width, size.height)
    const prepared = await toJpegFile(canvas, file)
    // A bigger "optimised" file means the source was already efficient; keep it.
    if (!prepared || prepared.size >= file.size) return file
    return prepared
  } catch {
    return file
  } finally {
    bitmap?.close?.()
  }
}

export async function prepareFiles(files, options = {}) {
  const list = Array.isArray(files) ? files : Array.from(files || [])
  return Promise.all(list.map((file) => prepareFile(file, options)))
}
