export type MessageKind =
  | 'text'
  | 'poll'
  | 'location'
  | 'contact'
  | 'event'
  | 'voice'
  | 'image'
  | 'video'
  | 'file';

export type Message = {
  /** Server id, or `local:<clientId>` while the send has not been acknowledged. */
  id: string;
  conversationId: string;
  senderId: string;
  /** Client-generated idempotency key. Survives a retry, so the server can prove two
   *  deliveries of the same send are one message. */
  clientId: string;
  kind: MessageKind;
  body: string;
  payload: Record<string, unknown>;
  /** Epoch milliseconds. */
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  pending: boolean;
  failed: boolean;
};

/**
 * A conversation window, sorted oldest to newest by (createdAt, id).
 *
 * Every operation returns a new timeline instead of editing in place: the chat
 * screen renders from this value, so mutation in a Realtime callback would show
 * a stale window and make the duplicate-message bug this module exists to
 * prevent impossible to reason about.
 */
export type Timeline = { rows: Message[] };

export function emptyTimeline(): Timeline {
  return { rows: [] };
}

const localId = (clientId: string) => `local:${clientId}`;

function sortKey(message: Message): string {
  return `${String(message.createdAt).padStart(14, '0')}:${message.id}`;
}

function compare(a: Message, b: Message): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function build(rows: Message[]): Timeline {
  return { rows: [...rows].sort(compare) };
}

/** True when a row for that idempotency key is already in the window. */
export function hasClientId(timeline: Timeline, clientId: string, senderId: string): boolean {
  return timeline.rows.some((row) => row.clientId === clientId && row.senderId === senderId);
}

export function appendOptimistic(timeline: Timeline, message: Message): Timeline {
  if (hasClientId(timeline, message.clientId, message.senderId)) return timeline;
  return build([...timeline.rows, { ...message, id: localId(message.clientId), pending: true }]);
}

/**
 * Fold server rows in, keeping the local copy only while nothing from the server
 * carries the same idempotency key. This is what stops a message appearing twice
 * when both the send response and the Realtime echo deliver it.
 */
export function merge(timeline: Timeline, incoming: Message[]): Timeline {
  const byIdentity = new Map<string, Message>();
  const byClientId = new Map<string, string>();

  for (const row of timeline.rows) {
    byIdentity.set(row.id, row);
    byClientId.set(`${row.senderId}|${row.clientId}`, row.id);
  }

  for (const row of incoming) {
    const token = `${row.senderId}|${row.clientId}`;
    const existing = byIdentity.get(row.id);

    if (existing) {
      // A server row always wins over whatever was in the window for that id:
      // it is the copy the rest of the members see.
      byIdentity.set(row.id, row);
      const pending = byClientId.get(token);
      if (pending && pending !== row.id) byIdentity.delete(pending);
      byClientId.set(token, row.id);
      continue;
    }

    const pending = byClientId.get(token);
    if (pending && pending !== row.id) byIdentity.delete(pending);
    byIdentity.set(row.id, row);
    byClientId.set(token, row.id);
  }

  return build([...byIdentity.values()]);
}

/** Replace the optimistic copy with the acknowledged row from send_message(). */
export function confirmSend(
  timeline: Timeline,
  ack: { clientId: string; senderId: string; id: string; createdAt: number },
): Timeline {
  const pending = timeline.rows.find((row) => row.clientId === ack.clientId && row.pending);
  const confirmed: Message = {
    ...(pending ?? ({} as Message)),
    id: ack.id,
    conversationId: pending?.conversationId ?? '',
    senderId: ack.senderId,
    clientId: ack.clientId,
    kind: pending?.kind ?? 'text',
    body: pending?.body ?? '',
    payload: pending?.payload ?? {},
    createdAt: ack.createdAt,
    editedAt: null,
    deletedAt: null,
    pending: false,
    failed: false
  };
  return merge(timeline, [confirmed]);
}

export function markSendFailed(timeline: Timeline, clientId: string): Timeline {
  let touched = false;
  const rows = timeline.rows.map((row) => {
    if (row.clientId !== clientId || !row.pending) return row;
    touched = true;
    return { ...row, pending: false, failed: true };
  });
  return touched ? build(rows) : timeline;
}

export function applyEdit(timeline: Timeline, id: string, body: string, editedAt: number): Timeline {
  return build(
    timeline.rows.map((row) => (row.id === id ? { ...row, body, editedAt } : row)),
  );
}

/**
 * Delete-for-everyone arrives as an update on the same row, so every client that
 * holds it must drop the content rather than the row: the placeholder is what
 * tells the other members that something was removed.
 */
export function applyDelete(timeline: Timeline, id: string, deletedAt: number): Timeline {
  return build(
    timeline.rows.map((row) =>
      row.id === id
        ? { ...row, body: '', payload: { deleted: true }, deletedAt, editedAt: null }
        : row,
    ),
  );
}

export function oldest(timeline: Timeline): Message | undefined {
  return timeline.rows[0];
}

/** Cursor for the next keyset page of older history. */
export function olderCursor(timeline: Timeline): { createdAt: number; id: string } | null {
  const first = oldest(timeline);
  if (!first || first.pending) return null;
  return { createdAt: first.createdAt, id: first.id };
}
