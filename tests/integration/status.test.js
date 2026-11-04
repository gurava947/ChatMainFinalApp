'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');
const { waitFor, openSocket } = require('../helpers/socket-harness');
const { STATUS_TTL_SECONDS, STATUS_MAX_PER_USER, STATUS_COLORS } = require('../../src/constants');

jest.setTimeout(30000);

let ctx;

/** The smallest real PNG: the server sniffs magic bytes, so a fake file is rejected. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const NOT_AN_IMAGE = Buffer.from('%PDF-1.4 this is a document, not a picture\n');

const STATUS_KEYS = ['id', 'kind', 'text', 'color', 'media', 'createdAt', 'expiresAt', 'remainingMs', 'author', 'mine', 'viewedByMe', 'viewerCount'];

async function sessionId(displayName) {
  const res = await request(ctx.app).post('/api/sessions').send({ displayName });
  expect(res.status).toBe(201);
  return res.body.userId;
}

const as = (userId) => ({ 'X-Session-Id': userId });

async function upload(userId, file, name) {
  const res = await request(ctx.app).post('/api/media').set(as(userId)).attach('files', file, name);
  expect(res.status).toBe(201);
  return res.body.media[0];
}

async function feed(userId) {
  const res = await request(ctx.app).get('/api/statuses').set(as(userId));
  expect(res.status).toBe(200);
  return res.body.statuses;
}

/** Every test shares one store, so a feed assertion always names its author. */
async function cardsBy(authorId, viewerId) {
  return (await feed(viewerId)).filter((row) => row.author.userId === authorId);
}

