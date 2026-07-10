import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type BrowserName } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000'
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const uxViewportMode = process.env.FSUSBLOG_UX_VIEWPORT_MODE
const resumesUxViewportRun = process.env.FSUSBLOG_UX_VIEWPORT_RESUME === '1'
const diagnosticAllFailures = process.env.FSUSBLOG_PLAYWRIGHT_DIAGNOSTIC_ALL_FAILURES === '1'
const configuredOutputDir = path.resolve(process.cwd(), process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results/playwright')

if (uxViewportMode) {
  if (resumesUxViewportRun && !process.env.FSUSBLOG_UX_VIEWPORT_RUN_ID) {
    const pointerFile = path.join(repositoryRoot, '.tmp/ux', `current-${uxViewportMode}-run.json`)
    const pointer = JSON.parse(readFileSync(pointerFile, 'utf8')) as {
      runId?: string
      runToken?: string
      mode?: string
    }
    if (!pointer.runId || pointer.mode !== uxViewportMode) {
      throw new Error(`Invalid UX viewport resume pointer: ${pointerFile}`)
    }
    process.env.FSUSBLOG_UX_VIEWPORT_RUN_ID = pointer.runId
    if (pointer.runToken) {
      process.env.FSUSBLOG_UX_VIEWPORT_RUN_TOKEN = pointer.runToken
    }
  }

  if (!resumesUxViewportRun) {
    process.env.FSUSBLOG_UX_VIEWPORT_RUN_ID ||= [
      'ux',
      uxViewportMode,
      Date.now().toString(36),
      randomUUID()
    ].join('-')
    process.env.FSUSBLOG_UX_VIEWPORT_RUN_TOKEN ||= randomUUID()
  }
}

const outputDir = uxViewportMode && process.env.FSUSBLOG_UX_VIEWPORT_RUN_ID
  ? path.join(configuredOutputDir, 'runs', process.env.FSUSBLOG_UX_VIEWPORT_RUN_ID)
  : configuredOutputDir

if (uxViewportMode) {
  process.env.FSUSBLOG_UX_VIEWPORT_CURRENT_OUTPUT_DIR = outputDir
}
const configuredWorkers = Number(process.env.FSUSBLOG_PLAYWRIGHT_WORKERS || '')
const workers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
  ? Math.floor(configuredWorkers)
  : (process.env.CI ? 4 : 4)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].find((candidate) => existsSync(candidate))

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
  maxFailures: diagnosticAllFailures ? 0 : 1,
  globalSetup: '../../tests/frontend/support/playwright/global-setup.ts',
  timeout: 240_000,
  expect: {
    timeout: 15_000
  },
  reporter: 'list',
  outputDir,
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
