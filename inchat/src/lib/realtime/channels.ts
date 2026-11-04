import { toMessage, type MessageRow } from '@/lib/chat/repository';
import type { Receipt } from '@/lib/chat/receipts';
import type { Message } from '@/lib/chat/timeline';

/**
 * Supabase Realtime, reduced to the shapes this app uses: a message row, a
 * receipt row, and who is present.
 *
 * Declared structurally instead of importing the SDK types so the payload
 * parsing below can be driven by fixtures in a unit test: what arrives over the
 * wire is data, and the failure mode this guards is a broadcast shaped slightly
 * differently from what the component expected.
 */

export type ChangePayload = {
  eventType?: string;
  new?: unknown;
  old?: unknown;
};

export type ChannelLike = {
  on(
    event: 'postgres_changes',
    params: Record<string, unknown>,
    callback: (payload: ChangePayload) => void
  ): ChannelLike;
  on(event: 'presence', action: string, callback: (payload: unknown) => void): ChannelLike;
  track(state: Record<string, unknown>): unknown;
  untrack(): unknown;
  unsubscribe(): unknown;
  subscribe(callback?: (status: string) => void): ChannelLike;
};

export type SocketLike = {
  channel(name: string): ChannelLike;
};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * A broadcast row, or null when it is not a message this client can render.
 *
 * The `old` record of an UPDATE carries only the identity key, which is how a
 * delete-for-everyone and a receipt-only update arrive; anything without a
 * sender or a timestamp is not a complete row and is dropped rather than
 * half-applied to the window.
 */
export function asMessageRow(payload: ChangePayload | unknown): MessageRow | null {
  if (!payload || typeof payload !== 'object') return null;
  const change = payload as ChangePayload;
  const row = change.new;
  if (!row || typeof row !== 'object') return null;

  const value = row as Record<string, unknown>;
  const id = str(value.id);
  const conversationId = str(value.conversation_id);
  const senderId = str(value.sender_id);
  const clientId = str(value.client_id);
  const createdAt = str(value.created_at);
  const kind = str(value.kind);
  if (!id || !conversationId || !senderId || !clientId || !createdAt || !kind) return null;
  if (typeof value.body !== 'string') return null;

  const data = value.payload;
  return {
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    kind: kind as MessageRow['kind'],
    body: value.body,
    payload:
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
    client_id: clientId,
    created_at: createdAt,
    edited_at: str(value.edited_at),
    deleted_at: str(value.deleted_at),
    deleted_by: str(value.deleted_by)
  };
}

export function messageFromChange(payload: ChangePayload | unknown): Message | null {
  const row = asMessageRow(payload);
  return row ? toMessage(row) : null;
}

/**
 * The user ids announced as present on a channel.
 *
 * supabase-js hands `presence_state` a map keyed by socket id, and `join` /
 * `leave` a single presence object, so both shapes funnel through here. A
 * payload that matches neither yields nobody: a malformed presence frame must
 * not paint a stranger as typing.
 */
export function presenceUserIds(payload: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const userId = userIdIn(value);
    if (userId && !seen.has(userId)) {
      seen.add(userId);
      ids.push(userId);
    }
  };

  if (payload && typeof payload === 'object') {
    const frame = payload as Record<string, unknown>;
    const states = frame.states ?? frame.presences;
    if (states && typeof states === 'object') {
      for (const entry of Object.values(states as Record<string, unknown>)) {
        if (Array.isArray(entry)) entry.forEach(add);
        else if (entry && typeof entry === 'object') {
          const payloads = (entry as Record<string, unknown>).payloads;
          if (Array.isArray(payloads)) payloads.forEach(add);
          else add(entry);
        }
      }
    }
    add(frame.newPresence);
    add(frame.currentPresence);
  }
  return ids;
}

function userIdIn(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const direct = str(record.u) ?? str(record.userId);
  if (direct) return direct;
  if (Array.isArray(record.payloads)) {
    for (const inner of record.payloads) {
      const found = userIdIn(inner);
      if (found) return found;
    }
  }
  return null;
}

