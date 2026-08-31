#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  EVIDENCE_TRANSPORT_MANIFEST_ENV,
  listTransportedArchiveFiles
} from '../test/current-run-evidence-transport.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const policyVersion = 'fsusblog-flaky-execution-v2'
const retryableFailureKind = 'browser-process-crash'
const allowedClassifications = new Set(['known-flaky', 'unknown-flaky', 'infra-transient', 'benchmark-noise', 'regression'])
const allowedEvidenceClasses = new Set(['correctness', 'browser-contract', 'diagnostic', 'infra-failure'])
const sourceEvidenceClasses = new Set(['correctness', 'browser-contract', 'diagnostic'])
const attemptFailureClasses = new Set(['product', 'contract', 'infra'])
const allowedFinalStatuses = new Set([
  'success',
  'failed-no-retry',
  'diagnostic-passed-after-infra-retry',
  'failed-after-infra-retry',
  'unstable-topology'
])
const forbiddenLegacyRetryStatuses = new Set(['passed-after-retry', 'failed-after-retry'])
export const FLAKY_EVIDENCE_COLLECTION_SCHEMA = 'fsusblog.ci.flaky-evidence-collection.v1'

function hasValue(item, field) {
  return item[field] !== undefined && item[field] !== null && item[field] !== ''
}

function uniqueStrings(values) {
  return Array.isArray(values)
    && values.length > 0
    && values.every((value) => typeof value === 'string' && value.trim().length > 0)
    && new Set(values).size === values.length
}

function failureIdentity(attempt) {
  return [...(attempt.testIds ?? [])].sort().join('\n')
}

function hasUnstableTopology(attempts) {
  const failedIdentities = attempts
    .filter((attempt) => attempt.status === 'failure')
    .map(failureIdentity)
  return failedIdentities.length >= 2 && new Set(failedIdentities).size > 1
}

function validateAttempt(attempt, index, file) {
  const errors = []
  const prefix = `${file}: attempts[${index}]`
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return [`${prefix} must be an object`]
  if (attempt.attempt !== index + 1) errors.push(`${prefix}.attempt must be ${index + 1}`)
  if (!['success', 'failure'].includes(attempt.status)) errors.push(`${prefix}.status must be success or failure`)
  if (!uniqueStrings(attempt.testIds)) errors.push(`${prefix}.testIds must be a non-empty unique string array`)
  if (!uniqueStrings(attempt.artifacts)) errors.push(`${prefix}.artifacts must preserve at least one artifact path`)
  if (!Number.isInteger(attempt.durationMs) || attempt.durationMs < 0) errors.push(`${prefix}.durationMs must be a non-negative integer`)
  if (!(attempt.exitCode === null || Number.isInteger(attempt.exitCode))) errors.push(`${prefix}.exitCode must be an integer or null`)
  if (!(attempt.signal === null || typeof attempt.signal === 'string')) errors.push(`${prefix}.signal must be a string or null`)
  if (attempt.status === 'success') {
    if (attempt.failureClass !== null) errors.push(`${prefix}.failureClass must be null for success`)
    if (attempt.failureKind !== null) errors.push(`${prefix}.failureKind must be null for success`)
  } else {
    if (!attemptFailureClasses.has(attempt.failureClass)) errors.push(`${prefix}.failureClass must be product, contract, or infra`)
    if (!hasValue(attempt, 'failureKind')) errors.push(`${prefix}.failureKind is required for failure`)
  }
  return errors
}

