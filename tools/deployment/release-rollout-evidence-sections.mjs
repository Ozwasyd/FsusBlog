import { validateAuxiliaryEvidence, validateCurrentSchemaStageOutput } from './release-rollout-auxiliary-evidence-contract.mjs'
import {
  REQUIRED_AUXILIARY_EVIDENCE,
  REQUIRED_FINAL_ARTIFACTS,
  ROLLOUT_STAGES,
  STAGE_SCHEMA,
  validateRecoveryResolution
} from './release-rollout-evidence-constants.mjs'
import { validateSemanticArtifact } from './release-rollout-semantic-artifact-contract.mjs'

const digestPattern = /^sha256:[0-9a-f]{64}$/u
const message = (error) => error instanceof Error ? error.message : String(error)

function validateOutputMetadata(parsed, label, errors, fileMetadata)
{
  for (const stream of ['stdout', 'stderr'])
  {
    const output = parsed.output?.[stream]
    if (!output) continue
    const current = fileMetadata(output.path)
    if (current.sha256 !== output.sha256 || current.bytes !== output.bytes)
    {
      errors.push(`${label} ${stream} changed after seal`)
    }
  }
}

function validateStageAttempts(stage, expectedStage, evidence, errors, readers)
{
  if (!Array.isArray(stage.attemptEvidence) || stage.attemptEvidence.length !== stage.attempts)
  {
    errors.push(`rollout stage attempt evidence is incomplete: ${expectedStage}`)
    return
  }
  for (const attempt of stage.attemptEvidence)
  {
    if (!attempt.evidence)
    {
      errors.push(`rollout stage attempt evidence is invalid: ${expectedStage} attempt ${attempt.attempt ?? '<missing>'}`)
      continue
    }
    try
    {
      const current = readers.fileMetadata(attempt.evidence.path)
      if (current.sha256 !== attempt.evidence.sha256 || current.bytes !== attempt.evidence.bytes)
      {
        errors.push(`stage attempt evidence changed after seal: ${expectedStage} attempt ${attempt.attempt}`)
        continue
      }
      const parsed = readers.readJson(attempt.evidence.path)
      validateCurrentSchemaStageOutput(parsed, evidence, errors, readers)
      if (parsed.schema !== STAGE_SCHEMA
        || parsed.rolloutId !== evidence.rolloutId
        || parsed.stage !== expectedStage
        || parsed.status !== attempt.status)
      {
        errors.push(`stage attempt evidence identity/status is invalid: ${expectedStage} attempt ${attempt.attempt}`)
      }
      validateOutputMetadata(parsed, `stage ${expectedStage} attempt ${attempt.attempt}`, errors, readers.fileMetadata)
    }
    catch (error)
    {
      errors.push(`${expectedStage} attempt ${attempt.attempt ?? '<missing>'}: ${message(error)}`)
    }
  }
}

export function validateRolloutStages(evidence, errors, readers)
{
  if (!Array.isArray(evidence.stages)
    || evidence.stages.map((item) => item.stage).join('\n') !== ROLLOUT_STAGES.join('\n'))
  {
    errors.push('rollout evidence stage order is incomplete')
    return
  }
  for (const expectedStage of ROLLOUT_STAGES)
  {
    const stage = evidence.stages.find((item) => item.stage === expectedStage)
    const metadata = stage?.evidence
    if (!metadata || !digestPattern.test(String(metadata.sha256 ?? '')))
    {
      errors.push(`rollout stage evidence is invalid: ${expectedStage}`)
      continue
    }
    try
    {
      const current = readers.fileMetadata(metadata.path)
      if (current.sha256 !== metadata.sha256 || current.bytes !== metadata.bytes)
      {
        errors.push(`stage evidence changed after seal: ${expectedStage}`)
        continue
      }
      const parsed = readers.readJson(metadata.path)
      validateCurrentSchemaStageOutput(parsed, evidence, errors, readers)
      if (parsed.schema !== STAGE_SCHEMA || parsed.rolloutId !== evidence.rolloutId
        || parsed.stage !== expectedStage || parsed.status !== 'ok')
      {
        errors.push(`stage evidence identity/status is invalid: ${expectedStage}`)
      }
      validateOutputMetadata(parsed, `stage ${expectedStage}`, errors, readers.fileMetadata)
    }
    catch (error)
    {
      errors.push(`${expectedStage}: ${message(error)}`)
    }
    validateStageAttempts(stage, expectedStage, evidence, errors, readers)
  }
}

