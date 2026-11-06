'use strict';

/**
 * The rules that decide what a guest sees after the room has been re-read.
 *
 * These are the parts of the chat client that a browser test describes badly and
 * a unit test describes exactly: the order of a transcript, what a reconnect
 * does to the rows below the server's window, and which rows are worth writing
 * to IndexedDB. They are asserted against `client/src/transcript.js` as shipped,
 * not against a copy - the file has no imports, so the same text runs here and in
 * the bundle.
 */

const { loadTranscript } = require('../helpers/load-client-module');

const BASE_TS = 1_760_000_000_000;

let t;

beforeEach(() => {
  t = loadTranscript();
});

const row = (id, seq, extra = {}) => ({
  id,
  clientId: null,
  seq,
  ts: BASE_TS + seq * 1000,
  text: `message ${seq}`,
  ...extra,
});

describe('ordering', () => {
  it('sorts by the sequence the store minted, not by the clock', () => {
    // Two replicas that wrote in the same millisecond, and whose clocks disagree.
    const list = [row('b', 2, { ts: 1000 }), row('a', 1, { ts: 9000 })];
    expect([...list].sort(t.byArrival).map((message) => message.id)).toEqual(['a', 'b']);
  });

  it('puts an accepted row ahead of an unaccepted one however late it is', () => {
    const ordered = [row('sent', 5), row('draft', null, { ts: BASE_TS - 10 })].sort(t.byArrival);
    expect(ordered.map((message) => message.id)).toEqual(['sent', 'draft']);
  });

  it('falls back to the timestamp between two rows nothing has numbered yet', () => {
    const ordered = [
      row('late', null, { ts: BASE_TS + 5000 }),
      row('early', null, { ts: BASE_TS + 1000 }),
    ].sort(t.byArrival);
    expect(ordered.map((message) => message.id)).toEqual(['early', 'late']);
  });
});

describe('one message into the list', () => {
  it('appends what it has never seen and keeps the order', () => {
    const list = t.mergeMessage([row('m2', 2)], row('m1', 1));
    expect(list.map((message) => message.id)).toEqual(['m1', 'm2']);
  });

  it('turns this device own bubble into the server row instead of duplicating it', () => {
    // The optimistic row was made up under a clientId and has no id of its own
    // yet; the echo comes back with both, and must land in the same bubble.
    const optimistic = row('client-1', null, { clientId: 'client-1', pending: true });
    const list = t.mergeMessage([optimistic], row('srv-9', 9, { clientId: 'client-1' }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'srv-9', seq: 9, pending: false, failed: false });
  });

  it('clears a failed flag when the row comes back alive', () => {
    const stuck = row('m3', 3, { failed: true });
    const list = t.mergeMessage([stuck], row('m3', 3));
    expect(list[0].failed).toBe(false);
  });
});

describe('an older page', () => {
  it('prepends rows the device does not hold', () => {
    const list = t.mergePage([row('m3', 3)], [row('m1', 1), row('m2', 2)]);
    expect(list.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('hands back the same list when the page held nothing new', () => {
    const list = [row('m1', 1), row('m2', 2)];
    expect(t.mergePage(list, [row('m1', 1)])).toBe(list);
  });
});

describe('a server page folded over the device copy', () => {
  /**
   * The defect this exists to stop: a page is the room's newest window, and
   * replacing the transcript with it throws away every row underneath - which is
   * exactly the material a local store was added to keep.
   */
  it('keeps the rows below the page window', () => {
    const local = [row('m1', 1), row('m2', 2), row('m3', 3)];
    const page = [row('m4', 4), row('m5', 5)];
    const merged = t.mergeServerPage(local, page);
    expect(merged.map((message) => message.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('lets the server win for the rows it covers', () => {
    const local = [row('m1', 1, { text: 'stale' }), row('m2', 2)];
    const merged = t.mergeServerPage(local, [row('m2', 2), row('m3', 3, { text: 'from the server' })]);
    expect(merged.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(merged[2].text).toBe('from the server');
  });

  it('carries an unsent bubble through a reconnect', () => {
    const pending = row('client-1', null, { clientId: 'client-1', pending: true });
    const merged = t.mergeServerPage([pending], [row('m1', 1)]);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ id: 'client-1', pending: true });
  });

  it('does not invent rows out of an empty page', () => {
    const local = [row('m1', 1)];
    expect(t.mergeServerPage(local, [])).toEqual(local);
    expect(t.mergeServerPage(local, undefined)).toEqual(local);
  });
});

describe('the cursor for "load older"', () => {
  it('pages from the lower edge, whichever side it came from', () => {
    expect(t.olderCursor(50, 12)).toBe(12);
    expect(t.olderCursor(12, 50)).toBe(12);
  });

  it('takes the one edge it has when the other is unknown', () => {
    expect(t.olderCursor(null, 40)).toBe(40);
    expect(t.olderCursor(40, null)).toBe(40);
    expect(t.olderCursor(undefined, undefined)).toBeNull();
  });

  it('ignores a page whose first row was never numbered', () => {
    expect(t.olderCursor(7, undefined)).toBe(7);
    expect(t.olderCursor(Number.NaN, 'not a sequence')).toBeNull();
  });
});

describe('which rows earn a write', () => {
  it('skips a row the server has not numbered', () => {
    // An unacked send has no place to be read back in order, and the outbox is
    // what actually owes it a home.
    const fresh = t.rowsToPersist([row('m1', 1), row('draft', null)], new Set(), new Set());
    expect(fresh.map((message) => message.id)).toEqual(['m1']);
  });

  it('skips a row this device has already committed', () => {
    const rows = [row('m1', 1), row('m2', 2)];
    const fresh = t.rowsToPersist(rows, new Set(['m1']), new Set());
    expect(fresh.map((message) => message.id)).toEqual(['m2']);
  });

  it('rewrites a committed row whose receipts moved', () => {
    const rows = [row('m1', 1, { seenBy: ['u2'] }), row('m2', 2)];
    const fresh = t.rowsToPersist(rows, new Set(['m1', 'm2']), new Set(['m1']));
    expect(fresh.map((message) => message.id)).toEqual(['m1']);
  });

  it('will not write a row with no id to key it by', () => {
    const rows = [{ seq: 1, ts: BASE_TS }, row('m2', 2)];
    expect(t.rowsToPersist(rows, new Set(), new Set()).map((message) => message.id)).toEqual(['m2']);
  });

  it('treats a missing book of record as nothing held yet', () => {
    const rows = [row('m1', 1)];
    expect(t.rowsToPersist(rows)).toEqual(rows);
  });

  it('says which message each attachment belongs to', () => {
    const rows = [
      row('m1', 1, { attachments: [{ id: 'a', kind: 'image' }, { id: 'b', kind: 'file' }] }),
      row('m2', 2),
      row('m3', 3, { attachments: [{ id: 'c', kind: 'video' }] }),
    ];
    expect(t.attachmentRows(rows)).toEqual([
      { id: 'a', kind: 'image', messageId: 'm1' },
      { id: 'b', kind: 'file', messageId: 'm1' },
      { id: 'c', kind: 'video', messageId: 'm3' },
    ]);
  });
});
