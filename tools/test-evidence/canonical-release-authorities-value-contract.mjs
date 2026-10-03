import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { validateBehaviorDocStaticAdmissionReceiptV3 } from '../docs/behavior-doc-static-admission-contract.mjs'
import { verifyReleaseRolloutEvidence } from '../deployment/release-rollout-evidence-receipt-contract.mjs'
import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { createReleaseManifestValueContract, validateCurrentSchemaAdmissionOutput } from '../release/release-manifest-value-contract.mjs'
import { validateCurrentSchemaCodeContractObservation } from '../docs/behavior-doc-minimal-contract-build-v3-contract.mjs'

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

function verifyRuntimeRole(relative, plan, repositoryRoot, readJson, expectedClaimStageAuthority)
{
  const admission = readJson(relative, 'runtime-role static admission')
  validateBehaviorDocStaticAdmissionReceiptV3(admission.value, {
    expectedSourceIdentity: {
      sourceCommit: plan.sourceState.commit,
      worktreeFingerprint: normalized(plan.sourceState.worktreeFingerprint)
    },
    expectedWorktree: repositoryRoot,
    expectedClaimStageAuthority,
    expectedExtractorIds: readJson(
      'config/contracts/behavior-fact-extractors.json', 'extractor registry'
    ).value.extractors.map((extractor) => extractor.id).sort()
  })
  const minimal = admission.value.minimalContractBuild
  const artifact = minimal?.artifacts?.['runtime-role-observation']
  const buildReceipt = artifact?.buildReceipt
  if (buildReceipt?.schema !== 'fsusblog.runtime-role-observation-build-receipt.v4'
    || buildReceipt.sourceCommit !== plan.sourceState.commit
    || normalized(buildReceipt.worktreeFingerprint) !== normalized(plan.sourceState.worktreeFingerprint))
  {
    fail('runtime-role authority is not the current typed v4 build producer contract')
  }
  const observation = readJson(artifact.path, 'content-addressed runtime-role observation')
  const deployment = readJson(artifact.deploymentArtifactPath, 'content-addressed deployment observation')
  if (normalized(observation.ref.fileDigest) !== artifact.artifactDigest
    || normalized(deployment.ref.fileDigest) !== artifact.deploymentArtifactDigest
    || observation.value.schema !== 'fsusblog.runtime-role-observation.v3'
    || deployment.value.ownership?.claimEligible !== true
    || observation.value.ownership?.claimEligible !== true
    || observation.value.deploymentAuthority?.observationDigest !== deployment.value.observationDigest
    || normalized(deployment.value.observationDigest) !== normalized(buildReceipt.deploymentObservationDigest))
  {
    fail('runtime-role/deployment raw artifacts are stale, synthetic, or not claim eligible')
  }
  validateCurrentSchemaCodeContractObservation(observation.value.currentSchemaContract)
  return { admission, minimal, artifact, buildReceipt, observation, deployment }
}

// This compares persisted values only. The original codec/native execution and
// admitted collector must independently authenticate them before post-runtime use.
function verifyCurrentSchemaValues(receiptRef, manifest, rollout, plan, repositoryRoot, readJson)
{
  if (!receiptRef || Array.isArray(receiptRef)
    || Object.keys(receiptRef).sort().join('\n') !== ['contentDigest', 'fileDigest', 'path', 'schema'].join('\n')
    || receiptRef.schema !== 'fsusblog.current-schema-receipt.v1'
    || typeof receiptRef.path !== 'string' || !receiptRef.path.trim()
    || receiptRef.path !== receiptRef.path.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(receiptRef.path)
    || receiptRef.path.split(/[\\/]/u).some(part => part.toLowerCase() === 'latest')
    || !/^sha256:[a-f0-9]{64}$/u.test(receiptRef.fileDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(receiptRef.contentDigest))
  {
    fail('current-schema receipt reference must have the exact v1 path/file/content bindings')
  }
  const opened = readJson(receiptRef.path, 'current-schema receipt values')
  const receipt = opened.value
  const binding = manifest.value.currentSchema
  if (opened.ref.fileDigest !== receiptRef.fileDigest
    || path.resolve(repositoryRoot, opened.ref.path) !== path.resolve(repositoryRoot, receiptRef.path)
    || path.resolve(repositoryRoot, binding.receipt.reference) !== path.resolve(repositoryRoot, receiptRef.path)
    || receiptRef.fileDigest !== `sha256:${binding.receipt.sha256}`
    || receipt?.format !== receiptRef.schema
    || receipt.status !== 'verified-current'
    || !/^[a-f0-9]{64}$/u.test(receipt.contentDigest ?? '')
    || receiptRef.contentDigest !== `sha256:${receipt.contentDigest}`
    || !isDeepStrictEqual(receipt.target, binding.target)
    || !isDeepStrictEqual(receipt.database, binding.database)
    || receipt.actualSchemaDigest !== binding.actualSchemaDigest)
  {
    fail('current-schema receipt values do not match the immutable manifest/reference bindings')
  }
  const admission = referencedJson(rollout.value.auxiliary?.currentSchemaAdmission,
    'current-schema admission output', repositoryRoot, readJson)
  if (admission.ref.contentDigest !== null)
    fail('current-schema admission output has no payload content seal')
  const errors = validateCurrentSchemaAdmissionOutput(admission.value, binding, plan.sourceState.commit)
  if (errors.length !== 0) fail(`current-schema admission output rejected: ${errors.join('; ')}`)
  // Do not recompute the native C# ordered seal with the unrelated sorted-JSON
  // authority serializer, or infer verifier/source/backup/native truth here.
  return { receiptRef: structuredClone(receiptRef), receipt, admission }
}

export function verifyCanonicalReleaseAuthorityValues({
  candidatePlan: plan, rolloutEvidence, runtimeRoleAdmission, currentSchemaReceiptRef, repositoryRoot,
  readJson, readBytes, now, expectedClaimStageAuthority
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
  // The original I/O owner constructs these materials from the independently
  // bound source. This pure value layer does not read or authenticate provenance.
  const runtimeRole = verifyRuntimeRole(runtimeRoleAdmission, plan, repositoryRoot, readJson, expectedClaimStageAuthority)
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
  const currentSchema = verifyCurrentSchemaValues(currentSchemaReceiptRef,
    manifest, rollout, plan, repositoryRoot, readJson)
  return {
    rollout,
    runtimeRole,
    manifest,
    currentSchema,
    authorityDigest: `sha256:${digestValue(stable({
      rollout: rollout.ref.fileDigest,
      runtimeRole: runtimeRole.observation.ref.fileDigest,
      deployment: runtimeRole.deployment.ref.fileDigest,
      manifest: manifest.ref.fileDigest,
      currentSchemaReceipt: currentSchema.receiptRef.fileDigest,
      currentSchemaReceiptContent: currentSchema.receiptRef.contentDigest,
      currentSchemaAdmission: currentSchema.admission.ref.fileDigest
    }))}`
  }
}
