#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  UX_VIEWPORT_MODEL_ROUTE_IDS,
  buildUxViewportPlan
} from '../../tests/frontend/support/playwright/uxViewportPlan.mjs'
import { writeUxViewportSummary } from '../../tests/frontend/checks/ux/write-ux-viewport-summary.mjs'
import { readManifestSchedulerResourceGrant } from '../test/run-command-manifest.mjs'
import {
  executeElasticUxGroupPool,
  executePersistentUxWorkerPool
} from './ux-risk-elastic-pool.mjs'
import { validateReleasePreviewReady } from './release-preview-readiness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontend = path.join(root, 'src/frontend')
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'tests/frontend/fixtures/ux-viewport-matrix.json'), 'utf8'))
const routes = UX_VIEWPORT_MODEL_ROUTE_IDS.map((id) => ({
  id,
  storage: id.startsWith('public-') ? 'anonymous' : id.startsWith('user-') ? 'user' : 'admin'
}))
const fullPlan = buildUxViewportPlan({ matrix, routes, mode: 'boundaries' })
const riskPlan = buildUxViewportPlan({ matrix, routes, mode: 'boundaries', filters: { riskMatrix: true } })
const resume = process.env.FSUSBLOG_UX_VIEWPORT_RESUME === '1'
const detectedCpuCount = os.availableParallelism?.() ?? os.cpus().length
const explicitSchedulerCpuGrant = resolvePositiveGrant([
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_BUNDLE_CPU_UNITS',
  'FSUSBLOG_BUNDLE_CPU_BUDGET'
])
const schedulerCpuGrant = explicitSchedulerCpuGrant ?? detectedCpuCount
const detectedAvailableMemoryGiB = os.freemem() / 1024 ** 3
const explicitSchedulerMemoryGrantGiB = resolvePositiveGrant([
  'FSUSBLOG_STEP_MEMORY_GIB',
  'FSUSBLOG_BUNDLE_MEMORY_GIB'
])
const schedulerMemoryGrantGiB = explicitSchedulerMemoryGrantGiB ?? detectedAvailableMemoryGiB
const grantedMemoryGiB = Math.min(detectedAvailableMemoryGiB, schedulerMemoryGrantGiB)
const machineMemoryPerCpuGiB = Math.max(Number.EPSILON, os.totalmem() / 1024 ** 3 / detectedCpuCount)
const schedulerManaged = explicitSchedulerCpuGrant !== undefined
  && explicitSchedulerMemoryGrantGiB !== undefined
// Browser viewport workers spend most of their wall time awaiting navigation,
// layout stabilization and screenshots. Admit them by the larger of CPU and
// memory capacity while both remain bounded by the route groups and host CPUs;
// this lets an I/O-heavy 1-CPU/3-memory-share grant keep three isolated pages
// in flight without inventing a fixed machine-specific worker count.
const memoryWorkerCapacity = Math.max(1, Math.ceil(grantedMemoryGiB / machineMemoryPerCpuGiB))
const configuredWorkers = Number.parseInt(String(
  process.env.FSUSBLOG_UX_VIEWPORT_WORKERS
    ?? process.env.FSUSBLOG_PLAYWRIGHT_WORKERS
    ?? ''), 10)
const workerCapacity = Number.isInteger(configuredWorkers) && configuredWorkers > 0
  ? Math.min(configuredWorkers, Math.max(Math.floor(schedulerCpuGrant), memoryWorkerCapacity), detectedCpuCount)
  : Math.min(Math.max(Math.floor(schedulerCpuGrant), memoryWorkerCapacity), detectedCpuCount)
const riskWorkers = Math.max(1, Math.min(riskPlan.counts.routeThemeGroups, workerCapacity))
const maximumWorkerCapacity = Math.max(1, Math.min(
  riskPlan.counts.routeThemeGroups,
  detectedCpuCount,
  Number.isInteger(configuredWorkers) && configuredWorkers > 0
    ? configuredWorkers
    : riskPlan.counts.routeThemeGroups
))

