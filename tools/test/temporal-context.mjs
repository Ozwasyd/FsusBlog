import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const policyPath = path.join(repositoryRoot, 'config/testing/temporal-policy.json')
const ledgerPath = path.join(repositoryRoot, 'config/testing/temporal-callsite-dispositions.json')
const policy = JSON.parse(readFileSync(policyPath, 'utf8'))

export const TEMPORAL_CONTEXT_SCHEMA = 'fsusblog.test-temporal-context.v1'
export const TEMPORAL_PLAN_SCHEMA = 'fsusblog.test-temporal-plan.v1'
export const TEMPORAL_ACTUAL_SCHEMA = 'fsusblog.test-temporal-actual.v1'
export const TEMPORAL_RECEIPT_SCHEMA = 'fsusblog.test-temporal-receipt.v1'
export const TEMPORAL_LEDGER_SCHEMA = 'fsusblog.temporal-callsite-ledger.v1'

export const temporalClockKinds = Object.freeze([...policy.clockKinds])
export const temporalAuthorityKinds = Object.freeze([...policy.authorityKinds])
export const temporalReasonCodes = Object.freeze([...policy.reasonCodes])

const contextFields = Object.freeze([
  'sourceCommit',
  'sourceFingerprint',
  'producerId',
  'schedulerRunId',
  'businessEpochUtc',
  'businessClockMode',
  'businessClockStepPolicy',
  'timezone',
  'locale',
  'uiLocale',
  'backendCulture',
  'postgresTimezone',
  'nodeTimezone',
  'calendar',
  'firstDayOfWeek',
  'monotonicClockSource',
  'timeoutPolicyDigest',
  'temporalPolicyDigest',
  'ledgerSource'
])

const unresolvedDispositions = new Set(['unknown', 'requires-explicit'])

export class TemporalContractError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(`${reasonCode}: ${message}`)
    this.name = 'TemporalContractError'
    this.reasonCode = reasonCode
    this.details = details
  }
}

function fail(reasonCode, message, details) {
  throw new TemporalContractError(reasonCode, message, details)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function digestCanonical(value) {
  return sha256(canonicalJson(value))
}

function requiredText(value, field, reasonCode = 'temporal.context-invalid') {
  if (typeof value !== 'string' || !value.trim()) fail(reasonCode, `${field} is required`)
  return value.trim()
}

function exactEnum(value, allowed, field) {
  if (!allowed.includes(value)) fail('temporal.context-invalid', `${field} is not a stable enum value`, { field, value })
  return value
}

function validateDigest(value, field) {
  const normalized = requiredText(value, field)
  if (!/^sha256:[0-9a-f]{64}$/u.test(normalized)) fail('temporal.context-invalid', `${field} must be a sha256 digest`)
  return normalized
}

function validateEpoch(value) {
  const epoch = requiredText(value, 'businessEpochUtc')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u.test(epoch)
      || !Number.isFinite(Date.parse(epoch))) {
    fail('temporal.context-invalid', 'businessEpochUtc must be an RFC3339 UTC instant')
  }
  return epoch
}

function immutableRegularFile(file, label) {
  const resolved = path.resolve(repositoryRoot, file)
  if (lstatSync(resolved).isSymbolicLink()) fail('temporal.ledger-source-mismatch', `${label} must not be a symlink`)
  const realRoot = realpathSync(repositoryRoot)
  const realFile = realpathSync(resolved)
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) fail('temporal.ledger-source-mismatch', `${label} escapes repository`)
  const stat = statSync(realFile)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('temporal.ledger-source-mismatch', `${label} must be a regular file`)
  return realFile
}

