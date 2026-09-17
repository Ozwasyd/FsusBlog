#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYamlDocument } from '../yaml/parse-document.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = path.resolve(path.join(path.dirname(scriptPath), '..', '..'))
const catalogSchema = 'fsusblog.security-matrix-catalog.v1'
const errors = []
let root = defaultRoot

function fail(message) {
  errors.push(`[security-matrix] ${message}`)
}

function repoPathExists(value) {
  if (value.startsWith('.tmp/')) return true
  if (value.startsWith('src/frontend/test-results/')) return true
  return fs.existsSync(path.join(root, value))
}

function parseEntries(document, listKey) {
  const records = document[listKey]
  if (!Array.isArray(records)) return []
  return records.map((record) => {
    const fields = record && typeof record === 'object' && !Array.isArray(record)
      ? new Set(Object.keys(record))
      : new Set()
    const paths = []
    for (const section of ['code', 'tests', 'evidence']) {
      for (const value of Array.isArray(record?.[section]) ? record[section] : []) {
        paths.push({ section, value: String(value).trim() })
      }
    }
    return { id: String(record?.id ?? '').trim(), fields, paths }
  })
}

function verifyRiskControlMatrix(text) {
  const requiredScenarioIds = [
    'RISKCONTROL-DECISION-MODES',
    'RISKCONTROL-PROVIDER-SURFACES',
    'RISKCONTROL-PROOF-BINDING',
    'RISKCONTROL-INTEGRATION-SURFACES',
    'RISKCONTROL-E2E-FAILURE-MODES',
    'RISKCONTROL-PERFORMANCE-BUDGETS',
    'RISKCONTROL-FAULT-MODES'
  ]
  const requiredTokens = [
    'allow',
    'challenge',
    'step-up',
    'queue',
    'throttle',
    'block',
    'sha256PowV1',
    'perceptionLocalizationV2',
    'perceptionMicroInteractionV2',
    'perceptionCharacterV3',
    'argon2idPoSpaceV1',
    'humanReadProofV1',
    'passkeyStepUpV1',
    'adminPasskeyStepUpV1',
    'replay',
    'expired',
    'action-mismatch',
    'route-mismatch',
    'device-mismatch',
    'auth',
    'comment',
    'public-read',
    'notification',
    'admin-policy',
    'desktop',
    'mobile',
    'wasm-failure',
    'canvas-fallback',
    'worker-failure',
    'slow-device',
    'redis-unavailable',
    'postgres-slow-write',
    'provider-missing',
    'policy-load-failure'
  ]
  const budgetLimits = {
    decisionP99Ms: 10,
    powVerifyP99Ms: 100,
    perceptionVerifyP99Ms: 100,
    proofConsumeP99Ms: 25
  }

  for (const id of requiredScenarioIds) {
    if (!text.includes(`id: ${id}`)) {
      fail(`risk-control matrix missing scenario ${id}`)
    }
  }

  for (const token of requiredTokens) {
    if (!text.includes(token)) {
      fail(`risk-control matrix missing required coverage token ${token}`)
    }
  }

  for (const [budgetName, maxValue] of Object.entries(budgetLimits)) {
    const match = text.match(new RegExp(`\\b${budgetName}:\\s+(\\d+)\\b`))
    if (!match) {
      fail(`risk-control matrix missing performance budget ${budgetName}`)
      continue
    }

    const value = Number(match[1])
    if (!Number.isFinite(value) || value <= 0 || value > maxValue) {
      fail(`risk-control matrix budget ${budgetName}=${value} exceeds fail-closed max ${maxValue}`)
    }
  }
}

