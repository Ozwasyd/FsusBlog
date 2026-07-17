#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  UX_VIEWPORT_MODEL_ROUTE_IDS,
  buildUxViewportPlan
} from '../../tests/frontend/support/playwright/uxViewportPlan.mjs'
import { writeUxViewportSummary } from '../../tests/frontend/checks/ux/write-ux-viewport-summary.mjs'
import { buildUxRiskSessionPlan } from './ux-risk-session-plan.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontend = path.join(root, 'src/frontend')
const matrix = JSON.parse(fs.readFileSync(
  path.join(root, 'tests/frontend/fixtures/ux-viewport-matrix.json'),
  'utf8'
))
const routes = UX_VIEWPORT_MODEL_ROUTE_IDS.map((id) => ({
  id,
  storage: id.startsWith('public-') ? 'anonymous' : id.startsWith('user-') ? 'user' : 'admin'
}))
const fullPlan = buildUxViewportPlan({ matrix, routes, mode: 'boundaries' })
const riskPlan = buildUxViewportPlan({
  matrix,
  routes,
  mode: 'boundaries',
  filters: { riskMatrix: true }
})
const workerEnvironmentNames = [
  'FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS',
  'FSUSBLOG_PLAYWRIGHT_WORKERS',
  'FSUSBLOG_UX_VIEWPORT_WORKERS'
]
const resourcePlan = Object.freeze({
  diagnosticsOnly: true,
  outerBrowserLanes: 1,
  workers: 1,
  maximumWorkers: 1,
  dynamicInnerPool: false,
  persistentElasticPool: false,
  capacitySource: 'browser-diagnostics-fixed-topology'
})

if (process.argv[2] === '--print-resource-plan') {
  if (process.argv.length !== 3) throw new Error('--print-resource-plan does not accept extra arguments')
  process.stdout.write(`${JSON.stringify(resourcePlan)}\n`)
  process.exit(0)
}
if (process.argv.length !== 2) {
  throw new Error(`unknown UX risk diagnostics argument: ${process.argv.slice(2).join(' ')}`)
}
if (process.env.FSUSBLOG_BROWSER_DIAGNOSTICS !== '1') {
  throw new Error('UX risk runner is diagnostics-only; use the browser diagnostics catalog')
}
for (const name of workerEnvironmentNames) requireSingleWorker(name)
if (process.env.FSUSBLOG_PLAYWRIGHT_CONFIG !== 'playwright.diagnostics.config.ts') {
  throw new Error('UX risk diagnostics require playwright.diagnostics.config.ts')
}
if (process.env.FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY !== '1') {
  throw new Error('UX risk diagnostics require managed-only Playwright')
}
if (process.env.FSUSBLOG_PLAYWRIGHT_RETRIES !== '0') {
  throw new Error('UX risk diagnostics disable Playwright retries')
}
if (fullPlan.counts.cases !== 6468) {
  throw new Error(`full UX model must contain 6468 cases, got ${fullPlan.counts.cases}`)
}
if (riskPlan.counts.navigations > 48) {
  throw new Error(`risk UX runtime exceeds 48 navigations: ${riskPlan.counts.navigations}`)
}

