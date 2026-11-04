import { describe, expect, it } from 'vitest';

import {
  cancel,
  claim,
  count,
  dueEntries,
  emptyOutbox,
  enqueue,
  fromStorage,
  hasWork,
  pending,
  recordFailure,
  recordSuccess,
  recoverStaleInFlight,
  toStorage,
  type OutboxConfig
} from '@/lib/chat/outbox';

const t0 = 1_000_000;

function queued(clientId: string, over: Partial<{ body: string; conversationId: string }> = {}) {
  return {
    clientId,
    conversationId: over.conversationId ?? 'conv-1',
    kind: 'text' as const,
    body: over.body ?? clientId
  };
}

describe('enqueueing', () => {
  it('queues a send immediately', () => {
    const out = enqueue(emptyOutbox(), queued('c1'), t0);
    expect(count(out)).toBe(1);
    expect(dueEntries(out, t0)).toHaveLength(1);
  });

  it('keeps one entry when the same client id is queued twice', () => {
    const out = enqueue(enqueue(emptyOutbox(), queued('c1'), t0), queued('c1'), t0 + 1);
    expect(count(out)).toBe(1);
  });

  it('preserves the order the user pressed send', () => {
    let out = emptyOutbox();
    out = enqueue(out, queued('first'), t0);
    out = enqueue(out, queued('second'), t0 + 5);
    out = enqueue(out, queued('third'), t0 + 9);
    expect(pending(out).map((entry) => entry.clientId)).toEqual(['first', 'second', 'third']);
  });

  it('reports work for the offline banner', () => {
    expect(hasWork(emptyOutbox())).toBe(false);
    expect(hasWork(enqueue(emptyOutbox(), queued('c1'), t0))).toBe(true);
  });
});

describe('due selection', () => {
  const config: OutboxConfig = {
    maxAttempts: 3,
    baseRetryDelayMs: 1_000,
    maxRetryDelayMs: 8_000,
    inFlightTimeoutMs: 45_000
  };

  it('waits for the backoff instead of hammering a failing network', () => {
    let out = enqueue(emptyOutbox(), queued('c1'), t0);
    out = recordFailure(out, 'c1', t0, {}, config).outbox;

    expect(dueEntries(out, t0 + 500, config)).toHaveLength(0);
    expect(dueEntries(out, t0 + 1_000, config)).toHaveLength(1);
  });

  it('gives up on an entry that has used its attempts', () => {
    let out = enqueue(emptyOutbox(), queued('c1'), t0);
    let dropped = null;
    for (let i = 0; i < 3; i += 1) {
      const failed = recordFailure(out, 'c1', t0 + i * 10_000, {}, config);
      out = failed.outbox;
      dropped = failed.dropped;
    }

    expect(dropped).toMatchObject({ clientId: 'c1', attempts: 3 });
    expect(count(out)).toBe(0);
    expect(dueEntries(out, t0 + 100_000, config)).toHaveLength(0);
  });

  it('re-queues a given-up send under the same token when the user retries', () => {
    const failed = recordFailure(enqueue(emptyOutbox(), queued('c1'), t0), 'c1', t0, {}, {
      ...config,
      maxAttempts: 1
    });
    const retry = failed.dropped;
    if (!retry) throw new Error('the queue must hand the message back to the caller');

    const out = enqueue(failed.outbox, retry, t0 + 5_000);
    expect(out.entries[0]).toMatchObject({ clientId: 'c1', attempts: 0 });
    expect(dueEntries(out, t0 + 5_000, config)).toHaveLength(1);
  });

  it('orders retries behind everything queued earlier', () => {
    let out = emptyOutbox();
    out = enqueue(out, queued('old'), t0);
    out = enqueue(out, queued('new'), t0 + 1);
    out = recordFailure(out, 'old', t0 + 2, { retryAfterMs: 10 }, config).outbox;

    expect(dueEntries(out, t0 + 1_000, config).map((entry) => entry.clientId)).toEqual([
      'old',
      'new'
    ]);
  });
});

describe('claiming', () => {
  it('lets only one request represent a send', () => {
    const out = enqueue(emptyOutbox(), queued('c1'), t0);
    const first = claim(out, 'c1', t0);
    const second = claim(first.outbox, 'c1', t0);

    expect(first.entry).not.toBeNull();
    expect(second.entry).toBeNull();
    expect(dueEntries(first.outbox, t0 + 1)).toHaveLength(0);
  });

  it('refuses an unknown client id', () => {
    expect(claim(emptyOutbox(), 'nope', t0).entry).toBeNull();
  });
});

