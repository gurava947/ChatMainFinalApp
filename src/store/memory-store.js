'use strict';

const { baseMime } = require('../utils/media');
const { normalizeViewers } = require('../utils/status');
const { CALL_HISTORY_MAX, STATUS_MAX_PER_USER } = require('../constants');

/** Voters are stored per choice, so the tally is derived rather than mutated. */
function tallyOf(voters, optionCount) {
  const counts = Array.from({ length: optionCount }, () => []);
  for (const [userId, choices] of voters) {
    for (const choice of choices) {
      if (counts[choice]) counts[choice].push(userId);
    }
  }
  return { totalVoters: voters.size, options: counts.map((voterIds) => ({ count: voterIds.length, voters: voterIds })) };
}

/** Both per-user history indexes drop the oldest entry first, so the cap is one helper. */
function trimIndex(index, max) {
  if (index.size <= max) return;
  const excess = [...index.entries()].sort((a, b) => a[1] - b[1]).slice(0, index.size - max);
  for (const [id] of excess) index.delete(id);
}

/**
 * Single-process stand-in for Redis. Exists so the app can boot for local
 * experimentation without an external service; it is NOT safe for the
 * multi-replica deployments described in k8s/ and docker-compose.yml.
 */
class MemoryStore {
  constructor({ messageCacheSize, mediaTtlSeconds = 3600 }) {
    this.maxMessages = messageCacheSize;
    this.mediaTtl = mediaTtlSeconds;
    this.messages = new Map();
    this.presence = new Map();
    this.windows = new Map();
    this.sessions = new Map();
    this.seen = new Map();
    this.delivered = new Map();
    this.media = new Map();
    this.sends = new Map();
    this.polls = new Map();
    this.notes = new Map();
    this.avatars = new Map();
    this.roomSettings = new Map();
    this.blocked = new Map();
    this.roomPasswords = new Map();
    this.roomAccess = new Set();
    this.calls = new Map();
    this.callIndex = new Map();
    this.statuses = new Map();
    this.statusIndex = new Map();
  }

  async ping() {
    return true;
  }

  async pushMessage(room, message) {
    const list = this.messages.get(room) || [];
    list.unshift(message);
    if (list.length > this.maxMessages) list.length = this.maxMessages;
    this.messages.set(room, list);
    return message;
  }

  async recentMessages(room, count) {
    return (this.messages.get(room) || []).slice(0, count).reverse();
  }

  /** Returns true only the first time this user reads this message. */
  async markSeen(messageId, userId, now = Date.now()) {
    const readers = this.seen.get(messageId) || new Map();
    const already = readers.has(userId);
    if (!already) {
      readers.set(userId, now);
      this.seen.set(messageId, readers);
      if (this.seen.size > 5000) {
        const oldest = this.seen.keys().next().value;
        this.seen.delete(oldest);
      }
    }
    return !already;
  }

  async seenByMessages(messageIds) {
    const out = new Map();
    for (const id of messageIds) out.set(id, [...(this.seen.get(id)?.keys() || [])]);
    return out;
  }

  /**
   * A delivery receipt is reported by the receiving device, so it is recorded
   * once per user the same way a read receipt is. Repeat reports are cheap.
   */
  async markDelivered(messageId, userId, now = Date.now()) {
    const receivers = this.delivered.get(messageId) || new Map();
    const already = receivers.has(userId);
    if (!already) {
      receivers.set(userId, now);
      this.delivered.set(messageId, receivers);
      if (this.delivered.size > 5000) {
        const oldest = this.delivered.keys().next().value;
        this.delivered.delete(oldest);
      }
    }
    return !already;
  }

  async deliveredByMessages(messageIds) {
    const out = new Map();
    for (const id of messageIds) out.set(id, [...(this.delivered.get(id)?.keys() || [])]);
    return out;
  }

  async trackPresence(room, socketId, user, now = Date.now()) {
    const entries = this.presence.get(room) || new Map();
    const existing = entries.get(socketId);
    entries.set(socketId, {
      socketId,
      userId: user.userId,
      displayName: user.displayName,
      since: existing ? existing.since : (user.since ?? now),
      lastSeen: now
    });
    this.presence.set(room, entries);
  }

  async releasePresence(room, socketId) {
    const entries = this.presence.get(room);
    if (entries) entries.delete(socketId);
  }

  async pruneStalePresence(room, ttlMs, now = Date.now()) {
    const entries = this.presence.get(room);
    if (!entries) return [];
    const removed = [];
    for (const [socketId, entry] of entries) {
      if (now - entry.lastSeen > ttlMs) {
        entries.delete(socketId);
        removed.push(socketId);
      }
    }
    return removed;
  }

