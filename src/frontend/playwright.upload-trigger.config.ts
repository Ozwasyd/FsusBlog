import path from 'node:path'
import { defineConfig } from '@playwright/test'
import { resolveSystemChromiumExecutablePath } from '../../tests/frontend/support/system-chromium.mjs'

const executablePath = resolveSystemChromiumExecutablePath()

export default defineConfig({
  tsconfig: './tsconfig.playwright.json',
  testDir: '../../tests/frontend/e2e',
  testMatch: 'settings-brand-upload-trigger.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000
  },
  reporter: 'list',
  outputDir: path.resolve(process.cwd(), process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results/playwright/upload-trigger'),

  webServer: {
    command: 'npx vite --config vite.fixture.config.ts --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      FSUSBLOG_LOCAL_FSUSUI_ROOT: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT || '/workspace/FsusUI',
      ...(process.env.FSUSBLOG_USE_LOCAL_FSUSUI
        ? { FSUSBLOG_USE_LOCAL_FSUSUI: process.env.FSUSBLOG_USE_LOCAL_FSUSUI }
        : {})
    }
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4179',
    headless: true,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=LocalNetworkAccessChecks']
    }
  }
})
