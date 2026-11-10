'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'useRoomCalls.js'), 'utf8');

describe('the hook replays the signal mailbox', () => {
  test('a reconnect asks for the mailbox while the call is still negotiating', () => {
    expect(SOURCE).toMatch(/\['calling', 'connecting', 'reconnecting'\]\.includes\(current\.status\)/);
    expect(SOURCE).toMatch(/socket\.emit\('call:resume', \{ callId: current\.callId \}\)/);
  });

  test('the mailbox listener is registered and removed with the socket', () => {
    expect(SOURCE).toMatch(/socket\.on\('call:mailbox', onMailbox\)/);
    expect(SOURCE).toMatch(/socket\.off\('call:mailbox', onMailbox\)/);
  });

  test('a replay aims at the peer socket presence knows now', () => {
    const mailbox = SOURCE.slice(SOURCE.indexOf('const onMailbox'), SOURCE.indexOf("socket.on('disconnect'"));
    expect(mailbox).toMatch(/const peerSocketId = signal\.fromSocketId \|\| active\.peerSocketId/);
    expect(mailbox).toMatch(/updateCall\(\{ \.\.\.active, peerSocketId/);
    expect(mailbox).toMatch(/if \(active\.direction === 'incoming'\) await onOffer\(replay\)/);
    expect(mailbox).toMatch(/else await onAnswer\(replay\)/);
    expect(mailbox).toMatch(/for \(const candidate of signal\.candidates \|\| \[\]\)/);
  });
});

describe('the hook reports the call path once', () => {
  test('a call id is reported once and cleared with the call', () => {
    expect(SOURCE).toMatch(/reportedCallStatsRef\.current\.has\(active\.callId\)/);
    expect(SOURCE).toMatch(/reportedCallStatsRef\.current\.add\(active\.callId\)/);
    expect(SOURCE).toMatch(/reportedCallStatsRef\.current\.clear\(\)/);
  });

  test('the selected candidate pair decides relay vs direct', () => {
    expect(SOURCE).toMatch(/socket\.emit\('call:stats', \{ callId: active\.callId, outcome, relayed \}\)/);
    expect(SOURCE).toMatch(/item\.type === 'candidate-pair' && item\.state === 'succeeded'/);
    expect(SOURCE).toMatch(/candidate\?\.candidateType === 'relay'/);
  });

  test('connected and failed setups both report', () => {
    expect(SOURCE).toMatch(/reportCallStats\(active, 'connected'\)/);
    expect(SOURCE).toMatch(/reportCallStats\(active, 'failed'\)/);
  });
});