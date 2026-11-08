'use strict';

const express = require('express');
const { z } = require('zod');
const {
  parse,
  joinPayloadSchema,
  roomSchema,
  postMessageSchema,
  noteSchema,
  blockTargetSchema,
  roomThemeSchema,
  roomCredentialSchema,
  hideIdsSchema,
  historyQuerySchema,
  profileIdsSchema,
  statusSchema,
  sanitizeText
} = require('../utils/validate');
const { SOCKET_EVENTS, selfRoom } = require('../constants');
const { mediaUploadRouter } = require('./media');
const { createProfileService } = require('../services/profile-service');
const { createCallService } = require('../services/call-service');
const { createStatusService } = require('../services/status-service');
const { createIceServers } = require('../utils/rtc-config');

const sessionHeaderSchema = z.string().uuid();
const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

function requireSession({ chat }) {
  return async function middleware(req, res, next) {
    try {
      const sessionId = sessionHeaderSchema.parse(req.get('x-session-id'));
      const sessionToken = sessionTokenSchema.parse(req.get('x-session-token'));
      const session = await chat.authenticateSession(sessionId, sessionToken);
      if (!session) {
        return res.status(401).json({ error: 'invalid_session' });
      }
      req.session = session;
      return next();
    } catch {
      return res.status(401).json({ error: 'invalid_session' });
    }
  };
}

