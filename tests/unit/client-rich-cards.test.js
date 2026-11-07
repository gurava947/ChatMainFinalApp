'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadRichCards } = require('../helpers/load-client-module');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');

let cards;

beforeEach(() => {
  cards = loadRichCards();
});

describe('poll builder', () => {
  test('a trimmed question and blank options make a clean poll', () => {
    const poll = cards.buildPollContent({ question: '  Lunch spot?  ', options: [' Idli ', '', 'Dosa  ', 'Biryani'] });
    expect(poll).toEqual({ type: 'poll', question: 'Lunch spot?', options: ['Idli', 'Dosa', 'Biryani'], multiple: false });
  });

  test('a poll needs a question', () => {
    expect(() => cards.buildPollContent({ question: '   ', options: ['a', 'b'] })).toThrow(/question is required/i);
  });

  test('a poll needs at least two real options', () => {
    expect(() => cards.buildPollContent({ question: 'Q', options: ['only one', '   '] })).toThrow(/at least 2/i);
  });

  test('duplicate options are rejected the same way the server rejects them', () => {
    expect(() => cards.buildPollContent({ question: 'Q', options: ['Tea', ' tea '] })).toThrow(/must be different/i);
  });

  test('the option cap is enforced before the send, not after a rejection', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => `option ${index}`);
    expect(cards.buildPollContent({ question: 'Q', options: twelve }).options).toHaveLength(12);
    expect(() => cards.buildPollContent({ question: 'Q', options: [...twelve, 'one too many'] })).toThrow(/at most 12/i);
  });

  test('multi-choice polls say so in the payload', () => {
    expect(cards.buildPollContent({ question: 'Q', options: ['a', 'b'], multiple: true }).multiple).toBe(true);
  });
});

describe('contact builder', () => {
  test('a phone and email both survive as dial and mail targets', () => {
    const contact = cards.buildContactContent({ name: ' Asha ', phone: '+91 98765 43210', email: 'asha@example.com', org: 'Acme', note: 'Design' });
    expect(contact).toEqual({
      type: 'contact', name: 'Asha', phone: '+91 98765 43210', email: 'asha@example.com', org: 'Acme', note: 'Design'
    });
  });

  test('a contact without any way to reach them is refused', () => {
    expect(() => cards.buildContactContent({ name: 'Asha' })).toThrow(/phone number or an email/i);
  });

  test('a phone with letters is refused rather than sent into a tel: link', () => {
    expect(() => cards.buildContactContent({ name: 'Asha', phone: 'call me 24x7' })).toThrow(/unsupported characters/i);
  });

  test('an incomplete email is refused', () => {
    expect(() => cards.buildContactContent({ name: 'Asha', email: 'asha@' })).toThrow(/not complete/i);
  });

  test('contact links are built from the validated fields only', () => {
    const links = cards.contactLinks({ name: 'Asha', phone: '+91 98765 43210', email: 'asha@example.com' });
    expect(links).toEqual([
      { label: '+91 98765 43210', href: 'tel:+919876543210' },
      { label: 'asha@example.com', href: 'mailto:asha@example.com' }
    ]);
  });
});

