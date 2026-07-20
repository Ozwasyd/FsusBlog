#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { isValidReleaseId } from '../release/release-id.mjs'

export const REHEARSAL_PLAN_SCHEMA = 'fsusblog.zero-downtime-rehearsal-plan.v1'
export const RESOLVED_PLAN_SCHEMA = 'fsusblog.zero-downtime-rehearsal-resolved-plan.v1'
export const MODE_EVIDENCE_SCHEMA = 'fsusblog.zero-downtime-rehearsal-mode-evidence.v1'

export const ROLLOUT_STAGES = Object.freeze([
  'manifest-validate',
  'capacity-preflight',
  'backup-restore-gate',
  'expand-migration',
  'candidate-start',
  'candidate-readiness',
  'asset-materialize',
  'candidate-smoke',
  'compatibility-smoke',
  'gateway-switch',
  'source-drain',
  'active-fence',
  'public-verify',
  'source-stop',
  'release-evidence'
])

export const HOST_INTERRUPTION_STAGES = Object.freeze([
  'source-drain',
  'source-stop',
  'release-evidence'
])

export const FAULT_CASES = Object.freeze([
  'manifest-digest-mismatch',
  'capacity-insufficient',
  'expand-failure',
  'candidate-readiness',
  'asset-hash-mismatch',
  'gateway-reload-failure',
  'active-fence-failure',
  'public-probe-failure',
  'drain-timeout',
  'source-stop-failure',
  'host-interruption',
  'redis-disconnect',
  'postgres-disconnect'
])
export const MIGRATION_QUALIFICATION_CASES = Object.freeze([
  'expand-with-old-active',
  'blue-green-concurrent-read-write',
  'backfill-checkpoint-resume',
  'missing-expand-candidate-not-ready',
  'contract-rollback-window-rejected',
  'contract-applied-non-rollback-compatible',
  'advisory-lock-timeout',
  'database-disconnect',
  'partial-failure-recovery',
  'history-integrity-rejected'
])

const MODES = new Set(['normal', 'explicit-rollback', 'post-switch-rollback', 'sigkill-resume'])
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{2,127}$/u
const NORMAL_WORKER_KINDS = Object.freeze([
  'scheduled-publish',
  'article-mutation-outbox',
  'audit-writer',
  'visit-view-projection',
  'public-hot-aot',
  'upload-cleanup',
  'active-singleton-control',
  'multi-consumer-safe-control'
])

export function resolveRehearsalPlan(raw, context) {
  object(raw, 'plan')
  if (raw.schema !== REHEARSAL_PLAN_SCHEMA) fail(`plan schema must be ${REHEARSAL_PLAN_SCHEMA}`)
  if (raw.nonProductionOnly !== true || raw.environment !== 'Test') {
    fail('rehearsal plan must be explicitly non-production and use environment Test')
  }
  if (raw.acknowledgement !== 'DESTROY_ISOLATED_LOCAL_REHEARSAL_ONLY') {
    fail('local destructive rehearsal acknowledgement is missing')
  }

  const planFile = canonicalFile(context.planFile, 'plan file')
  const repoRoot = canonicalDirectory(context.repoRoot, 'repository root')
  const rehearsalId = safeId(raw.rehearsalId, 'rehearsalId')
  const publicUrl = localUrl(raw.publicUrl, '/health/ready', 'publicUrl')
  const controlOrigin = localUrl(raw.controlOrigin ?? new URL(publicUrl).origin, null, 'controlOrigin')
  const publicPort = boundedInteger(raw.publicPort ?? Number(new URL(publicUrl).port), 1024, 65535, 'publicPort')
  if (Number(new URL(publicUrl).port) !== publicPort) fail('publicPort must match publicUrl')
  if (new URL(publicUrl).origin !== new URL(controlOrigin).origin) fail('controlOrigin must match publicUrl origin')

  const workRoot = resolveFrom(planFile, raw.workRoot)
  const allowedWorkRoot = path.join(repoRoot, '.tmp')
  ensureWithin(workRoot, allowedWorkRoot, 'workRoot')
  if (workRoot === allowedWorkRoot) fail('workRoot must be a dedicated child of repository .tmp')
  assertNoSymlinkTraversal(allowedWorkRoot, repoRoot, 'repository .tmp')
  assertNoSymlinkTraversal(workRoot, repoRoot, 'workRoot')
  assertNoSymlinkTraversal(path.join(workRoot, rehearsalId), repoRoot, 'rehearsal root')

  const envFile = privateMaterialFile(planFile, raw.envFile, 'envFile')
  assertTestEnvironment(envFile, publicUrl)
  const adminHeaderFile = privateMaterialFile(planFile, raw.adminHeaderFile, 'adminHeaderFile')
  assertPrivateAdminHeader(adminHeaderFile)
  const notificationAuthStorageState = privateMaterialFile(
    planFile,
    raw.notificationAuthStorageState,
    'notificationAuthStorageState')

  object(raw.source, 'source')
  object(raw.target, 'target')
  if (raw.source.slot !== 'blue' || raw.target.slot !== 'green') {
    fail('rehearsal topology is fixed to source blue and target green')
  }
  const sourceManifest = releaseManifest(materialFile(planFile, raw.source.manifest, 'source.manifest'), 'source manifest')
  const targetManifest = releaseManifest(materialFile(planFile, raw.target.manifest, 'target.manifest'), 'target manifest')
  const sourcePreviousRollbackRelease = safeId(
    raw.source.previousRollbackRelease,
    'source.previousRollbackRelease')
  if (sourcePreviousRollbackRelease === sourceManifest.releaseId) {
    fail('source.previousRollbackRelease must differ from source releaseId')
  }
  if (sourceManifest.releaseId === targetManifest.releaseId || sourceManifest.imageDigest === targetManifest.imageDigest) {
    fail('source and target manifests must identify different immutable releases')
  }

  object(raw.evidenceInputs, 'evidenceInputs')
  const backupRestore = materialFile(planFile, raw.evidenceInputs.backupRestore, 'evidenceInputs.backupRestore')
  const trafficScenario = materialFile(planFile, raw.evidenceInputs.trafficScenario, 'evidenceInputs.trafficScenario')
  const trafficBindingKey = privateMaterialFile(
    planFile,
    raw.evidenceInputs.trafficBindingKey,
    'evidenceInputs.trafficBindingKey')
  const trafficBindingKeyBytes = fs.statSync(trafficBindingKey).size
  if (trafficBindingKeyBytes < 32 || trafficBindingKeyBytes > 4096) {
    fail('evidenceInputs.trafficBindingKey must contain 32..4096 bytes')
  }
  const assetBrowserBindingKey = privateMaterialFile(
    planFile,
    raw.evidenceInputs.assetBrowserBindingKey,
    'evidenceInputs.assetBrowserBindingKey')
  const assetBrowserBindingKeyBytes = fs.statSync(assetBrowserBindingKey).size
  if (assetBrowserBindingKeyBytes < 32 || assetBrowserBindingKeyBytes > 4096) {
    fail('evidenceInputs.assetBrowserBindingKey must contain 32..4096 bytes')
  }
  const notificationResyncScenario = materialFile(
    planFile,
    raw.evidenceInputs.notificationResyncScenario,
    'evidenceInputs.notificationResyncScenario')
  if (readJson(notificationResyncScenario, 'notification resync scenario').schema !== 'fsusblog.release-notification-resync-scenario.v1') {
    fail('evidenceInputs.notificationResyncScenario schema is invalid')
  }
  const migrationServerDll = materialFile(planFile, raw.target.migrationServerDll, 'target.migrationServerDll')

  object(raw.migrationQualification, 'migrationQualification')
  const migrationQualificationTemplate = materialFile(
    planFile,
    raw.migrationQualification.scenarioTemplate,
    'migrationQualification.scenarioTemplate')
  const migrationQualificationTimeoutSeconds = boundedInteger(
    raw.migrationQualification.timeoutSeconds ?? 900,
    60,
    1800,
    'migrationQualification.timeoutSeconds')
  const expandMigrationId = safeId(raw.migrationQualification.expandMigrationId, 'migrationQualification.expandMigrationId')
  const backfillMigrationId = safeId(raw.migrationQualification.backfillMigrationId, 'migrationQualification.backfillMigrationId')
  const contractMigrationId = safeId(raw.migrationQualification.contractMigrationId, 'migrationQualification.contractMigrationId')

  object(raw.assets, 'assets')
  const deployAssetScenario = materialFile(planFile, raw.assets.deployScenario, 'assets.deployScenario')
  const rollbackAssetScenario = materialFile(planFile, raw.assets.rollbackScenario, 'assets.rollbackScenario')
  assertAssetScenario(deployAssetScenario, sourceManifest.releaseId, targetManifest.releaseId, 'deploy asset scenario')
  assertAssetScenario(rollbackAssetScenario, targetManifest.releaseId, sourceManifest.releaseId, 'rollback asset scenario')
  const assetStore = resolveFrom(planFile, raw.assets.store)
  const retentionState = resolveFrom(planFile, raw.assets.retentionState)
  ensureWithin(assetStore, workRoot, 'assets.store')
  ensureWithin(retentionState, workRoot, 'assets.retentionState')
  assertNoSymlinkTraversal(assetStore, repoRoot, 'assets.store')
  assertNoSymlinkTraversal(retentionState, repoRoot, 'assets.retentionState')

  object(raw.workers, 'workers')
  const workerTimeoutSeconds = boundedInteger(raw.workers.timeoutSeconds ?? 300, 10, 1800, 'workers.timeoutSeconds')
  const workerObserverEnvFile = privateMaterialFile(
    planFile,
    raw.workers.observerEnvFile,
    'workers.observerEnvFile')
  const workerPhases = {}
  for (const phase of ['deploy', 'rollback', 'resume']) {
    object(raw.workers[phase], `workers.${phase}`)
    const startStage = String(raw.workers[phase].startStage ?? 'public-verify')
    const startIndex = ROLLOUT_STAGES.indexOf(startStage)
    if (startIndex < ROLLOUT_STAGES.indexOf('candidate-start')
      || startIndex > ROLLOUT_STAGES.indexOf('public-verify')) {
      fail(`workers.${phase}.startStage must be candidate-start..public-verify`)
    }
    const scenario = materialFile(planFile, raw.workers[phase].scenario, `workers.${phase}.scenario`)
    const normalScenario = materialFile(planFile, raw.workers[phase].normalScenario, `workers.${phase}.normalScenario`)
    const observerServicePlanFile = materialFile(
      planFile,
      raw.workers[phase].observerServicePlan,
      `workers.${phase}.observerServicePlan`)
    const drill = workerScenario(scenario, `workers.${phase}.scenario`)
    const normal = normalWorkerScenario(normalScenario, `workers.${phase}.normalScenario`)
    const observerServicePlan = workerObserverServicePlan(
      observerServicePlanFile,
      `workers.${phase}.observerServicePlan`)
    if (normal.baseUrl !== observerServicePlan.baseUrl) {
      fail(`workers.${phase}.normalScenario.baseUrl must equal observer service listen origin`)
    }
    if (!drill.allowedHttpOrigins.includes(observerServicePlan.baseUrl)) {
      fail(`workers.${phase}.scenario must allow the observer service listen origin`)
    }
    workerPhases[phase] = {
      ...drill,
      normalScenario: normal,
      observerServicePlan,
      startStage
    }
  }

  object(raw.faults, 'faults')
  const faultPlanTemplate = materialFile(planFile, raw.faults.planTemplate, 'faults.planTemplate')
  const faultTokens = resolveFaultTokens(raw.faults.tokens, planFile, repoRoot, workRoot)

  object(raw.hostInterruption, 'hostInterruption')
  const interruptStages = raw.hostInterruption.stages
  if (!Array.isArray(interruptStages)
    || interruptStages.join('\n') !== HOST_INTERRUPTION_STAGES.join('\n')) {
    fail(`hostInterruption.stages must be the exact ordered late-stage set: ${HOST_INTERRUPTION_STAGES.join(', ')}`)
  }
  const interruptTimeoutSeconds = boundedInteger(
    raw.hostInterruption.timeoutSeconds ?? 180,
    10,
    300,
    'hostInterruption.timeoutSeconds')

  return {
    schema: RESOLVED_PLAN_SCHEMA,
    rehearsalId,
    nonProductionOnly: true,
    environment: 'Test',
    acknowledgement: raw.acknowledgement,
    planFile,
    repoRoot,
    workRoot,
    publicUrl,
    controlOrigin: new URL(controlOrigin).origin,
    publicPort,
    envFile,
    adminHeaderFile,
    notificationAuthStorageState,
    source: {
      slot: 'blue',
      ...sourceManifest,
      previousRollbackRelease: sourcePreviousRollbackRelease
    },
    target: { slot: 'green', ...targetManifest, migrationServerDll },
    evidenceInputs: {
      backupRestore,
      trafficScenario,
      trafficBindingKey,
      assetBrowserBindingKey,
      notificationResyncScenario
    },
    migrationQualification: {
      scenarioTemplate: migrationQualificationTemplate,
      timeoutSeconds: migrationQualificationTimeoutSeconds,
      expandMigrationId,
      backfillMigrationId,
      contractMigrationId
    },
    assets: { deployScenario: deployAssetScenario, rollbackScenario: rollbackAssetScenario, store: assetStore, retentionState },
    workers: { timeoutSeconds: workerTimeoutSeconds, observerEnvFile: workerObserverEnvFile, ...workerPhases },
    faults: { planTemplate: faultPlanTemplate, tokens: faultTokens },
    hostInterruption: { stages: [...HOST_INTERRUPTION_STAGES], timeoutSeconds: interruptTimeoutSeconds }
  }
}

