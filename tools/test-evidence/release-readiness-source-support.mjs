import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { explicitJson, seal } from '../fact-extractors/post-runtime/adapter.mjs'
import { validateReleaseManifest } from '../release/release-manifest.mjs'

export const releaseReadinessSourceSchema = 'fsusblog.release-identity-readiness-current-run.v1'
export const releaseReadinessObservationSchema = 'fsusblog.observation.release-identity-readiness.v1'

const digestPattern = /^sha256:[a-f0-9]{64}$/u
const commitPattern = /^[a-f0-9]{40}$/u
export const releaseIdPattern = /^\d{14}-[a-f0-9]{12}$/u
const forbiddenPathPattern = /(?:^|[/\\])(?:docs|latest|history|historical)(?:[/\\]|$)/iu
const forbiddenSensitiveKeyPattern = /(?:password|passwd|privatekey|secret|access[_-]?token|refresh[_-]?token)$/iu
export const fail = (message) => { throw new Error(`[release-readiness-raw] ${message}`) }
export const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`
export const bytesDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

export const observationSchemas = Object.freeze({
  image: 'fsusblog.release-readiness.image.v1',
  package: 'fsusblog.release-readiness.package.v1',
  config: 'fsusblog.release-readiness.config.v1',
  databaseSchema: 'fsusblog.release-readiness.database-schema.v1',
  signing: 'fsusblog.release-readiness.signing.v1',
  trust: 'fsusblog.release-readiness.trust.v1',
  readiness: 'fsusblog.release-readiness.semantic-probes.v1',
  runtimeRole: 'fsusblog.release-readiness.runtime-role.v1'
})

export const readinessChecks = Object.freeze({
  service: 'runtime-health-contract',
  routeData: 'route-data-semantic-probe',
  cache: 'cache-coherence-probe',
  dependencies: 'dependency-version-probe',
  version: 'runtime-version-inspect',
  credential: 'credential-capability-probe'
})

export function exactKeys(value, keys, label)
{
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(`${label} fields are incomplete or unsupported`)
  return value
}

export function requireDigest(value, label)
{
  if (!digestPattern.test(String(value ?? ''))) fail(`${label} must be sha256:<64 lowercase hex>`)
  return value
}

export function requireString(value, label)
{
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required`)
  return value
}

export function verifySeal(value, label)
{
  requireDigest(value?.contentDigest, `${label}.contentDigest`)
  const { contentDigest: ignored, ...payload } = value
  if (seal(payload).contentDigest !== value.contentDigest) fail(`${label} contentDigest mismatch`)
}

export function assertPrivacySafe(value, label, seen = new Set())
{
  if (value === null || value === undefined || typeof value !== 'object')
  {
    if (typeof value === 'string' && /(?:authorization:\s*(?:bearer|basic)|cookie:\s*[^*]|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu.test(value))
    {
      fail(`${label} contains credential material`)
    }
    return
  }
  if (seen.has(value)) return
  seen.add(value)
  for (const [key, nested] of Object.entries(value))
  {
    if (forbiddenSensitiveKeyPattern.test(key)) fail(`${label} contains forbidden sensitive field ${key}`)
    assertPrivacySafe(nested, `${label}.${key}`, seen)
  }
}

export function currentJson(relative, label, repositoryRoot)
{
  if (typeof relative !== 'string' || forbiddenPathPattern.test(relative))
  {
    fail(`${label} must not read documentation or latest/history paths`)
  }
  const input = explicitJson(relative, label, repositoryRoot)
  const absolute = path.resolve(repositoryRoot, input.relative)
  return {
    value: input.value,
    ref: {
      path: input.relative,
      fileDigest: bytesDigest(absolute),
      contentDigest: input.value?.contentDigest ?? null
    }
  }
}

export function sourceState(value, plan)
{
  exactKeys(value, [
    'sourceCommit', 'worktreeFingerprint', 'buildIdentity', 'artifactDigest',
    'candidateId', 'releaseId', 'runtimeId', 'runId', 'attemptId', 'slot'
  ], 'sourceState')
  if (!commitPattern.test(String(value.sourceCommit ?? ''))) fail('sourceState.sourceCommit is invalid')
  requireDigest(value.worktreeFingerprint, 'sourceState.worktreeFingerprint')
  requireDigest(value.buildIdentity, 'sourceState.buildIdentity')
  requireDigest(value.artifactDigest, 'sourceState.artifactDigest')
  if (!releaseIdPattern.test(String(value.releaseId ?? ''))) fail('sourceState.releaseId is not canonical')
  if (!['blue', 'green'].includes(value.slot)) fail('sourceState.slot must be blue or green')
  for (const field of ['candidateId', 'runtimeId', 'runId', 'attemptId']) requireString(value[field], `sourceState.${field}`)
  const expected = {
    sourceCommit: plan.sourceState.commit,
    worktreeFingerprint: plan.sourceState.worktreeFingerprint,
    buildIdentity: plan.build.receiptContentDigest,
    candidateId: plan.candidate.candidateId,
    releaseId: plan.candidate.releaseId,
    runtimeId: plan.candidate.runtimeId,
    runId: plan.candidate.runId,
    attemptId: plan.candidate.attemptId
  }
  for (const [field, expectedValue] of Object.entries(expected))
  {
    if (value[field] !== expectedValue) fail(`sourceState.${field} does not exact-match candidate plan`)
  }
  return value
}

export function provenance(value)
{
  exactKeys(value, [
    'schema', 'mode', 'collectorId', 'observedAtUtc', 'rerunCommand',
    'syntheticSemanticResult', 'diagnostic', 'recovered', 'historicalFallback'
  ], 'provenance')
  if (value.schema !== 'fsusblog.release-readiness-provenance.v1'
    || value.mode !== 'current-candidate-runtime'
    || value.collectorId !== 'release-readiness-runtime-probe')
  {
    fail('provenance does not identify the canonical current-runtime collector')
  }
  if (value.syntheticSemanticResult !== false || value.diagnostic !== false
    || value.recovered !== false || value.historicalFallback !== false)
  {
    fail('synthetic, diagnostic, recovered, or historical evidence cannot qualify')
  }
  if (!Number.isFinite(Date.parse(value.observedAtUtc)) || !String(value.observedAtUtc).endsWith('Z'))
  {
    fail('provenance.observedAtUtc must be an ISO UTC timestamp')
  }
  requireString(value.rerunCommand, 'provenance.rerunCommand')
  return value
}

export function manifestReference(value, repositoryRoot, source, plan)
{
  exactKeys(value, ['path', 'fileDigest'], 'manifestRef')
  requireDigest(value.fileDigest, 'manifestRef.fileDigest')
  const input = currentJson(value.path, 'release manifest', repositoryRoot)
  if (input.ref.fileDigest !== value.fileDigest) fail('release manifest bytes changed after source observation')
  const errors = validateReleaseManifest(input.value, {
    requireRegistryDigest: true,
    requireConcreteRuntimeProfile: true,
    expectedReleaseId: source.releaseId,
    expectedImageDigest: input.value.imageDigest,
    expectedCommitSha: source.sourceCommit
  })
  if (errors.length > 0) fail(`release manifest is invalid: ${errors.join('; ')}`)
  if (input.value.releaseId !== plan.candidate.releaseId || input.value.commitSha !== plan.sourceState.commit)
  {
    fail('release manifest identity does not exact-match candidate plan')
  }
  return { manifest: input.value, ref: input.ref }
}
