'use strict';

const request = require('supertest');

const sessionTokens = new Map();

function rememberSession(session) {
  if (session && typeof session.userId === 'string' && typeof session.sessionToken === 'string') {
    sessionTokens.set(session.userId, session.sessionToken);
  }
  return session;
}

function sessionHeaders(userId) {
  const sessionToken = sessionTokens.get(userId);
  return {
    'X-Session-Id': userId,
    ...(sessionToken ? { 'X-Session-Token': sessionToken } : {})
  };
}

function getSessionToken(userId) {
  return sessionTokens.get(userId);
}

async function createSession(app, displayName) {
  const response = await request(app)
    .post('/api/sessions')
    .set('X-Session-Transport', 'token')
    .send({ displayName });
  if (response.status !== 201) {
    throw new Error(`session creation failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  rememberSession(response.body);
  return response.body.userId;
}

module.exports = { createSession, getSessionToken, rememberSession, sessionHeaders };
