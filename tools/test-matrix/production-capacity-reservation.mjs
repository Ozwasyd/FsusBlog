import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  currentProcessIdentity,
  processGroupMemberIdentities,
  processIdentityStatus
} from '../test/process-identity.mjs'
import {
  collectSchedulerProcessGroupOrJobIdentity,
  schedulerProcessGroupOrJobIdentityIsComplete
} from './scheduler-run-owner.mjs'
import { collectWindowsJobMemberIdentities } from './windows-job-members.mjs'
import {
  producerRemainingDiskDemand,
  productionDiskDemandDigest
} from './production-disk-demand.mjs'

export const productionCapacityReservationSchema = 'fsusblog.production-capacity-reservation.v1'
export const productionCapacityReleaseSchema = 'fsusblog.production-capacity-release.v1'
const activeStates = new Set(['prepared', 'active', 'releasing', 'recovery-required'])
const preflightActionNames = Object.freeze([
  'runtimeKillOrRemove',
  'containerRemove',
  'tempOrOutputDeletion',
  'checkpointDeletion',
  'logDeletion',
  'cacheRenameOrDelete',
  'buildRootMutation',
  'staleBuildGcSpawn',
  'physicalProducerSpawn'
])

export function productionCapacityPreflightActionCounts() {
  return Object.fromEntries(preflightActionNames.map((name) => [name, 0]))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function seal(value) {
  const { contentDigest: _contentDigest, ...payload } = value
  return { ...payload, contentDigest: productionDiskDemandDigest(canonicalize(payload)) }
}

function fsyncPath(candidate) {
  const descriptor = fs.openSync(candidate, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function atomicWrite(file, value, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (exclusive) {
    fs.writeFileSync(file, serialized, { mode: 0o600, flag: 'wx' })
    fsyncPath(file)
    fsyncPath(path.dirname(file))
    return
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, serialized, {
    mode: 0o600,
    flag: 'wx'
  })
  fsyncPath(temporary)
  fs.renameSync(temporary, file)
  fsyncPath(path.dirname(file))
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function safeIdentity(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)
}

function processOwnerIdentityIsComplete(owner) {
  return Boolean(owner)
    && Number.isInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.processStartIdentity === 'string'
    && owner.processStartIdentity.length > 0
    && typeof owner.executablePath === 'string'
    && owner.executablePath.length > 0
    && /^sha256:[a-f0-9]{64}$/u.test(owner.executableDigest ?? '')
    && /^sha256:[a-f0-9]{64}$/u.test(owner.commandDigest ?? '')
}

function receiptIsComplete(receipt) {
  if (!receipt || receipt.schema !== productionCapacityReservationSchema
    || !safeIdentity(receipt.reservationId)
    || !safeIdentity(receipt.runId)
    || typeof receipt.ownerToken !== 'string' || receipt.ownerToken.length < 16
    || !/^sha256:[a-f0-9]{64}$/u.test(receipt.candidateIdentityDigest ?? '')
    || !/^sha256:[a-f0-9]{64}$/u.test(receipt.repositoryIdentity ?? '')
    || !/^sha256:[a-f0-9]{64}$/u.test(receipt.planDigest ?? '')
    || !/^sha256:[a-f0-9]{64}$/u.test(receipt.producerDeclarationDigest ?? '')
    || !Array.isArray(receipt.filesystems) || receipt.filesystems.length === 0
    || !Number.isFinite(Date.parse(receipt.createdAt))
    || !Number.isFinite(Date.parse(receipt.heartbeatAt))
    || !['prepared', 'active', 'releasing', 'released', 'recovery-required', 'aborted'].includes(receipt.state)
    || receipt.contentDigest !== seal(receipt).contentDigest) return false
  const owner = receipt.ownerIdentity
  if (!processOwnerIdentityIsComplete(owner)
    || !schedulerProcessGroupOrJobIdentityIsComplete(receipt.processGroupOrJobIdentity)
    || typeof receipt.repositoryLeaseOwnerToken !== 'string'
    || !receipt.repositoryLeaseOwnerToken) return false
  if (JSON.stringify(receipt.preflightActionCounts) !== JSON.stringify(productionCapacityPreflightActionCounts())) {
    return false
  }
  return receipt.filesystems.every((entry) => (
    typeof entry.filesystemIdentity === 'string' && entry.filesystemIdentity
    && ['admitted', 'released', 'recovery-required', 'aborted'].includes(entry.status)
    && ['observedFreeBytes', 'activeReservedBytesBefore', 'requestedBytes', 'safetyBytes', 'admittedBytes']
      .every((field) => Number.isSafeInteger(entry[field]) && entry[field] >= 0)
  ))
}

function reservationRootDefault() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return path.join(os.tmpdir(), `fsus-production-capacity-authority-${uid}`)
}

function acquireAuthorityLock(authorityRoot, {
  now = Date.now,
  timeoutMs = 10_000,
  ownerIdentity = currentProcessIdentity()
} = {}) {
  fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 })
  const lock = path.join(authorityRoot, 'authority.lock')
  const deadline = now() + timeoutMs
  for (;;) {
    const ownerToken = randomUUID()
    const candidate = path.join(authorityRoot, `.authority-lock-${ownerToken}`)
    try {
      fs.mkdirSync(candidate, { mode: 0o700 })
      const owner = seal({
        schema: 'fsusblog.production-capacity-authority-lock.v1',
        ownerToken,
        ownerIdentity,
        createdAt: new Date(now()).toISOString()
      })
      atomicWrite(path.join(candidate, 'owner.json'), owner, { exclusive: true })
      fs.renameSync(candidate, lock)
      fsyncPath(authorityRoot)
      return () => {
        const current = readJson(path.join(lock, 'owner.json'))
        if (current?.contentDigest !== seal(current).contentDigest
          || current.ownerToken !== ownerToken) {
          throw new Error('Production capacity reservation authority lock owner changed')
        }
        const tombstone = path.join(authorityRoot, `.released-authority-lock-${ownerToken}`)
        fs.renameSync(lock, tombstone)
        fs.rmSync(tombstone, { recursive: true, force: true })
        fsyncPath(authorityRoot)
      }
    } catch (error) {
      fs.rmSync(candidate, { recursive: true, force: true })
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
      const current = readJson(path.join(lock, 'owner.json'))
      if (!current
        || current.schema !== 'fsusblog.production-capacity-authority-lock.v1'
        || !safeIdentity(current.ownerToken)
        || !processOwnerIdentityIsComplete(current.ownerIdentity)
        || current.contentDigest !== seal(current).contentDigest) {
        throw new Error('Production capacity reservation authority lock is invalid or tampered')
      }
      const status = processIdentityStatus(current.ownerIdentity)
      if (status.status === 'dead' || status.status === 'mismatch') {
        const tombstone = path.join(authorityRoot, `.stale-authority-lock-${current.ownerToken}`)
        try {
          fs.renameSync(lock, tombstone)
          fs.rmSync(tombstone, { recursive: true, force: true })
          fsyncPath(authorityRoot)
          continue
        } catch (recoveryError) {
          if (recoveryError?.code === 'ENOENT') continue
          throw recoveryError
        }
      }
      if (status.status !== 'live') {
        throw new Error('Production capacity reservation authority lock owner is unverifiable')
      }
      if (now() >= deadline) throw new Error('Production capacity reservation authority is busy')
    }
  }
}

