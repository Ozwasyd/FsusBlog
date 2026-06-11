#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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

  return errors
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-release-final-'))
  const jobs = path.join(tmp, 'job-summaries')
  fs.mkdirSync(jobs, { recursive: true })
  const commit = '0123456789abcdef0123456789abcdef01234567'
  fs.writeFileSync(path.join(jobs, 'fast.json'), JSON.stringify({
    schema: 'fsusblog.ci.job-result.v1',
    jobId: 'fast',
    status: 'success',
    commit
  }))
  const manifestFile = path.join(tmp, 'manifest.json')
  const manifest = {
    status: 'collected-ok',
    commitSha: commit,
    imageDigest: 'sha256:abc',
    artifacts: { jobSummaries: 'job-summaries', visualGateSkip: null },
    artifactDigests: { productionExposureLive: { algorithm: 'sha256', value: 'a'.repeat(64) } },
    evidenceSummary: {
      coverage: { status: 'ok' },
      gates: { visualGateSkip: null },
      externalExposure: { status: 'ok', firewallPolicy: 'present', liveExposure: 'ok' }
    }
  }
  const errors = validateManifest(manifest, manifestFile)
  fs.rmSync(tmp, { recursive: true, force: true })
  if (errors.length > 0) fail([`self-test expected pass: ${errors.join('; ')}`])
  console.log('[release-final] self-test ok')
}

const args = process.argv.slice(2)
if (args.includes('--self-test')) {
  runSelfTest()
  process.exit(0)
}

const manifestArg = args.find((arg) => !arg.startsWith('--'))
const manifestFile = manifestArg ? path.resolve(manifestArg) : latestManifest()
if (!manifestFile) fail(['manifest path is required or .tmp/release-evidence must contain a manifest'])

const errors = validateManifest(readJson(manifestFile), manifestFile)
if (errors.length > 0) fail(errors)
console.log(`[release-final] ok file=${path.relative(root, manifestFile)}`)
