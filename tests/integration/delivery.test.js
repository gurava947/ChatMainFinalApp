'use strict';

const request = require('supertest');
const { io: connect } = require('socket.io-client');
const { createTestServer } = require('../helpers/create-test-server');
const { waitFor, emitWithAck, openSocket, record } = require('../helpers/socket-harness');
const { createSession, getSessionToken } = require('../helpers/session-auth');

jest.setTimeout(30000);

let ctx;

async function sessionId(displayName) {
  return createSession(ctx.app, displayName);
}

/** Sends one message from `senderSocket` and resolves with its stored id. */
async function sendMessage(senderSocket, room, text) {
  const ack = await emitWithAck(senderSocket, 'message', { room, text, clientId: crypto.randomUUID() });
  expect(ack.ok).toBe(true);
  return ack.id;
}

function reportDelivered(socket, ids) {
  return emitWithAck(socket, 'message:delivered', { ids });
}

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('delivery receipts', () => {
  test('a freshly sent message carries no delivery receipt', async () => {
    const aId = await sessionId('Ana');
    const bId = await sessionId('Ben');
    await ctx.pairRoomForTest('fresh', [aId, bId]);
    const a = openSocket(ctx.url, aId, 'fresh');
    const b = openSocket(ctx.url, bId, 'fresh');
    await waitFor(b, 'presence', (p) => p.connections === 2);

    await sendMessage(a, 'fresh', 'hello');
    const message = await waitFor(b, 'new_message', (p) => p.text === 'hello');

    // Both users are online, yet presence must not fabricate a delivery.
    expect(message.deliveredTo).toEqual([]);

    a.close();
    b.close();
  });

  test('the recipient device reports delivery and the sender is notified', async () => {
    const aId = await sessionId('Ana');
    const bId = await sessionId('Ben');
    await ctx.pairRoomForTest('receipt', [aId, bId]);
    const a = openSocket(ctx.url, aId, 'receipt');
    const b = openSocket(ctx.url, bId, 'receipt');
    await waitFor(b, 'presence', (p) => p.connections === 2);

    const messageId = await sendMessage(a, 'receipt', 'deliver me');
    await waitFor(b, 'new_message', (p) => p.id === messageId);

    const notified = waitFor(a, 'message_delivered', (p) => p.messageId === messageId);
    const ack = await reportDelivered(b, [messageId]);
    expect(ack).toMatchObject({ ok: true, counted: 1 });

    const receipt = await notified;
    expect(receipt.userId).toBe(bId);
    expect(receipt.room).toBe('receipt');

    const stored = await ctx.store.deliveredByMessages([messageId]);
    expect(stored.get(messageId)).toEqual([bId]);

    a.close();
    b.close();
  });

  test('repeat reports from the same device are absorbed', async () => {
    const aId = await sessionId('Ana');
    const bId = await sessionId('Ben');
    await ctx.pairRoomForTest('dupe', [aId, bId]);
    const a = openSocket(ctx.url, aId, 'dupe');
    const b = openSocket(ctx.url, bId, 'dupe');
    await waitFor(b, 'presence', (p) => p.connections === 2);

    const messageId = await sendMessage(a, 'dupe', 'once only');
    await waitFor(b, 'new_message', (p) => p.id === messageId);

    expect((await reportDelivered(b, [messageId])).counted).toBe(1);
    expect((await reportDelivered(b, [messageId])).counted).toBe(0);

    const stored = await ctx.store.deliveredByMessages([messageId]);
    expect(stored.get(messageId)).toEqual([bId]);

    a.close();
    b.close();
  });

  test('opening history delivers other people messages to the reader', async () => {
    const authorId = await sessionId('Cleo');
    const latecomerId = await sessionId('Dev');
    await ctx.pairRoomForTest('offline-send', [authorId, latecomerId]);

    const author = openSocket(ctx.url, authorId, 'offline-send');
    await waitFor(author, 'history');
    const messageId = await sendMessage(author, 'offline-send', 'sent while alone');
    author.close();

    // The HTTP history route is a real handoff: reading it delivers the room.
    const res = await request(ctx.app)
      .get('/api/rooms/offline-send/messages')
      .set({ 'x-session-id': latecomerId, 'x-session-token': getSessionToken(latecomerId) });
    expect(res.status).toBe(200);

    const message = res.body.messages.find((item) => item.id === messageId);
    expect(message.deliveredTo).toContain(latecomerId);

    const stored = await ctx.store.deliveredByMessages([messageId]);
    expect(stored.get(messageId)).toEqual([latecomerId]);
  });

  test('a reader is never marked as the delivery target of their own message', async () => {
    const userId = await sessionId('Ela');
    const socket = openSocket(ctx.url, userId, 'self-room');
    socket.emit('room:join', { room: `self-${userId}` });
    await waitFor(socket, 'history', (p) => p.room === `self-${userId}`);
    const messageId = await sendMessage(socket, `self-${userId}`, 'to myself');

    const res = await request(ctx.app)
      .get(`/api/rooms/self-${userId}/messages`)
      .set({ 'x-session-id': userId, 'x-session-token': getSessionToken(userId) });

    expect(res.status).toBe(200);
    expect(res.body.messages.find((item) => item.id === messageId).deliveredTo).toEqual([]);
    socket.close();
  });

  test('socket history delivery notifies the online sender too', async () => {
    const senderId = await sessionId('Fay');
    const readerId = await sessionId('Gus');
    await ctx.pairRoomForTest('rejoin', [senderId, readerId]);

    const sender = openSocket(ctx.url, senderId, 'rejoin');
    await waitFor(sender, 'presence', (p) => p.connections === 1);
    const messageId = await sendMessage(sender, 'rejoin', 'waiting for you');

    const notified = waitFor(sender, 'message_delivered', (p) => p.messageId === messageId);
    const reader = openSocket(ctx.url, readerId, 'rejoin');
    await waitFor(reader, 'history', (p) => p.messages.some((item) => item.id === messageId));

    expect((await notified).userId).toBe(readerId);
    sender.close();
    reader.close();
  });

  test('a read receipt implies delivery for clients that never report it', async () => {
    const aId = await sessionId('Hal');
    const bId = await sessionId('Isla');
    await ctx.pairRoomForTest('seen-only', [aId, bId]);
    const a = openSocket(ctx.url, aId, 'seen-only');
    const b = openSocket(ctx.url, bId, 'seen-only');
    await waitFor(b, 'presence', (p) => p.connections === 2);

    const messageId = await sendMessage(a, 'seen-only', 'read is enough');
    await waitFor(b, 'new_message', (p) => p.id === messageId);

    const delivered = waitFor(a, 'message_delivered', (p) => p.messageId === messageId);
    const read = waitFor(a, 'message_seen', (p) => p.messageId === messageId);
    await emitWithAck(b, 'message:seen', { ids: [messageId] });

    expect((await delivered).userId).toBe(bId);
    expect((await read).userId).toBe(bId);

    a.close();
    b.close();
  });

  test('rejects malformed and oversized receipt batches', async () => {
    const userId = await sessionId('Jo');
    const socket = openSocket(ctx.url, userId, 'guards');
    await waitFor(socket, 'history');

    const bad = await emitWithAck(socket, 'message:delivered', { ids: ['not-a-uuid'] });
    expect(bad.ok).toBe(false);

    const empty = await emitWithAck(socket, 'message:delivered', { ids: [] });
    expect(empty.ok).toBe(false);

    const tooMany = await emitWithAck(socket, 'message:delivered', {
      ids: Array.from({ length: 51 }, () => crypto.randomUUID())
    });
    expect(tooMany.ok).toBe(false);

    socket.close();
  });

  test('a socket that never joined a room cannot report delivery', async () => {
    const userId = await sessionId('Lea');
    // No room in the handshake, so the guard has nothing to attribute the receipt to.
    const loose = record(connect(ctx.url, {
      auth: { userId, sessionToken: getSessionToken(userId) },
      transports: ['websocket'],
      forceNew: true
    }));
    await waitFor(loose, 'system', (p) => p.type === 'connected');

    const ack = await emitWithAck(loose, 'message:delivered', { ids: [crypto.randomUUID()] });
    expect(ack).toMatchObject({ ok: false, error: 'join a room first' });

    loose.close();
  });

  test('memory store records each receiver once', async () => {
    const first = await ctx.store.markDelivered('m-1', 'u-1');
    const again = await ctx.store.markDelivered('m-1', 'u-1');
    const other = await ctx.store.markDelivered('m-1', 'u-2');

    expect(first).toBe(true);
    expect(again).toBe(false);
    expect(other).toBe(true);

    const listing = await ctx.store.deliveredByMessages(['m-1', 'm-missing']);
    expect(listing.get('m-1').sort()).toEqual(['u-1', 'u-2']);
    expect(listing.get('m-missing')).toEqual([]);
  });

  test('delivery rate limiting does not consume the read-receipt window', async () => {
    const userId = await sessionId('Kim');
    const socket = openSocket(ctx.url, userId, 'limits');
    await waitFor(socket, 'history');

    const seen = await emitWithAck(socket, 'message:seen', { ids: [crypto.randomUUID()] });
    const delivered = await emitWithAck(socket, 'message:delivered', { ids: [crypto.randomUUID()] });

    // Unknown ids are simply not counted, but neither path is rate_limited here.
    expect(seen.ok).toBe(true);
    expect(delivered.ok).toBe(true);
    socket.close();
  });
});
