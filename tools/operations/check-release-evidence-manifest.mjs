#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const { assertReleaseIdentity, isValidReleaseId } = await import(new URL('../release/release-id.mjs', import.meta.url));
const { validateReleaseManifest, deriveReleaseCandidateId, deriveReleaseManifestContentDigest } = await import(new URL('../release/release-manifest.mjs', import.meta.url));
const { validateReleaseRuntimeMatrix } = await import(new URL('../runtime-profiles/release-runtime-matrix.mjs', import.meta.url));
const {
    createProductionFreshRunBoundLocator,
    readProductionFreshJsonOutput,
    resolveProductionFreshLocatorEnvironment
} = await import(new URL('../test-matrix/production-fresh-output-locator.mjs', import.meta.url));
const { resolveProductionFreshOutputAttempt } = await import(new URL('../test-matrix/production-fresh-run-bound-outputs.mjs', import.meta.url));

import { evidenceClassificationErrors } from './evidence-classification.mjs';
const { verifyCleanAttemptCohortManifest } = await import(new URL('../release/release-clean-attempt-cohort.mjs', import.meta.url));


const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const requiredRedisFaultCases = ['redis-restart', 'redis-reconnect', 'redis-latency'];
const requiredPostgresFaultCases = ['postgres-readiness', 'postgres-reconnect', 'postgres-lock-timeout'];
const requiredNotificationFaultCases = ['notification-stream-slow-consumer'];
const requiredGracefulShutdownFaultCases = ['graceful-shutdown'];
const requiredDiskArtifactFaultCases = ['disk-artifact-storage-write-failure'];
const requiredRolloutStages = [
    'manifest-validate', 'capacity-preflight', 'backup-restore-gate', 'expand-migration',
    'asset-materialize', 'candidate-start', 'candidate-readiness', 'candidate-smoke',
    'compatibility-smoke', 'gateway-switch', 'source-drain', 'active-fence',
    'public-verify', 'source-stop', 'release-evidence'
];
const requiredRolloutArtifacts = [
    'publicTraffic', 'notificationStream', 'assetCompatibility',
    'workerReconciliation', 'resourceBudget', 'faultInjection'
];
const requiredTrafficCategories = [
    'home', 'archive', 'article', 'binary', 'search', 'static',
    'login', 'refresh', 'protected-read', 'write', 'upload', 'admin-health'
];
const requiredTrafficPolicyStages = ['status:planned', ...requiredRolloutStages, 'status:completed'];
const requiredRolloutAuxiliary = [
    'releaseManifest', 'backupRestoreGate', 'migrationExpand', 'candidateReadiness',
    'assetMaterialization', 'retentionPrepared', 'retainedAssets', 'candidateSmoke',
    'compatibilityMatrix', 'gatewayTransition', 'activeFenceAcquire',
    'activeFenceSourceRevoke', 'activeFenceVerify', 'publicTrafficCheckpoint',
    'sourceDrainSnapshot', 'sourceDrainGate', 'targetHealth',
    'retentionDrainComplete', 'operatorNote'
];

const requiredStatusChecks = [
    ['image digest', (manifest) => manifest.evidenceSummary?.image?.status === 'present'],
    ['release identity', (manifest) => releaseIdentityOk(manifest)],
    ['sealed runtime publish matrix', (manifest, context) => Boolean(context.manifestPath) && validateReleaseRuntimeMatrix(manifest, context.manifestPath).length === 0],
    ['coverage', (manifest) => manifest.evidenceSummary?.coverage?.status === 'ok'],
    ['ZAP DAST', (manifest) => manifest.evidenceSummary?.security?.dastZap === 'ok'],
    ['authenticated DAST', (manifest, context) => manifest.evidenceSummary?.security?.authenticatedDast === 'ok' && authenticatedDastOk(manifest, context)],
    ['local runtime exposure', (manifest, context) => manifest.evidenceSummary?.security?.localRuntimeExposure === 'ok' && localRuntimeExposureOk(manifest, context)],
    ['Wasm fuzz', (manifest, context) => manifest.evidenceSummary?.security?.wasmFuzz === 'ok' && wasmFuzzOk(manifest, context)],
    ['attack matrix', (manifest) => manifest.evidenceSummary?.security?.attackMatrix === 'ok'],
    ['permission matrix', (manifest) => manifest.evidenceSummary?.security?.permissionMatrix === 'ok'],
    ['supply chain', (manifest) => manifest.evidenceSummary?.security?.supplyChain === 'ok'],
    ['SBOM', (manifest) => manifest.evidenceSummary?.security?.sbom === 'ok'],
    ['post deploy smoke', (manifest, context) => manifest.evidenceSummary?.operations?.postDeploySmoke === 'ok' && postDeploySmokeOk(manifest, context)],
    ['gateway transition', (manifest, context) => manifest.evidenceSummary?.operations?.gatewayTransition === 'ok' && gatewayTransitionOk(manifest, context)],
    ['zero downtime release rollout', (manifest, context) => manifest.evidenceSummary?.operations?.releaseRollout === 'ok' && releaseRolloutOk(manifest, context)],
    ['backup restore drill', (manifest, context) => manifest.evidenceSummary?.operations?.backupRestoreDrill === 'ok' && backupRestoreDrillOk(manifest, context)],
    ['SLO alert replay', (manifest) => manifest.evidenceSummary?.operations?.sloAlerts === 'ok'],
    ['critical SLO alerts', (manifest) => Number(manifest.evidenceSummary?.operations?.sloCriticalFiring ?? 0) === 0],
    ['fault injection', (manifest, context) => manifest.evidenceSummary?.resilienceDepth?.faultInjection === 'ok' && faultInjectionOk(manifest, context)],
    ['short soak', (manifest, context) => manifest.evidenceSummary?.resilienceDepth?.soak === 'ok' && shortSoakOk(manifest, context)],
    ['memory leak resource budget', (manifest, context) => manifest.evidenceSummary?.resilienceDepth?.memoryLeak === 'ok' && releaseResourceSummaryOk(manifest, context, 'memoryLeakSummary')],
    ['open handle resource budget', (manifest, context) => manifest.evidenceSummary?.resilienceDepth?.openHandle === 'ok' && releaseResourceSummaryOk(manifest, context, 'openHandleSummary')],
    ['production status', (manifest) => manifest.evidenceSummary?.externalExposure?.status === 'ok'],
    ['firewall policy', (manifest) => manifest.evidenceSummary?.externalExposure?.firewallPolicy === 'present'],
    ['DNS readiness', (manifest) => manifest.evidenceSummary?.externalExposure?.dnsReadiness === 'ok'],
    ['DNS delegation', (manifest) => manifest.evidenceSummary?.externalExposure?.dnsDelegation === 'ok'],
    ['live exposure', (manifest) => manifest.evidenceSummary?.externalExposure?.liveExposure === 'ok'],
    ['frontend render structure', (manifest, context) => manifest.evidenceSummary?.gates?.frontendRenderStructure === 'ok' && frontendRenderStructureOk(manifest, context)],
    ['AEDS Wasm decode budget', (manifest, context) => manifest.evidenceSummary?.gates?.aedsDecodeBudget === 'ok' && aedsDecodeBudgetOk(manifest, context)],
    ['public AOT cache resilience', (manifest, context) => manifest.evidenceSummary?.gates?.publicAotCacheResilience === 'success' && publicAotCacheResilienceOk(manifest, context)],
    ['public hydration sidecar', (manifest, context) => manifest.evidenceSummary?.gates?.publicHydrationSidecar === 'success' && publicHydrationSidecarOk(manifest, context)],
    ['doc sync', (manifest) => manifest.evidenceSummary?.gates?.docSync === 'ok']
];

const requiredArtifacts = [
    'attackMatrix',
    'permissionMatrix',
    'dastZap',
    'authenticatedDast',
    'localRuntimeExposure',
    'fuzz',
    'supplyChain',
    'sbom',
    'postDeploySmoke',
    'gatewayTransition',
    'releaseRollout',
    'releaseRolloutBundle',
    'backupRestoreDrill',
    'coverage',
    'runtimePublishMatrix',
    'jobSummaries',
    'frontendRenderStructureSummary',
    'aedsDecodeBudgetSummary',
    'aotCacheResilienceSummary',
    'publicHydrationSidecarSummary',
    'publishArtifactsSummary',
    'docSyncSummary',
    'markdownRenderBudgetSummary',
    'domDepthStaticSummary',
    'productionExposureStatus',
    'productionExposureLive',
    'firewallPolicy',
    'dnsReadiness',
    'dnsDelegation',
    'faultInjection',
    'soak',
    'memoryLeakSummary',
    'openHandleSummary'
];

function fail(message)
{
    console.error(`[release-manifest-check] ${message}`);
    process.exit(1);
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function artifactPath(manifest, manifestPath, key)
{
    const artifact = manifest.artifacts?.[key];
    if (!artifact || artifact === 'null' || !manifestPath)
    {
        return null;
    }
    return path.resolve(path.dirname(manifestPath), artifact);
}

function readArtifactJson(manifest, context, key, relative = null)
{
    const base = artifactPath(manifest, context.manifestPath, key);
    if (!base)
    {
        return null;
    }
    const file = relative ? path.join(base, relative) : base;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    {
        return null;
    }
    try
    {
        return readJson(file);
    }
    catch
    {
        return null;
    }
}

function aedsWorkerModelOk(model, resourceSource)
{
    return model?.resourceSource === resourceSource
    && Number.isSafeInteger(model.logicalProcessors) && model.logicalProcessors >= 1
    && model.instancesPerPage === 1
    && Number.isSafeInteger(model.minimumActiveRequests) && model.minimumActiveRequests >= 1
    && Number.isSafeInteger(model.maximumActiveRequests) && model.maximumActiveRequests >= model.minimumActiveRequests
    && model.maximumActiveRequests <= 32
    && Number.isSafeInteger(model.activeRequests)
    && model.activeRequests >= model.minimumActiveRequests
    && model.activeRequests <= model.maximumActiveRequests;
}

function aedsDecodeBudgetOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'aedsDecodeBudgetSummary');
    if (!report || report.status !== 'ok'
    || report.evidenceClass !== 'correctness'
    || report.affectsCorrectness !== true
    || report.executionBoundary !== 'browserless-node-wasm-runtime'
    || report.commitSha !== manifest.commitSha
    || !/^[0-9a-f]{40}$/u.test(String(report.commitSha ?? ''))
    || report.measurementSource !== 'real-basic-speed-wasm-runtime'
    || !aedsWorkerModelOk(report.workerModel, 'os.availableParallelism'))
    {
        return false;
    }
    const tiers = new Map((Array.isArray(report.tiers) ? report.tiers : []).map((tier) => [tier?.tier, tier]));
    const tierBudgets = {
        basic: { rawBytes: 64 * 1024, gzipBytes: 32 * 1024, brotliBytes: 24 * 1024, compileP95Ms: 50, memoryPages: 4096 },
        speed: { rawBytes: 96 * 1024, gzipBytes: 48 * 1024, brotliBytes: 40 * 1024, compileP95Ms: 75, memoryPages: 1024 }
    };
    for (const tierName of ['basic', 'speed'])
    {
        const tier = tiers.get(tierName);
        const budget = tierBudgets[tierName];
        if (!tier || !Number.isFinite(tier.compileP95Ms) || tier.compileP95Ms < 0)
        {
            return false;
        }
        if (!Number.isSafeInteger(tier.memoryPages) || tier.memoryPages < 1)
        {
            return false;
        }
        if (!Number.isSafeInteger(tier.artifact?.rawBytes) || tier.artifact.rawBytes < 1)
        {
            return false;
        }
        if (!Number.isSafeInteger(tier.artifact?.gzipBytes) || tier.artifact.gzipBytes < 1)
        {
            return false;
        }
        if (!Number.isSafeInteger(tier.artifact?.brotliBytes) || tier.artifact.brotliBytes < 1)
        {
            return false;
        }
        if (tier.compileP95Ms > budget.compileP95Ms
      || tier.memoryPages > budget.memoryPages
      || tier.artifact.rawBytes > budget.rawBytes
      || tier.artifact.gzipBytes > budget.gzipBytes
      || tier.artifact.brotliBytes > budget.brotliBytes)
        {
            return false;
        }
        if (!Number.isSafeInteger(tier.initialMemoryPages) || tier.initialMemoryPages < 1
      || !Number.isSafeInteger(tier.peakMemoryPages) || tier.peakMemoryPages < tier.initialMemoryPages
      || !Number.isSafeInteger(tier.growCount) || tier.growCount < 0
      || !Number.isSafeInteger(tier.arenaReallocationCount) || tier.arenaReallocationCount < 1
      || !Number.isSafeInteger(tier.arenaClearCount) || tier.arenaClearCount < 1
      || tier.sensitiveBytesCleared !== true)
        {
            return false;
        }
        const copy = tier.copyBudget;
        if (copy?.measurementSource !== 'executed-arena-and-owned-payload-copy'
      || !Number.isSafeInteger(copy.measuredDecodeCount) || copy.measuredDecodeCount < 1
      || !Number.isSafeInteger(copy.jsToWasmCopiedBytes) || copy.jsToWasmCopiedBytes < 1
      || copy.jsToWasmCopiedBytes !== copy.expectedJsToWasmCopiedBytes
      || !Number.isSafeInteger(copy.wasmToJsCopiedBytes) || copy.wasmToJsCopiedBytes < 1
      || copy.wasmToJsCopiedBytes !== copy.expectedWasmToJsCopiedBytes
      || copy.structuredCloneFullBufferCopies !== 0
      || tier.arenaReallocationCount >= copy.measuredDecodeCount)
        {
            return false;
        }
    }
    const speed = tiers.get('speed');
    if (speed.initialMemoryPages !== 1024 || speed.memoryPages !== 1024
    || speed.peakMemoryPages !== 1024 || speed.growCount !== 0)
    {
        return false;
    }
    const throughput = Array.isArray(report.throughput) ? report.throughput : [];
    return throughput.length >= 3
    && throughput.every((sample) => Number.isSafeInteger(sample?.frameBytes) && sample.frameBytes > 0
      && Number.isFinite(sample?.basicMBps) && sample.basicMBps > 0
      && Number.isFinite(sample?.speedMBps) && sample.speedMBps > 0
      && Number.isFinite(sample?.speedup) && sample.speedup > 0)
    && throughput.filter((sample) => sample.speedup > 1).length >= 2
    && Number.isFinite(report.budgets?.measuredMedianSpeedup)
    && report.budgets.measuredMedianSpeedup >= 1.05;
}

function includesAll(values, required)
{
    const set = new Set(Array.isArray(values) ? values : []);
    return required.every((value) => set.has(value));
}

function releaseIdentityOk(manifest)
{
    const identity = manifest.releaseIdentity;
    if (!identity || typeof identity !== 'object' || Array.isArray(identity))
    {
        return false;
    }
    const { releaseSlot, ...releaseManifest } = identity;
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(String(releaseSlot ?? '')))
    {
        return false;
    }
    if (manifest.evidenceSummary?.image?.releaseIdentityStatus !== 'ok')
    {
        return false;
    }
    if (manifest.imageDigest !== releaseManifest.imageDigest)
    {
        return false;
    }
    if (manifest.commitSha !== releaseManifest.commitSha)
    {
        return false;
    }
    return validateReleaseManifest(releaseManifest, {
        requireRegistryDigest: true,
        requireConcreteRuntimeProfile: true,
        expectedReleaseId: releaseManifest.releaseId,
        expectedImageRef: releaseManifest.imageRef,
        expectedImageDigest: manifest.imageDigest,
        expectedCommitSha: manifest.commitSha
    }).length === 0;
}

function gatewayTransitionOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'gatewayTransition');
    if (!report || typeof report !== 'object' || Array.isArray(report) || report.status !== 'ok')
    {
        return false;
    }
    if (!Number.isSafeInteger(report.generation) || report.generation < 1)
    {
        return false;
    }
    if (!Number.isFinite(report.durationMs) || report.durationMs < 0)
    {
        return false;
    }
    if (!isIsoUtc(report.startedAtUtc) || !isIsoUtc(report.completedAtUtc))
    {
        return false;
    }
    if (Date.parse(report.completedAtUtc) < Date.parse(report.startedAtUtc))
    {
        return false;
    }
    if (containsSensitiveFieldName(report))
    {
        return false;
    }
    if (!gatewayReleaseIdentityOk(report.source) || !gatewayReleaseIdentityOk(report.target))
    {
        return false;
    }
    if (report.source.slot === report.target.slot)
    {
        return false;
    }

    let finalIdentity;
    if (report.schema === 'fsusblog.gateway-transition-evidence.v1')
    {
        if (!['switch', 'rollback'].includes(report.kind))
        {
            return false;
        }
        if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/health\/ready$/u.test(String(report.publicProbeUrl ?? '')))
        {
            return false;
        }
        const expectedPostSwitchProbeUrl = report.checks?.sourceDrainDeferred === true
            ? String(report.publicProbeUrl).replace(/\/health\/ready$/u, '/health/live')
            : report.publicProbeUrl;
        if (report.postSwitchProbeUrl !== expectedPostSwitchProbeUrl)
        {
            return false;
        }
        if (!/^sha256:[0-9a-f]{64}$/u.test(String(report.upstreamBeforeSha256 ?? '')))
        {
            return false;
        }
        if (!/^sha256:[0-9a-f]{64}$/u.test(String(report.upstreamAfterSha256 ?? '')))
        {
            return false;
        }
        if (!allTrue(report.checks, [
            'targetIdentity',
            'targetReadiness',
            'sourcePublicRelease',
            'stagedConfigTest',
            'stateBegin',
            'upstreamInstall',
            'activeConfigTest',
            'reload',
            'publicReleaseProbe',
            'targetLoopbackAfterReload',
            'stateCommit',
            'sourceRuntimeStatus',
            'targetRuntimeStatus',
            'targetActivation'
        ]))
        {
            return false;
        }
        if (!((report.checks.sourceDrain === true && report.checks.sourceDrainDeferred === false)
      || (report.checks.sourceDrain === false && report.checks.sourceDrainDeferred === true)))
        {
            return false;
        }
        if (!deploymentLifecycleEvidenceOk(report))
        {
            return false;
        }
        finalIdentity = report.target;
    }
    else if (report.schema === 'fsusblog.gateway-recovery-evidence.v1')
    {
        if (report.kind !== 'recovery' || !['restore-source', 'commit-target'].includes(report.action))
        {
            return false;
        }
        if (!allTrue(report.checks, ['activeConfigTest', 'reload', 'publicReleaseProbe', 'stateResolution']))
        {
            return false;
        }
        if (report.action === 'restore-source' && !allTrue(report.checks, ['sourceRuntime', 'sourceRuntimeStatus', 'targetNeutralized']))
        {
            return false;
        }
        if (report.action === 'commit-target' && !allTrue(report.checks, ['targetRuntime', 'targetRuntimeStatus', 'targetActivation', 'sourceRuntimeStatus', 'sourceDrain']))
        {
            return false;
        }
        if (!gatewayRecoveryLifecycleOk(report))
        {
            return false;
        }
        finalIdentity = report.action === 'restore-source' ? report.source : report.target;
        if (report.observedAfter?.publicReleaseId !== finalIdentity.releaseId || report.observedAfter?.publicSlot !== finalIdentity.slot)
        {
            return false;
        }
    }
    else
    {
        return false;
    }

    const releaseIdentity = manifest.releaseIdentity;
    return releaseIdentity?.releaseSlot === finalIdentity.slot
    && releaseIdentity.releaseId === finalIdentity.releaseId
    && releaseIdentity.imageDigest === finalIdentity.imageDigest;
}

function gatewayReleaseIdentityOk(identity)
{
    return identity
    && typeof identity === 'object'
    && !Array.isArray(identity)
    && ['blue', 'green'].includes(identity.slot)
    && isValidReleaseId(identity.releaseId, { forPublication: true })
    && /^sha256:[0-9a-f]{64}$/u.test(String(identity.imageDigest ?? ''));
}

function deploymentLifecycleEvidenceOk(report)
{
    const lifecycle = report.lifecycle;
    if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle))
    {
        return false;
    }
    const sourceBefore = lifecycle.sourceBefore;
    const targetBefore = lifecycle.targetBefore;
    const targetAfter = lifecycle.targetAfterActivation;
    const sourceAfter = lifecycle.sourceAfterDrain;
    if (![sourceBefore, targetBefore, targetAfter, sourceAfter].every((snapshot) =>
        snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      && Number.isSafeInteger(snapshot.generation) && snapshot.generation > 0))
    {
        return false;
    }
    if (sourceBefore.releaseId !== report.source.releaseId || sourceBefore.slot !== report.source.slot)
    {
        return false;
    }
    if (targetBefore.releaseId !== report.target.releaseId || targetBefore.slot !== report.target.slot)
    {
        return false;
    }
    if (targetAfter.releaseId !== report.target.releaseId || targetAfter.slot !== report.target.slot)
    {
        return false;
    }
    if (sourceAfter.releaseId !== report.source.releaseId || sourceAfter.slot !== report.source.slot)
    {
        return false;
    }
    if (sourceBefore.mode !== 'active' || sourceBefore.state !== 'active' || sourceBefore.canReceiveTraffic !== true)
    {
        return false;
    }
    if (targetBefore.mode !== 'candidate' || targetBefore.state !== 'ready' || targetBefore.canReceiveTraffic !== false || targetBefore.canClaimBackgroundWork !== false)
    {
        return false;
    }
    if (targetAfter.mode !== 'active' || targetAfter.state !== 'active' || targetAfter.canReceiveTraffic !== true || targetAfter.canClaimBackgroundWork !== true)
    {
        return false;
    }
    if (report.checks.sourceDrainDeferred === true)
    {
        return sourceAfter.mode === 'active'
      && sourceAfter.state === 'active'
      && sourceAfter.drain?.requested === false;
    }
    return sourceAfter.mode === 'draining'
    && sourceAfter.state === 'draining'
    && sourceAfter.canReceiveTraffic === false
    && sourceAfter.canClaimBackgroundWork === false
    && sourceAfter.drain?.requested === true
    && sourceAfter.drain?.drained === true
    && sourceAfter.drain?.timedOut === false
    && Array.isArray(sourceAfter.drain?.blockers)
    && sourceAfter.drain.blockers.length === 0;
}

function gatewayRecoveryLifecycleOk(report)
{
    const lifecycle = report.lifecycle;
    if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle))
    {
        return false;
    }
    const sourceBefore = lifecycle.sourceBefore;
    if (!sourceBefore || sourceBefore.releaseId !== report.source.releaseId || sourceBefore.slot !== report.source.slot)
    {
        return false;
    }
    if (!Number.isSafeInteger(sourceBefore.generation) || sourceBefore.generation < 1)
    {
        return false;
    }
    if (sourceBefore.mode !== 'active' || sourceBefore.state !== 'active' || sourceBefore.canReceiveTraffic !== true)
    {
        return false;
    }
    if (report.action === 'restore-source')
    {
        const targetAfter = lifecycle.targetAfterActivation;
        return targetAfter === null
      || (targetAfter.releaseId === report.target.releaseId
        && targetAfter.slot === report.target.slot
        && Number.isSafeInteger(targetAfter.generation)
        && targetAfter.generation > 0
        && targetAfter.canReceiveTraffic === false
        && targetAfter.canClaimBackgroundWork === false);
    }
    const targetBefore = lifecycle.targetBefore;
    const targetAfter = lifecycle.targetAfterActivation;
    const sourceAfter = lifecycle.sourceAfterDrain;
    if (![targetBefore, targetAfter, sourceAfter].every((snapshot) =>
        snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      && Number.isSafeInteger(snapshot.generation) && snapshot.generation > 0))
    {
        return false;
    }
    return targetBefore.releaseId === report.target.releaseId
    && targetBefore.slot === report.target.slot
    && ((targetBefore.mode === 'candidate' && targetBefore.state === 'ready' && targetBefore.canReceiveTraffic === false)
      || (targetBefore.mode === 'active' && targetBefore.state === 'active' && targetBefore.canReceiveTraffic === true))
    && targetAfter.releaseId === report.target.releaseId
    && targetAfter.slot === report.target.slot
    && targetAfter.mode === 'active'
    && targetAfter.state === 'active'
    && targetAfter.canReceiveTraffic === true
    && sourceAfter.releaseId === report.source.releaseId
    && sourceAfter.slot === report.source.slot
    && sourceAfter.mode === 'draining'
    && sourceAfter.state === 'draining'
    && sourceAfter.canReceiveTraffic === false
    && sourceAfter.drain?.requested === true
    && sourceAfter.drain?.drained === true
    && sourceAfter.drain?.timedOut === false
    && Array.isArray(sourceAfter.drain?.blockers)
    && sourceAfter.drain.blockers.length === 0;
}

function releaseRolloutOk(manifest, context)
{
    try
    {
        return releaseRolloutOkUnsafe(manifest, context);
    }
    catch
    {
        return false;
    }
}

function releaseRolloutOkUnsafe(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'releaseRollout');
    const finalFile = artifactPath(manifest, context.manifestPath, 'releaseRollout');
    const bundle = artifactPath(manifest, context.manifestPath, 'releaseRolloutBundle');
    if (!report || report.schema !== 'fsusblog.release-rollout-evidence.v1' || report.status !== 'pass')
    {
        return false;
    }
    if (!finalFile || !bundle || !fs.statSync(bundle, { throwIfNoEntry: false })?.isDirectory())
    {
        return false;
    }
    if (!Array.isArray(report.errors) || report.errors.length !== 0)
    {
        return false;
    }
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(String(report.rolloutId ?? '')))
    {
        return false;
    }
    if (!['deploy', 'rollback'].includes(report.kind))
    {
        return false;
    }
    if (!gatewayReleaseIdentityOk(report.source) || !gatewayReleaseIdentityOk(report.target))
    {
        return false;
    }
    if (!Number.isSafeInteger(report.source.runtimeGeneration) || report.source.runtimeGeneration < 1)
    {
        return false;
    }
    if (!Number.isSafeInteger(report.target.runtimeGeneration) || report.target.runtimeGeneration < 1)
    {
        return false;
    }
    if (!Number.isSafeInteger(report.gatewayGeneration) || report.gatewayGeneration < 1)
    {
        return false;
    }
    if (report.source.slot === report.target.slot || report.source.releaseId === report.target.releaseId)
    {
        return false;
    }
    if (report.target.releaseId !== manifest.releaseIdentity?.releaseId
    || report.target.slot !== manifest.releaseIdentity?.releaseSlot
    || report.target.imageDigest !== manifest.releaseIdentity?.imageDigest)
    {
        return false;
    }
    if (report.rollback?.target?.releaseId !== report.source.releaseId
    || report.rollback?.target?.slot !== report.source.slot
    || typeof report.rollback?.allowed !== 'boolean'
    || typeof report.rollback?.contractMigrationApplied !== 'boolean')
    {
        return false;
    }
    if (report.rollback.contractMigrationApplied === report.rollback.allowed)
    {
        return false;
    }
    if (!Array.isArray(report.recoveries))
    {
        return false;
    }
    for (let index = 0; index < report.recoveries.length; index += 1)
    {
        const recovery = report.recoveries[index];
        if (!['ok', 'failed'].includes(recovery?.status) || !recovery?.evidence)
        {
            return false;
        }
        if (recovery.status === 'failed' && !report.recoveries.slice(index + 1).some(candidate => candidate?.status === 'ok'
      && candidate.action === recovery.action && candidate.failedStage === recovery.failedStage))
        {
            return false;
        }
        const localFile = path.join(bundle, 'recoveries', path.basename(String(recovery.evidence.path ?? '')));
        if (!metadataMatchesFile(recovery.evidence, localFile))
        {
            return false;
        }
    }
    if (!Array.isArray(report.stages) || report.stages.map(item => item?.stage).join('\n') !== requiredRolloutStages.join('\n'))
    {
        return false;
    }

    for (const stage of report.stages)
    {
        if (!Number.isSafeInteger(stage.attempts) || stage.attempts < 1)
        {
            return false;
        }
        const localFile = path.join(bundle, 'commands', path.basename(String(stage.evidence?.path ?? '')));
        if (!metadataMatchesFile(stage.evidence, localFile))
        {
            return false;
        }
        const stageReport = readJson(localFile);
        if (stageReport.schema !== 'fsusblog.release-rollout-stage-evidence.v1'
      || stageReport.rolloutId !== report.rolloutId
      || stageReport.stage !== stage.stage
      || stageReport.status !== 'ok'
      || stageReport.exitCode !== 0)
        {
            return false;
        }
        for (const stream of ['stdout', 'stderr'])
        {
            const output = stageReport.output?.[stream];
            if (output && !metadataMatchesFile(output, path.join(bundle, 'commands', path.basename(String(output.path ?? '')))))
            {
                return false;
            }
        }
        if (Array.isArray(stage.attemptEvidence))
        {
            if (stage.attemptEvidence.length !== stage.attempts)
            {
                return false;
            }
            for (const attempt of stage.attemptEvidence)
            {
                const attemptFile = path.join(bundle, 'commands', path.basename(String(attempt?.evidence?.path ?? '')));
                if (!metadataMatchesFile(attempt?.evidence, attemptFile))
                {
                    return false;
                }
                const attemptReport = readJson(attemptFile);
                if (attemptReport.schema !== 'fsusblog.release-rollout-stage-evidence.v1'
          || attemptReport.rolloutId !== report.rolloutId
          || attemptReport.stage !== stage.stage
          || attemptReport.status !== attempt.status)
                {
                    return false;
                }
                for (const stream of ['stdout', 'stderr'])
                {
                    const output = attemptReport.output?.[stream];
                    if (output && !metadataMatchesFile(output, path.join(bundle, 'commands', path.basename(String(output.path ?? '')))))
                    {
                        return false;
                    }
                }
            }
        }
    }

    for (const name of requiredRolloutArtifacts)
    {
        const metadata = report.artifacts?.[name];
        const localFile = path.join(bundle, 'artifacts', name, path.basename(String(metadata?.path ?? '')));
        if (!metadataMatchesFile(metadata, localFile))
        {
            return false;
        }
        const artifact = readJson(localFile);
        if (artifact.rolloutId !== report.rolloutId || !rolloutArtifactSemanticsOk(name, artifact))
        {
            return false;
        }
    }
    if (Object.keys(report.auxiliary ?? {}).join('\n') !== requiredRolloutAuxiliary.join('\n'))
    {
        return false;
    }
    for (const name of requiredRolloutAuxiliary)
    {
        const metadata = report.auxiliary?.[name];
        const localFile = path.join(bundle, 'auxiliary', name, path.basename(String(metadata?.path ?? '')));
        if (!metadataMatchesFile(metadata, localFile))
        {
            return false;
        }
        const auxiliary = readJson(localFile);
        if (!rolloutAuxiliarySemanticsOk(name, auxiliary, report))
        {
            return false;
        }
    }

    const recordedDigest = manifest.artifactDigests?.releaseRollout;
    if (recordedDigest?.algorithm !== 'sha256' || recordedDigest.value !== sha256Hex(finalFile))
    {
        return false;
    }
    const index = readJson(path.join(bundle, 'bundle-index.json'));
    if (index.schema !== 'fsusblog.release-rollout-collected-bundle.v1'
    || index.status !== 'ok'
    || index.rolloutId !== report.rolloutId)
    {
        return false;
    }
    if (index.sourceEvidenceSha256 !== `sha256:${recordedDigest.value}`
    || !Number.isSafeInteger(index.fileCount)
    || !Array.isArray(index.files)
    || index.files.length !== index.fileCount)
    {
        return false;
    }
    const indexedPaths = new Set();
    for (const item of index.files)
    {
        const relative = String(item?.path ?? '');
        if (relative.length === 0 || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..') || indexedPaths.has(relative))
        {
            return false;
        }
        indexedPaths.add(relative);
        if (!metadataMatchesFile(item, path.join(bundle, relative)))
        {
            return false;
        }
    }
    return indexedPaths.has('release-rollout.json')
    && `sha256:${sha256Hex(path.join(bundle, 'release-rollout.json'))}` === index.sourceEvidenceSha256;
}