if (process.argv[2] === '--print-resource-plan') {
  process.stdout.write(`${JSON.stringify({
    schedulerManaged,
    schedulerCpuGrant,
    schedulerMemoryGrantGiB: grantedMemoryGiB,
    memoryWorkerCapacity,
    workers: riskWorkers,
    maximumWorkers: maximumWorkerCapacity
  })}\n`)
  process.exit(0)
}

const schedulerRunId = requireSafeRunId('FSUSBLOG_TEST_RUN_ID')
const inheritedStepDeadlineMs = resolvePositiveGrant(['FSUSBLOG_STEP_DEADLINE_MS'])
const stepDeadlineAtMs = inheritedStepDeadlineMs === undefined
  ? undefined
  : Date.now() + inheritedStepDeadlineMs
const playwrightBaseUrl = requireHttpUrl('FSUSBLOG_RELEASE_PREVIEW_URL')
const previewReady = validateReleasePreviewReady({
  root,
  runId: schedulerRunId,
  previewUrl: process.env.FSUSBLOG_RELEASE_PREVIEW_MARKER_URL ?? playwrightBaseUrl
})
const publicBaseUrl = requireHttpUrl('FSUSBLOG_DEBUG_BACKEND_URL')
const resumeRunId = resume ? requireSafeRunId('FSUSBLOG_UX_VIEWPORT_RUN_ID') : undefined

if (fullPlan.counts.cases !== 6468) throw new Error(`full UX model must contain 6468 cases, got ${fullPlan.counts.cases}`)
if (riskPlan.counts.navigations > 48) throw new Error(`risk UX runtime exceeds 48 navigations: ${riskPlan.counts.navigations}`)
const cli = path.join(frontend, 'node_modules/@playwright/test/cli.js')
const executionMode = resolveExecutionMode(process.env.FSUSBLOG_UX_RISK_EXECUTION_MODE)
console.log(
  `[local-production:ux-risk] mode=${executionMode} schedulerManaged=${schedulerManaged} cpuGrant=${schedulerCpuGrant.toFixed(2)} memoryGrantGiB=${grantedMemoryGiB.toFixed(2)} workers=${riskWorkers}`
)
const freshRunId = `local-production-risk-${schedulerRunId}-${Date.now()}`
const uxRunId = resumeRunId ?? freshRunId
const uxRunToken = `${freshRunId}-token`
const pointerFile = path.join(root, '.tmp/ux/current-boundaries-run.json')
const resourceSampler = startProcessTreeResourceSampler()
let pool
try {
  pool = executionMode === 'cli'
    ? await runDirectCliPool()
    : await runPersistentBrowserPool()
} finally {
  resourceSampler.stop()
}
const resourceUsage = resourceSampler.summary()

const { summary } = await writeUxViewportSummary({ root, mode: 'boundaries', runId: uxRunId })
if (summary.status !== 'ok' || summary.plannedNavigationCount !== riskPlan.counts.navigations) {
  throw new Error(`risk UX summary is incomplete: status=${summary.status} navigations=${summary.plannedNavigationCount}`)
}
if (summary.runId !== uxRunId) {
  throw new Error(`risk UX summary belongs to ${summary.runId}, expected ${uxRunId}`)
}
const evidence = {
  schema: 'fsusblog.local-production.ux-risk.v2',
  status: 'success',
  executionMode,
  executionSource: resume ? 'resume' : 'fresh',
  fullModel: fullPlan.counts,
  runtimeRisk: riskPlan.counts,
  selection: riskPlan.selection,
  workers: pool.maximumWorkers,
  initialWorkers: riskWorkers,
  startedGroupIds: pool.startedGroupIds,
  completedGroupIds: pool.completedGroupIds,
  playwrightProcessCount: pool.playwrightProcessCount,
  browserLaunchCount: pool.browserLaunchCount,
  browserCrashRetryCount: pool.retryCount,
  timeToFirstGroupMs: pool.timeToFirstGroupMs,
  workerLifecycle: pool.workers,
  groupAttempts: pool.attempts,
  resourceUsage,
  chromiumSlots: {
    outerCountedResource: 'chromiumLane',
    outerSlotsConsumed: 1,
    initialLocalCapacity: riskWorkers,
    maximumLocalCapacity: maximumWorkerCapacity,
    liveCapacitySource: 'scheduler CPU/memory grant'
  },
  schedulerRunId,
  uxRunId,
  playwrightBaseUrl,
  publicBaseUrl,
  previewReadyMarker: path.relative(root, previewReady.markerFile),
  runtimeSummary: summary,
  generatedAt: new Date().toISOString()
}
const outFile = path.join(root, '.tmp/release-evidence/local-production-ux-risk.json')
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`[local-production:ux-risk] model=${fullPlan.counts.cases} navigations=${riskPlan.counts.navigations}`)

