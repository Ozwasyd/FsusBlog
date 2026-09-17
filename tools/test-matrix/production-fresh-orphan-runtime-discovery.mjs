import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { collectProcessIdentity } from '../test/process-identity.mjs'
import {
  loadPhysicalExecutionProcessPolicy,
  terminatePhysicalExecutionAuthoritySync
} from '../test/physical-execution-process-tree.mjs'
import { schedulerRunLockActivity } from './scheduler-run-owner.mjs'
import { observeProductionFreshExclusiveLease } from './production-fresh-exclusive-lease.mjs'

export const orphanRuntimeClassifications = Object.freeze([
  'owned-orphan',
  'active-owned-other-run',
  'external-not-owned',
  'identity-unverifiable'
])

const runtimeLabels = Object.freeze({
  runId: 'io.fsusblog.test.run-id',
  bundleId: 'io.fsusblog.test.bundle-id',
  stepId: 'io.fsusblog.test.step-id',
  namespace: 'io.fsusblog.test.namespace',
  preparationId: 'io.fsusblog.test.preparation-id',
  repositoryRootDigest: 'io.fsusblog.test.repository-root-digest'
})

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

export function canonicalRepositoryIdentity(root) {
  const canonicalRepositoryRoot = fs.realpathSync(root)
  return {
    canonicalRepositoryRoot,
    repositoryRootDigest: sha256(canonicalRepositoryRoot)
  }
}

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : null
}

function withinRoot(value, canonicalRepositoryRoot) {
  if (!value) return false
  const resolved = path.resolve(String(value))
  return resolved === canonicalRepositoryRoot
    || resolved.startsWith(`${canonicalRepositoryRoot}${path.sep}`)
}

function commandPathWithinRoot(args, canonicalRepositoryRoot) {
  return args.some((argument) => (path.isAbsolute(argument)
    && withinRoot(argument, canonicalRepositoryRoot))
    || String(argument).includes(canonicalRepositoryRoot))
}

