'use strict';

const env = require('../config/env');
const logger = require('../config/logger');

function notFound(req, res) {
  res.status(404).json({ error: 'not_found' });
}

/**
 * A Redis handle can fail part-way through a request: on a function host the
 * socket can be half-open when an isolate wakes, so the command is already
 * committed by the time it dies. The gate cannot see that case, and a 500 would
 * blame the route for what is a store outage, so it answers with the same
 * retryable status the gate uses.
 */
function isStoreDown(err) {
  const text = `${err && err.name} ${err && err.message}`;
  return /Connection is clos|MaxRetriesPerRequestError|ConnectionTimeoutError|Connect timeout/i.test(text)
    || ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(err && err.code);
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
function errorHandler(err, req, res, next) {
  const storeDown = isStoreDown(err);
  const status = storeDown ? 503 : err.statusCode || err.status || 500;

  if (storeDown) {
    // A dependency that is briefly gone is normal on a function host; the noise
    // is only useful if it is not filed with the bugs.
    logger.warn({ err, path: req.path }, 'store unreachable during request');
  } else if (status >= 500) {
    logger.error({ err, path: req.path }, 'unhandled request error');
  } else {
    logger.debug({ err, path: req.path }, 'request rejected');
  }

  res.status(status).json({
    error: storeDown ? 'store_unavailable' : status >= 500 ? 'internal_error' : err.message,
    ...(status >= 500 && env.NODE_ENV !== 'production' ? { detail: err.message } : {})
  });
}

module.exports = { notFound, errorHandler, isStoreDown };
