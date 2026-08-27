import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs'
import { observeAotGeneration } from '../../tools/test-fixtures/observers/aot-generation.mjs'
import { digest, noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs'

const identity = runtimeIdentity()
const domain = 'artifact.public-aot-overlay'
const artifactBytes = { home: '<html>home</html>', article: '<html>article</html>' }
const artifacts = Object.entries(artifactBytes).map(([id, bytes]) => ({ id, ref: `${id}.html`, contentDigest: digest(bytes) }))
const routes = { '/': 'home', '/article/example': 'article' }

function manifest(overrides = {}) {
  const body = {
    schema: 'fsusblog.aot-generation.v1',
    generationId: 'generation-a',
    sourceCommit: identity.sourceCommit,
    buildReceiptDigest: identity.buildReceiptDigest,
    artifacts,
    routes,
    ...overrides
  }
  return { ...body, contentDigest: digestCanonical(body) }
}

const handle = {
  owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
  catalogDigest: identity.catalogDigest,
  overlayId: 'overlay-a',
  activeGenerationRef: { generationId: 'generation-a', authorityDigest: digest('active') },
  manifestRef: { contentDigest: manifest().contentDigest },
  expectedArtifacts: artifacts,
  expectedRoutes: routes
}

function context(document = manifest(), active = { status: 'active', generationId: 'generation-a', authorityDigest: digest('active') }) {
  return {
    handles: { [domain]: { ...handle, manifestRef: { contentDigest: document.contentDigest } } },
    ports: {
      aotGeneration: {
        readonly: true,
        async readActiveGeneration() { return active },
        async readManifest() { return document },
        async openArtifact({ artifactId }) { return Readable.from([artifactBytes[artifactId]]) },
        async readSideEffectCounters() { return noSideEffects() }
      }
    }
  }
}

test('AOT observer binds active pointer, manifest, artifacts and routes without mtime authority', async () => {
  const result = await observeAotGeneration({ domain, identity, context: context() })
  assert.equal(result.semantic.generationId, 'generation-a')
  assert.equal(result.semantic.artifacts.length, 2)
  assert.equal(JSON.stringify(result).includes('mtime'), false)
})

test('AOT observer rejects ambiguity, tamper, extra routes and cross-build generation', async () => {
  await assert.rejects(observeAotGeneration({ domain, identity, context: context(manifest(), { status: 'ambiguous' }) }), /missing or ambiguous/)
  await assert.rejects(observeAotGeneration({ domain, identity, context: context({ ...manifest(), generationId: 'other' }) }), /disagrees/)
  await assert.rejects(observeAotGeneration({ domain, identity, context: context(manifest({ routes: { ...routes, '/extra': 'home' } })) }), /route\/output mapping/)
  const tampered = manifest()
  tampered.routes['/tampered'] = 'home'
  await assert.rejects(observeAotGeneration({ domain, identity, context: context(tampered) }), /tampered/)
})