function runtimeRole(record) {
  const args = Array.isArray(record?.args) ? record.args.map(String) : []
  const command = args.join('\0')
  const executable = path.basename(String(record?.executablePath ?? args[0] ?? '')).toLowerCase()
  if (args.some((argument) => /(?:^|[\\/])FsusBlog\.Server(?:\.dll|\.exe)?(?:$|[\s"'])/u.test(argument))) {
    return 'backend'
  }
  if (args.some((argument) => /(?:^|[\\/])vite(?:\.js|\.mjs|\.cmd)?(?:$|[\s"'])/u.test(argument))
    || /(?:^|\0)(?:npm\0exec\0--\0)?vite\0/u.test(command)) {
    return args.includes('preview') ? 'release-preview' : 'debug-frontend'
  }
  if (args.some((argument) => /(?:server-public-ssr\.bundle|public-ssr|public-aot|hot-read).*\.(?:mjs|js)$/iu.test(argument))) {
    return 'public-aot-worker'
  }
  const environment = record?.environment ?? {}
  if (environment.FSUSBLOG_TEST_RUN_ID
    && environment.FSUSBLOG_TEST_NAMESPACE
    && ['bash', 'sh', 'dash', 'zsh', 'pwsh', 'powershell.exe', 'dotnet', 'node', 'node.exe']
      .includes(executable)) {
    return 'production-descendant'
  }
  return null
}

function candidateObservation(record, role) {
  return {
    pid: record.pid ?? null,
    parentPid: record.parentPid ?? null,
    processGroupId: record.processGroupId ?? null,
    sessionId: record.sessionId ?? null,
    jobObject: record.jobObject ?? null,
    processStartIdentity: record.processStartIdentity ?? null,
    executablePath: record.executablePath ?? null,
    executableDigest: record.executableDigest ?? null,
    commandDigest: record.commandDigest ?? null,
    arguments: record.args ?? [],
    cwd: record.cwd ?? null,
    canonicalRepositoryRoot: record.canonicalRepositoryRoot ?? null,
    cgroup: record.cgroup ?? null,
    containerLabels: record.containerLabels ?? null,
    openPorts: record.openPorts ?? [],
    environmentIdentity: {
      runId: record.environment?.FSUSBLOG_TEST_RUN_ID ?? null,
      namespace: record.environment?.FSUSBLOG_TEST_NAMESPACE ?? null,
      runtimeRole: record.environment?.FSUSBLOG_RUNTIME_ROLE ?? null,
      preparationId: record.environment?.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID ?? null,
      repositoryRootDigest: record.environment?.FSUSBLOG_REPOSITORY_ROOT_DIGEST ?? null
    },
    buildRoot: record.buildRoot ?? null,
    role
  }
}

function completeProcessIdentity(record, platform) {
  const containmentComplete = platform === 'win32'
    ? record.jobObject?.kind === 'windows-job-object'
      && typeof record.jobObject.jobName === 'string'
      && record.jobObject.jobName.length > 0
    : positiveInteger(record.processGroupId) !== null
  return record.identityStatus === 'verified'
    && positiveInteger(record.pid) !== null
    && typeof record.processStartIdentity === 'string'
    && record.processStartIdentity.length > 0
    && /^sha256:[a-f0-9]{64}$/u.test(String(record.executableDigest ?? ''))
    && /^sha256:[a-f0-9]{64}$/u.test(String(record.commandDigest ?? ''))
    && typeof record.executablePath === 'string'
    && record.executablePath.length > 0
    && Array.isArray(record.args)
    && record.args.length > 0
    && containmentComplete
}

function ownedProcessShape(record, canonicalRepositoryRoot, repositoryRootDigest) {
  const args = Array.isArray(record.args) ? record.args : []
  const environment = record.environment ?? {}
  const explicitRootBinding = environment.FSUSBLOG_REPOSITORY_ROOT_DIGEST === repositoryRootDigest
  const filesystemBinding = withinRoot(record.cwd, canonicalRepositoryRoot)
    || withinRoot(record.executablePath, canonicalRepositoryRoot)
    || commandPathWithinRoot(args, canonicalRepositoryRoot)
    || withinRoot(record.buildRoot, canonicalRepositoryRoot)
  const runBinding = typeof environment.FSUSBLOG_TEST_RUN_ID === 'string'
    && environment.FSUSBLOG_TEST_RUN_ID.length > 0
    && typeof environment.FSUSBLOG_TEST_NAMESPACE === 'string'
    && environment.FSUSBLOG_TEST_NAMESPACE.length > 0
  return {
    filesystemBinding,
    explicitRootBinding,
    runBinding,
    owned: (filesystemBinding || explicitRootBinding) && runBinding
  }
}

export function classifyProcessCandidate(record, {
  root,
  currentRunId = '',
  platform = process.platform,
  activeRunStatus = () => ({ status: 'inactive', reason: 'run-owner-not-live' })
}) {
  const { canonicalRepositoryRoot, repositoryRootDigest } = canonicalRepositoryIdentity(root)
  const role = runtimeRole(record)
  if (role === null) return null
  const observation = candidateObservation({
    ...record,
    canonicalRepositoryRoot
  }, role)
  const ownership = ownedProcessShape(record, canonicalRepositoryRoot, repositoryRootDigest)
  if (!ownership.filesystemBinding && !ownership.explicitRootBinding) {
    return {
      kind: 'process',
      classification: 'external-not-owned',
      reason: 'candidate is not bound to the canonical FsusBlog repository root',
      observation
    }
  }
  if (!ownership.owned || !completeProcessIdentity(record, platform)) {
    return {
      kind: 'process',
      classification: 'identity-unverifiable',
      reason: !ownership.runBinding
        ? 'repository runtime lacks complete run and namespace ownership identity'
        : 'repository runtime lacks complete process start, executable, command, or containment identity',
      observation
    }
  }
  const runId = record.environment.FSUSBLOG_TEST_RUN_ID
  if (runId !== currentRunId) {
    const active = activeRunStatus(runId, record)
    if (active?.status === 'active') {
      return {
        kind: 'process',
        classification: 'active-owned-other-run',
        reason: active.reason ?? 'candidate belongs to another verified active run',
        observation
      }
    }
    if (active?.status !== 'inactive') {
      return {
        kind: 'process',
        classification: 'identity-unverifiable',
        reason: active?.reason ?? 'candidate run owner identity is unverifiable',
        observation
      }
    }
  }
  return {
    kind: 'process',
    classification: 'owned-orphan',
    reason: runId === currentRunId
      ? 'candidate belongs to the current Fresh cleanup run'
      : 'candidate has complete repository ownership and no verified active run owner',
    observation
  }
}

function parseLinuxStat(pid, value) {
  const close = value.lastIndexOf(')')
  if (close < 0) throw new Error('process stat command boundary is missing')
  const fields = value.slice(close + 2).trim().split(/\s+/u)
  return {
    pid,
    state: fields[0] ?? '',
    parentPid: positiveInteger(fields[1]),
    processGroupId: positiveInteger(fields[2]),
    sessionId: positiveInteger(fields[3])
  }
}

function decodeEnvironment(value) {
  return Object.fromEntries(String(value).split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('=')
    return separator < 1
      ? [entry, '']
      : [entry.slice(0, separator), entry.slice(separator + 1)]
  }))
}

function linuxOpenPorts(pid, procRoot) {
  const sockets = new Set()
  try {
    for (const entry of fs.readdirSync(path.join(procRoot, String(pid), 'fd'))) {
      try {
        const target = fs.readlinkSync(path.join(procRoot, String(pid), 'fd', entry))
        const match = /^socket:\[(\d+)\]$/u.exec(target)
        if (match) sockets.add(match[1])
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    const ports = []
    for (const table of ['tcp', 'tcp6']) {
      const file = path.join(procRoot, String(pid), 'net', table)
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u).slice(1)) {
        const fields = line.trim().split(/\s+/u)
        if (fields.length < 10 || !sockets.has(fields[9])) continue
        const port = Number.parseInt(fields[1].split(':').at(-1), 16)
        if (Number.isInteger(port) && port > 0) ports.push(port)
      }
    }
    return [...new Set(ports)].sort((left, right) => left - right)
  } catch {
    return []
  }
}

function linuxProcessRecord(pid, {
  procRoot,
  root,
  collectIdentity
}) {
  const processRoot = path.join(procRoot, String(pid))
  let stat
  try {
    stat = parseLinuxStat(pid, fs.readFileSync(path.join(processRoot, 'stat'), 'utf8'))
    if (stat.state === 'Z') return null
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null
    throw new Error(`unable to enumerate process-group identity for PID ${pid}: ${error.message}`, {
      cause: error
    })
  }
  let cwd = null
  let environment = {}
  let cgroup = null
  let args = []
  const observationErrors = []
  try {
    const command = fs.readFileSync(path.join(processRoot, 'cmdline'), 'utf8')
    args = command.split('\0').filter(Boolean)
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null
    args = []
    observationErrors.push(`command:${error.code ?? error.message}`)
  }
  try {
    cwd = fs.realpathSync(path.join(processRoot, 'cwd'))
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) observationErrors.push(`cwd:${error.code ?? error.message}`)
  }
  try {
    environment = decodeEnvironment(fs.readFileSync(path.join(processRoot, 'environ'), 'utf8'))
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) observationErrors.push(`environment:${error.code ?? error.message}`)
  }
  try {
    cgroup = fs.readFileSync(path.join(processRoot, 'cgroup'), 'utf8').trim()
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) observationErrors.push(`cgroup:${error.code ?? error.message}`)
  }
  const identity = collectIdentity(pid, { platform: 'linux', procRoot })
  const buildRoot = args.find((argument) => path.isAbsolute(argument)
    && withinRoot(argument, path.join(root, '.tmp', 'build'))) ?? null
  return {
    ...stat,
    args,
    cwd,
    environment,
    cgroup,
    openPorts: linuxOpenPorts(pid, procRoot),
    buildRoot,
    identityStatus: observationErrors.length === 0 ? identity.status : 'unverifiable',
    processStartIdentity: identity.processStartIdentity ?? null,
    executablePath: identity.executablePath ?? args[0] ?? null,
    executableDigest: identity.executableDigest ?? null,
    commandDigest: identity.commandDigest ?? null,
    observationErrors
  }
}

export function discoverLinuxProcessCandidates({
  root,
  procRoot = '/proc',
  collectIdentity = collectProcessIdentity
}) {
  const records = []
  for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue
    const record = linuxProcessRecord(Number(entry.name), { procRoot, root, collectIdentity })
    if (record) records.push(record)
  }
  return records.sort((left, right) => left.pid - right.pid)
}

