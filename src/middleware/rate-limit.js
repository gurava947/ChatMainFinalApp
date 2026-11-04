'use strict';

const { rateLimit } = require('express-rate-limit');
const { RedisStore: RateLimitRedisStore } = require('rate-limit-redis');

function buildKeyPrefix(name) {
  return `chat:rl:${name}:`;
}

function createLimiter({ name, limit, windowMs, redis, message }) {
  const options = {
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    limit,
    windowMs,
    message: message || { error: 'rate_limited', retryAfterMs: windowMs },
    // A crashed limiter must not take the chat down with it.
    passOnStoreError: true
  };

  if (redis) {
    options.store = new RateLimitRedisStore({
      prefix: buildKeyPrefix(name),
      sendKey: false,
      // v4 of rate-limit-redis has no `client` option: it hands the command as
      // a flattened argument list and expects the reply back. ioredis exposes
      // every Redis word as a lower-cased method, so the mapping is direct.
      // Passing `client` instead throws at boot and takes the whole app down.
      sendCommand: (...command) => redis[command[0].toLowerCase()](...command.slice(1))
    });
  }

  return rateLimit(options);
}

/**
 * Socket connections bypass Express middleware, so they get their own fixed
 * window check against the shared store: every replica sees the same counter.
 */
function socketConnectGuard({ store, limit, windowMs, logger }) {
  return async function guard(socket, next) {
    const ip = socket.handshake.address;
    const bucket = `socket:${ip}`;
    try {
      const { total, remaining } = await store.consumeWindow(bucket, limit, windowMs);
      socket.data.rateRemaining = remaining;
      if (total > limit) {
        logger.warn({ ip, total, limit }, 'socket connect rate limited');
        return next(new Error('rate_limited'));
      }
    } catch (err) {
      logger.error({ err }, 'socket rate limit check failed, allowing connection');
    }
    return next();
  };
}

/** Per-socket message throttle, checked on the emit path instead of the wire. */
function createMessageThrottle({ store, limit, windowMs }) {
  return async function throttle(socket) {
    const bucket = `send:${socket.handshake.address}:${socket.data.user.userId}`;
    const result = await store.consumeWindow(bucket, limit, windowMs);
    return { allowed: result.total <= limit, ...result };
  };
}

module.exports = { createLimiter, socketConnectGuard, createMessageThrottle };
