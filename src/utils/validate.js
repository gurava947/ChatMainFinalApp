'use strict';

const { z } = require('zod');
const {
  MESSAGE_MAX_CHARS,
  ROOM_ID_MAX,
  USERNAME_MAX,
  SEEN_BATCH_MAX,
  DELIVERED_BATCH_MAX,
  ATTACHMENTS_MAX,
  MESSAGE_KINDS,
  POLL_OPTIONS_MIN,
  POLL_OPTIONS_MAX,
  POLL_OPTION_MAX_CHARS,
  VOICE_MAX_MS,
  VOICE_PEAKS_MAX,
  NOTE_MAX_CHARS,
  HISTORY_PAGE_SIZE,
  HISTORY_PAGE_MAX,
  CHAT_THEMES,
  PROFILE_LOOKUP_MAX,
  STATUS_COLORS,
  STATUS_TEXT_MAX_CHARS,
  SELF_ROOM_PREFIX,
  selfRoomOwner
} = require('../constants');
const { safeDisplayName } = require('./media');

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const SCRIPT_LIKE = /<\s*(script|style|iframe|object|embed|svg)\b[\s\S]*?<\s*\/\s*\1\s*>/giu;
const COMPLETE_TAG = /<\s*\/?\s*[a-zA-Z][^<>]*>/g;

/**
 * `self-<uuid>` is reserved for a user's own inbox, so a hand-typed room that
 * merely starts with the prefix cannot masquerade as one.
 */
const roomSchema = z
  .string()
  .trim()
  .min(1)
  .max(ROOM_ID_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'room must be a slug of letters, digits, dot, dash, underscore')
  .refine((room) => !room.startsWith(SELF_ROOM_PREFIX) || Boolean(selfRoomOwner(room)), {
    message: 'a self room must name a session id'
  });

const usernameSchema = z
  .string()
  .trim()
  .min(2)
  .max(USERNAME_MAX)
  .regex(/^[\p{L}\p{N}\p{M} ._'-]+$/u, 'username has unsupported characters');

const messageSchema = z
  .string()
  .trim()
  .max(MESSAGE_MAX_CHARS);

const attachmentSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['image', 'video', 'audio', 'document']),
  name: z.string().min(1).max(140),
  mime: z.string().min(3).max(120),
  size: z.coerce.number().int().min(1).max(2 * 1024 * 1024 * 1024)
});

const seenIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(SEEN_BATCH_MAX)
});

/** Delivery receipts use the same shape as read receipts, but their own batch cap. */
const deliveredIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(DELIVERED_BATCH_MAX)
});

/** Choices are option indexes; duplicates would let one vote count twice. */
const pollVoteSchema = z.object({
  messageId: z.string().uuid(),
  choices: z
    .array(z.coerce.number().int().min(0).max(POLL_OPTIONS_MAX - 1))
    .min(1)
    .max(POLL_OPTIONS_MAX)
    .transform((choices) => [...new Set(choices)])
});

/** Empty is legal: it is how the owner clears their own note. */
const noteSchema = z.object({ text: z.string().trim().max(NOTE_MAX_CHARS) });

/** Blocking is by session id; the name is only a label snapshot for the list. */
const blockTargetSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().trim().max(USERNAME_MAX).optional()
});

/** A theme id becomes a class name in the browser, so only known ids pass. */
const roomThemeSchema = z.object({ theme: z.enum(CHAT_THEMES) });
const roomPasswordSchema = z.object({
  password: z.string().min(8).max(128).optional()
});

/** Message ids for delete-for-me, single tap or bulk selection. */
const hideIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(SEEN_BATCH_MAX)
});

/** Profile reads arrive as a comma-separated query, so the split happens here. */
const profileIdsSchema = z.string().min(1)
  .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
  .pipe(z.array(z.string().uuid()).min(1).max(PROFILE_LOOKUP_MAX));

/**
 * History paging arrives in the query string, so both numbers are coerced.
 * `before` is the sequence the client already holds, which is what makes the
 * page underneath it reachable instead of only the top of the room.
 */
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).default(HISTORY_PAGE_SIZE),
  before: z.coerce.number().int().min(0).optional()
});

