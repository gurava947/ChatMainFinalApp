'use strict';

/**
 * Vercel entry point. The platform takes the exported http.Server and routes
 * both plain requests and WebSocket upgrades through it, which means this
 * module must load synchronously and must not throw: a failure here is the
 * "FUNCTION_INVOCATION_FAILED" page a visitor sees. All slow startup work is
 * therefore deferred into `runtime.ready` by createRuntime().
 *
 * vercel.json rewrites every path onto this function and Vercel keeps the
 * original request path in req.url, so the Express app sees the routes it was
 * written for and the Socket.io handshake still arrives on /socket.io.
 */
const { createRuntime } = require('../src/server');

const runtime = createRuntime({ listen: false });

module.exports = runtime.server;
