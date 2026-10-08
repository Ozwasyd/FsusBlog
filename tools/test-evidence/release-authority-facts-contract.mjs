import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'

const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`

// Input authorities must already have passed the canonical I/O verifier.
export function deriveReleaseReadinessAuthorityFacts({ plan, authorities, build })
{
  const rollout = authorities.rollout.value
  const runtime = authorities.runtimeRole
  const legacyFacts = {
    imageDigest: rollout.target.imageDigest,
    packageDigest: build.packageDigest,
    configDigest: runtime.deployment.ref.fileDigest,
    schemaDigest: authorities.manifest.value.currentSchema.receiptContentDigest,
    manifestDigest: authorities.manifest.ref.fileDigest,
    signingDigest: rollout.auxiliary?.releaseManifest?.sha256,
    trustDigest: semanticDigest({ image: rollout.target.imageDigest, manifest: authorities.manifest.ref.fileDigest }),
    readinessReceiptDigest: authorities.rollout.ref.fileDigest,
    serviceReady: true, routeDataReady: true, cacheReady: true, dependenciesReady: true,
    versionReady: true, credentialReady: true, identityMatch: true,
    runtimeRoleContractSatisfied: true, monolithicOwnershipSatisfied: true
  }
  const typedFacts = {
    artifactDigest: authorities.authorityDigest,
    imageDigest: rollout.target.imageDigest,
    packageDigest: build.packageDigest,
    configDigest: runtime.deployment.ref.fileDigest,
    schemaDigest: legacyFacts.schemaDigest,
    runtimeRole: 'monolithic',
    candidateId: plan.candidate.candidateId,
    releaseId: plan.candidate.releaseId,
    readinessDigest: authorities.rollout.ref.fileDigest
  }
  return { legacyFacts, typedFacts }
}

export function deriveBlueGreenAuthorityFacts({ authorities })
{
  const rollout = authorities.rollout.value
  const stage = (id) => rollout.stages.find(({ stage: stageId }) => stageId === id)
  const sourceIdentity = rollout.source
  const targetIdentity = rollout.target
  const legacyFacts = {
    activeBeforeDigest: semanticDigest(sourceIdentity),
    standbyBeforeDigest: semanticDigest(targetIdentity),
    activeAfterDigest: semanticDigest(targetIdentity),
    standbyAfterDigest: semanticDigest(sourceIdentity),
    promotionReceiptDigest: semanticDigest(stage('candidate-readiness') ?? stage('gateway-switch')),
    switchReceiptDigest: semanticDigest(stage('gateway-switch')),
    healthReceiptDigest: semanticDigest(stage('target-health')),
    rollbackReceiptDigest: semanticDigest(rollout.recoveries),
    failureReceiptDigest: rollout.artifacts.faultInjection.sha256,
    trafficOwnershipDigest: rollout.artifacts.publicTraffic.sha256,
    artifactContainmentDigest: rollout.artifacts.assetCompatibility.sha256,
    volumeContainmentDigest: rollout.artifacts.resourceBudget.sha256,
    schemaContainmentDigest: rollout.auxiliary.compatibilityMatrix.sha256,
    processContainmentDigest: authorities.runtimeRole.observation.ref.fileDigest,
    cleanupReceiptDigest: semanticDigest(stage('release-evidence')),
    terminalReceiptDigest: authorities.rollout.ref.fileDigest,
    activeReleaseProtected: true, activeIdentityKnown: true, switchComplete: true,
    splitBrainAbsent: true, cleanupInactiveOnly: true, sharedFactsPreserved: true,
    runtimeRoleContractSatisfied: true
  }
  const typedFacts = {
    activeBeforeDigest: legacyFacts.activeBeforeDigest,
    standbyBeforeDigest: legacyFacts.standbyBeforeDigest,
    activeAfterDigest: legacyFacts.activeAfterDigest,
    standbyAfterDigest: legacyFacts.standbyAfterDigest,
    promotionDigest: legacyFacts.promotionReceiptDigest,
    switchDigest: legacyFacts.switchReceiptDigest,
    healthDigest: legacyFacts.healthReceiptDigest,
    rollbackDigest: legacyFacts.rollbackReceiptDigest,
    trafficOwnershipDigest: legacyFacts.trafficOwnershipDigest,
    containmentDigest: semanticDigest({
      artifact: legacyFacts.artifactContainmentDigest,
      volume: legacyFacts.volumeContainmentDigest,
      schema: legacyFacts.schemaContainmentDigest,
      process: legacyFacts.processContainmentDigest
    }),
    terminalReceiptDigest: legacyFacts.terminalReceiptDigest
  }
  return { legacyFacts, typedFacts }
}
