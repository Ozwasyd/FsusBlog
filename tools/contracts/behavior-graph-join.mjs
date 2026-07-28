/**
 * BehaviorGraph consistency join.
 *
 * Consumes sealed public receipts only:
 *   BehaviorCatalog (+ digest)
 *   ImplementationOwner receipt
 *   FactObservation receipts
 *   BehaviorTestEvidence receipt
 *   DocClaim parse + verification receipts
 *   GeneratedSection check receipt
 *
 * Does not import extractors, DocClaim/Markdown parsers, test runners, owner scanners,
 * or business assemblies. Does not read repository change sets, invoke producers, or repair inputs.
 * Fail closed: identity drift, missing inputs, and partial producer failures fail the join.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const behaviorGraphSchema = 'fsusblog.behavior-graph-receipt.v1'
export const ownerReceiptSchema = 'fsusblog.behavior-owner-binding-receipt.v1'
export const testEvidenceSchema = 'fsusblog.behavior-test-evidence-receipt.v1'
export const factObservationSchema = 'fsusblog.fact-observation-receipt.v1'
export const docClaimParseSchema = 'fsusblog.doc-claim-parse-receipt.v1'
export const docClaimVerificationSchema = 'fsusblog.doc-claim-verification-receipt.v1'
export const generatedSectionCheckSchema = 'fsusblog.generated-section-check-receipt.v1'
export const mutationEvidenceSchema = 'fsusblog.mutation-evidence-receipt.v1'
export const catalogSchema = 'fsusblog.behavior-contract-catalog.v1'

export const forbiddenJoinFields = Object.freeze([
  'lastVerifiedCommit',
  'gitDiff',
  'changedPaths',
  'optionalJoin',
  'defaultPass',
  'warning',
  'warnings',
  'partial',
  'sync',
  'featureFlag',
  'approved',
  'baseline',
  'expectedValue'
])

const commitPattern = /^[a-f0-9]{40}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const prefixedDigestPattern = /^sha256:[a-f0-9]{64}$/u
const behaviorIdPattern = /^[a-z][a-z0-9-]*$/u

const fail = (message) =>
{
  throw new Error(`[behavior-graph-join] ${message}`)
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function stable (value)
{
  if (Array.isArray(value)) return value.map(stable)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

export function canonicalize (value)
{
  return JSON.stringify(stable(value))
}

export function digestValue (value)
{
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')
}

export function normalizeFingerprint (value)
{
  if (typeof value !== 'string' || value.length === 0) return null
  if (prefixedDigestPattern.test(value)) return value.slice('sha256:'.length)
  if (digestPattern.test(value)) return value
  return null
}

export function normalizeDigest (value)
{
  if (typeof value !== 'string' || value.length === 0) return null
  if (prefixedDigestPattern.test(value)) return value.slice('sha256:'.length)
  if (digestPattern.test(value)) return value
  return null
}

function assertNoForbiddenKeys (value, label)
{
  if (Array.isArray(value))
  {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${label}[${index}]`))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, nested] of Object.entries(value))
  {
    if (forbiddenJoinFields.includes(key))
    {
      fail(`${label} contains forbidden field ${key}`)
    }
    assertNoForbiddenKeys(nested, `${label}.${key}`)
  }
}

function loadJsonInput (input, label)
{
  if (input == null) fail(`${label} is required`)
  if (typeof input === 'string')
  {
    return JSON.parse(readFileSync(input, 'utf8'))
  }
  if (isPlainObject(input)) return structuredClone(input)
  fail(`${label} must be a path or object`)
}

function requireDigestMatch (receipt, label)
{
  if (typeof receipt.contentDigest !== 'string') fail(`${label} missing contentDigest`)
  const expected = digestValue({ ...receipt, contentDigest: undefined })
  const actual = normalizeDigest(receipt.contentDigest)
  if (actual !== expected && receipt.contentDigest !== expected && receipt.contentDigest !== `sha256:${expected}`)
  {
    // Support bare hex and sha256: prefix digests over the same payload.
    const bare = digestValue(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
    if (actual !== bare && receipt.contentDigest !== bare && receipt.contentDigest !== `sha256:${bare}`)
    {
      fail(`${label} contentDigest mismatch`)
    }
  }
}

export function sealReceiptPayload (payload)
{
  assertNoForbiddenKeys(payload, 'receipt')
  const sealed = { ...payload, contentDigest: null }
  sealed.contentDigest = digestValue(Object.fromEntries(Object.entries(sealed).filter(([key]) => key !== 'contentDigest')))
  return sealed
}

/**
 * Seal an ImplementationOwner scan/report into a joinable receipt with contentDigest.
 * Callers already hold the owner report; this never scans source.
 */
export function sealOwnerBindingReceipt (report)
{
  if (!isPlainObject(report)) fail('owner receipt must be an object')
  if (report.schema !== ownerReceiptSchema) fail(`owner receipt schema must be ${ownerReceiptSchema}`)
  if (!digestPattern.test(report.catalogDigest)) fail('owner receipt catalogDigest invalid')
  if (!Array.isArray(report.bindings) || !Array.isArray(report.errors)) fail('owner receipt bindings/errors required')
  const status = report.status
    ?? (report.errors.length === 0 ? 'ok' : 'failed')
  return sealReceiptPayload({
    schema: ownerReceiptSchema,
    catalogDigest: report.catalogDigest,
    worktreeDigest: String(report.worktreeDigest ?? ''),
    status,
    bindingCount: report.bindingCount ?? report.bindings.length,
    bindings: report.bindings.map((binding) => ({
      behaviorId: binding.behaviorId,
      language: binding.language,
      sourcePath: binding.sourcePath,
      symbol: binding.symbol,
      bindingKind: binding.bindingKind,
      sourceDigest: binding.sourceDigest,
      catalogDigest: binding.catalogDigest ?? report.catalogDigest,
      worktreeDigest: binding.worktreeDigest ?? report.worktreeDigest,
      status: binding.status ?? 'ok',
      ...(binding.role ? { role: binding.role } : {})
    })),
    errors: [...report.errors].sort((left, right) => left.localeCompare(right))
  })
}

/**
 * Seal DocClaim verification results already produced by ProseClaimVerifier consumers.
 * Does not parse Markdown or invoke verifiers.
 */
export function sealDocClaimVerificationReceipt ({
  sourceCommit,
  worktreeFingerprint,
  catalogDigest,
  parseReceiptDigest,
  factObservationDigests = [],
  results = [],
  status,
  failureReasons = []
})
{
  if (!commitPattern.test(sourceCommit)) fail('verification sourceCommit invalid')
  if (!normalizeFingerprint(worktreeFingerprint)) fail('verification worktreeFingerprint invalid')
  if (!digestPattern.test(catalogDigest) || !digestPattern.test(parseReceiptDigest))
  {
    fail('verification catalog/parse digests invalid')
  }
  if (status !== 'ok' && status !== 'failed') fail(`verification status invalid: ${status}`)
  if (status === 'ok' && failureReasons.length !== 0) fail('verification status=ok cannot include failureReasons')
  if (status === 'failed' && failureReasons.length === 0) fail('verification status=failed requires failureReasons')
  return sealReceiptPayload({
    schema: docClaimVerificationSchema,
    sourceCommit,
    worktreeFingerprint: normalizeFingerprint(worktreeFingerprint),
    catalogDigest,
    parseReceiptDigest,
    factObservationDigests: [...factObservationDigests]
      .map((entry) => ({ extractorId: entry.extractorId, contentDigest: entry.contentDigest }))
      .sort((left, right) => left.extractorId.localeCompare(right.extractorId)),
    results: [...results]
      .map((entry) => ({
        claimId: entry.claimId,
        behaviorId: entry.behaviorId,
        claimType: entry.claimType,
        documentPath: entry.documentPath,
        documentStatus: entry.documentStatus,
        factPath: entry.factPath ?? null,
        status: entry.status,
        reason: entry.reason
      }))
      .sort((left, right) =>
      {
        const byClaim = left.claimId.localeCompare(right.claimId)
        if (byClaim !== 0) return byClaim
        return left.documentPath.localeCompare(right.documentPath)
      }),
    status,
    failureReasons: [...failureReasons].sort((left, right) => left.localeCompare(right))
  })
}

