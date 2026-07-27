import fs from 'node:fs'
import path from 'node:path'

import { schedulerRunLockActivity } from './scheduler-run-owner.mjs'

const msbuildFlags = new Set(['/noautoresponse', '/nologo', '/nodemode:1', '/nodeReuse:true', '/low:false'])

function serverKind(args) {
  if (exactMsbuildNode(args)) return 'msbuild-node'
  if (exactVbcsCompiler(args)) return 'roslyn-compiler'
  return null
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function exactMsbuildNode(args) {
  if (args.length !== 7 || path.basename(String(args[0] ?? '')) !== 'dotnet') return false
  const assembly = String(args[1] ?? '')
  if (path.basename(assembly) !== 'MSBuild.dll'
    || !/[/\\]sdk[/\\]\d+\.\d+\.\d+[/\\]MSBuild\.dll$/u.test(assembly)) return false
  const flags = args.slice(2)
  return flags.length === msbuildFlags.size
    && new Set(flags).size === msbuildFlags.size
    && flags.every((flag) => msbuildFlags.has(flag))
}

function exactVbcsCompiler(args) {
  if (args.length !== 4
    || path.basename(String(args[0] ?? '')) !== 'dotnet'
    || args[1] !== 'exec') return false
  const assembly = String(args[2] ?? '')
  return /[/\\]sdk[/\\]\d+\.\d+\.\d+[/\\]Roslyn[/\\]bincore[/\\]VBCSCompiler\.dll$/u.test(assembly)
    && /^-pipename:[A-Za-z0-9._-]+$/u.test(String(args[3] ?? ''))
}

export function managedOrphanDotnetBuildServer(record, { root }) {
  // MSBuild worker nodes chdir into the selected SDK directory before they
  // detach, so their /proc/<pid>/cwd no longer identifies the repository that
  // launched them. Ownership is instead proven by the exact server command and
  // the run-bound environment inherited from the production scheduler.
  path.resolve(root)
  const args = Array.isArray(record?.args) ? record.args : []
  const env = record?.env ?? {}
  const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '')
  const namespace = String(env.FSUSBLOG_TEST_NAMESPACE ?? '')
  return positiveInteger(record?.pid) !== null
    && record.ppid === 1
    && /^\d+$/u.test(String(record.startTimeTicks ?? ''))
    && runId.length > 0
    && namespace.length > 0
    && serverKind(args) !== null
}

function dotnetBuildServerShape(record) {
  return positiveInteger(record?.pid) !== null
    && record.ppid === 1
    && /^\d+$/u.test(String(record.startTimeTicks ?? ''))
    && serverKind(Array.isArray(record?.args) ? record.args : []) !== null
}

function schedulerOwnerActivity(runsRoot, runId) {
  if (!runId) return { status: 'unverifiable', reason: 'build-server-run-id-missing' }
  return schedulerRunLockActivity({ runsRoot, runId })
}

function buildServerStartSource(record) {
  const source = String(record?.env?.FSUSBLOG_TEST_EXECUTION_SOURCE ?? '')
  return ['fresh', 'resume'].includes(source) ? source : null
}

export function dotnetBuildServerInventory(records, {
  root,
  currentRunId = '',
  currentNamespace = '',
  currentStartSource = '',
  runsRoot = path.join(path.resolve(root), '.tmp/test-runs'),
  runActivity = ({ runId }) => schedulerOwnerActivity(runsRoot, runId)
}) {
  if (!Array.isArray(records)) throw new Error('dotnet build-server inventory requires a process array')
  if (typeof runActivity !== 'function') throw new Error('dotnet build-server inventory requires a scheduler run-owner activity probe')
  const expectedBuildRoot = currentRunId ? path.join(path.resolve(root), '.tmp/build', currentRunId) : ''
  return records
    .filter(dotnetBuildServerShape)
    .map((record) => {
      const env = record.env ?? {}
      const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '')
      const namespace = String(env.FSUSBLOG_TEST_NAMESPACE ?? '')
      const buildRoot = String(env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '')
      const startSource = buildServerStartSource(record)
      const startedByCurrentRun = runId === currentRunId && namespace === currentNamespace
        && buildRoot === expectedBuildRoot && startSource === currentStartSource
      const ownerActivity = startedByCurrentRun || !runId
        ? null
        : runActivity({ runId, namespace, buildRoot, startSource })
      const ownerState = startedByCurrentRun
        ? 'current'
        : (!runId || !namespace
          ? 'external-unknown'
          : (runId === currentRunId
            ? 'unknown-current-run'
            : (ownerActivity?.status === 'active'
              ? 'active-other-run'
              : ownerActivity?.status === 'inactive'
                ? 'inactive-or-unknown'
                : 'owner-unverifiable')))
      return {
        processIdentity: {
          pid: record.pid,
          ppid: record.ppid,
          startTimeTicks: record.startTimeTicks,
          cwd: record.cwd,
          args: [...record.args]
        },
        serverKind: serverKind(record.args),
        runId,
        namespace,
        buildRoot,
        startSource,
        pipeOrSocketIdentity: serverKind(record.args) === 'roslyn-compiler' ? record.args[3] : null,
        startedByCurrentRun,
        sharedWithOtherRun: ownerState !== 'current',
        ownerState,
        record
      }
    })
}

