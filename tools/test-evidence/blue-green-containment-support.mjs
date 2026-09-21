import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import {
  explicitJson,
  seal,
  validateCandidatePlan
} from '../fact-extractors/post-runtime/adapter.mjs'
import { productionBuildBinding } from '../release/test-evidence-receipts.mjs'
import { loadPostRuntimeProducerRegistry } from '../test-matrix/post-runtime-producer-registry.mjs'

export const sourceReceiptSchema = 'fsusblog.blue-green-containment-source-receipt.v1'
export const sourceBundleSchema = 'fsusblog.blue-green-containment-source-bundle.v1'
export const failureReceiptSchema = 'fsusblog.observation.blue-green-containment.failure.v1'

export const classId = 'blue-green-containment'
const digestPattern = /^sha256:[a-f0-9]{64}$/u
export const forbiddenPathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
export const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
export const roles = Object.freeze([
  'state-before',
  'state-after',
  'promotion',
  'switch',
  'health',
  'rollback',
  'failure',
  'traffic',
  'artifact',
  'volume',
  'schema',
  'process',
  'cleanup',
  'terminal'
])
const identityFields = Object.freeze([
  'sourceCommit',
  'worktreeFingerprint',
  'buildIdentity',
  'candidateId',
  'releaseId',
  'rolloutId',
  'deploymentId',
  'runtimeId',
  'runId',
  'attemptId',
  'producerId',
  'schemaIdentity',
  'toolchainIdentity'
])

export const fail = (message) => { throw new Error(`[blue-green-containment-raw] ${message}`) }
export const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`

export function privacySafeMessage(error)
{
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?<name>password|passwd|token|secret|credential)\s*[=:]\s*[^\s,;}]+/giu, '$<name>=<redacted>')
    .slice(0, 2048)
}

export function exactKeys(value, expected, label)
{
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0'))
  {
    fail(`${label} fields do not exact-match its contract`)
  }
}

export function requireDigest(value, label)
{
  if (!digestPattern.test(String(value ?? ''))) fail(`${label} must be a sha256 digest`)
}

export function requireId(value, label)
{
  if (!safeIdentifierPattern.test(String(value ?? ''))) fail(`${label} must be an exact identifier`)
}

export function safeInput(relative, repositoryRoot, label)
{
  if (typeof relative !== 'string' || relative.length === 0 || !relative.endsWith('.json')
    || path.isAbsolute(relative) || forbiddenPathPattern.test(relative))
  {
    fail(`${label} must be an explicit current-run JSON path`)
  }
  const normalized = relative.replaceAll('\\', '/')
  if (path.posix.normalize(normalized) !== normalized
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..'))
  {
    fail(`${label} path is not canonical`)
  }
  const base = path.resolve(repositoryRoot)
  const absolute = path.resolve(base, normalized)
  if (!absolute.startsWith(`${base}${path.sep}`)) fail(`${label} escapes the repository`)
  let cursor = absolute
  while (cursor !== base)
  {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(`${label} contains a symlink`)
    cursor = path.dirname(cursor)
  }
  if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) fail(`${label} is missing`)
  const bytes = fs.readFileSync(absolute)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch { fail(`${label} is not structured JSON`) }
  return {
    value,
    ref: {
      path: normalized,
      fileDigest: bytesDigest(bytes),
      contentDigest: value.contentDigest ?? null,
      schema: value.schema ?? null
    }
  }
}

export function verifySeal(receipt, label)
{
  requireDigest(receipt?.contentDigest, `${label} contentDigest`)
  const replay = seal(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
  if (receipt.contentDigest !== replay.contentDigest) fail(`${label} contentDigest mismatch`)
}

export function planContext(candidatePlan, repositoryRoot)
{
  const input = safeInput(candidatePlan, repositoryRoot, 'candidate plan')
  const plan = validateCandidatePlan(input.value, { repositoryRoot })
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned) fail('candidate plan does not own blue-green-containment')
  const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
  const definition = registry.observationClasses[classId]
  const producer = registry.producers.find(({ producerId }) => producerId === plan.producerId)
  if (!definition || planned.schema !== definition.schema) fail('candidate plan blue-green schema authority mismatch')
  if (!producer) fail('candidate plan producer is absent from registry')
  const build = explicitJson(plan.build.receipt, 'production build receipt', repositoryRoot).value
  const buildBinding = productionBuildBinding(build, plan.build.receipt)
  if (buildBinding.receiptContentDigest !== plan.build.receiptContentDigest
    || buildBinding.sourceState.commit !== plan.sourceState.commit
    || `sha256:${String(buildBinding.sourceState.worktreeFingerprint).replace(/^sha256:/u, '')}`
      !== plan.sourceState.worktreeFingerprint)
  {
    fail('production build receipt does not exact-match the candidate plan')
  }
  return {
    plan,
    planned,
    definition,
    toolVersion: producer.toolVersion,
    candidatePlanRef: {
      path: input.ref.path,
      fileDigest: input.ref.fileDigest,
      contentDigest: input.ref.contentDigest
    },
    toolchainIdentity: semanticDigest(build.toolchain ?? build.producer)
  }
}

export function expectedIdentity(context, deploymentId)
{
  const { plan, definition, toolchainIdentity } = context
  return {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    candidateId: plan.candidate.candidateId,
    releaseId: plan.candidate.releaseId,
    rolloutId: plan.candidate.rolloutId,
    deploymentId,
    runtimeId: plan.candidate.runtimeId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId,
    producerId: plan.producerId,
    schemaIdentity: definition.schema,
    toolchainIdentity
  }
}

export function requireIdentity(receipt, expected, role)
{
  exactKeys(receipt.sourceState, identityFields, `${role} sourceState`)
  for (const field of identityFields)
  {
    if (receipt.sourceState[field] !== expected[field]) fail(`${role} ${field} does not exact-match the candidate plan`)
  }
}
