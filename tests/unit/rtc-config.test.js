'use strict';

const crypto = require('node:crypto');
const { createIceServers } = require('../../src/utils/rtc-config');

describe('ephemeral RTC ICE configuration', () => {
  test('adds ten-minute coturn REST credentials without returning the shared secret', () => {
    const now = 1_800_000_000;
    const userId = '7d2e7f42-b82a-4bfa-83bc-b7d8b1ed2dc0';
    const secret = 'server-only-shared-secret-value';
    const servers = createIceServers({
      turnUrls: 'turn:turn.example.test:3478, turns:turn.example.test:5349',
      turnSharedSecret: secret,
      userId,
      nowSeconds: now
    });
    const username = `${now + 600}:${userId}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    expect(servers).toEqual([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: ['turn:turn.example.test:3478', 'turns:turn.example.test:5349'], username, credential }
    ]);
    expect(JSON.stringify(servers)).not.toContain(secret);
  });

  test('uses STUN-only fallback unless all TURN inputs are present', () => {
    expect(createIceServers({ turnUrls: 'turn:turn.example.test:3478', turnSharedSecret: 'secret', userId: '' }))
      .toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    expect(createIceServers({ turnUrls: '', turnSharedSecret: 'secret', userId: 'user-id' }))
      .toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });
});
