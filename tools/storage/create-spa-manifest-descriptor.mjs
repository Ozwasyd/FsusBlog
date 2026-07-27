#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  productionBuildReceiptSchema,
  verifyProductionBuildReceipt
} from '../ci/production-build-artifacts.mjs'
import { readReleaseManifest } from '../release/release-manifest.mjs'

export const SPA_MANIFEST_DESCRIPTOR_SCHEMA = 'fsusblog.spa-manifest-descriptor.v1'
export const SPA_MANIFEST_DESCRIPTOR_NAME = 'spa-manifest-descriptor.json'
export const RETAINED_PRODUCTION_BUILD_RECEIPT_NAME = 'production-build-receipt.json'

const generatedReleaseFiles = new Set([
  'asset-manifest.json',
  'release-compatibility.json',
  SPA_MANIFEST_DESCRIPTOR_NAME,
  RETAINED_PRODUCTION_BUILD_RECEIPT_NAME
])
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const fingerprintPattern = /^(?:sha256:)?[a-f0-9]{64}$/u
const requiredToolchain = Object.freeze(['node', 'npm', 'dotnet', 'vite', 'vitest', 'playwright', 'emsdk'])

function sha256Buffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file))
}

function canonicalize(value, omitContentDigest = false) {
  if (Array.isArray(value)) return value.map(item => canonicalize(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value)
    .sort()
    .filter(key => !omitContentDigest || key !== 'contentDigest')
    .map(key => [key, canonicalize(value[key])]))
}

function contentDigest(value) {
  return sha256Buffer(JSON.stringify(canonicalize(value, true)))
}

function normalizeRelative(value, label) {
  const normalized = String(value ?? '').trim().replace(/^\.\//u, '')
  if (!normalized
    || normalized.includes('\\')
    || path.posix.isAbsolute(normalized)
    || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} path is unsafe`)
  }
  return normalized
}

function assertInside(root, target, label) {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside release asset root`)
  }
}

