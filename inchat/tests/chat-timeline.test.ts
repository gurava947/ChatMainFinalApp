import { describe, expect, it } from 'vitest';

import {
  appendOptimistic,
  applyDelete,
  applyEdit,
  confirmSend,
  emptyTimeline,
  hasClientId,
  markSendFailed,
  merge,
  olderCursor,
  type Message
} from '@/lib/chat/timeline';

let counter = 0;

function msg(over: Partial<Message> = {}): Message {
  counter += 1;
  return {
    id: `srv-${counter}`,
    conversationId: 'conv-1',
    senderId: 'user-b',
    clientId: `client-${counter}`,
    kind: 'text',
    body: `hello ${counter}`,
    payload: {},
    createdAt: 1_700_000_000_000 + counter,
    editedAt: null,
    deletedAt: null,
    pending: false,
    failed: false,
    ...over
  };
}

function mine(over: Partial<Message> = {}): Message {
  return msg({ senderId: 'me', id: `local-${over.clientId ?? counter}`, ...over });
}

describe('optimistic send', () => {
  it('holds an unacknowledged send under a local id', () => {
    const t = appendOptimistic(emptyTimeline(), mine({ clientId: 'c1', body: 'hi', createdAt: 10 }));
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ id: 'local:c1', pending: true, failed: false, body: 'hi' });
  });

  it('drops a second local copy of the same idempotency key', () => {
    const start = appendOptimistic(emptyTimeline(), mine({ clientId: 'c1' }));
    const twice = appendOptimistic(start, mine({ clientId: 'c1', id: 'ignored' }));
    expect(twice.rows).toHaveLength(1);
    expect(hasClientId(twice, 'c1', 'me')).toBe(true);
  });

  it('treats the same clientId from another sender as a different message', () => {
    const t = appendOptimistic(emptyTimeline(), mine({ clientId: 'shared' }));
    const other = appendOptimistic(t, msg({ clientId: 'shared', senderId: 'user-b' }));
    expect(other.rows).toHaveLength(2);
  });

  it('keeps the timeline sorted oldest to newest', () => {
    const t = merge(emptyTimeline(), [
      msg({ createdAt: 300 }),
      msg({ createdAt: 100 }),
      msg({ createdAt: 200 })
    ]);
    expect(t.rows.map((row) => row.createdAt)).toEqual([100, 200, 300]);
  });
});

