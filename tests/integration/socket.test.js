'use strict';

const request = require('supertest');
const { io: connect } = require('socket.io-client');
const { createTestServer } = require('../helpers/create-test-server');
const { waitFor, emitWithAck, openSocket } = require('../helpers/socket-harness');
const { createSession, rememberSession, sessionHeaders } = require('../helpers/session-auth');

jest.setTimeout(30000);

let ctx;

async function sessionId(displayName) {
  return createSession(ctx.app, displayName);
}

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('socket handshake', () => {
  test('rejects an unknown session id', async () => {
    const socket = openSocket(ctx.url, '00000000-0000-4000-8000-000000000000', 'general');
    const error = await new Promise((resolve) => socket.once('connect_error', resolve));
    expect(error.message).toBe('unauthorized');
    socket.close();
  });

  test('rejects a known public user id without its session token', async () => {
    const userId = await sessionId('Sana');
    const socket = connect(ctx.url, {
      auth: { userId, room: 'launch' },
      transports: ['websocket'],
      forceNew: true
    });
    const error = await new Promise((resolve) => socket.once('connect_error', resolve));
    expect(error.message).toBe('unauthorized');
    socket.close();
  });

  test('delivers history and presence on join', async () => {
    const userId = await sessionId('Maya');
    const socket = openSocket(ctx.url, userId, 'launch');

    const history = await waitFor(socket, 'history');
    const presence = await waitFor(socket, 'presence');

    expect(history.room).toBe('launch');
    expect(Array.isArray(history.messages)).toBe(true);
    expect(presence.onlineUsers).toBe(1);
    socket.close();
  });
});

