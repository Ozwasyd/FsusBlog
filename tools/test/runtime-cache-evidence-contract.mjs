import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateJsonSchema } from '../test-matrix/schema-validator/validate.mjs'

export const RUNTIME_CACHE_RECEIPT_SCHEMA = 'fsusblog.runtime-cache-scenario-receipt.v1'
export const RUNTIME_CACHE_CATALOG_SCHEMA = 'fsusblog.runtime-cache-evidence-catalog.v1'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultCatalogPath = path.join(moduleRoot, 'config/testing/runtime-cache-evidence-catalog.json')
const defaultSchemaPath = path.join(moduleRoot, 'config/schemas/runtime-cache-scenario-receipt.schema.json')

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function digest(value) {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')}`
}

export function sealReceipt(receipt) {
  const { contentDigest: _ignored, ...payload } = receipt
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
    worktreeFingerprint: digest({ status, trackedPatch, untracked })
  }
}

export function loadRuntimeCacheCatalog(customPath = defaultCatalogPath) {
  const catalog = JSON.parse(fs.readFileSync(customPath, 'utf8').replace(/^\uFEFF/u, ''))
  if (catalog.schema !== RUNTIME_CACHE_CATALOG_SCHEMA) throw new Error(`unsupported runtime cache catalog schema: ${catalog.schema}`)
  if (catalog.receiptSchema !== RUNTIME_CACHE_RECEIPT_SCHEMA) throw new Error(`catalog receipt schema mismatch: ${catalog.receiptSchema}`)
  if (!Array.isArray(catalog.scenarios) || catalog.scenarios.length !== 13) throw new Error('runtime cache catalog must contain exactly 13 scenarios')
  const ids = catalog.scenarios.map((scenario) => scenario.id)
  if (new Set(ids).size !== ids.length) throw new Error('runtime cache catalog scenario IDs must be unique')
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

function commandRollup(commands, categorySelector) {
  const byCategory = {}
  for (const command of commands) {
    const category = categorySelector(command)
    byCategory[category] = (byCategory[category] ?? 0) + 1
  }
  return { count: commands.length, byCategory }
}

function equalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function validateScenarioRequirements(receipt, scenario, errors) {
  const requirements = scenario.requirements
  if (receipt.input.requestCount !== scenario.requests) errors.push(`request count must equal catalog value ${scenario.requests}`)
  if (receipt.input.concurrency !== scenario.concurrency) errors.push(`concurrency must equal catalog value ${scenario.concurrency}`)
  if (receipt.windows.warmup.requestCount !== scenario.warmupRequests) errors.push(`warmup count must equal catalog value ${scenario.warmupRequests}`)
  const assertionIds = new Set(receipt.assertions.map((item) => item.id))
  for (const id of scenario.requiredAssertions ?? []) if (!assertionIds.has(id)) errors.push(`missing required assertion: ${id}`)
  const redisCount = receipt.commandSummary.redis.count
  const dbCount = receipt.commandSummary.database.count
  if (Number.isInteger(requirements.redisCommandsMax) && redisCount > requirements.redisCommandsMax) errors.push(`redis command budget exceeded: ${redisCount} > ${requirements.redisCommandsMax}`)
  if (Number.isInteger(requirements.dbCommandsMax) && dbCount > requirements.dbCommandsMax) errors.push(`database command budget exceeded: ${dbCount} > ${requirements.dbCommandsMax}`)
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
      } else if (!states.has('injected') || !states.has('observed')) {
        errors.push(`fault class ${fault} lacks injected/observed timeline`)
      }
    }
  }
  if (requirements.nodes === 2) {
    if (!assertionIds.has('two-node-route') || !assertionIds.has('durable-convergence') || !assertionIds.has('residency-convergence')) errors.push('two-node receipt lacks route, durable, or residency convergence assertion')
  }
  if (requirements.rebuildCountMax != null) {
    const assertion = receipt.assertions.find((item) => item.id === 'rebuild-count')
    if (!assertion || Number(assertion.actual) > requirements.rebuildCountMax) errors.push(`rebuild count must be <= ${requirements.rebuildCountMax}`)
  }
}

