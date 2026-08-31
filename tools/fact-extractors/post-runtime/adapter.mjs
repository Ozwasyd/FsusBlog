import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadCatalog } from '../../contracts/behavior-contract-catalog.mjs'
import { validateGlobalClaimExactnessReceipt } from '../../docs/global-claim-exactness-final.mjs'
import { digestValue, isPlainObject, stable } from '../lib/canonicalize.mjs'
import { resolveSourceCommit, resolveWorktreeFingerprint } from '../identity.mjs'
import { productionBuildBinding } from '../../release/test-evidence-receipts.mjs'
import { verifyProductionBuildReceipt } from '../../ci/production-build-artifacts.mjs'
import { assertPreRuntimeQualified } from '../../test-matrix/behavior-evidence-pre-runtime.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root as defaultRoot,
  validateAcceptedClaimsReceiptAgainstRegistry,
  validatePostRuntimeProducerRegistry,
  validateProducerReceiptAgainstRegistry
} from '../../test-matrix/post-runtime-producer-registry.mjs'
import { validateSemanticFacts } from './semantic-contracts.mjs'

export const acceptedClaimsSchema = 'fsusblog.post-runtime-accepted-claims.v1'
export const candidatePlanSchema = 'fsusblog.post-runtime-candidate-plan.v1'
export const classReceiptSchema = 'fsusblog.post-runtime-class-receipt.v1'
export const observationReceiptSchema = 'fsusblog.post-runtime-observation-receipt.v1'
export const identityAuthoritySchema = 'fsusblog.post-runtime-identity-authority.v1'
export const sourceReceiptSchema = 'fsusblog.post-runtime-source-receipt.v1'

const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/u
const unsafePathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
const fail = (message) => { throw new Error(`[post-runtime-observation] ${message}`) }
const normalizedDigest = (value) => String(value ?? '').replace(/^sha256:/u, '')
const prefixedDigest = (value) => `sha256:${normalizedDigest(value)}`

function withoutDigest(value)
{
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest'))
}

export function seal(value)
{
  const receipt = { ...stable(value), contentDigest: null }
  receipt.contentDigest = `sha256:${digestValue(withoutDigest(receipt))}`
  return receipt
}

function verifySeal(value, label)
{
  if (!digestPattern.test(String(value?.contentDigest ?? ''))) fail(`${label} contentDigest is invalid`)
  if (prefixedDigest(value.contentDigest) !== seal(withoutDigest(value)).contentDigest) fail(`${label} contentDigest mismatch`)
}

export function explicitJson(input, label, repositoryRoot = defaultRoot)
{
  if (isPlainObject(input)) return { value: structuredClone(input), relative: null, fileDigest: null }
  if (typeof input !== 'string' || input.length === 0) fail(`${label} requires an explicit JSON path`)
  const root = path.resolve(repositoryRoot)
  const absolute = path.resolve(root, input)
  if (!absolute.startsWith(`${root}${path.sep}`) || !input.endsWith('.json') || unsafePathPattern.test(input))
  {
    fail(`${label} must be a current-run JSON path inside the repository`)
  }
  for (let cursor = absolute; cursor !== root; cursor = path.dirname(cursor))
  {
    const cursorStat = lstatSync(cursor, { throwIfNoEntry: false })
    if (!cursorStat || cursorStat.isSymbolicLink())
    {
      fail(`${label} must not traverse a symlink or missing ancestor`)
    }
  }
  const stat = lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute
    || realpathSync(root) !== root)
  {
    fail(`${label} must be a regular non-symlink current-run file`)
  }
  const bytes = readFileSync(absolute)
  return {
    value: JSON.parse(bytes.toString('utf8')),
    relative: path.relative(root, absolute).replaceAll(path.sep, '/'),
    fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  }
}

function receiptReference(input, label)
{
  if (input.relative === null || !digestPattern.test(String(input.value?.contentDigest ?? '')))
  {
    fail(`${label} requires one persisted sealed receipt`)
  }
  return stable({
    path: input.relative,
    fileDigest: input.fileDigest,
    contentDigest: prefixedDigest(input.value.contentDigest),
    schema: input.value.schema
  })
}

function verifyReference(reference, label, repositoryRoot)
{
  if (!isPlainObject(reference)
    || JSON.stringify(Object.keys(reference).sort())
      !== JSON.stringify(['contentDigest', 'fileDigest', 'path', 'schema'])
    || !digestPattern.test(String(reference.fileDigest ?? ''))
    || !digestPattern.test(String(reference.contentDigest ?? '')))
  {
    fail(`${label} reference shape is invalid`)
  }
  const input = explicitJson(reference.path, label, repositoryRoot)
  if (input.fileDigest !== reference.fileDigest
    || prefixedDigest(input.value.contentDigest) !== reference.contentDigest
    || input.value.schema !== reference.schema)
  {
    fail(`${label} reference bytes, content, or schema changed`)
  }
  return input
}

