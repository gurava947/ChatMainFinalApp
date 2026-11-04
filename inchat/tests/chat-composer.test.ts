import { describe, expect, it } from 'vitest';

import {
  MAX_POLL_OPTIONS,
  STANDARD_EDGE,
  attachmentKindForMime,
  choiceOf,
  contactDraft,
  eventDraft,
  extensionOf,
  locationDraft,
  mediaDraft,
  messageKindForAttachment,
  pollDraft,
  pollView,
  registrationOf,
  targetEdge,
  votersOf,
  withLocalVote,
  type PollInput
} from '@/lib/chat/composer';

const poll = (over: Partial<PollInput> = {}): PollInput => ({
  question: 'Lunch?',
  options: ['Biryani', 'Thali'],
  multiple: false,
  ...over
});

describe('poll drafts', () => {
  it('writes the shape vote_in_poll() reads', () => {
    const built = pollDraft(poll());
    if (!built.ok) throw new Error('expected a valid poll');
    expect(built.draft.kind).toBe('poll');
    expect(built.draft.payload).toEqual({
      question: 'Lunch?',
      options: ['Biryani', 'Thali'],
      multiple: false,
      voters: {}
    });
  });

  it('trims the options it stores', () => {
    const built = pollDraft(poll({ options: ['  Biryani ', ' Thali  '] }));
    if (!built.ok) throw new Error('expected a valid poll');
    expect(built.draft.payload['options']).toEqual(['Biryani', 'Thali']);
  });

  it('refuses a question that is only space', () => {
    const built = pollDraft(poll({ question: '   ' }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors['question']).toBeTruthy();
  });

  it('refuses one option, because a poll with nothing to choose is a statement', () => {
    expect(pollDraft(poll({ options: ['Biryani'] })).ok).toBe(false);
  });

  it('refuses more options than the thread can render', () => {
    const many = Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, index) => `Option ${index}`);
    expect(pollDraft(poll({ options: many })).ok).toBe(false);
  });

  it('refuses an empty option without losing which one it was', () => {
    const built = pollDraft(poll({ options: ['Biryani', '   '] }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors['option:1']).toBeTruthy();
  });

  it('refuses two options that say the same thing', () => {
    const built = pollDraft(poll({ options: ['Biryani', 'biryani'] }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors['options']).toBeTruthy();
  });
});

describe('location drafts', () => {
  it('keeps the coordinates as numbers and adds a map link', () => {
    const built = locationDraft({ latitude: 17.4239, longitude: 78.4384, label: 'Gachibowli' });
    if (!built.ok) throw new Error('expected a valid location');
    expect(built.draft.kind).toBe('location');
    expect(built.draft.body).toBe('Gachibowli');
    expect(built.draft.payload['latitude']).toBe(17.4239);
    expect(String(built.draft.payload['maps_url'])).toContain('mlat=17.4239');
  });

  it('falls back to the coordinates when no label was written', () => {
    const built = locationDraft({ latitude: 0, longitude: 0, label: '' });
    if (!built.ok) throw new Error('expected a valid location');
    expect(built.draft.body).toBe('0.00000, 0.00000');
    expect(built.draft.payload['label']).toBeUndefined();
  });

  it('refuses a latitude off the globe', () => {
    const built = locationDraft({ latitude: 95, longitude: 78, label: '' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors['latitude']).toBeTruthy();
  });

  it('says a coordinate is required rather than claiming zero is invalid', () => {
    const built = locationDraft({ latitude: '', longitude: 78, label: '' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors['latitude']).toBe('Latitude is required');
  });
});

describe('contact drafts', () => {
  it('omits the fields nobody filled in', () => {
    const built = contactDraft({ name: 'Amma', phone: '', company: '' });
    if (!built.ok) throw new Error('expected a valid contact');
    expect(built.draft.kind).toBe('contact');
    expect(built.draft.payload).toEqual({ name: 'Amma' });
    expect(built.draft.body).toBe('Amma');
  });

  it('writes the number and the company into the body the search reads', () => {
    const built = contactDraft({ name: 'Amma', phone: '+91 98480 00000', company: 'Home' });
    if (!built.ok) throw new Error('expected a valid contact');
    expect(built.draft.body).toBe('Amma · +91 98480 00000 · Home');
  });

  it('refuses a card with no name', () => {
    expect(contactDraft({ name: '  ', phone: '123', company: '' }).ok).toBe(false);
  });
});

describe('event drafts', () => {
  it('stores the instants in UTC so every member reads the same one', () => {
    const built = eventDraft({
      title: 'Standup',
      startsAt: '2026-11-04T09:30',
      endsAt: '2026-11-04T09:45',
      location: 'Room 2',
      note: 'Bring the numbers'
    });
    if (!built.ok) throw new Error('expected a valid event');
    expect(built.draft.kind).toBe('event');
    expect(built.draft.body).toBe('Standup\nBring the numbers');
    const payload = built.draft.payload;
    // Local time in this runner's zone; the invariant is the fifteen minute gap.
    const gap = Date.parse(String(payload['ends_at'])) - Date.parse(String(payload['starts_at']));
    expect(gap).toBe(15 * 60 * 1000);
    expect(payload['location']).toBe('Room 2');
  });

  it('refuses an event that ends before it starts', () => {
    const built = eventDraft({
      title: 'Standup',
      startsAt: '2026-11-04T09:30',
      endsAt: '2026-11-04T09:00',
      location: '',
      note: ''
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors['endsAt']).toBeTruthy();
  });

  it('leaves the end out entirely when nobody chose one', () => {
    const built = eventDraft({
      title: 'Standup',
      startsAt: '2026-11-04T09:30',
      endsAt: '',
      location: '',
      note: ''
    });
    if (!built.ok) throw new Error('expected a valid event');
    expect(built.draft.payload['ends_at']).toBeUndefined();
  });
});

describe('media drafts', () => {
  const source = {
    fileName: 'IMG_0207.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 2_400_000,
    path: 'c/u/f.jpg',
    width: 4032,
    height: 3024,
    hd: true
  };

  it('carries the storage path and the metadata the bubble needs', () => {
    const built = mediaDraft(source);
    if (!built.ok) throw new Error('expected a valid media draft');
    expect(built.draft.kind).toBe('image');
    expect(built.draft.body).toBe('IMG_0207.jpg');
    expect(built.draft.payload['path']).toBe('c/u/f.jpg');
    expect(built.draft.payload['attachment_kind']).toBe('image');
    expect(built.draft.payload['hd']).toBe(true);
  });

  it('calls an audio file a voice message with no body', () => {
    const built = mediaDraft({
      ...source,
      fileName: 'clip.m4a',
      mimeType: 'audio/mp4',
      width: null,
      height: null,
      durationSecs: 12.34
    });
    if (!built.ok) throw new Error('expected a valid media draft');
    expect(built.draft.kind).toBe('voice');
    expect(built.draft.body).toBe('');
    expect(built.draft.payload['duration_secs']).toBe(12.34);
    expect(built.draft.payload['hd']).toBeUndefined();
  });

  it('refuses an empty file rather than storing a zero-length object', () => {
    expect(mediaDraft({ ...source, sizeBytes: 0 }).ok).toBe(false);
  });

  it('refuses anything past the bucket ceiling before the bytes move', () => {
    expect(mediaDraft({ ...source, sizeBytes: 52_428_801 }).ok).toBe(false);
  });

  it('rounds a duration to hundredths so a payload stays readable', () => {
    const built = mediaDraft({ ...source, mimeType: 'video/mp4', durationSecs: 8.999 });
    if (!built.ok) throw new Error('expected a valid media draft');
    expect(built.draft.payload['duration_secs']).toBe(9);
  });

  it('maps a mime type to the attachments table kind', () => {
    expect(attachmentKindForMime('image/png')).toBe('image');
    expect(attachmentKindForMime('video/quicktime')).toBe('video');
    expect(attachmentKindForMime('audio/webm')).toBe('audio');
    expect(attachmentKindForMime('application/pdf')).toBe('file');
    expect(messageKindForAttachment('audio')).toBe('voice');
    expect(messageKindForAttachment('file')).toBe('file');
  });

  it('reads the extension after the final dot, and says so when there is none', () => {
    expect(extensionOf('Report.PDF')).toBe('pdf');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('photo')).toBe('bin');
    expect(extensionOf('name.')).toBe('bin');
  });
});

describe('the attachment row a send still owes', () => {
  const payload = {
    path: 'c1/u1/f1.jpg',
    attachment_kind: 'image',
    name: 'a.jpg',
    mime: 'image/jpeg',
    bytes: 1200,
    width: 4,
    height: 3
  };

  it('is filed for a picture', () => {
    expect(registrationOf('image', payload)).toEqual({
      storagePath: 'c1/u1/f1.jpg',
      kind: 'image',
      fileName: 'a.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1200,
      width: 4,
      height: 3,
      durationSecs: null
    });
  });

  it('is nothing at all for a text message', () => {
    expect(registrationOf('text', { path: 'c1/u1/f1.jpg' })).toBeNull();
  });

  it('refuses a payload whose path or size is missing', () => {
    expect(registrationOf('image', { ...payload, path: '' })).toBeNull();
    expect(registrationOf('image', { ...payload, bytes: 'many' })).toBeNull();
  });

  it('uses the mime type when the payload forgot the attachment kind', () => {
    const rest: Record<string, unknown> = { ...payload };
    delete rest.attachment_kind;
    const registration = registrationOf('voice', { ...rest, mime: 'audio/webm' });
    expect(registration?.kind).toBe('audio');
  });
});

describe('the poll tally', () => {
  it('counts from the voter map, not from anything stored', () => {
    const view = pollView({
      question: 'Lunch?',
      options: ['Biryani', 'Thali'],
      voters: { u1: 0, u2: 0, u3: 1 }
    });
    expect(view.total).toBe(3);
    expect(view.options.map((option) => option.votes)).toEqual([2, 1]);
    expect(view.options.map((option) => option.share)).toEqual([67, 33]);
  });

  it('ignores a vote for a choice the poll does not offer', () => {
    // A payload edited by hand, or an option list a later edit shortened.
    const view = pollView({ options: ['A', 'B'], voters: { u1: 7 } });
    expect(view.total).toBe(0);
  });

  it('treats a junk voters map as nobody having voted', () => {
    expect(votersOf({ voters: [1, 2] })).toEqual({});
    expect(votersOf({ voters: { u1: 'zero' } })).toEqual({});
    expect(pollView({ options: ['A'], voters: 'nope' }).total).toBe(0);
  });

  it('reports the viewer own choice, and nothing when they have not voted', () => {
    const view = pollView({ options: ['A', 'B'], voters: { u1: 1 } });
    expect(choiceOf(view, 'u1')).toBe(1);
    expect(choiceOf(view, 'u9')).toBeNull();
  });

  it('closes the poll on exactly the values vote_in_poll() closes it on', () => {
    // The function compares the text of the key, so a boolean and the string
    // both arrive as 'true'; anything else is an open poll.
    expect(pollView({ options: ['A'], closed: true }).closed).toBe(true);
    expect(pollView({ options: ['A'], closed: 'true' }).closed).toBe(true);
    expect(pollView({ options: ['A'], closed: false }).closed).toBe(false);
    expect(pollView({ options: ['A'], closed: 'false' }).closed).toBe(false);
    expect(pollView({ options: ['A'] }).closed).toBe(false);
  });

  it('moves only the voters own entry when a tap is painted early', () => {
    const payload = { options: ['A', 'B'], voters: { u1: 0, u2: 1 } };
    expect(withLocalVote(payload, 'u9', 1)).toEqual({
      options: ['A', 'B'],
      voters: { u1: 0, u2: 1, u9: 1 }
    });
    // Changing one's mind replaces the choice instead of adding a second vote.
    expect(withLocalVote(payload, 'u1', 1)).toEqual({
      options: ['A', 'B'],
      voters: { u1: 1, u2: 1 }
    });
    // A choice the poll does not offer leaves the payload exactly as it was.
    expect(withLocalVote(payload, 'u1', 5)).toBe(payload);
  });

  it('keeps HD out of the resize path', () => {
    expect(targetEdge(true)).toBe(0);
    expect(targetEdge(false)).toBe(STANDARD_EDGE);
  });
});
