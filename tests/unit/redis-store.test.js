'use strict';

const RedisStore = require('../../src/store/redis-store');
const {
  CALL_HISTORY_MAX,
  CALL_RECORD_TTL_SECONDS,
  STATUS_TTL_SECONDS,
  STATUS_MAX_PER_USER,
  STATUS_COLORS
} = require('../../src/constants');

/** Redis scores accept `+inf`, `-inf` and the exclusive `(n` form. */
function scoreBound(raw) {
  const text = String(raw);
  const exclusive = text.startsWith('(');
  const body = exclusive ? text.slice(1) : text;
  if (body === '+inf' || body === 'inf') return { value: Number.POSITIVE_INFINITY, exclusive };
  if (body === '-inf') return { value: Number.NEGATIVE_INFINITY, exclusive };
  return { value: Number(body), exclusive };
}

/** Members inside a score range, ordered the way Redis orders them: score first. */
function byScore(zset, low, high, desc) {
  const lo = scoreBound(low);
  const hi = scoreBound(high);
  return [...zset.entries()]
    .filter(([, score]) => (lo.exclusive ? score > lo.value : score >= lo.value)
      && (hi.exclusive ? score < hi.value : score <= hi.value))
    .sort((a, b) => (desc ? b[1] - a[1] : a[1] - b[1]));
}

/** Rank slices are inclusive at both ends and count back from the end when negative. */
function sliceRank(items, start, stop) {
  const from = start < 0 ? Math.max(0, items.length + start) : start;
  const to = stop < 0 ? items.length + stop : Math.min(stop, items.length - 1);
  return to < from ? [] : items.slice(from, to + 1);
}

/**
 * Fake client that records the commands the store issues, so the Redis code
 * path is covered without a live server. Semantics are approximated: the goal
 * is to prove the right keys, ordering and atomic batches are used.
 */
class FakeClient {
  constructor() {
    this.zsets = new Map();
    this.hash = new Map();
    this.kv = new Map();
    this.sets = new Map();
    this.expires = new Map();
    this.calls = [];
    this.scripts = {};
  }

  defineCommand(name, spec) {
    this.scripts[name] = spec;
  }

  async ping() {
    return 'PONG';
  }

  async incrWithTtl(key, ttlMs) {
    const total = Number(this.kv.get(key) || 0) + 1;
    this.kv.set(key, total);
    this.expires.set(key, Number(ttlMs));
    this.calls.push(['incrWithTtl', key, String(ttlMs)]);
    return total;
  }

  /** Per-room history sequence: the counter is the only ordering authority. */
  async incr(key) {
    const total = Number(this.kv.get(key) || 0) + 1;
    this.kv.set(key, total);
    this.calls.push(['incr', key]);
    return total;
  }

  async expire(key, seconds) {
    this.expires.set(key, Number(seconds));
    this.calls.push(['expire', key, seconds]);
    return 1;
  }

  /** Handles `SET k v EX n`, `SET k v PX n` and the `NX` tail. */
  async set(key, value, ...args) {
    this.calls.push(['set', key, ...args.map(String)]);
    const modes = args.map((arg) => String(arg).toUpperCase());
    if (modes.includes('NX') && this.kv.has(key)) return null;

    this.kv.set(key, value);
    const ex = modes.indexOf('EX');
    const px = modes.indexOf('PX');
    if (ex !== -1) this.expires.set(key, Number(args[ex + 1]));
    else if (px !== -1) this.expires.set(key, Number(args[px + 1]) / 1000);
    else this.expires.delete(key);
    return 'OK';
  }

  async get(key) {
    const value = this.kv.get(key);
    return value === undefined ? null : value;
  }

  /** `MGET` and `HMGET` take either an array or a spread, like ioredis. */
  async mget(...args) {
    const list = Array.isArray(args[0]) ? args[0] : args;
    return list.map((key) => {
      const value = this.kv.get(key);
      return value === undefined ? null : value;
    });
  }