const joinPayloadSchema = z.object({
  room: roomSchema,
  displayName: usernameSchema
});
const roomJoinPayloadSchema = z.object({
  room: roomSchema,
  password: z.string().min(8).max(128).optional()
});

/**
 * Call signals are relayed verbatim and a subset of them is also stored, so the
 * fields that reach the history are validated here rather than trusted from the
 * wire. The messages are the ones the client already keys its error copy on.
 */
const callSignalSchema = z.object({
  callId: z.string().uuid('invalid call id'),
  targetSocketId: z.string().min(1, 'invalid call recipient').max(128, 'invalid call recipient')
});

/** Only an invite carries a mode, and only these two modes exist. */
const callInviteSchema = callSignalSchema.extend({ mode: z.enum(['audio', 'video'], 'invalid call mode') });

/**
 * A status is one card: a colour and at most 200 characters, or media that was
 * already uploaded. The palette is an allowlist because the value is painted
 * into the card in the browser, exactly like the chat themes.
 */
const statusSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string().trim().min(1, 'status text is empty').max(STATUS_TEXT_MAX_CHARS, 'status text is too long'),
    color: z.enum(STATUS_COLORS, 'status colour is not on the palette')
  }),
  z.object({
    kind: z.enum(['image', 'video'], 'status media must be an image or a video'),
    mediaId: z.string().uuid('unknown media id')
  })
]);

/* ------------------------------------------------------------------ *
 * Structured content. Each type is a closed shape: the client never
 * sends markup for these messages, it sends fields, and the card is
 * built from the fields on both ends.
 * ------------------------------------------------------------------ */
const text = (max) => z.string().trim().min(1).max(max);

const pollContentSchema = z
  .object({
    type: z.literal('poll'),
    question: text(200),
    options: z.array(text(POLL_OPTION_MAX_CHARS)).min(POLL_OPTIONS_MIN).max(POLL_OPTIONS_MAX),
    multiple: z.boolean().default(false)
  })
  .refine(
    (poll) => new Set(poll.options.map((option) => option.toLowerCase())).size === poll.options.length,
    { message: 'poll options must be distinct' }
  );

const locationContentSchema = z.object({
  type: z.literal('location'),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracyM: z.coerce.number().min(0).max(100000).optional(),
  label: text(120).optional(),
  address: text(300).optional()
});

const contactContentSchema = z
  .object({
    type: z.literal('contact'),
    name: text(100),
    /** Digits and dialling punctuation only: a card links through tel:/mailto:. */
    phone: text(40).regex(/^[+0-9 ()\-.]+$/, 'phone has unsupported characters').optional(),
    email: z.email().trim().max(120).optional(),
    org: text(80).optional(),
    note: text(200).optional()
  })
  .refine((contact) => Boolean(contact.phone || contact.email), {
    message: 'contact needs a phone number or an email'
  });

const eventContentSchema = z
  .object({
    type: z.literal('event'),
    title: text(140),
    start: z.coerce.date().transform((date) => date.getTime()),
    end: z.coerce.date().transform((date) => date.getTime()).optional(),
    allDay: z.boolean().default(false),
    location: text(140).optional(),
    note: text(500).optional()
  })
  .refine((event) => !event.end || event.end > event.start, {
    message: 'event end must be after its start'
  });

/** The bytes live in the media pipeline; this is the player metadata. */
const voiceContentSchema = z.object({
  type: z.literal('voice'),
  durationMs: z.coerce.number().int().min(100).max(VOICE_MAX_MS),
  peaks: z.array(z.coerce.number().min(0).max(1)).max(VOICE_PEAKS_MAX).default([])
});

const contentSchema = z.discriminatedUnion('type', [
  pollContentSchema,
  locationContentSchema,
  contactContentSchema,
  eventContentSchema,
  voiceContentSchema
]);

