import {
  claim,
  defaultOutboxConfig,
  dueEntries,
  recordFailure,
  recordSuccess,
  recoverStaleInFlight,
  type Outbox,
  type OutboxConfig,
  type OutboxEntry
} from './outbox';

export type DrainAck = { id: string; createdAt: number };

export type DrainDeps = {
  now: () => number;
  /** One attempt at the server. Rejects with whatever the transport reported. */
  send: (entry: OutboxEntry) => Promise<DrainAck>;
  /** Whether a failure can ever succeed on a later attempt. */
  classify?: (error: unknown) => 'permanent' | 'transient';
  onAck?: (entry: OutboxEntry, ack: DrainAck) => void;
  onDrop?: (entry: OutboxEntry) => void;
  config?: OutboxConfig;
};

/**
 * Send everything the queue owes, once each, and return what is left.
 *
 * This is the retry-and-acknowledgement loop, kept away from React so it can be
 * driven by a fake server. What matters and is asserted in tests: an entry is
 * claimed before it is sent, so one pass cannot fire it twice; a lost response
 * re-queues the same idempotency token rather than duplicating the message; and
 * a message the server will never accept is handed back to the caller instead of
 * retried until the battery dies.
 */
export async function drainQueue(outbox: Outbox, deps: DrainDeps): Promise<Outbox> {
  const config = deps.config ?? defaultOutboxConfig;
  let current = recoverStaleInFlight(outbox, deps.now(), config);

  for (const due of dueEntries(current, deps.now(), config)) {
    const claimed = claim(current, due.clientId, deps.now(), config);
    if (!claimed.entry) continue;
    current = claimed.outbox;

    const entry = claimed.entry;
    try {
      const ack = await deps.send(entry);
      current = recordSuccess(current, entry.clientId);
      deps.onAck?.(entry, ack);
    } catch (error) {
      const permanent = (deps.classify?.(error) ?? 'transient') === 'permanent';
      const failed = recordFailure(current, entry.clientId, deps.now(), { permanent }, config);
      current = failed.outbox;
      if (failed.dropped) deps.onDrop?.(entry);
    }
  }

  return current;
}
