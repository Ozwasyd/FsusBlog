#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { validateReleaseManifest } from './release-manifest.mjs'
import { validateReleaseRuntimeMatrix } from '../runtime-profiles/release-runtime-matrix.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))

function fail(errors) {
  for (const error of errors) console.error(`[release-final] ${error}`)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function latestManifest() {
  const baseDir = path.join(root, '.tmp/release-evidence')
  if (!fs.existsSync(baseDir)) return null
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name, 'manifest.json'))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file ?? null
}

function artifactPath(manifestFile, artifact) {
  if (!artifact || artifact === 'null') return null
  return path.resolve(path.dirname(manifestFile), artifact)
}

function listJsonFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return []
  const files = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(file)
      else if (entry.name.endsWith('.json')) files.push(file)
    }
  }
  return files.sort()
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateReleaseResourceSummary(summary, artifactKey) {
  const errors = []
  if (!summary || typeof summary !== 'object') {
    return [`${artifactKey} release resource summary is missing`]
  }

  if (summary.status !== 'ok') {
    errors.push(`${artifactKey}.status must be ok, got ${summary.status}`)
  }

  if (!Array.isArray(summary.metrics) || summary.metrics.length === 0) {
    errors.push(`${artifactKey}.metrics must be non-empty`)
  }

  const unavailable = Array.isArray(summary.unavailableMetrics) ? summary.unavailableMetrics : []
  for (const [index, item] of unavailable.entries()) {
    if (!item || typeof item.reason !== 'string' || item.reason.length === 0) {
      errors.push(`${artifactKey}.unavailableMetrics[${index}].reason missing`)
    }
  }

  let okMetricCount = 0
  for (const [index, metric] of (summary.metrics ?? []).entries()) {
    const label = `${artifactKey}.metrics[${index}]`
    if (!metric || typeof metric !== 'object') {
      errors.push(`${label} must be an object`)
      continue
    }
    if (typeof metric.name !== 'string' || metric.name.length === 0) errors.push(`${label}.name missing`)
    for (const field of ['startValue', 'endValue', 'maxValue', 'delta', 'threshold']) {
      if (!isFiniteNumber(metric[field])) errors.push(`${label}.${field} must be a finite number`)
    }
    if (metric.status !== 'ok') {
      errors.push(`${label}.status must be ok, got ${metric.status}`)
    } else {
      okMetricCount += 1
    }
    if (metric.thresholdOperator !== '<=') errors.push(`${label}.thresholdOperator must be <=`)
    if (metric.thresholdField !== 'delta') errors.push(`${label}.thresholdField must be delta`)
    if (isFiniteNumber(metric.delta) && isFiniteNumber(metric.threshold) && metric.delta > metric.threshold) {
      errors.push(`${label}.delta ${metric.delta} exceeds threshold ${metric.threshold}`)
    }
  }

  if (okMetricCount === 0) {
    errors.push(`${artifactKey} must include at least one passing resource metric`)
  }

  return errors
}