function validateV2(item, file) {
  const errors = []
  for (const field of [
    'suite',
    'classification',
    'evidenceClass',
    'sourceEvidenceClass',
    'issue',
    'retryCount',
    'finalStatus',
    'generatedAt'
  ]) {
    if (!hasValue(item, field)) errors.push(`${file}: ${field} is required`)
  }
  if (item.policyVersion !== policyVersion) errors.push(`${file}: policyVersion must be ${policyVersion}`)
  if (!allowedClassifications.has(item.classification)) errors.push(`${file}: invalid classification ${item.classification}`)
  if (!allowedEvidenceClasses.has(item.evidenceClass)) errors.push(`${file}: invalid evidenceClass ${item.evidenceClass}`)
  if (!sourceEvidenceClasses.has(item.sourceEvidenceClass)) errors.push(`${file}: invalid sourceEvidenceClass ${item.sourceEvidenceClass}`)
  if (!allowedFinalStatuses.has(item.finalStatus)) errors.push(`${file}: invalid finalStatus ${item.finalStatus}`)
  if (!uniqueStrings(item.testIds)) errors.push(`${file}: testIds must be a non-empty unique string array`)
  if (!uniqueStrings(item.declaredTestIds)) errors.push(`${file}: declaredTestIds must be a non-empty unique string array`)
  if (!Number.isInteger(item.issue) || item.issue <= 0) errors.push(`${file}: issue must be a positive integer`)
  if (!Number.isInteger(item.retryCount) || item.retryCount < 0 || item.retryCount > 1) errors.push(`${file}: retryCount must be 0 or 1`)
  if (!Array.isArray(item.attempts) || item.attempts.length === 0 || item.attempts.length > 2) {
    errors.push(`${file}: attempts must contain one or two entries`)
  } else {
    item.attempts.forEach((attempt, index) => errors.push(...validateAttempt(attempt, index, file)))
    if (item.retryCount !== item.attempts.length - 1) errors.push(`${file}: retryCount must equal attempts.length - 1`)
    const executedTestIds = [...new Set(item.attempts.flatMap((attempt) => attempt.testIds ?? []))].sort()
    if (JSON.stringify([...(item.testIds ?? [])].sort()) !== JSON.stringify(executedTestIds)) {
      errors.push(`${file}: testIds must equal the union of attempt testIds`)
    }
  }
  if (!item.retryPolicy || typeof item.retryPolicy !== 'object' || Array.isArray(item.retryPolicy)) {
    errors.push(`${file}: retryPolicy is required`)
  } else {
    if (!Number.isInteger(item.retryPolicy.allowedRetries) || item.retryPolicy.allowedRetries < 0 || item.retryPolicy.allowedRetries > 1) {
      errors.push(`${file}: retryPolicy.allowedRetries must be 0 or 1`)
    }
    if (!['never', retryableFailureKind].includes(item.retryPolicy.retryOn)) {
      errors.push(`${file}: retryPolicy.retryOn must be never or ${retryableFailureKind}`)
    }
  }

  const expectedAffectsCorrectness = item.sourceEvidenceClass !== 'diagnostic'
  if (item.affectsCorrectness !== expectedAffectsCorrectness) {
    errors.push(`${file}: affectsCorrectness must reflect sourceEvidenceClass (${expectedAffectsCorrectness})`)
  }
  if (item.evidenceClass === 'infra-failure') {
    if (item.finalStatus === 'success' || item.finalStatus === 'diagnostic-passed-after-infra-retry') {
      errors.push(`${file}: infra-failure evidence cannot be a successful outcome`)
    }
    if (!['infra', 'unstable-topology'].includes(item.failureClass)) {
      errors.push(`${file}: infra-failure requires infra or unstable-topology failureClass`)
    }
  } else if (item.finalStatus === 'failed-no-retry' && !['product', 'contract'].includes(item.failureClass)) {
    errors.push(`${file}: non-infra failed-no-retry requires product or contract failureClass`)
  }

  const lastAttempt = item.attempts?.at(-1)
  if (item.finalStatus === 'success' && (item.failureClass !== null || item.failureKind !== null)) {
    errors.push(`${file}: successful first attempt must not retain a failure class`)
  }
  if (item.finalStatus === 'diagnostic-passed-after-infra-retry'
    && (item.failureClass !== 'infra' || item.failureKind !== retryableFailureKind)) {
    errors.push(`${file}: recovered diagnostic must retain its browser crash classification`)
  }
  if (lastAttempt?.status === 'failure' && item.finalStatus !== 'unstable-topology'
    && (item.failureClass !== lastAttempt.failureClass || item.failureKind !== lastAttempt.failureKind)) {
    errors.push(`${file}: final failure class must match the last attempt`)
  }

  if (item.sourceEvidenceClass === 'correctness' || item.sourceEvidenceClass === 'browser-contract') {
    if (item.retryCount !== 0 || item.attempts?.length !== 1) {
      errors.push(`${file}: ${item.sourceEvidenceClass} must run exactly once without retry`)
    }
    if (item.retryPolicy?.allowedRetries !== 0 || item.retryPolicy?.retryOn !== 'never') {
      errors.push(`${file}: ${item.sourceEvidenceClass} retry policy must be allowedRetries=0 and retryOn=never`)
    }
    if (item.finalStatus.includes('retry') || item.finalStatus === 'unstable-topology') {
      errors.push(`${file}: ${item.sourceEvidenceClass} cannot report a retry-derived status`)
    }
  }

  if (item.sourceEvidenceClass === 'browser-contract') {
    if (!['browser-contract', 'infra-failure'].includes(item.evidenceClass)) {
      errors.push(`${file}: Browser Contract outcome must be browser-contract or infra-failure`)
    }
    const attempt = item.attempts?.[0]
    if (attempt?.status === 'failure' && attempt.failureClass === 'infra' && item.evidenceClass !== 'infra-failure') {
      errors.push(`${file}: Browser Contract crash/disconnect must surface directly as infra-failure`)
    }
  }

  if (item.sourceEvidenceClass === 'diagnostic') {
    if (item.retryPolicy?.allowedRetries > 0 && item.retryPolicy?.retryOn !== retryableFailureKind) {
      errors.push(`${file}: diagnostic retry must be restricted to ${retryableFailureKind}`)
    }
    if (item.retryCount > 0) {
      const first = item.attempts?.[0]
      if (first?.status !== 'failure' || first.failureClass !== 'infra' || first.failureKind !== retryableFailureKind) {
        errors.push(`${file}: diagnostic retry requires an explicit first-attempt browser process crash`)
      }
      const finalSucceeded = item.attempts?.at(-1)?.status === 'success'
      if (finalSucceeded && item.finalStatus !== 'diagnostic-passed-after-infra-retry') {
        errors.push(`${file}: recovered diagnostic must use diagnostic-passed-after-infra-retry`)
      }
      if (!finalSucceeded && !['failed-after-infra-retry', 'unstable-topology'].includes(item.finalStatus)) {
        errors.push(`${file}: exhausted diagnostic retry has an invalid finalStatus`)
      }
    } else if (item.finalStatus === 'diagnostic-passed-after-infra-retry' || item.finalStatus === 'failed-after-infra-retry') {
      errors.push(`${file}: retry-derived diagnostic status requires retryCount=1`)
    }
  }

  if (Array.isArray(item.attempts) && hasUnstableTopology(item.attempts)) {
    if (item.finalStatus !== 'unstable-topology' || item.failureClass !== 'unstable-topology') {
      errors.push(`${file}: different failed test IDs across attempts must be marked unstable-topology`)
    }
  } else if (item.finalStatus === 'unstable-topology' || item.failureClass === 'unstable-topology') {
    errors.push(`${file}: unstable-topology requires different failed test IDs across attempts`)
  }

  return errors
}

