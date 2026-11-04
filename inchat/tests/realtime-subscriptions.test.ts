import { describe, expect, it, vi } from 'vitest';

import { createSubscriptionManager, type Closable } from '@/lib/realtime/subscriptions';

function handle() {
  return { close: vi.fn((): void => {}) };
}

describe('one channel per key', () => {
  it('opens a socket the first time a conversation is claimed', () => {
    const manager = createSubscriptionManager();
    const open = vi.fn(handle);

    manager.retain('chat:c1', open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(manager.refs('chat:c1')).toBe(1);
  });

  it('joins the existing channel instead of subscribing twice', () => {
    // React StrictMode runs the effect twice on mount; a second subscribe would
    // deliver every message to the screen twice.
    const manager = createSubscriptionManager();
    const open = vi.fn(handle);

    manager.retain('chat:c1', open);
    manager.retain('chat:c1', open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(manager.refs('chat:c1')).toBe(2);
  });

  it('keeps separate conversations separate', () => {
    const manager = createSubscriptionManager();
    const a = manager.retain('chat:c1', handle);
    const b = manager.retain('chat:c2', handle);

    expect(manager.keys()).toEqual(['chat:c1', 'chat:c2']);
    a();
    expect(manager.keys()).toEqual(['chat:c2']);
    b();
    expect(manager.keys()).toEqual([]);
  });

  it('closes only when the last claimer leaves', () => {
    const manager = createSubscriptionManager();
    const socket = handle();
    const first = manager.retain('chat:c1', () => socket);
    const second = manager.retain('chat:c1', () => socket);

    first();
    expect(socket.close).not.toHaveBeenCalled();

    second();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(manager.refs('chat:c1')).toBe(0);
  });

  it('survives a cleanup that runs twice', () => {
    const manager = createSubscriptionManager();
    const other = manager.retain('chat:c1', handle);
    const socket = handle();
    const mine = manager.retain('chat:c1', () => socket);

    mine();
    mine();
    expect(socket.close).not.toHaveBeenCalled();
    expect(manager.refs('chat:c1')).toBe(1);

    other();
    expect(manager.keys()).toEqual([]);
  });

  it('reopens a channel claimed again after it closed', () => {
    const manager = createSubscriptionManager();
    const first = handle();
    const release = manager.retain('chat:c1', () => first);
    release();

    const second = handle();
    manager.retain('chat:c1', () => second);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(manager.refs('chat:c1')).toBe(1);
  });

  it('holds nothing when the socket could not be opened', () => {
    const manager = createSubscriptionManager();
    expect(() =>
      manager.retain('chat:c1', () => {
        throw new Error('socket refused');
      })
    ).toThrow('socket refused');
    expect(manager.keys()).toEqual([]);
  });
});

describe('teardown', () => {
  it('closes every channel on logout, whatever the refcount', () => {
    const manager = createSubscriptionManager();
    const a = handle();
    const b = handle();
    manager.retain('chat:c1', () => a);
    manager.retain('chat:c1', () => a);
    manager.retain('chat:c2', () => b);

    manager.closeAll();

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(manager.keys()).toEqual([]);
  });

  it('still forgets a channel whose close threw', () => {
    // A socket that is already gone cannot be closed twice, and the next login
    // must not be blocked by a key left behind.
    const manager = createSubscriptionManager();
    const broken: Closable = {
      close() {
        throw new Error('already closed');
      }
    };
    manager.retain('chat:c1', () => broken);

    manager.closeAll();
    expect(manager.keys()).toEqual([]);
  });

  it('releases a key whose close is asynchronous', () => {
    const manager = createSubscriptionManager();
    const closing: Closable = { close: () => Promise.resolve() };
    const release = manager.retain('chat:c1', () => closing);

    release();
    expect(manager.keys()).toEqual([]);
  });

  it('can drop a channel a component is still holding', () => {
    const manager = createSubscriptionManager();
    const socket = handle();
    manager.retain('chat:c1', () => socket);

    manager.release('chat:c1');
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(manager.refs('chat:c1')).toBe(0);
  });
});
