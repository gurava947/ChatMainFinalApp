'use strict';

/**
 * A status write names its viewers by id, while every reader needs who looked
 * and when, so both forms land in one list. Ids without a name are kept as
 * unknown rather than guessed at, and the author never appears in their own list.
 */
function normalizeViewers(status) {
  const seeded = (status.viewerIds || []).map((userId) => ({ userId, displayName: null, at: status.createdAt }));
  const listed = Array.isArray(status.viewers) ? status.viewers : [];
  const byId = new Map();
  for (const entry of [...seeded, ...listed]) {
    if (!entry || typeof entry.userId !== 'string' || byId.has(entry.userId)) continue;
    byId.set(entry.userId, { userId: entry.userId, displayName: entry.displayName ?? null, at: Number(entry.at) || status.createdAt });
  }
  byId.delete(status.userId);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

module.exports = { normalizeViewers };
