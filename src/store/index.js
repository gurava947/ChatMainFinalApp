'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const RedisStore = require('./redis-store');
const MemoryStore = require('./memory-store');

function createStore(redisClients) {
  if (env.USE_MEMORY_STORE || !redisClients) {
    logger.warn('using in-memory store: no cross-replica sharing, disable for production');
    return new MemoryStore({
      messageCacheSize: env.MESSAGE_CACHE_SIZE,
      mediaTtlSeconds: env.MEDIA_TTL_S
    });
  }
  return new RedisStore(redisClients.primary, {
    messageCacheSize: env.MESSAGE_CACHE_SIZE,
    messageCacheTtlSeconds: env.MESSAGE_CACHE_TTL_S,
    sessionTtlSeconds: env.SESSION_TTL_S,
    mediaTtlSeconds: env.MEDIA_TTL_S
  });
}

module.exports = { createStore };
