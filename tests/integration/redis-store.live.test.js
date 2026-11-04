'use strict';

/**
 * These cases need a real Redis to prove the shared-state behaviour that the
 * deployment topology depends on, so they only run when REDIS_URL is present
 * (the CI `integration` job provides a service container).
 */
const redisUrl = process.env.REDIS_URL;
const describeMaybe = redisUrl ? describe : describe.skip;

const Redis = require('ioredis');
const express = require('express');
const request = require('supertest');

const RedisStore = require('../../src/store/redis-store');
const { createLimiter } = require('../../src/middleware/rate-limit');

describeMaybe('live Redis store', () => {
  let client;
  let store;
  const room = `ci-${process.pid}`;

  beforeAll(async () => {
    client = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    store = new RedisStore(client, {
      messageCacheSize: 3,
      messageCacheTtlSeconds: 60,
      sessionTtlSeconds: 60
    });
    await client.del(`chat:messages:${room}`, `chat:presence:${room}`, `chat:presence:${room}:meta`);
  });

  afterAll(async () => {
    await client.del(`chat:messages:${room}`, `chat:presence:${room}`, `chat:presence:${room}:meta`);
    client.disconnect();
  });

  test('connects and answers PING', async () => {
    expect(await store.ping()).toBe(true);
  });

  test('keeps only the newest messages and returns them oldest-first', async () => {
    for (let i = 1; i <= 6; i += 1) {
      await store.pushMessage(room, { id: String(i), ts: i });
    }
    const recent = await store.recentMessages(room, 10);
    expect(recent.map((m) => m.id)).toEqual(['4', '5', '6']);
  });

  test('shares presence between two store handles, which is what makes replicas equivalent', async () => {
    const second = new RedisStore(new Redis(redisUrl, { maxRetriesPerRequest: 1 }), {
      messageCacheSize: 3,
      messageCacheTtlSeconds: 60,
      sessionTtlSeconds: 60
    });

    await store.trackPresence(room, 'sock-a', { userId: 'u1', displayName: 'A' }, Date.now());
    await second.trackPresence(room, 'sock-b', { userId: 'u2', displayName: 'B' }, Date.now());

    const snapshot = await store.presenceSnapshot(room, 45000);
    expect(snapshot.connections).toBe(2);
    expect(snapshot.onlineUsers).toBe(2);
    expect(snapshot.users.map((u) => u.displayName).sort()).toEqual(['A', 'B']);

    // A second tab for the same person is still one person online.
    await store.trackPresence(room, 'sock-a2', { userId: 'u1', displayName: 'A' }, Date.now());
    const again = await store.presenceSnapshot(room, 45000);
    expect(again.connections).toBe(3);
    expect(again.onlineUsers).toBe(2);

    await store.releasePresence(room, 'sock-a2');
    await second.releasePresence(room, 'sock-b');
    expect((await store.presenceSnapshot(room, 45000)).connections).toBe(1);
    second.client.disconnect();
  });

  test('the rate window is atomic across clients', async () => {
    const bucket = `ci-window-${process.pid}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.consumeWindow(bucket, 10, 5000))
    );
    expect(results.map((r) => r.total).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await client.del(`chat:window:${bucket}`);
  });

  test('sessions round-trip with a TTL', async () => {
    await store.saveSession({ userId: 'ci-user', displayName: 'CI', expiresAt: Date.now() + 60000 });
    expect(await store.getSession('ci-user')).toMatchObject({ displayName: 'CI' });
    expect(await client.ttl('chat:session:ci-user')).toBeGreaterThan(0);
    await client.del('chat:session:ci-user');
  });

  test('the API limiter runs its scripts on Redis, so every replica shares one counter', async () => {
    const prefix = `chat:rl:ci-${process.pid}:`;
    const app = express();
    app.use(createLimiter({ name: `ci-${process.pid}`, limit: 2, windowMs: 60000, redis: client }));
    app.get('/ping', (_req, res) => res.json({ pong: true }));

    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(429);

    const keys = await client.keys(`${prefix}*`);
    expect(keys.length).toBeGreaterThan(0);
    await client.del(...keys);
  });
});

describeMaybe('live Redis: rich state', () => {
  let client;
  let store;
  const suffix = `${process.pid}-${Date.now()}`;
  const room = `ci-rich-${suffix}`;
  const messageId = '6f1c4f2a-7c1d-4e02-9b3f-2a5c8d9e0f11';
  const noteUser = '7c1d4e02-9b3f-4a5c-8d9e-0f112f3a4b5c';
  const clientIdA = 'ci-client-a';
  const keys = [];

  beforeAll(async () => {
    client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    store = new RedisStore(client, {
      messageCacheSize: 5,
      messageCacheTtlSeconds: 60,
      sessionTtlSeconds: 60
    });
    keys.push(`chat:messages:${room}`, `chat:poll:${messageId}`, `chat:note:${noteUser}`);
    await client.del(...keys);
  });

  afterAll(async () => {
    const claimed = await client.keys(`chat:idem:*${clientIdA}`);
    if (claimed.length) await client.del(...claimed);
    await client.del(...keys);
    client.disconnect();
  });

  test('a send is claimed once and the replay reports the stored message', async () => {
    const first = await store.claimSend(noteUser, clientIdA, 60000);
    expect(first).toEqual({ fresh: true, messageId: null });

    const message = { id: messageId, room, text: 'once', clientId: clientIdA, ts: Date.now() };
    await store.pushMessage(room, message);
    await store.recordSend(noteUser, clientIdA, messageId, 60000);

    const replay = await store.claimSend(noteUser, clientIdA, 60000);
    expect(replay.fresh).toBe(false);
    expect(replay.messageId).toBe(messageId);
    expect((await store.findMessage(room, messageId)).text).toBe('once');
    expect(await store.findMessage(room, 'no-such-id')).toBeNull();
  });

  test('poll votes are shared across store handles and a re-vote replaces', async () => {
    const other = new RedisStore(client, {
      messageCacheSize: 5,
      messageCacheTtlSeconds: 60,
      sessionTtlSeconds: 60
    });

    const voterOne = '11111111-1111-4111-8111-111111111111';
    const voterTwo = '22222222-2222-4222-8222-222222222222';

    await store.castPollVote(messageId, voterOne, [0], { multiple: false, optionCount: 3 });
    await other.castPollVote(messageId, voterTwo, [1], { multiple: false, optionCount: 3 });
    await store.castPollVote(messageId, voterOne, [2], { multiple: false, optionCount: 3 });

    const results = await other.pollResults(messageId, 3);
    expect(results.totalVoters).toBe(2);
    expect(results.options.map((option) => option.count)).toEqual([0, 1, 1]);
    expect(results.options[2].voters).toEqual([voterOne]);

    await expect(
      store.castPollVote(messageId, voterTwo, [0, 1], { multiple: false, optionCount: 3 })
    ).rejects.toThrow(/single choice/);
    await expect(
      store.castPollVote(messageId, voterTwo, [9], { multiple: true, optionCount: 3 })
    ).rejects.toThrow(/not part of this poll/);

    // The poll hash has to expire with the message window, not linger forever.
    expect(await client.ttl(`chat:poll:${messageId}`)).toBeGreaterThan(0);
  });

  test('a note is stored without a TTL and read back verbatim', async () => {
    const saved = await store.saveNote(noteUser, { text: 'at the gym', updatedAt: 123 });
    expect(await store.getNote(noteUser)).toEqual(saved);
    expect(await client.ttl(`chat:note:${noteUser}`)).toBe(-1);
    expect(await store.getNote('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
