#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { loadPublicPreviewRegistry } from './public-preview-registry.mjs'
import {
  createPublicPreviewQualityMatrix,
  qualitySidecarFile,
  validatePublicPreviewQualityMatrix,
  validatePublicPreviewQualityReport
} from './public-preview-quality.mjs'

export const publicPreviewQualityManifestSchema = 'fsusblog.public-preview-quality-manifest.v1'
export const publicPreviewQualityManifestName = 'public-preview-quality.json'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const managedPublicPreviewQualityFile = path.join(root, 'docs/assets/visual-evidence', publicPreviewQualityManifestName)

function stableJson(value) {
  return `${JSON.stringify(value, null, 4)}\n`
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function qualityPolicyDigest(registry) {
  return digest(stableJson({ policy: registry.qualityPolicy, scenarios: registry.qualityScenarios }))
}

export function createPublicPreviewQualityManifest(captureDirectory, sourceCommit, rootDirectory = root) {
  const registry = loadPublicPreviewRegistry(rootDirectory)
  const reports = registry.screenshots.map((entry) => {
    const file = qualitySidecarFile(captureDirectory, entry.file)
    if (!fs.existsSync(file)) throw new Error(`public-preview quality sidecar missing: ${entry.file}`)
    const report = readJson(file)
    const errors = validatePublicPreviewQualityReport(report, { ...entry, viewport: entry.qualityViewport }, registry.qualityPolicy)
    if (errors.length > 0) throw new Error(`${entry.id}: ${errors.join('; ')}`)
    return report
  })
  const matrixFile = path.join(captureDirectory, 'quality-matrix.json')
  if (!fs.existsSync(matrixFile)) throw new Error('public-preview quality matrix missing')
  const matrix = readJson(matrixFile)
  const matrixErrors = validatePublicPreviewQualityMatrix(matrix, registry.qualityScenarios, registry.qualityPolicy)
  if (matrixErrors.length > 0) throw new Error(matrixErrors.join('; '))
  const policyDigest = qualityPolicyDigest(registry)
  const normalizedMatrix = createPublicPreviewQualityMatrix(matrix.reports, policyDigest)
  const status = reports.some((report) => report.status === 'fail') || normalizedMatrix.status === 'fail'
    ? 'fail'
    : reports.some((report) => report.status === 'needs-design-review') || normalizedMatrix.status === 'needs-design-review'
      ? 'needs-design-review'
      : 'pass'
  return {
    schema: publicPreviewQualityManifestSchema,
    status,
    sourceCommit,
    policyDigest,
    screenshots: Object.fromEntries(reports.map((report) => [report.id, report])),
    matrix: normalizedMatrix
  }
}

export function writePublicPreviewQualityManifest(
  captureDirectory,
  sourceCommit,
  rootDirectory = root,
  outputFile = path.join(captureDirectory, publicPreviewQualityManifestName)
) {
  const manifest = createPublicPreviewQualityManifest(captureDirectory, sourceCommit, rootDirectory)
  if (manifest.status !== 'pass') throw new Error(`public-preview quality publication is ${manifest.status}`)
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  fs.writeFileSync(outputFile, stableJson(manifest))
  const registry = loadPublicPreviewRegistry(rootDirectory)
  for (const entry of registry.screenshots) fs.rmSync(qualitySidecarFile(captureDirectory, entry.file), { force: true })
  fs.rmSync(path.join(captureDirectory, 'quality-matrix.json'), { force: true })
  return manifest
}

export function validatePublicPreviewQualityManifest(file, rootDirectory = root, { requirePass = true } = {}) {
  const errors = []
  const registry = loadPublicPreviewRegistry(rootDirectory)
  if (!fs.existsSync(file)) return ['public-preview quality manifest missing']
  const manifest = readJson(file)
  if (manifest.schema !== publicPreviewQualityManifestSchema) errors.push('public-preview quality manifest schema')
  if (!/^[a-f0-9]{40}$/u.test(String(manifest.sourceCommit ?? ''))) errors.push('public-preview quality source commit')
  if (manifest.policyDigest !== qualityPolicyDigest(registry)) errors.push('public-preview quality policy digest')
  const screenshotIds = Object.keys(manifest.screenshots ?? {}).sort()
  const expectedScreenshotIds = registry.screenshots.map((entry) => entry.id).sort()
  if (JSON.stringify(screenshotIds) !== JSON.stringify(expectedScreenshotIds)) errors.push('public-preview quality screenshot ids')
  for (const entry of registry.screenshots) {
    errors.push(...validatePublicPreviewQualityReport(
      manifest.screenshots?.[entry.id],
      { ...entry, viewport: entry.qualityViewport },
      registry.qualityPolicy
    ).map((error) => `${entry.id}: ${error}`))
  }
  errors.push(...validatePublicPreviewQualityMatrix(manifest.matrix, registry.qualityScenarios, registry.qualityPolicy))
  if (manifest.matrix?.policyDigest !== manifest.policyDigest) errors.push('public-preview quality matrix policy digest')
  if (requirePass && manifest.status !== 'pass') errors.push(`public-preview quality manifest status=${manifest.status}`)
  return errors
}

export function comparePublicPreviewQualityManifests(actualFile, committedFile, evidenceFile, rootDirectory = root) {
  const errors = [
    ...validatePublicPreviewQualityManifest(actualFile, rootDirectory).map((error) => `captured: ${error}`),
    ...validatePublicPreviewQualityManifest(committedFile, rootDirectory).map((error) => `committed: ${error}`)
  ]
  if (fs.existsSync(actualFile) && fs.existsSync(committedFile)
      && digest(fs.readFileSync(actualFile)) !== digest(fs.readFileSync(committedFile))) {
    errors.push('captured public-preview quality manifest differs from committed quality manifest')
  }
  const evidence = fs.existsSync(evidenceFile) ? readJson(evidenceFile) : {}
  const quality = fs.existsSync(committedFile) ? readJson(committedFile) : null
  evidence.qualityAudit = errors.length === 0
  evidence.qualityPolicyDigest = quality?.policyDigest ?? null
  evidence.quality = quality
  if (errors.length > 0) evidence.status = 'failed'
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true })
  fs.writeFileSync(evidenceFile, stableJson(evidence))
  return { errors, evidence }
}