  async exists(key) {
    return this.kv.has(key) || this.zsets.has(key) || this.sets.has(key) ? 1 : 0;
  }

  async del(...keys) {
    let removed = 0;
    for (const key of keys) {
      if (this.kv.has(key) || this.zsets.has(key) || this.sets.has(key) || this.hash.has(key)) removed += 1;
      this.kv.delete(key);
      this.zsets.delete(key);
      this.sets.delete(key);
      this.hash.delete(key);
      this.expires.delete(key);
      this.calls.push(['del', key]);
    }
    return removed;
  }

  async saddWithTtl(key, member, ttlSeconds) {
    const set = this.sets.get(key) || new Set();
    this.sets.set(key, set);
    const added = set.has(member) ? 0 : 1;
    set.add(member);
    this.expires.set(key, Number(ttlSeconds));
    this.calls.push(['saddWithTtl', key, member, String(ttlSeconds)]);
    return added;
  }

  async smembers(key) {
    return [...(this.sets.get(key) || new Set())];
  }

  async zadd(key, ...pairs) {
    const z = this.zsets.get(key) || new Map();
    this.zsets.set(key, z);
    let added = 0;
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const member = pairs[i + 1];
      if (!z.has(member)) added += 1;
      z.set(member, Number(pairs[i]));
    }
    this.calls.push(['zadd', key]);
    return added;
  }

  async zrange(key, start, stop) {
    const rows = byScore(this.zsets.get(key) || new Map(), '-inf', '+inf', false);
    return sliceRank(rows.map(([member]) => member), start, stop);
  }

  async zrevrange(key, start, stop) {
    const rows = byScore(this.zsets.get(key) || new Map(), '-inf', '+inf', true);
    return sliceRank(rows.map(([member]) => member), start, stop);
  }

  /** History reads are score ranges, so paging by sequence needs no rank math. */
  zbyScore(key, low, high, desc, opts) {
    const rows = byScore(this.zsets.get(key) || new Map(), low, high, desc);
    const withScores = String(opts[0]).toUpperCase() === 'WITHSCORES';
    const out = [];
    for (const [member, score] of rows) {
      out.push(member);
      if (withScores) out.push(String(score));
    }
    const limitAt = opts.findIndex((arg) => String(arg).toUpperCase() === 'LIMIT');
    if (limitAt !== -1) {
      const offset = Number(opts[limitAt + 1]);
      const count = Number(opts[limitAt + 2]);
      const stride = withScores ? 2 : 1;
      return out.slice(offset * stride, offset * stride + count * stride);
    }
    return out;
  }

  async zrangebyscore(key, min, max, ...opts) {
    return this.zbyScore(key, min, max, false, opts);
  }

  /** Note the argument order: `ZREVRANGEBYSCORE key max min`. */
  async zrevrangebyscore(key, max, min, ...opts) {
    return this.zbyScore(key, min, max, true, opts);
  }

  async zremrangebyrank(key, start, stop) {
    const z = this.zsets.get(key) || new Map();
    const rows = byScore(z, '-inf', '+inf', false).map(([member]) => member);
    const doomed = sliceRank(rows, start, stop);
    doomed.forEach((member) => z.delete(member));
    this.calls.push(['zremrangebyrank', key, start, stop]);
    return doomed.length;
  }

  async hset(key, field, value) {
    const h = this.hash.get(key) || new Map();
    h.set(field, value);
    this.hash.set(key, h);
    return 1;
  }

  async hgetall(key) {
    const h = this.hash.get(key) || new Map();
    return Object.fromEntries(h);
  }

  async hmget(key, ...args) {
    const fields = Array.isArray(args[0]) ? args[0] : args;
    const h = this.hash.get(key) || new Map();
    return fields.map((field) => (h.has(field) ? h.get(field) : null));
  }

  async zrem(key, ...members) {
    const z = this.zsets.get(key) || new Map();
    members.forEach((member) => z.delete(member));
    this.calls.push(['zrem', key, ...members]);
    return members.length;
  }

  async hdel(key, ...fields) {
    const h = this.hash.get(key) || new Map();
    fields.forEach((field) => h.delete(field));
    this.calls.push(['hdel', key, ...fields]);
    return fields.length;
  }

  /** Queued commands run at `exec`, which is what makes the batch atomic. */
  multi() {
    const queue = [];
    const self = this;
    const api = {
      exec: async () => {
        const results = [];
        for (const call of queue) results.push([null, await self[call[0]](...call.slice(1))]);
        return results;
      }
    };
    Object.getOwnPropertyNames(FakeClient.prototype)
      .filter((name) => !['constructor', 'multi', 'defineCommand'].includes(name))
      .forEach((name) => {
        api[name] = (...args) => {
          queue.push([name, ...args]);
          return api;
        };
      });
    return api;
  }
}

