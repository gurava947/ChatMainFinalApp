'use strict';

const express = require('express');

/**
 * Liveness answers from the process alone: a flaky Redis must not make the
 * kubelet restart an otherwise healthy pod. Readiness does check the store,
 * so a pod without cache access is pulled out of the service rotation.
 *
 * `sharedStore` is reported on purpose. A deployment that came up on the
 * in-memory store is healthy and ready and still wrong: two pods would be two
 * separate chats, and an operator reading only "ok" would never notice.
 */
function healthRouter({ store, logger, env }) {
  const router = express.Router();

  router.get('/healthz', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      instance: env.INSTANCE_ID,
      sharedStore: env.sharedStore
    });
  });

  router.get('/readyz', async (req, res) => {
    try {
      const alive = await store.ping();
      if (!alive) throw new Error('store not reachable');
      res.status(200).json({ status: 'ready', store: 'ok', sharedStore: env.sharedStore });
    } catch (err) {
      logger.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'not_ready' });
    }
  });

  return router;
}

module.exports = healthRouter;
