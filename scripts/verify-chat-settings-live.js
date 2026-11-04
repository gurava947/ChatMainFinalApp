'use strict';

/**
 * Verifies the P2 chat settings against a running server, the way two guests on
 * two devices actually use them. Run with: node scripts/verify-chat-settings-live.js [baseUrl]
 */

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';

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

async function api(method, path, { session, body } = {}) {
  // The app rate-limits writes per client, and this script makes many of them in
  // one minute, so honouring the advertised retry window keeps the run honest.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(session ? { 'X-Session-Id': session } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await response.json().catch(() => null);
    if (response.status === 429 && json?.retryAfterMs && attempt < 4) {
      await new Promise((resolve) => { setTimeout(resolve, Number(json.retryAfterMs) + 250); });
      continue;
    }
    return { status: response.status, json };
  }
}

async function sessionFor(displayName) {
  const res = await api('POST', '/api/sessions', { body: { displayName } });
  if (res.status !== 201) throw new Error(`could not create session: ${JSON.stringify(res.json)}`);
  return res.json.userId;
}

async function send(room, session, text) {
  const res = await api('POST', `/api/rooms/${room}/messages`, { session, body: { text, clientId: crypto.randomUUID() } });
  if (res.status !== 201) throw new Error(`send failed: ${JSON.stringify(res.json)}`);
  return res.json.id;
}

const texts = (rows) => rows.map((row) => row.text);

async function main() {
  console.log(`\nChat settings against ${BASE}\n`);

  const room = `p2-live-${Date.now()}`;
  const [ana, ben] = await Promise.all([sessionFor('Vindhya'), sessionFor('Guru')]);

  await send(room, ana, 'ana one');
  await send(room, ana, 'ana two');
  const benId = await send(room, ben, 'ben one');

  const both = await api('GET', `/api/rooms/${room}/messages`, { session: ana });
  check('both guests see the full room to start', texts(both.json.messages).length === 3);

  const emptySettings = await api('GET', `/api/rooms/${room}/settings`, { session: ben });
  check('settings start empty for a fresh viewer',
    emptySettings.status === 200 && emptySettings.json.theme === 'default' && emptySettings.json.clearedAt === 0);

  const blocked = await api('POST', '/api/me/blocks', { session: ben, body: { userId: ana, displayName: 'Vindhya' } });
  check('blocking a guest is stored for the blocker', blocked.status === 201 && blocked.json.blocked.length === 1);

  const benView = await api('GET', `/api/rooms/${room}/messages`, { session: ben });
  const anaView = await api('GET', `/api/rooms/${room}/messages`, { session: ana });
  check('the blocker no longer receives the blocked history', texts(benView.json.messages).join() === 'ben one');
  check('the blocked guest history is untouched', texts(anaView.json.messages).length === 3);

  const theme = await api('PUT', `/api/rooms/${room}/settings/theme`, { session: ben, body: { theme: 'sunset' } });
  const anaTheme = await api('GET', `/api/rooms/${room}/settings`, { session: ana });
  check('a chat theme applies to one viewer', theme.json.theme === 'sunset' && anaTheme.json.theme === 'default');
  check('an unknown theme is rejected',
    (await api('PUT', `/api/rooms/${room}/settings/theme`, { session: ben, body: { theme: 'neon' } })).status === 400);

  const unblocked = await api('DELETE', `/api/me/blocks/${ana}`, { session: ben });
  const benRestored = await api('GET', `/api/rooms/${room}/messages`, { session: ben });
  check('unblocking restores the blocked messages',
    unblocked.json.blocked.length === 0 && texts(benRestored.json.messages).length === 3);

  const hidden = await api('POST', `/api/rooms/${room}/messages/hide`, { session: ana, body: { ids: [benId] } });
  const anaAfterHide = await api('GET', `/api/rooms/${room}/messages`, { session: ana });
  check('delete-for-me hides only that row',
    hidden.json.hidden.includes(benId) && texts(anaAfterHide.json.messages).join() === 'ana one,ana two');
  const benAfterHide = await api('GET', `/api/rooms/${room}/messages`, { session: ben });
  check('delete-for-me cannot erase the shared room', texts(benAfterHide.json.messages).length === 3);

  await api('POST', `/api/rooms/${room}/clear`, { session: ana });
  const newId = await send(room, ben, 'after clear');
  const anaCleared = await api('GET', `/api/rooms/${room}/messages`, { session: ana });
  check('clearing hides old rows but keeps the room live', texts(anaCleared.json.messages).join() === 'after clear');

  await api('POST', `/api/rooms/${room}/messages/unhide`, { session: ana, body: { ids: [newId] } });
  const sharedDelete = await api('DELETE', `/api/rooms/${room}`, { session: ana });
  check('deleting a shared room only drops this viewer view',
    sharedDelete.json.deleted === false && sharedDelete.json.selfRoom === false);
  const benStill = await api('GET', `/api/rooms/${room}/messages`, { session: ben });
  check('the other guest keeps every message', texts(benStill.json.messages).length === 4);

  const selfRoom = (await api('GET', '/api/me/self', { session: ana })).json.room;
  const privateId = await send(selfRoom, ana, 'private note');
  const outsider = await api('DELETE', `/api/rooms/${selfRoom}`, { session: ben });
  check('another guest cannot delete your private room', outsider.status === 403);
  const selfDelete = await api('DELETE', `/api/rooms/${selfRoom}`, { session: ana });
  check('deleting your own room really empties it',
    selfDelete.json.deleted === true && selfDelete.json.removed === 1
      && (await api('GET', `/api/rooms/${selfRoom}/messages`, { session: ana })).json.messages.length === 0
      && privateId.length > 0);

  const anonymous = await api('GET', `/api/rooms/${room}/settings`);
  check('chat settings require a session', anonymous.status === 401);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
