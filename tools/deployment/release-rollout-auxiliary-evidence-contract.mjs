import { validatePublicAotWarmEvidence } from '../frontend/public-aot-warm-evidence.mjs'
import { isDeepStrictEqual } from 'node:util'
import { validateCurrentSchemaAdmissionOutput, validateCurrentSchemaBinding } from '../release/release-manifest-value-contract.mjs'

export function validateAuxiliaryEvidence(name, value, state, errors, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${name}: auxiliary evidence must be a JSON object`)
    return
  }
  if (value.rolloutId !== undefined && value.rolloutId !== state.rolloutId) errors.push(`${name}: rolloutId mismatch`)
  if (value.releaseId !== undefined && name !== 'releaseManifest'
    && ![state.source.releaseId, state.target.releaseId].includes(value.releaseId)) errors.push(`${name}: releaseId is outside rollout identities`)
  if (value.target?.releaseId !== undefined && value.target.releaseId !== state.target.releaseId) errors.push(`${name}: target release mismatch`)
    if (value.source?.releaseId !== undefined && value.source.releaseId !== state.source.releaseId) {errors.push(`${name}: source release mismatch`)};
    if (Array.isArray(value.errors) && value.errors.length > 0) {errors.push(`${name}: errors must be empty`)};
    if (name === 'releaseManifest')
{
        if (value.schema !== 'fsusblog.release-manifest.v3'
      || value.releaseId !== state.target.releaseId
      || value.imageDigest !== state.target.imageDigest
      || value.commitSha !== state.candidateSourceRevision
      || !isDeepStrictEqual(value.currentSchema, state.currentSchema))
{
            errors.push(`${name}: immutable target identity mismatch`);
    }
    return
  }
  if (name === 'currentSchemaAdmission') {
    errors.push(...validateCurrentSchemaAdmissionOutput(value, state.currentSchema, state.candidateSourceRevision)
      .map(error => `${name}: ${error}`))
    return
  }
  if (name === 'operatorNote') {
    if (value.schema !== 'fsusblog.release-rollout-operator-note.v1'
      || value.rolloutId !== state.rolloutId
      || typeof value.provided !== 'boolean'
      || typeof value.note !== 'string'
      || value.note.length > 4000) {
      errors.push(`${name}: structured operator note is invalid`)
    }
    return
  }
  if (name === 'publicAotWarm') {
    const publicAotErrors = validatePublicAotWarmEvidence(value, {
      expectedRelease: state.target.releaseId,
      expectedSlot: state.target.slot,
      expectedPublicOrigin: value.expectedPublicOrigin,
      requireScope: 'all',
      maxAgeSeconds: Number.MAX_SAFE_INTEGER,
      now
    })
        errors.push(...publicAotErrors.map((error) => `${name}: ${error}`));
        return;
    }
    const targetGeneration = Number(state.target.runtimeGeneration ?? state.target.generation);
    if (name === 'challengeKindCutoverReceipt')
{
        if (value.schemaVersion !== 'fsus.security-challenge-kind-cutover-receipt.v1'
      || value.accepted !== true || value.status !== 'applied' || value.dryRun !== false
      || value.releaseId !== state.target.releaseId || value.slot !== state.target.slot
      || value.generation !== targetGeneration)
{
            errors.push(`${name}: applied receipt is not bound to the target release fence`);
        }
        return;
    }
    if (name === 'challengeKindCutoverAcceptance')
{
        if (value.schemaVersion !== 'fsus.security-challenge-kind-cutover-acceptance.v1'
      || value.accepted !== true || value.releaseId !== state.target.releaseId
      || value.slot !== state.target.slot || value.generation !== targetGeneration)
{
            errors.push(`${name}: verifier acceptance is not bound to the target release fence`);
        }
        return;
    }
    if (name === 'challengeKindCutoverGate')
{
        if (value.schema !== 'fsusblog.release-challenge-kind-cutover-gate.v1'
      || value.status !== 'pass' || value.rolloutId !== state.rolloutId
      || value.releaseId !== state.target.releaseId || value.slot !== state.target.slot
      || value.generation !== targetGeneration
      || value.lifecycle?.destructiveCutoverStarted !== true
      || value.lifecycle?.activationCommitted !== false
      || value.lifecycle?.stage !== 'source-drain'
      || value.bindings?.backendFence !== true || value.bindings?.frontend !== true
      || value.bindings?.staticAssets !== true || value.bindings?.cutover !== true
      || value.bindings?.perceptionCharacterV3 !== true)
{
            errors.push(`${name}: cross-layer target binding gate is invalid`);
        }
        return;
    }
    if (name === 'perceptionCharacterV3Cutover')
{
        if (value.schemaVersion !== 'fsus.security.perception-character-v3-cutover-receipt.v1'
      || value.accepted !== true || value.status !== 'activated' || value.dryRun !== false
      || value.releaseId !== state.target.releaseId || value.slot !== state.target.slot
      || value.generation !== targetGeneration)
{
            errors.push(`${name}: V3 cutover is not bound to the target release fence`);
        }
        return;
    }
    if (value.status !== undefined && !['pass', 'ok', 'healthy', 'completed', 'dry-run'].includes(value.status))
{
        errors.push(`${name}: status is not successful`);
    }
}

/** Validates retained output bindings only; never invents or executes a native admission. */
export function validateCurrentRolloutEvidenceBindings(evidence, errors) {
  const fields = ['schema', 'status', 'rolloutId', 'kind', 'source', 'target', 'gatewayGeneration',
    'manifestSha256', 'candidateSourceRevision', 'currentSchema', 'rollback', 'stages',
    'recoveries', 'artifacts', 'auxiliary', 'errors', 'sealedAtUtc']
  if (!evidence || Object.keys(evidence).sort().join('\n') !== [...fields].sort().join('\n')) {
    errors.push('current rollout evidence must contain the exact v2 fields')
  }
  if (evidence?.kind !== 'deploy' || typeof evidence?.manifestSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(evidence.manifestSha256)
    || typeof evidence?.candidateSourceRevision !== 'string'
    || !/^[0-9a-f]{40}$/u.test(evidence.candidateSourceRevision) || /^0+$/u.test(evidence.candidateSourceRevision)) {
    errors.push('current rollout must bind complete manifest bytes and exact candidate source')
  }
  validateCurrentSchemaBinding(evidence?.currentSchema, errors)
  if (!evidence?.rollback || Object.keys(evidence.rollback).join('\n') !== 'allowed' || evidence.rollback.allowed !== false) {
    errors.push('current rollout cannot permit image-only rollback or retired Contract fields')
  }
}

export function validateCurrentSchemaStageOutput(report, state, errors, readers) {
  if (report.stage !== 'current-schema-admission' || report.status !== 'ok') return
  const output = report.output?.stdout
  if (!output) {
    errors.push('current-schema-admission: retained Server stdout is required')
    return
  }
  try {
    const current = readers.fileMetadata(output.path)
    if (current.bytes !== output.bytes || current.sha256 !== output.sha256) {
      errors.push('current-schema-admission: Server stdout bytes changed after capture')
      return
    }
    errors.push(...validateCurrentSchemaAdmissionOutput(readers.readJson(output.path), state.currentSchema, state.candidateSourceRevision)
      .map(error => `current-schema-admission: ${error}`))
  } catch (error) {
    errors.push(`current-schema-admission: ${error instanceof Error ? error.message : String(error)}`)
  }
}
