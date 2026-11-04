'use strict';

/**
 * Verifies the P3 profile (note + picture) against a running server, the way two
 * guests on two devices actually see each other. Run with:
 *   node scripts/verify-profile-live.js [baseUrl]
 */

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';

// A 1x1 PNG, so the upload is a real image the server can type-sniff.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

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

async function send(method, path, { session, json, form } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(session ? { 'X-Session-Id': session } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {})
      },
      body: json ? JSON.stringify(json) : form
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 429 && payload?.retryAfterMs && attempt < 4) {
      await new Promise((resolve) => { setTimeout(resolve, Number(payload.retryAfterMs) + 250); });
      continue;
    }
    return { status: response.status, payload };
  }
}

async function signIn(displayName) {
  const { status, payload } = await send('POST', '/api/sessions', { json: { displayName } });
  if (status !== 200 && status !== 201) throw new Error(`sign-in failed for ${displayName}: ${status}`);
  return payload;
}

async function uploadPicture(session, bytes, name, type) {
  const form = new FormData();
  form.append('files', new Blob([bytes], { type }), name);
  return send('PUT', '/api/me/avatar', { session, form });
}

async function readBytes(url) {
  const response = await fetch(`${BASE}${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, type: response.headers.get('content-type'), body };
}

async function main() {
  console.log(`\nProfile checks against ${BASE}\n`);

  const owner = await signIn('Priya');
  const viewer = await signIn('Rahul');

  const fresh = await send('GET', '/api/me/profile', { session: owner.userId });
  check('a new guest has a profile document with no note and no picture',
    fresh.status === 200 && fresh.payload.profile.userId === owner.userId
    && !fresh.payload.profile.avatar && !fresh.payload.profile.note.text, fresh.payload);

  const first = await uploadPicture(owner.userId, PNG, 'first.png', 'image/png');
  const firstUrl = first.payload?.avatar?.url;
  check('uploading an image publishes a picture url',
    first.status === 201 && typeof firstUrl === 'string' && firstUrl.startsWith('/media/'), first.payload);

  const withPicture = await send('GET', '/api/me/profile', { session: owner.userId });
  check('the profile now reports the picture and when it changed',
    withPicture.payload.profile.avatar.url === firstUrl
    && Number.isFinite(withPicture.payload.profile.avatar.updatedAt), withPicture.payload);

  const bytes = await readBytes(firstUrl);
  check('the picture bytes are served with the server-side type',
    bytes.status === 200 && bytes.type === 'image/png' && bytes.body.equals(PNG),
    { status: bytes.status, type: bytes.type, size: bytes.body.length });

  const noteWithPicture = await send('PUT', '/api/me/note', { session: owner.userId, json: { text: 'Shipping a chat app.' } });
  const both = await send('GET', '/api/me/profile', { session: owner.userId });
  check('the note and the picture live in one profile, neither overwrites the other',
    noteWithPicture.status === 200 && both.payload.profile.note.text === 'Shipping a chat app.'
    && both.payload.profile.avatar.url === firstUrl, both.payload);

  const looked = await send('GET', `/api/profiles?ids=${owner.userId}`, { session: viewer.userId });
  const row = looked.payload?.profiles?.[0];
  check('another guest can look the picture up',
    looked.status === 200 && row?.userId === owner.userId && row?.displayName === 'Priya'
    && row?.avatar?.url === firstUrl, looked.payload);

  const second = await uploadPicture(owner.userId, PNG, 'second.png', 'image/png');
  const secondUrl = second.payload?.avatar?.url;
  const replaced = await readBytes(firstUrl);
  check('changing the picture retires the previous file',
    typeof secondUrl === 'string' && secondUrl !== firstUrl && replaced.status === 404,
    { firstStatus: replaced.status, secondUrl });

  const notAnImage = await uploadPicture(owner.userId, Buffer.from('just text'), 'notes.txt', 'text/plain');
  check('a non-image upload is rejected with the server reason',
    notAnImage.status === 400 && /image/i.test(notAnImage.payload?.error || ''), notAnImage.payload);

  const removed = await send('DELETE', '/api/me/avatar', { session: owner.userId });
  const afterRemove = await send('GET', '/api/me/profile', { session: owner.userId });
  const goneBytes = await readBytes(secondUrl);
  check('removing the picture clears the pointer and deletes the file',
    removed.payload?.removed === true && afterRemove.payload.profile.avatar === null
    && goneBytes.status === 404, { removed: removed.payload, profile: afterRemove.payload.profile, bytes: goneBytes.status });

  const noteSurvives = await send('GET', '/api/me/profile', { session: owner.userId });
  check('removing the picture leaves the about note alone',
    noteSurvives.payload.profile.note.text === 'Shipping a chat app.', noteSurvives.payload);

  const doubleRemove = await send('DELETE', '/api/me/avatar', { session: owner.userId });
  check('removing a picture that is already gone reports false instead of failing',
    doubleRemove.status === 200 && doubleRemove.payload?.removed === false, doubleRemove.payload);

  const stranger = await send('GET', '/api/profiles?ids=00000000-0000-4000-8000-000000000000', { session: viewer.userId });
  check('an unknown id comes back empty rather than invented',
    stranger.status === 200 && stranger.payload.profiles[0].displayName === null
    && stranger.payload.profiles[0].avatar === null, stranger.payload);

  const anonymous = await send('GET', '/api/profiles?ids=' + owner.userId);
  check('profile lookup needs a session', anonymous.status === 401, anonymous.payload);

  const junkIds = await send('GET', '/api/profiles?ids=not-a-uuid', { session: viewer.userId });
  check('profile lookup rejects ids it cannot trust', junkIds.status === 400, junkIds.payload);

  const oversizedList = await send('GET',
    `/api/profiles?ids=${Array.from({ length: 61 }, () => viewer.userId).join(',')}`, { session: viewer.userId });
  check('the batch lookup is capped, not unlimited', oversizedList.status === 400, oversizedList.status);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
