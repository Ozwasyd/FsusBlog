import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  computeConsumedInputDigests,
  digestPath,
  digestValue,
  sealSourceIdentity
} from '../fact-extractors/identity.mjs'
import { loadRegistry } from '../fact-extractors/registry.mjs'
import { observeRuntimeRoleDeploymentAuthority } from '../governance/check-monolithic-distributed-architecture.mjs'

export const minimalContractBuildSchema =
  'fsusblog.behavior-doc-minimal-contract-build-receipt.v1'

const hostDeclarations = Object.freeze({
  'runtime-role-observation': {
    project: 'tools/contracts/FsusBlog.RuntimeRoleObservation/FsusBlog.RuntimeRoleObservation.csproj',
    output: '.tmp/contracts/runtime-role/runtime-role-observation.json',
    cacheFile: 'observations/runtime-role-observation.json',
    repositoryRootArgument: false,
    assemblyFile: 'artifacts/bin/FsusBlog.RuntimeRoleObservation/release/FsusBlog.RuntimeRoleObservation.dll',
    buildReceiptSchema: 'fsusblog.runtime-role-observation-build-receipt.v3'
  },
  'openapi-aeds-observation': {
    project: 'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj',
    output: '.tmp/contracts/openapi/api-aeds-observation.json',
    cacheFile: 'observations/openapi-aeds-observation.json',
    repositoryRootArgument: true,
    buildReceiptSchema: 'fsusblog.openapi-aeds-observation-build-receipt.v1'
  },
  'auth-session-permission-observation': {
    project: 'tools/contracts/FsusBlog.AuthSessionObservation/FsusBlog.AuthSessionObservation.csproj',
    output: '.tmp/contracts/auth-session/auth-session-permission-observation.json',
    cacheFile: 'observations/auth-session-permission-observation.json',
    repositoryRootArgument: false,
    buildReceiptSchema: 'fsusblog.auth-session-permission-observation-build-receipt.v1'
  },
  'config-error-security-policy-observation': {
    project: 'tools/contracts/FsusBlog.ConfigErrorSecurityObservation/FsusBlog.ConfigErrorSecurityObservation.csproj',
    output: '.tmp/contracts/config-error-security/config-error-security-policy-observation.json',
    cacheFile: 'observations/config-error-security-policy-observation.json',
    repositoryRootArgument: true,
    buildReceiptSchema: 'fsusblog.config-error-security-policy-observation-build-receipt.v1'
  },
  'content-lifecycle-observation': {
    project: 'tools/contracts/FsusBlog.ContentLifecycleObservation/FsusBlog.ContentLifecycleObservation.csproj',
    output: '.tmp/contracts/content-lifecycle/content-lifecycle-observation.json',
    cacheFile: 'observations/content-lifecycle-observation.json',
    repositoryRootArgument: false,
    buildReceiptSchema: 'fsusblog.content-lifecycle-observation-build-receipt.v1'
  }
})
const cacheRelative = '.tmp/behavior-doc-contract-builds'

function hasExactKeys(value, keys) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function seal(value) {
  const receipt = { ...value, contentDigest: null }
  receipt.contentDigest = digestValue(receipt)
  return receipt
}

function safeSegment(value) {
  const raw = String(value ?? '')
  const normalized = raw.replace(/[^A-Za-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized !== raw) {
    throw new Error('minimal contract build requires a safe non-empty run id')
  }
  return normalized
}

function toolVersion(command, args, repositoryRoot, spawn = spawnSync) {
  const result = spawn(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000
  })
  if (result.status !== 0) {
    throw new Error(`${command} toolchain probe failed: ${String(result.stderr ?? '').trim()}`)
  }
  return String(result.stdout ?? '').trim()
}

function artifactDigest(repositoryRoot, relativePath) {
  return digestPath(repositoryRoot, relativePath)
}

function cachedArtifactPath(buildRoot, declaration) {
  return path.posix.join(buildRoot, declaration.cacheFile)
}

function processStartToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
    return fields[19] ?? null
  } catch {
    return null
  }
}

function lockOwnerIsAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0
    || typeof owner?.token !== 'string' || owner.token.length === 0) {
    return false
  }
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
  const currentStartToken = processStartToken(owner.pid)
  return owner.processStartToken == null
    || currentStartToken == null
    || owner.processStartToken === currentStartToken
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
}

function acquireBuildLock(cacheRoot, buildKey) {
  const locksRoot = path.join(cacheRoot, '.locks')
  const lockPath = path.join(locksRoot, `${buildKey}.lock`)
  fs.mkdirSync(locksRoot, { recursive: true })
  const owner = {
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    token: randomUUID()
  }

  while (true) {
    const candidate = path.join(locksRoot, `.candidate-${process.pid}-${randomUUID()}`)
    fs.mkdirSync(candidate)
    fs.writeFileSync(path.join(candidate, 'owner.json'), `${JSON.stringify(owner)}\n`)
    try {
      fs.renameSync(candidate, lockPath)
      break
    } catch (error) {
      fs.rmSync(candidate, { recursive: true, force: true })
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
    }

    let currentOwner = null
    try {
      currentOwner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'))
    } catch {
      // A valid owner directory is prepared completely before its atomic rename.
    }
    if (!lockOwnerIsAlive(currentOwner)) {
      const stalePath = path.join(locksRoot, `.stale-${buildKey}-${randomUUID()}`)
      try {
        fs.renameSync(lockPath, stalePath)
        fs.rmSync(stalePath, { recursive: true, force: true })
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'EEXIST'
          && error?.code !== 'ENOTEMPTY') {
          throw error
        }
      }
      continue
    }
    waitForLock()
  }

  return () => {
    try {
      const currentOwner = JSON.parse(
        fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')
      )
      if (currentOwner.token === owner.token) {
        fs.rmSync(lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

export function validateMinimalContractBuildReceipt(receipt, {
  expectedRunId = null,
  expectedSourceIdentity = null,
  repositoryRoot = null
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
  const artifactIds = Object.keys(receipt.artifacts ?? {}).sort()
  if (JSON.stringify(artifactIds) !== JSON.stringify(Object.keys(hostDeclarations).sort())) {
    throw new Error('minimal contract build artifact roster is incomplete')
  }
  for (const [artifactId, declaration] of Object.entries(hostDeclarations)) {
    const artifact = receipt.artifacts[artifactId]
    const expectedArtifactPath = cachedArtifactPath(receipt.buildRoot, declaration)
    const expectedArtifactKeys = artifactId === 'runtime-role-observation'
      ? [
          'project', 'projectDigest', 'path', 'artifactDigest', 'assemblyPath',
          'assemblyDigest', 'deploymentArtifactPath', 'deploymentArtifactDigest',
          'buildReceipt'
        ]
      : ['project', 'projectDigest', 'path', 'artifactDigest', 'buildReceipt']
    if (artifact?.project !== declaration.project
      || artifact?.path !== expectedArtifactPath
      || !hasExactKeys(artifact, expectedArtifactKeys)
      || !/^[a-f0-9]{64}$/u.test(artifact?.projectDigest ?? '')
      || !/^[a-f0-9]{64}$/u.test(artifact?.artifactDigest ?? '')) {
      throw new Error(`minimal contract build artifact ${artifactId} is invalid`)
    }
    const expectedReceiptKeys = artifactId === 'runtime-role-observation'
      ? [
          'schema', 'artifactId', 'artifactPath', 'artifactDigest', 'configuration',
          'sourceCommit', 'worktreeFingerprint', 'projectDigest', 'assemblyPath',
          'assemblyDigest', 'deploymentArtifactPath', 'deploymentArtifactDigest',
          'producer', 'externalOracle', 'externalOracleVersion',
          'effectiveComposeModelDigest',
          'deploymentAuthoritySchema', 'deploymentAuthorityContentDigest',
          'deploymentObservationDigest'
        ]
      : ['schema', 'artifactId', 'artifactPath', 'artifactDigest', 'configuration']
    if (!hasExactKeys(artifact.buildReceipt, expectedReceiptKeys)
      || artifact.buildReceipt.schema !== declaration.buildReceiptSchema
      || artifact.buildReceipt.artifactId !== artifactId
      || artifact.buildReceipt.artifactPath !== declaration.output
      || artifact.buildReceipt.artifactDigest !== artifact.artifactDigest
      || artifact.buildReceipt.configuration !== 'Release') {
      throw new Error(`minimal contract build artifact ${artifactId} receipt is invalid`)
    }
    if (artifactId === 'runtime-role-observation'
      && (artifact.buildReceipt.deploymentAuthoritySchema !== 'fsusblog.monolithic-distributed-architecture.v2'
        || artifact.buildReceipt.sourceCommit !== receipt.sourceCommit
        || artifact.buildReceipt.worktreeFingerprint !== receipt.worktreeFingerprint
        || artifact.buildReceipt.projectDigest !== artifact.projectDigest
        || artifact.buildReceipt.assemblyPath !== artifact.assemblyPath
        || artifact.buildReceipt.assemblyDigest !== artifact.assemblyDigest
        || artifact.buildReceipt.deploymentArtifactPath !== artifact.deploymentArtifactPath
        || artifact.buildReceipt.deploymentArtifactDigest !== artifact.deploymentArtifactDigest
        || artifact.buildReceipt.producer !== 'dotnet-run-content-addressed-minimal-contract-host'
        || artifact.buildReceipt.externalOracle !== 'docker-compose-config-json-no-interpolate'
        || typeof artifact.buildReceipt.externalOracleVersion !== 'string'
        || artifact.buildReceipt.externalOracleVersion.length === 0
        || !/^sha256:[a-f0-9]{64}$/u.test(artifact.buildReceipt.effectiveComposeModelDigest ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(artifact.buildReceipt.deploymentAuthorityContentDigest ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(artifact.buildReceipt.deploymentObservationDigest ?? ''))) {
      throw new Error('minimal contract build runtime-role deployment receipt is incomplete')
    }
    if (repositoryRoot !== null
      && (artifactDigest(repositoryRoot, artifact.project) !== artifact.projectDigest
        || artifactDigest(repositoryRoot, artifact.path) !== artifact.artifactDigest
        || (artifactId === 'runtime-role-observation'
          && (artifactDigest(repositoryRoot, artifact.assemblyPath) !== artifact.assemblyDigest
            || artifactDigest(repositoryRoot, artifact.deploymentArtifactPath)
              !== artifact.deploymentArtifactDigest)))) {
      throw new Error(`minimal contract build artifact ${artifactId} digest mismatch`)
    }
  }
  return receipt
}

export function buildIdentitiesFromMinimalReceipt(receipt) {
  validateMinimalContractBuildReceipt(receipt)
  return Object.fromEntries(Object.entries(receipt.artifacts).map(([artifactId, artifact]) => {
    const declaration = hostDeclarations[artifactId]
    if (declaration == null) throw new Error(`minimal contract build has unknown artifact ${artifactId}`)
    return [
      artifactId,
      artifactId === 'runtime-role-observation' ? {
        artifactId,
        receiptDigest: digestValue(artifact.buildReceipt),
        artifactDigest: artifact.artifactDigest,
        sourceCommit: receipt.sourceCommit,
        worktreeFingerprint: receipt.worktreeFingerprint,
        buildKey: receipt.buildKey,
        minimalReceiptPath: `${receipt.buildRoot}/receipts/${safeSegment(receipt.runId)}.json`,
        minimalReceiptDigest: receipt.contentDigest,
        artifactPath: artifact.path,
        assemblyPath: artifact.assemblyPath,
        assemblyDigest: artifact.assemblyDigest,
        deploymentArtifactPath: artifact.deploymentArtifactPath,
        deploymentArtifactDigest: artifact.deploymentArtifactDigest
      } : {
        artifactId,
        receiptDigest: digestValue(artifact.buildReceipt),
        artifactDigest: artifact.artifactDigest
      }
    ]
  }))
}

function reusableReceipt({
  buildRoot,
  buildKey,
  repositoryRoot,
  sourceIdentity,
  sourceClosureDigests,
  toolchain
}) {
  const receiptFile = path.join(buildRoot, 'receipt.json')
  if (!fs.existsSync(receiptFile)) return null
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    validateMinimalContractBuildReceipt(receipt, {
      expectedSourceIdentity: sourceIdentity,
      repositoryRoot
    })
    if (receipt.buildKey !== buildKey
      || digestValue(receipt.toolchain) !== digestValue(toolchain)
      || digestValue(receipt.sourceClosureDigests) !== digestValue(sourceClosureDigests)) {
      return null
    }
    return receipt
  } catch {
    return null
  }
}

function bindReceiptToRun(receipt, runId) {
  if (receipt.runId === runId) return receipt
  return seal({
    ...receipt,
    runId
  })
}

function publishCanonicalObservations(repositoryRoot, receipt) {
  for (const [artifactId, declaration] of Object.entries(hostDeclarations)) {
    const artifact = receipt.artifacts[artifactId]
    const source = path.join(repositoryRoot, artifact.path)
    if (artifactDigest(repositoryRoot, artifact.path) !== artifact.artifactDigest) {
      throw new Error(`minimal contract build artifact ${artifactId} changed before consumption`)
    }
    const destination = path.join(repositoryRoot, declaration.output)
    const temporary = `${destination}.next-${process.pid}-${randomUUID()}`
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, temporary)
    fs.renameSync(temporary, destination)
    if (artifactDigest(repositoryRoot, declaration.output) !== artifact.artifactDigest) {
      throw new Error(`minimal contract build artifact ${artifactId} publish digest mismatch`)
    }
  }
}

export function runMinimalContractBuild({
  repositoryRoot,
  runId,
  sourceIdentity = sealSourceIdentity(repositoryRoot),
  spawn = spawnSync,
  hostTimeoutMs = 15 * 60_000
}) {
  const registry = loadRegistry(path.join(repositoryRoot, 'config/contracts/behavior-fact-extractors.json'))
  const compiled = registry.extractors.filter((extractor) => extractor.kind === 'compiled-assembly')
  const expectedArtifactIds = compiled.map((extractor) => extractor.requiredBuildArtifact).sort()
  const declaredArtifactIds = Object.keys(hostDeclarations).sort()
  if (JSON.stringify(expectedArtifactIds) !== JSON.stringify(declaredArtifactIds)) {
    throw new Error('minimal contract build host roster drifted from the extractor registry')
  }

  const dotnetVersion = toolVersion('dotnet', ['--version'], repositoryRoot, spawn)
  const toolchain = {
    dotnet: dotnetVersion,
    configuration: 'Release',
    targetFramework: 'net10.0'
  }
  const consumedInputs = compiled.flatMap((extractor) => extractor.consumedInputs)
  const sourceClosureDigests = computeConsumedInputDigests(repositoryRoot, [
    ...consumedInputs,
    ...Object.values(hostDeclarations).map((entry) => entry.project),
    'config/contracts/behavior-fact-extractors.json',
    'Directory.Build.props',
    'Directory.Packages.props',
    'FsusBlog.slnx',
    'src/backend/FsusBlog.Server.csproj',
    'src/core/FsusBlog.Core.csproj',
    'src/shared/FsusBlog.Shared.csproj'
  ])
  const buildKey = digestValue({
    sourceIdentity,
    toolchain,
    sourceClosureDigests
  })
  const buildRoot = path.join(
    repositoryRoot,
    cacheRelative,
    buildKey
  )
  const cacheRoot = path.join(repositoryRoot, cacheRelative)
  const normalizedRunId = safeSegment(runId)
  const releaseLock = acquireBuildLock(cacheRoot, buildKey)
  let publishedReceipt
  let cacheHit = false
  let stagingRoot = null
  try {
    publishedReceipt = reusableReceipt({
      buildRoot,
      buildKey,
      repositoryRoot,
      sourceIdentity,
      sourceClosureDigests,
      toolchain
    })
    if (publishedReceipt) {
      cacheHit = true
    } else {
      fs.rmSync(buildRoot, { recursive: true, force: true })
      const stagingParent = path.join(cacheRoot, '.staging')
      fs.mkdirSync(stagingParent, { recursive: true })
      stagingRoot = path.join(
        stagingParent,
        `${buildKey}-${normalizedRunId}-${process.pid}-${randomUUID()}`
      )
      fs.mkdirSync(stagingRoot)

      const artifacts = {}
      const deploymentObservation = observeRuntimeRoleDeploymentAuthority({ root: repositoryRoot })
      if (!deploymentObservation.ownership?.claimEligible) {
        throw new Error(
          `minimal contract runtime-role deployment authority is not claim eligible: ${(deploymentObservation.ownership?.failureReasons ?? []).join('; ')}`
        )
      }
      for (const artifactId of declaredArtifactIds) {
        const declaration = hostDeclarations[artifactId]
        const stagedOutput = path.join(stagingRoot, declaration.cacheFile)
        fs.mkdirSync(path.dirname(stagedOutput), { recursive: true })
        const applicationArgs = ['--output', stagedOutput]
        if (artifactId === 'runtime-role-observation') {
          const deploymentOutput = path.join(
            stagingRoot,
            'observations/runtime-role-deployment-observation.json'
          )
          fs.mkdirSync(path.dirname(deploymentOutput), { recursive: true })
          fs.writeFileSync(deploymentOutput, `${JSON.stringify(deploymentObservation, null, 2)}\n`)
          applicationArgs.push('--deployment-observation', deploymentOutput)
        }
        if (declaration.repositoryRootArgument) {
          applicationArgs.push('--repository-root', repositoryRoot)
        }
        const args = [
          'run',
          '--project', declaration.project,
          '--configuration', 'Release',
          '--no-launch-profile',
          '--no-cache',
          '--disable-build-servers',
          '--artifacts-path', path.join(stagingRoot, 'artifacts'),
          '--',
          ...applicationArgs
        ]
        const result = spawn('dotnet', args, {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            DOTNET_NOLOGO: 'true',
            DOTNET_SKIP_FIRST_TIME_EXPERIENCE: 'true',
            MSBUILDDISABLENODEREUSE: '1'
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
          timeout: hostTimeoutMs
        })
        if (result.status !== 0) {
          const stderr = String(result.stderr ?? '').trim()
          const stdout = String(result.stdout ?? '').trim()
          const reason = result.error?.code === 'ETIMEDOUT'
            ? `timed out after ${hostTimeoutMs}ms`
            : stderr || stdout || `exit ${result.status}`
          throw new Error(
            `minimal contract host ${artifactId} failed: ${reason}`
          )
        }
        if (!fs.existsSync(stagedOutput)) {
          throw new Error(`minimal contract host ${artifactId} produced no observation`)
        }
        const artifactBytes = fs.readFileSync(stagedOutput, 'utf8')
        const artifactObservation = JSON.parse(artifactBytes)
        if (artifactId === 'runtime-role-observation'
          && (artifactObservation.schema !== 'fsusblog.runtime-role-observation.v2'
            || artifactObservation.deploymentAuthority?.authoritySchema
              !== deploymentObservation.authoritySchema
            || artifactObservation.deploymentAuthority?.authorityContentDigest
              !== deploymentObservation.authorityContentDigest
            || artifactObservation.deploymentAuthority?.observationDigest
              !== deploymentObservation.observationDigest)) {
          throw new Error('minimal contract runtime-role observation did not bind deployment authority')
        }
        const artifactDigestValue = digestPath(stagingRoot, declaration.cacheFile)
        const projectDigestValue = artifactDigest(repositoryRoot, declaration.project)
        const assemblyPath = artifactId === 'runtime-role-observation'
          ? path.posix.join(path.posix.join(cacheRelative, buildKey), declaration.assemblyFile)
          : null
        const assemblyDigest = artifactId === 'runtime-role-observation'
          ? digestPath(stagingRoot, declaration.assemblyFile)
          : null
        const deploymentArtifactPath = artifactId === 'runtime-role-observation'
          ? path.posix.join(
              path.posix.join(cacheRelative, buildKey),
              'observations/runtime-role-deployment-observation.json'
            )
          : null
        const deploymentArtifactDigest = artifactId === 'runtime-role-observation'
          ? digestPath(stagingRoot, 'observations/runtime-role-deployment-observation.json')
          : null
        const buildReceipt = {
          schema: declaration.buildReceiptSchema,
          artifactId,
          artifactPath: declaration.output,
          artifactDigest: artifactDigestValue,
          configuration: 'Release',
          ...(artifactId === 'runtime-role-observation'
            ? {
                sourceCommit: sourceIdentity.sourceCommit,
                worktreeFingerprint: sourceIdentity.worktreeFingerprint,
                projectDigest: projectDigestValue,
                assemblyPath,
                assemblyDigest,
                deploymentArtifactPath,
                deploymentArtifactDigest,
                producer: 'dotnet-run-content-addressed-minimal-contract-host',
                externalOracle: artifactObservation.deploymentAuthority?.effectiveCompose?.oracle,
                externalOracleVersion: artifactObservation.deploymentAuthority?.effectiveCompose?.oracleVersion,
                effectiveComposeModelDigest: artifactObservation.deploymentAuthority?.effectiveCompose?.modelDigest,
                deploymentAuthoritySchema: artifactObservation.deploymentAuthority?.authoritySchema,
                deploymentAuthorityContentDigest: artifactObservation.deploymentAuthority?.authorityContentDigest,
                deploymentObservationDigest: artifactObservation.deploymentAuthority?.observationDigest
              }
            : {})
        }
        artifacts[artifactId] = {
          project: declaration.project,
          projectDigest: projectDigestValue,
          path: cachedArtifactPath(
            path.posix.join(cacheRelative, buildKey),
            declaration
          ),
          artifactDigest: artifactDigestValue,
          ...(artifactId === 'runtime-role-observation'
            ? {
                assemblyPath,
                assemblyDigest,
                deploymentArtifactPath,
                deploymentArtifactDigest
              }
            : {}),
          buildReceipt
        }
      }

      publishedReceipt = seal({
        schema: minimalContractBuildSchema,
        runId: normalizedRunId,
        sourceCommit: sourceIdentity.sourceCommit,
        worktreeFingerprint: sourceIdentity.worktreeFingerprint,
        toolchain,
        buildKey,
        buildRoot: path.posix.join(cacheRelative, buildKey),
        sourceClosureDigests,
        artifacts,
        status: 'ok',
        failureReasons: []
      })
      fs.writeFileSync(
        path.join(stagingRoot, 'receipt.json'),
        `${JSON.stringify(publishedReceipt, null, 2)}\n`
      )
      fs.renameSync(stagingRoot, buildRoot)
      stagingRoot = null
      validateMinimalContractBuildReceipt(publishedReceipt, {
        expectedRunId: normalizedRunId,
        expectedSourceIdentity: sourceIdentity,
        repositoryRoot
      })
    }
  } finally {
    if (stagingRoot !== null) {
      fs.rmSync(stagingRoot, { recursive: true, force: true })
    }
    releaseLock()
  }

  const receipt = bindReceiptToRun(publishedReceipt, normalizedRunId)
  validateMinimalContractBuildReceipt(receipt, {
    expectedRunId: normalizedRunId,
    expectedSourceIdentity: sourceIdentity,
    repositoryRoot
  })
  publishCanonicalObservations(repositoryRoot, receipt)
  const receiptFile = path.join(buildRoot, 'receipts', `${normalizedRunId}.json`)
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true })
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
  return {
    receipt,
    receiptFile,
    buildIdentities: buildIdentitiesFromMinimalReceipt(receipt),
    cacheHit
  }
}

export { hostDeclarations }
