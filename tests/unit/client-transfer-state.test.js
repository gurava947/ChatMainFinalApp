/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadTransferProtocol } = require('../helpers/load-client-module');

const SRC = path.join(__dirname, '..', '..', 'client', 'src');
const WORKER_SOURCE = fs.readFileSync(path.join(SRC, 'workers', 'transfer-worker.js'), 'utf8');
const FACTORY_SOURCE = fs.readFileSync(path.join(SRC, 'transferWorker.js'), 'utf8');

const MB = 1024 * 1024;
let protocol;

beforeEach(() => {
  protocol = loadTransferProtocol();
});

describe('chunk arithmetic', () => {
  test('the slice size and ceiling are the ones the transport was designed around', () => {
    expect(protocol.TRANSFER_CHUNK_BYTES).toBe(16 * 1024);
    expect(protocol.TRANSFER_MAX_BYTES).toBe(100 * MB);
  });

  test('a file is counted in whole slices, with an empty file at zero', () => {
    expect(protocol.chunkCountFor(0)).toBe(0);
    expect(protocol.chunkCountFor(1)).toBe(1);
    expect(protocol.chunkCountFor(protocol.TRANSFER_CHUNK_BYTES)).toBe(1);
    expect(protocol.chunkCountFor(protocol.TRANSFER_CHUNK_BYTES + 1)).toBe(2);
    expect(protocol.chunkCountFor(protocol.TRANSFER_MAX_BYTES)).toBe(6400);
    expect(protocol.chunkCountFor('nonsense')).toBe(0);
  });

  test('the last slice is short and nothing slices past the end', () => {
    const size = protocol.TRANSFER_CHUNK_BYTES + 10;
    expect(protocol.chunkRange(size, 0)).toEqual({ offset: 0, length: protocol.TRANSFER_CHUNK_BYTES });
    expect(protocol.chunkRange(size, 1)).toEqual({ offset: protocol.TRANSFER_CHUNK_BYTES, length: 10 });
    expect(protocol.chunkRange(size, 2)).toBeNull();
    expect(protocol.chunkRange(size, -1)).toBeNull();
    expect(protocol.chunkRange(size, 1.5)).toBeNull();
    expect(protocol.chunkRange(-5, 0)).toBeNull();
  });
});

describe('the ack bitmap', () => {
  test('packs one bit per chunk into a few hundred bytes', () => {
    expect(protocol.createBitmap(0)).toHaveLength(0);
    expect(protocol.createBitmap(8)).toHaveLength(1);
    expect(protocol.createBitmap(9)).toHaveLength(2);
    expect(protocol.createBitmap(6400)).toHaveLength(800);
  });

  test('counting walks only the declared chunks', () => {
    const bitmap = protocol.createBitmap(10);
    protocol.markChunk(bitmap, 0);
    protocol.markChunk(bitmap, 9);
    protocol.markChunk(bitmap, 4);
    expect(protocol.receivedCount(bitmap, 10)).toBe(3);
    // A bitmap longer than the record cannot inflate progress.
    expect(protocol.receivedCount(bitmap, 2)).toBe(1);
  });

  test('a duplicate ack is cheap and changes nothing', () => {
    const bitmap = protocol.createBitmap(3);
    expect(protocol.markChunk(bitmap, 1)).toBe(true);
    expect(protocol.markChunk(bitmap, 1)).toBe(false);
    expect(protocol.receivedCount(bitmap, 3)).toBe(1);
  });

  test('an index outside the bitmap is refused rather than aliased onto another chunk', () => {
    const bitmap = protocol.createBitmap(2);
    expect(protocol.markChunk(bitmap, 99)).toBe(false);
    expect(protocol.markChunk(bitmap, -1)).toBe(false);
    expect(protocol.hasChunk(bitmap, 99)).toBe(false);
    expect(protocol.receivedCount(bitmap, 2)).toBe(0);
  });

  test('the next slice to send is the first hole, and completion is the absence of one', () => {
    const bitmap = protocol.createBitmap(4);
    expect(protocol.firstMissingChunk(bitmap, 4)).toBe(0);
    protocol.markChunk(bitmap, 0);
    protocol.markChunk(bitmap, 2);
    expect(protocol.firstMissingChunk(bitmap, 4)).toBe(1);
    expect(protocol.isComplete(bitmap, 4)).toBe(false);
    [1, 3].forEach((index) => protocol.markChunk(bitmap, index));
    expect(protocol.firstMissingChunk(bitmap, 4)).toBe(-1);
    expect(protocol.isComplete(bitmap, 4)).toBe(true);
  });

  test('an empty transfer is complete and reports 100%', () => {
    const record = protocol.createTransferRecord({ id: 'empty', name: 'empty.txt', size: 0, now: 1000 });
    expect(record.status).toBe('complete');
    expect(protocol.transferProgress(record)).toEqual({ received: 0, chunks: 0, percent: 100, complete: true });
  });
});

