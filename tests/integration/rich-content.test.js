'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');
const { waitFor, emitWithAck, openSocket } = require('../helpers/socket-harness');

jest.setTimeout(30000);

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let ctx;

async function sessionId(displayName) {
  const res = await request(ctx.app).post('/api/sessions').send({ displayName });
  return res.body.userId;
}

async function uploadPng(userId) {
  const res = await request(ctx.app)
    .post('/api/media')
    .set('X-Session-Id', userId)
    .attach('files', PNG_HEAD, { filename: 'shot.png', contentType: 'image/png' });
  return res.body.media[0];
}

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('structured messages on the wire', () => {
  test('a poll reaches the room as a ballot and a vote updates every reader', async () => {
    const author = await sessionId('Priya');
    const voter = await sessionId('Arjun');
    const a = openSocket(ctx.url, author, 'weekend');
    const b = openSocket(ctx.url, voter, 'weekend');
    await waitFor(b, 'history');

    const ack = await emitWithAck(a, 'message', {
      text: 'Plan it',
      content: { type: 'poll', question: 'Pick a day', options: ['Saturday', 'Sunday'] }
    });
    expect(ack.ok).toBe(true);

    const posted = await waitFor(b, 'new_message', (p) => p.id === ack.id);
    expect(posted.kind).toBe('poll');
    expect(posted.content.options).toEqual(['Saturday', 'Sunday']);
    expect(posted.results).toBeUndefined();

    const broadcast = waitFor(a, 'poll_voted', (p) => p.messageId === ack.id);
    const voteAck = await emitWithAck(b, 'poll:vote', { messageId: ack.id, choices: [1] });
    expect(voteAck.ok).toBe(true);
    expect(voteAck.results.options[1].count).toBe(1);

    const seen = await broadcast;
    expect(seen.results.options[1].voters).toEqual([voter]);

    // A rejoin has to show the tally, not a fresh ballot.
    b.close();
    const rejoined = openSocket(ctx.url, voter, 'weekend');
    const history = await waitFor(rejoined, 'history', (p) => p.messages.some((m) => m.id === ack.id));
    const poll = history.messages.find((m) => m.id === ack.id);
    expect(poll.results.totalVoters).toBe(1);
    expect(poll.results.options[1].count).toBe(1);

    a.close();
    rejoined.close();
  });

  test('re-voting replaces the earlier choice instead of adding to it', async () => {
    const author = await sessionId('Meera');
    const voter = await sessionId('Ravi');
    const a = openSocket(ctx.url, author, 'revote');
    const b = openSocket(ctx.url, voter, 'revote');
    await waitFor(a, 'history');

    const ack = await emitWithAck(a, 'message', {
      content: { type: 'poll', question: 'One pick', options: ['Tea', 'Coffee', 'Juice'] }
    });
    await emitWithAck(b, 'poll:vote', { messageId: ack.id, choices: [0] });
    const second = await emitWithAck(b, 'poll:vote', { messageId: ack.id, choices: [2] });

    expect(second.results.totalVoters).toBe(1);
    expect(second.results.options[0].count).toBe(0);
    expect(second.results.options[2].count).toBe(1);

    a.close();
    b.close();
  });

  test('a single-choice poll refuses two options and an unknown option index', async () => {
    const author = await sessionId('Nila');
    const other = await sessionId('Vikram');
    const a = openSocket(ctx.url, author, 'single');
    const b = openSocket(ctx.url, other, 'single');
    await waitFor(b, 'history');

    const ack = await emitWithAck(a, 'message', {
      content: { type: 'poll', question: 'Lunch', options: ['Biryani', 'Thali'] }
    });

    const greedy = await emitWithAck(b, 'poll:vote', { messageId: ack.id, choices: [0, 1] });
    expect(greedy.ok).toBe(false);
    expect(greedy.error).toMatch(/single choice/);

    const outOfRange = await emitWithAck(b, 'poll:vote', { messageId: ack.id, choices: [7] });
    expect(outOfRange.ok).toBe(false);

    a.close();
    b.close();
  });

  test('a vote for a poll in another room is refused', async () => {
    const author = await sessionId('Kiran');
    const outsider = await sessionId('Sana');
    const a = openSocket(ctx.url, author, 'pollhome');
    const away = openSocket(ctx.url, outsider, 'elsewhere');
    await waitFor(a, 'history');
    await waitFor(away, 'history');

    const ack = await emitWithAck(a, 'message', {
      content: { type: 'poll', question: 'Still here?', options: ['yes', 'no'] }
    });

    const vote = await emitWithAck(away, 'poll:vote', { messageId: ack.id, choices: [0] });
    expect(vote.ok).toBe(false);
    expect(vote.error).toMatch(/no such poll/);

    a.close();
    away.close();
  });

  test('location, contact and event cards arrive with sanitised fields', async () => {
    const userId = await sessionId('Deepa');
    const socket = openSocket(ctx.url, userId, 'cards');
    const peer = openSocket(ctx.url, await sessionId('Imran'), 'cards');
    await waitFor(peer, 'history');

    const location = await emitWithAck(socket, 'message', {
      content: {
        type: 'location',
        lat: 17.385,
        lng: 78.4867,
        accuracyM: 40,
        label: '<b>Office</b>',
        address: '<script>alert(1)</script>Banget Road'
      }
    });
    const deliveredLocation = await waitFor(peer, 'new_message', (p) => p.id === location.id);
    expect(deliveredLocation.kind).toBe('location');
    expect(deliveredLocation.content.label).toBe('Office');
    expect(deliveredLocation.content.address).toBe('Banget Road');

    const contact = await emitWithAck(socket, 'message', {
      content: {
        type: 'contact',
        name: 'Guava',
        phone: '+91 90000 00000',
        org: '<script>x</script>Acme',
        note: '<img src=x onerror="steal()">notes'
      }
    });
    const deliveredContact = await waitFor(peer, 'new_message', (p) => p.id === contact.id);
    expect(deliveredContact.content.org).toBe('Acme');
    expect(deliveredContact.content.note).toBe('notes');

    const event = await emitWithAck(socket, 'message', {
      content: {
        type: 'event',
        title: 'Retro',
        start: '2026-11-06T10:00:00.000Z',
        end: '2026-11-06T10:30:00.000Z',
        location: '<iframe src=evil></iframe>Room 2',
        note: '<style>body{}</style>bring notes'
      }
    });
    const deliveredEvent = await waitFor(peer, 'new_message', (p) => p.id === event.id);
    expect(deliveredEvent.kind).toBe('event');
    expect(deliveredEvent.content.location).toBe('Room 2');
    expect(deliveredEvent.content.note).toBe('bring notes');
    expect(new Date(deliveredEvent.content.start).toISOString()).toBe('2026-11-06T10:00:00.000Z');

    socket.close();
    peer.close();
  });

  test('a voice message is refused without the recording it describes', async () => {
    const userId = await sessionId('Anu');
    const socket = openSocket(ctx.url, userId, 'voice');
    await waitFor(socket, 'history');

    const bare = await emitWithAck(socket, 'message', {
      content: { type: 'voice', durationMs: 3000, peaks: [0.4] }
    });
    expect(bare.ok).toBe(false);
    expect(bare.error).toMatch(/audio attachment/);

    const media = await uploadPng(userId);
    const wrongKind = await emitWithAck(socket, 'message', {
      content: { type: 'voice', durationMs: 3000 },
      attachments: [media]
    });
    expect(wrongKind.ok).toBe(false);

    socket.close();
  });
});

