import { describe, expect, it, vi } from 'vitest';

import {
  asMessageRow,
  channelHandle,
  conversationChannelName,
  messageFromChange,
  openThreadChannel,
  presenceUserIds,
  receiptFromChange,
  type ChannelLike,
  type SocketLike
} from '@/lib/realtime/channels';

import {
  active,
  count,
  emptyTyping,
  prune,
  signal,
  signalMany,
  stopped
} from '@/lib/realtime/typing';

const full = {
  id: 'm-1',
  conversation_id: 'c-1',
  sender_id: 'u-2',
  kind: 'text',
  body: 'hi',
  payload: { anything: 1 },
  client_id: 'k-1',
  created_at: '2026-11-03T10:00:00.000Z',
  edited_at: null,
  deleted_at: null,
  deleted_by: null
};

describe('broadcast rows', () => {
  it('accepts a complete message row', () => {
    expect(asMessageRow({ eventType: 'INSERT', new: full })).toMatchObject({
      id: 'm-1',
      conversation_id: 'c-1',
      body: 'hi'
    });
  });

  it('turns one into a timeline message', () => {
    const message = messageFromChange({ eventType: 'INSERT', new: full });
    expect(message).toMatchObject({
      id: 'm-1',
      senderId: 'u-2',
      clientId: 'k-1',
      createdAt: Date.parse(full.created_at),
      pending: false
    });
  });

  it('carries a delete-for-everyone update through as an update', () => {
    const message = messageFromChange({
      eventType: 'UPDATE',
      new: { ...full, body: '', deleted_at: '2026-11-03T10:30:00.000Z', payload: { deleted: true } }
    });
    expect(message).toMatchObject({ body: '', deletedAt: Date.parse('2026-11-03T10:30:00.000Z') });
  });

  it('drops the identity-only record of an update', () => {
    expect(asMessageRow({ eventType: 'UPDATE', old: { id: 'm-1' }, new: {} })).toBeNull();
    expect(messageFromChange({ eventType: 'UPDATE', new: { id: 'm-1' } })).toBeNull();
  });

  it('refuses anything that is not a row', () => {
    expect(asMessageRow(null)).toBeNull();
    expect(asMessageRow('a string')).toBeNull();
    expect(asMessageRow({})).toBeNull();
    expect(asMessageRow({ new: null })).toBeNull();
    expect(asMessageRow({ new: { ...full, sender_id: null } })).toBeNull();
    expect(asMessageRow({ new: { ...full, created_at: 1_700_000_000 } })).toBeNull();
  });

  it('reads a missing or hostile payload as an empty object', () => {
    expect(asMessageRow({ new: { ...full, payload: null } })?.payload).toEqual({});
    expect(asMessageRow({ new: { ...full, payload: [1, 2] } })?.payload).toEqual({});
    expect(asMessageRow({ new: { ...full, payload: 'x' } })?.payload).toEqual({});
  });
});

describe('receipt frames', () => {
  const read = {
    message_id: 'm-1',
    user_id: 'u-2',
    state: 'read',
    recorded_at: '2026-11-03T10:00:00.000Z'
  };

  it('reads a delivered or read receipt with its timestamp', () => {
    expect(receiptFromChange({ eventType: 'INSERT', new: read })).toEqual({
      messageId: 'm-1',
      userId: 'u-2',
      state: 'read',
      recordedAt: Date.parse(read.recorded_at)
    });
    expect(receiptFromChange({ eventType: 'INSERT', new: { ...read, state: 'delivered' } })?.state).toBe(
      'delivered'
    );
  });

  it('drops a receipt it cannot place in time', () => {
    expect(receiptFromChange({ new: { ...read, recorded_at: 'not a date' } })).toBeNull();
    expect(receiptFromChange({ new: { ...read, recorded_at: null } })).toBeNull();
  });

  it('ignores a state the schema does not allow', () => {
    expect(receiptFromChange({ new: { ...read, state: 'seen' } })).toBeNull();
  });

  it('ignores a frame with no row or a missing key', () => {
    expect(receiptFromChange(null)).toBeNull();
    expect(receiptFromChange({ eventType: 'DELETE', old: read })).toBeNull();
    expect(receiptFromChange({ new: { ...read, user_id: null } })).toBeNull();
    expect(receiptFromChange({ new: { ...read, message_id: null } })).toBeNull();
  });
});

