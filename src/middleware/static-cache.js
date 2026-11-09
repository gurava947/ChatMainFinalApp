'use strict';

const path = require('node:path');

// Vite fingerprints everything it emits, so the file name changes whenever the
// bytes do; anything else keeps a stable URL and must stay revalidated.
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i;
const SERVICE_WORKER = /^(?:sw|service-worker)\.js$/i;

function cachePolicyFor(filePath) {
  const name = path.basename(filePath);
  // A pinned service worker keeps answering with the previous release's
  // precache list long after a deploy, so it is the one file that must be
  // revalidated on every load.
  if (SERVICE_WORKER.test(name)) return 'no-cache';
  if (HASHED_ASSET.test(name) && path.basename(path.dirname(filePath)) === 'assets') {
    return 'public, max-age=31536000, immutable';
  }
  if (name.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600, must-revalidate';
}

function staticCacheControl({ isProduction }) {
  // serve-static calls this as (res, path, stat).
  return (res, filePath) => {
    res.setHeader('Cache-Control', cachePolicyFor(filePath));
    res.setHeader('Vary', 'Accept-Encoding');
    if (isProduction) res.setHeader('X-Content-Type-Options', 'nosniff');
  };
}

module.exports = { staticCacheControl, cachePolicyFor };
