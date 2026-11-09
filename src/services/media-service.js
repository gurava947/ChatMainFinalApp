'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const multer = require('multer');

const { classifyKind } = require('../utils/media');
const metrics = require('../config/metrics');

const SNIFF_BYTES = 16;

/**
 * Magic-number check so the stored type matches the bytes rather than whatever
 * the client declared; the type drives both rendering and inline safety.
 */
function detectMime(head) {
  if (head.length < 4) return null;
  if (head[0] === 0x89 && head.subarray(1, 4).toString('ascii') === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (head.subarray(4, 8).toString('ascii') === 'ftyp') return head.subarray(8, 12).toString('ascii').includes('M4A') ? 'audio/mp4' : 'video/mp4';
  if (head.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (head.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
  if (head.subarray(0, 4).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) return 'image/tiff';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  return null;
}

async function sniffHead(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return detectMime(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    if (handle) await handle.close();
  }
}

/** Files are named by media id only: the id is a uuid, so no path can be forged. */
function isMediaId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

function createMediaService({ store, logger, config }) {
  const dir = config.uploadDir;
  fs.mkdirSync(dir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: config.mediaMaxBytes,
      files: config.mediaMaxPerMessage,
      fields: 8
    }
  });

  async function unlinkQuietly(mediaId) {
    try {
      await fsp.unlink(path.join(dir, mediaId));
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn({ err, mediaId }, 'could not remove upload');
    }
  }

  /**
   * Multer writes to disk before we know anything is valid, so every rejection
   * path must delete the orphan it leaves behind.
   */
  function handleUpload(request, response, next) {
    upload.array('files', config.mediaMaxPerMessage)(request, response, async (err) => {
      if (err) {
        await Promise.all((request.files || []).map((file) => unlinkQuietly(path.basename(file.path))));
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.code === 'LIMIT_FILE_COUNT'
          || err.code === 'LIMIT_UNEXPECTED_FILE' ? 413 : 400;
        const error = new Error(status === 413 ? 'file_too_large' : 'upload_failed');
        error.statusCode = status;
        error.detail = err.message;
        error.maxBytes = config.mediaMaxBytes;
        return next(error);
      }

      if (!request.files || request.files.length === 0) {
        const error = new Error('no_file');
        error.statusCode = 400;
        return next(error);
      }

      try {
        const records = await Promise.all(request.files.map(async (file) => {
          const detected = await sniffHead(file.path);
          const declaredMime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
          // Audio/video WebM share EBML, and MP4 audio/video share ftyp. Keep an
          // explicit browser audio declaration for these ambiguous containers
          // so MediaRecorder voice notes render with an audio player.
          const ambiguousAudioContainer = declaredMime.startsWith('audio/')
            && (detected === 'video/webm' || detected === 'video/mp4');
          const mime = ambiguousAudioContainer
            ? (detected === 'video/webm' ? 'audio/webm' : 'audio/mp4')
            : detected || file.mimetype || 'application/octet-stream';
          const record = await store.saveMedia({
            id: path.basename(file.filename),
            userId: request.session.userId,
            name: file.originalname,
            mime,
            declaredMime: file.mimetype,
            size: file.size,
            kind: classifyKind(mime)
          });
          return record;
        }));
        request.mediaRecords = records;
        metrics.mediaUploads.inc(records.length);
        return next();
      } catch (cause) {
        await Promise.all(request.files.map((file) => unlinkQuietly(path.basename(file.path))));
        return next(cause);
      }
    });
  }

  async function resolve(mediaId) {
    if (!isMediaId(mediaId)) return null;
    const record = await store.getMedia(mediaId);
    if (!record) return null;
    try {
      const stat = await fsp.stat(path.join(dir, mediaId));
      if (!stat.isFile()) return null;
      return { record, filePath: path.join(dir, mediaId), size: stat.size };
    } catch {
      await store.deleteMedia(mediaId);
      return null;
    }
  }

  async function removeExpired(limit = 50) {
    const expired = await store.expiredMedia(Date.now(), limit);
    for (const record of expired) {
      await unlinkQuietly(record.id);
      await store.deleteMedia(record.id);
    }
    if (expired.length) logger.debug({ count: expired.length }, 'pruned expired media');
    return expired.length;
  }

  function startSweep() {
    const timer = setInterval(() => {
      removeExpired().catch((err) => logger.error({ err }, 'media sweep failed'));
    }, config.mediaSweepEveryMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  return {
    handleUpload,
    resolve,
    removeExpired,
    startSweep,
    unlinkQuietly,
    uploadDir: dir,
    maxBytes: config.mediaMaxBytes,
    maxPerMessage: config.mediaMaxPerMessage,
    maxAgeSeconds: Math.max(60, Math.min(config.mediaTtlSeconds || 86400, 604800))
  };
}

module.exports = { createMediaService, detectMime, isMediaId };
