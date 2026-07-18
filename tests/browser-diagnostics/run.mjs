#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import {
  browserDiagnosticProbeCount,
  selectBrowserDiagnostics
} from './catalog.mjs'
import { resolveLocalFsusUiIdentity } from './local-fsusui-identity.mjs'
import { verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs'
import {
  sealBrowserDiagnosticsReceipt,
  validateBrowserDiagnosticsReceipt
} from '../../tools/release/test-evidence-receipts.mjs'
import { snapshotGitWorktree } from '../../tools/test-matrix/scheduler.mjs'
import { resolveWorkerTestSession } from '../frontend/support/test-session.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const thisFile = fileURLToPath(import.meta.url)
const infraFailurePattern = /browser (?:closed|crash|disconnect)|target .*closed|oom|out of memory|err_insufficient_resources|emfile|enfile|failed to launch|executable doesn't exist|browser_not_installed|no_supported_browser|infra-failure|signal (?:sigkill|sigsegv)/iu
const diagnosticResourceStatuses = new Set(['complete', 'skipped', 'incomplete'])

function parsePositiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function sanitizeIdentity(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 100) || 'local'
}

function diagnosticTrigger(mode, env) {
  const event = String(env.GITHUB_EVENT_NAME ?? '').trim()
  return {
    kind: event || (mode === 'nightly' ? 'local-nightly' : 'local-manual'),
    workflow: String(env.GITHUB_WORKFLOW ?? '').trim() || null,
    runId: String(env.GITHUB_RUN_ID ?? '').trim() || null,
    runAttempt: String(env.GITHUB_RUN_ATTEMPT ?? '').trim() || null,
    ref: String(env.GITHUB_REF ?? '').trim() || null
  }
}

export function resolveDiagnosticsOutputRoot(requestedOutputRoot, runId) {
  const diagnosticsRoot = path.join(root, '.tmp/browser-diagnostics')
  const outputRoot = path.resolve(
    root,
    requestedOutputRoot || path.join('.tmp/browser-diagnostics', runId)
  )
  const relative = path.relative(diagnosticsRoot, outputRoot)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('browser diagnostics output must be a run directory below .tmp/browser-diagnostics')
  }
  return outputRoot
}

function parseArguments(argv) {
  const options = {
    mode: process.env.FSUSBLOG_BROWSER_DIAGNOSTICS_MODE || 'manual',
    categoryIds: [],
    planOnly: false,
    workers: parsePositiveInteger(process.env.FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS || '1', 'diagnostic workers'),
    outputRoot: process.env.FSUSBLOG_BROWSER_DIAGNOSTICS_OUTPUT_ROOT || '',
    probeTimeoutMinutes: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === 'nightly' || value === 'manual') options.mode = value
    else if (value === '--plan-only') options.planOnly = true
    else if (value === '--category') options.categoryIds.push(argv[++index])
    else if (value === '--workers') options.workers = parsePositiveInteger(argv[++index], '--workers')
    else if (value === '--output') options.outputRoot = argv[++index]
    else if (value === '--probe-timeout-minutes') options.probeTimeoutMinutes = parsePositiveInteger(argv[++index], '--probe-timeout-minutes')
    else throw new Error(`unknown browser diagnostics argument: ${value}`)
  }
  if (!['nightly', 'manual'].includes(options.mode)) throw new Error(`invalid browser diagnostics mode: ${options.mode}`)
  if (options.categoryIds.some((id) => !id)) throw new Error('--category requires a value')
  return options
}

export function resolveDiagnosticResourceState({ env = process.env, requestedWorkers = 1 } = {}) {
  const parsedRequestedWorkers = parsePositiveInteger(requestedWorkers, 'requested diagnostic workers')
  if (parsedRequestedWorkers !== 1) {
    return {
      status: 'incomplete',
      reason: `requested-workers-${parsedRequestedWorkers}-cannot-be-reduced-silently-to-fixed-one`,
      requestedWorkers: parsedRequestedWorkers,
      effectiveWorkers: 1,
      sessionCount: 1
    }
  }

  const status = String(env.FSUSBLOG_BROWSER_DIAGNOSTICS_RESOURCE_STATUS || 'complete').trim().toLowerCase()
  if (!diagnosticResourceStatuses.has(status)) {
    throw new Error('FSUSBLOG_BROWSER_DIAGNOSTICS_RESOURCE_STATUS must be complete, skipped, or incomplete')
  }
  const reason = String(env.FSUSBLOG_BROWSER_DIAGNOSTICS_RESOURCE_REASON || '').trim()
  if (status !== 'complete' && !reason) {
    throw new Error('reduced browser diagnostic resources require FSUSBLOG_BROWSER_DIAGNOSTICS_RESOURCE_REASON')
  }
  return {
    status,
    reason: reason || null,
    requestedWorkers: parsedRequestedWorkers,
    effectiveWorkers: 1,
    sessionCount: 1
  }
}

