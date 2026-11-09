'use strict';

const {
  messagesKey,
  seqKey,
  messageRoomKey,
  presenceKey,
  windowKey,
  seenKey,
  deliveredKey,
  mediaKey,
  mediaIndexKey,
  idempotencyKey,
  pollKey,
  noteKey,
  roomSettingsKey,
  roomPasswordKey,
  roomRosterKey,
  blockedKey,
  avatarKey,
  callRecordKey,
  callUserKey,
  statusKey,
  statusUserKey,
  statusActiveKey,
  CALL_HISTORY_MAX,
  CALL_RECORD_TTL_SECONDS,
  STATUS_MAX_PER_USER
} = require('../constants');
const { baseMime } = require('../utils/media');
const { normalizeViewers } = require('../utils/status');
const { requireOptions } = require('./options');

/**
 * Atomic counter that sets the window TTL on the very first increment, so a
 * burst of parallel requests cannot leak an undying key.
 */
const INCR_WITH_TTL = `
local total = redis.call('INCR', KEYS[1])
if total == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return total
`;

/**
 * Read receipts are sets keyed per message; the TTL rides along in the same
 * script so a receipt for a message that already expired cannot outlive it.
 */
const SADD_WITH_TTL = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return added
`;

/**
 * Compare-and-set for a room roster. Two guests can reach an empty seat at the
 * same instant from two replicas, and the loser must be told the seat is full
 * rather than quietly overwrite the winner - which is why the write happens
 * here, behind a version check, and not in application code.
 *
 * Returns 1 when the roster was replaced, 0 when somebody wrote it first, and
 * -1 when there is no roster to compare against any more.
 */
const ROOM_ROSTER_CAS = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return -1
end
if tonumber(cjson.decode(raw).version) ~= tonumber(ARGV[2]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
return 1
`;

class RedisStore {
  constructor(client, {
    messageCacheSize,
    messageHistoryMax,
    messageRetentionSeconds,
    sessionTtlSeconds,
    mediaTtlSeconds = 3600
  }) {
    this.client = client;
    requireOptions('RedisStore', {
      messageCacheSize,
      messageHistoryMax,
      messageRetentionSeconds,
      sessionTtlSeconds,
      mediaTtlSeconds
    });
    /** How far a linear scan may walk: poll lookups and id probes. */
    this.maxMessages = messageCacheSize;
    /** How many rows a room keeps, which is how far history can be paged. */
    this.historyMax = messageHistoryMax;
    /**
     * The life of a room's rows, refreshed on every write. It used to be
     * MESSAGE_CACHE_TTL_S, which let an idle room expire its entire history.
     */
    this.retention = messageRetentionSeconds;
    this.sessionTtl = sessionTtlSeconds;
    this.mediaTtl = mediaTtlSeconds;
    /** Chat settings outlive a message window but must not pile up forever. */
    this.settingsTtl = Math.max(mediaTtlSeconds, sessionTtlSeconds, messageRetentionSeconds, 7 * 24 * 3600);

    client.defineCommand('incrWithTtl', { numberOfKeys: 1, lua: INCR_WITH_TTL });
    client.defineCommand('saddWithTtl', { numberOfKeys: 1, lua: SADD_WITH_TTL });
    client.defineCommand('roomRosterCas', { numberOfKeys: 1, lua: ROOM_ROSTER_CAS });
  }

  async ping() {
    return (await this.client.ping()) === 'PONG';
  }

  /**
   * The sequence is minted by Redis, not by the caller, so two replicas
   * writing at the same instant cannot both claim the next number or order
   * their rows by a clock one of them disagrees with.
   *
   * `seq` is the sort score, so history is ordered by the store's own notion of
   * arrival rather than by the row's timestamp, and a page is a score range.
   */
  async pushMessage(room, message) {
    const key = messagesKey(room);
    const seq = await this.client.incr(seqKey(room));
    const stored = { ...message, seq };

    const multi = this.client.multi();
    multi.zadd(key, seq, JSON.stringify(stored));
    // Ranks are low-to-high, so dropping the front of the set drops the oldest.
    multi.zremrangebyrank(key, 0, -(this.historyMax + 1));
    multi.expire(key, this.retention);
    // The counter expires with the rows it orders: a room nobody writes to for
    // a retention period has lost its history, so restarting at 1 cannot
    // collide with a client that still holds rows.
    multi.expire(seqKey(room), this.retention);
    multi.set(messageRoomKey(stored.id), room, 'EX', this.retention);
    await multi.exec();
    return stored;
  }