function validateLegacy(item, file) {
  const errors = []
  for (const field of ['suite', 'classification', 'issue', 'retryCount', 'finalStatus', 'generatedAt']) {
    if (!hasValue(item, field)) errors.push(`${file}: ${field} is required`)
  }
  if (!allowedClassifications.has(item.classification)) errors.push(`${file}: invalid classification ${item.classification}`)
  if (!Number.isInteger(item.issue) || item.issue <= 0) errors.push(`${file}: issue must be a positive integer`)
  if (!Number.isInteger(item.retryCount) || item.retryCount < 0) errors.push(`${file}: retryCount must be zero or greater`)
  if (item.retryCount > 0 || forbiddenLegacyRetryStatuses.has(item.finalStatus)) {
    errors.push(`${file}: legacy generic retry evidence is forbidden; regenerate with ${policyVersion}`)
  }
  if (!['failed-no-retry', 'allow-failure-reported', 'skipped-with-evidence'].includes(item.finalStatus)) {
    errors.push(`${file}: unsupported legacy finalStatus ${item.finalStatus}`)
  }
  if (item.evidenceClass !== undefined) {
    if (!['correctness', 'diagnostic'].includes(item.evidenceClass)) errors.push(`${file}: invalid legacy evidenceClass ${item.evidenceClass}`)
    const expected = item.evidenceClass === 'correctness'
    if (item.affectsCorrectness !== expected) errors.push(`${file}: legacy evidenceClass and affectsCorrectness do not match`)
  }
  return errors
}

