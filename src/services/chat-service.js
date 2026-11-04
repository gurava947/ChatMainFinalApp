'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const {
  SOCKET_EVENTS,
  PRESENCE_PRUNE_EVERY_MS,
  IDEMPOTENCY_WINDOW_MS,
  MESSAGE_KINDS,
  CHAT_THEMES,
  BLOCKED_MAX,
  HIDDEN_MESSAGES_MAX,
  USERNAME_MAX,
  isSelfRoom,
  selfRoomOwner
} = require('../constants');
const { sanitizeText, sanitizeContent, messageKind } = require('../utils/validate');
const { safeDisplayName } = require('../utils/media');

/** How long a live fan-out may reuse a viewer's block list. */
const BLOCK_CACHE_TTL_MS = 2000;

class ChatService {
  constructor({ store, io, logger, config }) {
    this.store = store;
    this.io = io;
    this.logger = logger;
    this.config = config;
    /** Rooms this replica has at least one socket in; used for presence sweeps. */
    this.activeRooms = new Set();
    this.sweepTimer = null;
    /** viewer id -> { at, ids }: block lists change rarely, live fan-out reads them often. */
    this.blockCache = new Map();
  }

  async createSession(displayName) {
    const now = Date.now();
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const session = {
      userId: crypto.randomUUID(),
      displayName,
      createdAt: now,
      expiresAt: now + this.config.sessionTtlSeconds * 1000,
      sessionTokenHash: crypto.createHash('sha256').update(sessionToken).digest('hex')
    };
    await this.store.saveSession(session);
    return {
      userId: session.userId,
      displayName: session.displayName,
      expiresAt: session.expiresAt,
      sessionToken
    };
  }

  getSession(userId) {
    return this.store.getSession(userId);
  }

  async authenticateSession(userId, sessionToken) {
    const session = await this.getSession(userId);
    if (!session || session.expiresAt <= Date.now() || !/^[a-f\d]{64}$/i.test(session.sessionTokenHash || '')) return null;

    const expected = Buffer.from(session.sessionTokenHash, 'hex');
    const actual = crypto.createHash('sha256').update(sessionToken).digest();
    return crypto.timingSafeEqual(expected, actual) ? session : null;
  }

  async hasRoomAccess(user, room) {
    const owner = selfRoomOwner(room);
    if (owner) return owner === user.userId;
    if (!await this.store.getRoomPassword(room)) {
      return (await this.store.recentMessages(room, 1)).length > 0;
    }
    return this.store.hasRoomAccess(room, user.userId);
  }

  /**
   * Legacy rooms with history stay open. The first guest to enter a new,
   * empty room sets its shared password; later joins must match it exactly.
   */
  async authorizeRoom(user, room, password) {
    const owner = selfRoomOwner(room);
    if (owner) {
      if (owner !== user.userId) throw this.roomAccessError('not_your_room', 403);
      return { legacy: false };
    }

    let record = await this.store.getRoomPassword(room);
    if (record) {
      if (!await this.store.hasRoomAccess(room, user.userId)) {
        const valid = await this.verifyRoomPassword(password, record);
        if (!valid) throw this.roomAccessError(password ? 'invalid_password' : 'room_password_required', 403);
        await this.store.grantRoomAccess(room, user.userId);
      }
      return { legacy: false };
    }

    if ((await this.store.recentMessages(room, 1)).length) return { legacy: true };
    if (!password) throw this.roomAccessError('password_required', 400);

    record = await this.hashRoomPassword(password);
    if (!await this.store.setRoomPasswordIfAbsent(room, record)) {
      const current = await this.store.getRoomPassword(room);
      if (!current || !await this.verifyRoomPassword(password, current)) {
        throw this.roomAccessError('invalid_password', 403);
      }
    }
    await this.store.grantRoomAccess(room, user.userId);
    return { legacy: false };
  }

  async assertRoomAccess(user, room) {
    const owner = selfRoomOwner(room);
    if (owner && owner !== user.userId) throw this.roomAccessError('not_your_room', 403);
    if (owner) return true;
    if (await this.hasRoomAccess(user, room)) return true;
    throw this.roomAccessError('room_password_required', 403);
  }

