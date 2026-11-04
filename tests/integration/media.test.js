'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let ctx;

async function session(displayName) {
  const res = await request(ctx.app).post('/api/sessions').send({ displayName });
  return res.body.userId;
}

async function upload(userId, field) {
  return request(ctx.app)
    .post('/api/media')
    .set('X-Session-Id', userId)
    .attach('files', field.buffer, { filename: field.name, contentType: field.type })
    .field('caption', 'from test');
}

beforeAll(async () => {
  ctx = await createTestServer({ mediaMaxBytes: 4096, mediaMaxPerMessage: 2 });
});

afterAll(async () => {
  await ctx.close();
});

describe('media upload', () => {
  test('requires a session', async () => {
    const res = await request(ctx.app)
      .post('/api/media')
      .attach('files', PNG_HEAD, 'x.png');
    expect(res.status).toBe(401);
  });

  test('stores the sniffed type, not the declared one', async () => {
    const userId = await session('Ada');
    const res = await upload(userId, { buffer: PNG_HEAD, name: 'shot.png', type: 'application/octet-stream' });

    expect(res.status).toBe(201);
    const [media] = res.body.media;
    expect(media.mime).toBe('image/png');
    expect(media.kind).toBe('image');
    expect(media.url).toMatch(/^\/media\/[0-9a-f-]{36}$/);
    expect(media.expiresAt).toBeGreaterThan(Date.now());
  });

  test('keeps a MediaRecorder audio/webm upload classified as audio and accepts it as a voice message', async () => {
    const userId = await session('Voice');
    await ctx.authorizeRoomForTest(userId, 'voice-room');
    const recorderWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
    const uploaded = await upload(userId, { buffer: recorderWebm, name: 'voice.webm', type: 'audio/webm;codecs=opus' });
    expect(uploaded.status).toBe(201);
    const [audio] = uploaded.body.media;
    expect(audio.mime).toBe('audio/webm');
    expect(audio.kind).toBe('audio');

    const sent = await request(ctx.app)
      .post('/api/rooms/voice-room/messages')
      .set('X-Session-Id', userId)
      .send({
        attachments: [{ id: audio.id, kind: audio.kind, name: audio.name, mime: audio.mime, size: audio.size }],
        content: { type: 'voice', durationMs: 1200, peaks: [] }
      });
    expect(sent.status).toBe(201);
    expect(sent.body.content.type).toBe('voice');

    const recorderMp4 = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
    const mp4Upload = await upload(userId, { buffer: recorderMp4, name: 'voice.m4a', type: 'audio/mp4' });
    expect(mp4Upload.status).toBe(201);
    expect(mp4Upload.body.media[0]).toMatchObject({ mime: 'audio/mp4', kind: 'audio' });
  });

  test('rejects an upload larger than the configured budget', async () => {
    const userId = await session('Brute');
    const res = await upload(userId, { buffer: Buffer.alloc(8192, 1), name: 'big.png', type: 'image/png' });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('file_too_large');
  });

  test('rejects a request with no file part', async () => {
    const userId = await session('Empty');
    const res = await request(ctx.app)
      .post('/api/media')
      .set('X-Session-Id', userId)
      .field('caption', 'nothing here');
    expect(res.status).toBe(400);
  });
});

