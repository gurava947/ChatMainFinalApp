'use strict';

const MESSAGE_NS = 'chat:messages';
const PRESENCE_NS = 'chat:presence';
const WINDOW_NS = 'chat:window';
const SEEN_NS = 'chat:seen';
const DELIVERED_NS = 'chat:delivered';
const MEDIA_NS = 'chat:media';
const MEDIA_INDEX_NS = 'chat:media:index';
const ROOM_SETTINGS_NS = 'chat:roomsettings';
const BLOCKED_NS = 'chat:blocked';
const ROOM_PASSWORD_NS = 'chat:room-password';
const ROOM_ROSTER_NS = 'chat:room-roster';

const ROOM_ID_MAX = 64;
/**
 * A room is a conversation between two people. The cap is enforced where
 * membership is written, not where it is displayed, because a limit the client
 * can walk around is not a limit.
 */
const ROOM_MAX_MEMBERS = 2;
/**
 * An invite is read out loud or typed on another device, so the alphabet drops
 * the pairs people misread - no 0/O, no 1/I/L.
 */
const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const INVITE_CODE_LENGTH = 8;
const USERNAME_MAX = 32;
/** Long-form text is a first-class message, so the ceiling is a wall of text. */
const MESSAGE_MAX_CHARS = 50000;
const PRESENCE_PRUNE_EVERY_MS = 5000;
const SEEN_BATCH_MAX = 50;
/** Delivery receipts travel in the same size batches as read receipts. */
const DELIVERED_BATCH_MAX = 50;
const ATTACHMENTS_MAX = 5;
const MEDIA_SWEEP_EVERY_MS = 60000;

/**
 * A page of history. The socket join and the HTTP read both answer with this
 * many rows, and a client asks for the next page with the oldest sequence it
 * already holds, so nothing in the room is unreachable.
 */
const HISTORY_PAGE_SIZE = 50;
const HISTORY_PAGE_MAX = 200;
/**
 * Rows a room keeps. The scan cap below is what a linear read may walk; the
 * two are separate because paging a 1000-row room must not make a poll lookup
 * scan 1000 rows.
 */
const MESSAGE_HISTORY_MAX = 1000;

/** A poll is the one message type that keeps mutating after it is sent. */
const POLL_OPTIONS_MIN = 2;
const POLL_OPTIONS_MAX = 12;
const POLL_OPTION_MAX_CHARS = 100;
const VOICE_MAX_MS = 15 * 60 * 1000;
/** One bar per bucket in the waveform the composer draws while recording. */
const VOICE_PEAKS_MAX = 48;

/** A room only its owner may join, so a user can write to themselves. */
const SELF_ROOM_PREFIX = 'self-';

const MESSAGE_KINDS = Object.freeze({
  TEXT: 'text',
  VOICE: 'voice',
  POLL: 'poll',
  LOCATION: 'location',
  CONTACT: 'contact',
  EVENT: 'event'
});

/** A resend of the same clientId inside this window is absorbed, not stored twice. */
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
/** The personal note is short by design, like the one under a profile name. */
const NOTE_MAX_CHARS = 500;
/** Per-user chat settings are bounded lists; a guest is not an enterprise directory. */
const BLOCKED_MAX = 200;
const HIDDEN_MESSAGES_MAX = 500;
/**
 * Chat palettes are an allowlist: the value is written straight into a class
 * name in the browser, so free text must never reach it.
 */
const CHAT_THEMES = Object.freeze(['default', 'forest', 'sunset', 'ocean', 'midnight', 'paper']);

/**
 * A profile picture is media, so it lives in the media store, but it must not
 * disappear with a room attachment's short TTL. The expiry slides forward every
 * time the owner reads their own profile.
 */
const AVATAR_TTL_SECONDS = 30 * 24 * 3600;
/** One batched read cannot turn into a directory crawl. */
const PROFILE_LOOKUP_MAX = 60;

/**
 * A call record is a reminder of a conversation, not a log of it: thirty days
 * is long enough to recall a missed call and short enough to bound the store.
 */
const CALL_RECORD_TTL_SECONDS = 30 * 24 * 3600;
/** Both ends share one record, so a guest's list is capped, not paginated. */
const CALL_HISTORY_MAX = 50;

/** A status is a day old and gone; the TTL is the whole product. */
const STATUS_TTL_SECONDS = 24 * 60 * 60;
/** Six live cards is generous for a guest and keeps the feed readable. */
const STATUS_MAX_PER_USER = 6;
const STATUS_TEXT_MAX_CHARS = 200;
/**
 * The card's background is painted from this list in the browser, so the colour
 * is an allowlist of hex values and not free text, exactly like the chat themes.
 */
const STATUS_COLORS = Object.freeze([
  '#f2c94c',
  '#f97316',
  '#fb7185',
  '#f472b6',
  '#a78bfa',
  '#60a5fa',
  '#22d3ee',
  '#34d399'
]);

