'use strict';

const Redis = require('ioredis');
const env = require('./env');
const logger = require('./logger');

function clientOptions(extra = {}) {
  return {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    // On a function host every command can arrive while the socket is still
    // opening: the limiter loads its Lua scripts during app wiring, and a socket
    // handler consumes its rate-limit window before the store is ready.
    // Queuing beats rejecting, which would surface as a failed send.
    enableOfflineQueue: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 3000),
    lazyConnect: true,
    ...extra
  };
}

function named(client, label) {
  client.on('error', (err) => {
    // A handle that is not connected is already retrying, which is the designed
    // recovery path; only an error raised on an open socket is a surprise.
    const level = client.status === 'ready' ? 'error' : 'warn';
    logger[level]({ err, redis: label }, 'redis error');
  });
  client.on('reconnecting', () => logger.warn({ redis: label }, 'redis reconnecting'));
  return client;
}

/**
 * Four handles on one Redis: the store, the adapter's publisher and subscriber
 * (ioredis forbids reusing a connection that is subscribed to a channel), and
 * the counter client for express-rate-limit.
 */
function createRedisClients() {
  const primary = named(new Redis(env.REDIS_URL, clientOptions()), 'primary');
  const pub = named(new Redis(env.REDIS_URL, clientOptions()), 'pub');
  const sub = named(new Redis(env.REDIS_URL, clientOptions()), 'sub');
  const limiter = named(new Redis(env.REDIS_URL, clientOptions()), 'limiter');

  return {
    primary,
    pub,
    sub,
    limiter,
    async close() {
      await Promise.all([primary, pub, sub, limiter].map((c) => c.quit().catch(() => c.disconnect())));
    }
  };
}

/**
 * How long to wait for ioredis to finish tearing a dead socket down. The close
 * event is processed on a later turn of the loop, and connect() is refused
 * until it has been; bounding the wait keeps a wedged handle from stalling the
 * request, whose own ceiling is shorter.
 */
const REOPEN_SETTLE_MS = 1000;

/**
 * True only when this handle has an open socket that could carry a command.
 *
 * `status` alone is not enough: when the platform freezes an isolate between
 * requests the socket goes away, but ioredis keeps reporting "ready" until the
 * close event is actually processed. The socket's own writability flips in the
 * same instant it dies, which makes it a free check on a path that runs for
 * every request.
 */
function isAnswering(client) {
  return client.status === 'ready' && !!client.stream && client.stream.writable === true;
}

/**
 * Ask for the socket if ioredis is not holding an open one.
 *
 * ioredis sits in "reconnecting" (or "end", once a dropped socket is noticed)
 * and every command rejects with "Connection is closed." until something asks
 * for the socket again. Re-opening on demand is what keeps a cold-start blip
 * from turning into a permanently failing instance.
 */
function connectIfNeeded(client) {
  if (client.status === 'wait' || client.status === 'end') {
    return client.connect().catch((err) => {
      // Another command already started the connect; that is the outcome we want.
      if (/already/i.test(String(err && err.message))) return;
      throw err;
    });
  }
  if (client.status === 'ready') return Promise.resolve();
  // Still opening, or already retrying: ioredis keeps trying, so wait for the
  // ready event and let the caller's own timeout bound the wait.
  return new Promise((resolve) => {
    client.once('ready', resolve);
  });
}

/**
 * Brings one lazy handle to a state where its commands can reach the server.
 *
 * A handle whose socket died but whose status has not caught up would hand that
 * failure to the next command, which surfaces as a 500 on a route that did
 * nothing wrong. Settling it here costs nothing while the connection is healthy
 * and, on the rare reopen, proves the new socket answers. What this cannot see
 * is a silently half-open socket, so the error handler still maps a mid-command
 * connection failure to a retryable 503.
 */
async function ensureUp(client) {
  if (isAnswering(client)) return;
  if (client.status !== 'ready') {
    await connectIfNeeded(client);
    return;
  }

  const settled = new Promise((resolve) => {
    client.once('end', resolve);
    setTimeout(resolve, REOPEN_SETTLE_MS).unref();
  });
  client.disconnect();
  await settled;
  await connectIfNeeded(client);
  await client.ping();
}

module.exports = { createRedisClients, ensureUp, connectIfNeeded, isAnswering };