const card = (text = 'Out today.', color = STATUS_COLORS[0]) => ({ kind: 'text', text, color });

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('text statuses', () => {
  test('a posted card appears in the feed and dies with its own clock', async () => {
    const ana = await sessionId('Ana');
    const created = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('Coffee first.'));
    expect(created.status).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual([...STATUS_KEYS].sort());
    expect(created.body).toMatchObject({
      kind: 'text',
      text: 'Coffee first.',
      color: STATUS_COLORS[0],
      media: null,
      mine: true,
      viewedByMe: false,
      viewerCount: 0,
      author: { userId: ana, displayName: 'Ana', avatar: null }
    });
    expect(created.body.expiresAt - created.body.createdAt).toBe(STATUS_TTL_SECONDS * 1000);
    expect(STATUS_COLORS).toContain(created.body.color);

    const dayMs = STATUS_TTL_SECONDS * 1000;
    const seen = (await feed(ana)).find((row) => row.id === created.body.id);
    expect(seen.remainingMs).toBeGreaterThan(dayMs - 5000);
    expect(seen.remainingMs).toBeLessThanOrEqual(dayMs);

    // The clock has to actually move for the countdown to be observable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const later = (await feed(ana)).find((row) => row.id === created.body.id);
    expect(later.remainingMs).toBeLessThan(seen.remainingMs);
  });

  test('markup in a card is stripped the same way chat text is', async () => {
    const ana = await sessionId('Ana');
    const res = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('<script>alert(1)</script> ship it'));
    expect(res.status).toBe(201);
    expect(res.body.text).toBe('ship it');
  });

  test('a card older than a day is gone from every list', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const created = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('Yesterday.'));
    const record = await ctx.store.getStatus(created.body.id);
    record.expiresAt = Date.now() - 1;
    await ctx.store.saveStatus(record);

    expect(await cardsBy(ana, ben)).toEqual([]);
    expect(await cardsBy(ana, ana)).toEqual([]);
    expect((await request(ctx.app).post(`/api/statuses/${created.body.id}/view`).set(as(ben))).status).toBe(404);
    expect((await request(ctx.app).delete(`/api/statuses/${created.body.id}`).set(as(ana))).body).toEqual({ removed: false });
  });

  test('only the author reads who looked, and a view is counted once', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const cleo = await sessionId('Cleo');
    const created = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('Anyone about?'));
    const id = created.body.id;

    const self = await request(ctx.app).post(`/api/statuses/${id}/view`).set(as(ana));
    expect(self.status).toBe(200);
    expect(self.body).toEqual({ viewers: 0 });

    expect((await request(ctx.app).post(`/api/statuses/${id}/view`).set(as(ben))).body).toEqual({ viewers: 1 });
    expect((await request(ctx.app).post(`/api/statuses/${id}/view`).set(as(ben))).body).toEqual({ viewers: 1 });
    expect((await request(ctx.app).post(`/api/statuses/${id}/view`).set(as(cleo))).body).toEqual({ viewers: 2 });

    // The author never appears in their own viewer list, so their own card reads
    // as unviewed even after they opened it.
    const row = (await feed(ana)).find((entry) => entry.id === id);
    expect(row).toMatchObject({ viewerCount: 2, viewedByMe: false });
    expect((await feed(ben)).find((entry) => entry.id === id).viewedByMe).toBe(true);
    expect((await feed(cleo)).find((entry) => entry.id === id).viewedByMe).toBe(true);

    const listed = await request(ctx.app).get(`/api/statuses/${id}/viewers`).set(as(ana));
    expect(listed.status).toBe(200);
    expect(listed.body.viewers).toHaveLength(2);
    expect(listed.body.viewers.map((entry) => entry.displayName)).toEqual(['Ben', 'Cleo']);
    expect(listed.body.viewers[0]).toMatchObject({ userId: ben, displayName: 'Ben' });
    expect(typeof listed.body.viewers[0].at).toBe('number');

    expect((await request(ctx.app).get(`/api/statuses/${id}/viewers`).set(as(ben))).status).toBe(403);
    expect((await request(ctx.app).get(`/api/statuses/${id}/viewers`)).status).toBe(401);
  });

  test('the cards one guest may post are capped, and the cap says so', async () => {
    const ana = await sessionId('Ana');
    for (let i = 0; i < STATUS_MAX_PER_USER; i += 1) {
      const res = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card(`Card ${i + 1}`));
      expect(res.status).toBe(201);
    }

    const extra = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('One too many'));
    expect(extra.status).toBe(429);
    expect(extra.body.error).toBe(`only ${STATUS_MAX_PER_USER} active statuses at a time`);
    expect((await feed(ana)).filter((row) => row.author.userId === ana)).toHaveLength(STATUS_MAX_PER_USER);
  });

  test('a card is rejected before it is stored when the payload is not on the palette', async () => {
    const ana = await sessionId('Ana');

    const offPalette = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('Neon', '#123456'));
    expect(offPalette.status).toBe(400);
    expect(offPalette.body.error).toBe('status colour is not on the palette');

    const blank = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('   '));
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe('status text is empty');

    const long = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('x'.repeat(201)));
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('status text is too long');

    expect(await cardsBy(ana, ana)).toEqual([]);
  });
});