describe('event builder and calendar file', () => {
  const start = '2026-11-20T09:30:00Z';

  test('a timed event keeps parsed millisecond bounds', () => {
    const event = cards.buildEventContent({ title: 'Retro', start, end: '2026-11-20T10:00:00Z', location: 'Room 4' });
    expect(event.type).toBe('event');
    expect(event.start).toBe(Date.parse(start));
    expect(event.end).toBe(Date.parse('2026-11-20T10:00:00Z'));
    expect(event.location).toBe('Room 4');
    expect(event.allDay).toBe(false);
  });

  test('an event that ends before it starts is refused', () => {
    expect(() => cards.buildEventContent({ title: 'Retro', start, end: '2026-11-20T09:00:00Z' })).toThrow(/end after it starts/i);
  });

  test('an unreadable date is refused instead of becoming NaN in the payload', () => {
    expect(() => cards.buildEventContent({ title: 'Retro', start: 'next tuesday' })).toThrow(/start date/i);
  });

  test('the calendar file is a real VEVENT with UTC stamps and CRLF lines', () => {
    const event = cards.buildEventContent({ title: 'Retro', start, end: '2026-11-20T10:00:00Z' });
    const ics = cards.icsForEvent(event, 'm1');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('UID:m1@inchat');
    expect(ics).toContain('DTSTART:20261120T093000Z');
    expect(ics).toContain('DTEND:20261120T100000Z');
    expect(ics).toContain('SUMMARY:Retro');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics.split('\r\n').length).toBeGreaterThan(10);
  });

  test('an all-day event uses DATE values and covers exactly one day', () => {
    const event = cards.buildEventContent({ title: 'Offsite', start: '2026-11-20', allDay: true });
    const ics = cards.icsForEvent(event);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261120');
    expect(ics).toContain('DTEND;VALUE=DATE:20261121');
  });

  test('an event without an end gets a one hour window instead of an open file', () => {
    const event = cards.buildEventContent({ title: 'Sync', start });
    const ics = cards.icsForEvent(event);
    expect(ics).toContain('DTSTART:20261120T093000Z');
    expect(ics).toContain('DTEND:20261120T103000Z');
  });

  test('commas, semicolons and newlines in the text cannot forge calendar fields', () => {
    const event = cards.buildEventContent({
      title: 'Retro, with cake; all teams',
      start,
      location: 'Café\nAttic',
      note: 'Bring: notes'
    });
    const ics = cards.icsForEvent(event);
    expect(ics).toContain('SUMMARY:Retro\\, with cake\\; all teams');
    expect(ics).toContain('LOCATION:Café\\nAttic');
    // No injected line may start its own field.
    expect(ics.split('\r\n').filter((line) => /^SUMMARY|^LOCATION|^DESCRIPTION/.test(line))).toHaveLength(3);
  });
});

describe('poll tallies', () => {
  const content = { type: 'poll', question: 'Q', options: ['Tea', 'Coffee', 'Water'] };

  test('counts become shares, and this viewer sees their own vote', () => {
    const results = {
      totalVoters: 3,
      options: [
        { count: 2, voters: ['u1', 'me'] },
        { count: 1, voters: ['u2'] },
        { count: 0, voters: [] }
      ]
    };
    const outcome = cards.pollOutcome(content, results, 'me');
    expect(outcome.total).toBe(3);
    expect(outcome.mine).toBe(true);
    expect(outcome.leading).toBe(2);
    expect(outcome.rows.map((row) => row.share)).toEqual([67, 33, 0]);
    expect(outcome.rows[0].mine).toBe(true);
    expect(outcome.rows[1].mine).toBe(false);
  });

  test('a poll nobody has voted in still renders every option', () => {
    const outcome = cards.pollOutcome(content, null, 'me');
    expect(outcome.total).toBe(0);
    expect(outcome.mine).toBe(false);
    expect(outcome.rows.map((row) => row.label)).toEqual(['Tea', 'Coffee', 'Water']);
    expect(outcome.rows.every((row) => row.count === 0 && row.share === 0)).toBe(true);
  });

  test('a results payload shorter than the option list does not crash the card', () => {
    const outcome = cards.pollOutcome(content, { totalVoters: 1, options: [{ count: 1, voters: ['u1'] }] }, 'u1');
    expect(outcome.rows).toHaveLength(3);
    expect(outcome.rows[2].count).toBe(0);
  });
});

