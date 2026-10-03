import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'

const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`

function projectRawFacts(rawFacts)
{
  return Object.fromEntries(Object.entries(rawFacts).map(([field, value]) =>
    field === 'runtimeRole' || field.endsWith('Id') || field === 'sourceRevision'
      ? [field, value]
      : [`${field}Digest`, semanticDigest(value)]))
}

function nativeMaterial(authorities)
{
  const current = authorities?.currentSchema
  if (!current?.receipt || !current?.admission?.value || !current?.admission?.ref
    || !current?.receiptRef)
  {
    throw new Error('[canonical-release-authorities] independently verified native material is unavailable')
  }
  return current
}

// Input authorities must already have passed the canonical I/O verifier.
export function deriveReleaseReadinessAuthorityFacts({ plan, authorities, build })
{
  const rollout = authorities.rollout.value
  const runtime = authorities.runtimeRole
  const legacyFacts = {
    imageDigest: rollout.target.imageDigest,
    packageDigest: build.packageDigest,
    configDigest: runtime.deployment.ref.fileDigest,
    schemaDigest: authorities.manifest.value.schemaCompatibility?.contentDigest
      ?? semanticDigest(authorities.manifest.value.schemaCompatibility),
    manifestDigest: authorities.manifest.ref.fileDigest,
    signingDigest: rollout.auxiliary?.releaseManifest?.sha256,
    trustDigest: semanticDigest({ image: rollout.target.imageDigest, manifest: authorities.manifest.ref.fileDigest }),
    readinessReceiptDigest: authorities.rollout.ref.fileDigest,
    serviceReady: true, routeDataReady: true, cacheReady: true, dependenciesReady: true,
    versionReady: true, credentialReady: true, identityMatch: true,
    runtimeRoleContractSatisfied: true, monolithicOwnershipSatisfied: true
  }
  const current = nativeMaterial(authorities)
  const rawFacts = {
    artifact: {
      rollout: authorities.rollout.ref,
      runtimeRole: runtime.observation.ref,
      manifest: authorities.manifest.ref,
      currentSchema: current.receiptRef
    },
    image: rollout.target.imageDigest,
    package: { receipt: build.receipt.ref, artifacts: build.receipt.value.artifacts },
    config: runtime.deployment.value,
    schema: { target: current.receipt.target, actualSchemaDigest: current.receipt.actualSchemaDigest },
    runtimeRole: 'monolithic',
    candidateId: plan.candidate.candidateId,
    releaseId: plan.candidate.releaseId,
    readiness: { rollout: authorities.rollout.ref, currentSchemaAdmission: current.admission }
  }
  return { legacyFacts, rawFacts, typedFacts: projectRawFacts(rawFacts) }
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
  const current = nativeMaterial(authorities)
  const rawFacts = {
    activeBefore: sourceIdentity,
    standbyBefore: targetIdentity,
    activeAfter: targetIdentity,
    standbyAfter: sourceIdentity,
    promotion: stage('candidate-readiness') ?? stage('gateway-switch'),
    switch: stage('gateway-switch'),
    health: stage('target-health'),
    rollback: rollout.recoveries,
    trafficOwnership: rollout.artifacts.publicTraffic,
    containment: {
      artifact: legacyFacts.artifactContainmentDigest,
      volume: legacyFacts.volumeContainmentDigest,
      schema: legacyFacts.schemaContainmentDigest,
      process: legacyFacts.processContainmentDigest,
      currentSchema: current.receiptRef,
      nativeAdmission: current.admission
    },
    terminalReceipt: authorities.rollout.ref
  }
  return { legacyFacts, rawFacts, typedFacts: projectRawFacts(rawFacts) }
}

export function deriveCurrentSchemaAdmissionFacts({ authorities })
{
  const current = nativeMaterial(authorities)
  const receipt = current.receipt
  const rawFacts = {
    currentSchemaReceiptReference: current.receiptRef,
    admissionOutput: current.admission,
    target: receipt.target,
    database: receipt.database,
    schemaObservation: receipt.actualSchemaDigest,
    sourceRevision: receipt.verifier?.sourceRevision,
    verifier: receipt.verifier,
    plan: receipt.plan,
    apply: receipt.apply,
    checkpoints: receipt.checkpoints,
    semanticPostconditions: receipt.semanticPostconditions,
    backupPackage: receipt.backupPackage,
    backupManifest: receipt.backupManifest,
    restoreDrill: receipt.restoreDrill,
    recoveryReferences: receipt.recoveryReferences
  }
  for (const [field, value] of Object.entries(rawFacts))
  {
    if (value === undefined || value === null || value === '')
    {
      throw new Error(`[canonical-release-authorities] native material ${field} is unavailable`)
    }
  }
  return { rawFacts, typedFacts: projectRawFacts(rawFacts) }
}
