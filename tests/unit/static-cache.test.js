'use strict';

const { cachePolicyFor, staticCacheControl } = require('../../src/middleware/static-cache');

describe('static cache policy', () => {
  test('fingerprinted build output is immutable for a year', () => {
    expect(cachePolicyFor('/srv/client/dist/assets/index-DexIuQpc.js')).toBe('public, max-age=31536000, immutable');
    expect(cachePolicyFor('/srv/client/dist/assets/index-yDCRtL3f.css')).toBe('public, max-age=31536000, immutable');
  });

  test('a stable-URL file that merely looks hashed is not pinned', () => {
    // The hash check is anchored on Vite's /assets directory; this file keeps
    // its name across releases even though it carries a hash-like suffix.
    expect(cachePolicyFor('/srv/client/public/release-20260101.js')).toBe('public, max-age=3600, must-revalidate');
  });

  test('the service worker is always revalidated', () => {
    expect(cachePolicyFor('/srv/client/dist/sw.js')).toBe('no-cache');
  });

  test('HTML is revalidated so new asset references are picked up', () => {
    expect(cachePolicyFor('/srv/client/dist/index.html')).toBe('no-cache');
  });

  test('everything else gets a short revalidating window', () => {
    expect(cachePolicyFor('/srv/client/public/inchat-logo.png')).toBe('public, max-age=3600, must-revalidate');
  });

  test('sets Vary and the production nosniff guard on the response', () => {
    const headers = {};
    const res = { setHeader: (name, value) => { headers[name] = value; } };
    staticCacheControl({ isProduction: true })(res, '/srv/client/dist/assets/app-abcdefgh.js');
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(headers.Vary).toBe('Accept-Encoding');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  test('does not invent a nosniff header outside production', () => {
    const headers = {};
    const res = { setHeader: (name, value) => { headers[name] = value; } };
    staticCacheControl({ isProduction: false })(res, '/srv/client/dist/index.html');
    expect(headers).not.toHaveProperty('X-Content-Type-Options');
  });
});
