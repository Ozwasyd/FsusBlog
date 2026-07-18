#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const defaultManifestPath = 'security/zk/provenance/artifact-ownership.manifest.json'
const activeArtifactRoot = 'artifacts/zk/comment-v3-layout4'
const activeCircuitId = 'fsus.anonymous.comment.v3'
const activeLayoutVersion = 4

export function validateZkArtifactOwnership({
  root = repositoryRoot,
  manifest = readJson(path.join(root, defaultManifestPath)),
  trackedFiles = listTrackedFiles(root, manifest.controlled_roots ?? [])
} = {}) {
  const errors = []
  const normalizedRoot = path.resolve(root)
  const tracked = new Set(trackedFiles.map(repoPath))
  const trackedArtifacts = array(manifest.tracked_artifacts)
  const externalArtifacts = array(manifest.external_artifacts)
  const retiredArtifacts = array(manifest.retired_artifacts)

  equal(errors, manifest.schema, 'fsusblog.zk.artifact-ownership.v1', 'schema')
  if (manifest.storage_policy?.ordinary_git_for_ceremony_artifacts !== false) {
    errors.push('storage policy must reject ordinary Git ownership for ceremony artifacts')
  }
  if (manifest.storage_policy?.ceremony_and_delivery_artifacts !== 'immutable-release-or-oci-by-sha256') {
    errors.push('ceremony and delivery storage authority must be immutable release or OCI by SHA-256')
  }
  if (manifest.storage_policy?.production_requires_matching_release_evidence !== true) {
    errors.push('production must require matching release evidence')
  }

  const declaredTrackedPaths = new Set()
  const packageIdentities = new Map()
  for (const artifact of trackedArtifacts) {
    const artifactPath = normalizePath(artifact.path, errors, 'tracked artifact path')
    if (!artifactPath) continue
    if (declaredTrackedPaths.has(artifactPath)) errors.push(`duplicate tracked artifact declaration: ${artifactPath}`)
    declaredTrackedPaths.add(artifactPath)
    validateIdentity(errors, artifact, artifactPath)
    validatePackageIdentity(errors, packageIdentities, artifact)
    requireEqual(errors, artifact.production_usable, false, `${artifactPath} production_usable`)
    requireEqual(errors, artifact.deterministic, true, `${artifactPath} deterministic`)
    requireEqual(errors, artifact.storage_authority, 'git', `${artifactPath} storage_authority`)
    if (!['active-generated', 'test-only'].includes(artifact.lifecycle)) {
      errors.push(`${artifactPath} lifecycle must be active-generated or test-only`)
    }
    if (!tracked.has(artifactPath)) errors.push(`declared tracked artifact is not tracked: ${artifactPath}`)
    validateBoundFile(normalizedRoot, artifactPath, artifact.sha256, artifact.bytes, errors)
    validateOwnedPath(normalizedRoot, artifact.owner, `${artifactPath} owner`, errors)
    validateOwnedPath(normalizedRoot, artifact.generator, `${artifactPath} generator`, errors)
    if (!text(artifact.check_command)) errors.push(`${artifactPath} check_command is required`)
    if (array(artifact.consumers).length === 0) errors.push(`${artifactPath} requires at least one consumer`)
    for (const consumer of array(artifact.consumers)) {
      validateOwnedPath(normalizedRoot, consumer, `${artifactPath} consumer`, errors)
    }
  }

  const controlledRoots = array(manifest.controlled_roots).map(repoPath)
  const binaryExtensions = array(manifest.binary_extensions).map(String)
  const controlledBinaries = [...tracked].filter((file) =>
    controlledRoots.some((rootPath) => file === rootPath || file.startsWith(`${rootPath}/`))
    && binaryExtensions.some((extension) => file.endsWith(extension)))
  for (const file of controlledBinaries) {
    if (!declaredTrackedPaths.has(file)) errors.push(`tracked cryptographic binary has no owner: ${file}`)
  }
  for (const file of declaredTrackedPaths) {
    if (!controlledBinaries.includes(file)) errors.push(`owned cryptographic binary is outside the tracked controlled set: ${file}`)
  }

  const knownActivePaths = new Set(trackedArtifacts
    .filter((artifact) => repoPath(artifact.path).startsWith(`${activeArtifactRoot}/`))
    .map((artifact) => repoPath(artifact.path)))
  for (const artifact of externalArtifacts) {
    const artifactPath = normalizePath(artifact.path, errors, 'external artifact path')
    if (!artifactPath) continue
    validateIdentity(errors, artifact, artifactPath)
    requireEqual(errors, artifact.production_usable, false, `${artifactPath} production_usable`)
    if (tracked.has(artifactPath)) errors.push(`external ceremony or delivery artifact must not be Git-tracked: ${artifactPath}`)
    if (!['immutable-release-or-oci', 'run-bound-build-output'].includes(artifact.storage_authority)) {
      errors.push(`${artifactPath} has unsupported external storage authority`)
    }
    if (artifact.lifecycle === 'required-before-production' && artifact.storage_authority !== 'immutable-release-or-oci') {
      errors.push(`${artifactPath} must use immutable release or OCI storage before production`)
    }
    if (!text(artifact.hash_authority)) errors.push(`${artifactPath} hash_authority is required`)
    knownActivePaths.add(artifactPath)
  }

  for (const forbiddenRoot of array(manifest.forbidden_roots).map(repoPath)) {
    if (existsSync(path.join(normalizedRoot, forbiddenRoot))) errors.push(`forbidden mixed-identity artifact root exists: ${forbiddenRoot}`)
    if ([...tracked].some((file) => file === forbiddenRoot || file.startsWith(`${forbiddenRoot}/`))) {
      errors.push(`forbidden mixed-identity artifact root is tracked: ${forbiddenRoot}`)
    }
  }

  for (const retired of retiredArtifacts) {
    const retiredPath = normalizePath(retired.original_path, errors, 'retired artifact path')
    if (!retiredPath) continue
    requireEqual(errors, retired.lifecycle, 'deleted', `${retiredPath} lifecycle`)
    requireEqual(errors, retired.production_usable, false, `${retiredPath} production_usable`)
    requireEqual(errors, retired.storage_authority, 'deleted-no-supported-consumer', `${retiredPath} storage_authority`)
    if (array(retired.current_consumers).length !== 0) errors.push(`${retiredPath} deleted artifact must have no current consumers`)
    if (!isSha256(retired.sha256) || !Number.isInteger(retired.bytes) || retired.bytes <= 0) {
      errors.push(`${retiredPath} deleted provenance must retain bytes and SHA-256`)
    }
    if (existsSync(path.join(normalizedRoot, retiredPath)) || tracked.has(retiredPath)) {
      errors.push(`retired artifact must remain deleted: ${retiredPath}`)
    }
  }

  for (const manifestPath of array(manifest.active_manifests)) {
    const normalizedPath = normalizePath(manifestPath, errors, 'active manifest path')
    if (!normalizedPath) continue
    const absolutePath = path.join(normalizedRoot, normalizedPath)
    if (!existsSync(absolutePath)) {
      errors.push(`active manifest is missing: ${normalizedPath}`)
      continue
    }
    const document = readJson(absolutePath)
    requireEqual(errors, document.circuit_id, activeCircuitId, `${normalizedPath} circuit_id`)
    requireEqual(errors, document.public_input_layout_version, activeLayoutVersion, `${normalizedPath} public_input_layout_version`)
    for (const artifactPath of artifactPathsIn(document)) {
      if (artifactPath.startsWith('artifacts/zk/comment-v2/')) {
        errors.push(`active manifest selects retired artifact: ${normalizedPath} -> ${artifactPath}`)
      } else if (!knownActivePaths.has(artifactPath)) {
        errors.push(`active manifest references an unowned artifact: ${normalizedPath} -> ${artifactPath}`)
      }
    }
  }

  for (const consumer of array(manifest.active_consumers)) {
    const consumerPath = normalizePath(consumer.path, errors, 'active consumer path')
    if (!consumerPath) continue
    const absolutePath = path.join(normalizedRoot, consumerPath)
    if (!existsSync(absolutePath)) {
      errors.push(`active artifact consumer is missing: ${consumerPath}`)
      continue
    }
    const source = readFileSync(absolutePath, 'utf8')
    if (source.includes('artifacts/zk/comment-v2/')) errors.push(`active consumer selects retired artifact root: ${consumerPath}`)
    for (const required of array(consumer.required_artifacts).map(repoPath)) {
      const basename = path.posix.basename(required)
      if (!source.includes(required) && !(source.includes('comment-v3-layout4') && source.includes(basename))) {
        errors.push(`active consumer does not bind required artifact: ${consumerPath} -> ${required}`)
      }
    }
  }

  return errors
}

