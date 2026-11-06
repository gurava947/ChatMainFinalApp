'use strict';

const { io: connect } = require('socket.io-client');
const { getSessionToken } = require('./session-auth');

const RECORDED_EVENTS = [
  'connect',
  'disconnect',
  'system',
  'history',
  'presence',
  'new_message',
  'user_joined',
  'user_left',
  'typing',
  'stop_typing',
  'message_seen',
  'message_delivered',
  'messages_delivered',
  'poll_voted',
  'status_created',
  'status_removed',
  'call:incoming',
  'call:accepted',
  'call:declined',
  'call:offer',
  'call:answer',
  'call:ice',
  'call:end'
];

/**
 * Joins can emit before the test body registers a listener, so every event is
 * buffered and waits consume from that buffer.
 */
function record(socket) {
  socket.__events = [];
  socket.__cursors = {};
  socket.__waiters = new Set();

  RECORDED_EVENTS.forEach((name) => {
    socket.on(name, (payload) => {
      socket.__events.push({ name, payload });
      socket.__waiters.forEach((wake) => wake());
    });
  });
  return socket;
}

function waitFor(socket, name, predicate = () => true, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const scan = () => {
      const from = socket.__cursors[name] || 0;
      for (let i = from; i < socket.__events.length; i += 1) {
        const event = socket.__events[i];
        if (event.name === name && predicate(event.payload)) {
          socket.__cursors[name] = i + 1;
          settled = true;
          cleanup();
          resolve(event.payload);
          return;
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.__waiters.delete(scan);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error(`timed out waiting for "${name}"`));
    }, timeoutMs);

    socket.__waiters.add(scan);
    scan();
  });
}

function emitWithAck(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for "${event}"`)), timeoutMs);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function openSocket(url, userId, room) {
  return record(connect(url, {
    auth: { userId, sessionToken: getSessionToken(userId), room, roomPassword: 'InChatTestPassword!' },
    transports: ['websocket'],
    forceNew: true
  }));
}

module.exports = { RECORDED_EVENTS, record, waitFor, emitWithAck, openSocket };
