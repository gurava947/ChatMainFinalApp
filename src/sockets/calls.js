'use strict';

const { parse, callSignalSchema, callInviteSchema, callResumeSchema, callStatsSchema } = require('../utils/validate');
const metrics = require('../config/metrics');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = Object.freeze({
  invite: 'call:invite',
  incoming: 'call:incoming',
  accept: 'call:accept',
  accepted: 'call:accepted',
  reject: 'call:reject',
  declined: 'call:declined',
  offer: 'call:offer',
  answer: 'call:answer',
  ice: 'call:ice',
  restart: 'call:restart',
  end: 'call:end',
  resume: 'call:resume',
  mailbox: 'call:mailbox',
  stats: 'call:stats'
});

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validatePayload(event, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw badRequest('invalid call signal');
  const signal = parse(event === EVENTS.invite ? callInviteSchema : callSignalSchema, payload);
  // zod accepts any hex in the version and variant fields; a call id is a uuid this
  // app's clients mint, so the stricter shape stays enforced on the wire.
  if (!UUID.test(signal.callId)) throw badRequest('invalid call id');
  if (event === EVENTS.offer || event === EVENTS.answer) {
    const expectedType = event === EVENTS.offer ? 'offer' : 'answer';
    if (!payload.description || payload.description.type !== expectedType || typeof payload.description.sdp !== 'string' || payload.description.sdp.length > 25000) {
      throw badRequest('invalid call description');
    }
  }
  if (event === EVENTS.ice) {
    const candidate = payload.candidate;
    if (!candidate || typeof candidate !== 'object' || typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096) {
      throw badRequest('invalid ICE candidate');
    }
    if (candidate.sdpMid !== null && candidate.sdpMid !== undefined && (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 128)) throw badRequest('invalid ICE mid');
    if (candidate.sdpMLineIndex !== null && candidate.sdpMLineIndex !== undefined && (!Number.isInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0 || candidate.sdpMLineIndex > 64)) throw badRequest('invalid ICE line index');
  }
  return signal;
}

/**
 * Every event a socket sends names the call it belongs to, so this is the list a
 * disconnect walks to settle its own calls instead of guessing from presence.
 */
function trackCall(socket, callId) {
  const tracked = socket.data.callIds || (socket.data.callIds = new Set());
  tracked.add(callId);
}

const LIVE_STATUSES = new Set(['ringing', 'connected']);

/** The call record is the authorization source: a stranger's callId replays nothing. */
async function openCall(store, callId, user, room) {
  const record = await store.getCall(callId);
  if (!record || record.room !== room || !LIVE_STATUSES.has(record.status)) return null;
  return (record.participants || []).some((entry) => entry.userId === user.userId) ? record : null;
}

