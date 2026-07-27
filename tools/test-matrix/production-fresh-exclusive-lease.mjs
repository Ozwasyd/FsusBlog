import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  collectSchedulerProcessGroupOrJobIdentity,
  schedulerCandidateIdentityDigest,
  schedulerProcessGroupOrJobIdentityIsComplete,
  verifySchedulerProcessAuthority
} from './scheduler-run-owner.mjs'
import {
  currentProcessIdentity,
  processDescendantIdentities
} from '../test/process-identity.mjs'
import { collectWindowsJobMemberIdentities } from './windows-job-members.mjs'

export const productionFreshLeaseProfile = 'production-fresh'
export const productionFreshLeaseNamespace = 'production-fresh'
export const productionFreshLeaseSchema = 'fsusblog.production-fresh-exclusive-lease.v1'
export const productionFreshLeaseStates = Object.freeze([
  'acquiring',
  'active',
  'finalizing',
  'complete',
  'failed',
  'cancelled'
])

const activeStates = new Set(['acquiring', 'active', 'finalizing'])
const terminalStates = new Set(['complete', 'failed', 'cancelled'])
const reclaimableAuthorityReasons = new Set(['owner-dead', 'owner-mismatch'])
const requiredFields = Object.freeze([
  'schema',
  'leaseId',
  'ownerToken',
  'canonicalRepositoryRoot',
  'profile',
  'candidateIdentityDigest',
  'targetTierId',
  'namespace',
  'pid',
  'processStartIdentity',
  'executableDigest',
  'commandDigest',
  'processGroupOrJobIdentity',
  'createdAt',
  'heartbeatAt',
  'state',
  'contentDigest'
])

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function ownerPayload(owner) {
  const { contentDigest: _contentDigest, ...payload } = owner ?? {}
  return payload
}

function sealOwner(owner) {
  const payload = ownerPayload(owner)
  return {
    ...payload,
    contentDigest: digest(JSON.stringify(canonicalize(payload)))
  }
}

function validDigest(value) {
  return /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ''))
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value))
}

export function productionFreshLeaseOwnerIsComplete(owner, nowMs = Date.now()) {
  return Boolean(
    owner &&
    Object.keys(owner).length === requiredFields.length &&
    requiredFields.every((field) => Object.hasOwn(owner, field)) &&
    owner.schema === productionFreshLeaseSchema &&
    typeof owner.leaseId === 'string' &&
    owner.leaseId.length > 0 &&
    typeof owner.ownerToken === 'string' &&
    owner.ownerToken.length > 0 &&
    typeof owner.canonicalRepositoryRoot === 'string' &&
    owner.canonicalRepositoryRoot.length > 0 &&
    owner.profile === productionFreshLeaseProfile &&
    validDigest(owner.candidateIdentityDigest) &&
    typeof owner.targetTierId === 'string' &&
    owner.targetTierId.length > 0 &&
    owner.namespace === productionFreshLeaseNamespace &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.processStartIdentity === 'string' &&
    owner.processStartIdentity.length > 0 &&
    validDigest(owner.executableDigest) &&
    validDigest(owner.commandDigest) &&
    schedulerProcessGroupOrJobIdentityIsComplete(owner.processGroupOrJobIdentity) &&
    validTimestamp(owner.createdAt) &&
    validTimestamp(owner.heartbeatAt) &&
    Date.parse(owner.createdAt) <= Date.parse(owner.heartbeatAt) &&
    Date.parse(owner.heartbeatAt) <= nowMs &&
    productionFreshLeaseStates.includes(owner.state) &&
    validDigest(owner.contentDigest) &&
    owner.contentDigest === sealOwner(owner).contentDigest
  )
}

function readOwner(ownerFile) {
  try {
    return JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  } catch {
    return null
  }
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx'
  })
  fs.renameSync(temporary, file)
}

function commonGitDirectory(root) {
  const dotGit = path.join(root, '.git')
  if (fs.lstatSync(dotGit).isDirectory()) return fs.realpathSync(dotGit)
  const match = /^gitdir:\s*(.+)\s*$/u.exec(fs.readFileSync(dotGit, 'utf8'))
  if (!match) throw new Error(`production fresh lease cannot resolve Git directory: ${dotGit}`)
  const gitDirectory = fs.realpathSync(path.resolve(root, match[1]))
  const commonDirectoryFile = path.join(gitDirectory, 'commondir')
  return fs.existsSync(commonDirectoryFile)
    ? fs.realpathSync(path.resolve(gitDirectory, fs.readFileSync(commonDirectoryFile, 'utf8').trim()))
    : gitDirectory
}

