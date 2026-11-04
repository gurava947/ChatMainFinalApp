'use strict';

const pino = require('pino');
const env = require('./env');

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token'
];

const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'groupchat', pod: process.env.HOSTNAME || 'local' },
  redact: { paths: redactPaths, censor: '[redacted]' },
  transport: env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined
});

module.exports = logger;
