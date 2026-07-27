import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { finalizeResidentLeaseCleanup } from './resident-resource-leases.mjs'
import { recordCheckpointResidentLeaseCleanup } from './scheduler.mjs'
import { discoverClassifyAndCleanupOrphanRuntimes } from './production-fresh-orphan-runtime-discovery.mjs'

function namespaceSlug(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return !normalized || normalized === '.' || normalized === '..' ? 'local' : normalized
}

const productionRunIdPattern = /^production-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-(\d+)$/u
const legacySchemaContainerPattern = /^fsus-schema-migration-[0-9a-f]{32}$/u
const labeledSchemaContainerPattern = /^fsus-pg-[a-z0-9-]+-(\d+)-[0-9a-f]+$/u
const schemaContainerKindLabel = 'com.fsusblog.test.kind'
const schemaContainerOwnerPidLabel = 'com.fsusblog.test.owner-pid'
const schemaContainerRunIdLabel = 'com.fsusblog.test.run-id'
const runtimeContainerRunIdLabel = 'io.fsusblog.test.run-id'
const runtimeContainerBundleIdLabel = 'io.fsusblog.test.bundle-id'
const runtimeContainerStepIdLabel = 'io.fsusblog.test.step-id'
const runtimeContainerNamespaceLabel = 'io.fsusblog.test.namespace'
const runtimeContainerPreparationIdLabel = 'io.fsusblog.test.preparation-id'
const runtimeProcessIdentitySchema = 'fsusblog.local-runtime-process-identity.v1'
const cleanupReceiptSchema = 'fsusblog.production-fresh.runtime-cleanup-receipt.v1'
const containerActions = new Set(['skipped-external-name', 'retained-external', 'blocked-active-owner', 'already-absent', 'blocked-ownership-mismatch', 'blocked-identity-incomplete', 'removed', 'remove-failed'])
const containerPostObservations = new Set(['not-observed', 'retained', 'name-absent', 'not-removed', 'name-and-id-absent', 'id-still-present', 'name-still-present', 'removal-unconfirmed'])
const processActions = new Set(['retained-external', 'blocked-active-owner', 'blocked', 'terminated', 'already-absent', 'termination-unconfirmed'])
const processPostObservations = new Set(['retained', 'not-observed', 'group-still-live', 'leader-and-group-absent', 'not-terminated', 'leader-or-group-still-live'])

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function freshRuntimeCleanupReceiptDigest(receipt) {
  const { contentDigest: _contentDigest, ...unsigned } = receipt ?? {}
  return `sha256:${createHash('sha256').update(canonicalJson(unsigned)).digest('hex')}`
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function processRunOwnerPid(runId) {
  const match = productionRunIdPattern.exec(String(runId ?? '').trim())
  return match ? positiveInteger(match[1]) : null
}

export function isOrphanProductionViteProcess(record, {
  root,
  processExists = (pid) => fs.existsSync(`/proc/${pid}`)
}) {
  const resolvedRoot = path.resolve(root)
  const frontend = path.join(resolvedRoot, 'src/frontend')
  const args = Array.isArray(record?.args) ? record.args : []
  const env = record?.env ?? {}
  const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '')
  const namespace = String(env.FSUSBLOG_TEST_NAMESPACE ?? '')
  const namespacePrefix = `${runId}-fresh-local-production-`
  const ownerPid = processRunOwnerPid(runId)
  if (!positiveInteger(record?.pid)
    || record.ppid !== 1
    || path.resolve(String(record.cwd ?? '')) !== frontend
    || !ownerPid
    || processExists(ownerPid)
    || !namespace.startsWith(namespacePrefix)
    || !/^\d+$/u.test(namespace.slice(namespacePrefix.length))) return false
  if (!['node', 'nodejs'].includes(path.basename(String(args[0] ?? '')))) return false
  if (path.resolve(String(args[1] ?? '')) !== path.join(frontend, 'node_modules/.bin/vite')) return false
  const preview = args[2] === 'preview'
  const optionStart = preview ? 3 : 2
  const options = args.slice(optionStart)
  const portIndex = options.indexOf('--port')
  const expectedPort = String(preview
    ? env.FSUSBLOG_RELEASE_PREVIEW_PORT ?? ''
    : env.FSUSBLOG_DEBUG_FRONTEND_PORT ?? '')
  return options.includes('--strictPort')
    && options.includes('--host')
    && options[options.indexOf('--host') + 1] === '0.0.0.0'
    && portIndex >= 0
    && /^\d+$/u.test(expectedPort)
    && options[portIndex + 1] === expectedPort
}

function schemaContainerShapeMatches(container) {
  const name = String(container?.Name ?? '').replace(/^\//u, '')
  const env = new Set(container?.Config?.Env ?? [])
  const bindings = container?.HostConfig?.PortBindings?.['5432/tcp']
  return container?.State?.Running === true
    && container?.HostConfig?.AutoRemove === true
    && /^postgres:\d+(?:\.\d+)?-alpine$/u.test(String(container?.Config?.Image ?? ''))
    && container?.Path === 'docker-entrypoint.sh'
    && Array.isArray(container?.Args)
    && container.Args.length === 1
    && container.Args[0] === 'postgres'
    && env.has('POSTGRES_USER=postgres')
    && env.has('POSTGRES_PASSWORD=postgres')
    && env.has('POSTGRES_DB=postgres')
    && (container?.HostConfig?.Binds === null || container?.HostConfig?.Binds?.length === 0)
    && Array.isArray(bindings)
    && bindings.length === 1
    && bindings[0]?.HostIp === '127.0.0.1'
    && String(bindings[0]?.HostPort ?? '') === ''
    && (legacySchemaContainerPattern.test(name) || labeledSchemaContainerPattern.test(name))
}

export function isStaleSchemaContainer(container, {
  nowMs,
  legacyMinimumAgeMs,
  processExists = (pid) => fs.existsSync(`/proc/${pid}`),
  activeBackendTesthost = false
}) {
  if (!schemaContainerShapeMatches(container)) return false
  const name = String(container.Name).replace(/^\//u, '')
  const labels = container?.Config?.Labels ?? {}
  const currentNameMatch = labeledSchemaContainerPattern.exec(name)
  if (currentNameMatch) {
    if (Object.keys(labels).length === 0) {
      const encodedOwnerPid = positiveInteger(currentNameMatch[1])
      return encodedOwnerPid !== null && !processExists(encodedOwnerPid)
    }
    const labeledOwnerPid = positiveInteger(labels[schemaContainerOwnerPidLabel])
    return labels[schemaContainerKindLabel] === 'schema-migration'
      && String(labels[schemaContainerRunIdLabel] ?? '').length > 0
      && labeledOwnerPid !== null
      && labeledOwnerPid === positiveInteger(currentNameMatch[1])
      && !processExists(labeledOwnerPid)
  }
  if (!legacySchemaContainerPattern.test(name)
    || Object.keys(labels).length > 0
    || activeBackendTesthost
    || !Number.isFinite(nowMs)
    || !Number.isFinite(legacyMinimumAgeMs)
    || legacyMinimumAgeMs <= 0) return false
  const createdMs = Date.parse(String(container.Created ?? ''))
  return Number.isFinite(createdMs) && nowMs - createdMs >= legacyMinimumAgeMs
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  const values = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u)
    if (match) values[match[1]] = match[2]
  }
  return values
}

function ownedContainerNames(namespace) {
  return new Set([
    `fsusblog-test-postgres-${namespace}`,
    `fsusblog-test-redis-${namespace}`
  ])
}