export function validateFlakyEvidence(item, file) {
  if (item.schema !== 'fsusblog.ci.flaky.v1') return [`${file}: schema must be fsusblog.ci.flaky.v1`]
  return item.policyVersion === policyVersion ? validateV2(item, file) : validateLegacy(item, file)
}

export function createFlakyEvidenceCollection(documents) {
  if (!Array.isArray(documents)) throw new Error('flaky evidence collection documents must be an array')
  const errors = documents.flatMap((document, index) =>
    validateFlakyEvidence(document, `evidence[${index}]`))
  if (errors.length > 0) throw new Error(errors.join('; '))
  return { schema: FLAKY_EVIDENCE_COLLECTION_SCHEMA, evidence: documents }
}

function isNonBlockingDiagnosticEvidence(item) {
  const sourceClass = item.sourceEvidenceClass ?? item.evidenceClass
  return sourceClass === 'diagnostic' && item.affectsCorrectness === false
}

function isSuccessful(item) {
  return item.finalStatus === 'success' || item.finalStatus === 'diagnostic-passed-after-infra-retry'
}

function listFlakyFiles() {
  const transport = String(process.env[EVIDENCE_TRANSPORT_MANIFEST_ENV] ?? '').trim()
  if (transport) {
    return listTransportedArchiveFiles({
      repositoryRoot: root,
      transportManifestPath: transport,
      authorityId: 'evidence-consumer.ci.check-flaky-evidence.current-run'
    })
  }
  const explicit = String(process.env.FSUSBLOG_FLAKY_EVIDENCE_FILES ?? '').trim()
  if (explicit) {
    return JSON.parse(explicit).map((file) => path.resolve(root, file))
  }
  const localDir = path.join(path.resolve(process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR
    ?? path.join(root, '.tmp/release-evidence')), 'flaky')
  if (!fs.existsSync(localDir)) return []
  return fs.readdirSync(localDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(localDir, name))
}

function checkEvidence({ releaseFinal, files = listFlakyFiles() }) {
  const errors = []
  let count = 0
  for (const file of files) {
    let item
    try {
      item = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      errors.push(`${path.relative(root, file)}: ${error.message}`)
      continue
    }
    if (item.schema !== 'fsusblog.ci.flaky.v1') continue
    count += 1
    const displayFile = path.relative(root, file)
    errors.push(...validateFlakyEvidence(item, displayFile))
    if (releaseFinal && !isNonBlockingDiagnosticEvidence(item) && !isSuccessful(item)) {
      errors.push(`${displayFile}: release-final rejects failing ${item.sourceEvidenceClass ?? item.evidenceClass ?? 'unclassified'} evidence (${item.finalStatus})`)
    }
  }
  return { count, errors }
}

function main() {
  const { count, errors } = checkEvidence({
    releaseFinal: process.argv.includes('--release-final')
  })
  if (errors.length > 0) {
    for (const error of errors) console.error(`[flaky-evidence] ${error}`)
    process.exit(1)
  }
  console.log(`[flaky-evidence] ok evidence=${count}`)
}

