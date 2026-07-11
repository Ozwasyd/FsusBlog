import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateDeadCodeAuditIndex } from '../../tools/governance/check-dead-code-audit-index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const indexPath = path.join(root, 'docs/planning/dead-code-audit-index.json')

async function canonicalIndex() {
  return JSON.parse(await readFile(indexPath, 'utf8'))
}

function clone(value) {
  return structuredClone(value)
}

test('canonical index is structurally valid while honestly remaining incomplete', async () => {
  const report = await validateDeadCodeAuditIndex(await canonicalIndex(), { root })

  assert.equal(report.passed, true, report.errors.join('\n'))
  assert.equal(report.childIssueCount, 17)
  assert.equal(report.sourceReportComplete, false)
  assert.equal(report.currentValidationPassed, false)
  assert.equal(report.stagesComplete, false)
  assert.equal(report.completionReady, false)
  assert.deepEqual(report.errors, [])
  assert.ok(report.warnings.some((warning) => warning.includes('source report is unavailable')))
  assert.ok(report.warnings.some((warning) => warning.includes('#1013')))
  assert.ok(report.warnings.some((warning) => warning.includes('#1014')))
})

test('require-complete fails closed for the missing report, unvalidated worktree, and staged issues', async () => {
  const report = await validateDeadCodeAuditIndex(await canonicalIndex(), {
    root,
    requireComplete: true
  })

  assert.equal(report.passed, false)
  assert.equal(report.completionReady, false)
  assert.ok(report.errors.some((error) => error.includes('checked-in complete source report')))
  assert.ok(report.errors.some((error) => error.includes('currentWorktreeValidation.status=passed')))
  assert.ok(report.errors.some((error) => error.includes('#1013 and #1014 stage gates')))
})

test('index must contain the exact ordered child range and the real 8/7/2 split', async () => {
  const index = clone(await canonicalIndex())
  index.children.splice(3, 1)
  index.children.push(clone(index.children[0]))

  const report = await validateDeadCodeAuditIndex(index, { root })

  assert.equal(report.passed, false)
  assert.ok(report.errors.some((error) => error.includes('ordered contiguous issue range #998-#1014')))
  assert.ok(report.errors.some((error) => error.includes('duplicate child issue')))
  assert.ok(report.errors.some((error) => error.includes('actual issue split')))
})

test('historical GitHub comments cannot be relabeled as current worktree validation', async () => {
  const index = clone(await canonicalIndex())
  index.children[0].githubHistoricalEvidence.evidenceKind = 'current-validation'
  index.children[0].currentWorktreeEvidence.verificationStatus = 'passed'

  const report = await validateDeadCodeAuditIndex(index, { root })

  assert.equal(report.passed, false)
  assert.ok(report.errors.some((error) => error.includes('historical comments from current validation')))
  assert.ok(report.errors.some((error) => error.includes('cannot claim current verification')))
})

test('stage issue cannot become ready or complete without every trigger and evidence path', async () => {
  const index = clone(await canonicalIndex())
  const staged = index.children.find((entry) => entry.issue === 1013)
  staged.stageGate.status = 'complete'
  staged.githubHistoricalEvidence.stateObserved = 'closed'
  staged.stageGate.triggers[0].satisfied = true

  const report = await validateDeadCodeAuditIndex(index, { root })

  assert.equal(report.passed, false)
  assert.equal(report.stagesComplete, false)
  assert.ok(report.errors.some((error) => error.includes('satisfied without evidence paths')))
  assert.ok(report.errors.some((error) => error.includes('cannot be complete until every required trigger')))
})

test('source report cannot be called complete without a checked-in file and matching sha256', async () => {
  const index = clone(await canonicalIndex())
  index.auditClaims.sourceReport.availability = 'checked-in-complete'
  index.auditClaims.sourceReport.contentSha256 = `sha256:${'0'.repeat(64)}`

  const report = await validateDeadCodeAuditIndex(index, { root })

  assert.equal(report.passed, false)
  assert.equal(report.sourceReportComplete, false)
  assert.ok(report.errors.some((error) => error.includes('checked-in-complete source report is missing')))
})

test('checker aggregates independent errors without a maximum-error cutoff', async () => {
  const index = clone(await canonicalIndex())
  index.schemaVersion = 'invalid'
  index.auditClaims.findingCounts.total = 84
  index.auditClaims.findingCounts.currentRecountStatus = 'passed'
  index.children[1].issue = 998
  index.children[1].title = ''
  index.children[1].githubHistoricalEvidence.commentsRead = false

  const report = await validateDeadCodeAuditIndex(index, { root })

  assert.equal(report.passed, false)
  assert.ok(report.errors.length >= 7, report.errors.join('\n'))
  assert.ok(report.errors.some((error) => error.includes('schemaVersion')))
  assert.ok(report.errors.some((error) => error.includes('finding counts')))
  assert.ok(report.errors.some((error) => error.includes('duplicate child issue')))
  assert.ok(report.errors.some((error) => error.includes('commentsRead=true')))
})
