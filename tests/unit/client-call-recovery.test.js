/** @jest-environment jsdom */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadCallRecovery } = require('../helpers/load-client-module');

const CALL_HOOK_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'useRoomCalls.js'), 'utf8');

let recovery;

beforeEach(() => {
  recovery = loadCallRecovery();
});

describe('recovery ladder', () => {
  test('the timings keep a transient blip invisible but bound the retries', () => {
    expect(recovery.RECONNECT_GRACE_MS).toBe(3000);
    expect(recovery.RECOVERY_WINDOW_MS).toBe(8000);
    expect(recovery.MAX_RECOVERY_ATTEMPTS).toBe(2);
  });

  test('the caller restarts ICE once, then rebuilds, then gives up', () => {
    expect(recovery.recoveryAction(0, 'outgoing')).toBe('restart');
    expect(recovery.recoveryAction(1, 'outgoing')).toBe('rebuild');
    expect(recovery.recoveryAction(2, 'outgoing')).toBe('fail');
    expect(recovery.recoveryAction(7, 'outgoing')).toBe('fail');
  });

  test('the callee asks the caller instead of offering a second negotiation', () => {
    expect(recovery.recoveryAction(0, 'incoming')).toBe('request-restart');
    expect(recovery.recoveryAction(1, 'incoming')).toBe('request-restart');
    expect(recovery.recoveryAction(2, 'incoming')).toBe('fail');
  });

  test('a failed transport skips the grace that a disconnect gets', () => {
    expect(recovery.recoveryGrace('failed')).toBe(0);
    expect(recovery.recoveryGrace('disconnected')).toBe(recovery.RECONNECT_GRACE_MS);
  });

  test('signaling coming back derives the status from the peer connection', () => {
    expect(recovery.restoredCallStatus('connected')).toBe('active');
    expect(recovery.restoredCallStatus('completed')).toBe('active');
    expect(recovery.restoredCallStatus('failed')).toBe('failed');
    expect(recovery.restoredCallStatus('closed')).toBe('failed');
    expect(recovery.restoredCallStatus('disconnected')).toBe('reconnecting');
    expect(recovery.restoredCallStatus('connecting')).toBe('reconnecting');
    expect(recovery.restoredCallStatus(undefined)).toBe('reconnecting');
  });
});

describe('the hook runs the ladder', () => {
  test('it restarts ICE with a fresh offer before rebuilding', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/connection\.restartIce\?\.\(\)/);
    expect(CALL_HOOK_SOURCE).toMatch(/createOffer\(\{ iceRestart: true \}\)/);
    expect(CALL_HOOK_SOURCE).toMatch(/recoveryAction\(attempt, active\.direction\)/);
  });

  test('a callee asks the caller and the caller listens for the request', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/socket\.emit\('call:restart', \{ targetSocketId: active\.peerSocketId, callId: active\.callId \}\)/);
    expect(CALL_HOOK_SOURCE).toMatch(/socket\.on\('call:restart', onRestart\)/);
    expect(CALL_HOOK_SOURCE).toMatch(/socket\.off\('call:restart', onRestart\)/);
  });

  test('a disconnected peer gets the grace and a failed one does not', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/recoveryGrace\(peerState\)/);
  });

  test('the rebuilt connection drops the old candidates and tracks first', () => {
    const rebuild = CALL_HOOK_SOURCE.slice(
      CALL_HOOK_SOURCE.indexOf('const rebuildConnection'),
      CALL_HOOK_SOURCE.indexOf('/**', CALL_HOOK_SOURCE.indexOf('const rebuildConnection')),
    );
    expect(rebuild).toMatch(/previous\.close\(\)/);
    expect(rebuild).toMatch(/pendingIceRef\.current = \[\]/);
    expect(rebuild).toMatch(/return createPeerConnection\(active\)/);
  });

  test('ending or replacing a call clears every recovery timer', () => {
    const cleanup = CALL_HOOK_SOURCE.slice(
      CALL_HOOK_SOURCE.indexOf('const cleanupLocal'),
      CALL_HOOK_SOURCE.indexOf('useEffect('),
    );
    expect(cleanup).toMatch(/clearRecovery\(\)/);
  });

  test('a candidate that arrives before its renegotiation is replayed', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/catch \{\s*\/\/ A candidate for an offer that has not been applied yet[\s\S]*?pendingIceRef\.current\.push\(signal\.candidate\)/);
  });

  test('socket reconnect hands a down media path to the recovery ladder', () => {
    expect(CALL_HOOK_SOURCE).toMatch(/peerState === 'disconnected' \|\| peerState === 'failed'\) \{\s*scheduleRecovery\(current, peerState\)/);
    expect(CALL_HOOK_SOURCE).toMatch(/updateCall\(\{ \.\.\.current, status: restoredCallStatus\(peerState\) \}\)/);
  });
});