function processAuthority(receipt) {
  const status = processIdentityStatus(receipt.ownerIdentity)
  if (status.status === 'live') return { status: 'live' }
  const members = receipt.processGroupOrJobIdentity.kind === 'windows-job-object'
    ? collectWindowsJobMemberIdentities(receipt.processGroupOrJobIdentity)
    : processGroupMemberIdentities(receipt.processGroupOrJobIdentity)
  if (members.status !== 'verified') return { status: 'unknown', reason: members.reason }
  const residuals = members.identities.filter((identity) => (
    identity.pid !== receipt.ownerIdentity.pid
    || identity.processStartIdentity !== receipt.ownerIdentity.processStartIdentity
  ))
  if (residuals.length > 0) return { status: 'process-tree-live', identities: residuals }
  return ['dead', 'exited'].includes(status.status)
    ? { status: 'terminal' }
    : { status: 'identity-mismatch', actual: status.actual }
}

function activeReservationFiles(authorityRoot) {
  const directory = path.join(authorityRoot, 'active')
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(directory, name))
    .sort()
}

function recoverOrBlock(file, receipt, {
  verifyOwner = processAuthority,
  now = () => Date.now()
} = {}) {
  if (!receiptIsComplete(receipt)) throw new Error(`Production capacity reservation journal is invalid or tampered: ${file}`)
  if (!activeStates.has(receipt.state)) return null
  const authority = verifyOwner(receipt)
  if (authority.status === 'live' || authority.status === 'process-tree-live') return receipt
  if (authority.status !== 'terminal') {
    const recoveryRequired = seal({
      ...receipt,
      state: 'recovery-required',
      heartbeatAt: new Date(now()).toISOString(),
      filesystems: receipt.filesystems.map((entry) => ({ ...entry, status: 'recovery-required' }))
    })
    atomicWrite(file, recoveryRequired)
    return recoveryRequired
  }
  const aborted = seal({
    ...receipt,
    state: 'aborted',
    heartbeatAt: new Date(now()).toISOString(),
    filesystems: receipt.filesystems.map((entry) => ({ ...entry, status: 'aborted' }))
  })
  atomicWrite(file, aborted)
  const terminalFile = path.join(path.dirname(path.dirname(file)), 'terminal', `${receipt.reservationId}.json`)
  atomicWrite(terminalFile, aborted)
  fs.rmSync(file, { force: true })
  return null
}

