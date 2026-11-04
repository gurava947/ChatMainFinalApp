'use strict';

const express = require('express');
const request = require('supertest');

const { createLimiter } = require('../../src/middleware/rate-limit');

/**
 * The shape ioredis exposes: every Redis command word is a lower-cased method
 * that takes the remaining arguments in order. rate-limit-redis v4 has no
 * `client` option, so a limiter built with the wrong wiring throws while the
 * app is still loading, which is how a Redis deployment ends up as a 500 page.
 */
function fakeRedis() {
  const calls = [];
  let hits = 0;

  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    if (name === 'script') return Promise.resolve('sha-mock');
    if (name === 'evalsha') {
      if (args[3] === '0' || args[3] === '1') hits += 1;
      return Promise.resolve([hits, Date.now() + 60000]);
    }
    return Promise.resolve(1);
  };

  return {
    calls,
    script: record('script'),
    evalsha: record('evalsha'),
    get: record('get'),
    decr: record('decr'),
    del: record('del')
  };
}

describe('Redis-backed rate limiter', () => {
  test('constructs from an ioredis-shaped client instead of throwing', () => {
    expect(() => createLimiter({ name: 'api', limit: 5, windowMs: 60000, redis: fakeRedis() })).not.toThrow();
  });

  test('counts hits through the client and blocks past the limit', async () => {
    const client = fakeRedis();
    const app = express();
    app.use(createLimiter({ name: 'unit', limit: 2, windowMs: 60000, redis: client }));
    app.get('/ping', (_req, res) => res.json({ pong: true }));

    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(429);

    const commands = client.calls.map(([name]) => name);
    expect(commands).toContain('script');
    expect(commands).toContain('evalsha');
    expect(client.calls.find(([name]) => name === 'evalsha')[3]).toMatch(/^chat:rl:unit:/);
  });

  test('stays open when no Redis client is configured', async () => {
    const app = express();
    app.use(createLimiter({ name: 'unit', limit: 1, windowMs: 60000 }));
    app.get('/ping', (_req, res) => res.json({ pong: true }));

    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(429);
  });
});
