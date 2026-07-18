#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { evidenceClassificationErrors } from './evidence-classification.mjs'

const HISTORICAL_ROOT = 'docs/reports/open-source-readiness/v1.1.0-public-preview'
const HISTORICAL_MANIFEST = `${HISTORICAL_ROOT}/snapshot-manifest.json`
const MATRIX_PATH = 'security/matrices/privacy-zk-comment.yml'
const REQUIRED_MATRIX_CLASSES = [
  'contract',
  'fixture',
  'implementation-attestation',
  'fresh-run-evidence',
  'release-closeout-evidence'
]
const STATIC_PATH_CLASSES = new Map([
  ['security/evidence-contracts/anonymous-credential-blind-issuance.json', 'implementation-attestation'],
  ['security/evidence-contracts/comment-author-mode-retirement.json', 'implementation-attestation'],
  ['security/evidence-contracts/public-revocation-distribution.json', 'implementation-attestation'],
  ['security/evidence-contracts/release-bundle-storage.json', 'contract'],
  ['tests/fixtures/evidence/anonymous-eligibility-anonymity-set.json', 'fixture']
])
const RELEASE_INDEX_KEYS = [
  'commitSha',
  'evidenceBundleSha256',
  'generatedAt',
  'imageDigest',
  'releaseId',
  'retentionDays',
  'schema',
  'status',
  'storageReference'
]
const HISTORICAL_BANNER = 'Historical snapshot — not current master evidence.'

function repoPath(value) {
  return value.replaceAll('\\', '/')
}

function walkFiles(root, relativeDirectory) {
  const files = []
  const visit = (relative) => {
    const absolute = path.join(root, relative)
    if (!fs.existsSync(absolute)) return
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = repoPath(path.join(relative, entry.name))
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(child)
      else files.push(child)
    }
  }
  visit(relativeDirectory)
  return files.sort()
}