const diagnosticsRunId = requireSafeRunId(
  process.env.FSUSBLOG_BROWSER_DIAGNOSTIC_NAMESPACE,
  'FSUSBLOG_BROWSER_DIAGNOSTIC_NAMESPACE'
)
const uxRunId = requireSafeRunId(
  process.env.FSUSBLOG_UX_VIEWPORT_RUN_ID,
  'FSUSBLOG_UX_VIEWPORT_RUN_ID'
)
const uxRunToken = requireSafeRunId(
  process.env.FSUSBLOG_UX_VIEWPORT_RUN_TOKEN,
  'FSUSBLOG_UX_VIEWPORT_RUN_TOKEN'
)
const playwrightBaseUrl = requireHttpUrl(
  process.env.FSUSBLOG_RELEASE_PREVIEW_URL,
  'FSUSBLOG_RELEASE_PREVIEW_URL'
)
const publicBaseUrl = requireHttpUrl(
  process.env.FSUSBLOG_DEBUG_BACKEND_URL,
  'FSUSBLOG_DEBUG_BACKEND_URL'
)
const inheritedStepDeadlineMs = optionalPositiveNumber(
  process.env.FSUSBLOG_STEP_DEADLINE_MS,
  'FSUSBLOG_STEP_DEADLINE_MS'
)
const sessionPlan = buildUxRiskSessionPlan(1, { env: process.env, repoRoot: root })
const [sessionId] = sessionPlan.sessionIds
const [fixtureFile] = sessionPlan.fixtureFiles
const playwrightOutputDir = path.resolve(
  frontend,
  process.env.PLAYWRIGHT_OUTPUT_DIR
    || path.join(root, '.tmp/browser-diagnostics-runtime/ux-risk/playwright')
)
assertInsideRepository(playwrightOutputDir, 'PLAYWRIGHT_OUTPUT_DIR')

const baseEnvironment = {
  ...process.env,
  FSUSBLOG_BROWSER_DIAGNOSTICS: '1',
  FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS: '1',
  FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
  FSUSBLOG_UX_VIEWPORT_WORKERS: '1',
  FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY: '1',
  FSUSBLOG_PLAYWRIGHT_CONFIG: 'playwright.diagnostics.config.ts',
  FSUSBLOG_PLAYWRIGHT_RETRIES: '0',
  FSUSBLOG_UX_VIEWPORT_MODE: 'boundaries',
  FSUSBLOG_UX_VIEWPORT_RISK_MATRIX: '1',
  FSUSBLOG_UX_VIEWPORT_SCREENSHOTS: '1',
  FSUSBLOG_UX_VIEWPORT_POOL_SIZE: '1',
  FSUSBLOG_TEST_SESSION_ISOLATION: '1',
  FSUSBLOG_DISABLE_NOTIFICATION_STREAM: '1',
  FSUSBLOG_PLAYWRIGHT_TRACE: 'off',
  FSUSBLOG_UX_VIEWPORT_PUBLIC_BASE_URL: publicBaseUrl,
  FSUSBLOG_UX_VIEWPORT_RUN_ID: uxRunId,
  FSUSBLOG_UX_VIEWPORT_RUN_TOKEN: uxRunToken,
  FSUSBLOG_UX_VIEWPORT_RESUME: '0',
  FSUSBLOG_UX_VIEWPORT_PERSISTENT_WORKER: '0',
  FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP: '1',
  FSUSBLOG_TEST_SESSION: sessionId,
  FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE: fixtureFile,
  FSUSBLOG_UX_VIEWPORT_CURRENT_OUTPUT_DIR: playwrightOutputDir,
  FSUSBLOG_BASE_URL: publicBaseUrl,
  PLAYWRIGHT_BASE_URL: playwrightBaseUrl,
  PLAYWRIGHT_OUTPUT_DIR: playwrightOutputDir,
  ...(inheritedStepDeadlineMs === undefined ? {} : {
    FSUSBLOG_STEP_DEADLINE_AT_MS: String(Date.now() + inheritedStepDeadlineMs)
  })
}
delete baseEnvironment.FSUSBLOG_PLAYWRIGHT_SHARD_ARG
delete baseEnvironment.FSUSBLOG_UX_VIEWPORT_EXECUTION_GROUP_IDS

console.log(
  `[browser-diagnostics:ux-risk] run=${diagnosticsRunId} workers=1 navigations=${riskPlan.counts.navigations}`
)
const startedAtMs = Date.now()
await preparePlaywrightSession(baseEnvironment)
await runPlaywright(baseEnvironment)

