'use strict';

const { parseCookieHeader, parseSessionCookie, sessionCookie } = require('../../src/utils/cookies');

describe('cookie parsing', () => {
  test('reads every pair and ignores malformed parts', () => {
    expect(parseCookieHeader('a=1; b=two; broken; c=%3D')).toEqual({ a: '1', b: 'two', c: '=' });
  });

  test('keeps the first value for a repeated name', () => {
    expect(parseCookieHeader('sid=first; sid=second')).toEqual({ sid: 'first' });
  });

  test('tolerates a missing header', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  test('unescapes a quoted value and survives bad percent-encoding', () => {
    expect(parseCookieHeader('a="quoted"; b=%E0%A4%A')).toEqual({ a: 'quoted', b: '%E0%A4%A' });
  });
});

describe('session cookie value', () => {
  test('splits on the only dot between the two halves', () => {
    expect(parseSessionCookie('uid-1.token_part-2')).toEqual({ userId: 'uid-1', sessionToken: 'token_part-2' });
  });

  test('rejects values that cannot carry both halves', () => {
    expect(parseSessionCookie('no-dot')).toBeNull();
    expect(parseSessionCookie('.token')).toBeNull();
    expect(parseSessionCookie('userId.')).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
  });
});

describe('Set-Cookie attributes', () => {
  test('always locks the cookie down and adds Secure for TLS', () => {
    const value = sessionCookie('u.t', { maxAgeSeconds: 60, secure: true });
    expect(value).toBe('inchat_session=u.t; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure');
  });

  test('a cleared cookie expires immediately', () => {
    expect(sessionCookie('', { maxAgeSeconds: 0, secure: false }))
      .toBe('inchat_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  });
});
