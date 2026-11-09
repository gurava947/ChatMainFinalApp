'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');
const { createSession } = require('../helpers/session-auth');

let ctx;

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('session cookie', () => {
  test('a browser agent works with the HttpOnly cookie and no token header', async () => {
    const agent = request.agent(ctx.app);
    const created = await agent.post('/api/sessions').send({ displayName: 'Cookie Guest' });

    expect(created.status).toBe(201);
    const cookie = created.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/inchat_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);

    const me = await agent.get('/api/me/self');
    expect(me.status).toBe(200);
    expect(me.body.displayName).toBe('Cookie Guest');
  });

  test('sign out expires the cookie so the same agent is anonymous again', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/api/sessions').send({ displayName: 'Cookie Leaver' });
    expect((await agent.get('/api/me/self')).status).toBe(200);

    const out = await agent.delete('/api/sessions/current');
    expect(out.status).toBe(204);
    expect(out.headers['set-cookie'].join(';')).toMatch(/Max-Age=0/);

    expect((await agent.get('/api/me/self')).status).toBe(401);
  });

  test('sign out revokes the token for header clients too', async () => {
    const userId = await createSession(ctx.app, 'Revoked Tool');
    const headers = {
      'X-Session-Id': userId,
      'X-Session-Token': require('../helpers/session-auth').getSessionToken(userId)
    };
    expect((await request(ctx.app).get('/api/me/self').set(headers)).status).toBe(200);
    await request(ctx.app).delete('/api/sessions/current').set(headers).expect(204);
    expect((await request(ctx.app).get('/api/me/self').set(headers)).status).toBe(401);
  });

  test('the token stays out of the JSON body unless tooling opts in', async () => {
    const browser = await request(ctx.app).post('/api/sessions').send({ displayName: 'Browser Body' });
    expect(browser.status).toBe(201);
    expect(browser.body.sessionToken).toBeUndefined();
    expect(browser.headers['set-cookie'].join(';')).toMatch(/inchat_session=/);

    const tool = await request(ctx.app)
      .post('/api/sessions')
      .set('X-Session-Transport', 'token')
      .send({ displayName: 'Tool Body' });
    expect(tool.status).toBe(201);
    expect(tool.body.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('the header credential still works for API tooling', async () => {
    const userId = await createSession(ctx.app, 'Header Tool');
    const me = await request(ctx.app)
      .get('/api/me/self')
      .set('X-Session-Id', userId)
      .set('X-Session-Token', require('../helpers/session-auth').getSessionToken(userId));
    expect(me.status).toBe(200);
  });
});

describe('pairing-code attempts', () => {
  test('are capped per room and address', async () => {
    const userId = await createSession(ctx.app, 'Code Guesser');
    const room = `guess-${Date.now()}`;
    const headers = { 'X-Session-Id': userId, 'X-Session-Token': require('../helpers/session-auth').getSessionToken(userId) };

    let last;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      last = await request(ctx.app)
        .post(`/api/rooms/${room}/access`)
        .set(headers)
        .send({ credential: 'WRONGCODE' });
    }
    expect(last.status).toBe(429);
    expect(last.body.error).toBe('rate_limited');
  });
});

describe('metrics endpoint', () => {
  test('publishes counters and records an accepted message', async () => {
    const userId = await createSession(ctx.app, 'Metric Guest');
    const token = require('../helpers/session-auth').getSessionToken(userId);
    const headers = { 'X-Session-Id': userId, 'X-Session-Token': token };
    const room = `metrics-${Date.now()}`;

    await request(ctx.app).post(`/api/rooms/${room}/access`).set(headers).send({}).expect(200);
    await request(ctx.app)
      .post(`/api/rooms/${room}/messages`)
      .set(headers)
      .send({ text: 'one for the counter' })
      .expect(201);

    const res = await request(ctx.app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('chat_messages_sent_total');
    expect(res.text).toMatch(/chat_messages_sent_total \d+/);
    expect(res.text).toContain('chat_active_sockets');
  });
});
