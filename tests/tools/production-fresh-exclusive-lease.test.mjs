import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  acquireProductionFreshExclusiveLease,
  productionFreshLeaseIdentity
} from '../../tools/test-matrix/production-fresh-exclusive-lease.mjs'
import {
  collectSchedulerProcessGroupOrJobIdentity,
  verifySchedulerProcessAuthority
} from '../../tools/test-matrix/scheduler-run-owner.mjs'
import {
  collectWindowsJobMemberIdentities,
  queryWindowsJobProcessIds
} from '../../tools/test-matrix/windows-job-members.mjs'
import { currentProcessIdentity } from '../../tools/test/process-identity.mjs'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function seal(owner) {
  const { contentDigest: _contentDigest, ...payload } = owner
  owner.contentDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex')}`
  return owner
}

function markStale(owner) {
  owner.createdAt = '2000-01-01T00:00:00.000Z'
  owner.heartbeatAt = '2000-01-01T00:00:00.000Z'
  return seal(owner)
}

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-fresh-lease-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  fs.mkdirSync(path.join(root, 'nested'))
  fs.writeFileSync(path.join(root, 'tracked'), 'tracked\n')
  fs.writeFileSync(path.join(root, 'nested/untracked'), 'untracked\n')
  execFileSync('git', ['add', 'tracked'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function leaseOptions(root, overrides = {}) {
  const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: `sha256:${'b'.repeat(64)}`
  }
  return {
    root,
    runId: 'production-fresh-candidate',
    targetTierId: 'production',
    sourceState,
    heartbeatEveryMs: 60_000,
    verifyDescendants: () => ({ status: 'verified', identities: [] }),
    ...overrides
  }
}

function treeDigest(root) {
  const entries = []
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git') continue
      const file = path.join(directory, entry.name)
      const relative = path.relative(root, file)
      if (entry.isDirectory()) {
        entries.push(`${relative}/`)
        visit(file)
      } else if (entry.isSymbolicLink()) {
        entries.push(`${relative}->${fs.readlinkSync(file)}`)
      } else {
        entries.push(`${relative}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`)
      }
    }
  }
  visit(root)
  return entries
}

test('Fresh B rejection preserves complete file/process/container/port inventories', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(leaseOptions(root))
  t.after(() => {
    try {
      first.release()
    } catch {}
  })
  const inventories = {
    files: treeDigest(root),
    processes: [{ pid: first.owner.pid, start: first.owner.processStartIdentity }],
    containers: [{ id: 'fresh-a-container', state: 'running' }],
    ports: [{ port: 54321, ownerPid: first.owner.pid }]
  }
  const before = structuredClone(inventories)
  assert.throws(
    () => acquireProductionFreshExclusiveLease(leaseOptions(root, {
      runId: 'production-fresh-candidate-b'
    })),
    /already active/u
  )
  inventories.files = treeDigest(root)
  assert.deepEqual(inventories, before)
})

test('Fresh B cannot terminate Fresh A after A enters runtime authority', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(leaseOptions(root))
  t.after(() => {
    try {
      first.release()
    } catch {}
  })
  const before = verifySchedulerProcessAuthority(first.owner)
  assert.equal(before.status, 'active')
  assert.throws(
    () => acquireProductionFreshExclusiveLease(leaseOptions(root)),
    /already active/u
  )
  assert.equal(verifySchedulerProcessAuthority(first.owner).status, 'active')
  assert.equal(fs.existsSync(first.leasePath), true)
})

test('relative and symlink aliases normalize to the same repository lease', (t) => {
  const root = repository(t)
  const alias = `${root}-alias`
  fs.symlinkSync(root, alias, 'dir')
  t.after(() => fs.rmSync(alias, { recursive: true, force: true }))
  const first = acquireProductionFreshExclusiveLease(leaseOptions(root))
  t.after(() => {
    try {
      first.release()
    } catch {}
  })
  assert.throws(
    () => acquireProductionFreshExclusiveLease(leaseOptions(alias)),
    /already active/u
  )
})

test('different repository roots hold independent Production Fresh leases', (t) => {
  const firstRoot = repository(t)
  const secondRoot = repository(t)
  const first = acquireProductionFreshExclusiveLease(leaseOptions(firstRoot))
  const second = acquireProductionFreshExclusiveLease(leaseOptions(secondRoot))
  assert.notEqual(first.leasePath, second.leasePath)
  first.release('failed')
  second.release('complete')
})

