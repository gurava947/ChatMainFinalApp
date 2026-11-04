'use strict';

/**
 * Verifies the P4 cards against a running server the way two guests use them:
 * one opens a ballot, the other votes, and both read the tally back from history.
 * Run with: node scripts/verify-rich-cards-live.js [baseUrl]
 *
 * It needs the dev dependency socket.io-client, so run it from a checkout that
 * has `npm install`ed, against a server started with USE_MEMORY_STORE or Redis.
 */

const { emitWithAck, openSocket, waitFor } = require('../tests/helpers/socket-harness');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';
const ROOM = `p4-cards-${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function signIn(displayName) {
  const response = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  if (!response.ok) throw new Error(`sign-in failed for ${displayName}: ${response.status}`);
  return response.json();
}

const send = (socket, payload) => emitWithAck(socket, 'message', { room: ROOM, clientId: crypto.randomUUID(), ...payload });

async function main() {
  console.log(`\nRich card checks against ${BASE} (room ${ROOM})\n`);

  const ana = await signIn('Ana');
  const ben = await signIn('Ben');

  const anaSock = openSocket(BASE, ana.userId, ROOM);
  const benSock = openSocket(BASE, ben.userId, ROOM);
  await Promise.all([waitFor(anaSock, 'connect'), waitFor(benSock, 'connect')]);
  await waitFor(anaSock, 'history');
  await waitFor(benSock, 'history');

  const poll = await send(anaSock, {
    content: { type: 'poll', question: 'Which evening works?', options: ['Tuesday', 'Wednesday', 'Thursday'], multiple: false }
  });
  check('a poll is accepted and arrives as a ballot', poll?.ok === true && poll?.id, poll);

  const seenByBen = await waitFor(benSock, 'new_message', (message) => message.content?.type === 'poll');
  check('the other guest receives the same ballot over the socket',
    seenByBen.content.question === 'Which evening works?' && seenByBen.content.options.length === 3, seenByBen.content);

  const vote = await emitWithAck(benSock, 'poll:vote', { messageId: poll.id, choices: [1] });
  check('a vote is counted by the server, not by the voter',
    vote?.results?.totalVoters === 1 && vote?.results?.options[1].count === 1
    && vote?.results?.options[1].voters.includes(ben.userId), vote?.results);

  const fanned = await waitFor(anaSock, 'poll_voted', (payload) => payload.messageId === poll.id);
  check('the author sees the tally move without reloading',
    fanned.results.options.map((option) => option.count).join(',') === '0,1,0', fanned.results);

  const secondVote = await emitWithAck(benSock, 'poll:vote', { messageId: poll.id, choices: [2] });
  check('re-voting replaces the earlier choice instead of double counting',
    secondVote?.results?.totalVoters === 1 && secondVote?.results?.options[1].count === 0
    && secondVote?.results?.options[2].count === 1, secondVote?.results);

  await emitWithAck(anaSock, 'poll:vote', { messageId: poll.id, choices: [1] });
  const refused = await emitWithAck(benSock, 'poll:vote', { messageId: poll.id, choices: [0, 1] })
    .catch((err) => ({ error: err.message }));
  check('a single-choice poll refuses two options',
    refused?.error !== undefined || refused?.ok === false || refused?.results?.totalVoters === 2, refused);

  const contact = await send(anaSock, {
    content: { type: 'contact', name: 'Asha Menon', phone: '+91 98765 43210', email: 'asha@example.com', org: 'Acme' }
  });
  const event = await send(anaSock, {
    content: { type: 'event', title: 'Design review', start: Date.parse('2026-11-20T09:30:00Z'), end: Date.parse('2026-11-20T10:00:00Z'), location: 'Room 4' }
  });
  const location = await send(anaSock, { content: { type: 'location', lat: 12.97, lng: 77.59, label: 'Office' } });
  check('contact, event and location cards are all accepted',
    contact?.ok && event?.ok && location?.ok, { contact: contact?.ok, event: event?.ok, location: location?.ok });

  const history = await fetch(`${BASE}/api/rooms/${ROOM}/messages`, { headers: { 'X-Session-Id': ana.userId } });
  const rows = (await history.json()).messages || [];
  const storedPoll = rows.find((row) => row.id === poll.id);
  check('history carries the live tally, so a rejoin is not a blank ballot',
    storedPoll?.results?.totalVoters === 2
    && storedPoll.results.options[1].count === 1 && storedPoll.results.options[2].count === 1, storedPoll?.results);

  const storedEvent = rows.find((row) => row.id === event.id);
  check('the stored event keeps the fields a calendar file is built from',
    storedEvent?.content?.title === 'Design review'
    && Number(storedEvent?.content?.start) === Date.parse('2026-11-20T09:30:00Z')
    && Number(storedEvent?.content?.end) === Date.parse('2026-11-20T10:00:00Z')
    && storedEvent?.content?.location === 'Room 4', storedEvent?.content);

  const storedContact = rows.find((row) => row.id === contact.id);
  check('the stored contact keeps a diallable number and a mailable address',
    storedContact?.content?.phone === '+91 98765 43210' && storedContact?.content?.email === 'asha@example.com',
    storedContact?.content);

  const pollKind = await send(anaSock, { text: 'plain', content: { type: 'poll', question: '', options: ['a'] } })
    .catch((err) => ({ error: err.message }));
  check('a malformed poll never becomes a message',
    pollKind?.ok !== true || !pollKind?.id, pollKind);

  anaSock.disconnect();
  benSock.disconnect();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
