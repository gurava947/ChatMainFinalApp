'use strict';

const http = require('node:http');

const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const env = require('./config/env');
const logger = require('./config/logger');
const { createRedisClients, ensureUp } = require('./config/redis');
const { createStore } = require('./store');
const ChatService = require('./services/chat-service');
const { createMediaService } = require('./services/media-service');
const { MEDIA_SWEEP_EVERY_MS } = require('./constants');
const { createMessageThrottle } = require('./middleware/rate-limit');
const { attachSocketHandlers } = require('./sockets');
const createApp = require('./app');

const SHUTDOWN_GRACE_MS = 10000;

/**
 * Builds the runtime without awaiting anything. A function host requires the
 * http.Server synchronously at module load, and an error thrown there is the
 * "function invocation failed" page a visitor sees, so slow work such as
 * opening the Redis pools is deferred into `ready` instead.
 */
function createRuntime(options = {}) {
  const { listen = true, server: providedServer, installSignalHandlers = listen } = options;

  const redisClients = env.USE_MEMORY_STORE ? null : createRedisClients();

  // `shared` is not decoration: it is the difference between a replica that
  // can be added to a deployment and one whose sessions, history and presence
  // live and die inside its own process.
  const { shared, store } = createStore(redisClients);
  const server = providedServer || http.createServer();

  const io = new Server(server, {
    path: '/socket.io',
    cors: {
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: !env.corsOrigins.includes('*'),
      methods: ['GET', 'POST']
    },
    pingInterval: 25000,
    pingTimeout: 20000,
    // Long-form messages are text on the wire, so the packet budget has to
    // cover the full MESSAGE_MAX_CHARS ceiling in multi-byte UTF-8.
    maxHttpBufferSize: 1e6
    // Connection-state recovery is not configured here: it needs an adapter
    // that persists missed packets, and the pub/sub Redis adapter does not.
    // The client already resyncs from history and its outbox after a drop.
  });

  const config = {
    instanceId: env.INSTANCE_ID,
    sharedStore: shared,
    historyPageSize: env.HISTORY_PAGE_SIZE,
    presenceTtlMs: env.PRESENCE_TTL_MS,
    sessionTtlSeconds: env.SESSION_TTL_S,
    uploadDir: env.uploadDir,
    mediaMaxBytes: env.MEDIA_MAX_BYTES,
    mediaMaxPerMessage: env.MEDIA_MAX_PER_MESSAGE,
    mediaTtlSeconds: env.MEDIA_TTL_S,
    mediaSweepEveryMs: MEDIA_SWEEP_EVERY_MS
  };

  const media = createMediaService({ store, logger, config });
  const chat = new ChatService({ store, io, logger, config });

  if (redisClients) {
    // Attaching the adapter replaces it, and a replacement forgets the rooms
    // sockets joined under the old one, so this happens before any connection
    // can be accepted. The pub/sub handles queue their own commands until the
    // sockets are open, which keeps the module load synchronous.
    io.adapter(createAdapter(redisClients.pub, redisClients.sub, { key: 'chat-socketio' }));
    logger.info('socket.io redis adapter enabled: rooms are shared across replicas');
  } else {
    logger.warn('socket.io running with the in-memory adapter: single replica only');
  }

  const storeHandles = redisClients
    ? [redisClients.primary, redisClients.limiter, redisClients.pub, redisClients.sub]
    : [];
  // Called per request, and cheap when everything is already up: a one-shot
  // readiness promise would latch a cold-start failure and keep answering 503
  // for the whole life of the instance.
  const ensureStore = storeHandles.length
    ? () => Promise.all(storeHandles.map((client) => ensureUp(client)))
    : null;

  const storeReady = ensureStore ? ensureStore() : Promise.resolve();

  const app = createApp({
    chat,
    store,
    redis: redisClients && redisClients.limiter,
    media,
    logger,
    env,
    ensureStore,
    io
  });
  server.on('request', app);

  const stopHeartbeat = attachSocketHandlers(io, {
    chat,
    store,
    io,
    logger,
    env,
    config,
    ensureStore,
    throttleMessage: createMessageThrottle({
      store,
      limit: env.RATE_LIMIT_SEND_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS
    })
  });

  chat.startSweep();
  const stopMediaSweep = media.startSweep();

  const ready = storeReady;

  let shuttingDown = false;
  const finish = async () => {
    if (finish.ran) return;
    finish.ran = true;
    stopHeartbeat();
    stopMediaSweep();
    chat.stopSweep();
    if (redisClients) await redisClients.close();
    logger.info('shutdown complete');
    if (listen) process.exit(0);
  };

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown started, draining connections');

    // Long-lived sockets should not be able to stall the pod's exit.
    setTimeout(finish, SHUTDOWN_GRACE_MS).unref();

    io.close();
    server.close(finish);
  };

  if (installSignalHandlers) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });
  } else {
    // Nothing else holds this promise on a function host, so the rejection has
    // to be consumed. It is not an outage: a frozen isolate closes the pools,
    // and every request re-checks them through `ensureStore` before it reads
    // or writes. Logging this as an error would report a failure the app has
    // already designed around.
    ready.catch((err) => logger.warn({ err }, 'store warm-up incomplete, first request will reconnect'));
  }

  return { server, io, app, store, shared, chat, media, ready, shutdown };
}

async function bootstrap() {
  const runtime = createRuntime({});
  await runtime.ready;
  await new Promise((resolve) => runtime.server.listen(env.PORT, '0.0.0.0', resolve));
  logger.info({ port: env.PORT, instance: env.INSTANCE_ID }, 'groupchat listening');
  return runtime;
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.fatal({ err }, 'failed to start');
    process.exit(1);
  });
}

module.exports = { bootstrap, createRuntime };