function defaultContainerExists(name) {
  const result = spawnSync('docker', ['inspect', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status === 0) return true
  const detail = String(result.stderr ?? result.stdout ?? '').trim()
  if (/no such (?:object|container)/iu.test(detail)) return false
  throw new Error(`unable to inspect Docker container ${name}: ${detail || `exit ${result.status ?? 'unknown'}`}`)
}

function defaultRemoveContainer(name) {
  const result = spawnSync('docker', ['rm', '--force', '--volumes', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stillExists = defaultContainerExists(name)
  return {
    removed: !stillExists,
    exitCode: result.status,
    reason: stillExists
      ? String(result.stderr ?? result.stdout ?? 'docker rm did not remove the container').trim()
      : null
  }
}

function expectedRoleForPidFile(pidFileName) {
  if (pidFileName === 'backend.pid') return 'backend'
  if (pidFileName === 'dev-server.pid') return 'debug-frontend'
  if (pidFileName === 'preview.pid') return 'release-preview'
  return null
}

function processIdentityFile(runtimeDirectory, pidFileName) {
  return path.join(runtimeDirectory, pidFileName.replace(/\.pid$/u, '.identity.json'))
}

function readRuntimeProcessIdentity(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return { identity: null, reason: 'identity-sidecar-not-regular' }
    if ((stat.mode & 0o777) !== 0o600) return { identity: null, reason: 'identity-sidecar-not-private' }
    const identity = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (identity?.schema !== runtimeProcessIdentitySchema
      || !positiveInteger(identity.pid)
      || !positiveInteger(identity.processGroupId)
      || !/^\d+$/u.test(String(identity.startTimeTicks ?? ''))
      || typeof identity.runId !== 'string'
      || typeof identity.namespace !== 'string'
      || typeof identity.role !== 'string'
      || typeof identity.preparationId !== 'string'
      || !identity.runId.trim()
      || !identity.namespace.trim()
      || !identity.role.trim()) {
      return { identity: null, reason: 'identity-sidecar-invalid' }
    }
    return { identity, reason: null }
  } catch (error) {
    if (error.code === 'ENOENT') return { identity: null, reason: 'identity-sidecar-missing' }
    return { identity: null, reason: 'identity-sidecar-unreadable' }
  }
}

function withinRepository(record, root) {
  if (!String(root ?? '').trim() || !String(record?.cwd ?? '').trim()) return false
  const resolvedRoot = path.resolve(root)
  const cwd = path.resolve(String(record?.cwd ?? ''))
  return cwd === resolvedRoot || cwd.startsWith(`${resolvedRoot}${path.sep}`)
}

function hasExactFixtureOwnership(record, fixtureRoot, namespace) {
  const expectedRoot = String(fixtureRoot ?? '').trim()
  const observedRoot = String(record?.env?.FSUSBLOG_FIXTURE_ROOT ?? '').trim()
  if (!expectedRoot || !observedRoot || !namespace) return false
  const resolvedExpectedRoot = path.resolve(expectedRoot)
  return path.basename(resolvedExpectedRoot) === namespace
    && path.resolve(observedRoot) === resolvedExpectedRoot
}

function commandMatchesRuntimeRole(record, role) {
  const command = (record?.args ?? []).join(' ')
  if (role === 'backend') return /(?:dotnet.+FsusBlog\.Server|FsusBlog\.Server)/u.test(command)
  if (role === 'debug-frontend' || role === 'release-preview') return /(?:^|\s|\/)vite(?:\s|$)/u.test(command)
  return false
}

export function dedicatedProcessIdentityMatches(identity, observed, {
  root,
  namespace,
  runId,
  role,
  preparationId,
  dedicatedRuntime = true,
  fixtureRoot = ''
}) {
  const expectedPreparationId = String(preparationId ?? '')
  const dedicatedEnvironmentMatches = dedicatedRuntime
    ? observed?.env?.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME === '1'
      && observed?.env?.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID === expectedPreparationId
    : observed?.env?.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME !== '1'
      && String(observed?.env?.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID ?? '') === expectedPreparationId
  return Boolean(root && namespace && runId && role && (!dedicatedRuntime || expectedPreparationId))
    && identity?.schema === runtimeProcessIdentitySchema
    && identity.pid === observed?.pid
    && identity.pid === identity.processGroupId
    && identity.processGroupId === observed?.processGroupId
    && String(identity.startTimeTicks) === String(observed?.startTimeTicks ?? '')
    && identity.runId === runId
    && identity.namespace === namespace
    && identity.role === role
    && identity.preparationId === expectedPreparationId
    && observed?.env?.FSUSBLOG_TEST_RUN_ID === runId
    && observed?.env?.FSUSBLOG_TEST_NAMESPACE === namespace
    && observed?.env?.FSUSBLOG_RUNTIME_ROLE === role
    && dedicatedEnvironmentMatches
    && (withinRepository(observed, root)
      || hasExactFixtureOwnership(observed, fixtureRoot, namespace))
    && commandMatchesRuntimeRole(observed, role)
}

export function dedicatedProcessGroupMembersMatch(identity, members, {
  root,
  dedicatedRuntime = true,
  fixtureRoot = ''
}) {
  if (!identity?.runId || !identity.namespace || !identity.role
    || (dedicatedRuntime && !identity.preparationId)
    || !root || !Array.isArray(members) || members.length === 0) return false
  return members.every((member) => member?.state !== 'Z'
    && positiveInteger(member?.pid) !== null
    && member.processGroupId === identity.processGroupId
    && member.env?.FSUSBLOG_TEST_RUN_ID === identity.runId
    && member.env?.FSUSBLOG_TEST_NAMESPACE === identity.namespace
    && member.env?.FSUSBLOG_RUNTIME_ROLE === identity.role
    && (dedicatedRuntime
      ? member.env?.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME === '1'
        && member.env?.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID === identity.preparationId
      : member.env?.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME !== '1'
        && String(member.env?.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID ?? '') === identity.preparationId)
    && (withinRepository(member, root)
      || hasExactFixtureOwnership(member, fixtureRoot, identity.namespace)))
}

function defaultProcessGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    return true
  }
}

function synchronousWaitUntil(predicate, timeoutMs) {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    Atomics.wait(waitBuffer, 0, 0, Math.min(25, Math.max(1, deadline - Date.now())))
  }
  return predicate()
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal)
    return true
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

export function terminateDedicatedProcessGroup(identity, {
  observeProcess = readProcProcess,
  processGroupExists = defaultProcessGroupExists,
  signalGroup = signalProcessGroup,
  listProcessGroupMembers = defaultListProcessGroupMembers,
  procRoot = '/proc',
  root = '',
  dedicatedRuntime = true,
  fixtureRoot = '',
  graceMs = 2_000
} = {}) {
  const initial = observeProcess(identity.pid)
  if (initial === null) return !processGroupExists(identity.processGroupId)
  if (!dedicatedProcessIdentityMatches(identity, initial, {
    root,
    namespace: identity.namespace,
    runId: identity.runId,
    role: identity.role,
    preparationId: identity.preparationId,
    dedicatedRuntime,
    fixtureRoot
  })
    || !processGroupExists(identity.processGroupId)) return false
  if (!signalGroup(identity.processGroupId, 'SIGTERM')) return false
  const exitedAfterTerm = synchronousWaitUntil(
    () => observeProcess(identity.pid) === null && !processGroupExists(identity.processGroupId),
    graceMs
  )
  if (exitedAfterTerm) return true

  const observed = observeProcess(identity.pid)
  if (observed !== null
    && (observed.startTimeTicks !== identity.startTimeTicks
      || observed.processGroupId !== identity.processGroupId)) return false
  let members
  try {
    members = listProcessGroupMembers(identity.processGroupId, { procRoot })
  } catch {
    return false
  }
  if (!dedicatedProcessGroupMembersMatch(identity, members, { root, dedicatedRuntime, fixtureRoot })) return false
  if (!signalGroup(identity.processGroupId, 'SIGKILL')) return false
  return synchronousWaitUntil(
    () => observeProcess(identity.pid) === null && !processGroupExists(identity.processGroupId),
    graceMs
  )
}