export function validateTemporalLedgerDocument(document) {
  if (document.schema !== TEMPORAL_LEDGER_SCHEMA || document.authorityKind !== 'immutable-ledger'
      || !Array.isArray(document.governedSources) || !Array.isArray(document.entries)) {
    fail('temporal.ledger-source-mismatch', 'temporal ledger header is invalid')
  }
  const ids = new Set()
  for (const entry of document.entries) {
    const callSiteId = requiredText(entry?.callSiteId, 'callSiteId')
    if (ids.has(callSiteId)) fail('temporal.ledger-source-mismatch', `duplicate call-site ID: ${callSiteId}`)
    ids.add(callSiteId)
    requiredText(entry.path, `${callSiteId}.path`)
    requiredText(entry.symbol, `${callSiteId}.symbol`)
    requiredText(entry.sourceAnchor, `${callSiteId}.sourceAnchor`)
    requiredText(entry.api, `${callSiteId}.api`)
    exactEnum(entry.clockKind, policy.clockKinds, `${callSiteId}.clockKind`)
    exactEnum(entry.authorityKind, policy.authorityKinds, `${callSiteId}.authorityKind`)
    exactEnum(entry.disposition, policy.dispositions, `${callSiteId}.disposition`)
    if (!['included', 'excluded'].includes(entry.semanticEffect)) {
      fail('temporal.ledger-source-mismatch', `${callSiteId}.semanticEffect is invalid`)
    }
    if (!['canonical-injected', 'runtime-monotonic', 'artifact-only', 'operability-only'].includes(entry.ingress)) {
      fail('temporal.ledger-source-mismatch', `${callSiteId}.ingress is invalid`)
    }
  }
  const unresolved = document.entries.filter((entry) => unresolvedDispositions.has(entry.disposition))
  return { document, unresolved }
}

export function readTemporalLedger(file = ledgerPath) {
  const resolved = immutableRegularFile(path.relative(repositoryRoot, file), 'temporal ledger')
  const bytes = readFileSync(resolved)
  const { document, unresolved } = validateTemporalLedgerDocument(JSON.parse(bytes.toString('utf8')))
  return {
    document,
    digest: sha256(bytes),
    unresolved,
    path: path.relative(repositoryRoot, resolved).replaceAll(path.sep, '/')
  }
}