function readJson(root, relative, errors) {
  const absolute = path.join(root, relative)
  if (!fs.existsSync(absolute)) {
    errors.push(`missing required evidence file: ${relative}`)
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'))
  } catch (error) {
    errors.push(`${relative} is not valid JSON: ${error.message}`)
    return null
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function checkStaticEvidence(root, errors) {
  for (const [relative, expectedClass] of STATIC_PATH_CLASSES) {
    const value = readJson(root, relative, errors)
    if (!value) continue
    for (const error of evidenceClassificationErrors(value, expectedClass)) {
      errors.push(`${relative}: ${error}`)
    }
    if (expectedClass === 'implementation-attestation' && Object.hasOwn(value, 'status')) {
      errors.push(`${relative}: top-level status is ambiguous; use implementationStatus`)
    }
  }

  for (const [directory, allowedClasses] of [
    ['security/evidence-contracts', new Set(['contract', 'implementation-attestation'])],
    ['tests/fixtures/evidence', new Set(['fixture'])]
  ]) {
    for (const relative of walkFiles(root, directory)) {
      if (!relative.endsWith('.json')) {
        errors.push(`${directory} may contain only classified JSON documents: ${relative}`)
        continue
      }
      const value = readJson(root, relative, errors)
      if (!value) continue
      if (!allowedClasses.has(value.evidenceClass)) {
        errors.push(`${relative}: evidenceClass ${String(value.evidenceClass)} is not owned by ${directory}`)
      }
      for (const error of evidenceClassificationErrors(value)) errors.push(`${relative}: ${error}`)
    }
  }

  const storage = readJson(root, 'security/evidence-contracts/release-bundle-storage.json', errors)
  if (storage) {
    if (storage.authority?.type !== 'github-actions-artifact'
      || storage.authority?.workflow !== '.github/workflows/release-evidence-storage.yml'
      || storage.authority?.immutableWithinWorkflowRun !== true
      || storage.authority?.overwriteAllowed !== false
      || storage.retention?.days !== 90
      || storage.releaseIndex?.generatedOnlyAfterRequireOk !== true
      || storage.releaseIndex?.bundleFetchAndDigestVerificationRequired !== true) {
      errors.push('release bundle storage contract must remain immutable, retained, and require --require-ok')
    }
  }
  const workflowPath = '.github/workflows/release-evidence-storage.yml'
  const workflowFile = path.join(root, workflowPath)
  if (!fs.existsSync(workflowFile)) {
    errors.push(`missing immutable storage workflow: ${workflowPath}`)
  } else {
    const workflow = fs.readFileSync(workflowFile, 'utf8')
    for (const token of [
      'workflow_call:',
      'target_environment:',
      'seal-release-evidence-bundle.mjs .tmp/release-evidence/storage-candidate --require-ok',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'retention-days: 90',
      'overwrite: false'
    ]) {
      if (!workflow.includes(token)) errors.push(`${workflowPath}: missing ${token}`)
    }
    if (/\n\s{2}(?:push|pull_request|schedule|workflow_dispatch):/u.test(workflow)) {
      errors.push(`${workflowPath}: storage authority must be reusable only and never auto-publish`)
    }
  }
}

function checkHistoricalSnapshot(root, errors) {
  const manifest = readJson(root, HISTORICAL_MANIFEST, errors)
  if (!manifest) return
  for (const error of evidenceClassificationErrors(manifest, 'historical-report')) {
    errors.push(`${HISTORICAL_MANIFEST}: ${error}`)
  }
  if (manifest.snapshotId !== 'v1.1.0-public-preview') {
    errors.push(`${HISTORICAL_MANIFEST}: snapshotId must remain v1.1.0-public-preview`)
  }
  if (manifest.currentMasterStatus !== 'not-asserted') {
    errors.push(`${HISTORICAL_MANIFEST}: currentMasterStatus must be not-asserted`)
  }
  if (!/^[0-9a-f]{40}$/u.test(String(manifest.repositoryRevision?.value ?? ''))
    || manifest.repositoryRevision?.scope !== 'secret-scan-recorded-revision') {
    errors.push(`${HISTORICAL_MANIFEST}: recorded revision and its limited scope are required`)
  }

  const markdown = walkFiles(root, HISTORICAL_ROOT).filter(file => file.endsWith('.md'))
  for (const relative of markdown) {
    const text = fs.readFileSync(path.join(root, relative), 'utf8')
    if (!text.includes(HISTORICAL_BANNER)) {
      errors.push(`${relative}: missing explicit historical snapshot banner`)
    }
  }

  const actual = walkFiles(root, HISTORICAL_ROOT)
    .filter(file => file !== HISTORICAL_MANIFEST)
    .map(file => path.posix.relative(HISTORICAL_ROOT, file))
    .sort()
  const declared = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  const declaredPaths = declared.map(item => item?.path).sort()
  if (JSON.stringify(actual) !== JSON.stringify(declaredPaths)) {
    errors.push(`${HISTORICAL_MANIFEST}: artifact inventory must exactly match the retained snapshot`)
  }
  for (const item of declared) {
    if (!item || typeof item.path !== 'string' || item.path.includes('..')) {
      errors.push(`${HISTORICAL_MANIFEST}: artifact path must be repository-local`)
      continue
    }
    const absolute = path.join(root, HISTORICAL_ROOT, item.path)
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      errors.push(`${HISTORICAL_MANIFEST}: missing regular artifact ${item.path}`)
      continue
    }
    if (item.bytes !== stat.size) errors.push(`${HISTORICAL_MANIFEST}: byte count drift for ${item.path}`)
    if (item.sha256 !== `sha256:${sha256File(absolute)}`) {
      errors.push(`${HISTORICAL_MANIFEST}: SHA-256 drift for ${item.path}`)
    }
  }
}

function parseEvidenceClassRegistry(source) {
  const registry = new Map()
  const lines = source.split(/\r?\n/u)
  let inRegistry = false
  let currentClass = null
  for (const line of lines) {
    if (line === 'evidenceClassRegistry:') {
      inRegistry = true
      continue
    }
    if (!inRegistry) continue
    if (/^[^\s#]/u.test(line)) break
    const classMatch = line.match(/^  ([a-z-]+):\s*$/u)
    if (classMatch) {
      currentClass = classMatch[1]
      registry.set(currentClass, [])
      continue
    }
    const pathMatch = line.match(/^    - (.+?)\s*$/u)
    if (pathMatch && currentClass) registry.get(currentClass).push(pathMatch[1])
  }
  return registry
}

function checkMatrixClassification(root, errors) {
  const matrixFile = path.join(root, MATRIX_PATH)
  if (!fs.existsSync(matrixFile)) {
    errors.push(`missing evidence-class matrix: ${MATRIX_PATH}`)
    return
  }
  const registry = parseEvidenceClassRegistry(fs.readFileSync(matrixFile, 'utf8'))
  for (const evidenceClass of REQUIRED_MATRIX_CLASSES) {
    if (!Array.isArray(registry.get(evidenceClass)) || registry.get(evidenceClass).length === 0) {
      errors.push(`${MATRIX_PATH}: evidenceClassRegistry.${evidenceClass} must not be empty`)
    }
  }
  const observed = new Map()
  for (const [evidenceClass, paths] of registry) {
    for (const relative of paths) {
      if (observed.has(relative)) {
        errors.push(`${MATRIX_PATH}: ${relative} is classified as both ${observed.get(relative)} and ${evidenceClass}`)
      }
      observed.set(relative, evidenceClass)
    }
  }
  for (const [relative, expectedClass] of STATIC_PATH_CLASSES) {
    if (observed.get(relative) !== expectedClass) {
      errors.push(`${MATRIX_PATH}: ${relative} must be classified as ${expectedClass}`)
    }
  }
  for (const evidenceClass of ['fresh-run-evidence', 'release-closeout-evidence']) {
    for (const relative of registry.get(evidenceClass) ?? []) {
      if (!relative.startsWith('.tmp/')) {
        errors.push(`${MATRIX_PATH}: tracked path cannot be ${evidenceClass}: ${relative}`)
      }
    }
  }
}

function checkReleaseIndexes(root, errors) {
  const directory = path.join(root, 'release-index')
  if (!fs.existsSync(directory)) return
  for (const relative of walkFiles(root, 'release-index')) {
    if (!relative.endsWith('.json')) {
      errors.push(`release-index permits only JSON index records: ${relative}`)
      continue
    }
    const value = readJson(root, relative, errors)
    if (!value) continue
    const keys = Object.keys(value).sort()
    if (JSON.stringify(keys) !== JSON.stringify(RELEASE_INDEX_KEYS)) {
      errors.push(`${relative}: release index contains fields outside the strict identity and integrity schema`)
    }
    if (value.schema !== 'fsusblog.release-evidence-index.v1') errors.push(`${relative}: invalid schema`)
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{5,127}$/u.test(String(value.releaseId ?? ''))) errors.push(`${relative}: invalid releaseId`)
    if (!/^[0-9a-f]{40}$/u.test(String(value.commitSha ?? ''))) errors.push(`${relative}: invalid commitSha`)
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(value.imageDigest ?? ''))) errors.push(`${relative}: invalid imageDigest`)
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(value.evidenceBundleSha256 ?? ''))) errors.push(`${relative}: invalid evidenceBundleSha256`)
    if (!/^github-actions:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\/artifacts\/[A-Za-z0-9_.-]+$/u.test(String(value.storageReference ?? ''))) errors.push(`${relative}: invalid immutable storageReference`)
    if (value.status !== 'collected-ok') errors.push(`${relative}: status must be collected-ok`)
    if (!Number.isInteger(value.retentionDays) || value.retentionDays < 1) errors.push(`${relative}: invalid retentionDays`)
    if (!Number.isFinite(Date.parse(value.generatedAt))) errors.push(`${relative}: invalid generatedAt`)
  }
}

export function checkReleaseEvidenceLayout(repositoryRoot) {
  const root = path.resolve(repositoryRoot)
  const errors = []
  if (fs.existsSync(path.join(root, 'release-evidence'))) {
    errors.push('top-level release-evidence/ is forbidden; dynamic bundles belong under .tmp and tracked indexes under release-index/')
  }
  checkStaticEvidence(root, errors)
  checkHistoricalSnapshot(root, errors)
  checkMatrixClassification(root, errors)
  checkReleaseIndexes(root, errors)
  return errors
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url)) {
  const repositoryRoot = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
  const errors = checkReleaseEvidenceLayout(repositoryRoot)
  if (errors.length > 0) {
    for (const error of errors) console.error(`[release-evidence-layout] ${error}`)
    process.exit(1)
  }
  console.log('[release-evidence-layout] ok')
}
