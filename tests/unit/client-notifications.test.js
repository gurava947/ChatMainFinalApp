/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadNotifications } = require('../helpers/load-client-module');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');

let notify;

beforeEach(() => {
  notify = loadNotifications();
  localStorage.clear();
});

const message = (overrides = {}) => ({
  id: 'm1', room: 'standup', userId: 'u2', displayName: 'Ben', text: 'Ship it today',
  attachments: [], content: null, ts: 1700000000000, ...overrides,
});

describe('device alert preferences', () => {
  test('a fresh device stays silent until the guest asks to be pinged', () => {
    expect(notify.readNotifyPrefs()).toEqual({ enabled: false, sound: false, preview: true, mentionsOnly: false });
  });

  test('the choices survive a reload', () => {
    notify.saveNotifyPrefs({ enabled: true, sound: true, preview: false });
    expect(notify.readNotifyPrefs()).toEqual({ enabled: true, sound: true, preview: false, mentionsOnly: false });
  });

  test('a corrupt or hostile stored blob cannot switch previews off by accident', () => {
    localStorage.setItem('inchat:notify', '{"enabled":"yes","sound":1,"preview":"no"}');
    expect(notify.readNotifyPrefs()).toEqual({ enabled: true, sound: true, preview: true, mentionsOnly: false });
    localStorage.setItem('inchat:notify', '{"preview":false}');
    expect(notify.readNotifyPrefs().preview).toBe(false);
    localStorage.setItem('inchat:notify', '{broken');
    expect(notify.readNotifyPrefs().enabled).toBe(false);
  });

  test('saving without a choice does not silently turn previews off', () => {
    expect(notify.saveNotifyPrefs({ enabled: true }).preview).toBe(true);
  });
});

describe('the browser permission', () => {
  test('no permission object means no desktop alert, ever', () => {
    expect(notify.canNotify()).toBe(false);
  });

  test('only a granted permission raises the door', () => {
    global.Notification = { permission: 'denied' };
    expect(notify.canNotify()).toBe(false);
    global.Notification.permission = 'granted';
    expect(notify.canNotify()).toBe(true);
  });

  test('a guest who already refused is never prompted again', async () => {
    const asked = jest.fn();
    global.Notification = { permission: 'denied', requestPermission: asked };
    await expect(notify.requestNotifyPermission()).resolves.toBe('denied');
    expect(asked).not.toHaveBeenCalled();
  });

  test('an unanswered prompt is treated as a refusal', async () => {
    global.Notification = { permission: 'default', requestPermission: () => Promise.reject(new Error('gone')) };
    await expect(notify.requestNotifyPermission()).resolves.toBe('denied');
    delete global.Notification;
    await expect(notify.requestNotifyPermission()).resolves.toBe('unsupported');
  });
});

describe('what deserves attention', () => {
  const prefs = { enabled: true, sound: true, preview: true, mentionsOnly: false };

  test('my own message never notifies me', () => {
    expect(notify.shouldNotify(message({ userId: 'me' }), { prefs, ownUserId: 'me' })).toBe(false);
  });

  test('the room on screen does not need a desktop alert', () => {
    expect(notify.shouldNotify(message(), { prefs, ownUserId: 'me', activeRoomId: 'standup' })).toBe(false);
    expect(notify.shouldNotify(message(), { prefs, ownUserId: 'me', activeRoomId: null })).toBe(true);
  });

  test('alerts off means total silence whatever arrives', () => {
    expect(notify.shouldNotify(message(), { prefs: { ...prefs, enabled: false } })).toBe(false);
  });

  test('mentions-only ignores everything that does not say this name', () => {
    const quiet = { ...prefs, mentionsOnly: true };
    expect(notify.shouldNotify(message({ text: 'standup notes updated' }), { prefs: quiet, ownUserId: 'me' })).toBe(false);
    expect(notify.shouldNotify(message({ displayName: 'Ben', text: 'hey @ben, review?' }), { prefs: quiet, ownUserId: 'me' })).toBe(true);
    expect(notify.shouldNotify(message({ displayName: 'Ben', text: '@benedict' }), { prefs: quiet, ownUserId: 'me' })).toBe(true);
  });

  test('the unread count ignores my own messages and the ones already read', () => {
    const rows = [message({ ts: 100 }), message({ ts: 200, userId: 'me' }), message({ ts: 300, userId: 'u3' })];
    expect(notify.unreadFor(rows, 150, 'me')).toBe(1);
    expect(notify.unreadFor(rows, 0, 'me')).toBe(2);
    expect(notify.unreadFor([], 0, 'me')).toBe(0);
  });
});

describe('what the alert says', () => {
  test('a picture, a poll and a voice note are described, not left blank', () => {
    const withFile = message({ text: '', attachments: [{ id: 'a1', kind: 'image' }] });
    expect(notify.notificationBody(withFile, { preview: true })).toBe('Ben sent a file');
    expect(notify.notificationBody(message({ text: '', attachments: [{}, {}] }), { preview: true })).toBe('Ben sent 2 files');
    expect(notify.notificationBody(message({ text: '', content: { type: 'poll', question: 'Lunch?' } }), { preview: true })).toBe('Ben started a poll: Lunch?');
    expect(notify.notificationBody(message({ text: '', content: { type: 'voice' } }), { preview: true })).toBe('Ben sent a voice message');
  });

  test('a long message is cut and its newlines folded', () => {
    const long = message({ text: `line one\nline two ${'x'.repeat(200)}` });
    const body = notify.notificationBody(long, { preview: true });
    expect(body).toMatch(/^Ben: line one line two /);
    expect(body.length).toBeLessThanOrEqual('Ben: '.length + 120);
  });

  test('preview off keeps the content on this device', () => {
    expect(notify.notificationBody(message(), { preview: false })).toBe('New message');
    expect(notify.notificationTitle(message(), 'Standup')).toBe('Standup');
    expect(notify.notificationTitle(message(), null)).toBe('standup');
  });

  test('the room view model names the sender on `author`, not `displayName`', () => {
    const fromRoom = { ...message(), displayName: undefined, author: 'Priya' };
    expect(notify.notificationBody(fromRoom, { preview: true })).toBe('Priya: Ship it today');
    expect(notify.shouldNotify(fromRoom, { prefs: { enabled: true, sound: false, preview: true, mentionsOnly: true }, ownUserId: 'me' })).toBe(false);
    expect(notify.shouldNotify({ ...fromRoom, text: 'ping @priya' }, { prefs: { enabled: true, mentionsOnly: true }, ownUserId: 'me' })).toBe(true);
  });
});

