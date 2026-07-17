#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { cleanupLocalRuntime } from '../../tools/test-matrix/local-runtime-cleanup.mjs'

const responseSchema = 'fsusblog.browser-contract-fixture-provider-response.v1'
const requestSchema = 'fsusblog.browser-contract-fixture-provider-request.v1'
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

function fail(message) {
  throw new Error(message)
}

function assertInside(root, value, label) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(value)
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`${label} is outside its owned root`)
  }
  return resolved
}

function parseEnvFile(file) {
  return readFile(file, 'utf8').then((raw) => Object.fromEntries(raw
    .split(/\r?\n/u)
    .map((line) => {
      const separator = line.indexOf('=')
      return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : null
    })
    .filter(Boolean)))
}

function decodePublicFixture(raw) {
  return Object.fromEntries(raw.split(/\r?\n/u).map((line) => {
    const separator = line.indexOf('\t')
    if (separator < 1) return null
    return [line.slice(0, separator), Buffer.from(line.slice(separator + 1), 'base64url').toString('utf8')]
  }).filter(Boolean))
}

async function readRequest() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (request?.schema !== requestSchema) fail('fixture provider request schema mismatch')
  const namespace = String(request.identity?.namespace ?? '')
  if (!/^bc-[a-f0-9]{8}-[a-f0-9]{10}-[a-f0-9]{6}$/u.test(namespace)) fail('fixture provider namespace is invalid')
  if (request.identity?.laneId !== 'browser-contract') fail('fixture provider lane identity mismatch')
  if (!/^[0-9a-f-]{36}$/u.test(String(request.preparation?.id ?? ''))
    || !Number.isFinite(Date.parse(String(request.preparation?.startedAt ?? '')))) {
    fail('fixture provider preparation identity is invalid')
  }
  if (request.resources?.databaseSchema !== 'public'
    || request.resources?.databaseInstance !== `fsusblog-test-postgres-${namespace}`
    || request.resources?.redisNamespace !== `FsusBlog_${namespace}_`
    || request.resources?.redisInstance !== `fsusblog-test-redis-${namespace}`) {
    fail('fixture provider resource identity mismatch')
  }
  const fixtureRoot = assertInside(
    path.join(repoRoot, '.tmp', 'browser-contract', 'fixtures'),
    request.resources.fixtureRoot,
    'fixture root'
  )
  if (path.basename(fixtureRoot) !== namespace) fail('fixture root namespace mismatch')
  return { ...request, resources: { ...request.resources, fixtureRoot } }
}

function providerStateFile(request) {
  return path.join(request.resources.fixtureRoot, 'provider-state.json')
}