function rejectSymlinks(root, target, label) {
  for (let current = target; current !== root; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${label} contains a symlink`)
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('asset root contains a symlink')
}

function enumerateFiles(assetRoot, { ignoreGeneratedReleaseFiles = false } = {}) {
  const files = []
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('materialized release contains a symlink')
      if (entry.isDirectory()) visit(absolute, relative)
      else if (entry.isFile()) {
        if (ignoreGeneratedReleaseFiles && !prefix && generatedReleaseFiles.has(relative)) {
          continue
        }
        files.push(relative)
      } else {
        throw new Error('materialized release contains an unsupported entry')
      }
    }
  }
  visit(assetRoot)
  return files
}

function enumerateReleaseFiles(assetRoot) {
  return enumerateFiles(assetRoot, { ignoreGeneratedReleaseFiles: true })
}

function validateReceiptContract(receipt) {
  if (receipt?.schema !== productionBuildReceiptSchema || receipt?.status !== 'complete') {
    throw new Error('production build receipt schema or status is invalid')
  }
  if (!digestPattern.test(String(receipt.contentDigest ?? ''))
    || !fingerprintPattern.test(String(receipt.sourceState?.worktreeFingerprint ?? ''))
    || !Array.isArray(receipt.domains)
    || !Array.isArray(receipt.artifacts)
    || !Array.isArray(receipt.inputDigests)
    || receipt.inputDigests.length === 0
    || receipt.digestTable?.authority !== 'receipt.artifacts'
    || receipt.digestTable?.traversalCount !== 1
    || receipt.digestTable?.entryCount !== receipt.artifacts.length
    || receipt.seal?.mode !== 'read-only-files'
    || receipt.seal?.atomicReceipt !== true
    || !String(receipt.producer?.runId ?? '').trim()
    || !Number.isInteger(receipt.producer?.runAttempt)
    || receipt.producer.runAttempt < 1
    || !String(receipt.producer?.job ?? '').trim()
    || requiredToolchain.some(name => !String(receipt.toolchain?.[name] ?? '').trim())) {
    throw new Error('production build receipt contract is incomplete')
  }

  const inputPaths = new Set()
  for (const input of receipt.inputDigests) {
    const inputPath = normalizeRelative(input?.path, 'receipt input')
    if (inputPaths.has(inputPath)
      || !Number.isInteger(input?.fileCount)
      || input.fileCount < 1
      || !Number.isInteger(input?.size)
      || input.size < 0
      || !digestPattern.test(String(input?.sha256 ?? ''))) {
      throw new Error('production build receipt input digest contract is invalid')
    }
    inputPaths.add(inputPath)
  }

  const domainNames = new Set()
  const domainPaths = new Set()
  for (const domain of receipt.domains) {
    const name = String(domain?.name ?? '').trim()
    const domainPath = normalizeRelative(domain?.path, 'receipt domain')
    if (!/^[a-z][a-z0-9-]*$/u.test(name)
      || domainNames.has(name)
      || domainPaths.has(domainPath)
      || !['read-only', 'copy-before-write'].includes(domain?.consumerMode)
      || !Number.isInteger(domain?.fileCount)
      || domain.fileCount < 1) {
      throw new Error('production build receipt domain contract is invalid')
    }
    domainNames.add(name)
    domainPaths.add(domainPath)
  }

  const frontendDomains = receipt.domains.filter(domain => domain.name === 'frontend-dist')
  if (frontendDomains.length !== 1 || frontendDomains[0].consumerMode !== 'read-only') {
    throw new Error('production build receipt requires one read-only frontend-dist domain')
  }

  const artifacts = new Map()
  for (const artifact of receipt.artifacts) {
    const artifactPath = normalizeRelative(artifact?.path, 'receipt artifact')
    if (artifacts.has(artifactPath)
      || !Number.isInteger(artifact?.size)
      || artifact.size < 0
      || !digestPattern.test(String(artifact?.sha256 ?? ''))) {
      throw new Error('production build receipt artifact contract is invalid')
    }
    artifacts.set(artifactPath, {
      path: artifactPath,
      size: artifact.size,
      sha256: artifact.sha256
    })
  }
  for (const artifactPath of artifacts.keys()) {
    if (receipt.domains.filter(domain => artifactPath === domain.path
      || artifactPath.startsWith(`${domain.path}/`)).length !== 1) {
      throw new Error('production build receipt artifact domain ownership is invalid')
    }
  }
  for (const domain of receipt.domains) {
    const ownedCount = [...artifacts.keys()].filter(artifactPath => artifactPath === domain.path
      || artifactPath.startsWith(`${domain.path}/`)).length
    if (ownedCount !== domain.fileCount) {
      throw new Error('production build receipt domain artifact count is invalid')
    }
  }
  const artifactBytes = [...artifacts.values()]
    .reduce((total, artifact) => total + artifact.size, 0)
  if (receipt.metrics?.artifactCount !== artifacts.size
    || receipt.metrics?.artifactBytes !== artifactBytes) {
    throw new Error('production build receipt metrics contract is invalid')
  }

  const frontendDomain = frontendDomains[0]
  const prefix = `${frontendDomain.path}/`
  const frontendArtifacts = new Map()
  for (const artifact of artifacts.values()) {
    if (!artifact.path.startsWith(prefix)) continue
    const relative = artifact.path.slice(prefix.length)
    normalizeRelative(relative, 'frontend artifact')
    frontendArtifacts.set(relative, artifact)
  }
  if (frontendArtifacts.size !== frontendDomain.fileCount || frontendArtifacts.size === 0) {
    throw new Error('production build receipt frontend-dist artifact count is invalid')
  }
  return { frontendDomain, frontendArtifacts }
}

export function verifySpaProductionBuildReceipt({ buildReceiptPath, expectedCommit }) {
  const receiptFile = path.resolve(buildReceiptPath)
  if (!fs.statSync(receiptFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('production build receipt is missing')
  }
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
  validateReceiptContract(receipt)
  if (receipt.sourceState?.commit !== expectedCommit) {
    throw new Error('production build receipt does not bind the release commit')
  }
  const artifactRoot = path.dirname(receiptFile)
  const verified = verifyProductionBuildReceipt({
    artifactRoot,
    receiptFile: path.basename(receiptFile),
    expectedSourceState: {
      commit: expectedCommit,
      worktreeFingerprint: receipt.sourceState.worktreeFingerprint
    },
    expectedReceiptDigest: receipt.contentDigest
  })
  return {
    receiptFile,
    receipt: verified.receipt,
    ...validateReceiptContract(verified.receipt)
  }
}

export function verifySpaSourceDirectory({ sourceDirectory, receiptBinding }) {
  const sourceRoot = path.resolve(sourceDirectory)
  if (!fs.statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('SPA source directory is missing')
  }
  rejectSymlinks(sourceRoot, sourceRoot, 'SPA source directory')
  const sourceFiles = enumerateFiles(sourceRoot)
  const receiptFiles = [...receiptBinding.frontendArtifacts.keys()]
    .sort((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(sourceFiles) !== JSON.stringify(receiptFiles)) {
    throw new Error('SPA source is not the exact receipted frontend-dist file set')
  }
  for (const relative of sourceFiles) {
    const absolute = path.resolve(sourceRoot, relative)
    assertInside(sourceRoot, absolute, 'SPA source asset')
    rejectSymlinks(sourceRoot, absolute, 'SPA source asset')
    const artifact = receiptBinding.frontendArtifacts.get(relative)
    if (!artifact
      || artifact.path !== path.posix.join(receiptBinding.frontendDomain.path, relative)
      || artifact.size !== fs.statSync(absolute).size
      || artifact.sha256 !== sha256File(absolute)) {
      throw new Error('SPA source file is not bound by exact receipt path, size, and digest')
    }
  }
}

function validateInventory(assetRoot, inventoryPath, manifestPath, release, receiptBinding) {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'))
  if (inventory?.schema !== 'fsusblog.release-assets.v1'
    || inventory?.releaseId !== release.releaseId
    || inventory?.frontendBuildId !== release.releaseId
    || !Array.isArray(inventory?.files)) {
    throw new Error('release asset inventory identity is invalid')
  }

  const entries = new Map()
  for (const file of inventory.files) {
    const relative = normalizeRelative(file?.path, 'release asset inventory')
    const digest = String(file?.sha256 ?? '')
    const size = file?.bytes
    if (entries.has(relative)
      || !digestPattern.test(digest)
      || !Number.isSafeInteger(size)
      || size < 0) {
      throw new Error('release asset inventory entry is invalid or duplicated')
    }
    const absolute = path.resolve(assetRoot, relative)
    assertInside(assetRoot, absolute, 'inventory asset')
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('release asset inventory file is missing')
    }
    rejectSymlinks(assetRoot, absolute, 'inventory asset')
    const receiptArtifact = receiptBinding.frontendArtifacts.get(relative)
    const physicalSize = fs.statSync(absolute).size
    if (!receiptArtifact
      || receiptArtifact.path !== path.posix.join(receiptBinding.frontendDomain.path, relative)
      || size !== physicalSize
      || receiptArtifact.size !== size
      || receiptArtifact.sha256 !== digest
      || sha256File(absolute) !== digest) {
      throw new Error('release asset inventory file is not bound by exact receipt path, size, and digest')
    }
    entries.set(relative, { digest, size })
  }

  const actualFiles = enumerateReleaseFiles(assetRoot)
  const inventoryFiles = [...entries.keys()].sort((left, right) => left.localeCompare(right, 'en'))
  const receiptFiles = [...receiptBinding.frontendArtifacts.keys()].sort((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(actualFiles) !== JSON.stringify(inventoryFiles)
    || JSON.stringify(receiptFiles) !== JSON.stringify(inventoryFiles)) {
    throw new Error('release asset inventory is not the exact materialized frontend-dist file set')
  }

  const relativeManifest = path.relative(assetRoot, manifestPath).replaceAll(path.sep, '/')
  if (!entries.has('index.html') || !entries.has(relativeManifest)) {
    throw new Error('release asset inventory does not bind index and manifest')
  }
}

function installImmutable(file, payload) {
  const target = path.resolve(file)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(temporary, payload, { flag: 'wx', mode: 0o444 })
    fs.chmodSync(temporary, 0o444)
    try {
      fs.linkSync(temporary, target)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (fs.lstatSync(target).isSymbolicLink()
        || !fs.statSync(target).isFile()
        || !fs.readFileSync(target).equals(payload)) {
        throw new Error(`immutable SPA authority conflict at ${target}`)
      }
    }
    if ((fs.statSync(target).mode & 0o222) !== 0) {
      throw new Error(`immutable SPA authority is writable: ${target}`)
    }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function createSpaManifestDescriptor({
  releaseManifestPath,
  buildReceiptPath,
  releaseAssetRoot,
  assetRoot,
  runtimeAssetRoot = assetRoot,
  out = path.join(assetRoot, SPA_MANIFEST_DESCRIPTOR_NAME)
}) {
  const release = readReleaseManifest(path.resolve(releaseManifestPath), {
    requireRegistryDigest: true,
    requireConcreteRuntimeProfile: true
  })
  const physicalReleaseAssetRoot = path.resolve(releaseAssetRoot)
  const physicalAssetRoot = path.resolve(assetRoot)
  const expectedAssetRoot = path.resolve(physicalReleaseAssetRoot, release.releaseId)
  if (physicalAssetRoot !== expectedAssetRoot
    || fs.realpathSync(physicalAssetRoot) !== path.resolve(fs.realpathSync(physicalReleaseAssetRoot), release.releaseId)) {
    throw new Error('asset root must be the configured current release directory')
  }
  rejectSymlinks(physicalReleaseAssetRoot, physicalAssetRoot, 'asset root')

  const descriptorOutput = path.resolve(out)
  if (descriptorOutput !== path.join(physicalAssetRoot, SPA_MANIFEST_DESCRIPTOR_NAME)) {
    throw new Error('SPA descriptor output must use the canonical release path')
  }
  const resolvedRuntimeAssetRoot = path.resolve(runtimeAssetRoot)
  if (!path.isAbsolute(runtimeAssetRoot) || path.basename(resolvedRuntimeAssetRoot) !== release.releaseId) {
    throw new Error('runtime asset root must be the current absolute release directory')
  }

  const manifestPhysicalPath = path.join(physicalAssetRoot, '.vite', 'manifest.json')
  const inventoryPath = path.join(physicalAssetRoot, 'asset-manifest.json')
  for (const [file, label] of [[manifestPhysicalPath, 'manifest'], [inventoryPath, 'inventory']]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`release ${label} is missing`)
    }
    rejectSymlinks(physicalAssetRoot, file, `${label} path`)
  }

  const receiptBinding = verifySpaProductionBuildReceipt({
    buildReceiptPath,
    expectedCommit: release.commitSha
  })
  validateInventory(physicalAssetRoot, inventoryPath, manifestPhysicalPath, release, receiptBinding)
  const retainedReceiptPath = path.join(physicalAssetRoot, RETAINED_PRODUCTION_BUILD_RECEIPT_NAME)
  installImmutable(retainedReceiptPath, fs.readFileSync(receiptBinding.receiptFile))

  const descriptor = {
    schema: SPA_MANIFEST_DESCRIPTOR_SCHEMA,
    releaseId: release.releaseId,
    sourceCommit: receiptBinding.receipt.sourceState.commit,
    worktreeFingerprint: receiptBinding.receipt.sourceState.worktreeFingerprint,
    buildReceiptDigest: receiptBinding.receipt.contentDigest,
    assetRoot: resolvedRuntimeAssetRoot,
    manifestPath: path.join(resolvedRuntimeAssetRoot, '.vite', 'manifest.json'),
    manifestDigest: sha256File(manifestPhysicalPath),
    assetInventoryDigest: sha256File(inventoryPath),
    contentDigest: null
  }
  descriptor.contentDigest = contentDigest(descriptor)
  installImmutable(descriptorOutput, Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`))
  return {
    descriptor,
    descriptorPath: descriptorOutput,
    descriptorDigest: sha256File(descriptorOutput),
    retainedReceiptPath,
    retainedReceiptDigest: sha256File(retainedReceiptPath)
  }
}