function validateManifest(manifest, manifestFile) {
  const errors = []
  if (manifest.status !== 'collected-ok') errors.push(`release-final requires collected-ok, got ${manifest.status}`)
  if (!/^[0-9a-f]{40}$/i.test(String(manifest.commitSha ?? ''))) errors.push('commitSha must be a full 40-character SHA')
  if (!/^sha256:[A-Za-z0-9._~:+/-]+$/u.test(String(manifest.imageDigest ?? ''))) errors.push('imageDigest must be a concrete sha256 digest')
  if (manifest.artifacts?.visualGateSkip !== null) errors.push('visual skip evidence cannot produce a release-final pass')
  if (manifest.evidenceSummary?.gates?.visualGateSkip !== null) errors.push('visualGateSkip summary must be null for release-final')
  if (manifest.evidenceSummary?.externalExposure?.liveExposure !== 'ok') errors.push('live production exposure evidence is required')
  if (manifest.evidenceSummary?.externalExposure?.status !== 'ok') errors.push('production exposure status must be ok')
  if (manifest.evidenceSummary?.externalExposure?.firewallPolicy !== 'present') errors.push('firewall policy evidence is required')
  if (manifest.evidenceSummary?.coverage?.status !== 'ok') errors.push('coverage evidence must be ok')

  const identity = manifest.releaseIdentity
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    errors.push('releaseIdentity is required')
  } else {
    const { releaseSlot, ...releaseManifest } = identity
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(String(releaseSlot ?? ''))) errors.push('releaseIdentity.releaseSlot is invalid')
    errors.push(...validateReleaseManifest(releaseManifest, {
      requireRegistryDigest: true,
      requireConcreteRuntimeProfile: true,
      expectedCommitSha: manifest.commitSha,
      expectedImageDigest: manifest.imageDigest
    }).map((error) => `releaseIdentity: ${error}`))
  }
  errors.push(...validateReleaseRuntimeMatrix(manifest, manifestFile))

  for (const [key, digest] of Object.entries(manifest.artifactDigests ?? {})) {
    if (!digest || digest.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/i.test(String(digest.value ?? ''))) {
      errors.push(`artifactDigests.${key} must include a sha256 digest`)
    }
  }

  const jobSummaryDir = artifactPath(manifestFile, manifest.artifacts?.jobSummaries)
  const jobSummaries = listJsonFiles(jobSummaryDir)
  if (jobSummaries.length === 0) {
    errors.push('job summary artifact is missing or empty')
  }
  for (const file of jobSummaries) {
    const summary = readJson(file)
    if (summary.schema !== 'fsusblog.ci.job-result.v1') continue
    if (summary.status !== 'success') errors.push(`${path.relative(root, file)} must be success, got ${summary.status}`)
    if (summary.commit !== manifest.commitSha) {
      errors.push(`${path.relative(root, file)} commit ${summary.commit} does not match manifest ${manifest.commitSha}`)
    }
  }

  for (const artifactKey of ['memoryLeakSummary', 'openHandleSummary']) {
    const file = artifactPath(manifestFile, manifest.artifacts?.[artifactKey])
    if (!file || !fs.existsSync(file)) {
      errors.push(`${artifactKey} release resource summary artifact is required`)
      continue
    }
    errors.push(...validateReleaseResourceSummary(readJson(file), artifactKey))
  }

  return errors
}

