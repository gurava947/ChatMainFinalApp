export type Closable = { close(): void | Promise<void> };

export type SubscriptionManager = {
  /** Claim a channel and return the function that gives it back. */
  retain(key: string, open: () => Closable): () => void;
  refs(key: string): number;
  keys(): string[];
  release(key: string): void;
  closeAll(): void;
};

/**
 * One live channel per key, however many components ask for it.
 *
 * React mounts an effect twice in development and a chat screen remounts on
 * every navigation, so an unguarded `subscribe()` in a component produces a
 * second socket for the same conversation: each incoming message is then
 * delivered twice and neither subscription is ever torn down. Reference
 * counting fixes both - the second caller joins the existing channel, and the
 * last one out closes it.
 */
export function createSubscriptionManager(): SubscriptionManager {
  const held = new Map<string, { handle: Closable; refs: number }>();

  const close = (key: string) => {
    const entry = held.get(key);
    if (!entry) return;
    held.delete(key);
    // The socket may already be gone (a reconnect dropped it, the page is
    // unloading). Teardown must still release the key, or the next mount of
    // this conversation joins a dead channel.
    try {
      void entry.handle.close();
    } catch {
      /* closed by someone else */
    }
  };

  return {
    retain(key, open) {
      const existing = held.get(key);
      if (existing) existing.refs += 1;
      else held.set(key, { handle: open(), refs: 1 });

      let given = false;
      return () => {
        // Idempotent: React calls a cleanup, then StrictMode may call it again
        // through a stale closure, and a double release would close a channel
        // another component is still using.
        if (given) return;
        given = true;

        const entry = held.get(key);
        if (!entry) return;
        entry.refs -= 1;
        if (entry.refs <= 0) close(key);
      };
    },

    refs(key) {
      return held.get(key)?.refs ?? 0;
    },

    keys() {
      return [...held.keys()];
    },

    release(key) {
      close(key);
    },

    closeAll() {
      for (const key of [...held.keys()]) close(key);
    }
  };
}

/**
 * The manager the whole document shares.
 *
 * Module-level on purpose: a per-component manager would forget the channels
 * the previous render opened, and those sockets would stay subscribed for the
 * life of the tab - holding another user's message traffic in memory after the
 * screen that asked for it is gone.
 */
let shared: SubscriptionManager | null = null;

export function sharedSubscriptions(): SubscriptionManager {
  if (!shared) shared = createSubscriptionManager();
  return shared;
}
