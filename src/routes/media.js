'use strict';

const fs = require('node:fs');

const express = require('express');

const { contentDisposition } = require('../utils/media');

/**
 * Media is streamed by hand instead of through res.sendFile: sendFile derives
 * Content-Type from the file extension, and the whole safety model here rests
 * on the type coming from the server-side record.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(header || '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (!Number.isFinite(start) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

function securityHeadersFor(record, maxAgeSeconds) {
  return {
    'Content-Type': record.mime,
    'Content-Disposition': contentDisposition(record.mime, record.name),
    // Sandbox is what makes an accidentally inline-servable document harmless.
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': `public, max-age=${maxAgeSeconds}, immutable`,
    'Accept-Ranges': 'bytes'
  };
}

function mediaDownloadRouter({ media }) {
  const router = express.Router();

  router.get('/:id', async (req, res, next) => {
    try {
      const found = await media.resolve(req.params.id);
      if (!found) {
        return res.status(404).json({ error: 'media_not_found' });
      }

      const { record, filePath } = found;
      const stat = fs.statSync(filePath);
      const headers = securityHeadersFor(record, media.maxAgeSeconds);

      const range = parseRange(req.headers.range, stat.size);
      if (range && range.invalid) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }

      if (range) {
        res.status(206);
        Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        res.setHeader('Content-Length', range.end - range.start + 1);
      } else {
        res.status(200);
        Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
        res.setHeader('Content-Length', stat.size);
      }

      if (req.method === 'HEAD') return res.end();

      const stream = fs.createReadStream(filePath, {
        start: range ? range.start : 0,
        end: range ? range.end : undefined
      });
      stream.on('error', (err) => {
        req.destroy();
        next(err);
      });
      return stream.pipe(res);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/**
 * Upload is authenticated, download is not: <img>/<video>/<audio> cannot carry
 * a session header, so the uuid in the URL is the capability. Treat media ids
 * as secrets and keep the TTL short.
 */
function mediaUploadRouter({ media, limiters }) {
  const router = express.Router();

  router.post('/', limiters.uploads, media.handleUpload, (req, res) => {
    res.status(201).json({
      media: req.mediaRecords.map((record) => ({
        id: record.id,
        kind: record.kind,
        name: record.name,
        mime: record.mime,
        size: record.size,
        url: `/media/${record.id}`,
        expiresAt: record.expiresAt
      }))
    });
  });

  return router;
}

module.exports = { mediaDownloadRouter, mediaUploadRouter, parseRange };
