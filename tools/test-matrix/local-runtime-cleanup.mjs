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

function defaultRemoveContainer(name) {
  spawnSync('docker', ['rm', '--force', '--volumes', name], { stdio: 'ignore' })
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

function readProcProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const statTail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
    const startTimeTicks = statTail[19] ?? ''
    if (!/^\d+$/u.test(startTimeTicks)) return null
    const environment = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('=')
        return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)]
      }))
    return {
      pid,
      ppid: positiveInteger(statTail[1]),
      startTimeTicks,
      cwd: fs.realpathSync(`/proc/${pid}/cwd`),
      args: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
      env: environment
    }
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null
    throw error
  }
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
  observeResidentService,
  residentCleanupTimeoutMs = null
}) {
  const resolvedRoot = path.resolve(root)
  const slug = namespaceSlug(namespace)
  const envRelative = path.join('.tmp', 'env', `${slug}.env`)
  const envFile = path.join(resolvedRoot, envRelative)
  const environment = readEnvFile(envFile)
  const owned = ownedContainerNames(slug)
  const configuredContainers = [
    environment.FSUSBLOG_POSTGRES_CONTAINER_NAME,
    environment.FSUSBLOG_REDIS_CONTAINER_NAME
  ].filter(Boolean)
  const removedContainers = []
  const skippedContainers = []
  for (const container of configuredContainers) {
    if (!owned.has(container)) {
      skippedContainers.push(container)
      continue
    }
    removeContainer(container)
    removedContainers.push(container)
  }

  const runtimeRelative = path.join('.tmp', 'acceptance', slug)
  const runtimeDirectory = path.join(resolvedRoot, runtimeRelative)
  const terminatedPids = []
  if (fs.existsSync(runtimeDirectory)) {
    for (const entry of fs.readdirSync(runtimeDirectory)) {
      if (!entry.endsWith('.pid')) continue
      const value = Number.parseInt(fs.readFileSync(path.join(runtimeDirectory, entry), 'utf8').trim(), 10)
      if (Number.isInteger(value) && value > 1 && killProcess(value, resolvedRoot, entry)) terminatedPids.push(value)
    }
  }

  const result = { namespace: slug, removedContainers, skippedContainers, terminatedPids }
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
  result.retainedRuntimeState = result.residentResourceLeases?.status === 'cleanup-pending-live-services'
  if (!result.retainedRuntimeState) {
    for (const relative of [
      runtimeRelative,
      path.join('.tmp', 'fixtures', slug),
      path.join('.tmp', 'data', slug),
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