function verifyPerceptionV2Matrix(text) {
  const requiredScenarioIds = [
    'PERCEPTION-V2-CONTRACTS',
    'PERCEPTION-V2-UNIT-CRYPTO',
    'PERCEPTION-V2-INTEGRATION-HOTPATH',
    'PERCEPTION-V2-GENERATOR-STRUCTURE',
    'PERCEPTION-V2-E2E-FRONTEND',
    'PERCEPTION-V2-E2E-RUNTIME',
    'PERCEPTION-V2-PERFORMANCE-BUDGETS',
    'PERCEPTION-V2-FAILURE-MODES'
  ]
  const requiredTokens = [
    'AEDS frame',
    'forbidden-fields',
    'answer',
    'glyphIds',
    'charIds',
    'expectedPoint',
    'recipeHash',
    'sealedToken',
    'AEAD',
    'O(1) verify',
    'constant-time compare',
    'challengeId-mismatch',
    'action-mismatch',
    'routeKey-mismatch',
    'subjectHash-mismatch',
    'clientIpHash-mismatch',
    'deviceFpHash-mismatch',
    'policyVersion-mismatch',
    'recipeHash-mismatch',
    'solveDuration',
    'issue-no-db-redis-write',
    'verify-redis-setnx-incr',
    'async-audit',
    'verify-no-image-recompute',
    'family-structural-builders',
    'variant-structural-delta',
    'localization-target-visual-binding',
    'recipeHash-structural-tamper',
    'localization',
    'micro-interaction-disabled',
    'micro-interaction-enabled',
    'worker-failure',
    'mobile-fallback',
    'contract-only',
    'provider-only',
    'e2e-runtime',
    'comment.create',
    'business-action-resume',
    'wrong-answer',
    'expired',
    'duplicate-submit',
    'route-mismatch',
    'async-audit-queue-nonblocking',
    'issue-p99',
    'verify-p99',
    'payload-size',
    'client-render-p95',
    'budget-ci-fail',
    'redis-unavailable',
    'postgres-slow-write',
    'provider-missing',
    'policy-load-failure'
  ]
  const perceptionBudgetLimits = {
    issueP99Ms: 8,
    verifyP99Ms: 32,
    payloadP95Bytes: 6200,
    clientRenderP95Ms: 55
  }

  for (const id of requiredScenarioIds) {
    if (!text.includes(`id: ${id}`)) {
      fail(`perception-v2 matrix missing scenario ${id}`)
    }
  }

  for (const token of requiredTokens) {
    if (!text.includes(token)) {
      fail(`perception-v2 matrix missing required coverage token ${token}`)
    }
  }

  for (const [budgetName, maxValue] of Object.entries(perceptionBudgetLimits)) {
    const match = text.match(new RegExp(`\\b${budgetName}:\\s+(\\d+)\\b`))
    if (!match) {
      fail(`perception-v2 matrix missing performance budget ${budgetName}`)
      continue
    }

    const value = Number(match[1])
    if (!Number.isFinite(value) || value <= 0 || value > maxValue) {
      fail(`perception-v2 matrix budget ${budgetName}=${value} exceeds fail-closed max ${maxValue}`)
    }
  }
}

function verifyPrivacyZkCommentMatrix(text) {
  const requiredScenarioIds = [
    'PRIVACY-ZK-AUTHOR-MODE-RETIREMENT',
    'PRIVACY-ZK-CIRCUIT-CONTRACT',
    'PRIVACY-ZK-TRUSTED-SETUP',
    'PRIVACY-ZK-TRANSPORT',
    'PRIVACY-ZK-FAIL-CLOSED',
    'PRIVACY-ZK-TICKET-NULLIFIER',
    'PRIVACY-ZK-MODERATION-LOGGING',
    'PRIVACY-ZK-FRONTEND-RUNTIME',
    'PRIVACY-ZK-CONCURRENCY',
    'PRIVACY-ZK-PUBLIC-REVOCATION-DISTRIBUTION',
    'PRIVACY-ZK-PROD-SMOKE'
  ]
  const requiredPrivacyCases = [
    'retired-anonymous-zero-write',
    'public-explicit-opt-in',
    'zk-no-identity-headers',
    'zk-unavailable-no-downgrade',
    'legacy-migration-preserves-display-structure-visibility',
    'legacy-nullifier-isolated',
    'no-cookie',
    'no-authorization',
    'cookie-rejected',
    'authorization-rejected',
    'comment.user_id:null',
    'zk-failure-no-anonymous-downgrade',
    'zk-failure-no-public-publish',
    'verifier-unavailable-fail-closed',
    'root-expired-fail-closed',
    'proof-invalid-fail-closed',
    'ticket-consume-once',
    'ticket-expired-rejected',
    'same-article-scope-stable-nullifier',
    'different-article-scope-different-nullifier',
    'blocked-nullifier-rejected',
    'scope-limit-exceeded-rejected',
    'provider-no-userId-username-proof-raw-nullifier',
    'log-redaction-proof-witness-credential-secret-raw-nullifier-cookie-authorization',
    'admin-no-account-reversal',
    'public-signature-explicit-opt-in',
    'blind-credential-possession',
    'credential-root-membership',
    'revocation-non-membership-witness',
    'nullifier-secret-action-scope-binding',
    'policy-bucket-legality',
    'no-userId-username-inputs',
    'tamper-root',
    'tamper-revocation-root',
    'tamper-scope',
    'tamper-non-current-layout',
    'ceremony-manifest-fail-closed',
    'vk-hash-binding',
    'srs-transcript-consistency',
    'public-input-layout-upgrade-new-ceremony',
    'pk-vk-artifact-paths',
    'placeholder-vk-hash-rejected',
    'happy-path-smoke',
    'cookie-contamination-negative-smoke',
    'ticket-replay-negative-smoke',
    'tampered-proof-negative-smoke',
    'feature-flag-off-expected-unavailable',
    'cross-scope-nullifier-independence-smoke',
    'real-native-verifier-wasm-prover-evidence',
    'proof-ticket-credential-redacted',
    'same-url-size-response-shape-two-credentials',
    'no-commitment-handle-leaf-stable-id',
    'retired-endpoint-410-no-body-parse',
    'full-snapshot-local-witness',
    'exact-base-delta-update',
    'tamper-content-hash-reject',
    'tamper-binding-reject',
    'root-mismatch-reject',
    'epoch-version-rollback-reject',
    'stale-reject',
    'low-memory-download-budget',
    'worker-cpu-budget',
    'no-handle-log-telemetry'
  ]
  const requiredConcurrencyCases = [
    'concurrent-same-nullifier-scope-policy-limit',
    'concurrent-ticket-consume-once',
    'root-snapshot-cached-high-frequency',
    'verifier-bounded-concurrency',
    'anonymous-ticket-identity-filter-cheap-reject',
    'comment-submit-invalidation-nonblocking'
  ]
  const requiredCommands = [
    'check:privacy-zk-contract',
    'check:privacy-zk-frontend',
    'check:privacy-zk-backend',
    'check:privacy-zk-concurrency',
    'check:privacy-zk-prod-smoke',
    'check:public-revocation-distribution'
  ]

  for (const id of requiredScenarioIds) {
    if (!text.includes(`id: ${id}`)) {
      fail(`privacy-zk matrix missing scenario ${id}`)
    }
  }

  for (const token of requiredPrivacyCases) {
    if (!text.includes(token)) {
      fail(`privacy-zk matrix missing required case ${token}`)
    }
  }

  for (const token of requiredConcurrencyCases) {
    if (!text.includes(token)) {
      fail(`privacy-zk matrix missing concurrency case ${token}`)
    }
  }

  for (const command of requiredCommands) {
    if (!text.includes(command)) {
      fail(`privacy-zk matrix missing local command ${command}`)
    }
  }
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--root' && argument !== '--catalog') {
      throw new Error(`unknown argument ${argument}`)
    }

    const value = argv[index + 1]
    if (!value) {
      throw new Error(`${argument} requires a path`)
    }
    parsed[argument.slice(2)] = value
    index += 1
  }
  return parsed
}