export function discoverMacProcessCandidates({
  root,
  collectIdentity = collectProcessIdentity,
  readEnvironment = (pid) => {
    const result = spawnSync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (result.status !== 0) return { status: 'unverifiable', reason: 'ps environment query failed' }
    const environment = {}
    for (const key of [
      'FSUSBLOG_TEST_RUN_ID',
      'FSUSBLOG_TEST_NAMESPACE',
      'FSUSBLOG_RUNTIME_ROLE',
      'FSUSBLOG_REPOSITORY_ROOT_DIGEST'
    ]) {
      const match = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, 'u').exec(String(result.stdout))
      if (match) environment[key] = match[1]
    }
    return Object.keys(environment).length > 0
      ? { status: 'verified', environment }
      : { status: 'unverifiable', reason: 'macOS process environment lacks FsusBlog run binding' }
  },
  execute = (file, args) => spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}) {
  const result = execute('ps', ['-axo', 'pid=,ppid=,pgid=,command='])
  if (result.status !== 0) {
    throw new Error(`unable to inventory macOS processes: ${String(result.stderr ?? '').trim()}`)
  }
  const records = []
  for (const line of String(result.stdout).split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line)
    if (!match) continue
    const pid = positiveInteger(match[1])
    if (pid === null) continue
    const identity = collectIdentity(pid, { platform: 'darwin' })
    const environmentResult = readEnvironment(pid)
    const record = {
      pid,
      parentPid: positiveInteger(match[2]),
      processGroupId: positiveInteger(match[3]),
      sessionId: null,
      args: [match[4]],
      cwd: null,
      environment: environmentResult?.status === 'verified' ? environmentResult.environment : {},
      cgroup: null,
      openPorts: [],
      buildRoot: match[4].includes(path.join(root, '.tmp', 'build'))
        ? path.join(root, '.tmp', 'build')
        : null,
      identityStatus: identity.status === 'verified' && environmentResult?.status === 'verified'
        ? 'verified'
        : 'unverifiable',
      processStartIdentity: identity.processStartIdentity ?? null,
      executablePath: identity.executablePath ?? null,
      executableDigest: identity.executableDigest ?? null,
      commandDigest: identity.commandDigest ?? null,
      observationErrors: environmentResult?.status === 'verified'
        ? ['cwd:unavailable']
        : ['cwd:unavailable', `environment:${environmentResult?.reason ?? 'unavailable'}`]
    }
    records.push(record)
  }
  return records
}

