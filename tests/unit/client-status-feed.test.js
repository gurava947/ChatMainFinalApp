/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { STATUS_COLORS } = require('../../src/constants');
const { loadStatusFeed } = require('../helpers/load-client-module');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const NOW = new Date('2026-11-04T15:04:00').getTime();

let win;

beforeEach(() => {
  win = loadStatusFeed();
});

const card = (overrides) => ({
  id: 's1',
  kind: 'text',
  text: 'Shipping today',
  color: '#22d3ee',
  media: null,
  createdAt: NOW - HOUR,
  expiresAt: NOW + DAY - HOUR,
  remainingMs: DAY - HOUR,
  author: { userId: 'u1', displayName: 'Ben', avatar: null },
  mine: false,
  viewedByMe: false,
  viewerCount: 0,
  ...overrides,
});

describe('the palette', () => {
  test('the browser may only offer colours the server will accept', () => {
    expect(win.STATUS_PALETTE.map((entry) => entry.hex)).toEqual([...STATUS_COLORS]);
  });

  test('every swatch has a name, because a colour alone is not a label', () => {
    for (const entry of win.STATUS_PALETTE) expect(entry.name).toBeTruthy();
  });

  test('a colour that is not on the palette falls back instead of posting garbage', () => {
    expect(win.pickColor('#deadff')).toBe(win.STATUS_PALETTE[0].hex);
    expect(win.pickColor(undefined)).toBe(win.STATUS_PALETTE[0].hex);
    expect(win.pickColor('#34d399')).toBe('#34d399');
  });

  test('the composer cannot outtype the server limit', () => {
    expect(win.STATUS_TEXT_MAX).toBe(200);
  });
});

describe('the countdown', () => {
  test('a day of updates is read as hours, not seconds', () => {
    expect(win.timeLeftLabel(23 * HOUR + 40 * MINUTE)).toBe('23h 40m left');
    expect(win.timeLeftLabel(5 * HOUR + 30 * MINUTE)).toBe('5h 30m left');
    expect(win.timeLeftLabel(42 * MINUTE)).toBe('42m left');
  });

  test('the last minute says so instead of counting to zero', () => {
    expect(win.timeLeftLabel(30 * 1000)).toBe('Expires in under a minute');
    expect(win.timeLeftLabel(0)).toBe('Expires in under a minute');
    expect(win.timeLeftLabel(-5000)).toBe('Expires in under a minute');
  });

  test('a card that has not quite expired never reads as more than a day', () => {
    expect(win.timeLeftLabel(DAY)).toBe('Less than a day left');
  });

  // A freshly posted card is a hair under 24h and once read "23h 60m left".
  test('minutes never roll into sixty on the way down', () => {
    for (const left of [DAY - 1000, DAY - 90_000, 23 * HOUR + 59 * MINUTE + 31_000]) {
      expect(win.timeLeftLabel(left)).not.toMatch(/60m/);
    }
    expect(win.timeLeftLabel(DAY - 1000)).toBe('Less than a day left');
    expect(win.timeLeftLabel(90 * MINUTE)).toBe('1h 30m left');
  });

  test('a card past its deadline is not live', () => {
    expect(win.isLive(card({ expiresAt: NOW + 1000 }), NOW)).toBe(true);
    expect(win.isLive(card({ expiresAt: NOW - 1 }), NOW)).toBe(false);
    expect(win.isLive(null, NOW)).toBe(false);
  });
});

describe('reading the feed', () => {
  test('an expired card drops out of every group', () => {
    const groups = win.groupFeed([card({ expiresAt: NOW - 1, mine: true })], NOW);
    expect(groups.mine).toEqual([]);
  });

  test('mine, new and already seen are three separate lists', () => {
    const groups = win.groupFeed([
      card({ id: 'a', mine: true, createdAt: NOW - 2 * HOUR }),
      card({ id: 'b', mine: true, createdAt: NOW - 1 * HOUR }),
      card({ id: 'c', author: { userId: 'u9', displayName: 'Ann', avatar: null } }),
      card({ id: 'd', viewedByMe: true }),
    ], NOW);
    expect(groups.mine.map((row) => row.id)).toEqual(['b', 'a']);
    expect(groups.unseen.map((row) => row.id)).toEqual(['c']);
    expect(groups.seen.map((row) => row.id)).toEqual(['d']);
  });

  test('a new card from someone else is what lights the badge', () => {
    expect(win.hasUnseen([card({ viewedByMe: true })])).toBe(false);
    expect(win.hasUnseen([card({ mine: true })])).toBe(false);
    expect(win.hasUnseen([card({})])).toBe(true);
    expect(win.hasUnseen([])).toBe(false);
  });

  test('the reader walks cards oldest first, so the feed is spent in order', () => {
    const ordered = win.playOrder([card({ id: 'new', createdAt: NOW }), card({ id: 'old', createdAt: NOW - DAY / 2 }), card({ id: 'dead', createdAt: NOW - DAY, expiresAt: NOW - 1000 })], NOW);
    expect(ordered.map((row) => row.id)).toEqual(['old', 'new']);
    expect(win.nextInPlay(ordered, 'old').id).toBe('new');
    expect(win.nextInPlay(ordered, 'new')).toBe(null);
    expect(win.nextInPlay(ordered, 'not-a-card')).toBe(null);
  });
});

