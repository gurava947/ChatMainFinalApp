/** @jest-environment jsdom */

'use strict';

const { join, loadClient, tick } = require('../helpers/client-env');

const SELF_ROOM = 'self-00000000-0000-4000-8000-000000000001';
const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
const byId = (id) => document.getElementById(id);
const activity = () => text(byId('message-list'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeTracks() {
  const stopped = [];
  return {
    stopped,
    stream: { getTracks: () => [{ stop: () => stopped.push('track') }], getAudioTracks: () => [] }
  };
}

function installCamera(api, blobBytes = 64) {
  const tracks = fakeTracks();
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: jest.fn(() => Promise.resolve(tracks.stream)) }
  });
  window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage: jest.fn(),
    clearRect: jest.fn(),
    fillRect: jest.fn(),
    fillStyle: ''
  });
  window.HTMLCanvasElement.prototype.toBlob = (cb, type) => {
    cb(new Blob([new Uint8Array(blobBytes)], { type: type || 'image/jpeg' }));
  };
  window.createImageBitmap = jest.fn(() => Promise.resolve({ width: 2000, height: 3000, close: jest.fn() }));
  return tracks;
}

function imageFile(name = 'photo.png', bytes = 5000) {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

describe('attachment sheet', () => {
  let api;

  beforeEach(async () => {
    api = loadClient();
    await join(api);
  });

  it('opens from the plus button and offers exactly the six shares', () => {
    byId('attach-button').click();

    const actions = Array.from(document.querySelectorAll('#sheet-grid .sheet__tile')).map((t) => t.dataset.action);
    expect(actions).toEqual(['camera', 'document', 'poll', 'location', 'contact', 'event']);
    expect(byId('attach-sheet').hidden).toBe(false);
    expect(text(byId('sheet-grid'))).not.toMatch(/gallery|photo library|images/i);
  });

  it('closes the sheet before opening the chosen share', async () => {
    byId('attach-button').click();
    document.querySelector('#sheet-grid [data-action="poll"]').click();

    expect(byId('attach-sheet').hidden).toBe(true);
    expect(byId('modal').hidden).toBe(false);
    expect(text(byId('modal-title'))).toBe('New poll');
    expect(document.querySelector('#modal-body [data-role="question"]')).not.toBeNull();
  });

  it('asks for a room before letting any share through', async () => {
    api.G().state.session = null;
    byId('attach-button').click();

    expect(byId('attach-sheet').hidden).toBe(true);
    expect(activity()).toContain('join a room first');
  });
});

describe('poll dialog', () => {
  let api;

  beforeEach(async () => {
    api = loadClient();
    await join(api);
    byId('attach-button').click();
    document.querySelector('#sheet-grid [data-action="poll"]').click();
    await tick();
  });

  const form = () => document.querySelector('#modal-body form');

  function typeOption(index, value) {
    const inputs = form().querySelectorAll('[data-role="options"] input');
    inputs[index].value = value;
  }

  function send() {
    Array.from(byId('modal-foot').querySelectorAll('button'))
      .find((b) => b.textContent === 'Send poll')
      .click();
  }

  it('refuses a question with nothing to choose', () => {
    typeOption(0, 'Red');
    typeOption(1, 'Blue');
    send();

    expect(text(form().querySelector('[data-role="error"]'))).toBe('Ask something first.');
    expect(api.socket.last('message')).toBeUndefined();
  });

  it('refuses a single option', () => {
    form().querySelector('[data-role="question"]').value = 'Colour?';
    typeOption(0, 'Red');
    send();

    expect(text(form().querySelector('[data-role="error"]'))).toBe('At least two options are needed.');
  });

  it('refuses two options that say the same thing', () => {
    form().querySelector('[data-role="question"]').value = 'Colour?';
    typeOption(0, 'Red');
    typeOption(1, ' red ');
    send();

    expect(text(form().querySelector('[data-role="error"]'))).toBe('Two options say the same thing.');
  });

  it('sends the poll as structured content, not markup', () => {
    form().querySelector('[data-role="question"]').value = 'Launch day?';
    typeOption(0, 'Tuesday');
    typeOption(1, 'Friday');
    form().querySelector('[data-role="multiple"]').checked = true;
    send();

    const payload = api.socket.last('message').payload;
    expect(payload.content).toEqual({
      type: 'poll',
      question: 'Launch day?',
      options: ['Tuesday', 'Friday'],
      multiple: true
    });
    expect(payload.text).toBe('');
    expect(byId('modal').hidden).toBe(true);
  });

  it('grows to a third option and caps at the limit', () => {
    const list = form().querySelector('[data-role="options"]');
    const add = form().querySelector('[data-role="add-option"]');
    expect(list.children).toHaveLength(2);

    for (let i = 0; i < 12; i += 1) add.click();

    expect(list.children).toHaveLength(12);
    expect(text(form().querySelector('[data-role="error"]'))).toContain('at most 12');
  });

  it('will not remove the last two options', () => {
    const list = form().querySelector('[data-role="options"]');
    list.children[1].querySelector('.form__remove').click();
    expect(list.children).toHaveLength(2);
  });
});

describe('HD media toggle', () => {
  let api;

  beforeEach(async () => {
    api = loadClient();
    await join(api);
    installCamera(api);
  });

  it('resizes and re-encodes a photo while HD is off', async () => {
    api.uploads.respond({ media: [{ id: '00000000-0000-4000-8000-000000000009', kind: 'image', name: 'photo.png', mime: 'image/png', size: 64 }] });

    await api.G().pickFiles([imageFile()]);
    await tick(3);

    expect(window.createImageBitmap).toHaveBeenCalled();
    const sent = api.uploads.state.sent[0];
    const file = sent.getAll('files')[0];
    expect(file.name).toBe('photo-standard.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(file.size).toBe(64);
  });

  it('sends the original bytes once HD is on', async () => {
    document.querySelector('#app-menu [data-action="hd"]').click();
    expect(window.localStorage.getItem('chat:hd')).toBe('on');
    expect(text(document.querySelector('#app-menu [data-role="hd-state"]'))).toBe('on');

    await api.G().pickFiles([imageFile()]);
    await tick(3);

    expect(window.createImageBitmap).not.toHaveBeenCalled();
    expect(api.uploads.state.sent[0].getAll('files')[0].name).toBe('photo.png');
  });

  it('keeps a photo that does not shrink on re-encode', async () => {
    installCamera(api, 50000);
    await api.G().pickFiles([imageFile('big.png', 500)]);
    await tick(3);

    expect(api.uploads.state.sent[0].getAll('files')[0].name).toBe('big.png');
  });

  it('leaves documents and video exactly as picked', async () => {
    const doc = new File([new Uint8Array(2000)], 'spec.pdf', { type: 'application/pdf' });
    await api.G().pickFiles([doc]);
    await tick(3);

    expect(window.createImageBitmap).not.toHaveBeenCalled();
    expect(api.uploads.state.sent[0].getAll('files')[0].name).toBe('spec.pdf');
  });
});

describe('camera', () => {
  let api;
  let tracks;

  beforeEach(async () => {
    api = loadClient();
    await join(api);
    tracks = installCamera(api);
  });

  it('opens straight from the button beside the input', async () => {
    byId('camera-button').click();
    await tick(2);

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'environment' },
      audio: false
    });
    expect(byId('camera').hidden).toBe(false);
  });

  it('explains a declined permission instead of failing silently', async () => {
    navigator.mediaDevices.getUserMedia = jest.fn(() => {
      const err = new Error('denied');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    });

    byId('camera-button').click();
    await tick(2);

    expect(byId('camera').hidden).toBe(true);
    expect(activity()).toContain('camera permission was declined');
  });

  it('waits for the view to be ready before it claims to take a photo', async () => {
    byId('camera-button').click();
    await tick(2);
    document.querySelector('#camera [data-role="camera-shutter"]').click();

    expect(activity()).toContain('the camera is still starting up');
    expect(api.uploads.state.sent).toHaveLength(0);
  });

  it('captures, closes the preview and hands the shot to the uploader', async () => {
    api.uploads.respond({ media: [{ id: '00000000-0000-4000-8000-00000000000a', kind: 'image', name: 'shot.jpg', mime: 'image/jpeg', size: 64 }] });
    byId('camera-button').click();
    await tick(2);

    const video = document.querySelector('#camera [data-role="camera-view"]');
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
    document.querySelector('#camera [data-role="camera-shutter"]').click();
    await tick(6);

    expect(byId('camera').hidden).toBe(true);
    expect(tracks.stopped).toEqual(['track']);
    expect(api.uploads.state.sent).toHaveLength(1);
    expect(api.uploads.state.sent[0].getAll('files')[0].type).toBe('image/jpeg');
  });

  it('flips to the other lens and releases the first stream', async () => {
    byId('camera-button').click();
    await tick(2);
    document.querySelector('#camera [data-role="camera-flip"]').click();
    await tick(2);

    expect(navigator.mediaDevices.getUserMedia.mock.calls.map((call) => call[0].video.facingMode))
      .toEqual(['environment', 'user']);
    expect(tracks.stopped).toEqual(['track']);
  });

  it('cancels without producing anything', async () => {
    byId('camera-button').click();
    await tick(2);
    document.querySelector('#camera [data-role="camera-cancel"]').click();

    expect(byId('camera').hidden).toBe(true);
    expect(api.uploads.state.sent).toHaveLength(0);
  });
});