export function discoverWindowsProcessCandidates({
  root,
  collectIdentity = collectProcessIdentity,
  resolveJobObject = () => ({ status: 'unverifiable', reason: 'Windows Job Object binding adapter is unavailable' }),
  execute = (file, args) => spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}) {
  const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
  const result = execute('powershell.exe', ['-NoProfile', '-Command', command])
  if (result.status !== 0) {
    throw new Error(`unable to inventory Windows processes: ${String(result.stderr ?? '').trim()}`)
  }
  const parsed = JSON.parse(String(result.stdout || '[]'))
  const values = Array.isArray(parsed) ? parsed : [parsed]
  const records = []
  for (const value of values) {
    const pid = positiveInteger(value?.ProcessId)
    if (pid === null || !value?.CommandLine) continue
    const identity = collectIdentity(pid, { platform: 'win32' })
    const jobBinding = resolveJobObject(pid, value)
    const record = {
      pid,
      parentPid: positiveInteger(value.ParentProcessId),
      processGroupId: null,
      sessionId: null,
      jobObject: jobBinding?.status === 'verified' ? jobBinding.value : null,
      args: [String(value.CommandLine)],
      cwd: null,
      environment: {},
      cgroup: null,
      openPorts: [],
      buildRoot: String(value.CommandLine).includes(path.join(root, '.tmp', 'build'))
        ? path.join(root, '.tmp', 'build')
        : null,
      identityStatus: identity.status === 'verified' && jobBinding?.status === 'verified'
        ? 'verified'
        : 'unverifiable',
      processStartIdentity: identity.processStartIdentity ?? null,
      executablePath: identity.executablePath ?? value.ExecutablePath ?? null,
      executableDigest: identity.executableDigest ?? null,
      commandDigest: identity.commandDigest ?? null,
      observationErrors: [
        'cwd:unavailable',
        'environment:unavailable',
        `job-object:${jobBinding?.status === 'verified' ? 'bound' : jobBinding?.reason ?? 'unavailable'}`
      ]
    }
    records.push(record)
  }
  return records
}

