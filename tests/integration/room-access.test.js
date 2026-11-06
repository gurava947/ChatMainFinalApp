'use strict';

const request = require('supertest');
const { createTestServer } = require('../helpers/create-test-server');
const { createSession: createTestSession, sessionHeaders } = require('../helpers/session-auth');
const { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } = require('../../src/constants');

jest.setTimeout(30000);

let ctx;

async function createSession(displayName) {
  return createTestSession(ctx.app, displayName);
}

function accessRequest(room, userId, credential) {
  return request(ctx.app)
    .post(`/api/rooms/${room}/access`)
    .set(sessionHeaders(userId))
    .send(credential === undefined ? {} : { credential });
}

function rosterRequest(room, userId) {
  return request(ctx.app).get(`/api/rooms/${room}/roster`).set(sessionHeaders(userId));
}

/** Every test that needs two members starts by claiming the room for the first. */
async function claimRoom(room, userId) {
  const response = await accessRequest(room, userId);
  expect(response.status).toBe(200);
  return response.body.inviteCode;
}

beforeAll(async () => {
  ctx = await createTestServer();
});

afterAll(async () => {
  await ctx.close();
});

describe('room roster and pairing codes', () => {
  test('the first member claims the room and is handed the code once', async () => {
    const owner = await createSession('Asha');
    const claimed = await accessRequest('claim-room', owner);

    expect(claimed.status).toBe(200);
    expect(claimed.body.authorized).toBe(true);
    expect(claimed.body.role).toBe('owner');
    expect(claimed.body.inviteCode).toMatch(new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`));

    // Claiming again is not a second code: the owner already holds a seat, so
    // the answer must not hand out a fresh secret that would strand the member
    // who paired with the first one.
    const again = await accessRequest('claim-room', owner);
    expect(again.status).toBe(200);
    expect(again.body.role).toBe('owner');
    expect(again.body.inviteCode).toBeNull();
  });

  test('a second member needs the code, and a third is refused', async () => {
    const owner = await createSession('Mina');
    const guest = await createSession('Ravi');
    const stranger = await createSession('Sue');
    const room = 'two-seat-room';
    const inviteCode = await claimRoom(room, owner);

    const noCode = await accessRequest(room, guest);
    expect(noCode.status).toBe(403);
    expect(noCode.body.error).toBe('pairing_code_required');

    // Built to differ from the real code in its first symbol, so the refusal
    // cannot go flaky on the one code that would make it pass.
    const wrongCode = INVITE_CODE_ALPHABET.replace(inviteCode[0], '')[0].repeat(INVITE_CODE_LENGTH);
    const wrong = await accessRequest(room, guest, wrongCode);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('invalid_pairing_code');

    const typed = await accessRequest(room, guest, inviteCode.toLowerCase().replace(/(.{4})(.{4})/, '$1 $2'));
    expect(typed.status).toBe(200);
    expect(typed.body.role).toBe('guest');
    expect(typed.body.inviteCode).toBeNull();

    // The cap has to hold against the identity that behaves perfectly, too:
    // a correct code is not an entitlement when both seats are already taken.
    const third = await accessRequest(room, stranger, inviteCode);
    expect(third.status).toBe(403);
    expect(third.body.error).toBe('room_is_full');
    expect((await request(ctx.app).get(`/api/rooms/${room}/access`).set(sessionHeaders(stranger))).body.authorized).toBe(false);
  });

  test('history stays closed until the pairing lands', async () => {
    const owner = await createSession('Kiran');
    const guest = await createSession('Dev');
    const room = 'seated-history';
    const inviteCode = await claimRoom(room, owner);
    await request(ctx.app).post(`/api/rooms/${room}/messages`).set(sessionHeaders(owner)).send({ text: 'for the pair only' });

    const blocked = await request(ctx.app).get(`/api/rooms/${room}/messages`).set(sessionHeaders(guest));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('not_a_member');

    await accessRequest(room, guest, inviteCode);
    const allowed = await request(ctx.app).get(`/api/rooms/${room}/messages`).set(sessionHeaders(guest));
    expect(allowed.status).toBe(200);
    expect(allowed.body.messages).toHaveLength(1);
  });

  test('a room that predates the roster is claimed by its first member, not left open', async () => {
    const first = await createSession('Nila');
    const other = await createSession('Omar');
    const room = 'legacy-open-room';
    await ctx.store.pushMessage(room, {
      id: 'legacy-message',
      room,
      userId: 'legacy-user',
      displayName: 'Legacy',
      text: 'Still here',
      ts: Date.now()
    });

    const migrated = await accessRequest(room, first);
    expect(migrated.status).toBe(200);
    expect(migrated.body.role).toBe('owner');
    expect(migrated.body.legacy).toBe(true);
    expect(migrated.body.inviteCode).toMatch(new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`));

    // This is the whole point of the migration: what used to be readable by
    // anybody who knew the id now needs the code as well.
    const late = await accessRequest(room, other);
    expect(late.status).toBe(403);
    expect(late.body.error).toBe('pairing_code_required');
  });

  test('a room that already had a shared password keeps accepting it for the free seat', async () => {
    const owner = await createSession('Priya');
    const partner = await createSession('Vikram');
    const room = 'old-password-room';
    const password = 'HistoryPass123';
    await ctx.store.setRoomPasswordIfAbsent(room, await ctx.chat.hashSecret(password));

    const claimed = await accessRequest(room, owner);
    expect(claimed.body.role).toBe('owner');
    expect(claimed.body.legacy).toBe(true);

    const joined = await accessRequest(room, partner, password);
    expect(joined.status).toBe(200);
    expect(joined.body.role).toBe('guest');
  });

  test('rotation replaces the code and retires the old password with it', async () => {
    const owner = await createSession('Aya');
    const partner = await createSession('Ben');
    const stranger = await createSession('Cid');
    const room = 'rotating-room';
    const password = 'RotationPass1';
    await ctx.store.setRoomPasswordIfAbsent(room, await ctx.chat.hashSecret(password));
    const inviteCode = await claimRoom(room, owner);

    const rotated = await request(ctx.app)
      .post(`/api/rooms/${room}/invite`)
      .set(sessionHeaders(owner))
      .send({});
    expect(rotated.status).toBe(200);
    expect(rotated.body.inviteCode).toHaveLength(INVITE_CODE_LENGTH);
    expect(rotated.body.inviteCode).not.toBe(inviteCode);

    expect((await accessRequest(room, partner, inviteCode)).body.error).toBe('invalid_pairing_code');
    expect((await accessRequest(room, partner, password)).body.error).toBe('invalid_pairing_code');
    expect((await accessRequest(room, partner, rotated.body.inviteCode)).status).toBe(200);

    // A guest may not hand out membership; only the seat that claimed the room
    // can mint a code.
    const byGuest = await request(ctx.app)
      .post(`/api/rooms/${room}/invite`)
      .set(sessionHeaders(partner))
      .send({});
    expect(byGuest.status).toBe(403);
    expect(byGuest.body.error).toBe('not_room_owner');
    expect((await accessRequest(room, stranger, rotated.body.inviteCode)).body.error).toBe('room_is_full');
  });

  test('the roster describes the room to its members and nothing to everyone else', async () => {
    const owner = await createSession('Dana');
    const guest = await createSession('Eli');
    const stranger = await createSession('Fay');
    const room = 'visible-roster';
    const inviteCode = await claimRoom(room, owner);

    const before = await rosterRequest(room, owner);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      room,
      role: 'owner',
      members: [{ userId: owner, role: 'owner' }],
      seatsFull: false,
      migrated: false
    });

    await accessRequest(room, guest, inviteCode);
    const after = await rosterRequest(room, guest);
    expect(after.body.role).toBe('guest');
    expect(after.body.members).toEqual([
      { userId: owner, role: 'owner' },
      { userId: guest, role: 'guest' }
    ]);
    expect(after.body.seatsFull).toBe(true);

    const denied = await rosterRequest(room, stranger);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('not_a_member');
  });

  test('a note-to-self room has one seat and no code to share', async () => {
    const owner = await createSession('Gita');
    const room = `self-${owner}`;

    expect((await accessRequest(room, owner)).body.role).toBe('owner');
    const roster = await rosterRequest(room, owner);
    expect(roster.body.seatsFull).toBe(true);
    expect(roster.body.members).toHaveLength(1);

    const other = await createSession('Hal');
    expect((await accessRequest(room, other)).status).toBe(403);
    expect((await request(ctx.app).get(`/api/rooms/${room}/messages`).set(sessionHeaders(other))).status).toBe(403);
  });
});
