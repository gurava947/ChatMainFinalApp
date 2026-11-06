'use strict';

const MemoryStore = require('../../src/store/memory-store');
const { CALL_HISTORY_MAX, STATUS_TTL_SECONDS, STATUS_MAX_PER_USER, STATUS_COLORS } = require('../../src/constants');

/**
 * The same knobs the real config passes, so a test room trims, pages and
 * expires exactly the way a deployed one does.
 */
function buildStore(options = {}) {
  return new MemoryStore({
    messageCacheSize: 5,
    messageHistoryMax: 5,
    sessionTtlSeconds: 43200,
    mediaTtlSeconds: 3600,
    retentionSeconds: 2592000,
    ...options
  });
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

describe('message history', () => {
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
    expect((await store.recentMessages('room', 1)).map((m) => m.id)).toEqual(['b']);
  });

  test('a renamed option is refused at construction rather than emptying every room', () => {
    expect(() => new MemoryStore({ messageCacheSize: 5, sessionTtlSeconds: 43200 })).toThrow(/messageHistoryMax/);
  });

  test('stamps a per-room sequence that orders rows without trusting the clock', async () => {
    const store = buildStore();
    // Both rows carry the same ts, so only the minted sequence separates them.
    const first = await store.pushMessage('general', { id: '1', ts: 1000 });
    const second = await store.pushMessage('general', { id: '2', ts: 1000 });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect((await store.recentMessages('general', 10)).map((m) => m.seq)).toEqual([1, 2]);

    // Sequence counters are per room, not global.
    expect((await store.pushMessage('other', { id: '3' })).seq).toBe(1);
  });

  test('pages underneath a cursor, oldest-first, and stops at the floor', async () => {
    const store = buildStore({ messageHistoryMax: 8 });
    for (let i = 1; i <= 8; i += 1) await store.pushMessage('general', { id: String(i) });

    const top = await store.historyPage('general', { limit: 3 });
    expect(top.map((m) => m.id)).toEqual(['6', '7', '8']);

    const middle = await store.historyPage('general', { limit: 3, before: top[0].seq });
    expect(middle.map((m) => m.id)).toEqual(['3', '4', '5']);

    const bottom = await store.historyPage('general', { limit: 3, before: middle[0].seq });
    expect(bottom.map((m) => m.id)).toEqual(['1', '2']);

    // Paging below the oldest row returns nothing rather than repeating a page.
    expect(await store.historyPage('general', { limit: 3, before: bottom[0].seq })).toEqual([]);
  });

  test('a page cannot be larger than the room keeps', async () => {
    const store = buildStore({ messageHistoryMax: 4 });
    for (let i = 1; i <= 10; i += 1) await store.pushMessage('general', { id: String(i) });
    expect(await store.historyPage('general', { limit: 100 })).toHaveLength(4);
  });

  test('every row remembers its room, so a receipt cannot be applied elsewhere', async () => {
    const store = buildStore();
    const mine = await store.pushMessage('general', { id: 'm1' });
    await store.pushMessage('other', { id: 'm2' });

    expect(await store.messageRoom(mine.id)).toBe('general');
    expect(await store.messageRoom('never-sent')).toBeNull();
    expect(await store.messageRooms(['m1', 'm2', 'nope'])).toEqual(
      new Map([['m1', 'general'], ['m2', 'other'], ['nope', null]])
    );
  });

  test('wiping a room drops its rows and owners but keeps the sequence', async () => {
    const store = buildStore();
    await store.pushMessage('general', { id: 'm1' });
    await store.pushMessage('general', { id: 'm2' });

    expect(await store.dropRoom('general')).toBe(2);
    expect(await store.recentMessages('general', 10)).toEqual([]);
    expect(await store.messageRoom('m1')).toBeNull();
    // A client holding the old rows must not see new ones filed under numbers
    // it already paged past.
    expect((await store.pushMessage('general', { id: 'm3' })).seq).toBe(3);
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
    const store = buildStore({ mediaTtlSeconds: 1 });
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

/* Every read the shared store offers has to exist here too, or a single
 * process would answer questions the deployment topology depends on. */
describe('store parity with the shared backend', () => {
  test('the people in a room come from presence, stale sockets excluded', async () => {
    const store = buildStore();
    const now = Date.now();
    await store.trackPresence('general', 's1', { userId: 'ana', displayName: 'Ana' }, now);
    await store.trackPresence('general', 's2', { userId: 'ana', displayName: 'Ana' }, now);
    await store.trackPresence('general', 's3', { userId: 'ben', displayName: 'Ben' }, now);
    await store.trackPresence('general', 'old', { userId: 'cid', displayName: 'Cid' }, now - 60000);

    expect((await store.roomUsers('general', 45000, now)).sort()).toEqual(['ana', 'ben']);
  });

  test('an attachment that is gone answers false rather than a missing row', async () => {
    const store = buildStore();
    const saved = await store.saveMedia({ id: 'a1', userId: 'u1', name: 'x.png', mime: 'image/png', size: 1 });
    expect(await store.mediaExists(['a1', 'gone'])).toEqual(new Map([['a1', true], ['gone', false]]));

    await store.deleteMedia('a1');
    expect(await store.mediaExists([])).toEqual(new Map());
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
  });

  test('only an unanswered claim is given back', async () => {
    const store = buildStore();
    expect(await store.claimSend('u1', 'pending-client', 60000)).toEqual({ fresh: true, messageId: null });
    expect(await store.claimSend('u1', 'pending-client', 60000)).toEqual({ fresh: false, messageId: null });
    await store.releaseSend('u1', 'pending-client');
    expect((await store.claimSend('u1', 'pending-client', 60000)).fresh).toBe(true);

    await store.claimSend('u1', 'done-client', 60000);
    await store.recordSend('u1', 'done-client', 'm9', 60000);
    await store.releaseSend('u1', 'done-client');
    expect(await store.claimSend('u1', 'done-client', 60000)).toEqual({ fresh: false, messageId: 'm9' });
  });

  test('a room password is first-writer-wins', async () => {
    const store = buildStore();
    const record = { hash: 'x', salt: 'y' };
    expect(await store.setRoomPasswordIfAbsent('general', record)).toBe(true);
    expect(await store.setRoomPasswordIfAbsent('general', { hash: 'z', salt: 'w' })).toBe(false);
    expect(await store.getRoomPassword('general')).toEqual(record);
  });

  test('a roster is claimed once and replaced only at the version it was read at', async () => {
    const store = buildStore();
    const roster = { room: 'general', owner: 'u1', guest: null, version: 0 };
    expect(await store.getRoomRoster('general')).toBeNull();
    expect(await store.createRoomRoster('general', roster)).toBe(true);
    expect(await store.createRoomRoster('general', { ...roster, owner: 'u2' })).toBe(false);
    expect(await store.getRoomRoster('general')).toEqual(roster);

    const seated = { ...roster, guest: 'u2', version: 1 };
    expect(await store.replaceRoomRoster('general', seated, 0)).toBe('ok');
    // The answer is 'conflict' rather than a silent overwrite: a request that
    // read version 0 no longer knows who holds the second seat.
    expect(await store.replaceRoomRoster('general', { ...roster, guest: 'u3', version: 1 }, 0)).toBe('conflict');
    expect(await store.getRoomRoster('general')).toEqual(seated);
    expect(await store.replaceRoomRoster('gone', roster, 0)).toBe('absent');
  });

  test('a roster read hands back a copy, so a caller cannot seat itself by mutation', async () => {
    const store = buildStore();
    await store.createRoomRoster('general', { room: 'general', owner: 'u1', guest: null, version: 0 });
    const read = await store.getRoomRoster('general');
    read.guest = 'someone-else';
    expect(await store.getRoomRoster('general')).toEqual({ room: 'general', owner: 'u1', guest: null, version: 0 });
  });
});
