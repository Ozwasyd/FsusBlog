import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  PublicRepresentationEvidence,
  canonicalDigest,
  compareClosedLoops,
  coordinateIdentity,
  createCoordinate,
  manifest,
  normalizeCoordinate,
  projectCanonicalState,
  sha256,
  validateTransition
} from '../../tools/contracts/public-representation-coordinate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const projection = Object.freeze({
  rendererVersion: 'public-ssr-v4',
  frontendRelease: '20260723010101-0123456789ab',
  frontendAssetVersion: 'assets-0123456789ab',
  aedsProtocolVersion: 2,
  aedsSchemaIdentity: 'ArticleDetail:4'
})
const baseState = Object.freeze({
  routeIdentity: '/article/42',
  sourceVersion: 1,
  articleRevision: 1,
  publication: 1,
  visibilityVersion: 1,
  title: 'Coordinate contracts',
  content: 'canonical',
  category: 'architecture',
  tags: ['contracts'],
  hydrationPageKind: 'ArticleDetail'
})

test('manifest is the single coordinate authority and delegates release/AEDS identity', async () => {
  assert.equal(manifest.schema, 'fsusblog.public-representation-coordinate.v1')
  assert.equal(manifest.existingAuthorities.aedsProtocol, 'src/shared/Contracts/Validation/aeds-protocol.json')
  assert.equal(manifest.existingAuthorities.releaseIdentity, 'src/shared/Contracts/Validation/release-id-contract.json')
  assert.equal(new Set(manifest.fields.map(({ name }) => name)).size, manifest.fields.length)
  assert.equal(new Set(manifest.transitions.map(({ id }) => id)).size, manifest.transitions.length)

  const generated = [
    'src/shared/Contracts/Validation/PublicRepresentationCoordinate.Generated.cs',
    'src/frontend/src/generated/publicRepresentationCoordinate.ts',
    'src/frontend/wasm/aeds/include/public_representation_coordinate.hpp'
  ]
  for (const relative of generated) {
    const source = await readFile(path.join(root, relative), 'utf8')
    assert.match(source, /Generated from src\/shared\/Contracts\/Validation\/public-representation-coordinate\.json/u)
    assert.match(source, /fsusblog\.public-representation-coordinate\.v1/u)
    if (relative.endsWith('.ts')) {
      assert.match(source, /sourceVersion: string/u, 'uint64 coordinates must not lose precision in JavaScript')
    }
  }

  const generatedCheck = spawnSync(
    process.execPath,
    ['tools/contracts/generate-public-representation-coordinate.mjs', '--check'],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(generatedCheck.status, 0, generatedCheck.stderr || generatedCheck.stdout)
})

test('coordinate sealing is deterministic and content addressed', () => {
  const candidate = projectCanonicalState(baseState, projection)
  assert.equal(coordinateIdentity(candidate), coordinateIdentity({ ...candidate }))
  assert.notEqual(coordinateIdentity(candidate), coordinateIdentity({ ...candidate, sourceVersion: '2' }))

  const documentBytes = Buffer.from('<html>sealed</html>')
  const hydrationSidecarBytes = Buffer.from('AEDS-sidecar')
  const sealed = createCoordinate(candidate, { documentBytes, hydrationSidecarBytes })
  assert.equal(sealed.documentDigest, sha256(documentBytes))
  assert.equal(sealed.hydrationSidecarDigest, sha256(hydrationSidecarBytes))
  assert.match(canonicalDigest(['route', 1, 'payload']), /^[0-9a-f]{64}$/u)
})

test('two public projection loops preserve canonical invariants over lifecycle mutations', () => {
  const mutations = [
    ['create', 1, 1, 0, 1, 'draft'],
    ['update', 2, 2, 0, 1, 'updated'],
    ['publish', 3, 2, 1, 2, 'published'],
    ['archive', 4, 2, 1, 3, 'published'],
    ['restore', 5, 2, 2, 4, 'restored']
  ]

  for (const [kind, sourceVersion, articleRevision, publication, visibilityVersion, content] of mutations) {
    const state = { ...baseState, sourceVersion, articleRevision, publication, visibilityVersion, content }
    const aotHtmlSidecarHydrate = projectCanonicalState(state, projection)
    const hotReadAedsDecoder = projectCanonicalState(state, projection)
    assert.deepEqual(compareClosedLoops(aotHtmlSidecarHydrate, hotReadAedsDecoder), {
      ok: true,
      transition: 'closed-loop',
      fallback: null,
      mismatches: []
    }, kind)
  }
})

test('renames change SEO/content coordinates while both loops still converge', () => {
  const before = projectCanonicalState(baseState, projection)
  const categoryRename = projectCanonicalState({
    ...baseState,
    sourceVersion: 2,
    visibilityVersion: 2,
    category: 'engineering'
  }, projection)
  const tagRename = projectCanonicalState({
    ...baseState,
    sourceVersion: 3,
    visibilityVersion: 3,
    tags: ['runtime']
  }, projection)

  assert.notEqual(before.seoIdentity, categoryRename.seoIdentity)
  assert.notEqual(before.documentDigest, categoryRename.documentDigest)
  assert.notEqual(before.seoIdentity, tagRename.seoIdentity)
  assert.equal(compareClosedLoops(categoryRename, { ...categoryRename }).ok, true)
  assert.equal(compareClosedLoops(tagRename, { ...tagRename }).ok, true)
})

test('renderer assets release sidecar route and source mismatches fail closed deterministically', () => {
  const expected = projectCanonicalState(baseState, projection)
  const cases = [
    ['artifact-to-browser-hydration', { rendererVersion: 'public-ssr-v3' }, 'network-canonical-route', 'rendererVersion'],
    ['artifact-to-browser-hydration', { frontendAssetVersion: 'assets-old' }, 'network-canonical-route', 'frontendAssetVersion'],
    ['service-worker-navigation', { frontendRelease: '20260722010101-aaaaaaaaaaaa' }, 'network-navigation', 'frontendRelease'],
    ['materialize-runtime-entry', { hydrationSidecarDigest: 'f'.repeat(64) }, 'evict-and-rebuild', 'hydrationSidecarDigest'],
    ['materialize-runtime-entry', { documentDigest: '0'.repeat(64) }, 'evict-and-rebuild', 'documentDigest'],
    ['canonical-to-hot-read', { sourceVersion: '2' }, 'hot-read-not-ready', 'sourceVersion'],
    ['artifact-to-browser-hydration', { routeIdentity: '/article/99' }, 'network-canonical-route', 'routeIdentity']
  ]

  for (const [transition, mutation, fallback, field] of cases) {
    const result = validateTransition(transition, expected, { ...expected, ...mutation })
    assert.equal(result.ok, false)
    assert.equal(result.fallback, fallback)
    assert.ok(result.mismatches.some((mismatch) => mismatch.field === field))
  }
})

test('malformed and incomplete coordinates are rejected instead of hydrated', () => {
  const complete = projectCanonicalState(baseState, projection)
  assert.throws(
    () => normalizeCoordinate({ ...complete, routeIdentity: '' }),
    /public_representation_coordinate_missing:routeIdentity/u
  )
  assert.throws(
    () => normalizeCoordinate({ ...complete, documentDigest: 'not-a-digest' }),
    /public_representation_coordinate_invalid:documentDigest/u
  )
  assert.throws(
    () => normalizeCoordinate({ ...complete, aedsProtocolVersion: 256 }),
    /public_representation_coordinate_invalid:aedsProtocolVersion/u
  )
})

test('evidence dimensions stay bounded and expose rebuild amplification', () => {
  const evidence = new PublicRepresentationEvidence()
  evidence.recordMismatch('browser', 'artifact-to-browser-hydration')
  evidence.recordFallback('browser', 'artifact-to-browser-hydration')
  evidence.recordClosedLoopMismatch()
  evidence.recordRebuild('publish', 'public-aot-html')
  evidence.recordRebuild('publish', 'hydration-sidecar')
  evidence.recordRebuild('publish', 'public-hot-read-aeds')

  const snapshot = evidence.snapshot()
  assert.equal(snapshot.rebuildAmplification.publish, 3)
  assert.equal(
    snapshot.counters['representationCoordinateMismatch|browser|artifact-to-browser-hydration'],
    1
  )
  assert.throws(
    () => evidence.recordMismatch('/article/42', 'artifact-to-browser-hydration'),
    /public_representation_layer_unknown/u
  )
  for (const forbidden of manifest.diagnostics.highCardinalityLabelsForbidden) {
    assert.ok(!Object.keys(snapshot.counters).some((key) => key.includes(baseState[forbidden] ?? 'never')))
  }
})
