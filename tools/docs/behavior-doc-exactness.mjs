import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { digestCatalog } from '../contracts/behavior-contract-catalog.mjs'
import { digestValue } from '../fact-extractors/identity.mjs'
import { readFactObservationReceipt } from '../fact-extractors/reader.mjs'
import { resolveFactPath } from './generated-fact-sections/catalog.mjs'

export const behaviorDocExactnessSchema = 'fsusblog.behavior-doc-exactness-receipt.v1'

const preciseManualPattern = /(?:lastReviewedAt\s*:|lastVerifiedCommit\s*:|manual(?:ly)?[- ]approved\s*:|factWaiver\s*:)/iu

function sha256(bytes)
{
  return createHash('sha256').update(bytes).digest('hex')
}

function stableUnique(values)
{
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function seal(receipt)
{
  const output = { ...receipt, contentDigest: null }
  output.contentDigest = digestValue(output)
  return output
}

function readDocumentDigest(repositoryRoot, relative)
{
  return sha256(readFileSync(path.join(repositoryRoot, relative)))
}

function receiptIndex(receipts)
{
  const byExtractor = new Map()
  for (const source of receipts)
  {
    const receipt = readFactObservationReceipt(source)
    if (byExtractor.has(receipt.extractorId))
    {
      throw new Error(`duplicate observation receipt for ${receipt.extractorId}`)
    }
    byExtractor.set(receipt.extractorId, receipt)
  }
  return byExtractor
}

/**
 * Generate the unique exact migration ledger directly from BehaviorCatalog,
 * lifecycle, parsed DocClaims, generated-section catalog, and sealed observations.
 * No document or behavior allowlist is accepted.
 */
export function buildBehaviorDocExactnessReceipt({
  repositoryRoot,
  catalog,
  lifecycle,
  claimReceipt,
  sectionCatalog,
  observationReceipts,
  domains,
  sourceCommit,
  worktreeFingerprint,
  scopeId
})
{
  const selectedDomains = new Set(domains)
  const contracts = catalog.contracts
    .filter((contract) => contract.status === 'active'
      && contract.documentationPolicy === 'required'
      && selectedDomains.has(contract.domain))
    .sort((left, right) => left.id.localeCompare(right.id))
  if (contracts.length === 0)
  {
    throw new Error(`scope ${scopeId} selects no active required behaviors`)
  }

  const lifecycleByPath = new Map(lifecycle.documents.map((entry) => [entry.path, entry]))
  const contractById = new Map(contracts.map((entry) => [entry.id, entry]))
  const observations = receiptIndex(observationReceipts)
  const claims = claimReceipt.claims.filter((claim) => contractById.has(claim.declaration.behaviorId))
  const sections = sectionCatalog.sections.filter((section) => contractById.has(section.behaviorId))
  const sectionById = new Map()
  const failures = []
  for (const section of sections)
  {
    if (sectionById.has(section.sectionId)) failures.push(`duplicate section ${section.sectionId}`)
    sectionById.set(section.sectionId, section)
  }
  for (const section of sections)
  {
    const owners = claims.filter((claim) => claim.declaration.claimType === 'generated-section'
      && claim.declaration.generatedSectionId === section.sectionId)
    if (owners.length === 0) failures.push(`extra generated section without claim ${section.sectionId}`)
    if (owners.length > 1) failures.push(`duplicate generated claims for section ${section.sectionId}`)
    const document = lifecycleByPath.get(section.documentPath)
    if (!document || document.status !== 'current')
    {
      failures.push(`generated section ${section.sectionId} is not in a current document`)
    }
  }

  const rows = []
  for (const contract of contracts)
  {
    const behaviorClaims = claims.filter((claim) => claim.declaration.behaviorId === contract.id)
    const behaviorSections = sections.filter((section) => section.behaviorId === contract.id)
    if (behaviorClaims.length === 0 && behaviorSections.length === 0)
    {
      failures.push(`missing claim/section for required behavior ${contract.id}`)
    }
    const receipt = observations.get(contract.factExtractorId)
    if (!receipt || receipt.status !== 'ok' || !receipt.behaviorIds.includes(contract.id))
    {
      failures.push(`missing successful observation for ${contract.id}`)
    }

    for (const documentPath of contract.documents)
    {
      const metadata = lifecycleByPath.get(documentPath)
      if (!metadata || metadata.status !== 'current')
      {
        failures.push(`required document ${documentPath} is not current`)
      }
    }

    for (const claim of behaviorClaims)
    {
      const declaration = claim.declaration
      const section = declaration.claimType === 'generated-section'
        ? sectionById.get(declaration.generatedSectionId)
        : null
      if (declaration.claimType === 'generated-section' && !section)
      {
        failures.push(`claim ${declaration.claimId} references missing generated section`)
        continue
      }
      const factPath = section?.factPath ?? declaration.factPath
      const ownerExtractor = section?.extractorId ?? contract.factExtractorId
      if (ownerExtractor !== contract.factExtractorId)
      {
        failures.push(`claim ${declaration.claimId} has conflicting extractor owner ${ownerExtractor}`)
      }
      const ownerReceipt = observations.get(ownerExtractor)
      if (!ownerReceipt || resolveFactPath(ownerReceipt.observations, factPath) === undefined)
      {
        failures.push(`claim ${declaration.claimId} references missing observation ${factPath}`)
      }
      const lifecycleEntry = lifecycleByPath.get(claim.location.documentPath)
      if (!lifecycleEntry || lifecycleEntry.status !== 'current')
      {
        failures.push(`claim ${declaration.claimId} is not in a current document`)
      }
      rows.push({
        behaviorId: contract.id,
        domain: contract.domain,
        currentAuthority: claim.location.documentPath,
        documentOwner: lifecycleEntry?.owner ?? 'missing',
        claimId: declaration.claimId,
        claimType: declaration.claimType,
        sectionId: section?.sectionId ?? null,
        ownership: section ? 'generated' : 'prose',
        extractorId: ownerExtractor,
        observationId: factPath,
        sourceRange: `${claim.location.claimStartLine}:${claim.location.claimEndLine}`,
        requiredTestKinds: [...contract.requiredTestKinds].sort(),
        mutationRequired: contract.mutationPolicy?.mutationRequired === true,
        documentDigest: readDocumentDigest(repositoryRoot, claim.location.documentPath)
      })
    }
  }

  const rowKeys = new Set()
  for (const row of rows)
  {
    const key = `${row.behaviorId}\0${row.observationId}\0${row.currentAuthority}`
    if (rowKeys.has(key)) failures.push(`duplicate exactness owner ${row.behaviorId}/${row.observationId}/${row.currentAuthority}`)
    rowKeys.add(key)
  }

  const scopedDocuments = stableUnique(rows.map((row) => row.currentAuthority))
  const manualFactDocuments = scopedDocuments.filter((documentPath) =>
    preciseManualPattern.test(readFileSync(path.join(repositoryRoot, documentPath), 'utf8')))
  if (manualFactDocuments.length > 0)
  {
    failures.push(`self-certified/manual compatibility surface in ${manualFactDocuments.join(', ')}`)
  }

  const counts = {
    required: contracts.length,
    generated: rows.filter((row) => row.ownership === 'generated').length,
    prose: rows.filter((row) => row.ownership === 'prose').length,
    verified: rows.length,
    missing: failures.filter((entry) => entry.startsWith('missing')).length,
    extra: 0,
    conflict: failures.filter((entry) => /conflict|duplicate/u.test(entry)).length,
    stale: 0,
    retired: 0,
    manualFact: manualFactDocuments.length,
    warnings: 0
  }
  const status = failures.length === 0 ? 'ok' : 'failed'
  return seal({
    schema: behaviorDocExactnessSchema,
    scopeId,
    source: { commit: sourceCommit, worktreeFingerprint },
    authorityDigests: {
      behaviorCatalog: digestCatalog(catalog),
      lifecycle: digestValue(lifecycle),
      claims: claimReceipt.contentDigest,
      generatedSections: digestValue(sectionCatalog),
      observations: digestValue([...observations.values()].map((receipt) => receipt.contentDigest).sort())
    },
    domains: stableUnique([...selectedDomains]),
    rows: rows.sort((left, right) => left.claimId.localeCompare(right.claimId)),
    counts,
    status,
    failureReasons: stableUnique(failures)
  })
}

export function validateBehaviorDocExactnessReceipt(receipt)
{
  if (receipt?.schema !== behaviorDocExactnessSchema) throw new Error('unexpected exactness receipt schema')
  const expected = digestValue({ ...receipt, contentDigest: null })
  if (receipt.contentDigest !== expected) throw new Error('exactness receipt contentDigest mismatch')
  if (receipt.status !== 'ok' || receipt.failureReasons.length !== 0 || receipt.counts.warnings !== 0)
  {
    throw new Error(`behavior doc exactness failed: ${receipt.failureReasons.join('; ')}`)
  }
  return receipt
}