export function materializeMigrationQualificationScenario(resolved, input) {
  assertResolvedPlan(resolved)
  object(input, 'migration qualification materialization input')
  const runRoot = path.resolve(input.runRoot)
  ensureWithin(runRoot, resolved.workRoot, 'migration qualification run root')
  const runtime = path.resolve(input.runtime)
  ensureWithin(runtime, runRoot, 'migration qualification runtime')
  const template = readJson(
    canonicalFile(resolved.migrationQualification.scenarioTemplate, 'migration qualification scenario template'),
    'migration qualification scenario template')
  const databaseIsolationId = safeId(input.databaseIsolationId, 'migration qualification databaseIsolationId')
  if (/prod(?:uction)?/iu.test(databaseIsolationId)) fail('migration qualification databaseIsolationId must be non-production')
  const sourceOrigin = localUrl(input.sourceOrigin, null, 'migration qualification sourceOrigin')
  const targetOrigin = localUrl(input.targetOrigin, null, 'migration qualification targetOrigin')
  if (new URL(sourceOrigin).origin === new URL(targetOrigin).origin) fail('migration qualification source/target origins must differ')
  const replacements = new Map([
    ['REPLACE_DATABASE_ISOLATION_ID', databaseIsolationId],
    ['REPLACE_SOURCE_ORIGIN', new URL(sourceOrigin).origin],
    ['REPLACE_TARGET_ORIGIN', new URL(targetOrigin).origin],
    ['REPLACE_QUALIFICATION_ADAPTER', canonicalFile(path.join(resolved.repoRoot, 'tools/deployment/rehearsal-schema-qualification-probe.mjs'), 'qualification adapter')],
    ['REPLACE_MIGRATION_RUNNER', canonicalFile(path.join(resolved.repoRoot, 'tools/db/run-online-migrations.sh'), 'migration runner')],
    ['REPLACE_SERVER_DLL', canonicalFile(resolved.target.migrationServerDll, 'migration server DLL')],
    ['REPLACE_ENV_FILE', privateMaterialFile(resolved.planFile, input.envFile, 'migration qualification env file')],
    ['REPLACE_ADMIN_HEADER_FILE', privateMaterialFile(resolved.planFile, input.adminHeaderFile, 'migration qualification admin header')],
    ['REPLACE_SOURCE_WRITE_BODY', canonicalFile(input.sourceWriteBody, 'source bridge write body')],
    ['REPLACE_TARGET_WRITE_BODY', canonicalFile(input.targetWriteBody, 'target bridge write body')],
    ['REPLACE_CONTRACT_WINDOW_EVIDENCE', canonicalFile(input.contractWindowEvidence, 'contract window evidence')],
    ['REPLACE_CONTRACT_QUALIFIED_EVIDENCE', canonicalFile(input.contractQualifiedEvidence, 'qualified Contract evidence')],
    ['REPLACE_EXPAND_MIGRATION_ID', resolved.migrationQualification.expandMigrationId],
    ['REPLACE_BACKFILL_MIGRATION_ID', resolved.migrationQualification.backfillMigrationId],
    ['REPLACE_CONTRACT_MIGRATION_ID', resolved.migrationQualification.contractMigrationId]
  ])
  const scenario = replaceStrings(template, replacements)
  if (scenario.schema !== 'fsusblog.release-migration-qualification-scenario.v1'
    || !Array.isArray(scenario.cases)
    || scenario.cases.length !== 10) {
    fail('materialized migration qualification scenario is incomplete')
  }
  const serialized = JSON.stringify(scenario)
  if (/REPLACE_[A-Z0-9_]+/u.test(serialized)) fail('migration qualification scenario contains unresolved placeholders')
  return scenario
}

