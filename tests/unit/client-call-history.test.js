/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadCallHistory } = require('../helpers/load-client-module');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');

const HOUR = 3600000;
const DAY = 86400000;
const NOW = new Date('2026-11-04T15:04:00').getTime();

let win;

beforeEach(() => {
  win = loadCallHistory();
});

const call = (overrides) => ({
  id: 'call-1',
  room: 'standup',
  mode: 'audio',
  status: 'ended',
  startedAt: NOW,
  connectedAt: NOW,
  endedAt: NOW + 1000,
  durationMs: 65000,
  direction: 'out',
  peer: { userId: 'u2', displayName: 'Ben' },
  ...overrides,
});

describe('naming a call', () => {
  test('the same record reads differently for the two guests in it', () => {
    expect(win.describeCall(call({ status: 'missed', direction: 'out' }))).toBe('No answer voice call');
    expect(win.describeCall(call({ status: 'missed', direction: 'in' }))).toBe('Missed voice call');
    expect(win.describeCall(call({ status: 'declined', direction: 'out' }))).toBe('Declined voice call');
    expect(win.describeCall(call({ status: 'declined', direction: 'in' }))).toBe('You declined voice call');
    expect(win.describeCall(call({ status: 'ringing', direction: 'out' }))).toBe('Calling voice call');
    expect(win.describeCall(call({ status: 'ringing', direction: 'in' }))).toBe('Ringing voice call');
    expect(win.describeCall(call({ status: 'connected' }))).toBe('Ongoing voice call');
  });

  test('the mode is spoken, because a missed video is not a missed voice call', () => {
    expect(win.describeCall(call({ mode: 'video', status: 'ended' }))).toBe('Ended video call');
  });

  test('a call nobody answered has no duration to show', () => {
    expect(win.callDurationLabel(call({ durationMs: 65000 }))).toBe('1:05');
    expect(win.callDurationLabel(call({ durationMs: 125000 }))).toBe('2:05');
    expect(win.callDurationLabel(call({ durationMs: 3725000 }))).toBe('1:02:05');
    expect(win.callDurationLabel(call({ connectedAt: null, durationMs: 0 }))).toBe('');
    expect(win.callDurationLabel(null)).toBe('');
  });

  /**
   * The server stamps a wall-clock difference, so a twelve-second call really
   * arrives as 12919 ms. A whole-second test would not have noticed the fraction
   * being printed as a decimal.
   */
  test('a duration that is not a whole number of seconds is still a duration', () => {
    expect(win.callDurationLabel(call({ durationMs: 12919 }))).toBe('0:12');
    expect(win.callDurationLabel(call({ durationMs: 999 }))).toBe('0:00');
    expect(win.callDurationLabel(call({ durationMs: 60111 }))).toBe('1:00');
  });
});

describe('placing a call in time', () => {
  test('today is the clock time the guest remembers', () => {
    const expected = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(NOW));
    expect(win.callMoment(NOW, NOW)).toBe(expected);
  });

  test('yesterday is a word and anything older is a dated day', () => {
    expect(win.callMoment(NOW - DAY, NOW)).toBe('Yesterday');
    expect(win.callMoment(NOW - 6 * DAY, NOW)).not.toBe('Today');
    expect(win.callMoment(NOW - 6 * DAY, NOW)).toMatch(/\d/);
  });

  test('a call a year old still shows its year', () => {
    expect(win.callMoment(NOW - 400 * DAY, NOW)).toMatch(/20\d\d|2025/);
  });
});

describe('grouping the log', () => {
  test('newest first, under one heading per calendar day', () => {
    const groups = win.groupCallsByDay([
      call({ id: 'a', startedAt: NOW - 3 * HOUR }),
      call({ id: 'b', startedAt: NOW - 3 * DAY }),
      call({ id: 'c', startedAt: NOW - 6 * HOUR }),
    ], NOW);

    expect(groups.map((group) => group.label)).toEqual(['Today', new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(NOW - 3 * DAY))]);
    expect(groups[0].calls.map((row) => row.id)).toEqual(['a', 'c']);
  });

  test('an empty log groups into nothing instead of a phantom day', () => {
    expect(win.groupCallsByDay([], NOW)).toEqual([]);
  });

  test('the guest list is never reordered by the grouping maths', () => {
    const groups = win.groupCallsByDay([call({ id: 'x' })], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].calls[0].id).toBe('x');
  });
});

describe('ringing somebody back', () => {
  test('only a call that came in from a known guest can be returned', () => {
    expect(win.canCallBack(call({ direction: 'in' }))).toBe(true);
    expect(win.canCallBack(call({ direction: 'out' }))).toBe(false);
    expect(win.canCallBack(call({ peer: null }))).toBe(false);
    expect(win.canCallBack(null)).toBe(false);
  });
});

describe('the calls page is wired to the real log', () => {
  test('it reads and clears through the session endpoints', () => {
    expect(APP_SOURCE).toContain('fetchCallHistory(guest)');
    expect(APP_SOURCE).toContain('await clearCallHistory(guest)');
  });

  test('a call is cleared behind a confirm, never by one click', () => {
    expect(APP_SOURCE).toContain('setConfirmClear(true)');
    expect(APP_SOURCE).toContain('Clear every call record for this guest?');
  });

  test('a missed incoming call offers a real call-back through the room socket', () => {
    expect(APP_SOURCE).toContain('onCallBack(call)');
    expect(APP_SOURCE).toContain('{ userId: call.peer.userId, displayName: call.peer.displayName, mode: call.mode }');
    expect(APP_SOURCE).toContain('calls.startCall(peer, autoCall.mode)');
  });

  test('a guest who is no longer in the room is reported, not quietly skipped', () => {
    expect(APP_SOURCE).toContain('right now, so there is nobody to call back.');
  });
});
