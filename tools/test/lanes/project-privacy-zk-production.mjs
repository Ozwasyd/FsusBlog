#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const credentialVaultReleasePlanPath = path.join(
  root,
  'security/evidence-contracts/comment-privacy-credential-vault.release-plan.json'
)

export const credentialVaultReleasePlan = JSON.parse(fs.readFileSync(credentialVaultReleasePlanPath, 'utf8'))
if (credentialVaultReleasePlan.schema !== 'fsusblog.comment-privacy-credential-vault-release-plan.v1'
    || credentialVaultReleasePlan.releaseTier !== 'privacy-zk-comment-matrix'
    || credentialVaultReleasePlan.frontendLane !== 'check:privacy-zk-frontend'
    || !Array.isArray(credentialVaultReleasePlan.requiredEvidence)
    || credentialVaultReleasePlan.requiredEvidence.length === 0) {
  throw new Error('comment privacy credential vault release plan is invalid or not production-bound')
}
const credentialVaultEvidenceKeys = new Set()
for (const evidence of credentialVaultReleasePlan.requiredEvidence) {
  if (typeof evidence?.id !== 'string' || typeof evidence?.file !== 'string'
      || typeof evidence?.testName !== 'string' || credentialVaultEvidenceKeys.has(evidence.id)) {
    throw new Error('comment privacy credential vault release plan contains invalid or duplicate evidence')
  }
  credentialVaultEvidenceKeys.add(evidence.id)
}

export const requiredBackendClasses = [
  'AnonymousCommentTicketServiceTests',
  'AnonymousCommentSubmitTests',
  'AnonymousCommentModerationPipelineTests',
  'RejectIdentifiedPrincipalFilterTests',
  'PodBinaryCodecTests',
  'BackendGoldenCatalogTests',
  'AnonymousCredentialRootLifecycleTests',
  'AnonymousCredentialRevocationArtifactServiceTests',
  'AnonymousCredentialRootEndpointTests',
  'AnonymousPrivacyConcurrencyTests'
]

const baselineFrontendFiles = [
  'tests/frontend/unit/api/comment.test.ts',
  'tests/frontend/unit/privacy/commentPrivacyAdapter.test.ts',
  'tests/frontend/unit/privacy/commentPrivacyRuntime.test.ts',
  'tests/frontend/unit/privacy/commentPrivacyCredentialProvider.test.ts',
  'tests/frontend/unit/privacy/commentPrivacyWorkerClient.test.ts',
  'tests/frontend/unit/privacy/commentPrivacyWasmProver.test.ts',
  'tests/frontend/unit/components/ArticleCommentComposer.test.ts'
]