describe('room wiring of the cards', () => {
  test('the app imports the builders instead of re-declaring them', () => {
    expect(APP_SOURCE).toMatch(/from '\.\/richCards'/);
    ['buildPollContent', 'buildContactContent', 'buildEventContent', 'icsForEvent', 'pollOutcome', 'contactLinks']
      .forEach((name) => expect(APP_SOURCE).toContain(name));
  });

  test('each rich message type gets its own card', () => {
    expect(APP_SOURCE).toMatch(/content\?\.type === 'poll' && <PollCard/);
    expect(APP_SOURCE).toMatch(/content\?\.type === 'contact' && <ContactCard/);
    expect(APP_SOURCE).toMatch(/content\?\.type === 'event' && <EventCard/);
  });

  test('a poll keeps the tally the server sent with history', () => {
    expect(APP_SOURCE).toMatch(/results: message\.results \|\| null/);
  });

  test('a vote from anybody else repaints the ballot', () => {
    const listener = APP_SOURCE.slice(APP_SOURCE.indexOf("roomSocket.on('poll_voted'"), APP_SOURCE.indexOf("roomSocket.on('presence'"));
    expect(listener).toMatch(/payload\.room !== chat\.id \|\| !payload\.results/);
    expect(listener).toMatch(/message\.id === payload\.messageId/);
    expect(listener).toMatch(/results: payload\.results/);
  });

  test('voting goes over the socket the server already answers', () => {
    const card = APP_SOURCE.slice(APP_SOURCE.indexOf('function PollCard'), APP_SOURCE.indexOf('function ContactCard'));
    expect(card).toMatch(/socket\.timeout\(10000\)\.emit\('poll:vote', \{ messageId: message\.id, choices: picked \}/);
    expect(card).toMatch(/Reconnect to the room before voting\./);
    expect(card).toMatch(/pollOutcome\(content, message\.results, session\.userId\)/);
  });

  test('the composer validates before it sends', () => {
    const sheet = APP_SOURCE.slice(APP_SOURCE.indexOf('function RichComposer'), APP_SOURCE.indexOf('function mergeMessage'));
    expect(sheet).toMatch(/buildPollContent\(fields\)/);
    expect(sheet).toMatch(/buildContactContent\(fields\)/);
    expect(sheet).toMatch(/buildEventContent\(fields\)/);
    expect(sheet).toMatch(/setError\(cause\.message\)/);
    expect(sheet).toMatch(/onSend\(content\)/);
  });

  test('the plus sheet offers the three cards, so none of them is a dead end', () => {
    // Matched on the attribute, not the whole tag: the menu also carries a ref for its keyboard hook.
    const menuStart = APP_SOURCE.indexOf('className="attachment-menu"');
    expect(menuStart).toBeGreaterThan(-1);
    const menu = APP_SOURCE.slice(menuStart, APP_SOURCE.indexOf('</div>}', menuStart));
    expect(menu).toMatch(/setRichSheet\('poll'\)/);
    expect(menu).toMatch(/setRichSheet\('event'\)/);
    expect(menu).toMatch(/setRichSheet\('contact'\)/);
    expect(menu).toMatch(/shareLocation/);
    expect(APP_SOURCE).toMatch(/<RichComposer kind=\{richSheet\}/);
  });

  test('the calendar button writes a real .ics file rather than announcing one', () => {
    const card = APP_SOURCE.slice(APP_SOURCE.indexOf('function EventCard'), APP_SOURCE.indexOf('const richSheetFields'));
    expect(card).toMatch(/new Blob\(\[icsForEvent\(content, message\.id \|\| message\.clientId\)\]/);
    expect(card).toMatch(/anchor\.download = /);
    expect(card).toMatch(/\.ics`/);
    expect(card).toMatch(/anchor\.click\(\)/);
    expect(card).toMatch(/URL\.revokeObjectURL\(url\)/);
  });

  test('a contact only links to a validated phone or email', () => {
    const card = APP_SOURCE.slice(APP_SOURCE.indexOf('function ContactCard'), APP_SOURCE.indexOf('function EventCard'));
    expect(card).toMatch(/contactLinks\(content\)/);
    expect(card).toMatch(/href=\{link\.href\}/);
    // No href may be built straight from user text here.
    expect(card).not.toMatch(/href=\{`tel:/);
  });
});