export function validateTemporalContext(value, { requireQualificationDefaults = true } = {}) {
  if (!plainObject(value)) fail('temporal.context-missing', 'temporal context is required')
  if (value.schema !== TEMPORAL_CONTEXT_SCHEMA) fail('temporal.context-invalid', 'temporal context schema is invalid')
  const normalized = { schema: TEMPORAL_CONTEXT_SCHEMA }
  for (const field of contextFields) {
    if (!(field in value)) fail('temporal.context-invalid', `${field} is required`)
    normalized[field] = value[field]
  }
  normalized.sourceCommit = requiredText(normalized.sourceCommit, 'sourceCommit')
  if (!/^[0-9a-f]{40}$/u.test(normalized.sourceCommit)) fail('temporal.context-invalid', 'sourceCommit must be a full commit')
  normalized.sourceFingerprint = validateDigest(normalized.sourceFingerprint, 'sourceFingerprint')
  normalized.producerId = requiredText(normalized.producerId, 'producerId')
  if (!/^[a-z][a-z0-9-]*$/u.test(normalized.producerId)) fail('temporal.context-invalid', 'producerId is invalid')
  normalized.schedulerRunId = requiredText(normalized.schedulerRunId, 'schedulerRunId')
  normalized.businessEpochUtc = validateEpoch(normalized.businessEpochUtc)
  exactEnum(normalized.businessClockMode, ['fixed', 'manually-advanced'], 'businessClockMode')
  exactEnum(normalized.businessClockStepPolicy, ['none', 'explicit-only'], 'businessClockStepPolicy')
  exactEnum(normalized.monotonicClockSource, policy.qualificationDefaults.monotonicClockSource === 'performance-now'
    ? ['performance-now', 'process-hrtime-bigint', 'dotnet-stopwatch']
    : policy.clockKinds, 'monotonicClockSource')
  validateDigest(normalized.timeoutPolicyDigest, 'timeoutPolicyDigest')
  validateDigest(normalized.temporalPolicyDigest, 'temporalPolicyDigest')
  for (const field of ['timezone', 'locale', 'uiLocale', 'backendCulture', 'postgresTimezone', 'nodeTimezone', 'calendar', 'firstDayOfWeek']) {
    normalized[field] = requiredText(normalized[field], field)
  }
  if (!plainObject(normalized.ledgerSource)
      || normalized.ledgerSource.authorityKind !== 'immutable-ledger'
      || normalized.ledgerSource.path !== 'config/testing/temporal-callsite-dispositions.json') {
    fail('temporal.ledger-source-mismatch', 'ledgerSource authority/path is invalid')
  }
  normalized.ledgerSource = {
    authorityKind: 'immutable-ledger',
    path: normalized.ledgerSource.path,
    digest: validateDigest(normalized.ledgerSource.digest, 'ledgerSource.digest')
  }
  if (requireQualificationDefaults) {
    for (const field of ['timezone', 'backendCulture', 'postgresTimezone', 'nodeTimezone', 'calendar', 'firstDayOfWeek']) {
      if (normalized[field] !== policy.qualificationDefaults[field]) {
        fail('temporal.context-invalid', `${field} does not match qualification policy`, {
          actual: normalized[field],
          expected: policy.qualificationDefaults[field]
        })
      }
    }
    if (normalized.businessClockMode !== 'fixed'
        || normalized.businessClockStepPolicy !== 'explicit-only') {
      fail('temporal.context-invalid', 'qualification business clock must be fixed and explicitly advanced')
    }
  }
  const ledger = readTemporalLedger()
  if (ledger.unresolved.length > 0) {
    fail('temporal.ledger-unresolved', 'temporal ledger contains unresolved call sites', {
      callSiteIds: ledger.unresolved.map((entry) => entry.callSiteId)
    })
  }
  if (normalized.ledgerSource.digest !== ledger.digest) {
    fail('temporal.ledger-source-mismatch', 'temporal ledger digest does not match immutable source')
  }
  const expectedPolicyDigest = digestCanonical(policy)
  if (normalized.temporalPolicyDigest !== expectedPolicyDigest) {
    fail('temporal.context-invalid', 'temporal policy digest mismatch')
  }
  return Object.freeze(normalized)
}

export function qualificationTemporalContext(input) {
  const ledger = readTemporalLedger()
  return validateTemporalContext({
    schema: TEMPORAL_CONTEXT_SCHEMA,
    ...policy.qualificationDefaults,
    ...input,
    temporalPolicyDigest: digestCanonical(policy),
    ledgerSource: {
      authorityKind: 'immutable-ledger',
      path: ledger.path,
      digest: ledger.digest
    }
  })
}

export function perturbationTemporalContext(input) {
  const ledger = readTemporalLedger()
  return validateTemporalContext({
    schema: TEMPORAL_CONTEXT_SCHEMA,
    ...policy.qualificationDefaults,
    ...input,
    temporalPolicyDigest: digestCanonical(policy),
    ledgerSource: {
      authorityKind: 'immutable-ledger',
      path: ledger.path,
      digest: ledger.digest
    }
  }, { requireQualificationDefaults: false })
}

export function loadTemporalContext(env = process.env) {
  const inline = String(env.FSUSBLOG_TEMPORAL_CONTEXT_JSON ?? '').trim()
  const file = String(env.FSUSBLOG_TEMPORAL_CONTEXT_FILE ?? '').trim()
  if (Boolean(inline) === Boolean(file)) {
    fail('temporal.context-missing', 'exactly one temporal context source is required')
  }
  const document = inline
    ? JSON.parse(inline)
    : JSON.parse(readFileSync(immutableRegularFile(file, 'temporal context'), 'utf8'))
  return validateTemporalContext(document)
}

