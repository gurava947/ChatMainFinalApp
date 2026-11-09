'use strict';

const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 3101);
const baseURL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // The two seats share one room, so the specs are deliberately serial.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    permissions: ['microphone', 'camera'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required'
      ]
    }
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // NODE_ENV=development on purpose: the server only mounts client/dist
    // outside the test env, and `npm run build:client` has already produced it.
    command: 'node src/server.js',
    url: `${baseURL}/readyz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NODE_ENV: 'development',
      PORT: String(PORT),
      USE_MEMORY_STORE: 'true',
      LOG_LEVEL: 'warn',
      RATE_LIMIT_API_MAX: '1000',
      RATE_LIMIT_SESSION_MAX: '1000',
      RATE_LIMIT_ACCESS_MAX: '1000',
      RATE_LIMIT_SEND_MAX: '1000'
    }
  }
});