describe('presence frames', () => {
  it('reads the snapshot map keyed by socket id', () => {
    const payload = {
      states: {
        'sock-1': { payloads: [{ u: 'u-2' }] },
        'sock-2': { payloads: [{ u: 'u-3' }, { u: 'u-3' }] }
      }
    };
    expect(presenceUserIds(payload)).toEqual(['u-2', 'u-3']);
  });

  it('reads a join and a leave frame', () => {
    expect(presenceUserIds({ key: 'sock-1', newPresence: { u: 'u-9' } })).toEqual(['u-9']);
    expect(presenceUserIds({ key: 'sock-1', currentPresence: { u: 'u-9' } })).toEqual(['u-9']);
  });

  it('never repeats a user who is present on two sockets', () => {
    const payload = {
      states: { a: { payloads: [{ u: 'u-2' }] }, b: { payloads: [{ u: 'u-2' }] } }
    };
    expect(presenceUserIds(payload)).toEqual(['u-2']);
  });

  it('says nobody for a frame it does not understand', () => {
    expect(presenceUserIds(null)).toEqual([]);
    expect(presenceUserIds(42)).toEqual([]);
    expect(presenceUserIds({ states: { a: { payloads: [{ typing: true }] } } })).toEqual([]);
    expect(presenceUserIds({ states: 'unexpected' })).toEqual([]);
  });
});

type Recorded = ChannelLike & {
  handlers: Array<{ event: string; params: unknown; callback: (payload: never) => void }>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
};

function fakeChannel(): Recorded {
  const handlers: Recorded['handlers'] = [];
  return {
    handlers,
    subscribe: vi.fn(function (this: Recorded) {
      return this;
    }),
    unsubscribe: vi.fn(),
    track: vi.fn(),
    untrack: vi.fn(),
    on(event: string, params: unknown, callback: (payload: never) => void) {
      handlers.push({ event, params, callback });
      return this as unknown as ChannelLike;
    }
  } as unknown as Recorded;
}

function fakeSocket(channel: Recorded): SocketLike {
  return { channel: () => channel as unknown as ChannelLike };
}

