'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');

jest.setTimeout(30000);

/** The smallest real PNG: the server sniffs magic bytes, so a fake file is rejected. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const NOT_AN_IMAGE = Buffer.from('%PDF-1.4 this is a document, not a picture\n');

let ctx;

async function sessionId(displayName) {
  const res = await request(ctx.app).post('/api/sessions').send({ displayName });
  expect(res.status).toBe(201);
  return res.body.userId;
}

const as = (userId) => ({ 'X-Session-Id': userId });

const profile = async (userId) => {
  const res = await request(ctx.app).get('/api/me/profile').set(as(userId));
  expect(res.status).toBe(200);
  return res.body.profile;
};

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('profile and picture', () => {
  test('a fresh guest has a name, no note and no picture', async () => {
    const ana = await sessionId('Ana');
    const mine = await profile(ana);
    expect(mine).toMatchObject({ userId: ana, displayName: 'Ana' });
    expect(mine.avatar).toBeNull();
    expect(mine.note).toEqual({ text: '', updatedAt: null });
  });

  test('uploading a picture publishes it to the room and keeps it after a note change', async () => {
    const ana = await sessionId('Ana');
    const upload = await request(ctx.app)
      .put('/api/me/avatar')
      .set(as(ana))
      .attach('files', PNG, 'me.png');
    expect(upload.status).toBe(201);
    expect(upload.body.avatar.url).toMatch(/^\/media\/[0-9a-f-]{36}$/);

    await request(ctx.app).put('/api/me/note').set(as(ana)).send({ text: 'Coffee first.' });
    const mine = await profile(ana);
    expect(mine.avatar.url).toBe(upload.body.avatar.url);
    expect(mine.note.text).toBe('Coffee first.');

    const ben = await sessionId('Ben');
    const looked = await request(ctx.app).get('/api/profiles').set(as(ben)).query({ ids: ana });
    expect(looked.status).toBe(200);
    expect(looked.body.profiles).toEqual([{
      userId: ana,
      displayName: 'Ana',
      avatar: { url: upload.body.avatar.url, mime: 'image/png', size: PNG.length, updatedAt: expect.any(Number) },
    }]);

    const bytes = await request(ctx.app).get(upload.body.avatar.url.replace('/media/', '/media/'));
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/png');
  });

  test('replacing a picture retires the old file', async () => {
    const ana = await sessionId('Ana');
    const first = await request(ctx.app).put('/api/me/avatar').set(as(ana)).attach('files', PNG, 'first.png');
    const second = await request(ctx.app).put('/api/me/avatar').set(as(ana)).attach('files', PNG, 'second.png');
    expect(second.body.avatar.url).not.toBe(first.body.avatar.url);

    await request(ctx.app).get(first.body.avatar.url).expect(404);
    await request(ctx.app).get(second.body.avatar.url).expect(200);

    const mine = await profile(ana);
    expect(mine.avatar.url).toBe(second.body.avatar.url);
  });

  test('only an image can be a profile picture, and the reject is cleaned up', async () => {
    const ana = await sessionId('Ana');
    const res = await request(ctx.app).put('/api/me/avatar').set(as(ana)).attach('files', NOT_AN_IMAGE, 'doc.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('a profile picture must be an image');
    expect((await profile(ana)).avatar).toBeNull();
  });

  test('a picture is not swept away with the message window', async () => {
    const ana = await sessionId('Ana');
    const upload = await request(ctx.app).put('/api/me/avatar').set(as(ana)).attach('files', PNG, 'me.png');
    const mediaId = upload.body.avatar.url.split('/').pop();
    const record = await ctx.store.getMedia(mediaId);
    const ttlSeconds = (record.expiresAt - Date.now()) / 1000;
    // Room attachments in this test run expire in an hour; an avatar must not.
    expect(ttlSeconds).toBeGreaterThan(7 * 24 * 3600);

    // Reading your own profile slides the expiry forward again.
    const before = record.expiresAt;
    await profile(ana);
    expect((await ctx.store.getMedia(mediaId)).expiresAt).toBeGreaterThan(before);
  });

  test('removing the picture deletes the file and the pointer', async () => {
    const ana = await sessionId('Ana');
    const upload = await request(ctx.app).put('/api/me/avatar').set(as(ana)).attach('files', PNG, 'me.png');
    const removed = await request(ctx.app).delete('/api/me/avatar').set(as(ana));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: true });
    expect((await profile(ana)).avatar).toBeNull();
    await request(ctx.app).get(upload.body.avatar.url).expect(404);
    expect((await request(ctx.app).delete('/api/me/avatar').set(as(ana))).body).toEqual({ removed: false });
  });

  test('the lookup is capped and only accepts session ids', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    expect((await request(ctx.app).get('/api/profiles').set(as(ben)).query({ ids: ana })).status).toBe(200);

    const junk = await request(ctx.app).get('/api/profiles').set(as(ben)).query({ ids: 'not-a-uuid' });
    expect(junk.status).toBe(400);

    const empty = await request(ctx.app).get('/api/profiles').set(as(ben));
    expect(empty.status).toBe(400);

    const crowd = await request(ctx.app).get('/api/profiles').set(as(ben))
      .query({ ids: Array.from({ length: 61 }, () => crypto.randomUUID()).join(',') });
    expect(crowd.status).toBe(400);

    const anonymous = await request(ctx.app).get('/api/profiles').query({ ids: ana });
    expect(anonymous.status).toBe(401);
  });

  test('a guest that never existed has no profile, so nothing is invented', async () => {
    const ben = await sessionId('Ben');
    const ghost = crypto.randomUUID();
    const res = await request(ctx.app).get('/api/profiles').set(as(ben)).query({ ids: ghost });
    expect(res.body.profiles).toEqual([{ userId: ghost, displayName: null, avatar: null }]);
  });
});
