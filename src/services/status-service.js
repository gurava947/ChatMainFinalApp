'use strict';

const crypto = require('node:crypto');
const {
  SOCKET_EVENTS,
  STATUS_TTL_SECONDS,
  STATUS_MAX_PER_USER,
  STATUS_TEXT_MAX_CHARS
} = require('../constants');
const { sanitizeText } = require('../utils/validate');

function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * A status is one card that lives for a day: a sentence on a colour from the
 * palette, or a single piece of media the author already uploaded. Media keeps
 * travelling through the existing capability URL, so nothing here re-implements
 * delivery — only the card and who looked at it are new.
 */
function createStatusService({ store, media, profile, io }) {
  async function dropMedia(mediaId) {
    if (!mediaId) return;
    if (media) await media.unlinkQuietly(mediaId);
    await store.deleteMedia(mediaId);
  }

  function broadcast(event, payload) {
    if (io) io.emit(event, payload);
  }

  /** The author's live name and picture come from the profile service, not a copy. */
  async function authorsOf(records) {
    const ids = [...new Set(records.map((record) => record.userId))];
    if (!profile || ids.length === 0) return new Map();
    const rows = await profile.profilesFor(ids);
    return new Map(rows.map((row) => [row.userId, row]));
  }

  async function decorate(records, viewerId, now = Date.now()) {
    const authors = await authorsOf(records);
    const mediaRecords = await Promise.all(
      records.map((record) => (record.mediaId ? store.getMedia(record.mediaId) : null))
    );

    return records.map((record, position) => {
      const found = mediaRecords[position];
      const author = authors.get(record.userId);
      return {
        id: record.id,
        kind: record.kind,
        text: record.text,
        color: record.color,
        // A card whose file has already been swept reads as media with nothing to
        // show, so the row says so instead of pointing at a dead URL.
        media: found ? { id: found.id, url: `/media/${found.id}`, mime: found.mime, name: found.name } : null,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        remainingMs: Math.max(0, record.expiresAt - now),
        author: {
          userId: record.userId,
          displayName: author?.displayName || record.displayName,
          avatar: author?.avatar ? { url: author.avatar.url } : null
        },
        mine: record.userId === viewerId,
        viewedByMe: record.viewers.some((entry) => entry.userId === viewerId),
        viewerCount: record.viewers.length
      };
    });
  }

  async function post(user, payload) {
    const active = await store.listStatuses(user.userId);
    if (active.length >= STATUS_MAX_PER_USER) {
      throw fail(`only ${STATUS_MAX_PER_USER} active statuses at a time`, 429);
    }

    const createdAt = Date.now();
    const card = {
      id: crypto.randomUUID(),
      userId: user.userId,
      displayName: user.displayName,
      createdAt,
      expiresAt: createdAt + STATUS_TTL_SECONDS * 1000,
      viewerIds: []
    };

    if (payload.kind === 'text') {
      const text = sanitizeText(payload.text).slice(0, STATUS_TEXT_MAX_CHARS);
      if (!text) throw fail('status text became empty after sanitising', 400);
      const saved = await store.saveStatus({ ...card, kind: 'text', text, color: payload.color, mediaId: null });
      broadcast(SOCKET_EVENTS.STATUS_CREATED, publiclyCreated(saved));
      return (await decorate([saved], user.userId))[0];
    }

    const record = await store.getMedia(payload.mediaId);
    if (!record) throw fail('unknown media id', 400);
    if (record.userId !== user.userId) throw fail('media does not belong to this session', 400);
    if (record.kind !== payload.kind) throw fail(`status media must be ${payload.kind}`, 400);

    const saved = await store.saveStatus({
      ...card,
      kind: payload.kind,
      text: '',
      color: null,
      mediaId: record.id
    });
    broadcast(SOCKET_EVENTS.STATUS_CREATED, publiclyCreated(saved));
    return (await decorate([saved], user.userId))[0];
  }

  function publiclyCreated(record) {
    return {
      id: record.id,
      author: { userId: record.userId, displayName: record.displayName },
      kind: record.kind,
      createdAt: record.createdAt
    };
  }

  async function listFor(viewer) {
    const now = Date.now();
    return decorate(await store.listStatuses(null, now), viewer.userId, now);
  }

  async function remove(user, statusId) {
    const record = await store.getStatus(statusId);
    if (!record) return { removed: false };
    if (record.userId !== user.userId) throw fail('not your status', 403);

    await store.deleteStatus(statusId);
    await dropMedia(record.mediaId);
    broadcast(SOCKET_EVENTS.STATUS_REMOVED, publiclyCreated(record));
    return { removed: true };
  }

  async function view(user, statusId) {
    if (!(await store.getStatus(statusId))) throw fail('status_not_found', 404);
    const count = await store.recordStatusView(statusId, { userId: user.userId, displayName: user.displayName });
    return { viewers: count };
  }

  /** Who looked is the author's own data; nobody else may read the list. */
  async function viewers(user, statusId) {
    const record = await store.getStatus(statusId);
    if (!record) throw fail('status_not_found', 404);
    if (record.userId !== user.userId) throw fail('not your status', 403);
    return store.listStatusViewers(statusId);
  }

  return { post, listFor, remove, view, viewers };
}

module.exports = { createStatusService };