export function materializeFaultPlan(
  resolved,
  runRoot,
  kind = 'deploy',
  rolloutIdOverride = null,
  resolvedPlanFileInput = null) {
  assertResolvedPlan(resolved)
  if (!['deploy', 'rollback'].includes(kind)) fail('fault plan kind must be deploy or rollback')
  const root = path.resolve(runRoot)
  ensureWithin(root, resolved.workRoot, 'fault run root')
  const source = kind === 'deploy' ? resolved.source : resolved.target
  const target = kind === 'deploy' ? resolved.target : resolved.source
  const rolloutId = rolloutIdOverride === null
    ? `${kind}-${target.releaseId}`
    : safeId(rolloutIdOverride, 'fault rolloutId override')
  const template = readJson(resolved.faults.planTemplate, 'fault plan template')
  const orchestrator = canonicalFile(
    path.join(resolved.repoRoot, 'tools/deployment/zero-downtime-rehearsal.sh'),
    'zero-downtime rehearsal orchestrator')
  const resolvedPlanFile = canonicalFile(
    resolvedPlanFileInput ?? resolved.planFile,
    'resolved rehearsal plan for fault cases')
  const replacements = new Map([
    ['REPLACE_ROLLOUT_ID', rolloutId],
    ['REPLACE_TARGET_RELEASE', target.releaseId],
    ['REPLACE_64_HEX_DIGEST', target.imageDigest.slice('sha256:'.length)],
    ['REPLACE_ROLLOUT_WRAPPER', orchestrator],
    ['REPLACE_FAILING_OPENRESTY_WRAPPER', resolved.faults.tokens.failingOpenRestyWrapper],
    ['REPLACE_DOCKER_FAILURE_BIN_PATH', resolved.faults.tokens.dockerFailureBinPath],
    ['REPLACE_RETAINED_ASSET', resolved.faults.tokens.retainedAsset],
    ['REPLACE_CORRUPT_ASSET', resolved.faults.tokens.corruptAsset],
    ['/REPLACE_LONG_REQUEST', resolved.faults.tokens.longRequestPath],
    ['REPLACE_LONG_REQUEST', resolved.faults.tokens.longRequestPath],
    ['{{RUN_ROOT}}', root],
    ['{{REPO_ROOT}}', resolved.repoRoot],
    ['{{ENV_FILE}}', resolved.envFile],
    ['{{ADMIN_HEADER_FILE}}', resolved.adminHeaderFile],
    ['{{SOURCE_MANIFEST}}', source.manifest],
    ['{{TARGET_MANIFEST}}', target.manifest],
    ['{{PUBLIC_URL}}', resolved.publicUrl]
  ])
  const plan = rebindFaultContainers(replaceStrings(template, replacements), source.slot, target.slot)
  if (plan.schema !== 'fsusblog.zero-downtime-fault-plan.v1') fail('materialized fault plan schema is invalid')
  if (!Array.isArray(plan.cases) || plan.cases.map(item => item.case).join('\n') !== FAULT_CASES.join('\n')) {
    fail('materialized fault plan does not contain the exact ordered fault matrix')
  }
  plan.rolloutId = safeId(plan.rolloutId, 'fault rolloutId')
  plan.target = { releaseId: target.releaseId, imageDigest: target.imageDigest }
  plan.sourceContainer = `fsus-app-${source.slot}`
  plan.targetContainer = `fsus-app-${target.slot}`
  plan.environment = {
    ...(plan.environment ?? {}),
    ASPNETCORE_ENVIRONMENT: 'Test',
    FSUSBLOG_ROLLOUT_REHEARSAL: '1',
    FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE: '1',
    FSUSBLOG_FAULT_ROLLOUT_ID: rolloutId,
    FSUSBLOG_FAULT_SOURCE_SLOT: source.slot,
    FSUSBLOG_FAULT_TARGET_SLOT: target.slot,
    FSUSBLOG_FAULT_SOURCE_MANIFEST: source.manifest,
    FSUSBLOG_FAULT_TARGET_MANIFEST: target.manifest
  }
  for (const definition of plan.cases) {
    object(definition, `fault case ${definition?.case ?? '<missing>'}`)
    const caseRoot = path.join(root, 'cases', definition.case)
    const caseRolloutId = childRolloutId(rolloutId, definition.case)
    definition.rolloutState = path.join(caseRoot, 'rollout-state.json')
    definition.slotState = path.join(caseRoot, 'slot-state.json')
    definition.publicUrl = resolved.publicUrl
    definition.setup = [{
      id: 'prepare-case',
      executable: 'bash',
      args: [
        orchestrator, '__fault-case-setup',
        '--resolved-plan', resolvedPlanFile,
        '--case-root', caseRoot,
        '--kind', kind,
        '--case', definition.case,
        '--rollout-id', caseRolloutId
      ],
      cwd: caseRoot,
      timeoutMs: 300_000
    }]
    definition.rollout = {
      ...(definition.rollout ?? {}),
      id: 'case-rollout',
      executable: 'bash',
      args: [
        orchestrator, '__fault-case-rollout',
        '--resolved-plan', resolvedPlanFile,
        '--case-root', caseRoot,
        '--kind', kind,
        '--case', definition.case,
        '--rollout-id', caseRolloutId
      ],
      cwd: caseRoot
    }
    definition.teardown = [{
      id: 'teardown-case',
      executable: 'bash',
      args: [
        orchestrator, '__fault-case-teardown',
        '--resolved-plan', resolvedPlanFile,
        '--case-root', caseRoot,
        '--kind', kind,
        '--case', definition.case,
        '--rollout-id', caseRolloutId
      ],
      cwd: caseRoot,
      timeoutMs: 300_000
    }]
    if (definition.case === 'source-stop-failure') {
      definition.rollout.environment = {
        ...(definition.rollout.environment ?? {}),
        PATH: `${resolved.faults.tokens.dockerFailureBinPath}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`
      }
    }
    validateNoSecretEnvironment(definition.rollout?.environment, `fault ${definition.case} rollout environment`)
  }
  const serialized = JSON.stringify(plan)
  if (/REPLACE_[A-Z0-9_]+|\{\{[A-Z0-9_]+\}\}/u.test(serialized)) {
    fail('materialized fault plan still contains unresolved placeholders')
  }
  return plan
}

export async function waitForRolloutStage(stateFile, stage, timeoutMs, pollMs = 50) {
  if (!ROLLOUT_STAGES.includes(stage)) fail(`unknown rollout stage: ${stage}`)
  const deadline = Date.now() + boundedInteger(timeoutMs, 1000, 1_800_000, 'timeoutMs')
  const intervalMs = boundedInteger(pollMs, 1, 1000, 'pollMs')
  while (Date.now() < deadline) {
    const state = readOptionalJson(path.resolve(stateFile))
    if (state?.schema === 'fsusblog.release-rollout-state.v1') {
      if (state.currentStage === stage) return state
      if (['completed', 'candidate_ready', 'rolled_back', 'aborted'].includes(state.status)) {
        fail(`rollout became terminal before stage ${stage}: ${state.status}`)
      }
      if (state.status === 'recovery_required') fail(`rollout requires recovery before stage ${stage}`)
      const expectedIndex = ROLLOUT_STAGES.indexOf(stage)
      if (state.completedStages?.includes(stage) || (state.completedStages?.length ?? 0) > expectedIndex) {
        fail(`rollout passed stage ${stage} before interruption could be injected`)
      }
    }
    await delay(intervalMs)
  }
  fail(`timed out waiting for rollout stage ${stage}`)
}

export function inspectOrphanedRollout(stateFile, expectedStage) {
  const state = readJson(path.resolve(stateFile), 'orphaned rollout state')
  if (state.schema !== 'fsusblog.release-rollout-state.v1') fail('orphaned rollout state schema is invalid')
  if (state.currentStage === null) {
    if (state.status !== 'running' && state.status !== 'planned') fail(`orphaned rollout status is ${state.status}`)
    return { action: 'resume-next-stage', stage: null, rolloutId: state.rolloutId }
  }
  if (state.currentStage !== expectedStage) {
    fail(`orphaned rollout stage changed: expected ${expectedStage}, got ${state.currentStage}`)
  }
  return { action: 'fail-running-stage', stage: state.currentStage, rolloutId: state.rolloutId }
}

