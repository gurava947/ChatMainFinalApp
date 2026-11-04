/** @jest-environment jsdom */

'use strict';

const { join, loadClient, tick } = require('../helpers/client-env');

const readOutbox = () => JSON.parse(window.localStorage.getItem('chat:outbox') || '[]');
const bubbles = () => Array.from(document.querySelectorAll('#message-list .msg'));
const tickOf = (node) => node.querySelector('[data-role="ticks"]');

describe('offline outbox', () => {
  let api;

  beforeEach(async () => {
    api = loadClient();
    await join(api);
  });

  afterEach(() => {
    // Retries are timer-driven; leaving them armed would outlive the test.
    api.G().state.retries.forEach((timer) => clearTimeout(timer));
  });

  it('keeps a send made while offline and replays it under the same client id', () => {
    api.socket.instance.connected = false;
    const clientId = api.G().deliver({ text: 'queued while offline' });

    expect(clientId).toBeTruthy();
    expect(readOutbox()).toHaveLength(1);
    expect(readOutbox()[0].clientId).toBe(clientId);
    expect(tickOf(bubbles().pop()).dataset.state).toBe('queued');
    expect(api.socket.last('message')).toBeUndefined();

    api.socket.instance.connected = true;
    api.socket.fire('connect');

    const send = api.socket.last('message');
    expect(send.payload.clientId).toBe(clientId);
    expect(send.timeout).toBe(8000);
  });

  it('drops the entry and promotes the bubble once the server acknowledges', () => {
    const clientId = api.G().deliver({ text: 'hello' });
    expect(readOutbox()[0].clientId).toBe(clientId);

    api.socket.answer('message', { ok: true, id: 'msg-9', ts: Date.now(), room: 'general' });

    expect(readOutbox()).toEqual([]);
    const node = bubbles().pop();
    expect(node.dataset.messageId).toBe('msg-9');
    // A server ack is only proof the message was stored; delivery needs a receipt.
    expect(tickOf(node).dataset.state).toBe('sent');
  });

  it('promotes from the ack alone when the room echo never arrives', () => {
    const clientId = api.G().deliver({ text: 'deduped send' });
    expect(api.socket.last('message').payload.clientId).toBe(clientId);

    api.socket.answer('message', { ok: true, id: 'msg-10', ts: Date.now(), duplicate: true, room: 'general' });

    expect(bubbles().pop().dataset.messageId).toBe('msg-10');
    expect(readOutbox()).toEqual([]);
  });

  it('retries a throttled send with backoff and keeps one client id', async () => {
    jest.useFakeTimers();
    try {
      const clientId = api.G().deliver({ text: 'throttled' });

      for (let i = 0; i < 3; i += 1) {
        await jest.advanceTimersByTimeAsync(0);
        const send = api.socket.emitted.filter((e) => e.event === 'message').pop();
        expect(send.payload.clientId).toBe(clientId);
        expect(send.payload.text).toBe('throttled');
        send.ack(null, { ok: false, error: 'rate_limited' });
        const queued = api.G().state.retries.get(clientId);
        expect(queued).toBeDefined();
        await jest.runAllTimersAsync();
      }

      expect(api.G().queueCount()).toBe(1);
      expect(readOutbox()[0].tries).toBeGreaterThan(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a send the server could not store, without a new client id', async () => {
    jest.useFakeTimers();
    try {
      const clientId = api.G().deliver({ text: 'store blip' });
      await jest.advanceTimersByTimeAsync(0);

      // The Redis handle died mid-request: retryable, and the same clientId keeps
      // the eventual write from duplicating the message.
      const first = api.socket.emitted.filter((e) => e.event === 'message').pop();
      first.ack(null, { ok: false, error: 'store_unavailable' });
      expect(api.G().queueCount()).toBe(1);
      expect(readOutbox()[0].clientId).toBe(clientId);

      await jest.runAllTimersAsync();
      const second = api.socket.emitted.filter((e) => e.event === 'message').pop();
      expect(second.payload.clientId).toBe(clientId);
      second.ack(null, { ok: true, id: 'msg-11', ts: Date.now(), room: 'general' });

      expect(readOutbox()).toEqual([]);
      expect(bubbles().pop().dataset.messageId).toBe('msg-11');
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up after the attempt ceiling instead of retrying forever', async () => {
    jest.useFakeTimers();
    try {
      api.G().deliver({ text: 'never acknowledged' });
      for (let i = 0; i < 10; i += 1) {
        await jest.runAllTimersAsync();
        const send = api.socket.emitted.filter((e) => e.event === 'message').pop();
        if (!send || typeof send.ack !== 'function') break;
        send.ack(new Error('timed out'));
      }
      await jest.runAllTimersAsync();

      expect(readOutbox()).toEqual([]);
      expect(api.G().queueCount()).toBe(0);
      const node = bubbles().pop();
      expect(tickOf(node).dataset.state).toBe('failed');
      expect(document.body.textContent).toContain('message not sent');
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails fast on a payload the server rejected for good', () => {
    api.G().deliver({ text: 'poll option became empty after sanitising' });
    api.socket.answer('message', { ok: false, error: 'message is empty' });

    expect(readOutbox()).toEqual([]);
    expect(tickOf(bubbles().pop()).dataset.state).toBe('failed');
    expect(api.G().state.retries.size).toBe(0);
  });

  it('explains an attachment that expired while the queue was offline', () => {
    api.G().deliver({
      text: '',
      attachments: [{ id: '00000000-0000-4000-8000-000000000001', kind: 'document', name: 'spec.pdf', mime: 'application/pdf', size: 12 }]
    });
    api.socket.answer('message', { ok: false, error: 'unknown attachment 00000000-0000-4000-8000-000000000001' });

    expect(document.body.textContent).toContain('the attachment expired before this send could go through');
    expect(readOutbox()).toEqual([]);
  });

  it('forgets entries older than the server idempotency window', () => {
    window.localStorage.setItem(
      'chat:outbox',
      JSON.stringify([
        { clientId: 'stale-1', room: 'general', text: 'too old', attachments: [], content: null, ts: Date.now() - 11 * 60 * 1000, tries: 2 }
      ])
    );

    api.G().flushOutbox();

    expect(readOutbox()).toEqual([]);
    expect(api.socket.last('message')).toBeUndefined();
  });

  it('leaves the queue of another room untouched until the user goes back', () => {
    window.localStorage.setItem(
      'chat:outbox',
      JSON.stringify([
        { clientId: 'other-1', room: 'design-team', text: 'for another room', attachments: [], content: null, ts: Date.now(), tries: 1 }
      ])
    );

    api.G().flushOutbox();

    expect(api.socket.last('message')).toBeUndefined();
    expect(readOutbox()).toHaveLength(1);
    expect(api.G().queueCount()).toBe(1);
  });

  it('replays the queue when the browser comes back online', async () => {
    api.socket.instance.connected = false;
    const clientId = api.G().deliver({ text: 'waiting for network' });
    expect(api.socket.last('message')).toBeUndefined();

    api.socket.instance.connected = true;
    window.dispatchEvent(new Event('online'));
    await tick();

    expect(api.socket.last('message').payload.clientId).toBe(clientId);
  });

  it('treats a duplicate send of the same client id as one bubble', () => {
    const first = api.G().deliver({ text: 'double tap', clientId: 'fixed-id' });
    const second = api.G().deliver({ text: 'double tap', clientId: 'fixed-id' });

    expect(first).toBe(second);
    expect(bubbles()).toHaveLength(1);
    expect(readOutbox()).toHaveLength(1);
  });

  it('survives a reload: a queued entry is replayed with its original id', async () => {
    const stored = [{
      clientId: 'reloaded-1',
      room: 'general',
      text: 'typed before the tab closed',
      attachments: [],
      content: null,
      ts: Date.now(),
      tries: 1
    }];
    // Discard the live client the way a reload would; only storage survives.
    const fresh = loadClient();
    window.localStorage.setItem('chat:outbox', JSON.stringify(stored));
    await join(fresh);

    expect(fresh.G().queueCount()).toBe(1);
    expect(fresh.socket.last('message').payload.clientId).toBe('reloaded-1');
    expect(fresh.socket.last('message').payload.text).toBe('typed before the tab closed');
  });
});
