import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const residentResourceLeaseSchema = 'fsusblog.test-matrix.resident-resource-leases.v2'
export const residentResourceHandoffSchema = 'fsusblog.test-matrix.resident-resource-handoff.v1'
export const productionResidentServiceIds = Object.freeze([
  'debug-backend',
  'debug-frontend',
  'release-preview',
  'postgres',
  'redis'
])

function requiredText(value, label) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(`${label} must be non-empty`)
  return normalized
}

function positiveNumber(value, label) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized <= 0) throw new Error(`${label} must be positive`)
  return normalized
}

function normalizedResourceGrant(resourceGrant) {
  return {
    cpuUnits: positiveNumber(resourceGrant?.cpuUnits, 'resourceGrant.cpuUnits'),
    memoryGiB: positiveNumber(resourceGrant?.memoryGiB, 'resourceGrant.memoryGiB')
  }
}

function requiredTimestamp(value, label) {
  const normalized = requiredText(value, label)
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${label} must be an ISO timestamp`)
  return normalized
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

export function residentLeaseDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function sameReservation(left, right) {
  return Math.abs(Number(left?.cpuUnits) - Number(right?.cpuUnits)) <= 1e-9
    && Math.abs(Number(left?.memoryGiB) - Number(right?.memoryGiB)) <= 1e-9
}

function summedReservation(services) {
  return {
    cpuUnits: services.reduce((sum, service) => sum + service.reservation.cpuUnits, 0),
    memoryGiB: services.reduce((sum, service) => sum + service.reservation.memoryGiB, 0)
  }
}

function normalizedService(service, index) {
  const label = `services[${index}]`
  const kind = requiredText(service?.kind, `${label}.kind`)
  if (!['process', 'container'].includes(kind)) throw new Error(`${label}.kind must be process or container`)
  const identity = kind === 'process'
    ? {
        pid: Math.floor(positiveNumber(service?.identity?.pid, `${label}.identity.pid`)),
        startTimeTicks: requiredText(service?.identity?.startTimeTicks, `${label}.identity.startTimeTicks`)
      }
    : {
        containerId: requiredText(service?.identity?.containerId, `${label}.identity.containerId`),
        createdAt: requiredText(service?.identity?.createdAt, `${label}.identity.createdAt`)
      }
  if (kind === 'process' && !/^\d+$/u.test(identity.startTimeTicks)) {
    throw new Error(`${label}.identity.startTimeTicks must be numeric`)
  }
  if (kind === 'container' && !/^[a-f0-9]{64}$/u.test(identity.containerId)) {
    throw new Error(`${label}.identity.containerId must be a full OCI container ID`)
  }
  if (kind === 'container') requiredTimestamp(identity.createdAt, `${label}.identity.createdAt`)
  const port = Number(service?.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label}.port must be a valid TCP port`)
  if (service?.health?.status !== 'ready') throw new Error(`${label}.health.status must be ready`)
  return {
    id: requiredText(service?.id, `${label}.id`),
    kind,
    identity,
    port,
    generation: requiredText(service?.generation, `${label}.generation`),
    health: {
      status: 'ready',
      checkedAt: requiredTimestamp(service?.health?.checkedAt, `${label}.health.checkedAt`)
    },
    observedRssBytes: Math.max(0, Number(service?.observedRssBytes) || 0)
  }
}