const SOCKET_EVENTS = Object.freeze({
  CONNECTION: 'connection',
  MESSAGE: 'message',
  NEW_MESSAGE: 'new_message',
  /**
   * A whisper to one member's own channels saying "this room has news". It is
   * what lets a conversation list badge move for a room the device is not
   * sitting in, which `new_message` on the room channel never can.
   */
  ROOM_ACTIVITY: 'room_activity',
  HISTORY: 'history',
  ROOM_JOIN: 'room:join',
  TYPING: 'typing',
  STOP_TYPING: 'stop_typing',
  PRESENCE: 'presence',
  USER_JOINED: 'user_joined',
  USER_LEFT: 'user_left',
  SEEN_MARK: 'message:seen',
  MESSAGE_SEEN: 'message_seen',
  DELIVERED_MARK: 'message:delivered',
  MESSAGE_DELIVERED: 'message_delivered',
  /** A whole page arriving is one receipt event, not one per row. */
  MESSAGES_DELIVERED: 'messages_delivered',
  POLL_VOTE: 'poll:vote',
  POLL_VOTED: 'poll_voted',
  STATUS_CREATED: 'status_created',
  STATUS_REMOVED: 'status_removed',
  SYSTEM: 'system',
  DISCONNECT: 'disconnect'
});

module.exports = {
  MESSAGE_NS,
  PRESENCE_NS,
  WINDOW_NS,
  SEEN_NS,
  DELIVERED_NS,
  MEDIA_NS,
  MEDIA_INDEX_NS,
  ROOM_ID_MAX,
  ROOM_MAX_MEMBERS,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  USERNAME_MAX,
  MESSAGE_MAX_CHARS,
  PRESENCE_PRUNE_EVERY_MS,
  SEEN_BATCH_MAX,
  DELIVERED_BATCH_MAX,
  ATTACHMENTS_MAX,
  MEDIA_SWEEP_EVERY_MS,
  HISTORY_PAGE_SIZE,
  HISTORY_PAGE_MAX,
  MESSAGE_HISTORY_MAX,
  POLL_OPTIONS_MIN,
  POLL_OPTIONS_MAX,
  POLL_OPTION_MAX_CHARS,
  VOICE_MAX_MS,
  VOICE_PEAKS_MAX,
  SELF_ROOM_PREFIX,
  MESSAGE_KINDS,
  IDEMPOTENCY_WINDOW_MS,
  NOTE_MAX_CHARS,
  BLOCKED_MAX,
  HIDDEN_MESSAGES_MAX,
  CHAT_THEMES,
  AVATAR_TTL_SECONDS,
  PROFILE_LOOKUP_MAX,
  CALL_RECORD_TTL_SECONDS,
  CALL_HISTORY_MAX,
  STATUS_TTL_SECONDS,
  STATUS_MAX_PER_USER,
  STATUS_TEXT_MAX_CHARS,
  STATUS_COLORS,
  SOCKET_EVENTS,
  messagesKey: (room) => `${MESSAGE_NS}:${room}`,
  /** Per-room counter: the sequence it hands out orders history and pages it. */
  seqKey: (room) => `${MESSAGE_NS}:seq:${room}`,
  /** Which room owns a message id, so a receipt can be checked against it. */
  messageRoomKey: (messageId) => `${MESSAGE_NS}:room:${messageId}`,
  presenceKey: (room) => `${PRESENCE_NS}:${room}`,
  windowKey: (bucket) => `${WINDOW_NS}:${bucket}`,
  seenKey: (messageId) => `${SEEN_NS}:${messageId}`,
  deliveredKey: (messageId) => `${DELIVERED_NS}:${messageId}`,
  mediaKey: (mediaId) => `${MEDIA_NS}:${mediaId}`,
  mediaIndexKey: () => MEDIA_INDEX_NS,
  pollKey: (messageId) => `chat:poll:${messageId}`,
  noteKey: (userId) => `chat:note:${userId}`,
  roomSettingsKey: (userId, room) => `${ROOM_SETTINGS_NS}:${userId}:${room}`,
  blockedKey: (userId) => `${BLOCKED_NS}:${userId}`,
  roomPasswordKey: (room) => `${ROOM_PASSWORD_NS}:${room}`,
  /** The roster is the room's membership record, and the only thing authorization reads. */
  roomRosterKey: (room) => `${ROOM_ROSTER_NS}:${room}`,
  avatarKey: (userId) => `chat:avatar:${userId}`,
  callRecordKey: (callId) => `chat:call:record:${callId}`,
  callUserKey: (userId) => `chat:call:user:${userId}`,
  statusKey: (statusId) => `chat:status:${statusId}`,
  statusUserKey: (userId) => `chat:status:user:${userId}`,
  statusActiveKey: () => 'chat:status:active',
  idempotencyKey: (userId, clientId) => `chat:idem:${userId}:${clientId}`,
  /**
   * Every socket also sits in its own room, so a replica can address one user
   * without knowing which replica holds that user's connection: the adapter
   * carries the membership across processes the way it carries chat rooms.
   */
  userRoom: (userId) => `u:${userId}`,
  /** Room id is a slug, so the owner's uuid drops straight in after the prefix. */
  selfRoom: (userId) => `${SELF_ROOM_PREFIX}${userId}`,
  isSelfRoom: (room) => String(room || '').startsWith(SELF_ROOM_PREFIX),
  /** `self-<uuid>` and nothing else; a hand-typed prefix must not reach another inbox. */
  selfRoomOwner: (room) => {
    const match = /^self-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
      .exec(String(room || ''));
    return match ? match[1] : null;
  }
};