async function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-release-final-'))
  const jobs = path.join(tmp, 'job-summaries')
  fs.mkdirSync(jobs, { recursive: true })
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const releaseId = '20260715010101-0123456789ab'
  const imageDigest = `sha256:${'a'.repeat(64)}`
  const profileManifestDigest = `sha256:${'6'.repeat(64)}`
  const profileDigest = `sha256:${'7'.repeat(64)}`
  fs.writeFileSync(path.join(jobs, 'fast.json'), JSON.stringify({
    schema: 'fsusblog.ci.job-result.v1',
    jobId: 'fast',
    status: 'success',
    commit
  }))
  const validResourceSummary = {
    status: 'ok',
    mode: 'memory-leak',
    metrics: [{
      name: 'backend_rss_bytes',
      startValue: 100,
      endValue: 104,
      maxValue: 104,
      delta: 4,
      threshold: 64,
      thresholdOperator: '<=',
      thresholdField: 'delta',
      status: 'ok'
    }],
    unavailableMetrics: []
  }
  fs.writeFileSync(path.join(tmp, 'memory-leak-summary.json'), JSON.stringify(validResourceSummary))
  fs.writeFileSync(path.join(tmp, 'open-handle-summary.json'), JSON.stringify({
    ...validResourceSummary,
    mode: 'open-handle',
    metrics: [{
      ...validResourceSummary.metrics[0],
      name: 'backend_open_file_descriptors',
      threshold: 16
    }]
  }))
  const manifestFile = path.join(tmp, 'manifest.json')
  const { createReleaseRuntimeMatrixFixture } = await import('../../tests/tools/fixtures/release-runtime-matrix.mjs')
  const matrixEvidence = createReleaseRuntimeMatrixFixture({ commitSha: commit, profileManifestDigest, profileDigest })
  const matrixFile = path.join(tmp, 'runtime-publish-matrix.json')
  fs.writeFileSync(matrixFile, `${JSON.stringify(matrixEvidence)}\n`)
  const manifest = {
    status: 'collected-ok',
    commitSha: commit,
    imageDigest,
    releaseIdentity: {
      schema: 'fsusblog.release-manifest.v1',
      releaseId,
      commitSha: commit,
      imageRepository: 'ghcr.io/fsusblog/app',
      imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
      imageDigest,
      imageRef: `ghcr.io/fsusblog/app@${imageDigest}`,
      registryDigestVerified: true,
      createdAtUtc: '2026-07-15T01:01:01.000Z',
      frontendManifestHash: `sha256:${'b'.repeat(64)}`,
      wasmArtifactHash: `sha256:${'c'.repeat(64)}`,
      zkLocalReviewHash: `sha256:${'e'.repeat(64)}`,
      schemaCompatibility: { minRelease: releaseId, maxRelease: releaseId },
      toolchain: {
        dotnetVersion: '10.0.100',
        nodeVersion: 'v24.16.0',
        dockerVersion: '28.0.0',
        dockerfileDigest: `sha256:${'d'.repeat(64)}`
      },
      runtimeProfile: {
        id: 'throughput-musl',
        manifestDigest: profileManifestDigest,
        profileDigest,
        baseImageFamily: 'musl',
        targetRuntime: 'linux-musl-x64',
        singleFile: true,
        readyToRun: false,
        tieredPgo: true,
        quickJitForLoops: true,
        serverGc: true,
        nativeAot: false,
        threadPoolMode: 'runtime-default',
        topologyMode: 'smt-visible'
      },
      build: { dockerfile: 'ops/docker/FsusBlog.Server.Dockerfile', target: 'final' },
      releaseSlot: 'green'
    },
    artifacts: {
      jobSummaries: 'job-summaries',
      memoryLeakSummary: 'memory-leak-summary.json',
      openHandleSummary: 'open-handle-summary.json',
      runtimePublishMatrix: 'runtime-publish-matrix.json',
      visualGateSkip: null
    },
    artifactDigests: {
      productionExposureLive: { algorithm: 'sha256', value: 'a'.repeat(64) },
      runtimePublishMatrix: { algorithm: 'sha256', value: sha256Hex(matrixFile) }
    },
    evidenceSummary: {
      coverage: { status: 'ok' },
      gates: { visualGateSkip: null },
      externalExposure: { status: 'ok', firewallPolicy: 'present', liveExposure: 'ok' },
      operations: {
        runtimeTuning: {
          profile: { id: 'throughput-musl', manifestDigest: profileManifestDigest, profileDigest },
          runtimeMatrixEvidence: 'runtime-publish-matrix.json',
          runtimeMatrixStatus: 'ok'
        }
      }
    }
  }
  const errors = validateManifest(manifest, manifestFile)
  if (errors.length > 0) fail([`self-test expected pass: ${errors.join('; ')}`])

  const missingMatrix = structuredClone(manifest)
  missingMatrix.artifacts.runtimePublishMatrix = null
  if (!validateManifest(missingMatrix, manifestFile).some((error) => error.includes('runtimePublishMatrix'))) {
    fail(['self-test expected release-final to reject a missing runtime matrix'])
  }
  const unselected = structuredClone(matrixEvidence)
  unselected.selection = null
  fs.writeFileSync(matrixFile, `${JSON.stringify(unselected)}\n`)
  const unselectedManifest = structuredClone(manifest)
  unselectedManifest.artifactDigests.runtimePublishMatrix.value = sha256Hex(matrixFile)
  if (!validateManifest(unselectedManifest, manifestFile).some((error) => error.includes('sealed production selection'))) {
    fail(['self-test expected release-final to reject an unselected runtime matrix'])
  }

  const wrongCommit = structuredClone(matrixEvidence)
  wrongCommit.identity.commitSha = 'f'.repeat(40)
  fs.writeFileSync(matrixFile, `${JSON.stringify(wrongCommit)}\n`)
  const wrongCommitManifest = structuredClone(manifest)
  wrongCommitManifest.artifactDigests.runtimePublishMatrix.value = sha256Hex(matrixFile)
  if (!validateManifest(wrongCommitManifest, manifestFile).some((error) => error.includes('release commit'))) {
    fail(['self-test expected release-final to reject a runtime matrix from the wrong commit'])
  }
  fs.writeFileSync(matrixFile, `${JSON.stringify(matrixEvidence)}\n`)

  const wrongProfileDigest = structuredClone(manifest)
  wrongProfileDigest.releaseIdentity.runtimeProfile.profileDigest = `sha256:${'8'.repeat(64)}`
  wrongProfileDigest.evidenceSummary.operations.runtimeTuning.profile.profileDigest = wrongProfileDigest.releaseIdentity.runtimeProfile.profileDigest
  if (!validateManifest(wrongProfileDigest, manifestFile).some((error) => error.includes('release profile'))) {
    fail(['self-test expected release-final to reject a runtime matrix selected for another profile digest'])
  }

  const zeroDigest = structuredClone(manifest)
  zeroDigest.releaseIdentity.runtimeProfile.profileDigest = `sha256:${'0'.repeat(64)}`
  zeroDigest.evidenceSummary.operations.runtimeTuning.profile.profileDigest = zeroDigest.releaseIdentity.runtimeProfile.profileDigest
  if (!validateManifest(zeroDigest, manifestFile).some((error) => error.includes('zero digest'))) {
    fail(['self-test expected release-final to reject a zero runtime profile digest'])
  }

  fs.rmSync(tmp, { recursive: true, force: true })

  const resourceTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-release-resource-final-'))
  const resourceJobs = path.join(resourceTmp, 'job-summaries')
  fs.mkdirSync(resourceJobs, { recursive: true })
  fs.writeFileSync(path.join(resourceJobs, 'release-final.json'), JSON.stringify({
    schema: 'fsusblog.ci.job-result.v1',
    jobId: 'release-final',
    status: 'success',
    commit
  }))
  fs.writeFileSync(path.join(resourceTmp, 'memory-leak-summary.json'), JSON.stringify({
    status: 'ok',
    mode: 'memory-leak',
    metrics: []
  }))
  const resourceManifestFile = path.join(resourceTmp, 'manifest.json')
  const resourceMatrixFile = path.join(resourceTmp, 'runtime-publish-matrix.json')
  fs.writeFileSync(resourceMatrixFile, `${JSON.stringify(matrixEvidence)}\n`)
  const emptyResourceManifest = {
    ...manifest,
    artifactDigests: {
      ...manifest.artifactDigests,
      runtimePublishMatrix: { algorithm: 'sha256', value: sha256Hex(resourceMatrixFile) }
    },
    artifacts: {
      ...manifest.artifacts,
      jobSummaries: 'job-summaries',
      memoryLeakSummary: 'memory-leak-summary.json'
    }
  }
  const resourceErrors = validateManifest(emptyResourceManifest, resourceManifestFile)
  fs.rmSync(resourceTmp, { recursive: true, force: true })
  if (!resourceErrors.some((error) => error.includes('memoryLeakSummary'))) {
    fail(['self-test expected release-final to reject empty release resource metrics'])
  }
  console.log('[release-final] self-test ok')
}

function sha256Hex(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const args = process.argv.slice(2)
if (args.includes('--self-test')) {
  await runSelfTest()
  process.exit(0)
}

const manifestArg = args.find((arg) => !arg.startsWith('--'))
const manifestFile = manifestArg ? path.resolve(manifestArg) : latestManifest()
if (!manifestFile) fail(['manifest path is required or .tmp/release-evidence must contain a manifest'])

const errors = validateManifest(readJson(manifestFile), manifestFile)
if (errors.length > 0) fail(errors)
console.log(`[release-final] ok file=${path.relative(root, manifestFile)}`)