export function buildWorkerTargetHealth(stateFile, ledgerFile) {
  const state = readJson(path.resolve(stateFile), 'worker rollout state')
  const ledgerPath = canonicalFile(ledgerFile, 'worker drill ledger')
  const ledger = readJson(ledgerPath, 'worker drill ledger')
  if (state.schema !== 'fsusblog.release-rollout-state.v1') fail('worker rollout state schema is invalid')
  if (ledger.schema !== 'fsusblog.release-worker-event-ledger.v1' || ledger.status !== 'pass') fail('worker drill ledger did not pass')
  if (ledger.rolloutId !== state.rolloutId) fail('worker drill ledger rolloutId mismatch')
  if (ledger.target?.releaseId !== state.target?.releaseId || ledger.target?.generation !== state.target?.runtimeGeneration) {
    fail('worker drill ledger target identity/generation mismatch')
  }
  if (ledger.drill?.targetReadiness?.status !== 'pass' || ledger.drill?.targetTakeover?.status !== 'pass') {
    fail('worker drill did not prove target readiness and takeover')
  }
  return {
    schema: 'fsusblog.release-worker-target-health.v1',
    status: 'healthy',
    rolloutId: state.rolloutId,
    qualificationId: ledger.drill.runId,
    releaseId: state.target.releaseId,
    generation: state.target.runtimeGeneration,
    slot: state.target.slot,
    sourceLedger: {
      path: ledgerPath,
      sha256: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(ledgerPath)).digest('hex')}`
    },
    readiness: ledger.drill.targetReadiness,
    takeover: ledger.drill.targetTakeover,
    observedAtUtc: new Date().toISOString()
  }
}

export function buildWorkerQualification(stateFile, ledgerFile, scenarioFile) {
  const state = readJson(path.resolve(stateFile), 'worker qualification rollout state')
  const ledgerPath = canonicalFile(ledgerFile, 'worker qualification ledger')
  const scenarioPath = canonicalFile(scenarioFile, 'worker qualification scenario')
  const ledger = readJson(ledgerPath, 'worker qualification ledger')
  const scenario = readJson(scenarioPath, 'worker qualification scenario')
  if (state.schema !== 'fsusblog.release-rollout-state.v1') fail('worker qualification rollout state schema is invalid')
  if (ledger.schema !== 'fsusblog.release-worker-event-ledger.v1' || ledger.status !== 'pass') fail('worker qualification ledger did not pass')
  if (ledger.rolloutId !== state.rolloutId) fail('worker qualification ledger rolloutId mismatch')
  if (scenario.schema !== 'fsusblog.release-worker-drill-plan.v1') fail('worker qualification scenario schema is invalid')
  if (scenario.coordination?.mode !== 'file-handshake') fail('worker qualification did not use file-handshake')
  if (ledger.drill?.coordination?.status !== 'pass') fail('worker qualification coordination did not pass')
  if (ledger.drill?.sourceTermination?.status !== 'pass' || ledger.drill?.sourceTermination?.forced !== true) {
    fail('worker qualification did not prove forced source-worker termination')
  }
  if (ledger.drill?.targetReadiness?.status !== 'pass' || ledger.drill?.targetTakeover?.status !== 'pass') {
    fail('worker qualification did not prove target readiness/takeover')
  }
  const target = state.target
  if (ledger.target?.releaseId !== target?.releaseId || ledger.target?.generation !== target?.runtimeGeneration) {
    fail('worker qualification target identity/generation mismatch')
  }
  const scenarioSha256 = hashFile(scenarioPath)
  const ledgerSha256 = hashFile(ledgerPath)
  const policyBinding = {
    targetReleaseId: target.releaseId,
    targetImageDigest: target.imageDigest,
    targetRuntimeGeneration: target.runtimeGeneration,
    scenarioSha256,
    sourceTerminationType: scenario.sourceTermination?.type,
    coordinationMode: scenario.coordination.mode
  }
  return {
    schema: 'fsusblog.release-worker-qualification-control.v1',
    status: 'pass',
    rolloutId: state.rolloutId,
    qualificationId: ledger.drill.runId,
    source: state.source,
    target,
    qualificationMode: 'forced-source-worker-termination',
    policyBinding,
    policyHash: `sha256:${crypto.createHash('sha256').update(JSON.stringify(policyBinding)).digest('hex')}`,
    ledger: { path: ledgerPath, sha256: ledgerSha256 },
    scenario: { path: scenarioPath, sha256: scenarioSha256 },
    coordination: ledger.drill.coordination,
    sourceTermination: ledger.drill.sourceTermination,
    targetReadiness: ledger.drill.targetReadiness,
    targetTakeover: ledger.drill.targetTakeover,
    observations: { blockers: [] },
    errors: [],
    observedAtUtc: new Date().toISOString()
  }
}

export function finalizeWorkerQualification(controlFile, reconciliationFile) {
  const controlPath = canonicalFile(controlFile, 'worker qualification control')
  const reconciliationPath = canonicalFile(reconciliationFile, 'worker qualification reconciliation')
  const control = readJson(controlPath, 'worker qualification control')
  const reconciliation = readJson(reconciliationPath, 'worker qualification reconciliation')
  if (control.schema !== 'fsusblog.release-worker-qualification-control.v1' || control.status !== 'pass') {
    fail('worker qualification control did not pass')
  }
  if (reconciliation.schema !== 'fsusblog.release-worker-reconciliation-evidence.v2'
    || reconciliation.mode !== 'qualification'
    || reconciliation.status !== 'pass') {
    fail('worker qualification reconciliation did not pass')
  }
  if (reconciliation.rolloutId !== control.rolloutId) fail('worker qualification reconciliation rolloutId mismatch')
  if (reconciliation.checks?.normalRolloutSeparationVerified !== true
    || reconciliation.qualification?.freshNormalRolloutRequired !== true
    || reconciliation.qualification?.normalRolloutReuseForbidden !== true
    || !reconciliation.inputs?.normalRolloutState?.sha256) {
    fail('worker qualification is not hash-bound to a distinct fresh normal rollout')
  }
  return {
    ...control,
    schema: 'fsusblog.release-worker-qualification-evidence.v1',
    control: { path: controlPath, sha256: hashFile(controlPath) },
    reconciliation: { path: reconciliationPath, sha256: hashFile(reconciliationPath) },
    sealedAtUtc: new Date().toISOString()
  }
}

export function authorizeWorkerQualification(stateFile, armedFile, outFile, runId) {
  const state = readJson(path.resolve(stateFile), 'qualification rollout state')
  const armed = readJson(path.resolve(armedFile), 'worker qualification armed signal')
  if (state.schema !== 'fsusblog.release-rollout-state.v1' || state.currentStage !== 'active-fence') {
    fail('source-worker termination may only be authorized during active-fence')
  }
  if (armed.schema !== 'fsusblog.release-worker-drill-signal.v1'
    || armed.stage !== 'armed'
    || armed.rolloutId !== state.rolloutId
    || armed.runId !== runId) fail('worker qualification armed signal identity mismatch')
  const observed = Date.parse(armed.observedAtUtc ?? '')
  if (!Number.isFinite(observed) || Math.abs(Date.now() - observed) > 15 * 60_000) fail('worker qualification armed signal is stale')
  const signal = {
    schema: 'fsusblog.release-worker-drill-signal.v1',
    rolloutId: state.rolloutId,
    runId,
    stage: 'terminate-source',
    observedAtUtc: new Date().toISOString()
  }
  writeJsonAtomic(outFile, signal)
  return signal
}

export function buildSigkillResumeEvidence(stateFile, stage, initialExitCode, orphanAction, resumeExitCode, holdReadyFile) {
  const state = readJson(path.resolve(stateFile), 'SIGKILL resumed rollout state')
  if (!HOST_INTERRUPTION_STAGES.includes(stage)) fail('SIGKILL stage is not an approved late interruption point')
  if (Number(initialExitCode) !== 137) fail('initial rollout did not exit 137 after SIGKILL')
  if (!['fail-running-stage', 'resume-next-stage'].includes(orphanAction)) fail('SIGKILL orphan action is invalid')
  if (Number(resumeExitCode) !== 0) fail('resumed rollout did not exit zero')
  if (state.schema !== 'fsusblog.release-rollout-state.v1' || state.status !== 'completed' || state.outcome !== 'succeeded') {
    fail('SIGKILL resumed rollout is not durably completed')
  }
  if (!Array.isArray(state.recoveries) || state.recoveries.length < 1 || state.recoveries.some(item => item.status !== 'ok')) {
    fail('SIGKILL resumed rollout lacks successful durable recovery')
  }
  const holdPath = canonicalFile(holdReadyFile, 'SIGKILL stage hold evidence')
  const hold = readJson(holdPath, 'SIGKILL stage hold evidence')
  if (hold.schema !== 'fsusblog.release-rollout-rehearsal-stage-hold.v1'
    || hold.status !== 'ready'
    || hold.rolloutId !== state.rolloutId
    || hold.stage !== stage
    || (hold.errors?.length ?? 0) !== 0) {
    fail('SIGKILL stage hold evidence is invalid or not identity-bound')
  }
  return {
    schema: 'fsusblog.zero-downtime-rehearsal-sigkill.v1',
    status: 'pass',
    signal: 'SIGKILL',
    stage,
    rolloutId: state.rolloutId,
    initialExit: { code: 137, signal: 'SIGKILL' },
    orphanAction,
    resumed: true,
    resumeExitCode: 0,
    recoveryCount: state.recoveries.length,
    finalEvidencePath: state.finalEvidencePath,
    stageHold: immutableJsonMetadata(holdPath, 'SIGKILL stage hold evidence'),
    errors: [],
    observedAtUtc: new Date().toISOString()
  }
}

export function buildSigkillMatrixEvidence(modeRoot, stages = HOST_INTERRUPTION_STAGES) {
  if (!Array.isArray(stages) || stages.join('\n') !== HOST_INTERRUPTION_STAGES.join('\n')) {
    fail(`SIGKILL matrix stages must be: ${HOST_INTERRUPTION_STAGES.join(', ')}`)
  }
  const root = path.resolve(modeRoot)
  const entries = stages.map(stage => {
    const stageRoot = path.join(root, 'interruptions', stage)
    const signalPath = canonicalFile(path.join(stageRoot, 'evidence', 'sigkill-resume.json'), `${stage} SIGKILL evidence`)
    const statePath = canonicalFile(path.join(stageRoot, 'states', 'deploy-rollout.json'), `${stage} rollout state`)
    const signal = readJson(signalPath, `${stage} SIGKILL evidence`)
    const state = readJson(statePath, `${stage} rollout state`)
    verifySignalEvidence(signalPath, stage)
    if (state.schema !== 'fsusblog.release-rollout-state.v1'
      || state.status !== 'completed'
      || state.outcome !== 'succeeded'
      || state.rolloutId !== signal.rolloutId
      || !Array.isArray(state.recoveries)
      || state.recoveries.length < 1
      || state.recoveries.some(item => item.status !== 'ok')) {
      fail(`${stage} resumed rollout state is incomplete or not bound to SIGKILL evidence`)
    }
    return {
      stage,
      rolloutId: state.rolloutId,
      signalEvidence: immutableJsonMetadata(signalPath, `${stage} SIGKILL evidence`),
      rolloutState: immutableJsonMetadata(statePath, `${stage} rollout state`)
    }
  })
  if (new Set(entries.map(item => item.rolloutId)).size !== entries.length) {
    fail('SIGKILL matrix must use a distinct rolloutId for every interruption stage')
  }
  const control = readJson(path.join(root, 'states', 'deploy-rollout.json'), 'fresh SIGKILL control rollout state')
  if (entries.some(item => item.rolloutId === control.rolloutId)) {
    fail('SIGKILL matrix rolloutIds must be distinct from the fresh control rolloutId')
  }
  return {
    schema: 'fsusblog.zero-downtime-rehearsal-sigkill-matrix.v1',
    status: 'pass',
    stages: [...HOST_INTERRUPTION_STAGES],
    entries,
    errors: [],
    observedAtUtc: new Date().toISOString()
  }
}

export function deriveRehearsalRolloutId(role, phase, releaseId, runId) {
  if (!['normal', 'qualification'].includes(role)) fail('rollout role must be normal or qualification')
  const safePhase = safeId(phase, 'rollout phase')
  if (!isValidReleaseId(releaseId)) fail('rollout releaseId is invalid')
  const safeRun = safeId(runId, 'rehearsal runId')
  const binding = `${role}\0${safePhase}\0${releaseId}\0${safeRun}`
  const suffix = crypto.createHash('sha256').update(binding).digest('hex').slice(0, 16)
  const fixed = `${role}-${safePhase}-`
  const tail = `-${suffix}`
  const available = 120 - fixed.length - tail.length
  const releasePart = String(releaseId).slice(0, Math.max(8, available)).replace(/[^0-9A-Za-z._-]/gu, '-')
  return safeId(`${fixed}${releasePart}${tail}`, 'derived rolloutId')
}

export function verifyMode(resolved, mode, modeRoot) {
  assertResolvedPlan(resolved)
  if (!MODES.has(mode)) fail(`unsupported rehearsal mode: ${mode}`)
  const root = path.resolve(modeRoot)
  ensureWithin(root, resolved.workRoot, 'mode root')
  const errors = []
  const checks = []
  const check = (name, callback) => {
    try {
      const detail = callback()
      checks.push({ name, status: 'pass', ...(detail === undefined ? {} : { detail }) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      checks.push({ name, status: 'fail', error: message })
      errors.push(`${name}: ${message}`)
    }
  }

  if (mode === 'post-switch-rollback') {
    check('fault-matrix', () => verifyFaultEvidence(path.join(root, 'evidence', 'fault-matrix.json'), true))
  } else {
    check('fault-matrix', () => verifyFaultEvidence(path.join(root, 'evidence', 'fault-matrix.json'), false))
  }
  check('deploy-rollout', () => verifyRollout(
    path.join(root, 'states', 'deploy-rollout.json'),
    path.join(root, 'rollouts', 'deploy'),
    {
      kind: 'deploy',
      sourceSlot: 'blue',
      sourceRelease: resolved.source.releaseId,
      targetSlot: 'green',
      targetRelease: resolved.target.releaseId,
      requireRecovery: false
    }))
  check('active-slot', () => verifyActiveSlot(path.join(root, 'states', 'slots.json'), mode === 'explicit-rollback' ? 'blue' : 'green'))
  if (mode === 'sigkill-resume') {
    check('sigkill-resume-matrix', () => verifySigkillMatrix(path.join(root, 'evidence', 'sigkill-resume.json'), root))
    for (const stage of resolved.hostInterruption.stages) {
      const stageRoot = path.join(root, 'interruptions', stage)
      check(`fault-matrix-${stage}`, () => verifyFaultEvidence(path.join(stageRoot, 'evidence', 'fault-matrix.json'), false))
      check(`deploy-rollout-${stage}`, () => verifyRollout(
        path.join(stageRoot, 'states', 'deploy-rollout.json'),
        path.join(stageRoot, 'rollouts', 'deploy'),
        {
          kind: 'deploy',
          sourceSlot: 'blue',
          sourceRelease: resolved.source.releaseId,
          targetSlot: 'green',
          targetRelease: resolved.target.releaseId,
          requireRecovery: true
        }))
    }
  }
  if (mode === 'explicit-rollback') {
    check('rollback-rollout', () => verifyRollout(
      path.join(root, 'states', 'rollback-rollout.json'),
      path.join(root, 'rollouts', 'rollback'),
      {
        kind: 'rollback',
        sourceSlot: 'green',
        sourceRelease: resolved.target.releaseId,
        targetSlot: 'blue',
        targetRelease: resolved.source.releaseId,
        requireRecovery: false
      }))
  }
  check('worker-qualification-deploy', () => verifyWorkerQualification(
    path.join(root, 'qualification', 'deploy', 'worker-qualification.json'),
    resolved.target.releaseId,
    resolved.target.imageDigest))
  check('migration-qualification-deploy', () => verifyMigrationQualification(
    path.join(root, 'migration-qualification', 'deploy', 'migration-qualification.json'),
    resolved.target.releaseId,
    resolved.target.imageDigest))
  if (mode === 'explicit-rollback') {
    check('worker-qualification-rollback', () => verifyWorkerQualification(
      path.join(root, 'qualification', 'rollback', 'worker-qualification.json'),
      resolved.source.releaseId,
      resolved.source.imageDigest))
    check('migration-qualification-rollback', () => verifyMigrationQualification(
      path.join(root, 'migration-qualification', 'rollback', 'migration-qualification.json'),
      resolved.source.releaseId,
      resolved.source.imageDigest))
  }

  return {
    schema: MODE_EVIDENCE_SCHEMA,
    status: errors.length === 0 ? 'pass' : 'fail',
    rehearsalId: resolved.rehearsalId,
    mode,
    nonProductionOnly: true,
    modeRoot: root,
    checks,
    errors,
    observedAtUtc: new Date().toISOString()
  }
}

function verifyMigrationQualification(file, targetReleaseId, targetImageDigest) {
  const reportPath = canonicalFile(file, 'migration qualification evidence')
  const report = readJson(reportPath, 'migration qualification evidence')
  if (report.schema !== 'fsusblog.release-migration-qualification-evidence.v1'
    || report.contractVersion !== 1
    || report.status !== 'pass'
    || report.target?.releaseId !== targetReleaseId
    || report.target?.imageDigest !== targetImageDigest
    || !Array.isArray(report.cases)
    || report.cases.map(item => item.id).join('\n') !== MIGRATION_QUALIFICATION_CASES.join('\n')
    || report.cases.some(item => item.status !== 'pass' || (item.errors?.length ?? 0) !== 0)
    || !Array.isArray(report.errors)
    || report.errors.length !== 0
    || !/^sha256:[0-9a-f]{64}$/u.test(String(report.evidenceSha256 ?? ''))) {
    fail('migration qualification evidence is incomplete or not target-bound')
  }
  return {
    rolloutId: report.rolloutId,
    runId: report.runId,
    targetReleaseId,
    evidenceSha256: hashFile(reportPath)
  }
}

function verifyRollout(stateFile, evidenceRoot, expected) {
  const state = readJson(stateFile, `${expected.kind} rollout state`)
  if (state.schema !== 'fsusblog.release-rollout-state.v1') fail('rollout state schema is invalid')
  if (state.status !== 'completed' || state.outcome !== 'succeeded') fail(`rollout is not completed: ${state.status}`)
  if (state.kind !== expected.kind) fail(`rollout kind is ${state.kind}`)
  if (state.source?.slot !== expected.sourceSlot || state.source?.releaseId !== expected.sourceRelease) fail('source identity mismatch')
  if (state.target?.slot !== expected.targetSlot || state.target?.releaseId !== expected.targetRelease) fail('target identity mismatch')
  if (state.completedStages?.join('\n') !== ROLLOUT_STAGES.join('\n')) fail('rollout stage set/order is incomplete')
  if (state.switchCommitted !== true || !Number.isSafeInteger(state.gatewayGeneration)) fail('gateway switch is not durably committed')
  if (!Array.isArray(state.recoveries) || state.recoveries.some(item => item.status !== 'ok')) fail('rollout contains unresolved recovery')
  if (expected.requireRecovery && state.recoveries.length < 1) fail('SIGKILL resume has no durable recovery record')
  const finalEvidencePath = state.finalEvidencePath
  if (typeof finalEvidencePath !== 'string') fail('final evidence path is missing')
  ensureWithin(finalEvidencePath, evidenceRoot, 'final rollout evidence')
  const evidence = readJson(finalEvidencePath, 'final rollout evidence')
  if (evidence.schema !== 'fsusblog.release-rollout-evidence.v1' || evidence.status !== 'pass') fail('final rollout evidence did not pass')
  if (evidence.rolloutId !== state.rolloutId || evidence.kind !== expected.kind) fail('final evidence identity mismatch')
  if (!Array.isArray(evidence.stages) || evidence.stages.map(item => item.stage).join('\n') !== ROLLOUT_STAGES.join('\n')) {
    fail('final evidence stages are incomplete')
  }
  for (const name of ['publicTraffic', 'notificationStream', 'assetCompatibility', 'workerReconciliation', 'resourceBudget', 'faultInjection']) {
    const artifact = evidence.artifacts?.[name]
    if (!artifact || artifact.status !== 'pass') fail(`${name} artifact did not pass`)
    assertImmutableArtifact(artifact, name)
  }
  const normalWorker = readJson(evidence.artifacts.workerReconciliation.path, 'normal worker reconciliation evidence')
  if (normalWorker.schema !== 'fsusblog.release-worker-reconciliation-evidence.v2'
    || normalWorker.mode !== 'normal'
    || normalWorker.status !== 'pass'
    || normalWorker.rolloutId !== state.rolloutId
    || normalWorker.kinds?.join('\n') !== NORMAL_WORKER_KINDS.join('\n')
    || normalWorker.forcedSourceRecoveryRequired !== false
    || Object.values(normalWorker.checks ?? {}).some(value => value !== true)) {
    fail('fresh normal worker v2 reconciliation is incomplete or not bound to rollout')
  }
  return { rolloutId: state.rolloutId, recoveryCount: state.recoveries.length, finalEvidencePath }
}

function verifyActiveSlot(file, expectedSlot) {
  const state = readJson(file, 'durable slot state')
  if (state.schema !== 'fsusblog.deployment-slots.v1') fail('slot state schema is invalid')
  if (state.status !== 'stable' || state.activeSlot !== expectedSlot) fail(`active slot is ${state.activeSlot ?? '<missing>'}`)
  const record = state.slots?.[expectedSlot]
  if (!record?.releaseId || !DIGEST.test(String(record.imageDigest ?? ''))) fail('active slot identity is incomplete')
  return { activeSlot: expectedSlot, releaseId: record.releaseId }
}

function verifyFaultEvidence(file, requirePostSwitchRollback) {
  const report = readJson(file, 'fault matrix evidence')
  if (report.schema !== 'fsusblog.zero-downtime-fault-matrix.v1' || report.status !== 'pass') fail('fault matrix did not pass')
  if (report.caseCount !== FAULT_CASES.length || report.cases?.map(item => item.case).join('\n') !== FAULT_CASES.join('\n')) {
    fail('fault matrix case set/order is incomplete')
  }
  if (report.cases.some(item => item.status !== 'pass' || item.automated !== true || item.actionStatus !== 'executed')) {
    fail('fault matrix contains an unexecuted or failed case')
  }
  if (requirePostSwitchRollback) {
    for (const name of ['active-fence-failure', 'public-probe-failure']) {
      const item = report.cases.find(candidate => candidate.case === name)
      if (item?.after?.rolloutState?.status !== 'rolled_back') fail(`${name} did not end rolled_back`)
      const recovery = item.after.rolloutState.recoveries?.at(-1)
      if (recovery?.action !== 'rollback-gateway-to-source' || recovery.status !== 'ok') {
        fail(`${name} lacks successful automatic rollback recovery`)
      }
    }
  }
  return { caseCount: report.caseCount }
}

function verifySignalEvidence(file, expectedStage) {
  const evidence = readJson(file, 'SIGKILL resume evidence')
  if (evidence.schema !== 'fsusblog.zero-downtime-rehearsal-sigkill.v1') fail('SIGKILL evidence schema is invalid')
  if (evidence.status !== 'pass' || (evidence.errors?.length ?? 0) !== 0) fail('SIGKILL evidence did not pass')
  if (evidence.signal !== 'SIGKILL' || evidence.stage !== expectedStage) fail('SIGKILL evidence signal/stage mismatch')
  if (evidence.initialExit?.signal !== 'SIGKILL' || evidence.initialExit?.code !== 137) fail('initial rollout was not killed with SIGKILL')
  if (evidence.resumeExitCode !== 0 || evidence.resumed !== true) fail('rollout did not successfully resume')
  if (!['fail-running-stage', 'resume-next-stage'].includes(evidence.orphanAction)) fail('orphan state was not durably classified')
  assertImmutableArtifact(evidence.stageHold, 'SIGKILL stage hold')
  const hold = readJson(evidence.stageHold.path, 'SIGKILL stage hold')
  if (hold.schema !== 'fsusblog.release-rollout-rehearsal-stage-hold.v1'
    || hold.status !== 'ready'
    || hold.rolloutId !== evidence.rolloutId
    || hold.stage !== expectedStage
    || (hold.errors?.length ?? 0) !== 0) {
    fail('SIGKILL stage hold is not identity-bound')
  }
  return { stage: evidence.stage, orphanAction: evidence.orphanAction }
}

function verifySigkillMatrix(file, root) {
  const matrix = readJson(file, 'SIGKILL interruption matrix')
  if (matrix.schema !== 'fsusblog.zero-downtime-rehearsal-sigkill-matrix.v1'
    || matrix.status !== 'pass'
    || (matrix.errors?.length ?? 0) !== 0
    || matrix.stages?.join('\n') !== HOST_INTERRUPTION_STAGES.join('\n')
    || matrix.entries?.map(item => item.stage).join('\n') !== HOST_INTERRUPTION_STAGES.join('\n')) {
    fail('SIGKILL interruption matrix is incomplete')
  }
  if (new Set(matrix.entries.map(item => item.rolloutId)).size !== HOST_INTERRUPTION_STAGES.length) {
    fail('SIGKILL interruption matrix reused a rolloutId')
  }
  const controlState = readJson(path.join(root, 'states', 'deploy-rollout.json'), 'fresh SIGKILL control rollout state')
  if (matrix.entries.some(item => item.rolloutId === controlState.rolloutId)) {
    fail('SIGKILL interruption matrix reused the fresh control rolloutId')
  }
  for (const entry of matrix.entries) {
    const stageRoot = path.join(root, 'interruptions', entry.stage)
    ensureWithin(entry.signalEvidence?.path, stageRoot, `${entry.stage} SIGKILL evidence`)
    ensureWithin(entry.rolloutState?.path, stageRoot, `${entry.stage} rollout state`)
    assertImmutableArtifact(entry.signalEvidence, `${entry.stage} SIGKILL evidence`)
    assertImmutableArtifact(entry.rolloutState, `${entry.stage} rollout state`)
    verifySignalEvidence(entry.signalEvidence.path, entry.stage)
    const signal = readJson(entry.signalEvidence.path, `${entry.stage} SIGKILL evidence`)
    ensureWithin(signal.stageHold?.path, stageRoot, `${entry.stage} stage hold`)
    const state = readJson(entry.rolloutState.path, `${entry.stage} rollout state`)
    if (state.rolloutId !== entry.rolloutId || state.status !== 'completed' || state.outcome !== 'succeeded') {
      fail(`${entry.stage} rollout state is not completed or identity-bound`)
    }
  }
  return { stages: matrix.stages, rolloutIds: matrix.entries.map(item => item.rolloutId) }
}

function verifyWorkerQualification(file, expectedRelease, expectedDigest) {
  const evidencePath = canonicalFile(file, 'worker qualification evidence')
  const evidence = readJson(evidencePath, 'worker qualification evidence')
  if (evidence.schema !== 'fsusblog.release-worker-qualification-evidence.v1' || evidence.status !== 'pass') {
    fail('worker qualification evidence did not pass')
  }
  if (evidence.target?.releaseId !== expectedRelease || evidence.target?.imageDigest !== expectedDigest) {
    fail('worker qualification target identity mismatch')
  }
  if (!DIGEST.test(String(evidence.policyHash ?? ''))) fail('worker qualification policy hash is invalid')
  if (!DIGEST.test(String(evidence.ledger?.sha256 ?? '')) || hashFile(evidence.ledger.path) !== evidence.ledger.sha256) {
    fail('worker qualification ledger hash mismatch')
  }
  if (!DIGEST.test(String(evidence.scenario?.sha256 ?? '')) || hashFile(evidence.scenario.path) !== evidence.scenario.sha256) {
    fail('worker qualification scenario hash mismatch')
  }
  if (!DIGEST.test(String(evidence.reconciliation?.sha256 ?? ''))
    || hashFile(evidence.reconciliation.path) !== evidence.reconciliation.sha256) {
    fail('worker qualification reconciliation hash mismatch')
  }
  const reconciliation = readJson(evidence.reconciliation.path, 'worker qualification reconciliation')
  if (reconciliation.schema !== 'fsusblog.release-worker-reconciliation-evidence.v2'
    || reconciliation.mode !== 'qualification'
    || reconciliation.checks?.normalRolloutSeparationVerified !== true
    || !DIGEST.test(String(reconciliation.inputs?.normalRolloutState?.sha256 ?? ''))) {
    fail('worker qualification lacks fresh normal rollout hash binding')
  }
  if (evidence.coordination?.status !== 'pass' || evidence.sourceTermination?.forced !== true || evidence.targetTakeover?.status !== 'pass') {
    fail('worker qualification lifecycle proof is incomplete')
  }
  return { policyHash: evidence.policyHash, ledgerSha256: evidence.ledger.sha256, path: evidencePath }
}

function assertImmutableArtifact(artifact, label) {
  if (!DIGEST.test(String(artifact.sha256 ?? ''))) fail(`${label} artifact hash is invalid`)
  const file = canonicalFile(artifact.path, `${label} artifact`)
  const bytes = fs.statSync(file).size
  const sha256 = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
  if (artifact.bytes !== bytes || artifact.sha256 !== sha256) fail(`${label} artifact changed after seal`)
}

function hashFile(file) {
  const resolved = canonicalFile(file, 'hashed evidence file')
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')}`
}