async function runPersistentBrowserPool() {
  const abortController = new AbortController()
  const cancel = (signal) => abortController.abort(signal)
  const onSigint = () => cancel('SIGINT')
  const onSigterm = () => cancel('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  configurePersistentRuntimeEnvironment()
  await preparePlaywrightSessions(maximumWorkerCapacity)
  const availableSessions = Array.from({ length: maximumWorkerCapacity }, (_, index) => `pw-${index}`)
  const { server, runtime } = await loadPersistentUxRuntime()
  const metadata = runtime.persistentUxViewportRuntimeMetadata()
  const plannedIds = riskPlan.groups.map((group) => group.id)
  if (JSON.stringify(metadata.plannedGroupIds) !== JSON.stringify(plannedIds)) {
    await server.close()
    throw new Error('persistent UX runtime group plan differs from the governed risk plan')
  }
  if (metadata.runId !== uxRunId) {
    await server.close()
    throw new Error(`persistent UX runtime initialized ${metadata.runId}, expected ${uxRunId}`)
  }
  const completedBeforeStart = new Set(metadata.completedGroupIds ?? [])
  const pendingGroups = riskPlan.groups.filter((group) => !completedBeforeStart.has(group.id))
  if (pendingGroups.length === 0) {
    await server.close()
    return {
      maximumWorkers: 0,
      playwrightProcessCount: 1,
      browserLaunchCount: 0,
      retryCount: 0,
      timeToFirstGroupMs: 0,
      startedGroupIds: [],
      completedGroupIds: [...completedBeforeStart],
      workers: [],
      attempts: []
    }
  }

  const playwright = await import(pathToFileURL(path.join(frontend, 'node_modules/playwright/index.mjs')).href)
  const executablePath = resolveChromiumExecutablePath()
  try {
    const result = await executePersistentUxWorkerPool(pendingGroups, {
      capacityProvider: () => resolveLiveWorkerCapacity(),
      pollMs: 100,
      signal: abortController.signal,
      maxCrashRetries: resolveCrashRetryLimit(),
      createWorker: async (workerIndex) => {
        const sessionId = availableSessions.shift()
        if (!sessionId) throw new Error('persistent UX worker has no local Playwright session slot')
        const launchedAt = Date.now()
        let browser
        try {
          browser = await playwright.chromium.launch({
            headless: true,
            ...(executablePath ? { executablePath } : {}),
            args: ['--no-sandbox', '--disable-dev-shm-usage']
          })
        } catch (error) {
          availableSessions.unshift(sessionId)
          throw error
        }
        const worker = {
          workerIndex,
          sessionId,
          browser,
          disconnected: false,
          launchedAt,
          launchDurationMs: Date.now() - launchedAt,
          executedGroupIds: []
        }
        browser.once('disconnected', () => { worker.disconnected = true })
        return worker
      },
      destroyWorker: async (worker) => {
        try {
          if (worker.browser.isConnected()) await worker.browser.close()
        } finally {
          availableSessions.push(worker.sessionId)
        }
      },
      classifyError: (error) => ({
        retryable: error?.code === 'FSUSBLOG_UX_BROWSER_CRASH'
      }),
      execute: async (group, worker, attempt) => {
        const groupSlug = group.id.replace(/[^a-z0-9._-]+/giu, '-')
        const outputDir = path.join(
          frontend,
          'test-results/playwright/local-production-risk/persistent',
          `worker-${worker.workerIndex}-${worker.sessionId}`,
          `${groupSlug}-attempt-${attempt.attempt}`
        )
        try {
          const groupResult = await runtime.runPersistentUxViewportGroup(worker.browser, group.id, {
            outputDir,
            workerIndex: worker.workerIndex,
            attempt: attempt.attempt,
            sessionId: worker.sessionId
          })
          worker.executedGroupIds.push(group.id)
          return groupResult
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          if (worker.disconnected || !worker.browser.isConnected() || isBrowserCrashError(error)) {
            failure.code = 'FSUSBLOG_UX_BROWSER_CRASH'
          }
          throw failure
        }
      }
    })
    return {
      ...result,
      playwrightProcessCount: 1,
      completedGroupIds: [...completedBeforeStart, ...result.completedGroupIds]
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    await server.close()
  }
}

async function runDirectCliPool() {
  let initializationResolve
  let initializationReject
  const initialization = new Promise((resolve, reject) => {
    initializationResolve = resolve
    initializationReject = reject
  })
  void initialization.catch(() => {})
  let initializationStarted = false
  let processCount = 0
  const startedAt = Date.now()
  let firstGroupStartedAt = null
  const result = await executeElasticUxGroupPool(riskPlan.groups, {
    capacityProvider: () => resolveLiveWorkerCapacity(),
    pollMs: 100,
    execute: async (group, workerIndex) => {
      const initializesRun = !initializationStarted
      initializationStarted = true
      if (!initializesRun) await initialization
      if (firstGroupStartedAt === null) firstGroupStartedAt = Date.now()
      const groupSlug = group.id.replace(/[^a-z0-9._-]+/giu, '-')
      const childEnvironment = { ...process.env }
      delete childEnvironment.NO_COLOR
      processCount += 1
      const child = spawn(process.execPath, [cli, 'test', '--workers=1', 'ux/viewport-boundaries.spec.ts'], {
        cwd: frontend,
        env: {
          ...childEnvironment,
          ...baseRiskEnvironment(),
          FSUSBLOG_UX_VIEWPORT_PERSISTENT_WORKER: '0',
          FSUSBLOG_UX_VIEWPORT_EXECUTION_GROUP_IDS: group.id,
          FSUSBLOG_UX_VIEWPORT_WORKERS: '1',
          FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
          FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP: initializesRun ? '0' : '1',
          FSUSBLOG_UX_VIEWPORT_RESUME: initializesRun && !resume ? '0' : '1',
          PLAYWRIGHT_OUTPUT_DIR: `test-results/playwright/local-production-risk/${groupSlug}-${workerIndex}`
        },
        stdio: 'inherit'
      })
      if (initializesRun) {
        waitForRunPointer(pointerFile, uxRunId, child)
          .then(initializationResolve, initializationReject)
      }
      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve(code ?? 1))
      })
      if (exitCode !== 0) {
        const error = new Error(`risk Playwright group ${group.id} exited ${exitCode}`)
        if (initializesRun) initializationReject(error)
        throw error
      }
    }
  })
  return {
    ...result,
    playwrightProcessCount: processCount,
    browserLaunchCount: processCount,
    retryCount: 0,
    timeToFirstGroupMs: firstGroupStartedAt === null ? null : firstGroupStartedAt - startedAt,
    workers: [],
    attempts: result.startedGroupIds.map((groupId) => ({ groupId, status: 'passed' }))
  }
}