function parseProcStat(pid, stat) {
  const statTail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
  const startTimeTicks = statTail[19] ?? ''
  if (!/^\d+$/u.test(startTimeTicks)) return null
  return {
    pid,
    state: statTail[0] ?? '',
    ppid: positiveInteger(statTail[1]),
    processGroupId: positiveInteger(statTail[2]),
    sessionId: positiveInteger(statTail[3]),
    startTimeTicks
  }
}

function decodeProcEnvironment(raw) {
  return Object.fromEntries(raw
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=')
      return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)]
    }))
}

function readProcProcessAtRoot(pid, procRoot) {
  const processRoot = path.join(procRoot, String(pid))
  const parsed = parseProcStat(pid, fs.readFileSync(path.join(processRoot, 'stat'), 'utf8'))
  if (parsed === null) return null
  return {
    ...parsed,
    cwd: fs.realpathSync(path.join(processRoot, 'cwd')),
    args: fs.readFileSync(path.join(processRoot, 'cmdline'), 'utf8').split('\0').filter(Boolean),
    env: decodeProcEnvironment(fs.readFileSync(path.join(processRoot, 'environ'), 'utf8'))
  }
}

function readProcProcess(pid) {
  try {
    return readProcProcessAtRoot(pid, '/proc')
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null
    throw error
  }
}

