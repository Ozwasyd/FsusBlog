import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildIdentitySchema,
  computeConsumedInputDigests,
  digestPath,
  digestValue,
  sealSourceIdentity
} from '../fact-extractors/identity.mjs'
import { loadRegistry } from '../fact-extractors/registry.mjs'

import {
  minimalContractBuildSchema,
  minimalContractBuildHostDeclarations as hostDeclarations,
  validateMinimalContractBuildReceipt as validateMinimalContractBuildReceiptContract
} from './behavior-doc-minimal-contract-build-contract.mjs'
export { minimalContractBuildSchema } from './behavior-doc-minimal-contract-build-contract.mjs'

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

export function validateMinimalContractBuildReceipt(receipt, options = {}) {
  return validateMinimalContractBuildReceiptContract(receipt, {
    ...options,
    readArtifactDigest: artifactDigest
  })
}

export function buildIdentitiesFromMinimalReceipt(receipt) {
  validateMinimalContractBuildReceipt(receipt)
  return Object.fromEntries(Object.entries(receipt.artifacts).map(([artifactId, artifact]) => {
    if (hostDeclarations[artifactId] == null) throw new Error(`minimal contract build has unknown artifact ${artifactId}`)
    const sourceDigests = structuredClone(receipt.sourceClosureDigests)
    return [
      artifactId,
      {
        schema: buildIdentitySchema,
        artifactId,
        receiptDigest: receipt.contentDigest,
        artifactDigest: artifact.artifactDigest,
        sourceDigests,
        sourceDigest: receipt.sourceDigest ?? digestValue(sourceDigests)
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
      || digestValue(receipt.sourceClosureDigests) !== digestValue(sourceClosureDigests)
      || receipt.sourceDigest !== digestValue(sourceClosureDigests)) {
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
      for (const artifactId of declaredArtifactIds) {
        const declaration = hostDeclarations[artifactId]
        const stagedOutput = path.join(stagingRoot, declaration.cacheFile)
        fs.mkdirSync(path.dirname(stagedOutput), { recursive: true })
        const applicationArgs = ['--output', stagedOutput]
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
        artifacts[artifactId] = {
          project: declaration.project,
          projectDigest: artifactDigest(repositoryRoot, declaration.project),
          path: cachedArtifactPath(
            path.posix.join(cacheRelative, buildKey),
            declaration
          ),
          artifactPath: declaration.output,
          artifactDigest: digestPath(stagingRoot, declaration.cacheFile)
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
        sourceDigest: digestValue(sourceClosureDigests),
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
  const receiptFile = path.join(buildRoot, 'receipt.json')
  const identityReceiptFile = path.join(buildRoot, 'receipts', `${normalizedRunId}.json`)
  fs.mkdirSync(path.dirname(identityReceiptFile), { recursive: true })
  fs.writeFileSync(identityReceiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
  return {
    receipt,
    receiptFile,
    identityReceiptFile,
    buildIdentities: buildIdentitiesFromMinimalReceipt(receipt),
    cacheHit
  }
}

export { hostDeclarations }
