/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadRoomChat } = require('../helpers/load-client-module');

const CLIENT = path.join(__dirname, '..', '..', 'client', 'src');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const session = {
  userId: 'a0000000-0000-4000-8000-000000000001',
  sessionToken: 'B'.repeat(43),
  displayName: 'Arjun',
  expiresAt: 1800000000000
};

let roomChat;
let fetchCalls;

beforeEach(() => {
  localStorage.clear();
  fetchCalls = [];
  roomChat = loadRoomChat();
  window.fetch = (url, options = {}) => {
    fetchCalls.push({ url, options });
    return window.__fetchResponse(url, options);
  };
});

describe('guest session storage', () => {
  test('saveGuest persists the identity but never the credential', () => {
    roomChat.saveGuest(session);
    expect(JSON.parse(localStorage.getItem('inchat:guest'))).toEqual({
      userId: session.userId,
      displayName: session.displayName,
      expiresAt: session.expiresAt
    });
    expect(localStorage.getItem('chat:userId')).toBe(session.userId);
    expect(localStorage.getItem('chat:displayName')).toBe(session.displayName);
  });

  test('validates a cached session through the cookie alone', async () => {
    roomChat.saveGuest(session);
    window.__fetchResponse = () => Promise.resolve(jsonResponse({
      userId: session.userId,
      displayName: session.displayName,
      expiresAt: session.expiresAt
    }));

    const restored = await roomChat.resolveGuest(session.displayName);

    expect(fetchCalls[0].url).toBe(`/api/sessions/${session.userId}`);
    expect(fetchCalls[0].options.headers).toEqual({ 'X-Session-Id': session.userId });
    expect(restored.sessionToken).toBeUndefined();
    expect(roomChat.readGuest().sessionToken).toBeUndefined();
  });

  test('a legacy token saved by an older build is dropped on read', () => {
    localStorage.setItem('inchat:guest', JSON.stringify(session));
    expect(roomChat.readGuest()).toEqual({
      userId: session.userId,
      displayName: session.displayName,
      expiresAt: session.expiresAt
    });
  });

  test('a minted session is only handed back, never stored, so a refused join cannot change who this device is', async () => {
    roomChat.saveGuest(session);
    const minted = { ...session, userId: 'b0000000-0000-4000-8000-000000000002', displayName: 'Cleo', sessionToken: 'C'.repeat(43) };
    window.__fetchResponse = () => Promise.resolve(jsonResponse(minted, 201));

    const fresh = await roomChat.resolveGuest('Cleo');

    expect(fresh).toEqual(minted);
    // resolveGuest alone is not a commitment; joinRoom stores it once the room says yes.
    expect(roomChat.readGuest()).toEqual({
      userId: session.userId,
      displayName: session.displayName,
      expiresAt: session.expiresAt
    });
    expect(localStorage.getItem('chat:displayName')).toBe(session.displayName);
  });

  test('clearGuest removes every trace of the session so sign out is real', () => {
    roomChat.saveGuest(session);
    roomChat.clearGuest();
    expect(localStorage.getItem('inchat:guest')).toBeNull();
    expect(localStorage.getItem('chat:userId')).toBeNull();
    expect(localStorage.getItem('chat:displayName')).toBeNull();
    expect(roomChat.readGuest()).toBeNull();
  });

  test('clearGuest leaves the room list alone — signing out is not deleting history', () => {
    roomChat.saveGuest(session);
    roomChat.saveRooms([roomChat.roomSummary('weekend-plans')]);
    roomChat.clearGuest();
    expect(roomChat.readRooms().map((room) => room.id)).toEqual(['weekend-plans']);
  });
});