const { summary } = await writeUxViewportSummary({
  root,
  mode: 'boundaries',
  runId: uxRunId
})
if (summary.status !== 'ok'
  || summary.plannedNavigationCount !== riskPlan.counts.navigations
  || summary.completedNavigationCount !== riskPlan.counts.navigations
  || summary.completedRouteThemeGroupCount !== riskPlan.counts.routeThemeGroups) {
  throw new Error(
    `risk UX summary is incomplete: status=${summary.status}`
    + ` navigations=${summary.completedNavigationCount}/${riskPlan.counts.navigations}`
    + ` groups=${summary.completedRouteThemeGroupCount}/${riskPlan.counts.routeThemeGroups}`
  )
}
if (summary.runId !== uxRunId) {
  throw new Error(`risk UX summary belongs to ${summary.runId}, expected ${uxRunId}`)
}

const evidence = {
  schema: 'fsusblog.browser-diagnostics.ux-risk.v1',
  status: 'success',
  evidenceClass: 'diagnostic',
  affectsCorrectness: false,
  diagnosticsRunId,
  uxRunId,
  executionMode: 'single-playwright-cli',
  fullModel: fullPlan.counts,
  runtimeRisk: riskPlan.counts,
  selection: riskPlan.selection,
  topology: resourcePlan,
  playwrightProcessCount: 1,
  browserLaunchCount: 1,
  workerLifecycle: [{ workerIndex: 0, sessionId, groupCount: riskPlan.counts.routeThemeGroups }],
  startedGroupIds: riskPlan.groups.map((group) => group.id),
  completedGroupIds: riskPlan.groups.map((group) => group.id),
  wallClockMs: Date.now() - startedAtMs,
  playwrightBaseUrl,
  publicBaseUrl,
  runtimeSummary: summary,
  generatedAt: new Date().toISOString()
}
const outFile = path.join(root, '.tmp/browser-diagnostics-runtime/ux-risk/summary.json')
writeJsonAtomic(outFile, evidence)
console.log(`[browser-diagnostics:ux-risk] wrote ${path.relative(root, outFile)}`)

async function preparePlaywrightSession(env) {
  const script = path.join(root, 'tests/frontend/fixtures/prepare-playwright-sessions.mjs')
  await runChild(process.execPath, [script, '--workers', '1', '--concurrency', '1'], {
    cwd: frontend,
    env: {
      ...env,
      FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY: '1'
    },
    label: 'prepare single Playwright diagnostics session'
  })
  if (!fs.existsSync(fixtureFile)) {
    throw new Error(`UX risk diagnostics fixture is missing: ${fixtureFile}`)
  }
}

async function runPlaywright(env) {
  const cli = path.join(frontend, 'node_modules/@playwright/test/cli.js')
  await runChild(process.execPath, [
    cli,
    'test',
    '--config=playwright.diagnostics.config.ts',
    '--workers=1',
    'ux/viewport-boundaries.spec.ts'
  ], {
    cwd: frontend,
    env,
    label: 'single-worker UX risk diagnostics'
  })
}

function runChild(command, args, { cwd, env, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error(`${label} failed (${signal || `exit ${code ?? 1}`})`))
    })
  })
}

function requireSingleWorker(name) {
  const raw = String(process.env[name] ?? '').trim()
  if (raw !== '1') throw new Error(`${name} must be exactly 1 for browser diagnostics`)
}

function requireSafeRunId(value, label) {
  const normalized = String(value ?? '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(normalized)) {
    throw new Error(`${label} must be a safe non-empty run id`)
  }
  return normalized
}

function requireHttpUrl(value, label) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(`${label} is required`)
  const url = new URL(normalized)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} must use http or https`)
  return url.href
}

function optionalPositiveNumber(value, label) {
  if (value === undefined || String(value).trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`)
  return parsed
}

function assertInsideRepository(file, label) {
  const relative = path.relative(root, file)
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the repository`)
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}