function immutableJsonMetadata(file, label) {
  const resolved = canonicalFile(file, label)
  const buffer = fs.readFileSync(resolved)
  const value = readJson(resolved, label)
  return {
    path: resolved,
    bytes: buffer.length,
    sha256: `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`,
    schema: value.schema ?? null,
    status: value.status ?? null
  }
}

function resolveFaultTokens(raw, planFile, repoRoot, workRoot) {
  object(raw, 'faults.tokens')
  const failingOpenRestyWrapper = materialFile(planFile, raw.failingOpenRestyWrapper, 'faults.tokens.failingOpenRestyWrapper')
  const dockerFailureBinPath = canonicalDirectory(resolveFrom(planFile, raw.dockerFailureBinPath), 'faults.tokens.dockerFailureBinPath')
  const retainedAsset = materialFile(planFile, raw.retainedAsset, 'faults.tokens.retainedAsset')
  const corruptAsset = materialFile(planFile, raw.corruptAsset, 'faults.tokens.corruptAsset')
  for (const [label, file] of Object.entries({ failingOpenRestyWrapper, dockerFailureBinPath, retainedAsset, corruptAsset })) {
    if (!isWithin(file, repoRoot) && !isWithin(file, workRoot)) fail(`${label} must stay under repository or rehearsal workRoot`)
  }
  if ((fs.statSync(failingOpenRestyWrapper).mode & 0o111) === 0) fail('faults.tokens.failingOpenRestyWrapper must be executable')
  const dockerFailureWrapper = canonicalFile(path.join(dockerFailureBinPath, 'docker'), 'faults.tokens.dockerFailureBinPath/docker')
  if ((fs.statSync(dockerFailureWrapper).mode & 0o111) === 0) fail('fault docker failure wrapper must be executable')
  const longRequestPath = String(raw.longRequestPath ?? '')
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%?\/-]{1,500}$/u.test(longRequestPath)
    || longRequestPath.startsWith('//')
    || longRequestPath.includes('..')) {
    fail('faults.tokens.longRequestPath must be a safe absolute HTTP path')
  }
  return { failingOpenRestyWrapper, dockerFailureBinPath, retainedAsset, corruptAsset, longRequestPath }
}