const CONTENT_TEXT_FIELDS = Object.freeze({
  poll: { fields: ['question'], lists: ['options'] },
  location: { fields: ['label', 'address'], lists: [] },
  contact: { fields: ['name', 'org', 'note'], lists: [] },
  event: { fields: ['title', 'location', 'note'], lists: [] },
  voice: { fields: [], lists: [] }
});

/** Same rules as chat text: these strings are echoed to every reader. */
function sanitizeContent(content) {
  if (!content) return null;
  const { fields, lists } = CONTENT_TEXT_FIELDS[content.type];
  const cleaned = { ...content };
  for (const field of fields) {
    if (typeof cleaned[field] === 'string') cleaned[field] = sanitizeText(cleaned[field]);
  }
  for (const field of lists) {
    if (Array.isArray(cleaned[field])) cleaned[field] = cleaned[field].map((entry) => sanitizeText(entry));
  }
  if (cleaned.type === 'poll' && cleaned.options.some((option) => !option)) {
    const error = new Error('poll option became empty after sanitising');
    error.statusCode = 400;
    throw error;
  }
  return cleaned;
}

function messageKind(content) {
  return content ? content.type : MESSAGE_KINDS.TEXT;
}

const isNotEmpty = (payload) =>
  payload.text.length > 0 || payload.attachments.length > 0 || Boolean(payload.content);

/** A voice message is its recording: the card has nothing to play otherwise. */
const contentMatchesAttachments = (payload) => {
  if (payload.content?.type !== 'voice') return true;
  return payload.attachments.length === 1 && payload.attachments[0].kind === 'audio';
};

/** An attachment with no caption is still a message, but neither is not. */
const sendPayloadShape = z.object({
  room: roomSchema,
  text: messageSchema.default(''),
  clientId: z.string().max(64).optional(),
  attachments: z.array(attachmentSchema).max(ATTACHMENTS_MAX).default([]),
  content: contentSchema.optional()
});

const sendPayloadSchema = sendPayloadShape
  .refine(isNotEmpty, { message: 'message is empty' })
  .refine(contentMatchesAttachments, { message: 'a voice message needs one audio attachment' });

/** Same rule for callers that already know the room (the HTTP write path). */
const postMessageSchema = sendPayloadShape
  .omit({ room: true })
  .refine(isNotEmpty, { message: 'message is empty' })
  .refine(contentMatchesAttachments, { message: 'a voice message needs one audio attachment' });

/**
 * Chat payloads are plain text, so complete tags and script-like blocks are
 * removed. A lone `<` is kept: developers type `if (a<b)` and the client
 * renders through textContent, so the surviving character cannot execute.
 * Control characters go because they break terminals and log pipelines.
 */
function sanitizeText(input) {
  return String(input)
    .replace(CONTROL_CHARS, '')
    .replace(SCRIPT_LIKE, ' ')
    .replace(COMPLETE_TAG, ' ')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]*\n[ \t]*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, MESSAGE_MAX_CHARS);
}

/** Attachment metadata is echoed back to the room, so treat it as user input. */
function sanitizeAttachment(attachment) {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: safeDisplayName(attachment.name),
    mime: attachment.mime,
    size: attachment.size
  };
}

function parse(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const error = new Error(result.error.issues.map((i) => i.message).join('; '));
    error.statusCode = 400;
    throw error;
  }
  return result.data;
}

module.exports = {
  roomSchema,
  usernameSchema,
  messageSchema,
  attachmentSchema,
  seenIdsSchema,
  deliveredIdsSchema,
  pollVoteSchema,
  noteSchema,
  blockTargetSchema,
  roomThemeSchema,
  roomPasswordSchema,
  hideIdsSchema,
  historyQuerySchema,
  profileIdsSchema,
  joinPayloadSchema,
  roomJoinPayloadSchema,
  callSignalSchema,
  callInviteSchema,
  statusSchema,
  sendPayloadSchema,
  postMessageSchema,
  contentSchema,
  sanitizeContent,
  messageKind,
  sanitizeText,
  sanitizeAttachment,
  parse
};
