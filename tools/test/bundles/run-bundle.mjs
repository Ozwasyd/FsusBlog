#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from '../../test-matrix/parse-matrix.mjs'
import {
  artifactSubstitutionBindingDigest,
  matrixGeneratedRuntimePaths,
  resolveLocalProfileResources,
  resolveArtifactSubstitutions
} from '../../test-matrix/local-profile.mjs'
import { performanceMixedWindowFloorMs, validatePerformanceDeadlineEvidence } from '../../test-matrix/local-profile.mjs'
import {
  buildSettledPhaseJoinEvidence,
  executeWeightedStepDag,
  performanceSteps,
  resolveBundleRuntimeCapacity,
  resolveMachineExecutionTimeoutMs,
  resolveStepRuntimeCapacity,
  runtimeSteps
} from './bundle-steps.mjs'
import { readRuntimeEnvironment } from './runtime-environment.mjs'
import { validateShardSummaryArtifacts } from '../run-backend-production-shards.mjs'
import { buildLocalStaticManifest, planLocalStaticCommands } from '../local-static-governance.mjs'
import {
  productionBuildEnvironment,
  productionBuildLayoutDigest,
  productionDotnetArtifacts,
  resolveProductionBuildLayout
} from '../../test-matrix/production-build-layout.mjs'
import { createArtifactDigestTable } from '../../test-matrix/artifact-digest-table.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const profileId = process.env.FSUSBLOG_LOCAL_PROFILE || 'production'
const bundleId = process.argv[2]
const finalizeExisting = process.argv.includes('--finalize-existing')
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
const profile = matrix.localProfiles?.[profileId]
const bundle = profile?.bundles?.find((entry) => entry.id === bundleId)
const matrixTiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]))
const outDir = path.join(root, `.tmp/local-${profileId}`, bundleId || 'unknown')
const summaryFile = path.join(outDir, 'summary.json')
const logDir = path.join(outDir, 'steps')
const startedAt = Date.now()
const productionBuildLayout = resolveProductionBuildLayout({ root })
if (path.resolve(process.env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '') !== productionBuildLayout.runRoot) {
  throw new Error('physical bundle requires the current run-bound production build root')
}
Object.assign(process.env, productionBuildEnvironment(productionBuildLayout, process.env))
const dotnetArtifacts = productionDotnetArtifacts(productionBuildLayout)
const backendTestDll = dotnetArtifacts.testDll
const benchmarkDll = dotnetArtifacts.benchmarkDll
const backendServerDll = dotnetArtifacts.serverDll
const frontendDistRoot = productionBuildLayout.frontendDist
const frontendWasmRoot = productionBuildLayout.frontendWasm
const backendWebRoot = productionBuildLayout.backendWebRoot
const activeStepChildren = new Map()
const stepExecutionResults = new Map()
let shutdownPromise = null
let runtimeChildEnvironment = {}
let performanceDeadlineEvidence = null

if (!bundleId || !bundle) throw new Error(`unknown ${profileId} bundle: ${String(bundleId)}`)
const artifactDigestTable = createArtifactDigestTable({
  root,
  file: process.env.FSUSBLOG_ARTIFACT_DIGEST_TABLE,
  runId: schedulerRunId(),
  sourceState: {
    commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
    worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
  }
})
if (!finalizeExisting) fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(logDir, { recursive: true })

const memberEvidence = new Map(bundle.members.map((tierId) => [tierId, {
  status: 'success',
  durationMs: 0,
  testIds: [],
  artifactDigests: {},
  artifactRefs: {}
}]))

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function signalProcessGroup(child, signal) {
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
}

function processGroupIsAlive(child) {
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function waitForProcessGroupExit(child, waitMs) {
  const deadline = Date.now() + waitMs
  const pollMs = Math.max(10, Math.ceil(waitMs / 20))
  while (processGroupIsAlive(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())))
  }
  return !processGroupIsAlive(child)
}

async function terminateProcessGroup(child, graceMs) {
  signalProcessGroup(child, 'SIGTERM')
  if (await waitForProcessGroupExit(child, graceMs)) return
  signalProcessGroup(child, 'SIGKILL')
  await waitForProcessGroupExit(child, graceMs)
}

function closeChildPipes(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
}

function installShutdownForwarding() {
  for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    process.once(signal, () => {
      if (shutdownPromise) return
      shutdownPromise = Promise.all([...activeStepChildren.entries()].map(async ([child, record]) => {
        await terminateProcessGroup(child, record.terminationGraceMs)
        closeChildPipes(child)
      })).finally(() => process.exit(exitCode))
    })
  }
}

installShutdownForwarding()

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function fileContentDigest(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function schedulerRunId() {
  const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim()
  if (!runId) throw new Error('FSUSBLOG_TEST_RUN_ID is required for run-bound bundle coordination')
  return runId
}

function digestArtifacts(declarations, step) {
  return artifactDigestTable.digestDeclarations(declarations, {
    env: process.env,
    producer: { bundle: bundleId, step }
  })
}

function buildLayoutBinding() {
  return {
    runId: schedulerRunId(),
    manifestPath: relative(productionBuildLayout.manifestFile),
    manifestDigest: productionBuildLayoutDigest(productionBuildLayout),
    sourceCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
    sourceFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
  }
}

function markerHasCurrentBuildLayout(marker) {
  const expected = buildLayoutBinding()
  return marker?.buildLayout?.runId === expected.runId
    && marker?.buildLayout?.manifestPath === expected.manifestPath
    && marker?.buildLayout?.manifestDigest === expected.manifestDigest
    && marker?.buildLayout?.sourceCommit === expected.sourceCommit
    && marker?.buildLayout?.sourceFingerprint === expected.sourceFingerprint
}

function backendBuildReadyFile(runId = schedulerRunId()) {
  return path.join(root, '.tmp/test-runs', runId, 'backend-build-ready.json')
}

function benchmarkBuildReadyFile(runId = schedulerRunId()) {
  return path.join(root, '.tmp/test-runs', runId, 'benchmark-build-ready.json')
}

function backendTestsReadyFile(runId = schedulerRunId()) {
  return path.join(root, '.tmp/test-runs', runId, 'backend-tests-ready.json')
}

function frontendBuildReadyFile(runId = schedulerRunId()) {
  return path.join(root, '.tmp/test-runs', runId, 'frontend-build-ready.json')
}

function publishBackendBuildReady() {
  const runId = schedulerRunId()
  const artifactPath = relative(backendServerDll)
  if (!fs.existsSync(backendServerDll)) {
    throw new Error(`backend server build completed without server DLL: ${artifactPath}`)
  }
  const artifact = digestArtifacts([artifactPath], 'backend-build-ready')
  const marker = {
    schema: 'fsusblog.local-production.backend-build-ready.v1',
    status: 'success',
    physicalBundleId: 'backend-tests',
    schedulerRunId: runId,
    buildLayout: buildLayoutBinding(),
    serverDll: {
      path: artifactPath,
      exists: true,
      digest: artifact.digests[artifactPath],
      artifactRef: artifact.refs[artifactPath]
    },
    generatedAt: new Date().toISOString()
  }
  const markerFile = backendBuildReadyFile(runId)
  fs.mkdirSync(path.dirname(markerFile), { recursive: true })
  const temporary = `${markerFile}.next-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`)
  fs.renameSync(temporary, markerFile)
  console.log(`[local-production:${bundleId}] backend-build-ready=${relative(markerFile)}`)
}

function publishBackendTestsReady() {
  const runId = schedulerRunId()
  const artifactPath = relative(backendTestDll)
  if (!fs.existsSync(backendTestDll)) throw new Error(`backend tests build completed without test DLL: ${artifactPath}`)
  const artifact = digestArtifacts([artifactPath], 'backend-tests-ready')
  const marker = {
    schema: 'fsusblog.local-production.backend-tests-ready.v1',
    status: 'success',
    physicalBundleId: 'backend-tests',
    schedulerRunId: runId,
    buildLayout: buildLayoutBinding(),
    testDll: {
      path: artifactPath,
      exists: true,
      digest: fileContentDigest(backendTestDll),
      declaredDigest: artifact.digests[artifactPath],
      artifactRef: artifact.refs[artifactPath]
    },
    generatedAt: new Date().toISOString()
  }
  const markerFile = backendTestsReadyFile(runId)
  fs.mkdirSync(path.dirname(markerFile), { recursive: true })
  const temporary = `${markerFile}.next-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`)
  fs.renameSync(temporary, markerFile)
  console.log(`[local-production:${bundleId}] backend-tests-ready=${relative(markerFile)}`)
}

function publishBenchmarkBuildReady() {
  const runId = schedulerRunId()
  const artifactPath = relative(benchmarkDll)
  if (!fs.existsSync(benchmarkDll)) {
    throw new Error(`benchmark readiness build completed without DLL: ${artifactPath}`)
  }
  const artifact = digestArtifacts([artifactPath], 'benchmark-build-ready')
  const marker = {
    schema: 'fsusblog.local-production.benchmark-build-ready.v1',
    status: 'success',
    physicalBundleId: 'backend-tests',
    schedulerRunId: runId,
    buildLayout: buildLayoutBinding(),
    benchmarkDll: {
      path: artifactPath,
      digest: artifact.digests[artifactPath],
      artifactRef: artifact.refs[artifactPath]
    },
    generatedAt: new Date().toISOString()
  }
  const markerFile = benchmarkBuildReadyFile(runId)
  fs.mkdirSync(path.dirname(markerFile), { recursive: true })
  const temporary = `${markerFile}.next-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`)
  fs.renameSync(temporary, markerFile)
  console.log(`[local-production:${bundleId}] benchmark-build-ready=${relative(markerFile)}`)
}