function baseRiskEnvironment() {
  return {
    FSUSBLOG_UX_VIEWPORT_MODE: 'boundaries',
    FSUSBLOG_UX_VIEWPORT_RISK_MATRIX: '1',
    FSUSBLOG_UX_VIEWPORT_SCREENSHOTS: '1',
    FSUSBLOG_UX_VIEWPORT_POOL_SIZE: String(maximumWorkerCapacity),
    ...(stepDeadlineAtMs === undefined ? {} : {
      FSUSBLOG_STEP_DEADLINE_AT_MS: String(stepDeadlineAtMs)
    }),
    FSUSBLOG_TEST_SESSION: 'pw-0',
    FSUSBLOG_TEST_SESSION_ISOLATION: '1',
    FSUSBLOG_DISABLE_NOTIFICATION_STREAM: '1',
    FSUSBLOG_PLAYWRIGHT_TRACE: 'off',
    FSUSBLOG_UX_VIEWPORT_PUBLIC_BASE_URL: publicBaseUrl,
    FSUSBLOG_UX_VIEWPORT_RUN_ID: uxRunId,
    FSUSBLOG_UX_VIEWPORT_RUN_TOKEN: uxRunToken,
    PLAYWRIGHT_BASE_URL: playwrightBaseUrl
  }
}

