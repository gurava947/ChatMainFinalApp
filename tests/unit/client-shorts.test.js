/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadShortsFeed } = require('../helpers/load-client-module');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');

let feed;

beforeEach(() => {
  feed = loadShortsFeed();
});

const room = (id, name) => ({ id, name: name || id });

const message = (overrides) => ({
  id: 'msg-1',
  userId: 'guest-1',
  displayName: 'Asha',
  ts: 1700000000000,
  attachments: [],
  ...overrides,
});

const attachment = (overrides) => ({
  id: 'media-1',
  kind: 'video',
  mime: 'video/webm',
  name: 'shelf-clip.webm',
  ...overrides,
});

describe('a clip url comes from the row the server actually sent', () => {
  test('history rows hold only an id, so the media path is built from it', () => {
    expect(feed.clipUrl({ id: '2edeae24-eb5a' })).toBe('/media/2edeae24-eb5a');
    expect(feed.clipUrl({ id: 'a b/c' })).toBe('/media/a%20b%2Fc');
  });

  test('an upload that already knows its url keeps it', () => {
    expect(feed.clipUrl({ id: 'm1', url: '/media/live-m1' })).toBe('/media/live-m1');
  });

  test('an attachment with neither id nor url has nothing to play', () => {
    expect(feed.clipUrl({ mime: 'video/mp4' })).toBe('');
  });
});

describe('collecting the shorts a device can actually watch', () => {
  test('videos become clips and everything else is left out', () => {
    const rows = feed.collectVideoClips([[
      message({ attachments: [attachment()] }),
      message({ id: 'msg-2', ts: 1700000000500, attachments: [attachment({ id: 'm2', mime: 'image/png', kind: 'image', name: 'shot.png' })] }),
      message({ id: 'msg-3', attachments: [attachment({ id: 'm3', mime: 'audio/webm', kind: 'audio' })] }),
    ]], [room('p78-verify', 'P78 Verify')]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'media-1',
      url: '/media/media-1',
      name: 'shelf-clip.webm',
      room: 'p78-verify',
      roomName: 'P78 Verify',
      displayName: 'Asha',
      ts: 1700000000000,
    });
  });

  test('the newest clip leads, whatever order the rooms were read in', () => {
    const rows = feed.collectVideoClips([
      [message({ attachments: [attachment({ id: 'old', ts: 0 })], ts: 100 })],
      [message({ attachments: [attachment({ id: 'new' })], ts: 900 })],
    ], [room('ragu'), room('p78-verify', 'P78 Verify')]);

    expect(rows.map((row) => row.id)).toEqual(['new', 'old']);
    expect(rows[0].room).toBe('p78-verify');
    expect(rows[1].roomName).toBe('ragu');
  });

  test('a clip shared twice is only offered once', () => {
    const rows = feed.collectVideoClips([[
      message({ attachments: [attachment({ id: 'same' })] }),
      message({ id: 'msg-9', ts: 1700000000900, attachments: [attachment({ id: 'same' }), attachment({ id: 'other' })] }),
    ]], [room('ragu')]);

    expect(rows.map((row) => row.id)).toEqual(['other', 'same']);
  });

  test('a room without media still counts as a room that was read', () => {
    expect(feed.collectVideoClips([[], []], [room('a'), room('b')])).toEqual([]);
  });

  test('a history read that fell over does not invent clips', () => {
    expect(feed.collectVideoClips([null, undefined], [room('a'), room('b')])).toEqual([]);
  });

  test('an attachment that names no author still says it came from a guest', () => {
    const rows = feed.collectVideoClips([[message({ displayName: '', attachments: [attachment()] })]], [room('a')]);
    expect(rows[0].displayName).toBe('Guest');
  });

  test('the feed is capped so one open does not read the whole archive', () => {
    const many = Array.from({ length: feed.SHORTS_LIMIT + 25 }, (_, i) => message({
      id: `msg-${i}`,
      ts: 1000 + i,
      attachments: [attachment({ id: `m${i}` })],
    }));
    const rows = feed.collectVideoClips([many], [room('a')]);

    expect(rows).toHaveLength(feed.SHORTS_LIMIT);
    expect(rows[0].id).toBe(`m${many.length - 1}`);
  });

  test('a clip whose bytes are not addressable is not put on screen', () => {
    const rows = feed.collectVideoClips([[message({ attachments: [attachment({ id: '' })] })]], [room('a')]);
    expect(rows).toEqual([]);
  });
});

describe('the shorts page is wired to the real feed', () => {
  test('it reads the rooms on this device instead of a placeholder', () => {
    expect(APP_SOURCE).toContain('fetchRoomMessages(guest, room.id)');
    expect(APP_SOURCE).toContain('setItems(collectVideoClips(batches, targets))');
  });

  test('the "coming soon" placeholder is gone', () => {
    expect(APP_SOURCE).not.toContain('Shorts are coming soon');
    expect(APP_SOURCE).not.toContain('shorts-coming-soon');
  });

  test('the page omits the sound toggle and keeps autoplay muted', () => {
    expect(APP_SOURCE).not.toContain('shorts-sound');
    expect(APP_SOURCE).toContain('clip.muted = true');
  });

  test('the page omits its heading and empty-state panels', () => {
    expect(APP_SOURCE).not.toContain('shorts-head');
    expect(APP_SOURCE).not.toContain('No videos in your rooms yet');
    expect(APP_SOURCE).not.toContain('Join a room to see short videos');
  });
});