export function allocateResidentReservations({ resourceGrant, services }) {
  const normalized = services.map(normalizedService)
  if (normalized.length === 0) throw new Error('resident services must be non-empty')
  const { cpuUnits: cpuEnvelope, memoryGiB: memoryEnvelope } = normalizedResourceGrant(resourceGrant)
  const rssWeights = normalized.map((service) => Math.max(1, service.observedRssBytes))
  const rssWeightTotal = rssWeights.reduce((sum, value) => sum + value, 0)
  // Resident services retain a measured, non-zero steady-state slice while at
  // least one executable CPU unit and a service-count-derived memory slice stay
  // available for downstream work. This is derived from the live grant and the
  // observed service set rather than a machine-specific constant.
  const schedulableCpu = Math.min(cpuEnvelope / 2, 1)
  const residentCpuEnvelope = Math.max(Number.EPSILON * normalized.length, cpuEnvelope - schedulableCpu)
  const measuredRssGiB = rssWeightTotal / (1024 ** 3)
  const rssSafetyFactor = 1 + (1 / normalized.length)
  const residentMemoryEnvelope = Math.min(
    memoryEnvelope * normalized.length / (normalized.length + 1),
    Math.max(memoryEnvelope / (normalized.length + 1), measuredRssGiB * rssSafetyFactor)
  )
  const cpuPerService = residentCpuEnvelope / normalized.length
  return normalized.map((service, index) => ({
    ...service,
    reservation: {
      cpuUnits: cpuPerService,
      memoryGiB: residentMemoryEnvelope * rssWeights[index] / rssWeightTotal
    }
  }))
}

let detectedPageSize = null

function pageSize() {
  if (detectedPageSize !== null) return detectedPageSize
  const result = spawnSync('getconf', ['PAGESIZE'], { encoding: 'utf8' })
  const value = Number(String(result.stdout ?? '').trim())
  detectedPageSize = result.status === 0 && Number.isInteger(value) && value > 0 ? value : 4096
  return detectedPageSize
}

function readProcessObservation(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closingName = stat.lastIndexOf(')')
    if (closingName < 0) return { status: 'unknown', reason: 'malformed-process-stat' }
    const fields = stat.slice(closingName + 2).trim().split(/\s+/u)
    const observedStartTimeTicks = fields[19]
    if (!observedStartTimeTicks) return { status: 'unknown', reason: 'missing-process-start-time' }
    const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/u)
    return {
      status: 'live',
      identity: { pid, startTimeTicks: observedStartTimeTicks },
      observedRssBytes: Math.max(0, Number(statm[1]) || 0) * pageSize(),
      observedCpuTicks: Math.max(0, Number(fields[11]) || 0) + Math.max(0, Number(fields[12]) || 0)
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'exited', reason: 'process-exited' }
    return { status: 'unknown', reason: error?.code ?? error?.message ?? 'process-observation-failed' }
  }
}

function processObservation(identity) {
  const observed = readProcessObservation(identity.pid)
  return observed.status === 'live' && observed.identity.startTimeTicks !== identity.startTimeTicks
    ? { ...observed, status: 'identity-changed' }
    : observed
}