function configurePersistentRuntimeEnvironment() {
  Object.assign(process.env, baseRiskEnvironment(), {
    FSUSBLOG_UX_VIEWPORT_PERSISTENT_WORKER: '1',
    FSUSBLOG_UX_VIEWPORT_RESUME: resume ? '1' : '0',
    FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP: '1',
    FSUSBLOG_UX_VIEWPORT_CURRENT_OUTPUT_DIR: path.join(
      frontend,
      'test-results/playwright/local-production-risk/runs',
      uxRunId
    )
  })
  delete process.env.FSUSBLOG_UX_VIEWPORT_EXECUTION_GROUP_IDS
}

async function preparePlaywrightSessions(sessionCount) {
  const script = path.join(root, 'tests/frontend/fixtures/prepare-playwright-sessions.mjs')
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--workers', String(sessionCount)], {
      cwd: frontend,
      env: { ...process.env, FSUSBLOG_PLAYWRIGHT_WORKERS: String(sessionCount) },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
  if (exitCode !== 0) throw new Error(`prepare-playwright-sessions failed with exit ${exitCode}`)
}

async function loadPersistentUxRuntime() {
  const { createServer } = await import(
    pathToFileURL(path.join(frontend, 'node_modules/vite/dist/node/index.js')).href
  )
  const server = await createServer({
    root: frontend,
    logLevel: 'error',
    appType: 'custom',
    resolve: {
      alias: {
        '@playwright/test': path.join(frontend, 'node_modules/@playwright/test/index.mjs')
      }
    },
    server: {
      middlewareMode: true,
      fs: { allow: [root] }
    }
  })
  try {
    const runtime = await server.ssrLoadModule(
      `/@fs/${path.join(root, 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts')}`
    )
    if (typeof runtime.runPersistentUxViewportGroup !== 'function'
      || typeof runtime.persistentUxViewportRuntimeMetadata !== 'function') {
      throw new Error('persistent UX runtime does not expose the governed public runner contract')
    }
    return { server, runtime }
  } catch (error) {
    await server.close()
    throw error
  }
}

function resolveChromiumExecutablePath() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (configured) return configured
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].find((candidate) => fs.existsSync(candidate))
}

function resolveCrashRetryLimit() {
  const raw = process.env.FSUSBLOG_UX_BROWSER_CRASH_RETRIES ?? '1'
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
    throw new Error(`FSUSBLOG_UX_BROWSER_CRASH_RETRIES must be an integer from 0 to 3, got ${raw}`)
  }
  return parsed
}

function isBrowserCrashError(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /browser.*(?:closed|disconnected|crash)|target page, context or browser has been closed/iu.test(message)
}

