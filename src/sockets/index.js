'use strict';

const { SOCKET_EVENTS, userRoom } = require('../constants');
const { parse, joinPayloadSchema, roomJoinPayloadSchema, roomCredentialSchema, sendPayloadSchema, seenIdsSchema, deliveredIdsSchema, pollVoteSchema } = require('../utils/validate');
const { socketConnectGuard } = require('../middleware/rate-limit');
const { isStoreDown } = require('../middleware/error-handler');
const { registerCallEvents } = require('./calls');
const { createCallService } = require('../services/call-service');

/**
 * Acks carry a code the client can act on, not driver text. A store outage in
 * the middle of a send is retryable, and the outbox only backs off on names it
 * knows, so "Connection is closed." would mark the message failed for good.
 */
const ACK_FAILED = (err) => ({
  ok: false,
  error: typeof err === 'string' ? err : isStoreDown(err) ? 'store_unavailable' : err.message
});
const ACK_OK = (payload) => ({ ok: true, ...payload });

/**
 * Runs before `connection`: throttles connection attempts per client IP and
 * turns an anonymous socket into an authenticated session holder.
 */
const HANDSHAKE_STORE_WAIT_MS = 5000;

function registerAuthMiddleware(io, { chat, store, logger, env, ensureStore }) {
  io.use(socketConnectGuard({
    store,
    limit: env.RATE_LIMIT_SOCKET_CONNECT_MAX,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    logger
  }));

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth || {};
    try {
      if (typeof auth.userId !== 'string') throw new Error('missing userId');
      if (ensureStore) {
        // A paused isolate can reach this handler with its Redis socket still
        // down; the lookup would then answer "unknown session" and the client
        // would reconnect in a loop instead of waiting for the reopen.
        await Promise.race([
          ensureStore(),
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('store reconnect timed out')), HANDSHAKE_STORE_WAIT_MS).unref();
          })
        ]);
      }
      const session = await chat.authenticateSession(auth.userId, auth.sessionToken);
      if (!session) throw new Error('unknown session');
      socket.data.user = { userId: session.userId, displayName: session.displayName, since: Date.now() };
      socket.data.room = null;
      return next();
    } catch (err) {
      logger.warn({ err, ip: socket.handshake.address }, 'socket auth rejected');
      return next(new Error('unauthorized'));
    }
  });
}

