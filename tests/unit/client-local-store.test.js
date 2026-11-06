/** @jest-environment jsdom */

'use strict';

/**
 * The browser's own copy of the chat, exercised against a real IndexedDB
 * implementation's semantics rather than a stub of my own making.
 *
 * What is being proved here is persistence, not rendering: that a row written now
 * is readable by a *different module instance over a different page load*, that
 * paging and gap detection use the sequence the server minted, that a duplicate
 * cannot survive a reload, and that an unsent message is the last thing any path
 * removes.
 */

const { installFakeIndexedDb, removeIndexedDb, stubStorageApi } = require('../helpers/fake-storage');
const { loadLocalStore } = require('../helpers/load-client-module');

const ROOM = 'sprint-room';
const OTHER = 'another-room';
const BASE_TS = 1_760_000_000_000;

let store;

const row = (id, seq, extra = {}) => ({
  id,
  clientId: null,
  seq,
  ts: BASE_TS + seq * 1000,
  text: `message ${seq}`,
  userId: 'u1',
  sender: 'me',
  author: 'Arjun',
  ...extra,
});

beforeEach(() => {
  installFakeIndexedDb();
  store = loadLocalStore();
});

afterEach(() => store.closeLocalStore());

describe('the schema', () => {
  it('creates the stores and indexes the read paths depend on', async () => {
    const db = await store.openLocalStore();
    expect([...db.objectStoreNames].sort()).toEqual([
      'calls', 'media', 'messages', 'meta', 'outbox', 'profiles', 'rooms',
    ].sort());
    const tx = db.transaction('messages', 'readonly');
    const names = tx.objectStore('messages').indexNames;
    expect([...names].sort()).toEqual(['byRoomClient', 'byRoomSeq']);
    tx.abort();
  });

  /**
   * The property every later version bump relies on: opening a database that
   * already exists must add to it, never rebuild it. Rewriting this file's
   * `upgrade` so it drops and recreates would pass every other test here and
   * delete everybody's history in production.
   */
  it('hands a second page load the rows the first one wrote', async () => {
    await store.storeMessages(ROOM, [row('m1', 1), row('m2', 2)]);
    await store.closeLocalStore();

    const reopened = loadLocalStore();
    const page = await reopened.readMessagePage(ROOM, { limit: 10 });
    expect(page.map((message) => message.id)).toEqual(['m1', 'm2']);
    await reopened.closeLocalStore();
  });

  it('says which store it could not open instead of only failing', async () => {
    globalThis.indexedDB.open = () => {
      const request = {};
      setTimeout(() => {
        request.error = new Error('nope');
        request.onerror();
      }, 0);
      return request;
    };
    expect(await store.openLocalStore()).toBeNull();
    expect(store.localStoreError().message).toBe('nope');
    // A later attempt is allowed to succeed; a latched failure would spend the
    // rest of the session behaving as though the device had no storage.
    delete globalThis.indexedDB.open;
    expect(await store.openLocalStore()).not.toBeNull();
  });
});