async function writePrivateJson(file, value) {
  const temporary = `${file}.next-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
    await chmod(file, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function readProviderState(request) {
  const state = await readProviderStateOptional(request)
  if (!state) fail('fixture provider state is missing or unsafe')
  return state
}

async function readProviderStateOptional(request) {
  const file = providerStateFile(request)
  let stat
  try {
    stat = await lstat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    fail('fixture provider state is unsafe')
  }
  return validateDefaultFixtureProviderState(JSON.parse(await readFile(file, 'utf8')), request)
}

export function validateDefaultFixtureProviderState(state, request) {
  const preparing = state?.phase === 'preparing'
  const prepared = state?.phase === 'prepared'
  const validContainerId = (value) => preparing
    ? value === null
    : /^[a-f0-9]{64}$/u.test(String(value ?? ''))
  if (state?.schema !== 'fsusblog.browser-contract-default-provider-state.v1'
    || (!preparing && !prepared)
    || state.namespace !== request.identity.namespace
    || state.preparation?.id !== request.preparation?.id
    || state.preparation?.startedAt !== request.preparation?.startedAt
    || state.sourceState?.commit !== request.sourceState?.commit
    || state.sourceState?.worktreeFingerprint !== request.sourceState?.worktreeFingerprint
    || state.buildIdentity?.receiptContentDigest !== request.build?.receiptContentDigest
    || state.containers?.postgres?.name !== request.resources.databaseInstance
    || state.containers?.redis?.name !== request.resources.redisInstance
    || !validContainerId(state.containers?.postgres?.id)
    || !validContainerId(state.containers?.redis?.id)
    || (prepared && state.runtime?.isolatedDatabase !== true)
    || (prepared && state.runtime?.testSessionHeader !== false)
    || (preparing && state.runtime !== null)) {
    fail('fixture provider state identity or ownership mismatch')
  }
  return state
}

async function readPreparedProviderState(request) {
  const state = await readProviderState(request)
  if (state.phase !== 'prepared') fail('fixture provider state is not prepared')
  return state
}

function run(command, args, { env = process.env, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const limit = 256 * 1024
    const timer = timeoutMs > 0
      ? setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      : null
    timer?.unref()
    child.stdout.on('data', (chunk) => { if (stdout.length < limit) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < limit) stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      if (code !== 0 || signal) {
        reject(new Error(`${path.basename(command)} failed with ${signal || `exit ${code}`}`))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

const containerInspectionFormat = [
  '{{.Id}}',
  '{{.Name}}',
  '{{.Config.Image}}',
  '{{index .Config.Labels "io.fsusblog.test.run-id"}}',
  '{{index .Config.Labels "io.fsusblog.test.bundle-id"}}',
  '{{index .Config.Labels "io.fsusblog.test.step-id"}}',
  '{{index .Config.Labels "io.fsusblog.test.namespace"}}',
  '{{index .Config.Labels "io.fsusblog.test.preparation-id"}}'
].join('|')

function normalizedLabel(value) {
  return value === '<no value>' ? '' : String(value ?? '')
}

async function inspectContainer(name) {
  const result = await run('docker', ['inspect', '--format', containerInspectionFormat, name])
  const [id, rawName, image, runId, bundleId, stepId, namespace, preparationId] = result.stdout.trim().split('|')
  if (!/^[a-f0-9]{64}$/u.test(id) || rawName !== `/${name}`) fail(`owned container inspection failed: ${name}`)
  return {
    name,
    id,
    image,
    labels: {
      runId: normalizedLabel(runId),
      bundleId: normalizedLabel(bundleId),
      stepId: normalizedLabel(stepId),
      namespace: normalizedLabel(namespace),
      preparationId: normalizedLabel(preparationId)
    }
  }
}

async function inspectContainerOptional(name) {
  try {
    return await inspectContainer(name)
  } catch (inspectionError) {
    const inventory = await run('docker', ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}'])
    const names = inventory.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)
    if (names.includes(name)) throw inspectionError
    return null
  }
}

async function inspectContainerIdOptional(id) {
  try {
    const result = await run('docker', ['inspect', '--format', containerInspectionFormat, id])
    const [observedId, rawName, image, runId, bundleId, stepId, namespace, preparationId] = result.stdout.trim().split('|')
    if (observedId !== id || !rawName.startsWith('/')) fail(`owned container id inspection failed: ${id}`)
    return {
      name: rawName.slice(1),
      id: observedId,
      image,
      labels: {
        runId: normalizedLabel(runId),
        bundleId: normalizedLabel(bundleId),
        stepId: normalizedLabel(stepId),
        namespace: normalizedLabel(namespace),
        preparationId: normalizedLabel(preparationId)
      }
    }
  } catch (inspectionError) {
    const inventory = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}'])
    const ids = inventory.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)
    if (ids.includes(id)) throw inspectionError
    return null
  }
}

function containerIdentity(container) {
  const id = String(container?.id ?? container?.Id ?? '')
  const rawName = String(container?.name ?? container?.Name ?? '')
  return {
    id,
    name: rawName.startsWith('/') ? rawName.slice(1) : rawName
  }
}

function inspectDockerContainerSync(reference) {
  const result = spawnSync('docker', ['inspect', reference], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim()
    if (/no such (?:object|container)/iu.test(detail)) return null
    fail(`docker inspect failed for ${reference}: ${detail || `exit ${result.status}`}`)
  }
  try {
    return JSON.parse(String(result.stdout ?? ''))?.[0] ?? null
  } catch {
    fail(`docker inspect returned invalid JSON for ${reference}`)
  }
}

function removeDockerContainerByIdSync(containerId) {
  const result = spawnSync('docker', ['rm', '--force', '--volumes', containerId], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  return result
}

function removalFailure(reason, exitCode = null) {
  return { removed: false, exitCode, reason }
}

export function removeVerifiedContainerById(containerId, {
  name,
  inspected,
  expected,
  removeById = removeDockerContainerByIdSync,
  inspectById = inspectDockerContainerSync,
  inspectByName = inspectDockerContainerSync
} = {}) {
  if (!/^[a-f0-9]{64}$/u.test(String(containerId ?? ''))) {
    return removalFailure('container-id-is-not-full')
  }
  const expectedIdentity = containerIdentity(expected)
  const inspectedIdentity = containerIdentity(inspected)
  if (expectedIdentity.id !== containerId
    || expectedIdentity.name !== name
    || inspectedIdentity.id !== containerId
    || (inspectedIdentity.name && inspectedIdentity.name !== name)) {
    return removalFailure('container-removal-identity-mismatch')
  }

  const observedById = inspectById(containerId)
  if (observedById === null) {
    return inspectByName(name) === null
      ? { removed: true, exitCode: 0, reason: null }
      : removalFailure('container-name-replaced-before-removal')
  }
  const observedIdentity = containerIdentity(observedById)
  if (observedIdentity.id !== containerId || observedIdentity.name !== name) {
    return removalFailure('container-removal-precondition-changed')
  }

  let removal
  try {
    removal = removeById(containerId)
  } catch (error) {
    return removalFailure(error instanceof Error ? error.message : String(error))
  }
  const exitCode = Number.isInteger(removal?.status)
    ? removal.status
    : Number.isInteger(removal?.exitCode) ? removal.exitCode : null
  const commandSucceeded = exitCode === null
    ? removal === true || removal?.removed === true
    : exitCode === 0
  if (inspectById(containerId) !== null) {
    return removalFailure('container-id-survived-removal', exitCode)
  }
  if (inspectByName(name) !== null) {
    return removalFailure('container-name-replaced-after-removal', exitCode)
  }
  if (!commandSucceeded) {
    return removalFailure('container-remove-command-failed', exitCode)
  }
  return { removed: true, exitCode, reason: null }
}

export function compensateVerifiedContainerCleanup(observedContainers, {
  removeById = removeDockerContainerByIdSync,
  inspectById = inspectDockerContainerSync,
  inspectByName = inspectDockerContainerSync
} = {}) {
  return [...observedContainers].map((observed) => {
    const identity = containerIdentity(observed)
    const outcome = removeVerifiedContainerById(identity.id, {
      name: identity.name,
      inspected: observed,
      expected: observed,
      removeById,
      inspectById,
      inspectByName
    })
    return { ...identity, ...outcome }
  })
}

function expectedContainerBinding(request) {
  return {
    runId: `browser-contract-${request.identity.runId}`,
    bundleId: 'browser-contract',
    stepId: 'browser-contract-fixture',
    namespace: request.identity.namespace,
    preparationId: request.preparation.id
  }
}

function assertOwnedContainer(container, request, expectedId = null) {
  const expected = expectedContainerBinding(request)
  if ((expectedId && container.id !== expectedId)
    || Object.entries(expected).some(([key, value]) => container.labels?.[key] !== value)) {
    fail(`refusing cleanup after ${container.name} ownership changed`)
  }
  const expectedImage = container.name === request.resources.databaseInstance
    ? 'postgres:16-alpine'
    : container.name === request.resources.redisInstance ? 'redis:7-alpine' : null
  if (!expectedImage || container.image !== expectedImage) {
    fail(`refusing cleanup after ${container.name} image changed`)
  }
  return container
}

async function pathExists(value) {
  try {
    await lstat(value)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function runtimeRecoveryPaths(request) {
  const namespace = request.identity.namespace
  return [
    path.join(repoRoot, '.tmp', 'env', `${namespace}.env`),
    path.join(repoRoot, '.tmp', 'acceptance', namespace),
    path.join(repoRoot, '.tmp', 'fixtures', namespace),
    path.join(repoRoot, '.tmp', 'data', namespace),
    path.join(repoRoot, '.tmp', 'run-once', namespace)
  ]
}

async function assertNamespaceVacant(request) {
  for (const name of [request.resources.databaseInstance, request.resources.redisInstance]) {
    if (await inspectContainerOptional(name)) {
      fail(`browser contract namespace already owns container ${name}; cleanup requires its sealed provider state`)
    }
  }
  for (const recoveryPath of runtimeRecoveryPaths(request)) {
    if (await pathExists(recoveryPath)) {
      fail(`browser contract namespace has stale runtime state: ${path.relative(repoRoot, recoveryPath)}`)
    }
  }
}

async function immutableBuildEnvironment(request) {
  const relativeReceipt = String(request.build?.receipt ?? '').trim()
  if (!relativeReceipt) fail('immutable build receipt path is missing from provider request')
  const receiptFile = assertInside(repoRoot, path.resolve(repoRoot, relativeReceipt), 'immutable build receipt')
  const artifactRoot = path.dirname(receiptFile)
  if (artifactRoot !== path.join(repoRoot, '.tmp', 'ci-production-build')) {
    fail('immutable build artifact root is not the canonical run-bound root')
  }
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
  if (receipt?.schema !== 'fsusblog.ci-production-build-receipt.v1'
    || receipt.status !== 'complete'
    || receipt.contentDigest !== request.build.receiptContentDigest
    || receipt.sourceState?.commit !== request.sourceState?.commit
    || receipt.sourceState?.worktreeFingerprint !== request.sourceState?.worktreeFingerprint) {
    fail('immutable build receipt identity mismatch')
  }
  const domains = new Set((receipt.domains ?? []).map((domain) => domain.name))
  for (const domain of ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm']) {
    if (!domains.has(domain)) fail(`immutable build receipt is missing ${domain}`)
  }
  return {
    FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: artifactRoot,
    FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: receipt.contentDigest,
    FSUSBLOG_TEST_SOURCE_COMMIT: receipt.sourceState.commit,
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: receipt.sourceState.worktreeFingerprint,
    GITHUB_RUN_ID: String(receipt.producer?.runId ?? ''),
    GITHUB_RUN_ATTEMPT: String(receipt.producer?.runAttempt ?? 1)
  }
}

async function cleanupOwnedRuntime(request, state = null) {
  const expectedContainers = [
    state?.containers?.postgres ?? { name: request.resources.databaseInstance, id: null },
    state?.containers?.redis ?? { name: request.resources.redisInstance, id: null }
  ]
  const observedBefore = new Map()
  for (const expected of expectedContainers) {
    const observed = await inspectContainerOptional(expected.name)
    if (observed) {
      if (!state) fail(`refusing cleanup of ${expected.name} without sealed provider state`)
      assertOwnedContainer(observed, request, expected.id)
      observedBefore.set(expected.name, observed)
    }
  }
  if (!state) {
    for (const recoveryPath of runtimeRecoveryPaths(request)) {
      if (await pathExists(recoveryPath)) {
        fail(`refusing cleanup without sealed provider state: ${path.relative(repoRoot, recoveryPath)}`)
      }
    }
  }
  const result = cleanupLocalRuntime({
    root: repoRoot,
    namespace: request.identity.namespace,
    removeContainer: (containerId, { name, inspected } = {}) => removeVerifiedContainerById(containerId, {
      name,
      inspected,
      expected: observedBefore.get(name)
    })
  })
  // The local runtime manifest is recovery evidence, not the ownership source.
  // It may be absent or only partially written after bootstrap fails. Always
  // compensate from the full IDs whose state, labels, image, and name were
  // verified above; the helper refuses to touch a same-name replacement.
  const compensation = compensateVerifiedContainerCleanup(observedBefore.values())
  const compensationFailures = compensation.filter((entry) => entry.removed !== true)
  const skippedProcesses = result.skippedProcesses ?? []
  const skippedPids = skippedProcesses
    .map((entry) => entry?.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 1)
  const filePaths = runtimeRecoveryPaths(request)
  const retainedFilePaths = []
  for (const filePath of filePaths) {
    if (await pathExists(filePath)) retainedFilePaths.push(filePath)
  }
  const files = {
    status: retainedFilePaths.length === 0 ? 'success' : 'failure',
    paths: filePaths.map((filePath) => path.relative(repoRoot, filePath).replaceAll(path.sep, '/')),
    retainedPaths: retainedFilePaths.map((filePath) => path.relative(repoRoot, filePath).replaceAll(path.sep, '/')),
    confirmedAbsent: retainedFilePaths.length === 0
  }
  const success = result.skippedContainers.length === 0
    && skippedProcesses.length === 0
    && result.containerCleanupFailures.length === 0
    && compensationFailures.length === 0
    && result.cleanupStatus === 'complete'
    && files.status === 'success'
  for (const observed of observedBefore.values()) {
    if (await inspectContainerIdOptional(observed.id)) fail(`owned container id survived cleanup: ${observed.id}`)
    if (await inspectContainerOptional(observed.name)) fail(`owned container name survived cleanup: ${observed.name}`)
  }
  for (const expected of expectedContainers) {
    if (!observedBefore.has(expected.name) && await inspectContainerOptional(expected.name)) {
      fail(`owned container name appeared during cleanup: ${expected.name}`)
    }
  }
  return {
    status: success ? 'success' : 'failure',
    resources: {
      database: {
        status: observedBefore.has(request.resources.databaseInstance) ? 'success' : 'already-absent',
        instance: request.resources.databaseInstance,
        id: state?.containers?.postgres?.id ?? null
      },
      redis: {
        status: observedBefore.has(request.resources.redisInstance) ? 'success' : 'already-absent',
        instance: request.resources.redisInstance,
        id: state?.containers?.redis?.id ?? null
      },
      processes: {
        status: success ? 'success' : 'failure',
        terminatedPids: result.terminatedPids,
        skippedPids,
        skippedProcesses,
        retainedRuntimeState: result.retainedRuntimeState === true
      },
      files
    }
  }
}

async function bootstrapDedicatedRuntime(request) {
  const buildEnvironment = await immutableBuildEnvironment(request)
  await assertNamespaceVacant(request)
  await mkdir(request.resources.fixtureRoot, { recursive: true, mode: 0o700 })
  await chmod(request.resources.fixtureRoot, 0o700)
  const state = {
    schema: 'fsusblog.browser-contract-default-provider-state.v1',
    phase: 'preparing',
    namespace: request.identity.namespace,
    preparation: request.preparation,
    runtime: null,
    containers: {
      postgres: { name: request.resources.databaseInstance, id: null, image: 'postgres:16-alpine' },
      redis: { name: request.resources.redisInstance, id: null, image: 'redis:7-alpine' }
    },
    sourceState: request.sourceState,
    buildIdentity: {
      receiptContentDigest: request.build?.receiptContentDigest ?? null
    }
  }
  await writePrivateJson(providerStateFile(request), state)
  const env = { ...process.env }
  for (const key of [
    'FSUSBLOG_POSTGRES_PORT',
    'FSUSBLOG_REDIS_PORT',
    'FSUSBLOG_DEBUG_BACKEND_PORT',
    'FSUSBLOG_DEBUG_FRONTEND_PORT',
    'FSUSBLOG_RELEASE_PREVIEW_PORT',
    'FSUSBLOG_DEBUG_BACKEND_URL',
    'FSUSBLOG_DEBUG_FRONTEND_URL',
    'FSUSBLOG_RELEASE_PREVIEW_URL',
    'FSUSBLOG_POSTGRES_CONTAINER_NAME',
    'FSUSBLOG_REDIS_CONTAINER_NAME',
    'FSUSBLOG_DATA_ROOT',
    'FSUSBLOG_TEST_SESSION'
  ]) delete env[key]
  Object.assign(env, {
    ...buildEnvironment,
    FSUSBLOG_TEST_NAMESPACE: request.identity.namespace,
    FSUSBLOG_TEST_RUN_ID: `browser-contract-${request.identity.runId}`,
    FSUSBLOG_PHYSICAL_BUNDLE_ID: 'browser-contract',
    FSUSBLOG_STEP_ID: 'browser-contract-fixture',
    FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: request.preparation.id,
    FSUSBLOG_FIXTURE_ROOT: request.resources.fixtureRoot,
    FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'legacy-parallel',
    FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
    FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY: '1',
    FSUSBLOG_TEST_SESSION_ISOLATION: '0',
    FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '1',
    FSUSBLOG_PUBLIC_AOT_BACKFILL_CONCURRENCY: '1',
    FSUSBLOG_PUBLIC_AOT_SSR_WORKER_COUNT: '1',
    FSUSBLOG_FORCE_BOOTSTRAP: '1',
    FSUSBLOG_PERSIST_AUTH_FIXTURES: '1'
  })
  await run('bash', [path.join(repoRoot, 'tools', 'bootstrap-acceptance-env.sh')], { env })
  const environment = await parseEnvFile(path.join(repoRoot, '.tmp', 'env', `${request.identity.namespace}.env`))
  if (environment.FSUSBLOG_TEST_NAMESPACE !== request.identity.namespace
    || environment.FSUSBLOG_POSTGRES_CONTAINER_NAME !== request.resources.databaseInstance
    || environment.FSUSBLOG_REDIS_CONTAINER_NAME !== request.resources.redisInstance) {
    fail('dedicated acceptance runtime ownership manifest mismatch')
  }
  const postgres = await inspectContainer(request.resources.databaseInstance)
  const redis = await inspectContainer(request.resources.redisInstance)
  assertOwnedContainer(postgres, request)
  assertOwnedContainer(redis, request)
  const runtime = {
    backendUrl: environment.FSUSBLOG_DEBUG_BACKEND_URL,
    frontendUrl: environment.FSUSBLOG_RELEASE_PREVIEW_URL || environment.FSUSBLOG_DEBUG_FRONTEND_URL,
    debugFrontendUrl: environment.FSUSBLOG_DEBUG_FRONTEND_URL,
    isolatedDatabase: true,
    testSessionHeader: false
  }
  for (const [label, value] of Object.entries(runtime)) {
    if (label.endsWith('Url') && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(String(value ?? ''))) {
      fail(`dedicated acceptance runtime ${label} is invalid`)
    }
  }
  const preparedState = {
    ...state,
    phase: 'prepared',
    runtime,
    containers: { postgres, redis },
    preparedAt: new Date().toISOString()
  }
  await writePrivateJson(providerStateFile(request), preparedState)
  return preparedState
}

async function publishedArticle(request) {
  const state = await readPreparedProviderState(request)
  const fixture = decodePublicFixture(await readFile(path.join(request.resources.fixtureRoot, 'public.aeds'), 'utf8'))
  if (!/^\d+$/u.test(fixture.articleId) || !/^\d+$/u.test(fixture.categoryId) || !fixture.articleTitle) {
    fail('dedicated public fixture is incomplete')
  }
  return {
    id: fixture.articleId,
    title: fixture.articleTitle,
    url: `${state.runtime.frontendUrl}/article/${fixture.articleId}`,
    category: {
      id: fixture.categoryId,
      name: process.env.FSUSBLOG_PLAYWRIGHT_CATEGORY_NAME || 'Acceptance Category'
    }
  }
}

async function sessionEntity(request, role) {
  const state = await readPreparedProviderState(request)
  const authRoot = path.join(request.resources.fixtureRoot, 'auth')
  const auth = JSON.parse(await readFile(path.join(authRoot, 'auth-fixtures.json'), 'utf8'))
  const descriptor = auth[role]
  if (!Number.isInteger(Number(descriptor?.id)) || Number(descriptor.id) <= 0) fail(`${role} auth fixture is invalid`)
  const source = assertInside(authRoot, path.join(authRoot, String(descriptor.storageStateFile ?? '')), `${role} storage state`)
  const sourceStat = await lstat(source)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || (sourceStat.mode & 0o777) !== 0o600) {
    fail(`${role} storage state is unsafe`)
  }
  const destinationName = `${role}.storage-state.json`
  const destination = path.join(request.resources.fixtureRoot, destinationName)
  const temporary = `${destination}.next-${process.pid}-${randomUUID()}`
  try {
    await copyFile(source, temporary)
    await chmod(temporary, 0o600)
    await rename(temporary, destination)
    await chmod(destination, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return {
    id: Number(descriptor.id),
    storageStateFile: destinationName,
    ...(role === 'user' ? { capabilities: { webAuthnRegistration: false } } : {}),
    runtime: state.runtime
  }
}

export function derivePendingCommentPrivacyIdentity(namespace, articleId) {
  const normalizedNamespace = String(namespace ?? '')
  const normalizedArticleId = String(articleId ?? '')
  if (!/^[a-z0-9_-]+$/u.test(normalizedNamespace)) fail('pending comment namespace is invalid')
  if (!/^[1-9][0-9]*$/u.test(normalizedArticleId)) fail('pending comment article id is invalid')
  const nullifierHash = createHash('sha256')
    .update(`browser-contract:nullifier:${normalizedNamespace}:${normalizedArticleId}`)
    .digest('hex')
  return {
    anonymousHandle: `bc-${nullifierHash.slice(0, 16)}`,
    nullifierHash,
    moderationSubjectHash: createHash('sha256')
      .update(`browser-contract:moderation:${normalizedNamespace}:${normalizedArticleId}`)
      .digest('hex')
  }
}

async function pendingComment(request) {
  const state = await readPreparedProviderState(request)
  const article = await publishedArticle(request)
  const commentId = String(800_000_000_000_000n + BigInt(`0x${createHash('sha256').update(request.identity.namespace).digest('hex').slice(0, 12)}`))
  const privacy = derivePendingCommentPrivacyIdentity(request.identity.namespace, article.id)
  const sql = `
INSERT INTO comment (
  id, article_id, content, create_time, user_id, author_mode, public_handle,
  anonymous_handle, anonymous_display_name, anonymous_display_language,
  anonymous_nullifier_hash, anonymous_scope, moderation_subject_hash,
  credential_level, reputation_bucket, account_age_bucket,
  anonymous_rate_class, anonymous_requires_moderation,
  parent_id, root_id, reply_to_user_id, reply_to_comment_id,
  depth, is_deleted, delete_reason, delete_time,
  moderation_status, moderation_reason, moderated_by_admin_principal_id, moderated_at
) VALUES (
  ${commentId}, ${article.id}, 'Browser Contract pending comment', now(), NULL, 'zk_anonymous', NULL,
  '${privacy.anonymousHandle}', 'Browser Contract Reader', 'en',
  '${privacy.nullifierHash}', 'browser-contract:${article.id}', '${privacy.moderationSubjectHash}',
  NULL, NULL, NULL, 'common', true,
  NULL, NULL, NULL, NULL,
  0, false, NULL, NULL,
  0, 'browser-contract-fixture', NULL, NULL
) ON CONFLICT (id) DO UPDATE SET
  article_id = EXCLUDED.article_id,
  content = EXCLUDED.content,
  create_time = EXCLUDED.create_time,
  user_id = NULL,
  author_mode = EXCLUDED.author_mode,
  public_handle = NULL,
  anonymous_handle = EXCLUDED.anonymous_handle,
  anonymous_display_name = EXCLUDED.anonymous_display_name,
  anonymous_display_language = EXCLUDED.anonymous_display_language,
  anonymous_nullifier_hash = EXCLUDED.anonymous_nullifier_hash,
  anonymous_scope = EXCLUDED.anonymous_scope,
  moderation_subject_hash = EXCLUDED.moderation_subject_hash,
  credential_level = NULL,
  reputation_bucket = NULL,
  account_age_bucket = NULL,
  anonymous_rate_class = EXCLUDED.anonymous_rate_class,
  anonymous_requires_moderation = true,
  parent_id = NULL,
  root_id = NULL,
  reply_to_user_id = NULL,
  reply_to_comment_id = NULL,
  depth = 0,
  is_deleted = false,
  delete_reason = NULL,
  delete_time = NULL,
  moderation_status = 0,
  moderation_reason = EXCLUDED.moderation_reason,
  moderated_by_admin_principal_id = NULL,
  moderated_at = NULL
RETURNING id;
`
  const result = await run('docker', [
    'exec', '-i', state.containers.postgres.name,
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'fsusblog', '-d', 'fsusblog', '-Atqc', sql
  ])
  if (result.stdout.trim() !== commentId) fail('pending comment fixture insert did not return its stable id')
  return {
    id: commentId,
    articleId: article.id,
    url: `${state.runtime.frontendUrl}/article/${article.id}#comment-${commentId}`
  }
}

async function respond(request) {
  switch (request.operation) {
    case 'resetContractNamespace': {
      if (request.phase === 'prepare') {
        const state = await bootstrapDedicatedRuntime(request)
        return { runtime: state.runtime, ownership: { containers: state.containers } }
      }
      if (request.phase === 'cleanup') {
        const state = await readProviderStateOptional(request)
        return { cleanup: await cleanupOwnedRuntime(request, state) }
      }
      fail('resetContractNamespace phase is invalid')
      break
    }
    case 'createPublishedArticle':
      return { entity: await publishedArticle(request) }
    case 'createPendingComment':
      return { entity: await pendingComment(request) }
    case 'createUserSession':
      return { entity: await sessionEntity(request, 'user') }
    case 'createAdminSession':
      return { entity: await sessionEntity(request, 'admin') }
    default:
      fail('fixture provider operation is unsupported')
  }
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  try {
    const request = await readRequest()
    const payload = await respond(request)
    process.stdout.write(`${JSON.stringify({
      schema: responseSchema,
      operation: request.operation,
      status: 'ok',
      ...payload
    })}\n`)
  } catch (error) {
    process.stderr.write(`[browser-contract-provider] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