export function productionFreshLeaseIdentity({
  runId,
  targetTierId,
  sourceState
}) {
  const commit = String(sourceState?.commit ?? '').trim()
  const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim()
  if (!['production-correctness', 'production'].includes(targetTierId)) {
    throw new Error(`Production Fresh lease target tier is invalid: ${targetTierId}`)
  }
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/u.test(commit)) {
    throw new Error('Production Fresh lease requires a real Git commit identity')
  }
  if (!/^(sha256:)?[a-f0-9]{64}$/u.test(worktreeFingerprint)) {
    throw new Error('Production Fresh lease requires a real worktree fingerprint')
  }
  return schedulerCandidateIdentityDigest({
    runId,
    targetTierId,
    namespace: productionFreshLeaseNamespace,
    sourceState: { commit, worktreeFingerprint }
  })
}

function acquireCasMarker(leasePath, owner, operation) {
  const markerFile = path.join(leasePath, 'owner-cas.json')
  const marker = {
    schema: 'fsusblog.production-fresh-exclusive-lease-cas.v1',
    operation,
    ownerToken: owner.ownerToken,
    ownerContentDigest: owner.contentDigest
  }
  try {
    fs.writeFileSync(markerFile, `${JSON.stringify(marker)}\n`, {
      mode: 0o600,
      flag: 'wx'
    })
    return markerFile
  } catch (error) {
    if (['EEXIST', 'ENOENT'].includes(error?.code)) return null
    throw error
  }
}

function removeCasMarker(markerFile) {
  if (!markerFile) return
  try {
    fs.rmSync(markerFile, { force: true })
  } catch {}
}

function ownerExactMatches(expected, actual) {
  return Boolean(
    productionFreshLeaseOwnerIsComplete(expected) &&
    productionFreshLeaseOwnerIsComplete(actual) &&
    expected.ownerToken === actual.ownerToken &&
    expected.contentDigest === actual.contentDigest
  )
}

function selfAuthority(identity, processGroupOrJobIdentity) {
  return {
    processStatus(owner) {
      return owner.pid === identity.pid &&
        owner.processStartIdentity === identity.processStartIdentity &&
        owner.executableDigest === identity.executableDigest &&
        owner.commandDigest === identity.commandDigest
        ? { status: 'live', actual: identity }
        : { status: 'mismatch', actual: identity }
    },
    groupOrJobStatus(owner) {
      return JSON.stringify(owner.processGroupOrJobIdentity) === JSON.stringify(processGroupOrJobIdentity)
        ? { status: 'verified', value: processGroupOrJobIdentity }
        : { status: 'mismatch', value: processGroupOrJobIdentity }
    }
  }
}

function windowsJobOwnerIsPresent(owner, members) {
  return members.some((identity) => (
    identity.pid === owner.pid &&
    identity.processStartIdentity === owner.processStartIdentity &&
    identity.executableDigest === owner.executableDigest &&
    identity.commandDigest === owner.commandDigest
  ))
}

function sameProcessIdentity(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.executableDigest === right.executableDigest &&
    left.commandDigest === right.commandDigest
  )
}

function productionFreshLeaseDescendants(owner, collectJobMembers, baselineJobMembers) {
  if (owner.processGroupOrJobIdentity.kind !== 'windows-job-object') {
    return processDescendantIdentities(owner)
  }
  const members = collectJobMembers(owner.processGroupOrJobIdentity)
  if (members?.status !== 'verified' || !Array.isArray(members.identities)) {
    return {
      status: 'unverifiable',
      reason: members?.reason ?? 'Windows Job member identities are unavailable'
    }
  }
  const ownerMember = members.identities.find((identity) => identity.pid === owner.pid)
  if (!ownerMember || !windowsJobOwnerIsPresent(owner, [ownerMember])) {
    return {
      status: 'unverifiable',
      reason: 'Windows Job owner process identity is missing or changed'
    }
  }
  return {
    status: 'verified',
    identities: members.identities.filter((identity) => (
      !baselineJobMembers.some((baseline) => sameProcessIdentity(baseline, identity))
    ))
  }
}