function resolveExecutionMode(raw) {
  if (raw === undefined || raw === '' || raw === 'pool') return 'pool'
  if (raw === 'cli') return 'cli'
  throw new Error(`FSUSBLOG_UX_RISK_EXECUTION_MODE must be pool or cli, got ${raw}`)
}

function startProcessTreeResourceSampler() {
  let peakRssBytes = process.memoryUsage().rss
  let peakProcessCount = 1
  let samples = 0
  const sample = () => {
    const processIds = process.platform === 'linux'
      ? listLinuxProcessTree(process.pid)
      : [process.pid]
    const rssBytes = processIds.reduce((total, processId) => total + readLinuxRssBytes(processId), 0)
    peakRssBytes = Math.max(peakRssBytes, rssBytes || process.memoryUsage().rss)
    peakProcessCount = Math.max(peakProcessCount, processIds.length)
    samples += 1
  }
  sample()
  const interval = setInterval(sample, 100)
  interval.unref()
  return {
    stop() {
      clearInterval(interval)
      sample()
    },
    summary() {
      return {
        peakProcessTreeRssBytes: peakRssBytes,
        peakProcessTreeCount: peakProcessCount,
        samples,
        scope: process.platform === 'linux' ? 'runner-and-descendants' : 'runner-only-fallback'
      }
    }
  }
}

function listLinuxProcessTree(rootProcessId) {
  const found = []
  const pending = [rootProcessId]
  const seen = new Set()
  while (pending.length > 0) {
    const processId = pending.pop()
    if (!Number.isInteger(processId) || seen.has(processId)) continue
    seen.add(processId)
    found.push(processId)
    try {
      const children = fs.readFileSync(`/proc/${processId}/task/${processId}/children`, 'utf8')
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map(Number)
      pending.push(...children)
    } catch {
      // A short-lived process may exit between discovery and sampling.
    }
  }
  return found
}

function readLinuxRssBytes(processId) {
  if (process.platform !== 'linux') return processId === process.pid ? process.memoryUsage().rss : 0
  try {
    const status = fs.readFileSync(`/proc/${processId}/status`, 'utf8')
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu)
    return match ? Number(match[1]) * 1024 : 0
  } catch {
    return 0
  }
}

function resolvePositiveGrant(names) {
  for (const name of names) {
    const value = process.env[name]
    if (value === undefined || String(value).trim() === '') continue
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive finite number, got ${value}`)
    }
    return parsed
  }
  return undefined
}

function resolveLiveWorkerCapacity() {
  const live = readManifestSchedulerResourceGrant()
  const cpuGrant = live?.cpuUnits ?? schedulerCpuGrant
  const memoryGrantGiB = Math.min(
    os.freemem() / 1024 ** 3,
    live?.memoryGiB ?? schedulerMemoryGrantGiB
  )
  const memoryCapacity = Math.max(1, Math.ceil(memoryGrantGiB / machineMemoryPerCpuGiB))
  const explicitCap = Number.isInteger(configuredWorkers) && configuredWorkers > 0
    ? configuredWorkers
    : riskPlan.counts.routeThemeGroups
  return Math.max(1, Math.min(
    riskPlan.counts.routeThemeGroups,
    Math.max(Math.floor(cpuGrant), memoryCapacity),
    detectedCpuCount,
    explicitCap
  ))
}

async function waitForRunPointer(file, runId, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`UX initializer exited before run pointer ${runId}`)
    try {
      const pointer = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (pointer.runId === runId && pointer.mode === 'boundaries') return
    } catch {
      // Atomic pointer creation may not have completed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`UX run pointer did not initialize for ${runId}`)
}

function requireSafeRunId(name) {
  const value = String(process.env[name] ?? '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new Error(`${name} must be a safe non-empty run id`)
  }
  return value
}

function requireHttpUrl(name) {
  const value = String(process.env[name] ?? '').trim()
  if (!value) throw new Error(`${name} is required`)
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use http or https`)
  }
  return url.href
}
