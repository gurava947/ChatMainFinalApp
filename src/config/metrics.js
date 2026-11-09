'use strict';

const client = require('@prometheus-io/client');

/**
 * One process-wide registry. Route templates are the label value, never the
 * concrete path, so a room id cannot explode cardinality in the metrics store.
 */
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequests = new client.Counter({
  name: 'chat_http_requests_total',
  help: 'HTTP requests by method, route template and final status.',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});

const messagesSent = new client.Counter({
  name: 'chat_messages_sent_total',
  help: 'Messages accepted by the store, including duplicate client ids.',
  registers: [register]
});

const socketConnections = new client.Counter({
  name: 'chat_socket_connections_total',
  help: 'Authenticated Socket.io connections since process start.',
  registers: [register]
});

const activeSockets = new client.Gauge({
  name: 'chat_active_sockets',
  help: 'Sockets currently connected to this process.',
  registers: [register]
});

const mediaUploads = new client.Counter({
  name: 'chat_media_uploads_total',
  help: 'Media records accepted by the upload service.',
  registers: [register]
});

module.exports = {
  register,
  contentType: client.contentType,
  httpRequests,
  messagesSent,
  socketConnections,
  activeSockets,
  mediaUploads
};
