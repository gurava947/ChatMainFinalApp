'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');

jest.setTimeout(30000);

let ctx;

async function createSession(displayName) {
  const response = await request(ctx.app).post('/api/sessions').send({ displayName });
  expect(response.status).toBe(201);
  return response.body.userId;
}

function accessRequest(method, room, userId, password) {
  const requestBuilder = request(ctx.app)[method](`/api/rooms/${room}/access`)
    .set('X-Session-Id', userId);
  return password === undefined ? requestBuilder.send({}) : requestBuilder.send({ password });
}

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('shared room passwords', () => {
  test('requires a password for a new room and grants access only after an exact match', async () => {
    const owner = await createSession('Asha');
    const guest = await createSession('Ravi');
    const room = 'password-room';

    const missing = await accessRequest('post', room, owner);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('password_required');

    const created = await accessRequest('post', room, owner, '  SharedRoomPass!  ');
    expect(created.status).toBe(200);
    expect(created.body.authorized).toBe(true);

    const mismatch = await accessRequest('post', room, guest, 'SharedRoomPass!');
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error).toBe('invalid_password');

    expect((await accessRequest('get', room, guest)).body.authorized).toBe(false);
    const joined = await accessRequest('post', room, guest, '  SharedRoomPass!  ');
    expect(joined.status).toBe(200);
    expect((await accessRequest('get', room, guest)).body.authorized).toBe(true);
  });

  test('protects room history until the guest is authorized', async () => {
    const owner = await createSession('Mina');
    const guest = await createSession('Dev');
    const room = 'history-password-room';
    await accessRequest('post', room, owner, 'HistoryPass123');

    const blocked = await request(ctx.app)
      .get(`/api/rooms/${room}/messages`)
      .set('X-Session-Id', guest);
    expect(blocked.status).toBe(403);

    await accessRequest('post', room, guest, 'HistoryPass123');
    const allowed = await request(ctx.app)
      .get(`/api/rooms/${room}/messages`)
      .set('X-Session-Id', guest);
    expect(allowed.status).toBe(200);
  });

  test('keeps rooms that already have message history passwordless', async () => {
    const guest = await createSession('Nila');
    const room = 'legacy-open-room';
    await ctx.store.pushMessage(room, {
      id: 'legacy-message',
      room,
      userId: 'legacy-user',
      displayName: 'Legacy',
      text: 'Still here',
      ts: Date.now()
    });

    const joined = await accessRequest('post', room, guest);
    expect(joined.status).toBe(200);
    expect(joined.body.legacy).toBe(true);
    expect((await accessRequest('get', room, guest)).body.authorized).toBe(true);
  });
});