describe('media statuses', () => {
  test('an uploaded picture becomes a card that delivers through the media URL', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const picture = await upload(ana, PNG, 'me.png');

    const created = await request(ctx.app).post('/api/statuses').set(as(ana)).send({ kind: 'image', mediaId: picture.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'image',
      text: '',
      color: null,
      media: { id: picture.id, url: `/media/${picture.id}`, mime: 'image/png', name: 'me.png' }
    });

    const bytes = await request(ctx.app).get(`/media/${picture.id}`);
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/png');

    expect((await feed(ben)).find((row) => row.id === created.body.id).media.url).toBe(`/media/${picture.id}`);
  });

  test('the author keeps their current name and picture in someone else feed', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const avatar = await request(ctx.app).put('/api/me/avatar').set(as(ana)).attach('files', PNG, 'face.png');
    expect(avatar.status).toBe(201);

    const created = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('With a face.'));
    const row = (await feed(ben)).find((entry) => entry.id === created.body.id);
    expect(row.author).toEqual({ userId: ana, displayName: 'Ana', avatar: { url: avatar.body.avatar.url } });
  });

  test('a card may only point at media this session uploaded as this kind', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const picture = await upload(ana, PNG, 'mine.png');
    const document = await upload(ana, NOT_AN_IMAGE, 'paper.pdf');

    const stolen = await request(ctx.app).post('/api/statuses').set(as(ben)).send({ kind: 'image', mediaId: picture.id });
    expect(stolen.status).toBe(400);
    expect(stolen.body.error).toBe('media does not belong to this session');

    const wrongKind = await request(ctx.app).post('/api/statuses').set(as(ana)).send({ kind: 'image', mediaId: document.id });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error).toBe('status media must be image');

    const unknown = await request(ctx.app).post('/api/statuses').set(as(ana)).send({ kind: 'image', mediaId: crypto.randomUUID() });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('unknown media id');

    const video = await request(ctx.app).post('/api/statuses').set(as(ana)).send({ kind: 'video', mediaId: picture.id });
    expect(video.status).toBe(400);
    expect(video.body.error).toBe('status media must be video');

    expect(await cardsBy(ana, ana)).toEqual([]);
  });

  test('only the author may delete a card, and the file goes with it', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const picture = await upload(ana, PNG, 'gone.png');
    const created = await request(ctx.app).post('/api/statuses').set(as(ana)).send({ kind: 'image', mediaId: picture.id });
    const id = created.body.id;

    expect((await request(ctx.app).delete(`/api/statuses/${id}`).set(as(ben))).status).toBe(403);
    expect((await request(ctx.app).get(`/media/${picture.id}`)).status).toBe(200);

    const removed = await request(ctx.app).delete(`/api/statuses/${id}`).set(as(ana));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: true });

    expect((await feed(ana)).some((row) => row.id === id)).toBe(false);
    expect(await cardsBy(ana, ana)).toEqual([]);
    expect((await request(ctx.app).get(`/media/${picture.id}`)).status).toBe(404);
    expect((await request(ctx.app).delete(`/api/statuses/${id}`).set(as(ana))).body).toEqual({ removed: false });
    expect((await request(ctx.app).delete(`/api/statuses/${crypto.randomUUID()}`).set(as(ana))).status).toBe(200);
  });

  test('an unknown card id is a 404 in the shape every other route uses', async () => {
    const ana = await sessionId('Ana');
    const missing = crypto.randomUUID();
    expect((await request(ctx.app).post(`/api/statuses/${missing}/view`).set(as(ana))).status).toBe(404);
    expect((await request(ctx.app).get(`/api/statuses/${missing}/viewers`).set(as(ana))).status).toBe(404);
    expect((await request(ctx.app).get(`/api/statuses/${missing}/viewers`).set(as(ana))).body).toEqual({ error: 'status_not_found' });
  });
});

describe('status broadcasts', () => {
  test('every connected socket hears a card arrive and leave', async () => {
    const ana = await sessionId('Ana');
    const ben = await sessionId('Ben');
    const watcher = openSocket(ctx.url, ben, 'p8-updates');
    await waitFor(watcher, 'presence');

    const created = await request(ctx.app).post('/api/statuses').set(as(ana)).send(card('Live.'));
    expect(await waitFor(watcher, 'status_created', (p) => p.id === created.body.id)).toMatchObject({
      id: created.body.id,
      kind: 'text',
      createdAt: created.body.createdAt,
      author: { userId: ana, displayName: 'Ana' }
    });

    await request(ctx.app).delete(`/api/statuses/${created.body.id}`).set(as(ana));
    expect(await waitFor(watcher, 'status_removed', (p) => p.id === created.body.id)).toMatchObject({
      id: created.body.id,
      kind: 'text',
      author: { userId: ana, displayName: 'Ana' }
    });

    watcher.close();
  });
});
