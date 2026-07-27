#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path'

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'))
const runtimeEvidencePath = process.env.FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE
  ? path.resolve(process.env.FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE)
  : path.join(root, '.tmp/security/perception-v2-e2e-runtime.json')
const matrixSummaryPath = process.env.FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE
  ? path.resolve(process.env.FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE)
  : path.join(root, '.tmp/security/perception-v2-test-matrix.json')
const releaseEvidencePath = process.env.FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE
  ? path.resolve(process.env.FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE)
  : path.join(root, '.tmp/release-evidence/perception-v2-release-evidence.json')

const requiredWorkflowPath = ['issue', 'render', 'verify', 'proof', 'business-action-resume']
const requiredFailureCases = ['wrong-answer', 'expired', 'duplicate-submit', 'action-mismatch', 'route-mismatch']
const requiredPerformanceCases = ['issue-p99', 'verify-gate-latency', 'async-audit-queue-nonblocking']

function fail(message) {
  console.error(`[perception-v2-e2e-evidence] ${message}`)
  process.exit(1)
}

function readJson(file) {
  if (!fs.existsSync(file)) {
    fail(`missing evidence file: ${path.relative(root, file)}`)
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`invalid JSON in ${path.relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertIncludesAll(actual, expected, label) {
  const set = new Set(Array.isArray(actual) ? actual : [])
  for (const item of expected) {
    if (!set.has(item)) {
      fail(`${label} missing ${item}`)
    }
  }
}

function assertPositiveMetric(value, label) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    fail(`${label} must be a positive number, got ${value}`)
  }

  return numeric
}

const evidence = readJson(runtimeEvidencePath)
if (evidence.schema !== 'fsusblog.perception-v2.e2e-runtime@v1') {
  fail(`unexpected runtime evidence schema: ${evidence.schema}`)
}
if (evidence.status !== 'ok') {
  fail(`runtime evidence status must be ok, got ${evidence.status}`)
}
if (evidence.issue !== 532) {
  fail(`runtime evidence must be bound to issue 532, got ${evidence.issue}`)
}
if (evidence.workflow?.businessFlow !== 'comment.create') {
  fail('runtime evidence must cover comment.create')
}
if (!['perceptionLocalizationV2', 'perceptionMicroInteractionV2'].includes(evidence.workflow?.challengeKind)) {
  fail('runtime evidence must cover an active perception v2 challenge')
}

assertIncludesAll(evidence.workflow?.path, requiredWorkflowPath, 'workflow.path')
assertIncludesAll(evidence.workflow?.taskKinds, ['localization', 'micro-interaction'], 'workflow.taskKinds')
assertIncludesAll(evidence.workflow?.businessFlows, ['comment.create'], 'workflow.businessFlows')
assertIncludesAll(evidence.coverage?.failureCases, requiredFailureCases, 'coverage.failureCases')
assertIncludesAll(evidence.coverage?.performanceCases, requiredPerformanceCases, 'coverage.performanceCases')

const issueP99Ms = assertPositiveMetric(evidence.metrics?.issueP99Ms, 'metrics.issueP99Ms')
const verifyGateP99Ms = assertPositiveMetric(evidence.metrics?.verifyGateP99Ms, 'metrics.verifyGateP99Ms')
const clientRenderP95Ms = assertPositiveMetric(evidence.metrics?.clientRenderP95Ms, 'metrics.clientRenderP95Ms')
const auditQueueObservedCount = Number(evidence.metrics?.auditQueueObservedCount ?? 0)
if (!Number.isFinite(auditQueueObservedCount) || auditQueueObservedCount <= 0) {
  fail('metrics.auditQueueObservedCount must be positive')
}
if (Number(evidence.metrics?.auditQueueDroppedLowValueCount ?? 0) !== 0 ||
    Number(evidence.metrics?.auditQueueDroppedHighValueCount ?? 0) !== 0) {
  fail('async audit queue must not drop low-value or high-value events in the E2E gate')
}

const knownGaps = Array.isArray(evidence.knownGaps) ? evidence.knownGaps : []
if (knownGaps.length === 0) {
  fail('runtime evidence must record known gaps for release handoff')
}

const releaseEvidence = {
  schema: 'fsusblog.perception-v2.release-evidence.v1',
  status: 'ok',
  issue: 532,
  generatedAtUtc: new Date().toISOString(),
  source: path.relative(root, runtimeEvidencePath),
  validatedBy: 'tools/security/check-perception-v2-e2e-evidence.mjs',
  taskKindsVerified: evidence.workflow.taskKinds,
  businessFlowsVerified: evidence.workflow.businessFlows,
  workflowPath: evidence.workflow.path,
  failureCasesVerified: evidence.coverage.failureCases,
  performanceMetrics: {
    issueP99Ms,
    verifyGateP99Ms,
    clientRenderP95Ms,
    asyncAuditQueueObservedCount: auditQueueObservedCount
  },
  knownGaps
}

const matrixSummary = {
  schema: 'fsusblog.perception-v2-test-matrix.v1',
  status: 'ok',
  source: 'security/matrices/perception-v2.yml',
  validatedBy: [
    'tools/security/check-security-matrices.mjs',
    'dotnet test PerceptionChallengeV2E2eTests',
    'tools/security/check-perception-v2-e2e-evidence.mjs'
  ],
  validationClasses: ['contract-only', 'provider-only', 'e2e-runtime'],
  e2eRuntimeEvidence: path.relative(root, runtimeEvidencePath),
  releaseEvidence: path.relative(root, releaseEvidencePath),
  verifiedRuntimeCoverage: {
    taskKinds: evidence.workflow.taskKinds,
    businessFlows: evidence.workflow.businessFlows,
    failureCases: evidence.coverage.failureCases,
    performanceCases: evidence.coverage.performanceCases
  },
  performanceBudgets: {
    issueP99Ms: 8,
    verifyP99Ms: 32,
    payloadP95Bytes: 6200,
    clientRenderP95Ms: 55
  },
  observedPerformance: {
    issueP99Ms,
    verifyGateP99Ms,
    clientRenderP95Ms
  }
}

fs.mkdirSync(path.dirname(releaseEvidencePath), { recursive: true })
fs.mkdirSync(path.dirname(matrixSummaryPath), { recursive: true })
fs.writeFileSync(releaseEvidencePath, `${JSON.stringify(releaseEvidence, null, 2)}\n`)
fs.writeFileSync(matrixSummaryPath, `${JSON.stringify(matrixSummary, null, 2)}\n`)
console.log('[perception-v2-e2e-evidence] ok')
