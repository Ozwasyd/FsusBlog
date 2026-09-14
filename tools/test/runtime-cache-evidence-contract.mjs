import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../test-matrix/schema-validator/validate.mjs'

export const RUNTIME_CACHE_RECEIPT_SCHEMA = 'fsusblog.runtime-cache-scenario-receipt.v2'
export const RUNTIME_CACHE_CATALOG_SCHEMA = 'fsusblog.runtime-cache-evidence-catalog.v2'
export const RUNTIME_CACHE_RAW_EVIDENCE_SCHEMA = 'fsusblog.runtime-cache-raw-evidence.v2'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultCatalogPath = path.join(moduleRoot, 'config/testing/runtime-cache-evidence-catalog.json')
const rebuildFamilyByScenario = new Map([
  ['cache-miss-singleflight', 'cache-miss-singleflight'],
  ['related-reading', 'related-reading'],
  ['hot-featured-frame', 'cache-miss-singleflight'],
  ['sitemap', 'sitemap']
])
const defaultSchemaPath = path.join(moduleRoot, 'config/schemas/runtime-cache-scenario-receipt.schema.json')
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const idPattern = /^[a-z0-9][a-z0-9.-]*$/u
const redisSources = new Set(['stackexchange-redis-profiler', 'resp-proxy'])
const databaseSources = new Set(['npgsql-interceptor', 'sqlsugar-aop', 'postgres-server-statistics'])
const expectedScenarioIds = [
  'public-hot-read',
  'article-detail-l1',
  'cache-miss-singleflight',
  'distributed-invalidation',
  'l1-residency',
  'pagination',
  'related-reading',
  'redis-fault-classes',
  'revocation',
  'hot-featured-frame',
  'sitemap',
  'security-projections',
  'telemetry'
]

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function digest(value) {
  return `sha256:${createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex')}`
}

export function evaluateLogicalPaginationDatabaseCommands(pageCounts, requirements) {
  const logicalPages = requirements.logicalPages ?? []
  const firstPage = logicalPages[0]
  const deepPages = logicalPages.slice(1)
  const firstPageCount = pageCounts[firstPage]
  const deepPageCounts = deepPages.map((page) => pageCounts[page])
  const deepReference = deepPageCounts[0]

  return {
    firstPageWithinBudget: Number.isInteger(firstPageCount) && firstPageCount <= requirements.countCacheMissDbCommandsMax,
    deepPagesWithinBudget: deepPageCounts.length > 0 && deepPageCounts.every((count) =>
      Number.isInteger(count) && count <= requirements.countCacheHitDbCommandsMax),
    deepPageCommandsConstant: deepPageCounts.length > 0 && deepPageCounts.every((count) => count === deepReference),
    countMissObservedOnce: Number.isInteger(firstPageCount) && Number.isInteger(deepReference) &&
      firstPageCount === deepReference + requirements.countCacheMissExtraCommands,
    positive: logicalPages.every((page) => Number.isInteger(pageCounts[page]) && pageCounts[page] > 0)
  }
}

export function sealReceipt(receipt) {
  const { contentDigest: _ignored, ...payload } = receipt
  return { ...payload, contentDigest: digest(payload) }
}

export function sealFirstFailure(firstFailure) {
  if (firstFailure === null) return null
  const { contentDigest: _ignored, ...payload } = firstFailure
  return { ...payload, contentDigest: digest(payload) }
}

function git(args, repositoryRoot) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
}

export function currentSourceState(repositoryRoot = moduleRoot) {
  const commit = git(['rev-parse', 'HEAD'], repositoryRoot)
  const status = git(['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude).tmp'], repositoryRoot)
  const trackedPatch = git(['diff', '--binary', 'HEAD', '--', '.', ':(exclude).tmp'], repositoryRoot)
  const untracked = status.split(/\r?\n/u)
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3))
    .sort()
    .map((relativePath) => {
      const absolutePath = path.join(repositoryRoot, relativePath)
      return `${relativePath}\0${fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile() ? digest(fs.readFileSync(absolutePath)) : 'non-file'}`
    })
  return {
    commit,
    dirty: status.length > 0,
    statusDigest: digest(status),
    worktreeFingerprint: digest({ status, trackedPatch, untracked })
  }
}