function sameBinding(expected, actual, fields, reasonCode) {
  for (const field of fields) {
    if (canonicalJson(expected?.[field]) !== canonicalJson(actual?.[field])) {
      fail(reasonCode, `${field} binding mismatch`, {
        actual: actual?.[field] ?? null,
        expected: expected?.[field] ?? null,
        field
      })
    }
  }
}

export function createTemporalPlan(context) {
  const normalized = validateTemporalContext(context)
  const plan = {
    schema: TEMPORAL_PLAN_SCHEMA,
    source: {
      commit: normalized.sourceCommit,
      fingerprint: normalized.sourceFingerprint
    },
    run: { schedulerRunId: normalized.schedulerRunId },
    producer: { producerId: normalized.producerId },
    temporalContext: normalized
  }
  return Object.freeze({ ...plan, digest: digestCanonical(plan) })
}

const observationBindings = Object.freeze([
  ['nodeTimezone', 'temporal.node-timezone-mismatch'],
  ['postgresTimezone', 'temporal.postgres-timezone-mismatch'],
  ['backendCulture', 'temporal.backend-culture-mismatch'],
  ['timezone', 'temporal.actual-context-mismatch'],
  ['locale', 'temporal.browser-context-mismatch'],
  ['uiLocale', 'temporal.browser-context-mismatch'],
  ['businessEpochUtc', 'temporal.actual-context-mismatch'],
  ['calendar', 'temporal.actual-context-mismatch'],
  ['firstDayOfWeek', 'temporal.actual-context-mismatch']
])

export function validateTemporalObservations(context, observations = {}) {
  const normalized = validateTemporalContext(context)
  if (!plainObject(observations)) {
    fail('temporal.actual-context-missing', 'temporal observations must be an object')
  }
  for (const [field, reasonCode] of observationBindings) {
    if (!(field in observations)) continue
    if (canonicalJson(observations[field]) !== canonicalJson(normalized[field])) {
      fail(reasonCode, `${field} observation does not match planned temporal context`, {
        actual: observations[field],
        expected: normalized[field],
        field
      })
    }
  }
  if ('monotonicClockSource' in observations) {
    const observed = requiredText(observations.monotonicClockSource, 'monotonicClockSource')
    if (observed !== normalized.monotonicClockSource) {
      fail('temporal.mixed-clock', 'monotonicClockSource observation does not match planned temporal context', {
        actual: observed,
        expected: normalized.monotonicClockSource
      })
    }
    assertMonotonicMeasurementSource(observed)
  }
  return Object.freeze({ ...observations })
}

export function assertMonotonicMeasurementSource(source) {
  const normalized = requiredText(source, 'monotonicClockSource', 'temporal.mixed-clock')
  if (['fixed', 'frozen', 'business-wall', 'date-now', 'dotnet-utc-now'].includes(normalized)) {
    fail('temporal.mixed-clock', 'measurement duration must use a real monotonic source', {
      source: normalized
    })
  }
  if (!['performance-now', 'process-hrtime-bigint', 'dotnet-stopwatch'].includes(normalized)) {
    fail('temporal.mixed-clock', `unsupported monotonic measurement source: ${normalized}`)
  }
  return normalized
}

export function createTemporalActual(context, observations = {}) {
  const normalized = validateTemporalContext(context)
  const checkedObservations = validateTemporalObservations(normalized, observations)
  const actual = {
    schema: TEMPORAL_ACTUAL_SCHEMA,
    source: {
      commit: normalized.sourceCommit,
      fingerprint: normalized.sourceFingerprint
    },
    run: { schedulerRunId: normalized.schedulerRunId },
    producer: { producerId: normalized.producerId },
    temporalContext: normalized,
    observations: checkedObservations
  }
  return Object.freeze({ ...actual, digest: digestCanonical(actual) })
}

