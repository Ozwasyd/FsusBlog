import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildBehaviorDocExactnessReceipt,
  validateBehaviorDocExactnessReceipt
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
      id: 'security-behavior',
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
      coverageIds: ['security-behavior'],
      documents: ['docs/security.md']
    }]
  }
  const lifecycle = { documents: [{ path: 'docs/security.md', status: 'current', owner: 'security' }] }
  const claim = {
    declaration: {
      claimId: 'security.permissions',
      behaviorId: 'security-behavior',
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
      behaviorId: 'security-behavior',
      factPath: 'facts.security.permissions',
      orderPolicy: 'ordinal',
      emptyPolicy: 'fail'
    }]
  }
  const observation = buildReceipt({
    extractorId: 'security-extractor',
    behaviorIds: ['security-behavior'],
    sourceCommit: SHA,
    worktreeFingerprint: DIGEST,
    extractorDigest: DIGEST,
    registryDigest: DIGEST,
    consumedInputDigests: [{ path: 'tools/security.mjs', digest: DIGEST }],
    observations: { facts: { 'security.permissions': ['admin.read'] } },
    status: 'ok'
  })
  return { repositoryRoot, catalog, lifecycle, claimReceipt, sectionCatalog, observation }
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

test('auth/security exactness rejects missing claims, duplicate ownership, stale facts, and self-certification', () =>
{
  const value = fixture()
  try
  {
    const missing = build(value, {
      claimReceipt: { ...value.claimReceipt, claims: [] },
      sectionCatalog: { ...value.sectionCatalog, sections: [] }
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

test('content exactness closes article, comment, privacy, outbox, and notification ownership without a document allowlist', () =>
{
  const value = fixture()
  try
  {
    mkdirSync(path.join(value.repositoryRoot, 'docs/api'), { recursive: true })
    writeFileSync(path.join(value.repositoryRoot, 'docs/api/article-publication-revisions.md'), '# Article publication\n')
    const contract = value.catalog.contracts[0]
    contract.id = 'article-comment-lifecycle-outbox'
    contract.domain = 'content'
    contract.factExtractorId = 'content-extractor'
    contract.documents = ['docs/api/article-publication-revisions.md']
    value.catalog.domains = ['content']
    value.catalog.extractors = [{ id: 'content-extractor', path: 'tools/content.mjs' }]
    value.lifecycle.documents = [{
      path: 'docs/api/article-publication-revisions.md',
      status: 'current',
      owner: 'backend'
    }]
    const declaration = value.claimReceipt.claims[0].declaration
    declaration.claimId = 'content.article-transitions'
    declaration.behaviorId = contract.id
    declaration.generatedSectionId = 'content.article-transitions'
    const location = value.claimReceipt.claims[0].location
    location.documentPath = 'docs/api/article-publication-revisions.md'
    const section = value.sectionCatalog.sections[0]
    section.sectionId = 'content.article-transitions'
    section.documentPath = location.documentPath
    section.extractorId = 'content-extractor'
    section.behaviorId = contract.id
    section.factPath = 'facts.article.transitions'
    value.observation = buildReceipt({
      extractorId: 'content-extractor',
      behaviorIds: [contract.id],
      sourceCommit: SHA,
      worktreeFingerprint: DIGEST,
      extractorDigest: DIGEST,
      registryDigest: DIGEST,
      consumedInputDigests: [{ path: 'tools/content.mjs', digest: DIGEST }],
      observations: { facts: { 'article.transitions': ['Draft->Published'] } },
      status: 'ok'
    })
    const receipt = build(value, {
      domains: ['content'],
      scopeId: 'article-comment-privacy-outbox-notification'
    })
    validateBehaviorDocExactnessReceipt(receipt)
    assert.deepEqual(receipt.domains, ['content'])
    assert.equal(receipt.rows[0].currentAuthority, 'docs/api/article-publication-revisions.md')
    assert.equal(receipt.counts.missing, 0)
  }
  finally
  {
    rmSync(value.repositoryRoot, { recursive: true, force: true })
  }
})
