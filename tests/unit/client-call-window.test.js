/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadCallWindow } = require('../helpers/load-client-module');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');
const CALL_HOOK_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'useRoomCalls.js'), 'utf8');

let win;
const viewport = { width: 1000, height: 800 };

beforeEach(() => {
  win = loadCallWindow();
  localStorage.clear();
});

describe('window modes', () => {
  test('a guest who never touched the controls gets the docked call', () => {
    expect(win.readWindowMode()).toBe('docked');
    expect(win.WINDOW_MODES).toEqual(['docked', 'floating', 'minimized']);
  });

  test('the last shape the guest chose is the next call shape', () => {
    expect(win.saveWindowMode('floating')).toBe('floating');
    expect(win.readWindowMode()).toBe('floating');
  });

  test('a made-up mode from a stale key cannot crash the call', () => {
    localStorage.setItem('inchat:call-window', '{"mode":"fullscreen"}');
    expect(win.readWindowMode()).toBe('docked');
    localStorage.setItem('inchat:call-window', 'not json at all');
    expect(win.readWindowMode()).toBe('docked');
  });

  test('the frame survives a reload but a absurd size does not', () => {
    win.saveWindowFrame({ width: 420, height: 320, left: 40, top: 60 });
    expect(win.readWindowFrame()).toEqual({ width: 420, height: 320, left: 40, top: 60 });
    localStorage.setItem('inchat:call-window', '{"width":99999,"height":-4,"left":"far"}');
    const repaired = win.readWindowFrame();
    expect(repaired.width).toBe(900);
    expect(repaired.height).toBe(200);
    expect(repaired.left).toBeUndefined();
  });
});