describe('voice notes', () => {
  let api;
  let started;
  let RecorderStub;

  class FakeMediaRecorder {
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = (options && options.mimeType) || '';
      this.state = 'inactive';
      this.handlers = {};
      RecorderStub.last = this;
    }

    addEventListener(name, handler) {
      (this.handlers[name] = this.handlers[name] || []).push(handler);
    }

    emit(name, payload) {
      (this.handlers[name] || []).forEach((fn) => fn(payload));
    }

    start() {
      this.state = 'recording';
      started.push(this.mimeType);
    }

    stop() {
      this.state = 'inactive';
      this.emit('dataavailable', { data: new Blob([new Uint8Array(900)], { type: 'audio/webm' }) });
      this.emit('stop');
    }
  }

  beforeEach(async () => {
    api = loadClient();
    await join(api);
    started = [];
    const tracks = fakeTracks();
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: jest.fn(() => Promise.resolve(tracks.stream)) }
    });
    FakeMediaRecorder.isTypeSupported = (mime) => mime === 'audio/webm;codecs=opus';
    window.MediaRecorder = FakeMediaRecorder;
    RecorderStub = FakeMediaRecorder;
  });

  afterEach(() => {
    delete window.MediaRecorder;
  });

  it('records, uploads and sends one voice message with its waveform', async () => {
    api.uploads.respond({
      media: [{ id: '00000000-0000-4000-8000-00000000000b', kind: 'audio', name: 'voice.webm', mime: 'audio/webm', size: 900 }]
    });

    byId('voice-button').click();
    await tick(3);
    expect(byId('recorder').hidden).toBe(false);
    expect(byId('voice-button').getAttribute('aria-pressed')).toBe('true');
    expect(started).toEqual(['audio/webm;codecs=opus']);

    await wait(450);
    byId('recorder-send').click();
    await tick(6);

    expect(byId('recorder').hidden).toBe(true);
    expect(byId('voice-button').getAttribute('aria-pressed')).toBe('false');

    const payload = api.socket.last('message').payload;
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].kind).toBe('audio');
    expect(payload.content.type).toBe('voice');
    expect(payload.content.durationMs).toBeGreaterThanOrEqual(400);
    expect(payload.content.peaks.length).toBeLessThanOrEqual(48);
  });

  it('throws the take away when the user cancels', async () => {
    byId('voice-button').click();
    await tick(3);
    await wait(450);
    byId('recorder-cancel').click();
    await tick(4);

    expect(api.socket.last('message')).toBeUndefined();
    expect(api.uploads.state.sent).toHaveLength(0);
    expect(activity()).toContain('recording discarded');
  });

  it('refuses a tap that produced no longer than a click', async () => {
    byId('voice-button').click();
    await tick(3);
    byId('recorder-send').click();
    await tick(4);

    expect(activity()).toContain('that was too short to send');
    expect(api.socket.last('message')).toBeUndefined();
  });

  it('says so when the browser cannot record at all', async () => {
    delete window.MediaRecorder;
    window.MediaRecorder = undefined;

    byId('voice-button').click();
    await tick(2);

    expect(activity()).toContain('this browser cannot record audio');
    expect(byId('recorder').hidden).toBe(true);
  });
});

