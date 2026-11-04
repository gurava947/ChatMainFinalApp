'use strict';

const express = require('express');

/**
 * Liveness answers from the process alone: a flaky Redis must not make the
 * kubelet restart an otherwise healthy pod. Readiness does check the store,
 * so a pod without cache access is pulled out of the service rotation.
 */
function healthRouter({ store, logger }) {
  const router = express.Router();

  router.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  router.get('/readyz', async (req, res) => {
    try {
      const alive = await store.ping();
      if (!alive) throw new Error('store not reachable');
      res.status(200).json({ status: 'ready', store: 'ok' });
    } catch (err) {
      logger.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'not_ready' });
    }
  });

  return router;
}

module.exports = healthRouter;
