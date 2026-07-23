import assert from 'node:assert/strict'
import {
  PublicRepresentationEvidence,
  compareClosedLoops,
  coordinateIdentity,
  manifest,
  projectCanonicalState,
  validateTransition
} from './public-representation-coordinate.mjs'

const projection = Object.freeze({
  rendererVersion: 'public-ssr-v4',
  frontendRelease: '20260723010101-0123456789ab',
  frontendAssetVersion: 'assets-0123456789ab',
  aedsProtocolVersion: 2,
  aedsSchemaIdentity: 'ArticleDetail:4'
})

const lifecycle = [
  ['create', { sourceVersion: 1, articleRevision: 1, publication: 0, visibilityVersion: 1, content: 'draft' }],
  ['update', { sourceVersion: 2, articleRevision: 2, publication: 0, visibilityVersion: 1, content: 'updated draft' }],
  ['publish', { sourceVersion: 3, articleRevision: 2, publication: 1, visibilityVersion: 2, content: 'published' }],
  ['archive', { sourceVersion: 4, articleRevision: 2, publication: 1, visibilityVersion: 3, content: 'published' }],
  ['restore', { sourceVersion: 5, articleRevision: 2, publication: 2, visibilityVersion: 4, content: 'restored' }],
  ['category-rename', { sourceVersion: 6, articleRevision: 2, publication: 2, visibilityVersion: 5, content: 'restored', category: 'engineering' }],
  ['tag-rename', { sourceVersion: 7, articleRevision: 2, publication: 2, visibilityVersion: 6, content: 'restored', category: 'engineering', tags: ['runtime'] }]
]

const evidence = new PublicRepresentationEvidence()
for (const [mutationKind, delta] of lifecycle) {
  const canonical = {
    routeIdentity: '/article/42',
    title: 'Coordinate contracts',
    hydrationPageKind: 'ArticleDetail',
    category: 'architecture',
    tags: ['contracts'],
    ...delta
  }
  const aot = projectCanonicalState(canonical, projection)
  const hotRead = projectCanonicalState(canonical, projection)
  assert.equal(compareClosedLoops(aot, hotRead).ok, true, `${mutationKind} closed loop`)
  assert.match(coordinateIdentity(aot), /^[0-9a-f]{64}$/u)
  evidence.recordRebuild(mutationKind, 'public-aot-html')
  evidence.recordRebuild(mutationKind, 'hydration-sidecar')
  evidence.recordRebuild(mutationKind, 'public-hot-read-aeds')
}

const current = projectCanonicalState({
  routeIdentity: '/article/42',
  sourceVersion: 9,
  articleRevision: 4,
  publication: 3,
  visibilityVersion: 7,
  title: 'Coordinate contracts',
  content: 'canonical',
  category: 'architecture',
  tags: ['contracts'],
  hydrationPageKind: 'ArticleDetail'
}, projection)

const negativeCases = [
  ['sidecar', 'materialize-runtime-entry', { hydrationSidecarDigest: 'f'.repeat(64) }],
  ['browser', 'artifact-to-browser-hydration', { rendererVersion: 'public-ssr-v3' }],
  ['browser', 'artifact-to-browser-hydration', { frontendAssetVersion: 'assets-old' }],
  ['service-worker', 'service-worker-navigation', { frontendRelease: '20260722010101-aaaaaaaaaaaa' }],
  ['hot-read', 'canonical-to-hot-read', { sourceVersion: '8' }],
  ['cache', 'materialize-runtime-entry', { documentDigest: '0'.repeat(64) }],
  ['browser', 'artifact-to-browser-hydration', { routeIdentity: '/article/99' }]
]

for (const [layer, transition, mutation] of negativeCases) {
  const result = validateTransition(transition, current, { ...current, ...mutation })
  assert.equal(result.ok, false, `${layer}/${transition} mismatch must fail closed`)
  assert.ok(result.fallback, `${layer}/${transition} must select deterministic fallback`)
  evidence.recordMismatch(layer, transition)
  evidence.recordFallback(layer, transition)
}

const summary = evidence.snapshot()
assert.equal(summary.schema, manifest.diagnostics.schema)
assert.deepEqual(Object.values(summary.rebuildAmplification), Array(lifecycle.length).fill(3))
console.log(JSON.stringify(summary, null, 2))
