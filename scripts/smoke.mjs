#!/usr/bin/env node
/**
 * Two-guest smoke test against a running server.
 *
 * Everything the product promises between two browsers is exercised over the
 * real HTTP and Socket.io surfaces: pairing, text, an uploaded attachment, and
 * the call signalling relay. It talks as a browser would (HttpOnly cookie, no
 * token header), so a pass here is evidence the deployed path works rather than
 * evidence an internal helper does.
 *
 *   node scripts/smoke.mjs
 *   SMOKE_BASE_URL=http://127.0.0.1:3100 node scripts/smoke.mjs
 *   SMOKE_METRICS_TOKEN=... node scripts/smoke.mjs
 */

import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const BASE_URL = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 8000);
// 1x1 transparent PNG. The upload sniffs magic numbers, so the bytes have to be
// a real image rather than text pretending to be one.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let stepNumber = 0;
function step(text) {
  stepNumber += 1;
  console.log(`[${String(stepNumber).padStart(2, '0')}] ${text}`);
}

function fail(message) {
  throw new Error(message);
}

function waitUntil(check, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = check();
      } catch (err) {
        return reject(err);
      }
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function api(path, { method = 'GET', cookie, body, headers = {}, rawBody } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (rawBody !== undefined) {
    init.body = rawBody;
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

function sessionCookie(response) {
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const cookie = setCookie.find((value) => value.startsWith('inchat_session='));
  if (!cookie) fail('session response did not set the inchat_session cookie');
  return cookie.split(';')[0];
}

function connectGuest(label, cookie, room) {
  const socket = io(BASE_URL, {
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
    auth: { room },
    extraHeaders: { Cookie: cookie }
  });
  const seen = {
    connected: false,
    history: null,
    presence: null,
    messages: [],
    incoming: [],
    accepted: [],
    offers: [],
    ice: [],
    ended: [],
    errors: [],
    ackErrors: []
  };
  socket.on('connect', () => {
    seen.connected = true;
  });
  socket.on('connect_error', (err) => {
    seen.errors.push(`connect_error: ${err.message}`);
  });
  socket.on('history', (payload) => {
    seen.history = payload;
  });
  socket.on('presence', (payload) => {
    seen.presence = payload;
  });
  socket.on('new_message', (message) => {
    seen.messages.push(message);
  });
  socket.on('system', (payload) => {
    if (payload?.type === 'error') seen.errors.push(payload.reason || payload.message || 'system error');
  });
  socket.on('call:incoming', (payload) => seen.incoming.push(payload));
  socket.on('call:accepted', (payload) => seen.accepted.push(payload));
  socket.on('call:offer', (payload) => seen.offers.push(payload));
  socket.on('call:ice', (payload) => seen.ice.push(payload));
  socket.on('call:end', (payload) => seen.ended.push(payload));
  socket.connect();
  return { label, socket, seen };
}

function emitAck(guest, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${guest.label}: no ack for ${event}`)), TIMEOUT_MS);
    guest.socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      if (!response || response.ok !== true) {
        return reject(new Error(`${guest.label}: ${event} rejected (${response?.error || 'no response'})`));
      }
      resolve(response);
    });
  });
}

async function joinRoom(guest) {
  await waitUntil(() => guest.seen.connected, `${guest.label} socket connected`);
  await waitUntil(() => guest.seen.history, `${guest.label} joined and received history`);
  await waitUntil(
    () => guest.seen.presence && guest.seen.presence.users?.length === 2,
    `${guest.label} presence shows both guests`
  );
}

async function main() {
  const guests = [];
  try {
    step(`target ${BASE_URL}`);

    const health = await api('/healthz');
    assert.equal(health.status, 200, `healthz answered ${health.status}`);
    const ready = await api('/readyz');
    assert.equal(ready.status, 200, `readyz answered ${ready.status}`);

    const first = await api('/api/sessions', { method: 'POST', body: { displayName: 'Smoke A' } });
    assert.equal(first.status, 201, `session A answered ${first.status}`);
    assert.equal(first.json?.sessionToken, undefined, 'session token leaked into the browser body');
    const cookieA = sessionCookie(first);
    const guestAId = first.json.userId;
    step('guest A session created (cookie only, no token in body)');

    const second = await api('/api/sessions', { method: 'POST', body: { displayName: 'Smoke B' } });
    assert.equal(second.status, 201, `session B answered ${second.status}`);
    const cookieB = sessionCookie(second);
    const guestBId = second.json.userId;
    step('guest B session created');

    const anonymous = await api('/api/me/self');
    assert.equal(anonymous.status, 401, 'self lookup without a cookie should be 401');
    const identified = await api('/api/me/self', { cookie: cookieA });
    assert.equal(identified.status, 200);
    assert.equal(identified.json.displayName, 'Smoke A');
    assert.equal(identified.json.room, `self-${guestAId}`);
    step('cookie authenticates; no cookie is anonymous');

    const room = `smoke-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const claim = await api(`/api/rooms/${room}/access`, { method: 'POST', cookie: cookieA, body: {} });
    assert.equal(claim.status, 200, `claim answered ${claim.status}`);
    assert.equal(claim.json.authorized, true);
    assert.match(claim.json.inviteCode, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    step(`room ${room} claimed by A; pairing code issued once`);

    const parked = await api(`/api/rooms/${room}/access`, { method: 'POST', cookie: cookieB, body: {} });
    assert.equal(parked.status, 403, 'a second guest must not enter without the code');
    assert.equal(parked.json.error, 'pairing_code_required');
    const seated = await api(`/api/rooms/${room}/access`, {
      method: 'POST',
      cookie: cookieB,
      body: { credential: claim.json.inviteCode }
    });
    assert.equal(seated.status, 200);
    assert.equal(seated.json.role, 'guest');
    step('B refused without the code, admitted with it');

    const a = connectGuest('A', cookieA, room);
    const b = connectGuest('B', cookieB, room);
    guests.push(a, b);
    await joinRoom(a);
    await joinRoom(b);
    step('both sockets joined; presence reports two guests');

    const aSocketId = a.seen.presence.users.find((entry) => entry.userId === guestAId)?.socketId;
    const bSocketId = b.seen.presence.users.find((entry) => entry.userId === guestBId)?.socketId;
    assert.ok(aSocketId && bSocketId, 'presence must carry both socket ids');

    const sentA = await emitAck(a, 'message', { room, text: 'hello from A', clientId: randomUUID() });
    assert.match(sentA.id, /^[0-9a-f-]{36}$/);
    await waitUntil(() => b.seen.messages.some((m) => m.text === 'hello from A'), 'B receiving A text');
    const receivedA = b.seen.messages.find((m) => m.text === 'hello from A');
    assert.equal(receivedA.seq, sentA.seq, 'live copy must carry the sequence the sender was acked');
    step(`text A -> B delivered and ordered (seq ${sentA.seq})`);

    await emitAck(b, 'message', { room, text: 'reply from B', clientId: randomUUID() });
    await waitUntil(() => a.seen.messages.some((m) => m.text === 'reply from B'), 'A receiving B text');
    step('text B -> A delivered');

    const form = new FormData();
    form.append('files', new Blob([PNG_BYTES], { type: 'image/png' }), 'smoke.png');
    const upload = await api('/api/media', { method: 'POST', cookie: cookieA, rawBody: form });
    assert.equal(upload.status, 201, `upload answered ${upload.status}`);
    const media = upload.json?.media?.[0];
    assert.ok(media?.id, 'upload must return a media record');
    assert.equal(media.kind, 'image');
    step(`image uploaded (${media.size} bytes, id ${media.id.slice(0, 8)}...)`);

    await emitAck(a, 'message', {
      room,
      text: 'with a picture',
      clientId: randomUUID(),
      attachments: [{ id: media.id, kind: media.kind, name: media.name, mime: media.mime, size: media.size }]
    });
    await waitUntil(
      () => b.seen.messages.some((m) => m.attachments?.some((file) => file.id === media.id)),
      'B receiving the attachment'
    );
    const download = await fetch(`${BASE_URL}/media/${media.id}`);
    assert.equal(download.status, 200, 'downloadable attachment answered non-200');
    assert.equal(Buffer.from(await download.arrayBuffer()).length, PNG_BYTES.length);
    step('attachment message delivered and the file downloads byte-for-byte');

    const callId = randomUUID();
    await emitAck(a, 'call:invite', { callId, targetSocketId: bSocketId, mode: 'audio' });
    await waitUntil(() => b.seen.incoming.some((call) => call.callId === callId), 'B receiving the call invite');
    assert.equal(b.seen.incoming[0].fromUserId, guestAId);
    step('call invite relayed A -> B');

    await emitAck(b, 'call:accept', { callId, targetSocketId: aSocketId });
    await waitUntil(() => a.seen.accepted.some((call) => call.callId === callId), 'A receiving the accept');
    step('call accept relayed B -> A');

    const offerSdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
    await emitAck(a, 'call:offer', {
      callId,
      targetSocketId: bSocketId,
      description: { type: 'offer', sdp: offerSdp }
    });
    await waitUntil(() => b.seen.offers.some((call) => call.callId === callId), 'B receiving the offer');
    assert.equal(b.seen.offers[0].description.sdp, offerSdp);
    step('SDP offer relayed intact');

    const candidate = { candidate: 'candidate:1 1 UDP 2113937151 127.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    await emitAck(b, 'call:ice', { callId, targetSocketId: aSocketId, candidate });
    await waitUntil(() => a.seen.ice.some((call) => call.callId === callId), 'A receiving the ICE candidate');
    assert.equal(a.seen.ice[0].candidate.candidate, candidate.candidate);
    step('ICE candidate relayed intact');

    await emitAck(a, 'call:end', { callId, targetSocketId: bSocketId });
    await waitUntil(() => b.seen.ended.some((call) => call.callId === callId), 'B receiving the hang-up');
    step('hang-up relayed; call closed');

    for (const guest of [a, b]) {
      assert.deepEqual(guest.seen.errors, [], `${guest.label} saw socket errors: ${guest.seen.errors.join(', ')}`);
    }

    const metricsHeaders = process.env.SMOKE_METRICS_TOKEN
      ? { authorization: `Bearer ${process.env.SMOKE_METRICS_TOKEN}` }
      : {};
    const metrics = await api('/metrics', { headers: metricsHeaders });
    if (metrics.status === 404 && !process.env.SMOKE_METRICS_TOKEN) {
      step('metrics endpoint is closed (production without METRICS_TOKEN)');
    } else {
      assert.equal(metrics.status, 200, `metrics answered ${metrics.status}`);
      assert.match(metrics.text, /chat_messages_sent_total [1-9]\d*/);
      assert.match(metrics.text, /chat_media_uploads_total [1-9]\d*/);
      assert.match(metrics.text, /chat_active_sockets 2/);
      step('metrics report sent messages, uploads and two active sockets');
    }

    a.socket.disconnect();
    b.socket.disconnect();
    guests.length = 0;

    const logout = await api('/api/sessions/current', { method: 'DELETE', cookie: cookieA });
    assert.equal(logout.status, 204);
    const afterLogout = await api('/api/me/self', { cookie: cookieA });
    assert.equal(afterLogout.status, 401, 'expired cookie still authenticates');
    step('sign-out expires the session cookie');

    console.log(`\nSmoke passed: ${stepNumber} checks against ${BASE_URL}`);
  } finally {
    for (const guest of guests) guest.socket.disconnect();
  }
}

main().catch((err) => {
  console.error(`\nSmoke failed: ${err.message}`);
  process.exitCode = 1;
});
