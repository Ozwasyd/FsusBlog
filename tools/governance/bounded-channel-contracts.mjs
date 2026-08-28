#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validateJsonSchema } from '../test-matrix/schema-validator/validate.mjs'
import { discoverBoundedChannels } from './bounded-channel-discovery.mjs'

export { discoverBoundedChannels } from './bounded-channel-discovery.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const defaultCatalogPath = path.join(root, 'config/testing/bounded-channel-delivery-contracts.json')
const deliveryClasses = new Set(['required', 'best-effort', 'coalescible', 'replayable'])
const dispositionKinds = new Set(['implemented', 'not-applicable', 'successor-required'])
const publicHotAuthorities = [1629, 1630, 1631]
  .map((issue) => `https://github.com/Ozwasyd/FsusBlog/issues/${issue}`)

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
  const duplicate = (values, label) => {
    for (const value of new Set(values.filter((item, index) => values.indexOf(item) !== index))) errors.push(`duplicate ${label}: ${value}`)
  }
  duplicate(catalog.queues.map((queue) => queue.queueId), 'queue ID')
  duplicate(catalog.queues.map((queue) => queue.discoveryKey), 'discovery key')
  duplicate(catalog.queues.map((queue) => queue.owner?.id), 'owner')
  const sortedIds = catalog.queues.map((queue) => queue.queueId)
  if (JSON.stringify(sortedIds) !== JSON.stringify([...sortedIds].sort())) errors.push('catalog queues must have stable queueId ordering')
  const catalogKeys = new Set(catalog.queues.map((queue) => queue.discoveryKey))
  const discoveredKeys = new Set(discovered.map((queue) => queue.discoveryKey))
  for (const key of discoveredKeys) if (!catalogKeys.has(key)) errors.push(`bounded channel missing from catalog: ${key}`)
  for (const key of catalogKeys) if (!discoveredKeys.has(key)) errors.push(`orphan catalog queue: ${key}`)
  if (catalog.digest !== deliveryCatalogDigest(catalog.queues)) errors.push('catalog digest does not match stable canonical queue ordering')
  for (const queue of catalog.queues) validateQueue(queue, discovered.find((item) => item.discoveryKey === queue.discoveryKey), errors, readSource)
  if (new Set(catalog.queues.map((queue) => queue.deliveryClass)).size < 2) errors.push('catalog must not assign every queue one delivery class')
  return errors
}

function validateQueue(queue, discovery, errors, readSource) {
  const label = queue.queueId || '<unknown>'
  rejectUnknownKeys(queue, new Set(['queueId', 'discoveryKey', 'owner', 'deliveryClass', 'channelBehavior', 'writerCallsites', 'readerCallsites', 'drain', 'fallback', 'failureSemantics', 'evidenceSources', 'proofTestIds', 'classProof', 'disposition', 'implementationOwner', 'authoritativeContracts']), label, errors)
  for (const field of ['queueId', 'discoveryKey', 'deliveryClass', 'implementationOwner', 'disposition']) {
    if (!presentString(queue[field])) errors.push(`${label}.${field} is required`)
  }
  if (!deliveryClasses.has(queue.deliveryClass)) errors.push(`${label} has unknown delivery class`)
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
  validateClassProof(queue, label, errors, readSource)
  if (queue.owner?.type?.includes('PublicHot')) {
    if (JSON.stringify(queue.authoritativeContracts) !== JSON.stringify(publicHotAuthorities)) errors.push(`${label} PublicHot authority must reference #1629-#1631 exactly`)
    if (Object.hasOwn(queue, 'copiedAuthority')) errors.push(`${label} PublicHot contract must not copy authoritative logic`)
  } else if (queue.authoritativeContracts !== undefined) errors.push(`${label} non-PublicHot queue must not declare PublicHot authority`)
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
  }
}

export function queueDispositionReport(catalogPath = defaultCatalogPath) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  return catalog.queues.map(({ queueId, deliveryClass, disposition, implementationOwner }) => ({ queueId, deliveryClass, disposition, implementationOwner }))
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const errors = validateBoundedChannelCatalog()
  if (errors.length > 0) {
    console.error(errors.join('\n')); process.exit(1)
  }
  console.log(JSON.stringify({ digest: JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8')).digest, queues: queueDispositionReport() }, null, 2))
}