describe('rooms on this device', () => {
  beforeEach(() => {
    roomChat.saveRooms([roomChat.roomSummary('weekend-plans'), roomChat.roomSummary('team-standup')]);
  });

  test('forgetRoom drops one room and persists the shorter list', () => {
    const next = roomChat.forgetRoom('weekend-plans');
    expect(next.map((room) => room.id)).toEqual(['team-standup']);
    expect(roomChat.readRooms().map((room) => room.id)).toEqual(['team-standup']);
  });

  test('forgetRoom also clears the legacy single-room key when it matches', () => {
    localStorage.setItem('chat:room', 'team-standup');
    const next = roomChat.forgetRoom('team-standup');
    expect(localStorage.getItem('chat:room')).toBeNull();
    expect(next.map((room) => room.id)).toEqual(['weekend-plans']);
    expect(roomChat.readRooms().map((room) => room.id)).toEqual(['weekend-plans']);
  });

  test('forgetRoom is not destructive when the room is unknown', () => {
    const next = roomChat.forgetRoom('never-joined');
    expect(next.map((room) => room.id)).toEqual(['weekend-plans', 'team-standup']);
  });

  test('roomSummary normalises a typed name into a shareable id', () => {
    const room = roomChat.roomSummary('Weekend Plans');
    expect(room.id).toBe('weekend-plans');
    expect(room.name).toBe('Weekend Plans');
    expect(room.initials).toBe('WP');
  });
});

describe('profile read + picture', () => {
  test('fetchMyProfile unwraps the profile the server owns', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({
      profile: { userId: session.userId, displayName: 'Arjun', note: { text: 'Coffee first.' }, avatar: null }
    }));
    const profile = await roomChat.fetchMyProfile(session);
    expect(fetchCalls[0].url).toBe('/api/me/profile');
    expect(fetchCalls[0].options.headers['X-Session-Id']).toBe(session.userId);
    expect(profile.avatar).toBeNull();
    expect(profile.note.text).toBe('Coffee first.');
  });

  test('fetchMyProfile turns a 401 into a sign-in hint instead of a blank profile', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ error: 'invalid_session' }, 401));
    await expect(roomChat.fetchMyProfile(session)).rejects.toThrow(/session expired/i);
  });

  test('uploadAvatar posts the file as multipart and returns the stored avatar', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({
      avatar: { url: '/media/m1', mime: 'image/png', size: 12, updatedAt: 1700000000000 }
    }));
    const file = new File(['bytes'], 'me.png', { type: 'image/png' });
    const avatar = await roomChat.uploadAvatar(session, file);
    const options = fetchCalls[0].options;
    expect(fetchCalls[0].url).toBe('/api/me/avatar');
    expect(options.method).toBe('PUT');
    expect(options.body).toBeInstanceOf(FormData);
    // FormData re-wraps the blob once a filename is supplied, so the upload is
    // checked by what the server will actually see rather than by identity.
    const sent = options.body.get('files');
    expect(sent.name).toBe('me.png');
    expect(sent.type).toBe('image/png');
    // Letting the browser set the multipart boundary is what keeps multer happy.
    expect(Object.keys(options.headers)).toEqual(['X-Session-Id']);
    expect(avatar.url).toBe('/media/m1');
  });

  test('uploadAvatar surfaces the server rejection reason', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ error: 'a profile picture must be an image' }, 400));
    await expect(roomChat.uploadAvatar(session, new File(['bytes'], 'notes.pdf')))
      .rejects.toThrow('a profile picture must be an image');
  });

  test('uploadAvatar falls back to a readable message on an unhelpful 500', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ error: 'internal_error' }, 500));
    await expect(roomChat.uploadAvatar(session, new File(['bytes'], 'me.png')))
      .rejects.toThrow('Could not change your profile.');
  });

  test('removeAvatar DELETEs the picture', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ removed: true }));
    await expect(roomChat.removeAvatar(session)).resolves.toEqual({ removed: true });
    expect(fetchCalls[0].url).toBe('/api/me/avatar');
    expect(fetchCalls[0].options.method).toBe('DELETE');
  });

  test('fetchProfiles maps the batch down to one row per sender', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({
      profiles: [
        { userId: 'u1', displayName: 'Ana', avatar: { url: '/media/a1' } },
        { userId: 'u2', displayName: 'Ben', avatar: null }
      ]
    }));
    const rows = await roomChat.fetchProfiles(session, ['u1', 'u2', 'u1']);
    expect(fetchCalls[0].url).toBe('/api/profiles?ids=u1%2Cu2');
    expect(Object.keys(rows)).toEqual(['u1', 'u2']);
    expect(rows.u2.avatar).toBeNull();
  });

  test('fetchProfiles skips the request when there is nobody to look up', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ profiles: [] }));
    await expect(roomChat.fetchProfiles(session, [null, undefined])).resolves.toEqual({});
    expect(fetchCalls).toEqual([]);
  });
});