describe('idempotent sends', () => {
  test('a resend of the same clientId produces one message and the same id', async () => {
    const userId = await sessionId('Sweatha');
    const socket = openSocket(ctx.url, userId, 'retry');
    await waitFor(socket, 'history');

    const payload = { text: 'sent once', clientId: 'fixed-client-1' };
    const first = await emitWithAck(socket, 'message', payload);
    const second = await emitWithAck(socket, 'message', payload);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);

    const history = await request(ctx.app)
      .get('/api/rooms/retry/messages')
      .set('X-Session-Id', userId);
    const mine = history.body.messages.filter((message) => message.clientId === 'fixed-client-1');
    expect(mine).toHaveLength(1);

    socket.close();
  });

  test('a resend from a different user is a different message', async () => {
    const one = await sessionId('User One');
    const two = await sessionId('User Two');
    const a = openSocket(ctx.url, one, 'sharedclient');
    const b = openSocket(ctx.url, two, 'sharedclient');
    await waitFor(b, 'history');

    const first = await emitWithAck(a, 'message', { text: 'mine', clientId: 'same-client' });
    const second = await emitWithAck(b, 'message', { text: 'mine', clientId: 'same-client' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.id).not.toBe(first.id);

    a.close();
    b.close();
  });
});

describe('message yourself', () => {
  test('the owner writes and reads back, and nobody else may enter', async () => {
    const owner = await sessionId('Guava');
    const intruder = await sessionId('Nosey');
    const room = `self-${owner}`;

    const socket = openSocket(ctx.url, owner, room);
    const ack = await emitWithAck(socket, 'message', { text: 'pin this' });
    expect(ack.ok).toBe(true);

    const history = await request(ctx.app).get(`/api/rooms/${room}/messages`).set('X-Session-Id', owner);
    expect(history.status).toBe(200);
    expect(history.body.messages.map((m) => m.text)).toContain('pin this');

    const snooped = await request(ctx.app).get(`/api/rooms/${room}/messages`).set('X-Session-Id', intruder);
    expect(snooped.status).toBe(403);

    const stranger = openSocket(ctx.url, intruder, room);
    const rejected = await waitFor(stranger, 'system', (p) => p.type === 'error');
    expect(rejected.reason).toBe('not_your_room');
    const joined = await emitWithAck(stranger, 'room:join', { room });
    expect(joined.ok).toBe(false);

    socket.close();
    stranger.close();
  });

  test('a self room has to name a real session id', async () => {
    const userId = await sessionId('Rakesh');
    const socket = openSocket(ctx.url, userId, 'general');
    await waitFor(socket, 'history');

    const fake = await emitWithAck(socket, 'room:join', { room: 'self-alice' });
    expect(fake.ok).toBe(false);
    expect(fake.error).toMatch(/must name a session id/);

    const http = await request(ctx.app).get('/api/rooms/self-alice/messages').set('X-Session-Id', userId);
    expect(http.status).toBe(400);

    socket.close();
  });

  test('the API hands the client its own room id', async () => {
    const userId = await sessionId('Bindu');
    const res = await request(ctx.app).get('/api/me/self').set('X-Session-Id', userId);
    expect(res.status).toBe(200);
    expect(res.body.room).toBe(`self-${userId}`);
  });
});