function build(options = {}) {
  const client = new FakeClient();
  const store = new RedisStore(client, {
    messageCacheSize: 3,
    messageHistoryMax: 3,
    messageRetentionSeconds: 2592000,
    sessionTtlSeconds: 43200,
    mediaTtlSeconds: 604800,
    ...options
  });
  return { client, store };
}

describe('Redis store command shape', () => {
  test('readiness compares the resolved PING reply, not the promise', async () => {
    const { store } = build();
    await expect(store.ping()).resolves.toBe(true);
  });

  test('a renamed option is refused at construction rather than sent as a NaN command', () => {
    // Exactly the mistake that used to turn into `ZREMRANGEBYRANK 0 NaN` and an
    // unexplained loss of history, so it has to fail where it is made.
    expect(() => new RedisStore(new FakeClient(), {
      messageCacheSize: 3,
      messageCacheTtlSeconds: 3600,
      sessionTtlSeconds: 43200
    })).toThrow(/messageHistoryMax/);
  });

  test('mints a sequence, then writes the row, the trim and the owner in one batch', async () => {
    const { client, store } = build();
    const stored = await store.pushMessage('general', { id: '1', ts: 1 });

    expect(stored.seq).toBe(1);
    expect(client.calls.map((c) => c[0])).toEqual(['incr', 'zadd', 'zremrangebyrank', 'expire', 'expire', 'set']);
    expect(client.kv.get('chat:messages:seq:general')).toBe(1);
    expect(client.zsets.get('chat:messages:general').get(JSON.stringify(stored))).toBe(1);
    // History survives the idle room, and so does the counter that orders it;
    // neither may be left in the keyspace for ever.
    expect(client.expires.get('chat:messages:general')).toBe(2592000);
    expect(client.expires.get('chat:messages:seq:general')).toBe(2592000);
    expect(client.kv.get('chat:messages:room:1')).toBe('general');
  });

  test('the sequence keeps counting after a trim, so rows never collide', async () => {
    const { store } = build();
    for (let i = 1; i <= 5; i += 1) expect((await store.pushMessage('general', { id: String(i) })).seq).toBe(i);
    expect((await store.recentMessages('general', 10)).map((m) => m.seq)).toEqual([3, 4, 5]);
  });

  test('reads history newest-first from Redis and returns oldest-first', async () => {
    const { store } = build();
    await store.pushMessage('general', { id: '1' });
    await store.pushMessage('general', { id: '2' });
    await store.pushMessage('general', { id: '3' });
    await store.pushMessage('general', { id: '4' });

    const recent = await store.recentMessages('general', 10);
    expect(recent.map((m) => m.id)).toEqual(['2', '3', '4']);
  });

  test('keeps presence in a sorted set plus a metadata hash', async () => {
    const { client, store } = build();
    await store.trackPresence('general', 's1', { userId: 'u1', displayName: 'Ada' }, 5000);

    expect(client.zsets.get('chat:presence:general').get('s1')).toBe(5000);
    const meta = JSON.parse(client.hash.get('chat:presence:general:meta').get('s1'));
    expect(meta).toMatchObject({ userId: 'u1', displayName: 'Ada', since: 5000 });
  });

  test('counts distinct people in a presence snapshot, not sockets', async () => {
    // The count used to be read off the spread of a Set, which is an array and
    // has no size, so the field arrived as undefined and the client rendered the
    // word. A number has to come back, deduplicated by user id.
    const { store } = build();
    const now = Date.now();
    await store.trackPresence('general', 's1', { userId: 'ana', displayName: 'Ana', since: now }, now);
    await store.trackPresence('general', 's2', { userId: 'ana', displayName: 'Ana', since: now }, now);
    await store.trackPresence('general', 's3', { userId: 'ben', displayName: 'Ben', since: now }, now);

    const snapshot = await store.presenceSnapshot('general', 60000, now);
    expect(snapshot.connections).toBe(3);
    expect(Number.isInteger(snapshot.onlineUsers)).toBe(true);
    expect(snapshot.onlineUsers).toBe(2);
  });

  test('prunes expired presence through one atomic batch', async () => {
    const { client, store } = build();
    await store.trackPresence('general', 'dead', { userId: 'u1', displayName: 'A' }, 0);
    await store.trackPresence('general', 'alive', { userId: 'u2', displayName: 'B' }, 9000);

    const removed = await store.pruneStalePresence('general', 5000, 10000);
    expect(removed).toEqual(['dead']);
    expect(client.zsets.get('chat:presence:general').has('alive')).toBe(true);
    expect(client.hash.get('chat:presence:general:meta').has('dead')).toBe(false);
  });

  test('the rate window uses the atomic INCR+PEXPIRE script', async () => {
    const { client, store } = build();
    expect(client.scripts.incrWithTtl.lua).toMatch(/INCR/);
    expect(client.scripts.incrWithTtl.lua).toMatch(/PEXPIRE/);

    expect(await store.consumeWindow('socket:1.2.3.4', 2, 60000)).toMatchObject({ total: 1, remaining: 1 });
    expect(await store.consumeWindow('socket:1.2.3.4', 2, 60000)).toMatchObject({ total: 2, remaining: 0 });
    expect(await store.consumeWindow('socket:1.2.3.4', 2, 60000)).toMatchObject({ total: 3, remaining: 0 });
  });

  test('sessions are stored with an expiry so idle sockets cannot leak keys', async () => {
    const { client, store } = build();
    const session = { userId: 'u1', displayName: 'Ada', expiresAt: 99 };
    await store.saveSession(session);

    expect(client.expires.get('chat:session:u1')).toBe(43200);
    expect(await store.getSession('u1')).toEqual(session);
    expect(await store.getSession('missing')).toBeNull();
  });

  test('read receipts are one atomic set member per reader', async () => {
    const { client, store } = build();
    expect(client.scripts.saddWithTtl.lua).toMatch(/SADD/);
    expect(client.scripts.saddWithTtl.lua).toMatch(/EXPIRE/);

    expect(await store.markSeen('m1', 'u1')).toBe(true);
    expect(await store.markSeen('m1', 'u1')).toBe(false);
    expect(await store.markSeen('m1', 'u2')).toBe(true);

    expect(client.expires.get('chat:seen:m1')).toBe(2592000);
    expect(await store.seenByMessages(['m1', 'nope'])).toEqual(
      new Map([['m1', ['u1', 'u2']], ['nope', []]])
    );
  });

  test('media metadata is keyed with an expiry and indexed for sweeping', async () => {
    const { client, store } = build();
    const record = await store.saveMedia({ id: 'a1', userId: 'u1', name: 'x.png', mime: 'image/png; charset=x', size: 10 });

    expect(record.mime).toBe('image/png');
    expect(client.kv.get('chat:media:a1')).toContain('"userId":"u1"');
    expect(client.expires.get('chat:media:a1')).toBe(604800);
    expect(client.zsets.get('chat:media:index').get('a1')).toBe(record.expiresAt);
    expect(await store.getMedia('a1')).toMatchObject({ id: 'a1', userId: 'u1', mime: 'image/png' });

    await store.deleteMedia('a1');
    expect(client.kv.get('chat:media:a1')).toBeFalsy();
    expect(client.zsets.get('chat:media:index').has('a1')).toBe(false);
  });

  test('the expiry sweep only returns media whose index score has passed', async () => {
    const { client, store } = build();
    await store.saveMedia({ id: 'old', userId: 'u1', name: 'a.png', mime: 'image/png', size: 1 });
    await store.saveMedia({ id: 'fresh', userId: 'u1', name: 'b.png', mime: 'image/png', size: 1 });

    const index = client.zsets.get('chat:media:index');
    index.set('old', 500);
    index.set('fresh', 9000);

    expect((await store.expiredMedia(1000, 10)).map((r) => r.id)).toEqual(['old']);
    expect(await store.expiredMedia(100, 10)).toEqual([]);
  });

  test('the sweep honours the batch limit', async () => {
    const { client, store } = build();
    await store.saveMedia({ id: 'a', userId: 'u1', name: 'a', mime: 'image/png', size: 1 });
    await store.saveMedia({ id: 'b', userId: 'u1', name: 'b', mime: 'image/png', size: 1 });
    await store.saveMedia({ id: 'c', userId: 'u1', name: 'c', mime: 'image/png', size: 1 });
    const index = client.zsets.get('chat:media:index');
    ['a', 'b', 'c'].forEach((id) => index.set(id, 1));

    expect(await store.expiredMedia(2, 2)).toHaveLength(2);
    expect(await store.expiredMedia(2, 10)).toHaveLength(3);
  });
});

