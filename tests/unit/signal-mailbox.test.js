'use strict';

const MemoryStore = require('../../src/store/memory-store');
const RedisStore = require('../../src/store/redis-store');
const { deriveMailbox } = require('../../src/utils/signal-mailbox');
const { SIGNAL_MAILBOX_MAX_ENTRIES, SIGNAL_MAILBOX_TTL_SECONDS, signalMailboxKey } = require('../../src/constants');

function memoryStore() {
  return new MemoryStore({
    messageCacheSize: 5,
    messageHistoryMax: 5,
    sessionTtlSeconds: 43200,
    mediaTtlSeconds: 3600,
    retentionSeconds: 2592000
  });
}

/** Just enough of ioredis for the mailbox script: a list, a TTL, and DEL. */
class MailboxClient {
  constructor() {
    this.lists = new Map();
    this.expires = new Map();
    this.written = new Map();
  }

  defineCommand() {}

  async signalMailboxAppend(key, kind, json, max, ttl) {
    const list = kind === 'description' ? [] : [...(this.lists.get(key) || [])];
    list.push(json);
    this.lists.set(key, list.slice(-Number(max)));
    this.expires.set(key, Number(ttl));
    this.written.set(key, Date.now());
    return this.lists.get(key).length;
  }

  async lrange(key) {
    const written = this.written.get(key);
    const ttl = this.expires.get(key);
    if (written !== undefined && ttl !== undefined && Date.now() >= written + ttl * 1000) {
      this.lists.delete(key);
      this.expires.delete(key);
      this.written.delete(key);
      return [];
    }
    return [...(this.lists.get(key) || [])];
  }

  async del(...keys) {
    let removed = 0;
    for (const key of keys) {
      if (this.lists.delete(key)) removed += 1;
      this.expires.delete(key);
      this.written.delete(key);
    }
    return removed;
  }
}

function redisStore() {
  return new RedisStore(new MailboxClient(), {
    messageCacheSize: 5,
    messageHistoryMax: 5,
    messageRetentionSeconds: 2592000,
    sessionTtlSeconds: 43200,
    mediaTtlSeconds: 3600
  });
}

const description = (type, sdp) => ({
  kind: 'description',
  description: { type, sdp },
  room: 'p5',
  fromSocketId: 'socket-a',
  fromUserId: 'user-a',
  fromDisplayName: 'Ana',
  ts: Date.now()
});

const candidate = (n) => ({
  kind: 'candidate',
  candidate: { candidate: `candidate:${n} 1 udp 100 10.0.0.1 50000 typ host`, sdpMid: '0', sdpMLineIndex: 0 },
  room: 'p5',
  fromSocketId: 'socket-a',
  fromUserId: 'user-a',
  fromDisplayName: 'Ana',
  ts: Date.now()
});

describe.each([
  ['MemoryStore', memoryStore],
  ['RedisStore', redisStore]
])('%s signal mailbox', (_name, build) => {
  test('a description plus its candidates replay as one generation', async () => {
    const store = build();
    await store.appendSignal('call-1', 'user-b', description('offer', 'v=0-offer'));
    await store.appendSignal('call-1', 'user-b', candidate(1));
    await store.appendSignal('call-1', 'user-b', candidate(2));

    const box = await store.readSignalMailbox('call-1', 'user-b');
    expect(box.description).toEqual({ type: 'offer', sdp: 'v=0-offer' });
    expect(box.candidates).toHaveLength(2);
    expect(box.fromUserId).toBe('user-a');
    expect(box.count).toBe(3);
    expect(box.expiresAt).toBeGreaterThan(Date.now());
  });

  test('a new description drops the previous generation candidates', async () => {
    const store = build();
    await store.appendSignal('call-1', 'user-b', description('offer', 'old'));
    await store.appendSignal('call-1', 'user-b', candidate(1));
    await store.appendSignal('call-1', 'user-b', description('offer', 'new'));
    await store.appendSignal('call-1', 'user-b', candidate(2));

    const box = await store.readSignalMailbox('call-1', 'user-b');
    expect(box.description.sdp).toBe('new');
    expect(box.candidates).toHaveLength(1);
    expect(box.candidates[0].candidate).toContain('candidate:2');
  });

  test('the list is capped and the TTL is sixty seconds', async () => {
    const store = build();
    for (let n = 0; n < SIGNAL_MAILBOX_MAX_ENTRIES + 10; n += 1) {
      await store.appendSignal('call-1', 'user-b', candidate(n));
    }
    const box = await store.readSignalMailbox('call-1', 'user-b');
    expect(box.count).toBe(SIGNAL_MAILBOX_MAX_ENTRIES);
    expect(box.candidates).toHaveLength(SIGNAL_MAILBOX_MAX_ENTRIES);
    expect(SIGNAL_MAILBOX_TTL_SECONDS).toBe(60);
    if (store.client) expect(store.client.expires.get(signalMailboxKey('call-1', 'user-b'))).toBe(60);
  });

  test('an expired mailbox reads empty', async () => {
    const store = build();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await store.appendSignal('call-1', 'user-b', description('offer', 'v=0'));
      expect((await store.readSignalMailbox('call-1', 'user-b')).description).not.toBeNull();
      spy.mockReturnValue(now + (SIGNAL_MAILBOX_TTL_SECONDS + 1) * 1000);
      const box = await store.readSignalMailbox('call-1', 'user-b');
      expect(box.description).toBeNull();
      expect(box.candidates).toEqual([]);
      expect(box.count).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('clearing removes both participants and leaves no replay', async () => {
    const store = build();
    await store.appendSignal('call-1', 'user-a', description('answer', 'v=0-answer'));
    await store.appendSignal('call-1', 'user-b', description('offer', 'v=0-offer'));
    expect(await store.clearSignalMailbox('call-1', ['user-a', 'user-b', 'user-a'])).toBe(2);
    expect((await store.readSignalMailbox('call-1', 'user-a')).count).toBe(0);
    expect((await store.readSignalMailbox('call-1', 'user-b')).count).toBe(0);
  });
});

describe('deriveMailbox', () => {
  test('an empty or malformed list is an empty mailbox', () => {
    expect(deriveMailbox([]).count).toBe(0);
    expect(deriveMailbox([null, { kind: 'junk' }]).description).toBeNull();
  });

  test('candidates without a description still replay and queue', () => {
    const box = deriveMailbox([candidate(1), candidate(2)]);
    expect(box.description).toBeNull();
    expect(box.candidates).toHaveLength(2);
    expect(box.fromUserId).toBe('user-a');
  });
});