function activeReservedByFilesystem(authorityRoot, options) {
  const totals = new Map()
  for (const file of activeReservationFiles(authorityRoot)) {
    const active = recoverOrBlock(file, readJson(file), options)
    if (!active || !activeStates.has(active.state)) continue
    for (const filesystem of active.filesystems) {
      totals.set(filesystem.filesystemIdentity,
        (totals.get(filesystem.filesystemIdentity) ?? 0) + filesystem.admittedBytes)
    }
  }
  return totals
}

export function acquireProductionCapacityReservation({
  plan,
  runId,
  candidateIdentityDigest,
  repositoryRoot,
  repositoryLeaseOwner,
  authorityRoot = process.env.FSUS_PRODUCTION_CAPACITY_AUTHORITY_ROOT || reservationRootDefault(),
  ownerIdentity = currentProcessIdentity(),
  verifyOwner,
  measureAvailable = (filesystem) => {
    const stats = fs.statfsSync(filesystem.canonicalPaths[0])
    return Number(stats.bavail) * Number(stats.bsize)
  },
  now = () => Date.now(),
  randomId = randomUUID,
  heartbeatEveryMs = 5_000
}) {
  if (!Number.isFinite(heartbeatEveryMs) || heartbeatEveryMs <= 0) {
    throw new Error('Production capacity reservation heartbeat interval must be positive')
  }
  const resolvedAuthorityRoot = path.resolve(authorityRoot)
  const forbiddenRoots = [
    repositoryRoot,
    path.join(repositoryRoot, '.tmp'),
    path.join(repositoryRoot, 'src/frontend/coverage'),
    path.join(repositoryRoot, 'src/frontend/test-results'),
    path.join(repositoryRoot, 'src/backend/Logs')
  ].map((entry) => path.resolve(entry))
  if (forbiddenRoots.some((entry) => resolvedAuthorityRoot === entry
    || resolvedAuthorityRoot.startsWith(`${entry}${path.sep}`))) {
    throw new Error('Production capacity reservation authority must be outside every Fresh cleanup and data root')
  }
  fs.mkdirSync(resolvedAuthorityRoot, { recursive: true, mode: 0o700 })
  const authorityMetadata = fs.lstatSync(resolvedAuthorityRoot)
  if (authorityMetadata.isSymbolicLink()
    || !authorityMetadata.isDirectory()
    || fs.realpathSync.native(resolvedAuthorityRoot) !== resolvedAuthorityRoot
    || (authorityMetadata.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && authorityMetadata.uid !== process.getuid())) {
    throw new Error('Production capacity reservation authority ownership/path is unsafe')
  }
  if (!repositoryLeaseOwner?.ownerToken) {
    throw new Error('Production capacity reservation requires the repository exclusive lease owner')
  }
  const groupOrJob = collectSchedulerProcessGroupOrJobIdentity(ownerIdentity)
  if (groupOrJob.status !== 'verified'
    || !schedulerProcessGroupOrJobIdentityIsComplete(groupOrJob.value)) {
    throw new Error(`Production capacity owner process tree/Job Object is unverifiable: ${groupOrJob.reason ?? 'incomplete identity'}`)
  }
  const releaseLock = acquireAuthorityLock(resolvedAuthorityRoot, { now })
  let receipt
  let activeFile
  try {
    const activeReserved = activeReservedByFilesystem(resolvedAuthorityRoot, { verifyOwner, now })
    const reservationId = `reservation-${randomId()}`
    const ownerToken = randomId()
    const timestamp = new Date(now()).toISOString()
    const filesystems = plan.filesystems.map((entry) => {
      const activeReservedBytesBefore = activeReserved.get(entry.filesystemIdentity) ?? 0
      const admittedBytes = entry.requestedBytes + entry.safetyBytes
      const observedFreeBytes = measureAvailable(entry)
      if (!Number.isSafeInteger(observedFreeBytes) || observedFreeBytes < 0) {
        throw new Error(`Production capacity is unknown for ${entry.filesystemIdentity}`)
      }
      return {
        filesystemIdentity: entry.filesystemIdentity,
        observedFreeBytes,
        activeReservedBytesBefore,
        requestedBytes: entry.requestedBytes,
        safetyBytes: entry.safetyBytes,
        admittedBytes,
        status: 'admitted'
      }
    })
    const shortages = filesystems.filter((entry) => (
      entry.observedFreeBytes - entry.activeReservedBytesBefore < entry.admittedBytes
    ))
    if (shortages.length > 0) {
      const rejected = seal({
        schema: productionCapacityReservationSchema,
        reservationId,
        runId,
        candidateIdentityDigest,
        repositoryIdentity: productionDiskDemandDigest(path.resolve(repositoryRoot)),
        ownerIdentity,
        processGroupOrJobIdentity: groupOrJob.value,
        ownerToken,
        repositoryLeaseOwnerToken: repositoryLeaseOwner.ownerToken,
        planDigest: plan.planDigest,
        producerDeclarationDigest: plan.producerDeclarationDigest,
        preflightActionCounts: productionCapacityPreflightActionCounts(),
        filesystems: filesystems.map((entry) => ({ ...entry, status: 'aborted' })),
        createdAt: timestamp,
        heartbeatAt: timestamp,
        state: 'aborted',
        terminalReason: 'capacity-admission-failed'
      })
      const rejectionFile = path.join(resolvedAuthorityRoot, 'terminal', `${reservationId}.json`)
      atomicWrite(rejectionFile, rejected, { exclusive: true })
      const details = shortages.map((entry) => (
        `${entry.filesystemIdentity}: free=${entry.observedFreeBytes} `
        + `reserved=${entry.activeReservedBytesBefore} requested=${entry.requestedBytes} safety=${entry.safetyBytes}`
      )).join('; ')
      const error = new Error(`Production capacity admission failed for ${details}`)
      error.code = 'PRODUCTION_CAPACITY_ADMISSION_FAILED'
      error.preflightActionCounts = productionCapacityPreflightActionCounts()
      error.receiptFile = rejectionFile
      error.receiptDigest = rejected.contentDigest
      throw error
    }
    receipt = seal({
      schema: productionCapacityReservationSchema,
      reservationId,
      runId,
      candidateIdentityDigest,
      repositoryIdentity: productionDiskDemandDigest(path.resolve(repositoryRoot)),
      ownerIdentity,
      processGroupOrJobIdentity: groupOrJob.value,
      ownerToken,
      repositoryLeaseOwnerToken: repositoryLeaseOwner.ownerToken,
      planDigest: plan.planDigest,
      producerDeclarationDigest: plan.producerDeclarationDigest,
      preflightActionCounts: productionCapacityPreflightActionCounts(),
      filesystems,
      createdAt: timestamp,
      heartbeatAt: timestamp,
      state: 'prepared'
    })
    activeFile = path.join(resolvedAuthorityRoot, 'active', `${reservationId}.json`)
    atomicWrite(activeFile, receipt, { exclusive: true })
    receipt = seal({ ...receipt, state: 'active', heartbeatAt: new Date(now()).toISOString() })
    atomicWrite(activeFile, receipt)
  } finally {
    releaseLock()
  }

  const immutableReceiptDigest = productionDiskDemandDigest({
    reservationId: receipt.reservationId,
    runId: receipt.runId,
    candidateIdentityDigest: receipt.candidateIdentityDigest,
    repositoryIdentity: receipt.repositoryIdentity,
    ownerIdentity: receipt.ownerIdentity,
    processGroupOrJobIdentity: receipt.processGroupOrJobIdentity,
    ownerToken: receipt.ownerToken,
    repositoryLeaseOwnerToken: receipt.repositoryLeaseOwnerToken,
    planDigest: receipt.planDigest,
    producerDeclarationDigest: receipt.producerDeclarationDigest,
    preflightActionCounts: receipt.preflightActionCounts,
    filesystems: receipt.filesystems.map(({ status: _status, ...entry }) => entry),
    createdAt: receipt.createdAt
  })
  const compareOwner = () => {
    const current = readJson(activeFile)
    const currentImmutableDigest = current && productionDiskDemandDigest({
      reservationId: current.reservationId,
      runId: current.runId,
      candidateIdentityDigest: current.candidateIdentityDigest,
      repositoryIdentity: current.repositoryIdentity,
      ownerIdentity: current.ownerIdentity,
      processGroupOrJobIdentity: current.processGroupOrJobIdentity,
      ownerToken: current.ownerToken,
      repositoryLeaseOwnerToken: current.repositoryLeaseOwnerToken,
      planDigest: current.planDigest,
      producerDeclarationDigest: current.producerDeclarationDigest,
      preflightActionCounts: current.preflightActionCounts,
      filesystems: current.filesystems?.map(({ status: _status, ...entry }) => entry),
      createdAt: current.createdAt
    })
    if (!receiptIsComplete(current)
      || current.ownerToken !== receipt.ownerToken
      || current.reservationId !== receipt.reservationId
      || current.state !== 'active'
      || currentImmutableDigest !== immutableReceiptDigest) {
      throw new Error('Production capacity reservation compare-owner-token failed')
    }
    return current
  }
  const heartbeat = () => {
    const release = acquireAuthorityLock(resolvedAuthorityRoot, { now })
    try {
      const current = compareOwner()
      receipt = seal({ ...current, heartbeatAt: new Date(now()).toISOString() })
      atomicWrite(activeFile, receipt)
      return receipt
    } finally {
      release()
    }
  }
  const assertPlan = (currentPlan) => {
    if (currentPlan.planDigest !== receipt.planDigest
      || currentPlan.producerDeclarationDigest !== receipt.producerDeclarationDigest
      || candidateIdentityDigest !== receipt.candidateIdentityDigest) {
      throw new Error('Production capacity reservation plan/candidate/declaration drift requires a new reservation')
    }
  }
  const producerBaselines = new Map()
  let heartbeatFailure = null
  const guardProducer = (producerId, {
    measureAvailable = (filesystem) => {
      const candidate = plan.filesystems.find((entry) => entry.filesystemIdentity === filesystem)
      if (!candidate) throw new Error(`Production capacity filesystem is unknown: ${filesystem}`)
      const stats = fs.statfsSync(candidate.canonicalPaths[0])
      return Number(stats.bavail) * Number(stats.bsize)
    }
  } = {}) => {
    if (heartbeatFailure) {
      throw new Error(`Production capacity reservation heartbeat failed: ${heartbeatFailure.message}`, {
        cause: heartbeatFailure
      })
    }
    heartbeat()
    const remaining = producerRemainingDiskDemand(plan, producerId)
    const release = acquireAuthorityLock(resolvedAuthorityRoot, { now })
    try {
      const activeReserved = activeReservedByFilesystem(resolvedAuthorityRoot, { verifyOwner, now })
      const observed = {}
      for (const [filesystemIdentity, requestedBytes] of remaining) {
        const currentFreeBytes = measureAvailable(filesystemIdentity)
        observed[filesystemIdentity] = currentFreeBytes
        const own = receipt.filesystems.find((entry) => entry.filesystemIdentity === filesystemIdentity)?.admittedBytes ?? 0
        const otherReservedBytes = Math.max(0, (activeReserved.get(filesystemIdentity) ?? 0) - own)
        const rollbackBytes = plan.producerDeclarations
          .filter((entry) => entry.producerId === producerId)
          .filter((entry) => plan.filesystems.find((filesystem) => (
            filesystem.filesystemIdentity === filesystemIdentity
            && filesystem.rootIds.includes(entry.rootId)
          )))
          .reduce((total, entry) => total + entry.rollbackOrRecoveryBytes, 0)
        if (currentFreeBytes - otherReservedBytes < requestedBytes + rollbackBytes) {
          const error = new Error(
            `Production capacity live guard blocked ${producerId}: external-capacity-loss on ${filesystemIdentity}`
          )
          error.code = 'EXTERNAL_CAPACITY_LOSS'
          throw error
        }
      }
      producerBaselines.set(producerId, observed)
      return { producerId, status: 'admitted', checkedAt: new Date(now()).toISOString() }
    } finally {
      release()
    }
  }
  const completeProducer = (producerId, {
    measureAvailable = (filesystem) => {
      const candidate = plan.filesystems.find((entry) => entry.filesystemIdentity === filesystem)
      if (!candidate) throw new Error(`Production capacity filesystem is unknown: ${filesystem}`)
      const stats = fs.statfsSync(candidate.canonicalPaths[0])
      return Number(stats.bavail) * Number(stats.bsize)
    }
  } = {}) => {
    const baseline = producerBaselines.get(producerId)
    if (!baseline) throw new Error(`Production capacity producer ${producerId} has no admission baseline`)
    const declarations = plan.producerDeclarations.filter((entry) => entry.producerId === producerId)
    for (const filesystem of plan.filesystems) {
      if (!Object.hasOwn(baseline, filesystem.filesystemIdentity)) continue
      const declaredGrowth = declarations
        .filter((entry) => filesystem.rootIds.includes(entry.rootId))
        .reduce((total, entry) => total + entry.peakAdditionalBytes + entry.uncertaintyBytes, 0)
      const concurrentAllowance = [...producerBaselines.keys()]
        .filter((otherProducerId) => otherProducerId !== producerId)
        .flatMap((otherProducerId) => plan.producerDeclarations
          .filter((entry) => entry.producerId === otherProducerId))
        .filter((entry) => filesystem.rootIds.includes(entry.rootId))
        .reduce((total, entry) => total + entry.peakAdditionalBytes + entry.uncertaintyBytes, 0)
      const observedGrowth = Math.max(
        0,
        baseline[filesystem.filesystemIdentity] - measureAvailable(filesystem.filesystemIdentity))
      if (observedGrowth > declaredGrowth + concurrentAllowance) {
        const error = new Error(
          `Production capacity estimator under-declared ${producerId} on ${filesystem.filesystemIdentity}: `
          + `observed=${observedGrowth} declared=${declaredGrowth}`
        )
        error.code = 'ESTIMATOR_UNDER_DECLARED'
        throw error
      }
    }
    producerBaselines.delete(producerId)
    return { producerId, status: 'within-declaration', checkedAt: new Date(now()).toISOString() }
  }
  const releaseReservation = (terminalState = 'released') => {
    if (releaseReservation.result) return releaseReservation.result
    clearInterval(heartbeatTimer)
    const release = acquireAuthorityLock(resolvedAuthorityRoot, { now })
    try {
      const current = compareOwner()
      const releasing = seal({
        ...current,
        state: 'releasing',
        heartbeatAt: new Date(now()).toISOString()
      })
      atomicWrite(activeFile, releasing)
      const terminal = seal({
        ...releasing,
        schema: productionCapacityReleaseSchema,
        state: terminalState === 'released' ? 'released' : 'aborted',
        heartbeatAt: new Date(now()).toISOString(),
        releasedAt: new Date(now()).toISOString(),
        terminalState,
        filesystems: releasing.filesystems.map((entry) => ({
          ...entry,
          status: terminalState === 'released' ? 'released' : 'aborted'
        }))
      })
      const terminalFile = path.join(resolvedAuthorityRoot, 'terminal', `${receipt.reservationId}.json`)
      atomicWrite(terminalFile, terminal, { exclusive: true })
      fs.rmSync(activeFile, { force: true })
      releaseReservation.result = { receipt: terminal, file: terminalFile }
      return releaseReservation.result
    } finally {
      release()
    }
  }
  const heartbeatTimer = setInterval(() => {
    try {
      heartbeat()
    } catch (error) {
      heartbeatFailure ??= error
    }
  }, heartbeatEveryMs)
  heartbeatTimer.unref?.()
  return {
    authorityRoot: resolvedAuthorityRoot,
    activeFile,
    get receipt() { return receipt },
    heartbeat,
    assertPlan,
    guardProducer,
    completeProducer,
    release: releaseReservation
  }
}