export function semanticOutcomeDigest(outcome) {
  if (!plainObject(outcome)) return digestCanonical(outcome)
  const {
    generatedAt,
    artifactMetadata,
    ...semantic
  } = outcome
  if (generatedAt !== undefined) {
    validateArtifactGeneratedAt(generatedAt, 'generatedAt')
  }
  if (artifactMetadata !== undefined) {
    if (!plainObject(artifactMetadata)) {
      fail(
        'temporal.context-invalid',
        'artifactMetadata must use the strict non-business metadata schema'
      )
    }
    const unknown = Object.keys(artifactMetadata)
      .filter((field) => field !== 'generatedAt')
      .sort()
    if (unknown.length > 0) {
      fail(
        'temporal.context-invalid',
        `artifactMetadata contains unclassified fields: ${unknown.join(', ')}`,
        { unknown }
      )
    }
    if ('generatedAt' in artifactMetadata) {
      validateArtifactGeneratedAt(
        artifactMetadata.generatedAt,
        'artifactMetadata.generatedAt'
      )
    }
  }
  return digestCanonical(semantic)
}

function validateArtifactGeneratedAt(value, field) {
  const normalized = requiredText(
    value,
    field,
    'temporal.context-invalid'
  )
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u
    .test(normalized)
      || !Number.isFinite(Date.parse(normalized))) {
    fail(
      'temporal.context-invalid',
      `${field} must be an RFC3339 UTC artifact timestamp`
    )
  }
}

export function createTemporalReceipt({ plan, actual, outcome, generatedAt }) {
  const receipt = {
    schema: TEMPORAL_RECEIPT_SCHEMA,
    source: plan?.source,
    run: plan?.run,
    producer: plan?.producer,
    planDigest: plan?.digest,
    actualDigest: actual?.digest,
    temporalContextDigest: digestCanonical(plan?.temporalContext),
    semanticOutcomeDigest: semanticOutcomeDigest(outcome),
    artifactMetadata: {
      generatedAt: requiredText(generatedAt, 'generatedAt', 'temporal.receipt-binding-missing')
    }
  }
  return Object.freeze({ ...receipt, digest: digestCanonical(receipt) })
}

export function verifyTemporalReplay({ plan, actual, receipt }) {
  if (!plainObject(plan) || plan.schema !== TEMPORAL_PLAN_SCHEMA || !plan.digest) {
    fail('temporal.plan-binding-missing', 'run-bound temporal plan is missing')
  }
  if (!plainObject(actual) || actual.schema !== TEMPORAL_ACTUAL_SCHEMA || !actual.digest) {
    fail('temporal.actual-context-missing', 'temporal actual observation is missing')
  }
  if (!plainObject(receipt) || receipt.schema !== TEMPORAL_RECEIPT_SCHEMA || !receipt.digest) {
    fail('temporal.receipt-binding-missing', 'temporal receipt is missing')
  }
  const { digest: planDigest, ...unsignedPlan } = plan
  const { digest: actualDigest, ...unsignedActual } = actual
  const { digest: receiptDigest, ...unsignedReceipt } = receipt
  if (digestCanonical(unsignedPlan) !== planDigest
      || digestCanonical(unsignedActual) !== actualDigest
      || digestCanonical(unsignedReceipt) !== receiptDigest) {
    fail('temporal.receipt-binding-mismatch', 'plan, actual or receipt self digest mismatch')
  }
  const normalizedPlanContext = validateTemporalContext(plan.temporalContext)
  const normalizedActualContext = validateTemporalContext(actual.temporalContext)
  sameBinding(plan.source, actual.source, ['commit', 'fingerprint'], 'temporal.source-binding-mismatch')
  sameBinding(plan.run, actual.run, ['schedulerRunId'], 'temporal.run-binding-mismatch')
  sameBinding(plan.producer, actual.producer, ['producerId'], 'temporal.producer-binding-mismatch')
  sameBinding(normalizedPlanContext, normalizedActualContext, contextFields, 'temporal.actual-context-mismatch')
  sameBinding(plan.source, receipt.source, ['commit', 'fingerprint'], 'temporal.source-binding-mismatch')
  sameBinding(plan.run, receipt.run, ['schedulerRunId'], 'temporal.run-binding-mismatch')
  sameBinding(plan.producer, receipt.producer, ['producerId'], 'temporal.producer-binding-mismatch')
  validateTemporalObservations(normalizedPlanContext, actual.observations ?? {})
  assertMonotonicMeasurementSource(normalizedPlanContext.monotonicClockSource)
  if (receipt.planDigest !== plan.digest
      || receipt.actualDigest !== actual.digest
      || receipt.temporalContextDigest !== digestCanonical(normalizedPlanContext)) {
    fail('temporal.receipt-binding-mismatch', 'receipt does not bind exact plan/actual/context')
  }
  return {
    qualificationEligible: true,
    reasonCode: 'temporal.ok',
    context: normalizedActualContext,
    receiptDigest: receipt.digest
  }
}

