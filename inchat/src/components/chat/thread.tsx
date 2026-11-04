'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { Composer } from '@/components/chat/composer';
import { MessageContent } from '@/components/chat/message-content';
import { Timestamp } from '@/components/chat/timestamp';
import { newClientId } from '@/lib/chat/client-id';
import { registrationOf, withLocalVote, type Draft } from '@/lib/chat/composer';
import {
  count as queueCount,
  enqueue,
  emptyOutbox,
  fromStorage,
  toStorage,
  type Outbox,
  type OutboxEntry
} from '@/lib/chat/outbox';
import { BUCKET } from '@/lib/chat/uploads';
import { ChatRpcFailure, createRepository } from '@/lib/chat/repository';
import {
  emptyReceipts,
  recordMany,
  summarize,
  unreadIds,
  type Receipt,
  type ReceiptBook
} from '@/lib/chat/receipts';
import { drainQueue } from '@/lib/chat/sender';
import {
  appendOptimistic,
  applyEdit,
  confirmSend,
  hasClientId,
  markSendFailed,
  merge,
  olderCursor,
  type Message,
  type Timeline
} from '@/lib/chat/timeline';
import { channelHandle, openThreadChannel } from '@/lib/realtime/channels';
import { createSubscriptionManager } from '@/lib/realtime/subscriptions';
import {
  active as activeTypers,
  emptyTyping,
  prune as pruneTyping,
  signalMany,
  type TypingState
} from '@/lib/realtime/typing';
import { createClient } from '@/lib/supabase/client';

const OUTBOX_KEY = 'inchat:outbox';
/** One page of history; the server caps a window at 100. */
export const THREAD_PAGE_SIZE = 50;
const TRACK_EVERY_MS = 3_000;
const TRACK_TTL_MS = 6_000;
/** Mute has no "forever" value in the row, so it is set far enough ahead that
 *  nobody will outlive it: clearing it is an explicit unmute. */
const MUTE_MS = 1000 * 60 * 60 * 24 * 365 * 10;
/** How long a media link is handed out for; long enough to watch a clip through. */
const SIGNED_URL_SECS = 300;
const THREAD_THEMES = {
  green: { label: 'Classic green', lightAccent: '#15803d', darkAccent: '#4ade80', lightSoft: '#dcfce7', darkSoft: '#0b3d22' },
  ocean: { label: 'Ocean blue', lightAccent: '#0369a1', darkAccent: '#38bdf8', lightSoft: '#e0f2fe', darkSoft: '#12324a' },
  violet: { label: 'Violet', lightAccent: '#6d28d9', darkAccent: '#a78bfa', lightSoft: '#ede9fe', darkSoft: '#2c2050' },
  rose: { label: 'Rose', lightAccent: '#be123c', darkAccent: '#fb7185', lightSoft: '#ffe4e6', darkSoft: '#4a202c' },
  amber: { label: 'Amber', lightAccent: '#92400e', darkAccent: '#fbbf24', lightSoft: '#fef3c7', darkSoft: '#493719' }
} as const;
type ThreadTheme = keyof typeof THREAD_THEMES;
function themeStorageKey(conversationId: string) {
  return `inchat:thread-theme:${conversationId}`;
}
function readThreadTheme(conversationId: string): ThreadTheme {
  try {
    const saved = window.localStorage.getItem(themeStorageKey(conversationId));
    if (saved && Object.hasOwn(THREAD_THEMES, saved)) return saved as ThreadTheme;
  } catch {
    // Fall back to the default when storage is blocked.
  }
  return 'green';
}
function subscribeThreadTheme(conversationId: string, onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === themeStorageKey(conversationId)) onChange();
  };
  const onLocalChange = (event: Event) => {
    if ((event as CustomEvent<string>).detail === conversationId) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('inchat:thread-theme', onLocalChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('inchat:thread-theme', onLocalChange);
  };
}
const readServerThreadTheme = (): ThreadTheme => 'green';

/** A rejection the server will give the same answer to forever. */
const PERMANENT_CODES = new Set(['22023', '42501', '28000', 'P0001']);

function classify(error: unknown): 'permanent' | 'transient' {
  if (!(error instanceof ChatRpcFailure)) return 'transient';
  // No code means the function itself refused the input, which a retry cannot fix.
  return error.code === undefined || PERMANENT_CODES.has(error.code) ? 'permanent' : 'transient';
}

