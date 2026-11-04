'use strict';

/**
 * The store gate is what stands between a paused function isolate and a page of
 * "store_unavailable" errors: readiness has to be re-checked per request, because
 * a one-shot promise that rejects during cold start would keep answering 503 for
 * the whole life of that instance.
 */
const request = require('supertest');

const createApp = require('../../src/app');
const env = require('../../src/config/env');
const logger = require('../../src/config/logger');
const { ensureUp } = require('../../src/config/redis');
const { errorHandler } = require('../../src/middleware/error-handler');

const storeStub = { constructor: { name: 'MemoryStore' } };
const mediaStub = { handleUpload: (req, res, next) => next() };

function appWith(ensureStore) {
  return createApp({
    chat: {},
    store: storeStub,
    redis: undefined,
    media: mediaStub,
    logger,
    env,
    ensureStore
  });
}

describe('store gate', () => {
  it('lets the next request through once the store comes back', async () => {
    let attempts = 0;
    const ensureStore = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('Connection is closed.'))
        : Promise.resolve();
    };
    const app = appWith(ensureStore);

    const down = await request(app).get('/api/events');
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: 'store_unavailable' });

    const up = await request(app).get('/api/events');
    expect(up.status).toBe(200);
    expect(up.body.store).toBe('MemoryStore');
    expect(attempts).toBe(2);
  });

  it('stays out of the way when there is no redis to wait for', async () => {
    const app = appWith(null);
    const res = await request(app).get('/api/events');
    expect(res.status).toBe(200);
  });

  // The gate bounds the wait itself, so a store that never answers has to be
  // reported before the test framework gives up on the request.
  it('answers 503 within the ceiling when the store never reports back', async () => {
    const ensureStore = () => new Promise(() => {}); // never settles
    const res = await request(appWith(ensureStore)).get('/api/events');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'store_unavailable' });
  }, 8000);
});

describe('ensureUp', () => {
  // A stand-in for the parts of an ioredis handle the gate touches: the status
  // it reports, the socket behind it, and the events that mark a teardown.
  const fake = (status, options = {}) => {
    const listeners = {};
    const client = {
      status,
      connects: 0,
      disconnects: 0,
      pings: 0,
      stream: options.noSocket ? undefined : { writable: true },
      connect() {
        client.connects += 1;
        client.status = 'ready';
        client.stream = { writable: true };
        return options.rejectConnect
          ? Promise.reject(new Error('Redis is already connecting/connected'))
          : Promise.resolve();
      },
      once(event, handler) { (listeners[event] = listeners[event] || []).push(handler); },
      emit(event) { (listeners[event] || []).forEach((fn) => fn()); },
      disconnect() {
        client.disconnects += 1;
        // ioredis only settles to "end" on a later turn of the loop, which is
        // why the gate waits for the event rather than assuming it.
        client.stream = { writable: false };
        setTimeout(() => { client.status = 'end'; client.emit('end'); }, 0).unref();
      },
      ping() {
        client.pings += 1;
        return client.stream && client.stream.writable ? Promise.resolve('PONG') : Promise.reject(new Error('Connection is closed.'));
      }
    };
    return client;
  };

  it('does nothing for a handle with a live socket', async () => {
    const client = fake('ready');
    await expect(ensureUp(client)).resolves.toBeUndefined();
    expect(client.connects).toBe(0);
    expect(client.pings).toBe(0);
    expect(client.disconnects).toBe(0);
  });

  it('re-opens a connection that ended', async () => {
    const client = fake('end', { noSocket: true });
    await ensureUp(client);
    expect(client.connects).toBe(1);
    expect(client.pings).toBe(0);
  });

  it('waits for a client that is still retrying', async () => {
    const client = fake('reconnecting', { noSocket: true });
    let settled = false;
    const pending = ensureUp(client).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(client.connects).toBe(0);
    client.status = 'ready';
    client.emit('ready');
    await pending;
    expect(settled).toBe(true);
  });

  it('treats a concurrent connect as success', async () => {
    const client = fake('wait', { rejectConnect: true, noSocket: true });
    await expect(ensureUp(client)).resolves.toBeUndefined();
    expect(client.connects).toBe(1);
  });

  it('re-opens a handle whose ready status has gone stale', async () => {
    // The socket died but the status has not caught up. Handing this back to the
    // caller would put "Connection is closed." in the middle of a route, so the
    // gate tears the handle down, waits for that to settle, and proves the new
    // socket carries a command.
    const client = fake('ready');
    client.stream = { writable: false };
    await ensureUp(client);
    expect(client.disconnects).toBe(1);
    expect(client.connects).toBe(1);
    expect(client.pings).toBe(1);
  });

  it('lets a store that never answers fail the gate', async () => {
    const client = fake('ready');
    client.stream = { writable: false };
    client.ping = () => Promise.reject(new Error('Connection is closed.'));
    await expect(ensureUp(client)).rejects.toThrow('Connection is closed.');
  });
});

describe('connection failures inside a route', () => {
  // The gate cannot see a socket that goes half-open after it cleared, so the
  // command fails mid-request. That is still a store outage, not an app fault.
  function respond(err) {
    let status = 0;
    let body = null;
    const res = {
      status(code) { status = code; return res; },
      json(payload) { body = payload; return res; }
    };
    errorHandler(err, { path: '/api/messages' }, res, () => {});
    return { status, body };
  }

  const down = [
    new Error('Connection is closed.'),
    Object.assign(new Error('Reached the max retries per request limit'), { name: 'MaxRetriesPerRequestError' }),
    Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
  ];

  it.each(down)('answers retryable 503 for %o', (err) => {
    const res = respond(err);
    expect(res.status).toBe(503);
    // Outside production the handler adds a detail field; the contract is the
    // retryable code, which is what the client keys its backoff on.
    expect(res.body).toMatchObject({ error: 'store_unavailable' });
  });

  it('still reports a real bug as a 500', () => {
    const res = respond(new TypeError('cannot read property of undefined'));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_error');
  });

  it('leaves a client error alone', () => {
    const res = respond(Object.assign(new Error('bad room name'), { statusCode: 400 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad room name');
  });
});
