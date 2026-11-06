#!/usr/bin/env node
/* InChat localhost state-management / data-sync probe. */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');

const ROUND = Number(process.argv[2] || 1);
const SUITE = process.argv[3] || 'all';
const TAG = `r${ROUND}`;
const room = (name) => `qa-${TAG}-${name}`;

/**
 * Pairing codes live here and nowhere else. A room's first accessor is handed
 * its code exactly once, so a probe that wants a second member has to hold on
 * to it - the same way the browser keeps it only in the owner's settings panel.
 */
const inviteCodes = new Map();

const results = [];
function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
  const mark = status === 'PASS' ? '+' : status === 'FAIL' ? 'x' : '~';
  console.log(`[${mark}] ${id} ${name} :: ${JSON.stringify(detail)}`);
}

const api = async (port, path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch { body = { nonJson: true }; }
  return { status: res.status, body };
};

const auth = (s) => ({ 'x-session-id': s.userId, 'x-session-token': s.sessionToken });

async function newSession(port, displayName) {
  const { status, body } = await api(port, '/api/sessions', {
    method: 'POST', body: JSON.stringify({ displayName })
  });
  if (status !== 201) throw new Error(`session create failed ${status} ${JSON.stringify(body)}`);
  return body;
}

/**
 * Takes this session a seat in the room. With no code known yet the call claims
 * the room and answers with the code; from then on the code is supplied, so the
 * harness pairs the way two real browsers would.
 */
async function join(port, s, R) {
  const credential = inviteCodes.get(R);
  const res = await api(port, `/api/rooms/${R}/access`, {
    method: 'POST', headers: auth(s), body: JSON.stringify(credential ? { credential } : {})
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`room join failed ${res.status} ${JSON.stringify(res.body)} (${s.displayName})`);
  if (res.body.inviteCode) inviteCodes.set(R, res.body.inviteCode);
  return res;
}

/** session + room membership in one call */
const member = async (port, name, R) => {
  const s = await newSession(port, name);
  await join(port, s, R);
  return s;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (ms = 600) => sleep(ms);

function connect(port, s, R, label) {
  const log = { newMessage: [], history: [], presence: [], userJoined: [], userLeft: [], seen: [], delivered: [], system: [], connectError: [] };
  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth: { userId: s.userId, sessionToken: s.sessionToken, room: R, roomCredential: inviteCodes.get(R) },
    reconnection: false,
    timeout: 5000
  });
  socket.on('connect_error', (e) => log.connectError.push(String(e.message || e)));
  socket.on('new_message', (p) => log.newMessage.push(p));
  socket.on('history', (p) => log.history.push(p));
  socket.on('presence', (p) => log.presence.push(p));
  socket.on('user_joined', (p) => log.userJoined.push(p));
  socket.on('user_left', (p) => log.userLeft.push(p));
  socket.on('message_seen', (p) => log.seen.push(p));
  socket.on('message_delivered', (p) => log.delivered.push(p));
  socket.on('system', (p) => log.system.push(p));
  return { socket, log, label, port };
}

const open = (c, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`open timeout: ${c.label}`)), ms);
  c.socket.on('connect', () => { clearTimeout(t); resolve(c); });
  c.socket.on('connect_error', (e) => { clearTimeout(t); reject(new Error(`${c.label}: ${e.message}`)); });
});

const ackOf = (c, event, payload, ms = 5000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ ok: false, error: `ack timeout ${event}` }), ms);
  c.socket.emit(event, payload, (r) => { clearTimeout(t); resolve(r); });
});

const send = (c, payload) => ackOf(c, 'message', payload);

const closeAll = async (clients) => {
  await Promise.all(clients.filter(Boolean).map(async (c) => {
    if (c.socket?.connected) { c.socket.disconnect(); await sleep(120); }
  }));
};

const history = async (port, s, R, limit = 50) =>
  (await api(port, `/api/rooms/${R}/messages?limit=${limit}`, { headers: auth(s) })).body.messages || [];

/* ------------------------------------------------------------------ *
 * T1 cross-instance room sync: same room name, two localhost ports
 * ------------------------------------------------------------------ */