/* The reads that make replicas equivalent, asserted on Redis so the in-memory
 * store can claim it answers them the same way. */
describe('shared-state reads', () => {
  test('history pages underneath a sequence cursor', async () => {
    const { store } = build({ messageHistoryMax: 8 });
    for (let i = 1; i <= 5; i += 1) await store.pushMessage('general', { id: String(i) });

    const top = await store.historyPage('general', { limit: 2 });
    expect(top.map((m) => m.id)).toEqual(['4', '5']);

    const older = await store.historyPage('general', { limit: 2, before: top[0].seq });
    expect(older.map((m) => m.id)).toEqual(['2', '3']);
    expect((await store.historyPage('general', { limit: 2, before: 1 })).map((m) => m.id)).toEqual([]);
  });

  test('a message id names the room that owns it', async () => {
    const { client, store } = build();
    await store.pushMessage('general', { id: 'm1' });
    await store.pushMessage('other', { id: 'm2' });

    expect(client.kv.get('chat:messages:room:m1')).toBe('general');
    expect(await store.messageRoom('m1')).toBe('general');
    expect(await store.messageRooms(['m1', 'm2', 'nope'])).toEqual(
      new Map([['m1', 'general'], ['m2', 'other'], ['nope', null]])
    );
  });

  test('the people in a room come out of shared presence, stale sockets excluded', async () => {
    const { store } = build();
    const now = Date.now();
    await store.trackPresence('general', 's1', { userId: 'ana', displayName: 'Ana', since: now }, now);
    await store.trackPresence('general', 's2', { userId: 'ana', displayName: 'Ana', since: now }, now);
    await store.trackPresence('general', 's3', { userId: 'ben', displayName: 'Ben', since: now }, now);
    await store.trackPresence('general', 'old', { userId: 'cid', displayName: 'Cid', since: now }, now - 60000);

    expect((await store.roomUsers('general', 45000, now)).sort()).toEqual(['ana', 'ben']);
  });

  test('an attachment that is gone answers false rather than a missing row', async () => {
    const { client, store } = build();
    await store.saveMedia({ id: 'a1', userId: 'u1', name: 'x.png', mime: 'image/png', size: 1 });
    expect(await store.mediaExists(['a1', 'gone'])).toEqual(new Map([['a1', true], ['gone', false]]));

    await client.del('chat:media:a1');
    expect(await store.mediaExists(['a1'])).toEqual(new Map([['a1', false]]));
  });

  test('only an unanswered claim is given back', async () => {
    const { client, store } = build();
    await store.claimSend('u1', 'pending-client', 60000);
    expect(await client.get('chat:idem:u1:pending-client')).toBe('pending');
    await store.releaseSend('u1', 'pending-client');
    expect(await client.get('chat:idem:u1:pending-client')).toBeNull();

    await store.claimSend('u1', 'done-client', 60000);
    await store.recordSend('u1', 'done-client', 'm9', 60000);
    await store.releaseSend('u1', 'done-client');
    expect(await client.get('chat:idem:u1:done-client')).toBe('m9');
  });

  test('a room password is stored with a life and refreshed when used', async () => {
    const { client, store } = build();
    const record = { hash: 'x', salt: 'y' };
    expect(await store.setRoomPasswordIfAbsent('general', record)).toBe(true);
    expect(await store.setRoomPasswordIfAbsent('general', { hash: 'z', salt: 'w' })).toBe(false);
    expect(await store.getRoomPassword('general')).toEqual(record);
    expect(client.expires.get('chat:room-password:general')).toBe(2592000);
  });

  test('a room grant outlives the session that asked for it', async () => {
    const { client, store } = build();
    expect(await store.hasRoomAccess('general', 'u1')).toBe(false);
    await store.grantRoomAccess('general', 'u1');
    expect(await store.hasRoomAccess('general', 'u1')).toBe(true);
    expect(client.expires.get('chat:room-access:general:u1')).toBe(2592000);
  });
});

