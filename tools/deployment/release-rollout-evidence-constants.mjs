export const ROLLOUT_STAGES = Object.freeze([
  'manifest-validate',
  'capacity-preflight',
  'backup-restore-gate',
  'current-schema-admission',
  'asset-materialize',
  'candidate-start',
  'candidate-readiness',
  'candidate-smoke',
  'compatibility-smoke',
  'gateway-switch',
  'source-drain',
  'active-fence',
  'public-verify',
  'source-stop',
  'release-evidence'
])

export const STAGE_SCHEMA = 'fsusblog.release-rollout-stage-evidence.v2'
export const FINAL_SCHEMA = 'fsusblog.release-rollout-evidence.v2'
export const REQUIRED_FINAL_ARTIFACTS = Object.freeze([
  'publicTraffic',
  'notificationStream',
  'assetCompatibility',
  'workerReconciliation',
  'resourceBudget',
  'faultInjection'
])
export const REQUIRED_AUXILIARY_EVIDENCE = Object.freeze([
  'releaseManifest',
  'backupRestoreGate',
  'currentSchemaAdmission',
  'candidateReadiness',
  'assetMaterialization',
  'retentionPrepared',
  'retainedAssets',
  'publicAotWarm',
  'candidateSmoke',
  'compatibilityMatrix',
  'gatewayTransition',
  'activeFenceAcquire',
  'activeFenceSourceRevoke',
  'activeFenceVerify',
  'challengeKindCutoverReceipt',
  'challengeKindCutoverAcceptance',
  'challengeKindCutoverGate',
  'perceptionCharacterV3Cutover',
  'publicTrafficCheckpoint',
  'sourceDrainSnapshot',
  'sourceDrainGate',
  'targetHealth',
  'retentionDrainComplete',
  'operatorNote'
])

export function validateRolloutId(value) {
  const id = String(value ?? '')
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(id)) throw new Error('rolloutId is invalid')
  return id
}

export function validateRecoveryResolution(records, errors) {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.status !== 'failed') continue
    const resolved = records.slice(index + 1).some(candidate => candidate.status === 'ok'
      && candidate.action === record.action
      && candidate.failedStage === record.failedStage)
    if (!resolved) errors.push(`rollout contains an unresolved failed recovery attempt: ${record.action ?? '<missing>'}`)
  }
}