function archiveTerminalOwner(leaseRoot, owner, reason = null) {
  const directory = path.join(leaseRoot, 'terminal-receipts')
  const file = path.join(directory, `${owner.leaseId}.json`)
  const terminal = sealOwner({
    ...owner,
    ...(reason ? { terminalReason: reason } : {}),
    terminalAt: owner.heartbeatAt
  })
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(file, `${JSON.stringify(terminal, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx'
    })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = readOwner(file)
    if (existing?.contentDigest !== terminal.contentDigest) {
      throw new Error('production fresh lease terminal receipt identity mismatch')
    }
  }
  return file
}

function reclaimInactiveOwner({
  leasePath,
  leaseRoot,
  ownerFile,
  expectedOwner,
  beforeReclaimCompare,
  now
}) {
  const markerFile = acquireCasMarker(leasePath, expectedOwner, 'reclaim')
  if (!markerFile) return false
  let tombstone = null
  try {
    beforeReclaimCompare?.({ ownerFile, active: expectedOwner })
    const confirmedOwner = readOwner(ownerFile)
    if (!ownerExactMatches(expectedOwner, confirmedOwner)) {
      throw new Error('production fresh lease reclaim compare-and-swap failed')
    }
    const timestamp = new Date(now()).toISOString()
    const terminal = sealOwner({
      ...confirmedOwner,
      state: 'failed',
      heartbeatAt: timestamp
    })
    atomicWriteJson(ownerFile, terminal)
    archiveTerminalOwner(leaseRoot, terminal, 'stale-owner-reclaimed')
    tombstone = `${leasePath}.reclaimed-${confirmedOwner.ownerToken}-${randomUUID()}`
    fs.renameSync(leasePath, tombstone)
    const reclaimedOwner = readOwner(path.join(tombstone, 'owner.json'))
    if (!ownerExactMatches(terminal, reclaimedOwner)) {
      if (!fs.existsSync(leasePath)) fs.renameSync(tombstone, leasePath)
      tombstone = null
      throw new Error('production fresh lease reclaim post-compare-and-swap failed')
    }
  } finally {
    if (!tombstone) removeCasMarker(markerFile)
  }
  fs.rmSync(tombstone, { recursive: true, force: true })
  return true
}

export function acquireProductionFreshExclusiveLease({
  root,
  runId,
  targetTierId,
  sourceState,
  candidateIdentityDigest = productionFreshLeaseIdentity({ runId, targetTierId, sourceState }),
  identity = currentProcessIdentity(),
  processGroupOrJobIdentity = null,
  collectGroupOrJobIdentity = collectSchedulerProcessGroupOrJobIdentity,
  verifyAuthority = verifySchedulerProcessAuthority,
  verifyDescendants = null,
  collectJobMembers = collectWindowsJobMemberIdentities,
  beforeReclaimCompare = null,
  heartbeatStaleMs = 15_000,
  heartbeatEveryMs = 1_000,
  now = () => Date.now()
}) {
  const canonicalRepositoryRoot = fs.realpathSync(root)
  const leaseKey = digest(JSON.stringify({
    canonicalRepositoryRoot,
    profile: productionFreshLeaseProfile
  }))
  const leaseRoot = path.join(commonGitDirectory(canonicalRepositoryRoot), 'production-fresh-exclusive-leases')
  const leasePath = path.join(leaseRoot, leaseKey.slice('sha256:'.length))
  const ownerFile = path.join(leasePath, 'owner.json')
  const groupOrJob = processGroupOrJobIdentity
    ? { status: 'verified', value: processGroupOrJobIdentity }
    : collectGroupOrJobIdentity(identity)
  if (
    groupOrJob.status !== 'verified' ||
    !schedulerProcessGroupOrJobIdentityIsComplete(groupOrJob.value)
  ) {
    throw new Error(
      `production fresh lease owner-unverifiable: ${
        groupOrJob.reason ?? 'process group or Job Object identity unavailable'
      }`
    )
  }
  const timestamp = new Date(now()).toISOString()
  const owner = sealOwner({
    schema: productionFreshLeaseSchema,
    leaseId: randomUUID(),
    ownerToken: randomUUID(),
    canonicalRepositoryRoot,
    profile: productionFreshLeaseProfile,
    candidateIdentityDigest,
    targetTierId,
    namespace: productionFreshLeaseNamespace,
    pid: identity.pid,
    processStartIdentity: identity.processStartIdentity,
    executableDigest: identity.executableDigest,
    commandDigest: identity.commandDigest,
    processGroupOrJobIdentity: groupOrJob.value,
    createdAt: timestamp,
    heartbeatAt: timestamp,
    state: 'acquiring'
  })
  if (!productionFreshLeaseOwnerIsComplete(owner, now())) {
    throw new Error('production fresh lease owner-unverifiable: candidate identity is incomplete')
  }
  let baselineJobMembers = null
  if (groupOrJob.value.kind === 'windows-job-object') {
    const members = collectJobMembers(groupOrJob.value)
    if (members?.status !== 'verified' || !Array.isArray(members.identities)) {
      throw new Error(
        `production fresh lease owner-unverifiable: ${
          members?.reason ?? 'Windows Job member query is unavailable'
        }`
      )
    }
    if (!windowsJobOwnerIsPresent(owner, members.identities)) {
      throw new Error('production fresh lease owner-unverifiable: owner is not a verified Windows Job member')
    }
    baselineJobMembers = members.identities
  }

  fs.mkdirSync(leaseRoot, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let createdLease = false
    try {
      fs.mkdirSync(leasePath, { mode: 0o700 })
      createdLease = true
      atomicWriteJson(ownerFile, owner)
      break
    } catch (error) {
      if (createdLease) fs.rmSync(leasePath, { recursive: true, force: true })
      if (error?.code !== 'EEXIST') throw error
      const active = readOwner(ownerFile)
      if (!productionFreshLeaseOwnerIsComplete(active, now())) {
        throw new Error('production fresh lease owner-unverifiable')
      }
      if (terminalStates.has(active.state)) {
        throw new Error('production fresh lease owner-unverifiable: terminal owner was not released')
      }
      const authority = verifyAuthority(active)
      if (authority.status === 'active') {
        throw new Error(`production fresh lease already active: ${JSON.stringify(active)}`)
      }
      if (authority.status !== 'inactive') {
        throw new Error(`production fresh lease owner-unverifiable: ${authority.reason}`)
      }
      if (!reclaimableAuthorityReasons.has(authority.reason)) {
        throw new Error(`production fresh lease owner-unverifiable: ${authority.reason}`)
      }
      const heartbeatAt = Date.parse(active.heartbeatAt)
      if (!Number.isFinite(heartbeatAt) || now() - heartbeatAt < heartbeatStaleMs) {
        throw new Error('production fresh lease stale owner heartbeat is still live')
      }
      if (!reclaimInactiveOwner({
        leasePath,
        leaseRoot,
        ownerFile,
        expectedOwner: active,
        beforeReclaimCompare,
        now
      })) {
        throw new Error('production fresh lease reclaim contention')
      }
      if (attempt === 2) throw new Error('production fresh lease acquisition contention')
    }
  }

  const authority = selfAuthority(identity, groupOrJob.value)
  function updateState(state) {
    const markerFile = acquireCasMarker(leasePath, owner, 'heartbeat')
    if (!markerFile) return false
    try {
      const current = readOwner(ownerFile)
      if (!ownerExactMatches(owner, current) || !activeStates.has(current.state)) return false
      const verification = verifyAuthority(current, authority)
      if (verification.status !== 'active') return false
      const next = sealOwner({
        ...current,
        heartbeatAt: new Date(now()).toISOString(),
        state
      })
      atomicWriteJson(ownerFile, next)
      Object.assign(owner, next)
      return true
    } finally {
      removeCasMarker(markerFile)
    }
  }
  if (!updateState('active')) {
    throw new Error('production fresh lease failed to enter active state')
  }
  let stopped = false
  const heartbeat = setInterval(() => {
    if (!stopped) updateState(owner.state)
  }, Math.max(1, heartbeatEveryMs))
  heartbeat.unref?.()

  return {
    owner,
    leasePath,
    release(state = 'complete') {
      if (!terminalStates.has(state)) {
        throw new Error('production fresh lease terminal state is invalid')
      }
      if (!updateState('finalizing')) {
        throw new Error('production fresh lease owner changed before finalizing')
      }
      const descendants = verifyDescendants
        ? verifyDescendants(owner)
        : productionFreshLeaseDescendants(owner, collectJobMembers, baselineJobMembers)
      if (!descendants || descendants.status === 'unverifiable') {
        throw new Error(
          `production fresh lease descendants are unverifiable: ${descendants?.reason ?? 'missing result'}`
        )
      }
      const activeDescendants = Array.isArray(descendants)
        ? descendants
        : descendants.identities
      if (activeDescendants.length > 0) {
        throw new Error('production fresh lease cannot release while producer descendants remain')
      }
      stopped = true
      clearInterval(heartbeat)
      const markerFile = acquireCasMarker(leasePath, owner, 'finalize')
      if (!markerFile) throw new Error('production fresh lease terminal compare-and-swap contention')
      let tombstone = null
      try {
        const current = readOwner(ownerFile)
        if (!ownerExactMatches(owner, current) || current.state !== 'finalizing') {
          throw new Error('production fresh lease owner changed before terminal receipt')
        }
        const terminal = sealOwner({
          ...current,
          heartbeatAt: new Date(now()).toISOString(),
          state
        })
        atomicWriteJson(ownerFile, terminal)
        Object.assign(owner, terminal)
        archiveTerminalOwner(leaseRoot, terminal)
        tombstone = `${leasePath}.terminal-${terminal.ownerToken}-${randomUUID()}`
        fs.renameSync(leasePath, tombstone)
        const releasedOwner = readOwner(path.join(tombstone, 'owner.json'))
        if (!ownerExactMatches(terminal, releasedOwner)) {
          if (!fs.existsSync(leasePath)) fs.renameSync(tombstone, leasePath)
          tombstone = null
          throw new Error('production fresh lease terminal post-compare-and-swap failed')
        }
      } finally {
        if (!tombstone) removeCasMarker(markerFile)
      }
      fs.rmSync(tombstone, { recursive: true, force: true })
    }
  }
}
