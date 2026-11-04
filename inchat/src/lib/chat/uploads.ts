import { z } from 'zod';

/**
 * Getting a file into the `chat-media` bucket, and the state that goes with it.
 *
 * Two halves: the checks the bucket itself will run (size ceiling and mime
 * allow-list, mirrored from the storage migration), and a queue of transfers
 * with progress and backoff. Both are here rather than in the component so a
 * rejected 40 MB video is a test case, not a bug report.
 *
 * The path convention is part of the authorization model - the storage policy
 * reads the conversation id and the uploader out of the first two segments - so
 * it is built by one function that nobody else gets to improvise.
 */

export const BUCKET = 'chat-media';

/** `file_size_limit` from the bucket row; a larger object is refused by Storage. */
export const MAX_UPLOAD_BYTES = 52_428_800;

/**
 * The mime types the bucket accepts, kept in the same order as the migration.
 * A rename does not get past this list, and the storage policy is the real gate.
 */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'application/zip'
];

/** Voice notes are recorded, not chosen, so they are bounded by length instead. */
export const MAX_VOICE_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fileGroup = z.enum(['image', 'video', 'audio', 'file']);
export type UploadGroup = z.infer<typeof fileGroup>;

/**
 * The limits shown while a file is being picked.
 *
 * The bucket ceiling is 50 MB for everything, but a 50 MB video from a phone on
 * a metered connection is not a feature, so the picker is narrower than the
 * policy and says so up front. Storage remains the authority: a file that
 * passes here can still be refused there.
 */
export const FILE_GROUP_LIMITS: Record<UploadGroup, number> = {
  image: MAX_UPLOAD_BYTES,
  video: 52_428_800,
  audio: 26_214_400,
  file: 52_428_800
};

export function groupForMime(mimeType: string): UploadGroup {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

export function isAllowedMime(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.includes(mimeType);
}

/**
 * The picker's accept list.
 *
 * `audio/*` and `video/*` stay in the dialog so a tap on Camera is not blocked
 * by a phone that reports the clip as `video/quicktime` one release and
 * `video/mp4` the next; `validateFile` then decides, against this same list.
 */
export const ACCEPT =
  'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,' +
  'audio/webm,audio/mpeg,audio/ogg,audio/mp4,application/pdf,.doc,.docx,.xls,.xlsx,.pptx,.txt,.zip';

/**
 * Refuse a file before it uses anyone's data.
 *
 * Returns the sentence to show, or null when the upload may start. The mime
 * check is first because an unsupported type will never be accepted no matter
 * how small it is, and telling the user that is more useful than a size limit
 * they would have passed.
 */
export function validateFile(input: {
  mimeType: string;
  sizeBytes: number;
  group?: UploadGroup;
}): string | null {
  const group = input.group ?? groupForMime(input.mimeType);
  const parsed = fileGroup.safeParse(group);
  if (!parsed.success) return 'That is not a file this chat accepts';

  if (!isAllowedMime(input.mimeType)) return `${input.mimeType || 'That file'} is not allowed in chat`;
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) return 'That file is empty';
  if (input.sizeBytes > MAX_UPLOAD_BYTES) return 'That file is larger than the 50 MB limit';

  const limit = FILE_GROUP_LIMITS[parsed.data];
  if (input.sizeBytes > limit) {
    return `That ${parsed.data} is larger than ${Math.round(limit / 1_048_576)} MB`;
  }
  return null;
}

const SAFE_SEGMENT = /^[0-9a-z][0-9a-z._-]*$/i;

/**
 * `{conversation_id}/{uploader_id}/{random_uuid}.{ext}`
 *
 * The storage policy reads segment one to decide who may download and segment
 * two to decide who may upload, so a segment that is not a uuid silently
 * authorises nobody. Refusing to build the path is the fix for that.
 */
export function objectPath(input: {
  conversationId: string;
  uploaderId: string;
  fileId: string;
  extension: string;
}): string {
  for (const value of [input.conversationId, input.uploaderId, input.fileId]) {
    if (!UUID.test(value)) throw new Error('attachment paths need uuid segments');
  }
  const extension = input.extension.toLowerCase().replace(/[^a-z0-9]/g, '');
  return extension === ''
    ? `${input.conversationId}/${input.uploaderId}/${input.fileId}`
    : `${input.conversationId}/${input.uploaderId}/${input.fileId}.${extension}`;
}

/**
 * Whether a path could belong to this conversation.
 *
 * The uploader segment is deliberately not checked here: on somebody else's
 * photo it names them, not the viewer. The storage policy is what enforces both
 * segments; this only stops a malformed path from being handed to a signed-URL
 * request that would fail anyway.
 */