describe('message yourself and the personal note', () => {
  let api;

  beforeEach(async () => {
    api = loadClient();
    api.route('GET', '/api/me/self', { room: SELF_ROOM, displayName: 'Arjun' });
    await join(api);
  });

  it('opens the menu from the three dots and closes it on the outside', () => {
    byId('menu-toggle').click();
    expect(byId('app-menu').hidden).toBe(false);
    expect(byId('menu-toggle').getAttribute('aria-expanded')).toBe('true');

    document.body.click();
    expect(byId('app-menu').hidden).toBe(true);
  });

  it('joins the private room and remembers where the user came from', async () => {
    byId('menu-toggle').click();
    document.querySelector('#app-menu [data-action="self"]').click();
    await tick(3);

    api.socket.answer('room:join', { ok: true, room: SELF_ROOM });
    await tick(3);

    expect(api.G().room()).toBe(SELF_ROOM);
    // the raw self-room id is meaningless to read, so the header shows a label
    expect(byId('room-title').textContent).toBe('Note to self');
    expect(byId('message-input').placeholder).toBe('Message yourself');
    expect(document.querySelector('[data-role="room-avatar"]').textContent).toBe('ME');
    expect(window.localStorage.getItem('chat:room')).toBe(SELF_ROOM);

    byId('back-button').click();
    await tick(2);
    api.socket.answer('room:join', { ok: true, room: 'general' });
    await tick(2);

    expect(api.G().room()).toBe('general');
  });

  it('refuses to stack a second self chat on top of the first', async () => {
    byId('menu-toggle').click();
    document.querySelector('#app-menu [data-action="self"]').click();
    await tick(3);
    api.socket.answer('room:join', { ok: true, room: SELF_ROOM });
    await tick(3);

    document.querySelector('#app-menu [data-action="self"]').click();
    await tick(2);

    expect(activity()).toContain('you are already in your own chat');
  });

  it('replays the outbox of the room the user came back to', async () => {
    api.G().flushOutbox();
    const queued = api.G().deliver({ text: 'held while offline' });
    expect(api.G().queueCount()).toBe(1);

    byId('menu-toggle').click();
    document.querySelector('#app-menu [data-action="self"]').click();
    await tick(3);
    api.socket.answer('room:join', { ok: true, room: SELF_ROOM });
    await tick(3);

    expect(api.G().queueCount()).toBe(1);

    byId('back-button').click();
    await tick(2);
    api.socket.answer('room:join', { ok: true, room: 'general' });
    await tick(2);

    expect(api.socket.emitted.filter((e) => e.event === 'message').pop().payload.clientId).toBe(queued);
  });

  it('loads, saves and clears the personal note', async () => {
    const updatedAt = Date.now();
    api.route('GET', '/api/me/note', { note: { text: 'Buy filter coffee', updatedAt } });
    api.route('PUT', '/api/me/note', { note: { text: '', updatedAt: Date.now() } });

    byId('menu-toggle').click();
    document.querySelector('#app-menu [data-action="note"]').click();
    await tick(3);

    const field = document.querySelector('#modal-body [data-role="note-text"]');
    expect(field.value).toBe('Buy filter coffee');
    expect(field.maxLength).toBe(500);
    expect(text(document.querySelector('#modal-body [data-role="note-meta"]'))).toContain('Last saved');

    field.value = '  ';
    Array.from(byId('modal-foot').querySelectorAll('button')).find((b) => b.textContent === 'Save').click();
    await tick(3);

    expect(api.bodyOf('PUT', '/api/me/note')).toEqual({ text: '' });
    expect(byId('modal').hidden).toBe(true);
  });

  it('reports a note the server refused instead of pretending it saved', async () => {
    api.route('GET', '/api/me/note', { note: { text: '', updatedAt: null } });
    api.route('PUT', '/api/me/note', () => Promise.resolve({ ok: false, status: 413, json: () => Promise.resolve({ error: 'note is too long' }) }));

    byId('menu-toggle').click();
    document.querySelector('#app-menu [data-action="note"]').click();
    await tick(3);

    expect(text(document.querySelector('#modal-body [data-role="note-meta"]'))).toBe('Nothing saved yet.');

    document.querySelector('#modal-body [data-role="note-text"]').value = 'far too long';
    Array.from(byId('modal-foot').querySelectorAll('button')).find((b) => b.textContent === 'Save').click();
    await tick(3);

    expect(byId('modal').hidden).toBe(false);
    expect(text(document.querySelector('#modal-body [data-role="error"]'))).toBe('note is too long');
  });
});

