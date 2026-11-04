import { describe, expect, it } from 'vitest';

import {
  accessTokenOf,
  objectUploadUrl,
  uploadObject,
  type ProgressEvent,
  type RequestLike
} from '@/lib/chat/uploader';

const C = '6f9b2a3c-1d4e-5f60-7182-93a4b5c6d7e8';
const U = '1a2b3c4d-5e6f-0a1b-2c3d-4e5f60718293';
const F = '9f8e7d6c-5b4a-3210-fedc-ba9876543210';

/**
 * A hand-rolled XMLHttpRequest.
 *
 * The test drives the four things the transport can do - send, report bytes,
 * finish, be aborted - and records everything it was asked for, so the headers
 * the bucket policy reads are asserted rather than assumed.
 */
class FakeRequest implements RequestLike {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  sent = false;
  aborted = false;
  status = 0;
  timeout = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
    this.sent = true;
  }

  abort() {
    this.aborted = true;
  }

  succeed(status = 200) {
    this.status = status;
    this.onload?.();
  }

  fail() {
    this.status = 0;
    this.onerror?.();
  }

  expire() {
    this.ontimeout?.();
  }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable });
  }
}

const baseRequest = {
  supabaseUrl: 'https://project.supabase.co',
  accessToken: 't',
  anonKey: 'a',
  path: `${C}/${U}/${F}.jpg`,
  mimeType: 'image/jpeg',
  body: 'bytes'
};

describe('the storage request', () => {
  it('addresses the private bucket by the object path, not a signed url', () => {
    expect(objectUploadUrl('https://project.supabase.co/', 'chat-media', `${C}/${U}/${F}.jpg`)).toBe(
      `https://project.supabase.co/storage/v1/object/chat-media/${C}/${U}/${F}.jpg`
    );
  });

  it('encodes a name that would otherwise change how the url is read', () => {
    const url = objectUploadUrl('https://project.supabase.co', 'chat-media', `${C}/${U}/a#b?.jpg`);
    expect(url.endsWith(`${C}/${U}/a%23b%3F.jpg`)).toBe(true);
    expect(url.split('#')).toHaveLength(1);
  });

  it('sends the caller own credentials and nothing else', () => {
    const xhr = new FakeRequest();
    void uploadObject({
      ...baseRequest,
      accessToken: 'user-token',
      anonKey: 'public-anon-key',
      newRequest: () => xhr
    });
    expect(xhr.method).toBe('POST');
    expect(xhr.headers['apikey']).toBe('public-anon-key');
    expect(xhr.headers['Authorization']).toBe('Bearer user-token');
    expect(xhr.headers['Content-Type']).toBe('image/jpeg');
    expect(xhr.body).toBe('bytes');
    expect(xhr.timeout).toBeGreaterThan(0);
  });

  it('reports bytes as they leave, and ignores a total it cannot compute', async () => {
    const seen: Array<[number, number]> = [];
    const xhr = new FakeRequest();
    const pending = uploadObject({
      ...baseRequest,
      newRequest: () => xhr,
      onProgress: (loaded, total) => seen.push([loaded, total])
    });

    xhr.progress(400, 1000);
    xhr.progress(1000, 1000, false);
    xhr.succeed();

    await expect(pending).resolves.toEqual({ ok: true, path: `${C}/${U}/${F}.jpg` });
    expect(seen).toEqual([[400, 1000]]);
  });

  it('turns a refusal into an answer the queue can show', async () => {
    const xhr = new FakeRequest();
    const pending = uploadObject({ ...baseRequest, newRequest: () => xhr });
    xhr.succeed(400);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: 'Storage refused the file (400)'
    });
  });

  it('names a dropped connection differently from a slow one', async () => {
    const dropped = new FakeRequest();
    const failing = uploadObject({ ...baseRequest, newRequest: () => dropped });
    dropped.fail();
    await expect(failing).resolves.toMatchObject({ ok: false, reason: 'The upload failed' });

    const slow = new FakeRequest();
    const timing = uploadObject({ ...baseRequest, newRequest: () => slow });
    slow.expire();
    await expect(timing).resolves.toMatchObject({ ok: false, reason: 'The upload timed out' });
  });

  it('gives the caller a way to stop, and settles once', async () => {
    const xhr = new FakeRequest();
    const captured: { cancel?: () => void } = {};
    const pending = uploadObject({
      ...baseRequest,
      newRequest: () => xhr,
      onAbortReady: (cancel) => {
        captured.cancel = cancel;
      }
    });
    const stop = captured.cancel;
    if (!stop) throw new Error('the transport never offered a cancel');

    stop();
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'Upload cancelled' });
    expect(xhr.aborted).toBe(true);

    // The browser still fires load for a request that ended; the queue must not
    // be told the same transfer finished after it was cancelled.
    xhr.succeed();
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'Upload cancelled' });
  });
});

describe('the token the request is signed with', () => {
  it('is the session access token', () => {
    expect(accessTokenOf({ access_token: 'abc' })).toBe('abc');
  });

  it('is nothing when the session is missing or expired out from under the tab', () => {
    expect(accessTokenOf(null)).toBeNull();
    expect(accessTokenOf({})).toBeNull();
    expect(accessTokenOf({ access_token: '' })).toBeNull();
  });
});
