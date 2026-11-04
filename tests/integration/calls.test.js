'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');
const { waitFor, emitWithAck, openSocket } = require('../helpers/socket-harness');

jest.setTimeout(30000);

let ctx;

async function sessionId(displayName) {
  const res = await request(ctx.app).post('/api/sessions').send({ displayName });
  expect(res.status).toBe(201);
  return res.body.userId;
}

const as = (userId) => ({ 'X-Session-Id': userId });

async function callsOf(userId) {
  const res = await request(ctx.app).get('/api/calls').set(as(userId));
  expect(res.status).toBe(200);
  return res.body.calls;
}

const callOf = async (userId, callId) => (await callsOf(userId)).find((entry) => entry.id === callId) || null;

/** The record is written after the relay is acked, so a test has to wait for it. */
async function until(read, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('the call record never reached the state the test waited for');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function pair(room) {
  const callerId = await sessionId('Ana');
  const calleeId = await sessionId('Ben');

  const caller = openSocket(ctx.url, callerId, room);
  await waitFor(caller, 'presence', (p) => p.connections === 1);
  const callee = openSocket(ctx.url, calleeId, room);
  await waitFor(callee, 'presence', (p) => p.connections === 2);

  return { caller, callee, callerId, calleeId };
}

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('call history', () => {
  let room = 0;
  const nextRoom = () => `p7-calls-${(room += 1)}`;

  test('a signalled call is stored once for both sides, with the duration it actually ran for', async () => {
    const space = nextRoom();
    const { caller, callee, callerId, calleeId } = await pair(space);
    const callId = crypto.randomUUID();

    expect(await emitWithAck(caller, 'call:invite', { targetSocketId: callee.id, callId, mode: 'video' })).toMatchObject({ ok: true });
    await waitFor(callee, 'call:incoming', (p) => p.callId === callId);

    expect(await emitWithAck(callee, 'call:accept', { targetSocketId: caller.id, callId })).toMatchObject({ ok: true });
    await waitFor(caller, 'call:accepted', (p) => p.callId === callId);

    const description = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
    expect(await emitWithAck(caller, 'call:offer', { targetSocketId: callee.id, callId, description })).toMatchObject({ ok: true });
    await waitFor(callee, 'call:offer', (p) => p.callId === callId);

    expect(await emitWithAck(callee, 'call:answer', {
      targetSocketId: caller.id,
      callId,
      description: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' }
    })).toMatchObject({ ok: true });
    await waitFor(caller, 'call:answer', (p) => p.callId === callId);

    expect(await emitWithAck(caller, 'call:ice', {
      targetSocketId: callee.id,
      callId,
      candidate: { candidate: 'candidate:1 1 udp 100 10.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    })).toMatchObject({ ok: true });

    expect(await emitWithAck(caller, 'call:end', { targetSocketId: callee.id, callId })).toMatchObject({ ok: true });

    const mine = await until(() => callOf(callerId, callId));
    expect(mine).toMatchObject({
      id: callId,
      room: space,
      mode: 'video',
      status: 'ended',
      direction: 'out',
      peer: { userId: calleeId, displayName: 'Ben' }
    });
    expect(mine.connectedAt).not.toBeNull();
    expect(mine.endedAt).not.toBeNull();
    expect(mine.startedAt).toBeLessThanOrEqual(mine.connectedAt);
    expect(mine.durationMs).toBe(mine.endedAt - mine.connectedAt);
    expect(mine.durationMs).toBeLessThan(60000);

    const theirs = await until(() => callOf(calleeId, callId));
    expect(theirs).toMatchObject({
      id: callId,
      status: 'ended',
      direction: 'in',
      peer: { userId: callerId, displayName: 'Ana' }
    });
    expect(theirs.durationMs).toBe(mine.durationMs);

    caller.close();
    callee.close();
  });

  test('a rejected ring is declined for both sides and lasted nothing', async () => {
    const space = nextRoom();
    const { caller, callee, callerId, calleeId } = await pair(space);
    const callId = crypto.randomUUID();

    expect(await emitWithAck(caller, 'call:invite', { targetSocketId: callee.id, callId, mode: 'audio' })).toMatchObject({ ok: true });
    await waitFor(callee, 'call:incoming', (p) => p.callId === callId);

    const ringing = await until(() => callOf(callerId, callId));
    expect(ringing.status).toBe('ringing');

    expect(await emitWithAck(callee, 'call:reject', { targetSocketId: caller.id, callId })).toMatchObject({ ok: true });
    await waitFor(caller, 'call:declined', (p) => p.callId === callId);

    const mine = await until(() => callOf(callerId, callId).then((entry) => (entry && entry.status === 'declined' ? entry : null)));
    expect(mine).toMatchObject({ status: 'declined', durationMs: 0, direction: 'out' });
    expect(mine.connectedAt).toBeNull();
    expect(mine.endedAt).not.toBeNull();

    const theirs = await until(() => callOf(calleeId, callId).then((entry) => (entry && entry.status === 'declined' ? entry : null)));
    expect(theirs).toMatchObject({ status: 'declined', durationMs: 0, direction: 'in' });

    caller.close();
    callee.close();
  });

  test('a caller whose socket dies while ringing leaves a missed call for both sides', async () => {
    const space = nextRoom();
    const { caller, callee, callerId, calleeId } = await pair(space);
    const callId = crypto.randomUUID();

    expect(await emitWithAck(caller, 'call:invite', { targetSocketId: callee.id, callId, mode: 'audio' })).toMatchObject({ ok: true });
    const ringing = await until(() => callOf(calleeId, callId));
    expect(ringing.status).toBe('ringing');

    const left = waitFor(callee, 'user_left', (p) => p.userId === callerId);
    caller.close();
    await left;

    const mine = await until(() => callOf(callerId, callId).then((entry) => (entry && entry.status === 'missed' ? entry : null)));
    expect(mine).toMatchObject({ status: 'missed', direction: 'out', connectedAt: null });
    expect(mine.durationMs).toBe(mine.endedAt - mine.startedAt);
    expect(await callOf(calleeId, callId)).toMatchObject({ status: 'missed', direction: 'in' });

    callee.close();
  });

  test('clearing empties the viewer list and leaves the peer list untouched', async () => {
    const space = nextRoom();
    const { caller, callee, callerId, calleeId } = await pair(space);
    const callId = crypto.randomUUID();

    expect(await emitWithAck(caller, 'call:invite', { targetSocketId: callee.id, callId, mode: 'video' })).toMatchObject({ ok: true });
    expect(await emitWithAck(callee, 'call:accept', { targetSocketId: caller.id, callId })).toMatchObject({ ok: true });
    expect(await emitWithAck(callee, 'call:end', { targetSocketId: caller.id, callId })).toMatchObject({ ok: true });

    await until(() => callOf(calleeId, callId).then((entry) => (entry && entry.status === 'ended' ? entry : null)));

    const cleared = await request(ctx.app).delete('/api/calls').set(as(callerId));
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ cleared: true });

    expect(await callsOf(callerId)).toEqual([]);
    expect((await callsOf(calleeId)).map((entry) => entry.id)).toEqual([callId]);

    caller.close();
    callee.close();
  });

  test('a malformed signal is acked as rejected and never recorded', async () => {
    const space = nextRoom();
    const { caller, callee, callerId } = await pair(space);
    const before = await callsOf(callerId);

    const junkId = await emitWithAck(caller, 'call:invite', { targetSocketId: callee.id, callId: 'not-a-uuid', mode: 'video' });
    expect(junkId).toMatchObject({ ok: false, error: 'invalid call id' });

    const junkMode = await emitWithAck(caller, 'call:invite', { targetSocketId: callee.id, callId: crypto.randomUUID(), mode: 'carrier-pigeon' });
    expect(junkMode).toMatchObject({ ok: false, error: 'invalid call mode' });

    const noTarget = await emitWithAck(caller, 'call:invite', { callId: crypto.randomUUID(), mode: 'video' });
    expect(noTarget.ok).toBe(false);

    const stranger = await emitWithAck(caller, 'call:accept', {
      targetSocketId: callee.id,
      callId: '11111111-1111-4111-8111-111111111111'
    });
    expect(stranger).toMatchObject({ ok: true });

    expect(await callsOf(callerId)).toEqual(before);
    expect(await ctx.store.getCall('11111111-1111-4111-8111-111111111111')).toBeNull();

    caller.close();
    callee.close();
  });

  test('the list belongs to the session that asks for it', async () => {
    const strangerId = await sessionId('Cleo');
    expect((await callsOf(strangerId)).length).toBe(0);

    const anonymous = await request(ctx.app).get('/api/calls');
    expect(anonymous.status).toBe(401);
  });
});