  async recentMessages(room, count) {
    return this.historyPage(room, { limit: count });
  }

  /**
   * One page of history, oldest first. `before` is a sequence, so a client that
   * holds a page can ask for the page underneath it instead of being stuck with
   * whatever the top of the room happens to return.
   */
  async historyPage(room, { limit = this.maxMessages, before = null } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || 1, this.historyMax));
    const raw = before === null || before === undefined
      ? await this.client.zrevrange(messagesKey(room), 0, size - 1)
      : await this.client.zrevrangebyscore(messagesKey(room), `(${Number(before)}`, '-inf', 'LIMIT', 0, size);

    const messages = [];
    for (const item of raw) {
      try {
        messages.push(JSON.parse(item));
      } catch {
        // A corrupt entry must never take down history reads.
      }
    }
    return messages.reverse();
  }

  /** The room that owns a message id, or null when this store never saw it. */
  async messageRoom(messageId) {
    return this.client.get(messageRoomKey(messageId));
  }

  async messageRooms(messageIds) {
    const ids = [...messageIds];
    if (ids.length === 0) return new Map();
    const rooms = await this.client.mget(ids.map((id) => messageRoomKey(id)));
    return new Map(ids.map((id, position) => [id, rooms[position] ?? null]));
  }

  /** The users a room holds right now, taken from the presence index. */
  async roomUsers(room, ttlMs, now = Date.now()) {
    const members = await this.client.zrangebyscore(presenceKey(room), now - ttlMs, '+inf');
    if (members.length === 0) return [];
    const meta = await this.client.hmget(`${presenceKey(room)}:meta`, members);
    const users = new Set();
    for (const raw of meta) {
      if (!raw) continue;
      try {
        users.add(JSON.parse(raw).userId);
      } catch {
        // A corrupt presence row cannot name a user.
      }
    }
    return [...users];
  }

  async trackPresence(room, socketId, user, now = Date.now()) {
    const metaField = JSON.stringify({ userId: user.userId, displayName: user.displayName, since: user.since ?? now });
    const multi = this.client.multi();
    multi.zadd(presenceKey(room), now, socketId);
    multi.hset(presenceKey(room) + ':meta', socketId, metaField);
    multi.expire(presenceKey(room) + ':meta', 86400);
    await multi.exec();
  }

  async releasePresence(room, socketId) {
    const multi = this.client.multi();
    multi.zrem(presenceKey(room), socketId);
    multi.hdel(presenceKey(room) + ':meta', socketId);
    await multi.exec();
  }

  async pruneStalePresence(room, ttlMs, now = Date.now()) {
    const key = presenceKey(room);
    const cutoff = now - ttlMs;
    const stale = await this.client.zrangebyscore(key, 0, cutoff);
    if (stale.length === 0) return [];

    const multi = this.client.multi();
    multi.zrem(key, ...stale);
    multi.hdel(`${key}:meta`, ...stale);
    await multi.exec();
    return stale;
  }

  async presenceSnapshot(room, ttlMs, now = Date.now()) {
    const key = presenceKey(room);
    const [members, meta] = await Promise.all([
      this.client.zrangebyscore(key, now - ttlMs, '+inf', 'WITHSCORES'),
      this.client.hgetall(`${key}:meta`)
    ]);

    const users = [];
    for (let i = 0; i < members.length; i += 2) {
      const socketId = members[i];
      const raw = meta[socketId];
      if (!raw) continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      users.push({
        socketId,
        userId: parsed.userId,
        displayName: parsed.displayName,
        since: parsed.since,
        lastSeen: Number(members[i + 1])
      });
    }

    users.sort((a, b) => a.since - b.since);
    return {
      connections: users.length,
      // One person can hold several sockets, so the count is of distinct ids.
      onlineUsers: new Set(users.map((u) => u.userId)).size,
      users
    };
  }

  /** Fixed-window counter. Returns the request ordinal inside the window. */
  async consumeWindow(bucket, limit, windowMs) {
    const total = await this.client.incrWithTtl(windowKey(bucket), windowMs);
    return { total, limit, remaining: Math.max(0, limit - total) };
  }
  async saveSession(session) {
    await this.client.set(`chat:session:${session.userId}`, JSON.stringify(session), 'EX', this.sessionTtl);
    return session;
  }

  async deleteSession(userId) {
    await this.client.del(`chat:session:${userId}`);
  }

  async getSession(userId) {
    const raw = await this.client.get(`chat:session:${userId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      error.message = `Invalid session record for ${userId}: ${error.message}`;
      throw error;
    }
  }

  async getRoomPassword(room) {
    const key = roomPasswordKey(room);
    const raw = await this.client.get(key);
    if (!raw) return null;
    // A room that is being used keeps its secret; one nobody visits for a
    // retention period does not stay in the keyspace for ever. Expiring was
    // never done at all, which is how a shared store grows without bound.
    await this.client.expire(key, this.retention);
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async setRoomPasswordIfAbsent(room, record) {
    return (await this.client.set(roomPasswordKey(room), JSON.stringify(record), 'EX', this.retention, 'NX')) === 'OK';
  }

  /**
   * The roster is the room's whole authorization: whoever holds a seat may
   * read the room and nobody else does. It replaces the older per-user grant
   * keys, which grew one key per joiner and so had no way to express a limit.
   */
  async getRoomRoster(room) {
    const key = roomRosterKey(room);
    const raw = await this.client.get(key);
    if (!raw) return null;
    let roster;
    try {
      roster = JSON.parse(raw);
    } catch {
      return null;
    }
    // Read-with-touch, so a room in use keeps its roster and an abandoned one
    // forgets it exactly like its password record does.
    await this.client.expire(key, this.retention);
    return roster;
  }

  /** The first writer claims the room; everyone after them is told it exists. */
  async createRoomRoster(room, roster) {
    return (await this.client.set(
      roomRosterKey(room),
      JSON.stringify(roster),
      'EX',
      this.retention,
      'NX'
    )) === 'OK';
  }

  async replaceRoomRoster(room, roster, expectedVersion) {
    const written = await this.client.roomRosterCas(
      roomRosterKey(room),
      JSON.stringify(roster),
      expectedVersion,
      this.retention
    );
    if (written === 1) return 'ok';
    return written === -1 ? 'absent' : 'conflict';
  }

  /** Returns true only for the first reader of a given message. */
  async markSeen(messageId, userId) {
    // The receipt lives as long as the row it describes: an hour-long TTL on a
    // message kept for thirty days would quietly drop the ticks.
    const added = await this.client.saddWithTtl(seenKey(messageId), userId, this.retention);
    return added === 1;
  }

  async seenByMessages(messageIds) {
    const entries = await Promise.all(
      messageIds.map(async (id) => [id, await this.client.smembers(seenKey(id))])
    );
    return new Map(entries);
  }

  /** Returns true only for the first receipt this device reports for a message. */
  async markDelivered(messageId, userId) {
    const added = await this.client.saddWithTtl(deliveredKey(messageId), userId, this.retention);
    return added === 1;
  }

  async deliveredByMessages(messageIds) {
    const entries = await Promise.all(
      messageIds.map(async (id) => [id, await this.client.smembers(deliveredKey(id))])
    );
    return new Map(entries);
  }

  async saveMedia(record, { ttlSeconds } = {}) {
    const ttl = Number(ttlSeconds) > 0 ? Number(ttlSeconds) : this.mediaTtl;
    const stored = {
      ...record,
      mime: baseMime(record.mime),
      expiresAt: Date.now() + ttl * 1000
    };
    const multi = this.client.multi();
    multi.set(mediaKey(stored.id), JSON.stringify(stored), 'EX', ttl);
    multi.zadd(mediaIndexKey(), stored.expiresAt, stored.id);
    await multi.exec();
    return stored;
  }

  async getMedia(mediaId) {
    const raw = await this.client.get(mediaKey(mediaId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Which of these attachment ids still resolve to bytes. A message row
   * advertises the files it was sent with and the media record can expire
   * first, so a read has to be able to tell the two apart.
   */
  async mediaExists(mediaIds) {
    const ids = [...mediaIds];
    if (ids.length === 0) return new Map();
    const rows = await this.client.mget(ids.map((id) => mediaKey(id)));
    return new Map(ids.map((id, position) => [id, Boolean(rows[position])]));
  }

  /** The index is needed because Redis expires keys silently. */
  async expiredMedia(now = Date.now(), limit = 100) {
    const ids = await this.client.zrangebyscore(mediaIndexKey(), 0, now, 'LIMIT', 0, limit);
    const records = await Promise.all(ids.map((id) => this.getMedia(id)));
    return records.filter(Boolean);
  }

  async deleteMedia(mediaId) {
    const multi = this.client.multi();
    multi.del(mediaKey(mediaId));
    multi.zrem(mediaIndexKey(), mediaId);
    await multi.exec();
  }

  /**
   * `SET NX` picks the winner without a read-modify-write race, so two
   * replicas replaying the same clientId cannot both store a message.
   */
  async claimSend(userId, clientId, windowMs) {
    const key = idempotencyKey(userId, clientId);
    if (await this.client.set(key, 'pending', 'PX', windowMs, 'NX') === 'OK') {
      return { fresh: true, messageId: null };
    }
    const prior = await this.client.get(key);
    return { fresh: false, messageId: prior && prior !== 'pending' ? prior : null };
  }

  async recordSend(userId, clientId, messageId, windowMs) {
    await this.client.set(idempotencyKey(userId, clientId), messageId, 'PX', windowMs);
  }

  /**
   * A send that failed before it wrote anything has to give its claim back.
   * Without this the retry is absorbed as a duplicate of a message that was
   * never stored, and the client spends the rest of the window believing it
   * already sent.
   */
  async releaseSend(userId, clientId) {
    const key = idempotencyKey(userId, clientId);
    // Only an unanswered claim is dropped: a recorded send keeps absorbing
    // replays for the rest of its window, which is the point of the record.
    if ((await this.client.get(key)) === 'pending') await this.client.del(key);
  }

  async findMessage(room, messageId) {
    const raw = await this.client.zrevrange(messagesKey(room), 0, this.maxMessages - 1);
    for (const item of raw) {
      try {
        const message = JSON.parse(item);
        if (message.id === messageId) return message;
      } catch {
        // A corrupt entry is skipped, not fatal.
      }
    }
    return null;
  }

  /** One hash field per voter: re-voting overwrites, so a tally cannot double count. */
  async castPollVote(messageId, userId, choices, { multiple = false, optionCount = 0 } = {}) {
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
    const multi = this.client.multi();
    multi.hset(pollKey(messageId), userId, JSON.stringify(choices));
    multi.expire(pollKey(messageId), this.retention);
    await multi.exec();
    return this.pollResults(messageId, optionCount);
  }

  async pollResults(messageId, optionCount) {
    const entries = (await this.client.hgetall(pollKey(messageId))) || {};
    const counts = Array.from({ length: optionCount }, () => []);
    for (const [userId, raw] of Object.entries(entries)) {
      let choices;
      try {
        choices = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const choice of choices) {
        if (counts[choice]) counts[choice].push(userId);
      }
    }
    return {
      totalVoters: Object.keys(entries).length,
      options: counts.map((voterIds) => ({ count: voterIds.length, voters: voterIds }))
    };
  }

  /** A note is the user's own text, so it outlives the message window. */
  async saveNote(userId, note) {
    await this.client.set(noteKey(userId), JSON.stringify(note));
    return note;
  }

  async getNote(userId) {
    const raw = await this.client.get(noteKey(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Like the note, the picture pointer outlives the message window. */
  async saveAvatar(userId, avatar) {
    await this.client.set(avatarKey(userId), JSON.stringify(avatar));
    return avatar;
  }

  async getAvatar(userId) {
    const raw = await this.client.get(avatarKey(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async deleteAvatar(userId) {
    await this.client.del(avatarKey(userId));
    return true;
  }

  /**
   * Settings are refreshed on every write, so an active user never loses the
   * list; a guest who abandons a browser leaves nothing behind for ever.
   */
  async getRoomSettings(userId, room) {
    const raw = await this.client.get(roomSettingsKey(userId, room));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async saveRoomSettings(userId, room, settings) {
    await this.client.set(roomSettingsKey(userId, room), JSON.stringify(settings), 'EX', this.settingsTtl);
    return settings;
  }

  async deleteRoomSettings(userId, room) {
    return (await this.client.del(roomSettingsKey(userId, room))) > 0;
  }

  async getBlockedList(userId) {
    const raw = await this.client.get(blockedKey(userId));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async saveBlockedList(userId, entries) {
    await this.client.set(blockedKey(userId), JSON.stringify(entries), 'EX', this.settingsTtl);
    return entries;
  }

  /** Whole-room wipe for a room the viewer owns; receipts go with the messages. */
  async dropRoom(room) {
    const raw = await this.client.zrange(messagesKey(room), 0, -1);
    const ids = [];
    for (const item of raw) {
      try {
        ids.push(JSON.parse(item).id);
      } catch {
        // A corrupt row has no receipts to clean up either.
      }
    }
    const multi = this.client.multi();
    multi.del(messagesKey(room));
    for (const id of ids) {
      multi.del(seenKey(id), deliveredKey(id), pollKey(id), messageRoomKey(id));
    }
    // The sequence counter survives the wipe on purpose: a client that still
    // holds rows from before would file new ones under numbers it has seen.
    await multi.exec();
    return ids.length;
  }

  /* ------------------------------------------------------------------ *
   * Call history (P7). One record per call id plus one sorted set per
   * participant, so both stores answer the same three questions: what
   * happened, who was in it, and whose list is it in.
   * ------------------------------------------------------------------ */

  /**
   * A sorted set is trimmed by dropping its oldest ids rather than by rank, so
   * the cap needs no command beyond the range read that listing already does.
   */
  async trimByScore(key, max) {
    const ids = await this.client.zrangebyscore(key, 0, '+inf');
    if (ids.length > max) await this.client.zrem(key, ...ids.slice(0, ids.length - max));
    return ids;
  }

  async recordCall(entry) {
    const members = (entry.participants || []).filter((p) => p && typeof p.userId === 'string');
    const unique = [...new Set(members.map((p) => p.userId))];

    const multi = this.client.multi();
    multi.set(callRecordKey(entry.id), JSON.stringify(entry), 'EX', CALL_RECORD_TTL_SECONDS);
    for (const userId of unique) multi.zadd(callUserKey(userId), entry.startedAt, entry.id);
    await multi.exec();

    for (const userId of unique) await this.trimByScore(callUserKey(userId), CALL_HISTORY_MAX);
    return entry;
  }

  async getCall(callId) {
    const raw = await this.client.get(callRecordKey(callId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** The index is ordered by start time, so a capped read is the same walk in both stores. */
  async listCalls(userId, limit = CALL_HISTORY_MAX) {
    const ids = await this.client.zrangebyscore(callUserKey(userId), 0, '+inf');
    const records = await Promise.all(ids.map((id) => this.getCall(id)));
    return records
      .filter(Boolean)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  /**
   * Clearing empties this user's list, not the peer's: a record another
   * participant still lists survives, and one nobody lists is dropped here
   * rather than waiting out its thirty days.
   */
  async clearCalls(userId) {
    const key = callUserKey(userId);
    const ids = await this.client.zrangebyscore(key, 0, '+inf');
    if (ids.length === 0) return 0;

    const doomed = [];
    for (const id of ids) {
      const record = await this.getCall(id);
      if (!record) continue;
      const peers = (record.participants || [])
        .map((participant) => participant.userId)
        .filter((participantId) => participantId !== userId);
      const listings = await Promise.all(peers.map((peer) => this.client.zrangebyscore(callUserKey(peer), 0, '+inf')));
      if (!listings.some((listed) => listed.includes(id))) doomed.push(id);
    }

    const multi = this.client.multi();
    multi.zrem(key, ...ids);
    for (const id of doomed) multi.del(callRecordKey(id));
    await multi.exec();
    return ids.length;
  }

  /* ------------------------------------------------------------------ *
   * Statuses (P8). The record carries its own expiry, so an index row that
   * outlives it is a read miss and gets pruned on sight.
   * ------------------------------------------------------------------ */

  async saveStatus(status) {
    const record = { ...status, viewers: normalizeViewers(status) };
    delete record.viewerIds;
    const multi = this.client.multi();
    multi.set(statusKey(record.id), JSON.stringify(record), 'EX', this.ttlUntil(record.expiresAt));
    multi.zadd(statusUserKey(record.userId), record.createdAt, record.id);
    multi.zadd(statusActiveKey(), record.createdAt, record.id);
    await multi.exec();
    await this.trimByScore(statusUserKey(record.userId), STATUS_MAX_PER_USER);
    return record;
  }

  /** Never below a second: a zero EX would drop the card before anyone read it. */
  ttlUntil(expiresAt, now = Date.now()) {
    const seconds = Math.ceil((Number(expiresAt) - now) / 1000);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
  }

  async readStatus(statusId) {
    const raw = await this.client.get(statusKey(statusId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async getStatus(statusId, now = Date.now()) {
    const record = await this.readStatus(statusId);
    if (!record) return null;
    if (record.expiresAt <= now) {
      await this.dropStatus(record);
      return null;
    }
    return record;
  }

  async listStatuses(userId = null, now = Date.now()) {
    const key = userId ? statusUserKey(userId) : statusActiveKey();
    const ids = await this.client.zrangebyscore(key, 0, '+inf');
    const records = await Promise.all(ids.map((id) => this.readStatus(id)));

    const live = [];
    const stale = [];
    records.forEach((record, position) => {
      if (!record || record.expiresAt <= now) stale.push(ids[position]);
      else live.push(record);
    });
    if (stale.length) await this.client.zrem(key, ...stale);
    return live.sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteStatus(statusId) {
    const record = await this.readStatus(statusId);
    if (!record) return false;
    await this.dropStatus(record);
    return true;
  }

  /** Record and both index rows go together, or a later read would resurrect the card. */
  async dropStatus(record) {
    const multi = this.client.multi();
    multi.del(statusKey(record.id));
    multi.zrem(statusUserKey(record.userId), record.id);
    multi.zrem(statusActiveKey(), record.id);
    await multi.exec();
  }

  async recordStatusView(statusId, viewer, now = Date.now()) {
    const record = await this.getStatus(statusId, now);
    if (!record) return 0;
    if (record.userId === viewer.userId) return record.viewers.length;
    if (record.viewers.some((entry) => entry.userId === viewer.userId)) return record.viewers.length;

    const viewers = [...record.viewers, { userId: viewer.userId, displayName: viewer.displayName, at: now }];
    // The rewrite has to carry the remaining life, not a fresh day.
    await this.client.set(statusKey(record.id), JSON.stringify({ ...record, viewers }), 'EX', this.ttlUntil(record.expiresAt, now));
    return viewers.length;
  }

  async listStatusViewers(statusId, now = Date.now()) {
    const record = await this.getStatus(statusId, now);
    return record ? record.viewers.map((entry) => ({ ...entry })) : [];
  }
}

module.exports = RedisStore;