describe('two-user room', () => {
  let a;
  let b;
  let aId;
  let bId;

  beforeEach(async () => {
    aId = await sessionId('Ana');
    bId = await sessionId('Ben');

    a = openSocket(ctx.url, aId, 'standup');
    await waitFor(a, 'presence', (p) => p.connections === 1);

    b = openSocket(ctx.url, bId, 'standup');
    await waitFor(b, 'presence', (p) => p.connections === 2);
  });

  afterEach(() => {
    a.close();
    b.close();
  });

  test('both members see the broadcast message, sanitised', async () => {
    const onSender = waitFor(b, 'new_message');
    const onPeer = waitFor(a, 'new_message');

    const ack = await emitWithAck(b, 'message', { text: '<b>ship</b> it', clientId: 'c-1' });
    expect(ack.ok).toBe(true);

    const [mine, theirs] = await Promise.all([onSender, onPeer]);
    expect(mine.text).toBe('ship it');
    expect(theirs.text).toBe('ship it');
    expect(theirs.userId).toBe(bId);
    expect(theirs.displayName).toBe('Ben');
  });

  test('a read receipt reaches the sender once, however often it is re-sent', async () => {
    const sent = await emitWithAck(b, 'message', { text: 'read me', clientId: 'seen-1' });
    expect(sent.ok).toBe(true);

    const received = await waitFor(a, 'new_message', (m) => m.id === sent.id);
    expect(received.seenBy).toEqual([]);

    const first = await emitWithAck(a, 'message:seen', { ids: [sent.id] });
    expect(first).toEqual({ ok: true, counted: 1 });

    const receipt = await waitFor(b, 'message_seen', (p) => p.messageId === sent.id);
    expect(receipt.userId).toBe(aId);
    expect(receipt.displayName).toBe('Ana');

    const repeat = await emitWithAck(a, 'message:seen', { ids: [sent.id] });
    expect(repeat).toEqual({ ok: true, counted: 0 });

    await new Promise((resolve) => setTimeout(resolve, 250));
    const duplicates = a.__events.filter((e) => e.name === 'message_seen' && e.payload.messageId === sent.id);
    expect(duplicates).toHaveLength(0);

    const history = await request(ctx.app)
      .get('/api/rooms/standup/messages')
      .set(sessionHeaders(bId));
    const hydrated = history.body.messages.find((m) => m.id === sent.id);
    expect(hydrated.seenBy).toEqual([aId]);
  });

  test('a receipt for a message the reader never received is still attributed to the reader', async () => {
    const ack = await emitWithAck(a, 'message:seen', { ids: ['11111111-1111-4111-8111-111111111111'] });
    expect(ack.ok).toBe(true);
  });

  test('a malformed receipt payload is rejected', async () => {
    const ack = await emitWithAck(a, 'message:seen', { ids: ['not-a-uuid'] });
    expect(ack.ok).toBe(false);
  });

  test('a wall-of-text message is delivered whole', async () => {
    const long = 'line\n'.repeat(4000);
    const onPeer = waitFor(a, 'new_message', (m) => m.text.startsWith('long:'));
    const sender = waitFor(b, 'new_message', (m) => m.text.startsWith('long:'));

    const ack = await emitWithAck(b, 'message', { text: `long:${long}` });
    expect(ack.ok).toBe(true);

    const [mine, theirs] = await Promise.all([onPeer, sender]);
    // Only the trailing newline is dropped, by the trim in sanitiseText.
    expect(mine.text).toBe(`long:${long}`.trimEnd());
    expect(mine.text.length).toBe(long.length + 5 - 1);
    expect(theirs.text).toBe(mine.text);
  });

  test('an attachment the sender never uploaded is rejected', async () => {
    const ack = await emitWithAck(b, 'message', {
      text: 'phantom',
      attachments: [{
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'image',
        name: 'ghost.png',
        mime: 'image/png',
        size: 8
      }]
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/unknown attachment/);
  });

  test('announces the join and counts connections separately from users', async () => {
    const joined = await waitFor(a, 'user_joined', (p) => p.userId === bId);
    expect(joined.displayName).toBe('Ben');

    const snapshot = await waitFor(a, 'presence', (p) => p.connections === 2);
    expect(snapshot.onlineUsers).toBe(2);
  });

  test('relays call invites and SDP only between active members of the same room', async () => {
    const callId = 'c2b8a48b-73ca-4c7e-8dc2-923b55ea1b40';
    const incoming = waitFor(b, 'call:incoming');
    const inviteAck = await emitWithAck(a, 'call:invite', { targetSocketId: b.id, callId, mode: 'video' });
    expect(inviteAck.ok).toBe(true);
    expect(await incoming).toMatchObject({ callId, mode: 'video', fromDisplayName: 'Ana' });

    const accepted = waitFor(a, 'call:accepted');
    expect(await emitWithAck(b, 'call:accept', { targetSocketId: a.id, callId })).toMatchObject({ ok: true });
    expect(await accepted).toMatchObject({ callId, fromDisplayName: 'Ben' });

    const offer = waitFor(b, 'call:offer');
    const offerAck = await emitWithAck(a, 'call:offer', {
      targetSocketId: b.id,
      callId,
      description: { type: 'offer', sdp: 'v=0\\r\\no=- 1 1 IN IP4 127.0.0.1\\r\\n' }
    });
    expect(offerAck.ok).toBe(true);
    expect(await offer).toMatchObject({ callId, description: { type: 'offer' }, fromDisplayName: 'Ana' });

    const outsiderId = await sessionId('Cleo');
    const outsider = openSocket(ctx.url, outsiderId, 'different-room');
    await waitFor(outsider, 'presence');
    const rejected = await emitWithAck(a, 'call:invite', { targetSocketId: outsider.id, callId: 'c2b8a48b-73ca-4c7e-8dc2-923b55ea1b41', mode: 'audio' });
    expect(rejected.ok).toBe(false);
    outsider.close();
  });

  test('typing signals reach the peer and clear on stop', async () => {
    const typing = waitFor(a, 'typing');
    b.emit('typing');
    await expect(typing).resolves.toMatchObject({ displayName: 'Ben' });

    const stopped = waitFor(a, 'stop_typing');
    b.emit('stop_typing');
    await expect(stopped).resolves.toMatchObject({ userId: bId });
  });

  test('disconnect announces user_left and decrements presence', async () => {
    const left = waitFor(a, 'user_left', (p) => p.userId === bId);
    const presence = waitFor(a, 'presence', (p) => p.connections === 1);

    b.close();

    expect((await left).displayName).toBe('Ben');
    expect((await presence).onlineUsers).toBe(1);
  });

  test('a message addressed to a room the socket has not joined is rejected', async () => {
    const ack = await emitWithAck(a, 'message', { room: 'other', text: 'sneaky' });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('room mismatch');
  });

  test('an empty message is rejected before it reaches the cache', async () => {
    const ack = await emitWithAck(a, 'message', { text: '   ' });
    expect(ack.ok).toBe(false);
  });
});

describe('room switching', () => {
  test('rejoining moves presence to the new room', async () => {
    const userId = await sessionId('Nina');
    const socket = openSocket(ctx.url, userId, 'first');
    await waitFor(socket, 'presence', (p) => p.connections === 1);

    const ack = await emitWithAck(socket, 'room:join', { room: 'second', password: 'InChatTestPassword!' });
    expect(ack.ok).toBe(true);

    const history = await waitFor(socket, 'history', (p) => p.room === 'second');
    expect(history.messages).toEqual([]);

    const presence = await waitFor(socket, 'presence', (p) => p.users.length === 1 && p.users[0].userId === userId);
    expect(presence.connections).toBe(1);
    socket.close();
  });
});

describe('per-socket send throttle', () => {
  let limited;

  beforeAll(async () => {
    limited = await createTestServer({ sendLimit: 2 });
  });

  afterAll(async () => {
    await limited.close();
  });

  test('the third message in the window is rejected', async () => {
    const res = await request(limited.app).post('/api/sessions').send({ displayName: 'Spam' });
    rememberSession(res.body);
    const socket = openSocket(limited.url, res.body.userId, 'flood');
    await waitFor(socket, 'presence');

    const first = await emitWithAck(socket, 'message', { text: 'one' });
    const second = await emitWithAck(socket, 'message', { text: 'two' });
    const third = await emitWithAck(socket, 'message', { text: 'three' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual({ ok: false, error: 'rate_limited' });
    socket.close();
  });
});

describe('a send that meets a store outage', () => {
  let broken;

  beforeAll(async () => {
    broken = await createTestServer();
  });

  afterAll(async () => {
    await broken.close();
  });

  // The gate clears before the handler runs, so a socket that goes half-open
  // mid-command still fails inside sendMessage. The ack has to name it as the
  // retryable case it is, or the client marks the message failed for good.
  test('acks store_unavailable rather than the driver text', async () => {
    // Sessions live in the store of the server that will answer the handshake.
    const res = await request(broken.app).post('/api/sessions').send({ displayName: 'Wrecker' });
    rememberSession(res.body);
    const socket = openSocket(broken.url, res.body.userId, 'outage');
    await waitFor(socket, 'presence', (p) => p.connections === 1);

    const first = Object.assign(new Error('Connection is closed.'), { name: 'ConnectionClosedError' });
    const claim = broken.store.claimSend.bind(broken.store);
    broken.store.claimSend = () => Promise.reject(first);
    let ack;
    try {
      ack = await emitWithAck(socket, 'message', { text: 'written during the outage', clientId: crypto.randomUUID() });
    } finally {
      broken.store.claimSend = claim;
    }

    expect(ack).toEqual({ ok: false, error: 'store_unavailable' });
    socket.close();
  });

  test('acks a rejected payload unchanged', async () => {
    const res = await request(broken.app).post('/api/sessions').send({ displayName: 'Honest' });
    rememberSession(res.body);
    const socket = openSocket(broken.url, res.body.userId, 'valid');
    await waitFor(socket, 'presence', (p) => p.connections === 1);

    const ack = await emitWithAck(socket, 'message', { text: '   ' });
    expect(ack.ok).toBe(false);
    expect(ack.error).not.toBe('store_unavailable');
    socket.close();
  });
});

describe('events that arrive during the handshake join', () => {
  let slow;

  beforeAll(async () => {
    slow = await createTestServer();
    const track = slow.store.trackPresence.bind(slow.store);
    slow.store.trackPresence = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return track(...args);
    };
  });

  afterAll(async () => {
    await slow.close();
  });

  // A client that sends the moment it is connected used to be answered with
  // nothing at all: the join was still awaiting the store when the packet
  // landed, and no listener existed for it yet.
  test('a message sent before the join finishes still gets its ack', async () => {
    const res = await request(slow.app).post('/api/sessions').send({ displayName: 'Rusher' });
    rememberSession(res.body);
    const socket = connect(slow.url, {
      auth: {
        userId: res.body.userId,
        sessionToken: res.body.sessionToken,
        room: 'rushed',
        roomPassword: 'InChatTestPassword!'
      },
      transports: ['websocket'],
      forceNew: true
    });

    const ack = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ack for "message"')), 6000);
      socket.on('connect', () => {
        socket.emit('message', { text: 'sent while the join was running' }, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    });

    await expect(ack).resolves.toMatchObject({ ok: true });
    socket.close();
  });
});
