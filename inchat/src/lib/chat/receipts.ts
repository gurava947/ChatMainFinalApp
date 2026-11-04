export type ReceiptState = 'delivered' | 'read';

export type Receipt = {
  messageId: string;
  userId: string;
  state: ReceiptState;
  /** Epoch milliseconds of the transition into `state`. */
  recordedAt: number;
};

/**
 * Receipts for the messages currently on screen, keyed message then member.
 *
 * Realtime delivers these as separate rows, out of order and more than once: a
 * peer's phone can report "read" before its "delivered" arrives. Keeping one
 * entry per (message, user) and refusing to move backwards is what stops the
 * ticks in the UI from flashing blue and then back to grey, which is the
 * "inconsistent receipts" failure this module exists to prevent.
 */
export type ReceiptBook = { byMessage: Map<string, Map<string, Receipt>> };

const rank: Record<ReceiptState, number> = { delivered: 1, read: 2 };

export function emptyReceipts(): ReceiptBook {
  return { byMessage: new Map() };
}

/**
 * Add one receipt, advancing at most one step.
 *
 * A same-state repeat is ignored and keeps the original timestamp, so the
 * "read 14:02" line does not slide forward every time the row is re-broadcast.
 */
export function record(book: ReceiptBook, receipt: Receipt): ReceiptBook {
  const current = book.byMessage.get(receipt.messageId)?.get(receipt.userId);
  if (current && rank[current.state] >= rank[receipt.state]) return book;

  const readers = new Map(book.byMessage.get(receipt.messageId));
  readers.set(receipt.userId, receipt);

  const byMessage = new Map(book.byMessage);
  byMessage.set(receipt.messageId, readers);
  return { byMessage };
}

export function recordMany(book: ReceiptBook, receipts: Receipt[]): ReceiptBook {
  return receipts.reduce((acc, receipt) => record(acc, receipt), book);
}

export function stateOf(
  book: ReceiptBook,
  messageId: string,
  userId: string
): ReceiptState | null {
  return book.byMessage.get(messageId)?.get(userId)?.state ?? null;
}

export type Summary = {
  /** Members (other than the viewer) who reported the message at all. */
  delivered: number;
  /** Members (other than the viewer) whose furthest state is read. */
  read: number;
  /** The viewer's own state, used for the ticks on a received message. */
  viewerState: ReceiptState | null;
  lastReadAt: number | null;
  /** User ids that read this, newest first, for the detail sheet. */
  readBy: string[];
};

/**
 * Fold the receipts of one message into what the row needs to render.
 *
 * The viewer is excluded from the counters in both directions: their own
 * receipt must not make a message they sent look read-by-two, and it is
 * reported separately as `viewerState` for a message they received.
 */
export function summarize(book: ReceiptBook, messageId: string, viewerId: string): Summary {
  const readers = book.byMessage.get(messageId);
  if (!readers) {
    return { delivered: 0, read: 0, viewerState: null, lastReadAt: null, readBy: [] };
  }

  let delivered = 0;
  let read = 0;
  let lastReadAt: number | null = null;
  const readRows: Array<{ userId: string; recordedAt: number }> = [];
  let viewerState: ReceiptState | null = null;

  for (const [userId, receipt] of readers) {
    if (userId === viewerId) {
      viewerState = receipt.state;
      continue;
    }
    delivered += 1;
    if (receipt.state === 'read') {
      read += 1;
      readRows.push({ userId, recordedAt: receipt.recordedAt });
      lastReadAt = lastReadAt === null ? receipt.recordedAt : Math.max(lastReadAt, receipt.recordedAt);
    }
  }

  readRows.sort((a, b) => b.recordedAt - a.recordedAt);
  return {
    delivered,
    read,
    viewerState,
    lastReadAt,
    readBy: readRows.map((row) => row.userId)
  };
}

/**
 * Messages the viewer has seen but not yet reported.
 *
 * Drives the batched `mark_messages_seen` call: the client collects ids while
 * the thread is open and flushes once, instead of firing an RPC per row - which
 * matters most on a slow connection, where per-message writes queue behind the
 * messages themselves.
 */
export function unreadIds(book: ReceiptBook, messageIds: string[], viewerId: string): string[] {
  return messageIds.filter((id) => stateOf(book, id, viewerId) !== 'read');
}

/**
 * Release everything held for a message that left the window, and the whole
 * book when a thread is closed. Receipts grow with the history a user scrolls
 * through, so without this the map is a leak that survives switching chats.
 */
export function forgetMessage(book: ReceiptBook, messageId: string): ReceiptBook {
  if (!book.byMessage.has(messageId)) return book;
  const byMessage = new Map(book.byMessage);
  byMessage.delete(messageId);
  return { byMessage };
}

export function forgetMessages(book: ReceiptBook, messageIds: string[]): ReceiptBook {
  return messageIds.reduce((acc, id) => forgetMessage(acc, id), book);
}

export function size(book: ReceiptBook): number {
  return book.byMessage.size;
}
