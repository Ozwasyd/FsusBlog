import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createReleaseManifest,
  writeReleaseManifestAtomic
} from '../../tools/release/release-manifest.mjs'
import {
  materializeReleaseAssets,
  releaseAssetUrl,
  sha256File
} from '../../tools/storage/release-assets.mjs'
import {
  buildCompatibilityMatrix,
  createReleaseCompatibilityMetadata,
  evaluateClientServerCompatibility
} from '../../tools/storage/release-compatibility.mjs'
import {
  executeReleaseAssetGc,
  planReleaseAssetGc,
  RELEASE_GC_STATE_SCHEMA
} from '../../tools/storage/release-gc.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-storage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root,
    source: path.join(root, 'source'),
    store: path.join(root, 'store')
  }
}

function writeSource(source, marker) {
  fs.mkdirSync(path.join(source, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(source, 'wasm'), { recursive: true })
  fs.writeFileSync(path.join(source, 'index.html'), `<script src="/assets/app.${marker}.js"></script>\n`)
  fs.writeFileSync(path.join(source, 'sw.js'), `const BUILD = '${marker}'\n`)
  fs.writeFileSync(path.join(source, 'assets', `app.${marker}.js`), `export const build = '${marker}'\n`)
  fs.writeFileSync(path.join(source, 'wasm', 'aeds_decoder.wasm'), Buffer.from(`wasm-${marker}`))
}

function compatibility(releaseId, overrides = {}) {
  return createReleaseCompatibilityMetadata({ releaseId, ...overrides })
}

test('materialization is release-addressed append-only idempotent and keeps old assets', (t) => {
  const { root, source, store } = fixture(t)
  const firstRelease = '20260710010101-aaaaaaaaaaaa'
  const secondRelease = '20260711010101-bbbbbbbbbbbb'
  writeSource(source, 'aaaaaa')

  const dryRun = materializeReleaseAssets({
    releaseId: firstRelease,
    slot: 'blue',
    sourceDirectory: source,
    storeDirectory: store,
    compatibility: compatibility(firstRelease),
    dryRun: true
  })
  assert.equal(dryRun.report.status, 'dry-run')
  assert.equal(fs.existsSync(store), false)

  const first = materializeReleaseAssets({
    releaseId: firstRelease,
    slot: 'blue',
    sourceDirectory: source,
    storeDirectory: store,
    compatibility: compatibility(firstRelease),
    dryRun: false
  })
  const retry = materializeReleaseAssets({
    releaseId: firstRelease,
    slot: 'blue',
    sourceDirectory: source,
    storeDirectory: store,
    compatibility: compatibility(firstRelease),
    dryRun: false
  })
  assert.equal(first.report.status, 'ok')
  assert.ok(retry.report.actions.every(action => action.action.startsWith('retain-')))
  assert.equal(releaseAssetUrl(firstRelease, 'wasm/aeds_decoder.wasm'), `/release-assets/${firstRelease}/wasm/aeds_decoder.wasm`)

  fs.rmSync(source, { recursive: true, force: true })
  writeSource(source, 'bbbbbb')
  materializeReleaseAssets({
    releaseId: secondRelease,
    slot: 'green',
    sourceDirectory: source,
    storeDirectory: store,
    compatibility: compatibility(secondRelease),
    dryRun: false
  })

  assert.equal(fs.existsSync(path.join(store, 'releases', firstRelease, 'assets', 'app.aaaaaa.js')), true)
  assert.equal(fs.existsSync(path.join(store, 'releases', secondRelease, 'assets', 'app.bbbbbb.js')), true)
  assert.notEqual(
    sha256File(path.join(store, 'releases', firstRelease, 'wasm', 'aeds_decoder.wasm')),
    sha256File(path.join(store, 'releases', secondRelease, 'wasm', 'aeds_decoder.wasm')))

  fs.chmodSync(path.join(store, 'releases', secondRelease, 'wasm', 'aeds_decoder.wasm'), 0o600)
  fs.writeFileSync(path.join(store, 'releases', secondRelease, 'wasm', 'aeds_decoder.wasm'), 'tampered')
  assert.throws(() => materializeReleaseAssets({
    releaseId: secondRelease,
    slot: 'green',
    sourceDirectory: source,
    storeDirectory: store,
    compatibility: compatibility(secondRelease),
    dryRun: false
  }), /append-only asset conflict/u)
  assert.equal(root.length > 0, true)
})

test('compatibility matrix covers N N-1 old service worker and old decoder', () => {
  const candidate = compatibility('20260711010101-bbbbbbbbbbbb')
  const active = compatibility('20260710010101-aaaaaaaaaaaa')
  const previous = compatibility('20260709010101-999999999999')

  const matrix = buildCompatibilityMatrix({
    candidate,
    active,
    previous,
    retainedAssetReleaseIds: [candidate.releaseId, active.releaseId, previous.releaseId]
  })

  assert.equal(matrix.status, 'pass')
  assert.deepEqual(matrix.scenarios.map(scenario => scenario.id), [
    'N-to-N',
    'N-1-client-to-N-server',
    'previous-client-to-N-server',
    'old-service-worker-assets-retained',
    'old-decoder-to-N-frame'
  ])

  const incompatibleOldClient = compatibility('20260708010101-888888888888', {
    aeds: { emitVersion: 1, minDecoderVersion: 1, maxDecoderVersion: 1 }
  })
  const result = evaluateClientServerCompatibility(incompatibleOldClient, candidate)
  assert.equal(result.compatible, false)
  assert.match(result.errors.join('\n'), /AEDS frame/u)
})

test('service worker derives cache namespace and search URLs from immutable build identity', () => {
  const serviceWorker = fs.readFileSync(path.join(repositoryRoot, 'src/frontend/public/sw.js'), 'utf8')

  assert.match(serviceWorker, /new URL\(self\.location\.href\)\.searchParams\.get\('build'\)/u)
  assert.match(serviceWorker, /fsus-static-v5\$\{CACHE_NAMESPACE\}/u)
  assert.match(serviceWorker, /\/release-derived\/\$\{FRONTEND_BUILD_ID\}\/search/u)
  assert.match(serviceWorker, /importScripts\('\/generated\/release-id-contract\.js'\)/u)
  assert.match(serviceWorker, /FsusReleaseIdContract\.isCanonicalReleaseId\(BUILD_ID_CANDIDATE\)/u)
})

test('GC dry-run is locked and protects active previous draining retention and references', (t) => {
  const { root, store } = fixture(t)
  const releases = [
    ['20260701010101-000001000001', 'orphan'],
    ['20260711010101-111111111111', 'active'],
    ['20260710010101-222222222222', 'previous'],
    ['20260709010101-333333333333', 'draining'],
    ['20260708010101-444444444444', 'retained'],
    ['20260707010101-555555555555', 'referenced']
  ]
  for (const [releaseId, marker] of releases) {
    const source = path.join(root, `source-${marker}`)
    writeSource(source, marker)
    materializeReleaseAssets({
      releaseId,
      slot: marker === 'active' ? 'green' : 'blue',
      sourceDirectory: source,
      storeDirectory: store,
      compatibility: compatibility(releaseId),
      dryRun: false
    })
  }
  const state = {
    schema: RELEASE_GC_STATE_SCHEMA,
    activeReleaseId: releases[1][0],
    previousReleaseId: releases[2][0],
    drainingReleaseIds: [releases[3][0]],
    retentionReleaseIds: [releases[4][0]],
    referencedReleaseIds: [releases[5][0]],
    minimumRetainedReleaseCount: 2
  }
  const veryOld = new Date('2020-01-01T00:00:00Z')
  fs.utimesSync(path.join(store, 'releases', releases[0][0]), veryOld, veryOld)

  const plan = planReleaseAssetGc({ storeDirectory: store, state })
  assert.equal(plan.releases.find(release => release.releaseId === releases[0][0]).action, 'delete')
  for (const releaseId of releases.slice(1).map(([releaseId]) => releaseId)) {
    assert.equal(plan.releases.find(release => release.releaseId === releaseId).protected, true)
  }

  const dryRun = executeReleaseAssetGc({ storeDirectory: store, state })
  assert.equal(dryRun.status, 'dry-run')
  assert.equal(fs.existsSync(path.join(store, 'releases', releases[0][0])), true)
  assert.equal(fs.existsSync(path.join(store, '.gc.lock')), false)

  const applied = executeReleaseAssetGc({ storeDirectory: store, state, apply: true })
  assert.equal(applied.status, 'ok')
  assert.equal(fs.existsSync(path.join(store, 'releases', releases[0][0])), false)
  assert.equal(fs.existsSync(path.join(store, 'releases', releases[1][0])), true)
})

test('host CLIs emit stable machine JSON and retained asset gate fails closed', (t) => {
  const { root, source, store } = fixture(t)
  const candidateRelease = '20260711010101-0123456789ab'
  const previousRelease = '20260710010101-fedcbafedcba'
  writeSource(source, 'candidate')
  const releaseManifestFile = path.join(root, 'release-manifest.json')
  writeReleaseManifestAtomic(releaseManifestFile, createReleaseManifest({
    releaseId: candidateRelease,
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    imageRepository: 'ghcr.io/fsusblog/app',
    imageTag: `ghcr.io/fsusblog/app:${candidateRelease}`,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    registryDigestVerified: true,
    createdAtUtc: '2026-07-11T01:01:01.000Z',
    frontendManifestHash: `sha256:${'b'.repeat(64)}`,
    wasmArtifactHash: `sha256:${'c'.repeat(64)}`,
    zkLocalReviewHash: `sha256:${'e'.repeat(64)}`,
    schemaMinimumCoordinate: previousRelease,
    schemaMaximumCoordinate: candidateRelease,
    dotnetVersion: '10.0.100',
    nodeVersion: 'v20.19.0',
    dockerVersion: '28.0.0',
    dockerfileDigest: `sha256:${'d'.repeat(64)}`,
    runtimeProfile: {
      id: 'throughput-musl',
      manifestDigest: `sha256:${'f'.repeat(64)}`,
      profileDigest: `sha256:${'1'.repeat(64)}`,
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
    target: 'final'
  }))

  const materialize = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'tools/storage/materialize-release-assets.mjs'),
    '--release-manifest', releaseManifestFile,
    '--slot', 'green',
    '--source', source,
    '--store', store
  ], { cwd: repositoryRoot, encoding: 'utf8' })
  assert.equal(materialize.status, 0, materialize.stderr)
  const materializationReport = JSON.parse(materialize.stdout)
  assert.equal(materializationReport.schema, 'fsusblog.release-assets.materialization.v1')
  assert.equal(materializationReport.status, 'ok')
  assert.equal(materializationReport.releaseId, candidateRelease)
  assert.deepEqual(materializationReport.errors, [])

  const previousSource = path.join(root, 'previous-source')
  writeSource(previousSource, 'previous')
  materializeReleaseAssets({
    releaseId: previousRelease,
    slot: 'blue',
    sourceDirectory: previousSource,
    storeDirectory: store,
    compatibility: compatibility(previousRelease),
    dryRun: false
  })
  const stateFile = path.join(store, 'retention-state.json')
  fs.writeFileSync(stateFile, `${JSON.stringify({
    schema: RELEASE_GC_STATE_SCHEMA,
    activeReleaseId: candidateRelease,
    previousReleaseId: previousRelease,
    drainingReleaseIds: [],
    retentionReleaseIds: [],
    referencedReleaseIds: [],
    minimumRetainedReleaseCount: 2
  }, null, 2)}\n`)

  const verify = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'tools/storage/verify-retained-assets.mjs'),
    '--release-manifest', releaseManifestFile,
    '--slot', 'green',
    '--store', store,
    '--state', stateFile,
    '--dry-run'
  ], { cwd: repositoryRoot, encoding: 'utf8' })
  assert.equal(verify.status, 0, verify.stderr)
  const verifyReport = JSON.parse(verify.stdout)
  assert.equal(verifyReport.schema, 'fsusblog.release-assets.retention-verification.v1')
  assert.equal(verifyReport.status, 'dry-run')
  assert.deepEqual(verifyReport.protectedReleaseIds.sort(), [candidateRelease, previousRelease].sort())
  assert.ok(verifyReport.assets.every(asset => asset.releaseCopy === 'verified' && asset.objectCopy === 'verified'))

  const compatibilityGate = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'tools/storage/check-release-compatibility.mjs'),
    '--candidate', candidateRelease,
    '--active', previousRelease,
    '--previous', previousRelease,
    '--store', store,
    '--state', stateFile
  ], { cwd: repositoryRoot, encoding: 'utf8' })
  assert.equal(compatibilityGate.status, 0, compatibilityGate.stderr)
  const compatibilityReport = JSON.parse(compatibilityGate.stdout)
  assert.equal(compatibilityReport.schema, 'fsusblog.release-compatibility-matrix.v1')
  assert.equal(compatibilityReport.status, 'pass')

  fs.chmodSync(path.join(store, 'releases', previousRelease, 'wasm', 'aeds_decoder.wasm'), 0o600)
  fs.writeFileSync(path.join(store, 'releases', previousRelease, 'wasm', 'aeds_decoder.wasm'), 'tampered')
  const rejected = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'tools/storage/verify-retained-assets.mjs'),
    '--release-manifest', releaseManifestFile,
    '--slot', 'green',
    '--store', store,
    '--state', stateFile,
    '--dry-run'
  ], { cwd: repositoryRoot, encoding: 'utf8' })
  assert.notEqual(rejected.status, 0)
  const rejectedReport = JSON.parse(rejected.stdout)
  assert.equal(rejectedReport.status, 'fail')
  assert.match(rejectedReport.errors.join('\n'), /hash mismatch/u)
})
