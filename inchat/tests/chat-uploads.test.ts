import { describe, expect, it } from 'vitest';

import {
  ACCEPT,
  ALLOWED_MIME_TYPES,
  BUCKET,
  MAX_UPLOAD_BYTES,
  MAX_VOICE_SECONDS,
  addTransfer,
  bytesLabel,
  defaultTransferConfig,
  dueTransfers,
  emptyTransfers,
  findTransfer,
  groupForMime,
  hasTransfers,
  markProgress,
  markTransferFailed,
  markUploaded,
  objectPath,
  pathInConversation,
  percentOf,
  removeTransfer,
  retryTransfer,
  startTransfer,
  validateFile,
  type Transfer,
  type TransferBook
} from '@/lib/chat/uploads';

const C = '6f9b2a3c-1d4e-5f60-7182-93a4b5c6d7e8';
const U = '1a2b3c4d-5e6f-0a1b-2c3d-4e5f60718293';
const F = '9f8e7d6c-5b4a-3210-fedc-ba9876543210';

function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    clientId: 'c-1',
    conversationId: C,
    path: `${C}/${U}/${F}.jpg`,
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    group: 'image',
    bytes: 1000,
    sentBytes: 0,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
    hd: false,
    width: null,
    height: null,
    durationSecs: null,
    ...over
  };
}

const bookOf = (...items: Transfer[]): TransferBook => ({ items });

