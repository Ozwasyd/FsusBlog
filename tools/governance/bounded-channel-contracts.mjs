#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validateJsonSchema } from '../test-matrix/schema-validator/validate.mjs'
import { discoverBoundedChannels, discoverUnboundedChannels } from './bounded-channel-discovery.mjs'

export { discoverBoundedChannels, discoverUnboundedChannels } from './bounded-channel-discovery.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const defaultCatalogPath = path.join(root, 'config/testing/bounded-channel-delivery-contracts.json')
const deliveryClasses = new Set(['required', 'best-effort', 'coalescible', 'replayable'])
const dispositionKinds = new Set(['implemented', 'not-applicable', 'successor-required'])
const publicHotAuthorities = [1629, 1630, 1631]
  .map((issue) => `https://github.com/Ozwasyd/FsusBlog/issues/${issue}`)
const drainParticipantSource = 'src/backend/Infrastructure/Operations/BoundedQueueDrainParticipants.cs'
const drainParticipantRegistrationSource = 'src/backend/Infrastructure/Operations/ActiveReleaseFenceHosting.cs'
const acceptanceReceiptSchema = 'fsusblog.bounded-queue-acceptance.v1'
const drainAggregateSchema = 'fsusblog.bounded-queue-drain-aggregate.v1'
const matrixTestSource = 'tests/backend/Unit/BoundedQueueDrainAggregatorTests.cs'
const matrixScenarios = [
  'exact-drain',
  'queued-pending',
  'in-flight-pending',
  'durable-pending',
  'terminal-failure',
  'commit-postcondition-unknown',
  'drop-proof-mutation',
  'worker-crash',
  'cancel-timeout',
  'restart-generation-regression'
]
const acceptanceSourcePaths = [
  'config/testing/bounded-channel-delivery-contracts.json',
  'config/testing/bounded-channel-delivery-contracts.schema.json',
  'src/backend/Infrastructure/Operations/ActiveReleaseFenceHosting.cs',
  'src/backend/Infrastructure/Operations/BoundedQueueDeliveryCatalog.cs',
  'src/backend/Infrastructure/Operations/BoundedQueueDrainAggregator.cs',
  'src/backend/Infrastructure/Operations/BoundedQueueDrainContracts.cs',
  drainParticipantSource,
  'src/backend/Infrastructure/Operations/BoundedQueueDrainReleaseParticipant.cs',
  'src/backend/Infrastructure/Operations/ProductionHealth.cs',
  'docs/testing.md',
  'tests/tools/bounded-channel-contracts.test.mjs',
  matrixTestSource,
  'tools/governance/bounded-channel-contracts.mjs',
  'tools/governance/bounded-channel-discovery.mjs'
].sort()

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function deliveryCatalogDigest(queues) {
  return `sha256:${crypto.createHash('sha256').update(canonical(queues)).digest('hex')}`
}

function presentString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validateReference(reference, label, errors, readSource) {
  if (!reference || !presentString(reference.file) || !presentString(reference.token)) {
    errors.push(`${label} must contain file and token`); return
  }
  const source = readSource(reference.file)
  if (source === null) errors.push(`${label} references missing file ${reference.file}`)
  else if (!source.includes(reference.token)) errors.push(`${label} token is absent from ${reference.file}: ${reference.token}`)
}

function validateDisposition(value, label, errors, readSource) {
  if (!value || !dispositionKinds.has(value.status)) errors.push(`${label}.status is unknown`)
  if (!presentString(value?.rationale)) errors.push(`${label}.rationale is required`)
  if (!Array.isArray(value?.callsites)) errors.push(`${label}.callsites must be an array`)
  else {
    if (value.status === 'implemented' && value.callsites.length === 0) errors.push(`${label} implemented disposition needs a callsite`)
    value.callsites.forEach((reference, index) => validateReference(reference, `${label}.callsites[${index}]`, errors, readSource))
  }
}

