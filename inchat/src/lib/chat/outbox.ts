import type { MessageKind } from './timeline';

/**
 * A send that has not reached the server yet.
 *
 * `attempts`/`nextAttemptAt` implement the retry schedule, `inFlightSince` marks
 * the entry as handed to a request so the queue cannot fire it twice, and
 * `firstQueuedAt` is the ordering key: a retried message goes out in the order
 * the user pressed send, never in the order the retries happened to succeed.
 */
export type OutboxEntry = {
  clientId: string;
  conversationId: string;
  kind: MessageKind;
  body: string;
  payload: Record<string, unknown>;
  attempts: number;
  firstQueuedAt: number;
  nextAttemptAt: number;
  inFlight: boolean;
  inFlightSince: number | null;
};

export type Outbox = { entries: OutboxEntry[] };

export type OutboxConfig = {
  /** Attempts after which an entry is dropped rather than retried again. */
  maxAttempts: number;
  /** First retry delay; doubles per attempt up to maxRetryDelayMs. */
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  /** An entry whose request never came back is released after this long. */
  inFlightTimeoutMs: number;
};

export const defaultOutboxConfig: OutboxConfig = {
  // Six attempts over roughly two minutes covers a 2G/3G reconnect or a
  // cold-start token refresh without letting a poison entry retry forever.
  maxAttempts: 6,
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 30_000,
  inFlightTimeoutMs: 45_000
};

export function emptyOutbox(): Outbox {
  return { entries: [] };
}

export type NewEntry = {
  clientId: string;
  conversationId: string;
  kind: MessageKind;
  body: string;
  payload?: Record<string, unknown>;
};

/**
 * Queue a send. Same clientId twice is one entry: this is the client half of the
 * idempotency contract, and it is what keeps a double tap or a restored
 * session from producing two messages.
 */
export function enqueue(outbox: Outbox, input: NewEntry, now: number): Outbox {
  if (outbox.entries.some((entry) => entry.clientId === input.clientId)) return outbox;

  const entry: OutboxEntry = {
    clientId: input.clientId,
    conversationId: input.conversationId,
    kind: input.kind,
    body: input.body,
    payload: input.payload ?? {},
    attempts: 0,
    firstQueuedAt: now,
    nextAttemptAt: now,
    inFlight: false,
    inFlightSince: null
  };
  return { entries: [...outbox.entries, entry] };
}

export function pending(outbox: Outbox): OutboxEntry[] {
  return [...outbox.entries].sort((a, b) => a.firstQueuedAt - b.firstQueuedAt);
}

export function count(outbox: Outbox): number {
  return outbox.entries.length;
}

/**
 * Entries the caller may send now, oldest first.
 *
 * Grouped per conversation and ordered inside the group so a batch of three
 * queued messages still arrives at the server in the order they were written.
 */
export function dueEntries(
  outbox: Outbox,
  now: number,
  config: OutboxConfig = defaultOutboxConfig
): OutboxEntry[] {
  return pending(outbox)
    .filter((entry) => !entry.inFlight)
    .filter((entry) => entry.attempts < config.maxAttempts)
    .filter((entry) => entry.nextAttemptAt <= now);
}

/**
 * Claim an entry for one attempt. Returns null when the entry is not claimable
 * (unknown id, already in flight, or not due yet) so a racing caller cannot
 * start a second request for the same send.
 */
export function claim(
  outbox: Outbox,
  clientId: string,
  now: number,
  config: OutboxConfig = defaultOutboxConfig
): { outbox: Outbox; entry: OutboxEntry | null } {
  const entry = outbox.entries.find((row) => row.clientId === clientId);
  if (!entry || entry.inFlight || entry.attempts >= config.maxAttempts) {
    return { outbox, entry: null };
  }

  const claimed: OutboxEntry = { ...entry, inFlight: true, inFlightSince: now };
  return {
    outbox: {
      entries: outbox.entries.map((row) => (row.clientId === clientId ? claimed : row))
    },
    entry: claimed
  };
}

/** The server stored it: the entry is gone, and the timeline gets the ack. */
export function recordSuccess(outbox: Outbox, clientId: string): Outbox {
  if (!outbox.entries.some((entry) => entry.clientId === clientId)) return outbox;
  return { entries: outbox.entries.filter((entry) => entry.clientId !== clientId) };
}

export type FailureResult = { outbox: Outbox; dropped: OutboxEntry | null };

/**
 * Report a failed attempt.
 *
 * `permanent` (rejected body, no longer a member, a token that will not
 * refresh) drops the entry on the spot: retrying those only burns data on a
 * metered connection and never succeeds. A transient failure backs off
 * exponentially, or honours `retryAfterMs` when the server named a delay.
 *
 * The return value names the entry that left the queue, if any. The caller must
 * still mark that message failed in the timeline: a send the queue gave up on
 * has to stay on screen so the user can tap retry, which re-enqueues it under
 * the same `client_id` and therefore cannot store it twice.
 */
