'use strict';

const crypto = require('node:crypto');

const DEFAULT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' })
]);

/**
 * Create short-lived coturn REST credentials. TURN_URLS is a comma-separated
 * list of turn:/turns: URLs; TURN_SHARED_SECRET must be configured only on the
 * server. The secret is never returned to the browser.
 */
function createIceServers({ turnUrls, turnSharedSecret, userId, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!turnUrls || !turnSharedSecret || !userId) return [...DEFAULT_ICE_SERVERS];

  const expiresAt = nowSeconds + 10 * 60;
  const username = `${expiresAt}:${userId}`;
  const credential = crypto
    .createHmac('sha1', turnSharedSecret)
    .update(username)
    .digest('base64');
  const urls = turnUrls.split(',').map((url) => url.trim()).filter(Boolean);
  if (!urls.length) return [...DEFAULT_ICE_SERVERS];

  return [
    ...DEFAULT_ICE_SERVERS,
    { urls, username, credential }
  ];
}

module.exports = { createIceServers, DEFAULT_ICE_SERVERS };
