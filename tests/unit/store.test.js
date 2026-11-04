'use strict';

const MemoryStore = require('../../src/store/memory-store');
const { CALL_HISTORY_MAX, STATUS_TTL_SECONDS, STATUS_MAX_PER_USER, STATUS_COLORS } = require('../../src/constants');

function buildStore() {
  return new MemoryStore({ messageCacheSize: 5 });
}

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

describe('message cache', () => {
  test('keeps the newest N messages and returns them oldest-first', async () => {
    const store = buildStore();
    for (let i = 1; i <= 8; i += 1) {
      await store.pushMessage('general', { id: String(i), ts: i });
    }
    const recent = await store.recentMessages('general', 10);
    expect(recent.map((m) => m.id)).toEqual(['4', '5', '6', '7', '8']);
  });

  test('honours the requested limit', async () => {
    const store = buildStore();
    await store.pushMessage('room', { id: 'a' });
    await store.pushMessage('room', { id: 'b' });
    expect(await store.recentMessages('room', 1)).toEqual([{ id: 'b' }]);
  });
});

describe('presence', () => {
  test('counts connections and unique users separately', async () => {
    const store = buildStore();
    const user = { userId: 'u1', displayName: 'Ada' };
    await store.trackPresence('general', 's1', user, 1000);
    await store.trackPresence('general', 's2', user, 1000);
    await store.trackPresence('general', 's3', { userId: 'u2', displayName: 'Lin' }, 1000);

    const snapshot = await store.presenceSnapshot('general', 45000, 1000);
    expect(snapshot.connections).toBe(3);
    expect(snapshot.onlineUsers).toBe(2);
  });

  test('a second heartbeat refreshes the same entry instead of duplicating it', async () => {
    const store = buildStore();
    const user = { userId: 'u1', displayName: 'Ada', since: 1000 };
    await store.trackPresence('general', 's1', user, 1000);
    await store.trackPresence('general', 's1', user, 5000);

    const snapshot = await store.presenceSnapshot('general', 45000, 5000);
    expect(snapshot.connections).toBe(1);
    expect(snapshot.users[0].since).toBe(1000);
  });

  test('stale entries are pruned, live ones survive', async () => {
    const store = buildStore();
    await store.trackPresence('general', 'dead', { userId: 'u1', displayName: 'A' }, 0);
    await store.trackPresence('general', 'alive', { userId: 'u2', displayName: 'B' }, 9000);

    const removed = await store.pruneStalePresence('general', 5000, 10000);
    expect(removed).toEqual(['dead']);

    const snapshot = await store.presenceSnapshot('general', 5000, 10000);
    expect(snapshot.users.map((u) => u.socketId)).toEqual(['alive']);
  });

  test('releasePresence removes the socket', async () => {
    const store = buildStore();
    await store.trackPresence('general', 's1', { userId: 'u1', displayName: 'A' }, 1000);
    await store.releasePresence('general', 's1');
    expect((await store.presenceSnapshot('general', 45000, 1000)).connections).toBe(0);
  });
});

describe('fixed-window rate limiting', () => {
  test('blocks the request that exceeds the limit', async () => {
    const store = buildStore();
    expect(await store.consumeWindow('send:x', 2, 1000)).toMatchObject({ total: 1, remaining: 1 });
    expect(await store.consumeWindow('send:x', 2, 1000)).toMatchObject({ total: 2, remaining: 0 });
    expect(await store.consumeWindow('send:x', 2, 1000)).toMatchObject({ total: 3, remaining: 0 });
  });

  test('resets once the window has elapsed', async () => {
    const store = buildStore();
    await store.consumeWindow('send:y', 1, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.consumeWindow('send:y', 1, 1000)).toMatchObject({ total: 1 });
  });
});

describe('read receipts', () => {
  test('only the first read of a message counts', async () => {
    const store = buildStore();
    expect(await store.markSeen('m1', 'u1', 1000)).toBe(true);
    expect(await store.markSeen('m1', 'u1', 2000)).toBe(false);
    expect(await store.markSeen('m1', 'u2', 2000)).toBe(true);
    expect(await store.seenByMessages(['m1', 'unknown'])).toEqual(
      new Map([['m1', ['u1', 'u2']], ['unknown', []]])
    );
  });
});

describe('media metadata', () => {
  test('stores the sniffed mime and drops the record once it expires', async () => {
    const store = new MemoryStore({ messageCacheSize: 5, mediaTtlSeconds: 1 });
    const saved = await store.saveMedia({ id: 'a1', userId: 'u1', name: 'x.png', mime: 'image/png; x', size: 3 });
    expect(saved.mime).toBe('image/png');
    expect(await store.getMedia('a1')).toMatchObject({ id: 'a1' });

    const due = await store.expiredMedia(saved.expiresAt + 1, 10);
    expect(due.map((r) => r.id)).toEqual(['a1']);

    await store.deleteMedia('a1');
    expect(await store.getMedia('a1')).toBeNull();
  });
});