describe('duplicate prevention', () => {
  it('evicts the pending twin when the server row arrives', () => {
    const pending = appendOptimistic(emptyTimeline(), mine({ clientId: 'c1', createdAt: 500 }));
    const merged = merge(pending, [mine({ clientId: 'c1', id: 'srv-9', createdAt: 501 })]);

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]).toMatchObject({ id: 'srv-9', pending: false });
  });

  it('collapses the ack and the realtime echo into one row', () => {
    const pending = appendOptimistic(emptyTimeline(), mine({ clientId: 'c1', createdAt: 500 }));
    const acked = confirmSend(pending, { clientId: 'c1', senderId: 'me', id: 'srv-9', createdAt: 501 });
    const echoed = merge(acked, [mine({ clientId: 'c1', id: 'srv-9', createdAt: 501 })]);

    expect(echoed.rows).toHaveLength(1);
    expect(echoed.rows[0].id).toBe('srv-9');
  });

  it('survives an echo that arrives before the ack', () => {
    const pending = appendOptimistic(emptyTimeline(), mine({ clientId: 'c1', createdAt: 500 }));
    const echoed = merge(pending, [mine({ clientId: 'c1', id: 'srv-9', createdAt: 501 })]);
    const acked = confirmSend(echoed, { clientId: 'c1', senderId: 'me', id: 'srv-9', createdAt: 501 });

    expect(acked.rows).toHaveLength(1);
    expect(acked.rows[0]).toMatchObject({ id: 'srv-9', pending: false, failed: false });
  });

  it('re-merging the same server row changes nothing', () => {
    const one = merge(emptyTimeline(), [msg({ id: 'srv-1' })]);
    const twice = merge(one, [msg({ id: 'srv-1', body: 'edited on server' })]);

    expect(twice.rows).toHaveLength(1);
    expect(twice.rows[0].body).toBe('edited on server');
  });

  it('is idempotent across a reconnect replay of the whole window', () => {
    const rows = [msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'c' })];
    const once = merge(emptyTimeline(), rows);
    const replayed = merge(once, rows);

    expect(replayed.rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('send acknowledgement', () => {
  it('confirms a queued send and keeps its content', () => {
    const pending = appendOptimistic(
      emptyTimeline(),
      mine({ clientId: 'c1', kind: 'poll', body: '', payload: { question: 'Lunch?' }, createdAt: 700 })
    );
    const t = confirmSend(pending, { clientId: 'c1', senderId: 'me', id: 'srv-9', createdAt: 702 });

    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      id: 'srv-9',
      kind: 'poll',
      payload: { question: 'Lunch?' },
      pending: false
    });
  });

  it('marks only the failed send, leaving the rest of the window alone', () => {
    let t = appendOptimistic(emptyTimeline(), mine({ clientId: 'c1' }));
    t = appendOptimistic(t, mine({ clientId: 'c2' }));
    t = markSendFailed(t, 'c1');

    expect(t.rows.find((row) => row.clientId === 'c1')).toMatchObject({ pending: false, failed: true });
    expect(t.rows.find((row) => row.clientId === 'c2')).toMatchObject({ pending: true, failed: false });
  });

  it('ignores a failure report for a message that is not in the window', () => {
    const t = appendOptimistic(emptyTimeline(), mine({ clientId: 'c1' }));
    expect(markSendFailed(t, 'nope')).toBe(t);
  });
});

describe('edits and delete-for-everyone', () => {
  it('rewrites the body and stamps the edit', () => {
    const t = applyEdit(merge(emptyTimeline(), [msg({ id: 'm1', body: 'typo' })]), 'm1', 'fixed', 900);
    expect(t.rows[0]).toMatchObject({ body: 'fixed', editedAt: 900 });
  });

  it('destroys content for everyone while keeping the placeholder row', () => {
    const source = merge(emptyTimeline(), [
      msg({ id: 'm1', body: 'secret', payload: { kept: true }, createdAt: 800 })
    ]);
    const t = applyDelete(source, 'm1', 1_000);

    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ body: '', payload: { deleted: true }, deletedAt: 1_000 });
  });
});

describe('pagination cursor', () => {
  it('walks older history from the oldest server row', () => {
    const t = merge(emptyTimeline(), [
      msg({ id: 'newer', createdAt: 200 }),
      msg({ id: 'older', createdAt: 100 })
    ]);
    expect(olderCursor(t)).toEqual({ createdAt: 100, id: 'older' });
  });

  it('refuses to page from an optimistic row that has no server id yet', () => {
    const t = appendOptimistic(emptyTimeline(), mine({ clientId: 'c1' }));
    expect(olderCursor(t)).toBeNull();
  });

  it('has no cursor for an empty window', () => {
    expect(olderCursor(emptyTimeline())).toBeNull();
  });
});

describe('immutability', () => {
  it('never edits the timeline a Realtime callback was handed', () => {
    const source = merge(emptyTimeline(), [msg({ id: 'm1', createdAt: 100, body: 'original' })]);
    const snapshot = source.rows[0];

    appendOptimistic(source, mine({ clientId: 'c9', createdAt: 50 }));
    merge(source, [msg({ id: 'm2', createdAt: 200 })]);
    applyEdit(source, 'm1', 'changed', 300);
    applyDelete(source, 'm1', 400);

    expect(source.rows).toHaveLength(1);
    expect(source.rows[0]).toBe(snapshot);
    expect(snapshot).toMatchObject({ id: 'm1', body: 'original', deletedAt: null });
  });
});
