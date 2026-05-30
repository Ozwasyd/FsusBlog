import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000'
const configuredWorkers = Number(process.env.FSUSBLOG_PLAYWRIGHT_WORKERS || '')
const workers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
  ? Math.floor(configuredWorkers)
  : (process.env.CI ? 4 : 4)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((candidate) => existsSync(candidate))

const launchOptions: {
  executablePath?: string
  args: string[]
} = {
  args: ['--no-sandbox', '--disable-dev-shm-usage']
}

if (executablePath) {
  launchOptions.executablePath = executablePath
}

export default defineConfig({
  testDir: '../../tests/frontend/e2e',
  fullyParallel: true,
  workers,
  globalSetup: '../../tests/frontend/support/playwright/global-setup.ts',
  timeout: 240_000,
  expect: {
    timeout: 15_000
  },
  reporter: 'list',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results/playwright',
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions
  },
  projects: [
    {
      name: 'chrome',
      use: {
        browserName: 'chromium'
      }
    }
  ]
})