const BASE = Date.now();
const at = (seconds) => BASE + seconds * 1000;

function callEntry(id, startedAt, userIds = ['u1', 'u2']) {
  return {
    id,
    room: 'general',
    mode: 'audio',
    status: 'ringing',
    startedAt,
    connectedAt: null,
    endedAt: null,
    durationMs: null,
    participants: userIds.map((userId, position) => ({
      userId,
      displayName: `guest ${userId}`,
      direction: position === 0 ? 'out' : 'in'
    }))
  };
}

function statusCard(id, userId, createdAt, expiresAt = createdAt + STATUS_TTL_SECONDS * 1000) {
  return {
    id,
    userId,
    displayName: 'Ada',
    kind: 'text',
    text: 'hello',
    color: STATUS_COLORS[0],
    mediaId: null,
    createdAt,
    expiresAt,
    viewerIds: []
  };
}

/* The same assertions as tests/unit/store.test.js: both stores must answer the
 * same questions about calls and statuses, only the keys differ. */
describe('call history', () => {
  test('a later write for the same id patches the record instead of adding a row', async () => {
    const { store } = build();
    await store.recordCall(callEntry('c1', at(0)));
    await store.recordCall({ ...callEntry('c1', at(0)), status: 'connected', connectedAt: at(1) });

    const record = await store.getCall('c1');
    expect(record.status).toBe('connected');
    expect(record.connectedAt).toBe(at(1));
    expect((await store.listCalls('u1')).map((call) => call.id)).toEqual(['c1']);
    expect(await store.getCall('unknown')).toBeNull();
  });

  test('lists every participant newest-first and honours the limit', async () => {
    const { store } = build();
    for (let i = 0; i < 3; i += 1) await store.recordCall(callEntry(`c${i}`, at(i)));

    expect((await store.listCalls('u1')).map((call) => call.id)).toEqual(['c2', 'c1', 'c0']);
    expect((await store.listCalls('u2', 2)).map((call) => call.id)).toEqual(['c2', 'c1']);
    expect(await store.listCalls('stranger')).toEqual([]);
  });

  test('caps each participant index at the history size', async () => {
    const { client, store } = build();
    for (let i = 1; i <= CALL_HISTORY_MAX + 2; i += 1) await store.recordCall(callEntry(`c${i}`, at(i), ['u1']));

    const list = await store.listCalls('u1');
    expect(list).toHaveLength(CALL_HISTORY_MAX);
    expect(list[0].id).toBe(`c${CALL_HISTORY_MAX + 2}`);
    expect(list[list.length - 1].id).toBe('c3');
    expect((await store.listCalls('u1', 2)).map((call) => call.id)).toEqual([`c${CALL_HISTORY_MAX + 2}`, `c${CALL_HISTORY_MAX + 1}`]);
    expect(client.zsets.get('chat:call:user:u1').size).toBe(CALL_HISTORY_MAX);
  });

  test('a record gets its own key, a thirty day expiry and one index row per guest', async () => {
    const { client, store } = build();
    await store.recordCall(callEntry('c1', at(0)));

    expect(client.expires.get('chat:call:record:c1')).toBe(CALL_RECORD_TTL_SECONDS);
    expect(JSON.parse(client.kv.get('chat:call:record:c1')).participants).toHaveLength(2);
    expect(client.zsets.get('chat:call:user:u1').get('c1')).toBe(at(0));
    expect(client.zsets.get('chat:call:user:u2').get('c1')).toBe(at(0));
  });

  test('clearing empties one list and drops a record only once nobody lists it', async () => {
    const { client, store } = build();
    await store.recordCall(callEntry('shared', at(0), ['u1', 'u2']));
    await store.recordCall(callEntry('solo', at(1), ['u1']));

    expect(await store.clearCalls('u1')).toBe(2);
    expect(await store.listCalls('u1')).toEqual([]);
    expect((await store.listCalls('u2')).map((call) => call.id)).toEqual(['shared']);
    expect(await store.getCall('solo')).toBeNull();
    expect(await store.getCall('shared')).not.toBeNull();

    await store.clearCalls('u2');
    expect(await store.getCall('shared')).toBeNull();
    expect(client.zsets.get('chat:call:user:u2').size).toBe(0);
    expect(await store.clearCalls('nobody')).toBe(0);
  });
});