function publishFrontendBuildReady() {
  const runId = schedulerRunId()
  const artifactPath = relative(path.join(frontendDistRoot, 'index.html'))
  const privacyWasmPaths = [
    'comment-privacy-prover.js',
    'comment-privacy-prover.zkey',
    'comment-privacy-prover.manifest.json'
  ].map((file) => relative(path.join(frontendWasmRoot, file)))
  const summaryPath = '.tmp/frontend/frontend-build.json'
  const generatedProverBundlePath = relative(process.env.FSUSBLOG_COMMENT_PROVER_BUNDLE)
  const requiredArtifacts = [artifactPath, ...privacyWasmPaths, generatedProverBundlePath]
  const missingArtifacts = requiredArtifacts.filter((requiredPath) => !fs.existsSync(path.join(root, requiredPath)))
  if (missingArtifacts.length > 0) {
    throw new Error(`frontend build completed without required artifact(s): ${missingArtifacts.join(', ')}`)
  }
  const artifacts = digestArtifacts(requiredArtifacts, 'frontend-build-ready')
  const artifactDigests = artifacts.digests
  const generatedContractFile = path.join(productionBuildLayout.generatedRoot, 'frontend-build-contract.json')
  writeJsonAtomic(generatedContractFile, {
    schema: 'fsusblog.production-frontend-build-contract.v1',
    status: 'success',
    schedulerRunId: runId,
    buildLayout: buildLayoutBinding(),
    artifacts: Object.fromEntries(requiredArtifacts.map((requiredPath) => [requiredPath, {
      digest: artifactDigests[requiredPath],
      artifactRef: artifacts.refs[requiredPath]
    }])),
    generatedAt: new Date().toISOString()
  })
  const generatedContractPath = relative(generatedContractFile)
  const generatedContract = digestArtifacts([generatedContractPath], 'frontend-generated-contract')
  const generatedContractDigest = generatedContract.digests[generatedContractPath]
  const marker = {
    schema: 'fsusblog.local-production.frontend-build-ready.v1',
    status: 'success',
    physicalBundleId: 'build-static',
    schedulerRunId: runId,
    buildLayout: buildLayoutBinding(),
    distEntry: {
      path: artifactPath,
      digest: artifactDigests[artifactPath],
      artifactRef: artifacts.refs[artifactPath]
    },
    privacyWasmArtifacts: Object.fromEntries(privacyWasmPaths.map((requiredPath) => [requiredPath, {
      path: requiredPath,
      digest: artifactDigests[requiredPath],
      artifactRef: artifacts.refs[requiredPath]
    }])),
    generatedProverBundle: {
      path: generatedProverBundlePath,
      digest: artifactDigests[generatedProverBundlePath],
      artifactRef: artifacts.refs[generatedProverBundlePath]
    },
    generatedContract: {
      path: generatedContractPath,
      digest: generatedContractDigest,
      artifactRef: generatedContract.refs[generatedContractPath]
    },
    generatedAt: new Date().toISOString()
  }
  for (const markerFile of [path.join(root, summaryPath), frontendBuildReadyFile(runId)]) {
    fs.mkdirSync(path.dirname(markerFile), { recursive: true })
    const temporary = `${markerFile}.next-${process.pid}-${randomUUID()}`
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`)
    fs.renameSync(temporary, markerFile)
  }
  console.log(`[local-production:${bundleId}] frontend-build-ready=${relative(frontendBuildReadyFile(runId))}`)
}

function register(step, result, testIds = null, artifactFiles = []) {
  const ids = testIds ?? [`command:${step.id}`]
  const declaredArtifacts = [result.logFile, ...artifactFiles].map((file) => {
    const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
    return relative(absolute)
  })
  const artifacts = digestArtifacts(declaredArtifacts, step.id)
  const artifactDigests = artifacts.digests
  for (const tierId of step.members ?? []) {
    const evidence = memberEvidence.get(tierId)
    if (!evidence) throw new Error(`${step.id} references undeclared member ${tierId}`)
    evidence.durationMs += result.durationMs
    evidence.testIds.push(...ids)
    Object.assign(evidence.artifactDigests, artifactDigests)
    Object.assign(evidence.artifactRefs, artifacts.refs)
  }
}

function bindMatrixRuntimeArtifacts() {
  const substitutionsByTier = resolveArtifactSubstitutions(bundle, matrix.tiers)
  const runtimePathsByTier = new Map()
  const directRuntimePaths = []
  const actualProofPaths = []
  for (const [tierId, evidence] of memberEvidence) {
    const tier = matrixTiers.get(tierId)
    if (!tier) throw new Error(`bundle member is missing from matrix tiers: ${tierId}`)
    const runtimePaths = matrixGeneratedRuntimePaths(tier)
    const substitutions = substitutionsByTier[tierId] ?? {}
    runtimePathsByTier.set(tierId, runtimePaths)
    for (const runtimePath of runtimePaths) {
      const actualPaths = substitutions[runtimePath]
      if (actualPaths) actualProofPaths.push(...actualPaths)
      else directRuntimePaths.push(runtimePath)
    }
    evidence.artifactProofMode = runtimePaths.length === 0
      ? 'command-log-and-test-ids'
      : (Object.keys(substitutions).length > 0
          ? 'matrix-runtime-artifacts-with-substitutions'
          : 'matrix-runtime-artifacts')
    evidence.matrixRuntimePaths = runtimePaths
    evidence.artifactSubstitutionProofs = {}
  }
  const allRuntimeArtifacts = digestArtifacts([
    ...new Set([...directRuntimePaths, ...actualProofPaths])
  ], 'matrix-runtime-artifacts')
  const allRuntimeDigests = allRuntimeArtifacts.digests
  for (const [tierId, runtimePaths] of runtimePathsByTier) {
    const evidence = memberEvidence.get(tierId)
    const substitutions = substitutionsByTier[tierId] ?? {}
    for (const canonicalPath of runtimePaths) {
      const actualPaths = substitutions[canonicalPath]
      if (!actualPaths) {
        evidence.artifactDigests[canonicalPath] = allRuntimeDigests[canonicalPath]
        evidence.artifactRefs[canonicalPath] = allRuntimeArtifacts.refs[canonicalPath]
        continue
      }
      const actualDigests = Object.fromEntries(actualPaths.map((actualPath) => [
        actualPath,
        allRuntimeDigests[actualPath]
      ]))
      const canonicalDigest = artifactSubstitutionBindingDigest(canonicalPath, actualDigests)
      const actualRefs = Object.fromEntries(actualPaths.map((actualPath) => [
        actualPath,
        allRuntimeArtifacts.refs[actualPath]
      ]))
      const substitution = artifactDigestTable.registerSubstitution(
        canonicalPath,
        actualDigests,
        actualRefs,
        { producer: { bundle: bundleId, step: 'artifact-substitution' } }
      )
      if (substitution.digest !== canonicalDigest) {
        throw new Error(`artifact substitution table digest mismatch: ${canonicalPath}`)
      }
      evidence.artifactDigests[canonicalPath] = canonicalDigest
      Object.assign(evidence.artifactDigests, actualDigests)
      evidence.artifactRefs[canonicalPath] = substitution.artifactId
      Object.assign(evidence.artifactRefs, actualRefs)
      evidence.artifactSubstitutionProofs[canonicalPath] = {
        canonicalPath,
        canonicalDigest,
        actualPaths,
        actualDigests,
        actualRefs,
        canonicalArtifactRef: substitution.artifactId
      }
    }
  }
}

function memberReceiptPath(tierId) {
  return path.join(outDir, 'member-summaries', tierId, 'summary.json')
}

function writeMemberExecutionReceipts() {
  for (const [tierId, evidence] of memberEvidence) {
    const receiptFile = memberReceiptPath(tierId)
    const receipt = {
      schema: 'fsusblog.local-production.member-execution.v1',
      status: 'success',
      tierId,
      physicalBundleId: bundleId,
      schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
      sourceState: {
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
        worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
      },
      durationMs: evidence.durationMs,
      testIds: [...new Set(evidence.testIds)].sort(),
      directArtifactDigests: Object.fromEntries(Object.entries(evidence.artifactDigests).sort()),
      directArtifactRefs: Object.fromEntries(Object.entries(evidence.artifactRefs).sort()),
      generatedAt: new Date().toISOString()
    }
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true })
    const temporary = `${receiptFile}.next-${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`)
    fs.renameSync(temporary, receiptFile)
    const receiptArtifact = digestArtifacts([relative(receiptFile)], `member-receipt/${tierId}`)
    Object.assign(evidence.artifactDigests, receiptArtifact.digests)
    Object.assign(evidence.artifactRefs, receiptArtifact.refs)
  }
}

function loadExistingMemberExecutionReceipts() {
  for (const [tierId, evidence] of memberEvidence) {
    const receiptFile = memberReceiptPath(tierId)
    if (!fs.existsSync(receiptFile)) throw new Error(`existing member receipt is missing: ${relative(receiptFile)}`)
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    if (receipt.schema !== 'fsusblog.local-production.member-execution.v1' || receipt.status !== 'success') {
      throw new Error(`existing member receipt is invalid: ${relative(receiptFile)}`)
    }
    if (receipt.tierId !== tierId || receipt.physicalBundleId !== bundleId) {
      throw new Error(`existing member receipt identity mismatch: ${relative(receiptFile)}`)
    }
    if (receipt.schedulerRunId !== (process.env.FSUSBLOG_TEST_RUN_ID ?? null)) {
      throw new Error(`existing member receipt run mismatch: ${relative(receiptFile)}`)
    }
    evidence.durationMs = receipt.durationMs
    evidence.testIds.push(...receipt.testIds)
    Object.assign(evidence.artifactDigests, receipt.directArtifactDigests)
    Object.assign(evidence.artifactRefs, receipt.directArtifactRefs)
    const receiptArtifact = digestArtifacts([relative(receiptFile)], `existing-member-receipt/${tierId}`)
    Object.assign(evidence.artifactDigests, receiptArtifact.digests)
    Object.assign(evidence.artifactRefs, receiptArtifact.refs)
  }
}

async function executeStep(step) {
  if (shutdownPromise) throw new Error(`cannot start ${step.id} while bundle shutdown is in progress`)
  const logFile = path.join(logDir, `${step.id}.log`)
  fs.writeFileSync(logFile, '')
  const started = Date.now()
  if (step.resources?.coordinationOnly === true) {
    const relativeDependencyResults = new Map((step.dependsOn ?? []).flatMap((dependencyId) => {
      const result = stepExecutionResults.get(dependencyId)
      return result
        ? [[dependencyId, { ...result, logFile: relative(result.logFile) }]]
        : []
    }))
    const joined = buildSettledPhaseJoinEvidence({
      stepId: step.id,
      dependencyIds: step.dependsOn ?? [],
      dependencyOutcomes: step.dependencyOutcomes,
      dependencyResults: relativeDependencyResults
    })
    const joinEvidence = joined.evidence
    fs.writeFileSync(logFile, `${JSON.stringify(joinEvidence, null, 2)}\n`)
    const result = {
      code: 0,
      signal: null,
      durationMs: joined.durationMs,
      startedAtMs: joined.startedAtMs,
      finishedAtMs: joined.finishedAtMs,
      logFile
    }
    stepExecutionResults.set(step.id, { ...result, status: joinEvidence.status })
    console.log(`[local-production:${bundleId}] joined ${step.id} status=${joinEvidence.status} durationMs=${result.durationMs}`)
    register(step, result, step.testIds, [...joined.dependencyLogs, ...(step.artifacts ?? [])])
    return result
  }
  const stepCapacity = resolveStepRuntimeCapacity(bundleId, step, bundleCapacity())
  const remainingBundleDeadlineMs = Math.max(1, bundleDeadlineMs() - (Date.now() - startedAt))
  const stepDeadlineMs = Math.min(remainingBundleDeadlineMs, resolveMachineExecutionTimeoutMs({
    baseTimeoutMs: remainingBundleDeadlineMs,
    workload: step.resources,
    actualCapacity: stepCapacity
  }))
  console.log(
    `[local-production:${bundleId}] start ${step.id}`
    + ` cpu=${stepCapacity.cpuUnits.toFixed(2)}`
    + ` memoryGiB=${stepCapacity.memoryGiB.toFixed(2)}`
    + ` parallel=${stepCapacity.maxParallel}`
    + ` deadlineMs=${stepDeadlineMs}`
  )
  const childBaseEnvironment = { ...process.env }
  // Playwright sets FORCE_COLOR for its workers. Inheriting an ambient
  // NO_COLOR at the same time emits one warning per worker and violates the
  // release zero-warning contract without changing test semantics.
  delete childBaseEnvironment.NO_COLOR
  for (const stalePhysicalWorkerCap of [
    'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
    'FSUSBLOG_VITEST_MAX_WORKERS',
    'FSUSBLOG_PLAYWRIGHT_WORKERS'
  ]) delete childBaseEnvironment[stalePhysicalWorkerCap]
  const child = spawn('/bin/bash', ['-lc', step.command], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: {
      ...childBaseEnvironment,
      ...runtimeChildEnvironment,
      ...(step.env ?? {}),
      // Production bundles are short-lived and can be cancelled at their
      // deadline. Persistent MSBuild nodes otherwise detach with PPID 1 and
      // continue consuming this run's CPU/memory after the bundle exits.
      MSBUILDDISABLENODEREUSE: '1',
      FSUSBLOG_STEP_CPU_BUDGET: String(stepCapacity.cpuUnits),
      FSUSBLOG_STEP_MEMORY_GIB: String(stepCapacity.memoryGiB),
      FSUSBLOG_BUNDLE_CPU_BUDGET: String(stepCapacity.maxParallel),
      FSUSBLOG_BUNDLE_CPU_UNITS: String(stepCapacity.cpuUnits),
      FSUSBLOG_BUNDLE_MEMORY_GIB: String(stepCapacity.memoryGiB),
      FSUSBLOG_STEP_DEADLINE_MS: String(stepDeadlineMs)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const terminationGraceMs = Math.max(100, Math.min(5_000, Math.ceil(stepDeadlineMs * 0.02)))
  activeStepChildren.set(child, { terminationGraceMs, stepId: step.id })
  for (const [stream, writer] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('data', (chunk) => {
      fs.appendFileSync(logFile, chunk)
      writer.write(chunk)
    })
  }
  const exit = await new Promise((resolve) => {
    let settled = false
    let deadlineExpired = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      resolve(result)
    }
    const deadlineTimer = setTimeout(async () => {
      if (settled) return
      deadlineExpired = true
      await terminateProcessGroup(child, terminationGraceMs)
      closeChildPipes(child)
      settle({ code: 124, signal: null, timedOut: true })
    }, stepDeadlineMs)
    deadlineTimer.unref?.()

    child.once('error', (error) => {
      activeStepChildren.delete(child)
      closeChildPipes(child)
      settle({ code: 1, signal: null, error })
    })
    child.once('close', (code, signal) => {
      activeStepChildren.delete(child)
      if (deadlineExpired) return
      settle({ code: code ?? 1, signal })
    })
  })
  const result = {
    ...exit,
    durationMs: Date.now() - started,
    startedAtMs: started,
    finishedAtMs: Date.now(),
    logFile
  }
  if (result.timedOut) {
    stepExecutionResults.set(step.id, { ...result, status: 'failure' })
    throw new Error(`${step.id} exceeded machine-resolved deadline (${stepDeadlineMs}ms)`)
  }
  if (result.error) {
    stepExecutionResults.set(step.id, { ...result, status: 'failure' })
    throw result.error
  }
  if (result.code !== 0 || result.signal) {
    stepExecutionResults.set(step.id, { ...result, status: 'failure' })
    throw new Error(`${step.id} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.code}`})`)
  }
  // A dependent step must not become runnable until the producer's readiness
  // marker is durably published. Keeping this hook inside executeStep closes
  // the gap between child exit and the DAG completion notification.
  if (typeof step.afterSuccess === 'function') await step.afterSuccess(result)
  stepExecutionResults.set(step.id, { ...result, status: 'success' })
  console.log(`[local-production:${bundleId}] done ${step.id} durationMs=${result.durationMs}`)
  register(step, result, step.testIds, step.artifacts ?? [])
  return result
}

