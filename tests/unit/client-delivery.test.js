/** @jest-environment jsdom */

'use strict';

const { join, loadClient } = require('../helpers/client-env');

const bubbles = () => Array.from(document.querySelectorAll('#message-list .msg'));
const tickOf = (node) => node.querySelector('[data-role="ticks"]');

const base = { room: 'general', ts: 1700000000000, deliveredTo: [], seenBy: [] };
const mine = (over = {}) => ({ ...base, id: 'msg-mine', userId: 'user-1', displayName: 'Arjun', text: 'from me', ...over });
const theirs = (over = {}) => ({ ...base, id: 'msg-other', userId: 'user-2', displayName: 'Ben', text: 'from ben', ...over });

/** Two online sockets, one of them this device: online is not the same as delivered. */
const twoOnline = {
  connections: 2,
  onlineUsers: 2,
  users: [
    { socketId: 's-1', userId: 'user-1', displayName: 'Arjun', since: 1, lastSeen: 1 },
    { socketId: 's-2', userId: 'user-2', displayName: 'Ben', since: 1, lastSeen: 1 }
  ]
};

describe('delivery receipts in the room client', () => {
  let api;

  beforeEach(async () => {
    api = loadClient();
    await join(api);
  });

  it('shows sent, not delivered, while nobody has acknowledged the message', () => {
    api.socket.fire('history', { room: 'general', messages: [mine()] });
    const node = bubbles().pop();
    expect(tickOf(node).dataset.state).toBe('sent');
  });

  it('never turns an online peer into a delivery receipt', () => {
    api.socket.fire('new_message', mine({ id: 'msg-online' }));
    api.socket.fire('presence', twoOnline);

    const node = bubbles().pop();
    expect(tickOf(node).dataset.state).toBe('sent');
    // This device must not report delivery for its own message either.
    expect(api.socket.last('message:delivered')).toBeUndefined();
  });

  it('reports delivery the moment another guest message lands', () => {
    api.socket.fire('new_message', theirs({ id: 'msg-inbound' }));

    const report = api.socket.last('message:delivered');
    expect(report.payload.ids).toEqual(['msg-inbound']);
  });

  it('reports each inbound message once', () => {
    api.socket.fire('new_message', theirs({ id: 'msg-twice' }));
    api.socket.fire('new_message', theirs({ id: 'msg-twice' }));

    const reports = api.socket.emitted.filter((entry) => entry.event === 'message:delivered');
    expect(reports).toHaveLength(1);
  });

  it('upgrades the tick when a receipt arrives for my message', () => {
    api.socket.fire('new_message', mine({ id: 'msg-upgrade' }));
    const node = bubbles().pop();
    expect(tickOf(node).dataset.state).toBe('sent');

    api.socket.fire('message_delivered', { messageId: 'msg-upgrade', userId: 'user-2', room: 'general' });
    expect(tickOf(node).dataset.state).toBe('delivered');
  });

  it('paints deliveredTo that already exists in history', () => {
    api.socket.fire('history', {
      room: 'general',
      messages: [mine({ id: 'msg-history', deliveredTo: ['user-2'] })]
    });

    expect(tickOf(bubbles().pop()).dataset.state).toBe('delivered');
  });

  it('keeps read receipts above delivery receipts', () => {
    api.socket.fire('history', {
      room: 'general',
      messages: [mine({ id: 'msg-read', deliveredTo: ['user-2'], seenBy: ['user-2'] })]
    });

    expect(tickOf(bubbles().pop()).dataset.state).toBe('seen');
  });

  it('ignores receipts for messages this device did not send', () => {
    api.socket.fire('new_message', theirs({ id: 'msg-not-mine' }));
    const node = bubbles().pop();
    const ticks = tickOf(node);

    api.socket.fire('message_delivered', { messageId: 'msg-not-mine', userId: 'user-2', room: 'general' });

    expect(tickOf(node)).toBe(ticks);
    expect(ticks.hidden).toBe(true);
  });

  it('does not report delivery twice across a room switch', async () => {
    api.socket.fire('new_message', theirs({ id: 'msg-leave' }));
    expect(api.socket.emitted.filter((e) => e.event === 'message:delivered')).toHaveLength(1);

    await join(api, { room: 'general' });
    api.socket.fire('new_message', theirs({ id: 'msg-leave' }));

    expect(api.socket.emitted.filter((e) => e.event === 'message:delivered')).toHaveLength(2);
  });
});
