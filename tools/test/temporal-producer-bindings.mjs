import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bindProducerTemporalArtifacts,
  canonicalJson,
  digestCanonical,
  loadTemporalContext,
  materializeTemporalEnvironment,
  observeRuntimeTemporalContext,
  qualificationTemporalContext,
  validateTemporalContext
} from './temporal-context.mjs'
import {
  readFixtureCatalogs,
  scanFixtureSourceDeclarations
} from '../testing/fixture-catalog.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bindingsPath = path.join(repositoryRoot, 'config/testing/temporal-producer-bindings.json')
const inventoryPath = path.join(repositoryRoot, 'config/testing/fixture-consumer-inventory.generated.json')

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

export function validateTemporalProducerBindings({
  bindings = readJson(bindingsPath),
  inventory = readJson(inventoryPath),
  root = repositoryRoot,
  declarations = scanFixtureSourceDeclarations({ repositoryRoot: root }),
  fixtureCatalogs = readFixtureCatalogs()
} = {}) {
  if (bindings?.schema !== 'fsusblog.temporal-producer-bindings.v1'
      || !Array.isArray(bindings.producerBindings)) {
    throw new Error('temporal producer binding catalog header is invalid')
  }
  const inventoryRows = inventory?.producerImplementations
  if (!Array.isArray(inventoryRows)) {
    throw new Error('fixture consumer inventory producer implementations are missing')
  }
  const discoveredRows = declarations?.producers
  if (!Array.isArray(discoveredRows)) {
    throw new Error('independent repository producer discovery is missing')
  }
  const canonicalRows = (rows) => canonicalJson(rows
    .map((row) => ({
      producerId: row.producerId,
      source: row.source
    }))
    .sort((left, right) =>
      left.producerId.localeCompare(right.producerId)
        || left.source.localeCompare(right.source)))
  if (canonicalRows(inventoryRows) !== canonicalRows(discoveredRows)) {
    throw new Error(
      'generated fixture inventory does not exact-match independent repository producer discovery'
    )
  }
  const registryIds = sortedUnique(
    (fixtureCatalogs.producer?.producers ?? []).map((row) => row.id)
  )
  const expectedIds = sortedUnique(discoveredRows.map((row) => row.producerId))
  if (canonicalJson(expectedIds) !== canonicalJson(registryIds)) {
    throw new Error(
      'independently discovered producer IDs do not exact-match the producer registry'
    )
  }
  const actualIds = bindings.producerBindings.map((row) => row.producerId)
  if (canonicalJson(actualIds) !== canonicalJson(sortedUnique(actualIds))) {
    throw new Error('temporal producer bindings must be sorted and unique by producerId')
  }
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
    throw new Error(`temporal producer binding coverage mismatch: expected ${expectedIds.join(', ')}`)
  }

  const exclusions = bindings.cutoverExcludedImplementations ?? []
  const excludedSources = new Set(exclusions.map((row) => row.source))
  for (const exclusion of exclusions) {
    if (typeof exclusion?.source !== 'string' || typeof exclusion?.reason !== 'string'
        || !exclusion.reason.trim()) {
      throw new Error('temporal producer cutover exclusion is invalid')
    }
    const owners = sortedUnique(discoveredRows
      .filter((row) => row.source === exclusion.source)
      .map((row) => row.producerId))
    if (owners.length < 2) {
      throw new Error(`temporal producer cutover exclusion is not a shared implementation: ${exclusion.source}`)
    }
  }
  const expectedByProducer = new Map(expectedIds.map((id) => [
    id,
    sortedUnique(discoveredRows
      .filter((row) => row.producerId === id && !excludedSources.has(row.source))
      .map((row) => row.source))
  ]))
  for (const row of bindings.producerBindings) {
    const expectedSources = expectedByProducer.get(row.producerId)
    if (canonicalJson(row.implementations) !== canonicalJson(expectedSources)) {
      throw new Error(`temporal producer ${row.producerId} implementation coverage drift`)
    }
    for (const source of row.implementations) {
      const resolved = path.resolve(root, source)
      if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
        throw new Error(`temporal producer ${row.producerId} source escapes repository`)
      }
      readFileSync(resolved)
    }
    for (const field of [
      'contextIngress',
      'actualObservation',
      'planCarrier',
      'receiptCarrier',
      'clockDisposition'
    ]) {
      if (typeof row[field] !== 'string' || !row[field].trim()) {
        throw new Error(`temporal producer ${row.producerId} ${field} is required`)
      }
    }
    if (row.planCarrier !== 'FSUSBLOG_TEMPORAL_CONTEXT_JSON'
        || row.receiptCarrier !== 'temporal-receipt.json'
        || row.clockDisposition !== 'canonical-business-epoch') {
      throw new Error(`temporal producer ${row.producerId} does not use canonical temporal carriers`)
    }
  }
  return Object.freeze({
    producerCount: actualIds.length,
    implementationCount: discoveredRows
      .filter((row) => !excludedSources.has(row.source)).length,
    cutoverExclusionCount: exclusions.length,
    digest: digestCanonical(bindings)
  })
}