async function executeWave(steps) {
  await executeWeightedStepDag(steps, bundleDagCapacity, executeStep)
}

function schedulerResourceGrant() {
  const grantFile = String(process.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE ?? '').trim()
  const tierId = String(process.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID ?? '').trim()
  if (!grantFile || !tierId || !fs.existsSync(grantFile)) return null
  const document = JSON.parse(fs.readFileSync(grantFile, 'utf8'))
  if (document?.schema !== 'fsusblog.test-matrix.resource-grants.v1') {
    throw new Error(`invalid scheduler resource grant schema: ${relative(grantFile)}`)
  }
  if (document.runId !== schedulerRunId()) {
    throw new Error(`scheduler resource grant belongs to another run: ${document.runId ?? '<missing>'}`)
  }
  const grant = document.grants?.[tierId]
  if (!grant) return null
  if (!Number.isFinite(Number(grant.cpuUnits)) || Number(grant.cpuUnits) <= 0
    || !Number.isFinite(Number(grant.memoryGiB)) || Number(grant.memoryGiB) <= 0) {
    throw new Error(`scheduler resource grant is invalid for ${tierId}`)
  }
  return {
    cpuUnits: Number(grant.cpuUnits),
    memoryGiB: Number(grant.memoryGiB)
  }
}

