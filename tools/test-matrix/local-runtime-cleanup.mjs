import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { finalizeResidentLeaseCleanup } from './resident-resource-leases.mjs'

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
  return spawnSync('docker', ['inspect', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).status === 0
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
      || !identity.role.trim()
      || !identity.preparationId.trim()) {
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
  fixtureRoot = ''
}) {
  return Boolean(root && namespace && runId && role && preparationId)
    && identity?.schema === runtimeProcessIdentitySchema
    && identity.pid === observed?.pid
    && identity.pid === identity.processGroupId
    && identity.processGroupId === observed?.processGroupId
    && String(identity.startTimeTicks) === String(observed?.startTimeTicks ?? '')
    && identity.runId === runId
    && identity.namespace === namespace
    && identity.role === role
    && identity.preparationId === preparationId
    && observed?.env?.FSUSBLOG_TEST_RUN_ID === runId
    && observed?.env?.FSUSBLOG_TEST_NAMESPACE === namespace
    && observed?.env?.FSUSBLOG_RUNTIME_ROLE === role
    && observed?.env?.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME === '1'
    && observed?.env?.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID === preparationId
    && (withinRepository(observed, root)
      || hasExactFixtureOwnership(observed, fixtureRoot, namespace))
    && commandMatchesRuntimeRole(observed, role)
}