describe('personal notes', () => {
  test('a note is stored per user, sanitised, and invisible to anybody else', async () => {
    const owner = await sessionId('Chaitu');
    const other = await sessionId('Farhan');

    const put = await request(ctx.app)
      .put('/api/me/note')
      .set('X-Session-Id', owner)
      .send({ text: '<script>alert(1)</script>at the gym, back by 7' });
    expect(put.status).toBe(200);
    expect(put.body.note.text).toBe('at the gym, back by 7');
    expect(put.body.note.updatedAt).toBeGreaterThan(0);

    const read = await request(ctx.app).get('/api/me/note').set('X-Session-Id', owner);
    expect(read.body.note.text).toBe('at the gym, back by 7');

    const someoneElses = await request(ctx.app).get('/api/me/note').set('X-Session-Id', other);
    expect(someoneElses.body.note.text).toBe('');

    const cleared = await request(ctx.app).put('/api/me/note').set('X-Session-Id', owner).send({ text: '' });
    expect(cleared.body.note.text).toBe('');
  });

  test('a note longer than the cap is refused', async () => {
    const owner = await sessionId('Harish');
    const res = await request(ctx.app)
      .put('/api/me/note')
      .set('X-Session-Id', owner)
      .send({ text: 'x'.repeat(600) });
    expect(res.status).toBe(400);
  });
});

describe('media library', () => {
  test('attachments come back with their sender and the message that carried them', async () => {
    const uploader = await sessionId('Naveen');
    const socket = openSocket(ctx.url, uploader, 'library');
    await waitFor(socket, 'history');

    const media = await uploadPng(uploader);
    const ack = await emitWithAck(socket, 'message', {
      text: 'screenshot',
      attachments: [media]
    });
    expect(ack.ok).toBe(true);

    const res = await request(ctx.app).get('/api/rooms/library/media').set('X-Session-Id', uploader);
    expect(res.status).toBe(200);
    const item = res.body.items.find((entry) => entry.id === media.id);
    expect(item.kind).toBe('image');
    expect(item.name).toBe('shot.png');
    expect(item.sender).toBe('Naveen');
    expect(item.messageId).toBe(ack.id);

    socket.close();
  });

  test('the library of a self room is not readable by another session', async () => {
    const owner = await sessionId('Sitha');
    const intruder = await sessionId('Zoya');
    const res = await request(ctx.app).get(`/api/rooms/self-${owner}/media`).set('X-Session-Id', intruder);
    expect(res.status).toBe(403);
  });
});
