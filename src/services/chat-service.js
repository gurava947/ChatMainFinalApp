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
  HISTORY_PAGE_SIZE,
  HISTORY_PAGE_MAX,
  userRoom,
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

  /**
   * A socket outlives the session that opened it, and until now nothing on the
   * wire noticed: a session that expired or was replaced kept streaming room
   * data through a connection that had no claim to it. The token is still on
   * the handshake, so revalidating costs one shared-store read.
   */
  async revalidateSocket(socket) {
    const userId = socket.data.user && socket.data.user.userId;
    if (!userId) return false;
    return Boolean(await this.authenticateSession(userId, socket.handshake.auth && socket.handshake.auth.sessionToken));
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
    // The personal room is what makes a per-viewer fan-out work across
    // replicas; it is joined here as well as at connect so a socket that
    // resumed with a restored session still carries it.
    socket.join(userRoom(user.userId));
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

    let message;
    try {
      const attachments = await this.resolveAttachments(user, payload.attachments);
      const content = sanitizeContent(payload.content);
      message = {
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

      // Re-reading what was written would cost a round trip; what matters is
      // that the row going out below carries the sequence the store minted, so
      // a live message sorts against history by the same token rather than by a
      // clock two replicas may not agree on.
      message = await this.store.pushMessage(payload.room, message);
      if (clientId) await this.store.recordSend(user.userId, clientId, message.id, windowMs);
    } catch (err) {
      // A send that stored nothing has to give its claim back, or every retry
      // of this clientId is absorbed as a duplicate of a message that does not
      // exist and the client waits out the whole window believing it sent.
      if (clientId) await this.store.releaseSend(user.userId, clientId);
      throw err;
    }

    // Freshly written: nobody's device has confirmed receipt yet, so the live
    // fanout carries empty receipts and each recipient fills them in.
    await this.emitLiveMessage(payload.room, message);
    return message;
  }

  /**
   * Live fan-out has to survive more than one replica, so it is expressed in
   * rooms the redis adapter shares rather than in socket handles, which only
   * ever exist on the process that holds them.
   *
   * `io.to(room)` reaches every member on every replica; each socket also sits
   * in a personal room, so the per-viewer block filter is applied by excluding
   * those personal rooms instead of by walking sockets one at a time. A guest
   * who blocked the author never receives that author's messages on any device,
   * and history and the wire agree on it.
   */
  async emitLiveMessage(room, message) {
    const payload = { ...message, seenBy: [], deliveredTo: [] };
    const viewers = await this.store.roomUsers(room, this.config.presenceTtlMs);

    const muted = [];
    for (const userId of viewers) {
      if (userId === message.userId) continue;
      if (await this.isBlockedBy(userId, message.userId)) muted.push(userRoom(userId));
    }

    const operator = muted.length ? this.io.to(room).except(muted) : this.io.to(room);
    operator.emit(SOCKET_EVENTS.NEW_MESSAGE, payload);
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

  /**
   * Poll tallies travel with history, so a rejoin shows live results. Receipts
   * come from the same shared indexes in both store modes, and an attachment
   * that outlived its bytes is marked expired instead of silently 404ing later.
   */
  async recentMessages(room, limit, before = null) {
    return this.historyPage(room, { limit, before });
  }

  /**
   * One page, oldest first, addressed by the store's own sequence: a client
   * holding a page can ask for the page underneath it instead of being stuck
   * with whatever sits at the top of the room.
   */
  async historyPage(room, { limit = HISTORY_PAGE_SIZE, before = null } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || HISTORY_PAGE_SIZE, HISTORY_PAGE_MAX));
    const messages = await this.store.historyPage(room, { limit: size, before });
    const ids = messages.map((message) => message.id);
    const mediaIds = messages.flatMap((message) => (message.attachments || []).map((item) => item.id));
    const [seen, delivered, liveMedia] = await Promise.all([
      this.store.seenByMessages(ids),
      this.store.deliveredByMessages(ids),
      this.store.mediaExists(mediaIds)
    ]);

    return Promise.all(messages.map(async (message) => {
      const row = {
        ...message,
        seenBy: seen.get(message.id) || [],
        deliveredTo: delivered.get(message.id) || [],
        attachments: (message.attachments || []).map((item) => ({ ...item, expired: !liveMedia.get(item.id) }))
      };
      if (message.kind === MESSAGE_KINDS.POLL && message.content) {
        row.results = await this.store.pollResults(message.id, message.content.options.length);
      }
      return row;
    }));
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
    this.emitDelivered(room, viewer, newly);
    return newly;
  }

  /**
   * The one read path that both the HTTP history route and socket joins use, so
   * opening a room always leaves a genuine delivery receipt behind. A viewer's
   * own settings are applied first: a message they blocked, deleted or cleared
   * away is not something this device received, so it earns no receipt either.
   */
  async readHistory(room, viewer, { limit = HISTORY_PAGE_SIZE, before = null } = {}) {
    const [messages, settings] = await Promise.all([
      this.historyPage(room, { limit, before }),
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

  /**
   * A page of history reaching a device is one event, not one per row: before
   * this, a rejoin spent a whole page of broadcasts on receipts the sender
   * could have taken from the page itself.
   */
  emitDelivered(room, user, messageIds) {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    if (ids.length === 0) return;
    const at = Date.now();
    if (ids.length === 1) {
      this.io.to(room).emit(SOCKET_EVENTS.MESSAGE_DELIVERED, {
        messageId: ids[0],
        userId: user.userId,
        displayName: user.displayName,
        room,
        at
      });
      return;
    }
    this.io.to(room).emit(SOCKET_EVENTS.MESSAGES_DELIVERED, {
      messageIds: ids,
      userId: user.userId,
      displayName: user.displayName,
      room,
      at
    });
  }

  /**
   * Attachments are read back out of the message window instead of a second
   * index, so the library can never advertise a file that no message points at.
   * `expired` is the other half of that promise: a row can outlive its bytes.
   */
  async mediaLibrary(room, limit = HISTORY_PAGE_MAX) {
    const messages = await this.store.historyPage(room, { limit: Math.min(limit, HISTORY_PAGE_MAX) });
    const live = await this.store.mediaExists(
      messages.flatMap((message) => (message.attachments || []).map((item) => item.id))
    );
    const items = [];
    for (const message of messages) {
      for (const attachment of message.attachments || []) {
        items.push({
          ...attachment,
          expired: !live.get(attachment.id),
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
   *
   * An id is only credited to the room the socket is standing in: a client that
   * guessed (or kept) an id from another room could otherwise mark messages it
   * never received as read and delivered.
   */
  async markSeen(socket, messageIds) {
    const { room, user } = socket.data;
    if (!room || !user) return [];

    const at = Date.now();
    const { newlySeen, newlyDelivered } = await this.recordReceipts(room, user, messageIds, { seen: true });

    for (const messageId of newlySeen) {
      socket.to(room).emit(SOCKET_EVENTS.MESSAGE_SEEN, {
        messageId,
        userId: user.userId,
        displayName: user.displayName,
        room,
        at
      });
    }
    // A read implies the message reached the device, so clients that only
    // report reads still move the sender's tick past "delivered".
    this.emitDelivered(room, user, newlyDelivered);
    return newlySeen;
  }

  /**
   * Delivery is reported by the receiving device rather than inferred from
   * presence: an online socket says nothing about a message reaching it.
   */
  async markDelivered(socket, messageIds) {
    const { room, user } = socket.data;
    if (!room || !user) return [];

    const { newlyDelivered } = await this.recordReceipts(room, user, messageIds, { seen: false });
    this.emitDelivered(room, user, newlyDelivered);
    return newlyDelivered;
  }

  /**
   * Shared receipt path: keep only the ids this room actually owns, then write.
   * Returns the ids credited for the first time, so a repeat report is silent.
   */
  async recordReceipts(room, user, messageIds, { seen }) {
    const ids = [...new Set(messageIds)];
    const owners = await this.store.messageRooms(ids);
    const mine = ids.filter((id) => owners.get(id) === room);

    const newlySeen = [];
    const newlyDelivered = [];
    for (const messageId of mine) {
      if (seen && await this.store.markSeen(messageId, user.userId)) newlySeen.push(messageId);
      if (await this.store.markDelivered(messageId, user.userId)) newlyDelivered.push(messageId);
    }
    return { newlySeen, newlyDelivered };
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