export const requiredFrontendEvidence = credentialVaultReleasePlan.requiredEvidence
export const requiredFrontendFiles = [...new Set([
  ...baselineFrontendFiles,
  ...requiredFrontendEvidence.map(evidence => evidence.file)
])]

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${path.relative(root, file)}`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error })
  }
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function xmlAttribute(text, name) {
  return text.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))?.[1]
    ?.replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>') ?? ''
}

function parseTrx(file) {
  const text = fs.readFileSync(file, 'utf8')
  const definitions = new Map()
  for (const match of text.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu)) {
    const id = xmlAttribute(match[1], 'id')
    const method = match[2].match(/<TestMethod\b([^>]*)\/?\s*>/u)?.[1] ?? ''
    definitions.set(id, {
      className: xmlAttribute(method, 'className'),
      methodName: xmlAttribute(method, 'name')
    })
  }
  const records = []
  for (const match of text.matchAll(/<UnitTestResult\b([^>]*)\/?\s*>/gu)) {
    const definition = definitions.get(xmlAttribute(match[1], 'testId')) ?? {}
    records.push({
      className: definition.className ?? '',
      methodName: definition.methodName ?? xmlAttribute(match[1], 'testName'),
      outcome: xmlAttribute(match[1], 'outcome')
    })
  }
  return records
}

function listJson(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name)
    return entry.isDirectory() ? listJson(child) : (entry.name.endsWith('.json') ? [child] : [])
  })
}

function normalizeRepoPath(file, repositoryRoot = root) {
  const absolute = path.resolve(file)
  return path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/')
}

function requireRunBinding(document, expectedRunId, source) {
  if (!expectedRunId) return
  const actual = document?.producer?.runId ?? document?.runId ?? document?.schedulerRunId
  if (actual !== expectedRunId) {
    throw new Error(`${source} run binding mismatch: expected ${expectedRunId}, got ${actual ?? 'missing'}`)
  }
}

export function projectPrivacyFunctionalEvidence({
  repositoryRoot = root,
  contractReceipt = path.join(repositoryRoot, '.tmp/security/privacy-zk-comment-matrix-stages/contract.json'),
  backendSummary = path.join(repositoryRoot, '.tmp/test-results/backend/production/summary.json'),
  vitestRoot = path.join(repositoryRoot, '.tmp/test-results/vitest'),
  smokeEvidence = path.join(repositoryRoot, '.tmp/security/privacy-zk-prod-smoke.json'),
  output = path.join(repositoryRoot, '.tmp/security/privacy-zk-comment-matrix-stages/functional.json'),
  expectedRunId = process.env.FSUSBLOG_TEST_RUN_ID ?? ''
} = {}) {
  const contract = readJson(contractReceipt, 'privacy contract receipt')
  if (contract.schema !== 'fsusblog.privacy-zk-comment-matrix-stage.v1'
      || contract.status !== 'ok' || contract.stage !== 'contract') {
    throw new Error('privacy contract receipt is not a successful contract-stage receipt')
  }
  requireRunBinding(contract, expectedRunId, 'privacy contract receipt')
  const minimumMtimeMs = Date.parse(contract.generatedAt)
  if (!Number.isFinite(minimumMtimeMs)) throw new Error('privacy contract receipt generatedAt is invalid')

  const summary = readJson(backendSummary, 'backend production summary')
  if (summary.schema !== 'fsusblog.backend-production-shards.v2' || summary.status !== 'success') {
    throw new Error('backend production summary is not a successful exact-union summary')
  }
  if (summary.execution?.exactOnce !== true || summary.execution?.allPassed !== true) {
    throw new Error('backend production summary does not prove an exact-once all-passing union')
  }
  requireRunBinding(summary, expectedRunId, 'backend production summary')
  const trxFiles = (summary.partitions ?? []).map((partition) => path.resolve(repositoryRoot, partition.trx ?? ''))
  if (trxFiles.length < 2 || trxFiles.some((file) => !fs.existsSync(file))) {
    throw new Error('backend production summary must declare every existing exact-union TRX partition')
  }
  // Backend and frontend production suites intentionally execute in parallel.
  // Freshness is established by the exact run binding above; comparing the
  // backend TRX mtime with this frontend stage would reject valid same-run
  // evidence merely because the backend won the race.
  const backendRecords = trxFiles.flatMap(parseTrx)
  const backendProjection = requiredBackendClasses.map((className) => {
    const selected = backendRecords.filter((record) => record.className.endsWith(`.${className}`))
    if (selected.length === 0) throw new Error(`backend production TRX is missing privacy class ${className}`)
    const failed = selected.filter((record) => record.outcome !== 'Passed')
    if (failed.length > 0) throw new Error(`backend privacy class ${className} has ${failed.length} non-passing result(s)`)
    return { className, passed: selected.length }
  })

  const productionSummaryFile = path.join(vitestRoot, 'production-rolling/summary.json')
  let reports
  if (fs.existsSync(productionSummaryFile)) {
    const productionSummary = readJson(productionSummaryFile, 'production Vitest summary')
    if (productionSummary.schema !== 'fsusblog.frontend-vitest-rolling.v2'
        || productionSummary.status !== 'success'
        || productionSummary.exactOnce !== true) {
      throw new Error('production Vitest summary is not a successful exact-once result')
    }
    requireRunBinding(productionSummary, expectedRunId, 'production Vitest summary')
    const mergedReport = path.resolve(repositoryRoot, productionSummary.artifacts?.mergedJson ?? '')
    if (!mergedReport.startsWith(path.resolve(vitestRoot) + path.sep)) {
      throw new Error('production Vitest summary declares a report outside the Vitest evidence root')
    }
    reports = [mergedReport]
  } else {
    reports = listJson(vitestRoot).filter((file) => fs.statSync(file).mtimeMs >= minimumMtimeMs)
  }
  const frontendRecords = reports.flatMap((file) => {
    const report = readJson(file, 'Vitest report')
    if (report.success !== true) throw new Error(`Vitest report is not successful: ${path.relative(repositoryRoot, file)}`)
    return (report.testResults ?? []).map((testFile) => ({
      file: normalizeRepoPath(testFile.name ?? '', repositoryRoot),
      status: testFile.status,
      assertions: testFile.assertionResults ?? [],
      report: file
    }))
  })
  const frontendProjection = requiredFrontendFiles.map((requiredFile) => {
    const selected = frontendRecords.filter((record) => record.file === requiredFile)
    if (selected.length !== 1) {
      throw new Error(`Vitest production reports require exactly one current result for ${requiredFile}, got ${selected.length}`)
    }
    const [record] = selected
    if (record.status !== 'passed' || record.assertions.length === 0
        || record.assertions.some((assertion) => assertion.status !== 'passed')) {
      throw new Error(`Vitest privacy file is empty or non-passing: ${requiredFile}`)
    }
    const requiredEvidence = requiredFrontendEvidence.filter(evidence => evidence.file === requiredFile)
    const evidence = requiredEvidence.map((requirement) => {
      const selectedAssertions = record.assertions.filter(assertion => {
        const fullName = String(assertion.fullName ?? [
          ...(assertion.ancestorTitles ?? []),
          assertion.title ?? ''
        ].join(' '))
        return fullName.endsWith(requirement.testName)
      })
      if (selectedAssertions.length !== 1 || selectedAssertions[0].status !== 'passed') {
        throw new Error(
          `Vitest privacy evidence ${requirement.id} requires exactly one passing assertion named ${requirement.testName}`
        )
      }
      return { id: requirement.id, testName: requirement.testName }
    })
    return { file: requiredFile, passed: record.assertions.length, evidence }
  })

  const smoke = readJson(smokeEvidence, 'privacy production smoke evidence')
  if (fs.statSync(smokeEvidence).mtimeMs < minimumMtimeMs
      || smoke.schema !== 'fsusblog.privacy-zk-prod-smoke.v1'
      || !['ok', 'expected_unavailable'].includes(smoke.status)
      || !Array.isArray(smoke.errors) || smoke.errors.length !== 0) {
    throw new Error('privacy production smoke evidence is stale, invalid, or failed')
  }

  const evidenceFiles = [credentialVaultReleasePlanPath, backendSummary, ...trxFiles, ...new Set(frontendProjection.map((entry) => {
    return frontendRecords.find((record) => record.file === entry.file).report
  })), smokeEvidence]
  const receipt = {
    schema: 'fsusblog.privacy-zk-comment-matrix-stage.v1',
    status: 'ok',
    stage: 'functional',
    mode: 'exact-production-result-projection',
    runId: expectedRunId || null,
    backendProjection,
    frontendProjection,
    smokeStatus: smoke.status,
    evidenceDigests: Object.fromEntries(evidenceFiles.map((file) => [
      path.relative(repositoryRoot, file).replaceAll(path.sep, '/'),
      sha256(file)
    ])),
    generatedAt: new Date().toISOString()
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const pending = `${output}.pending-${process.pid}`
  fs.writeFileSync(pending, `${JSON.stringify(receipt, null, 2)}\n`)
  fs.renameSync(pending, output)
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = projectPrivacyFunctionalEvidence()
    console.log(`[privacy-zk-projection] ok backendClasses=${receipt.backendProjection.length} frontendFiles=${receipt.frontendProjection.length} smoke=${receipt.smokeStatus}`)
  } catch (error) {
    console.error(`[privacy-zk-projection] ${error.message}`)
    process.exitCode = 1
  }
}
