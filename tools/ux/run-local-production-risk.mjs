#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  UX_VIEWPORT_MODEL_ROUTE_IDS,
  buildUxViewportPlan
} from '../../tests/frontend/support/playwright/uxViewportPlan.mjs'
import { writeUxViewportSummary } from '../../tests/frontend/checks/ux/write-ux-viewport-summary.mjs'
import { readManifestSchedulerResourceGrant } from '../test/run-command-manifest.mjs'
import { executeElasticUxGroupPool } from './ux-risk-elastic-pool.mjs'
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

if (process.argv[2] === '--print-resource-plan') {
  process.stdout.write(`${JSON.stringify({
    schedulerManaged,
    schedulerCpuGrant,
    schedulerMemoryGrantGiB: grantedMemoryGiB,
    memoryWorkerCapacity,
    workers: riskWorkers
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
console.log(
  `[local-production:ux-risk] schedulerManaged=${schedulerManaged} cpuGrant=${schedulerCpuGrant.toFixed(2)} memoryGrantGiB=${grantedMemoryGiB.toFixed(2)} workers=${riskWorkers}`
)
const freshRunId = `local-production-risk-${schedulerRunId}-${Date.now()}`
const uxRunId = resumeRunId ?? freshRunId
const uxRunToken = `${freshRunId}-token`
const pointerFile = path.join(root, '.tmp/ux/current-boundaries-run.json')
let initializationResolve
let initializationReject
const initialization = new Promise((resolve, reject) => {
  initializationResolve = resolve
  initializationReject = reject
})
void initialization.catch(() => {})
let initializationStarted = false

const pool = await executeElasticUxGroupPool(riskPlan.groups, {
  capacityProvider: () => resolveLiveWorkerCapacity(),
  pollMs: 100,
  execute: async (group, workerIndex) => {
    const initializesRun = !initializationStarted
    initializationStarted = true
    if (!initializesRun) await initialization
    const groupSlug = group.id.replace(/[^a-z0-9._-]+/giu, '-')
    const childEnvironment = { ...process.env }
    // Playwright enables FORCE_COLOR for TTY reporters. Do not also pass
    // NO_COLOR into that process tree, otherwise Node emits one warning per
    // worker even when the caller itself did not set FORCE_COLOR.
    delete childEnvironment.NO_COLOR
    const child = spawn(process.execPath, [cli, 'test', '--workers=1', 'ux/viewport-boundaries.spec.ts'], {
      cwd: frontend,
      env: {
        ...childEnvironment,
        FSUSBLOG_UX_VIEWPORT_MODE: 'boundaries',
        FSUSBLOG_UX_VIEWPORT_RISK_MATRIX: '1',
        FSUSBLOG_UX_VIEWPORT_SCREENSHOTS: '1',
        FSUSBLOG_UX_VIEWPORT_EXECUTION_GROUP_IDS: group.id,
        FSUSBLOG_UX_VIEWPORT_WORKERS: '1',
        FSUSBLOG_UX_VIEWPORT_POOL_SIZE: String(riskWorkers),
        FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
        ...(stepDeadlineAtMs === undefined ? {} : {
          FSUSBLOG_STEP_DEADLINE_AT_MS: String(stepDeadlineAtMs)
        }),
        FSUSBLOG_TEST_SESSION: 'pw-0',
        FSUSBLOG_TEST_SESSION_ISOLATION: '1',
        FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP: initializesRun ? '0' : '1',
        // Notification-stream pressure and reconnect behavior have their own
        // runtime/performance cohorts. Keeping that background socket active in
        // a screenshot/layout matrix adds unrelated browser contention.
        FSUSBLOG_DISABLE_NOTIFICATION_STREAM: '1',
        FSUSBLOG_PLAYWRIGHT_TRACE: 'off',
        FSUSBLOG_UX_VIEWPORT_PUBLIC_BASE_URL: publicBaseUrl,
        FSUSBLOG_UX_VIEWPORT_RESUME: initializesRun && !resume ? '0' : '1',
        FSUSBLOG_UX_VIEWPORT_RUN_ID: uxRunId,
        FSUSBLOG_UX_VIEWPORT_RUN_TOKEN: uxRunToken,
        PLAYWRIGHT_BASE_URL: playwrightBaseUrl,
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

const { summary } = await writeUxViewportSummary({ root, mode: 'boundaries', runId: uxRunId })
if (summary.status !== 'ok' || summary.plannedNavigationCount !== riskPlan.counts.navigations) {
  throw new Error(`risk UX summary is incomplete: status=${summary.status} navigations=${summary.plannedNavigationCount}`)
}
if (summary.runId !== uxRunId) {
  throw new Error(`risk UX summary belongs to ${summary.runId}, expected ${uxRunId}`)
}
const evidence = {
  schema: 'fsusblog.local-production.ux-risk.v1',
  status: 'success',
  executionSource: resume ? 'resume' : 'fresh',
  fullModel: fullPlan.counts,
  runtimeRisk: riskPlan.counts,
  selection: riskPlan.selection,
  workers: pool.maximumWorkers,
  initialWorkers: riskWorkers,
  startedGroupIds: pool.startedGroupIds,
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