function apiRouter({ chat, store, limiters, media, logger, io, env }) {
  const router = express.Router();
  /** Profiles need the media plumbing, so without an upload service there is no picture to set. */
  const profile = media ? createProfileService({ store, media, chat }) : null;
  const calls = createCallService({ store, logger });
  const statuses = createStatusService({ store, media, chat, profile, io });

  router.post('/sessions', limiters.sessions, async (req, res, next) => {
    try {
      const { displayName } = parse(joinPayloadSchema.pick({ displayName: true }), req.body);
      const session = await chat.createSession(displayName);
      res.status(201).json({
        userId: session.userId,
        displayName: session.displayName,
        expiresAt: session.expiresAt,
        sessionToken: session.sessionToken
      });
    } catch (err) {
      next(err);
    }
  });

  const guard = requireSession({ chat });

  router.get('/rtc-config', guard, limiters.reads, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ iceServers: createIceServers({
      turnUrls: env.TURN_URLS,
      turnSharedSecret: env.TURN_SHARED_SECRET,
      userId: req.session.userId
    }) });
  });

  router.get('/rooms/:room/access', guard, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      return res.json({ authorized: await chat.hasRoomAccess(req.session, room) });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * Seat state for the member who asks, and nothing to anybody else: a
   * non-member gets the same 403 they get for reading the room, so this cannot
   * be used to survey which room ids are in use.
   */
  router.get('/rooms/:room/roster', guard, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      return res.json(await chat.roomRoster(req.session, room));
    } catch (err) {
      return next(err);
    }
  });

  /** The code is handed out once, at the claim, so the owner needs a way to get another. */
  router.post('/rooms/:room/invite', guard, limiters.writes, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      return res.json(await chat.rotateRoomInvite(req.session, room));
    } catch (err) {
      return next(err);
    }
  });

  router.post('/rooms/:room/access', guard, limiters.writes, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      const { credential } = parse(roomCredentialSchema, req.body);
      const result = await chat.authorizeRoom(req.session, room, credential);
      return res.json({
        authorized: true,
        role: result.role,
        legacy: Boolean(result.legacy),
        // Present exactly once, for the member who just claimed the room. The
        // hash is on the server and a later join is refused without the code,
        // so nobody else's response ever carries it.
        inviteCode: result.inviteCode ?? null
      });
    } catch (err) {
      return next(err);
    }
  });

  /** Multipart uploads ride the same session guard as everything else. */
  if (media) router.use('/media', guard, mediaUploadRouter({ media, limiters }));

  /** Lets a returning client reuse its cached session instead of minting a new identity. */
  router.get('/sessions/:userId', guard, async (req, res, next) => {
    try {
      const userId = sessionHeaderSchema.parse(req.params.userId);
      if (userId !== req.session.userId) return res.status(404).json({ error: 'unknown_session' });
      return res.json({
        userId: req.session.userId,
        displayName: req.session.displayName,
        expiresAt: req.session.expiresAt
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/rooms/:room/messages', guard, limiters.reads, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      const { limit, before } = parse(historyQuerySchema, req.query);
      const messages = await chat.readHistory(room, req.session, { limit, before });
      res.json({ room, messages });
    } catch (err) {
      next(err);
    }
  });

  /** Flat attachment list; the client splits it into Recents / Media / Folders. */
  router.get('/rooms/:room/media', guard, limiters.reads, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      res.json({ room, items: await chat.mediaLibrary(room) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/rooms/:room/presence', guard, limiters.reads, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      res.json({ room, ...(await chat.presenceSnapshot(room)) });
    } catch (err) {
      next(err);
    }
  });

  /** Escape hatch for tests and ops tooling; mirrors the socket write path. */
  router.post('/rooms/:room/messages', guard, limiters.writes, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      const payload = parse(postMessageSchema, req.body);
      const stored = await chat.sendMessage(req.session, { room, ...payload });
      if (!stored) return res.status(200).json({ duplicate: true });
      return res.status(stored.duplicate ? 200 : 201).json(stored);
    } catch (err) {
      return next(err);
    }
  });

  /** The room a user can only ever share with themselves. */
  router.get('/me/self', guard, (req, res) => {
    res.json({ room: selfRoom(req.session.userId), displayName: req.session.displayName });
  });

  router.get('/me/note', guard, async (req, res, next) => {
    try {
      res.json({ note: (await chat.getNote(req.session)) || { text: '', updatedAt: null } });
    } catch (err) {
      next(err);
    }
  });

  router.put('/me/note', guard, limiters.writes, async (req, res, next) => {
    try {
      const { text } = parse(noteSchema, req.body);
      const note = await chat.setNote(req.session, sanitizeText(text));
      res.json({ note });
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------------------------------------------ *
   * Profile (P3). Your name, your note and one picture, plus a capped
   * batch read so a room can draw sender avatars. The picture is ordinary
   * media with a longer lifetime; everything else is the same session the
   * rest of the app already authenticates with.
   * ------------------------------------------------------------------ */

  router.get('/me/profile', guard, async (req, res, next) => {
    try {
      if (!profile) return res.status(503).json({ error: 'media_unavailable' });
      res.json({ profile: await profile.myProfile(req.session) });
    } catch (err) {
      next(err);
    }
  });

  if (profile) {
    /** Multer parses the multipart body, then the service keeps the image only. */
    router.put('/me/avatar', guard, limiters.uploads, media.handleUpload, async (req, res, next) => {
      try {
        const avatar = await profile.setAvatar(req.session, req.mediaRecords);
        res.status(201).json({ avatar });
      } catch (err) {
        next(err);
      }
    });

    router.delete('/me/avatar', guard, limiters.writes, async (req, res, next) => {
      try {
        res.json(await profile.removeAvatar(req.session));
      } catch (err) {
        next(err);
      }
    });
  }

  router.get('/profiles', guard, limiters.reads, async (req, res, next) => {
    try {
      if (!profile) return res.status(503).json({ error: 'media_unavailable' });
      const ids = parse(profileIdsSchema, String(req.query.ids || ''));
      res.json({ profiles: await profile.profilesFor(ids) });
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------------------------------------------ *
   * Chat settings (P2). Everything here is per viewer: blocking, clearing
   * and deleting only ever change what this guest sees, so no route can
   * touch another guest's history. A shared room can be hidden from one
   * device; only a self room, which a session owns, is emptied outright.
   * ------------------------------------------------------------------ */

  router.get('/me/blocks', guard, async (req, res, next) => {
    try {
      res.json({ blocked: await store.getBlockedList(req.session.userId) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/me/blocks', guard, limiters.writes, async (req, res, next) => {
    try {
      const { userId, displayName } = parse(blockTargetSchema, req.body);
      const blocked = await chat.blockUser(req.session, userId, displayName);
      res.status(201).json({ blocked });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/me/blocks/:userId', guard, limiters.writes, async (req, res, next) => {
    try {
      const userId = z.string().uuid().parse(req.params.userId);
      const blocked = await chat.unblockUser(req.session, userId);
      res.json({ blocked });
    } catch (err) {
      next(err);
    }
  });

  router.get('/rooms/:room/settings', guard, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      res.json(await chat.roomSettings(req.session, room));
    } catch (err) {
      next(err);
    }
  });

  router.put('/rooms/:room/settings/theme', guard, limiters.writes, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      const { theme } = parse(roomThemeSchema, req.body);
      const settings = await chat.setRoomTheme(req.session, room, theme);
      res.json({ ...settings, theme });
    } catch (err) {
      next(err);
    }
  });

  router.post('/rooms/:room/clear', guard, limiters.writes, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      const settings = await chat.clearRoomForViewer(req.session, room);
      res.json({ ...settings, clearedAt: settings.clearedAt, hidden: [] });
    } catch (err) {
      next(err);
    }
  });

  router.post('/rooms/:room/messages/hide', guard, limiters.writes, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      const { ids } = parse(hideIdsSchema, req.body);
      const settings = await chat.hideMessagesForViewer(req.session, room, ids);
      res.json({ hidden: settings.hidden });
    } catch (err) {
      next(err);
    }
  });

  router.post('/rooms/:room/messages/unhide', guard, limiters.writes, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      const { ids } = parse(hideIdsSchema, req.body);
      const settings = await chat.unhideMessagesForViewer(req.session, room, ids);
      res.json({ hidden: settings.hidden });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/rooms/:room', guard, limiters.writes, async (req, res, next) => {
    try {
      const room = parse(roomSchema, req.params.room);
      await chat.assertRoomAccess(req.session, room);
      const result = await chat.deleteRoomForViewer(req.session, room);
      res.json({ room, ...result });
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------------------------------------------ *
   * Call history (P7). The record is written by the signalling sockets and
   * read back here, so a guest who closed the tab can still see the call they
   * missed. Only the viewer's own rows are ever listed or cleared.
   * ------------------------------------------------------------------ */

  router.get('/calls', guard, limiters.reads, async (req, res, next) => {
    try {
      res.json({ calls: await calls.listFor(req.session.userId) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/calls', guard, limiters.writes, async (req, res, next) => {
    try {
      res.json(await calls.clear(req.session.userId));
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------------------------------------------ *
   * Statuses (P8). One card per day, readable by every guest in the app and
   * gone twenty-four hours after it was posted, whatever the sweep does.
   * ------------------------------------------------------------------ */

  router.get('/statuses', guard, limiters.reads, async (req, res, next) => {
    try {
      res.json({ statuses: await statuses.listFor(req.session) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/statuses', guard, limiters.writes, async (req, res, next) => {
    try {
      const payload = parse(statusSchema, req.body);
      res.status(201).json(await statuses.post(req.session, payload));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/statuses/:id', guard, limiters.writes, async (req, res, next) => {
    try {
      const id = parse(z.string().uuid(), req.params.id);
      res.json(await statuses.remove(req.session, id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/statuses/:id/view', guard, limiters.writes, async (req, res, next) => {
    try {
      const id = parse(z.string().uuid(), req.params.id);
      res.json(await statuses.view(req.session, id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/statuses/:id/viewers', guard, limiters.reads, async (req, res, next) => {
    try {
      const id = parse(z.string().uuid(), req.params.id);
      res.json({ viewers: await statuses.viewers(req.session, id) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/events', (req, res) => {    res.json({
      socketEvents: Object.values(SOCKET_EVENTS),
      store: store.constructor.name,
      media: media ? { maxBytes: media.maxBytes, maxPerMessage: media.maxPerMessage } : null
    });
  });

  return router;
}

module.exports = apiRouter;
