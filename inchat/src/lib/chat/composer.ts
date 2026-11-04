import { z } from 'zod';

import { zodFieldErrors, type FieldErrors } from '@/lib/forms';
import type { AttachmentRegistration } from '@/lib/chat/repository';
import type { MessageKind } from '@/lib/chat/timeline';
import { MAX_UPLOAD_BYTES } from '@/lib/chat/uploads';

/** A failing builder hands back per-field reasons in a shared validation shape. */
export type { FieldErrors };

/**
 * The structured half of the composer.
 *
 * A message the server accepts is three columns - kind, body and a jsonb
 * payload - so every item in the attachment menu has to turn whatever the user
 * filled in into that shape *before* it is queued. Doing it here, in a module
 * with no React and no network, is what makes the shapes testable and keeps the
 * thread component from inventing payload keys at the click handler.
 *
 * The payload contracts are matched by the migrations:
 *   poll     - `options` is the array vote_in_poll() bounds the choice against,
 *              `voters` is the map it writes; the tally is derived, never stored.
 *   media    - `path` is the storage object whose first two segments are the
 *              conversation and the uploader, which is what register_message_
 *              attachment() re-checks.
 *   event    - times as ISO strings, so a payload read years later still says
 *              the same instant regardless of the viewer's clock settings.
 */

/** A message ready for the outbox: what send_message() will be called with. */
export type Draft = { kind: MessageKind; body: string; payload: Record<string, unknown> };

export type Built = { ok: true; draft: Draft } | { ok: false; errors: FieldErrors };

const fail = (errors: FieldErrors): Built => ({ ok: false, errors });
const built = (kind: MessageKind, body: string, payload: Record<string, unknown>): Built => ({
  ok: true,
  draft: { kind, body, payload }
});

/** Row-level limits the messages table enforces; a longer value is a rejected insert. */
export const MAX_BODY_CHARS = 20_000;
export const MAX_POLL_OPTIONS = 10;

const trimmed = (value: string) => value.trim();

const questionSchema = z
  .string()
  .trim()
  .min(1, 'Ask something first')
  .max(200, 'Keep the question under 200 characters');

const optionSchema = z.string().trim().min(1, 'An option cannot be empty').max(120);

const latitudeSchema = z
  .number({ message: 'Latitude is required' })
  .min(-90, 'Latitude must be between -90 and 90')
  .max(90, 'Latitude must be between -90 and 90');

const longitudeSchema = z
  .number({ message: 'Longitude is required' })
  .min(-180, 'Longitude must be between -180 and 180')
  .max(180, 'Longitude must be between -180 and 180');

const contactSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Keep the name under 80 characters'),
  phone: z.string().trim().max(32, 'Keep the number under 32 characters').optional().default(''),
  company: z.string().trim().max(80).optional().default('')
});

const locationSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  label: z.string().trim().max(120).optional().default(''),
  accuracy: z.number().int().min(0).max(10_000).optional()
});

const eventSchema = z.object({
  title: z.string().trim().min(1, 'Give the event a title').max(120),
  startsAt: z.iso.datetime({ offset: true, local: true }),
  endsAt: z.iso.datetime({ offset: true, local: true }).optional(),
  location: z.string().trim().max(120).optional().default(''),
  note: z.string().trim().max(2000).optional().default('')
});

export type PollInput = { question: string; options: string[]; multiple: boolean };

/**
 * A poll, in the shape vote_in_poll() expects.
 *
 * `voters` starts empty and the client never writes a count: two members voting
 * at the same moment would have to merge, and a tally recomputed from the map is
 * the same number on every device whatever order the broadcasts arrived in.
 */
export function pollDraft(input: PollInput): Built {
  const question = questionSchema.safeParse(input.question);
  if (!question.success) return fail({ question: question.error.issues[0].message });

  const offered = input.options.map((option) => trimmed(option));
  if (offered.length < 2) return fail({ options: 'A poll needs at least two options' });
  if (offered.length > MAX_POLL_OPTIONS) {
    return fail({ options: `A poll can offer at most ${MAX_POLL_OPTIONS} options` });
  }

  const errors: FieldErrors = {};
  offered.forEach((option, index) => {
    const parsed = optionSchema.safeParse(option);
    if (!parsed.success) errors[`option:${index}`] = parsed.error.issues[0].message;
  });
  if (Object.keys(errors).length) return fail(errors);

  if (new Set(offered.map((option) => option.toLowerCase())).size !== offered.length) {
    return fail({ options: 'Two options say the same thing' });
  }

  const payload: Record<string, unknown> = {
    question: question.data,
    options: offered,
    multiple: input.multiple,
    voters: {}
  };
  const body = input.multiple ? `${question.data} (pick any)` : question.data;
  if (body.length > MAX_BODY_CHARS) return fail({ question: 'Too long to send' });
  return built('poll', body, payload);
}

