'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');
const { waitFor, emitWithAck, openSocket } = require('../helpers/socket-harness');
const { createSession, sessionHeaders } = require('../helpers/session-auth');

jest.setTimeout(30000);

const settle = (ms = 150) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Every new_message payload a recorded socket was handed. */
const received = (socket) => socket.__events
  .filter((event) => event.name === 'new_message')
  .map((event) => event.payload.text);

let ctx;

async function sessionId(displayName) {
  return createSession(ctx.app, displayName);
}

const as = sessionHeaders;

async function post(room, userId, text) {
  await ctx.authorizeRoomForTest(userId, room);
  const res = await request(ctx.app)
    .post(`/api/rooms/${room}/messages`)
    .set(as(userId))
    .send({ text, clientId: crypto.randomUUID() });
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function history(room, userId) {
  await ctx.authorizeRoomForTest(userId, room);
  const res = await request(ctx.app).get(`/api/rooms/${room}/messages`).set(as(userId));
  expect(res.status).toBe(200);
  return res.body.messages;
}

async function settings(room, userId) {
  await ctx.authorizeRoomForTest(userId, room);
  const res = await request(ctx.app).get(`/api/rooms/${room}/settings`).set(as(userId));
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('chat settings are per viewer', () => {
  test('a fresh viewer sees every message and has empty settings', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    await post('plain', ana, 'first');
    await post('plain', ben, 'second');

    expect((await history('plain', ana)).map((m) => m.text)).toEqual(['first', 'second']);
    expect(await settings('plain', ana)).toMatchObject({ blocked: [], clearedAt: 0, theme: 'default', hidden: [] });
  });

  test('clearing for one guest leaves the other guest history untouched', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    await post('cleared', ana, 'before ana cleared');
    await post('cleared', ben, 'before ben sees it');

    const clear = await request(ctx.app).post('/api/rooms/cleared/clear').set(as(ana));
    expect(clear.status).toBe(200);
    expect(Number(clear.body.clearedAt)).toBeGreaterThan(0);

    expect(await history('cleared', ana)).toEqual([]);
    expect((await history('cleared', ben)).map((m) => m.text))
      .toEqual(['before ana cleared', 'before ben sees it']);

    await new Promise((resolve) => { setTimeout(resolve, 10); });
    await post('cleared', ben, 'after the clear');
    expect((await history('cleared', ana)).map((m) => m.text)).toEqual(['after the clear']);
  });

  test('blocking hides that sender for the blocker only', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    await post('blocked', ana, 'from ana');
    await post('blocked', ben, 'from ben');

    const block = await request(ctx.app).post('/api/me/blocks').set(as(ben)).send({ userId: ana, displayName: 'Ana' });
    expect(block.status).toBe(201);
    expect(block.body.blocked).toEqual([{ userId: ana, displayName: 'Ana', blockedAt: expect.any(Number) }]);

    expect((await history('blocked', ben)).map((m) => m.text)).toEqual(['from ben']);
    expect((await history('blocked', ana)).map((m) => m.text)).toEqual(['from ana', 'from ben']);

    const listed = await request(ctx.app).get('/api/me/blocks').set(as(ben));
    expect(listed.body.blocked.map((entry) => entry.userId)).toEqual([ana]);

    const unblocked = await request(ctx.app).delete(`/api/me/blocks/${ana}`).set(as(ben));
    expect(unblocked.status).toBe(200);
    expect(unblocked.body.blocked).toEqual([]);
    expect((await history('blocked', ben)).map((m) => m.text)).toEqual(['from ana', 'from ben']);
  });

  test('hiding message ids deletes for me without erasing the shared room', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const firstId = await post('selective', ana, 'delete this one');
    await post('selective', ben, 'keep this one');

    const hide = await request(ctx.app).post('/api/rooms/selective/messages/hide').set(as(ana)).send({ ids: [firstId] });
    expect(hide.status).toBe(200);
    expect(hide.body.hidden).toEqual([firstId]);

    expect((await history('selective', ana)).map((m) => m.text)).toEqual(['keep this one']);
    expect((await history('selective', ben)).map((m) => m.text)).toEqual(['delete this one', 'keep this one']);

    const unhide = await request(ctx.app).post('/api/rooms/selective/messages/unhide').set(as(ana)).send({ ids: [firstId] });
    expect(unhide.body.hidden).toEqual([]);
    expect((await history('selective', ana)).map((m) => m.text)).toEqual(['delete this one', 'keep this one']);
  });

  test('the theme is stored per viewer and only accepts known names', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    await ctx.authorizeRoomForTest(ana, 'themed');
    await ctx.authorizeRoomForTest(ben, 'themed');

    const saved = await request(ctx.app).put('/api/rooms/themed/settings/theme').set(as(ana)).send({ theme: 'forest' });
    expect(saved.status).toBe(200);
    expect(saved.body.theme).toBe('forest');
    expect((await settings('themed', ana)).theme).toBe('forest');
    expect((await settings('themed', ben)).theme).toBe('default');

    const bogus = await request(ctx.app).put('/api/rooms/themed/settings/theme').set(as(ana)).send({ theme: 'chartreuse' });
    expect(bogus.status).toBe(400);
  });

  test('blocking needs a real session, so anonymous requests get 401', async () => {
    const anonymous = await request(ctx.app).get('/api/rooms/plain/settings');
    expect(anonymous.status).toBe(401);
    expect((await request(ctx.app).post('/api/rooms/plain/clear')).status).toBe(401);
  });

  test('a guest cannot block their own session', async () => {
    const ana = await sessionId('Ana');
    const res = await request(ctx.app).post('/api/me/blocks').set(as(ana)).send({ userId: ana });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('you cannot block your own session');
  });

  test('deleting a shared room only drops this viewer settings', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    await post('shared-delete', ana, 'still here');
    await request(ctx.app).post('/api/rooms/shared-delete/clear').set(as(ana));

    const res = await request(ctx.app).delete('/api/rooms/shared-delete').set(as(ana));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room: 'shared-delete', deleted: false, selfRoom: false });

    expect((await history('shared-delete', ben)).map((m) => m.text)).toEqual(['still here']);
    expect(await settings('shared-delete', ana)).toMatchObject({ clearedAt: 0, hidden: [], theme: 'default' });
  });

  test('deleting a self room empties it for everyone because the session owns it', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const selfRoom = (await request(ctx.app).get('/api/me/self').set(as(ana))).body.room;

    await post(selfRoom, ana, 'private note');
    const outsiderRead = await request(ctx.app).get(`/api/rooms/${selfRoom}/messages`).set(as(ben));
    expect(outsiderRead.status).toBe(403);
    const outsider = await request(ctx.app).delete(`/api/rooms/${selfRoom}`).set(as(ben));
    expect(outsider.status).toBe(403);
    expect(await history(selfRoom, ana)).toHaveLength(1);

    const owner = await request(ctx.app).delete(`/api/rooms/${selfRoom}`).set(as(ana));
    expect(owner.body).toMatchObject({ deleted: true, selfRoom: true, removed: 1 });
    expect(await history(selfRoom, ana)).toEqual([]);
  });

  test('a blocked author is filtered on the wire, not only in history', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const cleo = await sessionId('Cleo');
    const anaSock = openSocket(ctx.url, ana, 'liveblock');
    const benSock = openSocket(ctx.url, ben, 'liveblock');
    const cleoSock = openSocket(ctx.url, cleo, 'liveblock');
    await waitFor(cleoSock, 'presence', (p) => p.connections === 3);

    await request(ctx.app).post('/api/me/blocks').set(as(ben)).send({ userId: ana, displayName: 'Ana' });

    await emitWithAck(anaSock, 'message', { room: 'liveblock', text: 'quiet please', clientId: crypto.randomUUID() });
    await waitFor(cleoSock, 'new_message', (p) => p.text === 'quiet please');
    await settle();

    expect(received(cleoSock)).toContain('quiet please');
    expect(received(anaSock)).toContain('quiet please');
    expect(received(benSock)).not.toContain('quiet please');
    expect(received(benSock)).toEqual([]);

    const unblock = await request(ctx.app).delete(`/api/me/blocks/${ana}`).set(as(ben));
    expect(unblock.body.blocked).toEqual([]);

    await emitWithAck(anaSock, 'message', { room: 'liveblock', text: 'welcome back', clientId: crypto.randomUUID() });
    await waitFor(benSock, 'new_message', (p) => p.text === 'welcome back');
    expect(received(benSock)).toEqual(['welcome back']);

    anaSock.close();
    benSock.close();
    cleoSock.close();
  });

  test('a viewer earns no delivery receipt for content they hid from themselves', async () => {    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const cleo = await sessionId('Cleo');
    const hiddenId = await post('receipts', ben, 'ana hid this');
    const keptId = await post('receipts', ben, 'ana still receives this');

    await ctx.authorizeRoomForTest(ana, 'receipts');
    await request(ctx.app).post('/api/rooms/receipts/messages/hide').set(as(ana)).send({ ids: [hiddenId] });
    const anaRows = await history('receipts', ana);
    expect(anaRows.map((m) => m.id)).toEqual([keptId]);

    // Cleo saw both rows, so the receipts recorded on them show exactly which
    // message Ana's device was allowed to receive.
    const cleoRows = await history('receipts', cleo);
    const rowFor = (id) => cleoRows.find((m) => m.id === id);
    expect(rowFor(keptId).deliveredTo).toContain(ana);
    expect(rowFor(hiddenId).deliveredTo).not.toContain(ana);
  });
});
