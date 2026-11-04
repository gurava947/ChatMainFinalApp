/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadMediaPrepare } = require('../helpers/load-client-module');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');

let prepare;

beforeEach(() => {
  prepare = loadMediaPrepare();
  localStorage.clear();
});

const file = (name, type, size = 1024) => ({ name, type, size, lastModified: 1700000000000 });

describe('HD preference', () => {
  test('HD is off until this device says otherwise', () => {
    expect(prepare.readHdPreference()).toBe(false);
    expect(prepare.saveHdPreference(true)).toBe(true);
    expect(prepare.readHdPreference()).toBe(true);
    expect(prepare.saveHdPreference(false)).toBe(false);
    expect(prepare.readHdPreference()).toBe(false);
  });

  test('a device with no usable storage still gets the default', () => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('storage is blocked'); };
    expect(prepare.readHdPreference()).toBe(false);
    Storage.prototype.setItem = () => { throw new Error('storage is blocked'); };
    expect(prepare.saveHdPreference(true)).toBe(true);
    Storage.prototype.getItem = getItem;
  });
});

describe('which files get shrunk', () => {
  test('a normal photo is planned for a smaller JPEG', () => {
    expect(prepare.planImageFor(file('IMG_0042.HEIC', 'image/heic'))).toEqual({
      mime: 'image/jpeg', quality: 0.82, maxEdge: 1600,
    });
  });

  test('HD on means the bytes travel exactly as the camera made them', () => {
    expect(prepare.planImageFor(file('a.png', 'image/png'), { hd: true })).toBeNull();
  });

  test('animations and vector art are never re-encoded', () => {
    expect(prepare.planImageFor(file('cat.gif', 'image/gif'))).toBeNull();
    expect(prepare.planImageFor(file('logo.svg', 'image/svg+xml'))).toBeNull();
  });

  test('documents, video, and audio keep their own pipeline', () => {
    expect(prepare.planImageFor(file('notes.pdf', 'application/pdf'))).toBeNull();
    expect(prepare.planImageFor(file('clip.mp4', 'video/mp4'))).toBeNull();
    expect(prepare.planImageFor(file('voice-1.webm', 'audio/webm'))).toBeNull();
    expect(prepare.planImageFor(file('no-type', ''))).toBeNull();
    expect(prepare.planImageFor(undefined)).toBeNull();
  });

  test('a charset on the mime does not confuse the check', () => {
    expect(prepare.planImageFor(file('a.jpg', 'image/jpeg;charset=utf-8'))).not.toBeNull();
  });
});

describe('scaling maths', () => {
  test('a portrait camera shot becomes 1600 on its long edge', () => {
    expect(prepare.scaledSize(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  test('a picture already inside the limit is untouched', () => {
    expect(prepare.scaledSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  test('sides stay even and never collapse to zero', () => {
    const tiny = prepare.scaledSize(1, 3000, 1600);
    expect(tiny.width).toBeGreaterThanOrEqual(1);
    expect(tiny.height % 2).toBe(0);
  });

  test('unreadable dimensions do not invent a canvas', () => {
    expect(prepare.scaledSize(0, 0, 1600)).toEqual({ width: 0, height: 0 });
    expect(prepare.scaledSize(undefined, undefined, 1600)).toEqual({ width: 0, height: 0 });
  });
});

describe('preparing one file', () => {
  test('a non-image is handed straight back', async () => {
    const pdf = file('notes.pdf', 'application/pdf');
    await expect(prepare.prepareFile(pdf)).resolves.toBe(pdf);
  });

  test('HD on hands the original back without touching the decoder', async () => {
    const photo = file('a.jpg', 'image/jpeg');
    await expect(prepare.prepareFile(photo, { hd: true })).resolves.toBe(photo);
  });

  test('a browser without createImageBitmap sends the original photo', async () => {
    const photo = file('big.jpg', 'image/jpeg', 5 * 1024 * 1024);
    expect(globalThis.createImageBitmap).toBeUndefined();
    await expect(prepare.prepareFile(photo)).resolves.toBe(photo);
  });

  test('prepareFiles keeps the order and the count of the selection', async () => {
    const files = [file('a.pdf', 'application/pdf'), file('b.jpg', 'image/jpeg'), file('c.txt', 'text/plain')];
    await expect(prepare.prepareFiles(files)).resolves.toEqual(files);
    await expect(prepare.prepareFiles([])).resolves.toEqual([]);
    await expect(prepare.prepareFiles(undefined)).resolves.toEqual([]);
  });

  test('a NodeList-style selection is accepted, not only an array', async () => {
    const single = file('a.pdf', 'application/pdf');
    const list = { length: 1, 0: single, [Symbol.iterator]: Array.prototype[Symbol.iterator] };
    await expect(prepare.prepareFiles(list)).resolves.toEqual([single]);
  });
});

describe('the upload path uses it', () => {
  test('picked files run through the optimiser with this device setting', () => {
    expect(APP_SOURCE).toMatch(/import \{ prepareFiles, readHdPreference, saveHdPreference \} from '\.\/mediaPrepare'/);
    expect(APP_SOURCE).toMatch(/await prepareFiles\(files, \{ hd: readHdPreference\(\) \}\)/);
    expect(APP_SOURCE).toMatch(/await uploadFiles\(prepared\)/);
  });

  test('the sender is told what the shrink saved', () => {
    expect(APP_SOURCE).toMatch(/const saved = prepared\.reduce\(/);
    expect(APP_SOURCE).toMatch(/showNotice\(`Sent \$\{Math\.round\(saved \/ 1024\)\} KB lighter/);
  });

  test('chat settings exposes the HD switch and it writes the device preference', () => {
    expect(APP_SOURCE).toMatch(/const \[hd, setHd\] = useState\(readHdPreference\)/);
    expect(APP_SOURCE).toMatch(/type="checkbox" role="switch" className="settings-switch" checked=\{hd\}/);
    expect(APP_SOURCE).toMatch(/setHd\(saveHdPreference\(event\.target\.checked\)\)/);
  });

  test('the voice note and its waveform skip the picture pipeline', () => {
    expect(APP_SOURCE).toMatch(/await uploadFiles\(\[file\]\)/);
    expect(APP_SOURCE).toMatch(/extractWaveform\(audioBlob\)/);
  });
});