function defaultActiveRunStatus(runId, _record, {
  platform = process.platform,
  root = null,
  runsRoot = null,
  sourceState = null
} = {}) {
  if (!root) {
    return {
      status: 'unverifiable',
      reason: 'canonical repository root is required for live lease observation'
    }
  }
  const lease = observeProductionFreshExclusiveLease({ root, runId })
  if (lease.status === 'active' || lease.status === 'unverifiable') {
    return {
      ...lease,
      reason: lease.reason ?? 'production-fresh lease authority is active'
    }
  }
  if (runsRoot) {
    const activity = schedulerRunLockActivity({
      runsRoot,
      runId,
      candidateIdentityDigest: sourceState?.candidateIdentityDigest ?? null,
      targetTierId: sourceState?.targetTierId ?? null
    })
    return {
      ...activity,
      reason: activity.reason ?? 'lease-bound scheduler run owner is active'
    }
  }
  return {
    status: 'unverifiable',
    reason: `run ${runId} has no live lease or scheduler owner authority`
  }
}

function groupMembers(records, groupId) {
  return records.filter((record) => record.processGroupId === groupId)
}

export function terminateOwnedProcessGroup(candidate, {
  root,
  currentRunId = '',
  terminationGraceMs,
  discoverProcesses = discoverLinuxProcessCandidates,
  signalGroup = (groupId, signal) => process.kill(-groupId, signal),
  classifyCandidate = classifyProcessCandidate,
  activeRunStatus = defaultActiveRunStatus
}) {
  const groupId = positiveInteger(candidate.observation.processGroupId)
  if (groupId === null) return { terminated: false, reason: 'process group identity is unavailable' }
  const leader = discoverProcesses({ root }).find((record) => record.pid === groupId)
  const policy = {
    ...loadPhysicalExecutionProcessPolicy(),
    gracefulTerminationMs: terminationGraceMs
  }
  const result = terminatePhysicalExecutionAuthoritySync({
    authority: {
      schema: 'fsusblog.process-group-or-job-identity.v1',
      platform: process.platform,
      kind: 'process-group',
      groupId,
      leaderPid: groupId,
      leaderProcessStartIdentity:
        leader?.processStartIdentity ?? candidate.observation.processStartIdentity
    },
    reason: 'production-fresh-owned-orphan',
    policy,
    expectedIdentities: groupMembers(discoverProcesses({ root }), groupId),
    collectMembers() {
      const records = groupMembers(discoverProcesses({ root }), groupId)
      return {
        status: 'verified',
        identities: records.map((record) => ({
          pid: record.pid,
          processStartIdentity: record.processStartIdentity,
          executableDigest: record.executableDigest,
          commandDigest: record.commandDigest
        }))
      }
    },
    validateMembers() {
      const records = groupMembers(discoverProcesses({ root }), groupId)
      for (const member of records) {
        const classification = classifyCandidate(member, {
          root,
          currentRunId,
          activeRunStatus
        })
        if (classification?.classification !== 'owned-orphan') {
          return {
            status: 'unverifiable',
            reason: `process group member ${member.pid} is not a proven owned orphan`
          }
        }
      }
      return { status: 'verified' }
    },
    signalAuthority: (authority, signal) => signalGroup(authority.groupId, signal)
  })
  return {
    ...result,
    postObservation: result.postObservation === 'zero-members'
      ? 'leader-and-group-absent'
      : result.postObservation
  }
}

