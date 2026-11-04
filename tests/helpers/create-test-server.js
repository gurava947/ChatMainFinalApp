'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const { Server } = require('socket.io');

const env = require('../../src/config/env');
const logger = require('../../src/config/logger');
const MemoryStore = require('../../src/store/memory-store');
const ChatService = require('../../src/services/chat-service');
const { createMediaService } = require('../../src/services/media-service');
const createApp = require('../../src/app');
const { attachSocketHandlers } = require('../../src/sockets');
const { createMessageThrottle } = require('../../src/middleware/rate-limit');

async function createTestServer(overrides = {}) {
  const store = new MemoryStore({ messageCacheSize: env.MESSAGE_CACHE_SIZE, mediaTtlSeconds: 3600 });
  const server = http.createServer();
  const io = new Server(server, { path: '/socket.io', cors: false });

  const uploadDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'groupchat-test-'));

  const config = {
    instanceId: 'test-instance',
    messageCacheSize: env.MESSAGE_CACHE_SIZE,
    presenceTtlMs: env.PRESENCE_TTL_MS,
    sessionTtlSeconds: env.SESSION_TTL_S,
    uploadDir,
    mediaMaxBytes: overrides.mediaMaxBytes || 5 * 1024 * 1024,
    mediaMaxPerMessage: overrides.mediaMaxPerMessage || 3,
    mediaTtlSeconds: 3600,
    mediaSweepEveryMs: 600000
  };

  const media = createMediaService({ store, logger, config });
  const chat = new ChatService({ store, io, logger, config });
  const stopHeartbeat = attachSocketHandlers(io, {
    chat,
    store,
    io,
    logger,
    env,
    config,
    throttleMessage: createMessageThrottle({ store, limit: overrides.sendLimit || 1000, windowMs: 60000 })
  });

  const app = createApp({ chat, store, redis: undefined, media, logger, env, io });
  server.on('request', app);
  chat.startSweep();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    app,
    io,
    store,
    chat,
    media,
    url,
    uploadDir,
    async authorizeRoomForTest(userId, room, password = 'InChatTestPassword!') {
      const session = await chat.getSession(userId);
      if (!session) throw new Error(`test session ${userId} does not exist`);
      return chat.authorizeRoom(session, room, password);
    },
    async close() {
      stopHeartbeat();
      chat.stopSweep();
      io.close();
      await new Promise((resolve) => server.close(resolve));
      await fsp.rm(uploadDir, { recursive: true, force: true });
    }
  };
}

module.exports = { createTestServer };