async function t1() {
  const R = room('sync');
  const a = await member(3000, `${TAG}-alice`, R);
  const b = await member(3001, `${TAG}-bob`, R);
  const clients = [];
  try {
    const ca = await open(connect(3000, a, R, 'A@3000'));
    const cb = await open(connect(3001, b, R, 'B@3001'));
    clients.push(ca, cb);
    await settle(500);
    const ack = await send(ca, { room: R, text: `cross-instance probe ${TAG}`, clientId: `${TAG}-t1` });
    await settle(1000);
    const gotOnB = cb.log.newMessage.length;
    const aCount = (await history(3000, a, R)).length;
    const bCount = (await history(3001, b, R)).length;
    record('T1', 'cross-instance room sync',
      gotOnB === 1 && bCount === aCount ? 'PASS' : 'FAIL',
      { sendAckOk: ack.ok, liveReceivedByPeerInstance: gotOnB, messagesOn3000: aCount, messagesOn3001: bCount,
        verdict: gotOnB === 0
          ? 'peer instance received nothing: no live fan-out across processes and no shared history. Two localhosts are two separate chats.'
          : 'synced' });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T2 session portability: session minted on 3000, used on 3001
 * ------------------------------------------------------------------ */
async function t2() {
  const R = room('portable');
  const a = await member(3000, `${TAG}-portable`, R);
  let failed = null;
  const c = connect(3001, a, R, 'A@3001');
  try { await open(c); } catch (e) { failed = e.message; }
  const http = await api(3001, `/api/rooms/${R}/messages`, { headers: auth(a) });
  record('T2', 'session portable across instances',
    failed ? 'FAIL' : 'PASS',
    { socketAuth: failed || 'accepted', httpOnPeerInstance: { status: http.status, body: http.body },
      verdict: failed
        ? 'session store is per-process: a session minted on one localhost is unknown to the other, so a load balancer without sticky sessions logs users out at random'
        : 'portable' });
  await closeAll([c]);
}

/* ------------------------------------------------------------------ *
 * T3 realtime fan-out to the peer seat, exactly once (single instance)
 * ------------------------------------------------------------------ */
async function t3() {
  const R = room('fanout');
  const list = [];
  for (let i = 0; i < 2; i++) list.push(await member(3002, `${TAG}-fan${i}`, R));
  const clients = [];
  try {
    for (let i = 0; i < 2; i++) clients.push(await open(connect(3002, list[i], R, `fan${i}`)));
    await settle(600);
    const ack = await send(clients[0], { room: R, text: `fanout ${TAG}`, clientId: `${TAG}-t3` });
    await settle(1000);
    const got = clients.slice(1).map((c) => c.log.newMessage.length);
    const selfGot = clients[0].log.newMessage.length;
    const presence = clients[0].log.presence.at(-1);
    record('T3', 'peer fan-out on one instance (two-seat room)',
      got.every((n) => n === 1) ? 'PASS' : 'FAIL',
      { sendAckOk: ack.ok, peerReceipts: got, senderOwnCopies: selfGot,
        presenceConnections: presence?.connections, presenceOnlineUsers: presence?.onlineUsers,
        verdict: got.every((n) => n === 1) ? 'the peer seat got exactly one copy' : 'fan-out incomplete or duplicated' });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T4 the roster is one record, not one per process
 * ------------------------------------------------------------------ */
async function t4() {
  const R = room('roster');
  const owner = await newSession(3000, `${TAG}-ro-owner`);
  const claim = await join(3000, owner, R);
  const code = inviteCodes.get(R);
  const guest = await newSession(3001, `${TAG}-ro-guest`);
  const paired = await join(3001, guest, R);
  const intruder = await newSession(3000, `${TAG}-ro-intruder-3000`);
  const intruderPeer = await newSession(3001, `${TAG}-ro-intruder-3001`);
  const attempt = (port, s, credential) => api(port, `/api/rooms/${R}/access`, {
    method: 'POST', headers: auth(s), body: JSON.stringify(credential ? { credential } : {})
  });
  const thirdOnOrigin = await attempt(3000, intruder, code);
  const thirdOnPeer = await attempt(3001, intruderPeer, code);
  const openAttempt = await attempt(3000, intruder);
  const historyAsStranger = await api(3000, `/api/rooms/${R}/messages`, { headers: auth(intruder) });
  const ownerReadsPeerInstance = await api(3001, `/api/rooms/${R}/messages`, { headers: auth(owner) });
  const full = (res) => res.status === 403 && res.body.error === 'room_is_full';
  const agrees = full(thirdOnOrigin) && full(thirdOnPeer)
    && openAttempt.status === 403 && historyAsStranger.status === 403
    && ownerReadsPeerInstance.status < 300;
  record('T4', 'two-seat cap and membership agree across instances',
    agrees ? 'PASS' : 'FAIL',
    { claim: { status: claim.status, role: claim.body.role, codeLength: code?.length },
      paired: { status: paired.status, role: paired.body.role },
      thirdOn3000: { status: thirdOnOrigin.status, error: thirdOnOrigin.body.error },
      thirdOn3001: { status: thirdOnPeer.status, error: thirdOnPeer.body.error },
      noCodeOn3000: { status: openAttempt.status, error: openAttempt.body.error },
      strangerHistory: { status: historyAsStranger.status, error: historyAsStranger.body.error },
      ownerHistoryOnPeer: ownerReadsPeerInstance.status,
      verdict: agrees
        ? 'both replicas refuse the third seat with the same reason, an unnamed room name is no longer readable without a seat, and the roster itself travels between processes'
        : 'a seat taken on one instance is not seen by the other, so the cap depends on which replica answers the join' });
}

/* ------------------------------------------------------------------ *
 * T5 idempotency claim poisoned by a failed send (message loss)
 * ------------------------------------------------------------------ */
async function t5() {
  const R = room('idem');
  const a = await member(3002, `${TAG}-idem`, R);
  const b = await member(3002, `${TAG}-idem-peer`, R);
  const clients = [];
  try {
    const ca = await open(connect(3002, a, R, 'idem'));
    const cb = await open(connect(3002, b, R, 'idem-peer'));
    clients.push(ca, cb);
    await settle(500);
    const clientId = `${TAG}-t5-clientid`;
    const bad = await send(ca, {
      room: R, text: 'attempt that must fail', clientId,
      attachments: [{ id: crypto.randomUUID(), kind: 'image', name: 'x.png', mime: 'image/png', size: 12 }]
    });
    const retry = await send(ca, { room: R, text: 'retry after failure', clientId });
    await settle(1000);
    const stored = await history(3002, a, R);
    const peerGot = cb.log.newMessage.map((m) => m.text);
    const retryTextStored = stored.some((m) => m.text === 'retry after failure');
    record('T5', 'retry after failed send with same clientId',
      retryTextStored ? 'PASS' : 'FAIL',
      { firstAttemptAck: bad, retryAck: retry, storedTexts: stored.map((m) => m.text), peerLiveTexts: peerGot,
        verdict: retryTextStored
          ? 'retry persisted'
          : 'retry acked ok + duplicate but nothing was stored and the peer got nothing: claimSend() writes the idempotency claim BEFORE the send can fail and never releases it, so a failed send silently poisons that clientId for the full 10 minute window' });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T6 presence accuracy across instances
 * ------------------------------------------------------------------ */
async function t6() {
  const R = room('presence');
  const origin = [await member(3000, `${TAG}-po0`, R)];
  const peer = [await member(3001, `${TAG}-pp0`, R)];
  const clients = [];
  try {
    for (const s of origin) clients.push(await open(connect(3000, s, R, 'origin')));
    for (const s of peer) clients.push(await open(connect(3001, s, R, 'peer')));
    await settle(900);
    const viewA = clients[0].log.presence.at(-1);
    const viewB = clients[1].log.presence.at(-1);
    const agree = viewA?.onlineUsers === 2 && viewB?.onlineUsers === 2;
    record('T6', 'presence agreement across instances (one seat on each)',
      agree ? 'PASS' : 'FAIL',
      { viewFrom3000: { connections: viewA?.connections, onlineUsers: viewA?.onlineUsers },
        viewFrom3001: { connections: viewB?.connections, onlineUsers: viewB?.onlineUsers },
        actualTotal: 2,
        verdict: agree ? 'both agree'
          : 'each replica reports only its own sockets: the online count is wrong whenever the two seats land on different instances, and user_joined/user_left never cross a process boundary' });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T7 rejoin receipt storm + delivery semantics
 * ------------------------------------------------------------------ */
async function t7() {
  const R = room('receipt');
  const a = await member(3003, `${TAG}-rcv-a`, R);
  const b = await member(3003, `${TAG}-rcv-b`, R);
  const clients = [];
  try {
    const ca = await open(connect(3003, a, R, 'rcv-a'));
    const cb = await open(connect(3003, b, R, 'rcv-b'));
    clients.push(ca, cb);
    await settle(500);
    for (let i = 0; i < 10; i++) await send(ca, { room: R, text: `bulk ${i}`, clientId: `${TAG}-t7-${i}` });
    await settle(900);
    const before = ca.log.delivered.length;
    cb.socket.disconnect();
    await sleep(500);
    const cb2 = await open(connect(3003, b, R, 'rcv-b-rejoin'));
    clients.push(cb2);
    await settle(1300);
    const storm = ca.log.delivered.length - before;
    const hist = cb2.log.history.at(-1)?.messages || [];
    const preMarked = hist.filter((m) => (m.deliveredTo || []).includes(b.userId)).length;
    const neverViewedMarked = preMarked;
    record('T7', 'rejoin delivery receipts',
      storm <= 1 ? 'PASS' : 'WARN',
      { deliveredBroadcastsFromOneRejoin: storm, rowsReturnedOnRejoin: hist.length,
        rowsMarkedDeliveredOnArrival: neverViewedMarked,
        verdict: storm > 1
          ? `one rejoin fired ${storm} message_delivered broadcasts and marked ${neverViewedMarked} rows delivered before the user looked at any of them: readHistory() is a delivery report, so a reconnect is O(page size) on the wire and the sender sees "delivered" for messages the peer never opened`
          : 'bounded' });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T8 reconnect gap detection (no sequence numbers)
 * ------------------------------------------------------------------ */
async function t8() {
  const R = room('gap');
  const a = await member(3003, `${TAG}-gap-a`, R);
  const b = await member(3003, `${TAG}-gap-b`, R);
  const clients = [];
  try {
    const ca = await open(connect(3003, a, R, 'gap-a'));
    let cb = await open(connect(3003, b, R, 'gap-b'));
    clients.push(ca, cb);
    await settle(500);
    for (let i = 0; i < 4; i++) await send(ca, { room: R, text: `before ${i}`, clientId: `${TAG}-t8a-${i}` });
    await settle(600);
    cb.socket.disconnect();
    await sleep(400);
    for (let i = 0; i < 4; i++) await send(ca, { room: R, text: `during ${i}`, clientId: `${TAG}-t8b-${i}` });
    await settle(400);
    const cb3 = await open(connect(3003, b, R, 'gap-b-reconnect'));
    clients.push(cb3);
    await settle(900);
    const hist = cb3.log.history.at(-1)?.messages || [];
    const texts = hist.map((m) => m.text);
    const allRecovered = [...Array(4)].every((_v, i) => texts.includes(`during ${i}`));
    const fields = hist[0] ? Object.keys(hist[0]) : [];
    const hasSeq = fields.some((f) => /seq|cursor|version|offset|rev/i.test(f));
    record('T8', 'reconnect catch-up and gap detectability',
      allRecovered && !hasSeq ? 'WARN' : (allRecovered && hasSeq ? 'PASS' : 'FAIL'),
      { missedWhileOffline: 4, recoveredFromHistory: allRecovered, liveAfterJoin: cb3.log.newMessage.length,
        historyRowFields: fields, sequenceOrCursorPresent: hasSeq,
        verdict: hasSeq ? 'rows carry an ordering token'
          : (allRecovered
            ? 'the join page recovered the missed rows, but no sequence/cursor field exists anywhere: a client cannot prove it is complete, cannot detect a gap, and anything older than the fixed 50-row join page is unreachable'
            : 'missed messages were NOT recovered') });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T9 same-millisecond ordering + live vs history row shape
 * ------------------------------------------------------------------ */
async function t9() {
  const R = room('order');
  const a = await member(3003, `${TAG}-ord-a`, R);
  const b = await member(3003, `${TAG}-ord-b`, R);
  const clients = [];
  try {
    const ca = await open(connect(3003, a, R, 'ord-a'));
    const cb = await open(connect(3003, b, R, 'ord-b'));
    clients.push(ca, cb);
    await settle(500);
    const fired = [];
    for (let i = 0; i < 6; i++) {
      fired.push(send(ca, { room: R, text: `A${i}`, clientId: `${TAG}-t9a-${i}` }));
      fired.push(send(cb, { room: R, text: `B${i}`, clientId: `${TAG}-t9b-${i}` }));
    }
    await Promise.all(fired);
    await settle(1400);
    const hist = await history(3003, a, R);
    const ts = hist.map((m) => m.ts);
    const collisions = ts.length - new Set(ts).size;
    const storedOrder = hist.map((m) => m.text);
    const seqs = hist.map((m) => m.seq);
    const liveRow = cb.log.newMessage[0];
    const histRow = hist.find((m) => m.id === liveRow?.id);
    /* Two rows in one millisecond is normal traffic, not a defect. What has to
     * hold is that the store's arrival order travels on the row, live and
     * historical, so a client that re-sorts cannot invent a different history. */
    const seqOnHistory = seqs.every((s) => Number.isInteger(s));
    const seqAscending = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
    const bySeq = [...hist].sort((x, y) => (x.seq - y.seq) || (x.ts - y.ts)).map((m) => m.text);
    const resortStable = JSON.stringify(bySeq) === JSON.stringify(storedOrder);
    const seqOnLive = Number.isInteger(liveRow?.seq);
    const liveAgrees = Boolean(liveRow && histRow && liveRow.seq === histRow.seq);
    const ordered = seqOnHistory && seqAscending && resortStable && seqOnLive && liveAgrees;
    record('T9', 'ordering under concurrent same-millisecond writes',
      ordered ? 'PASS' : 'WARN',
      { messages: hist.length, timestampCollisions: collisions, seqOnHistoryRows: seqOnHistory,
        seqAscendingWithStoreOrder: seqAscending, resortBySeqReproducesStoreOrder: resortStable,
        seqOnLiveRow: seqOnLive, liveRowAgreesWithHistorySeq: liveAgrees,
        verdict: ordered
          ? `${collisions} rows share a millisecond and the order still round-trips: the store's sequence is on every row, live and historical`
          : `the ordering token is missing or disagrees with the store: ${JSON.stringify({ seqOnHistory, seqAscending, resortStable, seqOnLive, liveAgrees })}` });
    const ids = hist.filter((m) => m.userId === a.userId).slice(0, 5).map((m) => m.id);
    await ackOf(cb, 'message:seen', { ids });
    await settle(900);
    const afterSeen = await history(3003, a, R);
    const seenBroadcasts = ca.log.seen.filter((e) => ids.includes(e.messageId)).length;
    const serverMarked = afterSeen.filter((m) => ids.includes(m.id) && (m.seenBy || []).includes(b.userId)).length;
    record('T9b', 'read-receipt propagation after a seen mark',
      seenBroadcasts === ids.length && serverMarked === ids.length ? 'PASS' : 'FAIL',
      { idsMarked: ids.length, seenEventsReceivedBySender: seenBroadcasts, rowsUpdatedInStore: serverMarked,
        verdict: seenBroadcasts === ids.length && serverMarked === ids.length
          ? 'store and live broadcast agree'
          : 'the store and the live broadcast disagree about how many receipts landed' });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T10 history window truncation (MESSAGE_CACHE_SIZE=10 probe on 3004)
 * ------------------------------------------------------------------ */
async function t10() {
  const R = room('trunc');
  const a = await member(3004, `${TAG}-trunc`, R);
  const b = await member(3004, `${TAG}-trunc-b`, R);
  const texts = [];
  for (let i = 0; i < 14; i++) {
    const t = `keep-${i}`;
    await api(3004, `/api/rooms/${R}/messages`, {
      method: 'POST', headers: auth(a), body: JSON.stringify({ text: t, clientId: `${TAG}-t10-${i}` })
    });
    texts.push(t);
  }
  const hist = await history(3004, b, R);
  const present = hist.map((m) => m.text);
  const lost = texts.filter((t) => !present.includes(t));
  const olderPage = await api(3004, `/api/rooms/${R}/messages?limit=50&before=${Date.now() - 1}`, { headers: auth(b) });
  record('T10', 'history window truncation (cache 10, 14 writes)',
    lost.length === 0 ? 'PASS' : 'WARN',
    { written: texts.length, returned: hist.length, lostFromHistory: lost,
      paginationCursorAccepted: olderPage.status, paginationBody: olderPage.body,
      verdict: lost.length
        ? `${lost.length} rows dropped by the in-process ring buffer with no durable backing store and no cursor to page back to them: history is bounded, not archived`
        : 'nothing lost' });
}

/* ------------------------------------------------------------------ *
 * T11 socket connect budget per IP
 * ------------------------------------------------------------------ */
async function t11() {
  const R = room('rl');
  const s = await member(3000, `${TAG}-rl`, R);
  let opened = 0, rejected = 0; const errors = [];
  for (let i = 0; i < 14; i++) {
    const c = connect(3000, s, R, `rl${i}`);
    try { await open(c, 2500); opened++; } catch (e) { rejected++; errors.push(String(e.message).slice(0, 50)); }
    c.socket.close();
    await sleep(40);
  }
  record('T11', 'socket connect budget per IP',
    rejected === 0 ? 'PASS' : 'WARN',
    { attempted: 14, opened, rejected, sampleErrors: errors.slice(0, 3),
      config: 'RATE_LIMIT_SOCKET_CONNECT_MAX=30 per 60s, bucketed by client IP only',
      verdict: rejected ? `${rejected} connects refused: the bucket is per-IP, so one noisy client (or everyone behind one NAT/localhost) throttles every other user's reconnect` : 'within budget' });
}

/* ------------------------------------------------------------------ *
 * T12 optimistic UI vs server truth (client-side state)
 * ------------------------------------------------------------------ */
async function t12() {
  const R = room('sanitize');
  const a = await member(3002, `${TAG}-san`, R);
  const b = await member(3002, `${TAG}-san-peer`, R);
  const clients = [];
  try {
    const ca = await open(connect(3002, a, R, 'san'));
    const cb = await open(connect(3002, b, R, 'san-peer'));
    clients.push(ca, cb);
    await settle(400);
    const inputs = [
      'plain text',
      'a<b and c>d',
      '<script>alert(1)</script> hello',
      '<img src=x onerror=alert(1)> tail',
      'line1\n   line2',
      'tab\there'
    ];
    const acks = [];
    for (let i = 0; i < inputs.length; i++) acks.push(await send(ca, { room: R, text: inputs[i], clientId: `${TAG}-t12-${i}` }));
    await settle(1000);
    const stored = await history(3002, a, R);
    const peer = cb.log.newMessage.map((m) => m.text);
    const changed = inputs.map((t, i) => ({ sent: t, stored: stored[i]?.text, same: stored[i]?.text === t }));
    const lossy = changed.filter((c) => !c.same);
    record('T12', 'text sanitization round-trip',
      lossy.length === 0 ? 'PASS' : 'WARN',
      { inputs: changed.map((c) => ({ sent: c.sent.slice(0, 30), stored: String(c.stored).slice(0, 30) })),
        alteredCount: lossy.length, peerMatchesStored: peer.length === stored.length,
        verdict: lossy.length
          ? `${lossy.length} of ${inputs.length} inputs came back altered. A client that renders its own optimistic text and then re-renders the stored row shows two different strings for one message; also the sanitizer strips content the user typed.`
          : 'round-trip clean' });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T13 room switch: does the old room's state get released cleanly
 * ------------------------------------------------------------------ */
async function t13() {
  const RA = room('switch-a');
  const RB = room('switch-b');
  const stayer = await member(3002, `${TAG}-sw-stayer`, RA);
  const switcher = await member(3002, `${TAG}-sw-switcher`, RA);
  await join(3002, switcher, RB);
  const others = await member(3002, `${TAG}-sw-other`, RB);
  const clients = [];
  try {
    const cs = await open(connect(3002, stayer, RA, 'stayer-A'));
    const cw = await open(connect(3002, switcher, RA, 'switcher-A'));
    clients.push(cs, cw);
    await settle(500);
    cw.socket.emit('room:join', { room: RB });
    await settle(900);
    const ack = await send(clients[0], { room: RA, text: `after switch ${TAG}`, clientId: `${TAG}-t13` });
    await settle(900);
    const stillGetsA = cw.log.newMessage.filter((m) => m.room === RA).length;
    const presenceA = cs.log.presence.at(-1);
    const leftAnnounced = cs.log.userLeft.some((e) => e.userId === switcher.userId);
    const gotHistoryB = cw.log.history.some((h) => h.room === RB);
    record('T13', 'room switch releases old-room state',
      stillGetsA === 0 && presenceA?.onlineUsers === 1 && leftAnnounced && gotHistoryB ? 'PASS' : 'FAIL',
      { switchAckImplicit: gotHistoryB, messagesFromOldRoomStillDelivered: stillGetsA,
        oldRoomOnlineUsersAfterSwitch: presenceA?.onlineUsers, userLeftAnnounced: leftAnnounced,
        verdict: (stillGetsA || presenceA?.onlineUsers !== 1 || !leftAnnounced)
          ? 'old-room state was not fully released on switch'
          : 'clean switch' });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T14 receipts are not scoped to the room the socket is in
 * ------------------------------------------------------------------ */
async function t14() {
  const R1 = room('forge-1');
  const R2 = room('forge-2');
  const victim = await member(3003, `${TAG}-forge-victim`, R1);
  const attacker = await member(3003, `${TAG}-forge-attacker`, R2);
  const clients = [];
  try {
    const cv = await open(connect(3003, victim, R1, 'victim'));
    const ca = await open(connect(3003, attacker, R2, 'attacker'));
    clients.push(cv, ca);
    await settle(500);
    const ack = await send(cv, { room: R1, text: `private ${TAG}`, clientId: `${TAG}-t14` });
    await settle(600);
    const msgId = ack.id;
    const forgedSeen = await ackOf(ca, 'message:seen', { ids: [msgId] });
    const forgedDelivered = await ackOf(ca, 'message:delivered', { ids: [msgId] });
    await settle(900);
    const seenEvents = cv.log.seen.filter((e) => e.messageId === msgId && e.userId === attacker.userId).length;
    const stored = (await history(3003, victim, R1)).find((m) => m.id === msgId);
    const pollutedSeen = (stored?.seenBy || []).includes(attacker.userId);
    const pollutedDelivered = (stored?.deliveredTo || []).includes(attacker.userId);
    record('T14', 'receipt writes scoped to the socket room',
      !pollutedSeen && !pollutedDelivered && seenEvents === 0 ? 'PASS' : 'FAIL',
      { seenAck: forgedSeen, deliveredAck: forgedDelivered,
        seenEventsVictimReceived: seenEvents, storedSeenBy: stored?.seenBy, storedDeliveredTo: stored?.deliveredTo,
        verdict: pollutedSeen || pollutedDelivered
          ? 'a socket in room forge-2 wrote read and delivery receipts onto a message in room forge-1 and the victim saw the fake tick: markSeen/markDelivered take message ids without checking the message belongs to socket.data.room'
          : 'rejected' });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T15 media record lifetime vs message lifetime (read-path probe)
 * ------------------------------------------------------------------ */
async function t15() {
  const MemoryStore = require('../src/store/memory-store.js');
  const ChatService = require('../src/services/chat-service.js');
  const store = new MemoryStore({
    messageCacheSize: 20,
    messageHistoryMax: 20,
    sessionTtlSeconds: 3600,
    mediaTtlSeconds: 1,
    retentionSeconds: 3600
  });
  // historyPage only touches the store; the rest of the service is unused here.
  const chat = new ChatService({ store, io: null, logger: console, config: {} });
  const record0 = await store.saveMedia({ id: crypto.randomUUID(), kind: 'image', name: 'a.png', mime: 'image/png', size: 10, userId: 'u1' });
  const message = { id: crypto.randomUUID(), room: 'probe', userId: 'u1', displayName: 'p', text: 'has a file',
    attachments: [{ id: record0.id, kind: 'image', name: 'a.png', mime: 'image/png', size: 10 }],
    content: null, kind: 'text', clientId: null, ts: Date.now(), serverId: 'probe' };
  await store.pushMessage('probe', message);
  const before = (await chat.historyPage('probe', { limit: 10 }))[0];
  await sleep(1300);
  const after = (await chat.historyPage('probe', { limit: 10 }))[0];
  const beforeFlag = before?.attachments?.[0]?.expired;
  const afterFlag = after?.attachments?.[0]?.expired;
  record('T15', 'expired media is marked, not silently advertised',
    after?.attachments?.length && afterFlag === true && beforeFlag === false ? 'PASS' : 'WARN',
    { rowsStillListedAfterExpiry: Boolean(after?.attachments?.length),
      attachmentMarkedExpiredBeforeExpiry: beforeFlag,
      attachmentMarkedExpiredAfterExpiry: afterFlag,
      attachmentAfterExpiry: after?.attachments?.[0],
      verdict: after?.attachments?.length && afterFlag !== true
        ? 'the media record expired while the message that cites it stayed in history and the read path still presents the file as resolvable: nothing marks it, so old chats carry permanently broken files that look intact.'
        : 'the read path annotates the attachment as expired, so the client can show it is gone instead of requesting bytes that are not there' });
}

/* ------------------------------------------------------------------ *
 * T16 session expiry vs an already-open socket (70s wait)
 * ------------------------------------------------------------------ */
async function t16() {
  const R = room('expiry');
  const a = await member(3005, `${TAG}-expiry`, R);
  const peer = await member(3005, `${TAG}-expiry-peer`, R);
  const clients = [];
  try {
    const ca = await open(connect(3005, a, R, 'expiry'));
    const cp = await open(connect(3005, peer, R, 'expiry-peer'));
    clients.push(ca, cp);
    await settle(500);
    const before = await send(ca, { room: R, text: `before expiry ${TAG}`, clientId: `${TAG}-t16a` });
    console.log('  ... waiting 70s for SESSION_TTL_S=60 to lapse');
    await sleep(70000);
    const httpAfter = await api(3005, `/api/rooms/${R}/messages`, { headers: auth(a) });
    const after = await send(ca, { room: R, text: `after expiry ${TAG}`, clientId: `${TAG}-t16b` });
    await settle(900);
    const peerGot = cp.log.newMessage.filter((m) => m.text === `after expiry ${TAG}`).length;
    const revocable = httpAfter.status === 401 && after.ok === false;
    record('T16', 'session revocation reaches live sockets',
      revocable ? 'PASS' : 'FAIL',
      { httpAfterExpiry: httpAfter.status, socketSendAfterExpiry: after, peerReceivedAfterExpiry: peerGot,
        verdict: revocable
          ? 'expired session rejected on both paths'
          : `HTTP rejects the expired session (${httpAfter.status}) but the open socket kept writing: identity is cached on socket.data at handshake and never re-checked, so an expired or revoked session keeps sending and receiving for as long as the TCP connection lives` });
  } finally { await closeAll(clients); }
}

/* ------------------------------------------------------------------ *
 * T17 can a client reach every stored row? (join page + cursor walk)
 * ------------------------------------------------------------------ */
async function t17() {
  const R = room('page');
  const a = await member(3002, `${TAG}-page`, R);
  for (let i = 0; i < 60; i++) {
    await api(3002, `/api/rooms/${R}/messages`, {
      method: 'POST', headers: auth(a), body: JSON.stringify({ text: `row-${i}`, clientId: `${TAG}-t17-${i}` })
    });
  }
  const c = await open(connect(3002, a, R, 'page'));
  await settle(900);
  const joinPage = c.log.history.at(-1)?.messages || [];

  // What the browser does after joining: page back with the oldest seq held.
  // The socket only ever delivers the first page, so this is the reachability
  // test - the join page's size on its own says nothing.
  const reached = new Set(joinPage.map((m) => m.seq));
  let cursor = Math.min(...joinPage.map((m) => m.seq));
  let pages = 1;
  while (pages < 20) {
    const res = await api(3002, `/api/rooms/${R}/messages?limit=50&before=${cursor}`, { headers: auth(a) });
    const older = res.body?.messages || [];
    if (!older.length) break;
    for (const m of older) reached.add(m.seq);
    cursor = Math.min(...older.map((m) => m.seq));
    pages += 1;
  }
  const total = (await api(3002, `/api/rooms/${R}/messages?limit=200`, { headers: auth(a) })).body.messages.length;
  const seqs = [...reached].sort((x, y) => x - y);
  const contiguous = seqs.length === total && seqs.every((s, i) => s === seqs[0] + i);
  record('T17', 'history reachability: join page then cursor walk',
    contiguous && joinPage.length === Math.min(50, total) ? 'PASS' : 'WARN',
    { rowsInStore: total, rowsOnSocketJoinPage: joinPage.length, pagesWalked: pages,
      rowsReachedAfterWalking: seqs.length, oldestReached: seqs[0], newestReached: seqs.at(-1),
      seqsContiguousNoGapsOrRepeats: contiguous,
      verdict: contiguous
        ? `the join page is the newest ${joinPage.length} rows and the cursor walk reaches the rest: every one of the ${total} stored rows is reachable, in seq order, with no gaps and no row served twice`
        : `paging did not cover the store: ${seqs.length} of ${total} rows reached, and the seq set is ${seqs.length === total ? '' : 'in'}complete` });
  await closeAll([c]);
}

/* ------------------------------------------------------------------ *
 * T18 a rotated code is dead on every replica, and the socket path
 * admits seats through the roster rather than because it was asked
 * ------------------------------------------------------------------ */
async function t18() {
  const R = room('rotate');
  const owner = await member(3000, `${TAG}-rot-owner`, R);
  const oldCode = inviteCodes.get(R);

  const rotated = await api(3000, `/api/rooms/${R}/invite`, { method: 'POST', headers: auth(owner), body: '{}' });
  const newCode = rotated.body.inviteCode;
  inviteCodes.set(R, newCode);

  const stranger = await newSession(3001, `${TAG}-rot-stranger`);
  const attempt = (s, credential) => api(3001, `/api/rooms/${R}/access`, {
    method: 'POST', headers: auth(s), body: JSON.stringify({ credential })
  });
  const stale = await attempt(stranger, oldCode);
  const fresh = await attempt(stranger, newCode);
  const notOwner = await api(3000, `/api/rooms/${R}/invite`, { method: 'POST', headers: auth(stranger), body: '{}' });

  // The room is at capacity now, so a socket that presents the live code for a
  // seat that is not free has to be refused by the handshake, not waved through
  // because it arrived before the first packet.
  const fourth = await newSession(3001, `${TAG}-rot-fourth`);
  const c = connect(3001, fourth, R, 'rot-full');
  let joinAck = null;
  try {
    await open(c);
    await settle(700);
    joinAck = await ackOf(c, 'room:join', { room: R, credential: newCode });
  } catch (err) {
    joinAck = { ok: false, error: String(err.message) };
  }
  const refusedByHandshake = c.log.system.some((e) => e.reason === 'room_is_full');
  const pageArrived = c.log.history.some((h) => h.room === R);
  await closeAll([c]);

  const clean = rotated.status < 300 && newCode !== oldCode
    && stale.status === 403 && stale.body.error === 'invalid_pairing_code'
    && fresh.status < 300 && fresh.body.role === 'guest'
    && notOwner.status === 403 && notOwner.body.error === 'not_room_owner'
    && refusedByHandshake && !pageArrived && joinAck?.ok === false && joinAck.error === 'room_is_full';
  record('T18', 'code rotation and socket-path admission across instances',
    clean ? 'PASS' : 'FAIL',
    { rotate: { status: rotated.status, changed: newCode !== oldCode },
      staleCodeOnPeer: { status: stale.status, error: stale.body.error },
      freshCodeOnPeer: { status: fresh.status, role: fresh.body.role },
      rotateByNonOwner: { status: notOwner.status, error: notOwner.body.error },
      handshakeFullRoom: { refusedByHandshake, historyPageArrived: pageArrived, roomJoinAck: joinAck },
      verdict: clean
        ? 'the retired code is dead on the replica that never saw the rotation, only the owner can hand one out, and a socket reaching a full room is refused with a reason instead of silently given a page'
        : `roster rules are not holding on every path: ${JSON.stringify({ stale: stale.body, fresh: fresh.body, notOwner: notOwner.body, joinAck })}` });
}

const suites = { t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12, t13, t14, t15, t16, t17, t18 };

const chosen = SUITE === 'all' ? Object.keys(suites) : SUITE.split(',');
for (const key of chosen) {
  try { await suites[key](); } catch (err) { record(key.toUpperCase(), key, 'ERROR', { message: String(err.message || err) }); }
}

console.log('\n=== SUMMARY ' + TAG + ' ===');
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.id} ${r.name}`);
const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
console.log(`counts: ${JSON.stringify(counts)}`);
await sleep(200);
process.exit(0);