export function bindCorrectnessProducerTemporalArtifacts({
  producerId,
  contextInput,
  outcome,
  observations,
  generatedAt
}) {
  const catalog = readJson(bindingsPath)
  const binding = catalog.producerBindings.find((row) => row.producerId === producerId)
  if (!binding) throw new Error(`unregistered correctness producer: ${producerId}`)
  if (!observations || typeof observations !== 'object') {
    throw new Error(`correctness producer ${producerId} did not return an actual temporal observation`)
  }
  const bound = bindProducerTemporalArtifacts({
    contextInput: { ...contextInput, producerId },
    outcome,
    observations,
    generatedAt
  })
  return Object.freeze({
    ...bound,
    bindingDigest: digestCanonical(binding),
    environment: materializeTemporalEnvironment(bound.context)
  })
}

export function resolveCorrectnessProducerTemporalContext({
  producerId,
  schedulerRunId,
  sourceCommit,
  sourceFingerprint,
  env = process.env
}) {
  const planned = loadTemporalContext(env)
  const expectedFingerprint = String(sourceFingerprint ?? planned.sourceFingerprint)
  const normalizedFingerprint = expectedFingerprint.startsWith('sha256:')
    ? expectedFingerprint
    : `sha256:${expectedFingerprint}`
  if (planned.schedulerRunId !== String(schedulerRunId)
      || planned.sourceCommit !== String(sourceCommit)
      || planned.sourceFingerprint !== normalizedFingerprint) {
    throw new Error(`temporal producer ${producerId} source/run ingress does not exact-match the fixture plan`)
  }
  return qualificationTemporalContext({
    ...planned,
    producerId
  })
}

export function observeBrowserTemporalContext(context, {
  locale,
  timezoneId,
  backendCulture,
  postgresTimezone,
  businessEpochUtc,
  nodeTimezone = process.env.TZ
} = {}) {
  const normalized = validateTemporalContext(context)
  if (!locale || !timezoneId) {
    throw new Error('browser temporal observation requires explicit locale and timezoneId')
  }
  return observeRuntimeTemporalContext(normalized, {
    locale,
    uiLocale: locale,
    timezone: timezoneId,
    backendCulture: backendCulture ?? normalized.backendCulture,
    postgresTimezone: postgresTimezone ?? normalized.postgresTimezone,
    businessEpochUtc: businessEpochUtc ?? normalized.businessEpochUtc,
    nodeTimezone: nodeTimezone ?? normalized.nodeTimezone
  })
}

export function postgresTemporalSessionSql(context) {
  const normalized = validateTemporalContext(context, { requireQualificationDefaults: false })
  const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`
  return [
    `SELECT set_config('TimeZone', ${sqlLiteral(normalized.postgresTimezone)}, false);`,
    `SELECT set_config('fsusblog.test_business_epoch_utc', ${sqlLiteral(normalized.businessEpochUtc)}, false);`
  ].join(' ')
}

export function verifyPostgresTemporalObservation(context, {
  timezone,
  businessEpochUtc
}) {
  const normalized = validateTemporalContext(context, { requireQualificationDefaults: false })
  if (timezone !== normalized.postgresTimezone) {
    throw new Error(`temporal.postgres-timezone-mismatch: expected ${normalized.postgresTimezone}, got ${timezone}`)
  }
  if (businessEpochUtc !== normalized.businessEpochUtc) {
    throw new Error('temporal.actual-context-mismatch: PostgreSQL business epoch mismatch')
  }
  return true
}
