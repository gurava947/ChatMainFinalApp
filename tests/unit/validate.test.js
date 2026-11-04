'use strict';

const {
  sanitizeText,
  sanitizeContent,
  messageKind,
  parse,
  roomSchema,
  usernameSchema,
  sendPayloadSchema
} = require('../../src/utils/validate');

describe('input validation and XSS sanitisation', () => {
  test('removes script-like blocks and complete tags', () => {
    expect(sanitizeText('<script>alert(1)</script>hello')).toBe('hello');
    expect(sanitizeText('<img src=x onerror="steal()">hi')).toBe('hi');
    expect(sanitizeText('<a href="javascript:alert(1)">click</a>')).toBe('click');
  });

  test('keeps a bare angle bracket so code snippets survive', () => {
    expect(sanitizeText('if (a<b) return;')).toBe('if (a<b) return;');
    expect(sanitizeText('1 < 2 and 3 > 1')).toBe('1 < 2 and 3 > 1');
  });

  test('drops control characters but keeps line breaks, capped at two', () => {
    expect(sanitizeText('be\u0000ware')).toBe('beware');
    expect(sanitizeText('  lots   of\n\nspace  ')).toBe('lots of\n\nspace');
    expect(sanitizeText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  test('room ids are slugs, so no path traversal into Redis keys', () => {
    expect(parse(roomSchema, 'engineering-1')).toBe('engineering-1');
    expect(() => parse(roomSchema, '../etc/passwd')).toThrow();
    expect(() => parse(roomSchema, 'has space')).toThrow();
    expect(() => parse(roomSchema, '')).toThrow();
  });

  test('usernames keep unicode letters but drop markup', () => {
    expect(parse(usernameSchema, 'అర్జున్')).toBe('అర్జున్');
    expect(() => parse(usernameSchema, '<b>bold</b>')).toThrow();
    expect(() => parse(usernameSchema, 'a')).toThrow();
  });

  test('rejections surface as 4xx so the HTTP layer maps them to 400', () => {
    try {
      parse(sendPayloadSchema, { room: 'general', text: '' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.statusCode).toBe(400);
    }
  });
});

describe('structured message content', () => {
  const uuid = '2f4b0a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

  test('a poll keeps its shape and defaults to single choice', () => {
    const parsed = parse(sendPayloadSchema, {
      room: 'general',
      content: { type: 'poll', question: 'Lunch?', options: ['Biryani', 'Thali'] }
    });
    expect(parsed.content.multiple).toBe(false);
    expect(parsed.content.options).toHaveLength(2);
  });

  test('a poll needs two distinct options', () => {
    expect(() => parse(sendPayloadSchema, { room: 'g', content: { type: 'poll', question: 'q', options: ['only one'] } }))
      .toThrow();
    expect(() => parse(sendPayloadSchema, { room: 'g', content: { type: 'poll', question: 'q', options: ['Tea', 'tea'] } }))
      .toThrow();
  });

  test('coordinates are bounded and arrive coerced from the geolocation string', () => {
    const parsed = parse(sendPayloadSchema, { room: 'g', content: { type: 'location', lat: '17.4239', lng: 78.4651 } });
    expect(parsed.content.lat).toBeCloseTo(17.4239);
    expect(() => parse(sendPayloadSchema, { room: 'g', content: { type: 'location', lat: 91, lng: 0 } })).toThrow();
    expect(() => parse(sendPayloadSchema, { room: 'g', content: { type: 'location', lat: 0, lng: 181 } })).toThrow();
  });

  test('a contact card is dial-able or mailable, never both empty', () => {
    expect(() => parse(sendPayloadSchema, { room: 'g', content: { type: 'contact', name: 'Guava' } })).toThrow();
    expect(() =>
      parse(sendPayloadSchema, { room: 'g', content: { type: 'contact', name: 'Guava', phone: '<a href=x>' } })
    ).toThrow();
    const parsed = parse(sendPayloadSchema, {
      room: 'g',
      content: { type: 'contact', name: 'Guava', phone: '+91 98765 43210', email: 'guava@example.com' }
    });
    expect(parsed.content.phone).toBe('+91 98765 43210');
  });

  test('an event stores epoch milliseconds and rejects an end before its start', () => {
    const parsed = parse(sendPayloadSchema, {
      room: 'g',
      content: { type: 'event', title: 'Standup', start: '2026-11-04T09:30:00.000Z' }
    });
    expect(typeof parsed.content.start).toBe('number');
    expect(parsed.content.allDay).toBe(false);
    expect(() =>
      parse(sendPayloadSchema, {
        room: 'g',
        content: { type: 'event', title: 'x', start: '2026-11-04T09:30:00.000Z', end: '2026-11-01T09:30:00.000Z' }
      })
    ).toThrow();
  });

  test('a voice message is only valid with the recording it describes', () => {
    expect(() => parse(sendPayloadSchema, { room: 'g', content: { type: 'voice', durationMs: 4200 } })).toThrow();
    expect(() =>
      parse(sendPayloadSchema, {
        room: 'g',
        content: { type: 'voice', durationMs: 4200 },
        attachments: [{ id: uuid, kind: 'image', name: 'a.png', mime: 'image/png', size: 10 }]
      })
    ).toThrow();
    const parsed = parse(sendPayloadSchema, {
      room: 'g',
      content: { type: 'voice', durationMs: 4200, peaks: [0.1, 0.9] },
      attachments: [{ id: uuid, kind: 'audio', name: 'm.webm', mime: 'audio/webm', size: 10 }]
    });
    expect(parsed.content.peaks).toEqual([0.1, 0.9]);
  });

  test('content strings are sanitised and an option that is pure markup is refused', () => {
    expect(sanitizeContent({ type: 'poll', question: '<b>Lunch?</b>', options: ['Biryani', 'Thali'] }).question)
      .toBe('Lunch?');
    expect(() => sanitizeContent({ type: 'poll', question: 'q', options: ['<script>x</script>', 'b'] })).toThrow();
    expect(sanitizeContent(null)).toBeNull();
  });

  // The field map is a list per type, so a typo silently skips sanitisation.
  test('every text field of every content type is sanitised', () => {
    const dirty = '<script>alert(1)</script>clean';
    const expectations = [
      ['poll', { question: dirty, options: [dirty, 'b'] }, ['question', 'options']],
      ['location', { lat: 1, lng: 1, label: dirty, address: dirty }, ['label', 'address']],
      ['contact', { name: dirty, phone: '123', org: dirty, note: dirty }, ['name', 'org', 'note']],
      ['event', { title: dirty, start: 1, location: dirty, note: dirty }, ['title', 'location', 'note']]
    ];
    for (const [type, content, fields] of expectations) {
      const cleaned = sanitizeContent({ type, ...content });
      for (const field of fields) {
        const value = cleaned[field];
        const values = Array.isArray(value) ? value : [value];
        for (const entry of values) expect(entry).not.toMatch(/script|<|>/);
      }
    }
  });

  test('kind is derived from content, so a client cannot label its own message', () => {
    expect(messageKind(null)).toBe('text');
    expect(messageKind({ type: 'poll' })).toBe('poll');
    expect(messageKind({ type: 'voice' })).toBe('voice');
  });

  test('text and attachments still stand alone, so older clients keep working', () => {
    expect(parse(sendPayloadSchema, { room: 'g', text: 'hello' }).content).toBeUndefined();
    expect(parse(sendPayloadSchema, { room: 'g', attachments: [{ id: uuid, kind: 'document', name: 'a.pdf', mime: 'application/pdf', size: 99 }] }).text)
      .toBe('');
    expect(() => parse(sendPayloadSchema, { room: 'g' })).toThrow();
  });
});