function rowFromEntry(entry: OutboxEntry, conversationId: string, senderId: string): Message {
  return {
    id: `local:${entry.clientId}`,
    conversationId,
    senderId,
    clientId: entry.clientId,
    kind: entry.kind,
    body: entry.body,
    payload: entry.payload,
    createdAt: entry.firstQueuedAt,
    editedAt: null,
    deletedAt: null,
    pending: true,
    failed: false
  };
}

function requeueForRetry(outbox: Outbox, message: Message, conversationId: string): Outbox {
  return enqueue(
    outbox,
    {
      clientId: message.clientId,
      conversationId,
      kind: message.kind,
      body: message.body,
      payload: message.payload
    },
    Date.now()
  );
}

/**
 * The browser's connectivity, read as an external store rather than mirrored
 * into state: an event listener that calls setState on every online/offline
 * flip is exactly the shape React asks you to express with a subscription.
 */
function subscribeConnectivity(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

const readConnectivity = () => navigator.onLine;

/** A server render has no network stack to report; assume reachable. */
const readServerConnectivity = () => true;

export type ThreadProps = {
  conversationId: string;
  title: string;
  viewerId: string;
  initial: Message[];
  /**
   * Receipts already recorded for `initial`, so reopening a thread shows the
   * ticks the peer last reached instead of downgrading every row to "sent".
   */
  initialReceipts: Receipt[];
  /** Whether this member has the thread muted right now. */
  initiallyMuted: boolean;
};

export function Thread({
  conversationId,
  title,
  viewerId,
  initial,
  initialReceipts,
  initiallyMuted
}: ThreadProps) {
  const client = useMemo(() => createClient(), []);
  const repo = useMemo(() => createRepository(client), [client]);
  // Owned by this mount, so leaving the thread (or logging out) cannot leave a
  // socket behind that still receives this conversation's rows.
  const subscriptions = useMemo(() => createSubscriptionManager(), []);

  const [timeline, setTimeline] = useState<Timeline>(() => ({ rows: initial }));
  const [receipts, setReceipts] = useState<ReceiptBook>(() => recordMany(emptyReceipts(), initialReceipts));
  const [typers, setTypers] = useState<string[]>([]);
  const [queued, setQueued] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(initial.length >= THREAD_PAGE_SIZE);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [themeOverride, setThemeOverride] = useState<ThreadTheme | null>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [muted, setMuted] = useState(initiallyMuted);
  const [mutePending, setMutePending] = useState(false);

  const online = useSyncExternalStore(subscribeConnectivity, readConnectivity, readServerConnectivity);
  const storedTheme = useSyncExternalStore(
    useCallback((onChange) => subscribeThreadTheme(conversationId, onChange), [conversationId]),
    useCallback(() => readThreadTheme(conversationId), [conversationId]),
    readServerThreadTheme
  );
  const theme = themeOverride ?? storedTheme;

  function chooseTheme(next: ThreadTheme) {
    setThemeOverride(next);
    setThemeMenuOpen(false);
    try {
      window.localStorage.setItem(themeStorageKey(conversationId), next);
      window.dispatchEvent(new CustomEvent('inchat:thread-theme', { detail: conversationId }));
    } catch {
      // Keep the choice in memory for the current open conversation.
    }
  }

  const outboxRef = useRef<Outbox>(emptyOutbox());
  const drainingRef = useRef(false);
  const typingRef = useRef<TypingState>(emptyTyping());
  const channelRef = useRef<ReturnType<typeof openThreadChannel> | null>(null);
  const trackRef = useRef(0);
  const untrackTimerRef = useRef<number | null>(null);
  const deliveredRef = useRef<Set<string>>(new Set());
  const seenUpToRef = useRef<string | null>(null);
  const signedRef = useRef(new Map<string, { url: string; until: number }>());

  const saveQueue = useCallback((outbox: Outbox) => {
    outboxRef.current = outbox;
    setQueued(queueCount(outbox));
    try {
      window.localStorage.setItem(OUTBOX_KEY, toStorage(outbox));
    } catch {
      // Full or blocked storage must not lose the copy still in memory.
    }
  }, []);

  const flush = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      const after = await drainQueue(outboxRef.current, {
        now: () => Date.now(),
        classify,
        send: async (entry) => {
          const ack = await repo.sendMessage({
            conversationId: entry.conversationId,
            clientId: entry.clientId,
            body: entry.body,
            kind: entry.kind,
            payload: entry.payload
          });
          return { id: ack.id, createdAt: ack.createdAt };
        },
        onAck: (entry, ack) => {
          if (entry.conversationId !== conversationId) return;
          setTimeline((current) =>
            hasClientId(current, entry.clientId, viewerId)
              ? confirmSend(current, {
                  clientId: entry.clientId,
                  senderId: viewerId,
                  id: ack.id,
                  createdAt: ack.createdAt
                })
              : current
          );

          // The bytes got to Storage before the message did, so the attachment
          // row can only be filed now that the send has an id to point at. The
          // server ignores a second registration of the same path, which makes
          // this safe to leave to the acknowledgement even after a retry.
          const registration = registrationOf(entry.kind, entry.payload);
          if (registration) {
            void repo.registerAttachment(ack.id, registration).catch(() => {
              setNotice('That file was sent, but it is missing from this chat media list.');
            });
          }
        },
        onDrop: (entry) => {
          if (entry.conversationId !== conversationId) return;
          setTimeline((current) => markSendFailed(current, entry.clientId));
          setNotice('A message could not be sent. Tap retry on it.');
        }
      });
      saveQueue(after);
    } finally {
      drainingRef.current = false;
    }
  }, [conversationId, repo, saveQueue, viewerId]);

  const resync = useCallback(async () => {
    try {
      const latest = await repo.listMessages({ conversationId, limit: THREAD_PAGE_SIZE });
      setTimeline((current) => merge(current, latest));
    } catch {
      setNotice('Some messages may be missing. Load older messages to catch up.');
    }
  }, [conversationId, repo]);

  const reportDelivered = useCallback(async () => {
    const ids = [...deliveredRef.current];
    if (!ids.length) return;
    deliveredRef.current.clear();
    try {
      await repo.markDelivered(conversationId, ids);
    } catch {
      // Delivery is a courtesy: the read receipt still arrives, and a retry
      // here would only compete with the message traffic on a slow link.
    }
  }, [conversationId, repo]);

  useEffect(() => {
    const release = subscriptions.retain(`chat:${conversationId}`, () => {
      const channel = openThreadChannel(client, conversationId, {
        onMessage: (message) => {
          setTimeline((current) => merge(current, [message]));
          if (message.senderId !== viewerId) {
            deliveredRef.current.add(message.id);
            void reportDelivered();
          }
        },
        onReceipt: (receipt) => setReceipts((current) => recordMany(current, [receipt])),
        onPresence: (userIds, event) => {
          const now = Date.now();
          typingRef.current =
            event === 'state'
              ? signalMany(emptyTyping(), userIds, now)
              : signalMany(typingRef.current, userIds, now);
          setTypers(activeTypers(typingRef.current, now, undefined, viewerId));
        }
      });
      channelRef.current = channel;
      return channelHandle(channel);
    });

    return () => {
      channelRef.current = null;
      release();
    };
  }, [client, conversationId, reportDelivered, subscriptions, viewerId]);

  // Restore the queue this device still owes, then show and send the part that
  // belongs to this thread. It runs once, on mount, from storage rather than
  // from React state: localStorage is the queue's home, so the first paint of a
  // reload cannot know what is waiting until it is read back.
  const hydrate = useCallback(async () => {
    let restored = emptyOutbox();
    try {
      restored = fromStorage(window.localStorage.getItem(OUTBOX_KEY));
    } catch {
      restored = emptyOutbox();
    }
    saveQueue(restored);

    for (const entry of restored.entries) {
      if (entry.conversationId !== conversationId) continue;
      setTimeline((current) =>
        hasClientId(current, entry.clientId, viewerId)
          ? current
          : appendOptimistic(current, rowFromEntry(entry, conversationId, viewerId))
      );
    }
    if (restored.entries.length) await flush();
  }, [conversationId, flush, saveQueue, viewerId]);

  useEffect(() => {
    // The queue's home is localStorage, and the read that brings it back is
    // synchronous, so the folds below cannot wait behind an await the way the
    // reconnect path can. The documented alternative - a lazy useState
    // initializer - would make the first client render differ from the HTML the
    // server produced for the same thread.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const sweep = window.setInterval(() => {
      const now = Date.now();
      typingRef.current = pruneTyping(typingRef.current, now);
      setTypers(activeTypers(typingRef.current, now, undefined, viewerId));
    }, 2_000);
    return () => window.clearInterval(sweep);
  }, [viewerId]);

  // Coming back to the network is the moment the queue and the missed rows get
  // another chance; the store already shows the header the current state.
  const wasOnlineRef = useRef(true);
  useEffect(() => {
    const wasOnline = wasOnlineRef.current;
    wasOnlineRef.current = online;
    if (online && !wasOnline) {
      void resync();
      void flush();
    }
  }, [flush, online, resync]);

  // A thread opened in the background marks itself read once it is actually
  // looked at: that is what the badge, the ticks and the other member's view
  // all read from, so it must not happen before the user sees anything.
  useEffect(() => {
    if (document.visibilityState !== 'visible') return;

    const incoming = timeline.rows
      .filter((row) => row.senderId !== viewerId && !row.pending && row.deletedAt === null)
      .map((row) => row.id);
    if (!incoming.length) return;

    const newest = incoming[incoming.length - 1];
    if (newest === seenUpToRef.current) return;
    if (unreadIds(receipts, [newest], viewerId).length === 0) return;

    seenUpToRef.current = newest;
    void repo
      .markSeen(conversationId)
      .then((moved) => {
        if (!moved) return;
        const now = Date.now();
        setReceipts((current) =>
          recordMany(
            current,
            incoming.map((messageId) => ({
              messageId,
              userId: viewerId,
              state: 'read' as const,
              recordedAt: now
            }))
          )
        );
      })
      .catch(() => {
        seenUpToRef.current = null;
      });
  }, [conversationId, receipts, repo, timeline.rows, viewerId]);

  useEffect(() => {
    return () => {
      if (untrackTimerRef.current !== null) window.clearTimeout(untrackTimerRef.current);
    };
  }, []);

  function notifyTyping() {
    const channel = channelRef.current;
    if (!channel) return;

    const now = Date.now();
    if (now - trackRef.current > TRACK_EVERY_MS) {
      trackRef.current = now;
      channel.track({ u: viewerId });
    }
    if (untrackTimerRef.current !== null) window.clearTimeout(untrackTimerRef.current);
    untrackTimerRef.current = window.setTimeout(() => {
      channel.untrack();
      trackRef.current = 0;
      untrackTimerRef.current = null;
    }, TRACK_TTL_MS);
  }

  function submit(ready: Draft) {
    const clientId = newClientId();
    const now = Date.now();

    setTimeline((current) =>
      appendOptimistic(current, {
        id: `local:${clientId}`,
        conversationId,
        senderId: viewerId,
        clientId,
        kind: ready.kind,
        body: ready.body,
        payload: ready.payload,
        createdAt: now,
        editedAt: null,
        deletedAt: null,
        pending: true,
        failed: false
      })
    );
    saveQueue(
      enqueue(
        outboxRef.current,
        { clientId, conversationId, kind: ready.kind, body: ready.body, payload: ready.payload },
        now
      )
    );
    void flush();
  }

  /**
   * A vote, painted from the payload the tap produced.
   *
   * The row the server broadcasts carries the same map, so the early paint and
   * the real one agree; a refusal pulls the thread back instead of leaving a
   * tally nobody else can see.
   */
  async function vote(messageId: string, choice: number) {
    setTimeline((current) => ({
      rows: current.rows.map((row) =>
        row.id === messageId ? { ...row, payload: withLocalVote(row.payload, viewerId, choice) } : row
      )
    }));

    try {
      const counted = await repo.voteInPoll(messageId, choice);
      if (!counted) {
        setNotice('That poll is closed.');
        void resync();
      }
    } catch {
      setNotice('The vote did not reach the server.');
      void resync();
    }
  }

  /**
   * A download link for one object, good for a few minutes.
   *
   * The bucket is private, so the bubble shows a path and asks for a link when
   * it is looked at. Signed urls are cached against that path, which is what
   * keeps a thread of two hundred photos from making two hundred requests as it
   * scrolls.
   */
  const resolveUrl = useCallback(
    async (path: string): Promise<string | null> => {
      const now = Date.now();
      const cached = signedRef.current.get(path);
      if (cached && cached.until > now) return cached.url;

      const signed = await client.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECS);
      if (signed.error || !signed.data?.signedUrl) return null;

      signedRef.current.set(path, {
        url: signed.data.signedUrl,
        // A link asked for at the very end of its life would break the first
        // tap that came after it.
        until: now + (SIGNED_URL_SECS - 30) * 1000
      });
      return signed.data.signedUrl;
    },
    [client]
  );

  // async so the drain it starts is awaited instead of racing the render that
  // asked for it; the caller only ever fires it from a click.
  const retry = useCallback(
    async (message: Message) => {
      if (!outboxRef.current.entries.some((row) => row.clientId === message.clientId)) {
        saveQueue(requeueForRetry(outboxRef.current, message, conversationId));
      }
      setTimeline((current) => appendOptimistic(current, { ...message, pending: true, failed: false }));
      await flush();
    },
    [conversationId, flush, saveQueue]
  );

  async function submitEdit() {
    if (!editing) return;
    const { id, body: value } = editing;
    const body = value.trim();
    setEditing(null);
    if (!body) return;

    setTimeline((current) => applyEdit(current, id, body, Date.now()));
    try {
      await repo.editMessage(id, body);
    } catch {
      setNotice('That edit did not reach the server.');
      void resync();
    }
  }

  async function removeForEveryone(id: string) {
    try {
      const removed = await repo.deleteForEveryone(id);
      // The server clears the body on the row, so every client sees the same
      // placeholder through the UPDATE broadcast; nothing to fold locally.
      if (!removed) setNotice('Only your own message, within 24 hours, can be removed for everyone.');
    } catch {
      setNotice('That message could not be removed.');
    }
  }

  async function toggleMute() {
    if (mutePending) return;
    setMutePending(true);
    const next = !muted;
    try {
      const changed = await repo.setMute(conversationId, next ? Date.now() + MUTE_MS : null);
      if (changed) {
        setMuted(next);
      } else {
        setNotice('You are not a member of this chat, so it cannot be muted.');
      }
    } catch {
      setNotice('The mute setting did not reach the server.');
    } finally {
      setMutePending(false);
    }
  }

  async function loadOlder() {
    const cursor = olderCursor(timeline);
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await repo.listMessages({ conversationId, before: cursor, limit: THREAD_PAGE_SIZE });
      setTimeline((current) => merge(current, older));
      setHasOlder(older.length >= THREAD_PAGE_SIZE);
    } catch {
      setNotice('Older messages could not be loaded.');
    } finally {
      setLoadingOlder(false);
    }
  }

  const typing = typers.length > 0;
  const selectedTheme = THREAD_THEMES[theme];

  return (
    <section
      className="chat-thread grid gap-3"
      aria-label={title}
      style={
        {
          '--chat-theme-accent-light': selectedTheme.lightAccent,
          '--chat-theme-accent-dark': selectedTheme.darkAccent,
          '--chat-theme-soft-light': selectedTheme.lightSoft,
          '--chat-theme-soft-dark': selectedTheme.darkSoft
        } as CSSProperties
      }
    >
      <header className="panel flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          <p className="text-xs text-[var(--text-dim)]" aria-live="polite">
            {typing
              ? 'typing…'
              : !online
                ? 'Offline — new messages will queue'
                : muted
                  ? 'Muted'
                  : 'Connected'}
          </p>
        </div>
        {queued > 0 ? (
          <span className="notice" role="status">
            {queued} waiting to send
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost !px-3 !py-2 text-xs"
          onClick={toggleMute}
          disabled={mutePending}
          aria-pressed={muted}
        >
          {mutePending ? 'Saving…' : muted ? 'Unmute' : 'Mute'}
        </button>
        <div className="relative">
          <button
            type="button"
            className="btn btn-ghost !grid !h-9 !w-9 !place-items-center !p-0"
            aria-label="Chat options"
            aria-haspopup="menu"
            aria-expanded={themeMenuOpen}
            onClick={() => setThemeMenuOpen((open) => !open)}
          >
            <span aria-hidden="true" className="text-xl leading-none">⋮</span>
          </button>
          {themeMenuOpen ? (
            <div
              className="chat-theme-menu panel absolute right-0 top-[calc(100%_+_8px)] z-30 grid min-w-52 gap-1 p-2 shadow-lg"
              role="menu"
              aria-label="Chat appearance"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setThemeMenuOpen(false);
              }}
            >
              <p className="px-2 pb-1 pt-1 text-xs font-semibold text-[var(--text-dim)]">Chat theme</p>
              {(Object.entries(THREAD_THEMES) as Array<[ThreadTheme, (typeof THREAD_THEMES)[ThreadTheme]]>).map(([id, option]) => (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={theme === id}
                  className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--surface-raised)]"
                  onClick={() => chooseTheme(id)}
                >
                  <span className="h-3 w-3 rounded-full" style={{ background: option.darkAccent }} aria-hidden="true" />
                  <span className="flex-1">{option.label}</span>
                  {theme === id ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
              <p className="px-2 pb-1 pt-1 text-[11px] text-[var(--text-dim)]">Saved for this chat only</p>
            </div>
          ) : null}
        </div>
      </header>

      {notice ? (
        <p className="notice notice-error" role="alert">
          {notice}
        </p>
      ) : null}

      <div className="panel grid gap-2 p-3" role="log" aria-live="polite" aria-label="Messages">
        {hasOlder ? (
          <button type="button" className="btn btn-ghost self-center text-xs" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? 'Loading…' : 'Load older messages'}
          </button>
        ) : null}

        {timeline.rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-[var(--text-dim)]">
            Nothing here yet. Write the first message.
          </p>
        ) : null}

        <ul className="grid gap-2">
          {timeline.rows.map((message) => (
            <Bubble
              key={message.id}
              message={message}
              viewerId={viewerId}
              conversationId={conversationId}
              receipts={receipts}
              resolveUrl={resolveUrl}
              onVote={(messageId, choice) => {
                void vote(messageId, choice);
              }}
              onEdit={() => setEditing({ id: message.id, body: message.body })}
              onRemove={() => removeForEveryone(message.id)}
              onRetry={() => {
                void retry(message);
              }}
            />
          ))}
        </ul>
      </div>

      {editing ? (
        <div className="panel grid gap-2 p-3">
          <label className="field">
            <span>Edit message</span>
            <textarea
              className="input"
              rows={2}
              value={editing.body}
              onChange={(event) => setEditing({ id: editing.id, body: event.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary text-sm" onClick={submitEdit}>
              Save
            </button>
            <button type="button" className="btn btn-ghost text-sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <Composer
          conversationId={conversationId}
          viewerId={viewerId}
          title={title}
          online={online}
          onSubmit={submit}
          onTyping={notifyTyping}
          onNotice={setNotice}
        />
      )}
    </section>
  );
}

function Bubble({
  message,
  viewerId,
  conversationId,
  receipts,
  resolveUrl,
  onVote,
  onEdit,
  onRemove,
  onRetry
}: {
  message: Message;
  viewerId: string;
  conversationId: string;
  receipts: ReceiptBook;
  resolveUrl: (path: string) => Promise<string | null>;
  onVote(messageId: string, choice: number): void;
  onEdit: () => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const mine = message.senderId === viewerId;
  const removed = message.deletedAt !== null;
  const summary = summarize(receipts, message.id, viewerId);

  return (
    <li className={`flex ${mine ? 'justify-end' : 'justify-start'}`} data-message-id={message.id}>
      <div
        className={`max-w-[85%] rounded-[var(--radius-sm)] border px-3 py-2 text-sm ${
          mine
            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
            : 'border-[var(--line)] bg-[var(--surface-raised)]'
        }`}
      >
        {removed ? (
          <p className="italic text-[var(--text-dim)]">This message was removed.</p>
        ) : (
          <MessageContent
            message={message}
            viewerId={viewerId}
            conversationId={conversationId}
            resolveUrl={resolveUrl}
            onVote={onVote}
          />
        )}

        <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-dim)]">
          <Timestamp epoch={message.createdAt} />
          {message.editedAt && !removed ? <span>edited</span> : null}
          {mine && !removed ? <Ticks message={message} summary={summary} /> : null}

          {mine && message.failed ? (
            <button type="button" className="underline" onClick={onRetry}>
              Retry
            </button>
          ) : null}
          {mine && !removed && message.kind === 'text' && !message.pending ? (
            <span className="flex gap-2">
              <button type="button" className="underline" onClick={onEdit}>
                Edit
              </button>
              <button type="button" className="underline" onClick={onRemove}>
                Remove
              </button>
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function Ticks({
  message,
  summary
}: {
  message: Message;
  summary: ReturnType<typeof summarize>;
}) {
  if (message.pending) return <span aria-label="sending">⏱</span>;
  if (message.failed) return <span aria-label="not sent">!</span>;
  if (summary.read > 0) return <span aria-label={`read by ${summary.read}`}>✓✓</span>;
  if (summary.delivered > 0) return <span aria-label={`delivered to ${summary.delivered}`}>✓✓</span>;
  return <span aria-label="sent">✓</span>;
}