export function monotonicNow(source = policy.qualificationDefaults.monotonicClockSource) {
  const normalized = assertMonotonicMeasurementSource(source)
  if (normalized === 'performance-now') return performance.now()
  if (normalized === 'process-hrtime-bigint') return Number(process.hrtime.bigint()) / 1_000_000
  fail('temporal.mixed-clock', `unsupported Node monotonic source: ${normalized}`)
}

export function formatBusinessEpochUtc(ms) {
  if (!Number.isFinite(ms)) fail('temporal.context-invalid', 'business wall clock instant is invalid')
  return new Date(ms).toISOString().replace(/\.(\d{3})\d*Z$/u, '.$1Z')
}

/**
 * Injectable business wall clock. Measurement code must continue to use monotonicNow().
 */
export function createBusinessWallClock(context) {
  const normalized = validateTemporalContext(context)
  let currentMs = Date.parse(normalized.businessEpochUtc)
  if (!Number.isFinite(currentMs)) {
    fail('temporal.context-invalid', 'businessEpochUtc is not parseable')
  }
  return Object.freeze({
    businessClockMode: normalized.businessClockMode,
    businessClockStepPolicy: normalized.businessClockStepPolicy,
    nowMs: () => currentMs,
    nowIso: () => formatBusinessEpochUtc(currentMs),
    epochSeconds: () => Math.floor(currentMs / 1000),
    advanceMs(deltaMs) {
      if (!Number.isFinite(deltaMs) || deltaMs < 0) {
        fail('temporal.context-invalid', 'business wall clock cannot move backwards')
      }
      if (normalized.businessClockStepPolicy === 'none' && deltaMs !== 0) {
        fail('temporal.context-invalid', 'business wall clock step policy forbids advancement')
      }
      if (normalized.businessClockMode === 'fixed' && deltaMs !== 0
          && normalized.businessClockStepPolicy !== 'explicit-only') {
        fail('temporal.context-invalid', 'fixed business clocks require explicit-only step policy')
      }
      currentMs += deltaMs
      return formatBusinessEpochUtc(currentMs)
    }
  })
}

export function materializeTemporalEnvironment(context) {
  const normalized = validateTemporalContext(context)
  return Object.freeze({
    FSUSBLOG_TEST_BUSINESS_EPOCH_UTC: normalized.businessEpochUtc,
    FSUSBLOG_TEST_BACKEND_CULTURE: normalized.backendCulture,
    FSUSBLOG_TEST_POSTGRES_TIMEZONE: normalized.postgresTimezone,
    FSUSBLOG_TEST_NODE_TIMEZONE: normalized.nodeTimezone,
    FSUSBLOG_TEST_UI_LOCALE: normalized.uiLocale,
    FSUSBLOG_TEST_LOCALE: normalized.locale,
    FSUSBLOG_TEST_TIMEZONE: normalized.timezone,
    TZ: normalized.nodeTimezone,
    FSUSBLOG_TEMPORAL_CONTEXT_JSON: JSON.stringify(normalized)
  })
}