function bundleCapacity() {
  const liveGrant = schedulerResourceGrant()
  return resolveBundleRuntimeCapacity({
    availableCpu: os.availableParallelism?.() ?? os.cpus().length,
    availableMemoryGiB: os.freemem() / (1024 ** 3),
    inheritedCpuBudget: liveGrant?.cpuUnits ?? process.env.FSUSBLOG_BUNDLE_CPU_BUDGET,
    inheritedMemoryGiB: liveGrant?.memoryGiB ?? process.env.FSUSBLOG_BUNDLE_MEMORY_GIB,
    cpuWeight: bundle.cpuWeight,
    memoryWeight: bundle.memoryWeight
  })
}

function bundleDagCapacity() {
  return {
    ...bundleCapacity(),
    exclusiveResources: bundle.exclusiveResources ?? []
  }
}

function bundleDeadlineMs() {
  const deadlineMs = Number(process.env.FSUSBLOG_BUNDLE_DEADLINE_MS)
  if (Number.isFinite(deadlineMs) && deadlineMs > 0) return deadlineMs
  if (profile.enforceBudget === false) {
    // Observe-only production must not inherit the optimization target as a
    // kill switch. Retain only the matrix's existing per-tier fault ceiling so
    // a genuinely wedged child cannot keep the machine forever.
    const declaredFaultCeilings = (bundle.members ?? [])
      .map((tierId) => Number(matrixTiers.get(tierId)?.timeoutMinutes) * 60_000)
      .filter((value) => Number.isFinite(value) && value > 0)
    return Math.max(profile.budgetMs, ...declaredFaultCeilings)
  }
  return resolveMachineExecutionTimeoutMs({
    baseTimeoutMs: profile.budgetMs,
    workload: {
      cpuWeight: bundle.cpuWeight,
      memoryWeight: bundle.memoryWeight,
      minCpuUnits: bundle.minCpuUnits
    },
    actualCapacity: bundleCapacity()
  })
}

function resolveExecutionWaitTimeoutMs(dependencyBundleIds) {
  dependencyBundleIds.forEach((dependencyBundleId) => {
    const dependency = profile.bundles.find((entry) => entry.id === dependencyBundleId)
    if (!dependency) throw new Error(`unknown dependency bundle: ${dependencyBundleId}`)
  })
  return resolveMachineExecutionTimeoutMs({
    baseTimeoutMs: bundleDeadlineMs(),
    workload: bundle,
    actualCapacity: bundleCapacity()
  })
}

function commandStep(id, command, members, options = {}) {
  return {
    id,
    command,
    members,
    ...options,
    resources: options.resources ?? { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
  }
}

function buildStaticSteps() {
  return [
    commandStep('frontend-build', 'cd src/frontend && FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1 npm run build:release', ['frontend-build'], {
      artifacts: [path.join(frontendDistRoot, 'index.html')],
      resources: {
        cpuWeight: 2,
        memoryWeight: 2,
        minCpuUnits: 1,
        exclusiveResources: ['build-output']
      }
    }),
    commandStep('validate-matrix', 'node tools/run-test-matrix.mjs preflight', ['validate-matrix']),
    commandStep('public-hydration-fast', 'tools/test/lanes/public-hydration-fast.sh', ['public-hydration-fast']),
    commandStep('contract-fuzz', 'tools/test/lanes/contract-fuzz.sh', ['contract-fuzz']),
    commandStep('perception-redteam', 'tools/test/lanes/perception-v2-redteam.sh pr', ['perception-v2-redteam-pr']),
    commandStep('risk-control', 'tools/test/lanes/risk-control-test-matrix.sh', ['risk-control-test-matrix']),
    commandStep('viewport-plan-progress', 'node tools/ux/run-viewport-plan-progress.mjs', ['ux-viewport-plan-progress'], {
      artifacts: [path.join(root, '.tmp/ux/viewport-plan-progress.json')]
    }),
    commandStep('sync-static-assets', [
      'rm -rf "$FSUSBLOG_BACKEND_WEBROOT"',
      'mkdir -p "$FSUSBLOG_BACKEND_WEBROOT"',
      'cp -R "$FSUSBLOG_FRONTEND_DIST_ROOT"/. "$FSUSBLOG_BACKEND_WEBROOT"/'
    ].join(' && '), ['frontend-build'], { dependsOn: ['frontend-build'] }),
    commandStep('frontend-runtime-contracts', 'cd src/frontend && FSUSBLOG_COMMAND_MANIFEST_WORKERS="$FSUSBLOG_STEP_CPU_BUDGET" node ../../tools/test/run-command-manifest.mjs ../../tests/frontend/checks/runtime/manifest.json', ['frontend-runtime-contracts'], { dependsOn: ['sync-static-assets'] }),
    commandStep('wasm-fuzz', 'tools/test/lanes/wasm-fuzz-regression.sh', ['wasm-fuzz-regression'], { dependsOn: ['frontend-build'] })
  ]
}

function trxAttribute(text, name) {
  const match = text.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))
  return match?.[1] ?? ''
}

function parseTrx(file) {
  const xml = fs.readFileSync(file, 'utf8')
  const definitions = new Map()
  for (const match of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu)) {
    const id = trxAttribute(match[1], 'id')
    const method = match[2].match(/<TestMethod\b([^>]*)\/>/u)?.[1] ?? ''
    const categories = [...match[2].matchAll(/TestCategory="([^"]+)"/gu)].map((entry) => entry[1])
    definitions.set(id, {
      id: `${trxAttribute(method, 'className')}.${trxAttribute(method, 'name')}`,
      categories
    })
  }
  return [...xml.matchAll(/<UnitTestResult\b([^>]*)\/?>(?:<\/UnitTestResult>)?/gu)].map((match) => {
    const definition = definitions.get(trxAttribute(match[1], 'testId')) ?? {}
    return {
      id: definition.id || trxAttribute(match[1], 'testName'),
      outcome: trxAttribute(match[1], 'outcome'),
      categories: definition.categories ?? []
    }
  }).filter((entry) => entry.id)
}

function readPerceptionUnionProjection(trxFiles, shardSummary) {
  const projectionFile = path.join(root, '.tmp/test-results/backend/production/perception-v2-union-projection.json')
  if (!fs.existsSync(projectionFile)) throw new Error('perception-v2 union projection is missing')
  const projection = JSON.parse(fs.readFileSync(projectionFile, 'utf8'))
  if (projection.schema !== 'fsusblog.perception-v2.union-projection.v1' || projection.status !== 'success') {
    throw new Error('perception-v2 union projection is not a successful v1 result')
  }
  const runId = schedulerRunId()
  if (projection.producer?.runId !== runId) {
    throw new Error(`perception-v2 union projection runId mismatch: expected ${runId}, received ${projection.producer?.runId ?? '<missing>'}`)
  }
  const dllPath = relative(backendTestDll)
  const expectedDllDigest = fileContentDigest(path.resolve(root, dllPath))
  if (projection.testDll?.path !== dllPath || projection.testDll?.digest !== expectedDllDigest) {
    throw new Error('perception-v2 union projection is not bound to the current backend test DLL digest')
  }
  const summaryPath = relative(shardSummary)
  const expectedSummaryDigest = fileContentDigest(path.resolve(root, summaryPath))
  if (projection.unionSummary?.path !== summaryPath || projection.unionSummary?.digest !== expectedSummaryDigest) {
    throw new Error('perception-v2 union projection is not bound to the current union summary digest')
  }
  const expectedTrxDigests = Object.fromEntries(
    trxFiles.map((file) => [relative(file), fileContentDigest(file)])
  )
  const projectedTrx = Array.isArray(projection.trxFiles) ? projection.trxFiles : []
  const projectedTrxDigests = Object.fromEntries(projectedTrx.map((entry) => [entry?.path, entry?.digest]))
  if (projectedTrx.length !== trxFiles.length
    || Object.keys(projectedTrxDigests).length !== trxFiles.length
    || Object.entries(expectedTrxDigests).some(([file, digest]) => projectedTrxDigests[file] !== digest)) {
    throw new Error('perception-v2 union projection is not bound to the exact current TRX digest set')
  }
  const expectedTests = [
    'FsusBlog.Server.Tests.Unit.PerceptionChallengeV2E2eTests.CommentCreateFlow_FailsClosedForWrongAnswerExpiredReplayAndBindingMismatch',
    'FsusBlog.Server.Tests.Unit.PerceptionChallengeV2E2eTests.CommentCreateFlow_IssueRenderVerifyProofResume_WritesReleaseEvidence'
  ].sort()
  const tests = Array.isArray(projection.tests) ? projection.tests : []
  if (tests.length !== expectedTests.length
    || tests.some((entry) => entry?.outcome !== 'Passed')
    || JSON.stringify(tests.map((entry) => entry?.id).sort()) !== JSON.stringify(expectedTests)) {
    throw new Error('perception-v2 union projection has missing, unexpected, duplicate, or non-passing canonical test results')
  }
  return { projectionFile, tests }
}

