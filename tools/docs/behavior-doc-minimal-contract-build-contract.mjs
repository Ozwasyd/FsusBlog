import path from 'node:path'
import { digestValue } from '../fact-extractors/lib/canonicalize.mjs'

export const minimalContractBuildSchema =
  'fsusblog.behavior-doc-minimal-contract-build-receipt.v1'

export const minimalContractBuildHostDeclarations = Object.freeze({
  'runtime-role-observation': {
    project: 'tools/contracts/FsusBlog.RuntimeRoleObservation/FsusBlog.RuntimeRoleObservation.csproj',
    output: '.tmp/contracts/runtime-role/runtime-role-observation.json',
    cacheFile: 'observations/runtime-role-observation.json',
    repositoryRootArgument: false
  },
  'openapi-aeds-observation': {
    project: 'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj',
    output: '.tmp/contracts/openapi/api-aeds-observation.json',
    cacheFile: 'observations/openapi-aeds-observation.json',
    repositoryRootArgument: true
  },
  'auth-session-permission-observation': {
    project: 'tools/contracts/FsusBlog.AuthSessionObservation/FsusBlog.AuthSessionObservation.csproj',
    output: '.tmp/contracts/auth-session/auth-session-permission-observation.json',
    cacheFile: 'observations/auth-session-permission-observation.json',
    repositoryRootArgument: false
  },
  'config-error-security-policy-observation': {
    project: 'tools/contracts/FsusBlog.ConfigErrorSecurityObservation/FsusBlog.ConfigErrorSecurityObservation.csproj',
    output: '.tmp/contracts/config-error-security/config-error-security-policy-observation.json',
    cacheFile: 'observations/config-error-security-policy-observation.json',
    repositoryRootArgument: true
  },
  'content-lifecycle-observation': {
    project: 'tools/contracts/FsusBlog.ContentLifecycleObservation/FsusBlog.ContentLifecycleObservation.csproj',
    output: '.tmp/contracts/content-lifecycle/content-lifecycle-observation.json',
    cacheFile: 'observations/content-lifecycle-observation.json',
    repositoryRootArgument: false
  }
})
function hasExactKeys(value, keys) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function cachedArtifactPath(buildRoot, declaration) {
  return path.posix.join(buildRoot, declaration.cacheFile)
}

export function validateMinimalContractBuildReceipt(receipt, {
  expectedRunId = null,
  expectedSourceIdentity = null,
  repositoryRoot = null,
  readArtifactDigest = null
} = {}) {
  if (receipt == null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('minimal contract build receipt must be an object')
  }
  if (!hasExactKeys(receipt, [
    'schema',
    'runId',
    'sourceCommit',
    'worktreeFingerprint',
    'toolchain',
    'buildKey',
    'buildRoot',
    'sourceClosureDigests',
    'artifacts',
    'status',
    'failureReasons',
    'contentDigest'
  ])) {
    throw new Error('minimal contract build receipt fields are not sealed')
  }
  const copy = structuredClone(receipt)
  const digest = copy?.contentDigest
  copy.contentDigest = null
  if (receipt?.schema !== minimalContractBuildSchema) {
    throw new Error(`minimal contract build schema must be ${minimalContractBuildSchema}`)
  }
  if (digest !== digestValue(copy)) throw new Error('minimal contract build content digest mismatch')
  if (receipt.status !== 'ok' || !Array.isArray(receipt.failureReasons)
    || receipt.failureReasons.length !== 0) {
    throw new Error(
      `minimal contract build is not successful: ${(receipt.failureReasons ?? []).join('; ')}`
    )
  }
  if (expectedRunId !== null && receipt.runId !== expectedRunId) {
    throw new Error('minimal contract build run id mismatch')
  }
  if (expectedSourceIdentity
    && (receipt.sourceCommit !== expectedSourceIdentity.sourceCommit
      || receipt.worktreeFingerprint !== expectedSourceIdentity.worktreeFingerprint)) {
    throw new Error('minimal contract build source/worktree identity mismatch')
  }
  if (!/^[a-f0-9]{64}$/u.test(receipt.buildKey ?? '')
    || receipt.buildRoot !== `.tmp/behavior-doc-contract-builds/${receipt.buildKey}`) {
    throw new Error('minimal contract build root is not content-addressed')
  }
  if (receipt.toolchain?.configuration !== 'Release'
    || receipt.toolchain?.targetFramework !== 'net10.0'
    || typeof receipt.toolchain?.dotnet !== 'string'
    || receipt.toolchain.dotnet.length === 0) {
    throw new Error('minimal contract build toolchain identity is incomplete')
  }
  if (!hasExactKeys(receipt.toolchain, ['dotnet', 'configuration', 'targetFramework'])) {
    throw new Error('minimal contract build toolchain fields are not sealed')
  }
  if (!Array.isArray(receipt.sourceClosureDigests)
    || receipt.sourceClosureDigests.length === 0
    || new Set(receipt.sourceClosureDigests.map((entry) => entry?.path)).size
      !== receipt.sourceClosureDigests.length
    || receipt.sourceClosureDigests.some((entry) =>
      !hasExactKeys(entry, ['path', 'digest'])
      || typeof entry.path !== 'string'
      || entry.path.length === 0
      || !/^[a-f0-9]{64}$/u.test(entry.digest ?? ''))) {
    throw new Error('minimal contract build source closure is incomplete')
  }
  if (repositoryRoot !== null && typeof readArtifactDigest !== 'function') {
    throw new Error('minimal contract build requires an independent artifact reader')
  }
  const artifactIds = Object.keys(receipt.artifacts ?? {}).sort()
  if (JSON.stringify(artifactIds) !== JSON.stringify(Object.keys(minimalContractBuildHostDeclarations).sort())) {
    throw new Error('minimal contract build artifact roster is incomplete')
  }
  for (const [artifactId, declaration] of Object.entries(minimalContractBuildHostDeclarations)) {
    const artifact = receipt.artifacts[artifactId]
    const expectedArtifactPath = cachedArtifactPath(receipt.buildRoot, declaration)
    if (artifact?.project !== declaration.project
      || artifact?.path !== expectedArtifactPath
      || !hasExactKeys(artifact, ['project', 'projectDigest', 'path', 'artifactDigest'])
      || !/^[a-f0-9]{64}$/u.test(artifact?.projectDigest ?? '')
      || !/^[a-f0-9]{64}$/u.test(artifact?.artifactDigest ?? '')) {
      throw new Error(`minimal contract build artifact ${artifactId} is invalid`)
    }
    if (repositoryRoot !== null
      && (readArtifactDigest(repositoryRoot, artifact.project) !== artifact.projectDigest
        || readArtifactDigest(repositoryRoot, artifact.path) !== artifact.artifactDigest)) {
      throw new Error(`minimal contract build artifact ${artifactId} digest mismatch`)
    }
  }
  return receipt
}
