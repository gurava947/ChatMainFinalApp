import { describe, expect, it } from 'vitest';

import {
  emptyReceipts,
  forgetMessage,
  forgetMessages,
  record,
  recordMany,
  size,
  stateOf,
  summarize,
  unreadIds,
  type Receipt
} from '@/lib/chat/receipts';

const M = 'm1';

function receipt(over: Partial<Receipt> = {}): Receipt {
  return { messageId: M, userId: 'u1', state: 'delivered', recordedAt: 1_000, ...over };
}

describe('monotonic state', () => {
  it('advances delivered to read', () => {
    const book = record(record(emptyReceipts(), receipt()), receipt({ state: 'read', recordedAt: 2_000 }));
    expect(stateOf(book, M, 'u1')).toBe('read');
  });

  it('never downgrades a read that arrives before its delivered', () => {
    // Realtime delivers these two rows independently and can lose the order.
    const book = record(
      record(emptyReceipts(), receipt({ state: 'read', recordedAt: 2_000 })),
      receipt({ state: 'delivered', recordedAt: 3_000 })
    );
    expect(stateOf(book, M, 'u1')).toBe('read');
  });

  it('keeps the first timestamp when the same state is replayed', () => {
    const book = recordMany(emptyReceipts(), [
      receipt({ state: 'read', recordedAt: 2_000 }),
      receipt({ state: 'read', recordedAt: 9_000 })
    ]);
    expect(summarize(book, M, 'sender').lastReadAt).toBe(2_000);
  });

  it('knows one user per message, whatever the traffic', () => {
    const book = recordMany(emptyReceipts(), [
      receipt(),
      receipt({ state: 'read' }),
      receipt({ state: 'delivered' }),
      receipt({ state: 'read', recordedAt: 5_000 })
    ]);
    expect(size(book)).toBe(1);
    expect(summarize(book, M, 'sender').read).toBe(1);
  });

  it('has no state for a stranger', () => {
    expect(stateOf(emptyReceipts(), M, 'nobody')).toBeNull();
  });
});

describe('summary for one message', () => {
  const book = recordMany(emptyReceipts(), [
    receipt({ userId: 'u1', state: 'read', recordedAt: 1_000 }),
    receipt({ userId: 'u2', state: 'read', recordedAt: 3_000 }),
    receipt({ userId: 'u3', state: 'delivered', recordedAt: 2_000 })
  ]);

  it('counts everyone but the viewer', () => {
    const asSender = summarize(book, M, 'me');
    expect(asSender).toMatchObject({ delivered: 3, read: 2, viewerState: null });

    const asU1 = summarize(book, M, 'u1');
    expect(asU1).toMatchObject({ delivered: 2, read: 1 });
  });

  it('reports the viewer own state separately, for the ticks on a received message', () => {
    expect(summarize(book, M, 'u3').viewerState).toBe('delivered');
    expect(summarize(book, M, 'u2').viewerState).toBe('read');
  });

  it('lists who read it, newest first, and the latest read time', () => {
    const summary = summarize(book, M, 'me');
    expect(summary.readBy).toEqual(['u2', 'u1']);
    expect(summary.lastReadAt).toBe(3_000);
  });

  it('is empty for a message nobody has reported', () => {
    expect(summarize(emptyReceipts(), 'unknown', 'me')).toEqual({
      delivered: 0,
      read: 0,
      viewerState: null,
      lastReadAt: null,
      readBy: []
    });
  });
});

describe('batched read reporting', () => {
  it('collects only the messages the viewer has not yet marked read', () => {
    const book = record(emptyReceipts(), receipt({ messageId: 'a', userId: 'me', state: 'read' }));
    expect(unreadIds(book, ['a', 'b', 'c'], 'me')).toEqual(['b', 'c']);
  });

  it('re-asks for a delivered row, because delivered is not read', () => {
    const book = record(emptyReceipts(), receipt({ messageId: 'a', userId: 'me' }));
    expect(unreadIds(book, ['a'], 'me')).toEqual(['a']);
  });

  it('returns nothing once the whole window is read', () => {
    const book = recordMany(emptyReceipts(), [
      receipt({ messageId: 'a', userId: 'me', state: 'read' }),
      receipt({ messageId: 'b', userId: 'me', state: 'read' })
    ]);
    expect(unreadIds(book, ['a', 'b'], 'me')).toEqual([]);
  });
});

describe('releasing history', () => {
  it('drops a message that left the window', () => {
    const book = recordMany(emptyReceipts(), [receipt({ messageId: 'a' }), receipt({ messageId: 'b' })]);
    const after = forgetMessage(book, 'a');

    expect(size(after)).toBe(1);
    expect(stateOf(after, 'a', 'u1')).toBeNull();
  });

  it('hands back the same book when there was nothing to drop', () => {
    const book = record(emptyReceipts(), receipt());
    expect(forgetMessage(book, 'gone')).toBe(book);
  });

  it('clears a whole page at once', () => {
    let book = emptyReceipts();
    for (const id of ['a', 'b', 'c', 'd']) book = record(book, receipt({ messageId: id }));

    book = forgetMessages(book, ['a', 'c']);
    expect(size(book)).toBe(2);
    expect(stateOf(book, 'b', 'u1')).toBe('delivered');
  });
});

describe('immutability', () => {
  it('never mutates the book a Realtime callback holds', () => {
    const before = record(emptyReceipts(), receipt({ userId: 'u1' }));
    const snapshot = before.byMessage.get(M)?.get('u1');

    record(before, receipt({ userId: 'u2', state: 'read' }));
    forgetMessage(before, M);

    expect(before.byMessage.get(M)?.get('u2')).toBeUndefined();
    expect(before.byMessage.get(M)?.get('u1')).toBe(snapshot);
    expect(size(before)).toBe(1);
  });
});
