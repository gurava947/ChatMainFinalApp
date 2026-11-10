/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadIceCache } = require('../helpers/load-client-module');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');
const CALL_HOOK_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'useRoomCalls.js'), 'utf8');

const SESSION = { userId: 'guest-1', displayName: 'Asha' };
const SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:relay.example:3478'], username: 'u', credential: 'c' },
];

function okResponse(iceServers = SERVERS) {
  return { ok: true, json: async () => ({ iceServers }) };
}

let ice;

beforeEach(() => {
  ice = loadIceCache();
  ice.resetIceCache();
  delete global.fetch;
});

afterEach(() => {
  jest.useRealTimers();
  delete global.fetch;
  jest.restoreAllMocks();
});

describe('boot-time cache', () => {
  test('nothing is handed to a call before the first prime', () => {
    expect(ice.readIceServers(SESSION)).toBeNull();
  });

  test('the boot prime caches the servers for synchronous reads', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    await expect(ice.primeIceConfig(SESSION)).resolves.toEqual(SERVERS);
    expect(ice.readIceServers(SESSION)).toEqual(SERVERS);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('/api/rtc-config', expect.objectContaining({
      headers: { 'X-Session-Id': 'guest-1' },
      cache: 'no-store',
    }));
  });

  test('reading is free and an unexpired prime does not refetch', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    await ice.primeIceConfig(SESSION);
    const fetchedAt = Date.now();
    expect(ice.readIceServers(SESSION, fetchedAt + 1000)).toEqual(SERVERS);
    await ice.primeIceConfig(SESSION, fetchedAt + ice.ICE_REFRESH_AFTER_MS - 1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('an aging cache refreshes once the refresh window is reached', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    await ice.primeIceConfig(SESSION);
    const fetchedAt = Date.now();
    await ice.primeIceConfig(SESSION, fetchedAt + ice.ICE_REFRESH_AFTER_MS + 1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('servers past their usable window are never used for a call', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    await ice.primeIceConfig(SESSION);
    const fetchedAt = Date.now();
    expect(ice.readIceServers(SESSION, fetchedAt + ice.ICE_USABLE_FOR_MS + 1)).toBeNull();
  });

  test('a second guest never inherits the first guest credentials', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    await ice.primeIceConfig(SESSION);
    expect(ice.readIceServers({ userId: 'guest-2' })).toBeNull();
  });
});

describe('resilience', () => {
  test('concurrent primes share a single request', async () => {
    let resolveFetch;
    global.fetch = jest.fn(() => new Promise((resolve) => { resolveFetch = resolve }));
    const first = ice.primeIceConfig(SESSION);
    const second = ice.primeIceConfig(SESSION);
    resolveFetch(okResponse());
    await expect(first).resolves.toEqual(SERVERS);
    await expect(second).resolves.toEqual(SERVERS);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a failed config request falls back to STUN and retries next time', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(ice.primeIceConfig(SESSION)).resolves.toEqual(ice.ICE_FALLBACK);
    expect(ice.readIceServers(SESSION)).toBeNull();
    global.fetch.mockResolvedValue(okResponse());
    await ice.primeIceConfig(SESSION);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(ice.readIceServers(SESSION)).toEqual(SERVERS);
  });

  test('a malformed payload cannot poison the cache', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse([]));
    await expect(ice.primeIceConfig(SESSION)).resolves.toEqual(ice.ICE_FALLBACK);
    expect(ice.readIceServers(SESSION)).toBeNull();
  });

  test('a hanging request is aborted instead of blocking the prime forever', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = ice.primeIceConfig(SESSION);
    jest.advanceTimersByTime(2600);
    await expect(pending).resolves.toEqual(ice.ICE_FALLBACK);
  });
});

describe('the call path uses the cache', () => {
  test('negotiation reads the cache instead of fetching', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/readIceServers\(session\) \|\| ICE_FALLBACK/);
    expect(CALL_HOOK_SOURCE).not.toMatch(/fetch\('\/api\/rtc-config'/);
    expect(CALL_HOOK_SOURCE).toMatch(/iceCandidatePoolSize: 2/);
  });

  test('the app primes at boot and when the tab returns', () => {
    expect(APP_SOURCE).toMatch(/primeIceConfig\(guest\)/);
    expect(APP_SOURCE).toMatch(/addEventListener\('visibilitychange', onVisible\)/);
  });

  test('gathering starts while the call is still ringing', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/latest\?\.callId === active\.callId && !peerConnectionRef\.current\) prepareConnectionRef\.current\?\.\(active\)/);
  });
});
