'use strict';

const SESSION_COOKIE = 'inchat_session';

/** Parses a Cookie header into a plain map; the first value for a name wins. */
function parseCookieHeader(header) {
  const jar = {};
  if (!header || typeof header !== 'string') return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.hasOwn(jar, name)) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      jar[name] = value;
    }
  }
  return jar;
}

/** The cookie carries both halves of the credential; neither is secret to the browser. */
function sessionCookie(value, { maxAgeSeconds, secure }) {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) attributes.push('Secure');
  return `${SESSION_COOKIE}=${value}; ${attributes.join('; ')}`;
}

/** Splits `userId.sessionToken`; a base64url token never contains a dot. */
function parseSessionCookie(value) {
  if (typeof value !== 'string') return null;
  const index = value.indexOf('.');
  if (index <= 0 || index === value.length - 1) return null;
  return { userId: value.slice(0, index), sessionToken: value.slice(index + 1) };
}

module.exports = { SESSION_COOKIE, parseCookieHeader, parseSessionCookie, sessionCookie };
