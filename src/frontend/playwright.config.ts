import { existsSync } from 'node:fs'
import { defineConfig, type BrowserName } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000'
const configuredWorkers = Number(process.env.FSUSBLOG_PLAYWRIGHT_WORKERS || '')
const workers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
  ? Math.floor(configuredWorkers)
  : (process.env.CI ? 4 : 4)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((candidate) => existsSync(candidate))

const chromiumLaunchOptions: {
  executablePath?: string
  args: string[]
} = {
  args: ['--no-sandbox', '--disable-dev-shm-usage']
}

if (executablePath) {
  chromiumLaunchOptions.executablePath = executablePath
}

const requestedBrowsers = (process.env.FSUSBLOG_PLAYWRIGHT_BROWSERS || 'chromium')
  .split(',')
  .map((browser) => browser.trim().toLowerCase())
  .filter(Boolean)

const uniqueBrowsers = Array.from(new Set(requestedBrowsers))
const supportedBrowsers = new Set(['chromium', 'firefox', 'webkit'])
const projects = uniqueBrowsers.map((browser) => {
  if (!supportedBrowsers.has(browser)) {
    throw new Error(`Unsupported FSUSBLOG_PLAYWRIGHT_BROWSERS entry: ${browser}`)
  }

  const browserName = browser as BrowserName
  return {
    name: browser,
    use: {
      browserName,
      ...(browserName === 'chromium' ? { launchOptions: chromiumLaunchOptions } : {})
    }
  }
})

export default defineConfig({
  tsconfig: './tsconfig.playwright.json',
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
    video: 'off'
  },
  projects
})