function displayPath(file) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/')
  return relative.startsWith('../') ? file : relative
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isRepositoryRelativePath(value) {
  if (!isNonEmptyString(value) || path.isAbsolute(value) || value.includes('\\')) return false
  const normalized = path.posix.normalize(value)
  return normalized === value && normalized !== '..' && !normalized.startsWith('../')
}

function readCatalog(file) {
  if (!fs.existsSync(file)) {
    fail(`missing matrix catalog ${displayPath(file)}`)
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`invalid matrix catalog JSON ${displayPath(file)}: ${error.message}`)
    return null
  }
}

function parseTopLevelMetadata(document) {
  const metadata = new Map()
  for (const [key, value] of Object.entries(document)) {
    if (value == null || typeof value === 'object') continue
    metadata.set(key, String(value))
  }
  return metadata
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return []

  if (catalog.schema !== catalogSchema) {
    fail(`catalog schema must be ${catalogSchema}, got ${String(catalog.schema)}`)
  }
  for (const field of ['version', 'owner', 'checker']) {
    if (!isNonEmptyString(catalog[field])) {
      fail(`catalog is missing ${field}`)
    }
  }
  if (isNonEmptyString(catalog.checker)) {
    if (!isRepositoryRelativePath(catalog.checker)) {
      fail(`catalog checker must be a repository-relative path: ${catalog.checker}`)
    } else if (!fs.existsSync(path.join(root, catalog.checker))) {
      fail(`catalog checker does not exist: ${catalog.checker}`)
    }
  }

  if (!Array.isArray(catalog.matrices) || catalog.matrices.length === 0) {
    fail('catalog matrices must be a non-empty array')
    return []
  }

  const checks = []
  const ids = new Set()
  const matrixPaths = new Set()
  for (const [index, matrix] of catalog.matrices.entries()) {
    const location = `catalog matrices[${index}]`
    if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
      fail(`${location} must be an object`)
      continue
    }

    for (const field of ['id', 'path', 'family', 'schema', 'version', 'owner', 'checker']) {
      if (!isNonEmptyString(matrix[field])) {
        fail(`${location} is missing ${field}`)
      }
    }

    if (isNonEmptyString(matrix.id)) {
      if (ids.has(matrix.id)) fail(`catalog has duplicate matrix id ${matrix.id}`)
      ids.add(matrix.id)
    }

    if (isNonEmptyString(matrix.path)) {
      if (!isRepositoryRelativePath(matrix.path) ||
          !matrix.path.startsWith('security/matrices/') ||
          !matrix.path.endsWith('.yml')) {
        fail(`${location} path must be a canonical YAML path under security/matrices/: ${matrix.path}`)
      }
      if (matrixPaths.has(matrix.path)) fail(`catalog has duplicate matrix path ${matrix.path}`)
      matrixPaths.add(matrix.path)
    }

    if (isNonEmptyString(matrix.checker)) {
      if (!isRepositoryRelativePath(matrix.checker)) {
        fail(`${location} checker must be a repository-relative path: ${matrix.checker}`)
      } else if (!fs.existsSync(path.join(root, matrix.checker))) {
        fail(`${location} checker does not exist: ${matrix.checker}`)
      }
      if (isNonEmptyString(catalog.checker) && matrix.checker !== catalog.checker) {
        fail(`${location} checker ${matrix.checker} does not match catalog checker ${catalog.checker}`)
      }
    }

    const validation = matrix.validation
    if (!validation || typeof validation !== 'object' || Array.isArray(validation)) {
      fail(`${location} is missing validation`)
      continue
    }
    for (const field of ['entryList', 'idPattern', 'profile']) {
      if (!isNonEmptyString(validation[field])) {
        fail(`${location} validation is missing ${field}`)
      }
    }

    let idPattern = null
    if (isNonEmptyString(validation.idPattern)) {
      try {
        idPattern = new RegExp(validation.idPattern)
      } catch (error) {
        fail(`${location} validation idPattern is invalid: ${error.message}`)
      }
    }

    if (isNonEmptyString(matrix.path)) {
      checks.push({ ...matrix, validation, idPattern })
    }
  }

  return checks
}