export function verifyRetainedSpaManifestAuthority({
  releaseManifestPath,
  buildReceiptPath,
  releaseAssetRoot,
  assetRoot,
  runtimeAssetRoot,
  descriptorPath
}) {
  const release = readReleaseManifest(path.resolve(releaseManifestPath), {
    requireRegistryDigest: true,
    requireConcreteRuntimeProfile: true
  })
  const physicalReleaseAssetRoot = path.resolve(releaseAssetRoot)
  const physicalAssetRoot = path.resolve(assetRoot)
  if (physicalAssetRoot !== path.resolve(physicalReleaseAssetRoot, release.releaseId)
    || fs.realpathSync(physicalAssetRoot) !== path.resolve(fs.realpathSync(physicalReleaseAssetRoot), release.releaseId)) {
    throw new Error('asset root must be the configured current release directory')
  }
  rejectSymlinks(physicalReleaseAssetRoot, physicalAssetRoot, 'asset root')

  const retainedReceiptPath = path.resolve(buildReceiptPath)
  const canonicalReceiptPath = path.join(physicalAssetRoot, RETAINED_PRODUCTION_BUILD_RECEIPT_NAME)
  const canonicalDescriptorPath = path.join(physicalAssetRoot, SPA_MANIFEST_DESCRIPTOR_NAME)
  if (retainedReceiptPath !== canonicalReceiptPath
    || path.resolve(descriptorPath) !== canonicalDescriptorPath) {
    throw new Error('retained SPA authority must use canonical release paths')
  }
  for (const [file, label] of [
    [retainedReceiptPath, 'retained receipt'],
    [canonicalDescriptorPath, 'descriptor']
  ]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()
      || fs.lstatSync(file).isSymbolicLink()
      || (fs.statSync(file).mode & 0o222) !== 0) {
      throw new Error(`${label} is missing, symbolic, or writable`)
    }
  }

  const descriptor = JSON.parse(fs.readFileSync(canonicalDescriptorPath, 'utf8'))
  const descriptorKeys = [
    'schema',
    'releaseId',
    'sourceCommit',
    'worktreeFingerprint',
    'buildReceiptDigest',
    'assetRoot',
    'manifestPath',
    'manifestDigest',
    'assetInventoryDigest',
    'contentDigest'
  ].sort()
  if (JSON.stringify(Object.keys(descriptor).sort()) !== JSON.stringify(descriptorKeys)
    || descriptor.schema !== SPA_MANIFEST_DESCRIPTOR_SCHEMA
    || descriptor.releaseId !== release.releaseId
    || descriptor.sourceCommit !== release.commitSha
    || !fingerprintPattern.test(String(descriptor.worktreeFingerprint ?? ''))
    || !digestPattern.test(String(descriptor.buildReceiptDigest ?? ''))
    || descriptor.contentDigest !== contentDigest(descriptor)) {
    throw new Error('retained SPA descriptor contract is invalid')
  }

  const resolvedRuntimeAssetRoot = path.resolve(runtimeAssetRoot)
  const manifestPath = path.join(physicalAssetRoot, '.vite', 'manifest.json')
  const inventoryPath = path.join(physicalAssetRoot, 'asset-manifest.json')
  if (descriptor.assetRoot !== resolvedRuntimeAssetRoot
    || descriptor.manifestPath !== path.join(resolvedRuntimeAssetRoot, '.vite', 'manifest.json')
    || descriptor.manifestDigest !== sha256File(manifestPath)
    || descriptor.assetInventoryDigest !== sha256File(inventoryPath)) {
    throw new Error('retained SPA descriptor does not bind the materialized release')
  }

  const receipt = JSON.parse(fs.readFileSync(retainedReceiptPath, 'utf8'))
  const receiptBinding = validateReceiptContract(receipt)
  if (receipt.contentDigest !== contentDigest(receipt)
    || receipt.contentDigest !== descriptor.buildReceiptDigest
    || receipt.sourceState?.commit !== release.commitSha
    || receipt.sourceState?.worktreeFingerprint !== descriptor.worktreeFingerprint) {
    throw new Error('retained production build receipt does not bind the descriptor')
  }
  validateInventory(physicalAssetRoot, inventoryPath, manifestPath, release, receiptBinding)
  return { descriptor, receipt }
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`)
    parsed[argument.slice(2)] = value
    index += 1
  }
  return parsed
}

function requiredPath(options, name) {
  if (!options[name]) throw new Error(`missing --${name}`)
  return path.resolve(options[name])
}

function runCli() {
  try {
    const [command, ...args] = process.argv.slice(2)
    const verifyRetained = command === 'verify-retained'
    const options = parseArgs(verifyRetained ? args : process.argv.slice(2))
    const common = {
      releaseManifestPath: requiredPath(options, 'release-manifest'),
      buildReceiptPath: requiredPath(options, 'build-receipt'),
      releaseAssetRoot: requiredPath(options, 'release-asset-root'),
      assetRoot: requiredPath(options, 'asset-root'),
      runtimeAssetRoot: options['runtime-asset-root']
        ? path.resolve(options['runtime-asset-root'])
        : requiredPath(options, 'asset-root')
    }
    if (verifyRetained) {
      verifyRetainedSpaManifestAuthority({
        ...common,
        descriptorPath: requiredPath(options, 'descriptor')
      })
    } else {
      createSpaManifestDescriptor({
        ...common,
        out: requiredPath(options, 'out')
      })
    }
  } catch (error) {
    console.error(`[spa-manifest-descriptor] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli()
}