describe('the transcript', () => {
  it('stores only what the server has sequenced, and counts what it passed on', async () => {
    const result = await store.storeMessages(ROOM, [
      row('ok', 1),
      { id: 'pending', seq: null, text: 'not sent yet' },
      { id: 'echo', clientId: 'echo', text: 'no seq either' },
    ]);
    expect(result).toEqual({ written: 1, skipped: 2 });
    expect(await store.readMessagePage(ROOM)).toHaveLength(1);
  });

  it('writes the same row twice without showing it twice', async () => {
    await store.storeMessages(ROOM, [row('m1', 1)]);
    await store.storeMessages(ROOM, [row('m1', 1, { text: 'edited copy' })]);
    const page = await store.readMessagePage(ROOM);
    expect(page).toHaveLength(1);
    expect(page[0].text).toBe('edited copy');
  });

  /**
   * The bug this exists for. A send is optimistic under a client id and comes back
   * under the server's id; if both keys stay in the store, the message appears
   * twice on every reload from then on, which is invisible until someone
   * refreshes.
   */
  it('replaces the optimistic key when the server answers with its own id', async () => {
    const clientId = 'c-1';
    await store.storeMessages(ROOM, [row(clientId, 7, { clientId })]);
    await store.storeMessages(ROOM, [row('s-9', 7, { clientId })]);

    const page = await store.readMessagePage(ROOM);
    expect(page.map((message) => message.id)).toEqual(['s-9']);
    expect(await store.findMessageByClientId(ROOM, clientId)).toMatchObject({ id: 's-9' });
  });

  it('keeps receipts the stored row proved even if the newer copy lacks them', async () => {
    await store.storeMessages(ROOM, [row('m1', 1, { seenBy: ['u2'], deliveredTo: ['u2'] })]);
    await store.storeMessages(ROOM, [row('m1', 1, { seenBy: [], deliveredTo: [], text: 'echo' })]);
    const [message] = await store.readMessagePage(ROOM);
    expect(message).toMatchObject({ text: 'echo', seenBy: ['u2'], deliveredTo: ['u2'] });
  });

  it('pages the newest rows oldest-first and can walk back underneath them', async () => {
    await store.storeMessages(ROOM, Array.from({ length: 10 }, (_, i) => row(`m${i + 1}`, i + 1)));

    const page = await store.readMessagePage(ROOM, { limit: 4 });
    expect(page.map((message) => message.seq)).toEqual([7, 8, 9, 10]);

    const older = await store.readOlderMessages(ROOM, page[0].seq, { limit: 3 });
    expect(older.map((message) => message.seq)).toEqual([4, 5, 6]);
    expect(await store.readOlderMessages(ROOM, 1)).toEqual([]);
  });

  it('finds the gap a dropped socket left, and does not return the row it was told', async () => {
    await store.storeMessages(ROOM, [row('a', 1), row('b', 2), row('c', 3), row('d', 4)]);
    const missed = await store.readNewerMessages(ROOM, 2);
    expect(missed.map((message) => message.id)).toEqual(['c', 'd']);
    expect(await store.readNewerMessages(ROOM, 4)).toEqual([]);
  });

  it('keeps two rooms apart on every path that deletes', async () => {
    await store.storeMessages(ROOM, [row('a', 1), row('b', 2)]);
    await store.storeMessages(OTHER, [row('c', 1)]);

    expect(await store.deleteMessages(ROOM, ['a'])).toBe(1);
    expect(await store.readMessagePage(ROOM)).toHaveLength(1);

    // The count, because a delete that matches nothing still "succeeds": the
    // first version of this path keyed its range on the sequence instead of the
    // primary key and cleared exactly zero rows on every device.
    expect(await store.deleteRoomMessages(ROOM)).toBe(1);
    expect(await store.readMessagePage(ROOM)).toEqual([]);
    expect(await store.readMessagePage(OTHER)).toHaveLength(1);
  });

  /**
   * Commit, not "request succeeded". A write the browser refuses has to reject
   * the caller, or the UI reports a message as saved when the store threw it
   * away - which is the same lie as a lost message, only quieter.
   */
  it('rejects a write that cannot be committed instead of resolving it', async () => {
    await expect(store.storeMessages(ROOM, [
      row('bad', 1, { attachments: [{ name: 'a.png', blob: () => 1 }] }),
    ])).rejects.toThrow();
    expect(await store.readMessagePage(ROOM)).toEqual([]);
  });
});

describe("a room's own cursor", () => {
  it('remembers how far the local copy reaches', async () => {
    await store.saveRoomState(ROOM, { latestSeq: 12, oldestSeq: 3 });
    await store.saveRoomState(ROOM, { hydratedAt: BASE_TS });
    expect(await store.readRoomState(ROOM)).toMatchObject({
      latestSeq: 12, oldestSeq: 3, hydratedAt: BASE_TS,
    });
    expect(await store.listRoomStates()).toHaveLength(1);

    await store.forgetRoomState(ROOM);
    expect(await store.readRoomState(ROOM)).toBeNull();
  });
});