function rolloutAuxiliarySemanticsOk(name, value, rollout)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    if (value.rolloutId !== undefined && value.rolloutId !== rollout.rolloutId)
    {
        return false;
    }
    if (value.target?.releaseId !== undefined && value.target.releaseId !== rollout.target.releaseId)
    {
        return false;
    }
    if (value.source?.releaseId !== undefined && value.source.releaseId !== rollout.source.releaseId)
    {
        return false;
    };
    if (Array.isArray(value.errors) && value.errors.length !== 0)
    {
        return false;
    };
    if (name === 'releaseManifest')
    {
        return value.schema === 'fsusblog.release-manifest.v3'
      && value.releaseId === rollout.target.releaseId
      && value.imageDigest === rollout.target.imageDigest;
    }
    if (name === 'operatorNote')
    {
        return value.schema === 'fsusblog.release-rollout-operator-note.v1'
      && value.rolloutId === rollout.rolloutId
      && typeof value.provided === 'boolean'
      && typeof value.note === 'string'
      && value.note.length <= 4000;
    }
    return value.status === undefined || ['pass', 'ok', 'healthy', 'completed', 'dry-run'].includes(value.status);
}

function rolloutArtifactSemanticsOk(name, value)
{
    if (!value || typeof value !== 'object' || Array.isArray(value) || !['pass', 'ok', 'completed'].includes(value.status))
    {
        return false;
    }
    if (name === 'publicTraffic')
    {
        return rolloutPublicTrafficSemanticsOk(value);
    }
    if (name === 'notificationStream')
    {
        const resync = Object.values(value.resync ?? {}).flatMap(items => Array.isArray(items) ? items : []);
        const resyncPhaseOk = (phase) =>
        {
            const observations = resync.filter(item => item?.phase === phase && item?.status === 'pass');
            return observations.length >= 2 && observations.every(item => Number.isSafeInteger(item.watermark)
        && /^sha256:[0-9a-f]{64}$/u.test(String(item.contentSha256 ?? '')));
        };
        return value.contractVersion === 2
      && zeroFields(value, ['missingEventCount', 'duplicateAppliedEventCount', 'duplicateBusinessEventCount'])
      && value.serviceRestartObserved === true
      && value.cursorReplayVerified === true
      && value.replayMissFullResyncVerified === true
      && value.businessEventsExactlyOnce === true
      && value.slowClientDidNotBlockDrain === true
      && /^sha256:[0-9a-f]{64}$/u.test(String(value.inputBindings?.resyncScenario?.sha256 ?? ''))
      && resyncPhaseOk('replay-miss')
      && resyncPhaseOk('final');
    }
    if (name === 'assetCompatibility')
    {
        return zeroFields(value, ['notFoundCount', 'hashMismatchCount', 'connectionErrorCount'])
      && ['delayedOldAssets', 'oldFrontendToNewBackend', 'newFrontendToOldBackend', 'oldServiceWorkerCache', 'retentionWindowAfterGc']
          .every(scenario => value.scenarios?.[scenario] === 'pass')
      && rolloutAssetCompatibilitySemanticsOk(value);
    }
    if (name === 'workerReconciliation')
    {
        return value.schema === 'fsusblog.release-worker-reconciliation-evidence.v2'
      && value.mode === 'normal'
      && zeroFields(value, ['duplicateEffectCount', 'staleGenerationCommitCount', 'lostAuditCount', 'lostVisitProjectionCount'])
      && (value.buffersDrained === true || value.durableReplayVerified === true)
      && value.gracefulDrainVerified === true
      && value.forcedSourceRecoveryRequired === false
      && value.forcedSourceRecoveryVerified === false
      && Object.values(value.checks ?? {}).length > 0
      && Object.values(value.checks).every(check => check === true);
    }
    if (name === 'resourceBudget')
    {
        return value.withinBudget === true
      && Number(value.minimumSupported?.cpuCores) > 0
      && Number(value.minimumSupported?.memoryMiB) > 0
      && Object.values(value.checks ?? {}).every(check => check === true);
    }
    if (name === 'faultInjection')
    {
        const cases = Array.isArray(value.cases) ? value.cases : [];
        return [
            'manifest-digest-mismatch', 'capacity-insufficient', 'expand-failure', 'candidate-readiness',
            'asset-hash-mismatch', 'gateway-reload-failure', 'active-fence-failure', 'public-probe-failure',
            'drain-timeout', 'source-stop-failure', 'host-interruption', 'redis-disconnect', 'postgres-disconnect'
        ].every(caseName => cases.some(item => item?.case === caseName && item.status === 'pass' && item.automated === true));
    }
    return false;
}

function rolloutAssetCompatibilitySemanticsOk(value)
{
    const browser = value.browser;
    if (browser?.schema !== 'fsusblog.release-asset-browser-evidence.v1'
    || browser?.status !== 'pass'
    || typeof browser.browser?.name !== 'string'
    || browser.browser.name.length === 0
    || typeof browser.browser?.version !== 'string'
    || browser.browser.version.length === 0
    || typeof browser.browser?.executablePath !== 'string'
    || !path.isAbsolute(browser.browser.executablePath)
    || !/^sha256:[0-9a-f]{64}$/u.test(String(browser.browser?.executableSha256 ?? '')))
    {
        return false;
    }
    if (browser.bindings?.rolloutId !== value.rolloutId
    || browser.bindings?.sourceReleaseId !== value.sourceReleaseId
    || browser.bindings?.targetReleaseId !== value.targetReleaseId
    || !/^sha256:[0-9a-f]{64}$/u.test(String(browser.bindings?.scenarioSha256 ?? ''))
    || !/^sha256:[0-9a-f]{64}$/u.test(String(browser.bindings?.manifestSha256 ?? ''))
    || !/^sha256:[0-9a-f]{64}$/u.test(String(browser.bindings?.gcEvidenceSha256 ?? '')))
    {
        return false;
    }
    if (browser.beforeSwitch?.status !== 'pass'
    || browser.beforeSwitch?.serviceWorker?.controller?.state !== 'activated')
    {
        return false;
    }
    const delayed = Array.isArray(browser.delayed?.resources) ? browser.delayed.resources : [];
    if (!['javascript', 'stylesheet', 'wasm', 'font']
        .every(kind => delayed.some(resource => resource?.kind === kind && resource?.hashMatches === true)))
    {
        return false;
    }
    if (browser.afterSwitch?.status !== 'pass'
    || browser.compatibility?.oldFrontendToNewBackend?.status !== 'pass'
    || browser.compatibility?.newFrontendToOldBackend?.status !== 'pass')
    {
        return false;
    }
    const cacheReads = Array.isArray(browser.afterGc?.cacheReads) ? browser.afterGc.cacheReads : [];
    if (browser.afterGc?.status !== 'pass' || cacheReads.length === 0
    || cacheReads.some(read => read?.cacheHit !== true || read?.hashMatches === false))
    {
        return false;
    }
    if (!Array.isArray(browser.pageErrors) || browser.pageErrors.length !== 0
    || !Array.isArray(browser.network?.failures))
    {
        return false;
    }
    const binding = value.browserBinding;
    const { browserBinding: ignored, ...unsignedValue } = value;
    void ignored;
    return binding?.schema === 'fsusblog.release-asset-browser-binding.v1'
    && binding?.algorithm === 'hmac-sha256'
    && /^hmac-sha256:[0-9a-f]{64}$/u.test(String(binding?.keyId ?? ''))
    && /^hmac-sha256:[0-9a-f]{64}$/u.test(String(binding?.signature ?? ''))
    && binding?.rolloutId === value.rolloutId
    && binding?.sourceReleaseId === value.sourceReleaseId
    && binding?.targetReleaseId === value.targetReleaseId
    && binding?.browserName === browser.browser?.name
    && binding?.browserVersion === browser.browser?.version
    && binding?.browserExecutablePath === browser.browser?.executablePath
    && binding?.browserExecutableSha256 === browser.browser?.executableSha256
    && binding?.scenarioSha256 === browser.bindings?.scenarioSha256
    && binding?.manifestSha256 === browser.bindings?.manifestSha256
    && binding?.gcEvidenceSha256 === browser.bindings?.gcEvidenceSha256
    && binding?.payloadSha256 === sha256Value(canonicalJson(unsignedValue));
}

function rolloutPublicTrafficSemanticsOk(value)
{
    if (!(Number(value.totalRequests) > 0)
    || !(Number(value.releaseDistribution?.source) > 0)
    || !(Number(value.releaseDistribution?.target) > 0)
    || !zeroFields(value, [
        'unexpectedResponseCount', 'deploymentFailureCount', 'connectionErrorCount',
        'gatewayErrorCount', 'unhandled5xxCount', 'inFlightAbortedCount', 'inFlightRequestCount'
    ]))
    {
        return false;
    }
    if (value.probeMode !== 'public-rollout'
    || value.releaseIdentityPolicy?.required !== true
    || value.releaseIdentityPolicy?.scenarioRequired !== true
    || value.releaseIdentityPolicy?.mode !== 'public-rollout'
    || Number(value.releaseIdentityPolicy?.violationCount) !== 0)
    {
        return false;
    }
    const expectedCoverage = requiredTrafficPolicyStages.flatMap(stage => requiredTrafficCategories.map(category => `${stage}/${category}`)).sort();
    const coverage = value.releaseIdentityPolicy?.coverage;
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage))
    {
        return false;
    }
    const coverageKeys = Object.keys(coverage).sort();
    if (coverageKeys.join('\n') !== expectedCoverage.join('\n')
    || coverageKeys.some(key => !Number.isSafeInteger(coverage[key]) || coverage[key] < 0))
    {
        return false;
    }
    if (!Array.isArray(value.requiredCategories)
    || value.requiredCategories.join('\n') !== requiredTrafficCategories.join('\n'))
    {
        return false;
    }
    const sessions = value.sessionChains && typeof value.sessionChains === 'object' && !Array.isArray(value.sessionChains)
        ? Object.values(value.sessionChains)
        : [];
    if (sessions.length === 0 || sessions.some(session => !(Number(session.completedCycles) > 0) || Number(session.failedCycles) !== 0))
    {
        return false;
    }
    const holds = value.gatewaySwitchHolds && typeof value.gatewaySwitchHolds === 'object' && !Array.isArray(value.gatewaySwitchHolds)
        ? Object.values(value.gatewaySwitchHolds)
        : [];
    if (holds.length === 0 || holds.some(hold => hold.required !== true
    || !(Number(hold.attempts) > 0)
    || !(Number(hold.passCount) > 0)
    || Number(hold.failCount) !== 0
    || !Array.isArray(hold.observations)
    || !hold.observations.some(observation => observation?.pass === true
      && observation?.startedAt?.switchCommitted === false
      && observation?.completedAt?.switchCommitted === true
      && observation?.releaseRole === 'target'
      && /^sha256:[0-9a-f]{64}$/u.test(String(observation?.bindingSha256 ?? '')))))
    {
        return false;
    }
    const observation = value.observationBinding;
    const digests = Array.isArray(observation?.observationSha256) ? observation.observationSha256 : [];
    if (observation?.schema !== 'fsusblog.release-traffic-observation-chain.v1'
    || observation?.algorithm !== 'sha256-chain'
    || !(Number(observation?.observationCount) > 0)
    || observation.observationCount !== digests.length
    || digests.some(digest => !/^sha256:[0-9a-f]{64}$/u.test(String(digest))))
    {
        return false;
    }
    let chainHead = sha256Value('fsusblog.release-traffic-observation-chain.v1');
    for (const digest of digests)
    {
        chainHead = sha256Value(`${chainHead}\0${digest}`);
    }
    if (chainHead !== observation.chainHeadSha256)
    {
        return false;
    }
    const responses = Array.isArray(value.responseObservations) ? value.responseObservations : [];
    if (!responses.some(record => record?.category === 'binary'
    && Array.isArray(record?.lastObservation?.aeds?.checks)
    && record.lastObservation.aeds.checks.length >= 7
    && record.lastObservation.aeds.checks.every(check => check?.pass === true)))
    {
        return false;
    }
    const binding = value.finalBinding;
    const { finalBinding: ignored, ...unsignedValue } = value;
    void ignored;
    return binding?.schema === 'fsusblog.release-traffic-final-binding.v1'
    && binding?.algorithm === 'hmac-sha256'
    && /^hmac-sha256:[0-9a-f]{64}$/u.test(String(binding?.keyId ?? ''))
    && /^hmac-sha256:[0-9a-f]{64}$/u.test(String(binding?.signature ?? ''))
    && binding?.rolloutId === value.rolloutId
    && binding?.scenarioSha256 === observation?.scenarioSha256
    && binding?.initialRolloutStateSha256 === observation?.initialRolloutStateSha256
    && /^sha256:[0-9a-f]{64}$/u.test(String(binding?.finalRolloutStateSha256 ?? ''))
    && binding?.observationCount === observation?.observationCount
    && binding?.observationHashChain === observation?.chainHeadSha256
    && binding?.payloadSha256 === sha256Value(canonicalJson(unsignedValue));
}

function metadataMatchesFile(metadata, file)
{
    if (!metadata || !/^sha256:[0-9a-f]{64}$/u.test(String(metadata.sha256 ?? '')))
    {
        return false;
    }
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    return stat?.isFile() === true
    && !stat.isSymbolicLink()
    && stat.size === metadata.bytes
    && `sha256:${sha256Hex(file)}` === metadata.sha256;
}

