'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const RedisStore = require('./redis-store');
const MemoryStore = require('./memory-store');

/**
 * Picks the store, and says honestly whether it is shared.
 *
 * The two backends answer the same questions with the same rules; the one thing
 * they do not share is that Redis is reachable from every process while
 * MemoryStore is reachable only from its own. Running the second one behind a
 * load balancer is the defect this module exists to make impossible to miss.
 */
function createStore(redisClients) {
  if (env.USE_MEMORY_STORE || !redisClients) {
    logger.warn(
      'using the in-memory store: state is per process, so this instance must be the only one serving traffic'
    );
    return {
      shared: false,
      store: new MemoryStore({
        messageCacheSize: env.MESSAGE_CACHE_SIZE,
        messageHistoryMax: env.MESSAGE_HISTORY_MAX,
        retentionSeconds: env.MESSAGE_RETENTION_S,
        mediaTtlSeconds: env.MEDIA_TTL_S,
        sessionTtlSeconds: env.SESSION_TTL_S
      })
    };
  }
  return {
    shared: true,
    store: new RedisStore(redisClients.primary, {
      messageCacheSize: env.MESSAGE_CACHE_SIZE,
      messageHistoryMax: env.MESSAGE_HISTORY_MAX,
      messageRetentionSeconds: env.MESSAGE_RETENTION_S,
      sessionTtlSeconds: env.SESSION_TTL_S,
      mediaTtlSeconds: env.MEDIA_TTL_S
    })
  };
}

module.exports = { createStore };