describe('about note', () => {
  test('saveNote PUTs the trimmed text with the session header and returns the saved note', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ note: { text: 'Coffee first.', updatedAt: 1700000001000 } }));
    const note = await roomChat.saveNote(session, 'Coffee first.');
    expect(fetchCalls[0].url).toBe('/api/me/note');
    expect(fetchCalls[0].options.method).toBe('PUT');
    expect(JSON.parse(fetchCalls[0].options.body)).toEqual({ text: 'Coffee first.' });
    expect(note.text).toBe('Coffee first.');
  });

  test('saveNote surfaces the server rejection reason instead of a generic failure', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ error: 'String must contain at most 500 character(s)' }, 400));
    await expect(roomChat.saveNote(session, 'x')).rejects.toThrow('String must contain at most 500 character(s)');
  });

  test('saveNote falls back to a readable message when the server gives nothing useful', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ error: 'internal_error' }, 500));
    await expect(roomChat.saveNote(session, 'x')).rejects.toThrow('Could not save your about note.');
  });
});

describe('header and settings entry points', () => {
  const app = () => fs.readFileSync(path.join(CLIENT, 'App.jsx'), 'utf8');

  test('the header keeps only the brand and the theme switch', () => {
    const source = app();
    expect(source).toMatch(/<AppHeader dark=\{dark\} onThemeChange=/);
    // Every account surface - profile, rooms, session - lives in Settings, so
    // the header does not receive identity or profile handlers at all.
    expect(source).not.toMatch(/<AppHeader[^\n]*guest=/);
    expect(source).not.toMatch(/<AppHeader[^\n]*profile=/);
    expect(source).not.toMatch(/<AppHeader[^\n]*onProfileChange=/);
    expect(source).not.toMatch(/<AppHeader[^\n]*onSignOut=/);
    expect(source).not.toMatch(/<AppHeader[^\n]*onForgetRoom=/);
  });

  test('the header has no avatar, profile sheet, or hidden menu', () => {
    const source = app();
    const header = source.slice(source.indexOf('function AppHeader'), source.indexOf('function AvatarFace'));
    expect(header).not.toMatch(/Ellipsis/);
    expect(header).not.toMatch(/header-account/);
    expect(header).not.toMatch(/ProfileSheet/);
    expect(header).toMatch(/<ThemeSwitch dark=\{dark\} onChange=\{onThemeChange\}/);
    expect(source).not.toMatch(/function ProfileMenu/);
    expect(source).not.toMatch(/function ProfileSheet/);
    // The initials helper survives for sender avatars; it is no longer a
    // header control.
    expect(source).toMatch(/function AvatarFace/);
    expect(header).not.toMatch(/AvatarFace/);
  });

  test('the settings route still owns profile editing and sign out', () => {
    const source = app();
    const route = source.slice(source.indexOf('<Route path="/settings"'), source.indexOf('</Routes>'));
    expect(route).toMatch(/profile=\{profile\}/);
    expect(route).toMatch(/onProfileChange=\{setProfile\}/);
    expect(route).toMatch(/onSignOut=\{signOut\}/);
    expect(route).toMatch(/onForgetRoom=\{forgetRoomOnDevice\}/);
  });

  test('sign out clears device storage and expires the cookie server-side', () => {
    const source = app();
    expect(source).toMatch(/const signOut = \(\) => \{/);
    expect(source).toMatch(/method: 'DELETE', headers: sessionHeaders\(guest\)/);
    expect(source).toMatch(/clearGuest\(\)\s*setGuest\(null\)/);
    expect(source).toMatch(/const forgetRoomOnDevice = \(roomId\) => setRooms\(forgetRoom\(roomId\)\)/);
  });

  test('sender pictures are looked up once per new author', () => {
    const source = app();
    expect(source).toMatch(/fetchProfiles\(session/);
    const preview = source.slice(source.indexOf('function ChatPreview'), source.indexOf('function JoinRoomDialog'));
    expect(preview).toMatch(/profilesRef\.current/);
    expect(preview).toMatch(/className="bubble-avatar"/);
  });
});
