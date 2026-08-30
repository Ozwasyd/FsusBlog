import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildBehaviorDocExactnessReceipt,
  runAuthSecurityDocMutationCases,
  scanAuthSecurityDocResidue,
  validateBehaviorDocExactnessReceipt,
  verifyBehaviorDocExactnessReplay
} from '../../tools/docs/behavior-doc-exactness.mjs'
import { buildReceipt } from '../../tools/fact-extractors/receipt.mjs'
import { digestValue } from '../../tools/fact-extractors/identity.mjs'

const SHA = 'a'.repeat(40)
const DIGEST = 'b'.repeat(64)

function fixture()
{
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-doc-exactness-'))
  mkdirSync(path.join(repositoryRoot, 'docs'), { recursive: true })
  writeFileSync(path.join(repositoryRoot, 'docs/security.md'), '# Security\n\nGenerated facts.\n')
  const catalog = {
    schema: 'fsusblog.behavior-contract-catalog.v1',
    digestAlgorithm: 'sha256',
    canonicalSerialization: 'json-utf8-v1',
    domains: ['security'],
    extractors: [{ id: 'security-extractor', path: 'tools/security.mjs' }],
    contracts: [{
      id: 'configuration-error-security-policy',
      domain: 'security',
      risk: 'critical',
      status: 'active',
      implementationOwnerCardinality: 'one',
      allowedImplementationOwnerRoles: [],
      factExtractorId: 'security-extractor',
      requiredTestKinds: ['positive', 'negative'],
      documentationPolicy: 'required',
      documentationRationale: 'Security behavior is public.',
      allowedClaimTypes: ['safety'],
      releaseQualification: true,
      coverageIds: ['configuration-error-security-policy'],
      documents: ['docs/security.md']
    }]
  }
  const lifecycle = { documents: [{ path: 'docs/security.md', status: 'current', owner: 'security' }] }
  const claim = {
    declaration: {
      claimId: 'security.permissions',
      behaviorId: 'configuration-error-security-policy',
      claimType: 'generated-section',
      generatedSectionId: 'security.permissions',
      render: 'enum-set'
    },
    location: {
      documentPath: 'docs/security.md',
      claimStartLine: 3,
      claimEndLine: 8,
      documentStatus: 'current',
      headingPath: ['Security'],
      bodyKind: 'none',
      bodyStartLine: null,
      bodyEndLine: null,
      bodyText: ''
    }
  }
  const claimBase = {
    schema: 'fsusblog.doc-claim-parse-receipt.v1',
    digestAlgorithm: 'sha256',
    canonicalSerialization: 'json-utf8-v1',
    behaviorCatalogDigest: digestValue(catalog),
    claims: [claim]
  }
  const claimReceipt = { ...claimBase, contentDigest: digestValue(claimBase) }
  const sectionCatalog = {
    schema: 'fsusblog.generated-fact-section-catalog.v1',
    digestAlgorithm: 'sha256',
    canonicalSerialization: 'json-utf8-v1',
    sections: [{
      sectionId: 'security.permissions',
      documentPath: 'docs/security.md',
      renderer: 'enum-set',
      extractorId: 'security-extractor',
      behaviorId: 'configuration-error-security-policy',
      factPath: 'facts.security.permissions',
      orderPolicy: 'ordinal',
      emptyPolicy: 'fail'
    }]
  }
  const observation = buildReceipt({
    extractorId: 'security-extractor',
    behaviorIds: ['configuration-error-security-policy'],
    sourceCommit: SHA,
    worktreeFingerprint: DIGEST,
    extractorDigest: DIGEST,
    registryDigest: DIGEST,
    consumedInputDigests: [{ path: 'tools/security.mjs', digest: DIGEST }],
    observations: { facts: { 'security.permissions': ['admin.read'] } },
    status: 'ok'
  })
  const migrationLedger = {
    schema: 'fsusblog.document-claim-migration-ledger.v1',
    scopes: [{
      scopeId: 'auth-security-configuration-admin-error',
      behaviorIds: ['configuration-error-security-policy'],
      entries: [{
        behaviorId: 'configuration-error-security-policy',
        documentPath: 'docs/security.md',
        claimIds: ['security.permissions'],
        generatedSectionIds: ['security.permissions']
      }]
    }]
  }
  return { repositoryRoot, catalog, lifecycle, migrationLedger, claimReceipt, sectionCatalog, observation }
}

function build(value, overrides = {})
{
  return buildBehaviorDocExactnessReceipt({
    ...value,
    observationReceipts: [value.observation],
    domains: ['security'],
    sourceCommit: SHA,
    worktreeFingerprint: DIGEST,
    scopeId: 'auth-security-configuration-admin-error',
    ...overrides
  })
}