function defaultListContainers(repositoryRootDigest) {
  const result = spawnSync('docker', [
    'ps', '-a',
    '--format', `{{.ID}}\t{{.Names}}\t{{.Label "${runtimeLabels.repositoryRootDigest}"}}`
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(`unable to inventory FsusBlog-owned containers: ${String(result.stderr ?? '').trim()}`)
  }
  return String(result.stdout).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, name, rootDigest]) => rootDigest === repositoryRootDigest
      || /^(?:fsusblog-(?:test|ci)-|fsus-pg-|fsus-schema-migration-)/u.test(name))
    .map(([id]) => id)
}

function defaultInspectContainer(identity) {
  const result = spawnSync('docker', ['inspect', identity], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim()
    if (/no such (?:object|container)/iu.test(detail)) return null
    throw new Error(`unable to inspect Docker container ${identity}: ${detail}`)
  }
  return JSON.parse(result.stdout)?.[0] ?? null
}

function completeContainerLabels(labels, repositoryRootDigest) {
  return labels[runtimeLabels.repositoryRootDigest] === repositoryRootDigest
    && typeof labels[runtimeLabels.runId] === 'string'
    && labels[runtimeLabels.runId].length > 0
    && typeof labels[runtimeLabels.bundleId] === 'string'
    && labels[runtimeLabels.bundleId].length > 0
    && typeof labels[runtimeLabels.stepId] === 'string'
    && labels[runtimeLabels.stepId].length > 0
    && typeof labels[runtimeLabels.namespace] === 'string'
    && labels[runtimeLabels.namespace].length > 0
}