describe('the outbox', () => {
  it('keeps an unsent message across a reload, in the order it was queued', async () => {
    await store.queueOutbox({ room: ROOM, clientId: 'c1', text: 'first', queuedAt: BASE_TS });
    await store.queueOutbox({ room: ROOM, clientId: 'c2', text: 'second', queuedAt: BASE_TS + 1 });
    await store.closeLocalStore();

    const reopened = loadLocalStore();
    const queued = await reopened.readOutbox(ROOM);
    expect(queued.map((entry) => entry.clientId)).toEqual(['c1', 'c2']);
    expect(queued[0]).toMatchObject({ text: 'first', tries: 0 });
    await reopened.closeLocalStore();
  });

  it('re-queueing does not launder the attempts that failed', async () => {
    await store.queueOutbox({ room: ROOM, clientId: 'c1', text: 'hi', queuedAt: BASE_TS });
    await store.bumpOutboxTries('c1', 'store_unavailable');
    await store.bumpOutboxTries('c1', 'store_unavailable');
    await store.queueOutbox({ room: ROOM, clientId: 'c1', text: 'hi', queuedAt: Date.now() });

    const [entry] = await store.readOutbox(ROOM);
    expect(entry).toMatchObject({ tries: 2, queuedAt: BASE_TS, error: 'store_unavailable' });
  });

  it('is only emptied by the ack, or by signing out', async () => {
    await store.queueOutbox({ room: ROOM, clientId: 'c1', text: 'hi' });
    expect(await store.resolveOutbox('c1')).toBe(true);
    expect(await store.readOutbox(ROOM)).toEqual([]);

    await store.queueOutbox({ room: ROOM, clientId: 'c2', text: 'again' });
    expect(await store.clearOutbox()).toBe(true);
    expect(await store.readOutbox()).toEqual([]);
  });

  it('ignores an entry with nowhere to go', async () => {
    expect(await store.queueOutbox({ clientId: 'c1' })).toBeNull();
    expect(await store.queueOutbox(null)).toBeNull();
  });
});

describe('profiles and the call log', () => {
  it('caches an author profile once and updates it in place', async () => {
    expect(await store.readProfile('u1')).toBeNull();
    await store.storeProfiles([{ userId: 'u1', displayName: 'Arjun', about: 'hi' }]);
    await store.storeProfiles([{ userId: 'u1', displayName: 'Arjun', about: 'still here' }]);
    const profiles = await store.readProfiles(['u1', 'nobody']);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ userId: 'u1', about: 'still here' });
  });

  it('keeps the call log newest-first and bounded', async () => {
    await store.storeCalls([
      { id: 'c1', ts: BASE_TS, outcome: 'missed' },
      { id: 'c2', ts: BASE_TS + 5000, outcome: 'answered' },
      { id: 'c3', ts: BASE_TS + 9000, outcome: 'answered' },
    ]);
    const calls = await store.readCalls({ limit: 2 });
    expect(calls.map((call) => call.id)).toEqual(['c3', 'c2']);

    expect(await store.clearCalls()).toBe(true);
    expect(await store.readCalls()).toEqual([]);
  });
});

