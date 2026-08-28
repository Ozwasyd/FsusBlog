import assert from 'node:assert/strict'
import test from 'node:test'

import { loadCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import { parseRepositoryClaims } from '../../tools/docs/doc-claim.mjs'
import { loadRegistry } from '../../tools/fact-extractors/registry.mjs'
import { runExtractor } from '../../tools/fact-extractors/runner.mjs'
import {
  allowedObservationClasses,
  validatePostRuntimeProducerContracts
} from '../../tools/fact-extractors/post-runtime/registry.mjs'

test('post-runtime release behaviors derive exact-one producers from the existing catalog and registry', () =>
{
  const result = validatePostRuntimeProducerContracts({ claimReceipt: parseRepositoryClaims() })
  assert.equal(result.status, 'ok', result.errors.join('\n'))
  assert.deepEqual(result.behaviorIds, [
    'application-runtime-semantic-coherence',
    'release-deployment-runtime-containment'
  ])
  assert.deepEqual(result.producerIds, [
    'application-runtime-observation-producer',
    'release-deployment-observation-producer'
  ])
  assert.deepEqual(allowedObservationClasses, [
    'route-response-error-semantics',
    'aot-hydration-coherence',
    'cache-search-outbox-convergence',
    'session-cookie-runtime-coherence',
    'browser-behavior-contract',
    'release-identity-readiness',
    'blue-green-switch-rollback-containment'
  ])
})

test('missing, duplicate, orphan, shortcut, diagnostic, identity, and claim mappings fail closed', () =>
{
  const catalog = loadCatalog()
  const registry = loadRegistry()
  const claims = parseRepositoryClaims()

  const missing = structuredClone(registry)
  missing.extractors = missing.extractors.filter((entry) => entry.id !== 'application-runtime-observation-producer')
  const missingResult = validatePostRuntimeProducerContracts({ registry: missing, catalog, claimReceipt: claims })
  assert.ok(missingResult.errors.some((error) => /has no producer/u.test(error)))

  const duplicate = structuredClone(registry)
  duplicate.extractors.find((entry) => entry.id === 'release-deployment-observation-producer')
    .ownedBehaviorIds = ['application-runtime-semantic-coherence']
  assert.throws(
    () => validatePostRuntimeProducerContracts({ registry: duplicate, catalog, claimReceipt: claims }),
    /dual extractor owners/u
  )

  const shortcut = structuredClone(registry)
  shortcut.extractors.find((entry) => entry.id === 'application-runtime-observation-producer')
    .runtimeContract.observationClasses.push('http-200')
  const shortcutResult = validatePostRuntimeProducerContracts({ registry: shortcut, catalog, claimReceipt: claims })
  assert.ok(shortcutResult.errors.some((error) => /unknown observation class|shortcut/u.test(error)))

  const missingIdentity = structuredClone(registry)
  missingIdentity.extractors.find((entry) => entry.id === 'application-runtime-observation-producer')
    .runtimeContract.requiredIdentities = ['artifact']
  const identityResult = validatePostRuntimeProducerContracts({ registry: missingIdentity, catalog, claimReceipt: claims })
  assert.ok(identityResult.errors.some((error) => /missing identity source-worktree/u.test(error)))

  const unknownClaim = structuredClone(registry)
  unknownClaim.extractors.find((entry) => entry.id === 'application-runtime-observation-producer')
    .runtimeContract.acceptedClaimIds = ['missing.claim']
  const claimResult = validatePostRuntimeProducerContracts({ registry: unknownClaim, catalog, claimReceipt: claims })
  assert.ok(claimResult.errors.some((error) => /unknown claim/u.test(error)))

  const diagnostic = structuredClone(registry)
  diagnostic.extractors.find((entry) => entry.id === 'application-runtime-observation-producer')
    .runtimeContract.diagnosticEligibility = 'accepted'
  assert.throws(
    () => validatePostRuntimeProducerContracts({ registry: diagnostic, catalog, claimReceipt: claims }),
    /correctness-only qualification/u
  )
})

test('static runner cannot execute a registered post-runtime adapter', async () =>
{
  await assert.rejects(
    () => runExtractor({ extractorId: 'application-runtime-observation-producer', useCache: false }),
    /post-runtime adapter/u
  )
})