export function recordFailure(
  outbox: Outbox,
  clientId: string,
  now: number,
  options: { retryAfterMs?: number; permanent?: boolean } = {},
  config: OutboxConfig = defaultOutboxConfig
): FailureResult {
  const entry = outbox.entries.find((row) => row.clientId === clientId);
  if (!entry) return { outbox, dropped: null };

  const attempts = entry.attempts + 1;
  const dropped: OutboxEntry = { ...entry, attempts, inFlight: false, inFlightSince: null };

  if (options.permanent || attempts >= config.maxAttempts) {
    return {
      outbox: { entries: outbox.entries.filter((row) => row.clientId !== clientId) },
      dropped
    };
  }

  const backoff = Math.min(
    config.baseRetryDelayMs * 2 ** (attempts - 1),
    config.maxRetryDelayMs
  );
  const delay = Math.max(0, options.retryAfterMs ?? backoff);

  const retried: OutboxEntry = {
    ...entry,
    attempts,
    inFlight: false,
    inFlightSince: null,
    nextAttemptAt: now + delay
  };
  return {
    outbox: {
      entries: outbox.entries.map((row) => (row.clientId === clientId ? retried : row))
    },
    dropped: null
  };
}

/**
 * Release entries whose request never returned - a tab closed mid-send, a
 * network that dropped the response, a crashed worker. Without this the entry
 * stays in flight forever and the message is silently lost.
 */
export function recoverStaleInFlight(
  outbox: Outbox,
  now: number,
  config: OutboxConfig = defaultOutboxConfig
): Outbox {
  let touched = false;
  const entries = outbox.entries.map((entry) => {
    if (!entry.inFlight) return entry;
    if (entry.inFlightSince === null || now - entry.inFlightSince < config.inFlightTimeoutMs) {
      return entry;
    }
    touched = true;
    return { ...entry, inFlight: false, inFlightSince: null, nextAttemptAt: now };
  });
  return touched ? { entries } : outbox;
}

/** Drop a queued send the user cancelled or whose optimistic copy was removed. */
export function cancel(outbox: Outbox, clientId: string): Outbox {
  if (!outbox.entries.some((entry) => entry.clientId === clientId)) return outbox;
  return { entries: outbox.entries.filter((entry) => entry.clientId !== clientId) };
}

/** Everything still owed, for the "3 messages waiting for network" banner. */
export function hasWork(outbox: Outbox): boolean {
  return outbox.entries.length > 0;
}

export function toStorage(outbox: Outbox): string {
  return JSON.stringify({ v: 1, entries: outbox.entries });
}

/**
 * Restore a persisted queue.
 *
 * localStorage is user-editable and survives a schema change, so anything that
 * does not match is skipped rather than trusted: a malformed entry must not
 * take the whole restored queue, or the app, down. In-flight marks are cleared
 * because the request that set them died with the previous page.
 */
export function fromStorage(raw: string | null | undefined): Outbox {
  if (!raw) return emptyOutbox();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyOutbox();
  }

  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return emptyOutbox();

  const restored: OutboxEntry[] = [];
  for (const value of entries) {
    const entry = parseEntry(value);
    if (entry && !restored.some((row) => row.clientId === entry.clientId)) restored.push(entry);
  }
  return { entries: restored };
}

const KINDS: readonly MessageKind[] = [
  'text',
  'poll',
  'location',
  'contact',
  'event',
  'voice',
  'image',
  'video',
  'file'
];

function parseEntry(value: unknown): OutboxEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;

  const clientId = row.clientId;
  const conversationId = row.conversationId;
  const kind = row.kind;
  const body = row.body;
  if (typeof clientId !== 'string' || !clientId) return null;
  if (typeof conversationId !== 'string' || !conversationId) return null;
  if (typeof kind !== 'string' || !KINDS.includes(kind as MessageKind)) return null;
  if (typeof body !== 'string') return null;

  const payload = row.payload;
  if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
    return null;
  }

  const attempts = typeof row.attempts === 'number' ? Math.max(0, Math.floor(row.attempts)) : 0;
  const firstQueuedAt = typeof row.firstQueuedAt === 'number' ? row.firstQueuedAt : 0;
  const nextAttemptAt = typeof row.nextAttemptAt === 'number' ? row.nextAttemptAt : firstQueuedAt;

  return {
    clientId,
    conversationId,
    kind: kind as MessageKind,
    body,
    payload: (payload as Record<string, unknown> | undefined) ?? {},
    attempts,
    firstQueuedAt,
    nextAttemptAt,
    inFlight: false,
    inFlightSince: null
  };
}