describe('attachment metadata', () => {
  it('describes an attachment without holding its bytes', async () => {
    await store.storeMedia(ROOM, [{
      id: 'a1', messageId: 'm1', kind: 'image', name: 'selfie.jpg', mime: 'image/jpeg', size: 42_000,
    }]);
    const media = await store.readMedia('a1');
    expect(media).toMatchObject({ id: 'a1', room: ROOM, name: 'selfie.jpg', size: 42_000 });
    expect(Object.keys(media).sort()).toEqual([
      'expired', 'id', 'kind', 'messageId', 'mime', 'name', 'room', 'size', 'storedAt',
    ]);
  });

  it('lists only what is older than the window it is given', async () => {
    await store.storeMedia(ROOM, [{ id: 'fresh', kind: 'file' }]);
    const fresh = await store.listMedia({ olderThanMs: 60_000 });
    expect(fresh).toEqual([]);

    const everything = await store.listMedia();
    expect(everything.map((entry) => entry.id)).toEqual(['fresh']);

    const ancient = await store.listMedia({ olderThanMs: 60_000, now: Date.now() + 3_600_000 });
    expect(ancient.map((entry) => entry.id)).toEqual(['fresh']);

    expect(await store.deleteMedia(['fresh'])).toBe(1);
    expect(await store.readMedia('fresh')).toBeNull();
  });
});

