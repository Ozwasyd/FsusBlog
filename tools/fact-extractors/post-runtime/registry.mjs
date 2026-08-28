import { loadCatalog, validateCatalog } from '../../contracts/behavior-contract-catalog.mjs'
import { loadRegistry, validateRegistry } from '../registry.mjs'

export const allowedObservationClasses = Object.freeze([
  'route-response-error-semantics',
  'aot-hydration-coherence',
  'cache-search-outbox-convergence',
  'session-cookie-runtime-coherence',
  'browser-behavior-contract',
  'release-identity-readiness',
  'blue-green-switch-rollback-containment'
])

const requiredIdentityClasses = Object.freeze([
  'artifact',
  'build',
  'candidate',
  'fixture',
  'profile',
  'run-attempt',
  'runtime',
  'source-worktree',
  'toolchain'
])

const shortcutPattern = /(?:http-?200|file-exists|artifact-path|screenshot|job-success|tier-green|latest)/iu

/** Validate the post-runtime slice of the one BehaviorCatalog/ExtractorRegistry pair. */
export function validatePostRuntimeProducerContracts({
  registry = loadRegistry(),
  catalog = loadCatalog(),
  claimReceipt = null,
  repositoryRoot
} = {})
{
  validateCatalog(catalog, repositoryRoot)
  const validated = validateRegistry(registry, repositoryRoot)
  const postBehaviors = catalog.contracts.filter((contract) =>
    contract.status === 'active'
    && contract.releaseQualification === true
    && contract.evidenceStage === 'post-runtime')
  const postExtractors = registry.extractors.filter((extractor) => extractor.evidenceStage === 'post-runtime')
  const errors = []
  const behaviorOwners = new Map()
  const claimOwners = new Map()
  const allowed = new Set(allowedObservationClasses)
  const knownClaims = claimReceipt == null
    ? null
    : new Set((claimReceipt.claims ?? []).map((claim) => claim.declaration?.claimId).filter(Boolean))

  for (const extractor of postExtractors)
  {
    for (const behaviorId of extractor.ownedBehaviorIds)
    {
      if (behaviorOwners.has(behaviorId)) errors.push(`duplicate runtime producer for ${behaviorId}`)
      behaviorOwners.set(behaviorId, extractor.id)
    }
    const runtime = extractor.runtimeContract
    for (const observationClass of runtime?.observationClasses ?? [])
    {
      if (!allowed.has(observationClass)) errors.push(`${extractor.id} has unknown observation class ${observationClass}`)
      if (shortcutPattern.test(observationClass)) errors.push(`${extractor.id} uses existence/job shortcut ${observationClass}`)
    }
    for (const identity of requiredIdentityClasses)
    {
      if (!(runtime?.requiredIdentities ?? []).includes(identity)) errors.push(`${extractor.id} missing identity ${identity}`)
    }
    for (const claimId of runtime?.acceptedClaimIds ?? [])
    {
      if (knownClaims && !knownClaims.has(claimId)) errors.push(`${extractor.id} references unknown claim ${claimId}`)
      if (claimOwners.has(claimId)) errors.push(`claim ${claimId} has duplicate runtime producers`)
      claimOwners.set(claimId, extractor.id)
    }
  }
  for (const behavior of postBehaviors)
  {
    const owner = behaviorOwners.get(behavior.id)
    if (!owner) errors.push(`post-runtime behavior ${behavior.id} has no producer`)
    if (owner && behavior.factExtractorId !== owner) errors.push(`post-runtime behavior ${behavior.id} owner mismatch`)
  }
  for (const [behaviorId, producerId] of behaviorOwners)
  {
    if (!postBehaviors.some((behavior) => behavior.id === behaviorId)) errors.push(`orphan post-runtime producer ${producerId}/${behaviorId}`)
  }
  return {
    status: errors.length === 0 ? 'ok' : 'failed',
    behaviorIds: postBehaviors.map((behavior) => behavior.id).sort(),
    producerIds: postExtractors.map((extractor) => extractor.id).sort(),
    registryDigest: validated.digest,
    errors: [...new Set(errors)].sort()
  }
}