describe('the transfer record', () => {
  const record = (extra = {}) => protocol.createTransferRecord({
    id: 't1', name: 'holiday.jpg', mime: 'image/jpeg', size: 40 * 1024 + 3, room: 'sprint-room', now: 1000, ...extra,
  });

  test('a fresh record names its slices and claims no progress', () => {
    const created = record();
    expect(created).toMatchObject({
      id: 't1', room: 'sprint-room', name: 'holiday.jpg', mime: 'image/jpeg',
      size: 40 * 1024 + 3, chunkBytes: protocol.TRANSFER_CHUNK_BYTES, chunks: 3,
      received: 0, status: 'pending', createdAt: 1000, updatedAt: 1000,
    });
    expect(created.bitmap).toHaveLength(1);
    expect(protocol.transferProgress(created).percent).toBe(0);
  });

  test('an oversize file, a missing id or a missing size is refused where it is named', () => {
    expect(() => record({ size: protocol.TRANSFER_MAX_BYTES + 1 })).toThrow(RangeError);
    expect(() => record({ id: '' })).toThrow(RangeError);
    expect(() => record({ size: -1 })).toThrow(RangeError);
    expect(() => record({ size: 'big' })).toThrow(RangeError);
  });

  test('an ack returns a new record and never mutates the one that was persisted', () => {
    const created = record();
    const acked = protocol.ackChunk(created, 0, 2000);
    expect(acked).not.toBe(created);
    expect(acked.bitmap).not.toBe(created.bitmap);
    expect(protocol.receivedCount(created.bitmap, created.chunks)).toBe(0);
    expect(acked).toMatchObject({ received: 1, status: 'sending', updatedAt: 2000, completedAt: null });
  });

  test('the last ack completes the transfer and keeps the moment it did', () => {
    let current = record();
    current = protocol.ackChunk(current, 0, 2000);
    current = protocol.ackChunk(current, 2, 3000);
    current = protocol.ackChunk(current, 1, 4000);
    expect(current.status).toBe('complete');
    expect(current.completedAt).toBe(4000);
    expect(protocol.transferProgress(current)).toEqual({ received: 3, chunks: 3, percent: 100, complete: true });
  });

  test('an ack outside the slice range leaves the record alone', () => {
    const created = record();
    expect(protocol.ackChunk(created, 9)).toBe(created);
    expect(protocol.ackChunk(created, -1)).toBe(created);
    expect(protocol.ackChunk(null, 0)).toBeNull();
  });

  test('progress rounds to a tenth so a bar does not jitter on a long file', () => {
    let current = protocol.createTransferRecord({ id: 'small', size: 3 * protocol.TRANSFER_CHUNK_BYTES, now: 0 });
    current = protocol.ackChunk(current, 0, 1);
    expect(protocol.transferProgress(current).percent).toBe(33.3);
    current = protocol.ackChunk(current, 1, 1);
    expect(protocol.transferProgress(current).percent).toBe(66.7);
  });
});

describe('resuming', () => {
  const base = (extra = {}) => ({ id: 't1', status: 'sending', createdAt: 1000, updatedAt: 5000, ...extra });

  test('a recent transfer can resume; a week-old one cannot', () => {
    const day = 24 * 3600 * 1000;
    expect(protocol.canResume(base(), { now: 5000 })).toBe(true);
    expect(protocol.canResume(base(), { now: 5000 + 7 * day, ttlMs: 7 * day })).toBe(true);
    expect(protocol.canResume(base(), { now: 5000 + 7 * day + 1, ttlMs: 7 * day })).toBe(false);
    expect(protocol.canResume(null, { now: 5000 })).toBe(false);
  });

  test('a failed transfer is never resumed automatically', () => {
    expect(protocol.canResume(base({ status: 'failed' }), { now: 5000 })).toBe(false);
  });

  test('failing keeps the bitmap so a manual retry sends only what is missing', () => {
    const created = protocol.ackChunk(protocol.ackChunk(protocol.createTransferRecord({ id: 't', size: 3 * 16384, now: 0 }), 0), 1);
    const failed = protocol.failTransfer(created, 'peer left', 9000);
    expect(failed).toMatchObject({ status: 'failed', error: 'peer left', received: 2, updatedAt: 9000 });
    expect(protocol.firstMissingChunk(failed.bitmap, failed.chunks)).toBe(2);
  });
});

describe('the worker wiring', () => {
  test('the bundler can see the worker as its own module entry', () => {
    expect(FACTORY_SOURCE).toMatch(/new Worker\(new URL\('\.\/workers\/transfer-worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
    expect(FACTORY_SOURCE).toMatch(/typeof Worker === 'undefined'/);
  });

  test('slices are hashed off the main thread and handed over without a copy', () => {
    expect(WORKER_SOURCE).toMatch(/crypto\.subtle\.digest\('SHA-256'/);
    expect(WORKER_SOURCE).toMatch(/self\.postMessage\(/);
    expect(WORKER_SOURCE).toMatch(/\},\s*\[buffer\],?\s*\)/);
    expect(WORKER_SOURCE).toMatch(/case 'open'/);
    expect(WORKER_SOURCE).toMatch(/case 'pull'/);
    expect(WORKER_SOURCE).toMatch(/case 'manifest'/);
    expect(WORKER_SOURCE).toMatch(/case 'abort'/);
  });

  test('the worker commits to chunk boundaries in the manifest', () => {
    expect(WORKER_SOURCE).toMatch(/digests\.length \* 32/);
    expect(WORKER_SOURCE).toMatch(/type: 'manifest'/);
  });
});