test('candidate identity binds commit, worktree fingerprint, target tier, and Production Fresh namespace', () => {
  const base = {
    runId: 'candidate',
    targetTierId: 'production',
    sourceState: {
      commit: 'a'.repeat(40),
      worktreeFingerprint: `sha256:${'b'.repeat(64)}`
    }
  }
  const first = productionFreshLeaseIdentity(base)
  assert.match(first, /^sha256:[a-f0-9]{64}$/u)
  assert.notEqual(first, productionFreshLeaseIdentity({
    ...base,
    sourceState: { ...base.sourceState, commit: 'c'.repeat(40) }
  }))
  assert.notEqual(first, productionFreshLeaseIdentity({
    ...base,
    sourceState: { ...base.sourceState, worktreeFingerprint: `sha256:${'d'.repeat(64)}` }
  }))
  assert.notEqual(first, productionFreshLeaseIdentity({
    ...base,
    targetTierId: 'production-correctness'
  }))
})

test('a dead owner with a current heartbeat remains fail closed', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(leaseOptions(root))
  const ownerFile = path.join(first.leasePath, 'owner.json')
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  owner.pid = 99_999_999
  seal(owner)
  fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`)
  assert.throws(
    () => acquireProductionFreshExclusiveLease(leaseOptions(root)),
    /heartbeat is still live/u
  )
  assert.equal(fs.existsSync(first.leasePath), true)
})

test('terminal receipt is written before lease release', (t) => {
  const root = repository(t)
  const lease = acquireProductionFreshExclusiveLease(leaseOptions(root))
  lease.release('failed')
  assert.equal(fs.existsSync(lease.leasePath), false)
  const receipt = path.join(
    path.dirname(lease.leasePath),
    'terminal-receipts',
    `${lease.owner.leaseId}.json`
  )
  const terminal = JSON.parse(fs.readFileSync(receipt, 'utf8'))
  assert.equal(terminal.state, 'failed')
  assert.equal(terminal.ownerToken, lease.owner.ownerToken)
  assert.match(terminal.contentDigest, /^sha256:[a-f0-9]{64}$/u)
  const completed = acquireProductionFreshExclusiveLease(leaseOptions(root, {
    runId: 'production-fresh-complete'
  }))
  completed.release('complete')
  const completedReceipt = path.join(
    path.dirname(completed.leasePath),
    'terminal-receipts',
    `${completed.owner.leaseId}.json`
  )
  assert.equal(JSON.parse(fs.readFileSync(completedReceipt, 'utf8')).state, 'complete')
})

test('lease remains finalizing while a producer descendant remains', (t) => {
  const root = repository(t)
  let descendants = [{ pid: 42 }]
  const lease = acquireProductionFreshExclusiveLease(leaseOptions(root, {
    verifyDescendants: () => ({ status: 'verified', identities: descendants })
  }))
  assert.throws(() => lease.release(), /producer descendants/u)
  assert.equal(JSON.parse(fs.readFileSync(path.join(lease.leasePath, 'owner.json'), 'utf8')).state, 'finalizing')
  descendants = []
  lease.release()
})

test('corrupt owner fails closed without deleting files or replacing the lease', (t) => {
  const root = repository(t)
  const lease = acquireProductionFreshExclusiveLease(leaseOptions(root))
  const owner = path.join(lease.leasePath, 'owner.json')
  const before = treeDigest(root)
  fs.writeFileSync(owner, '{')
  assert.throws(
    () => acquireProductionFreshExclusiveLease(leaseOptions(root)),
    /owner-unverifiable/u
  )
  assert.deepEqual(treeDigest(root), before)
  assert.equal(fs.existsSync(path.join(root, 'nested/untracked')), true)
})

test('SIGKILL-equivalent dead owner is reclaimed with a stale-owner terminal receipt', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(leaseOptions(root))
  const ownerFile = path.join(first.leasePath, 'owner.json')
  const stale = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  stale.pid = 99_999_999
  stale.processStartIdentity = 'linux:dead-owner'
  fs.writeFileSync(ownerFile, `${JSON.stringify(markStale(stale))}\n`)
  const recovered = acquireProductionFreshExclusiveLease(leaseOptions(root))
  assert.notEqual(recovered.owner.ownerToken, stale.ownerToken)
  const receipt = path.join(
    path.dirname(recovered.leasePath),
    'terminal-receipts',
    `${stale.leaseId}.json`
  )
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).terminalReason, 'stale-owner-reclaimed')
  recovered.release()
})

test('PID reuse with a different process-start identity is reclaimed by shared authority verification', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(leaseOptions(root))
  const ownerFile = path.join(first.leasePath, 'owner.json')
  const reused = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  reused.processStartIdentity = `${reused.processStartIdentity}:reused`
  fs.writeFileSync(ownerFile, `${JSON.stringify(markStale(reused))}\n`)
  const recovered = acquireProductionFreshExclusiveLease(leaseOptions(root))
  assert.notEqual(recovered.owner.ownerToken, reused.ownerToken)
  recovered.release()
})

test('owner token replacement during reclaim compare-and-swap is retained and rejected', (t) => {
  const root = repository(t)
  const first = acquireProductionFreshExclusiveLease(leaseOptions(root))
  const ownerFile = path.join(first.leasePath, 'owner.json')
  const stale = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  stale.pid = 99_999_999
  fs.writeFileSync(ownerFile, `${JSON.stringify(markStale(stale))}\n`)
  assert.throws(
    () => acquireProductionFreshExclusiveLease(leaseOptions(root, {
      beforeReclaimCompare: () => fs.writeFileSync(
        ownerFile,
        `${JSON.stringify(seal({ ...stale, ownerToken: 'replacement-token' }))}\n`
      )
    })),
    /compare-and-swap failed/u
  )
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).ownerToken, 'replacement-token')
  assert.equal(fs.existsSync(first.leasePath), true)
})

test('Unix process-group and Windows Job Object identities use the shared scheduler authority', (t) => {
  const root = repository(t)
  const identity = currentProcessIdentity()
  const unixGroup = collectSchedulerProcessGroupOrJobIdentity(identity)
  assert.equal(unixGroup.status, 'verified')
  const unixLease = acquireProductionFreshExclusiveLease(leaseOptions(root, {
    identity,
    processGroupOrJobIdentity: unixGroup.value
  }))
  assert.equal(verifySchedulerProcessAuthority(unixLease.owner).status, 'active')
  unixLease.release()

  const windowsIdentity = {
    pid: 42,
    processStartIdentity: 'windows:20260727000000.000000+000',
    executableDigest: `sha256:${'3'.repeat(64)}`,
    commandDigest: `sha256:${'4'.repeat(64)}`
  }
  const windowsJob = {
    schema: 'fsusblog.process-group-or-job-identity.v1',
    platform: 'win32',
    kind: 'windows-job-object',
    authorityId: 'job-authority',
    jobName: 'Local\\FsusBlog-Production-Fresh',
    supervisorProcessStartIdentity: windowsIdentity.processStartIdentity,
    ownerProcessStartIdentity: windowsIdentity.processStartIdentity
  }
  const windowsRoot = repository(t)
  const wrapperIdentity = {
    ...windowsIdentity,
    pid: 21,
    processStartIdentity: 'windows:20260726235900.000000+000'
  }
  let windowsJobMembers = [wrapperIdentity, windowsIdentity]
  const windowsLease = acquireProductionFreshExclusiveLease(leaseOptions(windowsRoot, {
    identity: windowsIdentity,
    processGroupOrJobIdentity: windowsJob,
    verifyAuthority: (owner, authority) => verifySchedulerProcessAuthority(owner, authority),
    verifyDescendants: null,
    collectJobMembers: () => ({ status: 'verified', identities: windowsJobMembers })
  }))
  assert.equal(windowsLease.owner.processGroupOrJobIdentity.kind, 'windows-job-object')
  windowsJobMembers = [{
    ...windowsIdentity,
    pid: 84,
    processStartIdentity: 'windows:20260727000100.000000+000'
  }, wrapperIdentity, windowsIdentity]
  assert.throws(
    () => windowsLease.release(),
    /producer descendants remain/u
  )
  assert.equal(fs.existsSync(windowsLease.leasePath), true)
  windowsJobMembers = [wrapperIdentity, windowsIdentity]
  windowsLease.release()
})

test('Windows Job with only the owner in its terminal snapshot writes a receipt and releases', (t) => {
  const root = repository(t)
  const identity = {
    pid: 42,
    processStartIdentity: 'windows:20260727000000.000000+000',
    executableDigest: `sha256:${'3'.repeat(64)}`,
    commandDigest: `sha256:${'4'.repeat(64)}`
  }
  const job = {
    schema: 'fsusblog.process-group-or-job-identity.v1',
    platform: 'win32',
    kind: 'windows-job-object',
    authorityId: 'empty-terminal-job-authority',
    jobName: 'Local\\FsusBlog-Empty-Terminal',
    supervisorProcessStartIdentity: identity.processStartIdentity,
    ownerProcessStartIdentity: identity.processStartIdentity
  }
  let members = [identity]
  const lease = acquireProductionFreshExclusiveLease(leaseOptions(root, {
    identity,
    processGroupOrJobIdentity: job,
    verifyDescendants: null,
    collectJobMembers: () => ({ status: 'verified', identities: members })
  }))
  lease.release()
  assert.equal(fs.existsSync(lease.leasePath), false)
  const receipt = path.join(
    path.dirname(lease.leasePath),
    'terminal-receipts',
    `${lease.owner.leaseId}.json`
  )
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).state, 'complete')
})

test('Windows Job release fails closed when the owner disappears from the member snapshot', (t) => {
  const root = repository(t)
  const identity = {
    pid: 42,
    processStartIdentity: 'windows:20260727000000.000000+000',
    executableDigest: `sha256:${'3'.repeat(64)}`,
    commandDigest: `sha256:${'4'.repeat(64)}`
  }
  const job = {
    schema: 'fsusblog.process-group-or-job-identity.v1',
    platform: 'win32',
    kind: 'windows-job-object',
    authorityId: 'missing-owner-job-authority',
    jobName: 'Local\\FsusBlog-Missing-Owner',
    supervisorProcessStartIdentity: identity.processStartIdentity,
    ownerProcessStartIdentity: identity.processStartIdentity
  }
  let members = [identity]
  const lease = acquireProductionFreshExclusiveLease(leaseOptions(root, {
    identity,
    processGroupOrJobIdentity: job,
    verifyDescendants: null,
    collectJobMembers: () => ({ status: 'verified', identities: members })
  }))
  t.after(() => {
    members = [identity]
    try {
      lease.release('failed')
    } catch {}
  })
  members = []
  assert.throws(
    () => lease.release(),
    /owner process identity is missing or changed/u
  )
  assert.equal(fs.existsSync(lease.leasePath), true)
})

test('Windows Job member query failure blocks before the lease or destructive preflight exists', (t) => {
  const root = repository(t)
  const identity = {
    pid: 42,
    processStartIdentity: 'windows:20260727000000.000000+000',
    executableDigest: `sha256:${'3'.repeat(64)}`,
    commandDigest: `sha256:${'4'.repeat(64)}`
  }
  const job = {
    schema: 'fsusblog.process-group-or-job-identity.v1',
    platform: 'win32',
    kind: 'windows-job-object',
    authorityId: 'unverifiable-job-authority',
    jobName: 'Local\\FsusBlog-Unverifiable',
    supervisorProcessStartIdentity: identity.processStartIdentity,
    ownerProcessStartIdentity: identity.processStartIdentity
  }
  const leaseRoot = path.join(root, '.git/production-fresh-exclusive-leases')
  assert.throws(
    () => acquireProductionFreshExclusiveLease(leaseOptions(root, {
      identity,
      processGroupOrJobIdentity: job,
      verifyDescendants: null,
      collectJobMembers: () => ({
        status: 'unverifiable',
        reason: 'injected Job query failure'
      })
    })),
    /owner-unverifiable: injected Job query failure/u
  )
  assert.equal(fs.existsSync(leaseRoot), false)
  assert.equal(fs.readFileSync(path.join(root, 'tracked'), 'utf8'), 'tracked\n')
})

test('Windows Job member adapter requires a stable double snapshot with full process identities', () => {
  const job = {
    platform: 'win32',
    kind: 'windows-job-object',
    jobName: 'Local\\FsusBlog-Adapter'
  }
  const queries = [
    [42],
    [42, 84],
    [42, 84],
    [42, 84]
  ]
  const result = collectWindowsJobMemberIdentities(job, {
    queryProcessIds: () => ({
      status: 'verified',
      processIds: queries.shift()
    }),
    collectIdentity: (pid) => ({
      status: 'verified',
      pid,
      processStartIdentity: `windows:start:${pid}`,
      executableDigest: `sha256:${'3'.repeat(64)}`,
      commandDigest: `sha256:${'4'.repeat(64)}`
    })
  })
  assert.equal(result.status, 'verified')
  assert.deepEqual(result.identities.map((identity) => identity.pid), [42, 84])
  assert.equal(queries.length, 0)

  let invocation = null
  assert.deepEqual(
    queryWindowsJobProcessIds(job, {
      execute(command, args) {
        invocation = { command, args }
        return '[42,84]'
      }
    }),
    { status: 'verified', processIds: [42, 84] }
  )
  assert.equal(invocation.command, 'powershell.exe')
  assert.equal(invocation.args.at(-1), job.jobName)
  const script = fs.readFileSync(
    path.resolve('tools/test-matrix/windows-job-members.ps1'),
    'utf8'
  )
  assert.match(script, /OpenJobObject/u)
  assert.match(script, /QueryInformationJobObject/u)
  assert.match(script, /Where-Object \{ \$_ -ne \[ulong\]\$PID \}/u)
})
