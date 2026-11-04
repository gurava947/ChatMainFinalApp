/** @jest-environment jsdom */

'use strict';

const { loadRoomChat } = require('../helpers/load-client-module');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const session = {
  userId: 'b0000000-0000-4000-8000-000000000002',
  sessionToken: 'A'.repeat(43),
  displayName: 'Meera',
  expiresAt: 1800000000000
};
const other = { userId: 'c0000000-0000-4000-8000-000000000003', displayName: 'Rahul' };

let roomChat;
let calls;

beforeEach(() => {
  localStorage.clear();
  calls = [];
  roomChat = loadRoomChat();
  window.fetch = (url, options = {}) => {
    calls.push({ url, options });
    return window.__fetchResponse(url, options);
  };
});

describe('fetching this viewer settings', () => {
  test('one call reads the room view and the block list together', async () => {
    window.__fetchResponse = (url) => Promise.resolve(
      url === '/api/me/blocks'
        ? jsonResponse({ blocked: [other] })
        : jsonResponse({ clearedAt: 1700, theme: 'forest', hidden: ['x1'] })
    );
    const settings = await roomChat.fetchChatSettings(session, 'weekend-plans');
    expect(settings).toEqual({ blocked: [other], clearedAt: 1700, theme: 'forest', hidden: ['x1'] });
    expect(calls.map((call) => call.url)).toEqual(['/api/rooms/weekend-plans/settings', '/api/me/blocks']);
    expect(calls.every((call) => call.options.headers['X-Session-Id'] === session.userId)).toBe(true);
    expect(calls.every((call) => call.options.headers['X-Session-Token'] === session.sessionToken)).toBe(true);
  });

  test('a first-time room reads as an empty view instead of an error', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({}));
    await expect(roomChat.fetchChatSettings(session, 'new-room')).resolves.toEqual({
      blocked: [], clearedAt: 0, theme: 'default', hidden: [],
    });
  });

  test('an expired session is explained, not swallowed', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ error: 'invalid_session' }, 401));
    await expect(roomChat.fetchChatSettings(session, 'weekend-plans')).rejects.toThrow(/session expired/i);
  });
});

describe('blocking from the chat', () => {
  test('blockGuest posts the target and returns the whole list', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ blocked: [other] }, 201));
    const blocked = await roomChat.blockGuest(session, other);
    expect(calls[0]).toMatchObject({ url: '/api/me/blocks', options: { method: 'POST' } });
    expect(JSON.parse(calls[0].options.body)).toEqual({ userId: other.userId, displayName: other.displayName });
    expect(calls[0].options.headers['Content-Type']).toBe('application/json');
    expect(blocked).toEqual([other]);
  });

  test('unblockGuest DELETEs that one entry', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ blocked: [] }));
    await expect(roomChat.unblockGuest(session, other.userId)).resolves.toEqual([]);
    expect(calls[0]).toMatchObject({ url: `/api/me/blocks/${other.userId}`, options: { method: 'DELETE' } });
  });

  test('the server reason is shown when a block is rejected', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ error: 'you cannot block your own session' }, 400));
    await expect(roomChat.blockGuest(session, session)).rejects.toThrow(/cannot block your own session/);
  });

  test('an unhelpful failure still gets a readable message', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ error: 'internal_error' }, 500));
    await expect(roomChat.blockGuest(session, other)).rejects.toThrow(/could not change your chat settings/i);
  });
});

