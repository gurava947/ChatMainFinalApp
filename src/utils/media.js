'use strict';

/**
 * Uploads are capability URLs: possession of the media id is the only
 * credential, because <img>/<video>/<audio> tags cannot send a session
 * header. Anything that could execute in our origin is therefore forced to
 * download instead of render.
 */
const INLINE_SAFE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska', 'video/3gpp', 'video/x-msvideo',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm',
  'audio/flac', 'audio/aac', 'audio/x-m4a', 'audio/basic', 'audio/amr',
  'application/pdf', 'text/plain'
]);

/** Never rendered and never inlined, whatever the client claims the type is. */
const ALWAYS_ATTACHMENT_MIMES = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml',
  'application/xml', 'text/javascript', 'application/javascript', 'application/x-sh'
]);

const NAME_MAX = 140;

function baseMime(mimeType) {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

function classifyKind(mimeType) {
  const mime = baseMime(mimeType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function isInlineSafe(mimeType) {
  const mime = baseMime(mimeType);
  if (ALWAYS_ATTACHMENT_MIMES.has(mime)) return false;
  return INLINE_SAFE_MIMES.has(mime);
}

/**
 * Names come from the client and land in a response header, so control
 * characters and quotes are removed before they can split the header.
 */
function safeDisplayName(rawName) {
  return String(rawName || 'attachment')
    .replace(/[\u0000-\u001F\u007F"\\/]/gu, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, NAME_MAX) || 'attachment';
}

function contentDisposition(mimeType, name) {
  const disposition = isInlineSafe(mimeType) ? 'inline' : 'attachment';
  const safeName = safeDisplayName(name);
  const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

module.exports = {
  INLINE_SAFE_MIMES,
  ALWAYS_ATTACHMENT_MIMES,
  baseMime,
  classifyKind,
  isInlineSafe,
  safeDisplayName,
  contentDisposition,
  formatBytes
};