export function validateRolloutRecoveries(evidence, errors, fileMetadata)
{
  if (!Array.isArray(evidence.recoveries))
  {
    errors.push('rollout evidence recoveries must be an array')
    return
  }
  validateRecoveryResolution(evidence.recoveries, errors)
  for (const recovery of evidence.recoveries)
  {
    if (!['ok', 'failed'].includes(recovery.status) || !recovery.evidence)
    {
      errors.push(`rollout recovery evidence is invalid: ${recovery.action ?? '<missing>'}`)
      continue
    }
    try
    {
      const current = fileMetadata(recovery.evidence.path)
      if (current.sha256 !== recovery.evidence.sha256 || current.bytes !== recovery.evidence.bytes)
      {
        errors.push(`recovery evidence changed after seal: ${recovery.action}`)
      }
    }
    catch (error)
    {
      errors.push(`recovery ${recovery.action}: ${message(error)}`)
    }
  }
}

export function validateRolloutArtifacts(evidence, errors, readers)
{
  if (Object.keys(evidence.artifacts ?? {}).join('\n') !== REQUIRED_FINAL_ARTIFACTS.join('\n'))
  {
    errors.push('rollout evidence artifact set must be the exact allowlist')
  }
  for (const name of REQUIRED_FINAL_ARTIFACTS)
  {
    const artifact = evidence.artifacts?.[name]
    if (!artifact || artifact.status === 'fail' || !digestPattern.test(String(artifact.sha256 ?? '')))
    {
      errors.push(`rollout evidence artifact is invalid: ${name}`)
      continue
    }
    try
    {
      const current = readers.fileMetadata(artifact.path)
      if (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes)
      {
        errors.push(`artifact changed after seal: ${name}`)
      }
      const parsed = readers.readJson(artifact.path)
      if (parsed.rolloutId !== evidence.rolloutId) errors.push(`${name}: rolloutId does not match sealed rollout`)
      if (parsed.target?.releaseId !== undefined && parsed.target.releaseId !== evidence.target?.releaseId)
      {
        errors.push(`${name}: target release does not match sealed rollout`)
      }
      if (parsed.target?.imageDigest !== undefined && parsed.target.imageDigest !== evidence.target?.imageDigest)
      {
        errors.push(`${name}: target digest does not match sealed rollout`)
      }
      if (parsed.sourceReleaseId !== undefined && parsed.sourceReleaseId !== evidence.source?.releaseId)
      {
        errors.push(`${name}: source release does not match sealed rollout`)
      }
      if (parsed.targetReleaseId !== undefined && parsed.targetReleaseId !== evidence.target?.releaseId)
      {
        errors.push(`${name}: target release does not match sealed rollout`)
      }
      validateSemanticArtifact(name, parsed, errors)
    }
    catch (error)
    {
      errors.push(`${name}: ${message(error)}`)
    }
  }
}

export function validateRolloutAuxiliary(evidence, errors, readers, now)
{
  if (Object.keys(evidence.auxiliary ?? {}).join('\n') !== REQUIRED_AUXILIARY_EVIDENCE.join('\n'))
  {
    errors.push('rollout evidence auxiliary set is incomplete or out of order')
  }
  for (const name of REQUIRED_AUXILIARY_EVIDENCE)
  {
    const metadata = evidence.auxiliary?.[name]
    if (!metadata || !digestPattern.test(String(metadata.sha256 ?? '')))
    {
      errors.push(`rollout auxiliary evidence is invalid: ${name}`)
      continue
    }
    try
    {
      const current = readers.fileMetadata(metadata.path)
      if (current.sha256 !== metadata.sha256 || current.bytes !== metadata.bytes)
      {
        errors.push(`auxiliary evidence changed after seal: ${name}`)
      }
      if (name === 'releaseManifest' && current.sha256 !== `sha256:${evidence.manifestSha256}`)
      {
        errors.push('releaseManifest: complete manifest bytes differ from durable rollout binding')
      }
      validateAuxiliaryEvidence(name, readers.readJson(metadata.path), evidence, errors, now)
    }
    catch (error)
    {
      errors.push(`${name}: ${message(error)}`)
    }
  }
}
