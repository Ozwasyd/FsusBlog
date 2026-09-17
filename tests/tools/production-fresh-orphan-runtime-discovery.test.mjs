import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  canonicalRepositoryIdentity,
  classifyProcessCandidate,
  discoverLinuxProcessCandidates,
  discoverMacProcessCandidates,
  discoverWindowsProcessCandidates,
  discoverClassifyAndCleanupOrphanRuntimes,
  terminateOwnedProcessGroup
} from '../../tools/test-matrix/production-fresh-orphan-runtime-discovery.mjs'
import { verifyFreshRuntimeCleanup } from '../../tools/test-matrix/local-runtime-cleanup.mjs'
import { acquireProductionFreshExclusiveLease } from '../../tools/test-matrix/production-fresh-exclusive-lease.mjs'

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

function waitFor(condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (condition()) return resolve()
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for test process'))
      setTimeout(poll, 25)
    }
    poll()
  })
}

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-orphan-discovery-'))
  fs.mkdirSync(path.join(root, 'src/backend/bin/Release/net10.0'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src/frontend/dist/server'), { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function processCandidate(root, {
  pid = 4101,
  parentPid = 1,
  processGroupId = pid,
  args = ['/usr/bin/dotnet', path.join(root, 'src/backend/bin/Release/net10.0/FsusBlog.Server.dll')],
  cwd = root,
  runId = 'production-2026-07-27_10-00-00-000-99999',
  namespace = `${runId}-fresh-local-production-0`,
  identityStatus = 'verified',
  platform = 'linux',
  jobObject = null
} = {}) {
  return {
    pid,
    parentPid,
    processGroupId,
    sessionId: processGroupId,
    args,
    cwd,
    environment: {
      FSUSBLOG_TEST_RUN_ID: runId,
      FSUSBLOG_TEST_NAMESPACE: namespace,
      FSUSBLOG_RUNTIME_ROLE: 'backend',
      FSUSBLOG_REPOSITORY_ROOT_DIGEST: canonicalRepositoryIdentity(root).repositoryRootDigest
    },
    cgroup: platform === 'linux' ? '0::/fsusblog-production' : null,
    openPorts: [24001],
    identityStatus,
    processStartIdentity: identityStatus === 'verified' ? `${platform}:boot:${pid}` : null,
    executablePath: '/usr/bin/dotnet',
    executableDigest: identityStatus === 'verified' ? digest('dotnet') : null,
    commandDigest: identityStatus === 'verified' ? digest(args.join('\0')) : null,
    jobObject
  }
}

function noContainers() {
  return []
}

test('tracking-free backend orphan is discovered, tree-terminated, recorded, and post-observed absent', (t) => {
  const root = fixtureRoot(t)
  const candidate = processCandidate(root)
  let alive = true
  let terminationCalls = 0
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => alive ? [candidate] : [],
    activeRunStatus: () => ({ status: 'inactive', reason: 'owner-dead' }),
    terminateProcess: (classified) => {
      terminationCalls += 1
      assert.equal(classified.classification, 'owned-orphan')
      alive = false
      return { terminated: true, postObservation: 'leader-and-group-absent' }
    },
    listContainers: noContainers
  })

  assert.equal(terminationCalls, 1)
  assert.equal(result.processRecords.length, 1)
  assert.equal(result.processRecords[0].classification, 'owned-orphan')
  assert.equal(result.processRecords[0].action, 'terminated')
  assert.equal(result.processRecords[0].postObservation, 'leader-and-group-absent')
  assert.equal(result.processRecords[0].observation.canonicalRepositoryRoot, fs.realpathSync(root))
  assert.match(result.processRecords[0].observation.executableDigest, /^sha256:/u)
  assert.deepEqual(result.processRecords[0].observation.openPorts, [24001])
  assert.equal(verifyFreshRuntimeCleanup({
    cleanups: [],
    orphanProcessRecords: result.processRecords,
    untrackedContainerRecords: []
  }).status, 'complete')
})

test('dead shell leader does not hide its live dotnet child in the owned process group', (t) => {
  const root = fixtureRoot(t)
  const child = processCandidate(root, {
    pid: 4202,
    parentPid: 1,
    processGroupId: 4201
  })
  let alive = true
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => alive ? [child] : [],
    activeRunStatus: () => ({ status: 'inactive' }),
    terminateProcess: (classified) => {
      assert.equal(classified.observation.parentPid, 1)
      assert.equal(classified.observation.processGroupId, 4201)
      alive = false
      return { terminated: true, postObservation: 'leader-and-group-absent' }
    },
    listContainers: noContainers
  })
  assert.equal(result.processRecords[0].action, 'terminated')
})

