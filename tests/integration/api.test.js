'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');

let ctx;

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

async function newSession(displayName = 'Arjun') {
  const res = await request(ctx.app).post('/api/sessions').send({ displayName });
  expect(res.status).toBe(201);
  return res.body.userId;
}

describe('health probes', () => {
  test('/healthz reports the process is alive', async () => {
    const res = await request(ctx.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('/readyz reports the store is reachable', async () => {
    const res = await request(ctx.app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.store).toBe('ok');
  });
});

describe('session endpoint', () => {
  test('issues a uuid session id', async () => {
    const userId = await newSession();
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('rejects a display name that is too short', async () => {
    const res = await request(ctx.app).post('/api/sessions').send({ displayName: 'x' });
    expect(res.status).toBe(400);
  });

  test('rejects a markup display name', async () => {
    const res = await request(ctx.app).post('/api/sessions').send({ displayName: '<script>alert(1)</script>' });
    expect(res.status).toBe(400);
  });
});

describe('room endpoints', () => {
  test('require a valid session id', async () => {
    const res = await request(ctx.app).get('/api/rooms/general/messages');
    expect(res.status).toBe(401);
  });

  test('reject a malformed room slug', async () => {
    const userId = await newSession();
    const res = await request(ctx.app)
      .get('/api/rooms/not%20a%20slug/messages')
      .set('X-Session-Id', userId);
    expect(res.status).toBe(400);
  });

  test('store, broadcast and read back a message', async () => {
    const userId = await newSession();
    await ctx.authorizeRoomForTest(userId, 'engineering');
    const write = await request(ctx.app)
      .post('/api/rooms/engineering/messages')
      .set('X-Session-Id', userId)
      .send({ text: '  deployed   to  staging  ' });
    expect(write.status).toBe(201);
    expect(write.body.text).toBe('deployed to staging');

    const read = await request(ctx.app)
      .get('/api/rooms/engineering/messages')
      .set('X-Session-Id', userId);
    expect(read.status).toBe(200);
    expect(read.body.messages).toHaveLength(1);
    expect(read.body.messages[0].id).toBe(write.body.id);
  });
});

describe('security headers and CORS', () => {
  test('sends CSP and friends', async () => {
    const res = await request(ctx.app).get('/healthz');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('does not allow an unlisted origin', async () => {
    const res = await request(ctx.app)
      .get('/healthz')
      .set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('allows a configured origin', async () => {
    const res = await request(ctx.app)
      .get('/healthz')
      .set('Origin', 'http://127.0.0.1');
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1');
  });

  test('rejects oversized JSON bodies before they reach the handler', async () => {
    const res = await request(ctx.app)
      .post('/api/sessions')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ displayName: 'A'.repeat(1_200_000) }));
    expect(res.status).toBe(413);
  });
});
