/** @jest-environment jsdom */

'use strict';

/**
 * The data-channel fast path, exercised as a real duplex conversation: two
 * controllers, two channels, the same framing and the same bitmap handshake the
 * browser would run. What is proved here is the part that is hard to see in a
 * demo - one frame per slice, backpressure, and a mid-way disconnect that
 * resumes without handing the receiver a chunk it already assembled.
 */

const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { loadFileTransfer, loadTransferProtocol } = require('../helpers/load-client-module');

const SRC = path.join(__dirname, '..', '..', 'client', 'src');
const CALL_HOOK_SOURCE = fs.readFileSync(path.join(SRC, 'useRoomCalls.js'), 'utf8');
const APP_SOURCE = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');

let transfer;
let protocol;
const controllers = [];

class FakeChannel {
  constructor() {
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.listeners = new Map();
    this.peer = null;
    this.dropped = false;
    this.sent = [];
    this.onDeliver = null;
  }

  addEventListener(type, handler) {
    const set = this.listeners.get(type) || new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type) {
    (this.listeners.get(type) || []).forEach((handler) => handler({ type }));
  }

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  shut() {
    this.readyState = 'closed';
    this.onclose?.();
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('the channel is not open');
    this.sent.push(data);
    if (this.dropped) return;
    const copy = typeof data === 'string' ? data : data.slice(0);
    setTimeout(() => {
      if (this.dropped || !this.peer || this.peer.readyState !== 'open') return
      this.peer.onDeliver?.(copy);
      this.peer.onmessage?.({ data: copy });
    }, 0);
  }
}

function pair() {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  return { a, b };
}

const controller = (extra = {}) => {
  const instance = transfer.createFileTransferController({ protocol, newId: () => 't1', ...extra });
  controllers.push(instance);
  return instance;
};

const pattern = (size) => new Uint8Array(size).map((_, index) => (index * 31 + 7) % 256);
const sha256 = (bytes) => nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
/**
 * The sender commits to SHA-256 over the per-chunk digests - the value the
 * Phase 3 worker produces - so the receiver's reconstruction must be built the
 * same way here.
 */
const manifestDigest = (bytes) => {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += protocol.TRANSFER_CHUNK_BYTES) {
    parts.push(nodeCrypto.createHash('sha256').update(Buffer.from(bytes.slice(offset, offset + protocol.TRANSFER_CHUNK_BYTES))).digest());
  }
  return sha256(Buffer.concat(parts));
};
const waitFor = async (condition, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the transfer');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

beforeEach(() => {
  transfer = loadFileTransfer();
  protocol = loadTransferProtocol();
  // jsdom ships a Blob without the promise readers modern browsers have; the
  // engine is written against the browser API, so give the fake one the same
  // surface through the reader jsdom does implement.
  if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value: function readArrayBuffer() {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(this);
        });
      },
    });
  }
  // jsdom's crypto has no digest; the browser's does, and the fallback the
  // module uses when it does not is deliberately "accept the file".
  if (!globalThis.crypto) globalThis.crypto = {};
  Object.defineProperty(globalThis.crypto, 'subtle', {
    configurable: true,
    value: {
      digest: async (_algorithm, data) => {
        const hash = nodeCrypto.createHash('sha256').update(Buffer.from(data)).digest();
        return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
      },
    },
  });
});

afterEach(() => {
  controllers.splice(0).forEach((instance) => instance.abortAll());
  delete globalThis.crypto.subtle;
});

describe('framing', () => {
  test('a chunk is one message with its slot and index in the header', () => {
    const frame = transfer.encodeChunkFrame(7, 42, new Uint8Array([1, 2, 3]).buffer);
    expect(frame.byteLength).toBe(transfer.FILE_HEADER_BYTES + 3);
    const decoded = transfer.decodeChunkFrame(frame);
    expect(decoded).toMatchObject({ slot: 7, index: 42 });
    expect(Array.from(new Uint8Array(decoded.bytes))).toEqual([1, 2, 3]);
  });

  test('a short or non-binary frame is refused rather than misread', () => {
    expect(transfer.decodeChunkFrame('hello')).toBeNull();
    expect(transfer.decodeChunkFrame(new ArrayBuffer(4))).toBeNull();
    expect(transfer.decodeChunkFrame(null)).toBeNull();
  });

  test('control frames round-trip and malformed JSON reads as absent', () => {
    expect(transfer.parseControlFrame(transfer.controlFrame('file:ack', { id: 'a', received: 3 })))
      .toEqual({ t: 'file:ack', id: 'a', received: 3 });
    expect(transfer.parseControlFrame('{oops')).toBeNull();
    expect(transfer.parseControlFrame('{"id":"no-type"}')).toBeNull();
    expect(transfer.parseControlFrame(12)).toBeNull();
  });

  test('a bitmap survives JSON as byte values', () => {
    const bitmap = protocol.createBitmap(20);
    [0, 3, 19].forEach((index) => protocol.markChunk(bitmap, index));
    const restored = transfer.bitmapFromArray(transfer.bitmapToArray(bitmap), 20);
    expect(Array.from(restored)).toEqual(Array.from(bitmap));
    // A bitmap wider than the record cannot set bits past it.
    expect(transfer.bitmapFromArray([255, 255, 255], 4)).toHaveLength(1);
  });

  test('the cache key names the same file across a message boundary', () => {
    expect(transfer.directFileKey('clip.mp4', 1024, 'video/mp4')).toBe('clip.mp4|1024|video/mp4');
    expect(transfer.directFileKey(null, 'x', null)).toBe('|0|');
  });
});