function registerCallEvents(socket, { io, chat, getJoined, calls, store, env, logger }) {
  const record = (event, signal, peer) => {
    const user = socket.data.user;
    if (event === EVENTS.invite) {
      return calls.start({ room: socket.data.room, callId: signal.callId, mode: signal.mode, caller: user, callee: peer });
    }
    if (event === EVENTS.accept) return calls.connect(signal.callId, user.userId);
    if (event === EVENTS.reject) return calls.decline(signal.callId, user.userId);
    if (event === EVENTS.end) return calls.finish(signal.callId, user.userId);
    return Promise.resolve();
  };

  const forward = (incomingEvent, outgoingEvent) => {
    socket.on(incomingEvent, async (payload, ack) => {
      try {
        await getJoined();
        if (!socket.data.room || !socket.data.user) throw badRequest('join a room before calling');
        const signal = validatePayload(incomingEvent, payload);
        if (signal.targetSocketId === socket.id) throw badRequest('cannot call this device');

        const snapshot = await chat.presenceSnapshot(socket.data.room);
        const peer = snapshot.users.find((entry) => entry.socketId === signal.targetSocketId);
        if (!peer || peer.userId === socket.data.user.userId) throw badRequest('guest is no longer available in this room');

        // An invite is the one event that opens a record, so it is the one that has
        // to stay inside a window: a guest cannot park a hundred ringing calls.
        if (incomingEvent === EVENTS.invite) {
          const window = await store.consumeWindow(
            `call:${socket.handshake.address}:${socket.data.user.userId}:${socket.data.room}`,
            env.RATE_LIMIT_SEND_MAX,
            env.RATE_LIMIT_WINDOW_MS
          );
          if (window.total > window.limit) throw new Error('rate_limited');
        }

        const forwarded = {
          room: socket.data.room,
          callId: signal.callId,
          fromSocketId: socket.id,
          fromUserId: socket.data.user.userId,
          fromDisplayName: socket.data.user.displayName
        };
        if (incomingEvent === EVENTS.invite) forwarded.mode = signal.mode;
        if (incomingEvent === EVENTS.offer || incomingEvent === EVENTS.answer) forwarded.description = payload.description;
        if (incomingEvent === EVENTS.ice) forwarded.candidate = payload.candidate;
        io.to(peer.socketId).emit(outgoingEvent, forwarded);
        if (typeof ack === 'function') ack({ ok: true });

        trackCall(socket, signal.callId);
        if (incomingEvent === EVENTS.offer || incomingEvent === EVENTS.answer || incomingEvent === EVENTS.ice) {
          const entry = {
            kind: incomingEvent === EVENTS.ice ? 'candidate' : 'description',
            room: socket.data.room,
            fromSocketId: socket.id,
            fromUserId: socket.data.user.userId,
            fromDisplayName: socket.data.user.displayName,
            ts: Date.now()
          };
          if (incomingEvent === EVENTS.ice) entry.candidate = payload.candidate;
          else entry.description = payload.description;
          // The live packet is already gone; a frozen isolate must not turn a
          // best-effort replay copy into a failed signal.
          try {
            await store.appendSignal(signal.callId, peer.userId, entry);
            metrics.signalMailbox.inc({ op: 'write' });
          } catch (err) {
            metrics.signalMailbox.inc({ op: 'error' });
            if (logger) logger.warn({ err, callId: signal.callId }, 'signal mailbox write failed');
          }
        }
        await record(incomingEvent, signal, peer);
        if (incomingEvent === EVENTS.end || incomingEvent === EVENTS.reject) {
          try {
            await store.clearSignalMailbox(signal.callId, [socket.data.user.userId, peer.userId]);
            metrics.signalMailbox.inc({ op: 'clear' });
          } catch (err) {
            metrics.signalMailbox.inc({ op: 'error' });
            if (logger) logger.warn({ err, callId: signal.callId }, 'signal mailbox clear failed');
          }
        }
      } catch (error) {
        if (typeof ack === 'function') ack({ ok: false, error: error.message || 'call_signal_rejected' });
      }
    });
  };

  forward(EVENTS.invite, EVENTS.incoming);
  forward(EVENTS.accept, EVENTS.accepted);
  forward(EVENTS.reject, EVENTS.declined);
  forward(EVENTS.offer, EVENTS.offer);
  forward(EVENTS.answer, EVENTS.answer);
  forward(EVENTS.ice, EVENTS.ice);
  forward(EVENTS.restart, EVENTS.restart);
  forward(EVENTS.end, EVENTS.end);

  socket.on(EVENTS.resume, async (payload, ack) => {
    try {
      await getJoined();
      if (!socket.data.room || !socket.data.user) throw badRequest('join a room before calling');
      const signal = parse(callResumeSchema, payload);
      if (!UUID.test(signal.callId)) throw badRequest('invalid call id');
      const callRecord = await openCall(store, signal.callId, socket.data.user, socket.data.room);
      if (!callRecord) throw badRequest('call is no longer active');

      const mailbox = await store.readSignalMailbox(signal.callId, socket.data.user.userId);
      metrics.signalMailbox.inc({ op: 'read' });
      const replayed = Boolean(mailbox.description || mailbox.candidates.length);
      metrics.callResume.inc({ outcome: replayed ? 'replayed' : 'empty' });
      if (replayed) {
        const snapshot = await chat.presenceSnapshot(socket.data.room);
        const sender = snapshot.users.find((entry) => entry.userId === mailbox.fromUserId);
        socket.emit(EVENTS.mailbox, {
          room: socket.data.room,
          callId: signal.callId,
          fromSocketId: sender?.socketId || mailbox.fromSocketId,
          fromUserId: mailbox.fromUserId,
          fromDisplayName: mailbox.fromDisplayName,
          description: mailbox.description,
          candidates: mailbox.candidates
        });
      }
      trackCall(socket, signal.callId);
      if (typeof ack === 'function') ack({ ok: true, replayed });
    } catch (error) {
      metrics.callResume.inc({ outcome: 'rejected' });
      if (typeof ack === 'function') ack({ ok: false, error: error.message || 'call_signal_rejected' });
    }
  });

  socket.on(EVENTS.stats, async (payload, ack) => {
    try {
      await getJoined();
      if (!socket.data.room || !socket.data.user) throw badRequest('join a room before calling');
      const signal = parse(callStatsSchema, payload);
      if (!UUID.test(signal.callId)) throw badRequest('invalid call id');
      const callRecord = await openCall(store, signal.callId, socket.data.user, socket.data.room);
      if (!callRecord) throw badRequest('call is no longer active');

      const transport = socket.conn?.transport?.name || 'unknown';
      metrics.callSetups.inc({ outcome: signal.outcome, transport });
      if (signal.outcome === 'connected') {
        metrics.callMediaPath.inc({ path: signal.relayed === null ? 'unknown' : signal.relayed ? 'relay' : 'direct' });
      }
      trackCall(socket, signal.callId);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message || 'call_signal_rejected' });
    }
  });

  socket.on('disconnect', async () => {
    const callIds = socket.data.callIds ? [...socket.data.callIds] : [];
    if (callIds.length === 0) return;
    socket.data.callIds = new Set();
    await calls.finalize(callIds);
  });
}

module.exports = { EVENTS, registerCallEvents, validatePayload };
