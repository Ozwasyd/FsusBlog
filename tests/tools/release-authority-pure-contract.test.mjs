import assert from 'node:assert/strict'
import test from 'node:test'
import { digestValue, stable } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { buildReleaseReadinessAuthorityBundle, buildBlueGreenAuthorityBundle } from '../../tools/test-evidence/release-authority-bundle-contract.mjs'
import { deriveReleaseReadinessAuthorityFacts, deriveBlueGreenAuthorityFacts } from '../../tools/test-evidence/release-authority-facts-contract.mjs'
import { seal as pureSeal } from '../../tools/fact-extractors/post-runtime/receipt-seal-contract.mjs'
import { createPureReleaseAuthorityFixture } from './support/pure-release-authority-fixture.mjs'

const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`
const pureAuthorityFixture = () => createPureReleaseAuthorityFixture(semanticDigest)

test('pure release authority seal preserves the original digest convention', () =>
{
  const value = { z: [{ b: 2, a: 1 }], a: true, contentDigest: 'stale' }
  const expected = { ...stable(value), contentDigest: null }
  expected.contentDigest = semanticDigest(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'contentDigest')))
  assert.deepEqual(pureSeal(value), expected)
  assert.equal(value.contentDigest, 'stale')
})

test('pure release authority bundle and facts preserve original-body golden parity', () =>
{
  const fixture = pureAuthorityFixture()
  const snapshot = structuredClone(fixture)
  const context = { plan: fixture.plan, candidatePlanRef: fixture.planInput.ref }
  const actual = {
    releaseBundle: buildReleaseReadinessAuthorityBundle(fixture),
    blueGreenBundle: buildBlueGreenAuthorityBundle({ ...fixture, candidatePlan: fixture.planInput.ref.path, context }),
    releaseFacts: deriveReleaseReadinessAuthorityFacts(fixture),
    blueGreenFacts: deriveBlueGreenAuthorityFacts(fixture)
  }
  // Exact golden changes only for the current receipt authority; bundle and other facts retain original parity.
  assert.equal(semanticDigest(actual), 'sha256:8cce190d06a3b8e1cb4f6349fa7a44c200ffe9551225d6cf038ee17183dd8468')
  const baseline = structuredClone(actual)
  baseline.releaseFacts.legacyFacts.schemaDigest = semanticDigest({ minimum: 1, maximum: 2 })
  baseline.releaseFacts.typedFacts.schemaDigest = baseline.releaseFacts.legacyFacts.schemaDigest
  assert.equal(semanticDigest(baseline), 'sha256:52c0b87d0be0abf9a13d578164af0910679485fa3e7f6ac7b3b7df494fa0e0d4')
  assert.equal(actual.releaseFacts.typedFacts.schemaDigest, fixture.authorities.manifest.value.currentSchema.receiptContentDigest)
  assert.deepEqual(fixture, snapshot)
})

test('pure release authority facts follow current inputs and preserve projection fallbacks', () =>
{
  const fixture = pureAuthorityFixture()
  fixture.build.packageDigest = semanticDigest('changed-package')
  fixture.authorities.manifest.value.currentSchema.receiptContentDigest = semanticDigest('explicit-schema')
  const release = deriveReleaseReadinessAuthorityFacts(fixture)
  assert.equal(release.typedFacts.packageDigest, fixture.build.packageDigest)
  assert.equal(release.legacyFacts.packageDigest, fixture.build.packageDigest)
  assert.equal(release.typedFacts.schemaDigest, fixture.authorities.manifest.value.currentSchema.receiptContentDigest)
  fixture.authorities.rollout.value.stages = fixture.authorities.rollout.value.stages.filter(({ stage }) => stage !== 'candidate-readiness')
  const blue = deriveBlueGreenAuthorityFacts(fixture)
  assert.equal(blue.typedFacts.promotionDigest, blue.typedFacts.switchDigest)
  fixture.authorities.rollout.value.artifacts.assetCompatibility.sha256 = semanticDigest('changed-assets')
  assert.notEqual(deriveBlueGreenAuthorityFacts(fixture).typedFacts.containmentDigest, blue.typedFacts.containmentDigest)
})


test('release authority facts require the current receipt projection and reject the old schema window', () =>
{
  const fixture = pureAuthorityFixture()
  fixture.authorities.manifest.value = { schemaCompatibility: { minimum: 1, maximum: 2 } }
  assert.throws(() => deriveReleaseReadinessAuthorityFacts(fixture), /receiptContentDigest/u)
})