export function selectOrphanDotnetBuildServers(records, {
  root,
  currentRunId = '',
  currentNamespace = '',
  currentStartSource = '',
  includeCurrentBinding = false,
  runsRoot = path.join(path.resolve(root), '.tmp/test-runs'),
  runActivity = ({ runId }) => schedulerOwnerActivity(runsRoot, runId)
}) {
  if (!Array.isArray(records)) throw new Error('dotnet build-server cleanup requires a process array')
  if (typeof runActivity !== 'function') throw new Error('dotnet build-server cleanup requires a scheduler run-owner activity probe')
  return dotnetBuildServerInventory(records, {
    root,
    currentRunId,
    currentNamespace,
    currentStartSource,
    runsRoot,
    runActivity
  }).filter((entry) => (
    includeCurrentBinding && entry.startedByCurrentRun
  )).map((entry) => entry.record)
}

export function readProcProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const statTail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
    const startTimeTicks = statTail[19] ?? ''
    if (!/^\d+$/u.test(startTimeTicks)) return null
    const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
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
      env
    }
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null
    throw error
  }
}

export function discoverOrphanDotnetBuildServers({ root }) {
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) return []
  return fs.readdirSync('/proc', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => readProcProcess(Number.parseInt(entry.name, 10)))
    .filter((record) => record && dotnetBuildServerShape(record))
}

function sameProcessIdentity(expected, observed = readProcProcess(expected.pid)) {
  return observed !== null
    && observed.ppid === expected.ppid
    && observed.startTimeTicks === expected.startTimeTicks
    && observed.cwd === expected.cwd
    && observed.args.join('\0') === expected.args.join('\0')
    && observed.env.FSUSBLOG_TEST_RUN_ID === expected.env.FSUSBLOG_TEST_RUN_ID
    && observed.env.FSUSBLOG_TEST_NAMESPACE === expected.env.FSUSBLOG_TEST_NAMESPACE
    && observed.env.FSUSBLOG_PRODUCTION_BUILD_ROOT === expected.env.FSUSBLOG_PRODUCTION_BUILD_ROOT
    && observed.env.FSUSBLOG_TEST_EXECUTION_SOURCE === expected.env.FSUSBLOG_TEST_EXECUTION_SOURCE
}

export function terminateOrphanDotnetBuildServers(records, {
  root,
  currentRunId = '',
  currentNamespace = '',
  currentStartSource = '',
  includeCurrentBinding = false,
  runsRoot = path.join(path.resolve(root), '.tmp/test-runs'),
  runActivity = ({ runId }) => schedulerOwnerActivity(runsRoot, runId),
  terminationGraceMs = 250,
  readProcess = readProcProcess,
  signalProcess = process.kill,
  processExists = (pid) => fs.existsSync(`/proc/${pid}`)
}) {
  if (!Number.isFinite(terminationGraceMs) || terminationGraceMs <= 0) {
    throw new Error('dotnet build-server cleanup requires a positive termination grace')
  }
  const selected = selectOrphanDotnetBuildServers(records, {
    root,
    currentRunId,
    currentNamespace,
    currentStartSource,
    includeCurrentBinding,
    runsRoot,
    runActivity
  })
  const signalled = []
  for (const record of selected) {
    const observed = readProcess(record.pid)
    if (!sameProcessIdentity(record, observed)) continue
    try {
      signalProcess(record.pid, 'SIGTERM')
      signalled.push(record)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + terminationGraceMs
  while (signalled.some((record) => processExists(record.pid)) && Date.now() < deadline) {
    Atomics.wait(waitBuffer, 0, 0, Math.min(25, Math.max(1, deadline - Date.now())))
  }
  const terminatedPids = []
  for (const record of signalled) {
    if (!processExists(record.pid)) {
      terminatedPids.push(record.pid)
      continue
    }
    const observed = readProcess(record.pid)
    if (!sameProcessIdentity(record, observed)) continue
    try {
      signalProcess(record.pid, 'SIGKILL')
      terminatedPids.push(record.pid)
    } catch (error) {
      if (error.code === 'ESRCH') terminatedPids.push(record.pid)
      else throw error
    }
  }
  return terminatedPids
}

export function cleanupOrphanDotnetBuildServers(options) {
  const records = discoverOrphanDotnetBuildServers({ root: options.root })
  return terminateOrphanDotnetBuildServers(records, options)
}
