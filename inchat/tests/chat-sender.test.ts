import { describe, expect, it, vi } from 'vitest';

import { count, dueEntries, emptyOutbox, enqueue } from '@/lib/chat/outbox';
import { drainQueue } from '@/lib/chat/sender';

const t = 2_000_000;

const entry = (clientId: string, conversationId = 'c-1') => ({
  clientId,
  conversationId,
  kind: 'text' as const,
  body: clientId
});

class Permanent extends Error {
  code = '22023';
}

describe('draining the queue', () => {
  it('sends each due entry once and empties the queue', async () => {
    let out = emptyOutbox();
    out = enqueue(out, entry('a'), t);
    out = enqueue(out, entry('b'), t);

    const send = vi.fn(async () => ({ id: 'srv', createdAt: t + 5 }));
    const after = await drainQueue(out, { now: () => t, send });

    expect(send).toHaveBeenCalledTimes(2);
    expect(count(after)).toBe(0);
  });

  it('acks in the order the sends were queued', async () => {
    let out = emptyOutbox();
    out = enqueue(out, entry('first'), t);
    out = enqueue(out, entry('second'), t);

    const acked: string[] = [];
    await drainQueue(out, {
      now: () => t,
      send: async (queued) => {
        if (queued.clientId === 'second') {
          // Nothing to wait for: the point is that the walk reaches this entry
          // only after the earlier send has been answered.
          await Promise.resolve();
        }
        acked.push(queued.clientId);
        return { id: queued.clientId, createdAt: t };
      }
    });

    expect(acked).toEqual(['first', 'second']);
  });

  it('leaves an entry that is not due yet for the next drain', async () => {
    let out = emptyOutbox();
    out = enqueue(out, entry('now'), t);
    out = enqueue(out, entry('later'), t + 1);

    const acked: string[] = [];
    out = await drainQueue(out, {
      now: () => t,
      send: async (queued) => {
        acked.push(queued.clientId);
        return { id: queued.clientId, createdAt: t };
      }
    });

    expect(acked).toEqual(['now']);
    expect(count(out)).toBe(1);

    out = await drainQueue(out, {
      now: () => t + 1,
      send: async (queued) => {
        acked.push(queued.clientId);
        return { id: queued.clientId, createdAt: t + 1 };
      }
    });

    expect(acked).toEqual(['now', 'later']);
    expect(count(out)).toBe(0);
  });

  it('tells the caller which server row belongs to which local message', async () => {
    const out = enqueue(emptyOutbox(), entry('a'), t);
    const onAck = vi.fn();

    await drainQueue(out, { now: () => t, send: async () => ({ id: 'srv-9', createdAt: t + 10 }), onAck });

    expect(onAck).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'a' }),
      { id: 'srv-9', createdAt: t + 10 }
    );
  });

  it('keeps a transient failure queued for another attempt', async () => {
    const out = enqueue(emptyOutbox(), entry('a'), t);
    const onDrop = vi.fn();

    const after = await drainQueue(out, {
      now: () => t,
      send: async () => {
        throw new Error('network down');
      },
      onDrop
    });

    expect(count(after)).toBe(1);
    expect(dueEntries(after, t + 1_000)).toHaveLength(1);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('gives a permanent failure back to the caller instead of retrying it', async () => {
    const out = enqueue(emptyOutbox(), entry('a'), t);
    const onDrop = vi.fn();
    const send = vi.fn(async () => {
      throw new Permanent('message is empty');
    });

    const after = await drainQueue(out, {
      now: () => t,
      send,
      classify: (error) => (error instanceof Permanent ? 'permanent' : 'transient'),
      onDrop
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(count(after)).toBe(0);
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'a', body: 'a' }));
  });

  it('does not send an entry that is not due yet', async () => {
    let out = enqueue(emptyOutbox(), entry('a'), t);
    out = await drainQueue(out, {
      now: () => t,
      send: async () => {
        throw new Error('network down');
      }
    });

    const send = vi.fn(async () => ({ id: 'srv', createdAt: t }));
    const later = await drainQueue(out, { now: () => t + 200, send });

    expect(send).not.toHaveBeenCalled();
    expect(count(later)).toBe(1);
  });

  it('releases a send that was claimed but never answered', async () => {
    // The request left and the tab died before the response: the entry is still
    // marked in flight, and nothing would ever send it again without recovery.
    let out = enqueue(emptyOutbox(), entry('a'), t);
    out = {
      entries: out.entries.map((row) => ({ ...row, inFlight: true, inFlightSince: t, attempts: 1 }))
    };

    expect(count(out)).toBe(1);
    const stalled = await drainQueue(out, { now: () => t + 1_000, send: vi.fn(async () => ({ id: 'x', createdAt: 0 })) });
    expect(count(stalled)).toBe(1);

    const send = vi.fn(async () => ({ id: 'srv', createdAt: t + 90_000 }));
    const after = await drainQueue(out, { now: () => t + 90_000, send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(count(after)).toBe(0);
  });

  it('sends entries from every conversation, not only the thread on screen', async () => {
    let out = emptyOutbox();
    out = enqueue(out, entry('a', 'c-1'), t);
    out = enqueue(out, entry('b', 'c-2'), t);

    const sent: string[] = [];
    const after = await drainQueue(out, {
      now: () => t,
      send: async (queued) => {
        sent.push(`${queued.conversationId}:${queued.clientId}`);
        return { id: 'srv', createdAt: t };
      }
    });

    expect(sent).toEqual(['c-1:a', 'c-2:b']);
    expect(count(after)).toBe(0);
  });

  it('hands nothing back when the queue was already empty', async () => {
    const send = vi.fn();
    const onDrop = vi.fn();
    const after = await drainQueue(emptyOutbox(), { now: () => t, send, onDrop });

    expect(send).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect(after.entries).toEqual([]);
  });
});