export function validateBoundedChannelCatalog(catalogPath = defaultCatalogPath, options = {}) {
  const catalog = options.catalog ?? JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  const sourceOverrides = options.sources instanceof Map ? options.sources : new Map()
  const readSource = (file) => {
    if (sourceOverrides.has(file)) return sourceOverrides.get(file)
    const absolute = path.join(root, file)
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null
  }
  const errors = []
  const schemaPath = path.join(root, 'config/testing/bounded-channel-delivery-contracts.schema.json')
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  if (schema.$id !== 'https://fsus.blog/schemas/testing/bounded-channel-delivery-contracts.schema.json') errors.push('bounded channel schema authority is unknown')
  errors.push(...validateJsonSchema(catalog, schema))
  rejectUnknownKeys(catalog, new Set(['schema', 'digest', 'queues']), 'catalog', errors)
  if (catalog.schema !== 'fsusblog.bounded-channel-delivery-contracts.v1') errors.push('catalog schema is unknown')
  if (!Array.isArray(catalog.queues)) return [...errors, 'catalog queues must be an array']
  const discovered = options.discovered ?? discoverBoundedChannels(options.sources ? { sources: options.sources } : {})
  const unbounded = options.unbounded ?? (options.sources instanceof Map ? discoverUnboundedChannels({ sources: options.sources }) : [])
  for (const channel of unbounded) errors.push(`unbounded channel is forbidden: ${channel.file}:${channel.line}`)
  const duplicate = (values, label) => {
    for (const value of new Set(values.filter((item, index) => values.indexOf(item) !== index))) errors.push(`duplicate ${label}: ${value}`)
  }
  duplicate(catalog.queues.map((queue) => queue.queueId), 'queue ID')
  duplicate(catalog.queues.map((queue) => queue.discoveryKey), 'discovery key')
  duplicate(catalog.queues.map((queue) => queue.owner?.id), 'owner')
  duplicate(
    catalog.queues
      .filter((queue) => queue.drainParticipant === true)
      .map((queue) => queue.participantAdapter?.token)
      .filter(Boolean),
    'drain participant adapter'
  )
  const sortedIds = catalog.queues.map((queue) => queue.queueId)
  if (JSON.stringify(sortedIds) !== JSON.stringify([...sortedIds].sort())) errors.push('catalog queues must have stable queueId ordering')
  const catalogKeys = new Set(catalog.queues.map((queue) => queue.discoveryKey))
  const discoveredKeys = new Set(discovered.map((queue) => queue.discoveryKey))
  for (const key of discoveredKeys) if (!catalogKeys.has(key)) errors.push(`bounded channel missing from catalog: ${key}`)
  for (const key of catalogKeys) if (!discoveredKeys.has(key)) errors.push(`orphan catalog queue: ${key}`)
  if (catalog.digest !== deliveryCatalogDigest(catalog.queues)) errors.push('catalog digest does not match stable canonical queue ordering')
  for (const queue of catalog.queues) validateQueue(queue, discovered.find((item) => item.discoveryKey === queue.discoveryKey), errors, readSource)
  if (new Set(catalog.queues.map((queue) => queue.deliveryClass)).size < 2) errors.push('catalog must not assign every queue one delivery class')
  const catalogText = options.catalogText ?? fs.readFileSync(catalogPath, 'utf8')
  if (/\bwildcardSuppression\b|directory-level suppression|private fallback unregistered/iu.test(`${catalogText}\n${JSON.stringify(catalog)}`)) {
    errors.push('catalog must not use directory-level suppression or unregistered private fallbacks')
  }
  return errors
}