describe('results', () => {
  it('removes the entry once the server has stored it', () => {
    let out = enqueue(emptyOutbox(), queued('c1'), t0);
    out = claim(out, 'c1', t0).outbox;
    out = recordSuccess(out, 'c1');
    expect(hasWork(out)).toBe(false);
  });

  it('doubles the delay between attempts and caps it', () => {
    const capped: OutboxConfig = {
      maxAttempts: 10,
      baseRetryDelayMs: 1_000,
      maxRetryDelayMs: 4_000,
      inFlightTimeoutMs: 45_000
    };
    let out = enqueue(emptyOutbox(), queued('c1'), t0);
    const delays: number[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      out = recordFailure(out, 'c1', t0, {}, capped).outbox;
      delays.push(out.entries[0].nextAttemptAt - t0);
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(out.entries[0].attempts).toBe(4);
  });

  it('honours a delay the server named', () => {
    const out = enqueue(emptyOutbox(), queued('c1'), t0);
    const failed = recordFailure(out, 'c1', t0, { retryAfterMs: 20_000 });

    expect(failed.outbox.entries[0].nextAttemptAt).toBe(t0 + 20_000);
    expect(failed.dropped).toBeNull();
  });

  it('drops a message the server will always reject', () => {
    const out = enqueue(emptyOutbox(), queued('c1'), t0);
    const failed = recordFailure(out, 'c1', t0, { permanent: true });

    expect(count(failed.outbox)).toBe(0);
    expect(failed.dropped).toMatchObject({ clientId: 'c1', body: 'c1', attempts: 1 });
  });

  it('ignores a late failure for a send that already succeeded', () => {
    let out = enqueue(emptyOutbox(), queued('c1'), t0);
    out = claim(out, 'c1', t0).outbox;
    out = recordSuccess(out, 'c1');

    const late = recordFailure(out, 'c1', t0 + 1_000, {});
    expect(late.dropped).toBeNull();
    expect(late.outbox).toBe(out);
  });

  it('ignores a late success for an entry the queue gave up on', () => {
    const out = recordFailure(enqueue(emptyOutbox(), queued('c1'), t0), 'c1', t0, {
      permanent: true
    }).outbox;

    expect(recordSuccess(out, 'c1')).toBe(out);
    expect(hasWork(out)).toBe(false);
  });

  it('cancels a send the user removed', () => {
    const out = enqueue(emptyOutbox(), queued('c1'), t0);
    expect(count(cancel(out, 'c1'))).toBe(0);
    expect(cancel(out, 'other')).toBe(out);
  });
});

describe('crash recovery', () => {
  it('releases a send whose request never came back', () => {
    let out = enqueue(emptyOutbox(), queued('c1'), t0);
    out = claim(out, 'c1', t0).outbox;

    expect(dueEntries(out, t0 + 10_000)).toHaveLength(0);
    out = recoverStaleInFlight(out, t0 + 46_000);
    expect(dueEntries(out, t0 + 46_000)).toHaveLength(1);
    expect(out.entries[0].inFlight).toBe(false);
  });

  it('leaves a request that is still within its timeout alone', () => {
    let out = enqueue(emptyOutbox(), queued('c1'), t0);
    out = claim(out, 'c1', t0).outbox;
    expect(recoverStaleInFlight(out, t0 + 5_000)).toBe(out);
  });
});

describe('persistence', () => {
  it('round-trips a queue through storage', () => {
    let out = emptyOutbox();
    out = enqueue(out, queued('c1', { body: 'see you at 6' }), t0);
    out = enqueue(
      out,
      {
        clientId: 'c2',
        conversationId: 'conv-2',
        kind: 'poll',
        body: '',
        payload: { question: 'Ok?' }
      },
      t0 + 1
    );
    out = claim(out, 'c1', t0 + 2).outbox;

    const restored = fromStorage(toStorage(out));
    expect(count(restored)).toBe(2);
    expect(restored.entries.every((entry) => !entry.inFlight)).toBe(true);
    expect(restored.entries.find((e) => e.clientId === 'c2')?.payload).toEqual({ question: 'Ok?' });
  });

  it('skips rows it cannot trust instead of throwing at boot', () => {
    const raw = JSON.stringify({
      v: 1,
      entries: [
        { clientId: 'ok', conversationId: 'c', kind: 'text', body: 'fine' },
        { clientId: '', conversationId: 'c', kind: 'text', body: 'no id' },
        { clientId: 'k', conversationId: 'c', kind: 'screenshot', body: 'unknown kind' },
        { clientId: 'p', conversationId: 'c', kind: 'text', payload: 'not an object' },
        null,
        'a string',
        { clientId: 'dup', conversationId: 'c', kind: 'text', body: 'one' },
        { clientId: 'dup', conversationId: 'c', kind: 'text', body: 'two' }
      ]
    });

    const out = fromStorage(raw);
    expect(out.entries.map((entry) => entry.clientId)).toEqual(['ok', 'dup']);
  });

  it('starts empty when storage holds anything at all that is not a queue', () => {
    expect(count(fromStorage(null))).toBe(0);
    expect(count(fromStorage('not json'))).toBe(0);
    expect(count(fromStorage('{"entries":42}'))).toBe(0);
    expect(count(fromStorage('[1,2,3]'))).toBe(0);
  });
});