describe('geometry', () => {
  test('a docked call is centred and sized to the screen', () => {
    const frame = win.defaultFrame('docked', viewport);
    expect(frame.left + frame.width / 2).toBeCloseTo(500, 0);
    expect(frame.top + frame.height / 2).toBeCloseTo(400, 0);
    expect(frame.width).toBeGreaterThanOrEqual(300);
    expect(frame.height).toBeLessThanOrEqual(680);
  });

  test('a floating call parks at the top-right so the composer stays reachable', () => {
    const frame = win.defaultFrame('floating', viewport);
    expect(frame.left + frame.width).toBeCloseTo(viewport.width - 16, 0);
    expect(frame.top).toBe(96);
  });

  test('a minimised call is a bar above the bottom edge', () => {
    const frame = win.defaultFrame('minimized', viewport);
    expect(frame.height).toBeLessThan(80);
    expect(frame.top + frame.height).toBeCloseTo(viewport.height - 24, 0);
  });

  test('a small screen shrinks the docked call instead of overflowing it', () => {
    const frame = win.defaultFrame('docked', { width: 320, height: 480 });
    expect(frame.width).toBeLessThanOrEqual(320 - 16);
    expect(frame.height).toBeLessThanOrEqual(480 - 16);
  });

  test('dragging cannot push the window off screen', () => {
    const start = { width: 300, height: 200, left: 100, top: 100 };
    expect(win.movedFrame(start, { x: -5000, y: -5000 }, viewport)).toEqual(
      expect.objectContaining({ left: 8, top: 8 }),
    );
    const dragged = win.movedFrame(start, { x: 900, y: 900 }, viewport);
    expect(dragged.left + dragged.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(dragged.top + dragged.height).toBeLessThanOrEqual(viewport.height - 8);
  });

  test('resizing keeps a usable window and never a negative one', () => {
    const start = { width: 400, height: 300, left: 10, top: 10 };
    expect(win.resizedFrame(start, { x: -3000, y: -3000 }, viewport).width).toBe(260);
    expect(win.resizedFrame(start, { x: -3000, y: -3000 }, viewport).height).toBe(200);
    expect(win.resizedFrame(start, { x: 5000, y: 5000 }, viewport).width).toBeLessThanOrEqual(1000 - 16);
  });

  test('a window bigger than the screen is pulled back inside it', () => {
    const clamped = win.clampToViewport({ width: 4000, height: 4000, left: -900, top: -900 }, viewport);
    expect(clamped.left).toBe(8);
    expect(clamped.top).toBe(8);
    expect(clamped.width).toBeLessThanOrEqual(viewport.width);
  });

  test('only the free-floating shapes are positioned by hand', () => {
    const frame = { width: 300, height: 200, left: 42, top: 24 };
    expect(win.frameStyle(frame, 'docked')).toBeUndefined();
    expect(win.frameStyle(frame, 'floating')).toEqual({ left: '42px', top: '24px', width: '300px', height: '200px' });
  });
});

describe('call timer', () => {
  test('seconds roll up and an hour passes into mm:ss with hours', () => {
    const startedAt = 1_000_000;
    expect(win.callDuration(startedAt, startedAt + 5000)).toBe('0:05');
    expect(win.callDuration(startedAt, startedAt + 125_000)).toBe('2:05');
    expect(win.callDuration(startedAt, startedAt + 3_725_000)).toBe('1:02:05');
  });

  test('a call that never connected shows no duration', () => {
    expect(win.callDuration(null)).toBe('0:00');
    expect(win.callDuration(undefined, 10)).toBe('0:00');
    expect(win.callDuration(5000, 1000)).toBe('0:00');
  });
});

describe('pointer input', () => {
  test('a mouse and a touch report the same point', () => {
    expect(win.pointerPoint({ clientX: 120, clientY: 60, pointerId: 3 })).toEqual({ x: 120, y: 60 });
    expect(win.pointerPoint({ touches: [{ clientX: 30, clientY: 44 }] })).toEqual({ x: 30, y: 44 });
    expect(win.pointerPoint({})).toEqual({ x: 0, y: 0 });
  });

  test('the delta is measured from where the grab started, not from zero', () => {
    expect(win.dragDelta({ x: 100, y: 100 }, { x: 132, y: 88 })).toEqual({ x: 32, y: -12 });
  });

  test('the viewport is read from the live window', () => {
    Object.defineProperty(window, 'innerWidth', { value: 640, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 480, configurable: true });
    expect(win.viewportSize()).toEqual({ width: 640, height: 480 });
  });
});

describe('the call window component', () => {
  test('every shape the prompt asks for is reachable from the window itself', () => {
    expect(APP_SOURCE).toMatch(/Float the call window/);
    expect(APP_SOURCE).toMatch(/aria-label="Minimise the call"/);
    expect(APP_SOURCE).toMatch(/aria-label=\{fullscreen \? 'Exit fullscreen' : 'Fullscreen'\}/);
    expect(APP_SOURCE).toMatch(/aria-label="Resize the call window"/);
  });

  test('the window is docked by default and floats or minimises from state', () => {
    expect(APP_SOURCE).toMatch(/const \[mode, setMode\] = useState\(readWindowMode\)/);
    expect(APP_SOURCE).toMatch(/changeMode\('minimized'\)/);
    expect(APP_SOURCE).toMatch(/saveWindowMode\(next\)/);
  });

  test('fullscreen uses the browser API and follows the user pressing Esc', () => {
    expect(APP_SOURCE).toMatch(/requestFullscreen\?\.\(\)/);
    expect(APP_SOURCE).toMatch(/document\.exitFullscreen\?\.\(\)/);
    expect(APP_SOURCE).toMatch(/addEventListener\('fullscreenchange'/);
  });

  test('drag and resize share one gesture handler that clamps to the screen', () => {
    expect(APP_SOURCE).toMatch(/startGesture\(kind, event\)/);
    expect(APP_SOURCE).toMatch(/movedFrame\(current, delta, viewportSize\(\)\)/);
    expect(APP_SOURCE).toMatch(/resizedFrame\(current, delta, viewportSize\(\)\)/);
    expect(APP_SOURCE).toMatch(/saveWindowFrame\(frame\)/);
  });

  test('a gesture on a docked call pops it out instead of leaving it stuck', () => {
    expect(APP_SOURCE).toMatch(/getBoundingClientRect\(\)/);
    expect(APP_SOURCE).toMatch(/setMode\(saveWindowMode\('floating'\)\)/);
  });

  test('remounting the media re-binds the live streams so the call keeps running', () => {
    expect(APP_SOURCE).toMatch(/useEffect\(\(\) => \{ calls\.reattachMedia\(\) \}, \[mode, fullscreen\]\)/);
    expect(APP_SOURCE).toMatch(/windowNode\.is-minimized|className=\{shellClass\}/);
  });

  test('a minimised call still hears the other guest', () => {
    const minimized = APP_SOURCE.slice(APP_SOURCE.indexOf("if (mode === 'minimized')"), APP_SOURCE.indexOf('const windowNode'));
    expect(minimized).toMatch(/<audio ref=\{calls\.remoteAudioRef\} autoPlay \/>/);
    expect(minimized).toMatch(/callDuration\(activeAtRef\.current\)/);
  });

  test('the chat behind a floating call stays interactive', () => {
    expect(APP_SOURCE).toMatch(/mode === 'docked' && !fullscreen\s*\?\s*<div className="call-overlay"/);
  });

  test('the timer starts when the call actually connects, not when it is dialled', () => {
    expect(APP_SOURCE).toMatch(/calls\.call\?\.status !== 'active'/);
    expect(APP_SOURCE).toMatch(/activeAtRef\.current \|\|= Date\.now\(\)/);
    expect(APP_SOURCE).toMatch(/calls\.call\?\.status === 'reconnecting'\) return undefined/);
  });
});

describe('WebRTC media and signaling recovery', () => {
  test('remote tracks bind to the video element and attempt playback', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/video\.srcObject = stream/);
    expect(CALL_HOOK_SOURCE).toMatch(/video\.play\?\.\(\)/);
    expect(APP_SOURCE).toMatch(/<video ref=\{calls\.remoteVideoRef\} className="remote-call-video" autoPlay playsInline onClick=\{calls\.retryRemotePlayback\} onPlaying=\{calls\.markRemoteVideoReady\} onWaiting=\{calls\.markRemoteVideoWaiting\} \/>/);
  });

  test('the waiting placeholder remains until the browser reports a playing video frame', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/setRemoteVideoReady\(false\)/);
    expect(APP_SOURCE).toMatch(/!calls\.remoteVideoReady && <div className="call-video-placeholder"/);
    expect(APP_SOURCE).toMatch(/onPlaying=\{calls\.markRemoteVideoReady\}/);
  });

  test('a failed media path gives actionable TURN guidance instead of leaving a blank stage', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/media path could not connect[\s\S]*TURN relay/);
    expect(APP_SOURCE).toMatch(/Video connection failed/);
    expect(APP_SOURCE).toMatch(/A TURN relay may be required on this network/);
  });

  test('camera switch reads current camera-off state after permission resolves', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/nextTrack\.enabled = !cameraOffRef\.current/);
    expect(CALL_HOOK_SOURCE).toMatch(/cameraOffRef\.current = nextOff/);
  });

  test('failed replaceTrack paths stop acquired tracks and restore the previous sender track', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/await sender\.replaceTrack\(nextTrack\)/);
    expect(CALL_HOOK_SOURCE).toMatch(/sender\.replaceTrack\(oldTrack\?\.readyState === 'live' \? oldTrack : null\)/);
    expect(CALL_HOOK_SOURCE).toMatch(/stream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  });

  test('socket reconnect derives the restored status from RTCPeerConnection state', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/peerState === 'connected' \? 'active'/);
    expect(CALL_HOOK_SOURCE).toMatch(/peerState === 'failed' \|\| peerState === 'closed' \? 'failed'/);
    expect(CALL_HOOK_SOURCE).toMatch(/peerState === 'disconnected' \? 'connecting'/);
  });
});