function sha256Hex(file)
{
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Value(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value)
{
    if (value === undefined)
    {
        return 'null';
    }
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(item => canonicalJson(item)).join(',')}]`;
    }
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function zeroFields(value, fields)
{
    return fields.every(field => Number(value[field]) === 0);
}

function lifecycleFixture({ source, target })
{
    const snapshot = (identity, mode, state, active, drain = {}) => ({
        releaseId: identity.releaseId,
        slot: identity.slot,
        mode,
        state,
        generation: identity.generation,
        canReceiveTraffic: active,
        canClaimBackgroundWork: active,
        canAcceptNotificationStream: active,
        inFlightHttpRequests: 0,
        notificationStreamConnections: 0,
        activeBackgroundClaims: 0,
        drain: {
            requested: false,
            drained: false,
            timedOut: false,
            blockers: [],
            ...drain
        }
    });
    return {
        sourceBefore: snapshot(source, 'active', 'active', true),
        targetBefore: snapshot(target, 'candidate', 'ready', false),
        targetAfterActivation: snapshot(target, 'active', 'active', true),
        sourceAfterDrain: snapshot(source, 'draining', 'draining', false, { requested: true, drained: true })
    };
}

function allTrue(value, keys)
{
    return value && typeof value === 'object' && !Array.isArray(value) && keys.every((key) => value[key] === true);
}

function isIsoUtc(value)
{
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(String(value ?? ''))
    && Number.isFinite(Date.parse(value));
}

function releaseEvidenceModelErrors(manifest, options, context)
{
    const errors = [];
    const isV2 = manifest.schema === 'fsusblog.release-evidence-manifest.v2';
    if (options.requireOk && !isV2)
    {
        errors.push('release closeout requires fsusblog.release-evidence-manifest.v2');
        return errors;
    }
    if (!isV2)
    {
        return errors;
    }

    const expectedClass = options.requireOk || manifest.evidenceClass === 'release-closeout-evidence'
        ? 'release-closeout-evidence'
        : 'fresh-run-evidence';
    for (const error of evidenceClassificationErrors(manifest, expectedClass))
    {
        errors.push(`evidence classification: ${error}`);
    }
    if (!isIsoUtc(manifest.generatedAt))
    {
        errors.push('generatedAt must be an ISO UTC timestamp');
    }
    if (!/^[a-z][a-z0-9-]{1,31}$/u.test(String(manifest.targetEnvironment ?? '')))
    {
        errors.push('targetEnvironment must explicitly identify the release environment');
    }
    if (manifest.status === 'collected-blocked' && manifest.evidenceClass !== 'fresh-run-evidence')
    {
        errors.push('collected-blocked manifest cannot claim release-closeout-evidence');
    }
    if (manifest.releaseId !== (manifest.releaseIdentity?.releaseId ?? null))
    {
        errors.push('releaseId must match releaseIdentity.releaseId');
    }
    let canonicalIdentity = false;
    try
    {
        assertReleaseIdentity({
            releaseId: manifest.releaseId,
            createdAtUtc: manifest.releaseIdentity?.createdAtUtc,
            commitSha: manifest.commitSha
        });
        canonicalIdentity = true;
    }
    catch
    {
        void canonicalIdentity;
    }
    const identityMatches = canonicalIdentity
    && /^sha256:[0-9a-f]{64}$/u.test(String(manifest.imageDigest ?? ''))
    && manifest.releaseIdentity?.commitSha === manifest.commitSha
    && manifest.releaseIdentity?.imageDigest === manifest.imageDigest;
    if (manifest.releaseBound !== identityMatches)
    {
        errors.push('releaseBound must exactly reflect release ID, commit SHA, and image digest agreement');
    }
    if (identityMatches
    && (manifest.targetTopology?.releaseSlot !== manifest.releaseIdentity?.releaseSlot
      || manifest.targetTopology?.runtimeProfileId !== manifest.releaseIdentity?.runtimeProfile?.id))
    {
        errors.push('targetTopology must match the release slot and selected runtime profile');
    }
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{5,191}$/u.test(String(manifest.releaseNamespace ?? '')))
    {
        errors.push('releaseNamespace must be a safe immutable identity namespace');
    }
    const expectedNamespace = identityMatches
        ? `${manifest.releaseId}--${manifest.imageDigest.slice('sha256:'.length, 'sha256:'.length + 12)}`
        : null;
    if (expectedNamespace && manifest.releaseNamespace !== expectedNamespace)
    {
        errors.push('releaseNamespace must bind canonical release ID and image digest without duplicating commitSha12');
    }

    const storage = manifest.storage;
    if (storage?.schema !== 'fsusblog.release-evidence-storage-binding.v1'
    || storage.authority !== 'github-actions-artifact'
    || storage.contractPath !== 'security/evidence-contracts/release-bundle-storage.json'
    || storage.workflow !== '.github/workflows/release-evidence-storage.yml'
    || storage.immutable !== true
    || storage.overwriteAllowed !== false
    || storage.publicationState !== 'pending-immutable-upload')
    {
        errors.push('storage binding must use the immutable GitHub Actions artifact authority');
    }
    if (storage?.retention?.days !== 90
    || typeof storage.retention?.deletionPolicy !== 'string'
    || typeof storage.retention?.legalHoldPolicy !== 'string'
    || typeof storage.retention?.auditHoldPolicy !== 'string'
    || typeof storage.retention?.rollbackReferencePolicy !== 'string')
    {
        errors.push('storage binding must include the complete retention and hold contract');
    }
    if (identityMatches)
    {
        const expectedArtifactName = `fsusblog-release-evidence-${manifest.releaseId}`;
        if (storage?.artifactName !== expectedArtifactName)
        {
            errors.push('storage artifact name must bind the canonical release ID without duplicating commitSha12');
        }
    }
    if (options.requireOk || manifest.evidenceClass === 'release-closeout-evidence')
    {
        if (!/^\d+$/u.test(String(manifest.workflowRun?.id ?? ''))
      || !/^\d+$/u.test(String(manifest.workflowRun?.attempt ?? ''))
      || typeof manifest.workflowRun?.workflow !== 'string'
      || manifest.workflowRun.workflow.trim() === '')
        {
            errors.push('release closeout requires workflow run, attempt, and workflow identity');
        }
        if (String(storage?.workflowRunId ?? '') !== String(manifest.workflowRun?.id ?? ''))
        {
            errors.push('storage workflow run must match manifest workflowRun.id');
        }
        if (!/^\d+$/u.test(String(storage?.workflowRunId ?? '')))
        {
            errors.push('release closeout storage requires a numeric workflow run id');
        }
        if (!/^fsusblog-release-evidence-\d{14}-[0-9a-f]{12}$/u.test(String(storage?.artifactName ?? '')))
        {
            errors.push('release closeout storage requires an identity-bound artifact name');
        }
        if (!/^github-actions:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\/artifacts\/[A-Za-z0-9_.-]+$/u.test(String(storage?.storageReference ?? '')))
        {
            errors.push('release closeout storage requires an immutable workflow-run storage reference');
        }
        else if (!String(storage.storageReference).endsWith(`/artifacts/${storage.artifactName}`))
        {
            errors.push('release closeout storage reference must name the identity-bound artifact');
        }
    }

    if (!context.manifestPath)
    {
        errors.push('artifact inventory validation requires the manifest path');
        return errors;
    }
    errors.push(...artifactInventoryErrors(manifest, context.manifestPath));
    return errors;
}

function artifactInventoryErrors(manifest, manifestPath)
{
    const errors = [];
    const directory = path.dirname(manifestPath);
    const inventory = manifest.artifactInventory;
    if (inventory?.schema !== 'fsusblog.release-evidence-artifact-inventory.v1'
    || inventory.algorithm !== 'sha256'
    || !Array.isArray(inventory.files))
    {
        return ['artifactInventory must be a SHA-256 file inventory'];
    }

    const actual = [];
    const visit = (relativeDirectory = '') =>
    {
        for (const entry of fs.readdirSync(path.join(directory, relativeDirectory), { withFileTypes: true }))
        {
            const relative = path.join(relativeDirectory, entry.name).replaceAll('\\', '/');
            if (relative === 'manifest.json' || relative === 'release-index.json')
            {
                continue;
            }
            const absolute = path.join(directory, relative);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink())
            {
                errors.push(`artifact inventory rejects symbolic link: ${relative}`);
            }
            else if (stat.isDirectory())
            {
                visit(relative);
            }
            else if (stat.isFile())
            {
                actual.push({
                    path: relative,
                    bytes: stat.size,
                    sha256: `sha256:${sha256Hex(absolute)}`
                });
            }
            else
            {
                errors.push(`artifact inventory rejects unsupported entry: ${relative}`);
            }
        }
    };
    visit();
    actual.sort((left, right) => left.path.localeCompare(right.path));
    if (JSON.stringify(inventory.files) !== JSON.stringify(actual))
    {
        errors.push('artifactInventory.files must exactly seal every copied bundle artifact');
    }
    if (inventory.fileCount !== actual.length)
    {
        errors.push('artifactInventory.fileCount mismatch');
    }
    const totalBytes = actual.reduce((total, file) => total + file.bytes, 0);
    if (inventory.totalBytes !== totalBytes)
    {
        errors.push('artifactInventory.totalBytes mismatch');
    }
    if (inventory.artifactSetSha256 !== sha256Value(canonicalJson(actual)))
    {
        errors.push('artifactInventory.artifactSetSha256 mismatch');
    }
    return errors;
}

function containsSensitiveFieldName(value)
{
    if (Array.isArray(value))
    {
        return value.some(containsSensitiveFieldName);
    }
    if (!value || typeof value !== 'object')
    {
        return false;
    }
    return Object.entries(value).some(([key, nested]) =>
        /(?:password|passwd|token|privatekey|secret|credential)$/iu.test(key) || containsSensitiveFieldName(nested));
}

function backupRestoreDrillOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'backupRestoreDrill');
    return report?.status === 'ok'
    && report.mode === 'real'
    && report.timings?.rpoSeconds !== null
    && report.timings?.rtoSeconds !== null
    && includesAll(report.checks, [
        'postgres-restore:ok',
        'redis-restore:ok',
        'webroot-artifact-restore:ok',
        'restored-backend-start:ok',
        'public-page:ok',
        'binary-api:ok',
        'search-index:ok',
        'notification-stream-live:ok',
        'admin-login:ok'
    ]);
}

function postDeploySmokeOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'postDeploySmoke');
    return report?.status === 'ok'
    && report.dryRun === false
    && Array.isArray(report.blockers)
    && report.blockers.length === 0
    && includesAll(report.verifiedCoverage, [
        'anonymous-public',
        'feed-rss',
        'feed-atom',
        'feed-json',
        'sitemap',
        'robots',
        'health-live',
        'health-ready'
    ]);
}

function authenticatedDastOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'authenticatedDast', 'summary.json');
    const contexts = ['anonymous', 'user', 'admin', 'author-console'];
    return report?.schema === 'fsusblog.security.authenticated-dast.v1'
    && report.status === 'ok'
    && report.executionSource === 'fresh-current-lane'
    && report.fixture?.executionSource === 'fresh-current-lane'
    && report.fixture?.historicalStateAccepted === false
    && report.fixture?.cleanup === 'success'
    && report.targetPolicy?.loopbackOnly === true
    && report.targetPolicy?.productionTargetAllowed === false
    && report.activeScan?.executed === true
    && Number.isInteger(report.activeScan?.requestCount)
    && report.activeScan.requestCount > 0
    && report.activeScan?.failedCount === 0
    && report.activeScan?.passedCount === report.activeScan.requestCount
    && contexts.every((name) => report.contexts?.[name]?.executed === true
      && Number.isInteger(report.contexts[name].requestCount)
      && report.contexts[name].requestCount > 0
      && report.contexts[name].failedCount === 0)
    && Array.isArray(report.checks)
    && report.checks.length === report.activeScan.requestCount
    && report.checks.every((check) => check?.passed === true);
}

function localRuntimeExposureOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'localRuntimeExposure');
    const targetIds = Array.isArray(report?.targets) ? report.targets.map((item) => item?.id).sort() : [];
    const serviceIds = Array.isArray(report?.restrictedServices) ? report.restrictedServices.map((item) => item?.id).sort() : [];
    return report?.schema === 'fsusblog.security.local-runtime-exposure.v1'
    && report.status === 'ok'
    && report.executionSource === 'fresh-loopback-runtime'
    && report.scope?.loopbackRuntimeOnly === true
    && report.scope?.externalProductionDnsChecked === false
    && report.scope?.externalFirewallEvidenceChecked === false
    && report.scope?.countsAsProductionCloseout === false
    && Array.isArray(report.failures)
    && report.failures.length === 0
    && JSON.stringify(targetIds) === JSON.stringify(['backend', 'frontend', 'release-preview'])
    && report.targets.every((item) => Number.isInteger(item?.status) && item.status < 500)
    && Array.isArray(report.listeners)
    && report.listeners.length === 3
    && report.listeners.every((item) => Array.isArray(item?.addresses) && item.addresses.length > 0)
    && JSON.stringify(serviceIds) === JSON.stringify(['postgres', 'redis'])
    && report.restrictedServices.every((item) => item?.loopbackOnly === true);
}

function wasmFuzzOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'fuzz', 'wasm/summary.json');
    const seedPlan = Array.isArray(report?.seedPlan) ? report.seedPlan : [];
    const seedsRun = Number(report?.seedsRun ?? 0);
    return report?.status === 'ok'
    && report.executionSource === 'fresh-wasm-runtime'
    && Number.isInteger(seedsRun)
    && seedsRun > 0
    && seedPlan.length > 0
    && seedPlan.every((item) => typeof item?.corpus === 'string'
      && item.corpus.length > 0
      && Number.isInteger(item.count)
      && item.count > 0
      && Number.isInteger(item.firstSeed))
    && seedPlan.reduce((total, item) => total + item.count, 0) === seedsRun
    && /^[a-f0-9]{64}$/u.test(report.decoder?.sha256 ?? '')
    && Array.isArray(report.crashes)
    && report.crashes.length === 0;
}

function faultInjectionOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'faultInjection', 'summary.json');
    return report?.status === 'ok'
    && Number(report.caseCount ?? 0) > 0
    && Array.isArray(report.cases)
    && includesAll(report.cases.map((item) => item.case), requiredRedisFaultCases)
    && includesAll(report.cases.map((item) => item.case), requiredPostgresFaultCases)
    && includesAll(report.cases.map((item) => item.case), requiredNotificationFaultCases)
    && includesAll(report.cases.map((item) => item.case), requiredGracefulShutdownFaultCases)
    && includesAll(report.cases.map((item) => item.case), requiredDiskArtifactFaultCases)
    && report.cases.every((item) => item.status === 'completed' && item.actionStatus === 'executed')
    && report.cases
        .filter((item) => requiredRedisFaultCases.includes(item.case))
        .every(redisFaultCaseOk)
    && report.cases
        .filter((item) => requiredPostgresFaultCases.includes(item.case))
        .every(postgresFaultCaseOk)
    && report.cases
        .filter((item) => requiredNotificationFaultCases.includes(item.case))
        .every(notificationFaultCaseOk)
    && report.cases
        .filter((item) => requiredGracefulShutdownFaultCases.includes(item.case))
        .every(gracefulShutdownFaultCaseOk)
    && report.cases
        .filter((item) => requiredDiskArtifactFaultCases.includes(item.case))
        .every(diskArtifactFaultCaseOk);
}

function redisFaultCaseOk(item)
{
    return typeof item.actionStartedAt === 'string'
    && item.actionStartedAt.length > 0
    && typeof item.actionCompletedAt === 'string'
    && item.actionCompletedAt.length > 0
    && Number(item.unavailableDurationMs ?? -1) >= 0
    && Number(item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && item.publicReadResult?.status === 'completed'
    && Number(item.publicReadResult?.sampleCount ?? 0) > 0
    && item.finalHealthStatus === 'healthy'
    && typeof item.authenticatedImpact?.status === 'string'
    && typeof item.notificationStreamImpact?.status === 'string';
}

function postgresFaultCaseOk(item)
{
    return typeof item.actionStartedAt === 'string'
    && item.actionStartedAt.length > 0
    && typeof item.actionCompletedAt === 'string'
    && item.actionCompletedAt.length > 0
    && typeof item.affectedEndpoint === 'string'
    && item.affectedEndpoint.length > 0
    && Number(item.unavailableDurationMs ?? -1) >= 0
    && Number(item.dbReconnectDurationMs ?? item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && item.publicReadRecoveryResult?.status === 'completed'
    && Number(item.publicReadRecoveryResult?.sampleCount ?? 0) > 0
    && typeof item.writePathRollbackResult?.status === 'string'
    && !['failed', 'scheduled', 'observed-only'].includes(item.writePathRollbackResult.status)
    && item.finalHealthStatus === 'healthy';
}

function notificationFaultCaseOk(item)
{
    return Number(item.connectionCount ?? 0) > 0
    && Number(item.heartbeatFrameCount ?? 0) > 0
    && Number(item.businessFrameCount ?? 0) > 0
    && Number(item.deliveredFrameCount ?? 0) > 0
    && Number(item.droppedOrBackpressuredCount ?? 0) > 0
    && item.reconnectSuccess === true
    && Number(item.replayedEventCount ?? 0) > 0
    && item.closeObserved === true
    && Array.isArray(item.eventIds)
    && item.eventIds.length > 0
    && item.eventIds.every((eventId) => Number(eventId) > 0)
    && typeof item.routeKey === 'string'
    && item.routeKey.length > 0
    && typeof item.slowConsumerPolicy === 'string'
    && item.slowConsumerPolicy.length > 0
    && item.finalHealthStatus === 'healthy';
}

function gracefulShutdownFaultCaseOk(item)
{
    return typeof item.shutdownRequestedAt === 'string'
    && item.shutdownRequestedAt.length > 0
    && item.processStopResult?.status === 'stopped'
    && Number(item.drainDurationMs ?? item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && Number(item.restartRecoveryDurationMs ?? item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && item.livenessBefore?.status === 'completed'
    && item.livenessDuringShutdown?.status === 'unavailable'
    && item.notificationCloseObserved === true
    && Number.isFinite(Number(item.notificationCloseCode))
    && item.notificationReconnectSuccess === true
    && item.publicReadRecoveryResult?.status === 'completed'
    && Number(item.publicReadRecoveryResult?.sampleCount ?? 0) > 0
    && item.basicAuthRecoveryResult?.status === 'completed'
    && Number(item.basicAuthRecoveryResult?.sampleCount ?? 0) > 0
    && item.backgroundWorkerState?.status === 'clean'
    && item.finalHealthStatus === 'healthy';
}

function diskArtifactFaultCaseOk(item)
{
    return typeof item.targetPath === 'string'
    && item.targetPath.length > 0
    && typeof item.expectedErrorClassification === 'string'
    && item.expectedErrorClassification.length > 0
    && item.writeFailureResult?.status === 'expected-error'
    && item.recoveryResult?.status === 'completed'
    && item.cleanupResult?.status === 'completed'
    && Number(item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && item.finalHealthStatus === 'healthy';
}

function shortSoakOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'soak', 'short/summary.json');
    return report?.status === 'ok'
    && report.mode === 'short'
    && report.executionMode === 'runtime'
    && report.countsAsReleaseFinal === true
    && Number(report.durationSeconds ?? 0) > 0
    && Number(report.sampleCount ?? 0) > 0
    && Number(report.latencyMs?.p95 ?? 0) > 0
    && Number(report.latencyMs?.p99 ?? 0) > 0
    && Number.isFinite(report.errorRate)
    && Number(report.errorRate) >= 0
    && soakResourceEvidenceOk(report);
}

function soakResourceEvidenceOk(report)
{
    const resourceSummary = report?.resourceMetricSummary;
    if (!resourceSummary || typeof resourceSummary !== 'object')
    {
        return false;
    }
    const metrics = Array.isArray(resourceSummary.metrics) ? resourceSummary.metrics : [];
    const unavailable = Array.isArray(resourceSummary.unavailableMetrics) ? resourceSummary.unavailableMetrics : [];
    const metricOk = metrics.some((metric) =>
        typeof metric?.name === 'string'
      && metric.name.length > 0
      && Number.isFinite(metric.startValue)
      && Number.isFinite(metric.endValue)
      && Number.isFinite(metric.maxValue)
      && Number.isFinite(metric.delta));
    const unavailableOk = unavailable.some((metric) =>
        typeof metric?.reason === 'string'
      && metric.reason.length > 0);
    return metricOk || unavailableOk;
}

function releaseResourceSummaryOk(manifest, context, artifactKey)
{
    const report = readArtifactJson(manifest, context, artifactKey);
    const metrics = Array.isArray(report?.metrics) ? report.metrics : [];
    return report?.status === 'ok'
    && metrics.length > 0
    && metrics.some((metric) => metric?.status === 'ok')
    && metrics.every((metric) =>
        typeof metric?.name === 'string'
        && metric.name.length > 0
        && Number.isFinite(metric.startValue)
        && Number.isFinite(metric.endValue)
        && Number.isFinite(metric.maxValue)
        && Number.isFinite(metric.delta)
        && Number.isFinite(metric.threshold)
        && metric.status === 'ok'
        && metric.thresholdOperator === '<='
        && metric.thresholdField === 'delta'
        && metric.delta <= metric.threshold);
}

function publicHydrationSidecarOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'publicHydrationSidecarSummary');
    const requiredKinds = ['Home', 'ArticleDetail', 'Archive', 'Filter', 'About', 'Privacy', 'Guidelines', 'Copyright'];
    return report?.schema === 'fsusblog.public-hydration-sidecar-smoke.v1'
    && report.status === 'success'
    && includesAll(report.requiredPageKinds, requiredKinds)
    && Array.isArray(report.missingRequiredKinds)
    && report.missingRequiredKinds.length === 0
    && Number(report.modeCounts?.['sidecar-primary'] ?? 0) >= requiredKinds.length
    && Object.hasOwn(report.modeCounts ?? {}, 'inline-fallback')
    && report.canary?.status === 'success'
    && Array.isArray(report.checks)
    && requiredKinds.every((kind) => report.checks.some((check) =>
        check.status === 'success'
        && check.expectedPageKind === kind
        && check.pageKind === kind
        && check.mode === 'sidecar-primary'));
}

function uxViewportSummaryOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'uxViewportSummary');
    const mode = report?.latestMode;
    return report?.status === 'ok'
    && ['smoke', 'visual', 'boundaries'].includes(mode)
    && typeof report.planFingerprint === 'string'
    && report.planFingerprint.length > 0
    && Number(report.plannedCaseCount) > 0
    && report.completedCaseCount === report.plannedCaseCount
    && Number(report.plannedNavigationCount) > 0
    && report.completedNavigationCount === report.plannedNavigationCount
    && Number(report.completedRouteThemeGroupCount) > 0
    && report.failedRouteThemeGroupCount === 0
    && typeof report.artifacts?.[mode] === 'string';
}

void uxViewportSummaryOk;

function frontendRenderStructureOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'frontendRenderStructureSummary');
    return report?.schema === 'fsusblog.frontend-render-structure.v1'
    && report.status === 'ok'
    && report.evidenceClass === 'correctness'
    && report.affectsCorrectness === true
    && report.executionBoundary === 'browserless-static-analysis'
    && ['dom-depth-static', 'markdown-render-budget'].every((check) => report.checks?.includes(check));
}

function publicAotCacheResilienceOk(manifest, context)
{
    const report = readArtifactJson(manifest, context, 'aotCacheResilienceSummary');
    const requiredCases = [
        'corrupt-document',
        'invalid-document-bytes',
        'missing-sidecar',
        'corrupt-sidecar',
        'old-asset-version',
        'html-payload-mismatch',
        'sw-stale-cache-poisoning'
    ];

    if (report?.schema !== 'fsusblog.public-aot-cache-resilience.v1' ||
    report.status !== 'success' ||
    report.placeholderOnly === true ||
    !Array.isArray(report.cases) ||
    !includesAll(report.cases.map((item) => item?.name), requiredCases))
    {
        return false;
    }

    return report.cases.every((item) => item?.status === 'success'
    && typeof item.route === 'string'
    && item.route.length > 0
    && typeof item.initialState === 'string'
    && typeof item.mutation === 'string'
    && item.mutation.length > 0
    && typeof item.observedState === 'string'
    && item.mutationVerified === true
    && item.recovered === true
    && Number(item.durationMs ?? -1) >= 0
    && Array.isArray(item.errors)
    && item.errors.length === 0);
}

function validateManifest(manifest, options = {})
{
    const context = { manifestPath: options.manifestPath ?? null };
    const errors = [];
    if (options.requireOk || manifest.artifacts?.cleanAttemptCohort)
    {
        try
        {
            verifyCleanAttemptCohortManifest(manifest, context.manifestPath, rootDir);
        }
        catch (error)
        {
            errors.push(`clean attempt cohort: ${error.message}`);
        }
    }
    if (!['collected-ok', 'collected-blocked'].includes(manifest.status))
    {
        errors.push(`invalid status: ${String(manifest.status)}`);
    }

    if (!manifest.commitSha || !/^(unknown|[0-9a-f]{40})$/i.test(manifest.commitSha))
    {
        errors.push('commitSha must be a full 40-character SHA or unknown');
    }

    if (!manifest.workflowRun || typeof manifest.workflowRun !== 'object')
    {
        errors.push('workflowRun object is required');
    }

    errors.push(...releaseEvidenceModelErrors(manifest, options, context));

    const runtimeMatrixDeclared = typeof manifest.artifacts?.runtimePublishMatrix === 'string'
    || manifest.releaseIdentity?.runtimeProfile != null
    || manifest.evidenceSummary?.operations?.runtimeTuning?.runtimeMatrixStatus === 'ok';
    if (context.manifestPath && (options.requireOk || runtimeMatrixDeclared))
    {
        errors.push(...validateReleaseRuntimeMatrix(manifest, context.manifestPath));
    }
    else if (!context.manifestPath && (options.requireOk || runtimeMatrixDeclared))
    {
        errors.push('runtime matrix validation requires the manifest path');
    }

    for (const key of requiredArtifacts)
    {
        if (!Object.hasOwn(manifest.artifacts ?? {}, key))
        {
            errors.push(`artifacts.${key} is missing`);
        }
    }

    const missingRequired = requiredStatusChecks
        .filter(([, predicate]) => !predicate(manifest, context))
        .map(([label]) => label);

    if (missingRequired.length > 0 && manifest.status !== 'collected-blocked')
    {
        errors.push(`manifest must be collected-blocked when required evidence is missing or blocked: ${missingRequired.join(', ')}`);
    }

    if (missingRequired.length === 0 && manifest.status !== 'collected-ok')
    {
        errors.push('manifest must be collected-ok when every required evidence component is ok');
    }

    if (options.requireOk && manifest.status !== 'collected-ok')
    {
        errors.push(`release closeout requires collected-ok, got ${manifest.status}`);
    }

    for (const key of ['frontendRenderStructureSummary', 'aedsDecodeBudgetSummary', 'aotCacheResilienceSummary', 'publicHydrationSidecarSummary', 'docSyncSummary', 'markdownRenderBudgetSummary', 'domDepthStaticSummary'])
    {
        if (manifest.artifacts?.[key] === null || manifest.artifacts?.[key] === undefined)
        {
            errors.push(`artifacts.${key} must point to a collected required summary`);
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        missingRequired
    };
}

function releaseRolloutTrafficFixture(rolloutId)
{
    const observationDigest = `sha256:${'6'.repeat(64)}`;
    const initialHead = sha256Value('fsusblog.release-traffic-observation-chain.v1');
    const chainHead = sha256Value(`${initialHead}\0${observationDigest}`);
    const scenarioSha256 = `sha256:${'7'.repeat(64)}`;
    const initialStateSha256 = `sha256:${'8'.repeat(64)}`;
    const coverage = Object.fromEntries(requiredTrafficPolicyStages
        .flatMap(stage => requiredTrafficCategories.map(category => [`${stage}/${category}`, 1])));
    const unsigned = {
        schema: 'fsusblog.release-traffic-evidence.v1',
        status: 'pass',
        probeMode: 'public-rollout',
        rolloutId,
        errors: [],
        totalRequests: 100,
        unexpectedResponseCount: 0,
        deploymentFailureCount: 0,
        connectionErrorCount: 0,
        gatewayErrorCount: 0,
        unhandled5xxCount: 0,
        inFlightAbortedCount: 0,
        inFlightRequestCount: 0,
        releaseDistribution: { source: 50, target: 50 },
        requiredCategories: [...requiredTrafficCategories],
        releaseIdentityPolicy: {
            required: true,
            scenarioRequired: true,
            mode: 'public-rollout',
            violationCount: 0,
            coverage
        },
        sessionChains: { authenticated: { completedCycles: 5, failedCycles: 0 } },
        gatewaySwitchHolds: {
            article: {
                required: true,
                attempts: 1,
                passCount: 1,
                failCount: 0,
                observations: [{
                    pass: true,
                    startedAt: { switchCommitted: false },
                    completedAt: { switchCommitted: true },
                    releaseRole: 'target',
                    bindingSha256: `sha256:${'9'.repeat(64)}`
                }]
            }
        },
        responseObservations: [{
            category: 'binary',
            lastObservation: {
                aeds: { checks: Array.from({ length: 7 }, (_, index) => ({ kind: `check-${index}`, pass: true })) }
            }
        }],
        observationBinding: {
            schema: 'fsusblog.release-traffic-observation-chain.v1',
            algorithm: 'sha256-chain',
            observationCount: 1,
            observationSha256: [observationDigest],
            chainHeadSha256: chainHead,
            scenarioSha256,
            initialRolloutStateSha256: initialStateSha256
        }
    };
    return {
        ...unsigned,
        finalBinding: {
            schema: 'fsusblog.release-traffic-final-binding.v1',
            algorithm: 'hmac-sha256',
            keyId: `hmac-sha256:${'a'.repeat(64)}`,
            rolloutId,
            scenarioSha256,
            initialRolloutStateSha256: initialStateSha256,
            finalRolloutStateSha256: `sha256:${'b'.repeat(64)}`,
            observationCount: 1,
            observationHashChain: chainHead,
            payloadSha256: sha256Value(canonicalJson(unsigned)),
            signature: `hmac-sha256:${'c'.repeat(64)}`
        }
    };
}

function releaseRolloutAssetFixture(rolloutId, sourceReleaseId, targetReleaseId)
{
    const scenarioSha256 = `sha256:${'d'.repeat(64)}`;
    const manifestSha256 = `sha256:${'e'.repeat(64)}`;
    const gcEvidenceSha256 = `sha256:${'f'.repeat(64)}`;
    const browser = {
        schema: 'fsusblog.release-asset-browser-evidence.v1',
        status: 'pass',
        browser: {
            name: 'chromium', version: 'fixture-1', executablePath: '/fixture/chromium',
            executableSha256: `sha256:${'1'.repeat(64)}`
        },
        bindings: { rolloutId, sourceReleaseId, targetReleaseId, scenarioSha256, manifestSha256, gcEvidenceSha256 },
        beforeSwitch: { status: 'pass', serviceWorker: { controller: { state: 'activated' } } },
        delayed: { resources: ['javascript', 'stylesheet', 'wasm', 'font'].map(kind => ({ kind, hashMatches: true })) },
        afterSwitch: { status: 'pass' },
        compatibility: {
            oldFrontendToNewBackend: { status: 'pass' },
            newFrontendToOldBackend: { status: 'pass' }
        },
        afterGc: { status: 'pass', cacheReads: [{ cacheHit: true, hashMatches: true }] },
        console: [], pageErrors: [],
        network: { responses: [], failures: [], blockedOldAssetRequests: [] },
        errors: []
    };
    const unsigned = {
        schema: 'fsusblog.release-asset-compatibility-evidence.v1',
        status: 'pass', rolloutId, sourceReleaseId, targetReleaseId, errors: [],
        notFoundCount: 0, hashMismatchCount: 0, connectionErrorCount: 0,
        checkpoint: { manifest: { sha256: manifestSha256 } },
        scenarios: Object.fromEntries([
            'delayedOldAssets', 'oldFrontendToNewBackend', 'newFrontendToOldBackend',
            'oldServiceWorkerCache', 'retentionWindowAfterGc'
        ].map(name => [name, 'pass'])),
        browser
    };
    return {
        ...unsigned,
        browserBinding: {
            schema: 'fsusblog.release-asset-browser-binding.v1', algorithm: 'hmac-sha256',
            keyId: `hmac-sha256:${'2'.repeat(64)}`, rolloutId, sourceReleaseId, targetReleaseId,
            browserName: browser.browser.name, browserVersion: browser.browser.version,
            browserExecutablePath: browser.browser.executablePath,
            browserExecutableSha256: browser.browser.executableSha256,
            scenarioSha256, manifestSha256, gcEvidenceSha256,
            payloadSha256: sha256Value(canonicalJson(unsigned)),
            signature: `hmac-sha256:${'3'.repeat(64)}`
        }
    };
}

function writeReleaseRolloutFixture(tmpDir, manifest, releaseId, imageDigest)
{
    const bundle = path.join(tmpDir, 'releaseRolloutBundle');
    const commands = path.join(bundle, 'commands');
    fs.mkdirSync(commands, { recursive: true });
    const rolloutId = `deploy-${releaseId}`;
    const source = {
        slot: 'blue',
        releaseId: '20260711000000-aabbccddeeff',
        imageDigest: `sha256:${'e'.repeat(64)}`,
        runtimeGeneration: 1
    };
    const target = { slot: 'green', releaseId, imageDigest, runtimeGeneration: 2 };
    const metadata = (file, original) => ({
        path: original,
        bytes: fs.statSync(file).size,
        sha256: `sha256:${sha256Hex(file)}`
    });
    const writeArtifact = (name, value) =>
    {
        const file = path.join(bundle, 'artifacts', name, `${name}.json`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify({ rolloutId, ...value })}\n`);
        return metadata(file, `/var/lib/fsusblog/deployment/rollouts/${rolloutId}/evidence/${name}.json`);
    };
    const artifacts = {
        publicTraffic: writeArtifact('publicTraffic', releaseRolloutTrafficFixture(rolloutId)),
        notificationStream: writeArtifact('notificationStream', {
            schema: 'fsusblog.release-notification-stream-evidence.v1', contractVersion: 2,
            status: 'pass', missingEventCount: 0, duplicateAppliedEventCount: 0,
            duplicateBusinessEventCount: 0, serviceRestartObserved: true, cursorReplayVerified: true,
            replayMissFullResyncVerified: true, businessEventsExactlyOnce: true,
            slowClientDidNotBlockDrain: true,
            inputBindings: { resyncScenario: { sha256: `sha256:${'1'.repeat(64)}` } },
            resync: {
                staleGuest: [
                    { phase: 'replay-miss', status: 'pass', watermark: 10, contentSha256: `sha256:${'2'.repeat(64)}` },
                    { phase: 'final', status: 'pass', watermark: 20, contentSha256: `sha256:${'3'.repeat(64)}` }
                ],
                staleAuth: [
                    { phase: 'replay-miss', status: 'pass', watermark: 10, contentSha256: `sha256:${'4'.repeat(64)}` },
                    { phase: 'final', status: 'pass', watermark: 20, contentSha256: `sha256:${'5'.repeat(64)}` }
                ]
            }
        }),
        assetCompatibility: writeArtifact(
            'assetCompatibility',
            releaseRolloutAssetFixture(rolloutId, source.releaseId, target.releaseId)),
        workerReconciliation: writeArtifact('workerReconciliation', {
            schema: 'fsusblog.release-worker-reconciliation-evidence.v2', mode: 'normal', status: 'pass',
            duplicateEffectCount: 0, staleGenerationCommitCount: 0, lostAuditCount: 0,
            lostVisitProjectionCount: 0, buffersDrained: true, durableReplayVerified: true,
            gracefulDrainVerified: true, forcedSourceRecoveryRequired: false,
            forcedSourceRecoveryVerified: false, checks: { gracefulDrainVerified: true, exactlyOnceVerified: true }
        }),
        resourceBudget: writeArtifact('resourceBudget', {
            schema: 'fsusblog.release-resource-budget-evidence.v1', status: 'pass', withinBudget: true,
            minimumSupported: { cpuCores: 4, memoryMiB: 6144, freeDiskMiB: 10240 },
            checks: { overlapSamples: true, dualSlotCpu: true, dualSlotMemory: true, temporaryDisk: true,
                openRestyReload: true, drain: true, notificationReconnect: true, trafficP95Impact: true, trafficP99Impact: true }
        }),
        faultInjection: writeArtifact('faultInjection', {
            schema: 'fsusblog.zero-downtime-fault-matrix.v1', status: 'pass',
            cases: [
                'manifest-digest-mismatch', 'capacity-insufficient', 'expand-failure', 'candidate-readiness',
                'asset-hash-mismatch', 'gateway-reload-failure', 'active-fence-failure', 'public-probe-failure',
                'drain-timeout', 'source-stop-failure', 'host-interruption', 'redis-disconnect', 'postgres-disconnect'
            ].map(caseName => ({ case: caseName, status: 'pass', automated: true }))
        })
    };
    const writeAuxiliary = (name, value) =>
    {
        const file = path.join(bundle, 'auxiliary', name, `${name}.json`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
        return metadata(file, `/var/lib/fsusblog/deployment/rollouts/${rolloutId}/evidence/auxiliary/${name}.json`);
    };
    const auxiliary = Object.fromEntries(requiredRolloutAuxiliary.map(name => [name, writeAuxiliary(
        name,
    name === 'releaseManifest'
        ? manifest.releaseIdentity
        : name === 'operatorNote'
        ? {
            schema: 'fsusblog.release-rollout-operator-note.v1', rolloutId,
            provided: false, author: null, note: '', errors: []
          }
        : { schema: `fsusblog.fixture.${name}.v1`, status: 'pass', rolloutId, source, target, errors: [] }
    )]));
    const stages = requiredRolloutStages.map(stage =>
    {
        const file = path.join(commands, `${stage}.attempt-1.json`);
        fs.writeFileSync(file, `${JSON.stringify({
            schema: 'fsusblog.release-rollout-stage-evidence.v1', rolloutId, stage,
            status: 'ok', exitCode: 0
        })}\n`);
        return {
            stage,
            attempts: 1,
            evidence: metadata(file, `/var/lib/fsusblog/deployment/rollouts/${rolloutId}/evidence/commands/${path.basename(file)}`)
        };
    });
    const report = {
        schema: 'fsusblog.release-rollout-evidence.v1',
        status: 'pass',
        rolloutId,
        kind: 'deploy',
        source,
        target,
        gatewayGeneration: 2,
        rollback: { allowed: true, contractMigrationApplied: false, target: source },
        stages,
        recoveries: [],
        artifacts,
        auxiliary,
        errors: [],
        sealedAtUtc: '2026-07-11T01:03:00.000Z'
    };
    const finalFile = path.join(tmpDir, 'releaseRollout.json');
    fs.writeFileSync(finalFile, `${JSON.stringify(report)}\n`);
    const bundleFiles = [
        path.join(bundle, 'release-rollout.json'),
        ...requiredRolloutStages.map(stage => path.join(commands, `${stage}.attempt-1.json`)),
        ...requiredRolloutArtifacts.map(name => path.join(bundle, 'artifacts', name, `${name}.json`)),
        ...requiredRolloutAuxiliary.map(name => path.join(bundle, 'auxiliary', name, `${name}.json`))
    ];
    fs.copyFileSync(finalFile, bundleFiles[0]);
    fs.writeFileSync(path.join(bundle, 'bundle-index.json'), `${JSON.stringify({
        schema: 'fsusblog.release-rollout-collected-bundle.v1',
        status: 'ok',
        rolloutId,
        sourceEvidenceSha256: `sha256:${sha256Hex(finalFile)}`,
        fileCount: bundleFiles.length,
        files: bundleFiles.map(file => ({ path: path.relative(bundle, file), bytes: fs.statSync(file).size, sha256: `sha256:${sha256Hex(file)}` })),
        collectedAtUtc: '2026-07-11T01:04:00.000Z'
    })}\n`);
    manifest.artifactDigests = {
        ...(manifest.artifactDigests ?? {}),
        releaseRollout: { algorithm: 'sha256', value: sha256Hex(finalFile) }
    };
}

