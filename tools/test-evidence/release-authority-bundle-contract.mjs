import { seal } from '../fact-extractors/post-runtime/adapter.mjs'

export const releaseReadinessAuthorityBundleSchema = 'fsusblog.release-identity-readiness-authority-bundle.v1'
export const canonicalAuthorityBundleSchema = 'fsusblog.blue-green-containment-authority-bundle.v1'

// The caller owns persisted input and canonical authority verification.
export function buildReleaseReadinessAuthorityBundle({ planInput, plan, authorities })
{
  return seal({
    schema: releaseReadinessAuthorityBundleSchema,
    sourceState: plan.sourceState,
    candidatePlanRef: planInput.ref,
    rolloutEvidenceRef: authorities.rollout.ref,
    runtimeRoleAdmissionRef: authorities.runtimeRole.admission.ref,
    authorityDigest: authorities.authorityDigest,
    canonicalRerunCommand: `node tools/test-evidence/release-readiness-raw.mjs bundle-authorities --candidate-plan ${planInput.ref.path} --rollout-evidence ${authorities.rollout.ref.path} --runtime-role-admission ${authorities.runtimeRole.admission.ref.path}`
  })
}

export function buildBlueGreenAuthorityBundle({ candidatePlan, context, authorities })
{
  return seal({
    schema: canonicalAuthorityBundleSchema,
    sourceState: context.plan.sourceState,
    candidatePlanRef: context.candidatePlanRef,
    rolloutEvidenceRef: authorities.rollout.ref,
    runtimeRoleAdmissionRef: authorities.runtimeRole.admission.ref,
    authorityDigest: authorities.authorityDigest,
    canonicalRerunCommand: `node tools/test-evidence/blue-green-containment-raw.mjs bundle-authorities --candidate-plan ${candidatePlan} --rollout-evidence ${authorities.rollout.ref.path} --runtime-role-admission ${authorities.runtimeRole.admission.ref.path}`
  })
}