function containerObservation(identity) {
  const result = spawnSync('docker', ['inspect', identity.containerId], { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') return { status: 'unknown', reason: 'docker-unavailable' }
  if (result.status !== 0) return { status: 'exited', reason: 'container-exited' }
  try {
    const document = JSON.parse(result.stdout)?.[0]
    if (!document?.Id || !document?.Created || document?.State?.Running !== true) {
      return { status: 'exited', reason: 'container-not-running' }
    }
    const process = readProcessObservation(document.State.Pid)
    return {
      status: document.Id === identity.containerId && document.Created === identity.createdAt
        ? (process.status === 'exited' ? 'unknown' : 'live')
        : 'identity-changed',
      identity: { containerId: document.Id, createdAt: document.Created },
      observedRssBytes: process.observedRssBytes ?? 0,
      observedCpuTicks: process.observedCpuTicks ?? 0
    }
  } catch (error) {
    return { status: 'unknown', reason: error?.message ?? 'container-observation-failed' }
  }
}

export function observeResidentService(service) {
  return service.kind === 'process'
    ? processObservation(service.identity)
    : containerObservation(service.identity)
}

export function reconcileResidentLeaseInventory(inventory, {
  observeService = observeResidentService,
  observedAt = new Date().toISOString()
} = {}) {
  validateResidentLeaseInventory(inventory)
  const services = inventory.services.map((service) => {
    let observation
    try {
      observation = observeService(service)
    } catch (error) {
      observation = { status: 'unknown', reason: error?.message ?? String(error) }
    }
    const status = ['live', 'exited', 'identity-changed', 'unknown'].includes(observation?.status)
      ? observation.status
      : 'unknown'
    return {
      id: service.id,
      generation: service.generation,
      status,
      reason: observation?.reason ?? null,
      observedRssBytes: Math.max(0, Number(observation?.observedRssBytes) || 0),
      observedCpuTicks: Math.max(0, Number(observation?.observedCpuTicks) || 0),
      observedAt
    }
  })
  const retainedIds = new Set(services.filter((service) => service.status !== 'exited').map((service) => service.id))
  const retained = inventory.services.filter((service) => retainedIds.has(service.id))
  return {
    services,
    reservation: {
      cpuUnits: retained.reduce((sum, service) => sum + service.reservation.cpuUnits, 0),
      memoryGiB: retained.reduce((sum, service) => sum + service.reservation.memoryGiB, 0)
    },
    healthy: services.every((service) => service.status === 'live'),
    fullyReleased: retained.length === 0
  }
}

export function createResidentLeaseInventory({
  runId,
  namespace,
  ownerBundleId,
  sourceState = null,
  resourceGrant,
  services,
  generatedAt = new Date().toISOString()
}) {
  const normalizedGrant = normalizedResourceGrant(resourceGrant)
  const allocated = allocateResidentReservations({ resourceGrant: normalizedGrant, services })
  const ids = allocated.map((service) => service.id)
  if (new Set(ids).size !== ids.length) throw new Error('resident service IDs must be unique')
  const inventory = {
    schema: residentResourceLeaseSchema,
    runId: requiredText(runId, 'runId'),
    namespace: requiredText(namespace, 'namespace'),
    ownerBundleId: requiredText(ownerBundleId, 'ownerBundleId'),
    sourceState: sourceState === null ? null : {
      commit: requiredText(sourceState?.commit, 'sourceState.commit'),
      worktreeFingerprint: requiredText(sourceState?.worktreeFingerprint, 'sourceState.worktreeFingerprint')
    },
    generation: residentLeaseDigest(allocated.map((service) => ({
      id: service.id,
      kind: service.kind,
      identity: service.identity,
      generation: service.generation
    }))),
    resourceGrant: normalizedGrant,
    services: allocated,
    reservation: {
      cpuUnits: allocated.reduce((sum, service) => sum + service.reservation.cpuUnits, 0),
      memoryGiB: allocated.reduce((sum, service) => sum + service.reservation.memoryGiB, 0)
    },
    generatedAt: requiredTimestamp(generatedAt, 'generatedAt')
  }
  return { ...inventory, digest: residentLeaseDigest(inventory) }
}

function validateResidentLeaseEnforcement(inventory, enforcement) {
  if (!['advisory', 'enforced'].includes(enforcement?.mode)) {
    throw new Error('resident enforcement mode must be advisory or enforced')
  }
  requiredTimestamp(enforcement?.boundAt, 'enforcement.boundAt')
  const processServices = inventory.services.filter((service) => service.kind === 'process')
  const containerServices = inventory.services.filter((service) => service.kind === 'container')
  const processReservation = summedReservation(processServices)
  if (processServices.length > 0
    && !sameReservation(enforcement?.processScope?.reservation, processReservation)) {
    throw new Error('resident process cgroup reservation does not match process leases')
  }
  if (processServices.length === 0 && enforcement?.processScope !== null) {
    throw new Error('resident process cgroup evidence exists without process leases')
  }
  if (processServices.length > 0 && enforcement?.mode === 'enforced'
    && !String(enforcement?.processScope?.path ?? '').trim()) {
    throw new Error('resident enforced process cgroup path is missing')
  }
  const containerEvidence = enforcement?.containers ?? {}
  const expectedContainerIds = new Set(containerServices.map((service) => service.id))
  for (const evidenceId of Object.keys(containerEvidence)) {
    if (!expectedContainerIds.has(evidenceId)) {
      throw new Error(`resident OCI evidence has no matching lease: ${evidenceId}`)
    }
  }
  for (const service of containerServices) {
    const evidence = containerEvidence[service.id]
    if (!evidence || evidence.containerId !== service.identity.containerId
      || !sameReservation(evidence.reservation, service.reservation)) {
      throw new Error(`resident OCI reservation does not match lease: ${service.id}`)
    }
    if (!['advisory', 'enforced'].includes(evidence.status)) {
      throw new Error(`resident OCI enforcement status is invalid: ${service.id}`)
    }
    if (enforcement.mode === 'enforced' && evidence.status !== 'enforced') {
      throw new Error(`resident OCI hard limit was not enforced: ${service.id}`)
    }
    if (evidence.status === 'enforced') {
      const expectedHigh = Math.round(service.reservation.memoryGiB * (1024 ** 3))
      if (Math.abs(Number(evidence.observed?.cpuUnits) - service.reservation.cpuUnits) > 1e-6
        || Number(evidence.observed?.memoryHighBytes) !== expectedHigh
        || Number(evidence.observed?.memoryMaxBytes) < expectedHigh) {
        throw new Error(`resident OCI hard limit does not match lease: ${service.id}`)
      }
    }
  }
  if (!sameReservation(enforcement?.reservation, inventory.reservation)) {
    throw new Error('resident enforcement reservation total mismatch')
  }
}

export function bindResidentLeaseEnforcement(inventory, enforcement) {
  validateResidentLeaseInventory(inventory)
  const processServices = inventory.services.filter((service) => service.kind === 'process')
  const containerEvidence = enforcement?.containers ?? {}
  const unsigned = {
    ...inventory,
    enforcement: {
      mode: requiredText(enforcement?.mode, 'enforcement.mode'),
      processScope: processServices.length > 0 ? enforcement.processScope : null,
      containers: containerEvidence,
      reservation: inventory.reservation,
      boundAt: requiredTimestamp(enforcement?.boundAt, 'enforcement.boundAt')
    }
  }
  delete unsigned.digest
  validateResidentLeaseEnforcement(unsigned, unsigned.enforcement)
  return { ...unsigned, digest: residentLeaseDigest(unsigned) }
}

export function validateResidentLeaseInventory(inventory, {
  runId,
  namespace,
  ownerBundleId,
  sourceState,
  resourceGrant,
  requiredServiceIds,
  verifyProcess,
  verifyContainer
} = {}) {
  if (inventory?.schema !== residentResourceLeaseSchema) throw new Error('resident lease inventory schema mismatch')
  if (runId !== undefined && inventory.runId !== runId) throw new Error('resident lease inventory belongs to another run')
  if (namespace !== undefined && inventory.namespace !== namespace) throw new Error('resident lease inventory belongs to another namespace')
  if (ownerBundleId !== undefined && inventory.ownerBundleId !== ownerBundleId) throw new Error('resident lease inventory belongs to another owner')
  if (sourceState !== undefined && (inventory.sourceState?.commit !== sourceState?.commit
    || inventory.sourceState?.worktreeFingerprint !== sourceState?.worktreeFingerprint)) {
    throw new Error('resident lease inventory belongs to another source state')
  }
  const storedGrant = normalizedResourceGrant(inventory.resourceGrant)
  if (resourceGrant !== undefined && !sameReservation(storedGrant, normalizedResourceGrant(resourceGrant))) {
    throw new Error('resident lease inventory belongs to another resource grant')
  }
  if (requiredServiceIds !== undefined) {
    const expectedIds = requiredServiceIds.map((value, index) => requiredText(value, `requiredServiceIds[${index}]`))
    if (new Set(expectedIds).size !== expectedIds.length) throw new Error('required resident service IDs must be unique')
    const actualIds = inventory.services.map((service) => service.id)
    if (actualIds.length !== expectedIds.length
      || [...actualIds].sort().some((value, index) => value !== [...expectedIds].sort()[index])) {
      throw new Error('resident lease inventory service roster mismatch')
    }
  }
  const { digest, ...unsigned } = inventory
  if (digest !== residentLeaseDigest(unsigned)) throw new Error('resident lease inventory digest mismatch')
  const rebuilt = createResidentLeaseInventory({
    runId: inventory.runId,
    namespace: inventory.namespace,
    ownerBundleId: inventory.ownerBundleId,
    sourceState: inventory.sourceState,
    resourceGrant: storedGrant,
    services: inventory.services,
    generatedAt: inventory.generatedAt
  })
  if (rebuilt.generation !== inventory.generation) throw new Error('resident lease inventory generation mismatch')
  for (const [index, service] of inventory.services.entries()) {
    if (!(service.reservation?.cpuUnits > 0) || !(service.reservation?.memoryGiB > 0)) {
      throw new Error(`resident service ${service.id} has no resource reservation`)
    }
    if (!sameReservation(service.reservation, rebuilt.services[index]?.reservation)) {
      throw new Error(`resident service ${service.id} reservation was not derived from its resource grant`)
    }
    const matches = service.kind === 'process'
      ? verifyProcess?.(service.identity, service)
      : verifyContainer?.(service.identity, service)
    if ((service.kind === 'process' && verifyProcess && matches !== true)
      || (service.kind === 'container' && verifyContainer && matches !== true)) {
      throw new Error(`resident service identity changed: ${service.id}`)
    }
  }
  const reservedCpuUnits = inventory.services.reduce((sum, service) => sum + service.reservation.cpuUnits, 0)
  const reservedMemoryGiB = inventory.services.reduce((sum, service) => sum + service.reservation.memoryGiB, 0)
  if (Math.abs(reservedCpuUnits - inventory.reservation.cpuUnits) > 1e-9
    || Math.abs(reservedMemoryGiB - inventory.reservation.memoryGiB) > 1e-9) {
    throw new Error('resident lease inventory reservation total mismatch')
  }
  if (!sameReservation(inventory.reservation, rebuilt.reservation)) {
    throw new Error('resident lease inventory reservation does not match its resource grant')
  }
  if (inventory.enforcement) validateResidentLeaseEnforcement(inventory, inventory.enforcement)
  return inventory
}

function validateResidentLeaseReadiness(readiness, inventory) {
  if (!readiness || readiness.status !== 'ready') {
    throw new Error('resident lease handoff requires ready health evidence')
  }
  requiredTimestamp(readiness.checkedAt, 'readiness.checkedAt')
  if (!Array.isArray(readiness.services) || readiness.services.length !== inventory.services.length) {
    throw new Error('resident lease handoff readiness roster mismatch')
  }
  const readinessById = new Map(readiness.services.map((service) => [service?.id, service]))
  if (readinessById.size !== inventory.services.length) {
    throw new Error('resident lease handoff readiness roster mismatch')
  }
  for (const service of inventory.services) {
    const evidence = readinessById.get(service.id)
    if (evidence?.generation !== service.generation || evidence?.status !== 'live') {
      throw new Error(`resident lease handoff readiness is stale: ${service.id}`)
    }
  }
}

export function createResidentLeaseHandoff({
  inventory,
  toOwnerBundleId,
  readiness,
  generatedAt = new Date().toISOString()
}) {
  validateResidentLeaseInventory(inventory)
  validateResidentLeaseReadiness(readiness, inventory)
  const receipt = {
    schema: residentResourceHandoffSchema,
    runId: inventory.runId,
    namespace: inventory.namespace,
    sourceState: inventory.sourceState,
    generation: inventory.generation,
    leaseDigest: inventory.digest,
    fromOwnerBundleId: inventory.ownerBundleId,
    toOwnerBundleId: requiredText(toOwnerBundleId, 'toOwnerBundleId'),
    readiness,
    generatedAt: requiredText(generatedAt, 'generatedAt'),
    consumedAt: null,
    consumedBy: null
  }
  return { ...receipt, digest: residentLeaseDigest(receipt) }
}

export function consumeResidentLeaseHandoff(receipt, {
  inventory,
  consumerBundleId,
  consumedAt = new Date().toISOString()
}) {
  validateResidentLeaseHandoff(receipt, { inventory, consumerBundleId, requireConsumed: false })
  const { digest, ...unsigned } = receipt
  const consumed = {
    ...unsigned,
    consumedAt: requiredText(consumedAt, 'consumedAt'),
    consumedBy: consumerBundleId
  }
  return { ...consumed, digest: residentLeaseDigest(consumed) }
}

function processStartTimeTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closingName = stat.lastIndexOf(')')
    return closingName < 0 ? null : stat.slice(closingName + 2).trim().split(/\s+/u)[19] ?? null
  } catch {
    return null
  }
}

