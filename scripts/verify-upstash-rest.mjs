#!/usr/bin/env node
/**
 * Upstash REST capability probe.
 *
 * Answers one operator question: can the credentials in this database back this
 * application? It replays the command shapes src/store/redis-store.js actually
 * issues and reports which ones REST refuses. The verdict is deliberately about
 * capability, not credentials - a healthy PING here does not mean the app can
 * use the database, because the store pipelines and the Socket.io adapter
 * subscribes, and REST refuses both.
 *
 * Credentials come from the environment and are never printed. Probe keys live
 * under `inchat:probe:` and are removed again.
 *
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/verify-upstash-rest.mjs
 */

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error('usage: UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/verify-upstash-rest.mjs');
  process.exit(2);
}

const KEYS = ['inchat:probe:session', 'inchat:probe:roster', 'inchat:probe:history', 'inchat:probe:seq', 'inchat:probe:receipts'];

async function command(...args) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, reason: `http ${response.status}: ${text.slice(0, 90)}` };
  try {
    const parsed = JSON.parse(text);
    if (parsed.error) return { ok: false, reason: String(parsed.error).slice(0, 90) };
    return { ok: true, value: parsed.result };
  } catch {
    return { ok: false, reason: `unparsable reply: ${text.slice(0, 60)}` };
  }
}

const checks = [];

async function check(label, why, ...args) {
  const result = await command(...args);
  checks.push({ label, why, ...result });
  return result;
}

const run = async () => {
  const info = await check('PING', 'the endpoint and token work at all', 'PING');
  if (!info.ok) {
    console.error(`cannot reach the database: ${info.reason}`);
    process.exit(1);
  }

  await check('SET ... EX NX', 'session creation (src/services/chat-service.js)', 'SET', KEYS[0], 'token', 'EX', '60', 'NX');
  await check('GET', 'session read-back on every request', 'GET', KEYS[0]);
  await check('HSET + HGETALL', 'the room roster that grants access', 'HSET', KEYS[1], 'owner', 'u1', 'version', '1');
  await check('ZADD', 'presence scores and the per-room sequence', 'ZADD', KEYS[2], '1', 'm1', '2', 'm2');
  await check('ZREVRANGEBYSCORE ... LIMIT', 'history paging under a cursor', 'ZREVRANGEBYSCORE', KEYS[2], '+inf', '-inf', 'WITHSCORES', 'LIMIT', '0', '2');
  await check('INCR', 'the monotonic seq a send mints', 'INCR', KEYS[3]);
  await check('SADD', 'read receipts per message', 'SADD', KEYS[4], 'u1', 'u2');
  await check('EXPIRE', 'retention on every stored key', 'EXPIRE', KEYS[2], '60');

  const loaded = await check('SCRIPT LOAD', 'the compare-and-set that caps a room at two', 'SCRIPT', 'LOAD', 'return redis.call("GET",KEYS[1])');
  if (loaded.ok) await check('EVALSHA', 'the same script executed with its keys', 'EVALSHA', String(loaded.value), '1', KEYS[0]);
  await check('MULTI', 'pipelined sends: claim, record, release', 'MULTI');
  await check('EXEC', 'committing that pipeline', 'EXEC');
  await check('PUBLISH', 'Socket.io adapter fan-out to other replicas', 'PUBLISH', 'inchat:probe:chan', 'hi');
  await check('SUBSCRIBE', 'the listener that fan-out needs a receiver for', 'SUBSCRIBE', 'inchat:probe:chan');

  await command('DEL', ...KEYS);
};

await run();

const refused = checks.filter((c) => !c.ok);
const width = Math.max(...checks.map((c) => c.label.length));
for (const c of checks) {
  console.log(`${c.ok ? 'supports' : 'refuses '} ${c.label.padEnd(width)}  ${c.why}${c.ok ? '' : `  <- ${c.reason}`}`);
}

console.log(`\n${checks.length - refused.length} of ${checks.length} commands this app issues are available over REST.`);

const blocking = refused.filter((c) => /MULTI|EXEC|SUBSCRIBE/.test(c.label));
if (blocking.length) {
  console.log(
    `\nREST cannot run this application. ${blocking.map((c) => c.label).join(', ')} `
    + `${blocking.length === 1 ? 'is' : 'are'} refused, so the store cannot pipeline a send and the Socket.io `
    + 'adapter cannot receive. This is not a credential problem: the same database reached over TCP with '
    + 'REDIS_URL=rediss://default:<password>@<host>:6379 serves all of it. Set that variable instead; '
    + 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are read by nothing in src/.'
  );
  process.exit(1);
}

console.log('\nREST answered everything. Note that this app still requires REDIS_URL over TCP; this probe only reports capability.');