export function publishPublicPreviewQualityManifest(stagedFile, committedFile = managedPublicPreviewQualityFile, rootDirectory = root) {
  const errors = validatePublicPreviewQualityManifest(stagedFile, rootDirectory)
  if (errors.length > 0) throw new Error(errors.join('; '))
  fs.mkdirSync(path.dirname(committedFile), { recursive: true })
  const temporary = `${committedFile}.tmp-${process.pid}`
  fs.copyFileSync(stagedFile, temporary)
  fs.renameSync(temporary, committedFile)
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  const result = {
    command,
    captureDirectory: null,
    sourceCommit: null,
    file: null,
    committedFile: managedPublicPreviewQualityFile,
    evidenceFile: null
  }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (key === '--capture-dir') result.captureDirectory = path.resolve(value)
    else if (key === '--source-commit') result.sourceCommit = value
    else if (key === '--file') result.file = path.resolve(value)
    else if (key === '--committed-file') result.committedFile = path.resolve(value)
    else if (key === '--evidence') result.evidenceFile = path.resolve(value)
    else throw new Error(`unknown public-preview quality argument: ${key}`)
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2))
  if (args.command === 'generate') {
    if (!args.captureDirectory || !args.file) throw new Error('--capture-dir and --file are required')
    writePublicPreviewQualityManifest(args.captureDirectory, args.sourceCommit, root, args.file)
  } else if (args.command === 'check') {
    if (!args.file) throw new Error('--file is required')
    const errors = validatePublicPreviewQualityManifest(args.file)
    if (errors.length > 0) throw new Error(errors.join('; '))
  } else if (args.command === 'compare') {
    if (!args.file || !args.evidenceFile) throw new Error('--file and --evidence are required')
    const result = comparePublicPreviewQualityManifests(args.file, args.committedFile, args.evidenceFile)
    if (result.errors.length > 0) throw new Error(result.errors.join('; '))
  } else if (args.command === 'publish') {
    if (!args.file) throw new Error('--file is required')
    publishPublicPreviewQualityManifest(args.file, args.committedFile)
  } else throw new Error('command must be generate, check, compare, or publish')
}
