'use strict';

process.env.NODE_ENV = 'test';
process.env.USE_MEMORY_STORE = 'true';
process.env.LOG_LEVEL = 'error';
process.env.CORS_ORIGIN = 'http://127.0.0.1';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_API_MAX = '1000';
process.env.RATE_LIMIT_SEND_MAX = '1000';
process.env.RATE_LIMIT_SOCKET_CONNECT_MAX = '1000';
