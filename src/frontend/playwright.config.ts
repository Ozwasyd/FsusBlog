import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type PlaywrightWorkerOptions } from '@playwright/test'
import { playwrightScreenshotPathTemplate } from '../../tests/frontend/support/playwright/screenshotPathTemplate.mjs'
import {
  correctnessProjectUse,
  createCorrectnessBrowserPlan,
  serializableBrowserPlan
} from '../../tools/test/playwright-browser-identity.mjs'

type BrowserName = PlaywrightWorkerOptions['browserName']

const baseURL = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000'
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const uxViewportMode = process.env.FSUSBLOG_UX_VIEWPORT_MODE
const resumesUxViewportRun = process.env.FSUSBLOG_UX_VIEWPORT_RESUME === '1'
const traceMode = process.env.FSUSBLOG_PLAYWRIGHT_TRACE === 'off' ? 'off' : 'retain-on-failure'
const configuredOutputDir = path.resolve(process.cwd(), process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results/playwright')
const temporalContext = process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON
  ? JSON.parse(process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON)
  : (process.env.FSUSBLOG_TEMPORAL_CONTEXT_FILE
      ? JSON.parse(readFileSync(process.env.FSUSBLOG_TEMPORAL_CONTEXT_FILE, 'utf8'))
      : null)
if (temporalContext && (
  temporalContext.schema !== 'fsusblog.test-temporal-context.v1'
  || !temporalContext.uiLocale
  || !temporalContext.timezone
  || process.env.TZ !== temporalContext.nodeTimezone
)) {
  throw new Error('Playwright temporal context is incomplete or does not match Node TZ')
}

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
const hostCpus = Math.max(1, os.availableParallelism?.() ?? os.cpus().length)
const schedulerCpuGrant = resolvePositiveGrant([
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_BUNDLE_CPU_UNITS',
  'FSUSBLOG_BUNDLE_CPU_BUDGET'
])
const schedulerMemoryGrantGiB = resolvePositiveGrant([
  'FSUSBLOG_STEP_MEMORY_GIB',
  'FSUSBLOG_BUNDLE_MEMORY_GIB'
])
const cpuCap = Math.max(1, Math.floor(Math.min(hostCpus, schedulerCpuGrant ?? hostCpus)))
const availableMemoryBytes = Math.max(0, os.freemem())
const grantedMemoryBytes = Math.min(
  availableMemoryBytes,
  schedulerMemoryGrantGiB === undefined
    ? availableMemoryBytes
    : schedulerMemoryGrantGiB * 1024 ** 3)
const machineMemoryPerCpuBytes = Math.max(1, os.totalmem() / hostCpus)
const schedulerManaged = schedulerCpuGrant !== undefined && schedulerMemoryGrantGiB !== undefined
// Browser workers remain bounded by the live STEP memory grant and the host's
// proportional memory density; a CPU admission alone does not make another
// isolated browser context memory-safe.
const memoryCap = Math.max(1, Math.ceil(grantedMemoryBytes / machineMemoryPerCpuBytes))
const loadCap = !schedulerManaged
  ? Math.max(1, Math.floor(hostCpus - Math.max(0, os.loadavg()[0] || 0)))
  : cpuCap
const dynamicWorkerCap = Math.max(1, Math.min(cpuCap, memoryCap, loadCap))
const workers = Number.isFinite(configuredWorkers) && configuredWorkers > 0
  ? Math.max(1, Math.min(Math.floor(configuredWorkers), dynamicWorkerCap))
  : dynamicWorkerCap
const publicPreviewRendererArgs = [
  ...(process.env.FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE === '1'
    ? [
        '--disable-gpu',
        '--disable-gpu-rasterization',
        '--disable-checker-imaging',
        '--disable-lcd-text',
        '--disable-font-subpixel-positioning',
        '--disable-skia-runtime-opts',
        '--disable-oop-rasterization',
        '--disable-partial-raster',
        '--disable-threaded-animation',
        '--disable-threaded-scrolling',
        '--disable-zero-copy',
        '--force-device-scale-factor=1',
        '--force-color-profile=srgb',
        '--num-raster-threads=1'
      ]
    : [])
]
const requestedBrowsers = (process.env.FSUSBLOG_PLAYWRIGHT_BROWSERS || 'chromium')
  .split(',')
  .map((browser) => browser.trim().toLowerCase())
  .filter(Boolean)

const uniqueBrowsers = Array.from(new Set(requestedBrowsers))
const supportedBrowsers = new Set(['chromium', 'firefox', 'webkit'])
const correctnessLocale = temporalContext?.uiLocale || 'zh-CN'
const browserPlans = uniqueBrowsers.map((browser) => {
  if (!supportedBrowsers.has(browser)) {
    throw new Error(`Unsupported FSUSBLOG_PLAYWRIGHT_BROWSERS entry: ${browser}`)
  }
  return createCorrectnessBrowserPlan({
    browserName: browser as BrowserName,
    evidenceClass: 'correctness',
    locale: correctnessLocale,
    frontendRoot: path.join(repositoryRoot, 'src/frontend'),
    additionalLaunchArgs: browser === 'chromium' ? publicPreviewRendererArgs : []
  })
})
process.env.FSUSBLOG_PLAYWRIGHT_BROWSER_IDENTITY_PLANS = JSON.stringify(
  browserPlans.map(serializableBrowserPlan)
)
const projects = browserPlans.map((plan) => {
  return {
    name: plan.browserName,
    use: correctnessProjectUse(plan)
  }
})

function resolveTestTimeoutMs(): number {
  const explicit = Number(process.env.FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS)
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  const stepDeadlineMs = Number(process.env.FSUSBLOG_STEP_DEADLINE_MS)
  if (Number.isFinite(stepDeadlineMs) && stepDeadlineMs > 0) {
    // Reserve independent shares for launch, execution and cleanup per browser.
    return Math.max(30_000, Math.floor(stepDeadlineMs / Math.max(1, projects.length * 3)))
  }
  const pressureScale = Math.sqrt(hostCpus / Math.max(1, cpuCap))
  return Math.floor(60_000 * pressureScale)
}

function resolvePositiveGrant(names: string[]): number | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value === undefined || value.trim() === '') continue
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive finite number, got ${value}`)
    }
    return parsed
  }
  return undefined
}

export default defineConfig({
  tsconfig: './tsconfig.playwright.json',
  testDir: '../../tests/frontend/e2e',
  // Browser-only diagnostics have their own scheduled/manual config. Keeping
  // this deny-list on the ordinary config prevents broad file globs and the
  // production correctness lane from accidentally re-admitting them. The UX
  // viewport runner opts into ux/** explicitly via FSUSBLOG_UX_VIEWPORT_MODE.
  testIgnore: [
    'visual/**',
    ...(uxViewportMode ? [] : ['ux/**']),
    'diagnostics/**',
    'acceptance/cross-browser-smoke.spec.ts',
    'acceptance/archive-sticky-geometry.spec.ts',
  ],
  fullyParallel: true,
  workers,
  globalSetup: '../../tests/frontend/support/playwright/global-setup.ts',
  timeout: resolveTestTimeoutMs(),
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      pathTemplate: playwrightScreenshotPathTemplate
    }
  },
  reporter: 'list',
  outputDir,
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: true,
    trace: traceMode,
    screenshot: 'only-on-failure',
    video: 'off',
    ...(temporalContext
      ? {
          locale: temporalContext.uiLocale,
          timezoneId: temporalContext.timezone
        }
      : {})
  },
  projects
})
