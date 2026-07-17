#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
      receiptFile: path.relative(root, receiptFile).replaceAll(path.sep, '/'),
      contentDigest: verification.receipt.contentDigest,
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

export async function runBrowserDiagnostics(options, dependencies = {}) {
  const categories = dependencies.categories || selectBrowserDiagnostics(options.categoryIds)
  const baseEnvironment = dependencies.env || process.env
  const resources = resolveDiagnosticResourceState({
    env: baseEnvironment,
    requestedWorkers: options.workers
  })
  const source = dependencies.source || await resolveSourceAndBuild(options, baseEnvironment)
  const localFsusUi = dependencies.localFsusUi || resolveLocalFsusUiIdentity({ env: baseEnvironment })
  const runId = sanitizeIdentity(dependencies.runId || process.env.FSUSBLOG_BROWSER_DIAGNOSTICS_RUN_ID || [
    options.mode,
    source.commit.slice(0, 12),
    process.env.GITHUB_RUN_ID || Date.now(),
    process.env.GITHUB_RUN_ATTEMPT || process.pid,
    randomUUID().slice(0, 8)
  ].join('-'))
  const outputRoot = resolveDiagnosticsOutputRoot(options.outputRoot, runId)
  const plan = {
    schema: 'fsusblog.browser-diagnostics-plan.v1',
    mode: options.mode,
    runId,
    evidenceClass: 'diagnostic',
    affectsCorrectness: false,
    sourceState: { commit: source.commit, worktreeFingerprint: source.worktreeFingerprint },
    build: source.build,
    localFsusUi,
    resources,
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
    categories: categories.map((category) => ({
      id: category.id,
      browsers: category.browsers,
      risk: category.risk,
      replacements: category.replacements,
      probes: category.probes.map((probe) => ({
        id: probe.id,
        command: probe.command,
        artifactPaths: probe.artifactPaths,
        timeoutMinutes: probe.timeoutMinutes
      }))
    })),
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
    const receipt = {
      schema: 'fsusblog.browser-diagnostics-receipt.v1',
      status: 'incomplete',
      evidenceClass: 'diagnostic',
      affectsCorrectness: false,
      mode: options.mode,
      runId,
      sourceState: plan.sourceState,
      build: plan.build,
      localFsusUi: plan.localFsusUi,
      resources,
      topology: plan.topology,
      plannedCategoryCount: plan.plannedCategoryCount,
      executedCategoryCount: 0,
      plannedProbeCount: plan.plannedProbeCount,
      executedProbeCount: 0,
      skippedProbeCount: plan.plannedProbeCount,
      incompleteReason: resources.reason,
      failureClasses: ['infra'],
      categories: categoryResults,
      createdAt: new Date().toISOString()
    }
    receipt.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(receipt)).digest('hex')}`
    const receiptFile = path.join(outputRoot, 'receipt.json')
    writeJson(receiptFile, receipt)
    const latestFile = path.join(root, '.tmp/browser-diagnostics/latest.json')
    writeJson(latestFile, { runId, receipt: path.relative(root, receiptFile).replaceAll(path.sep, '/') })
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
            artifactContractError: `successful probe did not materialize declared artifacts: ${artifactContract.missingPaths.join(', ')}`
          }
        }
        const copiedArtifacts = copyArtifacts(declaredArtifacts, path.join(probeOutput, 'artifacts'))
        probeResults.push({
          id: probe.id,
          command: probe.command,
          ...result,
          artifactContract: {
            ...artifactContract,
            status: artifactContract.missingPaths.length === 0
              ? 'success'
              : result.status === 'success' ? 'incomplete' : 'failure'
          },
          copiedArtifacts
        })
      }
      const categoryResult = {
        id: category.id,
        status: cancellationSignal
          ? 'incomplete'
          : probeResults.every((probe) => probe.status === 'success') ? 'success' : 'failure',
        failureClasses: [...new Set(probeResults.map((probe) => probe.failureClass).filter(Boolean))],
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
  const probeResults = categoryResults.flatMap((category) => category.probes)
  const skippedProbeCount = plan.plannedProbeCount - probeResults.length
  const failureClasses = [...new Set(probeResults.map((probe) => probe.failureClass).filter(Boolean))]
  if (cancellationSignal && !failureClasses.includes('infra')) failureClasses.push('infra')
  const receipt = {
    schema: 'fsusblog.browser-diagnostics-receipt.v1',
    status: skippedProbeCount > 0
      ? 'incomplete'
      : probeResults.every((probe) => probe.status === 'success') ? 'success' : 'failure',
    evidenceClass: 'diagnostic',
    affectsCorrectness: false,
    mode: options.mode,
    runId,
    sourceState: plan.sourceState,
    build: plan.build,
    localFsusUi: plan.localFsusUi,
    resources,
    topology: plan.topology,
    plannedCategoryCount: plan.plannedCategoryCount,
    executedCategoryCount: categoryResults.length,
    plannedProbeCount: plan.plannedProbeCount,
    executedProbeCount: probeResults.length,
    skippedProbeCount,
    incompleteReason: cancellationSignal ? `cancelled:${cancellationSignal}` : null,
    failureClasses,
    categories: categoryResults,
    createdAt: new Date().toISOString()
  }
  receipt.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(receipt)).digest('hex')}`
  const receiptFile = path.join(outputRoot, 'receipt.json')
  writeJson(receiptFile, receipt)
  const latestFile = path.join(root, '.tmp/browser-diagnostics/latest.json')
  writeJson(latestFile, { runId, receipt: path.relative(root, receiptFile).replaceAll(path.sep, '/') })
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