export function validateRuntimeCacheReceipt(receipt, options = {}) {
  const schema = options.schema ?? loadRuntimeCacheSchema(options.schemaPath)
  const catalog = options.catalog ?? loadRuntimeCacheCatalog(options.catalogPath)
  const errors = validateJsonSchema(receipt, schema)
  if (errors.length > 0) return errors

  const scenario = catalog.scenarios.find((item) => item.id === receipt.scenarioId)
  if (!scenario) errors.push(`scenario is not in current catalog: ${receipt.scenarioId}`)
  const { contentDigest, ...payload } = receipt
  if (digest(payload) !== contentDigest) errors.push('contentDigest mismatch')

  const expectedSource = options.expectedSource ?? currentSourceState(options.repositoryRoot ?? moduleRoot)
  for (const field of ['commit', 'dirty', 'worktreeFingerprint']) {
    if (receipt.source[field] !== expectedSource[field]) errors.push(`source.${field} does not match current source identity`)
  }

  if (receipt.status === 'passed') {
    if (receipt.firstFailure !== null) errors.push('passed receipt must not contain firstFailure')
    if (receipt.assertions.some((assertion) => assertion.status !== 'passed')) errors.push('passed receipt contains failed assertion')
  } else if (receipt.firstFailure === null) {
    errors.push('failed receipt must preserve firstFailure')
  }

  const requestIds = receipt.requests.map((request) => request.id)
  if (new Set(requestIds).size !== requestIds.length) errors.push('request IDs must be unique')
  if (receipt.requests.length !== receipt.input.requestCount) errors.push('request count does not match input.requestCount')
  if (receipt.windows.sample.requestCount !== receipt.requests.length) errors.push('sample window count does not match requests')

  const redisCommands = receipt.requests.flatMap((request) => request.redisCommands)
  const dbCommands = receipt.requests.flatMap((request) => request.dbCommands)
  if (!equalJson(receipt.commandSummary.redis, commandRollup(redisCommands, (command) => command.category))) errors.push('Redis command rollup does not match request traces')
  if (!equalJson(receipt.commandSummary.database, commandRollup(dbCommands, (command) => command.fingerprint))) errors.push('database command rollup does not match request traces')

  const latencies = receipt.requests.map((request) => request.latencyMs)
  const expectedLatency = { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: Math.max(...latencies) }
  if (!equalJson(receipt.latencyMs, expectedLatency)) errors.push('latency quantiles do not match request traces')

  for (const group of new Set(receipt.requests.map((request) => request.parityGroup))) {
    const payloads = new Set(receipt.requests.filter((request) => request.parityGroup === group).map((request) => request.payloadDigest))
    if (payloads.size !== 1) errors.push(`payload parity failed for group ${group}`)
  }

  if (receipt.memory.logicalBytes > receipt.memory.logicalBudgetBytes) errors.push('logical memory exceeds declared budget')
  if (receipt.memory.capacityBytes > receipt.memory.capacityBudgetBytes) errors.push('backing capacity exceeds declared budget')
  if (!receipt.cleanupProof.namespaceRemoved) errors.push('cleanup did not remove the run namespace')
  if (scenario) validateScenarioRequirements(receipt, scenario, errors)
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
  for (const receipt of receipts) {
    for (const error of validateRuntimeCacheReceipt(receipt, { ...options, catalog })) errors.push(`${receipt.scenarioId ?? 'unknown'}: ${error}`)
  }
  return errors
}

export function writeReceiptPreservingFirstFailure(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let firstFailure = receipt.firstFailure
  if (fs.existsSync(file)) {
    const prior = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
    if (prior.schema === RUNTIME_CACHE_RECEIPT_SCHEMA && prior.firstFailure !== null) firstFailure = prior.firstFailure
  }
  const sealed = sealReceipt({ ...receipt, firstFailure })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(sealed, null, 2)}\n`)
  fs.renameSync(temporary, file)
  return sealed
}