function resolveBuildReceiptFile(env = process.env) {
  const candidates = [
    env.FSUSBLOG_BROWSER_DIAGNOSTICS_BUILD_RECEIPT,
    env.FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT
      ? path.join(env.FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT, 'receipt.json')
      : null,
    path.join(root, '.tmp/ci-production-build/receipt.json')
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

async function resolveSourceAndBuild(options, env = process.env) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const snapshot = await snapshotGitWorktree(root)
  if (options.planOnly) return { commit, worktreeFingerprint: snapshot.fingerprint, build: null }
  const receiptFile = resolveBuildReceiptFile(env)
  if (!receiptFile) throw new Error('browser diagnostics require an immutable production build receipt')
  const verification = verifyProductionBuildReceipt({
    artifactRoot: path.dirname(receiptFile),
    receiptFile: path.basename(receiptFile),
    expectedSourceState: { commit, worktreeFingerprint: snapshot.fingerprint }
  })
  const requiredDomains = ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm']
  const domains = new Set(verification.receipt.domains.map((domain) => domain.name))
  const missingDomains = requiredDomains.filter((domain) => !domains.has(domain))
  if (missingDomains.length > 0) throw new Error(`browser diagnostics build is missing domains: ${missingDomains.join(', ')}`)
  return {
    commit,
    worktreeFingerprint: snapshot.fingerprint,
    build: {
      schema: verification.receipt.schema,
      receiptFile: path.relative(root, receiptFile).replaceAll(path.sep, '/'),
      contentDigest: verification.receipt.contentDigest,
      receiptContentDigest: verification.receipt.contentDigest,
      sourceState: verification.receipt.sourceState,
      domains: requiredDomains,
      artifactCount: verification.evidence.artifactCount,
      artifactBytes: verification.evidence.artifactBytes,
      verifiedAt: verification.evidence.verifiedAt
    }
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function normalizeArtifactPaths(paths) {
  return [...new Set(paths.map((value) => String(value).replaceAll('\\', '/').replace(/^\.\//u, '')))]
    .map((relativePath) => {
      const absolutePath = path.resolve(root, relativePath)
      const relativeToRoot = path.relative(root, absolutePath)
      if (!relativePath
        || relativeToRoot === ''
        || relativeToRoot.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeToRoot)) {
        throw new Error(`browser diagnostic artifact must stay below the repository root: ${relativePath}`)
      }
      return { relativePath, absolutePath }
    })
}

function cleanDeclaredArtifacts(paths) {
  const normalized = normalizeArtifactPaths(paths)
  for (const artifact of normalized) {
    fs.rmSync(artifact.absolutePath, { recursive: true, force: true })
  }
  return normalized
}

function isMaterializedArtifact(absolutePath) {
  if (!fs.existsSync(absolutePath)) return false
  const stat = fs.lstatSync(absolutePath)
  if (stat.isSymbolicLink()) return false
  if (stat.isFile()) return stat.size > 0
  if (stat.isDirectory()) return fs.readdirSync(absolutePath).length > 0
  return false
}

function inspectArtifactContract(artifacts) {
  const materializedPaths = []
  const missingPaths = []
  for (const artifact of artifacts) {
    if (isMaterializedArtifact(artifact.absolutePath)) materializedPaths.push(artifact.relativePath)
    else missingPaths.push(artifact.relativePath)
  }
  return {
    freshness: 'precleaned-before-probe',
    declaredPaths: artifacts.map((artifact) => artifact.relativePath),
    materializedPaths,
    missingPaths
  }
}

function copyArtifacts(artifacts, destination) {
  const copied = []
  for (const artifact of artifacts) {
    if (!isMaterializedArtifact(artifact.absolutePath)) continue
    const target = path.join(destination, artifact.relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(artifact.absolutePath, target, { recursive: true, force: true })
    copied.push(artifact.relativePath)
  }
  return copied
}

export function classifyDiagnosticFailure({ timedOut = false, signal = null, output = '', exitCode = 0 }) {
  if (timedOut || signal || infraFailurePattern.test(output)) return 'infra'
  return exitCode === 0 ? null : 'diagnostic'
}

export function classifyDiagnosticFailureKind({ timedOut = false, signal = null, output = '', exitCode = 0 }) {
  if (exitCode === 0 && !timedOut && !signal) return null
  if (timedOut) return 'probe-timeout'
  if (signal) return 'runner-process-signal'
  if (/browser (?:closed|crash|disconnect)|target .*closed/iu.test(output)) return 'browser-process-crash'
  if (infraFailurePattern.test(output)) return 'browser-infrastructure-failure'
  return 'diagnostic-failure'
}

export function diagnosticProbeEnvironment({ baseEnvironment, runId, categoryId, probeId, outputDir, workers }) {
  if (workers !== 1) throw new Error('browser diagnostic probe environment requires one fixed worker')
  const laneIdentity = sanitizeIdentity(`${runId}-${categoryId}-${probeId}`)
  const diagnosticNamespace = sanitizeIdentity(`browser-diagnostics-${laneIdentity}`).toLowerCase()
  const fixedSession = resolveWorkerTestSession(0, { FSUSBLOG_TEST_SESSION_PREFIX: laneIdentity })
  const environment = {
    ...baseEnvironment,
    FSUSBLOG_BROWSER_DIAGNOSTICS: '1',
    FSUSBLOG_BROWSER_DIAGNOSTIC_CATEGORY: categoryId,
    FSUSBLOG_BROWSER_DIAGNOSTIC_LANE: probeId,
    FSUSBLOG_BROWSER_DIAGNOSTIC_NAMESPACE: laneIdentity,
    FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS: '1',
    FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
    FSUSBLOG_VISUAL_PUBLIC_WORKERS: '1',
    FSUSBLOG_CONSOLE_VISUAL_WORKERS: '1',
    FSUSBLOG_UX_VIEWPORT_WORKERS: '1',
    FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS: '1',
    FSUSBLOG_SPA_ROUTES_WORKERS: '1',
    FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY: '1',
    FSUSBLOG_PLAYWRIGHT_CONFIG: 'playwright.diagnostics.config.ts',
    FSUSBLOG_PLAYWRIGHT_RETRIES: '0',
    FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-diagnostics',
    FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY: '1',
    FSUSBLOG_TEST_SESSION_ISOLATION: '1',
    FSUSBLOG_TEST_NAMESPACE: diagnosticNamespace,
    FSUSBLOG_FIXTURE_ROOT: path.join(outputDir, 'fixtures'),
    FSUSBLOG_TEST_SESSION: fixedSession,
    FSUSBLOG_TEST_SESSION_PREFIX: laneIdentity,
    FSUSBLOG_PLAYWRIGHT_SESSION_PREFIX: laneIdentity,
    FSUSBLOG_UX_VIEWPORT_RUN_ID: laneIdentity,
    FSUSBLOG_UX_VIEWPORT_RUN_TOKEN: laneIdentity,
    FSUSBLOG_UX_VIEWPORT_RESUME: '0',
    FSUSBLOG_BROWSER_DIAGNOSTICS_OUTPUT_ROOT: outputDir,
    FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT: outputDir,
    PLAYWRIGHT_OUTPUT_DIR: path.join(outputDir, 'playwright')
  }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('FSUSBLOG_BROWSER_CONTRACT')) delete environment[key]
  }
  return environment
}

function stopProcessGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') child.kill(signal)
  else {
    try { process.kill(-child.pid, signal) } catch (error) {
      if (error.code !== 'ESRCH') child.kill(signal)
    }
  }
}

function executeProbe({ probe, env, outputDir, timeoutMinutes, activeChildren }) {
  return new Promise((resolve) => {
    fs.mkdirSync(outputDir, { recursive: true })
    const stdoutFile = path.join(outputDir, 'stdout.log')
    const stderrFile = path.join(outputDir, 'stderr.log')
    const stdout = fs.createWriteStream(stdoutFile)
    const stderr = fs.createWriteStream(stderrFile)
    const startedAtMs = Date.now()
    const child = spawn(probe.command[0], probe.command.slice(1), {
      cwd: root,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    activeChildren.add(child)
    let outputTail = ''
    let timedOut = false
    const remember = (chunk) => {
      outputTail = `${outputTail}${chunk}`.slice(-32_768)
    }
    stdout.on('error', remember)
    stderr.on('error', remember)
    child.stdout.on('data', (chunk) => {
      stdout.write(chunk)
      process.stdout.write(chunk)
      remember(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr.write(chunk)
      process.stderr.write(chunk)
      remember(chunk)
    })
    const timeout = setTimeout(() => {
      timedOut = true
      stopProcessGroup(child, 'SIGTERM')
      setTimeout(() => stopProcessGroup(child, 'SIGKILL'), 5_000).unref()
    }, timeoutMinutes * 60_000)
    child.on('error', (error) => remember(error.stack || error.message))
    child.on('close', async (code, signal) => {
      clearTimeout(timeout)
      activeChildren.delete(child)
      stdout.end()
      stderr.end()
      await Promise.allSettled([finished(stdout), finished(stderr)])
      const exitCode = Number.isInteger(code) ? code : 1
      resolve({
        status: exitCode === 0 && !signal && !timedOut ? 'success' : 'failure',
        failureClass: classifyDiagnosticFailure({ timedOut, signal, output: outputTail, exitCode }),
        failureKind: classifyDiagnosticFailureKind({ timedOut, signal, output: outputTail, exitCode }),
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAtMs,
        stdout: path.relative(root, stdoutFile).replaceAll(path.sep, '/'),
        stderr: path.relative(root, stderrFile).replaceAll(path.sep, '/')
      })
    })
  })
}

function probePlannedDimensions(probe) {
  return {
    viewports: [...new Set(probe?.plannedDimensions?.viewports ?? ['1280x800'])].sort(),
    themes: [...new Set(probe?.plannedDimensions?.themes ?? ['light'])].sort()
  }
}

function categoryPlannedDimensions(category) {
  return {
    viewports: [...new Set(category.probes.flatMap((probe) => probePlannedDimensions(probe).viewports))].sort(),
    themes: [...new Set(category.probes.flatMap((probe) => probePlannedDimensions(probe).themes))].sort()
  }
}

function diagnosticsDimensions(categories) {
  const plannedViewports = categories.flatMap((category) => categoryPlannedDimensions(category).viewports)
  const plannedThemes = categories.flatMap((category) => categoryPlannedDimensions(category).themes)
  return {
    browsers: [...new Set(categories.flatMap((category) => category.browsers))].sort(),
    viewports: [...new Set(plannedViewports)].sort(),
    themes: [...new Set(plannedThemes)].sort(),
    lanes: categories.flatMap((category) => category.probes.map((probe) => `${category.id}/${probe.id}`)).sort()
  }
}

function diagnosticsPlanCategories(categories) {
  return categories.map((category) => ({
    id: category.id,
    browsers: category.browsers,
    risk: category.risk,
    replacements: category.replacements,
    plannedDimensions: categoryPlannedDimensions(category),
    plannedProbeIds: category.probes.map((probe) => probe.id).sort(),
    probes: category.probes.map((probe) => ({
      id: probe.id,
      command: probe.command,
      artifactPaths: probe.artifactPaths,
      timeoutMinutes: probe.timeoutMinutes,
      plannedDimensions: probePlannedDimensions(probe)
    }))
  }))
}

function initializationStage(error) {
  return /(?:build|receipt|artifact|domain)/iu.test(error instanceof Error ? error.message : String(error))
    ? 'build'
    : 'source'
}

function writeDiagnosticsReceipt(outputRoot, runId, receiptInput) {
  const receipt = sealBrowserDiagnosticsReceipt(receiptInput)
  const errors = validateBrowserDiagnosticsReceipt(receipt)
  if (errors.length > 0) throw new Error(`browser diagnostics produced an invalid receipt: ${errors.join('; ')}`)
  const receiptFile = path.join(outputRoot, 'receipt.json')
  writeJson(receiptFile, receipt)
  const latestFile = path.join(root, '.tmp/browser-diagnostics/latest.json')
  writeJson(latestFile, { runId, receipt: path.relative(root, receiptFile).replaceAll(path.sep, '/') })
  return { receipt, receiptFile }
}

function writeInitializationFailure({
  options,
  categories,
  baseEnvironment,
  resources,
  startedAtMs,
  runId,
  outputRoot,
  stage,
  error,
  source = null,
  localFsusUi = null
}) {
  const message = error instanceof Error ? error.message : String(error)
  const dimensions = diagnosticsDimensions(categories)
  const plannedProbeCount = browserDiagnosticProbeCount(categories)
  const sourceState = source ? { commit: source.commit, worktreeFingerprint: source.worktreeFingerprint } : null
  const plan = {
    schema: 'fsusblog.browser-diagnostics-plan.v1',
    status: 'incomplete',
    mode: options.mode,
    cadence: options.mode === 'nightly' ? 'nightly' : 'manual',
    trigger: diagnosticTrigger(options.mode, baseEnvironment),
    runId,
    evidenceClass: 'diagnostic',
    affectsCorrectness: false,
    sourceState,
    build: source?.build ?? null,
    localFsusUi,
    resources,
    dimensions,
    categories: diagnosticsPlanCategories(categories),
    plannedCategoryCount: categories.length,
    plannedProbeCount,
    incompleteReason: `initialization:${stage}:${message}`
  }
  fs.rmSync(outputRoot, { recursive: true, force: true })
  writeJson(path.join(outputRoot, 'plan.json'), plan)
  const categoryResults = categories.map((category) => ({
    id: category.id,
    browsers: category.browsers,
    plannedDimensions: categoryPlannedDimensions(category),
    plannedProbeIds: category.probes.map((probe) => probe.id).sort(),
    status: 'skipped',
    incompleteReason: plan.incompleteReason,
    plannedProbeCount: category.probes.length,
    executedProbeCount: 0,
    skippedProbeCount: category.probes.length,
    failureClasses: ['infra-failure'],
    probes: []
  }))
  const initializationFailure = {
    stage,
    failureClass: 'infra-failure',
    failureKind: 'initialization-failure',
    name: error instanceof Error ? error.name : 'Error',
    message
  }
  const { receipt, receiptFile } = writeDiagnosticsReceipt(outputRoot, runId, {
    status: 'incomplete',
    mode: options.mode,
    cadence: plan.cadence,
    trigger: plan.trigger,
    runId,
    sourceState,
    build: source?.build ?? null,
    localFsusUi,
    resources,
    dimensions,
    plannedCategoryCount: categories.length,
    executedCategoryCount: 0,
    plannedProbeCount,
    executedProbeCount: 0,
    skippedProbeCount: plannedProbeCount,
    incompleteReason: plan.incompleteReason,
    initializationFailure,
    failureClasses: ['infra-failure'],
    categories: categoryResults,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date().toISOString(),
    wallClockMs: Date.now() - startedAtMs,
    createdAt: new Date().toISOString()
  })
  return { status: receipt.status, plan, receipt, receiptFile }
}

export async function runBrowserDiagnostics(options, dependencies = {}) {
  const startedAtMs = Date.now()
  const categories = dependencies.categories || selectBrowserDiagnostics(options.categoryIds)
  const baseEnvironment = dependencies.env || process.env
  const resources = resolveDiagnosticResourceState({
    env: baseEnvironment,
    requestedWorkers: options.workers
  })
  let source
  try {
    const resolveSource = dependencies.resolveSourceAndBuild || resolveSourceAndBuild
    source = dependencies.source || await resolveSource(options, baseEnvironment)
  } catch (error) {
    const runId = sanitizeIdentity(dependencies.runId || baseEnvironment.FSUSBLOG_BROWSER_DIAGNOSTICS_RUN_ID || [
      options.mode,
      'initialization',
      baseEnvironment.GITHUB_RUN_ID || Date.now(),
      baseEnvironment.GITHUB_RUN_ATTEMPT || process.pid,
      randomUUID().slice(0, 8)
    ].join('-'))
    const outputRoot = resolveDiagnosticsOutputRoot(options.outputRoot, runId)
    return writeInitializationFailure({
      options, categories, baseEnvironment, resources, startedAtMs, runId, outputRoot,
      stage: initializationStage(error), error
    })
  }
  const runId = sanitizeIdentity(dependencies.runId || process.env.FSUSBLOG_BROWSER_DIAGNOSTICS_RUN_ID || [
    options.mode,
    source.commit.slice(0, 12),
    process.env.GITHUB_RUN_ID || Date.now(),
    process.env.GITHUB_RUN_ATTEMPT || process.pid,
    randomUUID().slice(0, 8)
  ].join('-'))
  const outputRoot = resolveDiagnosticsOutputRoot(options.outputRoot, runId)
  let localFsusUi
  try {
    const resolveFsusUi = dependencies.resolveLocalFsusUiIdentity || resolveLocalFsusUiIdentity
    localFsusUi = dependencies.localFsusUi || resolveFsusUi({ env: baseEnvironment })
  } catch (error) {
    return writeInitializationFailure({
      options, categories, baseEnvironment, resources, startedAtMs, runId, outputRoot,
      stage: 'fsusui', error, source
    })
  }
  const dimensions = diagnosticsDimensions(categories)
  const plan = {
    schema: 'fsusblog.browser-diagnostics-plan.v1',
    mode: options.mode,
    cadence: options.mode === 'nightly' ? 'nightly' : 'manual',
    trigger: diagnosticTrigger(options.mode, baseEnvironment),
    runId,
    evidenceClass: 'diagnostic',
    affectsCorrectness: false,
    sourceState: { commit: source.commit, worktreeFingerprint: source.worktreeFingerprint },
    build: source.build,
    localFsusUi,
    resources,
    dimensions,
    topology: {
      requestedWorkerLimit: resources.requestedWorkers,
      workerLimit: resources.effectiveWorkers,
      fixedSessionCount: resources.sessionCount,
      outerAdmissionMode: 'single-explicit-browser-diagnostics-tier',
      maxActiveBrowserLanes: 1,
      dynamicInnerPool: false,
      retries: 0,
      categoriesSerial: true
    },
    categories: diagnosticsPlanCategories(categories),
    plannedCategoryCount: categories.length,
    plannedProbeCount: browserDiagnosticProbeCount(categories)
  }
  if (options.planOnly) {
    const planFile = path.join(outputRoot, 'plan.json')
    writeJson(planFile, plan)
    return { status: 'planned', plan, receiptFile: planFile }
  }

  fs.rmSync(outputRoot, { recursive: true, force: true })
  writeJson(path.join(outputRoot, 'plan.json'), plan)
  if (resources.status !== 'complete') {
    const categoryResults = categories.map((category) => ({
      id: category.id,
      browsers: category.browsers,
      plannedDimensions: categoryPlannedDimensions(category),
      plannedProbeIds: category.probes.map((probe) => probe.id).sort(),
      status: 'skipped',
      incompleteReason: resources.reason,
      plannedProbeCount: category.probes.length,
      executedProbeCount: 0,
      skippedProbeCount: category.probes.length,
      failureClasses: ['infra'],
      probes: []
    }))
    for (const categoryResult of categoryResults) {
      writeJson(path.join(outputRoot, 'categories', categoryResult.id, 'summary.json'), {
        schema: 'fsusblog.browser-diagnostics-category.v1',
        evidenceClass: 'diagnostic',
        affectsCorrectness: false,
        runId,
        mode: options.mode,
        sourceState: plan.sourceState,
        build: plan.build,
        localFsusUi: plan.localFsusUi,
        resources,
        ...categoryResult
      })
    }
    const { receipt, receiptFile } = writeDiagnosticsReceipt(outputRoot, runId, {
      status: 'incomplete',
      evidenceClass: 'diagnostic',
      affectsCorrectness: false,
      mode: options.mode,
      cadence: plan.cadence,
      trigger: plan.trigger,
      runId,
      sourceState: plan.sourceState,
      build: plan.build,
      localFsusUi: plan.localFsusUi,
      resources,
      dimensions: plan.dimensions,
      topology: plan.topology,
      plannedCategoryCount: plan.plannedCategoryCount,
      executedCategoryCount: 0,
      plannedProbeCount: plan.plannedProbeCount,
      executedProbeCount: 0,
      skippedProbeCount: plan.plannedProbeCount,
      incompleteReason: resources.reason,
      failureClasses: ['infra'],
      categories: categoryResults,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      wallClockMs: Date.now() - startedAtMs,
      createdAt: new Date().toISOString()
    })
    return { status: receipt.status, plan, receipt, receiptFile }
  }
  const activeChildren = new Set()
  let cancellationSignal = null
  const terminate = (signal) => {
    for (const child of activeChildren) stopProcessGroup(child, signal)
  }
  const cancel = (signal) => {
    cancellationSignal ||= signal
    terminate('SIGTERM')
  }
  const onSigint = () => cancel('SIGINT')
  const onSigterm = () => cancel('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  const categoryResults = []
  try {
    for (const category of categories) {
      if (cancellationSignal) break
      const probeResults = []
      for (const probe of category.probes) {
        if (cancellationSignal) break
        const probeOutput = path.join(outputRoot, 'categories', category.id, probe.id)
        const env = diagnosticProbeEnvironment({
          baseEnvironment,
          runId,
          categoryId: category.id,
          probeId: probe.id,
          outputDir: probeOutput,
          workers: resources.effectiveWorkers
        })
        const artifactPaths = [
          ...probe.artifactPaths,
          ...(category.id === 'ux' ? [`.tmp/ux/runs/${env.FSUSBLOG_UX_VIEWPORT_RUN_ID}`] : [])
        ]
        const declaredArtifacts = cleanDeclaredArtifacts(artifactPaths)
        const timeoutMinutes = options.probeTimeoutMinutes || probe.timeoutMinutes
        let result = dependencies.executeProbe
          ? await dependencies.executeProbe({ probe, env, outputDir: probeOutput, timeoutMinutes, activeChildren })
          : await executeProbe({ probe, env, outputDir: probeOutput, timeoutMinutes, activeChildren })
        const artifactContract = inspectArtifactContract(declaredArtifacts)
        if (result.status === 'success' && artifactContract.missingPaths.length > 0) {
          result = {
            ...result,
            status: 'failure',
            failureClass: 'infra',
            failureKind: 'artifact-contract-incomplete',
            artifactContractError: `successful probe did not materialize declared artifacts: ${artifactContract.missingPaths.join(', ')}`
          }
        }
        const copiedArtifacts = copyArtifacts(declaredArtifacts, path.join(probeOutput, 'artifacts'))
        const crashRetryCount = Math.max(0, Number(result.crashRetryCount ?? 0))
        let attempts = Array.isArray(result.attempts) && result.attempts.length > 0
          ? result.attempts
          : [{
              attempt: 1,
              status: result.status,
              testIds: [`${category.id}/${probe.id}`],
              failureClass: result.failureClass ?? null,
              failureKind: result.status === 'success'
                ? null
                : result.failureKind ?? (result.failureClass === 'infra' ? 'browser-infrastructure-failure' : 'diagnostic-failure'),
              artifacts: [...new Set([result.stdout, result.stderr, ...copiedArtifacts].filter(Boolean))].sort(),
              exitCode: result.exitCode ?? null,
              signal: result.signal ?? null,
              durationMs: result.durationMs ?? null
            }]
        attempts = attempts.map((attempt, index) => {
          const attemptNumber = index + 1
          const attemptFile = path.join(probeOutput, `attempt-${attemptNumber}.json`)
          const attemptArtifact = path.relative(root, attemptFile).replaceAll(path.sep, '/')
          const status = attempt.status
          const normalized = {
            ...attempt,
            attempt: attemptNumber,
            status,
            testIds: [...new Set(attempt.testIds ?? [`${category.id}/${probe.id}`])].sort(),
            failureClass: status === 'success' ? null : attempt.failureClass ?? result.failureClass ?? 'diagnostic',
            failureKind: status === 'success'
              ? null
              : attempt.failureKind ?? result.failureKind ?? (attempt.failureClass === 'infra' ? 'browser-infrastructure-failure' : 'diagnostic-failure'),
            artifacts: [...new Set([...(attempt.artifacts ?? []), attemptArtifact])].sort()
          }
          writeJson(attemptFile, {
            schema: 'fsusblog.browser-diagnostics-attempt.v1',
            evidenceClass: 'diagnostic',
            affectsCorrectness: false,
            runId,
            categoryId: category.id,
            probeId: probe.id,
            ...normalized
          })
          return normalized
        })
        probeResults.push({
          id: probe.id,
          command: probe.command,
          ...result,
          status: result.status,
          finalStatus: attempts.length === 2
            && attempts[0].failureKind === 'browser-process-crash'
            && attempts.at(-1)?.status === 'success'
            ? 'diagnostic-passed-after-infra-retry'
            : result.status,
          plannedDimensions: probePlannedDimensions(probe),
          testIds: [...new Set(attempts.flatMap((attempt) => attempt.testIds ?? []))].sort(),
          attempts,
          crashRetryCount,
          artifactContract: {
            ...artifactContract,
            status: artifactContract.missingPaths.length === 0
              ? 'success'
              : result.status === 'success' ? 'incomplete' : 'failure'
          },
          copiedArtifacts
        })
        const requestedCancellation = dependencies.afterProbe?.({
          categoryId: category.id,
          probeId: probe.id,
          result: probeResults.at(-1)
        })
        if (requestedCancellation) cancellationSignal ||= String(requestedCancellation)
      }
      const categoryResult = {
        id: category.id,
        browsers: category.browsers,
        plannedDimensions: categoryPlannedDimensions(category),
        plannedProbeIds: category.probes.map((probe) => probe.id).sort(),
        status: cancellationSignal
          ? 'incomplete'
          : probeResults.every((probe) => probe.status === 'success') ? 'success' : 'failure',
        failureClasses: [...new Set([
          ...probeResults.map((probe) => probe.failureClass).filter(Boolean),
          ...(cancellationSignal ? ['infra'] : [])
        ])],
        plannedProbeCount: category.probes.length,
        executedProbeCount: probeResults.length,
        skippedProbeCount: category.probes.length - probeResults.length,
        probes: probeResults
      }
      categoryResults.push(categoryResult)
      writeJson(path.join(outputRoot, 'categories', category.id, 'summary.json'), {
        schema: 'fsusblog.browser-diagnostics-category.v1',
        evidenceClass: 'diagnostic',
        affectsCorrectness: false,
        runId,
        mode: options.mode,
        sourceState: plan.sourceState,
        build: plan.build,
        localFsusUi: plan.localFsusUi,
        resources,
        ...categoryResult
      })
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    terminate('SIGTERM')
  }
  const recordedCategoryIds = new Set(categoryResults.map((category) => category.id))
  if (cancellationSignal) {
    for (const category of categories.filter((candidate) => !recordedCategoryIds.has(candidate.id))) {
      const categoryResult = {
        id: category.id,
        browsers: category.browsers,
        plannedDimensions: categoryPlannedDimensions(category),
        plannedProbeIds: category.probes.map((probe) => probe.id).sort(),
        status: 'skipped',
        incompleteReason: `cancelled:${cancellationSignal}`,
        failureClasses: ['infra'],
        plannedProbeCount: category.probes.length,
        executedProbeCount: 0,
        skippedProbeCount: category.probes.length,
        probes: []
      }
      categoryResults.push(categoryResult)
      writeJson(path.join(outputRoot, 'categories', category.id, 'summary.json'), {
        schema: 'fsusblog.browser-diagnostics-category.v1',
        evidenceClass: 'diagnostic',
        affectsCorrectness: false,
        runId,
        mode: options.mode,
        sourceState: plan.sourceState,
        build: plan.build,
        localFsusUi: plan.localFsusUi,
        resources,
        ...categoryResult
      })
    }
  }
  const probeResults = categoryResults.flatMap((category) => category.probes)
  const skippedProbeCount = plan.plannedProbeCount - probeResults.length
  const failureClasses = [...new Set(probeResults.map((probe) => probe.failureClass).filter(Boolean))]
  if (cancellationSignal && !failureClasses.includes('infra')) failureClasses.push('infra')
  const { receipt, receiptFile } = writeDiagnosticsReceipt(outputRoot, runId, {
    status: skippedProbeCount > 0
      ? 'incomplete'
      : probeResults.every((probe) => probe.status === 'success') ? 'success' : 'failure',
    evidenceClass: 'diagnostic',
    affectsCorrectness: false,
    mode: options.mode,
    cadence: plan.cadence,
    trigger: plan.trigger,
    runId,
    sourceState: plan.sourceState,
    build: plan.build,
    localFsusUi: plan.localFsusUi,
    resources,
    dimensions: plan.dimensions,
    topology: plan.topology,
    plannedCategoryCount: plan.plannedCategoryCount,
    executedCategoryCount: categoryResults.length,
    plannedProbeCount: plan.plannedProbeCount,
    executedProbeCount: probeResults.length,
    skippedProbeCount,
    incompleteReason: cancellationSignal ? `cancelled:${cancellationSignal}` : null,
    failureClasses,
    categories: categoryResults,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date().toISOString(),
    wallClockMs: Date.now() - startedAtMs,
    createdAt: new Date().toISOString()
  })
  return { status: receipt.status, plan, receipt, receiptFile }
}

async function main() {
  const result = await runBrowserDiagnostics(parseArguments(process.argv.slice(2)))
  const relativeReceipt = path.relative(root, result.receiptFile).replaceAll(path.sep, '/')
  if (result.status === 'planned') {
    console.log(`[browser-diagnostics] planned categories=${result.plan.plannedCategoryCount} probes=${result.plan.plannedProbeCount} receipt=${relativeReceipt}`)
    return
  }
  console.log(`[browser-diagnostics] ${result.status} categories=${result.receipt.executedCategoryCount}/${result.receipt.plannedCategoryCount} probes=${result.receipt.executedProbeCount}/${result.receipt.plannedProbeCount} receipt=${relativeReceipt}`)
  if (result.status !== 'success') process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(`[browser-diagnostics] ${error instanceof Error ? error.stack : String(error)}`)
    process.exitCode = 1
  })
}