export function dedicatedProcessGroupMembersMatch(identity, members, {
  root,
  fixtureRoot = ''
}) {
  if (!identity?.runId || !identity.namespace || !identity.role || !identity.preparationId
    || !root || !Array.isArray(members) || members.length === 0) return false
  return members.every((member) => member?.state !== 'Z'
    && positiveInteger(member?.pid) !== null
    && member.processGroupId === identity.processGroupId
    && member.env?.FSUSBLOG_TEST_RUN_ID === identity.runId
    && member.env?.FSUSBLOG_TEST_NAMESPACE === identity.namespace
    && member.env?.FSUSBLOG_RUNTIME_ROLE === identity.role
    && member.env?.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME === '1'
    && member.env?.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID === identity.preparationId
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
  if (!dedicatedProcessGroupMembersMatch(identity, members, { root, fixtureRoot })) return false
  if (!signalGroup(identity.processGroupId, 'SIGKILL')) return false
  return synchronousWaitUntil(
    () => observeProcess(identity.pid) === null && !processGroupExists(identity.processGroupId),
    graceMs
  )
}

function defaultKillProcess(pid, root, pidFileName) {
  if (process.platform !== 'win32') {
    try {
      const resolvedRoot = fs.realpathSync(root)
      const cwd = fs.realpathSync(`/proc/${pid}/cwd`)
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
      const withinRoot = cwd === resolvedRoot || cwd.startsWith(`${resolvedRoot}${path.sep}`)
      const expectedCommand = pidFileName === 'backend.pid'
        ? /(?:dotnet.+FsusBlog\.Server|FsusBlog\.Server)/u.test(command)
        : /(?:^|\s|\/)vite(?:\s|$)/u.test(command)
      if (!withinRoot || !expectedCommand) return false
    } catch {
      return false
    }
  }
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGTERM')
    } else {
      process.kill(pid, 'SIGTERM')
    }
    return true
  } catch (error) {
    if (process.platform !== 'win32' && error.code === 'ESRCH') {
      try {
        process.kill(pid, 'SIGTERM')
        return true
      } catch {}
    }
    return false
  }
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
  if (result.status !== 0) return null
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
  const labels = container?.Config?.Labels ?? {}
  return Boolean(runId && bundleId && stepId && namespace && preparationId)
    && labels[runtimeContainerRunIdLabel] === runId
    && labels[runtimeContainerBundleIdLabel] === bundleId
    && labels[runtimeContainerStepIdLabel] === stepId
    && labels[runtimeContainerNamespaceLabel] === namespace
    && labels[runtimeContainerPreparationIdLabel] === preparationId
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
  removeContainer = defaultRemoveContainer,
  killProcess = defaultKillProcess,
  containerExists = null,
  inspectContainer = defaultInspectContainer,
  observeProcess = readProcProcess,
  processGroupExists = defaultProcessGroupExists,
  terminateDedicatedProcess = terminateDedicatedProcessGroup,
  dedicatedTerminationGraceMs = 2_000,
  observeResidentService,
  residentCleanupTimeoutMs = null
}) {
  const resolvedRoot = path.resolve(root)
  const slug = namespaceSlug(namespace)
  const envRelative = path.join('.tmp', 'env', `${slug}.env`)
  const envFile = path.join(resolvedRoot, envRelative)
  const environment = readEnvFile(envFile)
  const dedicatedRuntime = environment.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME === '1'
  const runId = String(environment.FSUSBLOG_TEST_RUN_ID ?? '').trim()
  const bundleId = String(environment.FSUSBLOG_PHYSICAL_BUNDLE_ID ?? '').trim()
  const stepId = String(environment.FSUSBLOG_STEP_ID ?? '').trim()
  const preparationId = String(environment.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID ?? '').trim()
  const fixtureRoot = String(environment.FSUSBLOG_FIXTURE_ROOT ?? '').trim()
  const owned = ownedContainerNames(slug)
  const configuredContainers = [
    environment.FSUSBLOG_POSTGRES_CONTAINER_NAME,
    environment.FSUSBLOG_REDIS_CONTAINER_NAME
  ].filter(Boolean)
  const removedContainers = []
  const skippedContainers = []
  const alreadyAbsentContainers = []
  const containerCleanupFailures = []
  const hasContainerObserver = dedicatedRuntime
    || typeof containerExists === 'function'
    || removeContainer === defaultRemoveContainer
  const containerIsPresent = typeof containerExists === 'function'
    ? containerExists
    : removeContainer === defaultRemoveContainer || dedicatedRuntime
      ? defaultContainerExists
      : () => true
  for (const container of configuredContainers) {
    if (!owned.has(container)) {
      skippedContainers.push(container)
      continue
    }
    if (!containerIsPresent(container)) {
      alreadyAbsentContainers.push(container)
      continue
    }
    let inspected = null
    let removalTarget = container
    if (dedicatedRuntime) {
      inspected = inspectContainer(container)
      if (!dedicatedContainerOwnershipMatches(inspected, {
        runId,
        bundleId,
        stepId,
        namespace: slug,
        preparationId
      })) {
        skippedContainers.push(container)
        containerCleanupFailures.push({ container, reason: 'ownership-label-mismatch' })
        continue
      }
      const observedContainerId = String(inspected?.Id ?? '').trim()
      if (!/^[a-f0-9]{64}$/u.test(observedContainerId)) {
        skippedContainers.push(container)
        containerCleanupFailures.push({ container, reason: 'container-id-unavailable' })
        continue
      }
      removalTarget = observedContainerId
    }
    const outcome = removeContainer(removalTarget, { name: container, inspected })
    const nameStillPresent = hasContainerObserver && containerIsPresent(container)
    const idStillPresent = dedicatedRuntime && containerIsPresent(removalTarget)
    const removed = containerRemovalSucceeded(outcome)
      && !nameStillPresent
      && !idStillPresent
    if (removed) {
      removedContainers.push(container)
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
    }
  }

  const runtimeRelative = path.join('.tmp', 'acceptance', slug)
  const runtimeDirectory = path.join(resolvedRoot, runtimeRelative)
  const terminatedPids = []
  const alreadyExitedPids = []
  const skippedProcesses = []
  if (fs.existsSync(runtimeDirectory)) {
    for (const entry of fs.readdirSync(runtimeDirectory)) {
      if (!entry.endsWith('.pid')) continue
      const value = Number.parseInt(fs.readFileSync(path.join(runtimeDirectory, entry), 'utf8').trim(), 10)
      if (!Number.isInteger(value) || value <= 1) {
        if (dedicatedRuntime) skippedProcesses.push({ pidFile: entry, pid: null, reason: 'pid-file-invalid' })
        continue
      }
      if (!dedicatedRuntime) {
        if (killProcess(value, resolvedRoot, entry)) terminatedPids.push(value)
        continue
      }

      const role = expectedRoleForPidFile(entry)
      const sidecar = readRuntimeProcessIdentity(processIdentityFile(runtimeDirectory, entry))
      if (!role || sidecar.identity === null) {
        skippedProcesses.push({ pidFile: entry, pid: value, reason: role ? sidecar.reason : 'runtime-role-unknown' })
        continue
      }
      const identity = sidecar.identity
      if (identity.pid !== value) {
        skippedProcesses.push({ pidFile: entry, pid: value, reason: 'identity-pid-mismatch' })
        continue
      }
      const observed = observeProcess(value)
      if (observed === null) {
        if (processGroupExists(identity.processGroupId)) {
          skippedProcesses.push({ pidFile: entry, pid: value, reason: 'process-leader-exited-group-still-live' })
        } else {
          alreadyExitedPids.push(value)
        }
        continue
      }
      if (!dedicatedProcessIdentityMatches(identity, observed, {
        root: resolvedRoot,
        namespace: slug,
        runId,
        role,
        preparationId,
        fixtureRoot
      })) {
        skippedProcesses.push({ pidFile: entry, pid: value, reason: 'proc-identity-mismatch' })
        continue
      }
      const terminationReported = terminateDedicatedProcess(identity, {
        observeProcess,
        processGroupExists,
        root: resolvedRoot,
        fixtureRoot,
        graceMs: dedicatedTerminationGraceMs
      })
      if (terminationReported && observeProcess(value) === null && !processGroupExists(identity.processGroupId)) {
        terminatedPids.push(value)
      } else {
        skippedProcesses.push({ pidFile: entry, pid: value, reason: 'process-group-exit-unconfirmed' })
      }
    }
  }

  const result = {
    namespace: slug,
    dedicatedRuntime,
    removedContainers,
    alreadyAbsentContainers,
    skippedContainers,
    containerCleanupFailures,
    terminatedPids,
    alreadyExitedPids,
    skippedProcesses
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
    || (dedicatedRuntime && (skippedContainers.length > 0 || skippedProcesses.length > 0))
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
  return result
}

export function cleanupStaleLocalRuntimes({
  root,
  removeContainer = defaultRemoveContainer,
  killProcess = defaultKillProcess,
  discoverUntracked = false,
  discoverOrphanProcesses = discoverOrphanProductionViteProcesses,
  killOrphanProcess = defaultKillOrphanProcess,
  listSchemaContainers = defaultListSchemaContainers,
  inspectContainer = defaultInspectContainer,
  legacyContainerMinimumAgeMs = null,
  orphanTerminationGraceMs = null,
  nowMs = Date.now(),
  detectActiveBackendTesthost = hasActiveBackendTesthost
}) {
  const resolvedRoot = path.resolve(root)
  const namespaces = new Set()
  const acceptanceRoot = path.join(resolvedRoot, '.tmp', 'acceptance')
  const envRoot = path.join(resolvedRoot, '.tmp', 'env')
  const runOnceRoot = path.join(resolvedRoot, '.tmp', 'run-once')

  if (fs.existsSync(acceptanceRoot)) {
    for (const entry of fs.readdirSync(acceptanceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && namespaceSlug(entry.name) === entry.name) namespaces.add(entry.name)
    }
  }
  if (fs.existsSync(envRoot)) {
    for (const entry of fs.readdirSync(envRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.env')) continue
      const namespace = entry.name.slice(0, -4)
      if (namespaceSlug(namespace) === namespace) namespaces.add(namespace)
    }
  }
  if (fs.existsSync(runOnceRoot)) {
    for (const entry of fs.readdirSync(runOnceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && namespaceSlug(entry.name) === entry.name) namespaces.add(entry.name)
    }
  }

  const cleanups = [...namespaces].sort().map((namespace) => cleanupLocalRuntime({
    root: resolvedRoot,
    namespace,
    removeContainer,
    killProcess
  }))
  const orphanProcesses = []
  const untrackedContainers = []
  if (discoverUntracked) {
    if (!Number.isFinite(orphanTerminationGraceMs) || orphanTerminationGraceMs <= 0) {
      throw new Error('untracked runtime cleanup requires a positive orphan termination grace')
    }
    if (!Number.isFinite(legacyContainerMinimumAgeMs) || legacyContainerMinimumAgeMs <= 0) {
      throw new Error('untracked runtime cleanup requires a positive legacy container minimum age')
    }
    for (const record of discoverOrphanProcesses(resolvedRoot)) {
      if (killOrphanProcess(record, orphanTerminationGraceMs)) orphanProcesses.push(record.pid)
    }
    const activeBackendTesthost = detectActiveBackendTesthost(resolvedRoot)
    for (const name of listSchemaContainers()) {
      const container = inspectContainer(name)
      if (!container || !isStaleSchemaContainer(container, {
        nowMs,
        legacyMinimumAgeMs: legacyContainerMinimumAgeMs,
        activeBackendTesthost
      })) continue
      removeContainer(name)
      untrackedContainers.push(name)
    }
  }
  return {
    namespaces: cleanups.map((cleanup) => cleanup.namespace),
    removedContainers: [...cleanups.flatMap((cleanup) => cleanup.removedContainers), ...untrackedContainers],
    skippedContainers: cleanups.flatMap((cleanup) => cleanup.skippedContainers),
    terminatedPids: [...cleanups.flatMap((cleanup) => cleanup.terminatedPids), ...orphanProcesses],
    orphanProcesses,
    untrackedContainers
  }
}