function verifyMatrix(check) {
  const absolute = path.join(root, check.path)
  if (!fs.existsSync(absolute)) {
    fail(`missing ${check.path}`)
    return
  }

  const text = fs.readFileSync(absolute, 'utf8')
  let document
  try {
    document = parseYamlDocument(text, { source: check.path })
  } catch (error) {
    fail(`${check.path} is invalid YAML: ${error.message}`)
    return
  }
  const metadata = parseTopLevelMetadata(document)
  for (const field of ['schema', 'family', 'version', 'owner', 'checker']) {
    if (metadata.get(field) !== check[field]) {
      fail(`${check.path} ${field}=${String(metadata.get(field))} does not match catalog value ${String(check[field])}`)
    }
  }

  const listKey = check.validation.entryList
  if (!Object.hasOwn(document, listKey)) {
    fail(`${check.path} is missing ${listKey}`)
  }

  const entries = parseEntries(document, listKey)
  if (entries.length === 0) {
    fail(`${check.path} has no entries`)
    return
  }

  const entryIds = new Set()
  for (const entry of entries) {
    if (entryIds.has(entry.id)) fail(`${check.path} has duplicate entry id ${entry.id}`)
    entryIds.add(entry.id)

    if (check.idPattern && !check.idPattern.test(entry.id)) {
      fail(`${check.path} has invalid ${check.family} id: ${entry.id}`)
    }

    for (const field of ['owner', 'status', 'code', 'tests', 'evidence']) {
      if (!entry.fields.has(field)) {
        fail(`${check.path} ${entry.id} is missing ${field}`)
      }
    }

    for (const section of ['code', 'tests', 'evidence']) {
      if (!entry.paths.some((item) => item.section === section)) {
        fail(`${check.path} ${entry.id} has empty ${section}`)
      }
    }

    for (const item of entry.paths) {
      if (!isRepositoryRelativePath(item.value)) {
        fail(`${check.path} ${entry.id} has unsafe ${item.section} path: ${item.value}`)
      } else if (!repoPathExists(item.value)) {
        fail(`${check.path} ${entry.id} references missing ${item.section} path: ${item.value}`)
      }
    }
  }

  switch (check.validation.profile) {
    case 'baseline':
      break
    case 'risk-control':
      verifyRiskControlMatrix(text)
      break
    case 'perception-v2':
      verifyPerceptionV2Matrix(text)
      break
    case 'privacy-zk-comment':
      verifyPrivacyZkCommentMatrix(text)
      break
    default:
      fail(`${check.path} declares unsupported validation profile ${String(check.validation.profile)}`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  root = path.resolve(args.root ?? defaultRoot)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(`repository root does not exist: ${root}`)
    return
  }

  const catalogFile = args.catalog
    ? path.resolve(args.catalog)
    : path.join(root, 'security/matrices/catalog.json')
  const catalog = readCatalog(catalogFile)
  for (const check of validateCatalog(catalog)) {
    verifyMatrix(check)
  }
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exitCode = 1
} else {
  console.log('[security-matrix] ok')
}