function registerChatEvents(io, deps) {
  const { chat, logger, env, store, throttleMessage } = deps;
  const calls = createCallService({ store, logger });

  // Deliberately not async: every listener has to exist before the first packet
  // can be processed. An awaited setup here would drop events that arrive while
  // it is still running, and a client that sends as soon as it connects never
  // gets an answer.
  io.on(SOCKET_EVENTS.CONNECTION, (socket) => {
    const emitError = (payload) => socket.emit(SOCKET_EVENTS.SYSTEM, { type: 'error', ...payload });

    socket.emit(SOCKET_EVENTS.SYSTEM, {
      type: 'connected',
      instanceId: deps.config.instanceId,
      // A client that cannot tell the two apart will believe its history is
      // shared when each replica is quietly holding its own.
      sharedStore: deps.config.sharedStore,
      serverId: socket.id
    });

    // The personal room is what lets any replica address this one user, so it
    // is joined before the first message can arrive rather than on room join.
    socket.join(userRoom(socket.data.user.userId));

    // Auto-join when the handshake already carries a room, so the common path
    // needs no extra round trip. Handlers await this instead of racing it; the
    // join error is reported here so the promise is never left unhandled.
    const requestedRoom = socket.handshake.auth && socket.handshake.auth.room;
    const setupJoin = async () => {
      const { room } = parse(joinPayloadSchema.partial().required({ room: true }), { room: requestedRoom });
      const { credential } = parse(roomCredentialSchema, { credential: socket.handshake.auth.roomCredential });
      // The handshake is a join like any other, so it goes through the roster
      // rather than being trusted because it arrived before the first packet.
      await chat.authorizeRoom(socket.data.user, room, credential);
      // joinRoom broadcasts presence to the room, which already contains this
      // socket, so no separate emit is needed here.
      await chat.joinRoom(socket, room, socket.data.user);
      socket.emit(SOCKET_EVENTS.HISTORY, {
        room,
        messages: await chat.readHistory(room, socket.data.user, { limit: env.HISTORY_PAGE_SIZE })
      });
    };
    const joined = requestedRoom
      ? setupJoin().catch((err) => emitError({ message: 'could not join room', reason: err.message }))
      : Promise.resolve();

    registerCallEvents(socket, { io, chat, getJoined: () => joined, calls, store, env });

    socket.on(SOCKET_EVENTS.ROOM_JOIN, async (payload, ack) => {
      try {
        const { room, credential } = parse(roomJoinPayloadSchema, payload);
        await joined;
        // Authorised here rather than trusted from the HTTP call that usually
        // precedes it: a socket can skip that call, and the roster is the only
        // thing that says whether this user holds a seat.
        const grant = await chat.authorizeRoom(socket.data.user, room, credential);
        if (socket.data.room) await chat.leaveRoom(socket);
        await chat.joinRoom(socket, room, socket.data.user);
        socket.emit(SOCKET_EVENTS.HISTORY, {
          room,
          messages: await chat.readHistory(room, socket.data.user, { limit: env.HISTORY_PAGE_SIZE })
        });
        if (typeof ack === 'function') ack(ACK_OK({ room, role: grant.role, inviteCode: grant.inviteCode ?? null }));
      } catch (err) {
        if (typeof ack === 'function') ack(ACK_FAILED(err));
      }
    });

    socket.on(SOCKET_EVENTS.MESSAGE, async (payload, ack) => {
      try {
        await joined;
        if (!socket.data.room) throw new Error('join a room first');
        // A write is the last place a stale session can still do damage, and
        // the check costs one shared-store read against a whole send.
        if (!await chat.revalidateSocket(socket)) throw new Error('session_expired');
        const send = parse(sendPayloadSchema, { ...payload, room: payload.room || socket.data.room });
        if (send.room !== socket.data.room) throw new Error('room mismatch');
        const rate = await throttleMessage(socket);
        if (!rate.allowed) {
          emitError({ message: 'slow_down', retryAfterMs: env.RATE_LIMIT_WINDOW_MS });
          if (typeof ack === 'function') ack(ACK_FAILED('rate_limited'));
          return;
        }

        const message = await chat.sendMessage(socket.data.user, send);
        if (typeof ack !== 'function') return;
        // null means the same clientId is still being written by the first send;
        // the client keeps its optimistic node and matches the real message when
        // new_message arrives, so acknowledging a duplicate is all this can do.
        if (!message) {
          ack(ACK_OK({ duplicate: true }));
          return;
        }
        // `seq` is the store's ordering, so echoing it lets the sender file its
        // own row by the same token history and the peer's live copy use, rather
        // than by a clock that another replica may disagree with.
        ack(ACK_OK({ id: message.id, seq: message.seq, ts: message.ts, seenBy: [], duplicate: Boolean(message.duplicate) }));
      } catch (err) {
        logger.debug({ err, socketId: socket.id }, 'message rejected');
        emitError({ message: 'message rejected', reason: err.message });
        if (typeof ack === 'function') ack(ACK_FAILED(err));
      }
    });

    socket.on(SOCKET_EVENTS.POLL_VOTE, async (payload, ack) => {
      try {
        await joined;
        if (!socket.data.room) throw new Error('join a room first');
        const vote = parse(pollVoteSchema, payload);
        const window = await store.consumeWindow(
          `poll:${socket.handshake.address}:${socket.data.user.userId}`,
          env.RATE_LIMIT_SEND_MAX * 2,
          env.RATE_LIMIT_WINDOW_MS
        );
        if (window.total > window.limit) throw new Error('rate_limited');
        const result = await chat.votePoll(socket, vote);
        if (typeof ack === 'function') ack(ACK_OK({ messageId: result.messageId, results: result.results }));
      } catch (err) {
        logger.debug({ err, socketId: socket.id }, 'poll vote rejected');
        if (typeof ack === 'function') ack(ACK_FAILED(err));
      }
    });

    // Read receipts: cheap, chatty and client-driven, so they get their own
    // window instead of consuming the message quota.
    socket.on(SOCKET_EVENTS.SEEN_MARK, async (payload, ack) => {
      try {
        await joined;
        if (!socket.data.room) throw new Error('join a room first');
        const { ids } = parse(seenIdsSchema, payload);
        const window = await store.consumeWindow(
          `seen:${socket.handshake.address}:${socket.data.user.userId}`,
          env.RATE_LIMIT_SEND_MAX * 4,
          env.RATE_LIMIT_WINDOW_MS
        );
        if (window.total > window.limit) throw new Error('rate_limited');
        const newlySeen = await chat.markSeen(socket, ids);
        if (typeof ack === 'function') ack(ACK_OK({ counted: newlySeen.length }));
      } catch (err) {
        logger.debug({ err, socketId: socket.id }, 'seen receipt rejected');
        if (typeof ack === 'function') ack(ACK_FAILED(err));
      }
    });

    // Delivery receipts arrive the moment a message lands, so they are chattier
    // than reads and get a window of their own.
    socket.on(SOCKET_EVENTS.DELIVERED_MARK, async (payload, ack) => {
      try {
        await joined;
        if (!socket.data.room) throw new Error('join a room first');
        const { ids } = parse(deliveredIdsSchema, payload);
        const window = await store.consumeWindow(
          `delivered:${socket.handshake.address}:${socket.data.user.userId}`,
          env.RATE_LIMIT_SEND_MAX * 8,
          env.RATE_LIMIT_WINDOW_MS
        );
        if (window.total > window.limit) throw new Error('rate_limited');
        const newly = await chat.markDelivered(socket, ids);
        if (typeof ack === 'function') ack(ACK_OK({ counted: newly.length }));
      } catch (err) {
        logger.debug({ err, socketId: socket.id }, 'delivery receipt rejected');
        if (typeof ack === 'function') ack(ACK_FAILED(err));
      }
    });

    socket.on(SOCKET_EVENTS.TYPING, () => {
      if (socket.data.room && socket.data.user) chat.emitTyping(socket, true);
    });

    socket.on(SOCKET_EVENTS.STOP_TYPING, () => {
      if (socket.data.room && socket.data.user) chat.emitTyping(socket, false);
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, async (reason) => {
      try {
        // A socket can drop while its join is still in flight; waiting keeps the
        // leave from running first and leaving a presence entry behind.
        await joined;
        await chat.leaveRoom(socket);
      } catch (err) {
        logger.error({ err, socketId: socket.id, reason }, 'cleanup on disconnect failed');
      }
    });
  });
}

function startHeartbeat(io, { chat, env, logger }) {
  const timer = setInterval(async () => {
    const sockets = io.of('/').sockets;
    for (const socket of sockets.values()) {
      if (!socket.data.room) continue;
      try {
        // Same tick that refreshes presence refreshes the session, so a socket
        // whose session died leaves instead of streaming on unauthenticated.
        if (!await chat.revalidateSocket(socket)) {
          logger.warn({ socketId: socket.id }, 'socket session no longer valid, disconnecting');
          socket.emit(SOCKET_EVENTS.SYSTEM, { type: 'session_revoked' });
          socket.disconnect(true);
          continue;
        }
        await chat.heartbeat(socket);
      } catch (err) {
        logger.debug({ err, socketId: socket.id }, 'presence heartbeat failed');
      }
    }
  }, env.SOCKET_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function attachSocketHandlers(io, deps) {
  registerAuthMiddleware(io, deps);
  registerChatEvents(io, deps);
  return startHeartbeat(io, deps);
}

module.exports = { attachSocketHandlers };