function exactKeys(value, expected, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`)
    return false
  }
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (canonicalJson(actual) !== canonicalJson(required)) {
    errors.push(`${label} fields must be exact; found ${actual.join(', ')}`)
    return false
  }
  return true
}

function exactArray(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected)
}

function uniqueStrings(values) {
  return Array.isArray(values) && values.length > 0
    && values.every((value) => typeof value === 'string' && idPattern.test(value))
    && new Set(values).size === values.length
}

export function loadRuntimeCacheCatalog(customPath = defaultCatalogPath) {
  const catalog = JSON.parse(fs.readFileSync(customPath, 'utf8').replace(/^\uFEFF/u, ''))
  const errors = []
  exactKeys(catalog, ['schema', 'receiptSchema', 'rawEvidenceSchema', 'scenarios'], 'catalog', errors)
  if (catalog.schema !== RUNTIME_CACHE_CATALOG_SCHEMA) errors.push(`unsupported runtime cache catalog schema: ${catalog.schema}`)
  if (catalog.receiptSchema !== RUNTIME_CACHE_RECEIPT_SCHEMA) errors.push(`catalog receipt schema mismatch: ${catalog.receiptSchema}`)
  if (catalog.rawEvidenceSchema !== RUNTIME_CACHE_RAW_EVIDENCE_SCHEMA) errors.push(`catalog raw evidence schema mismatch: ${catalog.rawEvidenceSchema}`)
  if (!Array.isArray(catalog.scenarios) || catalog.scenarios.length !== 13) errors.push('runtime cache catalog must contain exactly 13 scenarios')
  const ids = []
  for (const [index, scenario] of (catalog.scenarios ?? []).entries()) {
    exactKeys(scenario, ['id', 'subcases', 'requests', 'concurrency', 'warmupRequests', 'requiredAssertions', 'requirements'], `catalog.scenarios[${index}]`, errors)
    if (typeof scenario?.id !== 'string' || !idPattern.test(scenario.id)) errors.push(`catalog.scenarios[${index}].id is invalid`)
    else ids.push(scenario.id)
    if (!uniqueStrings(scenario?.subcases)) errors.push(`${scenario?.id ?? index}: subcases must be non-empty, unique IDs`)
    if (!uniqueStrings(scenario?.requiredAssertions)) errors.push(`${scenario?.id ?? index}: requiredAssertions must be non-empty, unique IDs`)
    for (const field of ['requests', 'concurrency']) if (!Number.isInteger(scenario?.[field]) || scenario[field] < 1) errors.push(`${scenario?.id ?? index}: ${field} must be positive`)
    if (!Number.isInteger(scenario?.warmupRequests) || scenario.warmupRequests < 0) errors.push(`${scenario?.id ?? index}: warmupRequests must be non-negative`)
    if (!scenario?.requirements || typeof scenario.requirements !== 'object' || Array.isArray(scenario.requirements)) errors.push(`${scenario?.id ?? index}: requirements must be an object`)
  }
  if (new Set(ids).size !== ids.length) errors.push('runtime cache catalog scenario IDs must be unique')
  if (!exactArray(ids, expectedScenarioIds)) errors.push('runtime cache catalog scenario IDs must exactly match the current 13-scenario order')
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return catalog
}

export function loadRuntimeCacheSchema(customPath = defaultSchemaPath) {
  return JSON.parse(fs.readFileSync(customPath, 'utf8').replace(/^\uFEFF/u, ''))
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  return sorted[index]
}

function increment(target, key) {
  target[key] = (target[key] ?? 0) + 1
}

function redisRollup(commands) {
  const byVerb = {}
  const byCategory = {}
  for (const command of commands) {
    increment(byVerb, command.verb)
    increment(byCategory, command.category)
  }
  return { count: commands.length, byVerb, byCategory }
}

function databaseRollup(commands) {
  const byFingerprint = {}
  for (const command of commands) increment(byFingerprint, command.fingerprint)
  return { count: commands.length, byFingerprint }
}

function isTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    && Number.isFinite(Date.parse(value))
}

function safeEvidencePath(repositoryRoot, relativePath, errors) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)
      || path.posix.normalize(relativePath) !== relativePath || !relativePath.startsWith('.tmp/perf/runtime-cache/')) {
    errors.push('raw evidence path escapes the current runtime-cache evidence root')
    return null
  }
  const evidenceRoot = path.resolve(repositoryRoot, '.tmp/perf/runtime-cache')
  const absolutePath = path.resolve(repositoryRoot, relativePath)
  if (absolutePath === evidenceRoot || !absolutePath.startsWith(`${evidenceRoot}${path.sep}`)) {
    errors.push('raw evidence path escapes the current runtime-cache evidence root')
    return null
  }
  return absolutePath
}

function validateRawRequest(request, label, errors) {
  if (!exactKeys(request, ['id', 'subcaseId', 'method', 'path', 'status', 'payloadDigest', 'parityGroup', 'layerSource', 'latencyMs', 'allocatedBytes'], label, errors)) return
  if (!idPattern.test(String(request.id ?? '')) || !idPattern.test(String(request.subcaseId ?? ''))) errors.push(`${label} identity is invalid`)
  if (!Number.isInteger(request.status) || request.status < 100 || request.status > 599) errors.push(`${label}.status is invalid`)
  if (!digestPattern.test(String(request.payloadDigest ?? ''))) errors.push(`${label}.payloadDigest is invalid`)
  if (!Number.isFinite(request.latencyMs) || request.latencyMs < 0 || !Number.isInteger(request.allocatedBytes) || request.allocatedBytes < 0) errors.push(`${label} metrics are invalid`)
}

function validateRawEvidenceDocument(raw, receipt, errors) {
  if (!exactKeys(raw, ['schema', 'runId', 'scenarioId', 'attemptId', 'authority', 'requests', 'redisCommands', 'redisFailureEvents', 'cacheEvents', 'databaseCommands', 'cacheClassifications', 'faultTimeline'], 'raw evidence', errors)) return null
  if (raw.schema !== RUNTIME_CACHE_RAW_EVIDENCE_SCHEMA) errors.push(`unsupported raw evidence schema: ${raw.schema}`)
  for (const field of ['runId', 'scenarioId', 'attemptId']) if (raw[field] !== receipt[field]) errors.push(`raw evidence ${field} does not match receipt`)
  if (!exactKeys(raw.authority, ['requests', 'redis', 'redisFailure', 'database', 'cache', 'fault'], 'raw evidence authority', errors)) return null
  if (!exactArray(raw.authority, receipt.rawEvidence.authority)) errors.push('raw evidence authority does not match receipt authority')
  if (raw.authority.requests !== 'kestrel-request-observation') errors.push(`unsupported request authority: ${raw.authority.requests}`)
  if (!redisSources.has(raw.authority.redis)) errors.push(`unsupported Redis authority: ${raw.authority.redis}`)
  if (raw.authority.redisFailure !== 'redis-operation-executor') errors.push(`unsupported Redis failure authority: ${raw.authority.redisFailure}`)
  if (!databaseSources.has(raw.authority.database)) errors.push(`unsupported database authority: ${raw.authority.database}`)
  if (raw.authority.cache !== 'runtime-cache-evidence-observation') errors.push(`unsupported cache authority: ${raw.authority.cache}`)
  if (raw.authority.fault !== 'runtime-fault-controller') errors.push(`unsupported fault authority: ${raw.authority.fault}`)

  let arraysValid = true
  for (const field of ['requests', 'redisCommands', 'redisFailureEvents', 'cacheEvents', 'databaseCommands', 'cacheClassifications', 'faultTimeline']) {
    if (!Array.isArray(raw[field])) {
      errors.push(`raw evidence ${field} must be an array`)
      arraysValid = false
    }
  }
  if (!arraysValid) return null
  raw.requests.forEach((request, index) => validateRawRequest(request, `raw requests[${index}]`, errors))
  const requests = new Map(raw.requests.map((request) => [request.id, request]))
  if (requests.size !== raw.requests.length) errors.push('raw request IDs must be unique')

  const validateReference = (row, label) => {
    const request = requests.get(row.requestId)
    if (!request) errors.push(`${label} references unknown request ${row.requestId}`)
    else if (row.subcaseId !== request.subcaseId) errors.push(`${label} subcase does not match request ${row.requestId}`)
  }
  for (const [index, command] of raw.redisCommands.entries()) {
    const label = `raw redisCommands[${index}]`
    if (!exactKeys(command, ['requestId', 'subcaseId', 'verb', 'category', 'source'], label, errors)) continue
    validateReference(command, label)
    if (!/^[A-Z]+$/u.test(String(command.verb ?? ''))) errors.push(`${label}.verb is invalid`)
    if (!idPattern.test(String(command.category ?? ''))) errors.push(`${label}.category is invalid`)
    if (command.source !== raw.authority.redis) errors.push(`${label}.source does not match Redis authority`)
  }
  for (const [index, event] of raw.redisFailureEvents.entries()) {
    const label = `raw redisFailureEvents[${index}]`
    if (!exactKeys(event, ['requestId', 'subcaseId', 'sequence', 'elapsedMilliseconds', 'operationClass', 'failureKind', 'failAction', 'source'], label, errors)) continue
    validateReference(event, label)
    if (!Number.isInteger(event.sequence) || event.sequence < 1) errors.push(`${label}.sequence is invalid`)
    if (!Number.isFinite(event.elapsedMilliseconds) || event.elapsedMilliseconds < 0) errors.push(`${label}.elapsedMilliseconds is invalid`)
    if (!/^[A-Z][A-Za-z0-9]*$/u.test(String(event.operationClass ?? ''))) errors.push(`${label}.operationClass is invalid`)
    if (!/^[A-Z][A-Za-z0-9]*$/u.test(String(event.failureKind ?? ''))) errors.push(`${label}.failureKind is invalid`)
    if (!idPattern.test(String(event.failAction ?? ''))) errors.push(`${label}.failAction is invalid`)
    if (event.source !== raw.authority.redisFailure) errors.push(`${label}.source does not match Redis failure authority`)
  }
  for (const [index, event] of raw.cacheEvents.entries()) {
    const label = `raw cacheEvents[${index}]`
    if (!exactKeys(event, ['requestId', 'subcaseId', 'sequence', 'elapsedMilliseconds', 'family', 'identityDigest', 'outcome', 'source'], label, errors)) continue
    validateReference(event, label)
    if (!Number.isInteger(event.sequence) || event.sequence < 1) errors.push(`${label}.sequence is invalid`)
    if (!Number.isFinite(event.elapsedMilliseconds) || event.elapsedMilliseconds < 0) errors.push(`${label}.elapsedMilliseconds is invalid`)
    if (!idPattern.test(String(event.family ?? ''))) errors.push(`${label}.family is invalid`)
    if (!digestPattern.test(String(event.identityDigest ?? ''))) errors.push(`${label}.identityDigest is invalid`)
    if (!['hit', 'built', 'negative', 'invalidated', 'published'].includes(event.outcome)) errors.push(`${label}.outcome is invalid`)
    if (event.source !== raw.authority.cache) errors.push(`${label}.source does not match cache authority`)
  }
  for (const [index, command] of raw.databaseCommands.entries()) {
    const label = `raw databaseCommands[${index}]`
    if (!exactKeys(command, ['requestId', 'subcaseId', 'fingerprint', 'source'], label, errors)) continue
    validateReference(command, label)
    if (!digestPattern.test(String(command.fingerprint ?? ''))) errors.push(`${label}.fingerprint is invalid`)
    if (command.source !== raw.authority.database) errors.push(`${label}.source does not match database authority`)
  }
  const classifications = new Map()
  for (const [index, classification] of raw.cacheClassifications.entries()) {
    const label = `raw cacheClassifications[${index}]`
    if (!exactKeys(classification, ['requestId', 'subcaseId', 'layerSource', 'source'], label, errors)) continue
    validateReference(classification, label)
    if (classification.source !== raw.authority.cache) errors.push(`${label}.source does not match cache authority`)
    if (classifications.has(classification.requestId)) errors.push(`duplicate cache classification for request ${classification.requestId}`)
    classifications.set(classification.requestId, classification)
  }
  for (const request of raw.requests) {
    const classification = classifications.get(request.id)
    if (!classification) errors.push(`missing cache classification for request ${request.id}`)
    else if (classification.layerSource !== request.layerSource) errors.push(`cache classification does not match request ${request.id}`)
  }
  for (const [index, event] of raw.faultTimeline.entries()) {
    const label = `raw faultTimeline[${index}]`
    if (!exactKeys(event, ['atMs', 'kind', 'state', 'classification', 'requestId', 'subcaseId', 'source'], label, errors)) continue
    validateReference(event, label)
    if (event.source !== raw.authority.fault) errors.push(`${label}.source does not match fault authority`)
  }
  return raw
}

function readRawEvidence(receipt, repositoryRoot, errors) {
  const absolutePath = safeEvidencePath(repositoryRoot, receipt.rawEvidence.path, errors)
  if (!absolutePath) return null
  if (!fs.existsSync(absolutePath)) {
    errors.push(`raw evidence artifact is missing: ${receipt.rawEvidence.path}`)
    return null
  }
  const metadata = fs.lstatSync(absolutePath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    errors.push('raw evidence artifact must be a regular non-symlink file')
    return null
  }
  const physicalRoot = fs.realpathSync(path.resolve(repositoryRoot, '.tmp/perf/runtime-cache'))
  const physicalFile = fs.realpathSync(absolutePath)
  const physicalRelative = path.relative(physicalRoot, physicalFile)
  if (physicalRelative === '..' || physicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(physicalRelative)) {
    errors.push('raw evidence physical path escapes the current runtime-cache evidence root')
    return null
  }
  const bytes = fs.readFileSync(absolutePath)
  if (digest(bytes) !== receipt.rawEvidence.digest) errors.push('raw evidence artifact digest mismatch')
  let raw
  try { raw = JSON.parse(bytes.toString('utf8')) } catch { errors.push('raw evidence artifact is not valid JSON'); return null }
  return validateRawEvidenceDocument(raw, receipt, errors)
}

function findAssertion(receipt, id) {
  return receipt.assertions.find((assertion) => assertion.id === id)
}

function commandsForSubcase(raw, field, subcaseId) {
  return raw[field].filter((command) => command.subcaseId === subcaseId).length
}

function validateScenarioRequirements(receipt, scenario, raw, errors) {
  const requirements = scenario.requirements
  if (receipt.input.requestCount !== scenario.requests) errors.push(`request count must equal catalog value ${scenario.requests}`)
  if (receipt.input.concurrency !== scenario.concurrency) errors.push(`concurrency must equal catalog value ${scenario.concurrency}`)
  if (receipt.windows.warmup.requestCount !== scenario.warmupRequests) errors.push(`warmup count must equal catalog value ${scenario.warmupRequests}`)
  if (!exactArray(receipt.subcases, scenario.subcases)) errors.push('receipt subcases must exactly match the current catalog')
  const assertionIds = receipt.assertions.map((item) => item.id)
  if (!exactArray(assertionIds, scenario.requiredAssertions)) errors.push('receipt assertion IDs must exactly match the current catalog')
  const redisCount = raw?.redisCommands.length ?? receipt.commandSummary.redis.count
  const dbCount = raw?.databaseCommands.length ?? receipt.commandSummary.database.count
  if (Number.isInteger(requirements.redisCommandsMax) && redisCount > requirements.redisCommandsMax) errors.push(`redis command budget exceeded: ${redisCount} > ${requirements.redisCommandsMax}`)
  if (Number.isInteger(requirements.dbCommandsMax) && dbCount > requirements.dbCommandsMax) errors.push(`database command budget exceeded: ${dbCount} > ${requirements.dbCommandsMax}`)
  for (const [subcaseId, maximum] of Object.entries(requirements.redisCommandsMaxBySubcase ?? {})) {
    const count = raw ? commandsForSubcase(raw, 'redisCommands', subcaseId) : Number.POSITIVE_INFINITY
    if (!Number.isInteger(maximum) || maximum < 0 || count > maximum) errors.push(`${subcaseId} Redis command budget exceeded: ${count} > ${maximum}`)
  }
  for (const [subcaseId, maximum] of Object.entries(requirements.dbCommandsMaxBySubcase ?? {})) {
    const count = raw ? commandsForSubcase(raw, 'databaseCommands', subcaseId) : Number.POSITIVE_INFINITY
    if (!Number.isInteger(maximum) || maximum < 0 || count > maximum) errors.push(`${subcaseId} database command budget exceeded: ${count} > ${maximum}`)
  }
  if (requirements.logicalWithinBudget && receipt.memory.logicalBytes > receipt.memory.logicalBudgetBytes) errors.push('logical memory budget exceeded')
  if (requirements.capacityWithinBudget && receipt.memory.capacityBytes > receipt.memory.capacityBudgetBytes) errors.push('backing capacity budget exceeded')
  if (requirements.activeKeyedEntriesFinal === 0 && receipt.cleanupProof.activeKeyedEntries !== 0) errors.push('active keyed entries did not drain to zero')
  if (requirements.faults) {
    const observed = new Set(receipt.faultTimeline.map((event) => event.kind))
    for (const fault of requirements.faults) if (!observed.has(fault)) errors.push(`missing fault class: ${fault}`)
    for (const fault of requirements.faults) {
      const states = new Set(receipt.faultTimeline.filter((event) => event.kind === fault).map((event) => event.state))
      if (fault === 'recovery') {
        if (!states.has('observed')) errors.push('recovery was not observed')
      } else if (!states.has('injected') || !states.has('observed')) errors.push(`fault class ${fault} lacks injected/observed timeline`)
    }
  }
  if (requirements.nodes === 2) {
    for (const id of ['two-node-route', 'durable-convergence', 'residency-convergence']) if (findAssertion(receipt, id)?.status !== 'passed') errors.push(`two-node receipt lacks passing ${id}`)
  }
  if (requirements.rebuildCountBySubcase != null) {
    const assertion = findAssertion(receipt, 'rebuild-count')
    const rebuildFamily = rebuildFamilyByScenario.get(receipt.scenarioId)
    const observed = raw
      ? Object.fromEntries(Object.keys(requirements.rebuildCountBySubcase).map((subcaseId) => [
          subcaseId,
          raw.cacheEvents.filter((event) => event.subcaseId === subcaseId && event.outcome === 'built' &&
            (rebuildFamily == null || event.family === rebuildFamily)).length
        ]))
      : assertion?.actual
    if (!assertion || !exactArray(assertion.actual, observed) || !exactArray(observed, requirements.rebuildCountBySubcase)) {
      errors.push(`rebuild counts must exactly match ${canonicalJson(requirements.rebuildCountBySubcase)}`)
    }
  }
  if (raw && Number.isInteger(requirements.coldDbCommandsMax)
      && commandsForSubcase(raw, 'databaseCommands', 'cold') > requirements.coldDbCommandsMax) errors.push('cold database command budget exceeded')
  if (raw && requirements.hotLayer) {
    const hot = raw.requests.filter((request) => request.subcaseId === 'hot')
    if (hot.length === 0 || hot.some((request) => request.layerSource !== requirements.hotLayer)) errors.push(`hot subcase must use ${requirements.hotLayer}`)
  }
  if (raw && requirements.redisFaultLatencyRatioMax != null) {
    const l1 = raw.requests.filter((request) => request.subcaseId === 'l1-hit')
    const fault = raw.requests.filter((request) => request.subcaseId === 'redis-fault')
    if (l1.length === 0 || fault.length === 0) {
      errors.push('article detail L1/fault request windows are missing')
    } else {
      const invalid = [...l1, ...fault].filter((request) =>
        request.layerSource !== 'l1-object' && request.layerSource !== 'l1-frame')
      if (invalid.length > 0) errors.push('article detail sample did not remain on an L1 path')
      const ratio = percentile(fault.map((request) => request.latencyMs), 95) /
        Math.max(percentile(l1.map((request) => request.latencyMs), 95), 0.001)
      if (ratio > requirements.redisFaultLatencyRatioMax) {
        errors.push(`Redis fault changed L1 latency ratio: ${ratio} > ${requirements.redisFaultLatencyRatioMax}`)
      }
    }
  }
  if (raw && requirements.logicalDepthIndependentDbCommands) {
    const pageCounts = Object.fromEntries(requirements.logicalPages.map((page) =>
      [page, commandsForSubcase(raw, 'databaseCommands', `page-${page}`)]))
    const actual = evaluateLogicalPaginationDatabaseCommands(pageCounts, requirements)
    const assertion = findAssertion(receipt, 'logical-page-command-constant')
    if (!assertion || !exactArray(assertion.actual, actual)) errors.push('logical pagination assertion does not match raw evidence')
    if (Object.values(actual).some((value) => value !== true)) {
      errors.push(`logical pagination database command budget failed: ${canonicalJson(actual)}`)
    }
  }
  if (raw && requirements.cursorlessDeepRedisCommandsMax != null
      && commandsForSubcase(raw, 'redisCommands', 'cursorless-deep') > requirements.cursorlessDeepRedisCommandsMax) errors.push('cursorless deep Redis command budget exceeded')
  if (raw && requirements.cursorlessDeepDbCommandsMax != null
      && commandsForSubcase(raw, 'databaseCommands', 'cursorless-deep') > requirements.cursorlessDeepDbCommandsMax) errors.push('cursorless deep database command budget exceeded')
  if (requirements.uniqueKeys != null && Number(findAssertion(receipt, 'unique-key-count')?.actual) !== requirements.uniqueKeys) errors.push(`unique key count must equal ${requirements.uniqueKeys}`)
  if (requirements.classificationCount != null && Number(findAssertion(receipt, 'classification-count')?.actual) !== requirements.classificationCount) errors.push(`classification count must equal ${requirements.classificationCount}`)
  if (requirements.atomicRedisPublication && findAssertion(receipt, 'atomic-redis-publication')?.actual !== true) errors.push('atomic Redis publication was not proven')
  if (requirements.unsampledL1AllocationBytesMax != null && raw) {
    const allocation = raw.requests.filter((request) => request.subcaseId === 'unsampled-l1-hit').reduce((sum, request) => sum + request.allocatedBytes, 0)
    if (allocation > requirements.unsampledL1AllocationBytesMax) errors.push('unsampled L1 allocation budget exceeded')
  }
}

export function validateRuntimeCacheReceipt(receipt, options = {}) {
  const schema = options.schema ?? loadRuntimeCacheSchema(options.schemaPath)
  const catalog = options.catalog ?? loadRuntimeCacheCatalog(options.catalogPath)
  const errors = validateJsonSchema(receipt, schema)
  if (errors.length > 0) return errors

  const scenario = catalog.scenarios.find((item) => item.id === receipt.scenarioId)
  if (!scenario) errors.push(`scenario is not in current catalog: ${receipt.scenarioId}`)
  if (receipt.catalogDigest !== digest(catalog)) errors.push('catalogDigest does not bind the current catalog')
  const { contentDigest, ...payload } = receipt
  if (digest(payload) !== contentDigest) errors.push('contentDigest mismatch')
  if (!isTimestamp(receipt.generatedAt)) errors.push('generatedAt must be a UTC timestamp')
  for (const windowName of ['warmup', 'sample']) {
    const window = receipt.windows[windowName]
    if (!isTimestamp(window.startedAt) || !isTimestamp(window.endedAt) || Date.parse(window.startedAt) > Date.parse(window.endedAt)) errors.push(`${windowName} window timestamps are invalid`)
  }

  if (!exactArray(receipt.source.start, receipt.source.end)) errors.push('source identity changed between start and end')
  const expectedSource = options.expectedSource ?? currentSourceState(options.repositoryRoot ?? moduleRoot)
  for (const phase of ['start', 'end']) {
    for (const field of ['commit', 'dirty', 'statusDigest', 'worktreeFingerprint']) {
      if (receipt.source[phase][field] !== expectedSource[field]) errors.push(`source.${phase}.${field} does not match current source identity`)
    }
  }

  if (receipt.attemptId !== `${receipt.runId}.attempt-${receipt.attemptNumber}`) errors.push('attemptId does not bind runId and attemptNumber')
  if (receipt.status === 'passed') {
    if (receipt.firstFailure !== null) errors.push('passed receipt must not contain firstFailure')
    if (receipt.assertions.some((assertion) => assertion.status !== 'passed')) errors.push('passed receipt contains failed assertion')
  } else if (receipt.firstFailure === null) errors.push('failed receipt must preserve firstFailure')
  if (receipt.firstFailure !== null) {
    const { contentDigest: failureDigest, ...failurePayload } = receipt.firstFailure
    if (digest(failurePayload) !== failureDigest) errors.push('firstFailure contentDigest mismatch')
    if (receipt.firstFailure.attemptId !== receipt.attemptId || receipt.firstFailure.attemptNumber !== receipt.attemptNumber) errors.push('firstFailure does not bind the receipt attempt')
    if (receipt.firstFailure.rawEvidenceDigest !== receipt.rawEvidence.digest) errors.push('firstFailure does not bind raw evidence')
  }

  const assertionIds = receipt.assertions.map((assertion) => assertion.id)
  if (new Set(assertionIds).size !== assertionIds.length) errors.push('assertion IDs must be unique')
  for (const assertion of receipt.assertions) {
    const equal = canonicalJson(assertion.expected) === canonicalJson(assertion.actual)
    if ((assertion.status === 'passed') !== equal) errors.push(`assertion ${assertion.id} status does not match expected/actual`)
  }

  const raw = readRawEvidence(receipt, options.repositoryRoot ?? moduleRoot, errors)
  if (raw) {
    if (!exactArray(raw.requests, receipt.requests)) errors.push('receipt requests do not exactly match raw request evidence')
    const expectedCounts = {
      requests: raw.requests.length,
      redisCommands: raw.redisCommands.length,
      redisFailureEvents: raw.redisFailureEvents.length,
      cacheEvents: raw.cacheEvents.length,
      databaseCommands: raw.databaseCommands.length,
      cacheClassifications: raw.cacheClassifications.length,
      faultEvents: raw.faultTimeline.length
    }
    if (!exactArray(receipt.rawEvidence.rowCounts, expectedCounts)) errors.push('raw evidence row counts do not close')
    if (!exactArray(receipt.commandSummary.redis, redisRollup(raw.redisCommands))) errors.push('Redis command rollup does not match raw traces')
    if (!exactArray(receipt.commandSummary.database, databaseRollup(raw.databaseCommands))) errors.push('database command rollup does not match raw traces')
    const rawTimeline = raw.faultTimeline.map(({ source: _source, ...event }) => event)
    if (!exactArray(receipt.faultTimeline, rawTimeline)) errors.push('fault timeline does not match raw evidence')
    const observedSubcases = new Set(raw.requests.map((request) => request.subcaseId))
    for (const subcase of receipt.subcases) if (!observedSubcases.has(subcase)) errors.push(`subcase has no raw request evidence: ${subcase}`)
  }

  const requestIds = receipt.requests.map((request) => request.id)
  if (new Set(requestIds).size !== requestIds.length) errors.push('request IDs must be unique')
  if (receipt.requests.length !== receipt.input.requestCount) errors.push('request count does not match input.requestCount')
  if (receipt.windows.sample.requestCount !== receipt.requests.length) errors.push('sample window count does not match requests')
  const latencies = receipt.requests.map((request) => request.latencyMs)
  const expectedLatency = { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: Math.max(...latencies) }
  if (!exactArray(receipt.latencyMs, expectedLatency)) errors.push('latency quantiles do not match request traces')
  for (const group of new Set(receipt.requests.map((request) => request.parityGroup))) {
    const payloads = new Set(receipt.requests.filter((request) => request.parityGroup === group).map((request) => request.payloadDigest))
    if (payloads.size !== 1) errors.push(`payload parity failed for group ${group}`)
  }

  if (receipt.memory.capacityBytes < receipt.memory.logicalBytes) errors.push('backing capacity is smaller than logical bytes')
  if (receipt.memory.logicalBytes > receipt.memory.logicalBudgetBytes) errors.push('logical memory exceeds declared budget')
  if (receipt.memory.capacityBytes > receipt.memory.capacityBudgetBytes) errors.push('backing capacity exceeds declared budget')
  if (receipt.cleanupProof.status !== 'passed' || !receipt.cleanupProof.namespaceRemoved || receipt.cleanupProof.activeKeyedEntries !== 0) errors.push('cleanup proof is not complete')
  if (scenario) validateScenarioRequirements(receipt, scenario, raw, errors)
  return errors
}

export function validateRuntimeCacheReceiptSet(receipts, options = {}) {
  const catalog = options.catalog ?? loadRuntimeCacheCatalog(options.catalogPath)
  const expected = catalog.scenarios.map((scenario) => scenario.id)
  const actual = receipts.map((receipt) => receipt.scenarioId)
  const errors = []
  if (receipts.length !== expected.length) errors.push(`expected 13 receipts, found ${receipts.length}`)
  if (new Set(actual).size !== actual.length) errors.push('receipt scenario IDs must be unique')
  for (const id of expected) if (!actual.includes(id)) errors.push(`missing current-schema receipt: ${id}`)
  for (const id of actual) if (!expected.includes(id)) errors.push(`unexpected receipt scenario: ${id}`)
  for (const receipt of receipts) {
    for (const error of validateRuntimeCacheReceipt(receipt, { ...options, catalog })) errors.push(`${receipt.scenarioId ?? 'unknown'}: ${error}`)
  }
  const first = receipts[0]
  if (first) {
    const common = {
      runId: first.runId,
      source: first.source,
      runtime: first.runtime,
      dependencies: first.dependencies
    }
    for (const receipt of receipts) {
      if (!exactArray({ runId: receipt.runId, source: receipt.source, runtime: receipt.runtime, dependencies: receipt.dependencies }, common)) errors.push(`${receipt.scenarioId}: aggregate run/source/runtime identity mismatch`)
      if (receipt.status !== 'passed' || receipt.firstFailure !== null || receipt.attemptNumber !== 1) errors.push(`${receipt.scenarioId}: only clean first-attempt success qualifies`)
    }
  }
  return errors
}

function immutableWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) {
    const metadata = fs.lstatSync(file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`append-only target is not a regular file: ${file}`)
    if (fs.readFileSync(file).equals(Buffer.from(bytes))) return false
    throw new Error(`append-only evidence already exists with different content: ${file}`)
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  try {
    fs.linkSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return true
}

export function writeReceiptPreservingFirstFailure(file, receipt) {
  const firstFailureFile = path.join(path.dirname(file), 'first-failure.json')
  let normalized = { ...receipt }
  if (receipt.firstFailure !== null) normalized = { ...normalized, firstFailure: sealFirstFailure(receipt.firstFailure) }
  if (fs.existsSync(firstFailureFile)) {
    const preserved = JSON.parse(fs.readFileSync(firstFailureFile, 'utf8'))
    if (normalized.firstFailure === null || canonicalJson(normalized.firstFailure) !== canonicalJson(preserved)) throw new Error('first failure is append-only and blocks a later success in the same run')
  } else if (normalized.firstFailure !== null) {
    immutableWrite(firstFailureFile, `${JSON.stringify(normalized.firstFailure, null, 2)}\n`)
  }
  const sealed = sealReceipt(normalized)
  immutableWrite(file, `${JSON.stringify(sealed, null, 2)}\n`)
  return sealed
}