function releaseManifest(file, label) {
  const value = readJson(file, label)
  if (!isValidReleaseId(value.releaseId)) fail(`${label} releaseId is invalid`)
  if (!DIGEST.test(String(value.imageDigest ?? ''))) fail(`${label} imageDigest is invalid`)
  return { manifest: file, releaseId: value.releaseId, imageDigest: value.imageDigest }
}

function assertAssetScenario(file, oldReleaseId, newReleaseId, label) {
  const value = readJson(file, label)
  if (value.schema !== 'fsusblog.release-asset-compatibility-scenario.v1') fail(`${label} schema is invalid`)
  if (value.oldReleaseId !== oldReleaseId || value.newReleaseId !== newReleaseId) fail(`${label} release identities mismatch`)
  if (value.browser?.required !== true) fail(`${label} must require controlled browser evidence`)
}

function workerScenario(file, label) {
  const value = readJson(file, label)
  if (value.schema !== 'fsusblog.release-worker-drill-plan.v1') fail(`${label} schema is invalid`)
  if (value.coordination?.mode !== 'file-handshake') fail(`${label} must use file-handshake coordination`)
  if (value.sourceTermination?.type !== 'process-signal' || value.sourceTermination?.signal !== 'SIGKILL') {
    fail(`${label} must SIGKILL a bounded source worker process; killing the source application container is not allowed in a success rehearsal`)
  }
  const coordination = {}
  for (const name of ['armedFile', 'authorizeFile', 'terminatedFile']) {
    const candidate = String(value.coordination?.[name] ?? '')
    if (!candidate || path.isAbsolute(candidate) || candidate.split(/[\\/]/u).some(segment => segment === '..')) {
      fail(`${label} coordination.${name} must be a safe relative work-directory path`)
    }
    coordination[name] = candidate
  }
  if (new Set(Object.values(coordination)).size !== 3) fail(`${label} coordination paths must be distinct`)
  const allowedHttpOrigins = Array.isArray(value.security?.allowedHttpOrigins)
    ? value.security.allowedHttpOrigins.map((origin, index) => localUrl(origin, null, `${label}.security.allowedHttpOrigins[${index}]`))
    : fail(`${label}.security.allowedHttpOrigins must be an array`)
  return { scenario: file, coordination, allowedHttpOrigins }
}

