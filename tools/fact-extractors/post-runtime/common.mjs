import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { loadCatalog } from '../../contracts/behavior-contract-catalog.mjs'
import {
  buildPostRuntimeAcceptedClaimsReceipt,
  validatePostRuntimeAcceptedClaimsValue
} from '../../docs/post-runtime-accepted-claims.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root as repositoryRoot,
  validatePostRuntimeProducerRegistry
} from '../../test-matrix/post-runtime-producer-registry.mjs'
import { digestValue, isPlainObject, stable } from '../lib/canonicalize.mjs'
import { seal } from './receipt-seal-contract.mjs'

export { seal } from './receipt-seal-contract.mjs'
export const defaultRoot = repositoryRoot
export const acceptedClaimsSchema = 'fsusblog.post-runtime-accepted-claims.v1'
export const candidatePlanSchema = 'fsusblog.post-runtime-candidate-plan.v1'
export const classReceiptSchema = 'fsusblog.post-runtime-class-receipt.v1'
export const observationReceiptSchema = 'fsusblog.post-runtime-observation-receipt.v1'
export const identityAuthoritySchema = 'fsusblog.post-runtime-identity-authority.v1'
export const sourceReceiptSchema = 'fsusblog.post-runtime-source-receipt.v1'

export const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/u
const unsafePathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
export const fail = (message) => { throw new Error(`[post-runtime-observation] ${message}`) }
const normalizedDigest = (value) => String(value ?? '').replace(/^sha256:/u, '')
export const prefixedDigest = (value) => `sha256:${normalizedDigest(value)}`
export const schedulerRunIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/u
const authorityCache = new Map()

export function canonicalCurrentRunJsonPath(value)
{
  return typeof value === 'string'
    && value.endsWith('.json')
    && value.startsWith('.tmp/')
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && path.posix.normalize(value) === value
    && !value.startsWith('../')
    && !unsafePathPattern.test(value)
}

export function canonicalCurrentRunDirectory(value)
{
  return typeof value === 'string'
    && value.startsWith('.tmp/')
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && path.posix.normalize(value) === value
    && !value.startsWith('../')
    && !value.endsWith('.json')
    && !unsafePathPattern.test(value)
}

function withoutDigest(value)
{
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest'))
}

export function verifySeal(value, label)
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
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(absolute) !== absolute
    || realpathSync(root) !== root)
  {
    fail(`${label} must be a regular non-symlink single-link current-run file`)
  }
  const bytes = readFileSync(absolute)
  return {
    value: JSON.parse(bytes.toString('utf8')),
    relative: path.relative(root, absolute).replaceAll(path.sep, '/'),
    fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  }
}

export function receiptReference(input, label)
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

export function verifyReference(reference, label, repositoryRoot)
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
  if (existing)
  {
    fail('output must not overwrite an existing current-run record')
  }
  const temporary = `${absolute}.prepublish-${process.pid}-${randomUUID()}`
  try
  {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const descriptor = openSync(temporary, 'r')
    try { fsyncSync(descriptor) }
    finally { closeSync(descriptor) }
    linkSync(temporary, absolute)
  }
  catch (error)
  {
    if (error?.code === 'EEXIST') fail('output must not overwrite an existing current-run record')
    throw error
  }
  finally
  {
    try { unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return path.relative(root, absolute).replaceAll(path.sep, '/')
}

function currentRepositoryAuthorityKey(repositoryRoot)
{
  const root = path.resolve(repositoryRoot)
  const git = (args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
  }).trim()
  if (git(['for-each-ref', '--format=%(refname)', 'refs/replace/']))
  {
    fail('Git replacement refs are forbidden for repository authority validation')
  }
  try
  {
    git(['diff-index', '--cached', '--quiet', 'HEAD', '--'])
    git(['diff-files', '--quiet', '--'])
  }
  catch (error)
  {
    fail(`Git HEAD/index/worktree authority is not exact-clean: ${error.stderr?.trim() || error.message}`)
  }
  return `${root}\0${git(['rev-parse', '--verify', 'HEAD'])}\0${git([
    'rev-parse', '--verify', 'HEAD^{tree}'
  ])}`
}

export function authority(repositoryRoot = defaultRoot)
{
  const cacheKey = currentRepositoryAuthorityKey(repositoryRoot)
  const cached = authorityCache.get(cacheKey)
  if (cached) return cached
  const catalog = loadCatalog(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'))
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  validatePostRuntimeProducerRegistry(registry, { catalog, repositoryRoot })
  if (registry.producers.length !== 1) fail('post-runtime registry must resolve exact-one producer')
  const resolved = { registry, producer: registry.producers[0] }
  authorityCache.clear()
  authorityCache.set(cacheKey, resolved)
  return resolved
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

export function observationSourceState({ classId, plan, artifactDigest = null, repositoryRoot = defaultRoot, legacy = {} })
{
  const schema = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const required = new Set(schema.required ?? [])
  if (!required.has('attemptAuthorityRef')) return stable(legacy)
  const available = {
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
  }
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const definition = registry.observationClasses[classId]
  if (!definition) fail('observation source state requires an explicit registered class')
  return stable(Object.fromEntries(definition.requiredIdentityFields
    .filter((field) => !['producerId', 'toolVersion', 'contentDigest'].includes(field))
    .map((field) => {
      if (available[field] === undefined) fail(`${classId} source identity ${field} is missing`)
      return [field, available[field]]
    })))
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
  const output = `.tmp/post-runtime-source-receipts/${plan.candidate.runId}/${plan.candidate.attemptId}/${classId}.json`
  const absoluteOutput = path.resolve(repositoryRoot, output)
  const existing = lstatSync(absoluteOutput, { throwIfNoEntry: false })
  if (existing)
  {
    const retained = explicitJson(output, `${classId} source receipt`, repositoryRoot).value
    if (retained.contentDigest !== wrapper.contentDigest
      || JSON.stringify(stable(retained)) !== JSON.stringify(stable(wrapper)))
    {
      fail(`${classId} source receipt attempt path already contains different evidence`)
    }
  }
  else
  {
    writeReceipt(output, wrapper, repositoryRoot)
  }
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

export function requiredModes(producer, classId)
{
  return Object.entries(producer.requiredObservations)
    .filter(([, classes]) => classes.includes(classId))
    .map(([mode]) => mode)
    .sort()
}

export function produceAcceptedClaims({ terminalReceipt, expectedRunId, repositoryRoot = defaultRoot })
{
  const { producer } = authority(repositoryRoot)
  return buildPostRuntimeAcceptedClaimsReceipt({
    terminalReceiptPath: terminalReceipt,
    expectedRunId,
    producerId: producer.producerId,
    repositoryRoot
  })
}

export function validateAcceptedClaims(receipt, { expectedRunId, repositoryRoot = defaultRoot } = {})
{
  const { producer } = authority(repositoryRoot)
  return validatePostRuntimeAcceptedClaimsValue({
    expectedRunId,
    producerId: producer.producerId,
    receipt,
    repositoryRoot
  })
}