describe('what a card says about itself', () => {
  test('a text card speaks its own line', () => {
    expect(win.cardSummary(card({ text: 'hello' }))).toBe('hello');
  });

  test('a media card names the file it holds', () => {
    expect(win.cardSummary(card({ kind: 'image', media: { name: 'beach.png' } }))).toBe('beach.png');
    expect(win.cardSummary(card({ kind: 'video', media: null }))).toBe('Video status');
  });

  test('one viewer is a person, not a unit', () => {
    expect(win.viewersLabel(0)).toBe('No one has seen this yet');
    expect(win.viewersLabel(1)).toBe('Seen by 1 person');
    expect(win.viewersLabel(12)).toBe('Seen by 12 people');
  });

  test('only the author with something to show may open the viewer list', () => {
    expect(win.canReadViewers(card({ mine: true, viewerCount: 2 }))).toBe(true);
    expect(win.canReadViewers(card({ mine: true, viewerCount: 0 }))).toBe(false);
    expect(win.canReadViewers(card({ mine: false, viewerCount: 9 }))).toBe(false);
  });
});

describe('choosing a file for a card', () => {
  test('a photo or a clip is decided by its type, not its name', () => {
    expect(win.mediaKind({ type: 'image/jpeg' })).toBe('image');
    expect(win.mediaKind({ type: 'video/mp4' })).toBe('video');
  });

  test('anything else is refused before it is uploaded', () => {
    expect(win.mediaKind({ type: 'application/pdf' })).toBe(null);
    expect(win.mediaKind({ type: '' })).toBe(null);
    expect(win.mediaKind(undefined)).toBe(null);
  });
});

describe('the updates page is wired to the real feed', () => {
  test('it reads, posts, views and deletes through the session endpoints', () => {
    expect(APP_SOURCE).toContain('await fetchStatuses(guest)');
    expect(APP_SOURCE).toContain('postTextStatus(guest, { kind: \'text\', text: trimmed, color })');
    expect(APP_SOURCE).toContain('postMediaStatus(guest, { kind, id: uploaded.id })');
    expect(APP_SOURCE).toContain('await deleteStatus(guest, card.id)');
    expect(APP_SOURCE).toContain('markStatusSeen(guest, card.id)');
    expect(APP_SOURCE).toContain('await fetchStatusViewers(guest, card.id)');
  });

  test('empty status sections and their screenshot headings are not rendered', () => {
    expect(APP_SOURCE).not.toContain('<h2>My status</h2>');
    expect(APP_SOURCE).not.toContain('<h2>Other updates</h2>');
    expect(APP_SOURCE).not.toContain('You have no update live.');
    expect(APP_SOURCE).not.toContain('No updates from other guests');
  });

  test('a card another guest posts while this page is open arrives live', () => {
    expect(APP_SOURCE).toContain("socket.on('status_created', refresh)");
    expect(APP_SOURCE).toContain("socket.on('status_removed', refresh)");
  });

  test('your own card never records a view against itself', () => {
    expect(APP_SOURCE).toContain('if (card.mine || card.viewedByMe) return');
  });

  test('the old placeholder notices are gone', () => {
    expect(APP_SOURCE).not.toContain('Updates are coming soon.');
    expect(APP_SOURCE).not.toContain('No additional updates are available yet.');
    expect(APP_SOURCE).not.toContain('Coming soon');
  });

  test('a status photo goes through the same shrink the chat uses', () => {
    expect(APP_SOURCE).toContain('await prepareFiles([file], { hd: readHdPreference() })');
    expect(APP_SOURCE).toContain('await uploadStatusMedia(guest, prepared)');
  });

  test('a text card is capped by the same limit the server enforces', () => {
    expect(APP_SOURCE).toContain('maxLength={STATUS_TEXT_MAX}');
    expect(APP_SOURCE).toContain('text.trim().slice(0, STATUS_TEXT_MAX)');
  });
});
