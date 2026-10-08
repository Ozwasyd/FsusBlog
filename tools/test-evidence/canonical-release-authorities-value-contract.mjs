import path from 'node:path'

import { validateRuntimeRoleCurrentSchemaContract } from '../contracts/lib/runtime-role-current-schema-contract.mjs'

import { validateBehaviorDocStaticAdmissionReceiptV3 } from '../docs/behavior-doc-static-admission-contract.mjs'
import { verifyReleaseRolloutEvidence } from '../deployment/release-rollout-evidence-receipt-contract.mjs'
import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { createReleaseManifestValueContract } from '../release/release-manifest-value-contract.mjs'

const fail = (message) => { throw new Error(`[canonical-release-authorities] ${message}`) }
const normalized = (value) => String(value ?? '').replace(/^sha256:/u, '')

// Readers supply persisted input values and bytes, never validation decisions.
// Filesystem shape, symlink safety and subprocess execution remain with the caller.
function referencedJson(metadata, label, repositoryRoot, readJson)
{
  if (!metadata || typeof metadata.path !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(metadata.sha256 ?? ''))
  {
    fail(`${label} reference is invalid`)
  }
  const relative = path.isAbsolute(metadata.path)
    ? path.relative(repositoryRoot, metadata.path).replaceAll(path.sep, '/')
    : metadata.path
  const current = readJson(relative, label)
  if (current.ref.fileDigest !== metadata.sha256) fail(`${label} bytes changed after rollout seal`)
  return current
}

function verifyRuntimeRole(relative, plan, repositoryRoot, readJson)
{
  const admission = readJson(relative, 'runtime-role static admission')
  validateBehaviorDocStaticAdmissionReceiptV3(admission.value, {
    expectedSourceIdentity: {
      sourceCommit: plan.sourceState.commit,
      worktreeFingerprint: normalized(plan.sourceState.worktreeFingerprint)
    },
    expectedWorktree: repositoryRoot,
    expectedExtractorIds: readJson(
      'config/contracts/behavior-fact-extractors.json', 'extractor registry'
    ).value.extractors.map((extractor) => extractor.id).sort()
  })
  const minimal = admission.value.minimalContractBuild
  const artifact = minimal?.artifacts?.['runtime-role-observation']
  const buildReceipt = artifact?.buildReceipt
  if (buildReceipt?.schema !== 'fsusblog.runtime-role-observation-build-receipt.v3'
    || buildReceipt.sourceCommit !== plan.sourceState.commit
    || normalized(buildReceipt.worktreeFingerprint) !== normalized(plan.sourceState.worktreeFingerprint))
  {
    fail('runtime-role authority is not the merged typed v3 producer contract')
  }
  const observation = readJson(artifact.path, 'content-addressed runtime-role observation')
  const deployment = readJson(artifact.deploymentArtifactPath, 'content-addressed deployment observation')
  if (normalized(observation.ref.fileDigest) !== artifact.artifactDigest
    || normalized(deployment.ref.fileDigest) !== artifact.deploymentArtifactDigest
    || !validateRuntimeRoleCurrentSchemaContract(observation.value, { sourceCommit: plan.sourceState.commit })
    || deployment.value.ownership?.claimEligible !== true
    || observation.value.ownership?.claimEligible !== true
    || observation.value.deploymentAuthority?.observationDigest !== deployment.value.observationDigest
    || normalized(deployment.value.observationDigest) !== normalized(buildReceipt.deploymentObservationDigest))
  {
    fail('runtime-role/deployment raw artifacts are stale, synthetic, or not claim eligible')
  }
  return { admission, minimal, artifact, buildReceipt, observation, deployment }
}

export function verifyCanonicalReleaseAuthorityValues({
  candidatePlan: plan, rolloutEvidence, runtimeRoleAdmission, repositoryRoot, readJson, readBytes, now
})
{
  if (!plan || !repositoryRoot) fail('candidate plan and repository root are required')
  if (typeof readJson !== 'function' || typeof readBytes !== 'function' || !Number.isFinite(now))
    fail('explicit JSON/byte readers and verification time are required')
  const openedRollout = readJson(rolloutEvidence, 'release rollout evidence')
  let report
  try
  {
    report = verifyReleaseRolloutEvidence(openedRollout.value, {
      evidencePath: path.resolve(repositoryRoot, openedRollout.ref.path), readBytes, now
    })
  }
  catch (error)
  {
    report = { schema: 'fsusblog.release-rollout-evidence-verification.v1', status: 'fail',
      errors: [error instanceof Error ? error.message : String(error)] }
  }
  if (report.status !== 'pass' || report.rolloutId !== openedRollout.value.rolloutId)
    fail(`canonical release rollout verifier rejected evidence: ${report.errors.join('; ')}`)
  const rollout = { ...openedRollout, report }
  const runtimeRole = verifyRuntimeRole(runtimeRoleAdmission, plan, repositoryRoot, readJson)
  const manifest = referencedJson(rollout.value.auxiliary?.releaseManifest, 'release manifest', repositoryRoot, readJson)
  const { validateReleaseManifest } = createReleaseManifestValueContract({
    releaseIdContract: readJson('src/shared/Contracts/Validation/release-id-contract.json', 'release identity contract').value
  })
  const manifestErrors = validateReleaseManifest(manifest.value, {
    requireRegistryDigest: true,
    requireConcreteRuntimeProfile: true,
    expectedReleaseId: plan.candidate.releaseId,
    expectedImageDigest: rollout.value.target?.imageDigest,
    expectedCommitSha: plan.sourceState.commit
  })
  if (manifestErrors.length > 0) fail(`release manifest rejected: ${manifestErrors.join('; ')}`)
  if (rollout.value.status !== 'pass' || rollout.value.rolloutId !== plan.candidate.rolloutId
    || rollout.value.target?.releaseId !== plan.candidate.releaseId)
  {
    fail('rollout/candidate release identities do not exact-match')
  }
  return {
    rollout,
    runtimeRole,
    manifest,
    authorityDigest: `sha256:${digestValue(stable({
      rollout: rollout.ref.fileDigest,
      runtimeRole: runtimeRole.observation.ref.fileDigest,
      deployment: runtimeRole.deployment.ref.fileDigest,
      manifest: manifest.ref.fileDigest
    }))}`
  }
}
