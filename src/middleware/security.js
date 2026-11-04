'use strict';

const helmet = require('helmet');

/**
 * CSP is scoped to this app's own assets. Socket.io needs ws/wss in
 * connect-src, and the client ships external CSS/JS only, so no
 * unsafe-inline is required.
 */
function securityHeaders({ isProduction }) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        // blob: is the local pre-upload preview; /media/* stays on 'self'.
        mediaSrc: ["'self'", 'blob:', 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: isProduction ? ["'self'", 'wss:', 'https:'] : ["'self'", 'ws:', 'wss:', 'http:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isProduction ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    noSniff: true,
    frameguard: { action: 'deny' },
    dnsPrefetchControl: true,
    ieNoOpen: true
  });
}

module.exports = { securityHeaders };