describe('backpressure', () => {
  test('a drained channel is sent to without waiting', async () => {
    const channel = new FakeChannel();
    channel.readyState = 'open';
    await expect(transfer.waitForDrain(channel)).resolves.toBeUndefined();
  });

  test('a full channel holds the sender until the low-water event', async () => {
    const channel = new FakeChannel();
    channel.readyState = 'open';
    channel.bufferedAmount = 4 * 1024 * 1024;
    const pending = transfer.waitForDrain(channel, 1024 * 1024, 256 * 1024);
    setTimeout(() => {
      channel.bufferedAmount = 0;
      channel.dispatch('bufferedamountlow');
    }, 10);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('a transfer between two controllers', () => {
  test('sends one frame per slice and the receiver verifies the digest', async () => {
    const { a, b } = pair();
    const received = [];
    const receiver = controller({ onReceived: (file) => received.push(file) });
    const sender = controller();
    receiver.attach(b);
    sender.attach(a);
    a.open();
    b.open();

    const bytes = pattern(40 * protocol.TRANSFER_CHUNK_BYTES);
    const digest = manifestDigest(bytes);
    const handle = sender.send(new File([bytes], 'clip.bin', { type: 'application/octet-stream' }), { digest });
    expect(handle.transferId).toBe('t1');

    const done = await handle.done;
    expect(done).toMatchObject({ name: 'clip.bin', size: bytes.length, digest });

    const frames = a.sent.filter((data) => typeof data !== 'string').map((data) => transfer.decodeChunkFrame(data));
    expect(frames).toHaveLength(40);
    expect(frames.map((frame) => frame.index).sort((left, right) => left - right)).toEqual([...Array(40).keys()]);
    expect(manifestDigest(Buffer.concat(frames.map((frame) => Buffer.from(frame.bytes))))).toBe(digest);

    expect(received).toHaveLength(1);
    expect(received[0].blob.size).toBe(bytes.length);
    expect(received[0].digest).toBe(digest);
  }, 20000);

  test('acks carry the bitmap and drive progress before the file is complete', async () => {
    const { a, b } = pair();
    const progress = [];
    const receiver = controller();
    const sender = controller();
    receiver.attach(b);
    sender.attach(a);
    a.open();
    b.open();

    const bytes = pattern(protocol.TRANSFER_CHUNK_BYTES * 70);
    const handle = sender.send(new File([bytes], 'clip.bin'), { digest: manifestDigest(bytes), onProgress: (state) => progress.push(state.percent) });
    await handle.done;
    // 70 chunks ack at 32 and 64, then complete at 100.
    expect(progress).toEqual(expect.arrayContaining([0, 45.7, 91.4, 100]));
  }, 20000);

  test('a rebuilt channel resumes from the receiver bitmap without a duplicate chunk', async () => {
    const first = pair();
    const delivered = [];
    first.b.onDeliver = (data) => {
      if (typeof data !== 'string') {
        delivered.push(transfer.decodeChunkFrame(data).index);
        // The socket dies halfway through the file: frames already queued
        // behind this one are lost, which is what a real disconnect does.
        if (delivered.length === 300) first.a.dropped = true;
      }
    };
    const received = [];
    const receiver = controller({ onReceived: (file) => received.push(file) });
    const sender = controller();
    receiver.attach(first.b);
    sender.attach(first.a);
    first.a.open();
    first.b.open();

    const chunks = Math.ceil((20 * 1024 * 1024) / protocol.TRANSFER_CHUNK_BYTES);
    const bytes = pattern(chunks * protocol.TRANSFER_CHUNK_BYTES);
    const digest = manifestDigest(bytes);
    const handle = sender.send(new File([bytes], 'clip.bin'), { digest });

    await waitFor(() => delivered.length >= 300);
    // The peer connection drops mid-transfer: stop delivering what was already
    // queued, detach both sides, and let the controllers keep their bitmaps.
    first.a.dropped = true;
    sender.detach();
    receiver.detach();
    first.a.shut();
    first.b.shut();

    const second = pair();
    second.b.onDeliver = (data) => {
      if (typeof data !== 'string') delivered.push(transfer.decodeChunkFrame(data).index);
    };
    receiver.attach(second.b);
    sender.attach(second.a);
    second.a.open();
    second.b.open();

    const done = await handle.done;
    expect(done.digest).toBe(digest);
    expect(received).toHaveLength(1);
    expect(received[0].blob.size).toBe(bytes.length);

    // Every slice reached the receiver exactly once: the resume rewound the
    // sender to the receiver's bitmap instead of replaying the whole file.
    expect(delivered.length).toBe(chunks);
    expect(new Set(delivered).size).toBe(chunks);
    expect([...delivered].sort((left, right) => left - right)).toEqual([...Array(chunks).keys()]);
  }, 120000);

  test('the server path is the answer when no channel opens in the window', async () => {
    const sender = controller();
    await expect(sender.whenOpen(40)).resolves.toBe(false);
    expect(sender.send(new File([new Uint8Array(8)], 'tiny.bin'), { digest: null })).toBeNull();
  });

  test('binding tells the peer which media id these bytes became', async () => {
    const { a, b } = pair();
    const bounds = [];
    const receiver = controller({ onBound: (binding) => bounds.push(binding) });
    const sender = controller();
    receiver.attach(b);
    sender.attach(a);
    a.open();
    b.open();

    const bytes = pattern(protocol.TRANSFER_CHUNK_BYTES);
    sender.send(new File([bytes], 'clip.bin'), { digest: manifestDigest(bytes) });
    await waitFor(() => a.sent.some((data) => typeof data === 'string' && data.includes('file:manifest')));
    expect(sender.bind('t1', 'media-9')).toBe(true);
    await waitFor(() => bounds.length === 1);
    expect(bounds[0]).toEqual({ transferId: 't1', mediaId: 'media-9' });
  }, 20000);

  test('a receiver refuses a manifest larger than the ceiling', async () => {
    const { a, b } = pair();
    const received = [];
    const receiver = controller({ onReceived: (file) => received.push(file) });
    receiver.attach(b);
    a.open();
    b.open();
    a.send(transfer.controlFrame('file:manifest', {
      id: 'huge', slot: 1, name: 'huge.bin', mime: '', size: protocol.TRANSFER_MAX_BYTES + 1,
      chunks: 6401, chunkBytes: protocol.TRANSFER_CHUNK_BYTES, digest: null,
    }));
    await waitFor(() => b.sent.some((data) => typeof data === 'string' && data.includes('too-large')));
    expect(received).toHaveLength(0);
  });

  test('an empty file completes without a chunk frame', async () => {
    const { a, b } = pair();
    const received = [];
    const receiver = controller({ onReceived: (file) => received.push(file) });
    const sender = controller();
    receiver.attach(b);
    sender.attach(a);
    a.open();
    b.open();
    const handle = sender.send(new File([], 'empty.txt', { type: 'text/plain' }), { digest: manifestDigest(new Uint8Array(0)) });
    const done = await handle.done;
    expect(done.size).toBe(0);
    expect(received[0].blob.size).toBe(0);
    expect(a.sent.filter((data) => typeof data !== 'string')).toHaveLength(0);
  }, 20000);
});

describe('the wiring the browser sees', () => {
  test('the call opens one ordered channel and attaches whatever arrives', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/createDataChannel\(FILE_CHANNEL_LABEL, \{ ordered: true \}\)/);
    expect(CALL_HOOK_SOURCE).toMatch(/connection\.ondatachannel = \(event\) =>/);
    expect(CALL_HOOK_SOURCE).toMatch(/event\.channel\?\.label !== FILE_CHANNEL_LABEL/);
    expect(CALL_HOOK_SOURCE).toMatch(/sendFileToPeer/);
    expect(CALL_HOOK_SOURCE).toMatch(/bindFileToPeer/);
    expect(CALL_HOOK_SOURCE).toMatch(/abortAll\(\)/);
  });

  test('the composer runs the direct path beside the upload and falls back quietly', () => {
    expect(APP_SOURCE).toMatch(/startDirectSend\(file\)/);
    expect(APP_SOURCE).toMatch(/sendFileToPeer\(file, \{\s*digest/);
    expect(APP_SOURCE).toMatch(/uploadFiles\(prepared, \{\s*onProgress/);
    expect(APP_SOURCE).toMatch(/bindFileToPeer\(handle\.transferId, uploaded\[index\]\.id\)/);
    expect(APP_SOURCE).toMatch(/Sending directly/);
    expect(APP_SOURCE).toMatch(/directUrl: directFiles\[/);
  });

  test('the sender hashes in the Phase 3 worker before the manifest goes out', () => {
    expect(APP_SOURCE).toMatch(/createTransferWorker\(\)/);
    expect(APP_SOURCE).toMatch(/worker\.postMessage\(\{ type: 'manifest', id \}\)/);
    expect(APP_SOURCE).toMatch(/type: 'open', id, file/);
  });
});