export function writeReceipt(output, receipt, repositoryRoot = defaultRoot)
{
  const root = path.resolve(repositoryRoot)
  const absolute = path.resolve(root, output)
  if (!absolute.startsWith(`${root}${path.sep}`) || !output.endsWith('.json') || unsafePathPattern.test(output))
  {
    fail('output must be a current-run JSON path inside the repository')
  }
  for (let cursor = absolute; cursor !== root; cursor = path.dirname(cursor))
  {
    const stat = lstatSync(cursor, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) fail('output path must not contain symlinks')
  }
  mkdirSync(path.dirname(absolute), { recursive: true })
  for (let cursor = path.dirname(absolute); cursor !== root; cursor = path.dirname(cursor))
  {
    if (lstatSync(cursor).isSymbolicLink()) fail('output path must not contain symlinks')
  }
  const existing = lstatSync(absolute, { throwIfNoEntry: false })
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
  {
    fail('output must be a regular non-symlink current-run file')
  }
  writeFileSync(absolute, `${JSON.stringify(receipt, null, 2)}\n`)
  return path.relative(root, absolute).replaceAll(path.sep, '/')
}

function authority(repositoryRoot = defaultRoot)
{
  const catalog = loadCatalog(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'))
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  validatePostRuntimeProducerRegistry(registry, { catalog })
  if (registry.producers.length !== 1) fail('post-runtime registry must resolve exact-one producer')
  return { registry, producer: registry.producers[0] }
}

export function currentRegistryBinding(repositoryRoot = defaultRoot)
{
  const { registry, producer } = authority(repositoryRoot)
  const observationSchema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const claimsSchema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-accepted-claims.schema.json'), 'utf8'))
  return stable({
    schema: registry.schema,
    contentDigest: `sha256:${digestValue(registry)}`,
    observationSchemaDigest: `sha256:${digestValue(observationSchema)}`,
    claimsSchemaDigest: `sha256:${digestValue(claimsSchema)}`,
    producerToolVersion: producer.toolVersion,
    observationEnvelopeSchema: registry.receiptSemantics.observationEnvelopeSchema,
    acceptedClaimsSchema: registry.receiptSemantics.acceptedClaimsSchema,
    acceptedClaimsToolVersion: registry.receiptSemantics.acceptedClaimsToolVersion
  })
}

export function observationEnvelopeAuthorityFields({ plan, candidatePlanRef, repositoryRoot = defaultRoot })
{
  const schema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const required = new Set(schema.required ?? [])
  if (!required.has('attemptAuthorityRef')) return { candidatePlanRef }
  verifyIdentityAuthorities(plan.identityAuthorityRefs, {
    sourceState: plan.sourceState,
    candidate: plan.candidate
  }, repositoryRoot)
  return stable({
    registryDigest: currentRegistryBinding(repositoryRoot).contentDigest,
    observationSchemaDigest: `sha256:${digestValue(schema)}`,
    candidatePlanRef: plan.identityAuthorityRefs.plan,
    attemptAuthorityRef: plan.identityAuthorityRefs.attempt,
    fixtureAuthorityRef: plan.identityAuthorityRefs.fixture,
    profileAuthorityRef: plan.identityAuthorityRefs.profile
  })
}

export function observationSourceState({ plan, artifactDigest = null, repositoryRoot = defaultRoot, legacy = {} })
{
  const schema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const required = new Set(schema.required ?? [])
  if (!required.has('attemptAuthorityRef')) return stable(legacy)
  return stable({
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    ...(artifactDigest ? { artifactDigest } : {}),
    candidateId: plan.candidate.candidateId,
    runtimeId: plan.candidate.runtimeId,
    browserIdentity: plan.candidate.browserId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    fixtureId: plan.candidate.fixtureId,
    profileId: plan.candidate.profileId
  })
}

export function observationSourceReceipt({
  classId,
  plan,
  sourceState,
  upstreamRef,
  upstreamSchema = upstreamRef?.schema,
  canonicalRerunCommand,
  independentVerifyCommand,
  repositoryRoot = defaultRoot
})
{
  const schema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  if (schema.$defs?.sourceReceiptRef?.properties?.schema?.const !== sourceReceiptSchema)
  {
    return stable(upstreamRef)
  }
  const { registry, producer } = authority(repositoryRoot)
  const definition = registry.observationClasses[classId]
  if (!definition?.sourceReceipt || upstreamSchema !== definition.sourceReceipt.schema)
  {
    fail(`${classId} upstream receipt schema does not match the registry source contract`)
  }
  const wrapper = seal({
    schema: sourceReceiptSchema,
    role: 'source',
    classId,
    producerId: producer.producerId,
    toolVersion: producer.toolVersion,
    sourceState,
    candidatePlanRef: plan.identityAuthorityRefs.plan,
    upstreamRef: {
      path: upstreamRef.path,
      fileDigest: upstreamRef.fileDigest,
      contentDigest: upstreamRef.contentDigest,
      schema: upstreamSchema,
      role: definition.sourceReceipt.role
    },
    canonicalRerunCommand,
    independentVerifyCommand
  })
  const output = `.tmp/post-runtime-source-receipts/${plan.candidate.runId}/${classId}.json`
  writeReceipt(output, wrapper, repositoryRoot)
  const persisted = explicitJson(output, `${classId} source receipt`, repositoryRoot)
  return stable({
    path: persisted.relative,
    fileDigest: persisted.fileDigest,
    contentDigest: wrapper.contentDigest,
    schema: sourceReceiptSchema,
    role: 'source'
  })
}

export function observationUpstreamPath(receipt, repositoryRoot = defaultRoot)
{
  if (receipt?.sourceReceiptRef?.schema !== sourceReceiptSchema) return receipt?.sourceReceiptRef?.path
  const wrapper = explicitJson(receipt.sourceReceiptRef.path, 'observation source receipt', repositoryRoot).value
  if (wrapper.schema !== sourceReceiptSchema || wrapper.role !== 'source'
    || wrapper.contentDigest !== receipt.sourceReceiptRef.contentDigest)
  {
    fail('observation source receipt wrapper identity mismatch')
  }
  return wrapper.upstreamRef?.path
}

export function candidatePlanPathForObservation(receipt, explicitCandidatePlan = null)
{
  if (receipt?.candidatePlanRef?.schema === identityAuthoritySchema)
  {
    if (typeof explicitCandidatePlan !== 'string' || explicitCandidatePlan.length === 0)
    {
      fail('typed observation verification requires an explicit candidate plan path')
    }
    return explicitCandidatePlan
  }
  return receipt?.candidatePlanRef?.path
}

function requiredModes(producer, classId)
{
  return Object.entries(producer.requiredObservations)
    .filter(([, classes]) => classes.includes(classId))
    .map(([mode]) => mode)
    .sort()
}

export function produceAcceptedClaims({ terminalReceipt, repositoryRoot = defaultRoot })
{
  const terminalInput = explicitJson(terminalReceipt, 'terminal receipt', repositoryRoot)
  if (terminalInput.relative === null) fail('accepted claims require a persisted terminal receipt path')
  const terminal = terminalInput.value
  validateGlobalClaimExactnessReceipt(terminal)
  const { registry, producer } = authority(repositoryRoot)
  const ledger = JSON.parse(readFileSync(path.join(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
  if (normalizedDigest(terminal.source?.migrationLedgerDigest) !== digestValue(ledger))
  {
    fail('terminal receipt migration ledger digest does not match current #2205 authority')
  }
  const claimOwners = new Map()
  for (const scope of ledger.scopes ?? [])
  {
    for (const entry of scope.entries ?? [])
    {
      for (const claimId of entry.claimIds ?? [])
      {
        if (claimOwners.has(claimId)) fail(`claim ${claimId} has duplicate ledger owners`)
        claimOwners.set(claimId, { behaviorId: entry.behaviorId, scopeId: scope.scopeId })
      }
    }
  }
  const claims = producer.acceptedClaimRefs.map((claimId) => {
    const owner = claimOwners.get(claimId)
    if (!owner) fail(`accepted claim ${claimId} is absent from the #2205 ledger`)
    return { claimId, ...owner }
  }).sort((left, right) => left.claimId.localeCompare(right.claimId))
  const claimsSchemaDocument = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-accepted-claims.schema.json'), 'utf8'))
  const requiresAuthorityDigests = (claimsSchemaDocument.required ?? []).includes('registryDigest')
  return seal({
    schema: acceptedClaimsSchema,
    sourceState: {
      commit: terminal.source.sourceCommit,
      worktreeFingerprint: prefixedDigest(terminal.source.worktreeFingerprint)
    },
    producerId: producer.producerId,
    toolVersion: registry.receiptSemantics.acceptedClaimsToolVersion,
    ...(requiresAuthorityDigests
      ? {
          registryDigest: `sha256:${digestValue(registry)}`,
          claimsSchemaDigest: `sha256:${digestValue(claimsSchemaDocument)}`
        }
      : {}),
    terminalReceiptRef: {
      path: terminalInput.relative,
      fileDigest: `sha256:${createHash('sha256').update(readFileSync(path.join(repositoryRoot, terminalInput.relative))).digest('hex')}`,
      contentDigest: prefixedDigest(terminal.contentDigest),
      schema: terminal.schema
    },
    migrationLedgerDigest: prefixedDigest(terminal.source.migrationLedgerDigest),
    claims,
    status: 'accepted'
  })
}

export function validateAcceptedClaims(receipt, { repositoryRoot = defaultRoot } = {})
{
  const { registry, producer } = authority(repositoryRoot)
  validateAcceptedClaimsReceiptAgainstRegistry({
    registry,
    producerId: producer.producerId,
    receipt,
    repositoryRoot
  })
  return receipt
}

export function produceCandidateContext({
  preRuntimeReceipt,
  runId,
  attemptId = 'attempt-0001',
  candidate: overrides = {},
  repositoryRoot = defaultRoot
})
{
  const preInput = explicitJson(preRuntimeReceipt, 'pre-runtime receipt', repositoryRoot)
  const pre = preInput.value
  assertPreRuntimeQualified(pre)
  if (!/^[a-z][a-z0-9-]{2,96}$/u.test(String(runId ?? ''))
    || !/^attempt-[0-9]{4}$/u.test(String(attemptId ?? '')))
  {
    fail('candidate context requires a stable lowercase runId and canonical attempt-NNNN identity')
  }
  const observationSchema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const typedIdentity = observationSchema.properties?.sourceState?.properties?.runtimeId !== undefined
  if (typedIdentity && !/^[0-9]{14}-[a-f0-9]{12}$/u.test(String(overrides.releaseId ?? '')))
  {
    fail('typed candidate context requires an explicit canonical releaseId')
  }
  return seal({
    schema: 'fsusblog.post-runtime-candidate-context.v1',
    preRuntimeReceiptRef: receiptReference(preInput, 'pre-runtime receipt'),
    sourceState: {
      commit: pre.sourceIdentity.commit,
      worktreeFingerprint: prefixedDigest(pre.sourceIdentity.worktreeFingerprint)
    },
    candidate: stable({
      candidateId: overrides.candidateId ?? `${runId}${typedIdentity ? ':' : '-'}candidate`,
      runId,
      attemptId,
      fixtureId: overrides.fixtureId ?? `${runId}${typedIdentity ? ':' : '-'}fixture`,
      profileId: overrides.profileId ?? 'acceptance-representative',
      runtimeId: overrides.runtimeId ?? `${runId}${typedIdentity ? ':' : '-'}runtime`,
      browserId: overrides.browserId ?? `${runId}${typedIdentity ? ':' : '-'}browser-contract`,
      releaseId: overrides.releaseId ?? `${runId}-release`,
      rolloutId: overrides.rolloutId ?? `${runId}${typedIdentity ? ':' : '-'}rollout`
    }),
    status: 'planned-before-runtime'
  })
}

function validateCandidateContext(run, repositoryRoot)
{
  if (run?.schema !== 'fsusblog.post-runtime-candidate-context.v1'
    || run.status !== 'planned-before-runtime')
  {
    fail('candidate context schema/status mismatch')
  }
  verifySeal(run, 'candidate context')
  const preInput = verifyReference(run.preRuntimeReceiptRef, 'candidate context pre-runtime receipt', repositoryRoot)
  assertPreRuntimeQualified(preInput.value)
  const expectedSource = {
    commit: preInput.value.sourceIdentity.commit,
    worktreeFingerprint: prefixedDigest(preInput.value.sourceIdentity.worktreeFingerprint)
  }
  if (JSON.stringify(stable(run.sourceState)) !== JSON.stringify(stable(expectedSource)))
  {
    fail('candidate context source identity does not replay from pre-runtime authority')
  }
  const candidate = run.candidate ?? {}
  if (!/^[a-z][a-z0-9-]{2,96}$/u.test(String(candidate.runId ?? ''))
    || !/^attempt-[0-9]{4}$/u.test(String(candidate.attemptId ?? ''))
    || ['candidateId', 'fixtureId', 'profileId', 'runtimeId', 'browserId', 'releaseId', 'rolloutId']
      .some((field) => typeof candidate[field] !== 'string' || candidate[field].length < 3))
  {
    fail('candidate context identities are not canonically derived')
  }
  const observationSchema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  if (observationSchema.properties?.sourceState?.properties?.runtimeId !== undefined
    && (candidate.candidateId !== `${candidate.runId}:candidate`
      || candidate.runtimeId !== `${candidate.runId}:runtime`
      || candidate.browserId !== `${candidate.runId}:browser-contract`
      || candidate.fixtureId !== `${candidate.runId}:fixture`
      || candidate.rolloutId !== `${candidate.runId}:rollout`
      || !/^[0-9]{14}-[a-f0-9]{12}$/u.test(candidate.releaseId)))
  {
    fail('typed candidate identities do not exact-match the run/release authority')
  }
  const profileCatalog = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/testing/fixture-profile-catalog.json'), 'utf8'))
  if (!(profileCatalog.profiles ?? []).some(({ id }) => id === candidate.profileId))
  {
    fail('candidate context profile identity is absent from the fixture-profile authority')
  }
  return run
}

function identityAuthoritySource(candidateContext)
{
  return stable({
    sourceCommit: candidateContext.sourceState.commit,
    worktreeFingerprint: candidateContext.sourceState.worktreeFingerprint,
    runId: candidateContext.candidate.runId,
    attemptId: candidateContext.candidate.attemptId,
    fixtureId: candidateContext.candidate.fixtureId,
    profileId: candidateContext.candidate.profileId
  })
}

function produceIdentityAuthorities({ candidateContext, outputDirectory, repositoryRoot })
{
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0)
  {
    fail('candidate plan requires an explicit identity-authority output directory')
  }
  const identities = {
    plan: candidateContext.candidate.runId,
    attempt: candidateContext.candidate.attemptId,
    fixture: candidateContext.candidate.fixtureId,
    profile: candidateContext.candidate.profileId
  }
  const refs = {}
  for (const [role, authorityId] of Object.entries(identities))
  {
    const receipt = seal({
      schema: identityAuthoritySchema,
      role,
      authorityId,
      sourceState: identityAuthoritySource(candidateContext)
    })
    const output = path.posix.join(outputDirectory.replaceAll(path.sep, '/'), `${role}.json`)
    writeReceipt(output, receipt, repositoryRoot)
    const input = explicitJson(output, `${role} identity authority`, repositoryRoot)
    refs[role] = stable({
      path: input.relative,
      fileDigest: input.fileDigest,
      contentDigest: receipt.contentDigest,
      schema: identityAuthoritySchema,
      role
    })
  }
  return stable(refs)
}

function verifyIdentityAuthorities(refs, candidateContext, repositoryRoot)
{
  if (!isPlainObject(refs)
    || JSON.stringify(Object.keys(refs).sort()) !== JSON.stringify(['attempt', 'fixture', 'plan', 'profile']))
  {
    fail('candidate plan identity authority closure must be exact')
  }
  const expectedIds = {
    plan: candidateContext.candidate.runId,
    attempt: candidateContext.candidate.attemptId,
    fixture: candidateContext.candidate.fixtureId,
    profile: candidateContext.candidate.profileId
  }
  const paths = new Set()
  for (const [role, authorityId] of Object.entries(expectedIds))
  {
    const reference = refs[role]
    if (!isPlainObject(reference)
      || JSON.stringify(Object.keys(reference).sort())
        !== JSON.stringify(['contentDigest', 'fileDigest', 'path', 'role', 'schema'])
      || reference.schema !== identityAuthoritySchema || reference.role !== role
      || !digestPattern.test(String(reference.fileDigest ?? ''))
      || !digestPattern.test(String(reference.contentDigest ?? '')))
    {
      fail(`${role} identity authority reference is invalid`)
    }
    if (paths.has(reference.path)) fail('identity authorities must use distinct files')
    paths.add(reference.path)
    const input = explicitJson(reference.path, `${role} identity authority`, repositoryRoot)
    const authority = input.value
    if (input.fileDigest !== reference.fileDigest || authority.schema !== identityAuthoritySchema
      || authority.role !== role || authority.authorityId !== authorityId
      || authority.contentDigest !== reference.contentDigest)
    {
      fail(`${role} identity authority bytes or identity mismatch`)
    }
    verifySeal(authority, `${role} identity authority`)
    if (JSON.stringify(stable(authority.sourceState))
      !== JSON.stringify(identityAuthoritySource(candidateContext)))
    {
      fail(`${role} identity authority sourceState mismatch`)
    }
  }
  return refs
}

function verifyProductionBuildInput(input, expectedSourceState, repositoryRoot)
{
  const binding = productionBuildBinding(input.value, input.relative ?? 'in-memory-build.json')
  if (input.relative !== null)
  {
    const absolute = path.join(repositoryRoot, input.relative)
    verifyProductionBuildReceipt({
      artifactRoot: path.dirname(absolute),
      receiptFile: path.basename(absolute),
      expectedSourceState,
      expectedReceiptDigest: binding.receiptContentDigest,
      repairReadOnlySeal: false
    })
  }
  return binding
}

function verifyCurrentRepositoryIdentity(sourceState, repositoryRoot)
{
  const actual = {
    commit: resolveSourceCommit(repositoryRoot),
    worktreeFingerprint: prefixedDigest(resolveWorktreeFingerprint(repositoryRoot))
  }
  if (sourceState.commit !== actual.commit || sourceState.worktreeFingerprint !== actual.worktreeFingerprint)
  {
    fail('candidate source identity does not exact-match the current repository worktree')
  }
}

export function produceCandidatePlan({
  preRuntimeReceipt,
  acceptedClaimsReceipt,
  buildReceipt,
  context,
  identityAuthorityDirectory,
  observationPaths,
  repositoryRoot = defaultRoot
})
{
  const preInput = explicitJson(preRuntimeReceipt, 'pre-runtime receipt', repositoryRoot)
  const pre = preInput.value
  assertPreRuntimeQualified(pre)
  const claimsInput = explicitJson(acceptedClaimsReceipt, 'accepted claims receipt', repositoryRoot)
  const claims = validateAcceptedClaims(claimsInput.value, { repositoryRoot })
  const buildInput = explicitJson(buildReceipt, 'production build receipt', repositoryRoot)
  const runInput = explicitJson(context, 'candidate context', repositoryRoot)
  const run = validateCandidateContext(runInput.value, repositoryRoot)
  const sourceState = { commit: pre.sourceIdentity.commit, worktreeFingerprint: prefixedDigest(pre.sourceIdentity.worktreeFingerprint) }
  verifyCurrentRepositoryIdentity(sourceState, repositoryRoot)
  const build = verifyProductionBuildInput(buildInput, sourceState, repositoryRoot)
  if (build.sourceState.commit !== sourceState.commit
    || prefixedDigest(build.sourceState.worktreeFingerprint) !== sourceState.worktreeFingerprint
    || claims.sourceState.commit !== sourceState.commit
    || claims.sourceState.worktreeFingerprint !== sourceState.worktreeFingerprint
    || run.sourceState?.commit !== sourceState.commit
    || prefixedDigest(run.sourceState?.worktreeFingerprint) !== sourceState.worktreeFingerprint)
  {
    fail('candidate inputs do not share one source/worktree identity')
  }
  const { registry, producer } = authority(repositoryRoot)
  const classes = Object.keys(registry.observationClasses).sort()
  if (!isPlainObject(observationPaths) || JSON.stringify(Object.keys(observationPaths).sort()) !== JSON.stringify(classes))
  {
    fail('candidate plan must bind exact-one output path for every canonical observation class')
  }
  const observations = classes.map((classId) => {
    const receiptPath = String(observationPaths[classId] ?? '')
    if (!receiptPath.endsWith('.json') || unsafePathPattern.test(receiptPath)) fail(`${classId} receipt path is not current-run explicit`)
    return { classId, schema: registry.observationClasses[classId].schema, receiptPath, requiredModes: requiredModes(producer, classId) }
  })
  const identityAuthorityRefs = produceIdentityAuthorities({
    candidateContext: run,
    outputDirectory: identityAuthorityDirectory,
    repositoryRoot
  })
  return seal({
    schema: candidatePlanSchema,
    producerId: producer.producerId,
    registryBinding: currentRegistryBinding(repositoryRoot),
    sourceState,
    build,
    candidate: stable(run.candidate),
    preRuntimeReceiptRef: receiptReference(preInput, 'pre-runtime receipt'),
    acceptedClaimsReceiptRef: receiptReference(claimsInput, 'accepted claims receipt'),
    buildReceiptRef: receiptReference(buildInput, 'production build receipt'),
    candidateContextRef: receiptReference(runInput, 'candidate context'),
    identityAuthorityRefs,
    preRuntimeReceiptDigest: prefixedDigest(pre.contentDigest),
    acceptedClaimsReceiptDigest: prefixedDigest(claims.contentDigest),
    observations,
    status: 'planned'
  })
}

export function validateCandidatePlan(plan, { repositoryRoot = defaultRoot } = {})
{
  if (plan?.schema !== candidatePlanSchema || plan.status !== 'planned') fail('candidate plan schema/status mismatch')
  verifySeal(plan, 'candidate plan')
  const { registry, producer } = authority(repositoryRoot)
  if (plan.producerId !== producer.producerId) fail('candidate plan producer mismatch')
  if (JSON.stringify(stable(plan.registryBinding)) !== JSON.stringify(currentRegistryBinding(repositoryRoot)))
  {
    fail('candidate plan registry/schema/tool identity binding mismatch')
  }
  const preInput = verifyReference(plan.preRuntimeReceiptRef, 'candidate plan pre-runtime receipt', repositoryRoot)
  assertPreRuntimeQualified(preInput.value)
  const claimsInput = verifyReference(plan.acceptedClaimsReceiptRef, 'candidate plan accepted claims receipt', repositoryRoot)
  const claims = validateAcceptedClaims(claimsInput.value, { repositoryRoot })
  const buildInput = verifyReference(plan.buildReceiptRef, 'candidate plan production build receipt', repositoryRoot)
  const contextInput = verifyReference(plan.candidateContextRef, 'candidate plan context receipt', repositoryRoot)
  const run = validateCandidateContext(contextInput.value, repositoryRoot)
  const sourceState = {
    commit: preInput.value.sourceIdentity.commit,
    worktreeFingerprint: prefixedDigest(preInput.value.sourceIdentity.worktreeFingerprint)
  }
  verifyCurrentRepositoryIdentity(sourceState, repositoryRoot)
  const build = verifyProductionBuildInput(buildInput, sourceState, repositoryRoot)
  if (JSON.stringify(stable(plan.sourceState)) !== JSON.stringify(stable(sourceState))
    || JSON.stringify(stable(plan.build)) !== JSON.stringify(stable(build))
    || JSON.stringify(stable(plan.candidate)) !== JSON.stringify(stable(run.candidate))
    || plan.preRuntimeReceiptDigest !== prefixedDigest(preInput.value.contentDigest)
    || plan.acceptedClaimsReceiptDigest !== prefixedDigest(claims.contentDigest)
    || claims.sourceState.commit !== sourceState.commit
    || claims.sourceState.worktreeFingerprint !== sourceState.worktreeFingerprint
    || run.sourceState.commit !== sourceState.commit
    || run.sourceState.worktreeFingerprint !== sourceState.worktreeFingerprint)
  {
    fail('candidate plan upstream replay identity mismatch')
  }
  verifyIdentityAuthorities(plan.identityAuthorityRefs, run, repositoryRoot)
  const expected = Object.keys(registry.observationClasses).sort()
  const actual = (plan.observations ?? []).map(({ classId }) => classId).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('candidate plan observation closure mismatch')
  for (const observation of plan.observations)
  {
    const definition = registry.observationClasses[observation.classId]
    if (observation.schema !== definition.schema
      || JSON.stringify([...(observation.requiredModes ?? [])].sort())
        !== JSON.stringify(requiredModes(producer, observation.classId)))
    {
      fail(`${observation.classId} candidate plan authority binding mismatch`)
    }
    if (typeof observation.receiptPath !== 'string' || !observation.receiptPath.endsWith('.json')
      || unsafePathPattern.test(observation.receiptPath))
    {
      fail(`${observation.classId} candidate plan path is not current-run explicit`)
    }
  }
  return plan
}

export function produceClassReceipt({ candidatePlan, classId, result, repositoryRoot = defaultRoot })
{
  const plan = validateCandidatePlan(explicitJson(candidatePlan, 'candidate plan', repositoryRoot).value, { repositoryRoot })
  const input = explicitJson(result, `${classId} result`, repositoryRoot)
  const { registry, producer } = authority(repositoryRoot)
  const definition = registry.observationClasses[classId]
  if (!definition) fail(`unknown observation class ${classId}`)
  validateProducerReceiptAgainstRegistry({
    registry, producerId: producer.producerId, receipt: input.value, classId, repositoryRoot
  })
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned || input.relative !== planned.receiptPath) fail(`${classId} result path does not match candidate plan`)
  const source = input.value.sourceState ?? input.value.sourceIdentity ?? {}
  if ((source.sourceCommit ?? source.commit) !== plan.sourceState.commit
    || prefixedDigest(source.worktreeFingerprint) !== plan.sourceState.worktreeFingerprint)
  {
    fail(`${classId} source identity mismatch`)
  }
  for (const field of definition.requiredIdentityFields)
  {
    if (field === 'contentDigest') continue
    if (source[field] == null && input.value[field] == null) fail(`${classId} is missing required identity ${field}`)
  }
  const identities = { ...source, ...input.value }
  const exactIdentity = {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    candidateId: plan.candidate.candidateId,
    runtimeId: plan.candidate.runtimeId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    fixtureId: plan.candidate.fixtureId,
    profileId: plan.candidate.profileId,
    browserIdentity: plan.candidate.browserId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId
  }
  for (const [field, expected] of Object.entries(exactIdentity))
  {
    if (definition.requiredIdentityFields.includes(field)
      && prefixedDigest(identities[field]) !== prefixedDigest(expected))
    {
      fail(`${classId} ${field} does not match candidate plan`)
    }
  }
  const modes = [...(input.value.modes ?? [])].sort()
  if (JSON.stringify(modes) !== JSON.stringify(planned.requiredModes)) fail(`${classId} result modes do not exact-match registry`)
  if (!Array.isArray(definition.requiredSemanticFactFields))
  {
    validateSemanticFacts(classId, input.value.semanticFacts)
  }
  return seal({
    schema: classReceiptSchema,
    classId,
    observationSchema: definition.schema,
    producerId: producer.producerId,
    sourceState: plan.sourceState,
    candidatePlanDigest: plan.contentDigest,
    buildReceiptDigest: plan.build.receiptContentDigest,
    candidate: plan.candidate,
    modes,
    semanticFacts: stable(input.value.semanticFacts),
    rawResult: { path: input.relative, contentDigest: prefixedDigest(input.value.contentDigest) },
    status: 'qualified'
  })
}

export function produceObservationReceipt({ scope, candidatePlan, acceptedClaimsReceipt, classReceipts, repositoryRoot = defaultRoot })
{
  const plan = validateCandidatePlan(explicitJson(candidatePlan, 'candidate plan', repositoryRoot).value, { repositoryRoot })
  const claims = validateAcceptedClaims(explicitJson(acceptedClaimsReceipt, 'accepted claims receipt', repositoryRoot).value, { repositoryRoot })
  if (claims.contentDigest !== plan.acceptedClaimsReceiptDigest) fail('accepted claims do not match candidate plan')
  const scopeClasses = scope === 'application'
    ? ['aot-spa-hydration', 'browser-behavior-contract', 'cache-search-outbox-convergence', 'route-response-error', 'session-cookie-runtime']
    : scope === 'release-deployment'
      ? ['blue-green-containment', 'release-identity-readiness']
      : fail(`unknown observation scope ${scope}`)
  const receipts = classReceipts.map((entry, index) => explicitJson(entry, `class receipt ${index}`, repositoryRoot).value)
  for (const receipt of receipts)
  {
    if (receipt.schema !== classReceiptSchema || receipt.status !== 'qualified') fail('class receipt schema/status mismatch')
    verifySeal(receipt, `class receipt ${receipt.classId}`)
    if (receipt.candidatePlanDigest !== plan.contentDigest) fail(`${receipt.classId} candidate plan mismatch`)
    const replay = produceClassReceipt({
      candidatePlan: plan,
      classId: receipt.classId,
      result: receipt.rawResult?.path,
      repositoryRoot
    })
    if (replay.contentDigest !== receipt.contentDigest) fail(`${receipt.classId} class receipt replay mismatch`)
  }
  if (JSON.stringify(receipts.map(({ classId }) => classId).sort()) !== JSON.stringify(scopeClasses.sort()))
  {
    fail(`${scope} class receipt closure must be exact-one`)
  }
  return seal({
    schema: observationReceiptSchema,
    scope,
    behaviorId: 'browserless-production-correctness',
    producerId: plan.producerId,
    sourceState: plan.sourceState,
    candidate: plan.candidate,
    build: plan.build,
    buildReceiptDigest: plan.build.receiptContentDigest,
    candidatePlanDigest: plan.contentDigest,
    preRuntimeReceiptDigest: plan.preRuntimeReceiptDigest,
    acceptedClaimsReceiptDigest: claims.contentDigest,
    acceptedClaimRefs: claims.claims.map(({ claimId }) => claimId).sort(),
    requiredClasses: [...scopeClasses].sort(),
    observedClasses: receipts.map(({ classId }) => classId).sort(),
    observations: receipts.sort((left, right) => left.classId.localeCompare(right.classId)).map((receipt) => ({
      classId: receipt.classId,
      receiptDigest: receipt.contentDigest,
      modes: receipt.modes,
      rawResult: receipt.rawResult,
      semanticFacts: receipt.semanticFacts
    })),
    status: 'qualified',
    failureReasons: []
  })
}

export function runObservationCli({ argv, scope, defaultOutput, repositoryRoot = defaultRoot })
{
  const command = argv[0]
  const options = { classReceipts: [] }
  for (let index = 1; index < argv.length; index += 2)
  {
    const key = argv[index]
    const value = argv[index + 1]
    if (!value) fail(`${key} requires a value`)
    if (key === '--candidate-plan') options.candidatePlan = value
    else if (key === '--accepted-claims') options.acceptedClaimsReceipt = value
    else if (key === '--class-receipt') options.classReceipts.push(value)
    else if (key === '--out') options.out = value
    else if (key === '--receipt') options.receipt = value
    else fail(`unknown option ${key}`)
  }
  const produced = produceObservationReceipt({ scope, ...options, repositoryRoot })
  if (command === 'verify')
  {
    const actual = explicitJson(options.receipt, 'observation receipt', repositoryRoot).value
    verifySeal(actual, 'observation receipt')
    if (actual.contentDigest !== produced.contentDigest) fail('observation receipt replay mismatch')
    return actual
  }
  if (command !== 'produce') fail('command must be produce or verify')
  writeReceipt(options.out ?? defaultOutput, produced, repositoryRoot)
  return produced
}