describe('media download', () => {
  test('serves an inline-safe type as inline with sandbox headers', async () => {
    const userId = await session('Ada');
    const uploaded = await upload(userId, { buffer: PNG_HEAD, name: 'shot.png', type: 'image/png' });
    const { url } = uploaded.body.media[0];

    const res = await request(ctx.app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  test('forces a scriptable type to download instead of render', async () => {
    const userId = await session('Eve');
    const uploaded = await upload(userId, { buffer: SVG, name: 'logo.svg', type: 'image/svg+xml' });
    const { url } = uploaded.body.media[0];

    const res = await request(ctx.app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  test('answers a byte range so video and audio can seek', async () => {
    const userId = await session('Ada');
    const uploaded = await upload(userId, {
      buffer: Buffer.from('a'.repeat(2048)),
      name: 'clip.txt',
      type: 'text/plain'
    });
    const { url } = uploaded.body.media[0];

    const res = await request(ctx.app).get(url).set('Range', 'bytes=100-199');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 100-199/2048');
    expect(res.headers['content-length']).toBe('100');
    expect(res.text).toHaveLength(100);
  });

  test('rejects an unsatisfiable range', async () => {
    const userId = await session('Ada');
    const uploaded = await upload(userId, {
      buffer: Buffer.from('b'.repeat(64)),
      name: 'tiny.txt',
      type: 'text/plain'
    });
    const { url } = uploaded.body.media[0];

    const res = await request(ctx.app).get(url).set('Range', 'bytes=500-900');
    expect(res.status).toBe(416);
  });

  test('unknown and malformed ids never touch the filesystem', async () => {
    expect((await request(ctx.app).get('/media/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await request(ctx.app).get('/media/../../etc/passwd')).status).not.toBe(200);
  });
});

describe('attachments on messages', () => {
  test('accepts an attachment the sender uploaded', async () => {
    const userId = await session('Ada');
    await ctx.authorizeRoomForTest(userId, 'launchpad');
    const uploaded = await upload(userId, { buffer: PNG_HEAD, name: 'shot.png', type: 'image/png' });
    const attached = uploaded.body.media[0];

    const res = await request(ctx.app)
      .post('/api/rooms/launchpad/messages')
      .set('X-Session-Id', userId)
      .send({ text: 'screenshot', attachments: [{ id: attached.id, kind: 'image', name: 'shot.png', mime: 'image/png', size: attached.size }] });

    expect(res.status).toBe(201);
    expect(res.body.attachments).toEqual([
      { id: attached.id, kind: 'image', name: 'shot.png', mime: 'image/png', size: attached.size }
    ]);

    const history = await request(ctx.app)
      .get('/api/rooms/launchpad/messages')
      .set('X-Session-Id', userId);
    expect(history.body.messages.at(-1).attachments[0].id).toBe(attached.id);
  });

  test('rejects an attachment id the sender does not own', async () => {
    const owner = await session('Owner');
    const thief = await session('Thief');
    await ctx.authorizeRoomForTest(owner, 'private');
    await ctx.authorizeRoomForTest(thief, 'private');
    const uploaded = await upload(owner, { buffer: PNG_HEAD, name: 'mine.png', type: 'image/png' });

    const res = await request(ctx.app)
      .post('/api/rooms/private/messages')
      .set('X-Session-Id', thief)
      .send({ text: 'steal', attachments: [{
        id: uploaded.body.media[0].id,
        kind: 'image',
        name: 'mine.png',
        mime: 'image/png',
        size: 8
      }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown attachment|does not belong/);
  });

  test('an attachment with no caption is still a message', async () => {
    const userId = await session('Ada');
    await ctx.authorizeRoomForTest(userId, 'launchpad');
    const uploaded = await upload(userId, { buffer: PNG_HEAD, name: 'silent.png', type: 'image/png' });
    const attached = uploaded.body.media[0];

    const res = await request(ctx.app)
      .post('/api/rooms/launchpad/messages')
      .set('X-Session-Id', userId)
      .send({
        attachments: [{
          id: attached.id, kind: attached.kind, name: attached.name, mime: attached.mime, size: attached.size
        }]
      });

    expect(res.status).toBe(201);
    expect(res.body.text).toBe('');
    expect(res.body.attachments).toHaveLength(1);
  });

  test('a message with neither text nor attachment is rejected', async () => {
    const userId = await session('Ada');
    await ctx.authorizeRoomForTest(userId, 'launchpad');
    const res = await request(ctx.app)
      .post('/api/rooms/launchpad/messages')
      .set('X-Session-Id', userId)
      .send({ text: '   ' });
    expect(res.status).toBe(400);
  });
});
