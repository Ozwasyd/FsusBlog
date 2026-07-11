#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  auditCompactRetentionRecords,
  auditRetentionRecords,
  expandPathReplacementPlan,
  mergeReplacementEntries,
  scanBackendSourceLocking,
  validateAfterSnapshotAuthority,
  validateChildIssueStatusEvidence,
  validateConvergencePlan,
  validateEvidenceContract,
  verifySourceLockingFixtures
} from './test-convergence/audit.mjs'
import {
  decodeCompactRetentionIndex,
  isCompactRetentionBaseline,
  validateCompactRetentionBaseline
} from './test-retention/audit.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = {
    after: null,
    out: null,
    final: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--after') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--after requires a path')
      options.after = resolve(root, value)
      index += 1
    } else if (arg === '--out') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--out requires a path')
      options.out = resolve(root, value)
      index += 1
    } else if (arg === '--final') {
      options.final = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/check-test-suite-convergence.mjs [--after <retention-audit.json>] [--out <summary.json>] [--final]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function repoPath(path) {
  return relative(root, path).replaceAll('\\', '/')
}

function walk(directory, predicate, output = []) {
  if (!existsSync(directory)) return output
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (['bin', 'obj', 'node_modules', '.tmp', 'TestResults'].includes(entry.name)) continue
      walk(absolute, predicate, output)
    } else if (predicate(absolute)) {
      output.push(absolute)
    }
  }
  return output
}

function recordsFromSnapshot(snapshot, source) {
  const records = snapshot?.testRecords ?? snapshot?.catalog?.testRecords ?? snapshot?.retention?.testRecords
  if (!Array.isArray(records)) throw new Error(`${source} has no testRecords array`)
  return records
}

function discoverIssueManifests() {
  return walk(
    resolve(root, 'tests'),
    (path) => /issue-\d+.*retention.*\.json$/u.test(path)
  ).map((path) => ({ source: repoPath(path), manifest: readJson(path) }))
}

async function frontendReplacementDescriptor(beforeRecords) {
  const planPath = resolve(root, 'tests/frontend/checks/static/frontend-source-locking-migration-plan.mjs')
  if (!existsSync(planPath)) return { descriptor: null, errors: [] }
  const plan = await import(pathToFileURL(planPath).href)
  const expanded = expandPathReplacementPlan(
    beforeRecords,
    {
      replacementOwners: plan.replacementOwners,
      wholeFileMigrations: plan.wholeFileMigrations,
      selectiveTestMigrations: plan.selectiveTestMigrations
    },
    repoPath(planPath)
  )
  return {
    descriptor: {
      source: repoPath(planPath),
      manifest: {
        deletedTests: expanded.entries.map((entry) => ({
          id: entry.id,
          path: entry.path,
          replacementTestIds: entry.replacementTestIds,
          reason: entry.reason
        }))
      }
    },
    errors: expanded.errors
  }
}

function sourceLockingAudit() {
  const positivePath = resolve(root, 'tests/tools/fixtures/test-suite-convergence/backend-source-lock-positive.fixture.cs.txt')
  const negativePath = resolve(root, 'tests/tools/fixtures/test-suite-convergence/backend-source-lock-negative.fixture.cs.txt')
  const fixtureAudit = verifySourceLockingFixtures(
    readFileSync(positivePath, 'utf8'),
    readFileSync(negativePath, 'utf8')
  )
  const files = walk(
    resolve(root, 'tests/backend'),
    (path) => path.endsWith('Tests.cs')
  ).sort((left, right) => repoPath(left).localeCompare(repoPath(right)))
  const violations = files.flatMap((path) =>
    scanBackendSourceLocking(readFileSync(path, 'utf8'), repoPath(path))
  )
  return { scannedFiles: files.length, fixtureAudit, violations }
}

