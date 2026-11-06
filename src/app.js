'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');

const { securityHeaders } = require('./middleware/security');
const { createLimiter } = require('./middleware/rate-limit');
const { notFound, errorHandler } = require('./middleware/error-handler');
const healthRouter = require('./routes/health');
const apiRouter = require('./routes/api');
const { mediaDownloadRouter } = require('./routes/media');

// Named legacy-ui, not public: a root `public/` is served by Vercel's static
// layer ahead of the vercel.json rewrite, which would answer `/` with this old
// page instead of handing the request to the app that serves client/dist.
const PUBLIC_DIR = path.join(__dirname, '..', 'legacy-ui');
const CLIENT_DIST_DIR = path.join(__dirname, '..', 'client', 'dist');
const SOCKET_PATH = '/socket.io';

function buildCorsOptions({ origins }) {
  const allowAll = origins.includes('*');
  return {
    origin: allowAll ? true : origins,
    credentials: !allowAll,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Session-Id', 'X-Session-Token'],
    exposedHeaders: ['RateLimit', 'RateLimit-Policy'],
    maxAge: 600
  };
}

function staticCacheControl({ isProduction }) {
  // serve-static calls this as (res, path, stat).
  return (res, path) => {
    const isHtml = path.endsWith('.html');
    // HTML must always be revalidated so clients pick up new asset references.
    res.setHeader('Cache-Control', isHtml ? 'no-cache' : 'public, max-age=60, must-revalidate');
    res.setHeader('Vary', 'Accept-Encoding');
    if (isProduction) res.setHeader('X-Content-Type-Options', 'nosniff');
  };
}

function createApp({ chat, store, redis, media, logger, env, ensureStore, io }) {
  const isProduction = env.NODE_ENV === 'production';
  const app = express();
  const hasBuiltClient = env.NODE_ENV !== 'test' && fs.existsSync(path.join(CLIENT_DIST_DIR, 'index.html'));

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.locals.instanceId = env.INSTANCE_ID;

  // engine.io registers its own 'request' listener on the shared http server
  // and answers /socket.io before this chain runs. Continuing here would write
  // headers a second time, so the transport path short-circuits out of Express.
  app.use((req, _res, next) => {
    if (req.url.startsWith(SOCKET_PATH)) return undefined;
    return next();
  });

  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
    autoLogging: { ignore: (req) => req.url.startsWith('/healthz') || req.url.startsWith('/readyz') || req.url.startsWith('/media/') }
  }));

  app.use(securityHeaders({ isProduction }));
  app.use(cors(buildCorsOptions({ origins: env.corsOrigins })));
  app.use(compression());
  // A long-form message is JSON on the wire, so the body ceiling follows the
  // text ceiling rather than staying at a hand-typed 16kb.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use(healthRouter({ store, logger, env }));

  // A function host can take the first request before the Redis pool is open.
  // Health endpoints answer regardless, so a cold start is never reported as
  // an outage; routes that read state wait for it, bounded so a Redis that is
  // down returns a retryable 503 instead of hanging until the platform kills it.
  const STORE_WAIT_MS = 5000;
  const awaitStore = (req, res, next) => {
    if (!ensureStore) return next();
    const timeout = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`no store connection within ${STORE_WAIT_MS}ms`)), STORE_WAIT_MS).unref();
    });
    Promise.race([ensureStore(), timeout]).then(
      () => next(),
      (err) => {
        logger.warn({ err }, 'store not reachable yet');
        res.status(503).json({ error: 'store_unavailable' });
      }
    );
    return undefined;
  };

  const limiters = {
    global: createLimiter({
      name: 'api',
      limit: env.RATE_LIMIT_API_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      redis: redis || undefined
    }),
    sessions: createLimiter({
      name: 'session',
      limit: env.RATE_LIMIT_SESSION_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      redis: redis || undefined
    }),
    writes: createLimiter({
      name: 'write',
      limit: env.RATE_LIMIT_SEND_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      redis: redis || undefined
    }),
    reads: createLimiter({ name: 'read', limit: env.RATE_LIMIT_API_MAX * 2, windowMs: env.RATE_LIMIT_WINDOW_MS, redis: redis || undefined }),
    uploads: createLimiter({
      name: 'upload',
      limit: Math.max(5, Math.floor(env.RATE_LIMIT_SEND_MAX / 2)),
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      redis: redis || undefined
    })
  };

  app.use('/api', awaitStore, limiters.global, apiRouter({ chat, store, limiters, media, logger, io }));

  // Downloads are capability URLs, so they bypass the session guard but not
  // the limiter; media ids must not be enumerable by brute force.
  if (media) {
    app.use(
      '/media',
      awaitStore,
      createLimiter({ name: 'media', limit: env.RATE_LIMIT_API_MAX * 10, windowMs: env.RATE_LIMIT_WINDOW_MS, redis: redis || undefined }),
      mediaDownloadRouter({ media })
    );
  }

  const staticOptions = {
    etag: true,
    lastModified: true,
    setHeaders: staticCacheControl({ isProduction })
  };
  if (hasBuiltClient) app.use(express.static(CLIENT_DIST_DIR, staticOptions));
  app.use(express.static(PUBLIC_DIR, staticOptions));

  if (hasBuiltClient) {
    app.get(['/', '/updates', '/shorts', '/calls'], (_req, res) => res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