async function runBackendTests() {
  const trxRoot = path.join(root, '.tmp/test-results/backend/production')
  const shardSummary = path.join(trxRoot, 'summary.json')
  const coverageDir = path.join(root, '.tmp/coverage/backend/production')
  fs.mkdirSync(trxRoot, { recursive: true })
  fs.mkdirSync(coverageDir, { recursive: true })
  await executeWave([
    commandStep('services', 'tools/bootstrap-acceptance-env.sh --services-only', [], {
      resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    }),
    commandStep('dotnet-restore',
      'FSUSBLOG_DOTNET_BUILD_PARALLELISM=auto tools/build-with-data-env.sh dotnet restore tests/FsusBlog.ProductionBackend.slnx -v minimal /p:NuGetAudit=false', [], {
        resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 1 }
      })
  ])
  const backendBuildStep = commandStep('backend-server-build',
    'tools/build-with-data-env.sh dotnet build src/backend/FsusBlog.Server.csproj -c Release --no-restore -warnaserror -v minimal /m:"$FSUSBLOG_STEP_CPU_BUDGET" /p:UseSharedCompilation=true /p:NuGetAudit=false',
    ['backend-build-governance'], {
      artifacts: [backendServerDll],
      resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    })
  await executeStep(backendBuildStep)
  publishBackendBuildReady()
  const testsBuildStep = commandStep('backend-tests-build',
    'tools/build-with-data-env.sh dotnet build tests/backend/FsusBlog.Server.Tests.csproj -c Release --no-restore --no-dependencies --no-incremental -warnaserror -v minimal /m:"$FSUSBLOG_STEP_CPU_BUDGET" /p:UseSharedCompilation=true /p:NuGetAudit=false',
    ['backend-build-governance'], {
      artifacts: [backendTestDll],
      resources: { cpuWeight: 2, memoryWeight: 2, minCpuUnits: 1 },
      afterSuccess: publishBackendTestsReady
    })
  const benchmarkBuildStep = commandStep('backend-benchmark-build',
    'tools/build-with-data-env.sh dotnet build benchmarks/core/FsusBlog.Core.Benchmarks.csproj -c Release --no-restore --no-dependencies -warnaserror -v minimal /m:"$FSUSBLOG_STEP_CPU_BUDGET" /p:UseSharedCompilation=true /p:NuGetAudit=false',
    ['backend-build-governance'], {
      artifacts: [benchmarkDll],
      resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    })
  const testStep = commandStep('dotnet-production-union',
    'FSUSBLOG_BACKEND_CPU_BUDGET="$FSUSBLOG_STEP_CPU_BUDGET" node tools/test/run-backend-production-shards.mjs', [], {
      resources: { cpuWeight: 2, memoryWeight: 3, minCpuUnits: 2 },
      afterSuccess: publishBackendTestsReady
    })
  const backendDagResults = new Map()
  await executeWeightedStepDag([
    testsBuildStep,
    { ...testStep, dependsOn: ['backend-tests-build'] },
    // The production union is the backend critical path. Start it as soon as
    // the test assembly is ready with the bundle's initial two CPUs; the short
    // benchmark build consumes the elastic third CPU after build-static
    // releases it, then publishes the marker that permits further testhosts.
    { ...benchmarkBuildStep, dependsOn: ['backend-tests-build'] },
    commandStep('perception-matrix',
      'tools/test/lanes/perception-v2-test-matrix.sh', [], {
        dependsOn: ['dotnet-production-union'],
        artifacts: [path.join(root, '.tmp/test-results/backend/production/perception-v2-union-projection.json')]
      }),
    commandStep('perception-evidence-finalize',
      'test -s .tmp/security/perception-v2-e2e-runtime.json -a -s .tmp/release-evidence/perception-v2-release-evidence.json -a -s .tmp/security/perception-v2-test-matrix.json', [], {
        dependsOn: ['perception-matrix'],
        artifacts: [
          path.join(root, '.tmp/security/perception-v2-e2e-runtime.json'),
          path.join(root, '.tmp/release-evidence/perception-v2-release-evidence.json'),
          path.join(root, '.tmp/security/perception-v2-test-matrix.json')
        ]
      }),
    commandStep('integrity-proof',
      'tools/test/lanes/integrity-proof-verification.sh', ['integrity-proof-verification'], {
        // Both verification lanes invoke dotnet test in Debug and therefore
        // share src/backend/obj/Debug. Keep their builds ordered so MSBuild's
        // static-web-assets and package caches have one writer.
        dependsOn: ['perception-matrix'],
        artifacts: [path.join(root, '.tmp/release-evidence/integrity-proof-verification.json')]
      }),
    commandStep('backend-coverage-summary',
      'node tools/coverage/summarize-cobertura.mjs .tmp/coverage/backend .tmp/coverage/backend-merged/Summary.json backend-cobertura', [], {
        dependsOn: ['dotnet-production-union']
      })
  ], bundleDagCapacity, async (step) => {
    const result = await executeStep(step)
    if (step.id === 'backend-benchmark-build') publishBenchmarkBuildReady()
    backendDagResults.set(step.id, result)
  })
  const result = backendDagResults.get('dotnet-production-union')
  if (!result) throw new Error('dotnet-production-union completed without a result')
  const shardReport = JSON.parse(fs.readFileSync(shardSummary, 'utf8'))
  const trxFiles = listFiles(trxRoot, (file) => file.endsWith('.trx')).sort()
  validateShardSummaryArtifacts(shardReport, trxFiles, { repositoryRoot: root })
  const tests = trxFiles.flatMap(parseTrx)
  const perceptionProjection = readPerceptionUnionProjection(trxFiles, shardSummary)
  register({ id: 'perception-union-projection', members: ['perception-v2-test-matrix'] }, result,
    perceptionProjection.tests.map((entry) => `xunit:${entry.id}`), [
      perceptionProjection.projectionFile,
      shardSummary,
      backendTestDll,
      ...trxFiles,
      path.join(root, '.tmp/security/perception-v2-e2e-runtime.json'),
      path.join(root, '.tmp/release-evidence/perception-v2-release-evidence.json'),
      path.join(root, '.tmp/security/perception-v2-test-matrix.json')
    ])
  const categoryMembers = new Map([
    ['backend-api-integration', 'ApiIntegration'],
    ['backend-auth-state-machine', 'SecurityStateMachine'],
    ['backend-concurrency', 'Concurrency'],
    ['backend-property', 'Property'],
    ['backend-golden', 'GoldenContract']
  ])
  const categoryMethods = new Map([...categoryMembers].map(([tierId, category]) => {
    const methods = shardReport.categoryMembership?.[category]?.testMethods
    if (!Array.isArray(methods) || methods.length === 0) {
      throw new Error(`${tierId} is missing bound category discovery evidence for ${category}`)
    }
    return [tierId, new Set(methods)]
  }))
  const specialMethods = new Set([...categoryMethods.values()].flatMap((methods) => [...methods]))
  const backendTestMembers = new Set([
    'backend-unit', 'backend-api-integration', 'backend-auth-state-machine', 'backend-concurrency',
    'backend-property', 'backend-golden', 'backend-fast', 'coverage-backend'
  ])
  for (const tierId of bundle.members.filter((id) => backendTestMembers.has(id))) {
    let selected = tests
    if (tierId === 'backend-unit') selected = tests.filter((entry) => !specialMethods.has(entry.id))
    else if (categoryMethods.has(tierId)) selected = tests.filter((entry) => categoryMethods.get(tierId).has(entry.id))
    if (selected.length === 0) throw new Error(`${tierId} received no executed backend test IDs`)
    register({ id: 'dotnet-production-union', members: [tierId] }, result, selected.map((entry) => `xunit:${entry.id}`), [
      shardSummary,
      ...trxFiles,
      path.join(root, '.tmp/coverage/backend-merged/Summary.json')
    ])
  }
}

function listFiles(directory, predicate = () => true) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(child, predicate) : (predicate(child) ? [child] : [])
  })
}

function parseVitestReports(files) {
  const records = []
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const testFile of report.testResults ?? []) {
      for (const assertion of testFile.assertionResults ?? []) {
        records.push({
          id: `vitest:${assertion.fullName || assertion.title}`,
          status: assertion.status,
          file: testFile.name || file
        })
      }
    }
  }
  return records
}