describe('clearing, deleting and theming', () => {
  test('saveRoomTheme PUTs the chosen theme and echoes it back', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ theme: 'ocean' }));
    await expect(roomChat.saveRoomTheme(session, 'weekend-plans', 'ocean')).resolves.toBe('ocean');
    expect(calls[0]).toMatchObject({ url: '/api/rooms/weekend-plans/settings/theme', options: { method: 'PUT' } });
    expect(JSON.parse(calls[0].options.body)).toEqual({ theme: 'ocean' });
  });

  test('the theme picker only offers themes the server accepts', async () => {
    const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');
    const ids = roomChat.CHAT_THEMES.map((theme) => theme.id);
    expect(app).toContain('chat-theme-');
    expect(ids).toEqual(expect.arrayContaining(['default', 'forest', 'sunset', 'ocean', 'midnight', 'paper']));
    expect(roomChat.CHAT_THEMES.every((theme) => theme.label.length > 0)).toBe(true);
  });

  test('clearChatForMe POSTs to the room and reports the watermark', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ clearedAt: 1700000000000, hidden: [] }));
    const result = await roomChat.clearChatForMe(session, 'weekend-plans');
    expect(calls[0]).toMatchObject({ url: '/api/rooms/weekend-plans/clear', options: { method: 'POST' } });
    expect(result.clearedAt).toBe(1700000000000);
  });

  test('deleteMessagesForMe sends the selected ids and returns the hidden set', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ hidden: ['m1', 'm2'] }));
    await expect(roomChat.deleteMessagesForMe(session, 'weekend-plans', ['m1', 'm2'])).resolves.toEqual(['m1', 'm2']);
    expect(calls[0].url).toBe('/api/rooms/weekend-plans/messages/hide');
    expect(JSON.parse(calls[0].options.body)).toEqual({ ids: ['m1', 'm2'] });
  });

  test('deleteChatForMe distinguishes an emptied self room from a shared one', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ room: 'self-abc', deleted: true, selfRoom: true, removed: 4 }));
    await expect(roomChat.deleteChatForMe(session, 'self-abc')).resolves.toEqual({ selfRoomDeleted: true, removed: 4 });

    window.__fetchResponse = () => Promise.resolve(jsonResponse({ room: 'weekend-plans', deleted: false, selfRoom: false }));
    await expect(roomChat.deleteChatForMe(session, 'weekend-plans')).resolves.toEqual({ selfRoomDeleted: false, removed: 0 });
    expect(calls[1]).toMatchObject({ url: '/api/rooms/weekend-plans', options: { method: 'DELETE' } });
  });

  test('a room name with symbols cannot escape the path', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ clearedAt: 1 }));
    await roomChat.clearChatForMe(session, '../admin');
    expect(calls[0].url).toBe('/api/rooms/..%2Fadmin/clear');
  });

  test('fetchRoomMessages reads the rows this viewer is allowed to see', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ room: 'weekend-plans', messages: [{ id: 'm1', text: 'hi' }] }));
    await expect(roomChat.fetchRoomMessages(session, 'weekend-plans')).resolves.toEqual([{ id: 'm1', text: 'hi' }]);
    expect(calls[0].url).toBe('/api/rooms/weekend-plans/messages');
    expect(calls[0].options.headers['X-Session-Id']).toBe(session.userId);
  });

  test('an empty read is an empty list, not a crash', async () => {
    window.__fetchResponse = () => Promise.resolve(jsonResponse({ room: 'weekend-plans' }));
    await expect(roomChat.fetchRoomMessages(session, 'weekend-plans')).resolves.toEqual([]);
  });
});

describe('chat settings wiring in the shipped app', () => {
  const app = () => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');

  test('the settings sheet gets the room, session and live settings', () => {
    const source = app();
    expect(source).toMatch(/<ChatSettingsSheet \{\.\.\.settingsSheetProps\} \/>/);
    expect(source).toMatch(/onChatDeleted: \(result\) =>/);
    expect(source).toMatch(/onSettingsChange: setChatSettings/);
  });

  test('every settings action calls the server, none is a placeholder', () => {
    const source = app();
    for (const helper of ['saveRoomTheme(', 'unblockGuest(', 'blockGuest(', 'clearChatForMe(', 'deleteChatForMe(', 'deleteMessagesForMe(']) {
      expect(source).toContain(helper);
    }
    expect(source).not.toMatch(/onBlock=\{\(\) => \{\}\}/);
  });

  test('unblocking re-reads history so skipped messages come back', () => {
    const source = app();
    expect(source).toMatch(/onHistoryRefresh: reloadHistory/);
    expect(source).toMatch(/const blocked = await unblockGuest\(session, target.userId\)[\s\S]{0,120}await onHistoryRefresh\(\)/);
    expect(source).toMatch(/const rows = await fetchRoomMessages\(session, chat.id\)/);
  });

  test('live messages respect the viewer settings', () => {
    const source = app();
    expect(source).toContain('hiddenCheckRef');
    expect(source).toMatch(/if \(hiddenCheckRef\.current\(message\)\) return/);
  });
});