describe('quota', () => {
  it('reports what the browser will say about space', async () => {
    const restore = stubStorageApi(globalThis, {
      estimate: async () => ({ usage: 3 * 1024 ** 3, quota: 10 * 1024 ** 3 }),
    });
    expect(await store.readUsage()).toMatchObject({ supported: true, usage: 3 * 1024 ** 3, percent: 30 });
    restore();
  });

  /**
   * A quota of zero means the browser would not answer, not that the disk is
   * full. Reading it as 100% spent would put a "storage almost full" warning on
   * the screen of a brand new profile.
   */
  it('treats an unanswered quota as unknown rather than exhausted', async () => {
    const restore = stubStorageApi(globalThis, { estimate: async () => ({ usage: 0, quota: 0 }) });
    expect(await store.readUsage()).toMatchObject({ supported: true, percent: 0 });
    restore();
  });

  it('says so when the platform has no storage API at all', async () => {
    expect(await store.readUsage()).toMatchObject({ supported: false, percent: 0 });
    expect(await store.requestPersistence()).toMatchObject({ supported: false, persisted: false });
  });

  it('passes a refused persistence request through as a refusal', async () => {
    const restore = stubStorageApi(globalThis, {
      persisted: async () => false,
      persist: async () => false,
    });
    expect(await store.requestPersistence()).toEqual({ supported: true, persisted: false, asked: true });
    restore();
  });

  it('recognises a quota failure under each engine', () => {
    expect(store.isQuotaError(Object.assign(new Error('out of space'), { name: 'QuotaExceededError' }))).toBe(true);
    expect(store.isQuotaError(Object.assign(new Error('Storage limit reached'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' }))).toBe(true);
    expect(store.isQuotaError(Object.assign(new Error('UnknownError'), { name: 'UnknownError', message: 'The operation failed for reasons unrelated to the database itself and not trying again may speed up your browser.' }))).toBe(false);
    expect(store.isQuotaError(new TypeError('cannot read property'))).toBe(false);
    expect(store.isQuotaError(null)).toBe(false);
  });

  it('keeps a small record about what it last reported', async () => {
    expect(await store.readMeta('lastNotice')).toBeNull();
    expect(await store.writeMeta('lastNotice', { percent: 91, at: BASE_TS })).toMatchObject({ percent: 91 });
    expect(await store.readMeta('lastNotice')).toMatchObject({ percent: 91 });
  });
});

describe('retention', () => {
  const fill = async (room, count, ageMs) => {
    const rows = Array.from({ length: count }, (_, i) => row(`${room}-${i + 1}`, i + 1, { ts: BASE_TS - ageMs }));
    await store.storeMessages(room, rows);
    await store.saveRoomState(room, { latestSeq: count, oldestSeq: 1 });
    return rows;
  };

  it('trims an old tail but never the recent screen of a room', async () => {
    const count = store.PINNED_PER_ROOM + 10;
    await fill(ROOM, count, 400 * 24 * 3600 * 1000);

    const result = await store.enforceRetention({ now: BASE_TS });
    expect(result).toMatchObject({ messages: 10, pinned: store.PINNED_PER_ROOM });
    const left = await store.readMessagePage(ROOM, { limit: 200 });
    expect(left).toHaveLength(store.PINNED_PER_ROOM);
    expect(left[left.length - 1].seq).toBe(count);
  });

  it('leaves recent history alone even when the tail is enormous', async () => {
    await fill(ROOM, store.PINNED_PER_ROOM + 10, 0);
    expect(await store.enforceRetention({ now: BASE_TS })).toMatchObject({ messages: 0 });
    expect(await store.readMessagePage(ROOM, { limit: 200 })).toHaveLength(store.PINNED_PER_ROOM + 10);
  });

  it('drops stale attachment metadata and reports both counts', async () => {
    await store.storeMedia(ROOM, [{ id: 'old', kind: 'image' }]);
    await store.storeCalls([{ id: 'c1', ts: BASE_TS }]);
    await store.queueOutbox({ room: ROOM, clientId: 'keep', text: 'unsent', queuedAt: BASE_TS });

    const result = await store.enforceRetention({
      now: Date.now() + 31 * 24 * 3600 * 1000,
      mediaTtlMs: 30 * 24 * 3600 * 1000,
    });
    expect(result).toMatchObject({ media: 1, messages: 0 });
    expect(await store.readMedia('old')).toBeNull();

    // The two things cleanup is forbidden to touch.
    expect(await store.readCalls()).toHaveLength(1);
    expect(await store.readOutbox()).toMatchObject([{ clientId: 'keep' }]);
  });

  it('names the rooms it trimmed so the notice can say which', async () => {
    await fill(ROOM, store.PINNED_PER_ROOM + 3, 400 * 24 * 3600 * 1000);
    await fill(OTHER, 5, 400 * 24 * 3600 * 1000);
    const result = await store.enforceRetention({ now: BASE_TS });
    expect(result.rooms).toEqual([{ room: ROOM, count: 3 }]);
    expect(result.messages).toBe(3);
  });
});

/**
 * Safari in private mode, Firefox with "block until I ask" storage, and any
 * browser whose IndexedDB threw on open all end up here. Losing the offline copy
 * is survivable; an exception on the send path is not, so every call has to
 * resolve into "nothing happened" instead.
 */
describe('a browser with no IndexedDB', () => {
  beforeEach(removeIndexedDb);

  it('reports the store as unavailable', () => {
    expect(store.supportsLocalStore()).toBe(false);
    expect(store.storageAvailable()).toBe(false);
  });

  it('resolves every read and write to nothing rather than throwing', async () => {
    await expect(store.openLocalStore()).resolves.toBeNull();
    await expect(store.storeMessages(ROOM, [row('m1', 1)])).resolves.toEqual({ written: 0, skipped: 0 });
    await expect(store.readMessagePage(ROOM)).resolves.toEqual([]);
    await expect(store.readOlderMessages(ROOM, 5)).resolves.toEqual([]);
    await expect(store.readNewerMessages(ROOM, 0)).resolves.toEqual([]);
    await expect(store.findMessageByClientId(ROOM, 'c1')).resolves.toBeNull();
    await expect(store.deleteMessages(ROOM, ['m1'])).resolves.toBe(0);
    await expect(store.deleteRoomMessages(ROOM)).resolves.toBe(0);
    await expect(store.readRoomState(ROOM)).resolves.toBeNull();
    await expect(store.listRoomStates()).resolves.toEqual([]);
    await expect(store.readProfiles(['u1'])).resolves.toEqual([]);
    await expect(store.readCalls()).resolves.toEqual([]);
    await expect(store.readOutbox()).resolves.toEqual([]);
    await expect(store.listMedia()).resolves.toEqual([]);
    await expect(store.readMeta('k')).resolves.toBeNull();
    await expect(store.enforceRetention()).resolves.toMatchObject({ media: 0, messages: 0 });
    await expect(store.wipeLocalStore()).resolves.toBeUndefined();
    await expect(store.closeLocalStore()).resolves.toBeUndefined();
  });
});