function validateIdentity(errors, artifact, artifactPath) {
  if (!artifactPath.startsWith(`${activeArtifactRoot}/`)) return
  requireEqual(errors, artifact.circuit_id, activeCircuitId, `${artifactPath} circuit_id`)
  requireEqual(errors, artifact.public_input_layout_version, activeLayoutVersion, `${artifactPath} public_input_layout_version`)
}

function validatePackageIdentity(errors, identities, artifact) {
  const packageRoot = repoPath(artifact.package_root)
  const identity = `${text(artifact.circuit_id)}@${String(artifact.public_input_layout_version)}`
  if (!packageRoot) {
    errors.push(`${artifact.path || '<missing>'} package_root is required`)
    return
  }
  const existing = identities.get(packageRoot)
  if (existing && existing !== identity) errors.push(`artifact package mixes identities: ${packageRoot}`)
  identities.set(packageRoot, identity)
  if (!repoPath(artifact.path).startsWith(`${packageRoot}/`)) errors.push(`${artifact.path} escapes package_root ${packageRoot}`)
}

function validateBoundFile(root, relativePath, expectedHash, expectedBytes, errors) {
  const absolutePath = path.join(root, relativePath)
  if (!existsSync(absolutePath)) {
    errors.push(`tracked artifact is missing: ${relativePath}`)
    return
  }
  const stats = lstatSync(absolutePath)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    errors.push(`tracked artifact must be a regular non-symlink file: ${relativePath}`)
    return
  }
  const resolved = realpathSync(absolutePath)
  if (!isWithinRoot(root, resolved)) errors.push(`tracked artifact escapes repository root: ${relativePath}`)
  const bytes = readFileSync(absolutePath)
  if (bytes.length !== expectedBytes) errors.push(`tracked artifact byte count mismatch: ${relativePath}`)
  if (!isSha256(expectedHash) || sha256(bytes) !== expectedHash) errors.push(`tracked artifact SHA-256 mismatch: ${relativePath}`)
}