export type LocationInput = {
  latitude: number | '';
  longitude: number | '';
  label: string;
  accuracy?: number;
};

/** Turn an empty form's blanks into undefined so the messages say "number required". */
function coordinateInput(value: number | ''): number | undefined {
  return value === '' ? undefined : value;
}

export function locationDraft(input: LocationInput): Built {
  const parsed = locationSchema.safeParse({
    latitude: coordinateInput(input.latitude),
    longitude: coordinateInput(input.longitude),
    label: input.label,
    accuracy: input.accuracy
  });
  if (!parsed.success) return fail(zodFieldErrors(parsed.error));

  const { latitude, longitude, label, accuracy } = parsed.data;
  const payload: Record<string, unknown> = { latitude, longitude };
  if (label !== '') payload.label = label;
  if (accuracy !== undefined) payload.accuracy = accuracy;
  // The open-in-maps link is built from the coordinates, not from a stored url:
  // a URL the client chose is one more thing to validate at the click.
  payload.maps_url = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
  const place = label === '' ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` : label;
  return built('location', place, payload);
}

export type ContactInput = { name: string; phone: string; company: string };

export function contactDraft(input: ContactInput): Built {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return fail(zodFieldErrors(parsed.error));

  const { name, phone, company } = parsed.data;
  const payload: Record<string, unknown> = { name };
  if (phone !== '') payload.phone = phone;
  if (company !== '') payload.company = company;
  const parts = [name];
  if (phone !== '') parts.push(phone);
  if (company !== '') parts.push(company);
  return built('contact', parts.join(' · '), payload);
}

export type EventInput = {
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  note: string;
};

export function eventDraft(input: EventInput): Built {
  // An empty time input is "nobody chose an end", not "an invalid time".
  const parsed = eventSchema.safeParse({ ...input, endsAt: input.endsAt === '' ? undefined : input.endsAt });
  if (!parsed.success) {
    const errors = zodFieldErrors(parsed.error);
    // zod answers "Invalid ISO datetime" for a time input nobody touched.
    if (errors['startsAt']) errors['startsAt'] = 'Pick a start time';
    return fail(errors);
  }

  const { title, startsAt, endsAt, location, note } = parsed.data;
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) return fail({ startsAt: 'That start time is not a date' });

  const payload: Record<string, unknown> = { title, starts_at: new Date(start).toISOString() };
  if (endsAt !== undefined) {
    const end = Date.parse(endsAt);
    if (!Number.isFinite(end)) return fail({ endsAt: 'That end time is not a date' });
    if (end <= start) return fail({ endsAt: 'The event cannot end before it starts' });
    payload.ends_at = new Date(end).toISOString();
  }
  if (location !== '') payload.location = location;

  const body = [title, note].filter((part) => part !== '').join('\n');
  if (body.length > MAX_BODY_CHARS) return fail({ note: 'That description is too long to send' });
  return built('event', body, payload);
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

const EXTENSION = /\.([a-z0-9]+)$/i;

export function extensionOf(fileName: string): string {
  const match = EXTENSION.exec(fileName.toLowerCase());
  return match ? match[1] : 'bin';
}

/**
 * Which of the four attachment kinds a file is.
 *
 * The bucket lists the mime types it takes; anything that slipped through a
 * renamed file still lands in 'file' rather than being rendered as media the
 * browser cannot play.
 */
export function attachmentKindForMime(mimeType: string): AttachmentKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

/** The messages table has no 'audio' kind - a voice note is the audio attachment. */
export function messageKindForAttachment(kind: AttachmentKind): MessageKind {
  return kind === 'audio' ? 'voice' : kind;
}

export type MediaSource = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
  width?: number | null;
  height?: number | null;
  durationSecs?: number | null;
  hd?: boolean;
};

export function mediaDraft(source: MediaSource): Built {
  if (source.sizeBytes <= 0) return fail({ file: 'That file is empty' });
  if (source.sizeBytes > MAX_UPLOAD_BYTES) return fail({ file: 'That file is larger than 50 MB' });

  const kind = attachmentKindForMime(source.mimeType);
  const messageKind = messageKindForAttachment(kind);
  const payload: Record<string, unknown> = {
    path: source.path,
    attachment_kind: kind,
    name: source.fileName,
    mime: source.mimeType,
    bytes: source.sizeBytes
  };
  if (source.width && source.height) {
    payload.width = source.width;
    payload.height = source.height;
  }
  if (source.durationSecs) payload.duration_secs = Math.round(source.durationSecs * 100) / 100;
  if (kind === 'image' || kind === 'video') payload.hd = source.hd === true;

  const body = messageKind === 'voice' ? '' : source.fileName;
  return built(messageKind, body, payload);
}

/**
 * What a payload carries for register_message_attachment().
 *
 * Returns null for anything that is not a media message, so the drain can call
 * it on every acknowledgement without a second kind check at the call site.
 */
export function registrationOf(
  kind: MessageKind,
  payload: Record<string, unknown>
): AttachmentRegistration | null {
  if (kind !== 'image' && kind !== 'video' && kind !== 'voice' && kind !== 'file') return null;

  const path = payload['path'];
  const name = payload['name'];
  const mime = payload['mime'];
  const bytes = payload['bytes'];
  if (typeof path !== 'string' || path === '') return null;
  if (typeof name !== 'string' || name === '') return null;
  if (typeof mime !== 'string' || mime === '') return null;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;

  const attachment = payload['attachment_kind'];
  return {
    storagePath: path,
    kind: isAttachmentKind(attachment) ? attachment : attachmentKindForMime(mime),
    fileName: name,
    mimeType: mime,
    sizeBytes: Math.round(bytes),
    width: positiveInt(payload['width']),
    height: positiveInt(payload['height']),
    durationSecs: positiveNumber(payload['duration_secs'])
  };
}

function isAttachmentKind(value: unknown): value is AttachmentKind {
  return value === 'image' || value === 'video' || value === 'audio' || value === 'file';
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 100) / 100
    : null;
}

/**
 * The long edge a *non*-HD picture is scaled to before it is uploaded.
 *
 * HD means "send the bytes the camera gave me"; the default means "make it
 * small enough to leave on a slow connection", and 1280 px is still a picture
 * that reads on a phone. Zero asks the uploader to send the file untouched.
 */
export const STANDARD_EDGE = 1280;

export function targetEdge(hd: boolean): number {
  return hd ? 0 : STANDARD_EDGE;
}

/* ------------------------------------------------------------------ polls */

export type PollOption = { text: string; votes: number; share: number };
export type PollView = {
  question: string;
  options: PollOption[];
  total: number;
  multiple: boolean;
  closed: boolean;
  voters: Record<string, number>;
};

/** The voter map, as the server wrote it: a junk value is treated as no votes. */
export function votersOf(payload: Record<string, unknown>): Record<string, number> {
  const raw = payload['voters'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

export function optionsOf(payload: Record<string, unknown>): string[] {
  const raw = payload['options'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((option): option is string => typeof option === 'string');
}

/**
 * A poll rendered from the row, with the tally derived from `voters`.
 *
 * Every client computes the same numbers because the counts come from the map
 * that is in the payload, not from anything it accumulated locally.
 */
export function pollView(payload: Record<string, unknown>): PollView {
  const options = optionsOf(payload);
  const voters = votersOf(payload);
  const counts = options.map(() => 0);
  for (const choice of Object.values(voters)) {
    if (choice < options.length) counts[choice] += 1;
  }
  const total = counts.reduce((sum, count) => sum + count, 0);

  return {
    question: typeof payload['question'] === 'string' ? payload['question'] : '',
    multiple: payload['multiple'] === true,
    closed: isClosed(payload),
    options: options.map((text, index) => ({
      text,
      votes: counts[index],
      share: total === 0 ? 0 : Math.round((counts[index] / total) * 100)
    })),
    total,
    voters
  };
}

/**
 * Closed, read exactly as `vote_in_poll()` reads it.
 *
 * The function compares the *text* of the key against 'true', which a JSON
 * boolean and the string "true" both serialise to. A client that only accepted
 * the boolean would offer a vote on a poll the server then refuses.
 */
export function isClosed(payload: Record<string, unknown>): boolean {
  const closed = payload['closed'];
  return closed === true || closed === 'true';
}

/** Which option this viewer already chose, or null. */
export function choiceOf(view: PollView, userId: string): number | null {
  const choice = view.voters[userId];
  return typeof choice === 'number' && choice < view.options.length ? choice : null;
}

/**
 * The payload as it looks the instant a member taps, before the row comes back.
 *
 * Only this viewer's entry moves, and it is a replacement rather than an
 * increment, so the optimistic copy and the row the server broadcasts differ by
 * nothing but the moment they arrived - and a vote that fails at the server is
 * corrected by the next real payload instead of leaving a phantom tally.
 */
export function withLocalVote(
  payload: Record<string, unknown>,
  userId: string,
  choice: number
): Record<string, unknown> {
  const options = optionsOf(payload);
  if (choice < 0 || choice >= options.length) return payload;
  return { ...payload, voters: { ...votersOf(payload), [userId]: choice } };
}