describe('call history', () => {
  test('a later write for the same id patches the record instead of adding a row', async () => {
    const store = buildStore();
    await store.recordCall(callEntry('c1', at(0)));
    await store.recordCall({ ...callEntry('c1', at(0)), status: 'connected', connectedAt: at(1) });

    const record = await store.getCall('c1');
    expect(record.status).toBe('connected');
    expect(record.connectedAt).toBe(at(1));
    expect((await store.listCalls('u1')).map((call) => call.id)).toEqual(['c1']);
    expect(await store.getCall('unknown')).toBeNull();
  });

  test('lists every participant newest-first and honours the limit', async () => {
    const store = buildStore();
    for (let i = 0; i < 3; i += 1) await store.recordCall(callEntry(`c${i}`, at(i)));

    expect((await store.listCalls('u1')).map((call) => call.id)).toEqual(['c2', 'c1', 'c0']);
    expect((await store.listCalls('u2', 2)).map((call) => call.id)).toEqual(['c2', 'c1']);
    expect(await store.listCalls('stranger')).toEqual([]);
  });

  test('caps each participant index at the history size', async () => {
    const store = buildStore();
    for (let i = 1; i <= CALL_HISTORY_MAX + 2; i += 1) await store.recordCall(callEntry(`c${i}`, at(i), ['u1']));

    const list = await store.listCalls('u1');
    expect(list).toHaveLength(CALL_HISTORY_MAX);
    expect(list[0].id).toBe(`c${CALL_HISTORY_MAX + 2}`);
    expect(list[list.length - 1].id).toBe('c3');
    expect((await store.listCalls('u1', 2)).map((call) => call.id)).toEqual([`c${CALL_HISTORY_MAX + 2}`, `c${CALL_HISTORY_MAX + 1}`]);
  });

  test('clearing empties one list and drops a record only once nobody lists it', async () => {
    const store = buildStore();
    await store.recordCall(callEntry('shared', at(0), ['u1', 'u2']));
    await store.recordCall(callEntry('solo', at(1), ['u1']));

    expect(await store.clearCalls('u1')).toBe(2);
    expect(await store.listCalls('u1')).toEqual([]);
    expect((await store.listCalls('u2')).map((call) => call.id)).toEqual(['shared']);
    expect(await store.getCall('solo')).toBeNull();
    expect(await store.getCall('shared')).not.toBeNull();

    await store.clearCalls('u2');
    expect(await store.getCall('shared')).toBeNull();
    expect(await store.clearCalls('nobody')).toBe(0);
  });
});

describe('statuses', () => {
  test('a card reads back until its own expiry, and an expired read removes it for good', async () => {
    const store = buildStore();
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
    const store = buildStore();
    const now = Date.now();
    await store.saveStatus(statusCard('s1', 'u1', now - 6 * 3600 * 1000, now + 30_000));

    expect(await store.getStatus('s1', now)).not.toBeNull();
    expect(await store.getStatus('s1', now + 30_000)).toBeNull();
    expect(await store.listStatuses('u1', now + 30_000)).toEqual([]);
  });

  test('re-saving an id replaces the card without duplicating the author index', async () => {
    const store = buildStore();
    await store.saveStatus(statusCard('s1', 'u1', at(0)));
    await store.saveStatus({ ...statusCard('s1', 'u1', at(1)), text: 'second' });

    const own = await store.listStatuses('u1');
    expect(own.map((card) => card.id)).toEqual(['s1']);
    expect(own[0].text).toBe('second');
  });

  test('the global feed is newest-first and an author feed holds only their own', async () => {
    const store = buildStore();
    await store.saveStatus(statusCard('s1', 'u1', at(0)));
    await store.saveStatus(statusCard('s2', 'u2', at(1)));
    await store.saveStatus(statusCard('s3', 'u1', at(2)));

    expect((await store.listStatuses()).map((card) => card.id)).toEqual(['s3', 's2', 's1']);
    expect((await store.listStatuses('u1')).map((card) => card.id)).toEqual(['s3', 's1']);
    expect((await store.listStatuses('u2')).map((card) => card.id)).toEqual(['s2']);
    expect(await store.listStatuses('nobody')).toEqual([]);
  });

  test('caps the author index at the active status limit', async () => {
    const store = buildStore();
    for (let i = 1; i <= STATUS_MAX_PER_USER + 2; i += 1) await store.saveStatus(statusCard(`s${i}`, 'u1', at(i)));

    expect((await store.listStatuses('u1')).map((card) => card.id)).toEqual(['s8', 's7', 's6', 's5', 's4', 's3']);
  });

  test('a view is counted once per viewer and never for the author', async () => {
    const store = buildStore();
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
    const store = buildStore();
    await store.saveStatus(statusCard('s1', 'u1', at(0)));

    expect(await store.deleteStatus('s1')).toBe(true);
    expect(await store.deleteStatus('s1')).toBe(false);
    expect(await store.getStatus('s1', at(0))).toBeNull();
    expect(await store.listStatuses('u1', at(0))).toEqual([]);
    expect(await store.listStatuses(null, at(0))).toEqual([]);
  });
});
