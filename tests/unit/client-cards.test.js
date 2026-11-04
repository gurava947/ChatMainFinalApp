/** @jest-environment jsdom */

'use strict';

const { join, loadClient, tick } = require('../helpers/client-env');

const MEDIA_ID = '00000000-0000-4000-8000-000000000007';
const bubbles = () => Array.from(document.querySelectorAll('#message-list .msg'));
const lastBubble = () => bubbles().pop();
const slot = (node) => node.querySelector('[data-role="content"]');
const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();

function incoming(api, message) {
  api.socket.fire('new_message', {
    room: 'general',
    userId: 'user-2',
    displayName: 'Nia',
    text: '',
    ts: Date.now(),
    ...message
  });
  return lastBubble();
}

describe('content cards', () => {
  let api;

  beforeEach(async () => {
    api = loadClient();
    await join(api);
  });

  it('renders a poll with its options and tallies', () => {
    const node = incoming(api, {
      id: 'poll-1',
      kind: 'poll',
      content: { type: 'poll', question: 'Ship on Friday?', options: ['Morning', 'Evening'], multiple: false },
      results: { totalVoters: 4, options: [{ count: 3, voters: ['user-1'] }, { count: 1, voters: ['user-2'] }] }
    });

    const card = slot(node).querySelector('.card--poll');
    expect(card).not.toBeNull();
    expect(text(card)).toContain('Ship on Friday?');
    expect(text(card)).toContain('one choice');
    expect(card.querySelectorAll('.poll__row')).toHaveLength(2);
    expect(card.querySelector('.poll__foot').textContent).toBe('4 votes');
    expect(card.querySelectorAll('.poll__bar')[0].style.width).toBe('75%');
    expect(card.querySelectorAll('.poll__bar')[1].style.width).toBe('25%');
    expect(card.querySelectorAll('.poll__row')[0].dataset.mine).toBe('yes');
    expect(card.querySelectorAll('.poll__row')[1].dataset.mine).toBe('');
  });

  it('tallies a single voter without a zero-division and marks the choice', () => {
    const node = incoming(api, {
      id: 'poll-2',
      kind: 'poll',
      content: { type: 'poll', question: 'Where?', options: ['Pondy', 'Goa'], multiple: true },
      results: { totalVoters: 1, options: [{ count: 1, voters: ['user-2'] }, { count: 0, voters: [] }] }
    });

    const card = slot(node).querySelector('.card--poll');
    expect(card.querySelector('.poll__foot').textContent).toBe('1 vote');
    expect(text(card)).toContain('choose any that fit');
  });

  it('votes with the id the server gave the message', () => {
    incoming(api, {
      id: 'poll-3',
      kind: 'poll',
      content: { type: 'poll', question: 'Lunch?', options: ['Biryani', 'Dosa'], multiple: false }
    });

    lastBubble().querySelectorAll('.poll__pick')[1].click();

    const vote = api.socket.last('poll:vote');
    expect(vote.payload).toEqual({ messageId: 'poll-3', choices: [1] });
  });

  it('refuses to vote on a poll that has not reached the server yet', () => {
    api.socket.instance.connected = false;
    api.G().deliver({
      text: '',
      content: { type: 'poll', question: 'Not sent yet', options: ['A', 'B'], multiple: false }
    });

    lastBubble().querySelectorAll('.poll__pick')[0].click();

    expect(api.socket.last('poll:vote')).toBeUndefined();
    expect(text(document.getElementById('message-list'))).toContain('still on its way');
  });

  it('adopts the promoted id so a queued poll becomes votable', () => {
    api.socket.instance.connected = false;
    api.G().deliver({
      text: '',
      content: { type: 'poll', question: 'Almost there', options: ['A', 'B'], multiple: false }
    });
    api.socket.instance.connected = true;
    api.socket.fire('connect');

    api.socket.answer('message', { ok: true, id: 'poll-4', ts: Date.now(), room: 'general' });
    expect(lastBubble().dataset.messageId).toBe('poll-4');

    lastBubble().querySelectorAll('.poll__pick')[0].click();
    expect(api.socket.last('poll:vote').payload.messageId).toBe('poll-4');
  });

  it('repaints the bars when another voter answers, without re-rendering', () => {
    incoming(api, {
      id: 'poll-5',
      kind: 'poll',
      content: { type: 'poll', question: 'Standup time?', options: ['09:30', '10:00'], multiple: false }
    });
    const node = lastBubble();
    const before = node.querySelector('.poll__foot').textContent;

    api.socket.fire('poll_voted', {
      messageId: 'poll-5',
      room: 'general',
      userId: 'user-3',
      displayName: 'Kumar',
      choices: [1],
      at: Date.now(),
      results: { totalVoters: 1, options: [{ count: 0, voters: [] }, { count: 1, voters: ['user-3'] }] }
    });

    expect(node.isConnected).toBe(true);
    expect(before).toBe('No votes yet');
    expect(node.querySelector('.poll__foot').textContent).toBe('1 vote');
    expect(node.querySelectorAll('.poll__bar')[1].style.width).toBe('100%');
  });

  it('plays a voice message from the card and never renders a second player', async () => {
    const node = incoming(api, {
      id: 'voice-1',
      kind: 'voice',
      content: { type: 'voice', durationMs: 12400, peaks: [0.2, 0.6, 0.9] },
      attachments: [{ id: MEDIA_ID, kind: 'audio', name: 'clip.webm', mime: 'audio/webm', size: 4096 }]
    });

    expect(node.querySelector('.card--voice')).not.toBeNull();
    expect(node.querySelectorAll('[data-role="media"] .att')).toHaveLength(0);
    expect(node.querySelector('[data-role="media"]').hidden).toBe(true);
    expect(node.querySelector('audio')).toBeNull();
    expect(node.querySelectorAll('.voice__wave i')).toHaveLength(3);
    expect(text(node)).toContain('0:12');

    node.querySelector('.voice__play').click();
    await tick(2);
    expect(node.querySelector('.voice__play').textContent).toBe('❚❚');
  });

  it('says so when a recording has expired', () => {
    const node = incoming(api, {
      id: 'voice-2',
      kind: 'voice',
      content: { type: 'voice', durationMs: 5000, peaks: [] },
      attachments: []
    });

    expect(text(node.querySelector('.card__missing'))).toContain('this recording has expired');
    expect(node.querySelector('.voice__play')).toBeNull();
  });

  it('links a shared location out to the map instead of embedding a frame', () => {
    const node = incoming(api, {
      id: 'loc-1',
      kind: 'location',
      content: { type: 'location', lat: 17.385, lng: 78.4867, accuracyM: 42, label: 'Office', address: 'Hyderabad' }
    });

    const card = slot(node).querySelector('.card--place');
    const link = card.querySelector('a.card__link');

    expect(link.href).toContain('openstreetmap.org');
    expect(link.href).toContain('mlat=17.385');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(card.querySelector('iframe')).toBeNull();
    expect(text(card)).toContain('17.38500, 78.48670 · ±42 m');
    expect(text(card)).toContain('Hyderabad');
  });

  it('builds dial and mail links from a contact, digits only in the href', () => {
    const node = incoming(api, {
      id: 'contact-1',
      kind: 'contact',
      content: {
        type: 'contact',
        name: 'Rekha Rao',
        phone: '+91 98480 00000',
        email: 'rekha@example.com',
        org: 'Acme',
        note: 'Sprint review'
      }
    });

    const links = Array.from(node.querySelectorAll('.card__actions a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'tel:+919848000000',
      'mailto:rekha@example.com'
    ]);
    expect(text(node)).toContain('Rekha Rao');
    expect(text(node)).toContain('Acme');
  });

  it('shows an event with its time window and downloads a calendar file', () => {
    const start = new Date('2026-11-05T18:30:00').getTime();
    const node = incoming(api, {
      id: 'event-1',
      kind: 'event',
      content: {
        type: 'event',
        title: 'Design review',
        start,
        end: start + 45 * 60 * 1000,
        allDay: false,
        location: 'Studio 2',
        note: 'Bring the flow boards'
      }
    });

    expect(text(node)).toContain('Design review');
    expect(text(node)).toContain('Nov 5');
    expect(text(node)).toContain('Studio 2');

    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    node.querySelector('.card__actions button').click();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('formats an all-day event label without a clock', () => {
    const start = new Date('2026-11-05T09:00:00').getTime();
    const node = incoming(api, {
      id: 'event-2',
      kind: 'event',
      content: { type: 'event', title: 'Holiday', start, allDay: true }
    });

    expect(text(node)).toContain('Event · all day');
    expect(node.querySelector('.card__when').textContent).toBe('Nov 5');
  });
});

describe('calendar export', () => {
  let rich;

  beforeAll(async () => {
    const api = loadClient();
    await join(api);
    rich = window.GChatRich;
  });

  it('escapes the fields iCalendar treats as separators', () => {
    expect(rich.icsText('Rao; Priya, (desk)')).toBe('Rao\\; Priya\\, (desk)');
    expect(rich.icsText('line one\nline two')).toBe('line one\\nline two');
  });

  it('writes a timed event in UTC and an all-day event as a date', () => {
    const start = new Date('2026-11-05T18:30:00').getTime();
    const timed = rich.buildIcs(
      { title: 'Design review', start, end: start + 2700000, location: 'Studio 2', note: 'Bring boards' },
      'event-1'
    );
    expect(timed).toContain('BEGIN:VCALENDAR');
    expect(timed).toContain('UID:event-1@gchat');
    expect(timed).toContain('SUMMARY:Design review');
    expect(timed).toContain('LOCATION:Studio 2');
    expect(timed).toContain('DESCRIPTION:Bring boards');
    expect(timed.match(/DTSTART:\d{8}T\d{6}Z/g)).toHaveLength(1);
    expect(timed.match(/DTEND:\d{8}T\d{6}Z/g)).toHaveLength(1);
    expect(timed).toContain('\r\n');

    const allDay = rich.buildIcs({ title: 'Holiday', start, allDay: true }, 'event-2');
    expect(allDay).toContain('DTSTART;VALUE=DATE:');
    expect(allDay).not.toContain('DTEND');
    expect(allDay).not.toContain('TZID');
  });

  it('joins a same-day window into one label', () => {
    const start = new Date('2026-11-05T18:30:00').getTime();
    expect(rich.whenLabel({ title: 'x', start, end: start + 2700000 })).toMatch(/^Nov 5 · .* – .*$/);
    expect(rich.whenLabel({ title: 'x', start, end: start + 26 * 3600000 })).toContain('Nov 6');
  });
});