  async presenceSnapshot(room, ttlMs, now = Date.now()) {
    const entries = [...(this.presence.get(room) || new Map()).values()]
      .filter((entry) => now - entry.lastSeen <= ttlMs)
      .sort((a, b) => a.since - b.since);

    return {
      connections: entries.length,
      onlineUsers: new Set(entries.map((e) => e.userId)).size,
      users: entries
    };
  }

  async consumeWindow(bucket, limit, windowMs) {
    const now = Date.now();
    const current = this.windows.get(bucket);
    if (!current || current.resetAt <= now) {
      this.windows.set(bucket, { total: 1, resetAt: now + windowMs });
      return { total: 1, limit, remaining: Math.max(0, limit - 1) };
    }
    current.total += 1;
    return { total: current.total, limit, remaining: Math.max(0, limit - current.total) };
  }

  async saveSession(session) {
    (this.sessions ||= new Map()).set(session.userId, session);
    return session;
  }

  async getSession(userId) {
    return this.sessions?.get(userId) ?? null;
  }

  async getRoomPassword(room) {
    return this.roomPasswords.get(room) || null;
  }

  async setRoomPasswordIfAbsent(room, record) {
    if (this.roomPasswords.has(room)) return false;
    this.roomPasswords.set(room, record);
    return true;
  }

  async hasRoomAccess(room, userId) {
    return this.roomAccess.has(`${room}:${userId}`);
  }

  async grantRoomAccess(room, userId) {
    this.roomAccess.add(`${room}:${userId}`);
  }

  async saveMedia(record, { ttlSeconds } = {}) {
    const ttl = Number(ttlSeconds) > 0 ? Number(ttlSeconds) : this.mediaTtl;
    const stored = {
      ...record,
      mime: baseMime(record.mime),
      expiresAt: Date.now() + ttl * 1000
    };
    this.media.set(stored.id, stored);
    return stored;
  }