  roomAccessError(code, statusCode) {
    const error = new Error(code);
    error.code = code;
    error.statusCode = statusCode;
    return error;
  }

  async hashRoomPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    return { salt: salt.toString('hex'), hash: hash.toString('hex') };
  }

  async verifyRoomPassword(password, record) {
    if (typeof password !== 'string' || !/^[a-f\d]{32}$/i.test(record.salt) || !/^[a-f\d]{128}$/i.test(record.hash)) return false;
    const actual = await scrypt(password, Buffer.from(record.salt, 'hex'), 64);
    return crypto.timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
  }

  async joinRoom(socket, room, session) {
    await this.assertRoomAccess(session, room);
    const user = {
      userId: session.userId,
      displayName: session.displayName,
      since: Date.now()
    };
    socket.data.room = room;
    socket.data.user = user;

    await this.store.trackPresence(room, socket.id, user);
    socket.join(room);
    this.activeRooms.add(room);

    const snapshot = await this.presenceSnapshot(room);

    socket.to(room).emit(SOCKET_EVENTS.USER_JOINED, {
      userId: user.userId,
      displayName: user.displayName,
      room,
      at: user.since
    });
    this.io.to(room).emit(SOCKET_EVENTS.PRESENCE, snapshot);

    return snapshot;
  }

  async leaveRoom(socket) {
    const { room, user } = socket.data;
    if (!room || !user) return;

    await this.store.releasePresence(room, socket.id);
    socket.leave(room);

    const snapshot = await this.presenceSnapshot(room);
    this.io.to(room).emit(SOCKET_EVENTS.PRESENCE, snapshot);

    const alreadyGone = !snapshot.users.some((entry) => entry.userId === user.userId);
    if (alreadyGone) {
      socket.to(room).emit(SOCKET_EVENTS.USER_LEFT, {
        userId: user.userId,
        displayName: user.displayName,
        room,
        at: Date.now()
      });
    }
  }

  /**
   * Returns the message the room should hold. `null` means an identical send
   * from this client is still in flight, so the caller must not claim a new
   * message; a returned message with `duplicate` is the one already stored.
   */
  async sendMessage(user, payload) {
    const windowMs = this.config.idempotencyWindowMs || IDEMPOTENCY_WINDOW_MS;
    const clientId = payload.clientId || null;

    if (clientId) {
      const claim = await this.store.claimSend(user.userId, clientId, windowMs);
      if (!claim.fresh) {
        const earlier = claim.messageId ? await this.store.findMessage(payload.room, claim.messageId) : null;
        return earlier ? { ...earlier, duplicate: true } : null;
      }
    }

    const attachments = await this.resolveAttachments(user, payload.attachments);
    const content = sanitizeContent(payload.content);
    const message = {
      id: crypto.randomUUID(),
      room: payload.room,
      userId: user.userId,
      displayName: user.displayName,
      text: sanitizeText(payload.text),
      attachments,
      content,
      kind: messageKind(content),
      clientId,
      ts: Date.now(),
      serverId: this.config.instanceId
    };

    await this.store.pushMessage(payload.room, message);
    if (clientId) await this.store.recordSend(user.userId, clientId, message.id, windowMs);
    // Freshly written: nobody's device has confirmed receipt yet, so the live
    // fanout carries empty receipts and each recipient fills them in.
    await this.emitLiveMessage(payload.room, message);
    return message;
  }

  /**
   * Live fan-out is per socket, so a guest who blocked an author never receives
   * that author's messages on this device — the history filter and the wire now
   * agree. Receipts stay empty because no device has confirmed anything yet.
   */
  async emitLiveMessage(room, message) {
    const payload = { ...message, seenBy: [], deliveredTo: [] };
    const sockets = await this.io.in(room).fetchSockets();
    for (const target of sockets) {
      const viewer = target.data.user;
      if (!viewer || viewer.userId === message.userId) {
        target.emit(SOCKET_EVENTS.NEW_MESSAGE, payload);
        continue;
      }
      if (await this.isBlockedBy(viewer.userId, message.userId)) continue;
      target.emit(SOCKET_EVENTS.NEW_MESSAGE, payload);
    }
  }

  async isBlockedBy(viewerId, authorId) {
    const cached = this.blockCache.get(viewerId);
    if (cached && cached.at + BLOCK_CACHE_TTL_MS > Date.now()) return cached.ids.has(authorId);
    const ids = new Set((await this.store.getBlockedList(viewerId)).map((entry) => entry.userId));
    this.blockCache.set(viewerId, { at: Date.now(), ids });
    return ids.has(authorId);
  }

  /**
   * Attachment metadata is rebuilt from the server-side record, so a client
   * cannot advertise a friendly type for bytes it never uploaded, and cannot
   * point a message at someone else's upload.
   */
  async resolveAttachments(user, requested = []) {
    const reject = (reason) => {
      const error = new Error(reason);
      error.statusCode = 400;
      throw error;
    };

    const attachments = [];
    for (const item of requested) {
      const record = await this.store.getMedia(item.id);
      if (!record) reject(`unknown attachment ${item.id}`);
      if (record.userId !== user.userId) reject('attachment does not belong to the sender');
      attachments.push({
        id: record.id,
        kind: record.kind,
        name: safeDisplayName(record.name),
        mime: record.mime,
        size: record.size
      });
    }
    return attachments;
  }

  /** Poll tallies travel with history, so a rejoin shows live results. */
  async recentMessages(room, limit) {
    const messages = await this.store.recentMessages(room, Math.min(limit, this.config.messageCacheSize));
    const ids = messages.map((message) => message.id);
    const seen = await this.store.seenByMessages(ids);
    const delivered = await this.store.deliveredByMessages(ids);
    return Promise.all(
      messages.map(async (message) => {
        const withSeen = {
          ...message,
          seenBy: seen.get(message.id) || [],
          deliveredTo: delivered.get(message.id) || []
        };
        if (message.kind === MESSAGE_KINDS.POLL && message.content) {
          withSeen.results = await this.store.pollResults(message.id, message.content.options.length);
        }
        return withSeen;
      })
    );
  }

  /**
   * A history read is a delivery in its own right: those bytes reached this
   * device now. The author's own rows are skipped, otherwise a second tab of
   * the sender would tick its own message as delivered to the room.
   */
  async deliverHistory(room, viewer, messages) {
    const newly = [];
    for (const message of messages) {
      if (message.userId === viewer.userId) continue;
      if (await this.store.markDelivered(message.id, viewer.userId)) newly.push(message.id);
    }
    for (const messageId of newly) this.emitDelivered(room, viewer, messageId);
    return newly;
  }

  /**
   * The one read path that both the HTTP history route and socket joins use, so
   * opening a room always leaves a genuine delivery receipt behind. A viewer's
   * own settings are applied first: a message they blocked, deleted or cleared
   * away is not something this device received, so it earns no receipt either.
   */
  async readHistory(room, viewer, limit) {
    const [messages, settings] = await Promise.all([
      this.recentMessages(room, limit),
      this.roomSettings(viewer, room)
    ]);
    const visible = this.filterForViewer(messages, settings);
    const newly = await this.deliverHistory(room, viewer, visible);
    if (!newly.length) return visible;
    const justDelivered = new Set(newly);
    return visible.map((message) =>
      justDelivered.has(message.id)
        ? { ...message, deliveredTo: [...(message.deliveredTo || []), viewer.userId] }
        : message
    );
  }

  emitDelivered(room, user, messageId) {
    this.io.to(room).emit(SOCKET_EVENTS.MESSAGE_DELIVERED, {
      messageId,
      userId: user.userId,
      displayName: user.displayName,
      room,
      at: Date.now()
    });
  }

  /**
   * Attachments are read back out of the message window instead of a second
   * index, so the library can never advertise a file that no message points at.
   */
  async mediaLibrary(room, limit = 200) {
    const messages = await this.store.recentMessages(room, Math.min(limit, this.config.messageCacheSize));
    const items = [];
    for (const message of messages) {
      for (const attachment of message.attachments || []) {
        items.push({
          ...attachment,
          messageId: message.id,
          kind: attachment.kind,
          ts: message.ts,
          senderId: message.userId,
          sender: message.displayName
        });
      }
    }
    return items;
  }

  /**
   * Receipts are recorded once per reader, so only genuinely new reads are
   * broadcast; a client that re-sends the same ids costs nothing on the wire.
   */
  async markSeen(socket, messageIds) {
    const { room, user } = socket.data;
    if (!room || !user) return [];

    const at = Date.now();
    const newlySeen = [];
    for (const messageId of messageIds) {
      if (await this.store.markSeen(messageId, user.userId)) newlySeen.push(messageId);
      // A read implies the message reached the device, so clients that only
      // report reads still move the sender's tick past "delivered".
      if (await this.store.markDelivered(messageId, user.userId)) this.emitDelivered(room, user, messageId);
    }

    for (const messageId of newlySeen) {
      socket.to(room).emit(SOCKET_EVENTS.MESSAGE_SEEN, {
        messageId,
        userId: user.userId,
        displayName: user.displayName,
        room,
        at
      });
    }
    return newlySeen;
  }

  /**
   * Delivery is reported by the receiving device rather than inferred from
   * presence: an online socket says nothing about a message reaching it.
   */
  async markDelivered(socket, messageIds) {
    const { room, user } = socket.data;
    if (!room || !user) return [];

    const newly = [];
    for (const messageId of messageIds) {
      if (await this.store.markDelivered(messageId, user.userId)) newly.push(messageId);
    }
    for (const messageId of newly) this.emitDelivered(room, user, messageId);
    return newly;
  }

  presenceSnapshot(room) {
    return this.store.presenceSnapshot(room, this.config.presenceTtlMs);
  }

  /**
   * A vote is only valid for a poll the voter can actually see in their room,
   * so the message is looked up rather than trusted from the client.
   */
  async votePoll(socket, { messageId, choices }) {
    const room = socket.data.room;
    const user = socket.data.user;
    if (!room || !user) {
      const error = new Error('join a room first');
      error.statusCode = 400;
      throw error;
    }

    const message = await this.store.findMessage(room, messageId);
    if (!message || message.kind !== MESSAGE_KINDS.POLL || !message.content) {
      const error = new Error('no such poll in this room');
      error.statusCode = 404;
      throw error;
    }

    const results = await this.store.castPollVote(messageId, user.userId, choices, {
      multiple: message.content.multiple,
      optionCount: message.content.options.length
    });

    const payload = {
      messageId,
      room,
      userId: user.userId,
      displayName: user.displayName,
      choices,
      at: Date.now(),
      results
    };
    this.io.to(room).emit(SOCKET_EVENTS.POLL_VOTED, payload);
    return payload;
  }

  async pollResults(messageId, optionCount) {
    return this.store.pollResults(messageId, optionCount);
  }

  /** The note is the user's own text, readable only through their session. */
  async setNote(user, text) {
    const note = { text, updatedAt: Date.now() };
    await this.store.saveNote(user.userId, note);
    return note;
  }

  async getNote(user) {
    return this.store.getNote(user.userId);
  }

  /**
   * Chat settings belong to the viewer, never to the room: one guest's block
   * list, cleared history or palette must not change what anybody else sees.
   */
  async roomSettings(user, room) {
    const [blocked, stored] = await Promise.all([
      this.store.getBlockedList(user.userId),
      this.store.getRoomSettings(user.userId, room)
    ]);
    return {
      blocked,
      clearedAt: Number(stored?.clearedAt) || 0,
      theme: CHAT_THEMES.includes(stored?.theme) ? stored.theme : 'default',
      hidden: Array.isArray(stored?.hidden) ? stored.hidden : []
    };
  }

  /** The block list only ever hides the room from the guest who set it. */
  async blockUser(user, targetUserId, displayName) {
    if (targetUserId === user.userId) {
      const error = new Error('you cannot block your own session');
      error.statusCode = 400;
      throw error;
    }
    const current = await this.store.getBlockedList(user.userId);
    if (current.some((entry) => entry.userId === targetUserId)) return current;
    const name = sanitizeText(displayName || '').slice(0, USERNAME_MAX);
    const next = [{ userId: targetUserId, displayName: name, blockedAt: Date.now() }, ...current]
      .filter((entry) => entry && typeof entry.userId === 'string')
      .slice(0, BLOCKED_MAX);
    const saved = await this.store.saveBlockedList(user.userId, next);
    this.blockCache.delete(user.userId);
    return saved;
  }

  async unblockUser(user, targetUserId) {
    const current = await this.store.getBlockedList(user.userId);
    const next = current.filter((entry) => entry.userId !== targetUserId);
    if (next.length === current.length) return current;
    const saved = await this.store.saveBlockedList(user.userId, next);
    this.blockCache.delete(user.userId);
    return saved;
  }

  async setRoomTheme(user, room, theme) {
    const settings = await this.roomSettings(user, room);
    return this.store.saveRoomSettings(user.userId, room, { ...settings, theme });
  }

  /** Clearing is a watermark, not a delete: the room itself keeps its history. */
  async clearRoomForViewer(user, room) {
    const settings = await this.roomSettings(user, room);
    return this.store.saveRoomSettings(user.userId, room, { ...settings, clearedAt: Date.now(), hidden: [] });
  }

  /** Deleting "for me" is a per-viewer id list, so one guest cannot erase another's history. */
  async hideMessagesForViewer(user, room, messageIds) {
    const settings = await this.roomSettings(user, room);
    const merged = [...new Set([...settings.hidden, ...messageIds])].slice(-HIDDEN_MESSAGES_MAX);
    return this.store.saveRoomSettings(user.userId, room, { ...settings, hidden: merged });
  }

  async unhideMessagesForViewer(user, room, messageIds) {
    const settings = await this.roomSettings(user, room);
    const dropped = new Set(messageIds);
    return this.store.saveRoomSettings(user.userId, room, {
      ...settings,
      hidden: settings.hidden.filter((id) => !dropped.has(id))
    });
  }

  /**
   * "Delete chat" for a shared room is the viewer's own copy: settings dropped and
   * history forgotten on this device. Only a self room, which one session owns,
   * can be emptied for everyone, and that is exactly what this does.
   */
  async deleteRoomForViewer(user, room) {
    await this.store.deleteRoomSettings(user.userId, room);
    if (!isSelfRoom(room) || selfRoomOwner(room) !== user.userId) {
      return { deleted: false, selfRoom: false };
    }
    const removed = await this.store.dropRoom(room);
    return { deleted: true, selfRoom: true, removed };
  }

  /** The single filter that decides which stored rows a given viewer may see. */
  filterForViewer(messages, settings) {
    const blocked = new Set((settings.blocked || []).map((entry) => entry.userId));
    const hidden = new Set(settings.hidden || []);
    const clearedAt = Number(settings.clearedAt) || 0;
    return messages.filter((message) =>
      !hidden.has(message.id) &&
      !blocked.has(message.userId) &&
      (!clearedAt || Number(message.ts) > clearedAt)
    );
  }

  async heartbeat(socket) {
    if (!socket.data.room || !socket.data.user) return;
    await this.store.trackPresence(socket.data.room, socket.id, socket.data.user);
  }

  emitTyping(socket, isTyping) {
    socket.to(socket.data.room).emit(isTyping ? SOCKET_EVENTS.TYPING : SOCKET_EVENTS.STOP_TYPING, {
      userId: socket.data.user.userId,
      displayName: socket.data.user.displayName,
      room: socket.data.room
    });
  }

  startSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepStalePresence().catch((err) => {
      this.logger.error({ err }, 'presence sweep failed');
    }), PRESENCE_PRUNE_EVERY_MS);
    this.sweepTimer.unref();
  }

  /**
   * Pods that crash never fire `disconnect`, so their presence entries expire
   * by TTL and are removed here. Live sockets refresh their score on the
   * heartbeat, which keeps them out of the stale set.
   */
  async sweepStalePresence() {
    const now = Date.now();
    for (const room of this.activeRooms) {
      const removed = await this.store.pruneStalePresence(room, this.config.presenceTtlMs, now);
      if (removed.length === 0) continue;
      const snapshot = await this.presenceSnapshot(room);
      this.io.to(room).emit(SOCKET_EVENTS.PRESENCE, snapshot);
      this.logger.debug({ room, removed: removed.length }, 'pruned stale presence');
      if (snapshot.connections === 0) this.activeRooms.delete(room);
    }
  }

  stopSweep() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

module.exports = ChatService;