test('Public AOT worker is discovered without PID sidecars', (t) => {
  const root = fixtureRoot(t)
  const worker = processCandidate(root, {
    pid: 4301,
    args: ['/usr/bin/node', path.join(root, 'src/frontend/dist/server/server-public-ssr.bundle.mjs')],
    cwd: path.join(root, 'src/frontend')
  })
  let alive = true
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => alive ? [worker] : [],
    activeRunStatus: () => ({ status: 'inactive' }),
    terminateProcess: () => {
      alive = false
      return { terminated: true, postObservation: 'leader-and-group-absent' }
    },
    listContainers: noContainers
  })
  assert.equal(result.processRecords[0].role, 'public-aot-worker')
  assert.equal(result.processRecords[0].classification, 'owned-orphan')
})

test('same executable in another repository is retained as external', (t) => {
  const root = fixtureRoot(t)
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-other-repo-'))
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }))
  const other = processCandidate(root, {
    cwd: otherRoot,
    args: ['/usr/bin/dotnet', path.join(otherRoot, 'src/backend/bin/FsusBlog.Server.dll')]
  })
  other.environment.FSUSBLOG_REPOSITORY_ROOT_DIGEST = digest(fs.realpathSync(otherRoot))
  const classified = classifyProcessCandidate(other, { root })
  assert.equal(classified.classification, 'external-not-owned')

  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    terminationGraceMs: 100,
    discoverProcesses: () => [other],
    terminateProcess: () => assert.fail('external process must not be terminated'),
    listContainers: noContainers
  })
  assert.equal(result.processRecords[0].action, 'retained-external')
  assert.equal(result.processRecords[0].postObservation, 'retained')
})

test('another verified active run blocks Fresh without termination', (t) => {
  const root = fixtureRoot(t)
  const candidate = processCandidate(root)
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => [candidate],
    activeRunStatus: () => ({ status: 'active', reason: 'exclusive lease owner is active' }),
    terminateProcess: () => assert.fail('active run process must not be terminated'),
    listContainers: noContainers
  })
  assert.equal(result.processRecords[0].classification, 'active-owned-other-run')
  assert.equal(result.processRecords[0].action, 'blocked-active-owner')
  assert.equal(verifyFreshRuntimeCleanup({
    cleanups: [],
    orphanProcessRecords: result.processRecords,
    untrackedContainerRecords: []
  }).status, 'blocked')
})

test('unreadable start identity fails closed with zero kill', (t) => {
  const root = fixtureRoot(t)
  const candidate = processCandidate(root, { identityStatus: 'unverifiable' })
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => [candidate],
    terminateProcess: () => assert.fail('unverifiable process must not be terminated'),
    listContainers: noContainers
  })
  assert.equal(result.processRecords[0].classification, 'identity-unverifiable')
  assert.equal(result.processRecords[0].action, 'blocked')
  assert.equal(result.processRecords[0].postObservation, 'not-terminated')
})

test('Linux real /proc discovery fail-closes a tracking-free process with incomplete run binding', async (t) => {
  if (process.platform !== 'linux') t.skip('Linux-only real process discovery contract')
  const root = fixtureRoot(t)
  const program = path.join(root, 'src/backend/bin/Release/net10.0/FsusBlog.Server.dll')
  fs.writeFileSync(program, 'setInterval(() => {}, 1000)\n')
  const child = spawn(process.execPath, [program], {
    cwd: root,
    env: {
      ...process.env,
      FSUSBLOG_TEST_RUN_ID: 'production-2026-07-27_10-00-00-000-99999',
      FSUSBLOG_REPOSITORY_ROOT_DIGEST: canonicalRepositoryIdentity(root).repositoryRootDigest
    },
    stdio: 'ignore'
  })
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  await waitFor(() => discoverLinuxProcessCandidates({ root }).some((record) => record.pid === child.pid))
  let terminations = 0
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    terminateProcess: () => {
      terminations += 1
      return { terminated: true, postObservation: 'leader-and-group-absent' }
    },
    listContainers: noContainers
  })
  const record = result.processRecords.find((entry) => entry.pid === child.pid)
  assert.equal(record?.classification, 'identity-unverifiable')
  assert.equal(record?.action, 'blocked')
  assert.equal(terminations, 0)
})

test('macOS discovery requires an executable environment binding adapter and fails closed when it is absent', () => {
  const root = fs.realpathSync('.')
  const execute = () => ({ status: 0, stdout: ' 6101 1 6101 /usr/bin/node /repo/src/frontend/dist/server/server-public-ssr.bundle.mjs\n', stderr: '' })
  const identity = () => ({
    status: 'verified', pid: 6101, processStartIdentity: 'darwin:start', executablePath: '/usr/bin/node',
    executableDigest: digest('node'), commandDigest: digest('command')
  })
  const missing = discoverMacProcessCandidates({ root, execute, collectIdentity: identity, readEnvironment: () => ({ status: 'unverifiable', reason: 'denied' }) })
  assert.equal(missing[0].identityStatus, 'unverifiable')
  const bound = discoverMacProcessCandidates({ root, execute, collectIdentity: identity, readEnvironment: () => ({
    status: 'verified', environment: { FSUSBLOG_TEST_RUN_ID: 'run', FSUSBLOG_TEST_NAMESPACE: 'namespace' }
  }) })
  assert.equal(bound[0].environment.FSUSBLOG_TEST_RUN_ID, 'run')
  assert.equal(bound[0].identityStatus, 'verified')
})

