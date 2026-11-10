'use strict';

const { SIGNAL_MAILBOX_TTL_SECONDS } = require('../constants');

const EMPTY_MAILBOX = Object.freeze({
  room: null,
  fromSocketId: null,
  fromUserId: null,
  fromDisplayName: null,
  description: null,
  candidates: [],
  count: 0,
  expiresAt: null
});

/**
 * Both stores keep the same append order, so the replay is derived the same
 * way: the newest description is the current ICE generation, and only the
 * candidates appended after it belong to that generation.
 */
function deriveMailbox(entries, now = Date.now()) {
  const valid = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object' && (entry.kind === 'description' || entry.kind === 'candidate'));
  if (valid.length === 0) return { ...EMPTY_MAILBOX, candidates: [] };

  let descriptionIndex = -1;
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    if (valid[index].kind === 'description' && valid[index].description) {
      descriptionIndex = index;
      break;
    }
  }

  const head = descriptionIndex >= 0 ? valid[descriptionIndex] : valid[valid.length - 1];
  const last = valid[valid.length - 1];
  const expiresAt = Number(last.ts) + SIGNAL_MAILBOX_TTL_SECONDS * 1000;
  return {
    room: head.room ?? null,
    fromSocketId: head.fromSocketId ?? null,
    fromUserId: head.fromUserId ?? null,
    fromDisplayName: head.fromDisplayName ?? null,
    description: descriptionIndex >= 0 ? valid[descriptionIndex].description : null,
    candidates: valid.slice(descriptionIndex + 1).filter((entry) => entry.kind === 'candidate' && entry.candidate).map((entry) => entry.candidate),
    count: valid.length,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + SIGNAL_MAILBOX_TTL_SECONDS * 1000
  };
}

module.exports = { deriveMailbox, EMPTY_MAILBOX };