async function runSelfTest()
{
    const releaseId = '20260711010101-0123456789ab';
    const commitSha = '0123456789abcdef0123456789abcdef01234567';
    const imageDigest = `sha256:${'a'.repeat(64)}`;
    const profileManifestDigest = `sha256:${'6'.repeat(64)}`;
    const profileDigest = `sha256:${'7'.repeat(64)}`;
    const base = {
        status: 'collected-ok',
        commitSha,
        workflowRun: { id: '123', attempt: '1', workflow: 'Quality Gate' },
        imageDigest,
        releaseIdentity: {
            schema: 'fsusblog.release-manifest.v3',
            releaseId,
            commitSha,
            imageRepository: 'ghcr.io/fsusblog/app',
            imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
            imageDigest,
            imageRef: `ghcr.io/fsusblog/app@${imageDigest}`,
            registryDigestVerified: true,
            createdAtUtc: '2026-07-11T01:01:01.000Z',
            frontendManifestHash: `sha256:${'b'.repeat(64)}`,
            wasmArtifactHash: `sha256:${'c'.repeat(64)}`,
            currentSchema: { receiptFormat: 'fsusblog.current-schema-receipt.v1', receipt: { reference: '/unit-fixture/current-schema-receipt.json', sha256: 'a'.repeat(64) }, receiptContentDigest: 'b'.repeat(64), target: { modelVersion: 'unit-model-v1', extractorVersion: 'unit-extractor-v1', generatorVersion: 'unit-generator-v1', sourceDigest: 'c'.repeat(64), contentDigest: 'd'.repeat(64) }, database: { provider: 0, instanceId: 'unit-instance', databaseId: 'unit-database' }, actualSchemaDigest: 'e'.repeat(64) },
            toolchain: {
                dotnetVersion: '10.0.100',
                nodeVersion: 'v20.19.0',
                dockerVersion: '28.0.0',
                dockerfileDigest: `sha256:${'d'.repeat(64)}`
            },
            runtimeProfile: {
                id: 'throughput-musl',
                manifestDigest: profileManifestDigest,
                profileDigest,
                baseImageFamily: 'musl',
                targetRuntime: 'linux-musl-x64',
                singleFile: true,
                readyToRun: false,
                tieredPgo: true,
                quickJitForLoops: true,
                serverGc: true,
                nativeAot: false,
                threadPoolMode: 'runtime-default',
                topologyMode: 'smt-visible'
            },
            build: { dockerfile: 'ops/docker/FsusBlog.Server.Dockerfile', target: 'final' },
            releaseSlot: 'green'
        },
        artifacts: Object.fromEntries(requiredArtifacts.map((key) => [key, `${key}.json`])),
        evidenceSummary: {
            image: { status: 'present', digest: imageDigest, releaseIdentityStatus: 'ok' },
            coverage: { status: 'ok' },
            operations: {
                postDeploySmoke: 'ok',
                gatewayTransition: 'ok',
                releaseRollout: 'ok',
                backupRestoreDrill: 'ok',
                sloAlerts: 'ok',
                sloCriticalFiring: 0,
                runtimeTuning: {
                    profile: { id: 'throughput-musl', manifestDigest: profileManifestDigest, profileDigest },
                    runtimeMatrixEvidence: 'runtimePublishMatrix.json',
                    runtimeMatrixStatus: 'ok'
                }
            },
            security: {
                dastZap: 'ok',
                authenticatedDast: 'ok',
                localRuntimeExposure: 'ok',
                attackMatrix: 'ok',
                permissionMatrix: 'ok',
                supplyChain: 'ok',
                sbom: 'ok',
                wasmFuzz: 'ok'
            },
            gates: {
                frontendRenderStructure: 'ok',
                aedsDecodeBudget: 'ok',
                publicAotCacheResilience: 'success',
                publicHydrationSidecar: 'success',
                docSync: 'ok'
            },
            resilienceDepth: {
                faultInjection: 'ok',
                soak: 'ok',
                memoryLeak: 'ok',
                openHandle: 'ok'
            },
            externalExposure: {
                status: 'ok',
                firewallPolicy: 'present',
                dnsReadiness: 'ok',
                dnsDelegation: 'ok',
                liveExposure: 'ok'
            }
        }
    };
    const { createReleaseIdentityRosterFixture } = await import('../../tests/tools/support/release-readiness-test-helpers.mjs');
    base.releaseIdentity.identity = createReleaseIdentityRosterFixture(base.releaseIdentity);
    base.releaseIdentity.signature = null;
    const { releaseSlot: unitSlot, ...unitManifest } = base.releaseIdentity;
    unitManifest.candidateId = deriveReleaseCandidateId(unitManifest);
    unitManifest.contentDigest = deriveReleaseManifestContentDigest(unitManifest);
    base.releaseIdentity = { ...unitManifest, releaseSlot: unitSlot };
    base.artifacts.authenticatedDast = 'authenticatedDast';
    base.artifacts.fuzz = 'fuzz';
    base.artifacts.faultInjection = 'faultInjection';
    base.artifacts.soak = 'soak';
    base.artifacts.memoryLeakSummary = 'memoryLeakSummary.json';
    base.artifacts.openHandleSummary = 'openHandleSummary.json';
    base.artifacts.uxViewportSummary = 'uxViewportSummary.json';
    base.artifacts.aedsDecodeBudgetSummary = 'aedsDecodeBudgetSummary.json';
    base.artifacts.aedsWasmBrowserSummary = 'aedsWasmBrowserSummary.json';
    base.artifacts.releaseRollout = 'releaseRollout.json';
    base.artifacts.releaseRolloutBundle = 'releaseRolloutBundle';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-release-manifest-'));
    const manifestFile = path.join(tmpDir, 'manifest.json');
    const { createReleaseRuntimeMatrixFixture } = await import(new URL('../../tests/tools/fixtures/release-runtime-matrix.mjs', import.meta.url));
    const runtimeMatrixFile = path.join(tmpDir, 'runtimePublishMatrix.json');
    fs.writeFileSync(runtimeMatrixFile, `${JSON.stringify(createReleaseRuntimeMatrixFixture({ commitSha, profileManifestDigest, profileDigest }))}\n`);
    base.artifacts.runtimePublishMatrix = 'runtimePublishMatrix.json';
    base.artifactDigests = {
        runtimePublishMatrix: { algorithm: 'sha256', value: sha256Hex(runtimeMatrixFile) }
    };
    fs.writeFileSync(path.join(tmpDir, 'backupRestoreDrill.json'), JSON.stringify({
        status: 'ok',
        mode: 'real',
        timings: { rpoSeconds: 1, rtoSeconds: 1 },
        checks: ['postgres-restore:ok', 'redis-restore:ok', 'webroot-artifact-restore:ok', 'restored-backend-start:ok', 'public-page:ok', 'binary-api:ok', 'search-index:ok', 'notification-stream-live:ok', 'admin-login:ok']
    }));
    fs.writeFileSync(path.join(tmpDir, 'postDeploySmoke.json'), JSON.stringify({
        status: 'ok',
        dryRun: false,
        verifiedCoverage: ['anonymous-public', 'feed-rss', 'feed-atom', 'feed-json', 'sitemap', 'robots', 'health-live', 'health-ready'],
        blockers: []
    }));
    fs.writeFileSync(path.join(tmpDir, 'gatewayTransition.json'), JSON.stringify({
        schema: 'fsusblog.gateway-transition-evidence.v1',
        kind: 'switch',
        status: 'ok',
        generation: 2,
        startedAtUtc: '2026-07-11T01:02:00.000Z',
        completedAtUtc: '2026-07-11T01:02:01.000Z',
        durationMs: 1000,
        source: { slot: 'blue', releaseId: '20260711000000-aabbccddeeff', imageDigest: `sha256:${'e'.repeat(64)}` },
        target: { slot: 'green', releaseId, imageDigest },
        checks: {
            targetIdentity: true,
            targetReadiness: true,
            sourcePublicRelease: true,
            stagedConfigTest: true,
            stateBegin: true,
            upstreamInstall: true,
            activeConfigTest: true,
            reload: true,
            publicReleaseProbe: true,
            targetLoopbackAfterReload: true,
            stateCommit: true,
            sourceRuntimeStatus: true,
            targetRuntimeStatus: true,
            targetActivation: true,
            sourceDrain: true,
            sourceDrainDeferred: false
        },
        lifecycle: lifecycleFixture({
            source: { slot: 'blue', releaseId: '20260711000000-aabbccddeeff', generation: 1 },
            target: { slot: 'green', releaseId, generation: 2 }
        }),
        publicProbeUrl: 'https://fsus.blog/health/ready',
        postSwitchProbeUrl: 'https://fsus.blog/health/ready',
        upstreamBeforeSha256: `sha256:${'1'.repeat(64)}`,
        upstreamAfterSha256: `sha256:${'2'.repeat(64)}`,
        failureStage: null,
        error: null,
        recoveryAction: 'none'
    }));
    writeReleaseRolloutFixture(tmpDir, base, releaseId, imageDigest);
    fs.writeFileSync(path.join(tmpDir, 'publicHydrationSidecarSummary.json'), JSON.stringify({
        schema: 'fsusblog.public-hydration-sidecar-smoke.v1',
        status: 'success',
        requiredPageKinds: ['Home', 'ArticleDetail', 'Archive', 'Filter', 'About', 'Privacy', 'Guidelines', 'Copyright'],
        missingRequiredKinds: [],
        modeCounts: { 'sidecar-primary': 8, 'inline-fallback': 0 },
        canary: { status: 'success' },
        checks: ['Home', 'ArticleDetail', 'Archive', 'Filter', 'About', 'Privacy', 'Guidelines', 'Copyright'].map((kind) => ({
            status: 'success',
            expectedPageKind: kind,
            pageKind: kind,
            mode: 'sidecar-primary'
        }))
    }));
    fs.writeFileSync(path.join(tmpDir, 'aotCacheResilienceSummary.json'), JSON.stringify({
        schema: 'fsusblog.public-aot-cache-resilience.v1',
        status: 'success',
        gitSha: 'fixture',
        rendererVersion: 'fixture',
        placeholderOnly: false,
        cases: [
            'corrupt-document',
            'invalid-document-bytes',
            'missing-sidecar',
            'corrupt-sidecar',
            'old-asset-version',
            'html-payload-mismatch',
            'sw-stale-cache-poisoning'
        ].map((name) => ({
            name,
            route: '/article/1',
            status: 'success',
            initialState: 'fresh',
            mutation: `fixture-${name}`,
            mutationVerified: true,
            observedState: name === 'old-asset-version' ? 'stale' : 'fallback',
            recovered: true,
            durationMs: 1,
            errors: []
        }))
    }));
    fs.writeFileSync(path.join(tmpDir, 'uxViewportSummary.json'), JSON.stringify({
        status: 'ok',
        latestMode: 'boundaries',
        planFingerprint: `sha256:${'a'.repeat(64)}`,
        plannedCaseCount: 70,
        completedCaseCount: 70,
        plannedNavigationCount: 70,
        completedNavigationCount: 70,
        completedRouteThemeGroupCount: 10,
        failedRouteThemeGroupCount: 0,
        artifacts: { smoke: null, visual: null, boundaries: '.tmp/ux/viewport-boundaries.json' }
    }));
    fs.writeFileSync(path.join(tmpDir, 'frontendRenderStructureSummary.json'), JSON.stringify({
        schema: 'fsusblog.frontend-render-structure.v1',
        status: 'ok',
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        executionBoundary: 'browserless-static-analysis',
        checks: ['dom-depth-static', 'markdown-render-budget']
    }));
    fs.writeFileSync(path.join(tmpDir, 'aedsDecodeBudgetSummary.json'), JSON.stringify({
        status: 'ok',
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        executionBoundary: 'browserless-node-wasm-runtime',
        commitSha,
        measurementSource: 'real-basic-speed-wasm-runtime',
        workerModel: {
            resourceSource: 'os.availableParallelism',
            logicalProcessors: 8,
            instancesPerPage: 1,
            activeRequests: 4,
            minimumActiveRequests: 1,
            maximumActiveRequests: 8
        },
        tiers: ['basic', 'speed'].map((tier) => ({
            tier,
            artifact: { rawBytes: 1024, gzipBytes: 512, brotliBytes: 480 },
            compileP95Ms: 1,
            initialMemoryPages: tier === 'speed' ? 1024 : 256,
            memoryPages: tier === 'speed' ? 1024 : 256,
            peakMemoryPages: tier === 'speed' ? 1024 : 256,
            growCount: 0,
            arenaReallocationCount: 3,
            arenaClearCount: 150,
            sensitiveBytesCleared: true,
            copyBudget: {
                measurementSource: 'executed-arena-and-owned-payload-copy',
                measuredDecodeCount: 120,
                jsToWasmCopiedBytes: 1024,
                expectedJsToWasmCopiedBytes: 1024,
                wasmToJsCopiedBytes: 512,
                expectedWasmToJsCopiedBytes: 512,
                structuredCloneFullBufferCopies: 0
            }
        })),
        throughput: [4096, 65536, 1048576].map((frameBytes, index) => ({
            frameBytes,
            basicMBps: 200 + index,
            speedMBps: 240 + index,
            speedup: 1.2
        })),
        budgets: { measuredMedianSpeedup: 1.2 }
    }));
    fs.writeFileSync(path.join(tmpDir, 'aedsWasmBrowserSummary.json'), JSON.stringify({
        status: 'ok',
        evidenceClass: 'diagnostic',
        affectsCorrectness: false,
        executionBoundary: 'real-browser-engines',
        commitSha,
        hydrationTakeoverEvidence: '.tmp/release-evidence/public-hydration-sidecar-summary.json',
        selectionRate: 1,
        fallbackRate: 1,
        browsers: ['chromium', 'firefox', 'webkit'].map((browser) => ({
            browser,
            supported: true,
            status: 'ok',
            selectedTier: 'speed',
            fallbackTier: 'basic',
            fallbackCount: 1,
            load: { downloadMs: 1, compileMs: 1, instantiateMs: 1 },
            decode: {
                megabytesPerSecond: 250,
                decodeCount: 40,
                decodedBytes: 10486400,
                jsToWasmCopiedBytes: 10486400,
                wasmToJsCopiedBytes: 10485760,
                initialPages: 1024,
                peakPages: 1024,
                growCount: 0,
                workerModel: {
                    resourceSource: 'navigator.hardwareConcurrency',
                    logicalProcessors: 8,
                    instancesPerPage: 1,
                    activeRequests: 4,
                    minimumActiveRequests: 1,
                    maximumActiveRequests: 8
                },
                arenaReallocationCount: 1,
                arenaClearCount: 39,
                longTaskDurationMs: 0
            },
            workerTransferMs: 0
        }))
    }));
    fs.mkdirSync(path.join(tmpDir, 'authenticatedDast'));
    fs.writeFileSync(path.join(tmpDir, 'authenticatedDast', 'summary.json'), JSON.stringify({
        schema: 'fsusblog.security.authenticated-dast.v1',
        status: 'ok',
        executionSource: 'fresh-current-lane',
        targetPolicy: { loopbackOnly: true, productionTargetAllowed: false },
        fixture: { executionSource: 'fresh-current-lane', historicalStateAccepted: false, cleanup: 'success' },
        activeScan: { executed: true, requestCount: 4, passedCount: 4, failedCount: 0 },
        contexts: Object.fromEntries(['anonymous', 'user', 'admin', 'author-console'].map((name) => [name, {
            executed: true, requestCount: 1, passedCount: 1, failedCount: 0
        }])),
        checks: ['anonymous', 'user', 'admin', 'author-console'].map((context) => ({ context, passed: true }))
    }));
    fs.writeFileSync(path.join(tmpDir, 'localRuntimeExposure.json'), JSON.stringify({
        schema: 'fsusblog.security.local-runtime-exposure.v1',
        status: 'ok',
        executionSource: 'fresh-loopback-runtime',
        scope: {
            loopbackRuntimeOnly: true,
            externalProductionDnsChecked: false,
            externalFirewallEvidenceChecked: false,
            countsAsProductionCloseout: false
        },
        targets: ['backend', 'frontend', 'release-preview'].map((id) => ({ id, status: 200 })),
        listeners: ['backend', 'frontend', 'release-preview'].map((id, index) => ({ id, addresses: [`127.0.0.1:${25001 + index}`] })),
        restrictedServices: ['postgres', 'redis'].map((id) => ({ id, loopbackOnly: true })),
        failures: []
    }));
    fs.mkdirSync(path.join(tmpDir, 'fuzz', 'wasm'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'fuzz', 'wasm', 'summary.json'), JSON.stringify({
        status: 'ok',
        executionSource: 'fresh-wasm-runtime',
        seedsRun: 1,
        seedPlan: [{ corpus: 'fixture', firstSeed: 1, count: 1 }],
        decoder: { sha256: 'a'.repeat(64) },
        crashes: []
    }));
    fs.mkdirSync(path.join(tmpDir, 'faultInjection'));
    const redisFaultFixtureCases = requiredRedisFaultCases.map((caseName, index) => ({
        case: caseName,
        status: 'completed',
        actionStatus: 'executed',
        actionStartedAt: `2026-06-18T00:00:0${index}Z`,
        actionCompletedAt: `2026-06-18T00:00:1${index}Z`,
        unavailableDurationMs: index,
        recoveryDurationMs: 2 + index,
        recoveryTimeMs: 2 + index,
        publicReadResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
        authenticatedImpact: { status: 'not-configured' },
        notificationStreamImpact: { status: 'not-configured' },
        finalHealthStatus: 'healthy'
    }));
    const postgresFaultFixtureCases = requiredPostgresFaultCases.map((caseName, index) => ({
        case: caseName,
        status: 'completed',
        actionStatus: 'executed',
        actionStartedAt: `2026-06-18T00:01:0${index}Z`,
        actionCompletedAt: `2026-06-18T00:01:1${index}Z`,
        affectedEndpoint: index === 2 ? '/api/binary/article/list/home/1/10.aeds' : '/health/ready',
        unavailableDurationMs: index,
        dbReconnectDurationMs: 3 + index,
        recoveryDurationMs: 3 + index,
        recoveryTimeMs: 3 + index,
        publicReadRecoveryResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
        writePathRollbackResult: { status: index === 2 ? 'verified' : 'not-mutated' },
        finalHealthStatus: 'healthy'
    }));
    const notificationFaultFixtureCase = {
        case: 'notification-stream-slow-consumer',
        status: 'completed',
        actionStatus: 'executed',
        actionStartedAt: '2026-06-18T00:02:00Z',
        actionCompletedAt: '2026-06-18T00:02:10Z',
        unavailableDurationMs: 0,
        recoveryDurationMs: 5,
        recoveryTimeMs: 5,
        connectionCount: 3,
        heartbeatFrameCount: 2,
        businessFrameCount: 8,
        deliveredFrameCount: 8,
        droppedOrBackpressuredCount: 1,
        reconnectSuccess: true,
        replayedEventCount: 1,
        closeObserved: true,
        eventIds: [101, 102],
        routeKey: 'g:ContentGovernanceGroup',
        slowConsumerPolicy: 'controlled-degradation',
        finalHealthStatus: 'healthy'
    };
    fs.writeFileSync(path.join(tmpDir, 'faultInjection', 'summary.json'), JSON.stringify({
        status: 'ok',
        caseCount: 6,
        cases: [...redisFaultFixtureCases, ...postgresFaultFixtureCases]
    }));
    const missingNotificationFault = validateManifest(base, { manifestPath: manifestFile });
    if (missingNotificationFault.ok || !missingNotificationFault.missingRequired.includes('fault injection'))
    {
        fail('self-test expected missing notification slow-consumer fault case to block release closeout');
    }
    fs.writeFileSync(path.join(tmpDir, 'faultInjection', 'summary.json'), JSON.stringify({
        status: 'ok',
        caseCount: 7,
        cases: [...redisFaultFixtureCases, ...postgresFaultFixtureCases, notificationFaultFixtureCase]
    }));
    const missingGracefulShutdownFault = validateManifest(base, { manifestPath: manifestFile });
    if (missingGracefulShutdownFault.ok || !missingGracefulShutdownFault.missingRequired.includes('fault injection'))
    {
        fail('self-test expected missing graceful shutdown fault case to block release closeout');
    }
    const gracefulShutdownFaultFixtureCase = {
        case: 'graceful-shutdown',
        status: 'completed',
        actionStatus: 'executed',
        actionStartedAt: '2026-06-18T00:03:00Z',
        actionCompletedAt: '2026-06-18T00:03:10Z',
        shutdownRequestedAt: '2026-06-18T00:03:01Z',
        drainDurationMs: 300,
        restartRecoveryDurationMs: 500,
        recoveryDurationMs: 800,
        recoveryTimeMs: 800,
        processStopResult: { status: 'stopped', signal: 'SIGTERM', exitObserved: true },
        livenessBefore: { status: 'completed', sampleCount: 1 },
        livenessDuringShutdown: { status: 'unavailable', statusCode: null },
        notificationCloseObserved: true,
        notificationCloseCode: 1001,
        notificationReconnectSuccess: true,
        publicReadRecoveryResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
        basicAuthRecoveryResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
        backgroundWorkerState: { status: 'clean', source: 'log-scan' },
        finalHealthStatus: 'healthy'
    };
    fs.writeFileSync(path.join(tmpDir, 'faultInjection', 'summary.json'), JSON.stringify({
        status: 'ok',
        caseCount: 8,
        cases: [...redisFaultFixtureCases, ...postgresFaultFixtureCases, notificationFaultFixtureCase, gracefulShutdownFaultFixtureCase]
    }));
    const missingDiskArtifactFault = validateManifest(base, { manifestPath: manifestFile });
    if (missingDiskArtifactFault.ok || !missingDiskArtifactFault.missingRequired.includes('fault injection'))
    {
        fail('self-test expected missing disk artifact storage fault case to block release closeout');
    }
    const diskArtifactFaultFixtureCase = {
        case: 'disk-artifact-storage-write-failure',
        status: 'completed',
        actionStatus: 'executed',
        actionStartedAt: '2026-06-18T00:04:00Z',
        actionCompletedAt: '2026-06-18T00:04:10Z',
        targetPath: '.tmp/fault-injection-storage/fixture/artifact-target',
        expectedErrorClassification: 'EACCES',
        recoveryDurationMs: 100,
        recoveryTimeMs: 100,
        writeFailureResult: { status: 'expected-error', code: 'EACCES' },
        recoveryResult: { status: 'completed', bytesWritten: 9 },
        cleanupResult: { status: 'completed' },
        finalHealthStatus: 'healthy'
    };
    fs.writeFileSync(path.join(tmpDir, 'faultInjection', 'summary.json'), JSON.stringify({
        status: 'ok',
        caseCount: 9,
        cases: [
            ...redisFaultFixtureCases,
            ...postgresFaultFixtureCases,
            notificationFaultFixtureCase,
            gracefulShutdownFaultFixtureCase,
            diskArtifactFaultFixtureCase
        ]
    }));
    fs.mkdirSync(path.join(tmpDir, 'soak', 'short'), { recursive: true });
    const validShortSoakSummary = {
        status: 'ok',
        mode: 'short',
        executionMode: 'runtime',
        countsAsReleaseFinal: true,
        durationSeconds: 1,
        sampleCount: 1,
        latencyMs: { p95: 1, p99: 1 },
        errorRate: 0,
        resourceMetricSummary: {
            status: 'ok',
            metrics: [{
                name: 'backend_rss_bytes',
                unit: 'bytes',
                startValue: 100,
                endValue: 104,
                maxValue: 104,
                delta: 4,
                status: 'observed'
            }],
            unavailableMetrics: []
        }
    };
    fs.writeFileSync(path.join(tmpDir, 'soak', 'short', 'summary.json'), JSON.stringify(validShortSoakSummary));
    const resourceSummary = {
        status: 'ok',
        metrics: [{
            name: 'backend_rss_bytes',
            startValue: 100,
            endValue: 104,
            maxValue: 104,
            delta: 4,
            threshold: 64,
            thresholdOperator: '<=',
            thresholdField: 'delta',
            status: 'ok'
        }],
        unavailableMetrics: []
    };
    fs.writeFileSync(path.join(tmpDir, 'memoryLeakSummary.json'), JSON.stringify(resourceSummary));
    fs.writeFileSync(path.join(tmpDir, 'openHandleSummary.json'), JSON.stringify({
        ...resourceSummary,
        metrics: [{
            ...resourceSummary.metrics[0],
            name: 'backend_open_file_descriptors',
            threshold: 16
        }]
    }));
    fs.writeFileSync(manifestFile, JSON.stringify(base));
    const ok = validateManifest(base, { manifestPath: manifestFile });
    if (!ok.ok)
    {
        fail(`self-test expected ok manifest to pass: ${ok.errors.join('; ')}`);
    }

    const validAedsDecodeBudget = readJson(path.join(tmpDir, 'aedsDecodeBudgetSummary.json'));
    fs.writeFileSync(path.join(tmpDir, 'aedsDecodeBudgetSummary.json'), JSON.stringify({
        ...validAedsDecodeBudget,
        budgets: { ...validAedsDecodeBudget.budgets, measuredMedianSpeedup: 1 }
    }));
    const regressedAedsBudget = structuredClone(base);
    regressedAedsBudget.status = 'collected-blocked';
    const regressedAedsBudgetResult = validateManifest(regressedAedsBudget, { manifestPath: manifestFile });
    if (!regressedAedsBudgetResult.ok || !regressedAedsBudgetResult.missingRequired.includes('AEDS Wasm decode budget'))
    {
        fail('self-test expected regressed AEDS speed budget to block release closeout');
    }
    fs.writeFileSync(path.join(tmpDir, 'aedsDecodeBudgetSummary.json'), JSON.stringify({
        ...validAedsDecodeBudget,
        tiers: validAedsDecodeBudget.tiers.map((tier, index) => index === 0 ? {
      ...tier,
      copyBudget: { ...tier.copyBudget, expectedJsToWasmCopiedBytes: tier.copyBudget.jsToWasmCopiedBytes + 1 }
    } : tier)
    }));
    const falseCopyAedsBudget = structuredClone(base);
    falseCopyAedsBudget.status = 'collected-blocked';
    const falseCopyAedsBudgetResult = validateManifest(falseCopyAedsBudget, { manifestPath: manifestFile });
    if (!falseCopyAedsBudgetResult.ok || !falseCopyAedsBudgetResult.missingRequired.includes('AEDS Wasm decode budget'))
    {
        fail('self-test expected unmeasured AEDS copy budget to block release closeout');
    }
    fs.writeFileSync(path.join(tmpDir, 'aedsDecodeBudgetSummary.json'), JSON.stringify(validAedsDecodeBudget));

    const validAedsBrowser = readJson(path.join(tmpDir, 'aedsWasmBrowserSummary.json'));
    fs.writeFileSync(path.join(tmpDir, 'aedsWasmBrowserSummary.json'), JSON.stringify({
        ...validAedsBrowser,
        selectionRate: 0.5
    }));
    const diagnosticAedsBrowserResult = validateManifest(base, { manifestPath: manifestFile });
    if (!diagnosticAedsBrowserResult.ok)
    {
        fail(`self-test expected regressed diagnostics-only AEDS browser evidence not to block correctness: ${diagnosticAedsBrowserResult.errors.join('; ')}`);
    }
    fs.writeFileSync(path.join(tmpDir, 'aedsWasmBrowserSummary.json'), JSON.stringify({
        ...validAedsBrowser,
        commitSha: 'f'.repeat(40)
    }));
    const staleDiagnosticAedsBrowserResult = validateManifest(base, { manifestPath: manifestFile });
    if (!staleDiagnosticAedsBrowserResult.ok)
    {
        fail(`self-test expected stale diagnostics-only AEDS browser evidence not to block correctness: ${staleDiagnosticAedsBrowserResult.errors.join('; ')}`);
    }
    fs.writeFileSync(path.join(tmpDir, 'aedsWasmBrowserSummary.json'), JSON.stringify(validAedsBrowser));

    const gatewayFixture = readJson(path.join(tmpDir, 'gatewayTransition.json'));
    fs.writeFileSync(path.join(tmpDir, 'gatewayTransition.json'), JSON.stringify({
        ...gatewayFixture,
        target: { ...gatewayFixture.target, releaseId: '20260711999999-badbadbadbad' }
    }));
    const mismatchedGateway = structuredClone(base);
    mismatchedGateway.status = 'collected-blocked';
    const mismatchedGatewayResult = validateManifest(mismatchedGateway, { manifestPath: manifestFile });
    if (!mismatchedGatewayResult.ok || !mismatchedGatewayResult.missingRequired.includes('gateway transition'))
    {
        fail(`self-test expected mismatched gateway release identity to stay blocked: ${mismatchedGatewayResult.errors.join('; ')}`);
    }
    fs.writeFileSync(path.join(tmpDir, 'gatewayTransition.json'), JSON.stringify(gatewayFixture));

    fs.writeFileSync(path.join(tmpDir, 'soak', 'short', 'summary.json'), JSON.stringify({
        status: 'ok',
        mode: 'short',
        durationSeconds: 1,
        sampleCount: 1,
        latencyMs: { p95: 1, p99: 1 },
        errorRate: 0
    }));
    const missingShortSoakResource = validateManifest(base, { manifestPath: manifestFile });
    if (missingShortSoakResource.ok)
    {
        fail('self-test expected short soak without resource evidence to fail');
    }
    fs.writeFileSync(path.join(tmpDir, 'soak', 'short', 'summary.json'), JSON.stringify(validShortSoakSummary));

    fs.writeFileSync(path.join(tmpDir, 'backupRestoreDrill.json'), JSON.stringify({
        status: 'ok',
        mode: 'dry-run',
        timings: { rpoSeconds: 1, rtoSeconds: 1 },
        checks: ['postgres-restore:ok', 'redis-restore:ok', 'webroot-artifact-restore:ok', 'restored-backend-start:ok', 'public-page:ok', 'binary-api:ok', 'search-index:ok', 'notification-stream-live:ok', 'admin-login:ok']
    }));
    const dryRunBackup = validateManifest(base, { manifestPath: manifestFile });
    if (dryRunBackup.ok || !dryRunBackup.missingRequired.includes('backup restore drill'))
    {
        fail('self-test expected dry-run backup restore artifact to block release closeout');
    }
    fs.writeFileSync(path.join(tmpDir, 'backupRestoreDrill.json'), JSON.stringify({
        status: 'ok',
        mode: 'real',
        timings: { rpoSeconds: 1, rtoSeconds: 1 },
        checks: ['postgres-restore:ok', 'redis-restore:ok', 'webroot-artifact-restore:ok', 'restored-backend-start:ok', 'public-page:ok', 'binary-api:ok', 'search-index:ok', 'notification-stream-live:ok', 'admin-login:ok']
    }));

    fs.writeFileSync(path.join(tmpDir, 'aotCacheResilienceSummary.json'), JSON.stringify({
        status: 'ok',
        placeholderOnly: true,
        cases: ['corrupt-html', 'corrupt-json']
    }));
    const placeholderAotResilience = validateManifest(base, { manifestPath: manifestFile });
    if (placeholderAotResilience.ok || !placeholderAotResilience.missingRequired.includes('public AOT cache resilience'))
    {
        fail('self-test expected placeholder AOT cache resilience artifact to block release closeout');
    }
    fs.writeFileSync(path.join(tmpDir, 'aotCacheResilienceSummary.json'), JSON.stringify({
        schema: 'fsusblog.public-aot-cache-resilience.v1',
        status: 'success',
        gitSha: 'fixture',
        rendererVersion: 'fixture',
        placeholderOnly: false,
        cases: [
            'corrupt-document',
            'invalid-document-bytes',
            'missing-sidecar',
            'corrupt-sidecar',
            'old-asset-version',
            'html-payload-mismatch',
            'sw-stale-cache-poisoning'
        ].map((name) => ({
            name,
            route: '/article/1',
            status: 'success',
            initialState: 'fresh',
            mutation: `fixture-${name}`,
            mutationVerified: true,
            observedState: name === 'old-asset-version' ? 'stale' : 'fallback',
            recovered: true,
            durationMs: 1,
            errors: []
        }))
    }));

    const missingButOk = structuredClone(base);
    missingButOk.evidenceSummary.image.status = 'missing';
    const blockedExpectation = validateManifest(missingButOk, { manifestPath: manifestFile });
    if (blockedExpectation.ok || !blockedExpectation.errors.some((error) => error.includes('collected-blocked')))
    {
        fail('self-test expected missing image digest to require collected-blocked');
    }

    const blocked = structuredClone(missingButOk);
    blocked.status = 'collected-blocked';
    const blockedResult = validateManifest(blocked, { manifestPath: manifestFile });
    if (!blockedResult.ok || !blockedResult.missingRequired.includes('image digest'))
    {
        fail(`self-test expected blocked missing-image manifest to pass schema: ${blockedResult.errors.join('; ')}`);
    }

    const mismatchedIdentity = structuredClone(base);
    mismatchedIdentity.status = 'collected-blocked';
    mismatchedIdentity.releaseIdentity.imageDigest = `sha256:${'e'.repeat(64)}`;
    const mismatchedIdentityResult = validateManifest(mismatchedIdentity, { manifestPath: manifestFile });
    if (!mismatchedIdentityResult.ok || !mismatchedIdentityResult.missingRequired.includes('release identity'))
    {
        fail(`self-test expected mismatched release identity to stay blocked: ${mismatchedIdentityResult.errors.join('; ')}`);
    }

    const localProductionBlocked = structuredClone(base);
    localProductionBlocked.status = 'collected-blocked';
    localProductionBlocked.releaseIdentity = { status: 'missing' };
    localProductionBlocked.artifacts.runtimePublishMatrix = null;
    localProductionBlocked.artifactDigests.runtimePublishMatrix = null;
    localProductionBlocked.evidenceSummary.operations.runtimeTuning = null;
    const localProductionBlockedResult = validateManifest(localProductionBlocked, { manifestPath: manifestFile });
    if (!localProductionBlockedResult.ok
    || !localProductionBlockedResult.missingRequired.includes('release identity')
    || !localProductionBlockedResult.missingRequired.includes('sealed runtime publish matrix'))
    {
        fail(`self-test expected local production evidence without release identity to stay collected-blocked: ${localProductionBlockedResult.errors.join('; ')}`);
    }

    const missingRuntimeMatrix = structuredClone(base);
    missingRuntimeMatrix.artifacts.runtimePublishMatrix = null;
    const missingRuntimeMatrixResult = validateManifest(missingRuntimeMatrix, { manifestPath: manifestFile });
    if (missingRuntimeMatrixResult.ok || !missingRuntimeMatrixResult.errors.some((error) => error.includes('runtimePublishMatrix')))
    {
        fail('self-test expected a missing runtime matrix to be rejected');
    }

    const validRuntimeMatrix = readJson(runtimeMatrixFile);
    const writeRuntimeMatrix = (value) =>
    {
        fs.writeFileSync(runtimeMatrixFile, `${JSON.stringify(value)}\n`);
        return { algorithm: 'sha256', value: sha256Hex(runtimeMatrixFile) };
    };
    const wrongCommit = structuredClone(validRuntimeMatrix);
    wrongCommit.identity.commitSha = 'f'.repeat(40);
    const wrongCommitManifest = structuredClone(base);
    wrongCommitManifest.artifactDigests.runtimePublishMatrix = writeRuntimeMatrix(wrongCommit);
    const wrongCommitResult = validateManifest(wrongCommitManifest, { manifestPath: manifestFile });
    if (wrongCommitResult.ok || !wrongCommitResult.errors.some((error) => error.includes('release commit')))
    {
        fail('self-test expected a wrong runtime matrix commit SHA to be rejected');
    }

    const unselected = structuredClone(validRuntimeMatrix);
    unselected.selection = null;
    const unselectedManifest = structuredClone(base);
    unselectedManifest.artifactDigests.runtimePublishMatrix = writeRuntimeMatrix(unselected);
    const unselectedResult = validateManifest(unselectedManifest, { manifestPath: manifestFile });
    if (unselectedResult.ok || !unselectedResult.errors.some((error) => error.includes('sealed production selection')))
    {
        fail('self-test expected an unselected runtime matrix to be rejected');
    }

    writeRuntimeMatrix(validRuntimeMatrix);
    const zeroDigest = structuredClone(base);
    zeroDigest.releaseIdentity.runtimeProfile.profileDigest = `sha256:${'0'.repeat(64)}`;
    zeroDigest.evidenceSummary.operations.runtimeTuning.profile.profileDigest = zeroDigest.releaseIdentity.runtimeProfile.profileDigest;
    const zeroDigestResult = validateManifest(zeroDigest, { manifestPath: manifestFile });
    if (zeroDigestResult.ok || !zeroDigestResult.errors.some((error) => error.includes('zero digest')))
    {
        fail('self-test expected a zero release profile digest to be rejected');
    }

    const wrongProfileDigest = structuredClone(base);
    wrongProfileDigest.releaseIdentity.runtimeProfile.profileDigest = `sha256:${'8'.repeat(64)}`;
    wrongProfileDigest.evidenceSummary.operations.runtimeTuning.profile.profileDigest = wrongProfileDigest.releaseIdentity.runtimeProfile.profileDigest;
    const wrongProfileDigestResult = validateManifest(wrongProfileDigest, { manifestPath: manifestFile });
    if (wrongProfileDigestResult.ok || !wrongProfileDigestResult.errors.some((error) => error.includes('release profile')))
    {
        fail('self-test expected a wrong selected runtime profile digest to be rejected');
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[release-manifest-check] self-test ok');
}

const args = process.argv.slice(2);
const requireOk = args.includes('--require-ok');
if (args.includes('--self-test'))
{
    await runSelfTest();
    process.exit(0);
}

const manifestArg = args.find((arg) => !arg.startsWith('--'));
function resolveRunBoundManifest()
{
    const context = resolveProductionFreshLocatorEnvironment(process.env);
    const collectionDir = String(process.env.FSUSBLOG_RELEASE_EVIDENCE_COLLECTION_DIR ?? '').trim();
    if (!collectionDir)
    {
        fail(
            'run-bound release manifest consumption requires'
      + ' FSUSBLOG_RELEASE_EVIDENCE_COLLECTION_DIR'
        );
    }
    const outputRoot = path.resolve(context.outputRoot);
    const manifestFile = path.resolve(collectionDir, 'manifest.json');
    if (manifestFile !== outputRoot
  && !manifestFile.startsWith(`${outputRoot}${path.sep}`))
    {
        fail(
            `release evidence collection dir escapes the run-bound output root: ${collectionDir}`
        );
    }
    const relativePath = path.relative(outputRoot, manifestFile).replaceAll(path.sep, '/');
    const namespace = String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim();
    const commit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim();
    const candidateIdentityDigest = sha256Value([
        context.runId,
        context.attemptId,
        namespace,
        commit
    ].filter(Boolean).join('|'));
    const layout = resolveProductionFreshOutputAttempt({
        root: rootDir,
        runId: context.runId,
        attemptId: context.attemptId
    });
    const binding = createProductionFreshRunBoundLocator({
        repositoryRoot: rootDir,
        runId: context.runId,
        attemptId: context.attemptId,
        outputRoot,
        producerId: 'release-evidence',
        relativePath,
        schema: 'fsusblog.release-evidence-manifest.v2',
        candidateIdentityDigest,
        receiptRef: path
            .relative(rootDir, path.join(layout.runOutputRoot, 'terminal-attempts.json'))
            .replaceAll(path.sep, '/')
    });
    const result = readProductionFreshJsonOutput({
        root: rootDir,
        locator: binding.locator,
        expectedCandidateIdentityDigest: candidateIdentityDigest
    });
    return { manifest: result.json, manifestPath: result.file };
}

let manifest = null;
let manifestPath = null;
void manifest;
void manifestPath;
if (manifestArg)
{
    manifestPath = path.resolve(manifestArg);
    manifest = readJson(manifestPath);
}
else
{
    let runBound;
    try
    {
        runBound = resolveRunBoundManifest();
    }
    catch (error)
    {
        fail(
            'explicit manifest path or a production-fresh run-bound locator context is required;'
      + ` ${error instanceof Error ? error.message : String(error)}`
        );
    }
    manifest = runBound.manifest;
    manifestPath = runBound.manifestPath;
}
const result = validateManifest(manifest, { requireOk, manifestPath });
if (!result.ok)
{
    for (const error of result.errors)
    {
        console.error(`[release-manifest-check] violation: ${error}`);
    }
    process.exit(1);
}

console.log(`[release-manifest-check] ok | status=${manifest.status} missing=${result.missingRequired.length} file=${manifestPath}`);
