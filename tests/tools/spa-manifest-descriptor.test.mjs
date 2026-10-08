import { createCurrentSchemaReleaseBindingFixture, createReleaseIdentityRosterFixture } from './support/release-readiness-test-helpers.mjs';
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs'
import { createReleaseManifest } from '../../tools/release/release-manifest.mjs'
import { materializeReleaseAssets } from '../../tools/storage/release-assets.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const descriptorTool = path.join(repositoryRoot, 'tools/storage/create-spa-manifest-descriptor.mjs')
const materializeTool = path.join(repositoryRoot, 'tools/storage/materialize-release-assets.mjs')
const releaseId = '20260726010101-0123456789ab'
const commitSha = '0123456789abcdef0123456789abcdef01234567'
const digest = value => `sha256:${value.repeat(64)}`
const toolchain = {
  node: 'v24.1.0',
  npm: '11.0.0',
  dotnet: '10.0.1',
  vite: '7.0.0',
  vitest: '4.0.0',
  playwright: '1.58.0',
  emsdk: '4.0.0'
}

function canonicalContentDigest(value) {
  const { contentDigest: _ignored, ...content } = value
  const canonicalize = item => {
    if (Array.isArray(item)) return item.map(canonicalize)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.keys(item)
      .sort()
      .map(key => [key, canonicalize(item[key])]))
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`
}

function writeReleaseManifest(directory) {
  const manifest = createReleaseManifest({
    releaseId,
    commitSha,
    imageRepository: 'ghcr.io/fsusblog/app',
    imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
    imageDigest: digest('a'),
    registryDigestVerified: true,
    createdAtUtc: '2026-07-26T01:01:01Z',
    frontendManifestHash: digest('b'),
    wasmArtifactHash: digest('c'),
    currentSchema: createCurrentSchemaReleaseBindingFixture(),
        identity: createReleaseIdentityRosterFixture({ commitSha, imageDigest: digest('a'), frontendManifestHash: digest('b'), wasmArtifactHash: digest('c') }),
    dotnetVersion: '10',
    nodeVersion: '24',
    dockerVersion: '28',
    dockerfileDigest: digest('d'),
    runtimeProfile: {
      id: 'throughput-musl',
      manifestDigest: digest('e'),
      profileDigest: digest('f'),
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
    }
  })
  const file = path.join(directory, 'release.json')
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return file
}

function fixture({ materialize = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-spa-descriptor-'))
  const checkout = path.join(directory, 'checkout')
  const artifactRoot = path.join(directory, 'production-build')
  const frontendDist = path.join(artifactRoot, 'frontend-dist')
  const store = path.join(directory, 'store')
  fs.mkdirSync(path.join(frontendDist, '.vite'), { recursive: true })
  fs.mkdirSync(path.join(frontendDist, 'assets'), { recursive: true })
  fs.mkdirSync(checkout, { recursive: true })
  fs.writeFileSync(path.join(checkout, 'build-input.json'), '{"profile":"production"}\n')
  fs.writeFileSync(path.join(frontendDist, 'index.html'), '<main>release</main>\n')
  fs.writeFileSync(path.join(frontendDist, 'assets/app.js'), 'export const release = true\n')
  fs.writeFileSync(path.join(frontendDist, 'assets/app.css'), 'body{color:#123}\n')
  fs.writeFileSync(path.join(frontendDist, '.vite/manifest.json'), `${JSON.stringify({
    'src/bootstrap/entry.ts': {
      file: 'assets/app.js',
      css: ['assets/app.css'],
      name: 'route-public'
    }
  })}\n`)
  const releaseManifest = writeReleaseManifest(directory)
  const receipt = createProductionBuildReceipt({
    root: checkout,
    artifactRoot,
    sourceState: {
      commit: commitSha,
      worktreeFingerprint: digest('2')
    },
    producer: {
      workflow: 'Quality Gate',
      runId: '1665',
      runAttempt: 1,
      job: 'production-build-artifacts'
    },
    toolchain,
    inputPaths: ['build-input.json'],
    domains: [{ name: 'frontend-dist', path: 'frontend-dist' }],
    build: {
      profile: 'production-release-fresh',
      command: './tools/test.sh ci-tier production-build-artifacts'
    },
    now: () => new Date('2026-07-26T01:00:00Z')
  })
  if (materialize) {
    materializeReleaseAssets({
      releaseId,
      slot: 'green',
      sourceDirectory: frontendDist,
      storeDirectory: store,
      dryRun: false
    })
  }
  return {
    directory,
    artifactRoot,
    frontendDist,
    store,
    releaseManifest,
    receipt,
    receiptPath: path.join(artifactRoot, 'receipt.json'),
    releaseAssetRoot: path.join(store, 'releases'),
    assetRoot: path.join(store, 'releases', releaseId)
  }
}

function runDescriptor(value, overrides = {}) {
  const assetRoot = overrides.assetRoot ?? value.assetRoot
  return spawnSync(process.execPath, [
    descriptorTool,
    '--release-manifest', value.releaseManifest,
    '--build-receipt', overrides.receiptPath ?? value.receiptPath,
    '--release-asset-root', overrides.releaseAssetRoot ?? value.releaseAssetRoot,
    '--asset-root', assetRoot,
    '--runtime-asset-root', overrides.runtimeAssetRoot ?? assetRoot,
    '--out', overrides.out ?? path.join(assetRoot, 'spa-manifest-descriptor.json')
  ], { encoding: 'utf8' })
}

test('real production receipt then release materialization produces a canonical SPA descriptor', () => {
  const value = fixture()
  try {
    const result = runDescriptor(value)
    assert.equal(result.status, 0, result.stderr)
    const descriptor = JSON.parse(fs.readFileSync(path.join(value.assetRoot, 'spa-manifest-descriptor.json')))
    const receipt = JSON.parse(fs.readFileSync(value.receiptPath))
    const inventoryDigest = `sha256:${createHash('sha256')
      .update(fs.readFileSync(path.join(value.assetRoot, 'asset-manifest.json')))
      .digest('hex')}`

    assert.equal(receipt.artifacts.some(artifact => artifact.path.endsWith('asset-manifest.json')), false)
    assert.equal(receipt.artifacts.some(artifact => artifact.sha256 === inventoryDigest), false)
    assert.ok(receipt.artifacts.every(artifact => artifact.path.startsWith('frontend-dist/')))
    assert.equal(descriptor.releaseId, releaseId)
    assert.equal(descriptor.buildReceiptDigest, receipt.contentDigest)
    assert.equal(descriptor.contentDigest, canonicalContentDigest(descriptor))
    assert.equal(fs.statSync(path.join(value.assetRoot, 'spa-manifest-descriptor.json')).mode & 0o222, 0)
    assert.equal(fs.statSync(path.join(value.assetRoot, 'production-build-receipt.json')).mode & 0o222, 0)
    assert.deepEqual(Object.keys(descriptor).sort(), [
      'assetInventoryDigest',
      'assetRoot',
      'buildReceiptDigest',
      'contentDigest',
      'manifestDigest',
      'manifestPath',
      'releaseId',
      'schema',
      'sourceCommit',
      'worktreeFingerprint'
    ])
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true })
  }
})

test('descriptor rejects a non-release root and a handwritten minimal receipt', () => {
  const wrongRoot = fixture()
  try {
    assert.notEqual(runDescriptor(wrongRoot, {
      assetRoot: wrongRoot.releaseAssetRoot,
      out: path.join(wrongRoot.releaseAssetRoot, 'spa-manifest-descriptor.json')
    }).status, 0)
  } finally {
    fs.rmSync(wrongRoot.directory, { recursive: true, force: true })
  }

  const handwritten = fixture()
  try {
    fs.chmodSync(handwritten.receiptPath, 0o644)
    const receipt = {
      sourceState: {
        commit: commitSha,
        worktreeFingerprint: digest('2')
      },
      artifacts: [],
      contentDigest: null
    }
    receipt.contentDigest = canonicalContentDigest(receipt)
    fs.writeFileSync(handwritten.receiptPath, JSON.stringify(receipt))
    assert.notEqual(runDescriptor(handwritten).status, 0)
  } finally {
    fs.rmSync(handwritten.directory, { recursive: true, force: true })
  }
})

test('descriptor rejects receipt tamper and incomplete exact artifact paths', () => {
  const tampered = fixture()
  try {
    fs.chmodSync(tampered.receiptPath, 0o644)
    const receipt = JSON.parse(fs.readFileSync(tampered.receiptPath))
    receipt.sourceState.commit = 'f'.repeat(40)
    fs.writeFileSync(tampered.receiptPath, JSON.stringify(receipt))
    assert.notEqual(runDescriptor(tampered).status, 0)
  } finally {
    fs.rmSync(tampered.directory, { recursive: true, force: true })
  }

  const incomplete = fixture()
  try {
    fs.chmodSync(incomplete.receiptPath, 0o644)
    const receipt = JSON.parse(fs.readFileSync(incomplete.receiptPath))
    receipt.artifacts = receipt.artifacts.filter(artifact => !artifact.path.endsWith('/assets/app.css'))
    receipt.domains[0].fileCount -= 1
    receipt.metrics.artifactCount -= 1
    receipt.metrics.artifactBytes -= fs.statSync(path.join(incomplete.frontendDist, 'assets/app.css')).size
    receipt.digestTable.entryCount -= 1
    receipt.contentDigest = canonicalContentDigest(receipt)
    fs.writeFileSync(incomplete.receiptPath, JSON.stringify(receipt))
    assert.notEqual(runDescriptor(incomplete).status, 0)
  } finally {
    fs.rmSync(incomplete.directory, { recursive: true, force: true })
  }
})

test('descriptor rejects a tampered materialized asset and a materialization extra', () => {
  const tampered = fixture()
  try {
    const asset = path.join(tampered.assetRoot, 'assets/app.css')
    fs.chmodSync(asset, 0o644)
    fs.appendFileSync(asset, 'tampered')
    assert.notEqual(runDescriptor(tampered).status, 0)
  } finally {
    fs.rmSync(tampered.directory, { recursive: true, force: true })
  }

  const extra = fixture()
  try {
    fs.writeFileSync(path.join(extra.assetRoot, 'materialization-extra.txt'), 'extra')
    assert.notEqual(runDescriptor(extra).status, 0)
  } finally {
    fs.rmSync(extra.directory, { recursive: true, force: true })
  }
})

test('descriptor rejects an extra or duplicated inventory entry without mutating the sealed receipt', () => {
  const value = fixture()
  try {
    const inventoryPath = path.join(value.assetRoot, 'asset-manifest.json')
    fs.chmodSync(inventoryPath, 0o644)
    const inventory = JSON.parse(fs.readFileSync(inventoryPath))
    inventory.files.push({
      path: 'assets/phantom.css',
      sha256: digest('f'),
      bytes: 1
    })
    fs.writeFileSync(inventoryPath, JSON.stringify(inventory))
    assert.notEqual(runDescriptor(value).status, 0)
    assert.equal(JSON.parse(fs.readFileSync(value.receiptPath)).contentDigest, value.receipt.contentDigest)

    inventory.files.pop()
    inventory.files.push({ ...inventory.files[0] })
    fs.writeFileSync(inventoryPath, JSON.stringify(inventory))
    assert.notEqual(runDescriptor(value).status, 0)
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true })
  }
})

test('materialization CLI requires the receipt and emits deployment-ready runtime paths', () => {
  const invalid = fixture({ materialize: false })
  try {
    fs.chmodSync(invalid.receiptPath, 0o644)
    const receipt = JSON.parse(fs.readFileSync(invalid.receiptPath))
    receipt.sourceState.commit = 'f'.repeat(40)
    fs.writeFileSync(invalid.receiptPath, JSON.stringify(receipt))
    const rejected = spawnSync(process.execPath, [
      materializeTool,
      '--release-manifest', invalid.releaseManifest,
      '--slot', 'green',
      '--source', invalid.frontendDist,
      '--store', invalid.store,
      '--build-receipt', invalid.receiptPath
    ], { encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.equal(fs.existsSync(invalid.store), false)
  } finally {
    fs.rmSync(invalid.directory, { recursive: true, force: true })
  }

  const mismatchedSource = fixture({ materialize: false })
  try {
    const extractedSource = path.join(mismatchedSource.directory, 'extracted-wwwroot')
    fs.cpSync(mismatchedSource.frontendDist, extractedSource, { recursive: true })
    fs.chmodSync(path.join(extractedSource, 'assets/app.js'), 0o644)
    fs.appendFileSync(path.join(extractedSource, 'assets/app.js'), 'tampered image\n')
    const rejected = spawnSync(process.execPath, [
      materializeTool,
      '--release-manifest', mismatchedSource.releaseManifest,
      '--slot', 'green',
      '--source', extractedSource,
      '--store', mismatchedSource.store,
      '--build-receipt', mismatchedSource.receiptPath
    ], { encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.equal(fs.existsSync(mismatchedSource.store), false)
  } finally {
    fs.rmSync(mismatchedSource.directory, { recursive: true, force: true })
  }

  const value = fixture({ materialize: false })
  try {
    const missingReceipt = spawnSync(process.execPath, [
      materializeTool,
      '--release-manifest', value.releaseManifest,
      '--slot', 'green',
      '--source', value.frontendDist,
      '--store', value.store
    ], { encoding: 'utf8' })
    assert.notEqual(missingReceipt.status, 0)

    const result = spawnSync(process.execPath, [
      materializeTool,
      '--release-manifest', value.releaseManifest,
      '--slot', 'green',
      '--source', value.frontendDist,
      '--store', value.store,
      '--build-receipt', value.receiptPath,
      '--runtime-release-asset-root', '/app/release-assets'
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    const descriptor = JSON.parse(fs.readFileSync(report.spaManifestDescriptor))
    assert.equal(descriptor.assetRoot, `/app/release-assets/${releaseId}`)
    assert.equal(descriptor.manifestPath, `/app/release-assets/${releaseId}/.vite/manifest.json`)
    assert.equal(report.productionBuildReceipt, path.join(value.assetRoot, 'production-build-receipt.json'))
    assert.equal(report.status, 'ok')
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true })
  }
})