describe('raising and handling the alert', () => {
  test('clicking the desktop alert asks for the room it came from', () => {
    const listeners = {}
    const handle = { addEventListener: (name, fn) => { listeners[name] = fn }, close: jest.fn() }
    const created = []
    global.Notification = jest.fn(() => handle)
    global.Notification.permission = 'granted'
    global.Notification.prototype.addEventListener = undefined
    const opened = notify.openNotification(message(), { onOpenRoom: (room) => created.push(room) })
    expect(handle).toBe(opened)
    expect(global.Notification).toHaveBeenCalledWith('standup', expect.objectContaining({ tag: 'm1', body: 'Ben: Ship it today' }))
    opened.close = jest.fn()
    listeners.click()
    expect(created).toEqual(['standup'])
  });

  test('an undecided guest is asked exactly once and the answer is returned', async () => {
    const asked = jest.fn(() => Promise.resolve('granted'))
    global.Notification = { permission: 'default', requestPermission: asked }
    await expect(notify.requestNotifyPermission()).resolves.toBe('granted')
    expect(asked).toHaveBeenCalledTimes(1)
  });
});

describe('the chime', () => {
  test('a browser with no Web Audio does not throw', () => {
    delete window.AudioContext
    expect(notify.playChime()).toBe(false);
  });

  test('two tones are scheduled on a real oscillator graph', () => {
    const started = []
    const peakVolumes = []
    const node = () => ({
      type: '', frequency: { value: 0 }, gain: { setValueAtTime: jest.fn(), exponentialRampToValueAtTime: jest.fn() },
      connect: (target) => target, start: (at) => started.push(at), stop: jest.fn(),
    })
    const gainNode = () => {
      const result = node()
      result.gain.exponentialRampToValueAtTime = jest.fn((value) => peakVolumes.push(value))
      return result
    }
    const context = {
      state: 'suspended', currentTime: 10, destination: {}, resume: jest.fn(),
      createOscillator: node, createGain: gainNode,
    }
    window.AudioContext = function Ctx() { return context }
    expect(notify.playChime()).toBe(true)
    expect(context.resume).toHaveBeenCalled()
    expect(started).toEqual([10, 10.12])
    expect(peakVolumes).toEqual([0.035, 0.0001, 0.035, 0.0001])
  });

  test('a broken audio graph is swallowed, not thrown into the socket handler', () => {
    window.AudioContext = function Ctx() { throw new Error('no device') }
    expect(notify.playChime()).toBe(false)
    delete window.AudioContext
  });
});

describe('the room wires it up', () => {
  test('an arriving message is the only trigger, and it is checked after the block filter', () => {
    const handler = APP_SOURCE.slice(APP_SOURCE.indexOf("roomSocket.on('new_message'"), APP_SOURCE.indexOf("roomSocket.on('message_delivered'"))
    expect(handler).toMatch(/if \(hiddenCheckRef\.current\(message\)\) return/)
    expect(handler).toMatch(/alertForMessage\(item\)/)
    expect(handler.indexOf('hiddenCheckRef.current(message)')).toBeLessThan(handler.indexOf('alertForMessage(item)'))
  });

  test('being busy in the room suppresses the desktop alert', () => {
    expect(APP_SOURCE).toMatch(/const away = document\.hidden \|\| !document\.hasFocus\(\)/);
    expect(APP_SOURCE).toMatch(/activeRoomId: away \? null : chat\.id/);
  });

  test('an incoming call rings even in a hidden tab', () => {
    expect(APP_SOURCE).toMatch(/calls\.call\?\.status !== 'incoming'/);
    expect(APP_SOURCE).toMatch(/openNotification\(\{ id: calls\.call\.callId/);
  });

  test('chat settings owns the device switches and asks permission on the spot', () => {
    expect(APP_SOURCE).toMatch(/const \[notify, setNotify\] = useState\(readNotifyPrefs\)/);
    expect(APP_SOURCE).toMatch(/await requestNotifyPermission\(\)/);
    expect(APP_SOURCE).toMatch(/<Bell size=\{15\} \/> Alerts/);
    expect(APP_SOURCE).toMatch(/checked=\{notify\.enabled\}/);
    expect(APP_SOURCE).toMatch(/checked=\{notify\.sound\} disabled=\{!notify\.enabled\}/);
    expect(APP_SOURCE).toMatch(/checked=\{notify\.preview\} disabled=\{!notify\.enabled\}/);
    expect(APP_SOURCE).toMatch(/checked=\{notify\.mentionsOnly\} disabled=\{!notify\.enabled\}/);
  });

  test('refusing the browser prompt is reported instead of pretending', () => {
    expect(APP_SOURCE).toMatch(/The browser refused notifications\./);
    expect(APP_SOURCE).toMatch(/disabled=\{permission === 'unsupported' \|\| permission === 'denied'\}/);
  });
});