describe('statuses', () => {
  test('a card reads back until its own expiry, and an expired read removes it for good', async () => {
    const { store } = build();
    const card = await store.saveStatus(statusCard('s1', 'u1', at(0)));
    expect(card.viewerIds).toBeUndefined();
    expect(await store.getStatus('s1', at(0))).toMatchObject({ id: 's1', text: 'hello', color: STATUS_COLORS[0] });
    expect(await store.getStatus('s1', card.expiresAt - 1)).not.toBeNull();
    expect(await store.getStatus('s1', card.expiresAt)).toBeNull();
    expect(await store.getStatus('s1', at(0))).toBeNull();
    expect(await store.listStatuses(null, at(0))).toEqual([]);
    expect(await store.listStatuses('u1', at(0))).toEqual([]);
  });

  test('a card that has only seconds left is still readable until they pass', async () => {
    const { store } = build();
    const now = Date.now();
    await store.saveStatus(statusCard('s1', 'u1', now - 6 * 3600 * 1000, now + 30_000));

    expect(await store.getStatus('s1', now)).not.toBeNull();
    expect(await store.getStatus('s1', now + 30_000)).toBeNull();
    expect(await store.listStatuses('u1', now + 30_000)).toEqual([]);
  });

  test('a key expires with the life the card has left, never a fresh day', async () => {
    const { client, store } = build();
    const now = Date.now();
    await store.saveStatus(statusCard('s1', 'u1', now - 6 * 3600 * 1000, now + 30_000));
    expect(client.expires.get('chat:status:s1')).toBe(30);

    await store.recordStatusView('s1', { userId: 'u2', displayName: 'Ben' }, now);
    expect(client.expires.get('chat:status:s1')).toBe(30);
    expect(client.kv.get('chat:status:s1')).toContain('"userId":"u2"');
  });

  test('a fresh card keeps the whole status day', async () => {
    const { store } = build();
    const card = await store.saveStatus(statusCard('s1', 'u1', Date.now()));
    expect(card.expiresAt - card.createdAt).toBe(STATUS_TTL_SECONDS * 1000);
  });

  test('re-saving an id replaces the card without duplicating the author index', async () => {
    const { store } = build();
    await store.saveStatus(statusCard('s1', 'u1', at(0)));
    await store.saveStatus({ ...statusCard('s1', 'u1', at(1)), text: 'second' });

    const own = await store.listStatuses('u1');
    expect(own.map((card) => card.id)).toEqual(['s1']);
    expect(own[0].text).toBe('second');
  });

  test('the global feed is newest-first and an author feed holds only their own', async () => {
    const { client, store } = build();
    await store.saveStatus(statusCard('s1', 'u1', at(0)));
    await store.saveStatus(statusCard('s2', 'u2', at(1)));
    await store.saveStatus(statusCard('s3', 'u1', at(2)));

    expect((await store.listStatuses()).map((card) => card.id)).toEqual(['s3', 's2', 's1']);
    expect((await store.listStatuses('u1')).map((card) => card.id)).toEqual(['s3', 's1']);
    expect((await store.listStatuses('u2')).map((card) => card.id)).toEqual(['s2']);
    expect(await store.listStatuses('nobody')).toEqual([]);
    expect(client.zsets.get('chat:status:user:u1').get('s2')).toBeUndefined();
    expect(client.zsets.get('chat:status:active').get('s2')).toBe(at(1));
  });

  test('caps the author index at the active status limit', async () => {
    const { client, store } = build();
    for (let i = 1; i <= STATUS_MAX_PER_USER + 2; i += 1) await store.saveStatus(statusCard(`s${i}`, 'u1', at(i)));

    expect((await store.listStatuses('u1')).map((card) => card.id)).toEqual(['s8', 's7', 's6', 's5', 's4', 's3']);
    expect(client.zsets.get('chat:status:user:u1').size).toBe(STATUS_MAX_PER_USER);
  });

  test('a view is counted once per viewer and never for the author', async () => {
    const { store } = build();
    await store.saveStatus(statusCard('s1', 'u1', at(0)));
    await store.saveStatus({ ...statusCard('s2', 'u1', at(1)), viewerIds: ['u1', 'u9'] });

    expect(await store.listStatusViewers('s2', at(1))).toEqual([{ userId: 'u9', displayName: null, at: at(1) }]);
    expect(await store.recordStatusView('s1', { userId: 'u1', displayName: 'Ada' }, at(2))).toBe(0);
    expect(await store.recordStatusView('s1', { userId: 'u2', displayName: 'Ben' }, at(2))).toBe(1);
    expect(await store.recordStatusView('s1', { userId: 'u2', displayName: 'Ben' }, at(3))).toBe(1);
    expect(await store.recordStatusView('s1', { userId: 'u3', displayName: 'Cid' }, at(4))).toBe(2);
    expect(await store.recordStatusView('gone', { userId: 'u2', displayName: 'Ben' }, at(4))).toBe(0);
    expect(await store.listStatusViewers('s1', at(4))).toEqual([
      { userId: 'u2', displayName: 'Ben', at: at(2) },
      { userId: 'u3', displayName: 'Cid', at: at(4) }
    ]);
    expect(await store.listStatusViewers('gone', at(4))).toEqual([]);
  });

  test('deleting removes the card from the store and from both lists', async () => {
    const { client, store } = build();
    await store.saveStatus(statusCard('s1', 'u1', at(0)));

    expect(await store.deleteStatus('s1')).toBe(true);
    expect(await store.deleteStatus('s1')).toBe(false);
    expect(await store.getStatus('s1', at(0))).toBeNull();
    expect(await store.listStatuses('u1', at(0))).toEqual([]);
    expect(await store.listStatuses(null, at(0))).toEqual([]);
    expect(client.kv.get('chat:status:s1')).toBeFalsy();
    expect(client.zsets.get('chat:status:active').has('s1')).toBe(false);
    expect(client.zsets.get('chat:status:user:u1').has('s1')).toBe(false);
  });
});
