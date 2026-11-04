'use strict';

const { AVATAR_TTL_SECONDS, PROFILE_LOOKUP_MAX } = require('../constants');

/**
 * Profiles are the identity a guest shows to other guests: name, note and one
 * picture. The picture is ordinary media, so it gets the same magic-number
 * checks and the same sandboxed delivery as any attachment; the difference is
 * lifetime. An attachment may expire in hours, a profile picture should not, so
 * the avatar's media record is written with a long TTL and renewed whenever the
 * owner reads their own profile.
 */
function createProfileService({ store, media, chat }) {
  async function dropMedia(mediaId) {
    if (!mediaId) return;
    if (media) await media.unlinkQuietly(mediaId);
    await store.deleteMedia(mediaId);
  }

  /** Records the uploader sent that are not the chosen picture must not linger on disk. */
  async function discardExcept(keepId, records) {
    await Promise.all(records.filter((record) => record.id !== keepId).map((record) => dropMedia(record.id)));
  }

  async function setAvatar(user, records) {
    const image = records.find((record) => record.kind === 'image');
    await discardExcept(image?.id, records);
    if (!image) {
      const error = new Error('a profile picture must be an image');
      error.statusCode = 400;
      throw error;
    }

    const previous = await store.getAvatar(user.userId);
    if (previous && previous.mediaId !== image.id) await dropMedia(previous.mediaId);

    // Re-writing the record is what extends its life; the sweep reads the same
    // expiry, so an avatar cannot be pruned while it is still pointed at.
    const stored = await store.saveMedia({ ...image }, { ttlSeconds: AVATAR_TTL_SECONDS });
    const avatar = { mediaId: stored.id, mime: stored.mime, size: stored.size, updatedAt: Date.now() };
    await store.saveAvatar(user.userId, avatar);
    return publicAvatar(avatar);
  }

  async function removeAvatar(user) {
    const previous = await store.getAvatar(user.userId);
    await store.deleteAvatar(user.userId);
    if (previous) await dropMedia(previous.mediaId);
    return { removed: Boolean(previous) };
  }

  function publicAvatar(avatar) {
    if (!avatar) return null;
    return { url: `/media/${avatar.mediaId}`, mime: avatar.mime, size: avatar.size, updatedAt: avatar.updatedAt };
  }

  /** Reading your own profile slides the picture's expiry forward again. */
  async function myProfile(user) {
    const stored = await store.getAvatar(user.userId);
    let avatar = stored;
    if (stored) {
      const record = await store.getMedia(stored.mediaId);
      if (!record) {
        await store.deleteAvatar(user.userId);
        avatar = null;
      } else {
        await store.saveMedia({ ...record }, { ttlSeconds: AVATAR_TTL_SECONDS });
      }
    }
    const [note, session] = await Promise.all([store.getNote(user.userId), chat.getSession(user.userId)]);
    return {
      userId: user.userId,
      displayName: session?.displayName || user.displayName,
      note: note || { text: '', updatedAt: null },
      avatar: publicAvatar(avatar)
    };
  }

  /**
   * Other guests read the same picture the owner uploaded. Only uuids are
   * accepted and the batch is capped, so this cannot become a directory crawl.
   */
  async function profilesFor(ids) {
    const unique = [...new Set(ids)].slice(0, PROFILE_LOOKUP_MAX);
    const rows = await Promise.all(unique.map(async (userId) => {
      const [avatar, session] = await Promise.all([store.getAvatar(userId), store.getSession(userId)]);
      return {
        userId,
        displayName: session?.displayName || null,
        avatar: avatar ? publicAvatar(avatar) : null
      };
    }));
    return rows;
  }

  return { setAvatar, removeAvatar, myProfile, profilesFor };
}

module.exports = { createProfileService };