describe('the bucket contract', () => {
  it('names the one private bucket the policies are written for', () => {
    expect(BUCKET).toBe('chat-media');
  });

  it('mirrors the buckets row: 50 MB, and the same mime list', () => {
    expect(MAX_UPLOAD_BYTES).toBe(52_428_800);
    expect(ALLOWED_MIME_TYPES).toContain('audio/webm');
    expect(ALLOWED_MIME_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(ALLOWED_MIME_TYPES).not.toContain('application/x-msdownload');
  });

  it('offers the picker the same types the bucket takes', () => {
    for (const mime of ['image/jpeg', 'video/mp4', 'audio/webm']) {
      expect(ACCEPT).toContain(mime);
    }
  });

  it('caps a voice note at five minutes', () => {
    expect(MAX_VOICE_SECONDS).toBe(300);
  });
});

describe('refusing a file before it costs anyone data', () => {
  it('lets an ordinary photo through', () => {
    expect(validateFile({ mimeType: 'image/jpeg', sizeBytes: 2_000_000 })).toBeNull();
  });

  it('refuses a type the bucket will not accept', () => {
    expect(validateFile({ mimeType: 'application/x-msdownload', sizeBytes: 10 })).toContain(
      'not allowed'
    );
  });

  it('refuses an empty file', () => {
    expect(validateFile({ mimeType: 'image/png', sizeBytes: 0 })).toBe('That file is empty');
  });

  it('refuses anything past the bucket ceiling', () => {
    expect(validateFile({ mimeType: 'video/mp4', sizeBytes: MAX_UPLOAD_BYTES + 1 })).toContain(
      '50 MB'
    );
  });

  it('names the group it was picked as when that is what failed', () => {
    const reason = validateFile({ mimeType: 'audio/webm', sizeBytes: 30_000_000, group: 'audio' });
    expect(reason).toBe('That audio is larger than 25 MB');
  });

  it('classifies a file by its type, not its name', () => {
    expect(groupForMime('image/png')).toBe('image');
    expect(groupForMime('audio/mpeg')).toBe('audio');
    expect(groupForMime('application/pdf')).toBe('file');
  });
});

describe('the object path is the authorization', () => {
  it('puts the conversation first and the uploader second', () => {
    expect(objectPath({ conversationId: C, uploaderId: U, fileId: F, extension: 'JPG' })).toBe(
      `${C}/${U}/${F}.jpg`
    );
  });

  it('refuses to build a path out of segments the policy cannot read', () => {
    // A non-uuid first segment resolves to null in SQL, which authorises nobody:
    // the upload would succeed and the file would be undownloadable.
    expect(() => objectPath({ conversationId: 'not-a-uuid', uploaderId: U, fileId: F, extension: 'png' })).toThrow();
    expect(() => objectPath({ conversationId: C, uploaderId: '', fileId: F, extension: 'png' })).toThrow();
  });

  it('drops an extension that would escape the bucket prefix', () => {
    const path = objectPath({ conversationId: C, uploaderId: U, fileId: F, extension: '../x' });
    expect(path).toBe(`${C}/${U}/${F}.x`);
    expect(path.split('/')).toHaveLength(3);
  });

  it('recognises a path from this conversation and not from another', () => {
    const path = objectPath({ conversationId: C, uploaderId: U, fileId: F, extension: 'png' });
    expect(pathInConversation(path, C)).toBe(true);
    expect(pathInConversation(path, U)).toBe(false);
    expect(pathInConversation(`${C}/${U}`, C)).toBe(false);
    expect(pathInConversation(`${C}/${U}/../../etc/passwd`, C)).toBe(false);
    // Somebody else's photo in this conversation still renders: the second
    // segment is their id, and the storage policy is what lets us read it.
    expect(pathInConversation(`${C}/${F}/${U}.png`, C)).toBe(true);
  });

  it('labels sizes the way a composer line reads', () => {
    expect(bytesLabel(512)).toBe('512 B');
    expect(bytesLabel(40_000)).toBe('39 KB');
    expect(bytesLabel(2_400_000)).toBe('2.3 MB');
    expect(bytesLabel(3_500_000_000)).toBe('3.3 GB');
  });
});

describe('the transfer machine', () => {
  it('queues each file once', () => {
    const book = addTransfer(addTransfer(emptyTransfers(), transfer()), transfer());
    expect(book.items).toHaveLength(1);
  });

  it('claims a queued transfer and nothing else', () => {
    const book = bookOf(transfer(), transfer({ clientId: 'c-2', status: 'done' }));
    const first = startTransfer(book, 'c-1', 1_000);
    expect(first.transfer?.status).toBe('uploading');
    expect(startTransfer(first.book, 'c-1', 2_000).transfer).toBeNull();
    expect(startTransfer(book, 'c-2', 2_000).transfer).toBeNull();
    expect(startTransfer(book, 'unknown', 2_000).transfer).toBeNull();
  });

  it('will not start a retry that is not due yet', () => {
    const { book } = markTransferFailed(bookOf(transfer()), 'c-1', 0, 'gone');
    expect(dueTransfers(book, 1_000)).toHaveLength(0);
    expect(dueTransfers(book, 5_000)).toHaveLength(1);
  });

  it('only reports progress upward', () => {
    const started = startTransfer(bookOf(transfer()), 'c-1', 0).book;
    const ahead = markProgress(started, 'c-1', 600);
    expect(findTransfer(ahead, 'c-1')?.sentBytes).toBe(600);
    // A late event from the part that already went, or a restart.
    expect(markProgress(ahead, 'c-1', 300).items[0].sentBytes).toBe(600);
    // Progress on a transfer that is not running changes nothing.
    expect(markProgress(bookOf(transfer()), 'c-1', 500).items[0].sentBytes).toBe(0);
  });

  it('never claims the last byte before the server has it', () => {
    const started = startTransfer(bookOf(transfer({ bytes: 100 })), 'c-1', 0).book;
    const full = markProgress(started, 'c-1', 100);
    expect(percentOf(full.items[0])).toBe(99);
    expect(percentOf(markUploaded(full, 'c-1').items[0])).toBe(100);
  });

  it('clamps a progress event that overshoots the file', () => {
    const started = startTransfer(bookOf(transfer({ bytes: 100 })), 'c-1', 0).book;
    expect(markProgress(started, 'c-1', 150).items[0].sentBytes).toBe(100);
  });

  it('backs off, then gives up and says so', () => {
    let book = bookOf(transfer());
    for (let attempt = 1; attempt < defaultTransferConfig.maxAttempts; attempt++) {
      const failed = markTransferFailed(book, 'c-1', attempt * 1_000, `attempt ${attempt}`);
      book = failed.book;
      expect(failed.exhausted).toBe(false);
      expect(book.items[0].status).toBe('queued');
      expect(book.items[0].attempts).toBe(attempt);
    }
    const last = markTransferFailed(book, 'c-1', 30_000, 'still down');
    expect(last.exhausted).toBe(true);
    expect(last.book.items[0].status).toBe('failed');
    expect(last.book.items[0].error).toBe('still down');
    expect(dueTransfers(last.book, Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });

  it('drops a transfer that will never succeed instead of retrying it', () => {
    const failed = markTransferFailed(bookOf(transfer()), 'c-1', 0, 'Not allowed', {
      permanent: true
    });
    expect(failed.exhausted).toBe(true);
    expect(failed.book.items[0].status).toBe('failed');
  });

  it('starts the countdown again when the user taps retry', () => {
    const exhausted = markTransferFailed(bookOf(transfer()), 'c-1', 0, 'gone', {
      permanent: true
    }).book;
    const again = retryTransfer(exhausted, 'c-1', 5_000);
    expect(again.items[0]).toMatchObject({
      status: 'queued',
      attempts: 0,
      sentBytes: 0,
      nextAttemptAt: 5_000,
      error: null
    });
    expect(startTransfer(again, 'c-1', 5_000).transfer).not.toBeNull();
  });

  it('forgets a transfer the user cancelled', () => {
    const book = bookOf(transfer(), transfer({ clientId: 'c-2' }));
    expect(removeTransfer(book, 'c-1').items.map((item) => item.clientId)).toEqual(['c-2']);
    expect(hasTransfers(removeTransfer(bookOf(transfer()), 'c-1'))).toBe(false);
    // Removing something that is not there returns the same book, not a copy.
    expect(removeTransfer(book, 'nope')).toBe(book);
  });

  it('leaves a finished or exhausted transfer out of the pump', () => {
    const done = markUploaded(bookOf(transfer()), 'c-1');
    expect(dueTransfers(done, 10_000)).toHaveLength(0);
    const failed = markTransferFailed(bookOf(transfer({ attempts: 2 })), 'c-1', 0, 'gone', {
      permanent: true
    }).book;
    expect(dueTransfers(failed, 10_000)).toHaveLength(0);
  });
});