export const conversationChannelName = (conversationId: string) => `chat:${conversationId}`;

const RECEIPT_STATES = new Set(['delivered', 'read']);

/**
 * A receipt broadcast, or null when the frame is not one this client can apply.
 *
 * `recorded_at` is what makes "read at 14:02" honest rather than the moment the
 * tab happened to repaint, so a frame without a readable timestamp is dropped:
 * a tick shown at the wrong time is worse than no tick.
 */
export function receiptFromChange(payload: ChangePayload | unknown): Receipt | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = (payload as ChangePayload).new;
  if (!row || typeof row !== 'object') return null;

  const value = row as Record<string, unknown>;
  const messageId = str(value.message_id);
  const userId = str(value.user_id);
  const state = str(value.state);
  const recordedAt = str(value.recorded_at);
  if (!messageId || !userId || !recordedAt || !state) return null;
  if (!RECEIPT_STATES.has(state)) return null;

  const at = Date.parse(recordedAt);
  if (!Number.isFinite(at)) return null;

  return { messageId, userId, state: state as Receipt['state'], recordedAt: at };
}

export type PresenceEvent = 'state' | 'join' | 'leave';

export type ThreadChannelHandlers = {
  /** A message was inserted or updated in this conversation. */
  onMessage(message: Message): void;
  /** Somebody on this thread reported receiving or reading a message. */
  onReceipt(receipt: Receipt): void;
  /**
   * Presence traffic for this thread.
   *
   * `state` is the whole snapshot and arrives on (re)subscribe, so it replaces
   * what the client believed; `join` names whoever just started typing. There is
   * no reliable `leave` identity - the frame keys the socket, not the user - so
   * a stop is expected to age out through the heartbeat ttl instead.
   */
  onPresence(userIds: string[], event: PresenceEvent): void;
};

/**
 * Open the one channel a thread needs: message inserts and updates, receipt
 * inserts, and presence for typing.
 *
 * UPDATE and not DELETE is deliberate - delete-for-everyone clears the body on
 * the same row, so it reaches every client as an update carrying the
 * placeholder. Deletes only happen when a member leaves, and the row level
 * policy already hides those rows from the client that is left.
 *
 * The receipt listener cannot be filtered by conversation: a receipt row only
 * carries the message id, so the client drops the frames that are not about a
 * message it currently holds. The row level policy is what keeps the traffic
 * private; this filter is only about not painting ticks for another thread.
 */
export function openThreadChannel(
  socket: SocketLike,
  conversationId: string,
  handlers: ThreadChannelHandlers
): ChannelLike {
  const channel = socket.channel(conversationChannelName(conversationId));
  const scoped = (event: 'INSERT' | 'UPDATE') => ({
    event,
    schema: 'public',
    table: 'messages',
    filter: `conversation_id=eq.${conversationId}`
  });

  for (const event of ['INSERT', 'UPDATE'] as const) {
    channel.on('postgres_changes', scoped(event), (payload) => {
      const message = messageFromChange(payload);
      if (message) handlers.onMessage(message);
    });
  }

  const receiptScope = (event: 'INSERT' | 'UPDATE') => ({
    event,
    schema: 'public',
    table: 'message_receipts'
  });

  for (const event of ['INSERT', 'UPDATE'] as const) {
    channel.on('postgres_changes', receiptScope(event), (payload) => {
      const receipt = receiptFromChange(payload);
      if (receipt) handlers.onReceipt(receipt);
    });
  }

  channel.on('presence', 'state', (payload) => handlers.onPresence(presenceUserIds(payload), 'state'));
  channel.on('presence', 'join', (payload) => handlers.onPresence(presenceUserIds(payload), 'join'));
  channel.on('presence', 'leave', (payload) => handlers.onPresence(presenceUserIds(payload), 'leave'));

  channel.subscribe();
  return channel;
}

export function channelHandle(channel: ChannelLike): { close(): void } {
  return {
    close() {
      void channel.unsubscribe();
    }
  };
}
