import assert from 'node:assert/strict'
import test from 'node:test'
import { digestValue, stable } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { buildReleaseReadinessAuthorityBundle, buildBlueGreenAuthorityBundle } from '../../tools/test-evidence/release-authority-bundle-contract.mjs'
import { deriveReleaseReadinessAuthorityFacts, deriveBlueGreenAuthorityFacts } from '../../tools/test-evidence/release-authority-facts-contract.mjs'
import { seal as pureSeal } from '../../tools/fact-extractors/post-runtime/receipt-seal-contract.mjs'

const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`
// Synthetic value fixtures and original-body golden from aaba0885; no runtime qualification.
function pureAuthorityFixture()
{
  const reference = (name) => ({ path: `.tmp/${name}.json`, fileDigest: semanticDigest(name), contentDigest: null })
  return {
    plan: { sourceState: { commit: 'a'.repeat(40) }, candidate: { candidateId: 'candidate-1', releaseId: 'release-1' } },
    planInput: { ref: reference('plan') },
    build: { packageDigest: semanticDigest('package') },
    authorities: {
      authorityDigest: semanticDigest('authority'),
      rollout: { ref: reference('rollout'), value: {
        source: { releaseId: 'old' }, target: { releaseId: 'new', imageDigest: semanticDigest('image') },
        stages: ['candidate-readiness', 'gateway-switch', 'target-health', 'release-evidence'].map(stage => ({ stage, status: 'pass' })),
        recoveries: [],
        artifacts: Object.fromEntries(['faultInjection', 'publicTraffic', 'assetCompatibility', 'resourceBudget'].map(name => [name, { sha256: semanticDigest(name) }])),
        auxiliary: { compatibilityMatrix: { sha256: semanticDigest('matrix') }, releaseManifest: { sha256: semanticDigest('manifest') } }
      } },
      runtimeRole: { admission: { ref: reference('admission') }, deployment: { ref: reference('deployment') }, observation: { ref: reference('observation') } },
      manifest: { ref: reference('manifest'), value: { schemaCompatibility: { minimum: 1, maximum: 2 } } }
    }
  }
}

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
  // Captured from original bundle bodies at 0e8ed680 and projector bodies at 311cf194e.
  assert.equal(semanticDigest(actual), 'sha256:52c0b87d0be0abf9a13d578164af0910679485fa3e7f6ac7b3b7df494fa0e0d4')
  assert.deepEqual(fixture, snapshot)
})

test('pure release authority facts follow current inputs and preserve projection fallbacks', () =>
{
  const fixture = pureAuthorityFixture()
  fixture.build.packageDigest = semanticDigest('changed-package')
  fixture.authorities.manifest.value.schemaCompatibility.contentDigest = semanticDigest('explicit-schema')
  const release = deriveReleaseReadinessAuthorityFacts(fixture)
  assert.equal(release.typedFacts.packageDigest, fixture.build.packageDigest)
  assert.equal(release.legacyFacts.packageDigest, fixture.build.packageDigest)
  assert.equal(release.typedFacts.schemaDigest, fixture.authorities.manifest.value.schemaCompatibility.contentDigest)
  fixture.authorities.rollout.value.stages = fixture.authorities.rollout.value.stages.filter(({ stage }) => stage !== 'candidate-readiness')
  const blue = deriveBlueGreenAuthorityFacts(fixture)
  assert.equal(blue.typedFacts.promotionDigest, blue.typedFacts.switchDigest)
  fixture.authorities.rollout.value.artifacts.assetCompatibility.sha256 = semanticDigest('changed-assets')
  assert.notEqual(deriveBlueGreenAuthorityFacts(fixture).typedFacts.containmentDigest, blue.typedFacts.containmentDigest)
})
