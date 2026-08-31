import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { validateBehaviorDocStaticAdmissionReceipt } from '../docs/behavior-doc-static-admission.mjs'
import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { explicitJson } from '../fact-extractors/post-runtime/adapter.mjs'
import { validateReleaseManifest } from '../release/release-manifest.mjs'

const fail = (message) => { throw new Error(`[canonical-release-authorities] ${message}`) }
const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const normalized = (value) => String(value ?? '').replace(/^sha256:/u, '')

function input(relative, label, repositoryRoot)
{
  const opened = explicitJson(relative, label, repositoryRoot)
  if (opened.relative === null) fail(`${label} requires a persisted current-run JSON file`)
  const absolute = path.join(repositoryRoot, opened.relative)
  const bytes = fs.readFileSync(absolute)
  return {
    value: opened.value,
    ref: {
      path: opened.relative,
      fileDigest: bytesDigest(bytes),
      contentDigest: opened.value?.contentDigest ?? null
    }
  }
}

function referencedJson(metadata, label, repositoryRoot)
{
  if (!metadata || typeof metadata.path !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(metadata.sha256 ?? ''))
  {
    fail(`${label} reference is invalid`)
  }
  const relative = path.isAbsolute(metadata.path)
    ? path.relative(repositoryRoot, metadata.path).replaceAll(path.sep, '/')
    : metadata.path
  const current = input(relative, label, repositoryRoot)
  if (current.ref.fileDigest !== metadata.sha256) fail(`${label} bytes changed after rollout seal`)
  return current
}

function verifyRollout(relative, repositoryRoot)
{
  const rollout = input(relative, 'release rollout evidence', repositoryRoot)
  const command = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'tools/deployment/release-rollout-evidence.mjs'),
    'verify', '--evidence', path.join(repositoryRoot, rollout.ref.path)
  ], { cwd: repositoryRoot, encoding: 'utf8' })
  let report = null
  try { report = JSON.parse(command.stdout.trim().split('\n').at(-1)) } catch { report = null }
  if (command.status !== 0 || report?.status !== 'pass' || report.rolloutId !== rollout.value.rolloutId)
  {
    fail(`canonical release rollout verifier rejected evidence: ${report?.errors?.join('; ') || command.stderr.trim()}`)
  }
  return { ...rollout, report }
}

function verifyRuntimeRole(relative, plan, repositoryRoot)
{
  const admission = input(relative, 'runtime-role static admission', repositoryRoot)
  validateBehaviorDocStaticAdmissionReceipt(admission.value, {
    expectedSourceIdentity: {
      sourceCommit: plan.sourceState.commit,
      worktreeFingerprint: normalized(plan.sourceState.worktreeFingerprint)
    },
    expectedWorktree: repositoryRoot
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
  const observation = input(artifact.path, 'content-addressed runtime-role observation', repositoryRoot)
  const deployment = input(artifact.deploymentArtifactPath, 'content-addressed deployment observation', repositoryRoot)
  if (normalized(observation.ref.fileDigest) !== artifact.artifactDigest
    || normalized(deployment.ref.fileDigest) !== artifact.deploymentArtifactDigest
    || observation.value.schema !== 'fsusblog.runtime-role-observation.v2'
    || deployment.value.ownership?.claimEligible !== true
    || observation.value.deploymentAuthority?.ownership?.claimEligible !== true
    || observation.value.deploymentAuthority?.observationDigest !== deployment.value.observationDigest
    || normalized(deployment.value.observationDigest) !== normalized(buildReceipt.deploymentObservationDigest))
  {
    fail('runtime-role/deployment raw artifacts are stale, synthetic, or not claim eligible')
  }
  return { admission, minimal, artifact, buildReceipt, observation, deployment }
}

export function verifyCanonicalReleaseAuthorities({ candidatePlan: plan, rolloutEvidence, runtimeRoleAdmission, repositoryRoot })
{
  if (!plan || !repositoryRoot) fail('candidate plan and repository root are required')
  const rollout = verifyRollout(rolloutEvidence, repositoryRoot)
  const runtimeRole = verifyRuntimeRole(runtimeRoleAdmission, plan, repositoryRoot)
  const manifest = referencedJson(rollout.value.auxiliary?.releaseManifest, 'release manifest', repositoryRoot)
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