function workerObserverServicePlan(file, label) {
  const value = readJson(file, label)
  if (value.schema !== 'fsusblog.release-worker-observer-service-plan.v1') fail(`${label} schema is invalid`)
  if (value.nonProductionOnly !== true || value.acknowledgement !== 'OBSERVE_ISOLATED_TEST_WORKERS_ONLY') {
    fail(`${label} non-production acknowledgement is invalid`)
  }
  if (/REPLACE_|<[^>]+>|\{\{[^}]+\}\}/u.test(JSON.stringify(value))) {
    fail(`${label} contains unresolved placeholders`)
  }
  const host = String(value.listen?.host ?? '')
  if (!['127.0.0.1', 'localhost'].includes(host)) fail(`${label}.listen.host must be explicit loopback`)
  const port = boundedInteger(value.listen?.port, 1, 65_535, `${label}.listen.port`)
  const baseUrl = localUrl(`http://${host}:${port}`, null, `${label}.listen`)
  return { file, baseUrl, host, port }
}

function normalWorkerScenario(file, label) {
  const value = readJson(file, label)
  if (value.schema !== 'fsusblog.release-worker-normal-observer-plan.v1') fail(`${label} schema is invalid`)
  const baseUrl = localUrl(value.baseUrl, null, `${label}.baseUrl`)
  const paths = {}
  for (const name of ['startPath', 'statusPath', 'finalizePath']) {
    const candidate = String(value[name] ?? '')
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{1,500}$/u.test(candidate) || candidate.includes('..')) {
      fail(`${label}.${name} must be a safe absolute HTTP path`)
    }
    paths[name] = candidate
  }
  if (new Set(Object.values(paths)).size !== 3) fail(`${label} endpoint paths must be distinct`)
  const requiredKinds = value.requiredKinds
  const expectedKinds = [
    'scheduled-publish', 'article-mutation-outbox', 'audit-writer', 'visit-view-projection',
    'public-hot-aot', 'upload-cleanup', 'active-singleton-control', 'multi-consumer-safe-control'
  ]
  if (!Array.isArray(requiredKinds) || requiredKinds.join('\n') !== expectedKinds.join('\n')) {
    fail(`${label}.requiredKinds must contain the exact ordered normal 8-kind set`)
  }
  return {
    file,
    baseUrl,
    ...paths,
    requiredKinds,
    timeoutMs: boundedInteger(value.timeoutMs ?? 300_000, 10_000, 900_000, `${label}.timeoutMs`),
    pollMs: boundedInteger(value.pollMs ?? 250, 50, 10_000, `${label}.pollMs`)
  }
}

function assertTestEnvironment(file, publicUrl) {
  const content = fs.readFileSync(file, 'utf8')
  const entries = new Map()
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator > 0) entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const environment = entries.get('ASPNETCORE_ENVIRONMENT') ?? entries.get('DOTNET_ENVIRONMENT')
  if (environment !== 'Test') fail('envFile must explicitly set ASPNETCORE_ENVIRONMENT or DOTNET_ENVIRONMENT to Test')
  const baseUrl = entries.get('SITE_BASEURL')
  if (baseUrl === undefined) fail('envFile must explicitly set SITE_BASEURL')
  localUrl(baseUrl, null, 'envFile SITE_BASEURL')
  if (new URL(baseUrl).origin !== new URL(publicUrl).origin) fail('envFile SITE_BASEURL must match rehearsal publicUrl origin')
  if (entries.get('EXTERNAL_DB_HOST') !== 'global-postgres') fail('envFile EXTERNAL_DB_HOST must be the isolated rehearsal Postgres alias')
  if (entries.get('EXTERNAL_REDIS_HOST') !== 'global-redis') fail('envFile EXTERNAL_REDIS_HOST must be the isolated rehearsal Redis alias')
  if (!/(?:rehears|test)/iu.test(entries.get('DB_NAME') ?? '')) fail('envFile DB_NAME must explicitly identify a rehearsal/test database')
  for (const name of ['FSUSBLOG_REHEARSAL_POSTGRES_IMAGE', 'FSUSBLOG_REHEARSAL_REDIS_IMAGE', 'FSUSBLOG_REHEARSAL_OPENRESTY_IMAGE']) {
    if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(entries.get(name) ?? '')) fail(`envFile ${name} must be an immutable repository digest`)
  }
  for (const name of ['FSUSBLOG_REHEARSAL_POSTGRES_VOLUME', 'FSUSBLOG_REHEARSAL_REDIS_VOLUME', 'FSUSBLOG_SHARED_UPLOADS_VOLUME', 'FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME']) {
    const value = entries.get(name)
    if (value !== undefined && !/^fsusblog-zdt-[A-Za-z0-9_.-]{1,80}$/u.test(value)) fail(`envFile ${name} must use an isolated fsusblog-zdt-* volume`)
  }
}

function validateNoSecretEnvironment(value, label) {
  if (value === undefined) return
  object(value, label)
  for (const [name, content] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)) fail(`${label} contains an unsafe variable name`)
    if (/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CONNECTION_STRING)$/u.test(name)) {
      fail(`${label} must pass secrets by private file, not environment value`)
    }
    if (typeof content !== 'string' || content.includes('\0') || content.includes('\n')) fail(`${label}.${name} is invalid`)
  }
}

function assertResolvedPlan(value) {
  object(value, 'resolved plan')
  if (value.schema !== RESOLVED_PLAN_SCHEMA || value.nonProductionOnly !== true || value.environment !== 'Test') {
    fail('resolved rehearsal plan is invalid')
  }
}

function replaceStrings(value, replacements) {
  if (typeof value === 'string') {
    let result = value
    for (const [needle, replacement] of replacements) result = result.split(needle).join(replacement)
    return result
  }
  if (Array.isArray(value)) return value.map(item => replaceStrings(item, replacements))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replacements)]))
  }
  return value
}

function rebindFaultContainers(value, sourceSlot, targetSlot) {
  if (typeof value === 'string') {
    const marker = '__FSUSBLOG_SOURCE_CONTAINER__'
    return value
      .replaceAll('fsus-app-blue', marker)
      .replaceAll('fsus-app-green', `fsus-app-${targetSlot}`)
      .replaceAll(marker, `fsus-app-${sourceSlot}`)
  }
  if (Array.isArray(value)) return value.map(item => rebindFaultContainers(item, sourceSlot, targetSlot))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebindFaultContainers(item, sourceSlot, targetSlot)]))
  }
  return value
}

function childRolloutId(parent, child) {
  const suffix = crypto.createHash('sha256').update(`${parent}\0${child}`).digest('hex').slice(0, 12)
  const tail = `-${child}-${suffix}`
  return safeId(`${parent.slice(0, 128 - tail.length)}${tail}`, 'fault case rolloutId')
}

function privateMaterialFile(planFile, value, label) {
  const file = materialFile(planFile, value, label)
  const mode = fs.statSync(file).mode & 0o777
  if (![0o400, 0o600].includes(mode)) fail(`${label} must have mode 0400 or 0600`)
  return file
}

function assertPrivateAdminHeader(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const match = lines.length === 1 ? /^(Authorization|Cookie): (\S(?:.*\S)?)$/u.exec(lines[0]) : null
  if (!match || (match[1] === 'Authorization' && !match[2].startsWith('Bearer '))) {
    fail('adminHeaderFile must contain exactly one Authorization: Bearer or Cookie header')
  }
}

