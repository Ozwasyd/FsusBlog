import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { externalEvidenceReceiptDigest } from '../../tools/test-matrix/local-profile.mjs'
import { validateQualifiedLocalProfile } from '../../tools/release/check-release-final.mjs'

const commit = '0123456789abcdef0123456789abcdef01234567'
const manifest = { commitSha: commit }
const sha = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

test('release-final rejects incomplete local profile and accepts only a sealed qualified external receipt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-release-final-local-profile-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceState = { commit, worktreeFingerprint: 'a'.repeat(64) }
  const placeholderPath = '.tmp/placeholders/external.json'
  const receiptPath = '.tmp/receipts/external.json'
  const placeholderFile = path.join(root, placeholderPath)
  const receiptFile = path.join(root, receiptPath)
  fs.mkdirSync(path.dirname(placeholderFile), { recursive: true })
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true })
  const placeholder = {
    schema: 'fsusblog.local-production.summary-only.v1', tierId: 'external', status: 'collected-blocked',
    executionSource: 'external-environment', schedulerRunId: 'run', sourceState
  }
  fs.writeFileSync(placeholderFile, JSON.stringify(placeholder))
  const receipt = {
    schema: 'fsusblog.external-correctness-receipt.v1', tierId: 'external', authorityId: 'authority',
    schedulerRunId: 'run', sourceState,
    buildIdentity: { schedulerRunId: 'run', sourceState, artifactDigestTableDigest: `sha256:${'b'.repeat(64)}` },
    testIds: ['test:external'], coverageIds: ['coverage:external'], assertionIds: ['assertion:external'], status: 'success'
  }
  receipt.contentDigest = externalEvidenceReceiptDigest(receipt)
  fs.writeFileSync(receiptFile, JSON.stringify(receipt))
  const base = {
    runId: 'run', targetTierId: 'production', mode: 'fresh', status: 'success', sourceState,
    tiers: {}, logicalTierProjection: {
      schema: 'fsusblog.local-profile-projection.v1', profileId: 'production', runId: 'run', sourceState,
      executionSource: 'fresh', logicalTierCount: 1, executedTierCount: 1, summaryOnlyTierCount: 0,
      requiredSummaryOnlyTierIds: ['external'], logicalTierIds: ['external'], qualificationEligible: true, status: 'complete-success',
      entries: { external: {
        tierId: 'external', evidenceKind: 'external-executed', physicalBundleId: null, status: 'success', executionSource: 'external-environment', durationMs: null,
        testIds: receipt.testIds, coverageIds: receipt.coverageIds, assertionIds: receipt.assertionIds,
        authorityId: receipt.authorityId, schedulerRunId: 'run', sourceState, buildIdentity: receipt.buildIdentity,
        blockedPlaceholder: { ...placeholder, evidencePath: placeholderPath, artifactDigest: sha(placeholderFile) },
        artifactDigests: { [receiptPath]: receipt.contentDigest }
      }}
    }
  }
  const file = path.join(root, 'checkpoint.json')
  const write = (value) => fs.writeFileSync(file, JSON.stringify(value))
  write({ ...base, logicalTierProjection: { ...base.logicalTierProjection, status: 'incomplete-external-evidence', qualificationEligible: false, summaryOnlyTierCount: 1, executedTierCount: 0, entries: { external: { ...base.logicalTierProjection.entries.external, evidenceKind: 'summary-only', status: 'collected-blocked', testIds: [], coverageIds: undefined, assertionIds: undefined } } } })
  assert.ok(validateQualifiedLocalProfile(file, manifest, root).some((error) => error.includes('not qualification-eligible')))
  write(base)
  assert.deepEqual(validateQualifiedLocalProfile(file, manifest, root), [])
  const unbound = structuredClone(base)
  delete unbound.logicalTierProjection.entries.external.blockedPlaceholder
  write(unbound)
  assert.ok(validateQualifiedLocalProfile(file, manifest, root).some((error) => error.includes('sealed validation failed')))
})