function finalEvidenceAudit(plan, finalMode, afterSnapshot) {
  if (!finalMode) {
    return { required: plan.finalEvidencePaths, missing: [], contentErrors: [], checkedContracts: [], mode: 'deferred' }
  }
  const missing = plan.finalEvidencePaths.filter((path) => !existsSync(resolve(root, path)))
  const contentErrors = []
  const checkedContracts = []
  const documents = new Map()
  for (const contract of plan.finalEvidenceContracts ?? []) {
    const absolute = resolve(root, contract.path)
    if (!existsSync(absolute)) continue
    try {
      const document = readJson(absolute)
      documents.set(contract.path, document)
      contentErrors.push(...validateEvidenceContract(document, contract, contract.path))
      checkedContracts.push(contract.path)
    } catch (error) {
      contentErrors.push(`${contract.path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const optimizationPath = '.tmp/release-evidence/test-optimization-report.json'
  const optimization = documents.get(optimizationPath)
  if (optimization && afterSnapshot
    && String(optimization.authoritativeFreshRun?.runId ?? '') !== String(afterSnapshot.producer?.runId ?? '')) {
    contentErrors.push(`${optimizationPath}: authoritative fresh run does not match the after retention producer run`)
  }
  const childIssuesPath = '.tmp/release-evidence/issue-1051-child-issues.json'
  const childIssues = documents.get(childIssuesPath)
  if (childIssues) contentErrors.push(...validateChildIssueStatusEvidence(childIssues))
  return { required: plan.finalEvidencePaths, missing, contentErrors, checkedContracts, mode: 'required' }
}

const options = parseArgs(process.argv.slice(2))
const planPath = resolve(root, 'tests/issue-1051-suite-convergence.json')
const plan = readJson(planPath)
const beforePath = resolve(root, plan.beforeSnapshot)
const beforeSnapshot = readJson(beforePath)
const compactBefore = isCompactRetentionBaseline(beforeSnapshot)
if (compactBefore) validateCompactRetentionBaseline(beforeSnapshot)
const beforeRecords = compactBefore ? null : recordsFromSnapshot(beforeSnapshot, plan.beforeSnapshot)
const centralPath = resolve(root, 'tests/test-retention-replacements.json')
const manifestDescriptors = [
  { source: repoPath(centralPath), manifest: readJson(centralPath) },
  ...discoverIssueManifests()
]
const frontend = compactBefore
  ? { descriptor: null, errors: [] }
  : await frontendReplacementDescriptor(beforeRecords)
if (frontend.descriptor) manifestDescriptors.push(frontend.descriptor)
const merged = mergeReplacementEntries(manifestDescriptors)

const defaultAfterPath = resolve(root, plan.defaultAfterSnapshot)
const afterPath = options.after
  ?? (options.final && existsSync(defaultAfterPath) ? defaultAfterPath : null)
const afterSnapshot = afterPath ? readJson(afterPath) : null
const afterRecords = afterSnapshot ? recordsFromSnapshot(afterSnapshot, repoPath(afterPath)) : null
const retention = compactBefore
  ? auditCompactRetentionRecords({
      beforeSnapshot,
      afterRecords,
      replacements: merged.entries,
      preBaselineDeletionIds: decodeCompactRetentionIndex(
        beforeSnapshot.replacementManifestBaseline.deletedTestIndex,
        'before snapshot historical deletion index'
      )
    })
  : auditRetentionRecords({
      beforeRecords,
      afterRecords,
      replacements: merged.entries,
      pathExists: (path) => existsSync(resolve(root, path)),
      preBaselineDeletionIds: beforeSnapshot.replacementManifestBaseline?.deletedTestIds ?? []
    })
const sourceLocking = sourceLockingAudit()
const stageErrors = validateConvergencePlan(plan)
const afterAuthorityErrors = validateAfterSnapshotAuthority(beforeSnapshot, afterSnapshot, {
  required: options.final
})
const evidence = finalEvidenceAudit(plan, options.final, afterSnapshot)
const errors = [
  ...stageErrors,
  ...afterAuthorityErrors,
  ...frontend.errors,
  ...merged.errors,
  ...retention.errors,
  ...sourceLocking.fixtureAudit.errors,
  ...sourceLocking.violations.map((violation) =>
    `${violation.path}:${violation.line}:${violation.column} ${violation.rule}: ${violation.message}`),
  ...evidence.contentErrors,
  ...evidence.missing.map((path) => `missing final evidence: ${path}`)
]

const report = {
  schema: 'fsusblog.test-suite-convergence.v1',
  trackingIssue: plan.trackingIssue,
  status: errors.length === 0 ? 'success' : 'blocked',
  mode: options.final ? 'final' : 'implementation',
  beforeSnapshot: repoPath(beforePath),
  afterSnapshot: afterPath ? repoPath(afterPath) : null,
  summary: {
    beforeTestRecords: compactBefore ? beforeSnapshot.testIndex.count : beforeRecords.length,
    afterTestRecords: afterRecords?.length ?? null,
    replacementDeclarations: merged.entries.length,
    deletedTestRecords: retention.deletedRecords.length,
    missingDeletionMappings: retention.missingDeletionMappings.length,
    mismatchedDeletionPaths: retention.mismatchedDeletionPaths.length,
    missingReplacementTargets: retention.missingReplacementTargets.length,
    backendSourceFilesScanned: sourceLocking.scannedFiles,
    backendSourceLockViolations: sourceLocking.violations.length,
    missingFinalEvidence: evidence.missing.length,
    invalidFinalEvidence: evidence.contentErrors.length,
    errors: errors.length
  },
  stageErrors,
  afterAuthorityErrors,
  replacementDeclarations: merged.entries.map(({ source: _source, ...entry }) => entry),
  replacementDeclarationSources: merged.entries.map((entry) => ({ id: entry.id, source: entry.source })),
  replacementConflicts: merged.conflicts,
  missingDeletionMappings: retention.missingDeletionMappings,
  unknownDeletionDeclarations: retention.unknownDeletionDeclarations,
  mismatchedDeletionPaths: retention.mismatchedDeletionPaths,
  missingReplacementTargets: retention.missingReplacementTargets,
  backendSourceLockViolations: sourceLocking.violations,
  evidence,
  errors
}

if (options.out) {
  mkdirSync(dirname(options.out), { recursive: true })
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[test-suite-convergence] ${error}`)
  process.exitCode = 1
} else {
  console.log(`[test-suite-convergence] ok replacements=${merged.entries.length} sourceFiles=${sourceLocking.scannedFiles}`)
}