function materialFile(planFile, value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required`)
  return canonicalFile(resolveFrom(planFile, value), label)
}

function resolveFrom(planFile, value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail('path value is missing or invalid')
  return path.resolve(path.dirname(planFile), value)
}

function canonicalFile(value, label) {
  const resolved = path.resolve(value)
  const stat = fs.statSync(resolved, { throwIfNoEntry: false })
  if (!stat?.isFile()) fail(`${label} is missing or not a regular file: ${resolved}`)
  if (fs.lstatSync(resolved).isSymbolicLink()) fail(`${label} must not be a symbolic link`)
  return fs.realpathSync(resolved)
}

function canonicalDirectory(value, label) {
  const resolved = path.resolve(value)
  const stat = fs.statSync(resolved, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) fail(`${label} is missing or not a directory: ${resolved}`)
  if (fs.lstatSync(resolved).isSymbolicLink()) fail(`${label} must not be a symbolic link`)
  return fs.realpathSync(resolved)
}

function localUrl(value, requiredPathname, label) {
  let parsed
  try { parsed = new URL(String(value ?? '')) } catch { fail(`${label} is not an absolute URL`) }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    fail(`${label} must be an explicit loopback HTTP URL for local rehearsal`)
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail(`${label} must not contain credentials/query/fragment`)
  if (!parsed.port) fail(`${label} must include an explicit port`)
  if (requiredPathname !== null && parsed.pathname !== requiredPathname) fail(`${label} must end with ${requiredPathname}`)
  return parsed.href.replace(/\/$/u, requiredPathname === null ? '' : '/')
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { fail(`unable to read ${label}: ${message(error)}`) }
}

function readOptionalJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJsonAtomic(file, value) {
  const resolved = path.resolve(file)
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, resolved)
}

function ensureWithin(candidate, parent, label) {
  if (!isWithin(candidate, parent)) fail(`${label} escapes ${parent}`)
}

function assertNoSymlinkTraversal(candidate, parent, label) {
  ensureWithin(candidate, parent, label)
  let cursor = path.resolve(parent)
  const target = path.resolve(candidate)
  const parentStat = fs.lstatSync(cursor, { throwIfNoEntry: false })
  if (parentStat?.isSymbolicLink()) fail(`${label} parent must not be a symbolic link`)
  const relative = path.relative(cursor, path.resolve(candidate))
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false })
    if (stat === undefined) break
    if (stat.isSymbolicLink()) fail(`${label} must not traverse a symbolic link: ${cursor}`)
    if (cursor !== target && !stat.isDirectory()) fail(`${label} traverses a non-directory path: ${cursor}`)
  }
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function safeId(value, label) {
  const result = String(value ?? '')
  if (!SAFE_ID.test(result) || result.includes('..')) fail(`${label} is invalid`)
  return result
}

function boundedInteger(value, minimum, maximum, label) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail(`${label} must be ${minimum}..${maximum}`)
  return result
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function fail(message) {
  throw new Error(message)
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function parseCli(argv) {
  const command = argv.shift()
  const options = {}
  while (argv.length > 0) {
    const name = argv.shift()
    const value = argv.shift()
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) fail(`invalid argument near ${name ?? '<end>'}`)
    options[name.slice(2)] = value
  }
  return { command, options }
}

async function main(argv) {
  const { command, options } = parseCli([...argv])
  if (command === 'resolve') {
    if (!options.plan || !options['repo-root'] || !options.out) fail('resolve requires --plan, --repo-root and --out')
    const planFile = path.resolve(options.plan)
    const resolved = resolveRehearsalPlan(readJson(planFile, 'rehearsal plan'), { planFile, repoRoot: options['repo-root'] })
    writeJsonAtomic(options.out, resolved)
    process.stdout.write(`${JSON.stringify({ schema: resolved.schema, rehearsalId: resolved.rehearsalId, out: path.resolve(options.out) })}\n`)
    return
  }
  if (command === 'materialize-fault') {
    if (!options.plan || !options['run-root'] || !options.out) fail('materialize-fault requires --plan, --run-root and --out')
    const resolved = readJson(path.resolve(options.plan), 'resolved rehearsal plan')
    const faultPlan = materializeFaultPlan(
      resolved,
      options['run-root'],
      options.kind ?? 'deploy',
      options['rollout-id'] ?? null,
      path.resolve(options.plan))
    writeJsonAtomic(options.out, faultPlan)
    process.stdout.write(`${JSON.stringify({ schema: faultPlan.schema, caseCount: faultPlan.cases.length, out: path.resolve(options.out) })}\n`)
    return
  }
  if (command === 'materialize-migration-qualification') {
    for (const name of [
      'plan', 'run-root', 'runtime', 'database-isolation-id', 'source-origin', 'target-origin',
      'env-file', 'admin-header-file', 'source-write-body', 'target-write-body',
      'contract-window-evidence', 'contract-qualified-evidence', 'out'
    ]) if (!options[name]) fail(`materialize-migration-qualification requires --${name}`)
    const resolved = readJson(path.resolve(options.plan), 'resolved rehearsal plan')
    const scenario = materializeMigrationQualificationScenario(resolved, {
      runRoot: options['run-root'],
      runtime: options.runtime,
      databaseIsolationId: options['database-isolation-id'],
      sourceOrigin: options['source-origin'],
      targetOrigin: options['target-origin'],
      envFile: options['env-file'],
      adminHeaderFile: options['admin-header-file'],
      sourceWriteBody: options['source-write-body'],
      targetWriteBody: options['target-write-body'],
      contractWindowEvidence: options['contract-window-evidence'],
      contractQualifiedEvidence: options['contract-qualified-evidence']
    })
    writeJsonAtomic(options.out, scenario)
    process.stdout.write(`${JSON.stringify({ schema: scenario.schema, caseCount: scenario.cases.length, out: path.resolve(options.out) })}\n`)
    return
  }
  if (command === 'derive-rollout-id') {
    for (const name of ['role', 'phase', 'release', 'run-id']) if (!options[name]) fail(`derive-rollout-id requires --${name}`)
    process.stdout.write(`${deriveRehearsalRolloutId(options.role, options.phase, options.release, options['run-id'])}\n`)
    return
  }
  if (command === 'wait-stage') {
    if (!options.state || !options.stage) fail('wait-stage requires --state and --stage')
    const state = await waitForRolloutStage(
      options.state,
      options.stage,
      Number(options['timeout-ms'] ?? 180_000),
      Number(options['poll-ms'] ?? 50))
    process.stdout.write(`${JSON.stringify({ rolloutId: state.rolloutId, stage: state.currentStage, status: state.status })}\n`)
    return
  }
  if (command === 'inspect-orphan') {
    if (!options.state || !options.stage) fail('inspect-orphan requires --state and --stage')
    process.stdout.write(`${JSON.stringify(inspectOrphanedRollout(options.state, options.stage))}\n`)
    return
  }
  if (command === 'worker-health') {
    if (!options.state || !options.ledger || !options.out) fail('worker-health requires --state, --ledger and --out')
    const report = buildWorkerTargetHealth(options.state, options.ledger)
    writeJsonAtomic(options.out, report)
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }
  if (command === 'worker-qualification') {
    if (!options.state || !options.ledger || !options.scenario || !options.out) {
      fail('worker-qualification requires --state, --ledger, --scenario and --out')
    }
    const report = buildWorkerQualification(options.state, options.ledger, options.scenario)
    writeJsonAtomic(options.out, report)
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }
  if (command === 'authorize-worker') {
    if (!options.state || !options.armed || !options.out || !options['run-id']) {
      fail('authorize-worker requires --state, --armed, --out and --run-id')
    }
    const signal = authorizeWorkerQualification(options.state, options.armed, options.out, options['run-id'])
    process.stdout.write(`${JSON.stringify(signal)}\n`)
    return
  }
  if (command === 'finalize-worker-qualification') {
    if (!options.control || !options.reconciliation || !options.out) {
      fail('finalize-worker-qualification requires --control, --reconciliation and --out')
    }
    const report = finalizeWorkerQualification(options.control, options.reconciliation)
    writeJsonAtomic(options.out, report)
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }
  if (command === 'sigkill-evidence') {
    if (!options.state || !options.stage || !options['initial-exit'] || !options['orphan-action'] || !options['resume-exit'] || !options['hold-ready'] || !options.out) {
      fail('sigkill-evidence requires --state, --stage, --initial-exit, --orphan-action, --resume-exit, --hold-ready and --out')
    }
    const report = buildSigkillResumeEvidence(
      options.state,
      options.stage,
      Number(options['initial-exit']),
      options['orphan-action'],
      Number(options['resume-exit']),
      options['hold-ready'])
    writeJsonAtomic(options.out, report)
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }
  if (command === 'sigkill-matrix') {
    if (!options['mode-root'] || !options.out) fail('sigkill-matrix requires --mode-root and --out')
    const report = buildSigkillMatrixEvidence(options['mode-root'])
    writeJsonAtomic(options.out, report)
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }
  if (command === 'verify-mode') {
    if (!options.plan || !options.mode || !options['mode-root'] || !options.out) {
      fail('verify-mode requires --plan, --mode, --mode-root and --out')
    }
    const resolved = readJson(path.resolve(options.plan), 'resolved rehearsal plan')
    const report = verifyMode(resolved, options.mode, options['mode-root'])
    writeJsonAtomic(options.out, report)
    process.stdout.write(`${JSON.stringify(report)}\n`)
    if (report.status !== 'pass') process.exitCode = 1
    return
  }
  fail('usage: zero-downtime-rehearsal-plan.mjs <resolve|derive-rollout-id|materialize-fault|materialize-migration-qualification|wait-stage|inspect-orphan|worker-health|worker-qualification|authorize-worker|finalize-worker-qualification|sigkill-evidence|sigkill-matrix|verify-mode> [options]')
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`[zero-downtime-rehearsal-plan] fatal: ${message(error)}\n`)
    process.exitCode = 1
  })
}