  async getMedia(mediaId) {
    const record = this.media.get(mediaId);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.media.delete(mediaId);
      return null;
    }
    return record;
  }

  async expiredMedia(now = Date.now(), limit = 100) {
    const expired = [];
    for (const record of this.media.values()) {
      if (record.expiresAt <= now) expired.push(record);
      if (expired.length >= limit) break;
    }
    return expired;
  }

  async deleteMedia(mediaId) {
    this.media.delete(mediaId);
  }

  /**
   * First caller wins the reservation and gets `fresh`. A resend inside the
   * window reports the message the original produced, or `messageId: null`
   * while the original is still being written.
   */
  async claimSend(userId, clientId, windowMs) {
    const key = `${userId}:${clientId}`;
    const prior = this.sends.get(key);
    if (prior && prior.expiresAt > Date.now()) return { fresh: false, messageId: prior.messageId };
    this.sends.set(key, { messageId: null, expiresAt: Date.now() + windowMs });
    if (this.sends.size > 5000) this.sends.delete(this.sends.keys().next().value);
    return { fresh: true, messageId: prior ? prior.messageId : null };
  }

  async recordSend(userId, clientId, messageId, windowMs) {
    this.sends.set(`${userId}:${clientId}`, { messageId, expiresAt: Date.now() + windowMs });
  }

  async findMessage(room, messageId) {
    return (this.messages.get(room) || []).find((message) => message.id === messageId) || null;
  }

  /** Re-voting replaces a voter's choice, so a tally never double counts. */
  async castPollVote(messageId, userId, choices, { multiple = false, optionCount = 0 } = {}) {
    const poll = this.polls.get(messageId) || { voters: new Map() };
    if (!multiple && choices.length > 1) {
      const error = new Error('this poll accepts a single choice');
      error.statusCode = 400;
      throw error;
    }
    if (choices.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= optionCount)) {
      const error = new Error('option is not part of this poll');
      error.statusCode = 400;
      throw error;
    }
    poll.voters.set(userId, choices);
    this.polls.set(messageId, poll);
    return tallyOf(poll.voters, optionCount);
  }

  async pollResults(messageId, optionCount) {
    return tallyOf(this.polls.get(messageId)?.voters || new Map(), optionCount);
  }

  async saveNote(userId, note) {
    this.notes.set(userId, note);
    return note;
  }

  async getNote(userId) {
    return this.notes.get(userId) || null;
  }

  /** The picture is a pointer into the media store; the bytes carry their own expiry. */
  async saveAvatar(userId, avatar) {
    this.avatars.set(userId, avatar);
    return avatar;
  }

  async getAvatar(userId) {
    return this.avatars.get(userId) || null;
  }

  async deleteAvatar(userId) {
    return this.avatars.delete(userId);
  }

  /** Chat settings are per viewer and per room, so a room key names both. */
  async getRoomSettings(userId, room) {
    return this.roomSettings.get(`${userId}:${room}`) || null;
  }

  async saveRoomSettings(userId, room, settings) {
    this.roomSettings.set(`${userId}:${room}`, settings);
    return settings;
  }

  async deleteRoomSettings(userId, room) {
    return this.roomSettings.delete(`${userId}:${room}`);
  }

  async getBlockedList(userId) {
    return this.blocked.get(userId) || [];
  }

  async saveBlockedList(userId, entries) {
    this.blocked.set(userId, entries);
    return entries;
  }

  /**
   * A full room wipe, used only where the viewer owns the room. The receipts of
   * the messages being thrown away go with them, or a later room of the same
   * name would inherit ghost ticks.
   */
  async dropRoom(room) {
    const list = this.messages.get(room) || [];
    for (const message of list) {
      this.seen.delete(message.id);
      this.delivered.delete(message.id);
      this.polls.delete(message.id);
    }
    this.messages.delete(room);
    return list.length;
  }

  /* ------------------------------------------------------------------ *
   * Call history (P7). One record per call id, patched as the signalling
   * moves through it, and listed through each participant's own index.
   * ------------------------------------------------------------------ */

  /** A later write for the same id replaces the record, so updates are idempotent. */
  async recordCall(entry) {
    const record = { ...entry, participants: [...(entry.participants || [])] };
    this.calls.set(record.id, record);
    for (const participant of record.participants) {
      if (!participant || typeof participant.userId !== 'string') continue;
      const index = this.callIndex.get(participant.userId) || new Map();
      index.set(record.id, record.startedAt);
      this.callIndex.set(participant.userId, index);
      trimIndex(index, CALL_HISTORY_MAX);
    }
    return record;
  }

  async getCall(callId) {
    return this.calls.get(callId) || null;
  }

  async listCalls(userId, limit = CALL_HISTORY_MAX) {
    const index = this.callIndex.get(userId);
    if (!index) return [];
    const records = [];
    for (const id of [...index.keys()]) {
      const record = this.calls.get(id);
      if (!record) {
        index.delete(id);
        continue;
      }
      records.push(record);
    }
    return records.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  /**
   * Clearing empties this user's list only: a record the peer still lists has to
   * outlive it, and one nobody lists any more would otherwise stay forever.
   */
  async clearCalls(userId) {
    const index = this.callIndex.get(userId);
    if (!index) return 0;
    const ids = [...index.keys()];
    this.callIndex.delete(userId);
    for (const id of ids) {
      const stillListed = [...this.callIndex.values()].some((other) => other.has(id));
      if (!stillListed) this.calls.delete(id);
    }
    return ids.length;
  }

  /* ------------------------------------------------------------------ *
   * Statuses (P8). A card is written once and read until its own expiry, so
   * an expired record is dropped on sight the way expired media is.
   * ------------------------------------------------------------------ */

  async saveStatus(status) {
    const record = { ...status, viewers: normalizeViewers(status) };
    delete record.viewerIds;
    this.statuses.set(record.id, record);
    const index = this.statusIndex.get(record.userId) || new Map();
    index.set(record.id, record.createdAt);
    this.statusIndex.set(record.userId, index);
    trimIndex(index, STATUS_MAX_PER_USER);
    return record;
  }

  purgeStatus(record) {
    this.statuses.delete(record.id);
    this.statusIndex.get(record.userId)?.delete(record.id);
  }

  async getStatus(statusId, now = Date.now()) {
    const record = this.statuses.get(statusId);
    if (!record) return null;
    if (record.expiresAt <= now) {
      this.purgeStatus(record);
      return null;
    }
    return record;
  }

  /** Without a userId this is everyone's feed; with one it is that author's own cards. */
  async listStatuses(userId = null, now = Date.now()) {
    const candidates = userId
      ? [...(this.statusIndex.get(userId)?.keys() || [])].map((id) => this.statuses.get(id))
      : [...this.statuses.values()];
    const live = [];
    for (const record of candidates) {
      if (!record) continue;
      if (record.expiresAt <= now) {
        this.purgeStatus(record);
        continue;
      }
      live.push(record);
    }
    return live.sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteStatus(statusId) {
    const record = this.statuses.get(statusId);
    if (!record) return false;
    this.purgeStatus(record);
    return true;
  }

  /** Returns the viewer count after the write; a repeat view and the author's own are absorbed. */
  async recordStatusView(statusId, viewer, now = Date.now()) {
    const record = await this.getStatus(statusId, now);
    if (!record) return 0;
    if (record.userId === viewer.userId) return record.viewers.length;
    if (!record.viewers.some((entry) => entry.userId === viewer.userId)) {
      record.viewers = [...record.viewers, { userId: viewer.userId, displayName: viewer.displayName, at: now }];
    }
    return record.viewers.length;
  }

  async listStatusViewers(statusId, now = Date.now()) {
    const record = await this.getStatus(statusId, now);
    return record ? record.viewers.map((entry) => ({ ...entry })) : [];
  }
}

module.exports = MemoryStore;
