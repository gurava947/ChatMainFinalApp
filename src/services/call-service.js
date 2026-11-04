'use strict';

const { CALL_HISTORY_MAX } = require('../constants');

/** Statuses a call can still move on from; anything else has already been settled. */
const LIVE = Object.freeze(['ringing', 'connected']);

/**
 * Turns WebRTC signalling into a history both guests can list. One record per
 * call id, patched as the events arrive, and shared by the two participants:
 * `direction` is what makes the same row read as outgoing for one guest and
 * incoming for the other.
 */
function createCallService({ store, logger }) {
  /** Signalling is the product, so a store that is gone is logged, not thrown. */
  async function quiet(task, callId) {
    try {
      return await task();
    } catch (err) {
      if (logger) logger.warn({ err, callId }, 'call history write failed');
      return null;
    }
  }

  /**
   * Only a participant of a call that is still live may move it, which is also
   * what stops a stranger's `callId` from creating a record out of nowhere.
   */
  async function openFor(callId, userId) {
    const record = await quiet(() => store.getCall(callId), callId);
    if (!record || !LIVE.includes(record.status)) return null;
    return (record.participants || []).some((entry) => entry.userId === userId) ? record : null;
  }

  function closed(record, endedAt) {
    const durationBase = record.connectedAt || record.startedAt;
    return {
      ...record,
      // A ring nobody answered is missed for both ends: the caller did ring, and
      // nobody picked up. Only a call that connected can genuinely "end".
      status: record.connectedAt ? 'ended' : 'missed',
      endedAt,
      durationMs: Math.max(0, endedAt - durationBase)
    };
  }

  async function start({ room, callId, mode, caller, callee }) {
    return quiet(async () => store.recordCall({
      id: callId,
      room,
      mode,
      status: 'ringing',
      startedAt: Date.now(),
      connectedAt: null,
      endedAt: null,
      durationMs: 0,
      participants: [
        { userId: caller.userId, displayName: caller.displayName, direction: 'out' },
        { userId: callee.userId, displayName: callee.displayName, direction: 'in' }
      ]
    }), callId);
  }

  async function connect(callId, userId) {
    const record = await openFor(callId, userId);
    if (!record) return null;
    return quiet(async () => store.recordCall({ ...record, status: 'connected', connectedAt: Date.now() }), callId);
  }

  async function decline(callId, userId) {
    const record = await openFor(callId, userId);
    if (!record) return null;
    const endedAt = Date.now();
    return quiet(async () => store.recordCall({ ...record, status: 'declined', endedAt, durationMs: 0 }), callId);
  }

  async function finish(callId, userId) {
    const record = await openFor(callId, userId);
    if (!record) return null;
    return quiet(async () => store.recordCall(closed(record, Date.now())), callId);
  }

  /** A dropped socket must not leave a call ringing forever on the other device. */
  async function finalize(callIds) {
    for (const callId of callIds) {
      const record = await quiet(() => store.getCall(callId), callId);
      if (!record || !LIVE.includes(record.status)) continue;
      await quiet(async () => store.recordCall(closed(record, Date.now())), callId);
    }
  }

  /** The viewer's own row is the reference point: the peer is whoever else was in it. */
  function publicCall(record, viewerId) {
    const participants = record.participants || [];
    const mine = participants.find((entry) => entry.userId === viewerId);
    if (!mine) return null;
    const peer = participants.find((entry) => entry.userId !== viewerId);
    return {
      id: record.id,
      room: record.room,
      mode: record.mode,
      status: record.status,
      startedAt: record.startedAt,
      connectedAt: record.connectedAt ?? null,
      endedAt: record.endedAt ?? null,
      durationMs: record.durationMs,
      direction: mine.direction,
      peer: peer ? { userId: peer.userId, displayName: peer.displayName } : null
    };
  }

  async function listFor(userId) {
    const records = await store.listCalls(userId, CALL_HISTORY_MAX);
    return records.map((record) => publicCall(record, userId)).filter(Boolean);
  }

  async function clear(userId) {
    await store.clearCalls(userId);
    return { cleared: true };
  }

  return { start, connect, decline, finish, finalize, listFor, clear };
}

module.exports = { createCallService };