/**
 * Seal generated-section --check results already produced by the section engine.
 * Does not re-render Markdown or invoke generators.
 */
export function sealGeneratedSectionCheckReceipt ({
  sourceCommit,
  worktreeFingerprint,
  catalogDigest,
  sectionCatalogDigest,
  factObservationDigests = [],
  sections = [],
  status,
  failureReasons = []
})
{
  if (!commitPattern.test(sourceCommit)) fail('generated-section sourceCommit invalid')
  if (!normalizeFingerprint(worktreeFingerprint)) fail('generated-section worktreeFingerprint invalid')
  if (!digestPattern.test(catalogDigest) || !digestPattern.test(sectionCatalogDigest))
  {
    fail('generated-section catalog digests invalid')
  }
  if (status !== 'ok' && status !== 'failed') fail(`generated-section status invalid: ${status}`)
  if (status === 'ok' && failureReasons.length !== 0) fail('generated-section status=ok cannot include failureReasons')
  if (status === 'failed' && failureReasons.length === 0) fail('generated-section status=failed requires failureReasons')
  return sealReceiptPayload({
    schema: generatedSectionCheckSchema,
    sourceCommit,
    worktreeFingerprint: normalizeFingerprint(worktreeFingerprint),
    catalogDigest,
    sectionCatalogDigest,
    factObservationDigests: [...factObservationDigests]
      .map((entry) => ({ extractorId: entry.extractorId, contentDigest: entry.contentDigest }))
      .sort((left, right) => left.extractorId.localeCompare(right.extractorId)),
    sections: [...sections]
      .map((entry) => ({
        sectionId: entry.sectionId,
        behaviorId: entry.behaviorId,
        documentPath: entry.documentPath,
        factPath: entry.factPath,
        status: entry.status,
        reason: entry.reason
      }))
      .sort((left, right) => left.sectionId.localeCompare(right.sectionId)),
    status,
    failureReasons: [...failureReasons].sort((left, right) => left.localeCompare(right))
  })
}