describe('media library', () => {
  const item = (over) => ({
    id: '00000000-0000-4000-8000-00000000000c',
    kind: 'image',
    name: 'board.png',
    mime: 'image/png',
    size: 2048,
    sender: 'Nia',
    senderId: 'user-2',
    ts: Date.now(),
    ...over
  });

  let api;

  beforeEach(async () => {
    api = loadClient();
    api.route('GET', '/api/rooms/general/media', {
      items: [
        item({ name: 'board.png', kind: 'image' }),
        item({ name: 'demo.mp4', kind: 'video', sender: 'Kumar' }),
        item({ name: 'spec.pdf', kind: 'document' })
      ]
    });
    await join(api);
  });

  async function open() {
    byId('menu-toggle').click();
    document.querySelector('#app-menu [data-action="library"]').click();
    await wait(500);
    await tick(2);
  }

  it('lists everything under Recents', async () => {
    await open();

    expect(byId('library-panel').hidden).toBe(false);
    expect(document.querySelectorAll('#library-list .library__item')).toHaveLength(3);
    expect(text(byId('library-list'))).toContain('spec.pdf');
    expect(text(byId('library-list'))).toContain('Nia · 2.0 KB');
  });

  it('filters to images and video under Media', async () => {
    await open();
    document.querySelector('.library__tab[data-tab="media"]').click();

    expect(document.querySelectorAll('#library-list .library__item')).toHaveLength(2);
    expect(text(byId('library-list'))).not.toContain('spec.pdf');
  });

  it('groups by sender under Folders', async () => {
    await open();
    document.querySelector('.library__tab[data-tab="folders"]').click();

    const groups = document.querySelectorAll('#library-list .library__group');
    expect(groups).toHaveLength(2);
    expect(text(groups[0])).toContain('Nia · 2 items');
    expect(text(groups[1])).toContain('Kumar · 1 item');
  });

  it('says when nothing has been shared yet', async () => {
    api.route('GET', '/api/rooms/general/media', { items: [] });
    await open();

    expect(byId('library-empty').hidden).toBe(false);
    expect(byId('library-list').children).toHaveLength(0);
  });

  it('opens an image in the lightbox', async () => {
    await open();
    document.querySelector('#library-list .library__item').click();

    expect(byId('lightbox').hidden).toBe(false);
    expect(byId('lightbox-stage').querySelector('img').src).toContain('/media/');
    expect(text(byId('lightbox-caption'))).toContain('board.png');
  });

  it('refreshes when the room shares something new', async () => {
    await open();
    expect(document.querySelectorAll('#library-list .library__item')).toHaveLength(3);

    api.socket.fire('new_message', { id: 'm-1', room: 'general', userId: 'user-2', displayName: 'Nia', text: 'here', ts: Date.now() });
    await wait(500);
    await tick(2);

    expect(document.querySelectorAll('#library-list .library__item')).toHaveLength(3);
    expect(api.callsFor('GET', '/api/rooms/general/media').length).toBe(2);
  });

  it('closes from its own button and with the back arrow', async () => {
    await open();
    byId('library-close').click();
    expect(byId('library-panel').hidden).toBe(true);

    await open();
    byId('back-button').click();
    expect(byId('library-panel').hidden).toBe(true);
  });
});