export function classifyContainerCandidate(container, {
  root,
  currentRunId = '',
  activeRunStatus = defaultActiveRunStatus
}) {
  const { canonicalRepositoryRoot, repositoryRootDigest } = canonicalRepositoryIdentity(root)
  const labels = container?.Config?.Labels ?? {}
  const id = String(container?.Id ?? '')
  const createdAt = String(container?.Created ?? '')
  const observation = {
    id: /^[a-f0-9]{64}$/u.test(id) ? id : null,
    name: String(container?.Name ?? '').replace(/^\//u, '') || null,
    canonicalRepositoryRoot,
    labels,
    createdAt: Number.isFinite(Date.parse(createdAt)) ? createdAt : null,
    running: container?.State?.Running === true,
    cgroupParent: container?.HostConfig?.CgroupParent ?? null
  }
  if (labels[runtimeLabels.repositoryRootDigest]
    && labels[runtimeLabels.repositoryRootDigest] !== repositoryRootDigest) {
    return {
      kind: 'container',
      classification: 'external-not-owned',
      reason: 'container repository-root ownership label belongs to another repository',
      observation
    }
  }
  if (!completeContainerLabels(labels, repositoryRootDigest)
    || observation.id === null
    || observation.createdAt === null) {
    return {
      kind: 'container',
      classification: 'identity-unverifiable',
      reason: 'container lacks complete repository, run, candidate, creation-time, or full-ID ownership labels',
      observation
    }
  }
  const runId = labels[runtimeLabels.runId]
  if (runId !== currentRunId) {
    const active = activeRunStatus(runId, container)
    if (active?.status === 'active') {
      return {
        kind: 'container',
        classification: 'active-owned-other-run',
        reason: active.reason ?? 'container belongs to another verified active run',
        observation
      }
    }
    if (active?.status !== 'inactive') {
      return {
        kind: 'container',
        classification: 'identity-unverifiable',
        reason: active?.reason ?? 'container run owner identity is unverifiable',
        observation
      }
    }
  }
  return {
    kind: 'container',
    classification: 'owned-orphan',
    reason: runId === currentRunId
      ? 'container belongs to the current Fresh cleanup run'
      : 'container has complete ownership labels and no verified active run owner',
    observation
  }
}

function processReceipt(candidate, outcome = null) {
  const observation = candidate.observation
  const classification = candidate.classification
  if (classification === 'external-not-owned') {
    return {
      pid: observation.pid,
      processGroupId: observation.processGroupId,
      startTimeTicks: null,
      role: observation.role,
      classification,
      classificationReason: candidate.reason,
      observation,
      identityResult: classification,
      action: 'retained-external',
      postObservation: 'retained'
    }
  }
  if (classification !== 'owned-orphan') {
    return {
      pid: observation.pid,
      processGroupId: observation.processGroupId,
      startTimeTicks: null,
      role: observation.role,
      classification,
      classificationReason: candidate.reason,
      observation,
      identityResult: classification,
      action: classification === 'active-owned-other-run' ? 'blocked-active-owner' : 'blocked',
      postObservation: 'not-terminated'
    }
  }
  return {
    pid: observation.pid,
    processGroupId: observation.processGroupId,
    startTimeTicks: null,
    role: observation.role,
    classification,
    classificationReason: candidate.reason,
    observation,
    identityResult: classification,
    action: outcome?.terminated ? 'terminated' : outcome?.alreadyAbsent ? 'already-absent' : 'termination-unconfirmed',
    postObservation: outcome?.postObservation
      ?? (outcome?.alreadyAbsent ? 'leader-and-group-absent' : 'leader-or-group-still-live'),
    actionReason: outcome?.reason ?? null
  }
}

function containerReceipt(candidate, outcome = null) {
  const observation = candidate.observation
  const classification = candidate.classification
  const base = {
    name: observation.name ?? `container-${observation.id ?? 'unverifiable'}`,
    id: observation.id,
    ownershipLabels: observation.labels,
    classification,
    classificationReason: candidate.reason,
    observation
  }
  if (classification === 'external-not-owned') {
    return { ...base, action: 'retained-external', postObservation: 'retained' }
  }
  if (classification !== 'owned-orphan') {
    return {
      ...base,
      action: classification === 'active-owned-other-run' ? 'blocked-active-owner' : 'blocked-identity-incomplete',
      postObservation: 'not-removed'
    }
  }
  return {
    ...base,
    action: outcome?.removed ? 'removed' : outcome?.alreadyAbsent ? 'already-absent' : 'remove-failed',
    postObservation: outcome?.postObservation
      ?? (outcome?.alreadyAbsent ? 'name-and-id-absent' : 'removal-unconfirmed'),
    actionReason: outcome?.reason ?? null
  }
}

export function discoverClassifyAndCleanupOrphanRuntimes({
  root,
  currentRunId = '',
  runsRoot = null,
  sourceState = null,
  platform = process.platform,
  terminationGraceMs,
  discoverProcesses = platform === 'linux'
    ? discoverLinuxProcessCandidates
    : platform === 'darwin'
      ? discoverMacProcessCandidates
      : platform === 'win32'
        ? discoverWindowsProcessCandidates
        : () => {
            throw new Error(`${platform} orphan runtime inventory adapter is unavailable`)
          },
  classifyCandidate = classifyProcessCandidate,
  activeRunStatus = (runId, record) => defaultActiveRunStatus(runId, record, {
    platform,
    root,
    runsRoot,
    sourceState
  }),
  terminateProcess = terminateOwnedProcessGroup,
  listContainers = defaultListContainers,
  inspectContainer = defaultInspectContainer,
  removeContainer = (id) => {
    const result = spawnSync('docker', ['rm', '--force', '--volumes', id], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return {
      removed: result.status === 0,
      reason: result.status === 0 ? null : String(result.stderr ?? result.stdout ?? '').trim()
    }
  }
}) {
  if (!Number.isFinite(terminationGraceMs) || terminationGraceMs <= 0) {
    throw new Error('orphan runtime cleanup requires a positive process-tree termination grace')
  }
  let currentLeaseOwner = null
  try {
    const currentLease = currentRunId
      ? observeProductionFreshExclusiveLease({ root, runId: currentRunId })
      : null
    if (currentLease?.status === 'unverifiable') {
      throw new Error(`current Production Fresh lease is unverifiable: ${currentLease.reason}`)
    }
    if (currentLease?.status === 'active') currentLeaseOwner = currentLease.owner
  } catch (error) {
    if (fs.existsSync(path.join(root, '.git'))) throw error
  }
  const isCurrentLeaseOwner = (record) => Boolean(currentLeaseOwner && (
      record.pid === currentLeaseOwner.pid &&
      record.processStartIdentity === currentLeaseOwner.processStartIdentity &&
      record.executableDigest === currentLeaseOwner.executableDigest &&
      record.commandDigest === currentLeaseOwner.commandDigest
  ))
  const processCandidates = discoverProcesses({ root })
    .filter((record) => !isCurrentLeaseOwner(record))
    .map((record) => classifyCandidate(record, { root, currentRunId, platform, activeRunStatus }))
    .filter(Boolean)
  const processRecords = []
  const completedGroups = new Set()
  for (const candidate of processCandidates) {
    const groupKey = platform === 'win32'
      ? candidate.observation.jobObject?.jobName ?? `pid:${candidate.observation.pid}`
      : `pgid:${candidate.observation.processGroupId}`
    if (candidate.classification === 'owned-orphan' && completedGroups.has(groupKey)) {
      processRecords.push(processReceipt(candidate, {
        alreadyAbsent: true,
        postObservation: 'leader-and-group-absent'
      }))
      continue
    }
    const outcome = candidate.classification === 'owned-orphan'
      ? terminateProcess(candidate, {
          root,
          currentRunId,
          platform,
          terminationGraceMs,
          discoverProcesses,
          classifyCandidate,
          activeRunStatus
        })
      : null
    if (outcome?.terminated || outcome?.alreadyAbsent) completedGroups.add(groupKey)
    processRecords.push(processReceipt(candidate, outcome))
  }

  const { repositoryRootDigest } = canonicalRepositoryIdentity(root)
  const containerRecords = []
  for (const identity of listContainers(repositoryRootDigest)) {
    const inspected = inspectContainer(identity)
    if (inspected === null) continue
    const candidate = classifyContainerCandidate(inspected, { root, currentRunId, activeRunStatus })
    let outcome = null
    if (candidate.classification === 'owned-orphan') {
      const removed = removeContainer(candidate.observation.id, { inspected })
      const nameStillPresent = inspectContainer(candidate.observation.name) !== null
      const idStillPresent = inspectContainer(candidate.observation.id) !== null
      outcome = !nameStillPresent && !idStillPresent
        ? {
            removed: removed !== false && removed?.removed !== false,
            alreadyAbsent: removed === false || removed?.removed === false,
            postObservation: 'name-and-id-absent'
          }
        : {
            removed: false,
            reason: idStillPresent ? 'container ID remains after removal' : 'container name remains after removal',
            postObservation: idStillPresent ? 'id-still-present' : 'name-still-present'
          }
    }
    containerRecords.push(containerReceipt(candidate, outcome))
  }

  const finalProcesses = discoverProcesses({ root })
    .filter((record) => !isCurrentLeaseOwner(record))
    .map((record) => classifyCandidate(record, { root, currentRunId, platform, activeRunStatus }))
    .filter((candidate) => candidate
      && ['owned-orphan', 'identity-unverifiable'].includes(candidate.classification))
  if (finalProcesses.length > 0) {
    const remaining = new Set(processRecords.map((record) => record.pid))
    for (const candidate of finalProcesses) {
      if (!remaining.has(candidate.observation.pid)) processRecords.push(processReceipt(candidate))
    }
  }
  const recordedContainerIds = new Set(containerRecords.map((record) => record.id).filter(Boolean))
  for (const identity of listContainers(repositoryRootDigest)) {
    const inspected = inspectContainer(identity)
    if (inspected === null) continue
    const candidate = classifyContainerCandidate(inspected, {
      root,
      currentRunId,
      activeRunStatus
    })
    if (
      ['owned-orphan', 'identity-unverifiable'].includes(candidate.classification) &&
      !recordedContainerIds.has(candidate.observation.id)
    ) {
      containerRecords.push(containerReceipt(candidate))
    }
  }
  return {
    processRecords,
    containerRecords,
    candidatesObserved: processCandidates.length + containerRecords.length
  }
}