export function pathInConversation(path: string, conversationId: string): boolean {
  const segments = path.split('/');
  return segments.length === 3 && segments[0] === conversationId && SAFE_SEGMENT.test(segments[2]);
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/* ------------------------------------------------------------- transfers */

export type TransferStatus = 'queued' | 'uploading' | 'done' | 'failed';

/**
 * One file waiting for, or in the middle of, its upload.
 *
 * The bytes are deliberately not in here: this record is what the progress tray
 * renders and what a retry re-reads, and a Blob inside React state would be held
 * for the life of the tab. The caller keeps the handle to the file and passes it
 * to the upload; this queue tracks what happened to it.
 */
export type Transfer = {
  /** The message this file will become, so the pending bubble and the tray agree. */
  clientId: string;
  conversationId: string;
  path: string;
  name: string;
  mimeType: string;
  group: UploadGroup;
  bytes: number;
  sentBytes: number;
  status: TransferStatus;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
  hd: boolean;
  /** Read before the upload started; the attachment row is filed with them. */
  width: number | null;
  height: number | null;
  durationSecs: number | null;
};

export type TransferBook = { items: Transfer[] };

export type TransferConfig = {
  maxAttempts: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
};

export const defaultTransferConfig: TransferConfig = {
  // Fewer attempts than the message outbox: a file that has failed three times
  // on this connection is not going to arrive, and re-sending 20 MB is the most
  // expensive mistake the app can make on a metered link.
  maxAttempts: 3,
  baseRetryDelayMs: 5_000,
  maxRetryDelayMs: 60_000
};

export function emptyTransfers(): TransferBook {
  return { items: [] };
}

export function addTransfer(book: TransferBook, transfer: Transfer): TransferBook {
  if (book.items.some((item) => item.clientId === transfer.clientId)) return book;
  return { items: [...book.items, transfer] };
}

export function findTransfer(book: TransferBook, clientId: string): Transfer | undefined {
  return book.items.find((item) => item.clientId === clientId);
}

function replace(book: TransferBook, clientId: string, next: Transfer): TransferBook {
  if (!book.items.some((item) => item.clientId === clientId)) return book;
  return { items: book.items.map((item) => (item.clientId === clientId ? next : item)) };
}

/** Claim a transfer for a run. Returns null when it is not startable now. */
export function startTransfer(
  book: TransferBook,
  clientId: string,
  now: number,
  config: TransferConfig = defaultTransferConfig
): { book: TransferBook; transfer: Transfer | null } {
  const item = findTransfer(book, clientId);
  if (!item || item.status === 'uploading' || item.status === 'done') return { book, transfer: null };
  if (item.attempts >= config.maxAttempts) return { book, transfer: null };
  if (item.nextAttemptAt > now) return { book, transfer: null };

  const started: Transfer = { ...item, status: 'uploading', sentBytes: 0, error: null };
  return { book: replace(book, clientId, started), transfer: started };
}

/**
 * Report bytes acknowledged by the network.
 *
 * Monotonic on purpose: a progress event that arrives out of order, or a retry
 * that restarts the stream, must never make the bar walk backwards.
 */
export function markProgress(book: TransferBook, clientId: string, sentBytes: number): TransferBook {
  const item = findTransfer(book, clientId);
  if (!item || item.status !== 'uploading') return book;

  const clamped = Math.max(0, Math.min(sentBytes, item.bytes));
  if (clamped <= item.sentBytes) return book;
  return replace(book, clientId, { ...item, sentBytes: clamped });
}

export function markUploaded(book: TransferBook, clientId: string): TransferBook {
  const item = findTransfer(book, clientId);
  if (!item) return book;
  return replace(book, clientId, {
    ...item,
    status: 'done',
    sentBytes: item.bytes,
    error: null,
    nextAttemptAt: 0
  });
}

/**
 * A transfer that did not finish.
 *
 * Backs off like the message queue, and drops the retry delay when the caller
 * knows the network is down - there is no point scheduling an attempt against a
 * connection that is not there, and `dueTransfers` will offer it again the
 * moment the browser says otherwise.
 */
export function markTransferFailed(
  book: TransferBook,
  clientId: string,
  now: number,
  error: string,
  options: { permanent?: boolean } = {},
  config: TransferConfig = defaultTransferConfig
): { book: TransferBook; exhausted: boolean } {
  const item = findTransfer(book, clientId);
  if (!item) return { book, exhausted: false };

  const attempts = item.attempts + 1;
  const gaveUp = options.permanent === true || attempts >= config.maxAttempts;

  const next: Transfer = {
    ...item,
    attempts,
    status: gaveUp ? 'failed' : 'queued',
    sentBytes: 0,
    error,
    nextAttemptAt: gaveUp
      ? Number.POSITIVE_INFINITY
      : now +
        Math.min(config.baseRetryDelayMs * 2 ** (attempts - 1), config.maxRetryDelayMs)
  };
  return { book: replace(book, clientId, next), exhausted: gaveUp };
}

export function retryTransfer(
  book: TransferBook,
  clientId: string,
  now: number
): TransferBook {
  const item = findTransfer(book, clientId);
  if (!item) return book;
  return replace(book, clientId, {
    ...item,
    attempts: 0,
    status: 'queued',
    sentBytes: 0,
    error: null,
    nextAttemptAt: now
  });
}

export function removeTransfer(book: TransferBook, clientId: string): TransferBook {
  if (!book.items.some((item) => item.clientId === clientId)) return book;
  return { items: book.items.filter((item) => item.clientId !== clientId) };
}

/** Nothing waiting, nothing running: the tray can hide itself. */
export function hasTransfers(book: TransferBook): boolean {
  return book.items.length > 0;
}

export function dueTransfers(
  book: TransferBook,
  now: number,
  config: TransferConfig = defaultTransferConfig
): Transfer[] {
  return book.items.filter(
    (item) =>
      item.status === 'queued' &&
      item.attempts < config.maxAttempts &&
      item.nextAttemptAt <= now
  );
}

export function percentOf(item: Transfer): number {
  if (item.status === 'done') return 100;
  if (item.bytes <= 0) return 0;
  return Math.min(99, Math.round((item.sentBytes / item.bytes) * 100));
}
