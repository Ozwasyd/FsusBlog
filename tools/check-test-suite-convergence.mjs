#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditCompactRetentionRecords,
  auditRetentionRecords,
  mergeReplacementEntries,
  scanBackendSourceLocking,
  validateAfterSnapshotAuthority,
  verifySourceLockingFixtures
} from './test-convergence/audit.mjs'
import {
  decodeCompactRetentionIndex,
  isCompactRetentionBaseline,
  validateCompactRetentionBaseline
} from './test-retention/audit.mjs'
import { loadTestMatrix } from './test-matrix/command-groups.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = { after: null, out: null, final: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--after' || arg === '--out') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      options[arg.slice(2)] = resolve(root, value)
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
      if (!['bin', 'obj', 'node_modules', '.tmp', 'TestResults'].includes(entry.name)) walk(absolute, predicate, output)
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

function validatePostBaselines(paths, replacements) {
  const replacementById = new Map(replacements.map((entry) => [entry.id, entry]))
  const ids = []
  const errors = []
  const sources = []
  for (const path of paths ?? []) {
    const absolute = resolve(root, path)
    if (!existsSync(absolute)) {
      errors.push(`post-baseline snapshot does not exist: ${path}`)
      continue
    }
    const baseline = readJson(absolute)
    if (baseline?.schema !== 'fsusblog.issue-acceptance-baseline.v1') {
      errors.push(`${path}: unsupported post-baseline schema ${baseline?.schema ?? 'missing'}`)
      continue
    }
    let accepted = 0
    for (const record of baseline.records ?? []) {
      if (record?.disposition !== 'migrated') continue
      const replacement = replacementById.get(record.id)
      if (!replacement || replacement.path !== record.path) {
        errors.push(`${path}: migrated record lacks an exact central replacement: ${record?.id ?? '<missing id>'}`)
        continue
      }
      ids.push(record.id)
      accepted += 1
    }
    if (Number.isInteger(baseline.expectedMigrated) && accepted !== baseline.expectedMigrated) {
      errors.push(`${path}: expected ${baseline.expectedMigrated} migrated records, found ${accepted}`)
    }
    sources.push({ source: path, issue: baseline.issue, accepted })
  }
  return { ids: [...new Set(ids)], errors, sources }
}

function sourceLockingAudit() {
  const positivePath = resolve(root, 'tests/tools/fixtures/test-suite-convergence/backend-source-lock-positive.fixture.cs.txt')
  const negativePath = resolve(root, 'tests/tools/fixtures/test-suite-convergence/backend-source-lock-negative.fixture.cs.txt')
  const fixtureAudit = verifySourceLockingFixtures(readFileSync(positivePath, 'utf8'), readFileSync(negativePath, 'utf8'))
  const files = walk(resolve(root, 'tests/backend'), (path) => path.endsWith('Tests.cs'))
    .sort((left, right) => repoPath(left).localeCompare(repoPath(right)))
  const violations = files.flatMap((path) => scanBackendSourceLocking(readFileSync(path, 'utf8'), repoPath(path)))
  return { scannedFiles: files.length, fixtureAudit, violations }
}

const options = parseArgs(process.argv.slice(2))
const matrix = loadTestMatrix(root)
const retentionGovernance = matrix.governance?.retention ?? {}
const beforePath = resolve(root, retentionGovernance.baseline ?? 'tests/test-retention-before.json')
const centralPath = resolve(root, retentionGovernance.replacementLedger ?? 'tests/test-retention-replacements.json')
const beforeSnapshot = readJson(beforePath)
const compactBefore = isCompactRetentionBaseline(beforeSnapshot)
if (compactBefore) validateCompactRetentionBaseline(beforeSnapshot)
const beforeRecords = compactBefore ? null : recordsFromSnapshot(beforeSnapshot, repoPath(beforePath))
const merged = mergeReplacementEntries([{ source: repoPath(centralPath), manifest: readJson(centralPath) }])
const postBaseline = validatePostBaselines(retentionGovernance.postBaselines, merged.entries)
const defaultAfterPath = resolve(root, retentionGovernance.auditOutput ?? '.tmp/release-evidence/test-retention-audit.json')
const afterPath = options.after ?? (options.final && existsSync(defaultAfterPath) ? defaultAfterPath : null)
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
      ),
      postBaselineDeletionIds: postBaseline.ids
    })
  : auditRetentionRecords({
      beforeRecords,
      afterRecords,
      replacements: merged.entries,
      pathExists: (path) => existsSync(resolve(root, path)),
      preBaselineDeletionIds: beforeSnapshot.replacementManifestBaseline?.deletedTestIds ?? []
    })
const sourceLocking = sourceLockingAudit()
const afterAuthorityErrors = validateAfterSnapshotAuthority(beforeSnapshot, afterSnapshot, { required: options.final })
const errors = [
  ...afterAuthorityErrors,
  ...postBaseline.errors,
  ...merged.errors,
  ...retention.errors,
  ...sourceLocking.fixtureAudit.errors,
  ...sourceLocking.violations.map((violation) =>
    `${violation.path}:${violation.line}:${violation.column} ${violation.rule}: ${violation.message}`)
]

const report = {
  schema: 'fsusblog.test-suite-convergence.v1',
  trackingIssue: 1267,
  status: errors.length === 0 ? 'success' : 'blocked',
  mode: options.final ? 'final' : 'implementation',
  authority: {
    matrix: 'tests/matrix.yml',
    replacementLedger: repoPath(centralPath),
    issueLocalReplacementManifests: false
  },
  beforeSnapshot: repoPath(beforePath),
  afterSnapshot: afterPath ? repoPath(afterPath) : null,
  summary: {
    beforeTestRecords: compactBefore ? beforeSnapshot.testIndex.count : beforeRecords.length,
    afterTestRecords: afterRecords?.length ?? null,
    replacementDeclarations: merged.entries.length,
    postBaselineDeletionDeclarations: postBaseline.ids.length,
    deletedTestRecords: retention.deletedRecords.length,
    backendSourceFilesScanned: sourceLocking.scannedFiles,
    errors: errors.length
  },
  afterAuthorityErrors,
  postBaselineDeclarationSources: postBaseline.sources,
  missingDeletionMappings: retention.missingDeletionMappings,
  unknownDeletionDeclarations: retention.unknownDeletionDeclarations,
  mismatchedDeletionPaths: retention.mismatchedDeletionPaths,
  missingReplacementTargets: retention.missingReplacementTargets,
  backendSourceLockViolations: sourceLocking.violations,
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