function fixtureAttempt(attempt, overrides = {}) {
  return {
    attempt,
    status: 'failure',
    testIds: ['diagnostic:a'],
    failureClass: 'infra',
    failureKind: retryableFailureKind,
    artifacts: [`attempt-${attempt}/stderr.log`],
    exitCode: 1,
    signal: null,
    durationMs: 1,
    ...overrides
  }
}

function fixtureEvidence(overrides = {}) {
  return {
    schema: 'fsusblog.ci.flaky.v1',
    policyVersion,
    suite: 'browser-diagnostics',
    test: 'diagnostic:a',
    testIds: ['diagnostic:a'],
    declaredTestIds: ['diagnostic:a'],
    classification: 'infra-transient',
    evidenceClass: 'diagnostic',
    sourceEvidenceClass: 'diagnostic',
    affectsCorrectness: false,
    failureClass: 'infra',
    failureKind: retryableFailureKind,
    issue: 1151,
    retryPolicy: { allowedRetries: 1, retryOn: retryableFailureKind },
    retryCount: 1,
    finalStatus: 'diagnostic-passed-after-infra-retry',
    attempts: [
      fixtureAttempt(1),
      fixtureAttempt(2, { status: 'success', failureClass: null, failureKind: null, exitCode: 0 })
    ],
    generatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides
  }
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-flaky-v2-'))
  const flakyDir = path.join(tmp, 'flaky')
  fs.mkdirSync(flakyDir, { recursive: true })
  try {
    fs.writeFileSync(path.join(flakyDir, 'diagnostic.json'), `${JSON.stringify(fixtureEvidence())}\n`)
    const diagnostic = checkEvidence({ releaseFinal: true, files: [path.join(flakyDir, 'diagnostic.json')] })
    if (diagnostic.errors.length > 0) throw new Error(`diagnostic recovery did not validate: ${diagnostic.errors.join('; ')}`)

    fs.writeFileSync(path.join(flakyDir, 'contract.json'), `${JSON.stringify(fixtureEvidence({
      suite: 'browser-contract',
      evidenceClass: 'infra-failure',
      sourceEvidenceClass: 'browser-contract',
      affectsCorrectness: true,
      retryPolicy: { allowedRetries: 0, retryOn: 'never' },
      retryCount: 0,
      finalStatus: 'failed-no-retry',
      attempts: [fixtureAttempt(1, { failureKind: 'browser-disconnect' })]
    }))}\n`)
    const contract = checkEvidence({ releaseFinal: true, files: [path.join(flakyDir, 'diagnostic.json'), path.join(flakyDir, 'contract.json')] })
    if (!contract.errors.some((error) => error.includes('release-final rejects failing browser-contract evidence'))) {
      throw new Error('Browser Contract infra failure did not fail closed')
    }

    fs.rmSync(path.join(flakyDir, 'contract.json'))
    fs.writeFileSync(path.join(flakyDir, 'legacy.json'), `${JSON.stringify({
      schema: 'fsusblog.ci.flaky.v1',
      suite: 'acceptance-playwright',
      classification: 'unknown-flaky',
      evidenceClass: 'correctness',
      affectsCorrectness: true,
      issue: 134,
      retryCount: 1,
      finalStatus: 'passed-after-retry',
      generatedAt: '2025-01-01T00:00:00.000Z'
    })}\n`)
    const legacy = checkEvidence({ releaseFinal: false, files: [path.join(flakyDir, 'diagnostic.json'), path.join(flakyDir, 'legacy.json')] })
    if (!legacy.errors.some((error) => error.includes('legacy generic retry evidence is forbidden'))) {
      throw new Error('legacy generic passed-after-retry evidence was accepted')
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  console.log('[flaky-evidence] self-test ok')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-test')) runSelfTest()
  else main()
}