describe('the thread channel', () => {
  it('is named per conversation so two screens cannot share one key by accident', () => {
    expect(conversationChannelName('c-1')).toBe('chat:c-1');
    expect(conversationChannelName('c-1')).not.toBe(conversationChannelName('c-2'));
  });

  it('subscribes to inserts and updates of this conversation only', () => {
    const channel = fakeChannel();
    openThreadChannel(fakeSocket(channel), 'c-1', {
      onMessage: vi.fn(),
      onReceipt: vi.fn(),
      onPresence: vi.fn()
    });

    const changes = channel.handlers.filter((h) => h.event === 'postgres_changes');
    expect(changes).toHaveLength(4);

    const messageChanges = changes.filter((h) => (h.params as { table: string }).table === 'messages');
    expect(messageChanges.map((h) => (h.params as { event: string }).event)).toEqual([
      'INSERT',
      'UPDATE'
    ]);
    for (const change of messageChanges) {
      expect(change.params).toMatchObject({
        schema: 'public',
        filter: 'conversation_id=eq.c-1'
      });
    }
    expect(channel.subscribe).toHaveBeenCalledTimes(1);
  });

  it('listens for receipts without a conversation filter, because the row has none', () => {
    const channel = fakeChannel();
    openThreadChannel(fakeSocket(channel), 'c-1', {
      onMessage: vi.fn(),
      onReceipt: vi.fn(),
      onPresence: vi.fn()
    });

    const receiptChanges = channel.handlers
      .filter((h) => h.event === 'postgres_changes')
      .filter((h) => (h.params as { table: string }).table === 'message_receipts');

    expect(receiptChanges.map((h) => (h.params as { event: string }).event)).toEqual([
      'INSERT',
      'UPDATE'
    ]);
    for (const change of receiptChanges) {
      expect((change.params as { filter?: string }).filter).toBeUndefined();
    }
  });

  it('listens for presence in all three shapes', () => {
    const channel = fakeChannel();
    openThreadChannel(fakeSocket(channel), 'c-1', {
      onMessage: vi.fn(),
      onReceipt: vi.fn(),
      onPresence: vi.fn()
    });

    expect(channel.handlers.filter((h) => h.event === 'presence').map((h) => h.params)).toEqual([
      'state',
      'join',
      'leave'
    ]);
  });

  it('hands a complete row to the message handler and nothing else', () => {
    const onMessage = vi.fn();
    const channel = fakeChannel();
    openThreadChannel(fakeSocket(channel), 'c-1', {
      onMessage,
      onReceipt: vi.fn(),
      onPresence: vi.fn()
    });

    const insert = channel.handlers.find(
      (h) =>
        h.event === 'postgres_changes' &&
        (h.params as { event: string; table: string }).event === 'INSERT' &&
        (h.params as { table: string }).table === 'messages'
    );
    insert?.callback({ eventType: 'INSERT', new: full } as never);
    insert?.callback({ eventType: 'INSERT', new: { id: 'junk' } } as never);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toMatchObject({ id: 'm-1' });
  });

  it('hands a receipt row to the receipt handler', () => {
    const onReceipt = vi.fn();
    const channel = fakeChannel();
    openThreadChannel(fakeSocket(channel), 'c-1', {
      onMessage: vi.fn(),
      onReceipt,
      onPresence: vi.fn()
    });

    const insert = channel.handlers.find(
      (h) =>
        h.event === 'postgres_changes' &&
        (h.params as { table: string; event: string }).table === 'message_receipts' &&
        (h.params as { event: string }).event === 'INSERT'
    );
    insert?.callback({
      eventType: 'INSERT',
      new: { message_id: 'm-1', user_id: 'u-2', state: 'read', recorded_at: '2026-11-03T10:00:00.000Z' }
    } as never);
    insert?.callback({ eventType: 'INSERT', new: { message_id: 'm-1', user_id: 'u-2', state: 'archived' } } as never);

    expect(onReceipt).toHaveBeenCalledTimes(1);
    expect(onReceipt.mock.calls[0][0]).toEqual({
      messageId: 'm-1',
      userId: 'u-2',
      state: 'read',
      recordedAt: Date.parse('2026-11-03T10:00:00.000Z')
    });
  });

  it('labels the presence event so the caller knows a snapshot from a delta', () => {
    const onPresence = vi.fn();
    const channel = fakeChannel();
    openThreadChannel(fakeSocket(channel), 'c-1', {
      onMessage: vi.fn(),
      onReceipt: vi.fn(),
      onPresence
    });

    const state = channel.handlers.find((h) => h.event === 'presence' && h.params === 'state');
    state?.callback({ states: { a: { payloads: [{ u: 'u-2' }] } } } as never);

    expect(onPresence).toHaveBeenCalledWith(['u-2'], 'state');
  });

  it('closes by unsubscribing from the socket', () => {
    const channel = fakeChannel();
    openThreadChannel(fakeSocket(channel), 'c-1', {
      onMessage: vi.fn(),
      onReceipt: vi.fn(),
      onPresence: vi.fn()
    });

    channelHandle(channel).close();
    expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('typing heartbeats', () => {
  const t = 100_000;

  it('shows a peer for the ttl window and then not', () => {
    const state = signal(emptyTyping(), 'u-2', t);
    expect(active(state, t + 1_000, 6_000)).toEqual(['u-2']);
    expect(active(state, t + 6_000, 6_000)).toEqual([]);
  });

  it('never lists the viewer as typing with themselves', () => {
    const state = signalMany(emptyTyping(), ['me', 'u-2'], t);
    expect(active(state, t + 10, 6_000, 'me')).toEqual(['u-2']);
  });

  it('takes a second signal from the same peer in the same instant once', () => {
    const once = signal(emptyTyping(), 'u-2', t);
    expect(signal(once, 'u-2', t)).toBe(once);
  });

  it('drops a peer who said they stopped', () => {
    const state = stopped(signal(emptyTyping(), 'u-2', t), 'u-2');
    expect(active(state, t + 10)).toEqual([]);
  });

  it('is a no-op when a stop arrives for somebody who was not typing', () => {
    const state = signal(emptyTyping(), 'u-2', t);
    expect(stopped(state, 'nobody')).toBe(state);
  });

  it('forgets expired peers on a sweep, and reuses the state when there is nothing to forget', () => {
    let state = signalMany(emptyTyping(), ['u-2', 'u-3'], t);
    expect(prune(state, t + 1_000, 6_000)).toBe(state);

    state = prune(state, t + 6_000, 6_000);
    expect(count(state)).toBe(0);
    expect(state).not.toBe(emptyTyping());
  });

  it('lists the oldest signal first, so a crowded thread reads predictably', () => {
    let state = signal(emptyTyping(), 'first', t);
    state = signal(state, 'second', t + 500);
    expect(active(state, t + 600, 6_000)).toEqual(['first', 'second']);
  });
});