function validateOwnedPath(root, value, label, errors) {
  const relativePath = normalizePath(value, errors, label)
  if (relativePath && !existsSync(path.join(root, relativePath))) errors.push(`${label} is missing: ${relativePath}`)
}

function artifactPathsIn(value, results = []) {
  if (typeof value === 'string') {
    const normalized = repoPath(value)
    if (normalized.startsWith('artifacts/zk/')) results.push(normalized)
  } else if (Array.isArray(value)) {
    for (const item of value) artifactPathsIn(item, results)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) artifactPathsIn(item, results)
  }
  return results
}

function listTrackedFiles(root, controlledRoots) {
  const args = ['-C', root, 'ls-files', '-z', '--', ...array(controlledRoots)]
  return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean)
}

function normalizePath(value, errors, label) {
  const raw = text(value)
  if (!raw) {
    errors.push(`${label} is required`)
    return ''
  }
  const normalized = path.posix.normalize(repoPath(raw))
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    errors.push(`${label} must stay repository-relative: ${raw}`)
    return ''
  }
  return normalized
}

function repoPath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '')
}

function isWithinRoot(root, value) {
  const relative = path.relative(path.resolve(root), path.resolve(value))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(text(value))
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function equal(errors, actual, expected, label) {
  if (actual !== expected) errors.push(`${label} must equal ${String(expected)}`)
}

function requireEqual(errors, actual, expected, label) {
  equal(errors, actual, expected, label)
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? repositoryRoot)
  const errors = validateZkArtifactOwnership({ root })
  const output = path.join(root, '.tmp/security/zk-artifact-ownership-check.json')
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify({
    schema: 'fsusblog.zk.artifact-ownership-check.v1',
    status: errors.length === 0 ? 'ok' : 'failed',
    errors
  }, null, 2)}\n`)
  if (errors.length > 0) {
    for (const error of errors) console.error(`[zk-artifact-ownership] ${error}`)
    process.exitCode = 1
  } else {
    console.log('[zk-artifact-ownership] ok')
  }
}