test('Windows discovery records only a verified Job Object binding and otherwise remains fail-closed', () => {
  const root = fs.realpathSync('.')
  const execute = () => ({ status: 0, stdout: JSON.stringify({ ProcessId: 6201, ParentProcessId: 1, ExecutablePath: 'C:\\node.exe', CommandLine: 'node server-public-ssr.bundle.mjs' }), stderr: '' })
  const identity = () => ({
    status: 'verified', pid: 6201, processStartIdentity: 'win:start', executablePath: 'C:\\node.exe',
    executableDigest: digest('node'), commandDigest: digest('command')
  })
  const missing = discoverWindowsProcessCandidates({ root, execute, collectIdentity: identity })
  assert.equal(missing[0].jobObject, null)
  assert.equal(missing[0].identityStatus, 'unverifiable')
  const authority = { kind: 'windows-job-object', jobName: 'Local\\FsusBlog-test', authorityId: digest('authority') }
  const bound = discoverWindowsProcessCandidates({ root, execute, collectIdentity: identity, resolveJobObject: () => ({ status: 'verified', value: authority }) })
  assert.deepEqual(bound[0].jobObject, authority)
  assert.equal(bound[0].identityStatus, 'verified')
})

test('post-kill descendants remaining in the group keep Fresh blocked', (t) => {
  const root = fixtureRoot(t)
  const candidate = processCandidate(root)
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => [candidate],
    activeRunStatus: () => ({ status: 'inactive' }),
    terminateProcess: () => ({
      terminated: false,
      reason: 'process group still has a live descendant',
      postObservation: 'group-still-live'
    }),
    listContainers: noContainers
  })
  assert.equal(result.processRecords[0].action, 'termination-unconfirmed')
  assert.equal(result.processRecords[0].postObservation, 'group-still-live')
  assert.match(result.processRecords[0].actionReason, /live descendant/u)
})

test('an unclassified process-group member prevents every signal', (t) => {
  const root = fixtureRoot(t)
  const candidate = processCandidate(root, { pid: 4401, processGroupId: 4401 })
  const classified = classifyProcessCandidate(candidate, {
    root,
    currentRunId: 'production-current',
    activeRunStatus: () => ({ status: 'inactive' })
  })
  const unrelated = {
    ...processCandidate(root, { pid: 4402, processGroupId: 4401 }),
    args: ['/usr/bin/sleep', '60'],
    environment: {}
  }
  let signals = 0
  const outcome = terminateOwnedProcessGroup(classified, {
    root,
    currentRunId: 'production-current',
    terminationGraceMs: 100,
    discoverProcesses: () => [candidate, unrelated],
    signalGroup: () => {
      signals += 1
      return true
    },
    activeRunStatus: () => ({ status: 'inactive' })
  })
  assert.equal(signals, 0)
  assert.equal(outcome.terminated, false)
  assert.match(outcome.reason, /not a proven owned orphan/u)
})

test('current controller is excluded only by the live Production Fresh lease identity', (t) => {
  const root = fixtureRoot(t)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  fs.writeFileSync(path.join(root, 'tracked'), 'tracked\n')
  execFileSync('git', ['add', 'tracked'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root })
  const runId = 'production-live-lease-owner'
  const lease = acquireProductionFreshExclusiveLease({
    root,
    runId,
    targetTierId: 'production',
    sourceState: {
      commit: 'a'.repeat(40),
      worktreeFingerprint: `sha256:${'b'.repeat(64)}`
    },
    heartbeatEveryMs: 60_000,
    verifyDescendants: () => ({ status: 'verified', identities: [] })
  })
  t.after(() => {
    try {
      lease.release('cancelled')
    } catch {}
  })
  let terminationCalls = 0
  const record = processCandidate(root, {
    pid: lease.owner.pid,
    processGroupId: lease.owner.processGroupOrJobIdentity.groupId,
    runId
  })
  Object.assign(record, {
    processStartIdentity: lease.owner.processStartIdentity,
    executableDigest: lease.owner.executableDigest,
    commandDigest: lease.owner.commandDigest
  })
  const result = discoverClassifyAndCleanupOrphanRuntimes({
    root,
    currentRunId: runId,
    terminationGraceMs: 100,
    discoverProcesses: () => [record],
    terminateProcess: () => {
      terminationCalls += 1
      return { terminated: true }
    },
    listContainers: () => []
  })
  assert.deepEqual(result.processRecords, [])
  assert.equal(terminationCalls, 0)
  lease.release('complete')
})