function validateQueue(queue, discovery, errors, readSource) {
  const label = queue.queueId || '<unknown>'
  rejectUnknownKeys(queue, new Set(['queueId', 'discoveryKey', 'owner', 'deliveryClass', 'drainParticipant', 'participantAdapter', 'channelBehavior', 'writerCallsites', 'readerCallsites', 'drain', 'fallback', 'failureSemantics', 'evidenceSources', 'proofTestIds', 'classProof', 'disposition', 'implementationOwner', 'authoritativeContracts']), label, errors)
  for (const field of ['queueId', 'discoveryKey', 'deliveryClass', 'implementationOwner', 'disposition']) {
    if (!presentString(queue[field])) errors.push(`${label}.${field} is required`)
  }
  if (!deliveryClasses.has(queue.deliveryClass)) errors.push(`${label} has unknown delivery class`)
  if (typeof queue.drainParticipant !== 'boolean') errors.push(`${label}.drainParticipant must be a boolean`)
  if (queue.drainParticipant === true) {
    if (!queue.participantAdapter) errors.push(`${label} drain participant requires participantAdapter`)
    else {
      validateReference(queue.participantAdapter, `${label}.participantAdapter`, errors, readSource)
      validateDrainParticipantBinding(queue, errors, readSource)
    }
  } else if (queue.participantAdapter) {
    errors.push(`${label} participantAdapter is only valid when drainParticipant is true`)
  }
  if (!queue.owner || !presentString(queue.owner.id) || !presentString(queue.owner.file) || !presentString(queue.owner.type) || !presentString(queue.owner.slot)) {
    errors.push(`${label} has unknown owner`)
  } else if (discovery && (queue.owner.file !== discovery.file || queue.owner.type !== discovery.ownerType || queue.owner.slot !== discovery.target)) {
    errors.push(`${label} owner does not match discovered bounded channel`)
  }
  if (discovery?.fullMode && queue.channelBehavior?.fullMode !== discovery.fullMode) errors.push(`${label} fullMode does not match source discovery`)
  for (const field of ['writerCallsites', 'readerCallsites', 'evidenceSources']) {
    if (!Array.isArray(queue[field]) || queue[field].length === 0) errors.push(`${label}.${field} must be non-empty`)
    else queue[field].forEach((reference, index) => validateReference(reference, `${label}.${field}[${index}]`, errors, readSource))
  }
  if (!Array.isArray(queue.proofTestIds) || queue.proofTestIds.length === 0) errors.push(`${label}.proofTestIds must be non-empty`)
  else queue.proofTestIds.forEach((reference, index) => validateReference(reference, `${label}.proofTestIds[${index}]`, errors, readSource))
  validateDisposition(queue.drain, `${label}.drain`, errors, readSource)
  validateDisposition(queue.fallback, `${label}.fallback`, errors, readSource)
  const failure = queue.failureSemantics
  for (const field of ['closed', 'cancellation', 'workerFailure', 'overflowMarker', 'inFlight', 'commitPostcondition', 'qualificationImpact']) {
    if (!presentString(failure?.[field])) errors.push(`${label}.failureSemantics.${field} is required`)
  }
  if (!presentString(queue.channelBehavior?.fullMode) || !presentString(queue.channelBehavior?.writerPrimitive)) {
    errors.push(`${label}.channelBehavior requires fullMode and writerPrimitive`)
  }
  if (queue.channelBehavior?.fullMode === 'Wait' && queue.channelBehavior?.writerPrimitive.includes('TryWrite') && !presentString(queue.channelBehavior.waitTryWriteDisposition)) {
    errors.push(`${label} FullMode Wait plus TryWrite must be explained`)
  }
  validateWriterPrimitive(queue, label, errors)
  validateClassProof(queue, label, errors, readSource)
  if (queue.deliveryClass === 'best-effort' && /audit|security|risk|challenge/iu.test(`${queue.queueId} ${queue.owner?.id ?? ''} ${queue.owner?.type ?? ''}`)) {
    errors.push(`${label} protected audit/security queue cannot be best-effort`)
  }
  if (queue.owner?.type?.includes('PublicHot')) {
    if (JSON.stringify(queue.authoritativeContracts) !== JSON.stringify(publicHotAuthorities)) errors.push(`${label} PublicHot authority must reference #1629-#1631 exactly`)
    if (Object.hasOwn(queue, 'copiedAuthority')) errors.push(`${label} PublicHot contract must not copy authoritative logic`)
  } else if (queue.authoritativeContracts !== undefined) errors.push(`${label} non-PublicHot queue must not declare PublicHot authority`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function validateDrainParticipantBinding(queue, errors, readSource) {
  const reference = queue.participantAdapter
  const token = reference?.token
  if (!presentString(token)) return
  const source = readSource(reference.file)
  if (source !== null) {
    const classPattern = new RegExp(`\\bclass\\s+${escapeRegExp(token)}\\b[\\s\\S]{0,480}:\\s*IBoundedQueueDrainParticipant\\b`, 'u')
    if (!classPattern.test(source)) errors.push(`${queue.queueId}.participantAdapter token must implement IBoundedQueueDrainParticipant`)
    const queueIdToken = `QueueId => "${queue.queueId}"`
    if ((source.match(new RegExp(escapeRegExp(queueIdToken), 'gu')) ?? []).length !== 1) errors.push(`${queue.queueId}.participantAdapter must bind QueueId exactly once`)
  }
  const registrations = readSource(drainParticipantRegistrationSource)
  if (registrations === null) {
    errors.push(`${queue.queueId}.participantAdapter registration source is missing`)
  } else {
    const registration = `ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, ${token}>()`
    if (!registrations.includes(registration)) errors.push(`${queue.queueId}.participantAdapter is not registered in ${drainParticipantRegistrationSource}`)
  }
}

function validateWriterPrimitive(queue, label, errors) {
  const primitive = queue.channelBehavior?.writerPrimitive
  const callsites = Array.isArray(queue.writerCallsites) ? queue.writerCallsites.map((reference) => reference?.token ?? '').join('\n') : ''
  const primitiveUsesTryWrite = presentString(primitive) && /\bTryWrite\b/iu.test(primitive)
  const callsitesUseTryWrite = /\bTryWrite\b/iu.test(callsites)
  if (primitiveUsesTryWrite && !callsitesUseTryWrite) errors.push(`${label} writer primitive does not match its writer callsite`)
  // Indirect WriteAsync callsites are valid when the catalog records the writer abstraction;
  // a mutation that erases an explicit TryWrite contract must still fail closed.
  if (presentString(primitive) && /^WriteAsync$/u.test(primitive.trim()) && callsitesUseTryWrite) {
    errors.push(`${label} writer primitive does not match its writer callsite`)
  }
}

function rejectUnknownKeys(value, allowed, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label} contains unknown property ${key}`)
}

function validateClassProof(queue, label, errors, readSource) {
  const proof = queue.classProof
  if (!proof || proof.kind !== queue.deliveryClass) { errors.push(`${label} class proof does not match delivery class`); return }
  if (proof.kind === 'required') {
    validateReference(proof.durableSource, `${label}.classProof.durableSource`, errors, readSource)
    validateReference(proof.replaySource, `${label}.classProof.replaySource`, errors, readSource)
  } else if (proof.kind === 'best-effort') {
    if (!presentString(proof.productCapability) || !presentString(proof.impact)) errors.push(`${label} best-effort product proof is incomplete`)
    if (/security|audit|correctness|authorization|integrity/iu.test(`${proof.productCapability ?? ''} ${proof.impact ?? ''}`)) errors.push(`${label} best-effort proof cannot waive security, audit, or correctness`)
    validateReference(proof.productProof, `${label}.classProof.productProof`, errors, readSource)
  } else if (proof.kind === 'coalescible') {
    validateReference(proof.commutativeProof, `${label}.classProof.commutativeProof`, errors, readSource)
    validateReference(proof.monotonicProof, `${label}.classProof.monotonicProof`, errors, readSource)
  } else if (proof.kind === 'replayable') {
    validateReference(proof.executableSource, `${label}.classProof.executableSource`, errors, readSource)
    validateReference(proof.postcondition, `${label}.classProof.postcondition`, errors, readSource)
    if (/log|metric|telemetry/iu.test(`${proof.postcondition?.file ?? ''} ${proof.postcondition?.token ?? ''}`)) {
      errors.push(`${label} replayable postcondition cannot be log-only evidence`)
    }
  }
}

export function queueDispositionReport(catalogPath = defaultCatalogPath) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  return catalog.queues.map(({ queueId, deliveryClass, disposition, implementationOwner }) => ({ queueId, deliveryClass, disposition, implementationOwner }))
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function sha256File(file) {
  return sha256Text(fs.readFileSync(path.join(root, file)))
}

function currentSourceBindings() {
  return acceptanceSourcePaths.map((file) => ({ path: file, contentDigest: sha256File(file) }))
}

function expectedMutation(id, mutate, expectedPattern, options = {}) {
  const value = JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8'))
  mutate(value)
  value.digest = deliveryCatalogDigest(value.queues)
  const errors = validateBoundedChannelCatalog(defaultCatalogPath, {
    catalog: value,
    discovered: discoverBoundedChannels(),
    sources: options.sources
  })
  const passed = errors.some((error) => expectedPattern.test(error))
  if (!passed) throw new Error(`${id} mutation was not rejected: ${errors.join('; ')}`)
  return { id, status: 'rejected', evidence: errors.filter((error) => expectedPattern.test(error)).sort() }
}

function runtimeMutationSourceEvidence(id, scenario) {
  const source = fs.readFileSync(path.join(root, matrixTestSource), 'utf8')
  if (!source.includes(`"${scenario}"`)) throw new Error(`${id} is missing runtime matrix scenario ${scenario}`)
  return { id, status: 'source-bound', evidence: { path: matrixTestSource, scenario } }
}

function matrixSourceEvidence() {
  const source = fs.readFileSync(path.join(root, matrixTestSource), 'utf8')
  const missing = matrixScenarios.filter((scenario) => !source.includes(`"${scenario}"`))
  if (missing.length > 0
    || !source.includes('embedded.DrainParticipants')
    || !source.includes('Assert.Equal(contracts.Count * scenarios.Length, executed)')) {
    throw new Error(`bounded queue matrix source is incomplete: ${missing.join(', ') || 'catalog enumeration or fixture assertion missing'}`)
  }
  return {
    path: matrixTestSource,
    enumeration: 'BoundedQueueDeliveryCatalog.Embedded.DrainParticipants',
    scenarioCount: matrixScenarios.length,
    fixtureAssertion: 'contracts.Count * scenarios.Length'
  }
}

function buildAcceptanceMutationResults() {
  const catalog = JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8'))
  const bestEffort = catalog.queues.find((queue) => queue.deliveryClass === 'best-effort')
  const protectedQueue = catalog.queues.find((queue) => /audit|security|risk|challenge/iu.test(`${queue.queueId} ${queue.owner?.type ?? ''}`))
  const bestEffortProof = structuredClone(bestEffort.classProof)
  return [
    expectedMutation(
      'unbounded-channel',
      () => {},
      /unbounded channel is forbidden/iu,
      { sources: new Map([['src/backend/Mutation.cs', 'private readonly Channel<int> _channel = Channel.CreateUnbounded<int>();']]) }
    ),
    expectedMutation(
      'writeasync-without-callsite-contract',
      (value) => { value.queues.find((queue) => queue.channelBehavior.writerPrimitive.includes('TryWrite')).channelBehavior.writerPrimitive = 'WriteAsync' },
      /writer primitive does not match/iu
    ),
    expectedMutation(
      'unknown-best-effort-classification',
      (value) => { value.queues.find((queue) => queue.deliveryClass === 'required').deliveryClass = 'best-effort' },
      /class proof does not match/iu
    ),
    expectedMutation(
      'protected-warning-only-drop',
      (value) => {
        const queue = value.queues.find((candidate) => candidate.queueId === protectedQueue.queueId)
        queue.deliveryClass = 'best-effort'
        queue.classProof = structuredClone(bestEffortProof)
      },
      /protected audit\/security queue cannot be best-effort/iu
    ),
    runtimeMutationSourceEvidence('coalescing-generation-regression', 'restart-generation-regression'),
    runtimeMutationSourceEvidence('queued-count-only-drain', 'in-flight-pending'),
    runtimeMutationSourceEvidence('worker-without-in-flight-accounting', 'in-flight-pending'),
    expectedMutation(
      'log-only-replay-postcondition',
      (value) => {
        const queue = value.queues.find((candidate) => candidate.deliveryClass === 'replayable')
        queue.classProof.postcondition = { file: queue.classProof.executableSource.file, token: 'ILogger' }
      },
      /postcondition|log-only/iu
    )
  ]
}

export function buildBoundedQueueAcceptanceReceipt(catalogPath = defaultCatalogPath) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  const errors = validateBoundedChannelCatalog(catalogPath)
  if (errors.length > 0) throw new Error(`cannot build bounded queue acceptance receipt: ${errors.join('; ')}`)
  const participants = catalog.queues
    .filter((queue) => queue.drainParticipant === true)
    .sort((left, right) => left.queueId.localeCompare(right.queueId))
  const sources = currentSourceBindings()
  const matrix = matrixSourceEvidence()
  const payload = {
    schema: acceptanceReceiptSchema,
    source: {
      files: sources,
      contentDigest: sha256Text(canonical(sources))
    },
    catalog: {
      path: path.relative(root, catalogPath).split(path.sep).join('/'),
      fileDigest: sha256File(path.relative(root, catalogPath)),
      catalogDigest: catalog.digest
    },
    matrix: {
      test: matrixTestSource,
      enumeration: matrix.enumeration,
      scenarios: matrixScenarios,
      queueCount: participants.length,
      fixtureCount: participants.length * matrixScenarios.length,
      fixtureAssertion: matrix.fixtureAssertion
    },
    perQueue: participants.map((queue) => ({
      queueId: queue.queueId,
      deliveryClass: queue.deliveryClass,
      participantAdapter: queue.participantAdapter,
      qualificationImpact: queue.failureSemantics.qualificationImpact,
      proofTestIds: queue.proofTestIds,
      scenarios: matrixScenarios
    })),
    drainAggregate: {
      schema: drainAggregateSchema,
      source: 'src/backend/Infrastructure/Operations/BoundedQueueDrainAggregator.cs',
      catalogDigest: catalog.digest,
      participantQueueIds: participants.map((queue) => queue.queueId)
    },
    mutationResults: buildAcceptanceMutationResults(),
    warnings: []
  }
  return { ...payload, contentDigest: sha256Text(canonical(payload)) }
}

export function verifyBoundedQueueAcceptanceReceipt(receipt, catalogPath = defaultCatalogPath) {
  const expected = buildBoundedQueueAcceptanceReceipt(catalogPath)
  if (canonical(receipt) !== canonical(expected)) throw new Error('bounded queue acceptance receipt does not match current source')
  return receipt
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const errors = validateBoundedChannelCatalog()
  if (errors.length > 0) {
    console.error(errors.join('\n')); process.exit(1)
  }
  if (process.argv.includes('--receipt')) {
    console.log(JSON.stringify(buildBoundedQueueAcceptanceReceipt(), null, 2))
    process.exit(0)
  }
  console.log(JSON.stringify({ digest: JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8')).digest, queues: queueDispositionReport() }, null, 2))
}
