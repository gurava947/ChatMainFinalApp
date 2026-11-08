'use strict';

require('dotenv').config();
const path = require('node:path');
const { z } = require('zod');

const IS_VERCEL = process.env.VERCEL === '1';

// Render publishes each web service's public host as RENDER_EXTERNAL_HOSTNAME.
// Browsers send an Origin header on the WebSocket handshake, so an allowlist
// that does not contain it rejects every socket; deriving it here means one
// less value to copy into a dashboard.
if (!process.env.CORS_ORIGIN && process.env.RENDER_EXTERNAL_HOSTNAME) {
  process.env.CORS_ORIGIN = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
}

// Vercel names the deployment and the production alias for us. These are the
// platform defaults that are safe to derive; REDIS_URL is deliberately not one
// of them - see the shared-store gate below.
if (IS_VERCEL) {
  const hosts = [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL]
    .filter(Boolean)
    .map((host) => `https://${host}`);
  if (!process.env.CORS_ORIGIN && hosts.length) process.env.CORS_ORIGIN = [...new Set(hosts)].join(',');
  if (!process.env.UPLOAD_DIR) process.env.UPLOAD_DIR = '/tmp/uploads';
  if (!process.env.MEDIA_MAX_BYTES) process.env.MEDIA_MAX_BYTES = '4000000';
}

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || (typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.string().default('http://localhost:8080'),
  REDIS_URL: z.string().optional(),
  TURN_URLS: z.preprocess((value) => value === '' ? undefined : value, z.string().optional()),
  TURN_SHARED_SECRET: z.preprocess((value) => value === '' ? undefined : value, z.string().min(16).optional()),
  USE_MEMORY_STORE: boolFromEnv.default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  RATE_LIMIT_API_MAX: z.coerce.number().int().min(1).default(120),
  /**
   * Session creations per IP per window. Once the limiter runs on Redis this
   * bucket is shared by every replica, so everyone behind one NAT or one proxy
   * draws on the same allowance - which makes it a knob to turn, not a constant
   * to recompile.
   */
  RATE_LIMIT_SESSION_MAX: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_SEND_MAX: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_SOCKET_CONNECT_MAX: z.coerce.number().int().min(1).default(30),
  SOCKET_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15000),
  PRESENCE_TTL_MS: z.coerce.number().int().min(2000).default(45000),
  MESSAGE_CACHE_SIZE: z.coerce.number().int().min(10).default(200),
  /**
   * Rows a room keeps and how long they survive without traffic. The cache size
   * is what a scan may walk; these two are what history can page back to, so a
   * quiet room is not allowed to expire its whole conversation.
   */
  MESSAGE_HISTORY_MAX: z.coerce.number().int().min(10).default(1000),
  MESSAGE_RETENTION_S: z.coerce.number().int().min(300).default(30 * 24 * 3600),
  HISTORY_PAGE_SIZE: z.coerce.number().int().min(10).max(200).default(50),
  SESSION_TTL_S: z.coerce.number().int().min(60).default(43200),
  UPLOAD_DIR: z.string().min(1).default('uploads'),
  MEDIA_MAX_BYTES: z.coerce.number().int().min(1024).default(50 * 1024 * 1024),
  MEDIA_MAX_PER_MESSAGE: z.coerce.number().int().min(1).max(10).default(5),
  MEDIA_TTL_S: z.coerce.number().int().min(300).default(7 * 24 * 3600),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const env = parsed.data;

if (env.TURN_URLS && !env.TURN_SHARED_SECRET) {
  throw new Error('TURN_SHARED_SECRET is required when TURN_URLS is configured.');
}
if (!env.TURN_URLS && env.TURN_SHARED_SECRET) {
  throw new Error('TURN_URLS is required when TURN_SHARED_SECRET is configured.');
}
if (env.TURN_URLS && env.TURN_URLS.split(',').some((url) => !/^turns?:/i.test(url.trim()))) {
  throw new Error('TURN_URLS must be a comma-separated list of turn: or turns: URLs.');
}

env.INSTANCE_ID = process.env.INSTANCE_ID || process.env.HOSTNAME || `local-${process.pid}`;

/**
 * An Upstash database hands out two credentials for two protocols, and only one
 * of them works here. REST answers HTTP requests, so it cannot subscribe - which
 * rules out the Socket.io adapter - and it cannot hold a connection long enough
 * to be the shared roster either. The REST pair is what a dashboard offers
 * first, so a deploy that copies it boots with its variables set and still has
 * no store: every request then fails on a line that never mentions them.
 */
const UPSTASH_REST_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];

if (!env.REDIS_URL && UPSTASH_REST_KEYS.some((key) => process.env[key])) {
  throw new Error(
    'REDIS_URL is missing, and the Upstash REST variables are not a substitute. '
    + 'Set REDIS_URL to the Redis (TCP) connection string from the same Upstash database - '
    + 'rediss://default:<password>@<database>.upstash.io:6379. REST cannot carry the '
    + 'pub/sub the Socket.io adapter needs, so ioredis is the only supported client here.'
  );
}

/**
 * The other way the same mistake arrives: the REST URL pasted into the right
 * variable. ioredis would fail on the first command rather than at boot, so the
 * scheme is checked where the rest of the configuration is.
 */
if (env.REDIS_URL && /^https?:\/\//i.test(env.REDIS_URL)) {
  throw new Error(
    'REDIS_URL has to be a redis:// or rediss:// connection string, not an http(s):// endpoint. '
    + 'For Upstash, use the Redis URL (rediss://default:<password>@<database>.upstash.io:6379) '
    + 'rather than the REST URL shown next to it.'
  );
}

/**
 * A room's two seats are one compare-and-set record, so the cap only means
 * anything if every replica reads the same one. With the in-memory store each
 * isolate keeps its own roster: two isolates is four seats, and a guest who
 * was refused on one gets in on the next. Silently falling back used to keep a
 * misconfigured deploy serving traffic while quietly breaking the one rule
 * that makes rooms private, so production refuses to boot instead. It is loud
 * on purpose - a cold start that throws is a signal, a room that admits a
 * third person is a vulnerability nobody sees.
 */
if (env.NODE_ENV === 'production' && !env.REDIS_URL) {
  throw new Error(
    'REDIS_URL is required in production. Without a shared store each instance holds its own rooms, '
    + 'so the two-seat cap is per-process and a guest can pair into a room that is already full. '
    + 'Set REDIS_URL, or run with NODE_ENV=development USE_MEMORY_STORE=true to try it locally.'
  );
}

if (!env.USE_MEMORY_STORE && !env.REDIS_URL) {
  throw new Error('REDIS_URL is required unless USE_MEMORY_STORE=true');
}

/**
 * Whether another process can see what this one writes. Everything that could
 * mislead an operator or a test reports this instead of assuming: `/healthz`,
 * the socket hello, and the store selection itself.
 */
env.sharedStore = !env.USE_MEMORY_STORE;

env.corsOrigins = env.CORS_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

env.uploadDir = path.resolve(process.cwd(), env.UPLOAD_DIR);

module.exports = env;