function defaultListProcessGroupMembers(processGroupId, { procRoot = '/proc' } = {}) {
  let entries
  try {
    entries = fs.readdirSync(procRoot, { withFileTypes: true })
  } catch {
    return null
  }
  const members = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue
    const pid = Number.parseInt(entry.name, 10)
    let before
    try {
      before = parseProcStat(pid, fs.readFileSync(path.join(procRoot, entry.name, 'stat'), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      return null
    }
    if (before === null || before.processGroupId !== processGroupId || before.state === 'Z') continue
    let observed
    try {
      observed = readProcProcessAtRoot(pid, procRoot)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      return null
    }
    if (observed === null
      || observed.startTimeTicks !== before.startTimeTicks
      || observed.processGroupId !== processGroupId) return null
    if (observed.state !== 'Z') members.push(observed)
  }
  return members
}

function discoverOrphanProductionViteProcesses(root) {
  return fs.readdirSync('/proc', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => readProcProcess(Number.parseInt(entry.name, 10)))
    .filter((record) => record && isOrphanProductionViteProcess(record, { root }))
}

function sameProcessIdentity(expected) {
  const observed = readProcProcess(expected.pid)
  return observed !== null
    && observed.startTimeTicks === expected.startTimeTicks
    && observed.env.FSUSBLOG_TEST_RUN_ID === expected.env.FSUSBLOG_TEST_RUN_ID
    && observed.env.FSUSBLOG_TEST_NAMESPACE === expected.env.FSUSBLOG_TEST_NAMESPACE
    && observed.args.join('\0') === expected.args.join('\0')
}

function defaultKillOrphanProcess(record, terminationGraceMs) {
  if (!sameProcessIdentity(record)) return false
  try {
    process.kill(record.pid, 'SIGTERM')
  } catch (error) {
    return error.code === 'ESRCH'
  }
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + terminationGraceMs
  while (fs.existsSync(`/proc/${record.pid}`) && Date.now() < deadline) {
    Atomics.wait(waitBuffer, 0, 0, Math.min(25, Math.max(1, deadline - Date.now())))
  }
  if (!fs.existsSync(`/proc/${record.pid}`)) return true
  if (!sameProcessIdentity(record)) return false
  try {
    process.kill(record.pid, 'SIGKILL')
    return true
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function hasActiveBackendTesthost(root) {
  const resolvedRoot = fs.realpathSync(root)
  return fs.readdirSync('/proc', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .some((entry) => {
      const record = readProcProcess(Number.parseInt(entry.name, 10))
      return record !== null
        && (record.cwd === resolvedRoot || record.cwd.startsWith(`${resolvedRoot}${path.sep}`))
        && record.args.some((argument) => /(?:^|\/)testhost(?:\.dll)?$/u.test(argument))
    })
}

function defaultListSchemaContainers() {
  const result = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) throw new Error(`unable to inventory schema test containers: ${String(result.stderr ?? '').trim()}`)
  return String(result.stdout ?? '').split(/\r?\n/u).map((name) => name.trim()).filter((name) =>
    legacySchemaContainerPattern.test(name) || labeledSchemaContainerPattern.test(name))
}

function defaultInspectContainer(name) {
  const result = spawnSync('docker', ['inspect', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim()
    if (/no such (?:object|container)/iu.test(detail)) return null
    throw new Error(`unable to inspect Docker container ${name}: ${detail || `exit ${result.status ?? 'unknown'}`}`)
  }
  try {
    return JSON.parse(result.stdout)?.[0] ?? null
  } catch {
    return null
  }
}

export function dedicatedContainerOwnershipMatches(container, {
  runId,
  bundleId,
  stepId,
  namespace,
  preparationId
}) {
  return runtimeContainerOwnershipMatches(container, {
    runId,
    bundleId,
    stepId,
    namespace,
    preparationId,
    dedicatedRuntime: true
  })
}

function runtimeContainerOwnershipMatches(container, {
  runId,
  bundleId,
  stepId,
  namespace,
  preparationId,
  dedicatedRuntime
}) {
  const labels = container?.Config?.Labels ?? {}
  const expectedPreparationId = String(preparationId ?? '')
  const bundleMatches = bundleId
    ? labels[runtimeContainerBundleIdLabel] === bundleId
    : typeof labels[runtimeContainerBundleIdLabel] === 'string'
      && labels[runtimeContainerBundleIdLabel].length > 0
  const stepMatches = stepId
    ? labels[runtimeContainerStepIdLabel] === stepId
    : typeof labels[runtimeContainerStepIdLabel] === 'string'
      && labels[runtimeContainerStepIdLabel].length > 0
  return Boolean(runId && namespace && (!dedicatedRuntime || expectedPreparationId))
    && labels[runtimeContainerRunIdLabel] === runId
    && bundleMatches
    && stepMatches
    && labels[runtimeContainerNamespaceLabel] === namespace
    && String(labels[runtimeContainerPreparationIdLabel] ?? '') === expectedPreparationId
}

function containerRemovalSucceeded(outcome) {
  if (outcome === false) return false
  if (outcome && typeof outcome === 'object' && outcome.removed === false) return false
  return true
}

function removeWithinRoot(root, relative) {
  const target = path.resolve(root, relative)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`refusing to clean path outside repository root: ${relative}`)
  }
  fs.rmSync(target, { recursive: true, force: true })
}

export function cleanupLocalRuntime({
  root,
  namespace,
  trackedIdentity = null,
  removeContainer = defaultRemoveContainer,
  containerExists = null,
  inspectContainer = defaultInspectContainer,
  observeProcess = readProcProcess,
  processGroupExists = defaultProcessGroupExists,
  terminateDedicatedProcess = terminateDedicatedProcessGroup,
  dedicatedTerminationGraceMs = 2_000,
  observeResidentService,
  residentCleanupTimeoutMs = null
}) {
  const startedAt = new Date().toISOString()
  const resolvedRoot = path.resolve(root)
  const slug = namespaceSlug(namespace)
  const envRelative = path.join('.tmp', 'env', `${slug}.env`)
  const envFile = path.join(resolvedRoot, envRelative)
  const environment = readEnvFile(envFile)
  const dedicatedRuntime = environment.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME === '1'
  const runId = String(environment.FSUSBLOG_TEST_RUN_ID ?? trackedIdentity?.runId ?? '').trim()
  const bundleId = String(environment.FSUSBLOG_PHYSICAL_BUNDLE_ID ?? trackedIdentity?.bundleId ?? '').trim()
  const stepId = String(environment.FSUSBLOG_STEP_ID ?? trackedIdentity?.stepId ?? '').trim()
  const preparationId = String(environment.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID ?? '').trim()
  const fixtureRoot = String(environment.FSUSBLOG_FIXTURE_ROOT ?? '').trim()
  const owned = ownedContainerNames(slug)
  const configuredContainers = [
    environment.FSUSBLOG_POSTGRES_CONTAINER_NAME,
    environment.FSUSBLOG_REDIS_CONTAINER_NAME
  ].filter(Boolean)
  const containerCandidates = [...new Set([...configuredContainers, ...owned])]
  const removedContainers = []
  const skippedContainers = []
  const alreadyAbsentContainers = []
  const containerCleanupFailures = []
  const containerRecords = []
  const hasContainerObserver = typeof containerExists === 'function'
    || typeof inspectContainer === 'function'
  const containerIsPresent = typeof containerExists === 'function'
    ? containerExists
    : (identity) => inspectContainer(identity) !== null
  for (const container of containerCandidates) {
    if (!owned.has(container)) {
      skippedContainers.push(container)
      containerRecords.push({ name: container, id: null, ownershipLabels: null, action: 'skipped-external-name', postObservation: 'not-observed' })
      continue
    }
    const inspected = inspectContainer(container)
    if (inspected === null && !containerIsPresent(container)) {
      alreadyAbsentContainers.push(container)
      containerRecords.push({ name: container, id: null, ownershipLabels: null, action: 'already-absent', postObservation: 'name-absent' })
      continue
    }
    if (inspected === null) {
      skippedContainers.push(container)
      containerCleanupFailures.push({ container, reason: 'container-inspect-identity-unavailable' })
      containerRecords.push({ name: container, id: null, ownershipLabels: null, action: 'blocked-identity-incomplete', postObservation: 'not-removed' })
      continue
    }
    if (!runtimeContainerOwnershipMatches(inspected, {
      runId,
      bundleId,
      stepId,
      namespace: slug,
      preparationId,
      dedicatedRuntime
    })) {
      skippedContainers.push(container)
      containerCleanupFailures.push({ container, reason: 'ownership-label-mismatch' })
      containerRecords.push({ name: container, id: String(inspected?.Id ?? '') || null, ownershipLabels: inspected?.Config?.Labels ?? null, action: 'blocked-ownership-mismatch', postObservation: 'not-removed' })
      continue
    }
    const observedContainerId = String(inspected?.Id ?? '').trim()
    if (!/^[a-f0-9]{64}$/u.test(observedContainerId)) {
      skippedContainers.push(container)
      containerCleanupFailures.push({ container, reason: 'container-id-unavailable' })
      containerRecords.push({ name: container, id: observedContainerId || null, ownershipLabels: inspected?.Config?.Labels ?? null, action: 'blocked-identity-incomplete', postObservation: 'not-removed' })
      continue
    }
    const removalTarget = observedContainerId
    const outcome = removeContainer(removalTarget, { name: container, inspected })
    const nameStillPresent = hasContainerObserver && containerIsPresent(container)
    const idStillPresent = hasContainerObserver && containerIsPresent(removalTarget)
    const removed = containerRemovalSucceeded(outcome)
      && !nameStillPresent
      && !idStillPresent
    if (removed) {
      removedContainers.push(container)
      containerRecords.push({ name: container, id: removalTarget, ownershipLabels: inspected?.Config?.Labels ?? null, action: 'removed', postObservation: 'name-and-id-absent' })
    } else {
      skippedContainers.push(container)
      containerCleanupFailures.push({
        container,
        reason: outcome?.reason || (idStillPresent
          ? 'docker-rm-id-still-present'
          : nameStillPresent
            ? 'docker-rm-name-still-present'
            : 'docker-rm-reported-failure'),
        exitCode: outcome?.exitCode ?? null
      })
      containerRecords.push({ name: container, id: removalTarget, ownershipLabels: inspected?.Config?.Labels ?? null, action: 'remove-failed', postObservation: idStillPresent ? 'id-still-present' : nameStillPresent ? 'name-still-present' : 'removal-unconfirmed' })
    }
  }

  const runtimeRelative = path.join('.tmp', 'acceptance', slug)
  const runtimeDirectory = path.join(resolvedRoot, runtimeRelative)
  const terminatedPids = []
  const alreadyExitedPids = []
  const skippedProcesses = []
  const processRecords = []
  if (fs.existsSync(runtimeDirectory)) {
    for (const entry of fs.readdirSync(runtimeDirectory)) {
      if (!entry.endsWith('.pid')) continue
      const value = Number.parseInt(fs.readFileSync(path.join(runtimeDirectory, entry), 'utf8').trim(), 10)
      if (!Number.isInteger(value) || value <= 1) {
        skippedProcesses.push({ pidFile: entry, pid: null, reason: 'pid-file-invalid' })
        processRecords.push({ pid: null, processGroupId: null, startTimeTicks: null, role: expectedRoleForPidFile(entry), identityResult: 'pid-file-invalid', action: 'blocked', postObservation: 'not-observed' })
        continue
      }

      const role = expectedRoleForPidFile(entry)
      const sidecar = readRuntimeProcessIdentity(processIdentityFile(runtimeDirectory, entry))
      if (!role || sidecar.identity === null) {
        skippedProcesses.push({ pidFile: entry, pid: value, reason: role ? sidecar.reason : 'runtime-role-unknown' })
        processRecords.push({ pid: value, processGroupId: null, startTimeTicks: null, role, identityResult: role ? sidecar.reason : 'runtime-role-unknown', action: 'blocked', postObservation: 'not-observed' })
        continue
      }
      const identity = sidecar.identity
      if (identity.pid !== value) {
        skippedProcesses.push({ pidFile: entry, pid: value, reason: 'identity-pid-mismatch' })
        processRecords.push({ pid: value, processGroupId: identity.processGroupId, startTimeTicks: identity.startTimeTicks, role, identityResult: 'identity-pid-mismatch', action: 'blocked', postObservation: 'not-observed' })
        continue
      }
      const observed = observeProcess(value)
      if (observed === null) {
        if (processGroupExists(identity.processGroupId)) {
          skippedProcesses.push({ pidFile: entry, pid: value, reason: 'process-leader-exited-group-still-live' })
          processRecords.push({ pid: value, processGroupId: identity.processGroupId, startTimeTicks: identity.startTimeTicks, role, identityResult: 'leader-exited-group-still-live', action: 'blocked', postObservation: 'group-still-live' })
        } else {
          alreadyExitedPids.push(value)
          processRecords.push({ pid: value, processGroupId: identity.processGroupId, startTimeTicks: identity.startTimeTicks, role, identityResult: 'identity-valid', action: 'already-absent', postObservation: 'leader-and-group-absent' })
        }
        continue
      }
      if (!dedicatedProcessIdentityMatches(identity, observed, {
        root: resolvedRoot,
        namespace: slug,
        runId,
        role,
        preparationId,
        dedicatedRuntime,
        fixtureRoot
      })) {
        skippedProcesses.push({ pidFile: entry, pid: value, reason: 'proc-identity-mismatch' })
        processRecords.push({ pid: value, processGroupId: identity.processGroupId, startTimeTicks: identity.startTimeTicks, role, identityResult: 'proc-identity-mismatch', action: 'blocked', postObservation: 'not-terminated' })
        continue
      }
      const terminationReported = terminateDedicatedProcess(identity, {
        observeProcess,
        processGroupExists,
        root: resolvedRoot,
        dedicatedRuntime,
        fixtureRoot,
        graceMs: dedicatedTerminationGraceMs
      })
      if (terminationReported && observeProcess(value) === null && !processGroupExists(identity.processGroupId)) {
        terminatedPids.push(value)
        processRecords.push({ pid: value, processGroupId: identity.processGroupId, startTimeTicks: identity.startTimeTicks, role, identityResult: 'identity-valid', action: 'terminated', postObservation: 'leader-and-group-absent' })
      } else {
        skippedProcesses.push({ pidFile: entry, pid: value, reason: 'process-group-exit-unconfirmed' })
        processRecords.push({ pid: value, processGroupId: identity.processGroupId, startTimeTicks: identity.startTimeTicks, role, identityResult: 'identity-valid', action: 'termination-unconfirmed', postObservation: 'leader-or-group-still-live' })
      }
    }
  }

  const result = {
    startedAt,
    namespace: slug,
    dedicatedRuntime,
    removedContainers,
    alreadyAbsentContainers,
    skippedContainers,
    containerCleanupFailures,
    terminatedPids,
    alreadyExitedPids,
    skippedProcesses,
    containerRecords,
    processRecords
  }
  const schedulerRunId = String(environment.FSUSBLOG_TEST_RUN_ID ?? '').trim()
  const checkpointFile = schedulerRunId
    ? path.join(resolvedRoot, '.tmp', 'test-runs', schedulerRunId, 'checkpoint.json')
    : null
  if (checkpointFile && fs.existsSync(checkpointFile)) {
    const checkpoint = finalizeResidentLeaseCleanup({
      root: resolvedRoot,
      checkpointFile,
      cleanup: result,
      checkpointAuthority: (file, updateCheckpoint) =>
        recordCheckpointResidentLeaseCleanup(file, schedulerRunId, updateCheckpoint),
      ...(observeResidentService ? { observeService: observeResidentService } : {}),
      ...(residentCleanupTimeoutMs === null ? {} : { timeoutMs: residentCleanupTimeoutMs })
    })
    result.residentResourceLeases = {
      status: checkpoint.residentResourceLeases?.status ?? 'not-acquired',
      releasedAt: checkpoint.residentResourceLeases?.releasedAt ?? null,
      reservation: checkpoint.residentResourceLeases?.reservation ?? { cpuUnits: 0, memoryGiB: 0 }
    }
  }
  const cleanupIdentityIncomplete = containerCleanupFailures.length > 0
    || skippedProcesses.length > 0
    || skippedContainers.some((name) => !containerRecords.some((record) =>
      record.name === name && record.action === 'skipped-external-name'))
  result.retainedRuntimeState = cleanupIdentityIncomplete
    || result.residentResourceLeases?.status === 'cleanup-pending-live-services'
  result.cleanupStatus = result.retainedRuntimeState ? 'skipped' : 'complete'
  if (!result.retainedRuntimeState) {
    for (const relative of [
      runtimeRelative,
      path.join('.tmp', 'fixtures', slug),
      path.join('.tmp', 'data', slug),
      path.join('.tmp', 'run-once', slug),
      envRelative
    ]) {
      removeWithinRoot(resolvedRoot, relative)
    }
  }
  result.finishedAt = new Date().toISOString()
  return result
}

export function cleanupStaleLocalRuntimes({
  root,
  removeContainer = defaultRemoveContainer,
  containerExists = null,
  discoverUntracked = false,
  discoverOrphanProcesses = () => [],
  killOrphanProcess = defaultKillOrphanProcess,
  observeOrphanProcess = readProcProcess,
  orphanProcessGroupExists = defaultProcessGroupExists,
  listSchemaContainers = () => [],
  inspectContainer = defaultInspectContainer,
  legacyContainerMinimumAgeMs = null,
  orphanTerminationGraceMs = null,
  currentRunId = '',
  schedulerRunsRoot = null,
  sourceState = null,
  discoverOwnedOrphanRuntimes = discoverClassifyAndCleanupOrphanRuntimes,
  nowMs = Date.now(),
  detectActiveBackendTesthost = hasActiveBackendTesthost,
  cleanupRuntime = cleanupLocalRuntime
}) {
  const startedAt = new Date().toISOString()
  const resolvedRoot = path.resolve(root)
  const trackedNamespaces = new Map()
  const acceptanceRoot = path.join(resolvedRoot, '.tmp', 'acceptance')
  const envRoot = path.join(resolvedRoot, '.tmp', 'env')
  const runOnceRoot = path.join(resolvedRoot, '.tmp', 'run-once')
  const testRunsRoot = path.join(resolvedRoot, '.tmp', 'test-runs')
  const registerNamespace = (namespace, identity = null) => {
    if (namespaceSlug(namespace) !== namespace) return
    const previous = trackedNamespaces.get(namespace)
    const runId = String(identity?.runId ?? '').trim()
    if (previous?.runId && runId && previous.runId !== runId) {
      throw new Error(`tracked namespace ${namespace} has conflicting scheduler run identities`)
    }
    trackedNamespaces.set(namespace, {
      ...(previous ?? {}),
      ...(runId ? { runId } : {})
    })
  }

  if (fs.existsSync(acceptanceRoot)) {
    for (const entry of fs.readdirSync(acceptanceRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) registerNamespace(entry.name)
    }
  }
  if (fs.existsSync(envRoot)) {
    for (const entry of fs.readdirSync(envRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.env')) continue
      const namespace = entry.name.slice(0, -4)
      const environment = readEnvFile(path.join(envRoot, entry.name))
      registerNamespace(namespace, { runId: environment.FSUSBLOG_TEST_RUN_ID })
    }
  }
  if (fs.existsSync(runOnceRoot)) {
    for (const entry of fs.readdirSync(runOnceRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) registerNamespace(entry.name)
    }
  }
  if (fs.existsSync(testRunsRoot)) {
    for (const entry of fs.readdirSync(testRunsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const checkpointFile = path.join(testRunsRoot, entry.name, 'checkpoint.json')
      if (!fs.existsSync(checkpointFile)) continue
      let checkpoint
      try {
        checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
      } catch (error) {
        throw new Error(`tracked scheduler checkpoint is unreadable: ${checkpointFile}: ${error.message}`, { cause: error })
      }
      if (checkpoint?.schema !== 'fsusblog.test-matrix.checkpoint.v1'
        || checkpoint.runId !== entry.name
        || typeof checkpoint.targetTierId !== 'string'
        || !checkpoint.targetTierId) {
        throw new Error(`tracked scheduler checkpoint identity is invalid: ${checkpointFile}`)
      }
      const localProductionTarget = ['production', 'production-correctness', 'release-final']
        .includes(checkpoint.targetTierId)
      const namespace = String(checkpoint.runtimeNamespace ?? (
        localProductionTarget
          ? `${checkpoint.runId}-fresh-local-${checkpoint.targetTierId}-0`
          : ''
      )).trim()
      if (!namespace) continue
      if (namespaceSlug(namespace) !== namespace) {
        throw new Error(`tracked scheduler checkpoint namespace is invalid: ${checkpointFile}`)
      }
      registerNamespace(namespace, { runId: checkpoint.runId })
    }
  }

  const cleanups = [...trackedNamespaces].sort(([left], [right]) => left.localeCompare(right)).map(([namespace, trackedIdentity]) => cleanupRuntime({
    root: resolvedRoot,
    namespace,
    trackedIdentity,
    removeContainer,
    containerExists,
    inspectContainer
  }))
  const orphanProcesses = []
  const orphanAlreadyExitedPids = []
  const orphanSkippedProcesses = []
  const orphanProcessRecords = []
  const untrackedContainers = []
  const untrackedAlreadyAbsentContainers = []
  const untrackedSkippedContainers = []
  const untrackedContainerRecords = []
  if (discoverUntracked) {
    if (!Number.isFinite(orphanTerminationGraceMs) || orphanTerminationGraceMs <= 0) {
      throw new Error('untracked runtime cleanup requires a positive orphan termination grace')
    }
    if (!Number.isFinite(legacyContainerMinimumAgeMs) || legacyContainerMinimumAgeMs <= 0) {
      throw new Error('untracked runtime cleanup requires a positive legacy container minimum age')
    }
    const generalized = currentRunId && fs.existsSync(path.join(resolvedRoot, '.git'))
      ? discoverOwnedOrphanRuntimes({
          root: resolvedRoot,
          currentRunId,
          runsRoot: schedulerRunsRoot,
          sourceState,
          terminationGraceMs: orphanTerminationGraceMs
        })
      : { processRecords: [], containerRecords: [] }
    orphanProcessRecords.push(...generalized.processRecords)
    untrackedContainerRecords.push(...generalized.containerRecords)
    for (const record of generalized.processRecords) {
      if (record.action === 'terminated') orphanProcesses.push(record.pid)
      else if (record.action === 'already-absent') orphanAlreadyExitedPids.push(record.pid)
      else if (record.action !== 'retained-external') {
        orphanSkippedProcesses.push({
          pid: record.pid,
          reason: record.classificationReason ?? record.action
        })
      }
    }
    for (const record of generalized.containerRecords) {
      if (record.action === 'removed') untrackedContainers.push(record.name)
      else if (record.action === 'already-absent') untrackedAlreadyAbsentContainers.push(record.name)
      else if (record.action !== 'retained-external') untrackedSkippedContainers.push(record.name)
    }
    for (const record of discoverOrphanProcesses(resolvedRoot)) {
      const pid = positiveInteger(record?.pid)
      const processGroupId = positiveInteger(record?.processGroupId)
      const startTimeTicks = String(record?.startTimeTicks ?? '')
      const role = record?.args?.[2] === 'preview' ? 'release-preview' : 'debug-frontend'
      if (pid === null || processGroupId === null || !/^\d+$/u.test(startTimeTicks)) {
        orphanSkippedProcesses.push({ pid: pid ?? null, reason: 'orphan-process-identity-incomplete' })
        orphanProcessRecords.push({
          pid,
          processGroupId,
          startTimeTicks: startTimeTicks || null,
          role,
          identityResult: 'strict-orphan-identity-incomplete',
          action: 'blocked',
          postObservation: 'not-observed'
        })
        continue
      }
      const terminationReported = killOrphanProcess(record, orphanTerminationGraceMs)
      const leaderStillPresent = observeOrphanProcess(pid) !== null
      const groupStillPresent = orphanProcessGroupExists(processGroupId)
      if (!leaderStillPresent && !groupStillPresent) {
        if (terminationReported) {
          orphanProcesses.push(pid)
          orphanProcessRecords.push({
            pid,
            processGroupId,
            startTimeTicks,
            role,
            identityResult: 'strict-orphan-production-vite',
            action: 'terminated',
            postObservation: 'leader-and-group-absent'
          })
        } else {
          orphanAlreadyExitedPids.push(pid)
          orphanProcessRecords.push({
            pid,
            processGroupId,
            startTimeTicks,
            role,
            identityResult: 'strict-orphan-production-vite',
            action: 'already-absent',
            postObservation: 'leader-and-group-absent'
          })
        }
      } else {
        orphanSkippedProcesses.push({ pid, reason: 'orphan-process-group-exit-unconfirmed' })
        orphanProcessRecords.push({
          pid,
          processGroupId,
          startTimeTicks,
          role,
          identityResult: 'strict-orphan-production-vite',
          action: 'termination-unconfirmed',
          postObservation: groupStillPresent ? 'group-still-live' : 'leader-or-group-still-live'
        })
      }
    }
    const activeBackendTesthost = detectActiveBackendTesthost(resolvedRoot)
    for (const name of listSchemaContainers()) {
      const container = inspectContainer(name)
      if (!container || !isStaleSchemaContainer(container, {
        nowMs,
        legacyMinimumAgeMs: legacyContainerMinimumAgeMs,
        activeBackendTesthost
      })) continue
      const id = String(container.Id ?? '').trim()
      const ownershipLabels = container?.Config?.Labels ?? {}
      if (!/^[a-f0-9]{64}$/u.test(id)) {
        untrackedSkippedContainers.push(name)
        untrackedContainerRecords.push({
          name,
          id: id || null,
          ownershipLabels,
          action: 'blocked-identity-incomplete',
          postObservation: 'not-removed'
        })
        continue
      }
      const outcome = removeContainer(id, { name, inspected: container })
      const nameStillPresent = inspectContainer(name) !== null
      const idStillPresent = inspectContainer(id) !== null
      if (!nameStillPresent && !idStillPresent) {
        if (containerRemovalSucceeded(outcome)) {
          untrackedContainers.push(name)
          untrackedContainerRecords.push({
            name,
            id,
            ownershipLabels,
            action: 'removed',
            postObservation: 'name-and-id-absent'
          })
        } else {
          untrackedAlreadyAbsentContainers.push(name)
          untrackedContainerRecords.push({
            name,
            id,
            ownershipLabels,
            action: 'already-absent',
            postObservation: 'name-and-id-absent'
          })
        }
      } else {
        untrackedSkippedContainers.push(name)
        untrackedContainerRecords.push({
          name,
          id,
          ownershipLabels,
          action: 'remove-failed',
          postObservation: idStillPresent ? 'id-still-present' : 'name-still-present'
        })
      }
    }
  }
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    cleanups,
    namespaces: cleanups.map((cleanup) => cleanup.namespace),
    removedContainers: [...cleanups.flatMap((cleanup) => cleanup.removedContainers), ...untrackedContainers],
    skippedContainers: [...cleanups.flatMap((cleanup) => cleanup.skippedContainers), ...untrackedSkippedContainers],
    terminatedPids: [...cleanups.flatMap((cleanup) => cleanup.terminatedPids), ...orphanProcesses],
    skippedProcesses: [...cleanups.flatMap((cleanup) => cleanup.skippedProcesses), ...orphanSkippedProcesses],
    orphanProcesses,
    orphanAlreadyExitedPids,
    orphanProcessRecords,
    untrackedContainers,
    untrackedAlreadyAbsentContainers,
    untrackedContainerRecords
  }
}

function runtimeCleanupOperationFailure(error, stage) {
  return {
    stage: String(stage || 'runtime-cleanup'),
    message: error instanceof Error ? error.message : String(error)
  }
}

export function appendFreshRuntimeCleanupFailure(cleanup, error, stage = 'runtime-cleanup') {
  const startedAt = cleanup?.startedAt ?? new Date().toISOString()
  return {
    ...(cleanup ?? {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    namespaces: cleanup?.namespaces ?? [],
    cleanups: cleanup?.cleanups ?? [],
    operationFailures: [
      ...(cleanup?.operationFailures ?? []),
      runtimeCleanupOperationFailure(error, stage)
    ]
  }
}

export function captureFreshRuntimeCleanup(operation, { stage = 'runtime-cleanup' } = {}) {
  const startedAt = new Date().toISOString()
  try {
    const cleanup = operation()
    if (!cleanup || typeof cleanup.then === 'function') {
      throw new Error('runtime cleanup operation must return a synchronous cleanup record')
    }
    return {
      ...cleanup,
      startedAt: cleanup.startedAt ?? startedAt,
      finishedAt: cleanup.finishedAt ?? new Date().toISOString(),
      operationFailures: cleanup.operationFailures ?? []
    }
  } catch (error) {
    return appendFreshRuntimeCleanupFailure({
      startedAt,
      finishedAt: new Date().toISOString(),
      namespaces: [],
      cleanups: []
    }, error, stage)
  }
}

export function verifyFreshRuntimeCleanup(cleanup) {
  const failures = []
  if (cleanup.sourceStateMatchesPreflight === false) failures.push('postflight source state differs from preflight')
  for (const failure of cleanup.operationFailures ?? []) {
    failures.push(`${failure.stage}: ${failure.message}`)
  }
  const verifyResourceRecords = (record) => {
    for (const container of record.containerRecords ?? []) {
      if (!container.name || !container.action || !container.postObservation) failures.push(`${record.namespace}: container receipt is incomplete`)
      if (['remove-failed', 'blocked-active-owner', 'blocked-ownership-mismatch', 'blocked-identity-incomplete'].includes(container.action)
        || /still-present|not-removed/u.test(container.postObservation)) failures.push(`${record.namespace}: container post-observation blocks Fresh`)
      if (container.action === 'removed' && container.postObservation !== 'name-and-id-absent') {
        failures.push(`${record.namespace}: removed container name and ID absence is unconfirmed`)
      }
      if (container.action === 'already-absent'
        && !['name-absent', 'name-and-id-absent'].includes(container.postObservation)) {
        failures.push(`${record.namespace}: already-absent container observation is invalid`)
      }
    }
    for (const process of record.processRecords ?? []) {
      if (!process.action || !process.postObservation || !process.identityResult) failures.push(`${record.namespace}: process receipt is incomplete`)
      if (['blocked', 'blocked-active-owner', 'termination-unconfirmed'].includes(process.action)
        || /still-live|not-observed|not-terminated/u.test(process.postObservation)) failures.push(`${record.namespace}: process post-observation blocks Fresh`)
      if (['terminated', 'already-absent'].includes(process.action)
        && process.postObservation !== 'leader-and-group-absent') {
        failures.push(`${record.namespace}: process leader and group absence is unconfirmed`)
      }
    }
  }
  for (const record of cleanup.cleanups ?? [cleanup]) {
    verifyResourceRecords(record)
    if ((record.containerCleanupFailures?.length ?? 0) > 0) failures.push(`${record.namespace}: container cleanup failure`)
    if ((record.skippedContainers ?? []).some((name) => !record.containerRecords?.some((container) =>
      container.name === name && container.action === 'skipped-external-name'))) {
      failures.push(`${record.namespace}: owned container skipped`)
    }
    if ((record.skippedProcesses?.length ?? 0) > 0) failures.push(`${record.namespace}: tracked process skipped`)
    if (record.retainedRuntimeState === true) failures.push(`${record.namespace}: runtime state retained`)
    if (record.cleanupStatus !== 'complete') failures.push(`${record.namespace}: cleanup status is not complete`)
    if (record.residentResourceLeases?.status === 'cleanup-pending-live-services') failures.push(`${record.namespace}: resident lease remains cleanup-pending`)
  }
  verifyResourceRecords({
    namespace: 'untracked-owned-runtime',
    containerRecords: cleanup.untrackedContainerRecords ?? [],
    processRecords: cleanup.orphanProcessRecords ?? []
  })
  return { status: failures.length === 0 ? 'complete' : 'blocked', failures }
}

export function verifyFreshRuntimeCleanupReceipt(receipt) {
  if (!receipt || receipt.schema !== cleanupReceiptSchema) throw new Error('runtime cleanup receipt schema is invalid')
  if (typeof receipt.runId !== 'string' || !receipt.runId.trim()) throw new Error('runtime cleanup receipt runId is required')
  if (typeof receipt.invocationId !== 'string' || !receipt.invocationId.trim()) throw new Error('runtime cleanup receipt invocationId is required')
  if (!/^[a-f0-9]{32}$/u.test(String(receipt.attemptId ?? ''))) throw new Error('runtime cleanup receipt attemptId is invalid')
  if (!['preflight', 'postflight'].includes(receipt.phase)) throw new Error('runtime cleanup receipt phase is invalid')
  if (!/^[a-f0-9]{40}$/u.test(String(receipt.source?.commit ?? ''))
    || !/^[a-f0-9]{64}$/u.test(String(receipt.source?.worktreeFingerprint ?? ''))
    || Object.keys(receipt.source ?? {}).toSorted().join(',') !== 'commit,worktreeFingerprint') {
    throw new Error('runtime cleanup receipt source state is invalid')
  }
  const startedMs = Date.parse(String(receipt.startedAt ?? ''))
  const finishedMs = Date.parse(String(receipt.finishedAt ?? ''))
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || finishedMs < startedMs
    || new Date(startedMs).toISOString() !== receipt.startedAt
    || new Date(finishedMs).toISOString() !== receipt.finishedAt) {
    throw new Error('runtime cleanup receipt timestamps are invalid')
  }
  if (!Array.isArray(receipt.discoveredNamespaces)
    || receipt.discoveredNamespaces.some((value) => typeof value !== 'string' || !value)
    || new Set(receipt.discoveredNamespaces).size !== receipt.discoveredNamespaces.length
    || receipt.discoveredNamespaces.join('\0') !== receipt.discoveredNamespaces.toSorted().join('\0')) {
    throw new Error('runtime cleanup receipt discovered namespaces must be sorted and unique')
  }
  if (!Array.isArray(receipt.cleanups)
    || !Array.isArray(receipt.untrackedContainerRecords)
    || !Array.isArray(receipt.orphanProcessRecords)
    || !Array.isArray(receipt.operationFailures)
    || !Array.isArray(receipt.residentLeaseStatus)
    || receipt.residentLeaseStatus.length !== receipt.cleanups.length
    || !Array.isArray(receipt.removed) || !Array.isArray(receipt.alreadyAbsent)
    || !Array.isArray(receipt.skipped) || !Array.isArray(receipt.failures)
    || typeof receipt.sourceStateMatchesPreflight !== 'boolean') {
    throw new Error('runtime cleanup receipt cleanup and resident lease records are invalid')
  }
  for (const failure of receipt.operationFailures) {
    if (typeof failure?.stage !== 'string' || !failure.stage
      || typeof failure?.message !== 'string' || !failure.message) {
      throw new Error('runtime cleanup receipt operation failure is invalid')
    }
  }
  const cleanupNamespaces = receipt.cleanups.map((cleanup) => cleanup.namespace)
  if (cleanupNamespaces.join('\0') !== receipt.discoveredNamespaces.join('\0')) {
    throw new Error('runtime cleanup receipt discovered namespaces do not match cleanup records')
  }
  for (const lease of receipt.residentLeaseStatus) {
    if (typeof lease?.namespace !== 'string' || !lease.namespace || typeof lease?.status !== 'string' || !lease.status) {
      throw new Error('runtime cleanup receipt resident lease record is invalid')
    }
  }
  if (receipt.residentLeaseStatus.map((lease) => lease.namespace).join('\0') !== cleanupNamespaces.join('\0')) {
    throw new Error('runtime cleanup receipt resident lease namespaces do not match cleanup records')
  }
  const validateResourceRecords = (cleanup) => {
    if (typeof cleanup.namespace !== 'string' || !cleanup.namespace
      || !Array.isArray(cleanup.containerRecords) || !Array.isArray(cleanup.processRecords)) {
      throw new Error('runtime cleanup receipt per-namespace record is invalid')
    }
    for (const container of cleanup.containerRecords) {
      if (typeof container.name !== 'string' || !container.name
        || !(container.id === null || /^[a-f0-9]{64}$/u.test(container.id))
        || !(container.ownershipLabels === null || (container.ownershipLabels && typeof container.ownershipLabels === 'object' && !Array.isArray(container.ownershipLabels)))
        || (container.ownershipLabels !== null && Object.values(container.ownershipLabels).some((value) => typeof value !== 'string'))
        || !containerActions.has(container.action)
        || !containerPostObservations.has(container.postObservation)) {
        throw new Error('runtime cleanup receipt container identity is invalid')
      }
    }
    for (const process of cleanup.processRecords) {
      if (!(process.pid === null || (Number.isInteger(process.pid) && process.pid > 1))
        || !(process.processGroupId === null || (Number.isInteger(process.processGroupId) && process.processGroupId > 1))
        || !(process.startTimeTicks === null || /^\d+$/u.test(process.startTimeTicks))
        || !(process.role === null || [
          'backend',
          'debug-frontend',
          'release-preview',
          'public-aot-worker',
          'production-descendant'
        ].includes(process.role))
        || typeof process.identityResult !== 'string' || !process.identityResult
        || !processActions.has(process.action)
        || !processPostObservations.has(process.postObservation)) {
        throw new Error('runtime cleanup receipt process identity is invalid')
      }
    }
  }
  for (const cleanup of receipt.cleanups) {
    if (!['complete', 'skipped'].includes(cleanup.cleanupStatus)
      || typeof cleanup.retainedRuntimeState !== 'boolean'
      || !Array.isArray(cleanup.containerCleanupFailures)
      || !Array.isArray(cleanup.skippedContainers)
      || !Array.isArray(cleanup.skippedProcesses)) {
      throw new Error('runtime cleanup receipt cleanup outcome is invalid')
    }
    validateResourceRecords(cleanup)
  }
  validateResourceRecords({
    namespace: 'untracked-owned-runtime',
    containerRecords: receipt.untrackedContainerRecords,
    processRecords: receipt.orphanProcessRecords
  })
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(receipt.contentDigest ?? ''))
    || receipt.contentDigest !== freshRuntimeCleanupReceiptDigest(receipt)) {
    throw new Error('runtime cleanup receipt digest does not match its content')
  }
  const verification = verifyFreshRuntimeCleanup({
    cleanups: receipt.cleanups,
    untrackedContainerRecords: receipt.untrackedContainerRecords,
    orphanProcessRecords: receipt.orphanProcessRecords,
    operationFailures: receipt.operationFailures,
    sourceStateMatchesPreflight: receipt.sourceStateMatchesPreflight
  })
  if (receipt.status !== verification.status
    || JSON.stringify(receipt.failures) !== JSON.stringify(verification.failures)) {
    throw new Error('runtime cleanup receipt status does not match independent verification')
  }
  const allContainerRecords = [
    ...receipt.cleanups.flatMap((item) => item.containerRecords),
    ...receipt.untrackedContainerRecords
  ]
  const allProcessRecords = [
    ...receipt.cleanups.flatMap((item) => item.processRecords),
    ...receipt.orphanProcessRecords
  ]
  const expectedRemoved = [
    ...allContainerRecords.filter((item) => item.action === 'removed').map((item) => item.name),
    ...allProcessRecords.filter((item) => item.action === 'terminated').map((item) => item.pid)
  ]
  const expectedAlreadyAbsent = [
    ...allContainerRecords.filter((item) => item.action === 'already-absent').map((item) => item.name),
    ...allProcessRecords.filter((item) => item.action === 'already-absent').map((item) => item.pid)
  ]
  const expectedSkipped = [
    ...allContainerRecords.filter((item) => !['removed', 'already-absent'].includes(item.action)).map((item) => item.name),
    ...allProcessRecords.filter((item) => !['terminated', 'already-absent'].includes(item.action)).map((item) => item.pid)
  ]
  if (JSON.stringify(receipt.removed) !== JSON.stringify(expectedRemoved)
    || JSON.stringify(receipt.alreadyAbsent) !== JSON.stringify(expectedAlreadyAbsent)
    || JSON.stringify(receipt.skipped) !== JSON.stringify(expectedSkipped)) {
    throw new Error('runtime cleanup receipt action summaries do not match per-resource records')
  }
  return verification
}

export function assertFreshRuntimeCleanupReceipt(receipt) {
  const verification = verifyFreshRuntimeCleanupReceipt(receipt)
  if (verification.status !== 'complete') {
    throw new Error(`Production Fresh runtime cleanup blocked: ${verification.failures.join('; ')}`)
  }
  return verification
}

export function writeFreshRuntimeCleanupReceipt({
  root,
  phase,
  runId,
  invocationId,
  source,
  cleanup,
  directory = null,
  attemptId = randomBytes(16).toString('hex')
}) {
  if (!cleanup.startedAt || !cleanup.finishedAt) throw new Error('runtime cleanup did not record real start and finish timestamps')
  const startedAt = cleanup.startedAt
  const verification = verifyFreshRuntimeCleanup(cleanup)
  const cleanups = cleanup.cleanups ?? [cleanup]
  const untrackedContainerRecords = cleanup.untrackedContainerRecords ?? []
  const orphanProcessRecords = cleanup.orphanProcessRecords ?? []
  const allContainerRecords = [
    ...cleanups.flatMap((item) => item.containerRecords ?? []),
    ...untrackedContainerRecords
  ]
  const allProcessRecords = [
    ...cleanups.flatMap((item) => item.processRecords ?? []),
    ...orphanProcessRecords
  ]
  const receipt = {
    schema: cleanupReceiptSchema,
    runId,
    invocationId,
    attemptId,
    source,
    sourceStateMatchesPreflight: cleanup.sourceStateMatchesPreflight ?? true,
    phase,
    startedAt,
    finishedAt: cleanup.finishedAt,
    discoveredNamespaces: cleanup.namespaces ?? [],
    cleanups,
    untrackedContainerRecords,
    orphanProcessRecords,
    operationFailures: cleanup.operationFailures ?? [],
    removed: [
      ...allContainerRecords.filter((item) => item.action === 'removed').map((item) => item.name),
      ...allProcessRecords.filter((item) => item.action === 'terminated').map((item) => item.pid)
    ],
    alreadyAbsent: [
      ...allContainerRecords.filter((item) => item.action === 'already-absent').map((item) => item.name),
      ...allProcessRecords.filter((item) => item.action === 'already-absent').map((item) => item.pid)
    ],
    skipped: [
      ...allContainerRecords.filter((item) => !['removed', 'already-absent'].includes(item.action)).map((item) => item.name),
      ...allProcessRecords.filter((item) => !['terminated', 'already-absent'].includes(item.action)).map((item) => item.pid)
    ],
    failures: verification.failures,
    residentLeaseStatus: cleanups.map((item) => ({ namespace: item.namespace, status: item.residentResourceLeases?.status ?? 'not-acquired' })),
    status: verification.status
  }
  receipt.contentDigest = freshRuntimeCleanupReceiptDigest(receipt)
  verifyFreshRuntimeCleanupReceipt(receipt)
  const receiptDirectory = directory ?? path.join(root, '.tmp', 'release-evidence', 'runtime-cleanup')
  fs.mkdirSync(receiptDirectory, { recursive: true })
  const invocationFileId = createHash('sha256').update(String(invocationId)).digest('hex').slice(0, 16)
  const file = path.join(receiptDirectory, `${namespaceSlug(runId)}-${invocationFileId}-${phase}-${attemptId}.json`)
  const pending = `${file}.pending-${process.pid}-${randomBytes(8).toString('hex')}`
  fs.writeFileSync(pending, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    fs.linkSync(pending, file)
  } finally {
    fs.rmSync(pending, { force: true })
  }
  return { file, receipt, verification }
}
