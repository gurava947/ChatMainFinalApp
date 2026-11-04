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

// Vercel names the deployment and the production alias for us. Throwing on a
// missing REDIS_URL used to turn the whole function into a 500 page, so the
// platform defaults below keep it runnable and say what was traded away.
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
  USE_MEMORY_STORE: boolFromEnv.default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  RATE_LIMIT_API_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_SEND_MAX: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_SOCKET_CONNECT_MAX: z.coerce.number().int().min(1).default(30),
  SOCKET_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15000),
  PRESENCE_TTL_MS: z.coerce.number().int().min(2000).default(45000),
  MESSAGE_CACHE_SIZE: z.coerce.number().int().min(10).default(200),
  MESSAGE_CACHE_TTL_S: z.coerce.number().int().min(60).default(3600),
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

env.INSTANCE_ID = process.env.INSTANCE_ID || process.env.HOSTNAME || `local-${process.pid}`;

// Warnings collected before the logger exists; the server logs them once it can.
env.startupWarnings = [];

if (!env.USE_MEMORY_STORE && !env.REDIS_URL) {
  if (IS_VERCEL) {
    env.USE_MEMORY_STORE = true;
    env.startupWarnings.push(
      'REDIS_URL is not set: running the in-memory store, so rooms and presence are per instance. ' +
      'Add a REDIS_URL (e.g. Upstash) to share state across function instances.'
    );
  } else {
    throw new Error('REDIS_URL is required unless USE_MEMORY_STORE=true');
  }
}

env.corsOrigins = env.CORS_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

env.uploadDir = path.resolve(process.cwd(), env.UPLOAD_DIR);

module.exports = env;
