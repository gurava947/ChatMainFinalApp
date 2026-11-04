'use strict';

/**
 * Live multi-session check against the running server: three guests in one room,
 * so delivery can be proven to come from a device report and not from presence.
 */

const { io } = require('socket.io-client');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const ROOM = `p1-verify-${Date.now().toString(36)}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function guest(displayName) {
  const response = await connectSession(displayName);
  if (!response.ok) throw new Error(`session for ${displayName} failed: ${response.status}`);
  return response.json();
}

async function connectSession(displayName) {
  return fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
}

function openSocket(session) {
  const socket = io(BASE, {
    auth: { userId: session.userId, room: ROOM },
    transports: ['websocket'],
    forceNew: true
  });
  socket.__events = [];
  ['connect', 'history', 'new_message', 'message_delivered', 'message_seen', 'presence'].forEach((name) => {
    socket.on(name, (payload) => socket.__events.push({ name, payload }));
  });
  return socket;
}

function take(socket, name, predicate = () => true, timeoutMs = 8000, label = name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    const scan = () => {
      const hit = socket.__events.find((event) => event.name === name && predicate(event.payload));
      if (hit) {
        socket.__events.splice(socket.__events.indexOf(hit), 1);
        clearTimeout(timer);
        resolve(hit.payload);
        return true;
      }
      return false;
    };
    if (scan()) return;
    const poll = setInterval(() => { if (scan()) clearInterval(poll); }, 40);
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  const [arjun, ben, chloe] = await Promise.all([guest('Arjun P1'), guest('Ben P1'), guest('Chloe P1')]);
  const sockets = { arjun: openSocket(arjun), ben: openSocket(ben), chloe: openSocket(chloe) };
  const { arjun: a, ben: b, chloe: c } = sockets;
  await Promise.all([a, b, c].map((socket) => take(socket, 'connect', () => true, 8000, 'socket open')));
  await wait(1200);

  // 1. Arjun sends while Ben and Chloe are online but silent.
  const sendAck = await new Promise((resolve) => a.emit('message', { text: 'delivery proof', clientId: crypto.randomUUID() }, resolve));
  const messageId = sendAck?.id;
  check('sender gets an ack with a message id', Boolean(messageId), JSON.stringify(sendAck && { ok: sendAck.ok, id: sendAck.id }));

  const benGot = await take(b, 'new_message', (p) => p.id === messageId, 8000, 'ben receives the message');
  await take(c, 'new_message', (p) => p.id === messageId, 8000, 'chloe receives the message');
  check('recipient receives new_message', benGot.room === ROOM);

  // 2. Presence alone must not look like delivery to the sender.
  await wait(800);
  const silent = a.__events.filter((e) => e.name === 'message_delivered');
  check('online peers alone produce no delivery receipt', silent.length === 0, `receipts=${silent.length}`);

  // 3. Ben's device reports the read delivery; Chloe stays silent.
  b.emit('message:delivered', { ids: [messageId] });
  const receipt = await take(a, 'message_delivered', (p) => p.userId === ben.userId, 8000, 'sender sees ben receipt');
  check('device report reaches the sender', receipt.messageId === messageId && receipt.userId === ben.userId);
  await wait(500);
  const forChloe = a.__events.filter((e) => e.name === 'message_delivered' && e.payload.userId === chloe.userId);
  check('the silent peer is NOT marked delivered', forChloe.length === 0, `receipts=${forChloe.length}`);

  // 4. A duplicate report from Ben is absorbed.
  b.emit('message:delivered', { ids: [messageId] });
  await wait(500);
  const dupes = a.__events.filter((e) => e.name === 'message_delivered' && e.payload.userId === ben.userId);
  check('duplicate report is not re-broadcast', dupes.length === 0, `extra=${dupes.length}`);

  // 5. Chloe opens the room over HTTP — the history read is her delivery.
  const history = await fetch(`${BASE}/api/rooms/${ROOM}/messages?limit=50`, { headers: { 'X-Session-Id': chloe.userId } });
  const { messages: rows } = await history.json();
  const row = rows.find((message) => message.id === messageId);
  check('HTTP history marks the reader as delivered', (row?.deliveredTo || []).includes(chloe.userId), JSON.stringify(row?.deliveredTo));
  await take(a, 'message_delivered', (p) => p.userId === chloe.userId, 8000, 'online sender learns about chloe');

  // 6. Ben marks it read: read must imply delivered, and the sender sees both.
  const seenAck = await new Promise((resolve) => b.emit('message:seen', { ids: [messageId] }, resolve));
  check('seen ack is accepted', Boolean(seenAck?.ok), JSON.stringify(seenAck));
  const seen = await take(a, 'message_seen', (p) => p.userId === ben.userId, 8000, 'sender sees read receipt');
  check('read receipt reaches the sender', seen.messageId === messageId);

  // 7. Rejoining Ben: history must still carry both receipts.
  b.disconnect();
  const b2 = openSocket(ben);
  await take(b2, 'connect', () => true, 8000, 'reopen');
  const rejoined = await take(b2, 'history', (p) => Array.isArray(p.messages), 8000, 'history on rejoin');
  const carried = rejoined.messages.find((message) => message.id === messageId);
  check('receipts survive a rejoin', (carried?.deliveredTo || []).includes(ben.userId) && (carried?.seenBy || []).includes(ben.userId),
    JSON.stringify({ deliveredTo: carried?.deliveredTo, seenBy: carried?.seenBy }));
  b2.disconnect();

  // 8. Malformed batches are rejected rather than trusted.
  const badAck = await new Promise((resolve) => c.emit('message:delivered', { ids: ['not-a-uuid'] }, resolve));
  check('a malformed delivery batch is rejected', badAck && badAck.ok === false, JSON.stringify(badAck));

  [a, c].forEach((socket) => socket.disconnect());
  const failures = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failures.length}/${results.length} live checks passed`);
  process.exit(failures.length ? 1 : 0);
})().catch((error) => {
  console.error('HARNESS ERROR:', error.message);
  process.exit(2);
});