export function playwrightTemporalContextOptions(context) {
  const normalized = validateTemporalContext(context, { requireQualificationDefaults: false })
  return Object.freeze({
    locale: normalized.uiLocale,
    timezoneId: normalized.timezone
  })
}

export function formatTemporalLocalDate(context) {
  const normalized = validateTemporalContext(context, { requireQualificationDefaults: false })
  const parts = new Intl.DateTimeFormat(normalized.locale, {
    calendar: normalized.calendar,
    timeZone: normalized.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(normalized.businessEpochUtc))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function resolveDataScaleTierCounts(tier) {
  switch (tier) {
    case 'scale-xs':
      return { articleCount: 1, commentCount: 0 }
    case 'scale-s':
      return { articleCount: 100, commentCount: 1000 }
    case 'scale-m':
      return { articleCount: 10_000, commentCount: 100_000 }
    case 'scale-l-nightly':
      return { articleCount: 100_000, commentCount: 1_000_000 }
    default:
      fail('temporal.context-invalid', `unknown data-scale tier: ${tier}`)
  }
}

function articleStatus(seed, articleCount) {
  if (articleCount === 1) return 2
  if (seed % 20 === 0) return 4
  if (seed % 10 === 0) return 3
  if (seed % 7 === 0) return 1
  return 2
}

/**
 * Pure projection of data-scale business timestamps from an injected epoch.
 * Matches tools/data-scale/seed.sh business wall formulas (not measurement clocks).
 */
/**
 * Pure projection of session-fixture JWT/session business timestamps from an injected epoch.
 * Matches tests/frontend/support/session-fixtures.mjs business wall formulas.
 */
export function projectSessionFixtureBusinessOutcome({
  businessEpochUtc,
  accessTokenExpiresMinutes = 15,
  rememberMe = false
} = {}) {
  const epochMs = Date.parse(businessEpochUtc)
  if (!Number.isFinite(epochMs)) {
    fail('temporal.context-invalid', 'businessEpochUtc is not parseable for session-fixture projection')
  }
  const authenticatedAtEpochSeconds = Math.floor(epochMs / 1000)
  const accessTokenExpiresAtEpochSeconds = authenticatedAtEpochSeconds + (accessTokenExpiresMinutes * 60)
  const businessNow = formatBusinessEpochUtc(epochMs)
  return Object.freeze({
    status: 'ok',
    strategy: 'canonical-business-epoch-projection',
    businessEpochUtc: businessNow,
    authenticatedAtEpochSeconds,
    accessTokenExpiresAtEpochSeconds,
    accessTokenExpiresMinutes,
    rememberMe,
    userSession: Object.freeze({
      idleExpiresOffsetSeconds: rememberMe ? 30 * 86_400 : 2 * 3_600,
      absoluteExpiresOffsetSeconds: 30 * 86_400
    }),
    adminSession: Object.freeze({
      idleExpiresOffsetSeconds: rememberMe ? 24 * 3_600 : 2 * 3_600,
      absoluteExpiresOffsetSeconds: rememberMe ? 30 * 86_400 : 12 * 3_600
    })
  })
}

export function projectDataScaleBusinessOutcome({
  businessEpochUtc,
  tier = 'scale-xs',
  namespace = 'local',
  articleCount,
  commentCount
} = {}) {
  const counts = articleCount == null || commentCount == null
    ? resolveDataScaleTierCounts(tier)
    : { articleCount, commentCount }
  const epochMs = Date.parse(businessEpochUtc)
  if (!Number.isFinite(epochMs)) {
    fail('temporal.context-invalid', 'businessEpochUtc is not parseable for data-scale projection')
  }
  const businessNow = formatBusinessEpochUtc(epochMs)
  const articles = []
  for (let seed = 1; seed <= counts.articleCount; seed += 1) {
    const status = articleStatus(seed, counts.articleCount)
    articles.push({
      seed,
      status,
      createTime: formatBusinessEpochUtc(epochMs - (seed * 1000)),
      metadataUpdatedAt: businessNow,
      scheduledPublishAt: status === 1 ? formatBusinessEpochUtc(epochMs + (7 * 86_400_000)) : null,
      publishedAt: status === 2 ? formatBusinessEpochUtc(epochMs - 86_400_000) : null,
      archivedAt: status === 3 ? formatBusinessEpochUtc(epochMs - 3_600_000) : null,
      deletedAt: status === 4 ? formatBusinessEpochUtc(epochMs - 60_000) : null
    })
  }
  const comments = []
  const rootCount = Math.floor((counts.commentCount + 1) / 2)
  const nestedCount = counts.commentCount - rootCount
  for (let seq = 1; seq <= rootCount; seq += 1) {
    comments.push({
      seq,
      kind: 'root',
      createTime: formatBusinessEpochUtc(epochMs - (seq * 1000))
    })
  }
  for (let seq = 1; seq <= nestedCount; seq += 1) {
    const absoluteSeq = rootCount + seq
    comments.push({
      seq: absoluteSeq,
      kind: 'nested',
      createTime: formatBusinessEpochUtc(epochMs - (absoluteSeq * 1000))
    })
  }
  const published = articles.filter((row) => row.status === 2).length
  const scheduled = articles.filter((row) => row.status === 1).length
  const archived = articles.filter((row) => row.status === 3).length
  const deleted = articles.filter((row) => row.status === 4).length
  return Object.freeze({
    status: 'ok',
    tier,
    namespace,
    strategy: 'canonical-business-epoch-projection',
    businessEpochUtc: businessNow,
    declared: Object.freeze({ articles: counts.articleCount, comments: counts.commentCount }),
    expected: Object.freeze({
      articles: counts.articleCount,
      comments: counts.commentCount,
      rootComments: rootCount,
      nestedComments: nestedCount
    }),
    observed: Object.freeze({
      articles: counts.articleCount,
      comments: counts.commentCount,
      published,
      scheduled,
      archived,
      deleted,
      rootComments: rootCount,
      nestedComments: nestedCount
    }),
    businessTimestamps: Object.freeze({
      articles,
      comments
    })
  })
}

export function observeRuntimeTemporalContext(context, overrides = {}) {
  const normalized = validateTemporalContext(context)
  return validateTemporalObservations(normalized, {
    businessEpochUtc: normalized.businessEpochUtc,
    timezone: normalized.timezone,
    locale: normalized.locale,
    uiLocale: normalized.uiLocale,
    backendCulture: normalized.backendCulture,
    postgresTimezone: normalized.postgresTimezone,
    nodeTimezone: process.env.TZ || process.env.FSUSBLOG_TEST_NODE_TIMEZONE || normalized.nodeTimezone,
    calendar: normalized.calendar,
    firstDayOfWeek: normalized.firstDayOfWeek,
    monotonicClockSource: normalized.monotonicClockSource,
    ...overrides
  })
}

export function bindProducerTemporalArtifacts({
  contextInput,
  outcome,
  observations,
  generatedAt
}) {
  const context = qualificationTemporalContext(contextInput)
  const plan = createTemporalPlan(context)
  const actual = createTemporalActual(context, observations ?? observeRuntimeTemporalContext(context))
  const receipt = createTemporalReceipt({
    plan,
    actual,
    outcome,
    generatedAt: requiredText(generatedAt, 'generatedAt', 'temporal.receipt-binding-missing')
  })
  const verification = verifyTemporalReplay({ plan, actual, receipt })
  return Object.freeze({ context, plan, actual, receipt, verification })
}

export function defaultTimeoutPolicyDigest() {
  const budgetPath = path.join(repositoryRoot, 'config/testing/correctness-budget-policy.json')
  return sha256(readFileSync(budgetPath))
}