function processExists(pid, startTimeTicks = null) {
  try {
    process.kill(pid, 0)
    return startTimeTicks === null || processStartTimeTicks(pid) === startTimeTicks
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function removeStaleHandoffLock(lockFile, staleLockMs) {
  try {
    const stat = fs.statSync(lockFile)
    if (Date.now() - stat.mtimeMs < staleLockMs) return false
    let owner = null
    try {
      owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    } catch {}
    if (Number.isInteger(owner?.pid) && processExists(owner.pid, owner.startTimeTicks ?? null)) return false
    fs.rmSync(lockFile, { force: true })
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
}

export function consumeResidentLeaseHandoffFile(file, {
  inventory,
  consumerBundleId,
  consumedAt = new Date().toISOString(),
  lockTimeoutMs = 5_000,
  staleLockMs = 30_000
}) {
  const absolute = path.resolve(file)
  const lockFile = `${absolute}.consume.lock`
  const timeout = Math.max(0, Number(lockTimeoutMs) || 0)
  const staleAfter = Math.max(1, Number(staleLockMs) || 1)
  const deadline = Date.now() + timeout
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  const token = crypto.randomUUID()
  const startTimeTicks = processStartTimeTicks(process.pid)
  let lockDescriptor = null
  while (lockDescriptor === null) {
    try {
      lockDescriptor = fs.openSync(lockFile, 'wx')
      fs.writeFileSync(lockDescriptor, `${JSON.stringify({
        pid: process.pid,
        startTimeTicks,
        token,
        acquiredAt: new Date().toISOString()
      })}\n`)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      removeStaleHandoffLock(lockFile, staleAfter)
      if (Date.now() >= deadline) throw new Error('resident lease handoff consume lock timed out')
      Atomics.wait(waitBuffer, 0, 0, Math.min(25, Math.max(1, deadline - Date.now())))
    }
  }
  try {
    const receipt = readResidentLeaseDocument(absolute)
    const consumed = consumeResidentLeaseHandoff(receipt, { inventory, consumerBundleId, consumedAt })
    writeResidentLeaseDocument(absolute, consumed)
    return consumed
  } finally {
    fs.closeSync(lockDescriptor)
    try {
      const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (owner.token === token) fs.rmSync(lockFile, { force: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

export function validateResidentLeaseHandoff(receipt, {
  inventory,
  consumerBundleId,
  sourceState,
  requireConsumed = null
}) {
  if (receipt?.schema !== residentResourceHandoffSchema) throw new Error('resident lease handoff schema mismatch')
  const { digest, ...unsigned } = receipt
  if (digest !== residentLeaseDigest(unsigned)) throw new Error('resident lease handoff digest mismatch')
  validateResidentLeaseInventory(inventory, {
    runId: receipt.runId,
    namespace: receipt.namespace,
    ownerBundleId: receipt.fromOwnerBundleId,
    ...(sourceState === undefined ? {} : { sourceState })
  })
  if (receipt.sourceState?.commit !== inventory.sourceState?.commit
    || receipt.sourceState?.worktreeFingerprint !== inventory.sourceState?.worktreeFingerprint) {
    throw new Error('resident lease handoff belongs to another source state')
  }
  if (receipt.generation !== inventory.generation || receipt.leaseDigest !== inventory.digest) {
    throw new Error('resident lease handoff is stale')
  }
  validateResidentLeaseReadiness(receipt.readiness, inventory)
  if (receipt.toOwnerBundleId !== consumerBundleId) throw new Error('resident lease handoff belongs to another consumer')
  const consumed = Boolean(receipt.consumedAt || receipt.consumedBy)
  if (consumed && (!receipt.consumedAt || receipt.consumedBy !== consumerBundleId)) {
    throw new Error('resident lease handoff consumption evidence is incomplete')
  }
  if (requireConsumed === true && !consumed) throw new Error('resident lease handoff was not consumed')
  if (requireConsumed === false && consumed) throw new Error('resident lease handoff was already consumed')
  return receipt
}

export function writeResidentLeaseDocument(file, document) {
  const absolute = path.resolve(file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
  fs.renameSync(temporary, absolute)
}

export function readResidentLeaseDocument(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  } catch (error) {
    throw new Error(`resident lease document is unreadable: ${file}`, { cause: error })
  }
}

export function finalizeResidentLeaseCleanup({
  root,
  checkpointFile,
  cleanup,
  observeService = observeResidentService,
  timeoutMs = null
}) {
  const absoluteRoot = path.resolve(root)
  const checkpoint = readResidentLeaseDocument(checkpointFile)
  const evidence = checkpoint.residentResourceLeases
  if (!evidence || evidence.status === 'not-acquired') return checkpoint
  const inventoryFile = path.resolve(absoluteRoot, evidence.inventoryFile)
  const inventory = readResidentLeaseDocument(inventoryFile)
  const observedTierDurationMs = Math.max(0, ...Object.values(checkpoint.tiers ?? {})
    .map((tier) => Math.max(0, Number(tier?.durationMs) || 0)))
  const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0
    ? Number(timeoutMs)
    : Math.max(100, Math.min(5_000, Math.ceil(observedTierDurationMs * 0.02)))
  const deadline = Date.now() + effectiveTimeoutMs
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  let reconciliation
  do {
    reconciliation = reconcileResidentLeaseInventory(inventory, { observeService })
    if (reconciliation.fullyReleased || Date.now() >= deadline) break
    Atomics.wait(waitBuffer, 0, 0, Math.min(100, Math.max(1, deadline - Date.now())))
  } while (true)
  for (const service of reconciliation.services) {
    const serviceEvidence = evidence.services[service.id] ??= {
      generation: service.generation,
      reservation: inventory.services.find((item) => item.id === service.id)?.reservation ?? null,
      history: [],
      restartCount: 0,
      releasedAt: null
    }
    serviceEvidence.history.push(service)
    if (service.status === 'exited' && serviceEvidence.releasedAt === null) {
      serviceEvidence.releasedAt = service.observedAt
    }
  }
  evidence.reservation = reconciliation.reservation
  evidence.cleanup = cleanup
  evidence.events.push({
    type: reconciliation.fullyReleased ? 'cleanup-confirmed-release' : 'cleanup-retained-live',
    at: new Date().toISOString(),
    reservation: reconciliation.reservation
  })
  if (reconciliation.fullyReleased) {
    evidence.status = 'released'
    evidence.releasedAt = new Date().toISOString()
  } else {
    evidence.status = 'cleanup-pending-live-services'
  }
  writeResidentLeaseDocument(checkpointFile, checkpoint)
  return checkpoint
}