test('auth/security exactness derives a sealed ledger from the existing authorities', () =>
{
  const value = fixture()
  try
  {
    const receipt = build(value)
    validateBehaviorDocExactnessReceipt(receipt)
    assert.equal(receipt.counts.required, 1)
    assert.equal(receipt.counts.generated, 1)
    assert.equal(receipt.counts.warnings, 0)
    assert.equal(receipt.rows[0].observationId, 'facts.security.permissions')
  }
  finally
  {
    rmSync(value.repositoryRoot, { recursive: true, force: true })
  }
})

test('terminal mutation evidence kills all twelve required degradation classes', () =>
{
  const evidence = runAuthSecurityDocMutationCases()
  assert.equal(evidence.total, 12)
  assert.equal(evidence.killed, evidence.total)
  assert.deepEqual(evidence.rows.map((row) => row.classId), [
    'auth-direction-reversal',
    'window-cache-alias',
    'global-error-substitute',
    'example-as-default',
    'permission-mismatch',
    'retired-listed-current',
    'overbroad-claim',
    'rationale-escape',
    'source-policy-drift',
    'opposite-prose',
    'hidden-compatibility',
    'self-certification'
  ])
})

test('terminal residue scanner rejects manual exact tables and hidden compatibility copies', () =>
{
  const value = fixture()
  try
  {
    writeFileSync(path.join(value.repositoryRoot, 'docs/security.md'), '| AuthenticationMethod | Meaning |\n| --- | --- |\n<details>legacy compatibility table</details>\n')
    const violations = scanAuthSecurityDocResidue(value.repositoryRoot, ['docs/security.md'])
    assert.deepEqual(violations.map((entry) => entry.classId).sort(), ['hidden-compatibility', 'manual-exact-table'])
  }
  finally
  {
    rmSync(value.repositoryRoot, { recursive: true, force: true })
  }
})

test('independent replay rejects a re-sealed forged row, count, or authority digest', () =>
{
  const value = fixture()
  try
  {
    const inputs = {
      ...value,
      observationReceipts: [value.observation],
      domains: ['security'],
      sourceCommit: SHA,
      worktreeFingerprint: DIGEST,
      scopeId: 'auth-security-configuration-admin-error'
    }
    const receipt = buildBehaviorDocExactnessReceipt(inputs)
    for (const mutate of [
      (copy) => { copy.counts.verified += 1 },
      (copy) => { copy.rows[0].observationId = 'facts.security.forged' },
      (copy) => { copy.authorityDigests.claims = 'c'.repeat(64) }
    ])
    {
      const forged = structuredClone(receipt)
      mutate(forged)
      forged.contentDigest = digestValue({ ...forged, contentDigest: null })
      assert.throws(() => verifyBehaviorDocExactnessReplay(forged, inputs), /independent replay/u)
    }
  }
  finally
  {
    rmSync(value.repositoryRoot, { recursive: true, force: true })
  }
})

test('auth/security exactness rejects missing claims, duplicate ownership, stale facts, and self-certification', () =>
{
  const value = fixture()
  try
  {
    const missing = build(value, {
      claimReceipt: { ...value.claimReceipt, claims: [] },
      sectionCatalog: { ...value.sectionCatalog, sections: [] },
      migrationLedger: {
        ...value.migrationLedger,
        scopes: [{ ...value.migrationLedger.scopes[0], entries: [{
          ...value.migrationLedger.scopes[0].entries[0], claimIds: [], generatedSectionIds: []
        }] }]
      }
    })
    assert.equal(missing.status, 'failed')
    assert.ok(missing.failureReasons.some((reason) => /missing claim\/section/u.test(reason)))

    const duplicateClaim = structuredClone(value.claimReceipt.claims[0])
    duplicateClaim.declaration.claimId = 'security.permissions-copy'
    const duplicate = build(value, {
      claimReceipt: { ...value.claimReceipt, claims: [...value.claimReceipt.claims, duplicateClaim] }
    })
    assert.ok(duplicate.failureReasons.some((reason) => /duplicate exactness owner/u.test(reason)))

    const staleSection = structuredClone(value.sectionCatalog)
    staleSection.sections[0].factPath = 'facts.security.missing'
    const stale = build(value, { sectionCatalog: staleSection })
    assert.ok(stale.failureReasons.some((reason) => /missing observation/u.test(reason)))

    writeFileSync(path.join(value.repositoryRoot, 'docs/security.md'), '# Security\nlastVerifiedCommit: deadbeef\n')
    const selfCertified = build(value)
    assert.equal(selfCertified.counts.manualFact, 1)
    assert.equal(selfCertified.status, 'failed')
  }
  finally
  {
    rmSync(value.repositoryRoot, { recursive: true, force: true })
  }
})
