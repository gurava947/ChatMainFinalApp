'use strict';

/**
 * Which store a process boots with decides whether a room's two seats are a
 * rule or a local habit, and that decision is taken once, at load time. A
 * production deploy without a shared roster store has to fail here rather than
 * serve traffic that quietly lets a third person pair into a full room.
 */

const ENV_KEYS = [
  'NODE_ENV',
  'REDIS_URL',
  'USE_MEMORY_STORE',
  'CORS_ORIGIN',
  'VERCEL',
  'VERCEL_URL',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN'
];

/**
 * Loads the config module from scratch under the given environment and reports
 * either the parsed values or the reason it refused to. `src/config/env.js`
 * throws at require time, so the throw has to be captured instead of asserted
 * on, and the registry is reset twice so a later test file cannot inherit the
 * half-built module or the platform defaults this one writes back.
 */
function loadEnv(overrides) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  jest.resetModules();
  try {
    return { env: require('../../src/config/env'), error: null };
  } catch (error) {
    return { env: null, error };
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.resetModules();
  }
}

const SHARED = 'redis://127.0.0.1:6379';

describe('shared-store gate', () => {
  it('refuses to boot production without REDIS_URL', () => {
    const { error } = loadEnv({ NODE_ENV: 'production' });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('REDIS_URL is required in production');
    // The message has to name the consequence, not just the missing variable.
    expect(error.message).toContain('two-seat cap');
  });

  it('does not let USE_MEMORY_STORE answer for a production deploy', () => {
    const { error } = loadEnv({ NODE_ENV: 'production', USE_MEMORY_STORE: 'true' });
    expect(error.message).toContain('REDIS_URL is required in production');
  });

  /**
   * The config used to grant Vercel an in-memory fallback, which is exactly the
   * platform where instances are ephemeral and numerous. Platform detection may
   * still derive host names; it may no longer pick the store.
   */
  it('gives a serverless platform no exemption from the gate', () => {
    const { error } = loadEnv({ NODE_ENV: 'production', VERCEL: '1', VERCEL_URL: 'inchat.vercel.app' });
    expect(error.message).toContain('REDIS_URL is required in production');
  });

  it('boots production once a shared store is configured', () => {
    const { env, error } = loadEnv({ NODE_ENV: 'production', REDIS_URL: SHARED });
    expect(error).toBeNull();
    expect(env.USE_MEMORY_STORE).toBe(false);
    expect(env.sharedStore).toBe(true);
  });

  it('keeps deriving the platform host names around the gate', () => {
    const { env, error } = loadEnv({
      NODE_ENV: 'production',
      REDIS_URL: SHARED,
      VERCEL: '1',
      VERCEL_PROJECT_PRODUCTION_URL: 'inchat.vercel.app'
    });
    expect(error).toBeNull();
    expect(env.corsOrigins).toContain('https://inchat.vercel.app');
  });

  /**
   * The REST pair is the first thing an Upstash dashboard shows, so this is the
   * misconfiguration a deploy actually hits. The answer has to name the values
   * that are present, not repeat that something is missing.
   */
  it('says what the Upstash REST variables are not, when only those are set', () => {
    const { error } = loadEnv({
      NODE_ENV: 'production',
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'a-token'
    });
    expect(error.message).toContain('Upstash REST variables are not a substitute');
    expect(error.message).toContain('rediss://default:');
  });

  it('refuses a REST endpoint handed to REDIS_URL', () => {
    const { error } = loadEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'https://example.upstash.io'
    });
    expect(error.message).toContain('not an http(s):// endpoint');
  });

  it('accepts the TCP connection string an Upstash database also publishes', () => {
    const { env, error } = loadEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://default:secret@example.upstash.io:6379'
    });
    expect(error).toBeNull();
    expect(env.sharedStore).toBe(true);
  });

  it('allows the in-memory store where every room lives in one process anyway', () => {
    const { env, error } = loadEnv({ NODE_ENV: 'development', USE_MEMORY_STORE: 'true' });
    expect(error).toBeNull();
    expect(env.sharedStore).toBe(false);
  });

  it('still makes a development run choose a store', () => {
    const { error } = loadEnv({ NODE_ENV: 'development' });
    expect(error.message).toContain('REDIS_URL is required unless USE_MEMORY_STORE=true');
  });
});