function validateMutationEvidenceReceipt (receipt)
{
  if (!isPlainObject(receipt)) fail('mutation evidence receipt must be an object')
  if (receipt.schema !== mutationEvidenceSchema)
  {
    fail(`mutation evidence schema must be ${mutationEvidenceSchema}`)
  }
  assertNoForbiddenKeys(receipt, 'mutationEvidence')
  if (typeof receipt.contentDigest !== 'string') fail('mutation evidence missing contentDigest')
  const expected = digestValue(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
  if (receipt.contentDigest !== expected && receipt.contentDigest !== `sha256:${expected}`)
  {
    fail('mutation evidence contentDigest mismatch')
  }
  if (!commitPattern.test(receipt.sourceCommit)) fail('mutation evidence sourceCommit invalid')
  if (!normalizeFingerprint(receipt.worktreeFingerprint)) fail('mutation evidence worktreeFingerprint invalid')
  if (!digestPattern.test(receipt.catalogDigest)) fail('mutation evidence catalogDigest invalid')
  if (!Array.isArray(receipt.attributions) || !Array.isArray(receipt.qualifications))
  {
    fail('mutation evidence receipt incomplete')
  }
  if (receipt.status !== 'ok' && receipt.status !== 'failed') fail('mutation evidence status invalid')
  for (const field of ['selectionDigest', 'ownerReceiptDigest', 'testBindingScanDigest', 'rawReportDigest', 'rawTraceDigest'])
  {
    if (!digestPattern.test(String(receipt[field] ?? ''))) fail(`mutation evidence ${field} invalid`)
  }
  if (!Number.isInteger(receipt.blockedCount) || receipt.blockedCount < 0) fail('mutation evidence blockedCount invalid')
  const qualifications = new Set()
  for (const qualification of receipt.qualifications)
  {
    if (!behaviorIdPattern.test(String(qualification.behaviorId ?? '')) || qualifications.has(qualification.behaviorId))
    {
      fail('mutation evidence qualifications must have unique behavior IDs')
    }
    qualifications.add(qualification.behaviorId)
    if (qualification.mutationRequired !== true || !Number.isFinite(qualification.score) || !Array.isArray(qualification.failures) || typeof qualification.qualified !== 'boolean')
    {
      fail(`mutation evidence qualification for ${qualification.behaviorId} is incomplete`)
    }
  }
  for (const attribution of receipt.attributions)
  {
    if (!behaviorIdPattern.test(String(attribution.behaviorId ?? '')) || !['Killed', 'Survived', 'Timeout', 'NoCoverage', 'CompileError', 'Ignored'].includes(attribution.status))
    {
      fail('mutation evidence attribution is invalid')
    }
  }
  if (receipt.status === 'ok' && (receipt.blockedCount !== 0 || receipt.qualifications.some((entry) => !entry.qualified)))
  {
    fail('mutation evidence status=ok cannot conceal blocked or unqualified mutations')
  }
  return receipt
}

function validateCatalog (catalog)
{
  if (!isPlainObject(catalog)) fail('catalog must be an object')
  if (catalog.schema !== catalogSchema) fail(`catalog schema must be ${catalogSchema}`)
  if (!Array.isArray(catalog.contracts) || catalog.contracts.length === 0) fail('catalog.contracts required')
  for (const contract of catalog.contracts)
  {
    if (!behaviorIdPattern.test(contract.id)) fail(`invalid behavior id ${contract.id}`)
    if (!['active', 'migration-only', 'retired'].includes(contract.status))
    {
      fail(`${contract.id} has invalid status`)
    }
    if (!['required', 'not-public', 'rationale-only'].includes(contract.documentationPolicy))
    {
      fail(`${contract.id} has invalid documentationPolicy`)
    }
    if (!Array.isArray(contract.requiredTestKinds)) fail(`${contract.id} requiredTestKinds required`)
    if (typeof contract.factExtractorId !== 'string') fail(`${contract.id} factExtractorId required`)
    if (contract.documentationPolicy === 'not-public'
      && (typeof contract.documentationRationale !== 'string' || contract.documentationRationale.length === 0))
    {
      fail(`${contract.id} not-public requires documentationRationale`)
    }
    if (contract.mutationPolicy != null)
    {
      const mp = contract.mutationPolicy
      if (typeof mp.mutationRequired !== 'boolean') fail(`${contract.id} mutationPolicy.mutationRequired must be boolean`)
      if (mp.mutationRequired)
      {
        if (!Number.isFinite(mp.minimumMutationScore)) fail(`${contract.id} mutationPolicy.minimumMutationScore required`)
        if (typeof mp.requireExecutedMutants !== 'boolean') fail(`${contract.id} mutationPolicy.requireExecutedMutants required`)
        if (!['none', 'documented'].includes(mp.allowedEquivalentMutantPolicy))
        {
          fail(`${contract.id} mutationPolicy.allowedEquivalentMutantPolicy must be none or documented`)
        }
      }
    }
  }
  return digestValue(catalog)
}

function validateOwnerReceipt (receipt)
{
  if (!isPlainObject(receipt)) fail('owner receipt must be an object')
  if (receipt.schema !== ownerReceiptSchema) fail(`owner receipt schema must be ${ownerReceiptSchema}`)
  assertNoForbiddenKeys(receipt, 'ownerReceipt')
  requireDigestMatch(receipt, 'owner receipt')
  if (!digestPattern.test(receipt.catalogDigest)) fail('owner receipt catalogDigest invalid')
  if (!Array.isArray(receipt.bindings) || !Array.isArray(receipt.errors)) fail('owner receipt incomplete')
  return receipt
}

function validateTestEvidenceReceipt (receipt)
{
  if (!isPlainObject(receipt)) fail('test evidence receipt must be an object')
  if (receipt.schema !== testEvidenceSchema) fail(`test evidence schema must be ${testEvidenceSchema}`)
  assertNoForbiddenKeys(receipt, 'testEvidence')
  if (typeof receipt.contentDigest !== 'string') fail('test evidence missing contentDigest')
  const expected = digestValue(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
  if (receipt.contentDigest !== expected && receipt.contentDigest !== `sha256:${expected}`)
  {
    fail('test evidence contentDigest mismatch')
  }
  if (!digestPattern.test(receipt.catalogDigest) && !prefixedDigestPattern.test(receipt.catalogDigest))
  {
    // catalogDigest in test evidence is bare hex per schema
    if (!digestPattern.test(String(receipt.catalogDigest))) fail('test evidence catalogDigest invalid')
  }
  if (!isPlainObject(receipt.run) || !isPlainObject(receipt.sourceState)) fail('test evidence run/sourceState required')
  if (!Array.isArray(receipt.evidence) || !Array.isArray(receipt.coverage) || !Array.isArray(receipt.errors))
  {
    fail('test evidence incomplete')
  }
  return receipt
}

function validateFactObservation (receipt)
{
  if (!isPlainObject(receipt)) fail('fact observation must be an object')
  if (receipt.schema !== factObservationSchema) fail(`fact observation schema must be ${factObservationSchema}`)
  assertNoForbiddenKeys(receipt, 'factObservation')
  requireDigestMatch(receipt, `fact observation ${receipt.extractorId ?? '<unknown>'}`)
  if (!commitPattern.test(receipt.sourceCommit)) fail(`${receipt.extractorId} sourceCommit invalid`)
  if (!normalizeFingerprint(receipt.worktreeFingerprint)) fail(`${receipt.extractorId} worktreeFingerprint invalid`)
  if (!Array.isArray(receipt.behaviorIds) || receipt.behaviorIds.length === 0)
  {
    fail(`${receipt.extractorId} behaviorIds required`)
  }
  if (receipt.status !== 'ok' && receipt.status !== 'failed') fail(`${receipt.extractorId} status invalid`)
  return receipt
}

function validateParseReceipt (receipt)
{
  if (!isPlainObject(receipt)) fail('doc-claim parse receipt must be an object')
  if (receipt.schema !== docClaimParseSchema) fail(`doc-claim parse schema must be ${docClaimParseSchema}`)
  assertNoForbiddenKeys(receipt, 'docClaimParse')
  requireDigestMatch(receipt, 'doc-claim parse receipt')
  if (!digestPattern.test(receipt.behaviorCatalogDigest)) fail('doc-claim parse behaviorCatalogDigest invalid')
  if (!Array.isArray(receipt.claims)) fail('doc-claim parse claims required')
  return receipt
}

function validateVerificationReceipt (receipt)
{
  if (!isPlainObject(receipt)) fail('doc-claim verification receipt must be an object')
  if (receipt.schema !== docClaimVerificationSchema)
  {
    fail(`doc-claim verification schema must be ${docClaimVerificationSchema}`)
  }
  assertNoForbiddenKeys(receipt, 'docClaimVerification')
  requireDigestMatch(receipt, 'doc-claim verification receipt')
  if (!commitPattern.test(receipt.sourceCommit)) fail('verification sourceCommit invalid')
  if (!normalizeFingerprint(receipt.worktreeFingerprint)) fail('verification worktreeFingerprint invalid')
  if (!digestPattern.test(receipt.catalogDigest)) fail('verification catalogDigest invalid')
  if (!Array.isArray(receipt.results) || !Array.isArray(receipt.failureReasons))
  {
    fail('verification receipt incomplete')
  }
  if (receipt.status !== 'ok' && receipt.status !== 'failed') fail('verification status invalid')
  return receipt
}

function validateGeneratedSectionReceipt (receipt)
{
  if (!isPlainObject(receipt)) fail('generated-section check receipt must be an object')
  if (receipt.schema !== generatedSectionCheckSchema)
  {
    fail(`generated-section schema must be ${generatedSectionCheckSchema}`)
  }
  assertNoForbiddenKeys(receipt, 'generatedSectionCheck')
  requireDigestMatch(receipt, 'generated-section check receipt')
  if (!commitPattern.test(receipt.sourceCommit)) fail('generated-section sourceCommit invalid')
  if (!normalizeFingerprint(receipt.worktreeFingerprint)) fail('generated-section worktreeFingerprint invalid')
  if (!digestPattern.test(receipt.catalogDigest)) fail('generated-section catalogDigest invalid')
  if (!Array.isArray(receipt.sections) || !Array.isArray(receipt.failureReasons))
  {
    fail('generated-section receipt incomplete')
  }
  if (receipt.status !== 'ok' && receipt.status !== 'failed') fail('generated-section status invalid')
  return receipt
}

function pushLocator (list, kind, behaviorId, anchor, reason)
{
  list.push({
    kind,
    behaviorId: behaviorId ?? null,
    anchor,
    reason
  })
}

function sortLocators (list)
{
  return [...list].sort((left, right) =>
  {
    const byKind = left.kind.localeCompare(right.kind)
    if (byKind !== 0) return byKind
    const byBehavior = String(left.behaviorId ?? '').localeCompare(String(right.behaviorId ?? ''))
    if (byBehavior !== 0) return byBehavior
    const byAnchor = left.anchor.localeCompare(right.anchor)
    if (byAnchor !== 0) return byAnchor
    return left.reason.localeCompare(right.reason)
  })
}

function resolveFactPath (observations, factPath)
{
  if (!isPlainObject(observations) || typeof factPath !== 'string' || factPath.length === 0) return undefined
  if (Object.hasOwn(observations, factPath)) return observations[factPath]
  const parts = factPath.split('.')
  let current = observations
  for (const part of parts)
  {
    if (!isPlainObject(current) || !Object.hasOwn(current, part)) return undefined
    current = current[part]
  }
  return current
}

function ownerSatisfiesCardinality (contract, owners, missing, conflicts, failureReasons)
{
  const behaviorId = contract.id
  if (contract.implementationOwnerCardinality === 'one')
  {
    if (owners.length === 0)
    {
      const reason = `${behaviorId} missing implementation owner`
      pushLocator(missing, 'missing-owner', behaviorId, `owner:${behaviorId}`, reason)
      failureReasons.push(reason)
      return false
    }
    if (owners.length > 1)
    {
      const reason = `${behaviorId} duplicate implementation owners: ${owners.map((owner) => `${owner.sourcePath}#${owner.symbol}`).join(', ')}`
      pushLocator(conflicts, 'duplicate-owner', behaviorId, `owner:${behaviorId}`, reason)
      failureReasons.push(reason)
      return false
    }
    if (owners[0].status === 'error')
    {
      const reason = `${behaviorId} implementation owner binding status=error`
      pushLocator(conflicts, 'duplicate-owner', behaviorId, `${owners[0].sourcePath}#${owners[0].symbol}`, reason)
      failureReasons.push(reason)
      return false
    }
    return true
  }

  // many-owner
  const allowed = new Set(contract.allowedImplementationOwnerRoles ?? [])
  const roles = owners.map((owner) => owner.role).filter(Boolean)
  let ok = true
  if (owners.length !== allowed.size)
  {
    const reason = `${behaviorId} many-owner cardinality expected ${allowed.size}, found ${owners.length}`
    pushLocator(missing, 'missing-owner', behaviorId, `owner:${behaviorId}`, reason)
    failureReasons.push(reason)
    ok = false
  }
  for (const role of allowed)
  {
    if (!roles.includes(role))
    {
      const reason = `${behaviorId} missing owner role ${role}`
      pushLocator(missing, 'missing-owner', behaviorId, `owner-role:${role}`, reason)
      failureReasons.push(reason)
      ok = false
    }
  }
  const seen = new Set()
  for (const role of roles)
  {
    if (seen.has(role))
    {
      const reason = `${behaviorId} duplicate owner role ${role}`
      pushLocator(conflicts, 'duplicate-owner', behaviorId, `owner-role:${role}`, reason)
      failureReasons.push(reason)
      ok = false
    }
    seen.add(role)
  }
  return ok
}

function testKindQualifies (row)
{
  if (!row) return { ok: false, reason: 'missing evidence row' }
  if (row.discovered !== true) return { ok: false, reason: 'not discovered' }
  if (row.executed !== true) return { ok: false, reason: 'not executed this round' }
  if (row.outcome !== 'passed') return { ok: false, reason: `outcome=${row.outcome}` }
  if (row.run?.attemptKind === 'diagnostic')
  {
    return { ok: false, reason: 'diagnostic attempt cannot qualify' }
  }
  if (row.outcome === 'skipped' || row.outcome === 'blocked')
  {
    return { ok: false, reason: `non-qualifying outcome=${row.outcome}` }
  }
  return { ok: true, reason: 'passed' }
}

/**
 * Join public receipts into a BehaviorGraphReceipt.
 *
 * @param {object} options
 * @param {object|string} options.catalog
 * @param {object|string} options.ownerReceipt
 * @param {Array<object|string>} options.factObservationReceipts
 * @param {object|string} options.testEvidenceReceipt
 * @param {object|string} options.docClaimParseReceipt
 * @param {object|string} options.docClaimVerificationReceipt
 * @param {object|string} options.generatedSectionCheckReceipt
 * @param {Array<{kind:string,digest:string}>} [options.rendererDigests]
 */
export function joinBehaviorGraph (options = {})
{
  const catalog = loadJsonInput(options.catalog, 'catalog')
  const catalogDigest = validateCatalog(catalog)

  const ownerReceipt = validateOwnerReceipt(loadJsonInput(options.ownerReceipt, 'ownerReceipt'))
  const testEvidence = validateTestEvidenceReceipt(loadJsonInput(options.testEvidenceReceipt, 'testEvidenceReceipt'))
  const parseReceipt = validateParseReceipt(loadJsonInput(options.docClaimParseReceipt, 'docClaimParseReceipt'))
  const verificationReceipt = validateVerificationReceipt(
    loadJsonInput(options.docClaimVerificationReceipt, 'docClaimVerificationReceipt')
  )
  const generatedReceipt = validateGeneratedSectionReceipt(
    loadJsonInput(options.generatedSectionCheckReceipt, 'generatedSectionCheckReceipt')
  )

  // Mutation evidence is optional; when present it must be valid and identity-consistent.
  let mutationReceipt = null
  if (options.mutationEvidenceReceipt != null)
  {
    mutationReceipt = validateMutationEvidenceReceipt(
      loadJsonInput(options.mutationEvidenceReceipt, 'mutationEvidenceReceipt')
    )
  }

  const factInputs = options.factObservationReceipts
  if (!Array.isArray(factInputs) || factInputs.length === 0)
  {
    fail('factObservationReceipts must be a non-empty list')
  }
  const factReceipts = factInputs.map((entry, index) =>
    validateFactObservation(loadJsonInput(entry, `factObservationReceipts[${index}]`)))

  const missing = []
  const orphans = []
  const conflicts = []
  const failureReasons = []

  // --- Identity exact match -------------------------------------------------
  const sourceCommit = testEvidence.sourceState?.commit
  const worktreeFingerprint = normalizeFingerprint(testEvidence.sourceState?.worktreeFingerprint)
  if (!commitPattern.test(sourceCommit) || !worktreeFingerprint)
  {
    fail('test evidence source identity is invalid')
  }

  // Prefer primary run identity; diagnostic-only runs cannot qualify.
  const runIdentity = {
    id: testEvidence.run.id,
    attemptKind: testEvidence.run.attemptKind,
    evidenceClass: testEvidence.run.evidenceClass
  }
  if (runIdentity.attemptKind === 'diagnostic')
  {
    const reason = 'test evidence run attemptKind=diagnostic cannot qualify BehaviorGraph'
    pushLocator(conflicts, 'non-qualifying-test', null, `run:${runIdentity.id}`, reason)
    failureReasons.push(reason)
  }

  // Catalog digests must agree.
  const catalogBindings = [
    ['ownerReceipt', ownerReceipt.catalogDigest],
    ['testEvidenceReceipt', testEvidence.catalogDigest],
    ['docClaimParseReceipt', parseReceipt.behaviorCatalogDigest],
    ['docClaimVerificationReceipt', verificationReceipt.catalogDigest],
    ['generatedSectionCheckReceipt', generatedReceipt.catalogDigest]
  ]
  for (const [label, digest] of catalogBindings)
  {
    if (normalizeDigest(digest) !== catalogDigest)
    {
      const reason = `${label} catalogDigest does not match catalog (identity exact match)`
      pushLocator(conflicts, 'identity-mismatch', null, label, reason)
      failureReasons.push(reason)
    }
  }

  // Source identities must agree.
  const identityChecks = [
    ['verification', verificationReceipt.sourceCommit, verificationReceipt.worktreeFingerprint],
    ['generated-section', generatedReceipt.sourceCommit, generatedReceipt.worktreeFingerprint],
    ...factReceipts.map((receipt) => [
      `fact:${receipt.extractorId}`,
      receipt.sourceCommit,
      receipt.worktreeFingerprint
    ])
  ]
  for (const [label, commit, fingerprint] of identityChecks)
  {
    if (commit !== sourceCommit || normalizeFingerprint(fingerprint) !== worktreeFingerprint)
    {
      const reason = `${label} source identity does not match this-round source (old run/build/worktree refused)`
      pushLocator(conflicts, 'identity-mismatch', null, label, reason)
      failureReasons.push(reason)
    }
  }

  // Mutation evidence identity must match this-round source.
  if (mutationReceipt != null)
  {
    if (mutationReceipt.sourceCommit !== sourceCommit
      || normalizeFingerprint(mutationReceipt.worktreeFingerprint) !== worktreeFingerprint)
    {
      const reason = 'mutation evidence source identity does not match this-round source (old run refused)'
      pushLocator(conflicts, 'identity-mismatch', null, 'mutationEvidenceReceipt', reason)
      failureReasons.push(reason)
    }
    if (normalizeDigest(mutationReceipt.catalogDigest) !== catalogDigest)
    {
      const reason = 'mutationEvidenceReceipt catalogDigest does not match catalog (identity exact match)'
      pushLocator(conflicts, 'identity-mismatch', null, 'mutationEvidenceReceipt', reason)
      failureReasons.push(reason)
    }
    if (normalizeDigest(mutationReceipt.ownerReceiptDigest) !== normalizeDigest(ownerReceipt.contentDigest))
    {
      const reason = 'mutation evidence ownerReceiptDigest does not match owner receipt'
      pushLocator(conflicts, 'identity-mismatch', null, 'mutationEvidenceReceipt', reason)
      failureReasons.push(reason)
    }
    if (mutationReceipt.status === 'failed')
    {
      const reason = `mutation evidence failed closed: ${mutationReceipt.failureReasons.join('; ') || 'failed'}`
      pushLocator(missing, 'input-failed', null, 'mutationEvidenceReceipt', reason)
      failureReasons.push(reason)
    }
  }

  // Build identity: if any fact observation declares a build, all ok facts for active behaviors must match.
  let buildIdentity = null
  for (const receipt of factReceipts)
  {
    if (receipt.buildIdentity != null)
    {
      if (buildIdentity == null)
      {
        buildIdentity = { ...receipt.buildIdentity }
      }
      else if (
        buildIdentity.artifactId !== receipt.buildIdentity.artifactId
        || buildIdentity.receiptDigest !== receipt.buildIdentity.receiptDigest
        || buildIdentity.artifactDigest !== receipt.buildIdentity.artifactDigest
      )
      {
        const reason = `fact:${receipt.extractorId} buildIdentity conflicts with other observations`
        pushLocator(conflicts, 'identity-mismatch', null, `build:${receipt.extractorId}`, reason)
        failureReasons.push(reason)
      }
    }
  }
  // Observations that omit build while others declare one are refused (old build / mixed identity).
  if (buildIdentity != null)
  {
    for (const receipt of factReceipts)
    {
      if (receipt.buildIdentity == null)
      {
        const reason = `fact:${receipt.extractorId} missing buildIdentity while join requires build identity`
        pushLocator(conflicts, 'identity-mismatch', null, `build:${receipt.extractorId}`, reason)
        failureReasons.push(reason)
      }
    }
  }

  // Producer failures fail closed — never fall back to older receipts.
  if (ownerReceipt.status === 'failed' || ownerReceipt.errors.length > 0)
  {
    const reason = `owner receipt failed closed (${ownerReceipt.errors.length} error(s))`
    pushLocator(missing, 'input-failed', null, 'ownerReceipt', reason)
    failureReasons.push(reason)
  }
  if (testEvidence.errors.length > 0)
  {
    const reason = `test evidence receipt failed closed (${testEvidence.errors.length} error(s))`
    pushLocator(missing, 'input-failed', null, 'testEvidenceReceipt', reason)
    failureReasons.push(reason)
  }
  if (verificationReceipt.status === 'failed')
  {
    const reason = `doc-claim verification failed closed: ${verificationReceipt.failureReasons.join('; ') || 'failed'}`
    pushLocator(missing, 'input-failed', null, 'docClaimVerificationReceipt', reason)
    failureReasons.push(reason)
  }
  if (generatedReceipt.status === 'failed')
  {
    const reason = `generated-section check failed closed: ${generatedReceipt.failureReasons.join('; ') || 'failed'}`
    pushLocator(missing, 'input-failed', null, 'generatedSectionCheckReceipt', reason)
    failureReasons.push(reason)
  }
  for (const receipt of factReceipts)
  {
    if (receipt.status === 'failed')
    {
      const reason = `fact observation ${receipt.extractorId} status=failed; join refuses historical fallback`
      pushLocator(missing, 'failed-fact', receipt.behaviorIds[0] ?? null, `fact:${receipt.extractorId}`, reason)
      failureReasons.push(reason)
    }
  }

  // Parse receipt claims identity vs verification results.
  if (verificationReceipt.parseReceiptDigest !== parseReceipt.contentDigest
    && verificationReceipt.parseReceiptDigest !== normalizeDigest(parseReceipt.contentDigest))
  {
    const reason = 'doc-claim verification parseReceiptDigest does not match parse receipt contentDigest'
    pushLocator(conflicts, 'identity-mismatch', null, 'docClaimParseReceipt', reason)
    failureReasons.push(reason)
  }

  // --- Index inputs by behavior --------------------------------------------
  const contractsById = new Map(catalog.contracts.map((contract) => [contract.id, contract]))
  const ownersByBehavior = new Map()
  for (const binding of ownerReceipt.bindings)
  {
    if (!ownersByBehavior.has(binding.behaviorId)) ownersByBehavior.set(binding.behaviorId, [])
    ownersByBehavior.get(binding.behaviorId).push(binding)
  }

  const factsByBehavior = new Map()
  const factsByExtractor = new Map()
  for (const receipt of factReceipts)
  {
    if (factsByExtractor.has(receipt.extractorId))
    {
      const reason = `duplicate fact observation for extractor ${receipt.extractorId}`
      pushLocator(conflicts, 'duplicate-fact', receipt.behaviorIds[0] ?? null, `fact:${receipt.extractorId}`, reason)
      failureReasons.push(reason)
    }
    factsByExtractor.set(receipt.extractorId, receipt)
    for (const behaviorId of receipt.behaviorIds)
    {
      if (!factsByBehavior.has(behaviorId)) factsByBehavior.set(behaviorId, [])
      factsByBehavior.get(behaviorId).push(receipt)
    }
  }

  const evidenceByBehavior = new Map()
  for (const row of testEvidence.evidence)
  {
    if (!evidenceByBehavior.has(row.behaviorId)) evidenceByBehavior.set(row.behaviorId, [])
    evidenceByBehavior.get(row.behaviorId).push(row)
  }

  const claimsByBehavior = new Map()
  for (const claim of parseReceipt.claims)
  {
    const behaviorId = claim.declaration?.behaviorId
    if (!behaviorId) continue
    if (!claimsByBehavior.has(behaviorId)) claimsByBehavior.set(behaviorId, [])
    claimsByBehavior.get(behaviorId).push(claim)
  }

  const verificationByClaim = new Map()
  for (const result of verificationReceipt.results)
  {
    const key = `${result.claimId}\0${result.documentPath}`
    if (verificationByClaim.has(key))
    {
      const reason = `duplicate verification result for claim ${result.claimId} @ ${result.documentPath}`
      pushLocator(conflicts, 'doc-conflict', result.behaviorId, key, reason)
      failureReasons.push(reason)
    }
    verificationByClaim.set(key, result)
  }

  const generatedByBehavior = new Map()
  for (const section of generatedReceipt.sections)
  {
    if (!generatedByBehavior.has(section.behaviorId)) generatedByBehavior.set(section.behaviorId, [])
    generatedByBehavior.get(section.behaviorId).push(section)
  }

  // --- Build edges and per-behavior qualification --------------------------
  const implementationEdges = []
  const factEdges = []
  const testEdges = []
  const documentClaimEdges = []
  const mutationEdges = []
  const behaviorNodes = []

  const contracts = [...catalog.contracts].sort((left, right) => left.id.localeCompare(right.id))

  for (const contract of contracts)
  {
    const behaviorId = contract.id
    const nodeFailures = []
    let ownerStatus = 'not-applicable'
    let factStatus = 'not-applicable'
    let testStatus = 'not-applicable'
    let docStatus = 'not-applicable'
    let qualification = 'excluded'

    if (contract.status !== 'active')
    {
      // retired/migration cannot mix into active qualification.
      const strayOwners = ownersByBehavior.get(behaviorId) ?? []
      for (const owner of strayOwners)
      {
        const reason = `${behaviorId} is ${contract.status} but still has implementation owner ${owner.sourcePath}#${owner.symbol}`
        pushLocator(orphans, 'orphan-claim', behaviorId, `${owner.sourcePath}#${owner.symbol}`, reason)
        nodeFailures.push(reason)
      }
      const currentClaims = (claimsByBehavior.get(behaviorId) ?? [])
        .filter((claim) => claim.location?.documentStatus === 'current')
      for (const claim of currentClaims)
      {
        const reason = `${behaviorId} is ${contract.status} but current docs still claim ${claim.declaration.claimId}`
        pushLocator(conflicts, 'retired-claim', behaviorId, `${claim.location.documentPath}#${claim.declaration.claimId}`, reason)
        nodeFailures.push(reason)
        failureReasons.push(reason)
      }
      for (const result of verificationReceipt.results.filter((entry) => entry.behaviorId === behaviorId && entry.documentStatus === 'current' && entry.status === 'verified'))
      {
        const reason = `${behaviorId} is ${contract.status} but has verified current claim ${result.claimId}`
        pushLocator(conflicts, 'retired-claim', behaviorId, `${result.documentPath}#${result.claimId}`, reason)
        nodeFailures.push(reason)
        failureReasons.push(reason)
      }

      behaviorNodes.push({
        behaviorId,
        status: contract.status,
        documentationPolicy: contract.documentationPolicy,
        ownerStatus: 'not-applicable',
        factStatus: 'not-applicable',
        testStatus: 'not-applicable',
        docStatus: nodeFailures.length === 0 ? 'ok' : 'failed',
        qualification: nodeFailures.length === 0 ? 'excluded' : 'failed',
        failureReasons: [...new Set(nodeFailures)].sort()
      })
      continue
    }

    qualification = 'qualified'

    // Owner
    const owners = ownersByBehavior.get(behaviorId) ?? []
    ownerStatus = ownerSatisfiesCardinality(contract, owners, missing, conflicts, nodeFailures) ? 'ok' : 'failed'
    for (const owner of owners)
    {
      implementationEdges.push({
        behaviorId,
        sourcePath: owner.sourcePath,
        symbol: owner.symbol,
        role: owner.role ?? null,
        status: ownerStatus === 'ok' && owner.status !== 'error' ? 'ok' : 'failed',
        reason: ownerStatus === 'ok' ? 'owner bound' : 'owner cardinality or status failed'
      })
    }
    if (owners.length === 0 && ownerStatus === 'failed')
    {
      implementationEdges.push({
        behaviorId,
        sourcePath: '',
        symbol: '',
        role: null,
        status: 'failed',
        reason: 'missing implementation owner'
      })
    }

    // Fact: exactly one observation for the declared extractor covering this behavior.
    const expectedExtractor = contract.factExtractorId
    const facts = factsByBehavior.get(behaviorId) ?? []
    const matching = facts.filter((receipt) => receipt.extractorId === expectedExtractor)
    if (matching.length === 0)
    {
      factStatus = 'failed'
      const reason = `${behaviorId} missing fact observation from extractor ${expectedExtractor}`
      pushLocator(missing, 'missing-fact', behaviorId, `fact:${expectedExtractor}`, reason)
      nodeFailures.push(reason)
      factEdges.push({
        behaviorId,
        extractorId: expectedExtractor,
        contentDigest: '',
        status: 'failed',
        reason: 'missing observation'
      })
    }
    else if (matching.length > 1)
    {
      factStatus = 'failed'
      const reason = `${behaviorId} has ${matching.length} observations from extractor ${expectedExtractor}`
      pushLocator(conflicts, 'duplicate-fact', behaviorId, `fact:${expectedExtractor}`, reason)
      nodeFailures.push(reason)
      for (const receipt of matching)
      {
        factEdges.push({
          behaviorId,
          extractorId: receipt.extractorId,
          contentDigest: receipt.contentDigest,
          status: 'failed',
          reason: 'duplicate observation'
        })
      }
    }
    else
    {
      const receipt = matching[0]
      if (receipt.status !== 'ok')
      {
        factStatus = 'failed'
        const reason = `${behaviorId} fact observation status=${receipt.status}`
        pushLocator(missing, 'failed-fact', behaviorId, `fact:${receipt.extractorId}`, reason)
        nodeFailures.push(reason)
        factEdges.push({
          behaviorId,
          extractorId: receipt.extractorId,
          contentDigest: receipt.contentDigest,
          status: 'failed',
          reason: `status=${receipt.status}`
        })
      }
      else
      {
        factStatus = 'ok'
        factEdges.push({
          behaviorId,
          extractorId: receipt.extractorId,
          contentDigest: receipt.contentDigest,
          status: 'ok',
          reason: 'single current observation'
        })
      }
    }
    // Extra extractors covering this active behavior are conflicts (not exactly one authority).
    for (const receipt of facts.filter((entry) => entry.extractorId !== expectedExtractor))
    {
      const reason = `${behaviorId} has unexpected fact observation from ${receipt.extractorId}`
      pushLocator(orphans, 'orphan-observation', behaviorId, `fact:${receipt.extractorId}`, reason)
      nodeFailures.push(reason)
      factEdges.push({
        behaviorId,
        extractorId: receipt.extractorId,
        contentDigest: receipt.contentDigest,
        status: 'failed',
        reason: 'unexpected extractor for behavior'
      })
      factStatus = 'failed'
    }

    // Tests: required kinds fully covered by this-round executed/passed evidence.
    const evidenceRows = evidenceByBehavior.get(behaviorId) ?? []
    const satisfiedKinds = new Set()
    for (const kind of contract.requiredTestKinds)
    {
      const rows = evidenceRows.filter((row) => row.testKind === kind)
      const qualifying = rows.filter((row) => testKindQualifies(row).ok)
      if (qualifying.length === 0)
      {
        testStatus = 'failed'
        const sample = rows[0]
        const detail = sample ? testKindQualifies(sample).reason : 'no evidence row'
        const reason = `${behaviorId} missing this-round passed evidence for kind ${kind} (${detail})`
        pushLocator(missing, 'missing-test-kind', behaviorId, `test:${behaviorId}/${kind}`, reason)
        nodeFailures.push(reason)
        testEdges.push({
          behaviorId,
          testKind: kind,
          canonicalTestId: sample?.canonicalTestId ?? '',
          outcome: sample?.outcome ?? 'missing',
          status: 'failed',
          reason: detail
        })
      }
      else
      {
        satisfiedKinds.add(kind)
        for (const row of qualifying)
        {
          testEdges.push({
            behaviorId,
            testKind: kind,
            canonicalTestId: row.canonicalTestId,
            outcome: row.outcome,
            status: 'ok',
            reason: 'executed passed'
          })
        }
      }
      // Explicit non-qualifying rows surface as anchors.
      for (const row of rows)
      {
        const check = testKindQualifies(row)
        if (!check.ok && (row.outcome === 'skipped' || row.outcome === 'blocked' || row.run?.attemptKind === 'diagnostic'))
        {
          pushLocator(conflicts, 'non-qualifying-test', behaviorId, row.canonicalTestId, `${row.canonicalTestId} ${check.reason}`)
          testEdges.push({
            behaviorId,
            testKind: kind,
            canonicalTestId: row.canonicalTestId,
            outcome: row.outcome,
            status: 'failed',
            reason: check.reason
          })
        }
      }
    }
    if (testStatus !== 'failed' && satisfiedKinds.size === contract.requiredTestKinds.length)
    {
      testStatus = 'ok'
    }
    else if (testStatus !== 'failed')
    {
      testStatus = 'failed'
    }

    // Documentation policy
    const parseClaims = claimsByBehavior.get(behaviorId) ?? []
    const currentParseClaims = parseClaims.filter((claim) => claim.location?.documentStatus === 'current')
    const verificationResults = verificationReceipt.results.filter((entry) => entry.behaviorId === behaviorId)
    const currentVerified = verificationResults.filter((entry) =>
      entry.documentStatus === 'current' && entry.status === 'verified')
    const currentFailed = verificationResults.filter((entry) =>
      entry.documentStatus === 'current' && entry.status === 'failed')
    const generatedSections = generatedByBehavior.get(behaviorId) ?? []
    const generatedOk = generatedSections.filter((section) => section.status === 'ok')
    const generatedFailed = generatedSections.filter((section) => section.status === 'failed')

    for (const result of verificationResults)
    {
      documentClaimEdges.push({
        behaviorId,
        claimId: result.claimId,
        documentPath: result.documentPath,
        claimType: result.claimType,
        factPath: result.factPath,
        status: result.status === 'verified' || result.status === 'not-applicable' ? 'ok' : 'failed',
        reason: result.reason
      })
    }
    for (const section of generatedSections)
    {
      documentClaimEdges.push({
        behaviorId,
        claimId: `generated:${section.sectionId}`,
        documentPath: section.documentPath,
        claimType: 'generated-section',
        factPath: section.factPath,
        status: section.status === 'ok' ? 'ok' : 'failed',
        reason: section.reason
      })
    }

    // Verification failures for this behavior are independent failures.
    for (const result of currentFailed)
    {
      const reason = `${behaviorId} doc claim ${result.claimId} verification failed: ${result.reason}`
      pushLocator(conflicts, 'doc-conflict', behaviorId, `${result.documentPath}#${result.claimId}`, reason)
      nodeFailures.push(reason)
      docStatus = 'failed'
    }
    for (const section of generatedFailed)
    {
      const reason = `${behaviorId} generated section ${section.sectionId} failed: ${section.reason}`
      pushLocator(conflicts, 'doc-conflict', behaviorId, `${section.documentPath}#${section.sectionId}`, reason)
      nodeFailures.push(reason)
      docStatus = 'failed'
    }

    // Fact path existence for claims that reference facts.
    const primaryFact = matching.length === 1 && matching[0].status === 'ok' ? matching[0] : null
    for (const claim of currentParseClaims)
    {
      const factPath = claim.declaration?.factPath
      if (!factPath) continue
      if (!primaryFact || resolveFactPath(primaryFact.observations, factPath) === undefined)
      {
        const reason = `${behaviorId} claim ${claim.declaration.claimId} references missing factPath ${factPath}`
        pushLocator(missing, 'missing-fact', behaviorId, `${claim.location.documentPath}#${claim.declaration.claimId}`, reason)
        nodeFailures.push(reason)
        docStatus = 'failed'
      }
    }

    // Conflicting verified claim values: two verified results with same factPath but different reasons of conflict.
    const verifiedByFactPath = new Map()
    for (const result of currentVerified)
    {
      if (!result.factPath) continue
      if (!verifiedByFactPath.has(result.factPath)) verifiedByFactPath.set(result.factPath, [])
      verifiedByFactPath.get(result.factPath).push(result)
    }
    // Also detect conflicts encoded in verification failureReasons for this behavior.
    for (const reason of verificationReceipt.failureReasons)
    {
      if (reason.includes(behaviorId) && /conflict/iu.test(reason))
      {
        pushLocator(conflicts, 'doc-conflict', behaviorId, `verification:${behaviorId}`, reason)
        nodeFailures.push(reason)
        docStatus = 'failed'
      }
    }

    if (contract.documentationPolicy === 'required')
    {
      const hasVerifiedClaim = currentVerified.length > 0 || generatedOk.length > 0
      if (!hasVerifiedClaim)
      {
        const reason = `${behaviorId} documentationPolicy=required but no current verified claim or generated section`
        pushLocator(missing, 'missing-doc', behaviorId, `doc:${behaviorId}`, reason)
        nodeFailures.push(reason)
        docStatus = 'failed'
      }
      else if (docStatus !== 'failed')
      {
        docStatus = 'ok'
      }
    }
    else if (contract.documentationPolicy === 'not-public')
    {
      if (typeof contract.documentationRationale !== 'string' || contract.documentationRationale.length === 0)
      {
        const reason = `${behaviorId} not-public missing catalog documentationRationale`
        pushLocator(missing, 'missing-doc', behaviorId, `doc:${behaviorId}`, reason)
        nodeFailures.push(reason)
        docStatus = 'failed'
      }
      const publicClaims = currentVerified.filter((entry) => entry.claimType !== 'rationale')
      const publicGenerated = generatedOk
      if (publicClaims.length > 0 || publicGenerated.length > 0)
      {
        const reason = `${behaviorId} not-public but current docs expose public claims/sections`
        pushLocator(conflicts, 'not-public-has-claim', behaviorId, `doc:${behaviorId}`, reason)
        nodeFailures.push(reason)
        docStatus = 'failed'
      }
      else if (docStatus !== 'failed')
      {
        docStatus = 'ok'
      }
    }
    else if (contract.documentationPolicy === 'rationale-only')
    {
      const nonRationale = currentVerified.filter((entry) =>
        entry.claimType !== 'rationale' && entry.claimType !== 'generated-section' && entry.status === 'verified')
      // rationale-only may still use generated sections for exact facts under controlled markers;
      // free-prose non-rationale verified claims fail.
      // If verification marked them verified as non-rationale, fail.
      const freeProseExact = currentVerified.filter((entry) =>
        !['rationale', 'generated-section'].includes(entry.claimType))
      if (freeProseExact.length > 0 && nonRationale.length > 0)
      {
        // Allow generated-section type only; other verified executable prose fails under rationale-only
        // unless they are not present. Treat non-rationale verified prose as failure.
      }
      const disallowed = currentVerified.filter((entry) => entry.claimType !== 'rationale')
      // generated-section verification status is often not-applicable in prose verifier;
      // generated check receipt is the authority for those.
      if (disallowed.length > 0)
      {
        const reason = `${behaviorId} rationale-only has non-rationale verified claims: ${disallowed.map((entry) => entry.claimId).join(', ')}`
        pushLocator(conflicts, 'doc-conflict', behaviorId, `doc:${behaviorId}`, reason)
        nodeFailures.push(reason)
        docStatus = 'failed'
      }
      else if (docStatus !== 'failed')
      {
        docStatus = 'ok'
      }
    }

    // Mutation evidence: per-behavior qualification
    let mutationStatus = 'not-applicable'
    if (mutationReceipt != null)
    {
      const behaviorQualification = mutationReceipt.qualifications.find(
        (q) => q.behaviorId === behaviorId)
      if (behaviorQualification != null)
      {
        if (!behaviorQualification.qualified)
        {
          mutationStatus = 'failed'
          for (const failure of behaviorQualification.failures)
          {
            pushLocator(conflicts, 'mutation-failed', behaviorId, `mutation:${behaviorId}`, failure)
            nodeFailures.push(failure)
          }
        }
        else
        {
          mutationStatus = 'ok'
        }
        // Add mutation edges for this behavior's attributions
        const behaviorAttributions = mutationReceipt.attributions.filter(
          (a) => a.behaviorId === behaviorId)
        for (const attr of behaviorAttributions)
        {
          mutationEdges.push({
            behaviorId,
            mutantId: attr.mutantId,
            sourcePath: attr.sourcePath,
            symbol: attr.symbol,
            mutator: attr.mutator,
            status: attr.status === 'Killed' ? 'ok' : 'failed',
            reason: attr.status
          })
        }
      }
      else if (contract.mutationPolicy?.mutationRequired === true)
      {
        mutationStatus = 'failed'
        const reason = `${behaviorId} mutationRequired but no mutation evidence qualification`
        pushLocator(missing, 'missing-mutation', behaviorId, `mutation:${behaviorId}`, reason)
        nodeFailures.push(reason)
      }
    }
    else if (contract.mutationPolicy?.mutationRequired === true)
    {
      // No mutation receipt provided but behavior requires it
      mutationStatus = 'failed'
      const reason = `${behaviorId} mutationRequired but no mutation evidence receipt provided`
      pushLocator(missing, 'missing-mutation', behaviorId, `mutation:${behaviorId}`, reason)
      nodeFailures.push(reason)
    }

    if (ownerStatus === 'failed' || factStatus === 'failed' || testStatus === 'failed' || docStatus === 'failed' || mutationStatus === 'failed')
    {
      qualification = 'failed'
    }
    for (const reason of nodeFailures) failureReasons.push(reason)

    behaviorNodes.push({
      behaviorId,
      status: contract.status,
      documentationPolicy: contract.documentationPolicy,
      ownerStatus,
      factStatus,
      testStatus,
      docStatus: docStatus === 'not-applicable' ? 'failed' : docStatus,
      mutationStatus,
      qualification,
      failureReasons: [...new Set(nodeFailures)].sort((left, right) => left.localeCompare(right))
    })
  }

  // Orphan claims: parse claims for unknown behaviors or without verification results.
  for (const claim of parseReceipt.claims)
  {
    const behaviorId = claim.declaration?.behaviorId
    const claimId = claim.declaration?.claimId
    const documentPath = claim.location?.documentPath
    if (!contractsById.has(behaviorId))
    {
      const reason = `orphan claim ${claimId} references unknown behavior ${behaviorId}`
      pushLocator(orphans, 'orphan-claim', behaviorId, `${documentPath}#${claimId}`, reason)
      failureReasons.push(reason)
      continue
    }
    if (claim.location?.documentStatus === 'current')
    {
      const key = `${claimId}\0${documentPath}`
      if (!verificationByClaim.has(key) && claim.declaration?.claimType !== 'generated-section')
      {
        const reason = `current claim ${claimId} has no verification result`
        pushLocator(orphans, 'orphan-claim', behaviorId, `${documentPath}#${claimId}`, reason)
        failureReasons.push(reason)
      }
    }
  }

  // Orphan observations: extractors not required by any active contract (still allowed if listed)
  // Public facts on required behaviors without any doc edge.
  for (const contract of contracts.filter((entry) => entry.status === 'active' && entry.documentationPolicy === 'required'))
  {
    const facts = (factsByBehavior.get(contract.id) ?? []).filter((receipt) =>
      receipt.extractorId === contract.factExtractorId && receipt.status === 'ok')
    if (facts.length !== 1) continue
    const receipt = facts[0]
    const observationKeys = Object.keys(receipt.observations ?? {})
    const documentedPaths = new Set()
    for (const result of verificationReceipt.results.filter((entry) => entry.behaviorId === contract.id && entry.status === 'verified'))
    {
      if (result.factPath) documentedPaths.add(result.factPath.split('.')[0])
    }
    for (const section of (generatedByBehavior.get(contract.id) ?? []).filter((entry) => entry.status === 'ok'))
    {
      if (section.factPath) documentedPaths.add(section.factPath.split('.')[0])
    }
    // Only flag when behavior has zero doc edges at all (already covered) or observation keys completely undoc'd.
    if (documentedPaths.size === 0 && observationKeys.length > 0)
    {
      // missing-doc already recorded under required policy.
      continue
    }
    for (const key of observationKeys)
    {
      if (!documentedPaths.has(key) && documentedPaths.size > 0)
      {
        // Policy: public facts not described by any required doc fail.
        const reason = `${contract.id} public fact observation key ${key} is not described by any required doc claim/section`
        pushLocator(orphans, 'public-fact-undocumented', contract.id, `factPath:${key}`, reason)
        failureReasons.push(reason)
        const node = behaviorNodes.find((entry) => entry.behaviorId === contract.id)
        if (node)
        {
          node.docStatus = 'failed'
          node.qualification = 'failed'
          node.failureReasons = [...new Set([...node.failureReasons, reason])].sort()
        }
      }
    }
  }

  const uniqueFailures = [...new Set(failureReasons)].sort((left, right) => left.localeCompare(right))
  const status = uniqueFailures.length === 0 ? 'ok' : 'failed'

  const extractorDigests = factReceipts
    .map((receipt) => ({
      extractorId: receipt.extractorId,
      extractorDigest: receipt.extractorDigest,
      contentDigest: receipt.contentDigest
    }))
    .sort((left, right) => left.extractorId.localeCompare(right.extractorId))

  const rendererDigests = Array.isArray(options.rendererDigests)
    ? [...options.rendererDigests]
      .map((entry) => ({ kind: entry.kind, digest: entry.digest }))
      .sort((left, right) => left.kind.localeCompare(right.kind))
    : []

  const receipt = {
    schema: behaviorGraphSchema,
    runIdentity,
    sourceIdentity: {
      commit: sourceCommit,
      worktreeFingerprint
    },
    buildIdentity,
    catalogDigest,
    extractorDigests,
    rendererDigests,
    inputDigests: {
      ownerReceipt: normalizeDigest(ownerReceipt.contentDigest),
      testEvidenceReceipt: String(testEvidence.contentDigest),
      factObservationReceipts: factReceipts
        .map((entry) => ({ extractorId: entry.extractorId, contentDigest: entry.contentDigest }))
        .sort((left, right) => left.extractorId.localeCompare(right.extractorId)),
      docClaimParseReceipt: normalizeDigest(parseReceipt.contentDigest),
      docClaimVerificationReceipt: normalizeDigest(verificationReceipt.contentDigest),
      generatedSectionCheckReceipt: normalizeDigest(generatedReceipt.contentDigest),
      mutationEvidenceReceipt: mutationReceipt != null ? normalizeDigest(mutationReceipt.contentDigest) : null
    },
    behaviorNodes: behaviorNodes.sort((left, right) => left.behaviorId.localeCompare(right.behaviorId)),
    implementationEdges: implementationEdges.sort((left, right) =>
      `${left.behaviorId}\0${left.sourcePath}\0${left.symbol}`.localeCompare(`${right.behaviorId}\0${right.sourcePath}\0${right.symbol}`)),
    factEdges: factEdges.sort((left, right) =>
      `${left.behaviorId}\0${left.extractorId}`.localeCompare(`${right.behaviorId}\0${right.extractorId}`)),
    testEdges: testEdges.sort((left, right) =>
      `${left.behaviorId}\0${left.testKind}\0${left.canonicalTestId}`.localeCompare(`${right.behaviorId}\0${right.testKind}\0${right.canonicalTestId}`)),
    documentClaimEdges: documentClaimEdges.sort((left, right) =>
      `${left.behaviorId}\0${left.claimId}\0${left.documentPath}`.localeCompare(`${right.behaviorId}\0${right.claimId}\0${right.documentPath}`)),
    mutationEdges: mutationEdges.sort((left, right) =>
      `${left.behaviorId}\0${left.mutantId}`.localeCompare(`${right.behaviorId}\0${right.mutantId}`)),
    missing: sortLocators(missing),
    orphans: sortLocators(orphans),
    conflicts: sortLocators(conflicts),
    status,
    failureReasons: uniqueFailures,
    contentDigest: null
  }

  receipt.contentDigest = digestValue(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
  return receipt
}

export function validateBehaviorGraphReceipt (receipt)
{
  if (!isPlainObject(receipt)) fail('behavior graph receipt must be an object')
  if (receipt.schema !== behaviorGraphSchema) fail(`unexpected schema ${receipt.schema}`)
  assertNoForbiddenKeys(receipt, 'behaviorGraph')
  requireDigestMatch(receipt, 'behavior graph receipt')
  if (receipt.status !== 'ok' && receipt.status !== 'failed') fail('behavior graph status invalid')
  if (receipt.status === 'ok' && receipt.failureReasons.length !== 0)
  {
    fail('behavior graph status=ok cannot include failureReasons')
  }
  if (receipt.status === 'failed' && receipt.failureReasons.length === 0)
  {
    fail('behavior graph status=failed requires failureReasons')
  }
  return receipt
}

export function assertBehaviorGraphQualified (receipt)
{
  validateBehaviorGraphReceipt(receipt)
  if (receipt.status !== 'ok')
  {
    fail(`${receipt.failureReasons.length} failure(s)\n${receipt.failureReasons.map((reason) => `- ${reason}`).join('\n')}`)
  }
  for (const node of receipt.behaviorNodes)
  {
    if (node.status === 'active' && node.qualification !== 'qualified')
    {
      fail(`${node.behaviorId} not qualified: ${node.failureReasons.join('; ')}`)
    }
  }
  return receipt
}

/**
 * Governance: joiner source must not import producers, scanners, or parsers.
 * Inspects import lines and call sites only (ignores this helper and field denylist text).
 */
export function assertJoinerDoesNotImportProducers (sourceText, label = 'behavior-graph-join')
{
  const importLines = sourceText
    .split(/\r?\n/u)
    .filter((line) => /^\s*import\b/u.test(line))
    .join('\n')
  const forbiddenImports = [
    /behavior-owner-binding\.mjs/u,
    /behavior-test-binding\.mjs/u,
    /doc-claim\.mjs/u,
    /prose-claim-verifier\//u,
    /generated-fact-sections\/(?:generator|markers)\.mjs/u,
    /fact-extractors\/(?:seeds|runner|registry)\//u,
    /child_process/u
  ]
  for (const pattern of forbiddenImports)
  {
    if (pattern.test(importLines))
    {
      fail(`${label} imports forbidden producer/parser surface: ${pattern}`)
    }
  }

  // Call-site scan: strip comments, denylist, and this governance helper before matching.
  const logic = sourceText
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1')
    .replace(/export const forbiddenJoinFields[\s\S]*?Object\.freeze\(\[[\s\S]*?\]\)\n/u, '')
    .replace(/export function assertJoinerDoesNotImportProducers[\s\S]*?\nexport function recomputeContentDigest/u, 'export function recomputeContentDigest')
  const forbiddenCalls = [
    /\bscanBehaviorOwnerBindings\s*\(/u,
    /\bscanBehaviorTestBindings\s*\(/u,
    /\bparseRepositoryClaims\s*\(/u,
    /\brunExtractor\s*\(/u,
    /\bimportExtractorModule\s*\(/u,
    /\bspawnSync\s*\(/u,
    /\bexecFileSync\s*\(/u
  ]
  for (const pattern of forbiddenCalls)
  {
    if (pattern.test(logic))
    {
      fail(`${label} invokes forbidden producer/parser API: ${pattern}`)
    }
  }
  return true
}

export function recomputeContentDigest (receipt)
{
  return digestValue(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
}
