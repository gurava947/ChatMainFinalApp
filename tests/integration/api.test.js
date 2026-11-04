'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');
const { createSession, sessionHeaders } = require('../helpers/session-auth');

let ctx;

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

async function newSession(displayName = 'Arjun') {
  return createSession(ctx.app, displayName);
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
    expect(sessionHeaders(userId)['X-Session-Token']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await ctx.chat.getSession(userId);
    expect(stored.sessionTokenHash).toMatch(/^[a-f\d]{64}$/);
    expect(stored.sessionToken).toBeUndefined();
    const authenticated = await request(ctx.app)
      .get(`/api/sessions/${userId}`)
      .set(sessionHeaders(userId));
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.sessionToken).toBeUndefined();
  });

  test('does not accept a public user id as an authentication credential', async () => {
    const userId = await newSession();
    const res = await request(ctx.app)
      .get('/api/me/self')
      .set('X-Session-Id', userId);
    expect(res.status).toBe(401);
  });

  test('rejects a display name that is too short', async () => {
    const res = await request(ctx.app).post('/api/sessions').send({ displayName: 'x' });
    expect(res.status).toBe(400);
  });

  test('does not disclose a session when only its public id is provided', async () => {
    const userId = await newSession();
    const res = await request(ctx.app).get(`/api/sessions/${userId}`);
    expect(res.status).toBe(401);
  });

  test('rejects a token that does not match the public session id', async () => {
    const userId = await newSession();
    const res = await request(ctx.app)
      .get('/api/me/self')
      .set({ 'X-Session-Id': userId, 'X-Session-Token': 'B'.repeat(43) });
    expect(res.status).toBe(401);
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
      .set(sessionHeaders(userId));
    expect(res.status).toBe(400);
  });

  test('store, broadcast and read back a message', async () => {
    const userId = await newSession();
    await ctx.authorizeRoomForTest(userId, 'engineering');
    const write = await request(ctx.app)
      .post('/api/rooms/engineering/messages')
      .set(sessionHeaders(userId))
      .send({ text: '  deployed   to  staging  ' });
    expect(write.status).toBe(201);
    expect(write.body.text).toBe('deployed to staging');

    const read = await request(ctx.app)
      .get('/api/rooms/engineering/messages')
      .set(sessionHeaders(userId));
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

  test('allows the session token header on a configured CORS preflight', async () => {
    const res = await request(ctx.app)
      .options('/api/me/self')
      .set('Origin', 'http://127.0.0.1')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-session-id,x-session-token');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toContain('X-Session-Token');
  });

  test('rejects oversized JSON bodies before they reach the handler', async () => {
    const res = await request(ctx.app)
      .post('/api/sessions')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ displayName: 'A'.repeat(1_200_000) }));
    expect(res.status).toBe(413);
  });
});