async function waitForSiblingBundleSummaries(bundleIds, timeoutMs = resolveExecutionWaitTimeoutMs(bundleIds)) {
  const expectedRunId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '')
  const checkpointFile = path.join(root, '.tmp/test-runs', expectedRunId, 'checkpoint.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = bundleIds.every((siblingBundleId) => {
      const file = path.join(root, `.tmp/local-${profileId}`, siblingBundleId, 'summary.json')
      if (!fs.existsSync(file)) return false
      try {
        const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
        return summary.status === 'success' && summary.schedulerRunId === expectedRunId
      } catch {
        return false
      }
    })
    if (ready) return
    if (fs.existsSync(checkpointFile)) {
      try {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
        const failures = bundleIds.flatMap((siblingBundleId) => {
          const tierId = `local-${profileId}-${siblingBundleId}`
          const status = checkpoint.tiers?.[tierId]?.status
          return ['failure', 'blocked', 'cancelled'].includes(status)
            ? [`${siblingBundleId}:${status}`]
            : []
        })
        if (failures.length > 0) {
          throw new Error(`sibling bundle failed before summary publication: ${failures.join(', ')}`)
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          // The checkpoint is atomically replaced, but tolerate a transient read
          // from unusual filesystems and retry instead of hiding sibling status.
        } else {
          throw error
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for sibling bundle summaries: ${bundleIds.join(', ')}`)
}

async function waitForBackendProductionSummaryReady(timeoutMs = resolveExecutionWaitTimeoutMs(['backend-tests'])) {
  const expectedRunId = schedulerRunId()
  const summaryFile = path.join(root, '.tmp/test-results/backend/production/summary.json')
  const checkpointFile = path.join(root, '.tmp/test-runs', expectedRunId, 'checkpoint.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(summaryFile)) {
      try {
        const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
        if (summary?.producer?.runId === expectedRunId) {
          if (summary.schema !== 'fsusblog.backend-production-shards.v2'
              || summary.status !== 'success'
              || summary.execution?.exactOnce !== true
              || summary.execution?.allPassed !== true
              || !Array.isArray(summary.partitions)
              || summary.partitions.length < 2) {
            throw new Error('current-run backend production summary is not an exact-once all-passing partition union')
          }
          const trxFiles = summary.partitions.map((partition) => path.resolve(root, partition.trx ?? ''))
          if (trxFiles.some((file) => !fs.existsSync(file))) {
            throw new Error('current-run backend production summary references a missing TRX')
          }
          validateShardSummaryArtifacts(summary, trxFiles, { repositoryRoot: root })
          return
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw new Error(`invalid run-bound backend production summary: ${error.message}`, { cause: error })
        }
      }
    }
    if (fs.existsSync(checkpointFile)) {
      try {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
        const status = checkpoint.tiers?.[`local-${profileId}-backend-tests`]?.status
        if (['failure', 'blocked', 'cancelled'].includes(status)) {
          throw new Error(`backend-tests:${status} before production summary readiness`)
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for run-bound backend production summary: ${expectedRunId}`)
}

async function waitForBackendBuildReady(timeoutMs = resolveExecutionWaitTimeoutMs(['backend-tests'])) {
  const expectedRunId = schedulerRunId()
  const markerFile = backendBuildReadyFile(expectedRunId)
  const checkpointFile = path.join(root, '.tmp/test-runs', expectedRunId, 'checkpoint.json')
  const artifactPath = relative(backendServerDll)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(checkpointFile)) {
      try {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
        const status = checkpoint.tiers?.[`local-${profileId}-backend-tests`]?.status
        if (['failure', 'blocked', 'cancelled'].includes(status)) {
          throw new Error(`backend-tests:${status} before backend build readiness`)
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
    if (fs.existsSync(markerFile)) {
      try {
        const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
        if (marker.schema !== 'fsusblog.local-production.backend-build-ready.v1'
            || marker.status !== 'success'
            || marker.physicalBundleId !== 'backend-tests'
            || marker.schedulerRunId !== expectedRunId
            || !markerHasCurrentBuildLayout(marker)
            || marker.serverDll?.path !== artifactPath
            || marker.serverDll?.exists !== true) {
          throw new Error(`backend build readiness marker is not bound to scheduler run ${expectedRunId}`)
        }
        if (!fs.existsSync(backendServerDll)) throw new Error(`backend build readiness artifact is missing: ${artifactPath}`)
        const expectedDigest = marker.serverDll.digest
        const actual = digestArtifacts([artifactPath], 'consume-backend-build-ready')
        const actualDigest = actual.digests[artifactPath]
        if (!expectedDigest || actualDigest !== expectedDigest
          || marker.serverDll.artifactRef !== actual.refs[artifactPath]) {
          throw new Error(`backend build readiness digest mismatch: ${artifactPath}`)
        }
        return
      } catch (error) {
        throw new Error(`invalid run-bound backend build readiness marker: ${error.message}`, { cause: error })
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for run-bound backend build readiness: ${expectedRunId}`)
}

async function waitForFrontendBuildReady(timeoutMs = resolveExecutionWaitTimeoutMs(['build-static'])) {
  const expectedRunId = schedulerRunId()
  const markerFile = frontendBuildReadyFile(expectedRunId)
  const checkpointFile = path.join(root, '.tmp/test-runs', expectedRunId, 'checkpoint.json')
  const artifactPath = relative(path.join(frontendDistRoot, 'index.html'))
  const privacyWasmPaths = [
    'comment-privacy-prover.js',
    'comment-privacy-prover.zkey',
    'comment-privacy-prover.manifest.json'
  ].map((file) => relative(path.join(frontendWasmRoot, file)))
  const generatedContractPath = relative(path.join(productionBuildLayout.generatedRoot, 'frontend-build-contract.json'))
  const generatedProverBundlePath = relative(process.env.FSUSBLOG_COMMENT_PROVER_BUNDLE)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(checkpointFile)) {
      try {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
        const status = checkpoint.tiers?.[`local-${profileId}-build-static`]?.status
        if (['failure', 'blocked', 'cancelled'].includes(status)) {
          throw new Error(`build-static:${status} before frontend build readiness`)
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
    if (fs.existsSync(markerFile)) {
      try {
        const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
        if (marker.schema !== 'fsusblog.local-production.frontend-build-ready.v1'
            || marker.status !== 'success'
            || marker.physicalBundleId !== 'build-static'
            || marker.schedulerRunId !== expectedRunId
            || !markerHasCurrentBuildLayout(marker)
            || marker.distEntry?.path !== artifactPath
            || marker.generatedContract?.path !== generatedContractPath
            || marker.generatedProverBundle?.path !== generatedProverBundlePath
            || privacyWasmPaths.some((requiredPath) => marker.privacyWasmArtifacts?.[requiredPath]?.path !== requiredPath)) {
          throw new Error(`frontend build readiness marker is not bound to scheduler run ${expectedRunId}`)
        }
        const requiredArtifacts = [artifactPath, ...privacyWasmPaths, generatedProverBundlePath, generatedContractPath]
        const missingArtifacts = requiredArtifacts.filter((requiredPath) => !fs.existsSync(path.join(root, requiredPath)))
        if (missingArtifacts.length > 0) {
          throw new Error(`frontend build readiness artifact(s) missing: ${missingArtifacts.join(', ')}`)
        }
        const actual = digestArtifacts(requiredArtifacts, 'consume-frontend-build-ready')
        const actualDigests = actual.digests
        const mismatches = requiredArtifacts.filter((requiredPath) => {
          const expectedDigest = requiredPath === artifactPath
            ? marker.distEntry.digest
            : requiredPath === generatedContractPath
              ? marker.generatedContract.digest
              : requiredPath === generatedProverBundlePath
                ? marker.generatedProverBundle.digest
              : marker.privacyWasmArtifacts[requiredPath].digest
          const expectedRef = requiredPath === artifactPath
            ? marker.distEntry.artifactRef
            : requiredPath === generatedContractPath
              ? marker.generatedContract.artifactRef
              : requiredPath === generatedProverBundlePath
                ? marker.generatedProverBundle.artifactRef
                : marker.privacyWasmArtifacts[requiredPath].artifactRef
          return !expectedDigest || actualDigests[requiredPath] !== expectedDigest
            || !expectedRef || actual.refs[requiredPath] !== expectedRef
        })
        if (mismatches.length > 0) {
          throw new Error(`frontend build readiness digest mismatch: ${mismatches.join(', ')}`)
        }
        return
      } catch (error) {
        throw new Error(`invalid run-bound frontend build readiness marker: ${error.message}`, { cause: error })
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for run-bound frontend build readiness: ${expectedRunId}`)
}

function resolvedFrontendTestCpuTarget() {
  const cpuCount = os.availableParallelism?.() ?? os.cpus().length
  const backendFloor = Math.max(1, Math.floor(
    profile.bundles.find((entry) => entry.id === 'backend-tests')?.minCpuUnits ?? 1
  ))
  const runtimeFloor = Math.max(1, Math.floor(
    profile.bundles.find((entry) => entry.id === 'runtime-browser')?.minCpuUnits ?? 1
  ))
  // Start the transform pool as soon as static prechecks settle. The frontend
  // build releases its CPUs while this long-lived pool is still running, so a
  // machine-derived tail target avoids idling those future slots.
  return Math.max(1, cpuCount - backendFloor - runtimeFloor)
}

function resolvedFrontendEarlyTestCpuTarget() {
  const currentCpuUnits = Math.max(1, Math.floor(bundleCapacity().cpuUnits))
  return currentCpuUnits >= 3 ? currentCpuUnits - 1 : currentCpuUnits
}

function resolvedFrontendVitestAdmissionFloor() {
  const cpuCount = os.availableParallelism?.() ?? os.cpus().length
  const eventualFrontendCapacity = resolvedFrontendTestCpuTarget()
  // A complete coverage host is expensive to resize after launch. Wait for a
  // machine-derived useful floor instead of starting a future multi-worker
  // host inside the bundle's one-CPU cold-start share. The square-root floor
  // stays portable on small machines while avoiding transform oversubscription.
  return Math.max(1, Math.min(
    eventualFrontendCapacity,
    Math.ceil(Math.sqrt(cpuCount))
  ))
}

async function waitForFrontendTestCapacity(targetCpuUnits, timeoutMs = bundleDeadlineMs()) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const currentCpuUnits = Math.floor(bundleCapacity().cpuUnits)
    if (currentCpuUnits >= targetCpuUnits) return
    await new Promise((resolve) => setTimeout(resolve, Math.max(10, Math.ceil(1000 / targetCpuUnits))))
  }
  throw new Error(`timed out waiting for frontend test CPU target: ${targetCpuUnits}`)
}

async function executeRuntimeStep(step) {
  const readinessWait = step.id === 'backend-build-ready'
    ? waitForBackendBuildReady
    : step.id === 'frontend-build-ready'
      ? waitForFrontendBuildReady
      : null
  if (!readinessWait) {
    const result = await executeStep(step)
    if (step.id === 'bootstrap') {
      const namespace = String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim()
      runtimeChildEnvironment = readRuntimeEnvironment(root, namespace)
      console.log(`[local-production:${bundleId}] loaded runtime environment namespace=${namespace}`)
    }
    return result
  }

  const logFile = path.join(logDir, `${step.id}.log`)
  const startedAtMs = Date.now()
  fs.writeFileSync(logFile, '')
  console.log(`[local-production:${bundleId}] start ${step.id} coordination-only`)
  await readinessWait()
  const finishedAtMs = Date.now()
  fs.writeFileSync(logFile, `${step.id} run=${schedulerRunId()} validated=true\n`)
  const result = {
    code: 0,
    signal: null,
    durationMs: finishedAtMs - startedAtMs,
    startedAtMs,
    finishedAtMs,
    logFile
  }
  stepExecutionResults.set(step.id, { ...result, status: 'success' })
  console.log(`[local-production:${bundleId}] done ${step.id} durationMs=${result.durationMs}`)
  register(step, result)
  return result
}

async function executePerformanceStep(step) {
  const result = await executeStep(step)
  if (step.id === 'performance-runtime-bootstrap') {
    const namespace = String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim()
    runtimeChildEnvironment = readRuntimeEnvironment(root, namespace)
    console.log(`[local-production:${bundleId}] loaded runtime environment namespace=${namespace}`)
  }
  return result
}

async function executeFrontendStep(step) {
  if (['frontend-early-test-capacity-ready', 'frontend-test-capacity-ready'].includes(step.id)) {
    const targetCpuUnits = step.id === 'frontend-early-test-capacity-ready'
      ? resolvedFrontendEarlyTestCpuTarget()
      : resolvedFrontendTestCpuTarget()
    const logFile = path.join(logDir, `${step.id}.log`)
    const startedAtMs = Date.now()
    fs.writeFileSync(logFile, '')
    console.log(`[local-production:${bundleId}] start ${step.id} coordination-only`)
    await waitForFrontendTestCapacity(targetCpuUnits)
    const finishedAtMs = Date.now()
    fs.writeFileSync(logFile, `targetCpuUnits=${targetCpuUnits} validated=true\n`)
    const result = { code: 0, signal: null, durationMs: finishedAtMs - startedAtMs, startedAtMs, finishedAtMs, logFile }
    stepExecutionResults.set(step.id, { ...result, status: 'success' })
    console.log(`[local-production:${bundleId}] done ${step.id} durationMs=${result.durationMs}`)
    register(step, result)
    return result
  }
  if (step.id === 'backend-production-summary-ready') {
    const logFile = path.join(logDir, `${step.id}.log`)
    const startedAtMs = Date.now()
    fs.writeFileSync(logFile, '')
    console.log(`[local-production:${bundleId}] start ${step.id} coordination-only`)
    await waitForBackendProductionSummaryReady()
    const finishedAtMs = Date.now()
    fs.writeFileSync(logFile, `${step.id} run=${schedulerRunId()} validated=true\n`)
    const result = {
      code: 0,
      signal: null,
      durationMs: finishedAtMs - startedAtMs,
      startedAtMs,
      finishedAtMs,
      logFile
    }
    stepExecutionResults.set(step.id, { ...result, status: 'success' })
    console.log(`[local-production:${bundleId}] done ${step.id} durationMs=${result.durationMs}`)
    register(step, result)
    return result
  }
  return executeRuntimeStep(step)
}

async function runFrontendTests() {
  const staticManifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/frontend/checks/static/manifest.json'), 'utf8'))
  const frontendPackage = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))
  const staticPlan = planLocalStaticCommands(buildLocalStaticManifest(staticManifest, frontendPackage.scripts))
  const staticEvidence = Object.fromEntries(
    ['blocking-prebuild', 'concurrent', 'postbuild', 'isolated', 'final']
      .map((stage) => [stage, path.join(outDir, `frontend-static-${stage}.json`)])
  )
  const staticTestIds = (entries) => entries.map((entry) => `frontend-static:${entry.id}`)
  const staticStageStep = (stage, options = {}) => commandStep(
    `frontend-static-${stage}`,
    `FSUSBLOG_LOCAL_STATIC_PHASE=${stage} FSUSBLOG_LOCAL_STATIC_EVIDENCE_FILE=${shellQuote(relative(staticEvidence[stage]))} FSUSBLOG_COMMAND_MANIFEST_WORKERS="$FSUSBLOG_STEP_CPU_BUDGET" node tools/test/local-static-governance.mjs`,
    ['frontend-static-governance'],
    {
      ...options,
      artifacts: [staticEvidence[stage]],
      testIds: staticTestIds(staticPlan[stage])
    }
  )
  // Only checks that validate the actual Vitest admission/configuration inputs
  // form the pre-test barrier. Every other static command enters the settled
  // weighted DAG below with explicit resource ownership from the manifest.
  await executeStep(staticStageStep('blocking-prebuild', {
    resources: { cpuWeight: 1, memoryWeight: 0.5, minCpuUnits: 1 }
  }))
  const step = commandStep('vitest-production-projects',
    'node tools/test/run-frontend-vitest-rolling-shards.mjs', [], {
    dependsOn: ['frontend-early-test-capacity-ready'],
    // run-frontend-vitest-rolling-shards reads the admitted step grant. Do not
    // inject the larger eventual bundle target into a smaller live allocation.
    resources: {
      cpuWeight: 2,
      memoryWeight: 1.5,
      minCpuUnits: resolvedFrontendVitestAdmissionFloor(),
      exclusiveResources: ['frontend-test-results']
    }
  })
  const frontendDagResults = new Map()
  await executeWeightedStepDag([
    commandStep('frontend-build-ready', ':', [], {
      resources: { coordinationOnly: true }
    }),
    commandStep('frontend-early-test-capacity-ready', ':', [], {
      resources: { coordinationOnly: true }
    }),
    commandStep('frontend-test-capacity-ready', ':', [], {
      resources: { coordinationOnly: true }
    }),
    staticStageStep('concurrent', {
      resources: {
        cpuWeight: 1,
        memoryWeight: 0.5,
        minCpuUnits: 1,
        exclusiveResources: ['generated-contracts']
      }
    }),
    // Static governance owns the first early CPU. Once build-static releases
    // capacity, Vitest starts in the remaining slots; its run-bound barrier
    // admits the final slot only after this static phase has settled.
    commandStep('static-governance-concurrent', 'tools/test/lanes/static-governance.sh concurrent-prechecks', ['static-governance'], {
      dependsOn: ['frontend-build-ready'],
      resources: { cpuWeight: 1, memoryWeight: 0.5, minCpuUnits: 1 }
    }),
    step,
    commandStep('privacy-zk-contract-prebuild', 'tools/test/lanes/privacy-zk-comment-matrix.sh contract-prebuild', [], {
      dependsOn: ['frontend-early-test-capacity-ready'],
      resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    }),
    commandStep('privacy-zk-contract', 'tools/test/lanes/privacy-zk-comment-matrix.sh contract-postbuild', [], {
      dependsOn: ['frontend-build-ready', 'privacy-zk-contract-prebuild'],
      resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    }),
    staticStageStep('postbuild', {
      dependsOn: ['frontend-build-ready'],
      resources: {
        cpuWeight: 0.5,
        memoryWeight: 0.5,
        minCpuUnits: 1,
        exclusiveResources: ['frontend-dist', 'frontend-static-output']
      }
    }),
    commandStep('vitest-settled', null, [], {
      dependsOn: ['vitest-production-projects'],
      runAfterSettled: true,
      resources: { coordinationOnly: true }
    }),
    // Preserve the complete release/rehearsal contract set, but start its long
    // process-based fixtures only after Vitest releases the duplicated Vite
    // transform hosts. The scheduler can then assign this step the live tail
    // grant instead of leaving it on the initial one-CPU share.
    commandStep('static-governance-node-contracts', 'tools/test/lanes/static-governance.sh node-contracts', ['static-governance'], {
      dependsOn: ['vitest-settled'],
      resources: { cpuWeight: 2, memoryWeight: 1, minCpuUnits: 1 }
    }),
    commandStep('static-governance-post-vitest', 'tools/test/lanes/static-governance.sh post-vitest', ['static-governance'], {
      dependsOn: ['vitest-settled'],
      resources: { cpuWeight: 0.5, memoryWeight: 0.5, minCpuUnits: 1 }
    }),
    commandStep('frontend-coverage-summary',
      'FSUSBLOG_COVERAGE_SKIP_TESTS=1 tools/coverage/collect-frontend-coverage.sh', [], {
        dependsOn: ['vitest-settled'],
        resources: {
          cpuWeight: 0.5,
          memoryWeight: 0.5,
          minCpuUnits: 1,
          exclusiveResources: ['frontend-test-results', 'frontend-coverage']
        }
      }),
    staticStageStep('isolated', {
      dependsOn: ['vitest-settled'],
      resources: {
        cpuWeight: 0.5,
        memoryWeight: 0.5,
        minCpuUnits: 1,
        exclusiveResources: ['frontend-static-output', 'frontend-render-pressure']
      }
    }),
    staticStageStep('final', {
      dependsOn: ['frontend-static-concurrent', 'frontend-static-postbuild', 'frontend-static-isolated'],
      runAfterSettled: true,
      resources: {
        cpuWeight: 0.5,
        memoryWeight: 0.25,
        minCpuUnits: 1,
        exclusiveResources: ['frontend-static-output', 'frontend-render-pressure']
      }
    }),
    commandStep('frontend-tests-join', null, [], {
      dependsOn: [
        'vitest-production-projects',
        'frontend-static-concurrent',
        'static-governance-concurrent',
        'static-governance-node-contracts',
        'frontend-static-postbuild',
        'frontend-static-isolated',
        'frontend-static-final',
        'static-governance-post-vitest',
        'frontend-coverage-summary'
      ],
      runAfterSettled: true,
      resources: { coordinationOnly: true }
    })
  ], bundleDagCapacity, async (frontendStep) => {
    const result = await executeFrontendStep(frontendStep)
    frontendDagResults.set(frontendStep.id, result)
  })
  const result = frontendDagResults.get('vitest-production-projects')
  if (!result) throw new Error('vitest-production-projects completed without a result')
  await waitForSiblingBundleSummaries(['build-static'])
  const perfStep = commandStep('vitest-production-perf-isolated', [
    'node tools/test/run-frontend-vitest-perf-isolated.mjs'
  ].join(' && '), [], {
    resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
  })
  const perfResult = await executeStep(perfStep)
  const reports = [
    path.join(root, '.tmp/test-results/vitest/production-rolling/merged.json'),
    path.join(root, '.tmp/test-results/vitest/production-rolling/summary.json'),
    path.join(root, '.tmp/test-results/vitest/production/perf-isolated.json'),
    path.join(root, '.tmp/test-results/vitest/production/perf-isolated-timing.json')
  ]
  if (reports.some((file) => !fs.existsSync(file))) throw new Error('current-run Vitest report is missing')
  const tests = parseVitestReports(reports)
  if (tests.length === 0 || tests.some((entry) => entry.status !== 'passed')) throw new Error('Vitest report is empty or contains non-passing tests')
  const summary = path.join(root, '.tmp/coverage/frontend/Summary.json')
  const perfTests = tests.filter((entry) => entry.file.includes('/benchmarks/'))
  const nonPerfTests = tests.filter((entry) => !entry.file.includes('/benchmarks/'))
  if (perfTests.length === 0) throw new Error('isolated frontend perf report is empty')
  const byMember = {
    'frontend-unit-shard': nonPerfTests.filter((entry) => entry.file.includes('/unit/')),
    'frontend-property-model-perf': nonPerfTests.filter((entry) => /\/(?:property|model)\//u.test(entry.file)),
    'frontend-fast-summary': nonPerfTests,
    'coverage-frontend': nonPerfTests
  }
  for (const tierId of bundle.members) {
    if (['static-governance', 'frontend-static-governance'].includes(tierId)) continue
    const selected = byMember[tierId] ?? []
    if (selected.length === 0) throw new Error(`${tierId} received no executed Vitest IDs`)
    register({ id: 'vitest-production-projects', members: [tierId] }, result, selected.map((entry) => entry.id), [summary, ...reports])
    if (['frontend-property-model-perf', 'frontend-fast-summary', 'coverage-frontend'].includes(tierId)) {
      register({ id: 'vitest-production-perf-isolated', members: [tierId] }, perfResult,
        perfTests.map((entry) => entry.id), [summary, ...reports])
    }
  }
}

async function run() {
  if (finalizeExisting) loadExistingMemberExecutionReceipts()
  else if (bundleId === 'backend-tests') await runBackendTests()
  else if (bundleId === 'frontend-tests') await runFrontendTests()
  else if (bundleId === 'build-static') {
    await executeWeightedStepDag(buildStaticSteps(), bundleDagCapacity, async (step) => {
      const result = await executeStep(step)
      if (step.id === 'sync-static-assets') publishFrontendBuildReady()
      return result
    })
  } else {
    const steps = bundleId === 'runtime-browser' ? runtimeSteps() : performanceSteps()
    await executeWeightedStepDag(
      steps,
      bundleDagCapacity,
      bundleId === 'runtime-browser' ? executeRuntimeStep : executePerformanceStep
    )
  }

  if (!finalizeExisting) writeMemberExecutionReceipts()
  bindMatrixRuntimeArtifacts()
  artifactDigestTable.registerConsumers(Object.fromEntries(
    [...memberEvidence.entries()].map(([tierId, evidence]) => [tierId, evidence.artifactRefs])))
  if (bundleId === 'performance-evidence') {
    const currentInvocationDurationMs = Date.now() - startedAt
    const steps = performanceSteps().map(({ id }) => {
      const result = stepExecutionResults.get(id)
      if (!result) throw new Error(`performance deadline evidence is missing step result: ${id}`)
      return {
        id,
        status: result.status,
        durationMs: result.durationMs,
        startedAtMs: result.startedAtMs,
        finishedAtMs: result.finishedAtMs
      }
    })
    const mixedStepDurationMs = steps.find((step) => step.id === 'mixed-performance-window')?.durationMs
    const mixedSummaryFile = path.join(root, '.tmp/perf/mixed-window/summary.json')
    const mixedSummaryDurationMs = fs.existsSync(mixedSummaryFile)
      ? Number(JSON.parse(fs.readFileSync(mixedSummaryFile, 'utf8')).elapsedMs)
      : 0
    const mixedDurationMs = Math.max(mixedStepDurationMs, mixedSummaryDurationMs)
    const measuredOtherSerialMs = Math.max(0, currentInvocationDurationMs - mixedStepDurationMs)
    const bundleDurationMs = measuredOtherSerialMs + mixedDurationMs
    performanceDeadlineEvidence = {
      schema: 'fsusblog.performance-deadline-evidence.v1',
      status: 'sufficient',
      schedulerRunId: schedulerRunId(),
      candidateBudgetMs: bundleDeadlineMs(),
      bundleDurationMs,
      mixedWindow: {
        stepId: 'mixed-performance-window',
        minimumDurationMs: performanceMixedWindowFloorMs,
        measuredDurationMs: mixedDurationMs
      },
      measuredOtherSerialMs,
      requiredBudgetMs: performanceMixedWindowFloorMs + measuredOtherSerialMs,
      steps,
      generatedAt: new Date().toISOString()
    }
    const deadlineErrors = validatePerformanceDeadlineEvidence(performanceDeadlineEvidence, {
      expectedRunId: schedulerRunId()
    })
    if (deadlineErrors.length > 0) throw new Error(`performance deadline evidence invalid: ${deadlineErrors.join('; ')}`)
    const deadlineFile = path.join(outDir, 'deadline-evidence.json')
    fs.writeFileSync(deadlineFile, `${JSON.stringify(performanceDeadlineEvidence, null, 2)}\n`)
  }
  const members = Object.fromEntries([...memberEvidence.entries()].map(([tierId, evidence]) => [tierId, {
    ...evidence,
    testIds: [...new Set(evidence.testIds)].sort(),
    artifactDigests: Object.fromEntries(Object.entries(evidence.artifactDigests).sort()),
    artifactRefs: Object.fromEntries(Object.entries(evidence.artifactRefs).sort())
  }]))
  for (const [tierId, evidence] of Object.entries(members)) {
    if (evidence.testIds.length === 0 || Object.keys(evidence.artifactDigests).length === 0
      || Object.keys(evidence.artifactRefs).length !== Object.keys(evidence.artifactDigests).length) {
      throw new Error(`${tierId} has no executed test IDs or complete artifact refs`)
    }
  }
  const summary = {
    schema: 'fsusblog.local-production.bundle.v1',
    physicalBundleId: bundleId,
    executionSource: 'fresh',
    status: 'success',
    schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
    runToken: randomUUID(),
    durationMs: Date.now() - startedAt,
    ...(performanceDeadlineEvidence ? { deadlineEvidence: performanceDeadlineEvidence } : {}),
    members,
    generatedAt: new Date().toISOString()
  }
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  const temporary = `${summaryFile}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`)
  fs.renameSync(temporary, summaryFile)
  console.log(`[local-production:${bundleId}] summary=${relative(summaryFile)} members=${Object.keys(members).length}`)
}

run().catch((error) => {
  if (shutdownPromise) return
  console.error(`[local-production:${bundleId}] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
