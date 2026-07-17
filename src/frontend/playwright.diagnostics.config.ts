import path from 'node:path'
import { defineConfig } from '@playwright/test'

function positiveInteger(value: string | undefined, label: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

const workers = positiveInteger(
  process.env.FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS,
  'FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS',
  1,
)
const timeout = positiveInteger(
  process.env.FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS,
  'FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS',
  90_000,
)
const requestedBrowsers = (process.env.FSUSBLOG_PLAYWRIGHT_BROWSERS || 'chromium')
  .split(',')
  .map((browser) => browser.trim().toLowerCase())
  .filter(Boolean)
const supportedBrowsers = new Set(['chromium', 'firefox', 'webkit'])
const projects = [...new Set(requestedBrowsers)].map((browser) => {
  if (!supportedBrowsers.has(browser)) throw new Error(`unsupported diagnostics browser: ${browser}`)
  return { name: browser, use: { browserName: browser as 'chromium' | 'firefox' | 'webkit' } }
})

export default defineConfig({
  tsconfig: './tsconfig.playwright.json',
  testDir: '../../tests/frontend/e2e',
  fullyParallel: false,
  workers,
  retries: 0,
  timeout,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: path.resolve(process.cwd(), process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results/playwright/browser-diagnostics'),
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000',
    headless: true,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects,
})
